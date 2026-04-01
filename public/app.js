// ─── HTML escape ─────────────────────────────────────────────────────────────
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escWithCode(str) {
  return esc(str).replace(/`([^`]+)`/g, '<code>$1</code>');
}

// ─── Timestamp / elapsed formatting ─────────────────────────────────────────
function chatFormatTimestamp(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '';
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (isToday) return timeStr;
  if (isYesterday) return `Yesterday ${timeStr}`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + timeStr;
}

function chatFormatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec < 10 ? '0' : ''}${sec}s`;
}

function chatFormatElapsedShort(ms) {
  if (ms < 10000) return (ms / 1000).toFixed(1) + 's';
  return chatFormatElapsed(ms);
}

// ─── Theme ───────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  let resolved = theme;
  if (theme === 'system') {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', resolved);
  const hljsLink = document.getElementById('hljs-theme');
  if (hljsLink) {
    const hljsStyle = resolved === 'dark' ? 'github-dark' : 'github';
    hljsLink.href = `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/${hljsStyle}.min.css`;
  }
  try { localStorage.setItem('agent-cockpit-theme', theme); } catch (e) {}
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const cached = localStorage.getItem('agent-cockpit-theme') || 'system';
  if (cached === 'system') applyTheme('system');
});

applyTheme(localStorage.getItem('agent-cockpit-theme') || 'system');

// ─── State ────────────────────────────────────────────────────────────────────
let csrfToken = null;

const API_BASE = new URL('./api/', window.location.href);
function apiUrl(path = '') {
  const clean = String(path || '').replace(/^\/+/, '');
  return new URL(clean, API_BASE).toString();
}

// ─── CSRF ─────────────────────────────────────────────────────────────────────
async function fetchCsrfToken() {
  const res = await fetch(apiUrl('/csrf-token'), { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`CSRF token fetch failed (${res.status})`);
  const body = await res.json();
  csrfToken = body.csrfToken;
}

// ─── Chat UI ──────────────────────────────────────────────────────────────────

let CHAT_BACKENDS = [];
let BACKEND_CAPABILITIES = {};
let BACKEND_ICONS = {};
const DEFAULT_BACKEND_ICON = '<svg width="28" height="28" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" rx="128" fill="#888"/><text x="256" y="320" text-anchor="middle" fill="#fff" font-size="280" font-family="sans-serif">⚡</text></svg>';

async function loadBackends() {
  try {
    const res = await fetch(apiUrl('/chat/backends'), { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`Failed to load backends (${res.status})`);
    const data = await res.json();
    CHAT_BACKENDS = data.backends.map(b => ({ id: b.id, label: b.label }));
    for (const b of data.backends) {
      BACKEND_CAPABILITIES[b.id] = b.capabilities || {};
      BACKEND_ICONS[b.id] = b.icon || null;
    }
    populateBackendSelects();
  } catch (err) {
    console.error('[loadBackends]', err);
    // Fallback so the UI still works
    CHAT_BACKENDS = [{ id: 'claude-code', label: 'Claude Code' }];
    populateBackendSelects();
  }
}

function populateBackendSelects() {
  const selects = document.querySelectorAll('#chat-backend-select, #chat-settings-backend');
  for (const sel of selects) {
    const current = sel.value;
    sel.innerHTML = CHAT_BACKENDS.map(b =>
      `<option value="${esc(b.id)}">${esc(b.label)}</option>`
    ).join('');
    if (current && [...sel.options].some(o => o.value === current)) {
      sel.value = current;
    }
  }
}

function getBackendIcon(backendId) {
  return BACKEND_ICONS[backendId] || DEFAULT_BACKEND_ICON;
}

function getBackendCapabilities(backendId) {
  return BACKEND_CAPABILITIES[backendId] || {};
}

// Chat state
let chatConversations = [];
let chatActiveConvId = null;
let chatActiveConv = null;
let chatStreamingConvs = new Set();
let chatResettingConvs = new Set();
let chatStreamingState = new Map(); // convId -> { assistantContent, assistantThinking, activeTools, activeAgents, planModeActive, pendingInteraction, streamingMsgEl }
let chatAbortController = null;
let chatSidebarCollapsed = false;
let chatSearchTimeout = null;
let chatContextMenuEl = null;
let chatSettingsData = null;
let chatInitialized = false;
let chatPendingWorkingDir = null;
let chatPendingFiles = []; // Each: { file, status: 'uploading'|'done'|'error', progress, result, xhr }
let _ensureConvPromise = null;

function chatApiUrl(path) {
  return apiUrl('chat/' + path);
}

async function chatFetch(path, opts = {}) {
  if (!csrfToken) await fetchCsrfToken();
  const headers = { ...opts.headers };
  if (csrfToken) headers['x-csrf-token'] = csrfToken;
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

function chatInit() {
  if (chatInitialized && chatActiveConvId) {
    // Re-entering — just refresh
    chatRenderConvList();
    if (chatActiveConv) chatRenderMessages();
    chatWireEvents();
    return;
  }
  chatInitialized = true;
  chatWireEvents();
  loadBackends();
  chatLoadConversations();

  // Show app version in sidebar + check for updates
  chatFetch('version').then(res => res.json()).then(v => {
    const textEl = document.getElementById('chat-version-text');
    if (textEl && v.version) textEl.textContent = 'v' + v.version;
    chatCheckUpdateIndicator(v);
  }).catch(() => {});

  // Click version number to trigger a manual version check
  const versionLabel = document.getElementById('chat-version-text');
  if (versionLabel) {
    versionLabel.style.cursor = 'pointer';
    versionLabel.title = 'Click to check for updates';
    versionLabel.addEventListener('click', chatManualVersionCheck);
  }

  // Poll for update status every 5 minutes (reads server-cached state, no git ops)
  setInterval(() => {
    chatFetch('update-status').then(res => res.json()).then(chatCheckUpdateIndicator).catch(() => {});
  }, 5 * 60 * 1000);

  // Sync theme from server settings
  chatFetch('settings').then(res => res.json()).then(s => {
    chatSettingsData = s;
    applyTheme(s.theme || 'system');
  }).catch(() => {});
}

function chatWireEvents() {
  const newBtn = document.getElementById('chat-new-btn');
  if (newBtn) newBtn.onclick = chatNewConversation;

  const collapseBtn = document.getElementById('chat-sidebar-collapse');
  if (collapseBtn) collapseBtn.onclick = () => chatToggleSidebar();

  const toggleBtn = document.getElementById('chat-header-toggle');
  if (toggleBtn) toggleBtn.onclick = () => chatToggleSidebar();

  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) sendBtn.onclick = () => {
    if (chatStreamingConvs.has(chatActiveConvId)) chatStopStreaming();
    else chatSendMessage();
  };

  const textarea = document.getElementById('chat-textarea');
  if (textarea) {
    textarea.oninput = () => {
      chatAutoResize(textarea);
      chatUpdateSendButtonState();
    };
    textarea.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const hasUploading = chatPendingFiles.some(entry => entry.status === 'uploading');
        if (!hasUploading && (textarea.value.trim() || chatPendingFiles.some(entry => entry.status === 'done'))) {
          chatSendMessage();
        }
      }
    };
    textarea.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            const ts = Date.now();
            const ext = file.name.includes('.') ? '.' + file.name.split('.').pop() : '.png';
            const baseName = file.name.replace(/\.[^.]+$/, '');
            const uniqueName = `${baseName}-${ts}-${files.length + 1}${ext}`;
            const renamed = new File([file], uniqueName, { type: file.type });
            files.push(renamed);
          }
        }
      }
      if (files.length) {
        e.preventDefault();
        chatAddPendingFiles(files);
        return;
      }
      // Convert large text pastes (1000+ chars) to text file attachments
      const pastedText = e.clipboardData.getData('text/plain');
      if (pastedText && pastedText.length >= 1000) {
        e.preventDefault();
        const now = new Date();
        const ts = now.getFullYear()
          + String(now.getMonth() + 1).padStart(2, '0')
          + String(now.getDate()).padStart(2, '0')
          + '-'
          + String(now.getHours()).padStart(2, '0')
          + String(now.getMinutes()).padStart(2, '0')
          + String(now.getSeconds()).padStart(2, '0');
        const textFile = new File([pastedText], `pasted-text-${ts}.txt`, { type: 'text/plain' });
        chatAddPendingFiles([textFile]);
      }
    });
  }

  const searchInput = document.getElementById('chat-search-input');
  if (searchInput) {
    searchInput.oninput = () => {
      clearTimeout(chatSearchTimeout);
      chatSearchTimeout = setTimeout(() => chatLoadConversations(searchInput.value), 300);
    };
  }

  const downloadBtn = document.getElementById('chat-download-btn');
  if (downloadBtn) downloadBtn.onclick = chatDownloadConversation;

  const resetBtn = document.getElementById('chat-reset-btn');
  if (resetBtn) resetBtn.onclick = chatResetSession;

  const sessionsBtn = document.getElementById('chat-sessions-btn');
  if (sessionsBtn) sessionsBtn.onclick = chatShowSessions;

  const settingsBtn = document.getElementById('chat-settings-btn');
  if (settingsBtn) settingsBtn.onclick = chatShowSettings;

  const signoutBtn = document.getElementById('chat-signout-btn');
  if (signoutBtn) signoutBtn.onclick = () => {
    if (confirm('Sign out?')) window.location.href = '/auth/logout';
  };

  // Prompt cards
  document.querySelectorAll('.chat-prompt-card').forEach(card => {
    card.onclick = () => {
      const textarea = document.getElementById('chat-textarea');
      if (textarea) {
        textarea.value = card.dataset.prompt;
        chatAutoResize(textarea);
        chatSendMessage();
      }
    };
  });

  // ── File attachment wiring ──
  const attachBtn = document.getElementById('chat-attach-btn');
  const fileInput = document.getElementById('chat-file-input');
  if (attachBtn && fileInput) {
    attachBtn.onclick = () => fileInput.click();
    fileInput.onchange = () => {
      if (fileInput.files.length) {
        chatAddPendingFiles(Array.from(fileInput.files));
        fileInput.value = '';
      }
    };
  }

  // Drag-and-drop on chat messages area
  const chatMsgs = document.getElementById('chat-messages');
  if (chatMsgs) {
    let dragCounter = 0;
    chatMsgs.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      if (dragCounter === 1) chatShowDropOverlay(true);
    });
    chatMsgs.addEventListener('dragover', (e) => e.preventDefault());
    chatMsgs.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; chatShowDropOverlay(false); }
    });
    chatMsgs.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      chatShowDropOverlay(false);
      if (e.dataTransfer.files.length) chatAddPendingFiles(Array.from(e.dataTransfer.files));
    });
  }

  // Close context menu on click elsewhere
  document.addEventListener('click', chatCloseContextMenu);
}

function chatAutoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

// ── File attachment helpers ──────────────────────────────────────────────────

function chatFormatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function chatEnsureConversation() {
  if (chatActiveConvId) return chatActiveConvId;
  if (_ensureConvPromise) return _ensureConvPromise;
  _ensureConvPromise = (async () => {
    try {
      const body = chatPendingWorkingDir ? { workingDir: chatPendingWorkingDir } : {};
      chatPendingWorkingDir = null;
      const res = await chatFetch('conversations', { method: 'POST', body });
      const conv = await res.json();
      chatActiveConvId = conv.id;
      chatActiveConv = conv;
      chatLoadConversations();
      chatUpdateHeader();
      chatRenderMessages();
      return conv.id;
    } finally {
      _ensureConvPromise = null;
    }
  })();
  return _ensureConvPromise;
}

async function chatUploadSingleFile(convId, entry) {
  if (!csrfToken) await fetchCsrfToken();
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    entry.xhr = xhr;
    const formData = new FormData();
    formData.append('files', entry.file);
    xhr.open('POST', chatApiUrl(`conversations/${convId}/upload`));
    xhr.setRequestHeader('x-csrf-token', csrfToken || '');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        entry.progress = Math.round((e.loaded / e.total) * 100);
        chatRenderFileChips();
      }
    };
    xhr.onload = () => {
      entry.xhr = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const resp = JSON.parse(xhr.responseText);
          entry.status = 'done';
          entry.result = resp.files[0];
        } catch {
          entry.status = 'error';
        }
      } else {
        entry.status = 'error';
      }
      chatRenderFileChips();
      chatUpdateSendButtonState();
      resolve();
    };
    xhr.onerror = () => {
      entry.xhr = null;
      entry.status = 'error';
      chatRenderFileChips();
      chatUpdateSendButtonState();
      resolve();
    };
    xhr.onabort = () => {
      entry.xhr = null;
      resolve();
    };
    xhr.send(formData);
  });
}

async function chatAddPendingFiles(files) {
  const newEntries = files.map(f => ({ file: f, status: 'uploading', progress: 0, result: null, xhr: null }));
  chatPendingFiles.push(...newEntries);
  chatRenderFileChips();
  chatUpdateSendButtonState();
  try {
    const convId = await chatEnsureConversation();
    for (const entry of newEntries) {
      if (entry.status === 'uploading') {
        chatUploadSingleFile(convId, entry);
      }
    }
  } catch (err) {
    for (const entry of newEntries) {
      entry.status = 'error';
      entry.xhr = null;
    }
    chatRenderFileChips();
    chatUpdateSendButtonState();
    alert('Failed to create conversation: ' + err.message);
  }
}

function chatRemovePendingFile(index) {
  const entry = chatPendingFiles[index];
  if (!entry) return;
  if (entry.status === 'uploading' && entry.xhr) {
    entry.xhr.abort();
  }
  if (entry.status === 'done' && entry.result && chatActiveConvId) {
    chatFetch(`conversations/${chatActiveConvId}/upload/${encodeURIComponent(entry.result.name)}`, { method: 'DELETE' }).catch(() => {});
  }
  chatPendingFiles.splice(index, 1);
  chatRenderFileChips();
  chatUpdateSendButtonState();
}

function chatRenderFileChips() {
  const container = document.getElementById('chat-file-chips');
  if (!container) return;
  if (!chatPendingFiles.length) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  container.style.display = 'flex';
  container.innerHTML = chatPendingFiles.map((entry, i) => {
    const f = entry.file;
    const isImage = f.type && f.type.startsWith('image/');
    const thumbHtml = isImage ? `<img class="chat-file-chip-thumb" src="${URL.createObjectURL(f)}" alt="">` : '';
    let statusHtml = '';
    if (entry.status === 'uploading') {
      statusHtml = `<div class="chat-file-chip-progress"><div class="chat-file-chip-progress-bar" style="width:${entry.progress}%"></div></div>`;
    }
    const doneIcon = entry.status === 'done' ? '<span class="chat-file-chip-done">&#10003;</span>' : '';
    const errorIcon = entry.status === 'error' ? '<span class="chat-file-chip-error" title="Upload failed">!</span>' : '';
    return `<div class="chat-file-chip${entry.status === 'error' ? ' error' : ''}">
      ${thumbHtml}
      <span class="chat-file-chip-name" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="chat-file-chip-size">${chatFormatFileSize(f.size)}</span>
      ${doneIcon}${errorIcon}
      ${statusHtml}
      <button class="chat-file-chip-remove" data-file-index="${i}" title="Remove">&times;</button>
    </div>`;
  }).join('');
  container.querySelectorAll('.chat-file-chip-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      chatRemovePendingFile(Number(btn.dataset.fileIndex));
    });
  });
}

function chatShowDropOverlay(show) {
  const chatMsgs = document.getElementById('chat-messages');
  if (!chatMsgs) return;
  let overlay = chatMsgs.querySelector('.chat-drop-overlay');
  if (show && !overlay) {
    chatMsgs.style.position = 'relative';
    overlay = document.createElement('div');
    overlay.className = 'chat-drop-overlay';
    overlay.textContent = 'Drop files here';
    chatMsgs.appendChild(overlay);
  } else if (!show && overlay) {
    overlay.remove();
  }
}

async function chatUploadFiles(convId, files) {
  if (!csrfToken) await fetchCsrfToken();
  const formData = new FormData();
  files.forEach(f => formData.append('files', f));
  const res = await fetch(chatApiUrl(`conversations/${convId}/upload`), {
    method: 'POST',
    headers: { 'x-csrf-token': csrfToken || '' },
    credentials: 'same-origin',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Upload failed');
  }
  return res.json();
}

function chatToggleSidebar() {
  chatSidebarCollapsed = !chatSidebarCollapsed;
  const sidebar = document.getElementById('chat-sidebar');
  if (sidebar) sidebar.classList.toggle('collapsed', chatSidebarCollapsed);
}

// ── Conversation list ─────────────────────────────────────────────────────────

async function chatLoadConversations(query) {
  try {
    const q = query ? `?q=${encodeURIComponent(query)}` : '';
    const res = await chatFetch(`conversations${q}`);
    const data = await res.json();
    chatConversations = data.conversations || [];
    chatRenderConvList();
  } catch (err) {
    console.error('Failed to load conversations:', err);
  }
}

function chatGroupConversations(convs) {
  const groups = {};
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const week = new Date(today); week.setDate(week.getDate() - 7);
  const month = new Date(today); month.setDate(month.getDate() - 30);

  for (const c of convs) {
    const d = new Date(c.updatedAt);
    let label;
    if (d >= today) label = 'Today';
    else if (d >= yesterday) label = 'Yesterday';
    else if (d >= week) label = 'Previous 7 Days';
    else if (d >= month) label = 'Previous 30 Days';
    else label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    if (!groups[label]) groups[label] = [];
    groups[label].push(c);
  }
  return groups;
}

function chatRenderConvList() {
  const list = document.getElementById('chat-conv-list');
  if (!list) return;

  if (chatConversations.length === 0) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:12px;">No conversations yet</div>';
    return;
  }

  const groups = chatGroupConversations(chatConversations);
  let html = '';
  for (const [label, convs] of Object.entries(groups)) {
    html += `<div class="chat-conv-group-label">${esc(label)}</div>`;
    for (const c of convs) {
      const isActive = c.id === chatActiveConvId;
      const isStreaming = chatStreamingConvs.has(c.id);
      const folderLabel = c.workingDir ? c.workingDir.split('/').filter(Boolean).slice(-2).join('/') : 'workspace';
      html += `
        <div class="chat-conv-item${isActive ? ' active' : ''}" data-conv-id="${esc(c.id)}">
          <div style="flex:1;min-width:0;">
            <span class="chat-conv-item-title">${esc(c.title)}</span>
            <div class="chat-conv-item-workdir" title="${esc(c.workingDir || 'Default workspace')}">📁 ${esc(folderLabel)}</div>
          </div>
          ${isStreaming ? '<span class="chat-conv-streaming-dot"></span>' : ''}
          <button class="chat-conv-item-menu" data-conv-menu="${esc(c.id)}" title="Options">⋯</button>
        </div>
      `;
    }
  }
  list.innerHTML = html;

  // Wire click events
  list.querySelectorAll('.chat-conv-item').forEach(el => {
    el.onclick = (e) => {
      if (e.target.closest('.chat-conv-item-menu')) return;
      chatSelectConversation(el.dataset.convId);
    };
  });

  list.querySelectorAll('.chat-conv-item-menu').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      chatShowContextMenu(e, btn.dataset.convMenu);
    };
  });
}

// ── Conversation operations ───────────────────────────────────────────────────

async function chatNewConversation() {
  chatShowFolderPicker();
}

async function chatCreateConversationWithDir(workingDir) {
  try {
    const body = workingDir ? { workingDir } : {};
    const res = await chatFetch('conversations', { method: 'POST', body });
    const conv = await res.json();
    chatActiveConvId = conv.id;
    chatActiveConv = conv;
    await chatLoadConversations();
    chatRenderMessages();
    chatUpdateHeader();
    chatCloseModal();
    const textarea = document.getElementById('chat-textarea');
    if (textarea) textarea.focus();
  } catch (err) {
    alert('Failed to create conversation: ' + err.message);
  }
}

