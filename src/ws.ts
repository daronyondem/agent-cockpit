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

export function attachWebSocket(
  server: http.Server,
  opts: AttachWebSocketOpts,
): { shutdown: () => void; send: (convId: string, frame: WsServerFrame) => boolean; isConnected: (convId: string) => boolean } {
  const { sessionStore, sessionSecret, activeStreams } = opts;

  const wss = new WebSocketServer({ noServer: true });
  const activeWebSockets = new Map<string, WebSocket>();

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

    console.log(`[ws] Connected for conv=${convId}`);

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
      // Abort CLI process if still running
      const entry = activeStreams.get(convId);
      if (entry) {
        entry.abort();
        activeStreams.delete(convId);
      }
    });

    ws.on('error', (err) => {
      console.error(`[ws] Error for conv=${convId}:`, err.message);
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function send(convId: string, frame: WsServerFrame): boolean {
    const ws = activeWebSockets.get(convId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }

  function isConnected(convId: string): boolean {
    const ws = activeWebSockets.get(convId);
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  function shutdown() {
    clearInterval(pingInterval);
    for (const [convId, ws] of activeWebSockets) {
      console.log(`[ws-shutdown] Closing WS for conv=${convId}`);
      ws.close(1001, 'Server shutting down');
    }
    activeWebSockets.clear();
    wss.close();
  }

  return { shutdown, send, isConnected };
}
