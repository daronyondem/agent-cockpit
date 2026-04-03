// ─── Shared mutable state ────────────────────────────────────────────────────
// Every module that reads or writes shared state imports this single object.
// Mutations via `state.X = val` are visible to all importers immediately.

export const state = {
  csrfToken: null,
  chatConversations: [],
  chatActiveConvId: null,
  chatActiveConv: null,
  chatStreamingConvs: new Set(),
  chatResettingConvs: new Set(),
  chatStreamingState: new Map(), // convId -> { assistantContent, assistantThinking, activeTools, activeAgents, planModeActive, pendingInteraction, streamingMsgEl }
  chatAbortController: null,
  chatSidebarCollapsed: false,
  chatSearchTimeout: null,
  chatContextMenuEl: null,
  chatSettingsData: null,
  chatInitialized: false,
  chatPendingWorkingDir: null,
  chatPendingFiles: [], // Each: { file, status: 'uploading'|'done'|'error', progress, result, xhr }
  chatDraftState: new Map(), // convId|'__new__' -> { text, pendingFiles }
  _ensureConvPromise: null,
  chatConvLoadGen: 0, // generation counter for chatLoadConversations to discard stale responses
  chatMessageQueue: new Map(), // convId -> [{ id, content, inFlight }]
  chatQueuePaused: new Set(), // convIds where queue is paused due to error
  chatQueueIdCounter: 0,
  chatWebSockets: new Map(), // convId -> WebSocket
  chatReconnectAttempts: new Map(), // convId -> attempt count
  _usageStatsCache: null,
  CHAT_BACKENDS: [],
  BACKEND_CAPABILITIES: {},
  BACKEND_ICONS: {},
};

// ─── Constants ───────────────────────────────────────────────────────────────
export const CHAT_MAX_RECONNECT_ATTEMPTS = 5;
export const CHAT_RECONNECT_BASE_DELAY = 1000; // 1s, doubles each attempt
export const DEFAULT_BACKEND_ICON = '<svg width="28" height="28" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" rx="128" fill="#888"/><text x="256" y="320" text-anchor="middle" fill="#fff" font-size="280" font-family="sans-serif">\u26A1</text></svg>';
export const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
export const PARALLEL_THRESHOLD_MS = 500;

// ─── API helpers ─────────────────────────────────────────────────────────────
const API_BASE = new URL('./api/', window.location.href);

export function apiUrl(path = '') {
  const clean = String(path || '').replace(/^\/+/, '');
  return new URL(clean, API_BASE).toString();
}

export function chatApiUrl(path) {
  return apiUrl('chat/' + path);
}

export async function fetchCsrfToken() {
  const res = await fetch(apiUrl('/csrf-token'), { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`CSRF token fetch failed (${res.status})`);
  const body = await res.json();
  state.csrfToken = body.csrfToken;
}

export async function chatFetch(path, opts = {}) {
  if (!state.csrfToken) await fetchCsrfToken();
  const headers = { ...opts.headers };
  if (state.csrfToken) headers['x-csrf-token'] = state.csrfToken;
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(chatApiUrl(path), { ...opts, headers, credentials: 'same-origin' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res;
}