async function chatShowFolderPicker(initialPath) {
  const browsePath = initialPath || '';
  let showHidden = false;

  async function loadDir(dirPath) {
    try {
      const q = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
      const showQ = showHidden ? (q ? '&showHidden=true' : '?showHidden=true') : '';
      const res = await chatFetch(`browse${q}${showQ}`);
      const data = await res.json();
      renderFolderBrowser(data);
    } catch (err) {
      const pathEl = document.querySelector('.folder-browser-path');
      if (pathEl) {
        const origText = pathEl.textContent;
        pathEl.textContent = '⚠️ ' + (err.message || 'Cannot access folder');
        pathEl.style.color = 'var(--blocked, #dc2626)';
        setTimeout(() => { pathEl.textContent = origText; pathEl.style.color = ''; }, 2000);
      }
    }
  }

  function renderFolderBrowser(data) {
    const folderName = data.currentPath.split('/').pop() || data.currentPath;
    let listHtml = '';
    if (data.parent) {
      listHtml += `<div class="folder-browser-item parent-item" data-path="${esc(data.parent)}">↑ Parent Directory</div>`;
    }
    if (data.dirs.length === 0) {
      listHtml += '<div style="padding:12px;color:var(--muted);font-size:12px;text-align:center;">No subdirectories</div>';
    }
    for (const d of data.dirs) {
      const full = data.currentPath + '/' + d;
      listHtml += `<div class="folder-browser-item" data-path="${esc(full)}">📁 ${esc(d)}</div>`;
    }

    const bodyHtml = `
      <div class="chat-modal-body">
        <div class="folder-browser-path-row">
          <div class="folder-browser-path" title="${esc(data.currentPath)}">${esc(data.currentPath)}</div>
          <div class="folder-browser-path-actions">
            ${data.parent ? `<button class="folder-browser-icon-btn" id="folder-go-parent" title="Go to parent folder">&#x2191;</button>` : ''}
            ${data.parent ? `<button class="folder-browser-icon-btn folder-browser-delete-btn" id="folder-delete-btn" title="Delete this folder">&#x1F5D1;</button>` : ''}
          </div>
        </div>
        <div class="folder-browser-toolbar">
          <label class="folder-browser-toggle">
            <input type="checkbox" id="folder-show-hidden" ${showHidden ? 'checked' : ''} /> Show hidden folders
          </label>
          <button class="folder-browser-new-btn" id="folder-new-btn" title="New Folder">+ New Folder</button>
        </div>
        <div class="folder-browser-new-input" id="folder-new-input" style="display:none;">
          <input type="text" id="folder-new-name" placeholder="Folder name" autocomplete="off" />
          <button id="folder-new-confirm" title="Create">&#10003;</button>
          <button id="folder-new-cancel" title="Cancel">&#10005;</button>
        </div>
        <div class="folder-browser-list" id="folder-browser-list">${listHtml}</div>
      </div>
      <div class="folder-browser-actions" style="padding:12px 20px;border-top:1px solid var(--border);">
        <button class="folder-browser-default" id="folder-use-default">Use Default (workspace)</button>
        <button class="folder-browser-select" id="folder-select-this">Select This Folder</button>
      </div>
    `;

    chatShowModal('Select Working Directory', bodyHtml);

    // Wire events
    document.getElementById('folder-browser-list').querySelectorAll('.folder-browser-item').forEach(el => {
      el.addEventListener('click', () => loadDir(el.dataset.path));
    });
    document.getElementById('folder-show-hidden').onchange = (e) => {
      showHidden = e.target.checked;
      loadDir(data.currentPath);
    };
    document.getElementById('folder-select-this').onclick = () => chatCreateConversationWithDir(data.currentPath);
    document.getElementById('folder-use-default').onclick = () => chatCreateConversationWithDir(null);

    // New Folder logic
    const newBtn = document.getElementById('folder-new-btn');
    const newInputRow = document.getElementById('folder-new-input');
    const newNameInput = document.getElementById('folder-new-name');
    newBtn.onclick = () => {
      newInputRow.style.display = 'flex';
      newBtn.style.display = 'none';
      newNameInput.value = '';
      newNameInput.focus();
    };
    document.getElementById('folder-new-cancel').onclick = () => {
      newInputRow.style.display = 'none';
      newBtn.style.display = '';
    };
    async function createNewFolder() {
      const name = newNameInput.value.trim();
      if (!name) return;
      try {
        const res = await chatFetch('mkdir', { method: 'POST', body: { parentPath: data.currentPath, name } });
        const result = await res.json();
        loadDir(result.created);
      } catch (err) {
        const pathEl = document.querySelector('.folder-browser-path');
        if (pathEl) {
          const origText = pathEl.textContent;
          const origColor = pathEl.style.color;
          pathEl.textContent = '\u26a0\ufe0f ' + (err.message || 'Failed to create folder');
          pathEl.style.color = 'var(--blocked, #dc2626)';
          setTimeout(() => { pathEl.textContent = origText; pathEl.style.color = origColor; }, 2000);
        }
      }
    }
    document.getElementById('folder-new-confirm').onclick = createNewFolder;
    newNameInput.onkeydown = (e) => {
      if (e.key === 'Enter') createNewFolder();
      if (e.key === 'Escape') { newInputRow.style.display = 'none'; newBtn.style.display = ''; }
    };

    // Parent navigation button
    const goParentBtn = document.getElementById('folder-go-parent');
    if (goParentBtn) goParentBtn.onclick = () => loadDir(data.parent);

    // Delete folder button with confirmation
    const deleteBtn = document.getElementById('folder-delete-btn');
    if (deleteBtn) {
      deleteBtn.onclick = () => {
        const folderName = data.currentPath.split('/').pop() || data.currentPath;
        const confirmEl = document.createElement('div');
        confirmEl.className = 'folder-browser-confirm-delete';
        confirmEl.innerHTML = `
          <span>Delete <strong>${esc(folderName)}</strong> and all its contents?</span>
          <div class="folder-browser-confirm-actions">
            <button class="folder-browser-confirm-yes" id="folder-delete-yes">Delete</button>
            <button class="folder-browser-confirm-no" id="folder-delete-no">Cancel</button>
          </div>
        `;
        const list = document.getElementById('folder-browser-list');
        if (list) list.replaceWith(confirmEl);
        document.getElementById('folder-delete-no').onclick = () => renderFolderBrowser(data);
        document.getElementById('folder-delete-yes').onclick = async () => {
          try {
            await chatFetch('rmdir', { method: 'POST', body: { dirPath: data.currentPath } });
            loadDir(data.parent);
          } catch (err) {
            const pathEl = document.querySelector('.folder-browser-path');
            if (pathEl) {
              const origText = pathEl.textContent;
              const origColor = pathEl.style.color;
              pathEl.textContent = '\u26a0\ufe0f ' + (err.message || 'Failed to delete folder');
              pathEl.style.color = 'var(--blocked, #dc2626)';
              setTimeout(() => { pathEl.textContent = origText; pathEl.style.color = origColor; }, 2000);
            }
            renderFolderBrowser(data);
          }
        };
      };
    }
  }

  loadDir(browsePath);
}
window.chatShowFolderPicker = chatShowFolderPicker;

function chatUpdateSendButtonState() {
  const sendBtn = document.getElementById('chat-send-btn');
  if (!sendBtn) return;
  const isStreaming = chatStreamingConvs.has(chatActiveConvId);
  const isResetting = chatResettingConvs.has(chatActiveConvId);
  if (isStreaming) {
    sendBtn.disabled = false;
    sendBtn.textContent = '■';
    sendBtn.classList.add('stop');
  } else {
    sendBtn.textContent = '↑';
    sendBtn.classList.remove('stop');
    const ta = document.getElementById('chat-textarea');
    const hasText = ta && ta.value.trim();
    const hasCompletedFiles = chatPendingFiles.some(e => e.status === 'done');
    const hasUploading = chatPendingFiles.some(e => e.status === 'uploading');
    sendBtn.disabled = isResetting || hasUploading || (!hasText && !hasCompletedFiles);
  }
}

async function chatSelectConversation(id) {
  if (id === chatActiveConvId) return;
  // Abort in-flight uploads and clear pending files from previous conversation
  for (const entry of chatPendingFiles) {
    if (entry.status === 'uploading' && entry.xhr) entry.xhr.abort();
  }
  chatPendingFiles = [];
  chatRenderFileChips();
  try {
    const res = await chatFetch(`conversations/${id}`);
    chatActiveConv = await res.json();
    chatActiveConvId = id;
    chatRenderConvList();
    chatRenderMessages();
    chatUpdateHeader();
    chatUpdateSendButtonState();
    const resetBtn = document.getElementById('chat-reset-btn');
    if (resetBtn) {
      resetBtn.disabled = chatResettingConvs.has(id);
      resetBtn.textContent = chatResettingConvs.has(id) ? '↻ Resetting...' : '↻ Reset';
    }
    const backendSelect = document.getElementById('chat-backend-select');
    if (backendSelect && chatActiveConv.backend) {
      backendSelect.value = chatActiveConv.backend;
    }
  } catch (err) {
    alert('Failed to load conversation: ' + err.message);
  }
}

async function chatRenameConversation(id) {
  const conv = chatConversations.find(c => c.id === id);
  const newTitle = prompt('Rename conversation:', conv ? conv.title : '');
  if (!newTitle || !newTitle.trim()) return;
  try {
    await chatFetch(`conversations/${id}`, { method: 'PUT', body: { title: newTitle.trim() } });
    if (chatActiveConvId === id && chatActiveConv) chatActiveConv.title = newTitle.trim();
    chatUpdateHeader();
    chatLoadConversations();
  } catch (err) {
    alert('Failed to rename: ' + err.message);
  }
}

async function chatDeleteConversation(id) {
  if (!confirm('Delete this conversation? This cannot be undone.')) return;
  try {
    await chatFetch(`conversations/${id}`, { method: 'DELETE' });
    if (chatActiveConvId === id) {
      // Abort in-flight uploads and clear pending files
      for (const entry of chatPendingFiles) {
        if (entry.status === 'uploading' && entry.xhr) entry.xhr.abort();
      }
      chatPendingFiles = [];
      chatRenderFileChips();
      chatActiveConvId = null;
      chatActiveConv = null;
      chatRenderMessages();
      chatUpdateHeader();
      chatUpdateSendButtonState();
    }
    chatLoadConversations();
  } catch (err) {
    alert('Failed to delete: ' + err.message);
  }
}

function chatUpdateHeader() {
  const titleEl = document.getElementById('chat-header-title');
  if (titleEl) {
    titleEl.textContent = chatActiveConv ? chatActiveConv.title : 'New Chat';
  }
  let wdEl = document.getElementById('chat-header-workdir');
  if (!wdEl) {
    const header = titleEl?.parentElement;
    if (header) {
      wdEl = document.createElement('div');
      wdEl.className = 'chat-header-workdir';
      wdEl.id = 'chat-header-workdir';
      titleEl.after(wdEl);
    }
  }
  if (wdEl) {
    if (chatActiveConv && chatActiveConv.workingDir) {
      const folderName = chatActiveConv.workingDir.split('/').filter(Boolean).slice(-2).join('/') || chatActiveConv.workingDir;
      wdEl.textContent = '📁 ' + folderName;
      wdEl.title = chatActiveConv.workingDir;
      wdEl.style.display = '';
    } else if (chatActiveConv) {
      wdEl.textContent = '📁 workspace';
      wdEl.title = 'Default workspace';
      wdEl.style.display = '';
    } else {
      wdEl.style.display = 'none';
    }
  }
}

// ── Context menu ──────────────────────────────────────────────────────────────

function chatShowContextMenu(e, convId) {
  chatCloseContextMenu();
  const menu = document.createElement('div');
  menu.className = 'chat-context-menu';
  menu.innerHTML = `
    <button class="chat-context-menu-item" data-action="rename">Rename</button>
    <button class="chat-context-menu-item danger" data-action="delete">Delete</button>
  `;
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  menu.querySelectorAll('.chat-context-menu-item').forEach(item => {
    item.onclick = () => {
      chatCloseContextMenu();
      if (item.dataset.action === 'rename') chatRenameConversation(convId);
      else if (item.dataset.action === 'delete') chatDeleteConversation(convId);
    };
  });

  document.body.appendChild(menu);
  chatContextMenuEl = menu;

  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
  });
}

function chatCloseContextMenu() {
  if (chatContextMenuEl) {
    chatContextMenuEl.remove();
    chatContextMenuEl = null;
  }
}

// ── Message rendering ─────────────────────────────────────────────────────────

function chatRenderMessages() {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  if (!chatActiveConv || chatActiveConv.messages.length === 0) {
    container.innerHTML = `
      <div class="chat-empty-state">
        <div class="chat-empty-title">What can I help with?</div>
        <div class="chat-empty-subtitle">Start a conversation with Agent Cockpit</div>
        <div class="chat-prompt-cards">
          <div class="chat-prompt-card" data-prompt="Summarize today's action plan and priorities">Summarize today's action plan and priorities</div>
          <div class="chat-prompt-card" data-prompt="What are my active tasks and their status?">What are my active tasks and their status?</div>
          <div class="chat-prompt-card" data-prompt="Review my LinkedIn content strategy">Review my LinkedIn content strategy</div>
        </div>
      </div>
    `;
    // Wire prompt cards
    container.querySelectorAll('.chat-prompt-card').forEach(card => {
      card.onclick = () => {
        const textarea = document.getElementById('chat-textarea');
        if (textarea) {
          textarea.value = card.dataset.prompt;
          chatAutoResize(textarea);
          chatSendMessage();
        }
      };
    });
    return;
  }

  // Messages are already just the current session (archived sessions live in separate files)
  const currentSessionMsgs = chatActiveConv.messages;

  let html = '';
  for (let mi = 0; mi < currentSessionMsgs.length; mi++) {
    const msg = currentSessionMsgs[mi];

    const isUser = msg.role === 'user';
    const backendIcon = !isUser && msg.backend ? getBackendIcon(msg.backend) : null;
    const avatar = isUser ? '👤' : (backendIcon || DEFAULT_BACKEND_ICON);
    const avatarClass = !isUser && backendIcon ? ' chat-msg-avatar-svg' : '';
    const roleLabel = isUser ? 'You' : 'Assistant';
    const backendLabel = msg.backend ? `<span class="chat-msg-model">${esc(CHAT_BACKENDS.find(b => b.id === msg.backend)?.label || msg.backend)}</span>` : '';
    const rendered = chatRenderMarkdown(msg.content);
    const caps = msg.backend ? getBackendCapabilities(msg.backend) : {};
    const thinkingHtml = msg.thinking && caps.thinking !== false ? chatRenderThinkingBlock(msg.thinking, false) : '';

    // Elapsed time for assistant messages (time since preceding user message)
    let elapsedLabel = '';
    if (!isUser && msg.timestamp) {
      for (let j = mi - 1; j >= 0; j--) {
        if (currentSessionMsgs[j].role === 'user' && currentSessionMsgs[j].timestamp) {
          const delta = new Date(msg.timestamp) - new Date(currentSessionMsgs[j].timestamp);
          if (delta > 0 && delta < 3600000) {
            elapsedLabel = `<span class="chat-msg-elapsed">${chatFormatElapsed(delta)}</span>`;
          }
          break;
        }
      }
    }

    const timeLabel = msg.timestamp ? `<span class="chat-msg-time">${chatFormatTimestamp(msg.timestamp)}${elapsedLabel}</span>` : '';

    html += `
      <div class="chat-msg ${esc(msg.role)}" data-msg-id="${esc(msg.id)}">
        <div class="chat-msg-wrapper">
          <div class="chat-msg-avatar${avatarClass}">${avatar}</div>
          <div class="chat-msg-body">
            <div class="chat-msg-role">${roleLabel} ${backendLabel}${timeLabel}</div>
            <div class="chat-msg-content">${thinkingHtml}${rendered}</div>
            <div class="chat-msg-actions">
              <button class="chat-msg-action" data-action="copy-msg" title="Copy">Copy</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
  chatWireMessageActions(container);
  chatHighlightCode(container);

  // Restore streaming UI if this conversation has an active stream
  const streamState = chatStreamingState.get(chatActiveConvId);
  if (streamState) {
    const msgEl = chatAppendStreamingMessage();
    streamState.streamingMsgEl = msgEl;
    chatStartElapsedTimer(chatActiveConvId);

    if (streamState.pendingInteraction) {
      if (streamState.pendingInteraction.type === 'planApproval') {
        chatShowPlanApproval(msgEl, chatActiveConvId, streamState.pendingInteraction.planContent);
      } else if (streamState.pendingInteraction.type === 'userQuestion') {
        chatShowUserQuestion(msgEl, chatActiveConvId, streamState.pendingInteraction.event);
      }
    } else if (streamState.assistantContent || streamState.assistantThinking) {
      chatUpdateStreamingMessage(msgEl, streamState.assistantContent, streamState.assistantThinking);
    } else if ((streamState.activeTools && streamState.activeTools.length) || (streamState.activeAgents && streamState.activeAgents.length) || streamState.planModeActive) {
      chatUpdateStreamingActivity(msgEl, streamState.activeTools || [], streamState.activeAgents || [], streamState.planModeActive);
      chatStartActivityTimer(chatActiveConvId);
    }
    // else: default typing dots shown by chatAppendStreamingMessage
  }

  chatScrollToBottom();
}

function chatRenderThinkingBlock(thinking, expanded) {
  const openAttr = expanded ? ' open' : '';
  return `<details class="chat-thinking-block"${openAttr}>
    <summary class="chat-thinking-toggle">Thinking</summary>
    <div class="chat-thinking-content">${chatRenderMarkdown(thinking)}</div>
  </details>`;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

function chatRenderUploadedFiles(html) {
  // Replace [Uploaded files: path1, path2] with inline images for image files.
  // This runs on the final HTML, so the pattern may be inside <p> tags.
  return html.replace(/<p>\s*\[Uploaded files?:\s*([^\]]+)\]\s*<\/p>|(\[Uploaded files?:\s*([^\]]+)\])/g, (match, pInner, bare, bareInner) => {
    const pathList = pInner || bareInner;
    if (!pathList) return match;
    const paths = pathList.split(',').map(p => p.trim());
    const parts = [];
    const nonImages = [];
    for (const fullPath of paths) {
      const filename = fullPath.split('/').pop();
      if (IMAGE_EXTENSIONS.test(filename)) {
        const segments = fullPath.replace(/\\/g, '/').split('/');
        const artifactsIdx = segments.lastIndexOf('artifacts');
        const convId = artifactsIdx >= 0 ? segments[artifactsIdx + 1] : chatActiveConvId;
        const url = chatApiUrl(`conversations/${encodeURIComponent(convId)}/files/${encodeURIComponent(filename)}`);
        parts.push(`<div class="chat-inline-image-wrap"><img class="chat-inline-image" src="${url}" alt="${esc(filename)}" title="${esc(filename)}" onclick="chatOpenLightbox(this.src)"></div>`);
      } else {
        nonImages.push(filename);
      }
    }
    let result = '';
    if (nonImages.length) {
      result += `<p>[Uploaded files: ${nonImages.join(', ')}]</p>`;
    }
    if (parts.length) {
      result += parts.join('');
    }
    return result;
  });
}

