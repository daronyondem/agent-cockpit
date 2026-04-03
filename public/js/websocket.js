import { state, CHAT_MAX_RECONNECT_ATTEMPTS, CHAT_RECONNECT_BASE_DELAY } from './state.js';

// Late-binding callback to avoid circular import with streaming.js.
// main.js wires this after all imports resolve.
let _streamEventHandler = null;
export function setStreamEventHandler(fn) { _streamEventHandler = fn; }

// ── WebSocket helpers ───────────────────────────────────────────────────────

function chatWsUrl(convId) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/api/chat/conversations/${convId}/ws`;
}

export function chatConnectWs(convId) {
  const existing = state.chatWebSockets.get(convId);
  if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
    return existing;
  }
  const ws = new WebSocket(chatWsUrl(convId));
  state.chatWebSockets.set(convId, ws);

  ws.onopen = () => {
    console.log(`[ws] Connected for conv=${convId}`);
  };

  ws.onmessage = (evt) => {
    try {
      const event = JSON.parse(evt.data);
      if (_streamEventHandler) _streamEventHandler(convId, event);
    } catch (err) {
      console.warn('[ws] Parse error:', err);
    }
  };

  ws.onclose = (evt) => {
    console.log(`[ws] Closed for conv=${convId}: code=${evt.code}`);
    if (state.chatWebSockets.get(convId) === ws) {
      state.chatWebSockets.delete(convId);
    }
    // Auto-reconnect if stream is still active (unexpected disconnect)
    if (state.chatStreamingConvs.has(convId)) {
      chatAutoReconnectWs(convId);
    }
  };

  ws.onerror = (err) => {
    console.error(`[ws] Error for conv=${convId}:`, err);
  };

  return ws;
}

function chatAutoReconnectWs(convId) {
  const attempts = state.chatReconnectAttempts.get(convId) || 0;
  if (attempts >= CHAT_MAX_RECONNECT_ATTEMPTS) {
    console.warn(`[ws] Reconnect attempts exhausted for conv=${convId}`);
    state.chatReconnectAttempts.delete(convId);
    // Give up — resolve done so the stream cleans up
    const st = state.chatStreamingState.get(convId);
    if (st && st._doneResolve) { st._doneResolve(); delete st._doneResolve; }
    return;
  }
  const delay = CHAT_RECONNECT_BASE_DELAY * Math.pow(2, attempts);
  state.chatReconnectAttempts.set(convId, attempts + 1);
  console.log(`[ws] Reconnecting conv=${convId} in ${delay}ms (attempt ${attempts + 1}/${CHAT_MAX_RECONNECT_ATTEMPTS})`);
  setTimeout(() => {
    // Stream may have ended while we waited
    if (!state.chatStreamingConvs.has(convId)) {
      state.chatReconnectAttempts.delete(convId);
      return;
    }
    chatConnectWs(convId);
  }, delay);
}

export function chatDisconnectWs(convId) {
  state.chatReconnectAttempts.delete(convId); // Prevent auto-reconnect on deliberate close
  const ws = state.chatWebSockets.get(convId);
  if (ws) {
    ws.close();
    state.chatWebSockets.delete(convId);
  }
}

export function chatWsSend(convId, frame) {
  const ws = state.chatWebSockets.get(convId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(frame));
    return true;
  }
  return false;
}
