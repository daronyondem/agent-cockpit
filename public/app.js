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

const CHAT_BACKENDS = [
  { id: 'claude-code', label: 'Claude Code' },
];

const CLAUDE_CODE_ICON = '<svg width="28" height="28" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" rx="128" fill="#D37D5B"/><path d="M256 220L285 85L305 92L275 225L380 145L395 165L285 245L440 265L435 290L285 275L390 380L365 400L265 295L295 440L265 445L245 295L180 420L155 405L230 280L100 340L90 315L225 260L70 250L75 225L225 235L110 145L130 130L235 215L170 85L195 80L245 210L256 220Z" fill="#F9EDE6"/></svg>';

// Chat state
let chatConversations = [];
let chatActiveConvId = null;
let chatActiveConv = null;
let chatStreamingConvs = new Set();
let chatStreamingState = new Map(); // convId -> { assistantContent, assistantThinking, activeTools, activeAgents, planModeActive, pendingInteraction, streamingMsgEl }
let chatAbortController = null;
let chatSidebarCollapsed = false;
let chatSearchTimeout = null;
let chatContextMenuEl = null;
let chatSettingsData = null;
let chatInitialized = false;
let chatPendingWorkingDir = null;
let chatPendingFiles = [];

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
  chatLoadConversations();

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
      const sendBtn = document.getElementById('chat-send-btn');
      if (sendBtn) sendBtn.disabled = !textarea.value.trim() && !chatPendingFiles.length && !chatStreamingConvs.has(chatActiveConvId);
    };
    textarea.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (textarea.value.trim() || chatPendingFiles.length) chatSendMessage();
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

function chatAddPendingFiles(files) {
  chatPendingFiles.push(...files);
  chatRenderFileChips();
  const sendBtn = document.getElementById('chat-send-btn');
  const ta = document.getElementById('chat-textarea');
  if (sendBtn) sendBtn.disabled = !chatPendingFiles.length && !(ta && ta.value.trim());
}