function chatRenderMarkdown(text) {
  if (!text) return '';
  if (typeof marked !== 'undefined') {
    const renderer = new marked.Renderer();
    const origCode = renderer.code;
    renderer.code = function(code, language) {
      let codeText, lang;
      if (typeof code === 'object' && code !== null) {
        codeText = code.text || '';
        lang = code.lang || language || '';
      } else {
        codeText = code || '';
        lang = language || '';
      }
      const lineCount = codeText.split('\n').length;
      const collapsible = lineCount > 50;
      const langLabel = lang ? esc(lang) : 'code';
      return `<div class="chat-code-block${collapsible ? ' collapsible collapsed' : ''}">
        <div class="chat-code-header">
          <span class="chat-code-lang">${langLabel}</span>
          <button class="chat-code-copy" onclick="chatCopyCode(this)">Copy</button>
        </div>
        <pre><code class="${lang ? 'language-' + esc(lang) : ''}">${esc(codeText)}</code></pre>
        ${collapsible ? '<div class="chat-code-expand" onclick="chatToggleCodeBlock(this)">Show more</div>' : ''}
      </div>`;
    };
    let html = marked.parse(text, { renderer, breaks: true });
    return chatRenderUploadedFiles(html);
  }
  let html = esc(text).replace(/\n/g, '<br>');
  return chatRenderUploadedFiles(html);
}

function chatOpenLightbox(src) {
  const overlay = document.getElementById('chat-lightbox');
  const img = document.getElementById('chat-lightbox-img');
  img.src = src;
  overlay.classList.add('active');
  document.addEventListener('keydown', chatLightboxEscHandler);
}

