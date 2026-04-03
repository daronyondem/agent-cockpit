import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cookie from 'cookie';
import type { Store } from 'express-session';
import type { ActiveStreamEntry, WsServerFrame, WsClientFrame } from './types';

interface AttachWebSocketOpts {
  sessionStore: Store;
  sessionSecret: string;
  activeStreams: Map<string, ActiveStreamEntry>;
}

export interface WsFunctions {
  shutdown: () => void;
  send: (convId: string, frame: WsServerFrame) => boolean;
  isConnected: (convId: string) => boolean;
  isStreamAlive: (convId: string) => boolean;
  clearBuffer: (convId: string) => void;
}

// ── Event buffer for reconnection ──────────────────────────────────────────

const GRACE_PERIOD_MS = 60_000;
const BUFFER_CLEANUP_MS = 60_000;
const MAX_BUFFER_SIZE = 1000;

interface ConvBuffer {
  events: WsServerFrame[];
  graceTimer: ReturnType<typeof setTimeout> | null;
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

// ── Main ───────────────────────────────────────────────────────────────────

export function attachWebSocket(
  server: http.Server,
  opts: AttachWebSocketOpts,
): WsFunctions {
  const { sessionStore, sessionSecret, activeStreams } = opts;

  const wss = new WebSocketServer({ noServer: true });
  const activeWebSockets = new Map<string, WebSocket>();
  const convBuffers = new Map<string, ConvBuffer>();

  // ── Keepalive: 30s ping/pong (well under Cloudflare's 100s idle timeout) ──
  const PING_INTERVAL = 30_000;
  const aliveMap = new WeakMap<WebSocket, boolean>();

  const pingInterval = setInterval(() => {
    for (const ws of activeWebSockets.values()) {
      if (!aliveMap.get(ws)) {
        ws.terminate();
        continue;
      }
      aliveMap.set(ws, false);
      ws.ping();
    }
  }, PING_INTERVAL);

  // ── Buffer helpers ───────────────────────────────────────────────────────

  function getOrCreateBuffer(convId: string): ConvBuffer {
    let buf = convBuffers.get(convId);
    if (!buf) {
      buf = { events: [], graceTimer: null, cleanupTimer: null };
      convBuffers.set(convId, buf);
    }
    return buf;
  }

  function clearBufferTimers(buf: ConvBuffer) {
    if (buf.graceTimer) { clearTimeout(buf.graceTimer); buf.graceTimer = null; }
    if (buf.cleanupTimer) { clearTimeout(buf.cleanupTimer); buf.cleanupTimer = null; }
  }

  function deleteBuffer(convId: string) {
    const buf = convBuffers.get(convId);
    if (buf) {
      clearBufferTimers(buf);
      convBuffers.delete(convId);
    }
  }

  function replayBuffer(ws: WebSocket, convId: string) {
    const buf = convBuffers.get(convId);
    if (!buf || buf.events.length === 0) return;

    console.log(`[ws] Replaying ${buf.events.length} buffered events for conv=${convId}`);
    ws.send(JSON.stringify({ type: 'replay_start', bufferedEvents: buf.events.length }));
    for (const event of buf.events) {
      ws.send(JSON.stringify(event));
    }
    ws.send(JSON.stringify({ type: 'replay_end' }));

    // If stream already finished, start cleanup timer (buffer served its purpose)
    const streamDone = buf.events.some(e => 'type' in e && e.type === 'done');
    if (streamDone) {
      clearBufferTimers(buf);
      buf.cleanupTimer = setTimeout(() => { deleteBuffer(convId); }, BUFFER_CLEANUP_MS);
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
            console.warn(`[ws] Origin mismatch: origin=${origin} host=${host}`);
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const passportUser = (session as any)?.passport?.user;
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
    // Close any existing WS for this conversation
    const existing = activeWebSockets.get(convId);
    if (existing && existing.readyState === WebSocket.OPEN) {
      existing.close(1000, 'Replaced by new connection');
    }
    activeWebSockets.set(convId, ws);
    aliveMap.set(ws, true);

    // Cancel grace timer — client reconnected
    const buf = convBuffers.get(convId);
    if (buf) {
      if (buf.graceTimer) { clearTimeout(buf.graceTimer); buf.graceTimer = null; }
      if (buf.cleanupTimer) { clearTimeout(buf.cleanupTimer); buf.cleanupTimer = null; }
    }

    // If there's a buffer with events, this is a reconnection — replay immediately
    if (buf && buf.events.length > 0) {
      console.log(`[ws] Reconnection detected for conv=${convId}`);
      replayBuffer(ws, convId);
    } else {
      console.log(`[ws] Connected for conv=${convId}`);
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
            console.log(`[ws] Sending stdin input for conv=${convId}: ${frame.text.substring(0, 100)}`);
            entry.sendInput(frame.text);
          }
        } else if (frame.type === 'abort') {
          if (entry) {
            console.log(`[ws] Aborting stream for conv=${convId}`);
            entry.abort();
            activeStreams.delete(convId);
          }
          deleteBuffer(convId);
        } else if (frame.type === 'reconnect') {
          // Client explicitly requests replay (e.g. after page load while stream is active)
          if (buf && buf.events.length > 0) {
            replayBuffer(ws, convId);
          }
        }
      } catch (err) {
        console.warn(`[ws] Failed to parse client frame for conv=${convId}:`, err);
      }
    });

    ws.on('close', () => {
      console.log(`[ws] Disconnected for conv=${convId}`);
      if (activeWebSockets.get(convId) === ws) {
        activeWebSockets.delete(convId);
      }

      // If a stream is active, start grace period instead of aborting
      const entry = activeStreams.get(convId);
      if (entry) {
        const graceBuf = getOrCreateBuffer(convId);
        console.log(`[ws] Starting ${GRACE_PERIOD_MS / 1000}s grace period for conv=${convId}`);
        graceBuf.graceTimer = setTimeout(() => {
          console.log(`[ws] Grace period expired for conv=${convId}, aborting CLI`);
          graceBuf.graceTimer = null;
          const staleEntry = activeStreams.get(convId);
          if (staleEntry) {
            staleEntry.abort();
            activeStreams.delete(convId);
          }
          deleteBuffer(convId);
        }, GRACE_PERIOD_MS);
      }
    });

    ws.on('error', (err) => {
      console.error(`[ws] Error for conv=${convId}:`, err.message);
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Buffer the event and send to WS if connected. Returns true if buffered. */
  function send(convId: string, frame: WsServerFrame): boolean {
    const buf = getOrCreateBuffer(convId);

    // Append to buffer (ring buffer: drop oldest if at cap)
    buf.events.push(frame);
    if (buf.events.length > MAX_BUFFER_SIZE) {
      buf.events.shift();
    }

    // If stream just finished (done event) and no WS is connected, start cleanup timer
    if (frame.type === 'done' && !isConnected(convId)) {
      if (!buf.cleanupTimer) {
        buf.cleanupTimer = setTimeout(() => { deleteBuffer(convId); }, BUFFER_CLEANUP_MS);
      }
    }

    // Send to WS if open
    const ws = activeWebSockets.get(convId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
      return true;
    }

    // Buffered but no WS to send to — that's fine during grace period
    return true;
  }

  /** True if a WebSocket is currently open for this conversation. */
  function isConnected(convId: string): boolean {
    const ws = activeWebSockets.get(convId);
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  /**
   * True if the stream should keep running: WS is open OR we're in a grace
   * period (buffer exists with an active grace timer). Used by processStream's
   * isClosed callback.
   */
  function isStreamAlive(convId: string): boolean {
    if (isConnected(convId)) return true;
    const buf = convBuffers.get(convId);
    return !!buf && buf.graceTimer !== null;
  }

  /** Clear the event buffer for a conversation (called before starting a new stream). */
  function clearBuffer(convId: string) {
    deleteBuffer(convId);
  }

  function shutdown() {
    clearInterval(pingInterval);
    for (const [convId, ws] of activeWebSockets) {
      console.log(`[ws-shutdown] Closing WS for conv=${convId}`);
      ws.close(1001, 'Server shutting down');
    }
    activeWebSockets.clear();
    for (const [convId] of convBuffers) {
      deleteBuffer(convId);
    }
    convBuffers.clear();
    wss.close();
  }

  return { shutdown, send, isConnected, isStreamAlive, clearBuffer };
}
