import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cookie from 'cookie';
import type { Store } from 'express-session';
import type { ActiveStreamEntry, WsServerFrame, WsClientFrame } from './types';
import { logger } from './utils/logger';

interface AttachWebSocketOpts {
  sessionStore: Store;
  sessionSecret: string;
  activeStreams: Map<string, ActiveStreamEntry>;
  abortStream?: (convId: string) => Promise<boolean> | boolean;
  bufferCleanupMs?: number;
  /** Deprecated compatibility override. Disconnect no longer aborts streams. */
  gracePeriodMs?: number;
}

export interface WsFunctions {
  shutdown: () => void;
  send: (convId: string, frame: WsServerFrame) => boolean;
  isConnected: (convId: string) => boolean;
  isStreamAlive: (convId: string) => boolean;
  clearBuffer: (convId: string) => void;
  /** Invoke `cb` for each conversation with an OPEN WebSocket. */
  forEachConnected: (cb: (convId: string) => void) => void;
  /** Mark an active stream as disconnected from browser transport. Kept as a
   *  compatibility name; it only enables buffering and never aborts a CLI stream. */
  startStreamGracePeriod: (convId: string) => void;
}

// ── Event buffer for reconnection ──────────────────────────────────────────

const BUFFER_CLEANUP_MS = 60_000;
const MAX_BUFFER_SIZE = 5000;
const wsLog = logger.child({ subsystem: 'ws' });

interface ConvBuffer {
  events: WsServerFrame[];
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function unsignCookie(val: string, secret: string): string | false {
  // express-session prefixes signed cookies with "s:"
  if (val.startsWith('s:')) val = val.slice(2);
  // cookie-signature format: value.signature
  const dot = val.lastIndexOf('.');
  if (dot === -1) return false;
  const raw = val.slice(0, dot);
  const sig = val.slice(dot + 1);
  // Recompute signature using HMAC-SHA256 (same as cookie-signature)
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64').replace(/=+$/, '');
  // Timing-safe comparison
  if (expected.length !== sig.length) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (!crypto.timingSafeEqual(a, b)) return false;
  return raw;
}

function isLocalRequest(req: http.IncomingMessage): boolean {
  const host = (req.headers.host || '').split(':')[0];
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function extractConvId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/\/api\/chat\/conversations\/([^/]+)\/ws/);
  return match ? match[1] : null;
}

function shouldBufferFrame(frame: WsServerFrame): boolean {
  return frame.type !== 'kb_state_update' && frame.type !== 'memory_update';
}

// ── Main ───────────────────────────────────────────────────────────────────