function chatCloseLightbox() {
  const overlay = document.getElementById('chat-lightbox');
  overlay.classList.remove('active');
  document.removeEventListener('keydown', chatLightboxEscHandler);
}

function chatLightboxEscHandler(e) {
  if (e.key === 'Escape') chatCloseLightbox();
}

function chatHighlightCode(container) {
  if (typeof hljs === 'undefined') return;
  container.querySelectorAll('.chat-code-block pre code').forEach(el => {
    hljs.highlightElement(el);
  });
}

function chatCopyCode(btn) {
  const codeEl = btn.closest('.chat-code-block').querySelector('code');
  if (codeEl) {
    navigator.clipboard.writeText(codeEl.textContent).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    });
  }
}
window.chatCopyCode = chatCopyCode;

function chatToggleCodeBlock(expandEl) {
  const block = expandEl.closest('.chat-code-block');
  if (block) {
    block.classList.toggle('collapsed');
    expandEl.textContent = block.classList.contains('collapsed') ? 'Show more' : 'Show less';
  }
}
window.chatToggleCodeBlock = chatToggleCodeBlock;

function chatWireMessageActions(container) {
  container.querySelectorAll('.chat-msg-action').forEach(btn => {
    btn.onclick = () => {
      const action = btn.dataset.action;
      const msgEl = btn.closest('.chat-msg');
      const msgId = msgEl ? msgEl.dataset.msgId : null;

      if (action === 'copy-msg') {
        const content = msgEl.querySelector('.chat-msg-content');
        if (content) navigator.clipboard.writeText(content.textContent);
      }
    };
  });
}

function chatScrollToBottom() {
  const container = document.getElementById('chat-messages');
  if (container) {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }
}

// ── Sending messages ──────────────────────────────────────────────────────────

function chatCleanupStreamState(convId) {
  const st = chatStreamingState.get(convId);
  if (!st) return;
  if (st.elapsedTimerInterval) clearInterval(st.elapsedTimerInterval);
  if (st.activityTimerInterval) clearInterval(st.activityTimerInterval);
  if (st.pendingInteraction) {
    // Keep the streaming bubble alive for pending interactions
    // (plan approval, user questions) so the user can still act on them
    return;
  }
  if (st.streamingMsgEl && st.streamingMsgEl.isConnected) {
    st.streamingMsgEl.remove();
  }
  chatStreamingState.delete(convId);
}

async function chatSendMessage() {
  const textarea = document.getElementById('chat-textarea');
  const hasText = textarea && textarea.value.trim();
  const completedFiles = chatPendingFiles.filter(e => e.status === 'done');
  const hasFiles = completedFiles.length > 0;
  if ((!hasText && !hasFiles) || chatStreamingConvs.has(chatActiveConvId) || chatResettingConvs.has(chatActiveConvId)) return;
  if (chatPendingFiles.some(e => e.status === 'uploading')) return;

  let content = textarea ? textarea.value.trim() : '';
  if (textarea) { textarea.value = ''; chatAutoResize(textarea); }

  // Gather uploaded file paths and clear pending files
  if (hasFiles) {
    const paths = completedFiles.map(e => e.result.path).join(', ');
    content = content
      ? content + '\n\n[Uploaded files: ' + paths + ']'
      : '[Uploaded files: ' + paths + ']';
  }
  chatPendingFiles = [];
  chatRenderFileChips();
  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) sendBtn.disabled = true;

  // Create conversation if none active (text-only messages without prior file attach)
  if (!chatActiveConvId) {
    try {
      const body = chatPendingWorkingDir ? { workingDir: chatPendingWorkingDir } : {};
      chatPendingWorkingDir = null;
      const res = await chatFetch('conversations', { method: 'POST', body });
      const conv = await res.json();
      chatActiveConvId = conv.id;
      chatActiveConv = conv;
      chatLoadConversations();
      chatUpdateHeader();
    } catch (err) {
      alert('Failed to create conversation: ' + err.message);
      return;
    }
  }

  const backend = document.getElementById('chat-backend-select')?.value || (CHAT_BACKENDS[0]?.id || 'claude-code');
  const targetConvId = chatActiveConvId;

  // Start streaming
  chatStreamingConvs.add(targetConvId);
  chatStreamingState.set(targetConvId, {
    assistantContent: '',
    assistantThinking: '',
    activeTools: [],
    activeAgents: [],
    planModeActive: false,
    pendingInteraction: null,
    streamingMsgEl: null,
    streamStartTime: Date.now(),
    elapsedTimerInterval: null,
    activityTimerInterval: null,
  });
  chatRenderConvList();
  chatUpdateSendButtonState();

  try {
    const response = await fetch(chatApiUrl(`conversations/${targetConvId}/message`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken || '',
      },
      credentials: 'same-origin',
      body: JSON.stringify({ content, backend }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || response.statusText);
    }

    const postResult = await response.json();

    if (chatActiveConv && chatActiveConvId === targetConvId && postResult.userMessage) {
      chatActiveConv.messages.push(postResult.userMessage);
      chatRenderMessages();
    }

    const state = chatStreamingState.get(targetConvId);
    if (!state) return; // cleaned up before stream started

    if (chatActiveConvId === targetConvId && !state.streamingMsgEl) {
      state.streamingMsgEl = chatAppendStreamingMessage();
      chatStartElapsedTimer(targetConvId);
    }

    const sseResponse = await fetch(chatApiUrl(`conversations/${targetConvId}/stream`), {
      credentials: 'same-origin',
    });

    const reader = sseResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6);
        if (!jsonStr.trim()) continue;

        try {
          const event = JSON.parse(jsonStr);
          const st = chatStreamingState.get(targetConvId);
          if (!st) break; // state was cleaned up
          const isStillActive = (chatActiveConvId === targetConvId);

          // Ensure DOM element exists when active, detect orphaned nodes
          if (isStillActive && (!st.streamingMsgEl || !st.streamingMsgEl.isConnected)) {
            st.streamingMsgEl = chatAppendStreamingMessage();
          }

          if (event.type === 'thinking') {
            st.assistantThinking += event.content;
            if (isStillActive) {
              chatUpdateStreamingMessage(st.streamingMsgEl, st.assistantContent, st.assistantThinking);
            }
          } else if (event.type === 'text') {
            st.assistantContent += event.content;
            if (st.pendingInteraction) {
              // Pending interaction (plan approval, user question) — don't overwrite
              // dialog with streaming text. Just accumulate assistantContent silently.
            } else {
              st.activeTools = [];
              st.activeAgents = [];
              if (st.activityTimerInterval) { clearInterval(st.activityTimerInterval); st.activityTimerInterval = null; }
              if (isStillActive) {
                chatUpdateStreamingMessage(st.streamingMsgEl, st.assistantContent, st.assistantThinking);
              }
            }
          } else if (event.type === 'tool_activity') {
            if (event.isAgent) {
              st.activeAgents.push({ subagentType: event.subagentType || 'agent', description: event.description || '', startTime: event.startTime || Date.now() });
            } else if (event.isPlanMode) {
              if (event.planAction === 'enter') st.planModeActive = true;
              else if (event.planAction === 'exit') st.planModeActive = false;
            }
            if (!event.isAgent && !event.isPlanMode) {
              st.activeTools.push({ tool: event.tool, description: event.description || '', startTime: event.startTime || Date.now() });
            }
            // Track pending interactions for restoration on switch-back
            if (event.isPlanMode && event.planAction === 'exit') {
              // Prefer plan file content (from Write tool) over streamed text summary
              const planContent = event.planContent || st.assistantContent;
              st.pendingInteraction = { type: 'planApproval', planContent };
            } else if (event.isQuestion) {
              st.pendingInteraction = { type: 'userQuestion', event };
            }
            if (isStillActive) {
              if (event.isPlanMode && event.planAction === 'exit') {
                chatShowPlanApproval(st.streamingMsgEl, targetConvId, st.pendingInteraction.planContent);
              } else if (event.isQuestion) {
                chatShowUserQuestion(st.streamingMsgEl, targetConvId, event);
              } else if (!st.pendingInteraction) {
                // Only render tool activity if no pending interaction (plan approval, user question)
                chatUpdateStreamingActivity(st.streamingMsgEl, st.activeTools, st.activeAgents, st.planModeActive);
                chatStartActivityTimer(targetConvId);
              }
            }
          } else if (event.type === 'assistant_message') {
            // Reset streaming state before re-render so the restored bubble
            // shows typing dots instead of stale content duplicating the
            // completed message that chatRenderMessages is about to display.
            // Preserve pending interactions (plan approval, user questions)
            // so they survive intermediate message saves — chatRenderMessages()
            // will restore the UI from pendingInteraction.
            const savedInteraction = st.pendingInteraction;
            st.assistantContent = '';
            st.assistantThinking = '';
            st.activeTools = [];
            st.activeAgents = [];
            st.planModeActive = false;
            st.pendingInteraction = savedInteraction;
            if (st.activityTimerInterval) { clearInterval(st.activityTimerInterval); st.activityTimerInterval = null; }
            if (isStillActive && chatActiveConv) {
              chatActiveConv.messages.push(event.message);
              chatRenderMessages();
              chatUpdateHeader();
            }
            chatLoadConversations();
          } else if (event.type === 'error') {
            st.pendingInteraction = null;
            st.activeTools = [];
            st.activeAgents = [];
            st.planModeActive = false;
            if (st.activityTimerInterval) { clearInterval(st.activityTimerInterval); st.activityTimerInterval = null; }
            if (isStillActive) chatAppendError(event.error);
          } else if (event.type === 'done') {
            chatCleanupStreamState(targetConvId);
          }
        } catch (parseErr) {
          console.warn('SSE event parse/handling error:', parseErr);
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      if (chatActiveConvId === targetConvId) chatAppendError(err.message);
    }
  } finally {
    chatStreamingConvs.delete(targetConvId);
    chatCleanupStreamState(targetConvId);
    chatUpdateSendButtonState();
    chatRenderConvList();
  }
}

