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
  chatViewingArchive: false,
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
  chatQueueSuspended: new Set(), // convIds where queue was restored from server
  chatQueueIdCounter: 0,
  _queueSyncInFlight: false,
  _queueSyncDirty: false,
  chatWebSockets: new Map(), // convId -> WebSocket
  chatReconnectAttempts: new Map(), // convId -> attempt count
  _usageStatsCache: null,
  CHAT_BACKENDS: [],
  BACKEND_CAPABILITIES: {},
  BACKEND_ICONS: {},
  BACKEND_MODELS: {},  // backendId -> ModelOption[] | null
};

// ─── Queue sync ─────────────────────────────────────────────────────────────
// Sequential coalescing: at most one PUT in flight; if mutations happen during
// the in-flight request, a single follow-up PUT sends the latest state.

export function chatSyncQueueToServer(convId) {
  if (!convId) return;
  if (state._queueSyncInFlight) {
    state._queueSyncDirty = true;
    return;
  }
  const queue = state.chatMessageQueue.get(convId);
  const contents = queue ? queue.filter(i => !i.inFlight).map(i => i.content) : [];
  state._queueSyncInFlight = true;
  chatFetch(`conversations/${convId}/queue`, {
    method: 'PUT',
    body: { queue: contents },
  }).catch(() => {}).finally(() => {
    state._queueSyncInFlight = false;
    if (state._queueSyncDirty) {
      state._queueSyncDirty = false;
      chatSyncQueueToServer(convId);
    }
  });
}

// ─── Constants ───────────────────────────────────────────────────────────────
export const CHAT_MAX_RECONNECT_ATTEMPTS = 5;
export const CHAT_RECONNECT_BASE_DELAY = 1000; // 1s, doubles each attempt
export const DEFAULT_BACKEND_ICON = '<svg width="28" height="28" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" rx="128" fill="#888"/><text x="256" y="320" text-anchor="middle" fill="#fff" font-size="280" font-family="sans-serif">\u26A1</text></svg>';
export const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

// KB pipeline icons — inline SVG strings sized for toolbar / status badge use.
export const KB_ICON_INGEST = '<svg class="kb-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
export const KB_ICON_DIGEST = '<svg class="kb-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5v14h7V5H3z"/><path d="M11 12h3"/><path d="M13 10l2 2-2 2"/><rect x="16" y="4" width="5" height="4" rx="0.5"/><rect x="16" y="10" width="5" height="4" rx="0.5"/><rect x="16" y="16" width="5" height="4" rx="0.5"/></svg>';
export const KB_ICON_DREAM = '<svg class="kb-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="17" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="19" cy="15" r="2"/><path d="M 6 15.3 Q 7 10 11 6.7"/><path d="M 13.1 6.6 Q 17 9 17.9 13.4"/><path d="M 7 16.7 Q 12 19 17 15.3"/></svg>';
export const KB_REF_ICON_PATTERN = '<svg class="kb-ref-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="1"/><circle cx="17" cy="7" r="1"/><circle cx="7" cy="17" r="1"/><circle cx="17" cy="17" r="1"/></svg>';
export const KB_REF_ICON_CONTRADICTION = '<svg class="kb-ref-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17l-5-5 5-5"/><path d="M4 12h8"/><path d="M15 7l5 5-5 5"/><path d="M20 12h-8"/></svg>';
export const KB_REF_ICON_GAP = '<svg class="kb-ref-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h4l3 10h4l3-10h4"/></svg>';
export const KB_REF_ICON_TREND = '<svg class="kb-ref-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>';
export const KB_REF_ICON_INSIGHT = '<svg class="kb-ref-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>';
export const ICON_STALE = '<svg class="kb-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
export const ICON_AI_MODEL = '<svg class="kb-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M12 3v6"/><path d="M12 15v6"/><path d="M21 12h-6"/><path d="M9 12H3"/><circle cx="12" cy="3" r="1"/><circle cx="12" cy="21" r="1"/><circle cx="21" cy="12" r="1"/><circle cx="3" cy="12" r="1"/></svg>';
export const ICON_CLI = '<svg class="kb-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
export const ICON_SERVER = '<svg class="kb-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="8" rx="2" ry="2"/><rect x="2" y="13" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="7" x2="6" y2="7.01"/><line x1="6" y1="17" x2="6" y2="17.01"/></svg>';
export const ICON_STATS = '<svg class="kb-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20v-4"/><path d="M9 20v-8"/><path d="M15 20v-6"/><path d="M21 20v-10"/><path d="M3 14l6-4 6 2 6-6"/></svg>';
export const ICON_KB = '<svg class="kb-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';
export const ICON_MEMORY = '<svg class="kb-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/><circle cx="12" cy="12" r="3"/></svg>';
export const ICON_CANCEL = '<svg class="kb-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
export const ICON_EDIT = '<svg class="kb-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
export const ICON_DOWNLOAD = '<svg class="kb-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
export const ICON_RESET = '<svg class="kb-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
export const ICON_SIGNOUT = '<svg class="kb-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';
export const ICON_ARCHIVE = '<svg class="kb-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><line x1="10" y1="12" x2="14" y2="12"/></svg>';
export const ICON_SETTINGS = '<svg class="kb-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33 1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>';
export const ICON_REFLECTION = '<svg class="kb-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2v1"/><path d="M5.22 5.22l.71.71"/><path d="M18.07 5.22l-.71.71"/><path d="M15 13a3 3 0 1 0-6 0c0 1.45.87 2.41 1.5 3h3c.63-.59 1.5-1.55 1.5-3Z"/></svg>';
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
  if (res.status === 401) {
    chatShowSessionExpired();
    throw new Error('Session expired');
  }
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
  if (res.status === 401) {
    chatShowSessionExpired();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // HTTP/2 responses leave `statusText` empty, so on a path like
    // `fetch over Cloudflare tunnel → Express default 404 HTML` the
    // JSON parse falls through and statusText is '' — that used to
    // throw `new Error('')` which gave UI alerts a blank message.
    // Fall back to the numeric status so a missing endpoint still
    // surfaces as `HTTP 404` rather than an empty line.
    throw new Error(err.error || res.statusText || `HTTP ${res.status}`);
  }
  return res;
}

// ─── Session expiry overlay ──────────────────────────────────────────────────
// Shown when any API request returns 401. Idempotent — calling it multiple
// times does not stack overlays. Drafts are already persisted to localStorage
// by draftState.js, so they survive the sign-in redirect and page reload.

export function chatShowSessionExpired() {
  if (document.getElementById('chat-session-expired-overlay')) return;
  const loginUrl = new URL('./auth/login', window.location.href).toString();
  const overlay = document.createElement('div');
  overlay.id = 'chat-session-expired-overlay';
  overlay.innerHTML =
    '<div class="session-expired-dialog">'
    + '<div style="font-size:18px;font-weight:600;margin-bottom:8px;">Session expired</div>'
    + '<div style="font-size:13px;color:var(--muted);margin-bottom:20px;">'
    + 'You have been signed out. Your draft message is preserved — sign in to continue.'
    + '</div>'
    + '<a class="session-expired-btn" id="chat-session-expired-btn" href="' + loginUrl + '">Sign in again</a>'
    + '</div>';
  document.body.appendChild(overlay);
  const btn = document.getElementById('chat-session-expired-btn');
  if (btn) btn.focus();
}
