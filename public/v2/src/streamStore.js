/* global AgentApi */

/* Agent Cockpit v2 — per-conversation stream store.

   Lifts streaming state out of the ChatLive view so that switching
   conversations does NOT abort an in-flight stream. Each conversation the
   user has visited this session owns its own entry in `states`, with its
   own WebSocket, accumulated messages, and streaming flags. The sidebar
   reads a compact `uiState` for every entry so multiple rows can light
   up at once ("streaming", "error", null = idle).

   Exposed as `window.StreamStore`. React views subscribe through the
   `useConversationState(convId)` / `useConvStates()` hooks defined in
   shell.jsx, which simply forward to `subscribe` / `subscribeGlobal`. */

(function(){
  /** @typedef {{
   *   type: 'planApproval', planContent: string,
   * } | {
   *   type: 'userQuestion', question: string, options: Array<{label:string, description?:string}>,
   * }} PendingInteraction */

  /** @typedef {'image'|'pdf'|'text'|'code'|'md'|'folder'|'file'} AttachmentKind */

  /** @typedef {{
   *   name: string, path: string, size?: number,
   *   kind: AttachmentKind, meta?: string,
   * }} AttachmentMeta */

  /** @typedef {{ content: string, attachments?: AttachmentMeta[] }} QueuedMessage */

  /** @typedef {{
   *   id: string, file: File,
   *   status: 'uploading' | 'done' | 'error',
   *   progress: number,
   *   result: AttachmentMeta | null,
   *   xhr: XMLHttpRequest | null,
   *   error: string | null,
   *   ocrStatus?: 'idle' | 'running' | 'done' | 'error',
   *   ocrMarkdown?: string | null,
   *   ocrError?: string | null,
   * }} PendingAttachment */

  /** @typedef {{
   *   convId: string,
   *   conv: object | null,
   *   messages: object[],
   *   input: string,
   *   sending: boolean,
   *   streaming: boolean,
   *   loadError: string | null,
   *   streamError: string | null,
   *   usage: object | null,
   *   streamingMsgId: string | null,
   *   loaded: boolean,
   *   ws: WebSocket | null,
   *   wsOpening: Promise<void> | null,
   *   wsReconnectAttempts: number,
   *   wsReconnectTimer: number | null,
   *   lastFrameAt: number | null,
   *   replayActive: boolean,
   *   reconcileTimer: number | null,
   *   uiState: 'streaming' | 'awaiting' | 'error' | null,
   *   unread: boolean,
   *   pendingInteraction: PendingInteraction | null,
   *   respondPending: boolean,
   *   composerCliProfileId: string | null,
   *   composerBackend: string | null,
   *   composerModel: string | null,
   *   composerEffort: string | null,
   *   pendingAttachments: PendingAttachment[],
   *   queue: QueuedMessage[],
   * }} ConvState */

  /** @type {Map<string, ConvState>} */
  const states = new Map();
  /** @type {Map<string, Set<() => void>>} */
  const convSubs = new Map();
  /** @type {Set<() => void>} */
  const globalSubs = new Set();
  /* Which conv the user is currently viewing. When a stream finishes on any
     other conv we flag it as unread so the sidebar can highlight it. The
     shell keeps this in sync via setActiveConvId in onSelectConv. */
  let activeConvId = null;

  /* Conversation list — single source of truth for the sidebar and any
     other consumer that wants to render the list. The store reflects the
     last `loadConvList({query, archived})` call; toggling views or typing
     a search re-fetches. Targeted mutations (title_updated, archive,
     delete, rename, create) patch the in-memory list so other views update
     without a server round-trip. */
  const convList = {
    items: null,        // null = not loaded yet, [] = empty, [...] = loaded
    error: null,
    query: '',
    archived: false,
    loading: false,
    reqGen: 0,          // race-cancellation gen counter for loadConvList
  };
  /** @type {Set<() => void>} */
  const convListSubs = new Set();

  /* Draft localStorage persistence — survives tab crash / reload so the user
     doesn't lose a half-written message. Only text + *completed* attachments
     (those with a server path) are persisted; in-flight uploads can't be
     serialized since the File bytes would need to replay. Mirrors V1
     `public/js/conversations.js:562-631` (`chatSerializeDraftFiles` +
     `chatWriteDraftToStorage`). */
  const DRAFT_KEY_PREFIX = 'ac:v2:draft:';
  const DRAFT_DEBOUNCE_MS = 150;
  const RECONNECT_MAX_ATTEMPTS = 5;
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 10000;
  const RECONCILE_AFTER_OPEN_MS = 150;
  const draftSaveTimers = new Map();
  const queuePersistStates = new Map();

  function draftKey(convId){ return DRAFT_KEY_PREFIX + convId; }

  function serializeDraftAttachments(pending){
    return (pending || [])
      .filter(f => f.status === 'done' && f.result && f.result.path)
      .map(f => f.result);
  }

  function writeDraft(convId, text, pendingAttachments){
    try {
      const atts = serializeDraftAttachments(pendingAttachments);
      const trimmed = (text || '').trim();
      if (!trimmed && atts.length === 0) {
        localStorage.removeItem(draftKey(convId));
        return;
      }
      localStorage.setItem(draftKey(convId), JSON.stringify({ text: text || '', attachments: atts }));
    } catch { /* quota / private mode — in-memory state still works */ }
  }

  function readDraft(convId){
    try {
      const raw = localStorage.getItem(draftKey(convId));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        text: typeof parsed.text === 'string' ? parsed.text : '',
        attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
      };
    } catch { return null; }
  }

  function clearDraft(convId){
    const t = draftSaveTimers.get(convId);
    if (t) { clearTimeout(t); draftSaveTimers.delete(convId); }
    try { localStorage.removeItem(draftKey(convId)); } catch {}
  }

  function scheduleDraftSave(convId){
    const existing = draftSaveTimers.get(convId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      draftSaveTimers.delete(convId);
      const s = states.get(convId);
      if (!s) return;
      writeDraft(convId, s.input, s.pendingAttachments);
    }, DRAFT_DEBOUNCE_MS);
    draftSaveTimers.set(convId, t);
  }

  /* Cancels any pending debounced save and writes the current state to
     localStorage immediately. Called before the optimistic-wipe in send()
     so a timer firing post-wipe doesn't clobber the persisted draft a
     session-expired refresh depends on. */
  function flushDraftNow(convId){
    const t = draftSaveTimers.get(convId);
    if (t) { clearTimeout(t); draftSaveTimers.delete(convId); }
    const s = states.get(convId);
    if (s) writeDraft(convId, s.input, s.pendingAttachments);
  }

  /* Rebuilds PendingAttachment rows from persisted AttachmentMeta entries.
     The `file` field is a stub with just name/size since we lost the File
     blob — the existing attachment-chip renderer guards on `f.type &&
     f.type.startsWith('image/')` so the missing type naturally skips the
     URL.createObjectURL path. `restored: true` marks the row for any callers
     that want to distinguish rehydrated from live uploads. */
  function hydrateAttachmentsFromDraft(atts){
    return (atts || []).map(meta => ({
      id: 'pa-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8),
      file: { name: meta.name || '', size: meta.size || 0 },
      status: 'done',
      progress: 100,
      result: meta,
      xhr: null,
      error: null,
      restored: true,
    }));
  }

  function blankState(convId){
    return {
      convId,
      conv: null,
      messages: [],
      input: '',
      sending: false,
      streaming: false,
      loadError: null,
      streamError: null,
      usage: null,
      streamingMsgId: null,
      loaded: false,
      ws: null,
      wsOpening: null,
      wsReconnectAttempts: 0,
      wsReconnectTimer: null,
      lastFrameAt: null,
      replayActive: false,
      reconcileTimer: null,
      uiState: null,
      unread: false,
      pendingInteraction: null,
      respondPending: false,
      composerCliProfileId: null,
      composerBackend: null,
      composerModel: null,
      composerEffort: null,
      pendingAttachments: [],
      queue: [],
      queueSuspended: false,
      planModeActive: false,
      resetting: false,
    };
  }

  function ensureState(convId){
    if (!states.has(convId)) states.set(convId, blankState(convId));
    return states.get(convId);
  }

  function getState(convId){
    return states.get(convId) || null;
  }

  function commit(convId, next, prev, wasNew){
    states.set(convId, next);
    const subs = convSubs.get(convId);
    if (subs) subs.forEach(l => { try { l(); } catch {} });
    if (wasNew || prev.uiState !== next.uiState || prev.unread !== next.unread) {
      globalSubs.forEach(l => { try { l(); } catch {} });
    }
  }

  function update(convId, patch){
    const wasNew = !states.has(convId);
    const prev = ensureState(convId);
    const next = typeof patch === 'function' ? patch(prev) : { ...prev, ...patch };
    if (next === prev) return;
    commit(convId, next, prev, wasNew);
  }

  function subscribe(convId, listener){
    if (!convSubs.has(convId)) convSubs.set(convId, new Set());
    convSubs.get(convId).add(listener);
    return () => {
      const set = convSubs.get(convId);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) convSubs.delete(convId);
    };
  }

  function subscribeGlobal(listener){
    globalSubs.add(listener);
    return () => { globalSubs.delete(listener); };
  }

  function convStates(){
    const out = {};
    for (const [id, s] of states) {
      if (s.uiState) out[id] = s.uiState;
      else if (s.unread) out[id] = 'unread';
      /* 'idle' sentinel — touched conv with no active state and no unread
         flag. Sidebar uses this to override any stale `c.unread=true` left
         in the server-cached conversation list (from before the user marked
         it read this session). For untouched convs (no ConvState), c.unread
         is the source of truth. */
      else out[id] = 'idle';
    }
    return out;
  }

  /* ── Conversation list ─────────────────────────────────────────────── */

  function notifyConvList(){
    convListSubs.forEach(l => { try { l(); } catch {} });
  }

  function subscribeConvList(listener){
    convListSubs.add(listener);
    return () => { convListSubs.delete(listener); };
  }

  function getConvList(){ return convList; }

  /* Fetch conversations matching the given filters and replace `items`.
     `reqGen` drops responses for any fetch that has been overtaken by a
     newer one (e.g. fast typing in the search box). */
  async function loadConvList(opts){
    const nextQuery = (opts && typeof opts.query === 'string') ? opts.query : '';
    const nextArchived = !!(opts && opts.archived);
    const gen = ++convList.reqGen;
    convList.query = nextQuery;
    convList.archived = nextArchived;
    convList.items = null;
    convList.error = null;
    convList.loading = true;
    notifyConvList();
    try {
      const items = await AgentApi.listConversations({ q: nextQuery, archived: nextArchived });
      if (gen !== convList.reqGen) return;
      convList.items = items;
      convList.loading = false;
      notifyConvList();
    } catch (err) {
      if (gen !== convList.reqGen) return;
      convList.error = err.message || String(err);
      convList.loading = false;
      notifyConvList();
    }
  }

  function refreshConvList(){
    return loadConvList({ query: convList.query, archived: convList.archived });
  }

  /* Seeds `uiState: 'streaming'` for conversations whose CLI stream is
     still alive on the server but whose per-conv ConvState was wiped by a
     page refresh. Called once on sidebar mount. Without this the sidebar
     would show gray dots for live streams until the user clicked into
     each one to trigger a WS reconnect + replay.

     Only seeds convs that don't already have an open WS (where the real
     stream state is already being tracked). If a seeded stream finishes
     while the user never clicks in, the dot stays blue until the next
     refresh — acceptable trade-off vs. opening a WS per conv. */
  async function hydrateActiveStreams(){
    let ids;
    try {
      ids = await AgentApi.getActiveStreams();
    } catch {
      return; // non-fatal — silent on network/auth errors
    }
    if (!Array.isArray(ids) || ids.length === 0) return;
    for (const id of ids) {
      const cur = states.get(id);
      if (cur && cur.ws) continue; // real WS already tracking state
      update(id, { streaming: true, uiState: 'streaming', streamError: null });
    }
  }

  function patchConvListItem(convId, patch){
    if (!Array.isArray(convList.items)) return;
    let changed = false;
    const next = convList.items.map(c => {
      if (c.id !== convId) return c;
      changed = true;
      return { ...c, ...patch };
    });
    if (!changed) return;
    convList.items = next;
    notifyConvList();
  }

  function removeConvListItem(convId){
    if (!Array.isArray(convList.items)) return;
    const next = convList.items.filter(c => c.id !== convId);
    if (next.length === convList.items.length) return;
    convList.items = next;
    notifyConvList();
  }

  /* Bump a sidebar row's `updatedAt` and re-sort the list. The server bumps
     `lastActivity` on every persisted user/assistant message, but the sidebar
     holds a snapshot from its last full fetch — without this, the relative
     time label and row order go stale until the next list reload. */
  function bumpConvListActivity(convId, iso){
    if (!Array.isArray(convList.items)) return;
    const stamp = iso || new Date().toISOString();
    let found = false;
    const patched = convList.items.map(c => {
      if (c.id !== convId) return c;
      found = true;
      return { ...c, updatedAt: stamp };
    });
    if (!found) return;
    patched.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    convList.items = patched;
    notifyConvList();
  }

  function prependConvListItem(conv){
    if (!conv || !conv.id) return;
    if (!Array.isArray(convList.items)) return;
    if (convList.items.some(c => c.id === conv.id)) return;
    convList.items = [conv, ...convList.items];
    notifyConvList();
  }

  /* Infer an AttachmentKind from a file path's extension. Mirrors the
     server-side helper so legacy `[Uploaded files: …]` transcripts can be
     parsed and typed on the client when historical messages are read. */
  function attachmentKindFromPath(p){
    const name = String(p || '').split('/').pop() || '';
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
    if (!ext) return 'file';
    if (['.png','.jpg','.jpeg','.gif','.webp','.svg','.bmp','.avif'].includes(ext)) return 'image';
    if (ext === '.pdf') return 'pdf';
    if (ext === '.md' || ext === '.markdown') return 'md';
    if (['.txt','.log','.csv','.tsv','.rtf'].includes(ext)) return 'text';
    if (['.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.go','.rs','.java','.kt','.cs','.cpp','.cc','.c','.h','.hpp','.rb','.php','.swift','.scala','.sh','.bash','.zsh','.fish','.yaml','.yml','.json','.toml','.xml','.html','.css','.scss','.sass','.less','.sql','.graphql'].includes(ext)) return 'code';
    return 'file';
  }

  /* Best-effort parse of a legacy `[Uploaded files: p1, p2]` tag that used to
     be appended to user message content strings. Returns the cleaned content
     plus typed attachments (extension-inferred kind only; size/pages/lines
     metadata is not available for legacy transcripts). */
  function parseUploadedFilesTag(content){
    if (typeof content !== 'string') return null;
    const match = content.match(/\n*\[Uploaded files: ([^\]]+)\]\s*$/);
    if (!match) return null;
    const paths = match[1].split(',').map(p => p.trim()).filter(Boolean);
    if (!paths.length) return null;
    const attachments = paths.map(abs => ({
      name: abs.split('/').pop() || abs,
      path: abs,
      kind: attachmentKindFromPath(abs),
    }));
    return { content: content.slice(0, match.index).replace(/\s+$/, ''), attachments };
  }

  function activeStreamErrorFromMessages(messages){
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role === 'assistant' && msg.streamError) {
        return msg.streamError.message || msg.content || 'Stream error';
      }
      if (msg.role === 'assistant' || msg.role === 'user') return null;
    }
    return null;
  }

  async function load(convId){
    const s = ensureState(convId);
    if (s.loaded || s.loadError) return;
    try {
      const res = await AgentApi.fetch('conversations/' + encodeURIComponent(convId));
      const data = await res.json();
      const messages = Array.isArray(data.messages) ? data.messages : [];
      const persistedStreamError = activeStreamErrorFromMessages(messages);
      const restoredQueue = Array.isArray(data.messageQueue) ? data.messageQueue : [];
      /* Tab-crash draft rehydration — only restore if the in-memory composer
         hasn't been touched (empty input + no pending files). If the user has
         already typed something this session, the live state wins and we
         leave the persisted draft alone. */
      const draft = (!s.input && s.pendingAttachments.length === 0)
        ? readDraft(convId)
        : null;
      console.log('[diag]', new Date().toISOString(), 'load-result',
        'conv=' + convId.slice(0,8),
        'msgCount=' + (Array.isArray(data.messages) ? data.messages.length : 0));
      update(convId, cur => ({
        ...cur,
        conv: data,
        messages,
        usage: data.sessionUsage || null,
        queue: restoredQueue,
        streamError: persistedStreamError,
        uiState: persistedStreamError ? 'error' : cur.uiState,
        /* Mark a non-empty restored queue as suspended so the auto-drainer
           bails until the user explicitly resumes or clears. Mirrors V1
           `conversations.js:715`: queue items restored from a previous
           session shouldn't auto-fire — they may be stale, and the user
           needs a chance to review. */
        queueSuspended: restoredQueue.length > 0 && !cur.streaming,
        loaded: true,
        /* Hydrate composer picker state from the conv record only if the user
           hasn't already touched it this session. Null = never-touched. */
        composerCliProfileId: cur.composerCliProfileId != null ? cur.composerCliProfileId : (data.cliProfileId || null),
        composerBackend: cur.composerBackend != null ? cur.composerBackend : (data.backend || null),
        composerModel:   cur.composerModel   != null ? cur.composerModel   : (data.model   || null),
        composerEffort:  cur.composerEffort  != null ? cur.composerEffort  : (data.effort  || null),
        input: draft ? draft.text : cur.input,
        pendingAttachments: draft && draft.attachments.length
          ? hydrateAttachmentsFromDraft(draft.attachments)
          : cur.pendingAttachments,
      }));
    } catch (err) {
      update(convId, { loadError: err.message || String(err) });
    }
  }

  function clearReconnectTimer(convId){
    const s = states.get(convId);
    if (!s || !s.wsReconnectTimer) return;
    clearTimeout(s.wsReconnectTimer);
    update(convId, { wsReconnectTimer: null });
  }

  function clearReconcileTimer(convId){
    const s = states.get(convId);
    if (!s || !s.reconcileTimer) return;
    clearTimeout(s.reconcileTimer);
    update(convId, { reconcileTimer: null });
  }

  function scheduleReconnect(convId){
    const s = states.get(convId);
    if (!s) return;
    if (!(s.streaming || s.uiState === 'streaming')) return;
    if (s.wsReconnectTimer) return;
    const attempts = s.wsReconnectAttempts || 0;
    if (attempts >= RECONNECT_MAX_ATTEMPTS) {
      update(convId, {
        streamError: 'WebSocket reconnect failed',
        uiState: 'error',
        wsReconnectTimer: null,
      });
      return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempts), RECONNECT_MAX_MS);
    const timer = setTimeout(() => {
      update(convId, cur => ({
        ...cur,
        wsReconnectTimer: null,
        wsReconnectAttempts: (cur.wsReconnectAttempts || 0) + 1,
      }));
      ensureWsOpen(convId).catch(() => {
        scheduleReconnect(convId);
      });
    }, delay);
    update(convId, { wsReconnectTimer: timer });
  }

  async function reconcileActiveStream(convId, ws){
    const s = states.get(convId);
    if (!s || s.ws !== ws) return;
    if (!(s.streaming || s.uiState === 'streaming')) return;
    let ids;
    try {
      ids = await AgentApi.getActiveStreams();
    } catch {
      return;
    }
    const cur = states.get(convId);
    if (!cur || cur.ws !== ws) return;
    if (Array.isArray(ids) && ids.includes(convId)) return;
    try {
      await refreshConversationFromServer(convId);
    } catch {
      // Best-effort backstop only. Normal replay remains the primary path.
    }
  }

  async function refreshConversationFromServer(convId, opts){
    const res = await AgentApi.fetch('conversations/' + encodeURIComponent(convId));
    const data = await res.json();
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const persistedStreamError = activeStreamErrorFromMessages(messages);
    const fallbackStreamError = opts && typeof opts.streamError === 'string' ? opts.streamError : null;
    const streamError = persistedStreamError || fallbackStreamError;
    update(convId, next => ({
      ...next,
      conv: data,
      messages,
      usage: data.sessionUsage || null,
      queue: Array.isArray(data.messageQueue) ? data.messageQueue : next.queue,
      streaming: false,
      streamingMsgId: null,
      pendingInteraction: null,
      planModeActive: false,
      replayActive: false,
      reconcileTimer: null,
      wsReconnectAttempts: 0,
      streamError,
      uiState: streamError ? 'error' : null,
    }));
    if (!streamError) drainQueueIfReady(convId);
  }

  function scheduleReconcileActiveStream(convId, ws){
    const s = states.get(convId);
    if (!s || s.ws !== ws) return;
    if (!(s.streaming || s.uiState === 'streaming')) return;
    clearReconcileTimer(convId);
    const timer = setTimeout(() => {
      const cur = states.get(convId);
      if (!cur || cur.ws !== ws || cur.replayActive) return;
      update(convId, { reconcileTimer: null });
      reconcileActiveStream(convId, ws);
    }, RECONCILE_AFTER_OPEN_MS);
    update(convId, { reconcileTimer: timer });
  }

  function ensureWsOpen(convId){
    const s = ensureState(convId);
    if (s.ws && (s.ws.readyState === WebSocket.OPEN || s.ws.readyState === WebSocket.CONNECTING)) {
      return s.wsOpening || Promise.resolve();
    }
    console.log('[diag]', new Date().toISOString(), 'ensureWsOpen-new', 'conv=' + convId.slice(0,8));
    const ws = new WebSocket(AgentApi.chatWsUrl(convId));
    const opening = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const cur = states.get(convId);
        if (cur && cur.ws === ws) {
          update(convId, { ws: null, wsOpening: null, replayActive: false });
        }
        try { ws.close(1000, 'open failed'); } catch {}
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('WebSocket connect timed out')), 5000);
      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        console.log('[diag]', new Date().toISOString(), 'ws-open', 'conv=' + convId.slice(0,8));
        const cur = states.get(convId);
        if (cur && cur.ws === ws) {
          clearReconnectTimer(convId);
          update(convId, {
            wsOpening: null,
            wsReconnectAttempts: 0,
            lastFrameAt: Date.now(),
          });
          scheduleReconcileActiveStream(convId, ws);
        }
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => { fail(new Error('WebSocket failed')); }, { once: true });
    });
    ws.onmessage = (evt) => {
      let frame;
      try { frame = JSON.parse(evt.data); } catch { return; }
      handleFrame(convId, frame);
    };
    ws.onerror = () => {
      console.log('[diag]', new Date().toISOString(), 'ws-error', 'conv=' + convId.slice(0,8));
    };
    ws.onclose = (ev) => {
      console.log('[diag]', new Date().toISOString(), 'ws-close', 'conv=' + convId.slice(0,8), 'code=' + (ev?.code ?? '?'), 'reason=' + (ev?.reason || ''));
      const cur = states.get(convId);
      if (!cur || cur.ws !== ws) return;
      clearReconcileTimer(convId);
      update(convId, { ws: null, wsOpening: null, replayActive: false });
      const reason = ev?.reason || '';
      const deliberate = ev?.code === 1000 && (reason === 'user request' || reason === 'Replaced by new connection');
      const revalidating = ev?.code === 4000 || reason === 'revalidating';
      if (!deliberate && !revalidating && (cur.streaming || cur.uiState === 'streaming')) {
        scheduleReconnect(convId);
      }
    };
    update(convId, { ws, wsOpening: opening });
    return opening;
  }

  function closeWs(convId){
    const s = states.get(convId);
    if (s && s.ws) {
      try { s.ws.close(1000, 'user request'); } catch {}
    }
  }

  function ensurePlaceholder(convId){
    const s = states.get(convId);
    if (!s) return null;
    if (s.streamingMsgId) return s.streamingMsgId;
    const id = 'pending-assistant-' + Date.now() + '-' + Math.random().toString(16).slice(2, 6);
    const backend = s.conv ? s.conv.backend : '';
    const ts = new Date().toISOString();
    update(convId, cur => ({
      ...cur,
      streamingMsgId: id,
      messages: [...cur.messages, {
        id, role: 'assistant', content: '', backend: backend || '',
        timestamp: ts, contentBlocks: [],
      }],
    }));
    return id;
  }

  function appendTextOrThinking(convId, kind, content){
    if (!content) return;
    const id = ensurePlaceholder(convId);
    if (!id) return;
    update(convId, cur => ({
      ...cur,
      messages: cur.messages.map(m => {
        if (m.id !== id) return m;
        const blocks = Array.isArray(m.contentBlocks) ? [...m.contentBlocks] : [];
        const last = blocks[blocks.length - 1];
        if (last && last.type === kind) {
          blocks[blocks.length - 1] = { type: kind, content: (last.content || '') + content };
        } else {
          blocks.push({ type: kind, content });
        }
        const nextContent = blocks.filter(b => b.type === 'text').map(b => b.content).join('');
        return { ...m, contentBlocks: blocks, content: nextContent };
      }),
    }));
  }

  function pushToolBlock(convId, activity){
    const id = ensurePlaceholder(convId);
    if (!id) return;
    update(convId, cur => ({
      ...cur,
      messages: cur.messages.map(m => {
        if (m.id !== id) return m;
        const blocks = Array.isArray(m.contentBlocks) ? [...m.contentBlocks] : [];
        blocks.push({ type: 'tool', activity });
        return { ...m, contentBlocks: blocks };
      }),
    }));
  }

  function patchToolOutcomes(convId, outcomes){
    const s = states.get(convId);
    if (!s) return;
    const id = s.streamingMsgId;
    if (!id || !Array.isArray(outcomes) || !outcomes.length) return;
    update(convId, cur => {
      const next = cur.messages.map(m => {
        if (m.id !== id) return m;
        if (!Array.isArray(m.contentBlocks)) return m;
        let changed = false;
        const blocks = m.contentBlocks.map(b => {
          if (b.type !== 'tool') return b;
          const out = outcomes.find(o => o.toolUseId && b.activity.id === o.toolUseId);
          if (!out) return b;
          changed = true;
          const duration = b.activity.duration != null
            ? b.activity.duration
            : (b.activity.startTime ? Math.max(0, Date.now() - b.activity.startTime) : null);
          return {
            type: 'tool',
            activity: {
              ...b.activity,
              outcome: out.outcome || undefined,
              status: out.status || undefined,
              duration,
            },
          };
        });
        return changed ? { ...m, contentBlocks: blocks } : m;
      });
      return { ...cur, messages: next };
    });
  }

  function refreshPlanUsageForSnapshot(snapshot){
    const conv = snapshot && snapshot.conv;
    if (!conv) return;
    const cliProfileId = conv.cliProfileId || null;
    const store = conv.backend === 'claude-code' ? window.PlanUsageStore
      : conv.backend === 'kiro'        ? window.KiroPlanUsageStore
      : conv.backend === 'codex'       ? window.CodexPlanUsageStore
      : null;
    if (!store || typeof store.refresh !== 'function') return;
    store.refresh(cliProfileId);
    /* The server starts profile plan-usage refresh after it emits `done`.
       Read the cache again shortly after so the tooltip picks up the
       just-refreshed profile snapshot instead of racing the first read. */
    window.setTimeout(() => store.refresh(cliProfileId), 2500);
    window.setTimeout(() => store.refresh(cliProfileId), 10000);
  }

  function handleFrame(convId, frame){
    if (!frame || typeof frame !== 'object') return;
    const s = states.get(convId);
    if (!s) return;
    update(convId, { lastFrameAt: Date.now() });
    if (frame.type !== 'text' && frame.type !== 'thinking') {
      console.log('[diag]', new Date().toISOString(), 'frame', 'conv=' + convId.slice(0,8), 'type=' + frame.type,
        frame.message ? ('msgId=' + String(frame.message.id || '').slice(0,16)) : '');
    }

    if (frame.type === 'text') {
      appendTextOrThinking(convId, 'text', typeof frame.content === 'string' ? frame.content : '');
      return;
    }
    if (frame.type === 'thinking') {
      appendTextOrThinking(convId, 'thinking', typeof frame.content === 'string' ? frame.content : '');
      return;
    }
    if (frame.type === 'tool_activity') {
      if (frame.isPlanMode) {
        if (frame.planAction === 'enter') {
          update(convId, { planModeActive: true });
        } else if (frame.planAction === 'exit') {
          const planContent = typeof frame.planContent === 'string' ? frame.planContent : '';
          update(convId, {
            pendingInteraction: { type: 'planApproval', planContent },
            planModeActive: false,
            uiState: 'awaiting',
          });
        }
        return;
      }
      if (frame.isQuestion) {
        const qs = Array.isArray(frame.questions) ? frame.questions : [];
        const first = qs[0] || {};
        update(convId, {
          pendingInteraction: {
            type: 'userQuestion',
            question: first.question || frame.description || 'Input needed',
            options: Array.isArray(first.options) ? first.options : [],
          },
          uiState: 'awaiting',
        });
        return;
      }
      pushToolBlock(convId, {
        tool: frame.tool,
        description: frame.description || '',
        id: frame.id || null,
        duration: null,
        startTime: Date.now(),
        isAgent: frame.isAgent || undefined,
        subagentType: frame.subagentType || undefined,
        parentAgentId: frame.parentAgentId || undefined,
      });
      return;
    }
    if (frame.type === 'tool_outcomes') {
      patchToolOutcomes(convId, frame.outcomes);
      return;
    }
    if (frame.type === 'assistant_message' && frame.message) {
      update(convId, cur => {
        const phId = cur.streamingMsgId;
        const matched = phId && cur.messages.some(m => m.id === phId);
        const incomingId = frame.message.id;
        /* Drop any prior message with the incoming id BEFORE deciding
           replace-vs-append. The server's per-conv buffer replays every
           past event whenever a fresh WS connects (page reload, sleep
           wake, network change, `online` event, visibility revalidation
           ≥30s). When that replay happens after a turn already completed,
           the original final message is still in `messages`, the replayed
           text deltas spin up a NEW placeholder via ensurePlaceholder
           (because streamingMsgId was cleared by the prior `done`), and
           the replayed assistant_message would replace that placeholder
           with a frame whose id matches the original — leaving two
           entries with the same id in the array. Filtering by id first
           collapses both replay variants (with or without a fresh
           placeholder) into a single entry. */
        const dupExists = incomingId && cur.messages.some(m => m.id === incomingId && m.id !== phId);
        const cleaned = dupExists
          ? cur.messages.filter(m => m.id !== incomingId)
          : cur.messages;
        const phStillPresent = phId && cleaned.some(m => m.id === phId);
        const mode = phStillPresent
          ? (dupExists ? 'replace-placeholder+drop-dup' : 'replace-placeholder')
          : (dupExists ? 'replace-duplicate' : 'append');
        console.log('[diag]', new Date().toISOString(), 'assistant_message-apply',
          'conv=' + convId.slice(0,8),
          'phId=' + (phId ? String(phId).slice(0,16) : 'null'),
          'matched=' + matched,
          'incomingId=' + String(incomingId || '').slice(0,16),
          'incomingTs=' + (frame.message.timestamp || 'null'),
          'mode=' + mode);
        const messages = phStillPresent
          ? cleaned.map(m => m.id === phId ? frame.message : m)
          : [...cleaned, frame.message];
        return { ...cur, messages, streamingMsgId: null };
      });
      diagSnap(convId, 'assistant_message-after');
      bumpConvListActivity(convId, frame.message.timestamp);
      return;
    }
    if (frame.type === 'turn_complete') {
      /* V1 uses this to archive active tools/agents into history. V2's
         contentBlocks already live on the per-turn assistant message and tool
         outcomes mutate in place, so the turn split from `assistant_message`
         above is sufficient. Claude-Code-only frame; Kiro never emits it. */
      return;
    }
    if (frame.type === 'replay_start') {
      console.log('[diag]', new Date().toISOString(), 'replay_start',
        'conv=' + convId.slice(0,8),
        'bufferedEvents=' + (frame.bufferedEvents ?? '?'));
      diagSnap(convId, 'replay_start-before');
      clearReconcileTimer(convId);
      /* Server is about to replay the full per-conv WS buffer (ws.ts
         replayBuffer). Wipe the streaming placeholder's contentBlocks and
         any partial accumulated interaction state so the replayed frames
         rebuild cleanly instead of duplicating what we already have in
         memory. Keep streamingMsgId so replayed text/tool frames land on
         the same placeholder id. Backend-agnostic — buffer is transport
         layer, affects both Claude Code and Kiro. */
      update(convId, cur => {
        if (!cur.streamingMsgId) return { ...cur, replayActive: true };
        return {
          ...cur,
          replayActive: true,
          messages: cur.messages.map(m =>
            m.id === cur.streamingMsgId ? { ...m, contentBlocks: [], content: '' } : m
          ),
          pendingInteraction: null,
          planModeActive: false,
        };
      });
      return;
    }
    if (frame.type === 'replay_end') {
      diagSnap(convId, 'replay_end-after');
      update(convId, { replayActive: false });
      const cur = states.get(convId);
      if (cur && cur.ws && (cur.streaming || cur.uiState === 'streaming')) {
        scheduleReconcileActiveStream(convId, cur.ws);
      }
      return;
    }
    if (frame.type === 'title_updated' && typeof frame.title === 'string') {
      update(convId, cur => ({
        ...cur,
        conv: cur.conv ? { ...cur.conv, title: frame.title } : cur.conv,
      }));
      patchConvListItem(convId, { title: frame.title });
      return;
    }
    if (frame.type === 'usage') {
      if (frame.sessionUsage) update(convId, { usage: frame.sessionUsage });
      return;
    }
    if (frame.type === 'error') {
      const msg = typeof frame.error === 'string' ? frame.error : 'Stream error';
      if (frame.terminal === false) {
        console.warn('[stream-warning]', msg);
        return;
      }
      update(convId, { streamError: msg, uiState: 'error', pendingInteraction: null, planModeActive: false });
      return;
    }
    if (frame.type === 'done') {
      const wasLocallyStreaming = !!states.get(convId)?.streaming;
      clearReconnectTimer(convId);
      clearReconcileTimer(convId);
      /* Flag conversation unread when a response completes on a non-active
         conv and we're landing in the idle resting state (no error, no
         pending interaction). The server persists via PATCH /unread so the
         dot survives reload. */
      const markUnreadNow = wasLocallyStreaming
        && convId !== activeConvId
        && !states.get(convId)?.streamError
        && !states.get(convId)?.pendingInteraction;
      update(convId, cur => ({
        ...cur,
        streaming: false,
        streamingMsgId: null,
        planModeActive: false,
        replayActive: false,
        wsReconnectAttempts: 0,
        uiState: cur.streamError
          ? 'error'
          : cur.pendingInteraction ? 'awaiting' : null,
        unread: markUnreadNow ? true : cur.unread,
      }));
      if (markUnreadNow) {
        AgentApi.markConversationUnread(convId, true).catch(() => {});
      }
      /* Poll the profile-aware plan usage store once per turn. Server floors
         actual upstream API calls; these reads only fan out cached snapshots. */
      if (wasLocallyStreaming) refreshPlanUsageForSnapshot(states.get(convId) || s);
      /* Auto-drain queue — if the just-finished run leaves us idle (no
         pending plan/question, no stream error) and there's a queued
         message, pop the head and send it. */
      if (wasLocallyStreaming) drainQueueIfReady(convId);
      return;
    }
    if (frame.type === 'memory_update') {
      const changed = Array.isArray(frame.changedFiles) ? frame.changedFiles : [];
      const fileCount = typeof frame.fileCount === 'number' ? frame.fileCount : 0;
      const capturedAt = typeof frame.capturedAt === 'string' ? frame.capturedAt : new Date().toISOString();
      const synth = {
        id: 'mem_' + capturedAt + '_' + Math.random().toString(36).slice(2, 8),
        role: 'memory',
        timestamp: capturedAt,
        memoryUpdate: { capturedAt, fileCount, changedFiles: changed },
      };
      update(convId, cur => ({ ...cur, messages: [...cur.messages, synth] }));
      return;
    }
    if (frame.type === 'kb_state_update') {
      const changed = frame.changed || {};
      const cur = states.get(convId);
      if (!cur || !cur.conv) return;
      /* Fan out workspace-scoped KB events so surfaces outside the chat
         conv scope (KB Browser, etc.) can observe. Mirrors V1, where
         `chatKbBrowserState` and the chat renderer both branch off the
         same WS frame. `hash` is the conv's workspace hash so listeners
         can filter to their own workspace. */
      try {
        if (typeof window !== 'undefined' && cur.conv.workspaceHash) {
          window.dispatchEvent(new CustomEvent('ac:kb-state-update', {
            detail: { hash: cur.conv.workspaceHash, changed },
          }));
        }
      } catch (_) { /* noop */ }
      if (!cur.conv.kb) return;
      const kb = { ...cur.conv.kb };
      if (changed.stopping) kb.dreamingStopping = true;
      if (changed.dreamProgress) {
        kb.dreamingStatus = 'running';
        kb._dreamProgress = changed.dreamProgress;
      }
      update(convId, curState => ({ ...curState, conv: { ...curState.conv, kb } }));
      /* Any event that changes the count of pending-digestion or
         pending-synthesis items requires a refetch so the composer's KB
         status icon sees accurate `pendingDigestions` / `pendingEntries`.
         `synthesis` covers dream completion, `raw` covers ingestion
         add/delete, `entries` covers digest completion, and `digestion`
         covers digestion-session transitions (active true↔false). */
      const needsRefresh = (
        (changed.synthesis && !changed.stopping) ||
        (Array.isArray(changed.raw) && changed.raw.length > 0) ||
        (Array.isArray(changed.entries) && changed.entries.length > 0) ||
        (changed.digestion && typeof changed.digestion.active === 'boolean')
      );
      if (needsRefresh) {
        AgentApi.fetch('conversations/' + encodeURIComponent(convId))
          .then(r => r.json())
          .then(data => {
            const s2 = states.get(convId);
            if (!s2) return;
            update(convId, c => ({ ...c, conv: data }));
          })
          .catch(() => {});
      }
      return;
    }
  }

  /* Compose the outgoing content string from a QueuedMessage. Wire format is
     unchanged — we still append `[Uploaded files: <abs paths>]` so Claude
     reads the files from disk. The typed chips are a UI concern only. */
  function composeWireContent(qm){
    const text = typeof qm.content === 'string' ? qm.content : '';
    const atts = Array.isArray(qm.attachments) ? qm.attachments : [];
    if (!atts.length) return text;
    const paths = atts.map(a => a.path).filter(Boolean).join(', ');
    if (!paths) return text;
    return text
      ? text + '\n\n[Uploaded files: ' + paths + ']'
      : '[Uploaded files: ' + paths + ']';
  }

  function diagSnap(convId, label){
    const s = states.get(convId);
    if (!s) { console.log('[diag]', new Date().toISOString(), label, 'conv=' + convId.slice(0,8), 'NO_STATE'); return; }
    const last3 = (s.messages || []).slice(-3).map(m => ({
      id: m.id ? String(m.id).slice(0,16) : null,
      role: m.role,
      ts: m.timestamp || null,
      snippet: typeof m.content === 'string' ? m.content.slice(0, 50) : '[blocks]',
    }));
    console.log('[diag]', new Date().toISOString(), label,
      'conv=' + convId.slice(0,8),
      'len=' + (s.messages?.length ?? 0),
      'streamingMsgId=' + (s.streamingMsgId ? String(s.streamingMsgId).slice(0,16) : 'null'),
      'wsReady=' + (s.ws ? s.ws.readyState : 'no-ws'),
      'last3=', last3);
  }

  async function send(convId, text){
    const s = states.get(convId);
    if (!s || s.sending || s.streaming) return;
    const doneAtts = s.pendingAttachments.filter(f => f.status === 'done');
    const hasUploading = s.pendingAttachments.some(f => f.status === 'uploading');
    if (hasUploading) return;
    if (!text && doneAtts.length === 0) return;
    diagSnap(convId, 'send-entry');

    /* Snapshot pendingAttachments and input so we can restore on POST
       failure — the files are still on the server so we don't need to
       re-upload, and the user shouldn't have to retype their message. */
    const attsSnapshot = s.pendingAttachments.slice();
    const inputSnapshot = s.input;
    const attachmentsMeta = doneAtts.map(f => f.result).filter(Boolean);
    const qm = { content: text || '', attachments: attachmentsMeta };
    const content = composeWireContent(qm);

    /* Flush the persisted draft *before* the optimistic wipe so a pending
       debounce timer can't fire later and erase localStorage with the
       wiped state. On POST failure we keep this copy intact for refresh. */
    flushDraftNow(convId);

    update(convId, { sending: true, streamError: null, pendingInteraction: null, pendingAttachments: [] });

    try {
      await ensureWsOpen(convId);
    } catch (err) {
      update(convId, { streamError: err.message || String(err), sending: false, pendingAttachments: attsSnapshot, input: inputSnapshot });
      return;
    }

    const now = new Date().toISOString();
    const tempUserId = 'pending-user-' + Date.now();
    const tempAssistId = 'pending-assistant-' + Date.now();
    const sendCliProfileId = s.composerCliProfileId || (s.conv && s.conv.cliProfileId) || '';
    const sendBackend = s.composerBackend || (s.conv && s.conv.backend) || '';
    const sendModel = s.composerModel || null;
    const sendEffort = s.composerEffort || null;

    update(convId, cur => ({
      ...cur,
      messages: [
        ...cur.messages,
        { id: tempUserId, role: 'user', content, backend: sendBackend, timestamp: now },
        { id: tempAssistId, role: 'assistant', content: '', backend: sendBackend, timestamp: now, contentBlocks: [] },
      ],
      streamingMsgId: tempAssistId,
      streaming: true,
      uiState: 'streaming',
      input: '',
    }));
    diagSnap(convId, 'send-post-optimistic');

    try {
      const body = { content };
      if (sendCliProfileId) body.cliProfileId = sendCliProfileId;
      if (sendBackend) body.backend = sendBackend;
      if (sendModel)   body.model   = sendModel;
      if (sendEffort)  body.effort  = sendEffort;
      const res = await AgentApi.fetch('conversations/' + encodeURIComponent(convId) + '/message', {
        method: 'POST',
        body,
      });
      const data = await res.json();
      if (data && data.userMessage && data.userMessage.id) {
        const authoritativeUser = data.userMessage;
        update(convId, cur => ({
          ...cur,
          messages: cur.messages.map(m => m.id === tempUserId ? authoritativeUser : m),
          /* Reflect the picker values the server just persisted so the conv
             record matches its truth after a backend/model/effort change. */
          conv: cur.conv ? {
            ...cur.conv,
            cliProfileId: sendCliProfileId || cur.conv.cliProfileId,
            backend: sendBackend || cur.conv.backend,
            model:   sendModel   !== null ? sendModel   : cur.conv.model,
            effort:  sendEffort  !== null ? sendEffort  : cur.conv.effort,
          } : cur.conv,
        }));
        bumpConvListActivity(convId, authoritativeUser.timestamp);
      }
      /* Draft wiped only on server-confirmed success — keep the persisted
         copy through a POST failure so a session-expired retry after reload
         still has the user's content. */
      clearDraft(convId);
    } catch (err) {
      if (err && err.status === 409) {
        update(convId, cur => ({
          ...cur,
          streamError: null,
          streaming: true,
          streamingMsgId: null,
          uiState: 'streaming',
          messages: cur.messages.filter(m => m.id !== tempUserId && m.id !== tempAssistId),
          pendingAttachments: attsSnapshot,
          input: inputSnapshot,
        }));
        ensureWsOpen(convId).catch(() => {});
        return;
      }
      update(convId, cur => ({
        ...cur,
        streamError: err.message || String(err),
        streaming: false,
        streamingMsgId: null,
        uiState: 'error',
        messages: cur.messages.filter(m => m.id !== tempUserId && m.id !== tempAssistId),
        pendingAttachments: attsSnapshot,
        input: inputSnapshot,
      }));
    } finally {
      update(convId, { sending: false });
    }
  }

  function setInput(convId, value){
    const s = states.get(convId);
    if (!s || s.input === value) return;
    update(convId, { input: value });
    scheduleDraftSave(convId);
  }

  /* Attachments — uploads land in the conv's artifacts dir and their typed
     AttachmentMeta (server-inferred kind + meta sublabel) rides along with
     the next /message as `[Uploaded files: p1, p2, …]` appended to the
     outgoing content string. */
  function nextAttachmentId(){
    return 'pa-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8);
  }

  function addAttachments(convId, files){
    if (!files || !files.length) return;
    const entries = Array.from(files).map(file => ({
      id: nextAttachmentId(),
      file,
      status: 'uploading',
      progress: 0,
      result: null,
      xhr: null,
      error: null,
    }));
    update(convId, cur => ({ ...cur, pendingAttachments: [...cur.pendingAttachments, ...entries] }));
    entries.forEach(entry => {
      AgentApi.conv.uploadFile(
        convId,
        entry.file,
        (loaded, total) => {
          const pct = total ? Math.round((loaded / total) * 100) : 0;
          update(convId, cur => ({
            ...cur,
            pendingAttachments: cur.pendingAttachments.map(f => f.id === entry.id ? { ...f, progress: pct } : f),
          }));
        },
        (xhr) => {
          update(convId, cur => ({
            ...cur,
            pendingAttachments: cur.pendingAttachments.map(f => f.id === entry.id ? { ...f, xhr } : f),
          }));
        },
      ).then(result => {
        update(convId, cur => ({
          ...cur,
          pendingAttachments: cur.pendingAttachments.map(f => f.id === entry.id
            ? { ...f, status: 'done', progress: 100, result, xhr: null } : f),
        }));
        scheduleDraftSave(convId);
      }).catch(err => {
        if (err && err.aborted) return;
        update(convId, cur => ({
          ...cur,
          pendingAttachments: cur.pendingAttachments.map(f => f.id === entry.id
            ? { ...f, status: 'error', xhr: null, error: err.message || 'Upload failed' } : f),
        }));
      });
    });
  }

  function removeAttachment(convId, attachmentId){
    const s = states.get(convId);
    if (!s) return;
    const entry = s.pendingAttachments.find(f => f.id === attachmentId);
    if (!entry) return;
    if (entry.status === 'uploading' && entry.xhr) {
      try { entry.xhr.abort(); } catch {}
    }
    if (entry.status === 'done' && entry.result) {
      AgentApi.conv.deleteUpload(convId, entry.result.name).catch(() => {});
    }
    update(convId, cur => ({
      ...cur,
      pendingAttachments: cur.pendingAttachments.filter(f => f.id !== attachmentId),
    }));
    scheduleDraftSave(convId);
  }

  /* OCR a pending image attachment into Markdown via a one-shot CLI call
     on the server. Returns the Markdown so the caller can splice it into
     the composer at the cursor. Caches the result on the attachment so a
     re-click is instant (no second CLI spin-up). */
  async function ocrAttachment(convId, attachmentId){
    const s = states.get(convId);
    if (!s) throw new Error('Conversation not loaded');
    const entry = s.pendingAttachments.find(f => f.id === attachmentId);
    if (!entry) throw new Error('Attachment not found');
    if (entry.status !== 'done' || !entry.result || !entry.result.path) {
      throw new Error('Attachment not yet uploaded');
    }
    if (entry.result.kind !== 'image') {
      throw new Error('OCR is only available for images');
    }
    if (entry.ocrMarkdown) return entry.ocrMarkdown;
    if (entry.ocrStatus === 'running') {
      throw new Error('OCR already in progress');
    }
    update(convId, cur => ({
      ...cur,
      pendingAttachments: cur.pendingAttachments.map(f => f.id === attachmentId
        ? { ...f, ocrStatus: 'running', ocrError: null } : f),
    }));
    try {
      const { markdown } = await AgentApi.conv.ocrAttachment(convId, entry.result.path);
      update(convId, cur => ({
        ...cur,
        pendingAttachments: cur.pendingAttachments.map(f => f.id === attachmentId
          ? { ...f, ocrStatus: 'done', ocrMarkdown: markdown, ocrError: null } : f),
      }));
      return markdown;
    } catch (err) {
      update(convId, cur => ({
        ...cur,
        pendingAttachments: cur.pendingAttachments.map(f => f.id === attachmentId
          ? { ...f, ocrStatus: 'error', ocrError: err.message || 'OCR failed' } : f),
      }));
      throw err;
    }
  }

  /* Clear the composer's pending attachments without deleting the uploads.
     Used when detaching them into a queued message — the server copies stay
     put, and the queue entry carries the AttachmentMeta references. */
  function clearPendingAttachments(convId){
    const s = states.get(convId);
    if (!s || !s.pendingAttachments.length) return;
    update(convId, { pendingAttachments: [] });
    scheduleDraftSave(convId);
  }

  /* Composer picker setters — the three values are flushed to the server as
     part of the next POST /message (see send()). Changing them locally does
     not hit the server until then. */
  function setComposerBackend(convId, value){
    const s = states.get(convId);
    if (!s || s.composerBackend === value) return;
    update(convId, { composerBackend: value || null });
  }
  function setComposerCliProfile(convId, profileId, backendId){
    const s = states.get(convId);
    if (!s) return;
    update(convId, {
      composerCliProfileId: profileId || null,
      composerBackend: backendId || null,
      composerModel: null,
      composerEffort: null,
    });
  }
  function setComposerModel(convId, value){
    const s = states.get(convId);
    if (!s || s.composerModel === value) return;
    update(convId, { composerModel: value || null });
  }
  function setComposerEffort(convId, value){
    const s = states.get(convId);
    if (!s || s.composerEffort === value) return;
    update(convId, { composerEffort: value || null });
  }

  /* ── Message queue ───────────────────────────────────────────────────────
     The queue persists server-side under the conversation record. The client
     mirrors it so the UI can render rows with their attachment strips during
     a live run. On `done` frames we auto-drain the head. All mutating calls
     optimistically update local state, then PUT the full queue. */

  async function loadQueue(convId){
    const s = ensureState(convId);
    try {
      const res = await AgentApi.fetch('conversations/' + encodeURIComponent(convId) + '/queue');
      const data = await res.json();
      const queue = Array.isArray(data && data.queue) ? data.queue : [];
      update(convId, { queue });
      return queue;
    } catch (err) {
      update(convId, { streamError: err.message || String(err) });
      return s.queue || [];
    }
  }

  function strippedQueueForPersist(queue){
    /* Strip client-only `inFlight` markers before persisting — the server
       already sees the in-flight head as drained. Without this filter, an
       enqueue during a live send would re-seed the in-flight item on the
       server, causing a duplicate send after the current one completes. */
    return (queue || [])
      .filter(q => q && !q.inFlight)
      .map(q => ({ content: q.content, attachments: q.attachments }));
  }

  async function drainQueuePersistRequests(convId, state){
    state.inFlight = true;
    try {
      while (state.pending) {
        const request = state.pending;
        state.pending = null;
        try {
          if (request.method === 'DELETE') {
            await AgentApi.fetch('conversations/' + encodeURIComponent(convId) + '/queue', { method: 'DELETE' });
          } else {
            await AgentApi.fetch('conversations/' + encodeURIComponent(convId) + '/queue', {
              method: 'PUT',
              body: { queue: request.queue },
            });
          }
        } catch (err) {
          update(convId, { streamError: err.message || String(err) });
        }
      }
    } finally {
      state.inFlight = false;
      const waiters = state.waiters.splice(0);
      waiters.forEach(resolve => resolve());
      if (!state.pending) queuePersistStates.delete(convId);
    }
  }

  function enqueueQueuePersistRequest(convId, request){
    let state = queuePersistStates.get(convId);
    if (!state) {
      state = { inFlight: false, pending: null, waiters: [] };
      queuePersistStates.set(convId, state);
    }
    state.pending = request;
    if (state.inFlight) {
      return new Promise(resolve => { state.waiters.push(resolve); });
    }
    return drainQueuePersistRequests(convId, state);
  }

  async function persistQueue(convId, queue){
    await enqueueQueuePersistRequest(convId, {
      method: 'PUT',
      queue: strippedQueueForPersist(queue),
    });
  }

  async function enqueue(convId, content, attachments){
    const s = ensureState(convId);
    const qm = {
      content: typeof content === 'string' ? content : '',
      attachments: Array.isArray(attachments) ? attachments : [],
    };
    const next = [...(s.queue || []), qm];
    /* Fresh enqueue clears the suspended flag — the user has just added a
       new item, which is the clearest signal that they intend the queue to
       drain normally. Mirrors V1's behavior of clearing suspension on any
       fresh user action affecting the queue. */
    update(convId, { queue: next, queueSuspended: false });
    /* Content moved to the queue — drop the draft. If the caller follows up
       by also clearing the composer input (ChatLive.doEnqueue does), the
       scheduleDraftSave that would fire from setInput('') is redundant but
       harmless since the trimmed-empty check in writeDraft just removes the
       key again. */
    clearDraft(convId);
    await persistQueue(convId, next);
  }

  async function removeFromQueue(convId, index){
    const s = ensureState(convId);
    const cur = Array.isArray(s.queue) ? s.queue : [];
    if (index < 0 || index >= cur.length) return;
    const next = cur.slice(0, index).concat(cur.slice(index + 1));
    update(convId, { queue: next });
    await persistQueue(convId, next);
  }

  async function reorderQueue(convId, fromIndex, toIndex){
    const s = ensureState(convId);
    const cur = Array.isArray(s.queue) ? s.queue : [];
    if (fromIndex < 0 || fromIndex >= cur.length) return;
    if (toIndex < 0 || toIndex >= cur.length) return;
    if (fromIndex === toIndex) return;
    const next = cur.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    update(convId, { queue: next });
    await persistQueue(convId, next);
  }

  async function updateQueueItem(convId, index, patch){
    const s = ensureState(convId);
    const cur = Array.isArray(s.queue) ? s.queue : [];
    if (index < 0 || index >= cur.length) return;
    const existing = cur[index];
    const merged = {
      content: typeof patch.content === 'string' ? patch.content : existing.content,
      attachments: Array.isArray(patch.attachments) ? patch.attachments : existing.attachments,
    };
    const next = cur.slice();
    next[index] = merged;
    update(convId, { queue: next });
    await persistQueue(convId, next);
  }

  async function clearQueue(convId){
    update(convId, { queue: [], queueSuspended: false });
    await enqueueQueuePersistRequest(convId, { method: 'DELETE' });
  }

  /* Called from the suspended-queue banner. Clears the suspended flag and
     kicks the drainer, which will send the head of the restored queue.
     Mirrors V1 `public/js/streaming.js:58-66`. */
  function resumeSuspendedQueue(convId){
    const s = states.get(convId);
    if (!s) return;
    update(convId, { queueSuspended: false });
    drainQueueIfReady(convId);
  }

  /* Auto-drain: called on every `done` frame. If the conversation is now idle
     (no awaiting interaction, no stream error) and the queue has items, pop
     the head and send it. Uses setTimeout to yield control so the `done`
     state commit lands first and any subscribers see streaming=false before
     the next send flips it back. */
  function drainQueueIfReady(convId){
    const s = states.get(convId);
    if (!s) return;
    if (s.streaming || s.sending) return;
    if (s.pendingInteraction || s.streamError) return;
    /* Suspended queues — restored from a previous session — never auto-drain.
       User must explicitly Resume via the suspended-queue banner. */
    if (s.queueSuspended) return;
    const queue = Array.isArray(s.queue) ? s.queue : [];
    if (!queue.length) return;
    const head = queue[0];
    const rest = queue.slice(1);
    /* Keep the head in the queue with `inFlight: true` so `QueueRow` can
       swap its badge to "Sending…" and hide the mutating actions while the
       send is in flight. The flag is cleared when the pending user message
       appears in the feed (sendWireContent), or on error. Mirrors V1
       `public/js/streaming.js:29`. Server persistence is handled by
       `sendWireContent` once `/message` accepts the send, or after rollback
       restores the head. */
    update(convId, { queue: [{ ...head, inFlight: true }, ...rest] });
    setTimeout(() => { sendWireContent(convId, head); }, 0);
  }

  /* Best-effort: ask the server to abort the in-flight CLI stream through
     REST so Stop works even when browser WebSocket transport is disconnected.
     The server also emits terminal abort frames for any connected/reconnecting
     socket; the local state update below covers the no-socket case. */
  async function stopStream(convId){
    const s = states.get(convId);
    if (!s || !s.streaming) return false;
    const applyAbortFallback = () => {
      update(convId, cur => ({
        ...cur,
        streamError: 'Aborted by user',
        streaming: false,
        streamingMsgId: null,
        pendingInteraction: null,
        planModeActive: false,
        replayActive: false,
        uiState: 'error',
        messages: cur.streamingMsgId
          ? cur.messages.filter(m => m.id !== cur.streamingMsgId)
          : cur.messages,
      }));
    };
    try {
      const result = await AgentApi.abortConversation(convId);
      if (result && result.aborted === false) {
        await refreshConversationFromServer(convId);
        return false;
      }
      clearReconnectTimer(convId);
      clearReconcileTimer(convId);
      applyAbortFallback();
      try {
        await refreshConversationFromServer(convId, { streamError: 'Aborted by user' });
      } catch (_) {
        // Local abort fallback above is authoritative enough to unstick the UI.
      }
      return true;
    } catch (err) {
      update(convId, {
        streamError: err.message || String(err),
        uiState: 'error',
      });
      return false;
    }
  }

  /* Clear a stream error so the conversation returns to idle. When
     `resumeQueue` is true and the queue is non-empty, re-trigger the drainer
     — the head of the queue resumes immediately. Called from the
     StreamErrorCard's Dismiss / Resume buttons. */
  function clearStreamError(convId, opts){
    const s = states.get(convId);
    if (!s) return;
    update(convId, cur => ({
      ...cur,
      streamError: null,
      uiState: cur.pendingInteraction ? 'awaiting' : null,
    }));
    if (opts && opts.resumeQueue) drainQueueIfReady(convId);
  }

  /* Bulk-clear stream errors across every conv. Called by the shell after
     a silent re-auth so stale "session expired" error cards vanish instead
     of sitting around until the user sends again. */
  function clearAllStreamErrors(){
    for (const [convId, s] of states) {
      if (s.streamError) clearStreamError(convId);
    }
  }

  /* Internal — send an already-composed wire-format content string (used by
     the queue drainer; bypasses the pendingAttachments pipeline since the
     attachments were uploaded when the message was queued). */
  async function sendWireContent(convId, queuedMessage){
    const s = states.get(convId);
    if (!s || s.sending || s.streaming) return;
    const originalHead = queuedMessage && typeof queuedMessage === 'object'
      ? {
          content: queuedMessage.content || '',
          attachments: Array.isArray(queuedMessage.attachments) ? queuedMessage.attachments : undefined,
      }
      : { content: String(queuedMessage || ''), attachments: undefined };
    const content = composeWireContent(originalHead);
    if (!content) return;
    const currentQueueTail = (queue) => Array.isArray(queue) ? queue.filter(q => q && !q.inFlight) : [];
    const persistCurrentQueueTail = () => {
      const latest = states.get(convId);
      persistQueue(convId, currentQueueTail(latest && latest.queue)).catch(() => {});
    };
    const restoreQueueAfterFailure = (buildState) => {
      let restoredQueue = [];
      update(convId, cur => {
        restoredQueue = [originalHead, ...currentQueueTail(cur.queue)];
        return buildState(cur, restoredQueue);
      });
      persistQueue(convId, restoredQueue).catch(() => {});
    };

    update(convId, { sending: true, streamError: null, pendingInteraction: null });
    try {
      await ensureWsOpen(convId);
    } catch (err) {
      restoreQueueAfterFailure((cur, restoredQueue) => ({
        ...cur,
        streamError: err.message || String(err),
        sending: false,
        queue: restoredQueue,
      }));
      return;
    }

    const now = new Date().toISOString();
    const tempUserId = 'pending-user-' + Date.now();
    const tempAssistId = 'pending-assistant-' + Date.now();
    const sendCliProfileId = s.composerCliProfileId || (s.conv && s.conv.cliProfileId) || '';
    const sendBackend = s.composerBackend || (s.conv && s.conv.backend) || '';
    const sendModel = s.composerModel || null;
    const sendEffort = s.composerEffort || null;

    update(convId, cur => ({
      ...cur,
      messages: [
        ...cur.messages,
        { id: tempUserId, role: 'user', content, backend: sendBackend, timestamp: now },
        { id: tempAssistId, role: 'assistant', content: '', backend: sendBackend, timestamp: now, contentBlocks: [] },
      ],
      queue: Array.isArray(cur.queue) ? cur.queue.filter(q => !q.inFlight) : [],
      streamingMsgId: tempAssistId,
      streaming: true,
      uiState: 'streaming',
    }));

    try {
      const body = { content };
      if (sendCliProfileId) body.cliProfileId = sendCliProfileId;
      if (sendBackend) body.backend = sendBackend;
      if (sendModel)   body.model   = sendModel;
      if (sendEffort)  body.effort  = sendEffort;
      const res = await AgentApi.fetch('conversations/' + encodeURIComponent(convId) + '/message', {
        method: 'POST',
        body,
      });
      const data = await res.json();
      if (data && data.userMessage && data.userMessage.id) {
        const authoritativeUser = data.userMessage;
        update(convId, cur => ({
          ...cur,
          messages: cur.messages.map(m => m.id === tempUserId ? authoritativeUser : m),
        }));
        bumpConvListActivity(convId, authoritativeUser.timestamp);
      }
      persistCurrentQueueTail();
    } catch (err) {
      if (err && err.status === 409) {
        restoreQueueAfterFailure((cur, restoredQueue) => ({
          ...cur,
          streamError: null,
          streaming: true,
          streamingMsgId: null,
          uiState: 'streaming',
          queue: restoredQueue,
          messages: cur.messages.filter(m => m.id !== tempUserId && m.id !== tempAssistId),
        }));
        ensureWsOpen(convId).catch(() => {});
        return;
      }
      restoreQueueAfterFailure((cur, restoredQueue) => ({
        ...cur,
        streamError: err.message || String(err),
        streaming: false,
        streamingMsgId: null,
        uiState: 'error',
        queue: restoredQueue,
        messages: cur.messages.filter(m => m.id !== tempUserId && m.id !== tempAssistId),
      }));
    } finally {
      update(convId, { sending: false });
    }
  }

  async function reset(convId){
    const s = states.get(convId);
    if (!s || s.streaming || s.sending || s.resetting) return false;
    update(convId, { resetting: true });
    try {
      await AgentApi.fetch('conversations/' + encodeURIComponent(convId) + '/reset', { method: 'POST', body: {} });
      const r = await AgentApi.fetch('conversations/' + encodeURIComponent(convId));
      const data = await r.json();
      update(convId, cur => ({
        ...cur,
        conv: data,
        messages: Array.isArray(data.messages) ? data.messages : [],
        queue: Array.isArray(data.messageQueue) ? data.messageQueue : [],
        usage: data.sessionUsage || null,
        streamError: null,
        streaming: false,
        streamingMsgId: null,
        pendingInteraction: null,
        uiState: null,
        resetting: false,
      }));
      /* Server resets title to 'New Chat' on session reset; mirror that
         in the sidebar list so the row label flips immediately. */
      if (data && typeof data.title === 'string') {
        patchConvListItem(convId, { title: data.title });
      }
      return true;
    } catch (err) {
      update(convId, { streamError: err.message || String(err), resetting: false });
      return false;
    }
  }

  /* Deliver an answer to the active plan/question interaction. When the
     backend has an active CLI stream attached to stdin, the server returns
     `{mode:'stdin'}` and the existing stream will continue to produce frames
     — we just clear the pending interaction. Otherwise `{mode:'message'}`
     means the stream is over and the answer must be sent as a fresh user
     message via the normal /message endpoint. */
  async function respond(convId, text){
    const s = states.get(convId);
    if (!s || !text || s.respondPending) return;
    if (!s.pendingInteraction) return;

    update(convId, { respondPending: true });

    let mode;
    try {
      const streamActive = s.streaming || s.sending;
      const res = await AgentApi.fetch(
        'conversations/' + encodeURIComponent(convId) + '/input',
        { method: 'POST', body: { text, streamActive } }
      );
      const data = await res.json();
      mode = data && data.mode;
    } catch (err) {
      update(convId, { streamError: err.message || String(err), respondPending: false, uiState: 'error' });
      return;
    }

    if (mode === 'stdin') {
      update(convId, cur => ({
        ...cur,
        pendingInteraction: null,
        uiState: cur.streaming
          ? 'streaming'
          : (cur.streamError ? 'error' : null),
        respondPending: false,
      }));
      return;
    }

    update(convId, { pendingInteraction: null, respondPending: false, uiState: null });
    await send(convId, text);
  }

  function patchConv(convId, patch){
    const s = states.get(convId);
    if (!s || !s.conv) return;
    update(convId, cur => ({ ...cur, conv: { ...cur.conv, ...patch } }));
  }

  /* Active conv tracking — the shell pushes this on route change so the
     `done` handler knows whether a completing stream belongs to the
     currently-viewed conv (and should NOT mark unread). */
  function setActiveConvId(id){
    const prev = activeConvId;
    activeConvId = id || null;
    if (prev !== activeConvId) {
      /* Touching the active conv may expose or hide the unread dot on
         whichever row just lost/gained focus — nudge the sidebar. */
      globalSubs.forEach(l => { try { l(); } catch {} });
    }
  }

  /* Mark a conversation as (un)read. Optimistically updates local state so
     the sidebar flips immediately; the server PATCH runs in the background
     and is fire-and-forget — on error the next `/conversations` fetch will
     reconcile. `unread:true` creates a ConvState entry if the user hasn't
     visited the conv this session (manual dot click on a cold row), so
     convStates() can surface it. */
  function markUnread(convId){
    const cur = states.get(convId);
    if (cur && cur.unread) return;
    if (cur) {
      update(convId, { unread: true });
    } else {
      const next = { ...blankState(convId), unread: true };
      const prev = blankState(convId);
      commit(convId, next, prev, true);
    }
    AgentApi.markConversationUnread(convId, true).catch(() => {});
  }

  function markRead(convId){
    const cur = states.get(convId);
    if (cur) {
      if (cur.unread) update(convId, { unread: false });
    } else {
      /* Even cold convs (no ConvState yet) need a touched entry so
         convStates() returns 'idle' and the sidebar overrides the stale
         `c.unread=true` it may still have from the server-cached list. */
      const next = blankState(convId);
      const prev = blankState(convId);
      commit(convId, next, prev, true);
    }
    AgentApi.markConversationUnread(convId, false).catch(() => {});
  }

  async function archive(convId){
    const s = states.get(convId);
    if (!s || s.streaming || s.sending) return false;
    try {
      await AgentApi.fetch('conversations/' + encodeURIComponent(convId) + '/archive', { method: 'PATCH' });
      closeWs(convId);
      const prev = states.get(convId);
      states.delete(convId);
      convSubs.delete(convId);
      if (prev && (prev.uiState || prev.unread)) globalSubs.forEach(l => { try { l(); } catch {} });
      removeConvListItem(convId);
      return true;
    } catch (err) {
      update(convId, { streamError: err.message || String(err) });
      return false;
    }
  }

  /* Re-open every live WebSocket after a long sleep / network change.

     A `WebSocket` that survived the underlying TCP socket dying (laptop
     sleep, NAT rebind on Wi-Fi switch) often sits in `readyState === OPEN`
     for several minutes before the OS surfaces the failure, so naive checks
     of readyState pass and new POSTs proceed without a usable transport.
     The server then receives a /message but no client-driven WS frames,
     and the conversation looks "in-progress" forever after a refresh.

     We force a fresh socket per conv: closing is transport-only, accepted CLI
     streams keep running server-side, and the immediate reopen replays
     anything buffered. The replay handler in handleFrame() wipes the
     streaming placeholder's contentBlocks so duplicate frames don't double
     up. */
  const VISIBILITY_REVALIDATE_THRESHOLD_MS = 30_000;
  let lastHiddenAt = null;

  function revalidateAllSockets(){
    let count = 0;
    for (const [convId, s] of states) {
      if (!s.ws) continue;
      count++;
      console.log('[diag]', new Date().toISOString(), 'revalidate-close', 'conv=' + convId.slice(0,8), 'wsReady=' + s.ws.readyState);
      try { s.ws.close(4000, 'revalidating'); } catch {}
      update(convId, { ws: null, wsOpening: null });
      ensureWsOpen(convId).catch(() => {});
    }
    console.log('[diag]', new Date().toISOString(), 'revalidateAllSockets-done', 'count=' + count);
  }

  function handleVisibilityChange(){
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      lastHiddenAt = Date.now();
      console.log('[diag]', new Date().toISOString(), 'visibility-hidden');
      return;
    }
    const hiddenMs = lastHiddenAt != null ? (Date.now() - lastHiddenAt) : 0;
    console.log('[diag]', new Date().toISOString(), 'visibility-visible', 'hiddenMs=' + hiddenMs);
    /* Brief tab switches must NOT revalidate — replay_start wipes
       contentBlocks and a sub-30s away triggers needless replay churn. */
    if (lastHiddenAt != null && hiddenMs >= VISIBILITY_REVALIDATE_THRESHOLD_MS) {
      revalidateAllSockets();
    }
    lastHiddenAt = null;
  }

  function handleOnline(){
    console.log('[diag]', new Date().toISOString(), 'online-event');
    revalidateAllSockets();
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('online', handleOnline);
  }

  window.StreamStore = {
    getState,
    load,
    ensureWsOpen,
    send,
    respond,
    setInput,
    setComposerCliProfile,
    setComposerBackend,
    setComposerModel,
    setComposerEffort,
    addAttachments,
    removeAttachment,
    ocrAttachment,
    clearPendingAttachments,
    loadQueue,
    enqueue,
    removeFromQueue,
    reorderQueue,
    updateQueueItem,
    clearQueue,
    resumeSuspendedQueue,
    stopStream,
    clearStreamError,
    clearAllStreamErrors,
    reset,
    archive,
    patchConv,
    closeWs,
    subscribe,
    subscribeGlobal,
    convStates,
    setActiveConvId,
    markRead,
    markUnread,
    parseUploadedFilesTag,
    attachmentKindFromPath,
    subscribeConvList,
    getConvList,
    loadConvList,
    refreshConvList,
    hydrateActiveStreams,
    patchConvListItem,
    removeConvListItem,
    prependConvListItem,
    revalidateAllSockets,
    /* Exposed for tests so the threshold logic can be exercised without
       cross-test event-listener interference. Not part of the stable API. */
    _handleVisibilityChange: handleVisibilityChange,
  };
})();