function chatAppendStreamingMessage() {
  const container = document.getElementById('chat-messages');
  if (!container) return null;

  const currentBackend = chatActiveConv?.backend || 'claude-code';
  const icon = getBackendIcon(currentBackend);
  const msgEl = document.createElement('div');
  msgEl.className = 'chat-msg assistant streaming';
  msgEl.innerHTML = `
    <div class="chat-msg-wrapper">
      <div class="chat-msg-avatar${icon ? ' chat-msg-avatar-svg' : ''}">${icon || DEFAULT_BACKEND_ICON}</div>
      <div class="chat-msg-body">
        <div class="chat-msg-role">Assistant<span class="chat-elapsed-timer"></span></div>
        <div class="chat-msg-content">
          <div class="chat-typing">
            <div class="chat-typing-dot"></div>
            <div class="chat-typing-dot"></div>
            <div class="chat-typing-dot"></div>
          </div>
        </div>
      </div>
    </div>
  `;
  container.appendChild(msgEl);
  chatScrollToBottom();
  return msgEl;
}

function chatUpdateStreamingMessage(msgEl, content, thinking) {
  if (!msgEl) return;
  const contentEl = msgEl.querySelector('.chat-msg-content');
  if (contentEl) {
    let html = '';
    if (thinking) {
      html += chatRenderThinkingBlock(thinking, true);
    }
    if (content) {
      html += chatRenderMarkdown(content);
    } else if (thinking) {
      html += '<div class="chat-thinking-status">Thinking...</div>';
    }
    contentEl.innerHTML = html;
    chatHighlightCode(contentEl);
  }
  chatScrollToBottom();
}

function chatUpdateStreamingActivity(msgEl, tools, agents, planMode) {
  if (!msgEl) return;
  const contentEl = msgEl.querySelector('.chat-msg-content');
  if (!contentEl) return;

  let html = '';

  // Activity history (completed tools with checkmarks)
  if (tools.length > 1) {
    html += '<div class="chat-activity-history">';
    for (let i = 0; i < tools.length - 1; i++) {
      const t = tools[i];
      const desc = t.description ? escWithCode(t.description) : esc(t.tool || 'Tool');
      let durationMs = t.duration;
      if (!durationMs && t.startTime) {
        const nextStart = tools[i + 1].startTime || Date.now();
        durationMs = nextStart - t.startTime;
      }
      const elapsed = durationMs ? chatFormatElapsedShort(durationMs) : '';
      html += `<div class="chat-activity-history-item"><span class="chat-activity-check">✓</span> <span class="chat-activity-history-desc">${desc}</span>${elapsed ? `<span class="chat-activity-elapsed">${elapsed}</span>` : ''}</div>`;
    }
    html += '</div>';
  }

  // Current active tool
  if (tools.length > 0) {
    const current = tools[tools.length - 1];
    const desc = current.description ? escWithCode(current.description) : esc(current.tool || 'Working');
    const initialElapsed = current.startTime ? chatFormatElapsed(Date.now() - current.startTime) : '';
    html += `<div class="chat-activity-indicator">
      <div class="chat-typing"><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div></div>
      <span class="chat-activity-label">${desc}</span>
      ${initialElapsed ? `<span class="chat-activity-timer-live">${initialElapsed}</span>` : ''}
    </div>`;
  }

  // Agent cards
  if (agents.length > 0) {
    html += '<div class="chat-agent-cards">';
    for (const agent of agents) {
      const agentType = esc(agent.subagentType || 'agent');
      const agentDesc = agent.description ? escWithCode(agent.description) : '';
      const initialElapsed = agent.startTime ? chatFormatElapsed(Date.now() - agent.startTime) : '';
      html += `<div class="chat-agent-card">
        <div class="chat-agent-spinner"></div>
        <div class="chat-agent-card-header">
          <span class="chat-agent-type">${agentType}</span>
          ${agentDesc ? `<span class="chat-agent-card-desc">${agentDesc}</span>` : ''}
        </div>
        ${initialElapsed ? `<span class="chat-agent-timer-live">${initialElapsed}</span>` : ''}
      </div>`;
    }
    html += '</div>';
  }

  // Plan mode banner
  if (planMode) {
    html += `<div class="chat-plan-mode-banner">
      <span class="chat-plan-mode-icon">📋</span> Planning mode active
    </div>`;
  }

  if (!html) {
    html = `<div class="chat-activity-indicator">
      <div class="chat-typing"><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div></div>
      <span class="chat-activity-label">Working...</span>
    </div>`;
  }

  contentEl.innerHTML = html;
  chatScrollToBottom();
}

function chatStartElapsedTimer(convId) {
  const state = chatStreamingState.get(convId);
  if (!state || state.elapsedTimerInterval) return;
  // Show initial value immediately
  const timerEl = state.streamingMsgEl?.querySelector('.chat-elapsed-timer');
  if (timerEl) timerEl.textContent = chatFormatElapsed(Date.now() - state.streamStartTime);
  state.elapsedTimerInterval = setInterval(() => {
    const st = chatStreamingState.get(convId);
    if (!st || !st.streamingMsgEl || !st.streamingMsgEl.isConnected) {
      clearInterval(state.elapsedTimerInterval);
      return;
    }
    const el = st.streamingMsgEl.querySelector('.chat-elapsed-timer');
    if (el) el.textContent = chatFormatElapsed(Date.now() - st.streamStartTime);
  }, 1000);
}

function chatStartActivityTimer(convId) {
  const state = chatStreamingState.get(convId);
  if (!state || state.activityTimerInterval) return;
  state.activityTimerInterval = setInterval(() => {
    const st = chatStreamingState.get(convId);
    if (!st || !st.streamingMsgEl || !st.streamingMsgEl.isConnected) {
      clearInterval(state.activityTimerInterval);
      state.activityTimerInterval = null;
      return;
    }
    // Update current tool timer
    const toolTimerEl = st.streamingMsgEl.querySelector('.chat-activity-timer-live');
    if (toolTimerEl && st.activeTools.length > 0) {
      const current = st.activeTools[st.activeTools.length - 1];
      if (current.startTime) toolTimerEl.textContent = chatFormatElapsed(Date.now() - current.startTime);
    }
    // Update agent card timers
    const agentTimerEls = st.streamingMsgEl.querySelectorAll('.chat-agent-timer-live');
    agentTimerEls.forEach((el, idx) => {
      if (idx < st.activeAgents.length && st.activeAgents[idx].startTime) {
        el.textContent = chatFormatElapsed(Date.now() - st.activeAgents[idx].startTime);
      }
    });
  }, 1000);
}

function chatShowPlanApproval(msgEl, convId, planContent) {
  if (!msgEl) return;
  const contentEl = msgEl.querySelector('.chat-msg-content');
  if (!contentEl) return;
  const planHtml = planContent ? chatRenderMarkdown(planContent) : '';
  contentEl.innerHTML = `
    ${planHtml ? `<div class="chat-plan-approval-content">${planHtml}</div>` : ''}
    <div class="chat-plan-approval">
      <div class="chat-plan-approval-title">Plan ready for review</div>
      <div class="chat-plan-approval-actions">
        <button class="chat-plan-approval-btn approve" data-action="approve">Approve</button>
        <button class="chat-plan-approval-btn reject" data-action="reject">Reject</button>
      </div>
    </div>
  `;
  chatHighlightCode(contentEl);
  contentEl.querySelectorAll('.chat-plan-approval-btn').forEach(btn => {
    btn.onclick = async () => {
      const action = btn.dataset.action;
      const text = action === 'approve' ? 'yes' : 'no';
      try {
        await fetch(chatApiUrl(`conversations/${convId}/input`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken || '' },
          credentials: 'same-origin',
          body: JSON.stringify({ text }),
        });
        const approvalState = chatStreamingState.get(convId);
        if (approvalState) {
          if (approvalState.elapsedTimerInterval) clearInterval(approvalState.elapsedTimerInterval);
          approvalState.pendingInteraction = null;
          // If the stream has ended (no longer in chatStreamingConvs), fully clean up
          if (!chatStreamingConvs.has(convId)) {
            chatStreamingState.delete(convId);
          }
        }
        contentEl.innerHTML = `${planHtml ? `<div class="chat-plan-approval-content">${planHtml}</div>` : ''}<div style="font-size:12px;color:var(--muted);font-style:italic;">Plan ${action === 'approve' ? 'approved' : 'rejected'}.</div>`;
        chatHighlightCode(contentEl);
      } catch (err) {
        contentEl.innerHTML = `<div style="font-size:12px;color:var(--danger);">Failed to send response: ${esc(err.message)}</div>`;
      }
    };
  });
  chatScrollToBottom();
}

function chatShowUserQuestion(msgEl, convId, event) {
  if (!msgEl) return;
  const contentEl = msgEl.querySelector('.chat-msg-content');
  if (!contentEl) return;

  const questions = event.questions || [];
  const questionText = questions.length > 0 ? (questions[0].question || 'Input needed') : (event.description || 'Input needed');
  const options = questions.length > 0 ? (questions[0].options || []) : [];

  let optionsHtml = '';
  if (options.length > 0) {
    optionsHtml = '<div class="chat-user-question-options">';
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      optionsHtml += `<button class="chat-user-question-option" data-value="${esc(opt.label || opt)}">${esc(opt.label || opt)}${opt.description ? `<br><span style="font-size:11px;color:var(--muted);font-weight:normal;">${esc(opt.description)}</span>` : ''}</button>`;
    }
    optionsHtml += '</div>';
  }

  contentEl.innerHTML = `
    <div class="chat-user-question">
      <div class="chat-user-question-header">Question</div>
      <div class="chat-user-question-text">${escWithCode(questionText)}</div>
      ${optionsHtml}
      <input class="chat-user-question-input" type="text" placeholder="Type your answer...">
      <button class="chat-user-question-submit" disabled>Send</button>
    </div>
  `;

  const input = contentEl.querySelector('.chat-user-question-input');
  const submitBtn = contentEl.querySelector('.chat-user-question-submit');

  // Option buttons
  contentEl.querySelectorAll('.chat-user-question-option').forEach(optBtn => {
    optBtn.onclick = () => {
      contentEl.querySelectorAll('.chat-user-question-option').forEach(b => b.classList.remove('selected'));
      optBtn.classList.add('selected');
      input.value = optBtn.dataset.value;
      submitBtn.disabled = false;
    };
  });

  input.oninput = () => { submitBtn.disabled = !input.value.trim(); };
  input.onkeydown = (e) => { if (e.key === 'Enter' && input.value.trim()) submitBtn.click(); };

  submitBtn.onclick = async () => {
    const text = input.value.trim();
    if (!text) return;
    submitBtn.disabled = true;
    try {
      await fetch(chatApiUrl(`conversations/${convId}/input`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken || '' },
        credentials: 'same-origin',
        body: JSON.stringify({ text }),
      });
      const questionState = chatStreamingState.get(convId);
      if (questionState) {
        questionState.pendingInteraction = null;
        if (!chatStreamingConvs.has(convId)) {
          chatStreamingState.delete(convId);
        }
      }
      contentEl.innerHTML = `<div style="font-size:12px;color:var(--muted);font-style:italic;">Answered: ${esc(text)}</div>`;
    } catch (err) {
      contentEl.innerHTML = `<div style="font-size:12px;color:var(--danger);">Failed to send response: ${esc(err.message)}</div>`;
    }
  };

  chatScrollToBottom();
}