export function attachWebSocket(
  server: http.Server,
  opts: AttachWebSocketOpts,
): WsFunctions {
  const { sessionStore, sessionSecret, activeStreams, abortStream } = opts;
  const bufferCleanupMs = opts.bufferCleanupMs ?? BUFFER_CLEANUP_MS;

  const wss = new WebSocketServer({ noServer: true });
  const activeWebSockets = new Map<string, Set<WebSocket>>();
  const convBuffers = new Map<string, ConvBuffer>();
  let shuttingDown = false;

  // ── Keepalive: 30s ping/pong (well under Cloudflare's 100s idle timeout) ──
  const PING_INTERVAL = 30_000;
  const aliveMap = new WeakMap<WebSocket, boolean>();

  const pingInterval = setInterval(() => {
    for (const sockets of activeWebSockets.values()) {
      for (const ws of sockets) {
        if (!aliveMap.get(ws)) {
          ws.terminate();
          continue;
        }
        aliveMap.set(ws, false);
        ws.ping();
      }
    }
  }, PING_INTERVAL);

  // ── Buffer helpers ───────────────────────────────────────────────────────

  function getOrCreateBuffer(convId: string): ConvBuffer {
    let buf = convBuffers.get(convId);
    if (!buf) {
      buf = { events: [], cleanupTimer: null };
      convBuffers.set(convId, buf);
    }
    return buf;
  }

  function clearBufferTimers(buf: ConvBuffer) {
    if (buf.cleanupTimer) { clearTimeout(buf.cleanupTimer); buf.cleanupTimer = null; }
  }

  function deleteBuffer(convId: string) {
    const buf = convBuffers.get(convId);
    if (buf) {
      clearBufferTimers(buf);
      convBuffers.delete(convId);
    }
  }

  function addActiveSocket(convId: string, ws: WebSocket): number {
    let sockets = activeWebSockets.get(convId);
    const openCount = sockets ? getOpenSockets(convId).length : 0;
    sockets = activeWebSockets.get(convId);
    if (!sockets) {
      sockets = new Set();
      activeWebSockets.set(convId, sockets);
    }
    sockets.add(ws);
    return openCount;
  }

  function removeActiveSocket(convId: string, ws: WebSocket): boolean {
    const sockets = activeWebSockets.get(convId);
    if (!sockets || !sockets.has(ws)) return false;
    sockets.delete(ws);
    if (sockets.size === 0) {
      activeWebSockets.delete(convId);
    }
    return true;
  }

  function getOpenSockets(convId: string): WebSocket[] {
    const sockets = activeWebSockets.get(convId);
    if (!sockets) return [];
    const open: WebSocket[] = [];
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        open.push(ws);
      } else if (ws.readyState === WebSocket.CLOSED) {
        sockets.delete(ws);
      }
    }
    if (sockets.size === 0) {
      activeWebSockets.delete(convId);
    }
    return open;
  }

  function replayBuffer(ws: WebSocket, convId: string) {
    const buf = convBuffers.get(convId);
    if (!buf || buf.events.length === 0) return;

    wsLog.info('replaying buffered events', {
      convId: convId.slice(0, 8),
      bufferedEvents: buf.events.length,
    });
    ws.send(JSON.stringify({ type: 'replay_start', bufferedEvents: buf.events.length }));
    for (const event of buf.events) {
      ws.send(JSON.stringify(event));
    }
    ws.send(JSON.stringify({ type: 'replay_end' }));

    // If stream already finished, start cleanup timer (buffer served its purpose)
    const streamDone = buf.events.some(e => 'type' in e && e.type === 'done');
    if (streamDone) {
      clearBufferTimers(buf);
      buf.cleanupTimer = setTimeout(() => { deleteBuffer(convId); }, bufferCleanupMs);
    }
  }

  // ── Upgrade handler: auth + origin validation ─────────────────────────────
  server.on('upgrade', (req: http.IncomingMessage, socket, head) => {
    const convId = extractConvId(req.url);
    if (!convId) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // Origin validation (replaces CSRF for WebSocket)
    if (!isLocalRequest(req)) {
      const origin = req.headers.origin;
      const host = req.headers.host;
      if (origin && host) {
        try {
          const originHost = new URL(origin).host;
          if (originHost !== host) {
            wsLog.warn('origin mismatch', { origin, host });
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }
        } catch {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
      }
    }

    // Session authentication
    const isLocal = isLocalRequest(req);
    const cookies = cookie.parse(req.headers.cookie || '');
    const rawSid = cookies['connect.sid'];

    if (!rawSid && !isLocal) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (rawSid) {
      const sid = unsignCookie(decodeURIComponent(rawSid), sessionSecret);
      if (!sid) {
        if (!isLocal) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        // Local request with bad cookie — allow anyway
        wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, convId));
        return;
      }

      sessionStore.get(sid, (err, session) => {
        if (err || !session) {
          if (!isLocal) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
        }

        // Check passport user exists in session
        const passportUser = session?.passport?.user;
        if (!passportUser && !isLocal) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, convId));
      });
    } else {
      // No cookie, local request — allow
      wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, convId));
    }
  });

  // ── Connection handler ────────────────────────────────────────────────────
  function handleConnection(ws: WebSocket, convId: string) {
    const existingOpenCount = addActiveSocket(convId, ws);
    aliveMap.set(ws, true);

    // Cancel post-completion cleanup so the reconnected client can replay.
    const buf = convBuffers.get(convId);
    const hadCleanup = !!buf?.cleanupTimer;
    if (buf) {
      if (buf.cleanupTimer) { clearTimeout(buf.cleanupTimer); buf.cleanupTimer = null; }
    }

    const eventTypes = buf ? buf.events.map(e => 'type' in e ? e.type : '?') : [];
    wsLog.debug('handleConnection', {
      convId: convId.slice(0, 8),
      existingOpenCount,
      bufferedEvents: buf?.events.length ?? 0,
      hadCleanup,
      activeStream: activeStreams.has(convId),
      eventTypes,
    });

    // If there's a buffer with events, this is a reconnection — replay immediately
    if (buf && buf.events.length > 0) {
      wsLog.info('reconnection detected', { convId: convId.slice(0, 8) });
      replayBuffer(ws, convId);
    } else {
      wsLog.info('connected', { convId: convId.slice(0, 8) });
    }

    ws.on('pong', () => {
      aliveMap.set(ws, true);
    });

    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(data.toString()) as WsClientFrame;
        const entry = activeStreams.get(convId);

        if (frame.type === 'input') {
          if (entry && entry.sendInput) {
            wsLog.debug('sending stdin input', { convId: convId.slice(0, 8), textLength: frame.text.length });
            entry.sendInput(frame.text);
          }
        } else if (frame.type === 'abort') {
          if (abortStream) {
            void Promise.resolve(abortStream(convId)).catch((err: unknown) => {
              wsLog.error('abort failed', { convId: convId.slice(0, 8), error: (err as Error).message });
            });
          } else {
            if (entry) {
              wsLog.info('aborting stream', { convId: convId.slice(0, 8) });
              entry.abort();
              activeStreams.delete(convId);
            }
            deleteBuffer(convId);
            send(convId, { type: 'error', error: 'Aborted by user', terminal: true, source: 'abort' });
            send(convId, { type: 'done' });
          }
        } else if (frame.type === 'reconnect') {
          // Client explicitly requests replay (e.g. after page load while stream is active)
          const currentBuf = convBuffers.get(convId);
          if (currentBuf && currentBuf.events.length > 0) {
            replayBuffer(ws, convId);
          }
        }
      } catch (err) {
        wsLog.warn('failed to parse client frame', { convId: convId.slice(0, 8), error: (err as Error).message || String(err) });
      }
    });

    ws.on('close', (code, reason) => {
      const wasActive = removeActiveSocket(convId, ws);
      if (!wasActive) return;
      wsLog.debug('socket closed', {
        convId: convId.slice(0, 8),
        code,
        reason: reason?.toString() || '',
        wasActive,
        activeStream: activeStreams.has(convId),
      });
      if (!shuttingDown) {
        wsLog.info('disconnected', { convId: convId.slice(0, 8) });
      }
      if (activeStreams.has(convId) && !isConnected(convId)) {
        startStreamGracePeriod(convId);
      }
    });

    ws.on('error', (err) => {
      wsLog.error('socket error', { convId: convId.slice(0, 8), error: err.message });
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Buffer replayable stream events and send to WS if connected. */
  function send(convId: string, frame: WsServerFrame): boolean {
    const replayable = shouldBufferFrame(frame);
    let buf = replayable ? getOrCreateBuffer(convId) : convBuffers.get(convId);

    if (replayable && buf) {
      // Append to buffer (ring buffer: drop oldest if at cap)
      buf.events.push(frame);
      if (buf.events.length > MAX_BUFFER_SIZE) {
        buf.events.shift();
      }

      // If stream just finished, start cleanup timer regardless of transport
      // state. Completed replay buffers are short-lived recovery data, not
      // conversation history.
      if (frame.type === 'done') {
        if (!buf.cleanupTimer) {
          buf.cleanupTimer = setTimeout(() => { deleteBuffer(convId); }, bufferCleanupMs);
        }
      }
    }

    // Send to every open WS for this conversation.
    const sockets = getOpenSockets(convId);
    const wsOpen = sockets.length > 0;
    if (frame.type !== 'text' && frame.type !== 'thinking') {
      wsLog.debug('send frame', {
        convId: convId.slice(0, 8),
        type: frame.type,
        wsOpen,
        replayable,
        bufferLength: buf?.events.length ?? 0,
      });
    }
    if (wsOpen) {
      const payload = JSON.stringify(frame);
      for (const socket of sockets) {
        socket.send(payload);
      }
      return true;
    }

    // Replayable frames are buffered even with no WS. Side-channel frames
    // are live-only triggers; persisted state is their source of truth.
    return replayable;
  }

  /** True if a WebSocket is currently open for this conversation. */
  function isConnected(convId: string): boolean {
    return getOpenSockets(convId).length > 0;
  }

  /** Enumerate every conversation with an OPEN WebSocket. */
  function forEachConnected(cb: (convId: string) => void): void {
    for (const [convId] of activeWebSockets) {
      if (getOpenSockets(convId).length > 0) cb(convId);
    }
  }

  /** True if the server still owns an active CLI stream for this conversation. */
  function isStreamAlive(convId: string): boolean {
    return activeStreams.has(convId);
  }

  /** Clear the event buffer for a conversation (called before starting a new stream). */
  function clearBuffer(convId: string) {
    const buf = convBuffers.get(convId);
    if (buf) {
      const eventTypes = buf.events.map(e => 'type' in e ? e.type : '?');
      wsLog.debug('clear buffer', {
        convId: convId.slice(0, 8),
        bufferedEvents: buf.events.length,
        eventTypes,
      });
    }
    deleteBuffer(convId);
  }

  /** Mark an active stream as disconnected so frames buffer for replay. */
  function startStreamGracePeriod(convId: string): void {
    const entry = activeStreams.get(convId);
    const wsOpen = isConnected(convId);
    wsLog.debug('mark disconnected', {
      convId: convId.slice(0, 8),
      hasEntry: !!entry,
      wsOpen,
    });
    if (!entry) return;
    getOrCreateBuffer(convId);
  }

  function shutdown() {
    shuttingDown = true;
    clearInterval(pingInterval);
    for (const [convId, sockets] of activeWebSockets) {
      wsLog.info('closing sockets for shutdown', {
        convId: convId.slice(0, 8),
        socketCount: sockets.size,
      });
      for (const ws of sockets) {
        ws.close(1001, 'Server shutting down');
      }
    }
    activeWebSockets.clear();
    for (const [convId] of convBuffers) {
      deleteBuffer(convId);
    }
    convBuffers.clear();
    wss.close();
  }

  return { shutdown, send, isConnected, isStreamAlive, clearBuffer, forEachConnected, startStreamGracePeriod };
}