function chatRemovePendingFile(index) {
  chatPendingFiles.splice(index, 1);
  chatRenderFileChips();
  const sendBtn = document.getElementById('chat-send-btn');
  const ta = document.getElementById('chat-textarea');
  if (sendBtn) sendBtn.disabled = !chatPendingFiles.length && !(ta && ta.value.trim());
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
  container.innerHTML = chatPendingFiles.map((f, i) => {
    const isImage = f.type && f.type.startsWith('image/');
    const thumbHtml = isImage ? `<img class="chat-file-chip-thumb" src="${URL.createObjectURL(f)}" alt="">` : '';
    return `<div class="chat-file-chip">
      ${thumbHtml}
      <span class="chat-file-chip-name" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="chat-file-chip-size">${chatFormatFileSize(f.size)}</span>
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
        <div class="folder-browser-path" title="${esc(data.currentPath)}">${esc(data.currentPath)}</div>
        <label class="folder-browser-toggle">
          <input type="checkbox" id="folder-show-hidden" ${showHidden ? 'checked' : ''} /> Show hidden folders
        </label>
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
  }

  loadDir(browsePath);
}
window.chatShowFolderPicker = chatShowFolderPicker;

function chatUpdateSendButtonState() {
  const sendBtn = document.getElementById('chat-send-btn');
  if (!sendBtn) return;
  const isStreaming = chatStreamingConvs.has(chatActiveConvId);
  if (isStreaming) {
    sendBtn.disabled = false;
    sendBtn.textContent = '■';
    sendBtn.classList.add('stop');
  } else {
    sendBtn.textContent = '↑';
    sendBtn.classList.remove('stop');
    const ta = document.getElementById('chat-textarea');
    sendBtn.disabled = !(ta && ta.value.trim());
  }
}

async function chatSelectConversation(id) {
  if (id === chatActiveConvId) return;
  try {
    const res = await chatFetch(`conversations/${id}`);
    chatActiveConv = await res.json();
    chatActiveConvId = id;
    chatRenderConvList();
    chatRenderMessages();
    chatUpdateHeader();
    chatUpdateSendButtonState();
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
      chatActiveConvId = null;
      chatActiveConv = null;
      chatRenderMessages();
      chatUpdateHeader();
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
    <button class="chat-context-menu-item" data-action="archive">Archive</button>
    <button class="chat-context-menu-item danger" data-action="delete">Delete</button>
  `;
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  menu.querySelectorAll('.chat-context-menu-item').forEach(item => {
    item.onclick = () => {
      chatCloseContextMenu();
      if (item.dataset.action === 'rename') chatRenameConversation(convId);
      else if (item.dataset.action === 'archive') chatResetSession(convId);
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

  // Only show messages from the current session (after the last session divider)
  const allMsgs = chatActiveConv.messages;
  let lastDividerIdx = -1;
  for (let i = allMsgs.length - 1; i >= 0; i--) {
    if (allMsgs[i].isSessionDivider) { lastDividerIdx = i; break; }
  }
  const currentSessionMsgs = lastDividerIdx >= 0 ? allMsgs.slice(lastDividerIdx + 1) : allMsgs;

  let html = '';
  for (const msg of currentSessionMsgs) {

    const isUser = msg.role === 'user';
    const isClaudeCode = !isUser && msg.backend === 'claude-code';
    const avatar = isUser ? '👤' : (isClaudeCode ? CLAUDE_CODE_ICON : '⚡');
    const avatarClass = isClaudeCode ? ' chat-msg-avatar-svg' : '';
    const roleLabel = isUser ? 'You' : 'Assistant';
    const backendLabel = msg.backend ? `<span class="chat-msg-model">${esc(CHAT_BACKENDS.find(b => b.id === msg.backend)?.label || msg.backend)}</span>` : '';
    const rendered = chatRenderMarkdown(msg.content);
    const thinkingHtml = msg.thinking ? chatRenderThinkingBlock(msg.thinking, false) : '';

    html += `
      <div class="chat-msg ${esc(msg.role)}" data-msg-id="${esc(msg.id)}">
        <div class="chat-msg-wrapper">
          <div class="chat-msg-avatar${avatarClass}">${avatar}</div>
          <div class="chat-msg-body">
            <div class="chat-msg-role">${roleLabel} ${backendLabel}</div>
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

    if (streamState.pendingInteraction) {
      if (streamState.pendingInteraction.type === 'planApproval') {
        chatShowPlanApproval(msgEl, chatActiveConvId);
      } else if (streamState.pendingInteraction.type === 'userQuestion') {
        chatShowUserQuestion(msgEl, chatActiveConvId, streamState.pendingInteraction.event);
      }
    } else if (streamState.assistantContent || streamState.assistantThinking) {
      chatUpdateStreamingMessage(msgEl, streamState.assistantContent, streamState.assistantThinking);
    } else if (streamState.activeTools.length || streamState.activeAgents.length || streamState.planModeActive) {
      chatUpdateStreamingActivity(msgEl, streamState.activeTools, streamState.activeAgents, streamState.planModeActive);
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
    return marked.parse(text, { renderer, breaks: true });
  }
  return esc(text).replace(/\n/g, '<br>');
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

async function chatSendMessage() {
  const textarea = document.getElementById('chat-textarea');
  const hasText = textarea && textarea.value.trim();
  const hasFiles = chatPendingFiles.length > 0;
  if ((!hasText && !hasFiles) || chatStreamingConvs.has(chatActiveConvId)) return;

  let content = textarea ? textarea.value.trim() : '';
  if (textarea) { textarea.value = ''; chatAutoResize(textarea); }
  const filesToUpload = chatPendingFiles.slice();
  chatPendingFiles = [];
  chatRenderFileChips();
  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) sendBtn.disabled = true;

  // Create conversation if none active
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

  // Upload files if any
  if (filesToUpload.length) {
    try {
      const uploadResult = await chatUploadFiles(chatActiveConvId, filesToUpload);
      const paths = uploadResult.files.map(f => f.path).join(', ');
      content = content
        ? content + '\n\n[Uploaded files: ' + paths + ']'
        : '[Uploaded files: ' + paths + ']';
    } catch (err) {
      alert('File upload failed: ' + err.message);
      return;
    }
  }

  const backend = document.getElementById('chat-backend-select')?.value || 'claude-code';
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
            st.activeTools = [];
            st.activeAgents = [];
            st.pendingInteraction = null;
            if (isStillActive) {
              chatUpdateStreamingMessage(st.streamingMsgEl, st.assistantContent, st.assistantThinking);
            }
          } else if (event.type === 'tool_activity') {
            if (event.isAgent) {
              st.activeAgents.push({ subagentType: event.subagentType || 'agent', description: event.description || '' });
            } else if (event.isPlanMode) {
              if (event.planAction === 'enter') st.planModeActive = true;
              else if (event.planAction === 'exit') st.planModeActive = false;
            }
            if (!event.isAgent && !event.isPlanMode) {
              st.activeTools.push({ tool: event.tool, description: event.description || '' });
            }
            // Track pending interactions for restoration on switch-back
            if (event.isPlanMode && event.planAction === 'exit') {
              st.pendingInteraction = { type: 'planApproval' };
            } else if (event.isQuestion) {
              st.pendingInteraction = { type: 'userQuestion', event };
            }
            if (isStillActive) {
              if (event.isPlanMode && event.planAction === 'exit') {
                chatShowPlanApproval(st.streamingMsgEl, targetConvId);
              } else if (event.isQuestion) {
                chatShowUserQuestion(st.streamingMsgEl, targetConvId, event);
              } else {
                chatUpdateStreamingActivity(st.streamingMsgEl, st.activeTools, st.activeAgents, st.planModeActive);
              }
            }
          } else if (event.type === 'assistant_message') {
            // Reset streaming state before re-render so the restored bubble
            // shows typing dots instead of stale content duplicating the
            // completed message that chatRenderMessages is about to display.
            st.assistantContent = '';
            st.assistantThinking = '';
            st.activeTools = [];
            st.activeAgents = [];
            st.planModeActive = false;
            st.pendingInteraction = null;
            if (isStillActive && chatActiveConv) {
              chatActiveConv.messages.push(event.message);
              chatRenderMessages();
              chatUpdateHeader();
            }
            chatLoadConversations();
          } else if (event.type === 'error') {
            st.pendingInteraction = null;
            if (isStillActive) chatAppendError(event.error);
          } else if (event.type === 'done') {
            if (st.streamingMsgEl && st.streamingMsgEl.isConnected) {
              st.streamingMsgEl.remove();
            }
            chatStreamingState.delete(targetConvId);
          }
        } catch {}
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      if (chatActiveConvId === targetConvId) chatAppendError(err.message);
    }
  } finally {
    chatStreamingConvs.delete(targetConvId);
    const finalState = chatStreamingState.get(targetConvId);
    if (finalState && finalState.streamingMsgEl && finalState.streamingMsgEl.isConnected) {
      finalState.streamingMsgEl.remove();
    }
    chatStreamingState.delete(targetConvId);
    chatUpdateSendButtonState();
    chatRenderConvList();
  }
}

function chatAppendStreamingMessage() {
  const container = document.getElementById('chat-messages');
  if (!container) return null;

  const msgEl = document.createElement('div');
  msgEl.className = 'chat-msg assistant streaming';
  msgEl.innerHTML = `
    <div class="chat-msg-wrapper">
      <div class="chat-msg-avatar chat-msg-avatar-svg">${CLAUDE_CODE_ICON}</div>
      <div class="chat-msg-body">
        <div class="chat-msg-role">Assistant</div>
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
      html += `<div class="chat-activity-history-item"><span class="chat-activity-check">✓</span> ${desc}</div>`;
    }
    html += '</div>';
  }

  // Current active tool
  if (tools.length > 0) {
    const current = tools[tools.length - 1];
    const desc = current.description ? escWithCode(current.description) : esc(current.tool || 'Working');
    html += `<div class="chat-activity-indicator">
      <div class="chat-typing"><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div></div>
      <span class="chat-activity-label">${desc}</span>
    </div>`;
  }

  // Agent cards
  if (agents.length > 0) {
    html += '<div class="chat-agent-cards">';
    for (const agent of agents) {
      const agentType = esc(agent.subagentType || 'agent');
      const agentDesc = agent.description ? escWithCode(agent.description) : '';
      html += `<div class="chat-agent-card">
        <div class="chat-agent-spinner"></div>
        <div class="chat-agent-card-header">
          <span class="chat-agent-type">${agentType}</span>
          ${agentDesc ? `<span class="chat-agent-card-desc">${agentDesc}</span>` : ''}
        </div>
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

function chatShowPlanApproval(msgEl, convId) {
  if (!msgEl) return;
  const contentEl = msgEl.querySelector('.chat-msg-content');
  if (!contentEl) return;
  contentEl.innerHTML = `
    <div class="chat-plan-approval">
      <div class="chat-plan-approval-title">Plan ready for review</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">The assistant has prepared a plan and is waiting for your approval.</div>
      <div class="chat-plan-approval-actions">
        <button class="chat-plan-approval-btn approve" data-action="approve">Approve</button>
        <button class="chat-plan-approval-btn reject" data-action="reject">Reject</button>
      </div>
    </div>
  `;
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
        if (approvalState) approvalState.pendingInteraction = null;
        contentEl.innerHTML = `<div style="font-size:12px;color:var(--muted);font-style:italic;">Plan ${action === 'approve' ? 'approved' : 'rejected'}.</div>`;
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
      if (questionState) questionState.pendingInteraction = null;
      contentEl.innerHTML = `<div style="font-size:12px;color:var(--muted);font-style:italic;">Answered: ${esc(text)}</div>`;
    } catch (err) {
      contentEl.innerHTML = `<div style="font-size:12px;color:var(--danger);">Failed to send response: ${esc(err.message)}</div>`;
    }
  };

  chatScrollToBottom();
}

function chatAppendError(errorMsg) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const errEl = document.createElement('div');
  errEl.className = 'chat-msg assistant';
  errEl.innerHTML = `
    <div class="chat-msg-wrapper">
      <div class="chat-msg-avatar" style="background:#fee2e2;color:#dc2626;">!</div>
      <div class="chat-msg-body">
        <div class="chat-msg-role" style="color:#dc2626;">Error</div>
        <div class="chat-msg-content" style="color:#dc2626;">${esc(errorMsg)}</div>
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
  if (chatStreamingConvs.has(chatActiveConvId)) { alert('Cannot reset session while streaming.'); return; }

  try {
    const res = await chatFetch(`conversations/${convId}/reset`, { method: 'POST', body: {} });
    const data = await res.json();
    if (convId === chatActiveConvId) {
      chatActiveConv = data.conversation;
      chatRenderMessages();
    }
  } catch (err) {
    alert('Session reset failed: ' + err.message);
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

function chatViewSession(sessionNumber) {
  if (!chatActiveConv) return;
  chatCloseModal();

  const msgs = chatActiveConv.messages;
  const dividerIndices = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].isSessionDivider) dividerIndices.push(i);
  }

  let start, end;
  if (sessionNumber === 1) {
    start = 0;
    end = dividerIndices.length > 0 ? dividerIndices[0] : msgs.length;
  } else {
    const divIdx = dividerIndices[sessionNumber - 2];
    if (divIdx === undefined) return;
    start = divIdx + 1;
    const nextDiv = dividerIndices[sessionNumber - 1];
    end = nextDiv !== undefined ? nextDiv : msgs.length;
  }

  const sessionMsgs = msgs.slice(start, end);

  let sessionDate = '';
  if (sessionNumber > 1 && dividerIndices[sessionNumber - 2] !== undefined) {
    const divMsg = msgs[dividerIndices[sessionNumber - 2]];
    sessionDate = new Date(divMsg.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } else if (sessionMsgs.length > 0 && sessionMsgs[0].timestamp) {
    sessionDate = new Date(sessionMsgs[0].timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  let msgsHtml = '';
  if (sessionMsgs.length === 0) {
    msgsHtml = '<div style="color:var(--muted);font-size:13px;padding:16px 0;">No messages in this session.</div>';
  } else {
    for (const msg of sessionMsgs) {
      if (msg.isSessionDivider) continue;
      const isUser = msg.role === 'user';
      const isClaudeCode = !isUser && msg.backend === 'claude-code';
      const avatar = isUser ? '👤' : (isClaudeCode ? CLAUDE_CODE_ICON : '⚡');
      const avatarClass = isClaudeCode ? ' chat-msg-avatar-svg' : '';
      const roleLabel = isUser ? 'You' : 'Assistant';
      const backendLabel = msg.backend ? `<span class="chat-msg-model">${esc(typeof CHAT_BACKENDS !== 'undefined' ? (CHAT_BACKENDS.find(b => b.id === msg.backend)?.label || msg.backend) : msg.backend)}</span>` : '';
      const rendered = chatRenderMarkdown(msg.content);
      const thinkingHtml = msg.thinking ? chatRenderThinkingBlock(msg.thinking, false) : '';
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
    chatSettingsData = { theme: 'system', sendBehavior: 'enter', customInstructions: { aboutUser: '', responseStyle: '' }, defaultBackend: 'claude-code' };
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
        <div class="chat-settings-label">What would you like the assistant to know about you?</div>
        <textarea class="chat-settings-textarea" id="chat-settings-about">${esc(s.customInstructions?.aboutUser || '')}</textarea>
      </div>
      <div class="chat-settings-group">
        <div class="chat-settings-label">How would you like the assistant to respond?</div>
        <textarea class="chat-settings-textarea" id="chat-settings-style">${esc(s.customInstructions?.responseStyle || '')}</textarea>
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
    defaultBackend: document.getElementById('chat-settings-backend')?.value || 'claude-code',
    customInstructions: {
      aboutUser: document.getElementById('chat-settings-about')?.value || '',
      responseStyle: document.getElementById('chat-settings-style')?.value || '',
    },
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