function chatFormatErrorMessage(errorMsg) {
  // Parse "API Error: 500 {...json...}" into a friendly message
  const apiMatch = errorMsg.match(/^API Error:\s*(\d{3})\s*(.*)/s);
  if (apiMatch) {
    const code = apiMatch[1];
    const rest = apiMatch[2].trim();
    let detail = '';
    try {
      const parsed = JSON.parse(rest);
      detail = (parsed.error && parsed.error.message) || parsed.message || '';
    } catch {
      detail = rest;
    }
    if (code === '500') return 'The API returned an internal server error. This is usually a temporary issue — try again.';
    if (code === '429') return 'Rate limit exceeded. Please wait a moment before retrying.';
    if (code === '529') return 'The API is temporarily overloaded. Please try again shortly.';
    return `API error ${code}${detail ? ': ' + detail : ''}`;
  }
  return errorMsg;
}

function chatAppendError(errorMsg) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const friendly = chatFormatErrorMessage(errorMsg);
  const errEl = document.createElement('div');
  errEl.className = 'chat-msg assistant';
  errEl.innerHTML = `
    <div class="chat-msg-wrapper">
      <div class="chat-msg-avatar" style="background:#fee2e2;color:#dc2626;">!</div>
      <div class="chat-msg-body">
        <div class="chat-msg-role" style="color:#dc2626;">Error</div>
        <div class="chat-msg-content" style="color:#dc2626;">${esc(friendly)}</div>
        <div class="chat-msg-actions" style="opacity:1;">
          <button class="chat-msg-action" onclick="chatRetryLast()">Retry</button>
        </div>
      </div>
    </div>
  `;
  container.appendChild(errEl);
  chatScrollToBottom();
}

async function chatStopStreaming() {
  if (!chatActiveConvId) return;
  try {
    await chatFetch(`conversations/${chatActiveConvId}/abort`, { method: 'POST', body: {} });
  } catch {}
}


function chatRetryLast() {
  if (!chatActiveConv) return;
  const lastUser = [...chatActiveConv.messages].reverse().find(m => m.role === 'user');
  if (lastUser) {
    const textarea = document.getElementById('chat-textarea');
    if (textarea) {
      textarea.value = lastUser.content;
      chatAutoResize(textarea);
      chatSendMessage();
    }
  }
}
window.chatRetryLast = chatRetryLast;

// ── Session management ────────────────────────────────────────────────────────

async function chatResetSession(convIdOverride) {
  const convId = typeof convIdOverride === 'string' ? convIdOverride : chatActiveConvId;
  if (!convId) return;
  if (chatStreamingConvs.has(convId)) { alert('Cannot reset session while streaming.'); return; }
  if (chatResettingConvs.has(convId)) return;

  // Enter resetting state
  chatResettingConvs.add(convId);
  chatUpdateSendButtonState();

  const resetBtn = document.getElementById('chat-reset-btn');
  if (resetBtn) { resetBtn.disabled = true; resetBtn.textContent = '↻ Resetting...'; }

  // Show progress indicator in messages area
  let progressEl = null;
  if (convId === chatActiveConvId) {
    const container = document.getElementById('chat-messages');
    if (container) {
      progressEl = document.createElement('div');
      progressEl.className = 'chat-msg assistant';
      progressEl.id = 'chat-reset-progress';
      progressEl.innerHTML = `
        <div class="chat-msg-wrapper">
          <div class="chat-msg-avatar chat-msg-avatar-svg">${getBackendIcon(chatActiveConv?.backend || 'claude-code')}</div>
          <div class="chat-msg-body">
            <div class="chat-msg-role">System</div>
            <div class="chat-msg-content">
              <div class="chat-activity-indicator">
                <div class="chat-typing"><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div></div>
                <span class="chat-activity-label">Archiving session...</span>
              </div>
            </div>
          </div>
        </div>`;
      container.appendChild(progressEl);
      chatScrollToBottom();
    }
  }

  try {
    const res = await chatFetch(`conversations/${convId}/reset`, { method: 'POST', body: {} });
    const data = await res.json();
    if (convId === chatActiveConvId) {
      chatActiveConv = data.conversation;
      chatRenderMessages();
    }
    chatLoadConversations();
  } catch (err) {
    if (progressEl && progressEl.isConnected) progressEl.remove();
    alert('Session reset failed: ' + err.message);
  } finally {
    chatResettingConvs.delete(convId);
    const leftover = document.getElementById('chat-reset-progress');
    if (leftover) leftover.remove();
    if (resetBtn) { resetBtn.disabled = false; resetBtn.textContent = '↻ Reset'; }
    chatUpdateSendButtonState();
  }
}

async function chatShowSessions() {
  if (!chatActiveConvId) return;
  try {
    const res = await chatFetch(`conversations/${chatActiveConvId}/sessions`);
    const data = await res.json();
    const sessions = data.sessions || [];

    let html = '<div class="chat-modal-body">';
    if (sessions.length === 0) {
      html += '<div style="color:var(--muted);font-size:13px;">No sessions yet.</div>';
    } else {
      for (const s of sessions) {
        const started = new Date(s.startedAt).toLocaleString();
        const ended = s.endedAt ? new Date(s.endedAt).toLocaleString() : null;
        const status = s.isCurrent ? '<span class="pill pill-running">Current</span>' : '';
        html += `
          <div style="padding:10px 0;border-bottom:1px solid var(--border);">
            <div style="display:flex;align-items:center;gap:8px;justify-content:space-between;">
              <div style="display:flex;align-items:center;gap:8px;">
                <strong>Session ${s.number}</strong> ${status}
              </div>
              <div style="display:flex;gap:6px;">
                <button class="chat-header-btn chat-dl-session-btn" data-session="${s.number}" style="font-size:11px;padding:2px 10px;cursor:pointer;">Download</button>
                <button class="chat-header-btn chat-view-session-btn" data-session="${s.number}" style="font-size:11px;padding:2px 10px;cursor:pointer;">View</button>
              </div>
            </div>
            ${s.summary ? `<div style="font-size:12px;color:var(--fg);margin-top:4px;">${esc(s.summary)}</div>` : ''}
            <div style="font-size:11px;color:var(--muted);margin-top:2px;">
              Started: ${esc(started)}${ended ? ` — Ended: ${esc(ended)}` : ''}
              · ${s.messageCount} messages
            </div>
          </div>
        `;
      }
    }
    html += '</div>';

    chatShowModal('Session History', html);
    document.querySelectorAll('.chat-view-session-btn').forEach(btn => {
      btn.addEventListener('click', () => chatViewSession(Number(btn.dataset.session)));
    });
    document.querySelectorAll('.chat-dl-session-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        window.open(apiUrl(`chat/conversations/${chatActiveConvId}/sessions/${btn.dataset.session}/download`), '_blank');
      });
    });
  } catch (err) {
    alert('Failed to load sessions: ' + err.message);
  }
}

