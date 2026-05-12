/* Agent Cockpit v2 — minimal API client shared across React screens. */
/**
 * @typedef {import('../../../src/contracts/conversations').CreateConversationRequest} CreateConversationRequest
 * @typedef {import('../../../src/contracts/conversations').RenameConversationRequest} RenameConversationRequest
 * @typedef {import('../../../src/contracts/conversations').SetMessagePinnedRequest} SetMessagePinnedRequest
 * @typedef {import('../../../src/contracts/conversations').SetUnreadRequest} SetUnreadRequest
 * @typedef {import('../../../src/contracts/contextMap').ContextMapSettingsRequest} ContextMapSettingsRequest
 * @typedef {import('../../../src/contracts/knowledgeBase').KbFolderCreateRequest} KbFolderCreateRequest
 * @typedef {import('../../../src/contracts/knowledgeBase').KbFolderRenameRequest} KbFolderRenameRequest
 * @typedef {import('../../../src/contracts/memory').MemoryEnabledRequest} MemoryEnabledRequest
 */
  const API_BASE = new URL('./api/', window.location.href.replace(/\/v2\/.*/, '/'));

  function apiUrl(path){
    return new URL(String(path || '').replace(/^\/+/, ''), API_BASE).toString();
  }

  function chatUrl(path){
    return apiUrl('chat/' + String(path || '').replace(/^\/+/, ''));
  }

  function kbUrl(hash, path){
    return apiUrl('chat/workspaces/' + encodeURIComponent(hash) + '/kb/' + String(path || '').replace(/^\/+/, ''));
  }

  function explorerUrl(hash, path, params){
    const base = apiUrl('chat/workspaces/' + encodeURIComponent(hash) + '/explorer/' + String(path || '').replace(/^\/+/, ''));
    if (!params) return base;
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== '')
    ).toString();
    return qs ? `${base}?${qs}` : base;
  }

  function chatWsUrl(convId){
    const u = new URL('chat/conversations/' + encodeURIComponent(convId) + '/ws', API_BASE);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.toString();
  }

  const state = {
    csrfToken: null,
    onSessionExpired: null,
    _backendsCache: null,
    _backendsPromise: null,
    _settingsCache: null,
    _settingsPromise: null,
    _profileMetadataCache: new Map(),
    _profileMetadataPromise: new Map(),
  };

  async function fetchCsrfToken(){
    const res = await fetch(apiUrl('csrf-token'), { credentials: 'same-origin' });
    if (res.status === 401) {
      if (state.onSessionExpired) state.onSessionExpired();
      throw new Error('Session expired');
    }
    if (!res.ok) throw new Error(`CSRF token fetch failed (${res.status})`);
    const body = await res.json();
    state.csrfToken = body.csrfToken;
  }

  /* Returns the logged-in user's display name and auth provider. Used by
     the sidebar footer to render the local owner or provider identity. Local-only
     dev sessions may return null fields — the caller renders a neutral fallback. */
  async function getMe(){
    const res = await fetch(apiUrl('me'), { credentials: 'same-origin' });
    if (res.status === 401) {
      if (state.onSessionExpired) state.onSessionExpired();
      throw new Error('Session expired');
    }
    if (!res.ok) throw new Error(`/api/me failed (${res.status})`);
    return res.json();
  }

  async function chatFetch(path, opts){
    opts = opts || {};
    if (!state.csrfToken) await fetchCsrfToken();
    const headers = Object.assign({}, opts.headers);
    if (state.csrfToken) headers['x-csrf-token'] = state.csrfToken;
    let body = opts.body;
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const res = await fetch(chatUrl(path), Object.assign({}, opts, { headers, body, credentials: 'same-origin' }));
    if (res.status === 401) {
      if (state.onSessionExpired) state.onSessionExpired();
      const e = new Error('Session expired');
      e.status = res.status;
      throw e;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const e = new Error(err.error || res.statusText || `HTTP ${res.status}`);
      e.status = res.status;
      e.body = err;
      throw e;
    }
    return res;
  }

  async function authFetch(path, opts){
    opts = opts || {};
    const method = (opts.method || 'GET').toUpperCase();
    const needsCsrf = opts.csrf !== false && !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (needsCsrf && !state.csrfToken) await fetchCsrfToken();
    const headers = Object.assign({}, opts.headers);
    if (needsCsrf && state.csrfToken) headers['x-csrf-token'] = state.csrfToken;
    let body = opts.body;
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const fetchOpts = Object.assign({}, opts, { method, headers, body, credentials: 'same-origin' });
    delete fetchOpts.csrf;
    const res = await fetch(apiUrl(path), fetchOpts);
    if (res.status === 401) {
      if (state.onSessionExpired) state.onSessionExpired();
      const e = new Error('Session expired');
      e.status = res.status;
      throw e;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const e = new Error(err.error || res.statusText || `HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return res;
  }

  async function listConversations(opts){
    const archived = opts && opts.archived ? 'true' : '';
    const q = (opts && opts.q) || '';
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (archived) params.set('archived', archived);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await chatFetch(`conversations${qs}`);
    const data = await res.json();
    return data.conversations || [];
  }

  /* Returns the IDs of conversations with accepted/preparing/running CLI
     turns on the server. Used on app load to restore sidebar "streaming"
     dots after a page refresh. */
  async function getActiveStreams(){
    const res = await chatFetch('active-streams');
    const data = await res.json();
    return data.ids || [];
  }

  async function browseDir(path, showHidden){
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    if (showHidden) params.set('showHidden', 'true');
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await chatFetch(`browse${qs}`);
    return res.json();
  }

  async function mkdirDir(parentPath, name){
    const res = await chatFetch('mkdir', { method: 'POST', body: { parentPath, name } });
    return res.json();
  }

  async function rmdirDir(dirPath){
    const res = await chatFetch('rmdir', { method: 'POST', body: { dirPath } });
    return res.json();
  }

  /** @param {CreateConversationRequest} body */
  async function createConversation(body){
    const res = await chatFetch('conversations', { method: 'POST', body: body || {} });
    return res.json();
  }

  async function restoreConversation(id){
    const res = await chatFetch('conversations/' + encodeURIComponent(id) + '/restore', { method: 'PATCH' });
    return res.json().catch(() => ({}));
  }

  async function markConversationUnread(id, unread){
    /** @type {SetUnreadRequest} */
    const body = { unread: !!unread };
    const res = await chatFetch('conversations/' + encodeURIComponent(id) + '/unread', {
      method: 'PATCH',
      body,
    });
    return res.json().catch(() => ({}));
  }

  async function setMessagePinned(id, messageId, pinned){
    /** @type {SetMessagePinnedRequest} */
    const body = { pinned: !!pinned };
    const res = await chatFetch(
      'conversations/' + encodeURIComponent(id) + '/messages/' + encodeURIComponent(messageId) + '/pin',
      { method: 'PATCH', body }
    );
    return res.json();
  }

  async function renameConversation(id, title){
    /** @type {RenameConversationRequest} */
    const body = { title };
    const res = await chatFetch('conversations/' + encodeURIComponent(id), {
      method: 'PUT',
      body,
    });
    return res.json();
  }

  async function deleteConversation(id){
    const res = await chatFetch('conversations/' + encodeURIComponent(id), { method: 'DELETE' });
    return res.json().catch(() => ({}));
  }

  async function abortConversation(id){
    const res = await chatFetch('conversations/' + encodeURIComponent(id) + '/abort', { method: 'POST', body: {} });
    return res.json().catch(() => ({}));
  }

  /* Self-update endpoints. `getVersion` is the initial-load fetch (also returns
     the cached remote/update-available flags). `getUpdateStatus` is the 5-min
     background poll. `checkVersion` forces a fresh upstream git-ls-remote.
     `triggerUpdate` pulls, installs, and pm2-restarts — the client treats a
     "Failed to fetch" rejection as a success signal (the process was killed
     mid-request). */
  async function getVersion(){
    const res = await chatFetch('version');
    return res.json();
  }

  async function getUpdateStatus(){
    const res = await chatFetch('update-status');
    return res.json();
  }

  async function getInstallStatus(){
    const res = await chatFetch('install/status');
    return res.json();
  }

  async function getInstallDoctor(){
    const res = await chatFetch('install/doctor');
    return res.json();
  }

  async function completeWelcome(){
    const res = await chatFetch('install/welcome-complete', { method: 'POST', body: {} });
    return res.json();
  }

  async function checkVersion(){
    const res = await chatFetch('check-version', { method: 'POST' });
    return res.json();
  }

  async function triggerUpdate(){
    const res = await chatFetch('update-trigger', { method: 'POST' });
    return res.json();
  }

  async function getCliUpdates(){
    const res = await chatFetch('cli-updates');
    return res.json();
  }

  async function checkCliUpdates(){
    const res = await chatFetch('cli-updates/check', { method: 'POST' });
    return res.json();
  }

  async function triggerCliUpdate(itemId){
    const res = await chatFetch('cli-updates/' + encodeURIComponent(itemId) + '/update', { method: 'POST', body: {} });
    return res.json();
  }

  /* Claude plan usage (Max/Pro rate limit utilization). Server-side cache
     is refreshed opportunistically on server start and after each Claude
     Code assistant turn, floor-throttled to once per 10 minutes. The
     endpoint itself never triggers a fetch — it just returns the cached
     snapshot with a `stale` boolean. */
  async function getClaudePlanUsage(cliProfileId){
    const qs = cliProfileId ? `?cliProfileId=${encodeURIComponent(cliProfileId)}` : '';
    const res = await chatFetch('plan-usage' + qs);
    return res.json();
  }

  /* Kiro plan usage (Amazon Q credits / overages / subscription). Same
     shape of contract as getClaudePlanUsage — server-side cache, 10-min
     floor, endpoint never triggers a fetch. */
  async function getKiroPlanUsage(){
    const res = await chatFetch('kiro-plan-usage');
    return res.json();
  }

  /* Codex plan usage (ChatGPT plan tier + 5-hour/weekly rate-limit
     utilization from `codex app-server`'s `account/read` and
     `account/rateLimits/read` RPCs). Same contract as the others. */
  async function getCodexPlanUsage(cliProfileId){
    const qs = cliProfileId ? `?cliProfileId=${encodeURIComponent(cliProfileId)}` : '';
    const res = await chatFetch('codex-plan-usage' + qs);
    return res.json();
  }

  /* Backend registry is effectively static — one fetch per session is plenty.
     Used by the composer pickers on every ChatLive mount. */
  function getBackendsCached(){
    if (state._backendsCache) return Promise.resolve(state._backendsCache);
    if (state._backendsPromise) return state._backendsPromise;
    state._backendsPromise = chatFetch('backends').then(r => r.json()).then(data => {
      state._backendsCache = (data && data.backends) || [];
      state._backendsPromise = null;
      return state._backendsCache;
    }).catch(err => {
      state._backendsPromise = null;
      throw err;
    });
    return state._backendsPromise;
  }

  function clearProfileMetadataCache(){
    state._profileMetadataCache.clear();
    state._profileMetadataPromise.clear();
  }

  function getCliProfileMetadata(profileId){
    if (!profileId) return Promise.reject(new Error('profileId is required'));
    if (state._profileMetadataCache.has(profileId)) {
      return Promise.resolve(state._profileMetadataCache.get(profileId));
    }
    if (state._profileMetadataPromise.has(profileId)) {
      return state._profileMetadataPromise.get(profileId);
    }
    const promise = chatFetch('cli-profiles/' + encodeURIComponent(profileId) + '/metadata')
      .then(r => r.json())
      .then(data => {
        const backend = data && data.backend ? data.backend : null;
        state._profileMetadataCache.set(profileId, backend);
        state._profileMetadataPromise.delete(profileId);
        return backend;
      })
      .catch(err => {
        state._profileMetadataPromise.delete(profileId);
        throw err;
      });
    state._profileMetadataPromise.set(profileId, promise);
    return promise;
  }

  function getSettingsCached(){
    if (state._settingsCache) return Promise.resolve(state._settingsCache);
    if (state._settingsPromise) return state._settingsPromise;
    state._settingsPromise = chatFetch('settings').then(r => r.json()).then(data => {
      state._settingsCache = data || {};
      state._settingsPromise = null;
      return state._settingsCache;
    }).catch(err => {
      state._settingsPromise = null;
      throw err;
    });
    return state._settingsPromise;
  }

  async function kbFetch(hash, path, opts){
    opts = opts || {};
    if (!state.csrfToken) await fetchCsrfToken();
    const headers = Object.assign({}, opts.headers);
    if (state.csrfToken) headers['x-csrf-token'] = state.csrfToken;
    let body = opts.body;
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const res = await fetch(kbUrl(hash, path), Object.assign({}, opts, { headers, body, credentials: 'same-origin' }));
    if (res.status === 401) {
      if (state.onSessionExpired) state.onSessionExpired();
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText || `HTTP ${res.status}`);
    }
    return res;
  }

  async function kbGet(hash, path, params){
    const qs = params ? new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== '')
    ).toString() : '';
    const res = await kbFetch(hash, qs ? `${path}?${qs}` : path);
    return res.json();
  }

  async function explorerFetch(hash, path, params, opts){
    opts = opts || {};
    if (!state.csrfToken) await fetchCsrfToken();
    const headers = Object.assign({}, opts.headers);
    if (state.csrfToken) headers['x-csrf-token'] = state.csrfToken;
    let body = opts.body;
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const res = await fetch(explorerUrl(hash, path, params), Object.assign({}, opts, { headers, body, credentials: 'same-origin' }));
    if (res.status === 401) {
      if (state.onSessionExpired) state.onSessionExpired();
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const wrapped = new Error(err.error || res.statusText || `HTTP ${res.status}`);
      wrapped.status = res.status;
      wrapped.body = err;
      throw wrapped;
    }
    return res;
  }

  const ExplorerApi = {
    tree: (hash, relPath) => explorerFetch(hash, 'tree', { path: relPath || '' })
      .then(r => r.json()),
    preview: (hash, relPath) => explorerFetch(hash, 'preview', { path: relPath, mode: 'view' })
      .then(r => r.json()),
    rawUrl: (hash, relPath) => explorerUrl(hash, 'preview', { path: relPath, mode: 'raw' }),
    downloadUrl: (hash, relPath) => explorerUrl(hash, 'preview', { path: relPath, mode: 'download' }),
    mkdir: (hash, parent, name) => explorerFetch(hash, 'mkdir', null, {
      method: 'POST', body: { parent: parent || '', name },
    }).then(r => r.json()),
    createFile: (hash, parent, name, content) => explorerFetch(hash, 'file', null, {
      method: 'POST', body: { parent: parent || '', name, content: content || '' },
    }).then(r => r.json()),
    saveFile: (hash, relPath, content) => explorerFetch(hash, 'file', null, {
      method: 'PUT', body: { path: relPath, content: content || '' },
    }).then(r => r.json()),
    rename: (hash, from, to, overwrite) => explorerFetch(hash, 'rename', null, {
      method: 'PATCH', body: { from, to, overwrite: !!overwrite },
    }).then(r => r.json()),
    deleteEntry: (hash, relPath) => explorerFetch(hash, 'entry', { path: relPath }, {
      method: 'DELETE',
    }).then(r => r.json()),
    /* XHR-based upload so we can track progress per file. Returns a Promise
       that resolves to { ok, entry } or rejects with a status-attached Error. */
    upload: (hash, destPath, file, overwrite, onProgress) => new Promise((resolve, reject) => {
      const url = explorerUrl(hash, 'upload', { path: destPath || '', overwrite: overwrite ? 'true' : '' });
      const run = () => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.withCredentials = true;
        if (state.csrfToken) xhr.setRequestHeader('x-csrf-token', state.csrfToken);
        xhr.upload.onprogress = (ev) => {
          if (onProgress && ev.lengthComputable) onProgress(ev.loaded, ev.total);
        };
        xhr.onload = () => {
          let parsed = null;
          try { parsed = JSON.parse(xhr.responseText); } catch { parsed = null; }
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(parsed || { ok: true });
          } else if (xhr.status === 401) {
            if (state.onSessionExpired) state.onSessionExpired();
            const err = new Error('Session expired');
            err.status = 401;
            reject(err);
          } else {
            const err = new Error((parsed && parsed.error) || xhr.statusText || `HTTP ${xhr.status}`);
            err.status = xhr.status;
            err.body = parsed;
            reject(err);
          }
        };
        xhr.onerror = () => {
          const err = new Error('Network error');
          err.status = 0;
          reject(err);
        };
        const fd = new FormData();
        fd.append('file', file);
        xhr.send(fd);
      };
      if (!state.csrfToken) {
        fetchCsrfToken().then(run).catch(reject);
      } else {
        run();
      }
    }),
  };

  const KbApi = {
    getState:       (hash, opts) => kbGet(hash, '', opts || {}).then(r => (r && r.state ? r.state : r)),
    getEntries:     (hash, opts) => kbGet(hash, 'entries', opts || {}),
    getEntry:       (hash, entryId) => kbGet(hash, 'entries/' + encodeURIComponent(entryId)),
    getTags:        (hash) => kbGet(hash, 'tags'),
    getSynthesis:   (hash) => kbGet(hash, 'synthesis'),
    getTopic:       (hash, topicId) => kbGet(hash, 'synthesis/' + encodeURIComponent(topicId)),
    getReflections: (hash) => kbGet(hash, 'reflections'),
    getReflection:  (hash, reflectionId) => kbGet(hash, 'reflections/' + encodeURIComponent(reflectionId)),
    getRawTrace: (hash, rawId) => kbGet(hash, 'raw/' + encodeURIComponent(rawId) + '/trace'),
    backfillStructure: (hash, force) => kbFetch(hash, 'structure/backfill', {
      method: 'POST', body: { force: !!force },
    }).then(r => r.json()),
    rebuildRawStructure: (hash, rawId) => kbFetch(hash, 'raw/' + encodeURIComponent(rawId) + '/structure', {
      method: 'POST', body: {},
    }).then(r => r.json()),
    rawDownloadUrl: (hash, rawId) => kbUrl(hash, 'raw/' + encodeURIComponent(rawId)),
    rawMediaUrl:    (hash, rawId, mediaPath) => kbUrl(
      hash,
      'raw/' + encodeURIComponent(rawId) + '/media/' +
        String(mediaPath || '').split('/').filter(Boolean).map(encodeURIComponent).join('/')
    ),
    setAutoDigest: (hash, enabled) => kbFetch(hash, 'auto-digest', {
      method: 'PUT', body: { autoDigest: !!enabled },
    }).then(r => r.json()),
    setAutoDream: (hash, autoDream) => kbFetch(hash, 'auto-dream', {
      method: 'PUT', body: { autoDream: autoDream || { mode: 'off' } },
    }).then(r => r.json()),
    digestRaw: (hash, rawId) => kbFetch(hash, 'raw/' + encodeURIComponent(rawId) + '/digest', {
      method: 'POST', body: {},
    }).then(r => r.json()),
    digestAll: (hash) => kbFetch(hash, 'digest-all', {
      method: 'POST', body: {},
    }).then(r => r.json()),
    /* `folder` and `filename` are optional — when both are present, only that
       one location is removed; otherwise the rawId is fully purged. */
    deleteRaw: (hash, rawId, folder, filename) => {
      const qs = (folder != null && filename != null)
        ? '?folder=' + encodeURIComponent(folder) + '&filename=' + encodeURIComponent(filename)
        : '';
      return kbFetch(hash, 'raw/' + encodeURIComponent(rawId) + qs, { method: 'DELETE' })
        .then(r => r.json());
    },
    /* Single-file upload. Uses XHR so we can report progress. Resolves to
       { entry, deduped, addedLocation }. Optional `onXhr(xhr)` exposes the
       underlying XHR to callers so they can `.abort()` it (queue Cancel). */
    uploadRaw: (hash, file, folder, onProgress, onXhr) => new Promise((resolve, reject) => {
      const url = kbUrl(hash, 'raw');
      const run = () => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.withCredentials = true;
        if (state.csrfToken) xhr.setRequestHeader('x-csrf-token', state.csrfToken);
        xhr.upload.onprogress = (ev) => {
          if (onProgress && ev.lengthComputable) onProgress(ev.loaded, ev.total);
        };
        xhr.onload = () => {
          let parsed = null;
          try { parsed = JSON.parse(xhr.responseText); } catch { parsed = null; }
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(parsed || { ok: true });
          } else if (xhr.status === 401) {
            if (state.onSessionExpired) state.onSessionExpired();
            const err = new Error('Session expired'); err.status = 401; reject(err);
          } else {
            const err = new Error((parsed && parsed.error) || xhr.statusText || `HTTP ${xhr.status}`);
            err.status = xhr.status; err.body = parsed; reject(err);
          }
        };
        xhr.onerror = () => { const err = new Error('Network error'); err.status = 0; reject(err); };
        xhr.onabort = () => { const err = new Error('Aborted'); err.status = 0; err.aborted = true; reject(err); };
        const fd = new FormData();
        fd.append('file', file);
        if (folder) fd.append('folder', folder);
        if (onXhr) onXhr(xhr);
        xhr.send(fd);
      };
      if (!state.csrfToken) fetchCsrfToken().then(run).catch(reject); else run();
    }),
    /* Folder CRUD. Backend rejects names containing slashes; folderPath is the
       full nested path (e.g. "docs/specs"). createFolder is idempotent. */
    createFolder: (hash, folderPath) => {
      /** @type {KbFolderCreateRequest} */
      const body = { folderPath };
      return kbFetch(hash, 'folders', { method: 'POST', body }).then(r => r.json());
    },
    renameFolder: (hash, fromPath, toPath) => {
      /** @type {KbFolderRenameRequest} */
      const body = { fromPath, toPath };
      return kbFetch(hash, 'folders', { method: 'PUT', body }).then(r => r.json());
    },
    /* `cascade` must be true when the folder (or any descendant) is non-empty;
       backend returns 409 otherwise. */
    deleteFolder: (hash, folderPath, cascade) => {
      const qs = '?folder=' + encodeURIComponent(folderPath) +
                 (cascade ? '&cascade=true' : '');
      return kbFetch(hash, 'folders' + qs, { method: 'DELETE' })
        .then(r => r.json());
    },
    /* Per-workspace embedding configuration for the PGLite vector layer.
       getEmbeddingConfig returns { embeddingConfig: {model?, ollamaHost?, dimensions?} | null };
       setEmbeddingConfig PUTs the same shape and returns { embeddingConfig: <result> };
       embeddingHealth POSTs to test Ollama reachability + model availability,
       resolving to { ok: boolean, error?: string }. */
    getEmbeddingConfig: (hash) => kbFetch(hash, 'embedding-config').then(r => r.json()),
    setEmbeddingConfig: (hash, cfg) => kbFetch(hash, 'embedding-config', {
      method: 'PUT', body: cfg || {},
    }).then(r => r.json()),
    embeddingHealth: (hash) => kbFetch(hash, 'embedding-health', {
      method: 'POST', body: {},
    }).then(r => r.json()),
    getGlossary: (hash) => kbFetch(hash, 'glossary').then(r => r.json()),
    createGlossaryTerm: (hash, term, expansion) => kbFetch(hash, 'glossary', {
      method: 'POST', body: { term, expansion },
    }).then(r => r.json()),
    updateGlossaryTerm: (hash, id, term, expansion) => kbFetch(hash, 'glossary/' + encodeURIComponent(id), {
      method: 'PUT', body: { term, expansion },
    }).then(r => r.json()),
    deleteGlossaryTerm: (hash, id) => kbFetch(hash, 'glossary/' + encodeURIComponent(id), {
      method: 'DELETE',
    }).then(r => r.json()),
    /* Top-level chat routes, not workspace-scoped. */
    pandocStatus: () => chatFetch('kb/pandoc-status').then(r => r.json()),
    libreOfficeStatus: () => chatFetch('kb/libreoffice-status').then(r => r.json()),
  };

  /* Per-workspace settings — backs the Workspace Settings page (gear button
     in the sidebar workspace action buttons). Instructions are prepended
     to every new session's system prompt; Memory + KB enable flags gate the
     respective pipelines for the workspace. All endpoints are scoped by the
     workspace hash that came off the conversation row. */
  const WorkspaceApi = {
    getInstructions: (hash) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/instructions'
    ).then(r => r.json()),
    saveInstructions: (hash, instructions) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/instructions',
      { method: 'PUT', body: { instructions: instructions || '' } },
    ).then(r => r.json()),
    getInstructionCompatibility: (hash) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/instruction-compatibility'
    ).then(r => r.json()),
    createInstructionPointers: (hash) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/instruction-compatibility/pointers',
      { method: 'POST', body: {} },
    ).then(r => r.json()),
    dismissInstructionCompatibility: (hash) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/instruction-compatibility/dismissal',
      { method: 'PUT', body: {} },
    ).then(r => r.json()),
    getMemory: (hash) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/memory'
    ).then(r => r.json()),
    searchMemory: (hash, opts) => {
      const params = new URLSearchParams();
      const query = opts && opts.query ? String(opts.query) : '';
      if (query) params.set('query', query);
      if (opts && opts.limit) params.set('limit', String(opts.limit));
      if (opts && opts.type) params.set('type', String(opts.type));
      if (opts && opts.status) params.set('status', String(opts.status));
      const qs = params.toString() ? '?' + params.toString() : '';
      return chatFetch('workspaces/' + encodeURIComponent(hash) + '/memory/search' + qs).then(r => r.json());
    },
    proposeMemoryConsolidation: (hash) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/memory/consolidate/propose',
      { method: 'POST', body: {} },
    ).then(r => r.json()),
    draftMemoryConsolidation: (hash, action) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/memory/consolidate/draft',
      { method: 'POST', body: { action } },
    ).then(r => r.json()),
    applyMemoryConsolidation: (hash, payload) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/memory/consolidate/apply',
      { method: 'POST', body: payload || { actions: [] } },
    ).then(r => r.json()),
    applyMemoryConsolidationDraft: (hash, payload) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/memory/consolidate/drafts/apply',
      { method: 'POST', body: payload || {} },
    ).then(r => r.json()),
    getMemoryReviewSchedule: (hash) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/memory/review-schedule'
    ).then(r => r.json()),
    setMemoryReviewSchedule: (hash, schedule) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/memory/review-schedule',
      { method: 'PUT', body: { schedule: schedule || { mode: 'off' } } },
    ).then(r => r.json()),
    startMemoryReview: (hash) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/memory/reviews',
      { method: 'POST', body: {} },
    ).then(r => r.json()),
    listMemoryReviews: (hash, pending) => {
      const qs = pending ? '?pending=true' : '';
      return chatFetch('workspaces/' + encodeURIComponent(hash) + '/memory/reviews' + qs).then(r => r.json());
    },
    getPendingMemoryReviews: (hash) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/memory/reviews/pending'
    ).then(r => r.json()),
    getMemoryReview: (hash, runId) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/memory/reviews/' + encodeURIComponent(runId)
    ).then(r => r.json()),
    applyMemoryReviewAction: (hash, runId, itemId) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/memory/reviews/' + encodeURIComponent(runId) + '/actions/' + encodeURIComponent(itemId) + '/apply',
      { method: 'POST', body: {} },
    ).then(r => r.json()),
    discardMemoryReviewAction: (hash, runId, itemId) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/memory/reviews/' + encodeURIComponent(runId) + '/actions/' + encodeURIComponent(itemId) + '/discard',
      { method: 'POST', body: {} },
    ).then(r => r.json()),
    applyMemoryReviewDraft: (hash, runId, draftId, payload) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/memory/reviews/' + encodeURIComponent(runId) + '/drafts/' + encodeURIComponent(draftId) + '/apply',
      { method: 'POST', body: payload || {} },
    ).then(r => r.json()),
    discardMemoryReviewDraft: (hash, runId, draftId) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/memory/reviews/' + encodeURIComponent(runId) + '/drafts/' + encodeURIComponent(draftId) + '/discard',
      { method: 'POST', body: {} },
    ).then(r => r.json()),
    regenerateMemoryReviewDraft: (hash, runId, draftId) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/memory/reviews/' + encodeURIComponent(runId) + '/drafts/' + encodeURIComponent(draftId) + '/regenerate',
      { method: 'POST', body: {} },
    ).then(r => r.json()),
    setMemoryEnabled: (hash, enabled) => {
      /** @type {MemoryEnabledRequest} */
      const body = { enabled: !!enabled };
      return chatFetch(
        'workspaces/' + encodeURIComponent(hash) + '/memory/enabled',
        { method: 'PUT', body },
      ).then(r => r.json());
    },
    deleteMemoryEntry: (hash, relPath) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/memory/entries/' + encodeURIComponent(relPath),
      { method: 'DELETE' },
    ).then(r => r.json()),
    restoreMemoryEntry: (hash, relPath) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/memory/entries/restore',
      { method: 'PUT', body: { relPath } },
    ).then(r => r.json()),
    clearMemory: (hash) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/memory/entries',
      { method: 'DELETE' },
    ).then(r => r.json()),
    getContextMapSettings: (hash) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/context-map/settings'
    ).then(r => r.json()),
    getContextMapReview: (hash, status) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/context-map/review' + (status ? '?status=' + encodeURIComponent(status) : '')
    ).then(r => r.json()),
    getContextMapGraph: (hash, opts) => {
      const p = new URLSearchParams();
      if (opts && opts.query) p.set('query', opts.query);
      if (opts && opts.type) p.set('type', opts.type);
      if (opts && opts.status) p.set('status', opts.status);
      if (opts && opts.sensitivity) p.set('sensitivity', opts.sensitivity);
      if (opts && opts.limit) p.set('limit', String(opts.limit));
      const qs = p.toString();
      return chatFetch(
        'workspaces/' + encodeURIComponent(hash) + '/context-map/graph' + (qs ? '?' + qs : '')
      ).then(r => r.json());
    },
    getContextMapEntity: (hash, entityId) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/context-map/entities/' + encodeURIComponent(entityId)
    ).then(r => r.json()),
    updateContextMapEntity: (hash, entityId, entity) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/context-map/entities/' + encodeURIComponent(entityId),
      { method: 'PUT', body: { entity: entity || {} } },
    ).then(r => r.json()),
    setContextMapEnabled: (hash, enabled) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/context-map/enabled',
      { method: 'PUT', body: { enabled: !!enabled } },
    ).then(r => r.json()),
    setContextMapSettings: (hash, settings) => {
      /** @type {ContextMapSettingsRequest} */
      const body = { settings: settings || {} };
      return chatFetch(
        'workspaces/' + encodeURIComponent(hash) + '/context-map/settings',
        { method: 'PUT', body },
      ).then(r => r.json());
    },
    runContextMapScan: (hash) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/context-map/scan',
      { method: 'POST', body: {} },
    ).then(r => r.json()),
    stopContextMapScan: (hash) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/context-map/scan/stop',
      { method: 'POST', body: {} },
    ).then(r => r.json()),
    clearContextMap: (hash) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/context-map',
      { method: 'DELETE' },
    ).then(r => r.json()),
    updateContextMapCandidate: (hash, candidateId, payload) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/context-map/candidates/' + encodeURIComponent(candidateId),
      { method: 'PUT', body: payload || {} },
    ).then(r => r.json()),
    applyContextMapCandidate: (hash, candidateId, opts) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/context-map/candidates/' + encodeURIComponent(candidateId) + '/apply',
      { method: 'POST', body: opts && opts.includeDependencies ? { includeDependencies: true } : {} },
    ).then(r => r.json()),
    discardContextMapCandidate: (hash, candidateId) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/context-map/candidates/' + encodeURIComponent(candidateId) + '/discard',
      { method: 'POST', body: {} },
    ).then(r => r.json()),
    reopenContextMapCandidate: (hash, candidateId) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/context-map/candidates/' + encodeURIComponent(candidateId) + '/reopen',
      { method: 'POST', body: {} },
    ).then(r => r.json()),
    getKb: (hash) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/kb'
    ).then(r => r.json()),
    setKbEnabled: (hash, enabled) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/kb/enabled',
      { method: 'PUT', body: { enabled: !!enabled } },
    ).then(r => r.json()),
    triggerDream: (hash) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/kb/dream',
      { method: 'POST', body: {} },
    ).then(r => r.json()),
    triggerRedream: (hash) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/kb/redream',
      { method: 'POST', body: {} },
    ).then(r => r.json()),
    stopDream: (hash) => chatFetch(
      'workspaces/' + encodeURIComponent(hash) + '/kb/dream/stop',
      { method: 'POST', body: {} },
    ).then(r => r.json()),
  };

  /* Global app settings + supporting reads consumed by the V2 Settings panel.
     `getSettings` / `setSettings` round-trip the full Settings object (server
     merges defaults for missing fields). `getBackends` returns the backend
     registry with nested `models[]` per backend. `getUsageStats` /
     `clearUsageStats` drive the Usage tab. `restartServer` kicks pm2 (server
     replies 409 if any stream is active). */
  const SettingsApi = {
    get: () => chatFetch('settings').then(r => r.json()).then(data => {
      state._settingsCache = data || {};
      return state._settingsCache;
    }),
    save: (settings) => chatFetch('settings', { method: 'PUT', body: settings || {} }).then(r => r.json()).then(data => {
      state._settingsCache = data || {};
      clearProfileMetadataCache();
      window.dispatchEvent(new CustomEvent('agent-cockpit-settings-saved', { detail: state._settingsCache }));
      return state._settingsCache;
    }),
    backends: () => chatFetch('backends').then(r => r.json()),
    usageStats: () => chatFetch('usage-stats').then(r => r.json()),
    clearUsageStats: () => chatFetch('usage-stats', { method: 'DELETE' }).then(r => r.json()),
    restartServer: () => chatFetch('server/restart', { method: 'POST', body: {} }).then(r => r.json()),
    testCliProfile: (profileId) => chatFetch(
      'cli-profiles/' + encodeURIComponent(profileId) + '/test',
      { method: 'POST', body: {} },
    ).then(r => r.json()).then(data => {
      if (data && data.settings) {
        state._settingsCache = data.settings;
        clearProfileMetadataCache();
        window.dispatchEvent(new CustomEvent('agent-cockpit-settings-saved', { detail: state._settingsCache }));
      }
      return data;
    }),
    startCliProfileAuth: (profileId) => chatFetch(
      'cli-profiles/' + encodeURIComponent(profileId) + '/auth/start',
      { method: 'POST', body: {} },
    ).then(r => r.json()).then(data => {
      if (data && data.settings) {
        state._settingsCache = data.settings;
        clearProfileMetadataCache();
        window.dispatchEvent(new CustomEvent('agent-cockpit-settings-saved', { detail: state._settingsCache }));
      }
      return data;
    }),
    getCliProfileAuthJob: (jobId) => chatFetch(
      'cli-profiles/auth-jobs/' + encodeURIComponent(jobId),
    ).then(r => r.json()),
    cancelCliProfileAuth: (jobId) => chatFetch(
      'cli-profiles/auth-jobs/' + encodeURIComponent(jobId) + '/cancel',
      { method: 'POST', body: {} },
    ).then(r => r.json()),
  };

  const AuthApi = {
    status: () => authFetch('auth/status', { csrf: false }).then(r => r.json()),
    listPasskeys: () => authFetch('auth/passkeys').then(r => r.json()),
    startPasskeyRegistration: (name) => authFetch(
      'auth/passkeys/register/options',
      { method: 'POST', body: { name: name || '' } },
    ).then(r => r.json()),
    verifyPasskeyRegistration: (name, response) => authFetch(
      'auth/passkeys/register/verify',
      { method: 'POST', body: { name: name || '', response } },
    ).then(r => r.json()),
    renamePasskey: (id, name) => authFetch(
      'auth/passkeys/' + encodeURIComponent(id),
      { method: 'PATCH', body: { name: name || '' } },
    ).then(r => r.json()),
    deletePasskey: (id) => authFetch(
      'auth/passkeys/' + encodeURIComponent(id),
      { method: 'DELETE' },
    ).then(r => r.json()),
    regenerateRecoveryCodes: () => authFetch(
      'auth/recovery/regenerate',
      { method: 'POST', body: {} },
    ).then(r => r.json()),
    updatePolicy: (patch) => authFetch(
      'auth/policy',
      { method: 'PATCH', body: patch || {} },
    ).then(r => r.json()),
  };

  /* Per-conversation file attachments. The composer's attachment tray drives
     these; each upload lands in the conv's artifacts dir and the chosen
     server path is embedded in the next /message body as `[Uploaded files: …]`
     (wire-format stability — Claude reads the file from disk). */
  const ConvApi = {
    /* Upload a single file to the conv's artifacts dir. Resolves with a full
       AttachmentMeta — `{name, path, size, kind, meta?}` where `kind` is one
       of image|pdf|text|code|md|folder|file and `meta` is a short human-read
       sublabel (e.g. "PDF · 12 pages", "1.2 MB"). `onXhr(xhr)` is invoked
       synchronously once the underlying XHR is created so the caller can
       abort it on remove. `onProgress(loaded, total)` feeds progress UI. */
    uploadFile: (convId, file, onProgress, onXhr) => new Promise((resolve, reject) => {
      const url = chatUrl('conversations/' + encodeURIComponent(convId) + '/upload');
      const run = () => {
        const xhr = new XMLHttpRequest();
        if (onXhr) onXhr(xhr);
        xhr.open('POST', url);
        xhr.withCredentials = true;
        if (state.csrfToken) xhr.setRequestHeader('x-csrf-token', state.csrfToken);
        xhr.upload.onprogress = (ev) => {
          if (onProgress && ev.lengthComputable) onProgress(ev.loaded, ev.total);
        };
        xhr.onload = () => {
          let parsed = null;
          try { parsed = JSON.parse(xhr.responseText); } catch { parsed = null; }
          if (xhr.status >= 200 && xhr.status < 300) {
            const entry = parsed && parsed.files && parsed.files[0];
            if (entry) resolve(entry);
            else reject(new Error('Upload returned no file'));
          } else if (xhr.status === 401) {
            if (state.onSessionExpired) state.onSessionExpired();
            const err = new Error('Session expired'); err.status = 401; reject(err);
          } else {
            const err = new Error((parsed && parsed.error) || xhr.statusText || `HTTP ${xhr.status}`);
            err.status = xhr.status; err.body = parsed; reject(err);
          }
        };
        xhr.onerror = () => { const err = new Error('Network error'); err.status = 0; reject(err); };
        xhr.onabort = () => { const err = new Error('Aborted'); err.status = 0; err.aborted = true; reject(err); };
        const fd = new FormData();
        fd.append('files', file);
        xhr.send(fd);
      };
      if (!state.csrfToken) fetchCsrfToken().then(run).catch(reject);
      else run();
    }),
    deleteUpload: (convId, filename) => chatFetch(
      'conversations/' + encodeURIComponent(convId) + '/upload/' + encodeURIComponent(filename),
      { method: 'DELETE' },
    ).then(r => r.json()),
    /* One-shot OCR for an image attachment. Server reuses the conv's
       backend/model/effort and returns `{ markdown }`. The composer's
       per-attachment OCR button calls through StreamStore.ocrAttachment,
       which caches the result so re-clicks don't re-spawn the CLI. */
    ocrAttachment: async (convId, path) => {
      const res = await chatFetch(
        'conversations/' + encodeURIComponent(convId) + '/attachments/ocr',
        { method: 'POST', body: { path } },
      );
      return await res.json();
    },
    /* Session history — the Sessions modal in the chat topbar. `getSessions`
       returns a flat list of session metadata; `getSessionMessages` hydrates
       a single past session's messages on demand; `sessionDownloadUrl` is a
       plain URL (no CSRF required for GET) that the caller passes to
       `window.open()` so the browser drives the download. */
    getSessions: (convId) => chatFetch(
      'conversations/' + encodeURIComponent(convId) + '/sessions'
    ).then(r => r.json()),
    getSessionMessages: (convId, sessionNumber) => chatFetch(
      'conversations/' + encodeURIComponent(convId) + '/sessions/' + encodeURIComponent(sessionNumber) + '/messages'
    ).then(r => r.json()),
    sessionDownloadUrl: (convId, sessionNumber) => chatUrl(
      'conversations/' + encodeURIComponent(convId) + '/sessions/' + encodeURIComponent(sessionNumber) + '/download'
    ),
    getGoal: (convId) => chatFetch(
      'conversations/' + encodeURIComponent(convId) + '/goal'
    ).then(r => r.json()),
    setGoal: (convId, body) => chatFetch(
      'conversations/' + encodeURIComponent(convId) + '/goal',
      { method: 'POST', body: body || {} },
    ).then(r => r.json()),
    resumeGoal: (convId) => chatFetch(
      'conversations/' + encodeURIComponent(convId) + '/goal/resume',
      { method: 'POST', body: {} },
    ).then(r => r.json()),
    pauseGoal: (convId) => chatFetch(
      'conversations/' + encodeURIComponent(convId) + '/goal/pause',
      { method: 'POST', body: {} },
    ).then(r => r.json()),
    clearGoal: (convId) => chatFetch(
      'conversations/' + encodeURIComponent(convId) + '/goal',
      { method: 'DELETE' },
    ).then(r => r.json()),
  };

export const AgentApi = {
    apiUrl,
    chatUrl,
    chatWsUrl,
    fetch: chatFetch,
    getMe,
    listConversations,
    getActiveStreams,
    createConversation,
    restoreConversation,
    markConversationUnread,
    setMessagePinned,
    renameConversation,
    deleteConversation,
    abortConversation,
    getVersion,
    getUpdateStatus,
    getInstallStatus,
    getInstallDoctor,
    completeWelcome,
    checkVersion,
    triggerUpdate,
    getCliUpdates,
    checkCliUpdates,
    triggerCliUpdate,
    getClaudePlanUsage,
    getKiroPlanUsage,
    getCodexPlanUsage,
    browseDir,
    mkdirDir,
    rmdirDir,
    getBackendsCached,
    getSettingsCached,
    getCliProfileMetadata,
    setSessionExpiredHandler: (fn) => { state.onSessionExpired = fn; },
    // Invalidates the cached CSRF token — called after a silent re-auth,
    // since the new session has a new csrfToken and the old cached value
    // would be rejected by csrfGuard. The next chatFetch re-fetches lazily.
    invalidateCsrfToken: () => { state.csrfToken = null; },
    kb: KbApi,
    explorer: ExplorerApi,
    settings: SettingsApi,
    auth: AuthApi,
    workspace: WorkspaceApi,
    conv: ConvApi,
  };

export default AgentApi;