async function chatViewSession(sessionNumber) {
  if (!chatActiveConv) return;
  chatCloseModal();

  let sessionMsgs;
  try {
    if (sessionNumber === chatActiveConv.sessionNumber) {
      sessionMsgs = chatActiveConv.messages;
    } else {
      const res = await chatFetch(`conversations/${chatActiveConvId}/sessions/${sessionNumber}/messages`);
      const data = await res.json();
      sessionMsgs = data.messages || [];
    }
  } catch (err) {
    alert('Failed to load session: ' + err.message);
    return;
  }

  let sessionDate = '';
  if (sessionMsgs.length > 0 && sessionMsgs[0].timestamp) {
    sessionDate = new Date(sessionMsgs[0].timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  let msgsHtml = '';
  if (sessionMsgs.length === 0) {
    msgsHtml = '<div style="color:var(--muted);font-size:13px;padding:16px 0;">No messages in this session.</div>';
  } else {
    for (const msg of sessionMsgs) {
      const isUser = msg.role === 'user';
      const backendIcon = !isUser && msg.backend ? getBackendIcon(msg.backend) : null;
      const avatar = isUser ? '👤' : (backendIcon || DEFAULT_BACKEND_ICON);
      const avatarClass = !isUser && backendIcon ? ' chat-msg-avatar-svg' : '';
      const roleLabel = isUser ? 'You' : 'Assistant';
      const backendLabel = msg.backend ? `<span class="chat-msg-model">${esc(CHAT_BACKENDS.find(b => b.id === msg.backend)?.label || msg.backend)}</span>` : '';
      const rendered = chatRenderMarkdown(msg.content);
      const caps = msg.backend ? getBackendCapabilities(msg.backend) : {};
      const thinkingHtml = msg.thinking && caps.thinking !== false ? chatRenderThinkingBlock(msg.thinking, false) : '';
      msgsHtml += `
        <div class="chat-msg ${esc(msg.role)}">
          <div class="chat-msg-wrapper">
            <div class="chat-msg-avatar${avatarClass}">${avatar}</div>
            <div class="chat-msg-body">
              <div class="chat-msg-role">${roleLabel} ${backendLabel}</div>
              <div class="chat-msg-content">${thinkingHtml}${rendered}</div>
            </div>
          </div>
        </div>
      `;
    }
  }

  const title = `Session ${sessionNumber}` + (sessionDate ? ` — ${sessionDate}` : '');
  const html = `
    <div class="chat-modal-body" style="padding:0;">
      <div style="padding:8px 16px;border-bottom:1px solid var(--border);">
        <button class="chat-header-btn" id="chat-back-to-sessions" style="font-size:12px;cursor:pointer;">← Back to Session List</button>
      </div>
      <div style="max-height:60vh;overflow-y:auto;padding:8px 16px;">
        ${msgsHtml}
      </div>
    </div>
  `;

  chatShowModal(title, html);

  document.getElementById('chat-back-to-sessions')?.addEventListener('click', chatShowSessions);

  const overlay = document.getElementById('chat-modal-overlay');
  if (overlay) chatHighlightCode(overlay);
}
window.chatViewSession = chatViewSession;

// ── Download ──────────────────────────────────────────────────────────────────

async function chatDownloadConversation() {
  if (!chatActiveConvId) return;
  try {
    const res = await fetch(chatApiUrl(`conversations/${chatActiveConvId}/download`), { credentials: 'same-origin' });
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="(.+?)"/);
    const filename = match ? match[1] : 'conversation.md';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Download failed: ' + err.message);
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function chatShowSettings() {
  try {
    const res = await chatFetch('settings');
    chatSettingsData = await res.json();
  } catch {
    chatSettingsData = { theme: 'system', sendBehavior: 'enter', systemPrompt: '', defaultBackend: CHAT_BACKENDS[0]?.id || 'claude-code' };
  }

  const s = chatSettingsData;
  const html = `
    <div class="chat-modal-body">
      <div class="chat-settings-group">
        <div class="chat-settings-label">Theme</div>
        <select class="chat-settings-select" id="chat-settings-theme">
          <option value="light"${s.theme === 'light' ? ' selected' : ''}>Light</option>
          <option value="dark"${s.theme === 'dark' ? ' selected' : ''}>Dark</option>
          <option value="system"${s.theme === 'system' ? ' selected' : ''}>System</option>
        </select>
      </div>
      <div class="chat-settings-group">
        <div class="chat-settings-label">Send Behavior</div>
        <select class="chat-settings-select" id="chat-settings-send">
          <option value="enter"${s.sendBehavior === 'enter' ? ' selected' : ''}>Enter to send</option>
          <option value="ctrl-enter"${s.sendBehavior === 'ctrl-enter' ? ' selected' : ''}>Ctrl+Enter to send</option>
        </select>
      </div>
      <div class="chat-settings-group">
        <div class="chat-settings-label">Default Backend</div>
        <select class="chat-settings-select" id="chat-settings-backend">
          ${CHAT_BACKENDS.map(b => `<option value="${b.id}"${s.defaultBackend === b.id ? ' selected' : ''}>${esc(b.label)}</option>`).join('')}
        </select>
      </div>
      <div class="chat-settings-group">
        <div class="chat-settings-label">System Prompt</div>
        <div class="chat-settings-desc">Prepended to every new CLI session.</div>
        <textarea class="chat-settings-textarea" id="chat-settings-system-prompt" style="min-height:120px">${esc(s.systemPrompt || '')}</textarea>
      </div>
      <button class="chat-settings-save" onclick="chatSaveSettings()">Save Settings</button>
    </div>
  `;

  chatShowModal('Settings', html);
}

async function chatSaveSettings() {
  const settings = {
    theme: document.getElementById('chat-settings-theme')?.value || 'system',
    sendBehavior: document.getElementById('chat-settings-send')?.value || 'enter',
    defaultBackend: document.getElementById('chat-settings-backend')?.value || (CHAT_BACKENDS[0]?.id || 'claude-code'),
    systemPrompt: document.getElementById('chat-settings-system-prompt')?.value || '',
  };
  applyTheme(settings.theme);
  try {
    await chatFetch('settings', { method: 'PUT', body: settings });
    chatSettingsData = settings;
    chatCloseModal();
  } catch (err) {
    alert('Failed to save settings: ' + err.message);
  }
}
window.chatSaveSettings = chatSaveSettings;

// ── Modal helper ──────────────────────────────────────────────────────────────

function chatShowModal(title, bodyHtml) {
  chatCloseModal();
  const overlay = document.createElement('div');
  overlay.className = 'chat-modal-overlay';
  overlay.id = 'chat-modal-overlay';
  overlay.innerHTML = `
    <div class="chat-modal">
      <div class="chat-modal-header">
        <div class="chat-modal-title">${esc(title)}</div>
        <button class="chat-modal-close" id="chat-modal-close-btn">✕</button>
      </div>
      ${bodyHtml}
    </div>
  `;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) chatCloseModal(); });
  document.body.appendChild(overlay);
  document.getElementById('chat-modal-close-btn').addEventListener('click', chatCloseModal);
}

function chatCloseModal() {
  const overlay = document.getElementById('chat-modal-overlay');
  if (overlay) overlay.remove();
}
window.chatCloseModal = chatCloseModal;

// ── Self-update UI ───────────────────────────────────────────────────────────

async function chatManualVersionCheck() {
  const textEl = document.getElementById('chat-version-text');
  if (!textEl) return;
  const original = textEl.textContent;
  textEl.textContent = 'checking…';
  try {
    const res = await chatFetch('check-version', { method: 'POST' });
    const status = await res.json();
    textEl.textContent = 'v' + (status.localVersion || original.replace(/^v/, ''));
    chatCheckUpdateIndicator(status);
  } catch {
    textEl.textContent = original;
  }
}

function chatCheckUpdateIndicator(status) {
  const indicator = document.getElementById('chat-update-indicator');
  if (!indicator) return;
  if (status.updateAvailable && status.remoteVersion) {
    indicator.textContent = 'v' + status.remoteVersion + ' available';
    indicator.title = 'Update to v' + status.remoteVersion;
    indicator.style.display = '';
    indicator.onclick = () => chatShowUpdateModal(status);
  } else {
    indicator.style.display = 'none';
    indicator.onclick = null;
  }
}

function chatShowUpdateModal(status) {
  const localVer = status.localVersion || status.version || '?';
  const remoteVer = status.remoteVersion || '?';
  const html = `
    <div class="chat-modal-body" style="padding:16px;">
      <div style="margin-bottom:16px;">
        <div style="font-size:13px;color:var(--muted);margin-bottom:6px;">
          Current version: <strong>v${esc(localVer)}</strong>
        </div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:16px;">
          Available version: <strong>v${esc(remoteVer)}</strong>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:16px;">
          This will pull the latest code from main, install dependencies, and restart the server.
          The page will reload automatically.
        </div>
      </div>
      <div id="chat-update-status" style="display:none;margin-bottom:12px;"></div>
      <button class="chat-settings-save" id="chat-update-confirm-btn">Update Now</button>
    </div>
  `;
  chatShowModal('Update Available', html);
  document.getElementById('chat-update-confirm-btn').addEventListener('click', chatTriggerUpdate);
}

async function chatTriggerUpdate() {
  const statusEl = document.getElementById('chat-update-status');
  const btn = document.getElementById('chat-update-confirm-btn');
  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.innerHTML = '<div style="color:var(--muted);font-size:13px;">Updating... This may take a moment.</div>';
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Updating...';
  }

  try {
    const res = await chatFetch('update-trigger', { method: 'POST' });
    const result = await res.json();

    if (result.success) {
      if (statusEl) {
        statusEl.innerHTML = '<div style="color:var(--done);font-size:13px;">Update successful! Restarting server...</div>';
      }
      setTimeout(() => chatShowRestartOverlay(), 1000);
      setTimeout(() => window.location.reload(), 6000);
    } else {
      if (statusEl) {
        const stepsHtml = (result.steps || []).map(s =>
          '<div style="font-size:12px;color:' + (s.success ? 'var(--done)' : 'var(--danger)') + ';">'
          + (s.success ? '&#10003; ' : '&#10007; ') + esc(s.name) + '</div>'
        ).join('');
        statusEl.innerHTML =
          '<div style="color:var(--danger);font-size:13px;margin-bottom:8px;">'
          + esc(result.error) + '</div>' + stepsHtml;
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Retry Update';
      }
    }
  } catch (err) {
    // If the server restarted before sending the response, we get a network error
    if (err.message === 'Failed to fetch' || err.name === 'TypeError') {
      chatShowRestartOverlay();
      setTimeout(() => window.location.reload(), 5000);
      return;
    }
    if (statusEl) {
      statusEl.innerHTML = '<div style="color:var(--danger);font-size:13px;">Update failed: ' + esc(err.message) + '</div>';
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Retry Update';
    }
  }
}

function chatShowRestartOverlay() {
  chatCloseModal();
  const overlay = document.createElement('div');
  overlay.id = 'chat-restart-overlay';
  overlay.innerHTML =
    '<div class="restart-dialog">'
    + '<div style="font-size:18px;font-weight:600;margin-bottom:8px;">Restarting Server...</div>'
    + '<div style="font-size:13px;color:var(--muted);">The page will reload automatically.</div>'
    + '</div>';
  document.body.appendChild(overlay);
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;

  // Ctrl/Cmd + Shift + O — New chat
  if (mod && e.shiftKey && e.key === 'O') {
    e.preventDefault();
    chatNewConversation();
    return;
  }

  // Ctrl/Cmd + K — Search conversations
  if (mod && e.key === 'k') {
    e.preventDefault();
    const searchInput = document.getElementById('chat-search-input');
    if (searchInput) searchInput.focus();
    return;
  }

  // Ctrl/Cmd + Shift + S — Toggle sidebar
  if (mod && e.shiftKey && e.key === 'S') {
    e.preventDefault();
    chatToggleSidebar();
    return;
  }

  // Ctrl/Cmd + Shift + C — Copy last response
  if (mod && e.shiftKey && e.key === 'C') {
    e.preventDefault();
    if (chatActiveConv) {
      const lastAssistant = [...chatActiveConv.messages].reverse().find(m => m.role === 'assistant');
      if (lastAssistant) navigator.clipboard.writeText(lastAssistant.content);
    }
    return;
  }

  // Ctrl/Cmd + Shift + R — Reset session
  if (mod && e.shiftKey && e.key === 'R') {
    e.preventDefault();
    chatResetSession();
    return;
  }

  // Ctrl/Cmd + Shift + D — Download conversation
  if (mod && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    chatDownloadConversation();
    return;
  }

  // / — Focus input (when not in input)
  if (e.key === '/' && !e.target.closest('input, textarea, select, [contenteditable]')) {
    e.preventDefault();
    const textarea = document.getElementById('chat-textarea');
    if (textarea) textarea.focus();
    return;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
chatInit();

