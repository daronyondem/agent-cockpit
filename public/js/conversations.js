import { state, chatFetch, fetchCsrfToken, chatApiUrl, chatSyncQueueToServer, ICON_ARCHIVE, ICON_SETTINGS, ICON_SEND, ICON_STOP, ICON_WORKSPACE, ICON_TOKEN, ICON_USER, ICON_FOLDER } from './state.js';
import { esc, chatFormatFileSize, chatFormatTokenCount, chatFormatCost } from './utils.js';
import { chatRenderMessages, chatRenderMarkdown, chatAutoResize, chatScrollToBottom, chatCloseFileViewer } from './rendering.js';
import { chatShowModal, chatCloseModal } from './modal.js';
import { populateModelSelect } from './backends.js';

// ── File attachment helpers ──────────────────────────────────────────────────

export async function chatEnsureConversation() {
  if (state.chatActiveConvId) return state.chatActiveConvId;
  if (state._ensureConvPromise) return state._ensureConvPromise;
  state._ensureConvPromise = (async () => {
    try {
      const body = state.chatPendingWorkingDir ? { workingDir: state.chatPendingWorkingDir } : {};
      state.chatPendingWorkingDir = null;
      const res = await chatFetch('conversations', { method: 'POST', body });
      const conv = await res.json();
      if (state.chatDraftState.has('__new__')) {
        state.chatDraftState.set(conv.id, state.chatDraftState.get('__new__'));
        state.chatDraftState.delete('__new__');
      }
      state.chatActiveConvId = conv.id;
      state.chatActiveConv = conv;
      chatLoadConversations();
      chatUpdateHeader();
      chatRenderMessages();
      return conv.id;
    } finally {
      state._ensureConvPromise = null;
    }
  })();
  return state._ensureConvPromise;
}

export async function chatUploadSingleFile(convId, entry) {
  if (!state.csrfToken) await fetchCsrfToken();
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    entry.xhr = xhr;
    const formData = new FormData();
    formData.append('files', entry.file);
    xhr.open('POST', chatApiUrl(`conversations/${convId}/upload`));
    xhr.setRequestHeader('x-csrf-token', state.csrfToken || '');
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

export async function chatAddPendingFiles(files) {
  const newEntries = files.map(f => ({ file: f, status: 'uploading', progress: 0, result: null, xhr: null }));
  state.chatPendingFiles.push(...newEntries);
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

export function chatRemovePendingFile(index) {
  const entry = state.chatPendingFiles[index];
  if (!entry) return;
  if (entry.status === 'uploading' && entry.xhr) {
    entry.xhr.abort();
  }
  if (entry.status === 'done' && entry.result && state.chatActiveConvId) {
    chatFetch(`conversations/${state.chatActiveConvId}/upload/${encodeURIComponent(entry.result.name)}`, { method: 'DELETE' }).catch(() => {});
  }
  state.chatPendingFiles.splice(index, 1);
  chatRenderFileChips();
  chatUpdateSendButtonState();
}

export function chatRenderFileChips() {
  const container = document.getElementById('chat-file-chips');
  if (!container) return;
  if (!state.chatPendingFiles.length) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  container.style.display = 'flex';
  container.innerHTML = state.chatPendingFiles.map((entry, i) => {
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

export function chatShowDropOverlay(show) {
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

export async function chatUploadFiles(convId, files) {
  if (!state.csrfToken) await fetchCsrfToken();
  const formData = new FormData();
  files.forEach(f => formData.append('files', f));
  const res = await fetch(chatApiUrl(`conversations/${convId}/upload`), {
    method: 'POST',
    headers: { 'x-csrf-token': state.csrfToken || '' },
    credentials: 'same-origin',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Upload failed');
  }
  return res.json();
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

export function chatToggleSidebar() {
  state.chatSidebarCollapsed = !state.chatSidebarCollapsed;
  const sidebar = document.getElementById('chat-sidebar');
  if (sidebar) sidebar.classList.toggle('collapsed', state.chatSidebarCollapsed);
}

// ── Conversation list ─────────────────────────────────────────────────────────

export async function chatLoadConversations(query) {
  const gen = ++state.chatConvLoadGen;
  try {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (state.chatViewingArchive) params.set('archived', 'true');
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await chatFetch(`conversations${qs}`);
    if (gen !== state.chatConvLoadGen) return;
    const data = await res.json();
    state.chatConversations = data.conversations || [];
    chatRenderConvList();
    if (state.chatActiveConv && state.chatActiveConvId) {
      const match = state.chatConversations.find(c => c.id === state.chatActiveConvId);
      if (match && match.title !== state.chatActiveConv.title) {
        state.chatActiveConv.title = match.title;
        chatUpdateHeader();
      }
    }
  } catch (err) {
    console.error('Failed to load conversations:', err);
  }
}

function chatGroupConversations(convs) {
  const groups = {};
  for (const c of convs) {
    const label = c.workingDir
      ? c.workingDir.split('/').filter(Boolean).slice(-2).join('/')
      : 'workspace';
    if (!groups[label]) {
      groups[label] = {
        fullPath: c.workingDir || '',
        hash: c.workspaceHash || '',
        kbEnabled: false,
        convs: [],
      };
    }
    // Workspace-wide toggle — any conv in this group carries the same
    // flag because it's stored on the workspace index, not per-conv.
    // OR-ing is a safety net in case the server omits it on some rows.
    if (c.workspaceKbEnabled) groups[label].kbEnabled = true;
    groups[label].convs.push(c);
  }
  return groups;
}

export function chatGetCollapsedGroups() {
  try {
    return JSON.parse(localStorage.getItem('chatCollapsedGroups') || '{}');
  } catch { return {}; }
}

export function chatSetGroupCollapsed(label, collapsed) {
  const groups = chatGetCollapsedGroups();
  if (collapsed) groups[label] = true;
  else delete groups[label];
  localStorage.setItem('chatCollapsedGroups', JSON.stringify(groups));
}

export function chatRenderConvList() {
  const list = document.getElementById('chat-conv-list');
  if (!list) return;

  const emptyMsg = state.chatViewingArchive ? 'No archived conversations' : 'No conversations yet';
  if (state.chatConversations.length === 0) {
    list.innerHTML = `<div style="padding:20px;text-align:center;color:var(--muted);font-size:12px;">${emptyMsg}</div>`;
    chatRenderArchiveToggle();
    return;
  }

  const groups = chatGroupConversations(state.chatConversations);
  const collapsed = chatGetCollapsedGroups();
  let html = '';
  for (const [label, group] of Object.entries(groups)) {
    const isCollapsed = !!collapsed[label];
    const count = group.convs.length;
    html += `
      <div class="chat-conv-group-header" data-group="${esc(label)}" title="${esc(group.fullPath || 'Default workspace')}">
        <svg class="chat-conv-group-chevron${isCollapsed ? ' collapsed' : ''}" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.5 6L8 9.5L11.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="chat-conv-group-label">${esc(label)}</span>
        ${isCollapsed ? `<span class="chat-conv-group-count">${count}</span>` : ''}
        ${group.hash && group.kbEnabled ? `<button class="chat-conv-group-kb-btn" data-kb-hash="${esc(group.hash)}" data-kb-label="${esc(label)}" title="Open Knowledge Base"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 3.5C3 2.67 3.67 2 4.5 2H12v11H4.5C3.67 13 3 12.33 3 11.5v-8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M3 11.5c0-.83.67-1.5 1.5-1.5H12" stroke="currentColor" stroke-width="1.3"/><path d="M6 5h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>` : ''}
        ${group.hash ? `<button class="chat-conv-group-explorer-btn" data-fe-hash="${esc(group.hash)}" data-fe-label="${esc(label)}" title="Open file explorer">${ICON_FOLDER}</button>` : ''}
        ${group.hash ? `<button class="chat-conv-group-instructions-btn" data-ws-hash="${esc(group.hash)}" data-ws-label="${esc(label)}" title="Workspace settings">${ICON_SETTINGS}</button>` : ''}
      </div>`;
    if (!isCollapsed) {
      for (const c of group.convs) {
        const isActive = c.id === state.chatActiveConvId;
        const isStreaming = state.chatStreamingConvs.has(c.id);
        html += `
          <div class="chat-conv-item${isActive ? ' active' : ''}" data-conv-id="${esc(c.id)}">
            <div style="flex:1;min-width:0;">
              <span class="chat-conv-item-title">${esc(c.title)}</span>
            </div>
            ${isStreaming ? '<span class="chat-conv-streaming-dot"></span>' : ''}
            <button class="chat-conv-item-menu" data-conv-menu="${esc(c.id)}" title="Options">\u22EF</button>
          </div>
        `;
      }
    }
  }
  list.innerHTML = html;
  chatRenderArchiveToggle();
}

function chatRenderArchiveToggle() {
  const sidebar = document.getElementById('chat-sidebar');
  if (!sidebar) return;
  let toggle = sidebar.querySelector('.chat-archive-toggle');
  if (!toggle) {
    toggle = document.createElement('button');
    toggle.className = 'chat-archive-toggle';
    toggle.addEventListener('click', chatToggleArchiveView);
    const settingsBtn = document.getElementById('chat-settings-btn');
    if (settingsBtn) {
      sidebar.insertBefore(toggle, settingsBtn);
    } else {
      sidebar.appendChild(toggle);
    }
  }
  if (state.chatViewingArchive) {
    toggle.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 12L2 8l4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 8h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> Back to conversations';
  } else {
    toggle.innerHTML = `${ICON_ARCHIVE} Archive`;
  }
}

export function chatToggleArchiveView() {
  state.chatViewingArchive = !state.chatViewingArchive;
  if (state.chatViewingArchive) {
    state.chatActiveConvId = null;
    state.chatActiveConv = null;
    chatRenderMessages();
    chatUpdateHeader();
  }
  chatLoadConversations();
}

// ── Conversation operations ───────────────────────────────────────────────────

export async function chatNewConversation() {
  if (state.chatViewingArchive) {
    state.chatViewingArchive = false;
    chatLoadConversations();
  }
  chatShowFolderPicker();
}

export async function chatCreateConversationWithDir(workingDir) {
  try {
    chatSaveDraft();
    for (const entry of state.chatPendingFiles) {
      if (entry.status === 'uploading' && entry.xhr) entry.xhr.abort();
    }
    const body = workingDir ? { workingDir } : {};
    if (state.chatSettingsData?.defaultBackend) {
      body.backend = state.chatSettingsData.defaultBackend;
    }
    const res = await chatFetch('conversations', { method: 'POST', body });
    const conv = await res.json();
    state.chatActiveConvId = conv.id;
    state.chatActiveConv = conv;
    await chatLoadConversations();
    chatRenderMessages();
    chatUpdateHeader();
    chatRestoreDraft(conv.id);
    chatCloseModal();
    const backendSelect = document.getElementById('chat-backend-select');
    if (backendSelect && conv.backend) {
      backendSelect.value = conv.backend;
    }
    populateModelSelect(state.chatSettingsData?.defaultModel, state.chatSettingsData?.defaultEffort);
    const textarea = document.getElementById('chat-textarea');
    if (textarea) textarea.focus();
  } catch (err) {
    alert('Failed to create conversation: ' + err.message);
  }
}

export async function chatShowFolderPicker(initialPath) {
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
        pathEl.textContent = '\u26A0\uFE0F ' + (err.message || 'Cannot access folder');
        pathEl.style.color = 'var(--blocked, #dc2626)';
        setTimeout(() => { pathEl.textContent = origText; pathEl.style.color = ''; }, 2000);
      }
    }
  }

  function renderFolderBrowser(data) {
    const folderName = data.currentPath.split('/').pop() || data.currentPath;
    let listHtml = '';
    if (data.parent) {
      listHtml += `<div class="folder-browser-item parent-item" data-path="${esc(data.parent)}">\u2191 Parent Directory</div>`;
    }
    if (data.dirs.length === 0) {
      listHtml += '<div style="padding:12px;color:var(--muted);font-size:12px;text-align:center;">No subdirectories</div>';
    }
    for (const d of data.dirs) {
      const full = data.currentPath + '/' + d;
      listHtml += `<div class="folder-browser-item" data-path="${esc(full)}">\u{1F4C1} ${esc(d)}</div>`;
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

    document.getElementById('folder-browser-list').querySelectorAll('.folder-browser-item').forEach(el => {
      el.addEventListener('click', () => loadDir(el.dataset.path));
    });
    document.getElementById('folder-show-hidden').onchange = (e) => {
      showHidden = e.target.checked;
      loadDir(data.currentPath);
    };
    document.getElementById('folder-select-this').onclick = () => chatCreateConversationWithDir(data.currentPath);
    document.getElementById('folder-use-default').onclick = () => chatCreateConversationWithDir(null);

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
          pathEl.textContent = '\u26A0\uFE0F ' + (err.message || 'Failed to create folder');
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

    const goParentBtn = document.getElementById('folder-go-parent');
    if (goParentBtn) goParentBtn.onclick = () => loadDir(data.parent);

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
              pathEl.textContent = '\u26A0\uFE0F ' + (err.message || 'Failed to delete folder');
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

// ── Send button state ────────────────────────────────────────────────────────

export function chatUpdateSendButtonState() {
  const sendBtn = document.getElementById('chat-send-btn');
  if (!sendBtn) return;
  const isStreaming = state.chatStreamingConvs.has(state.chatActiveConvId);
  const isResetting = state.chatResettingConvs.has(state.chatActiveConvId);
  const ta = document.getElementById('chat-textarea');
  const hasText = ta && ta.value.trim();
  if (isStreaming) {
    if (hasText) {
      sendBtn.disabled = false;
      sendBtn.innerHTML = ICON_SEND;
      sendBtn.classList.remove('stop');
      sendBtn.title = 'Queue message (Enter)';
    } else {
      sendBtn.disabled = false;
      sendBtn.innerHTML = ICON_STOP;
      sendBtn.classList.add('stop');
      sendBtn.title = 'Stop streaming';
    }
  } else {
    sendBtn.innerHTML = ICON_SEND;
    sendBtn.classList.remove('stop');
    sendBtn.title = 'Send message (Enter)';
    const hasCompletedFiles = state.chatPendingFiles.some(e => e.status === 'done');
    const hasUploading = state.chatPendingFiles.some(e => e.status === 'uploading');
    sendBtn.disabled = isResetting || hasUploading || (!hasText && !hasCompletedFiles);
  }
}

// ── Draft management ─────────────────────────────────────────────────────────

export function chatSaveDraft() {
  const key = state.chatActiveConvId || '__new__';
  const textarea = document.getElementById('chat-textarea');
  const text = textarea ? textarea.value : '';
  if (!text && !state.chatPendingFiles.length) {
    state.chatDraftState.delete(key);
    return;
  }
  state.chatDraftState.set(key, { text, pendingFiles: state.chatPendingFiles });
}

export function chatRestoreDraft(convId) {
  const key = convId || '__new__';
  const draft = state.chatDraftState.get(key);
  const textarea = document.getElementById('chat-textarea');
  if (draft) {
    if (textarea) {
      textarea.value = draft.text;
      chatAutoResize(textarea);
    }
    state.chatPendingFiles = draft.pendingFiles;
  } else {
    if (textarea) {
      textarea.value = '';
      chatAutoResize(textarea);
    }
    state.chatPendingFiles = [];
  }
  chatRenderFileChips();
  chatUpdateSendButtonState();
}

// ── Conversation management ──────────────────────────────────────────────────

export async function chatSelectConversation(id) {
  if (id === state.chatActiveConvId) return;
  chatCloseFileViewer();
  chatSaveDraft();
  for (const entry of state.chatPendingFiles) {
    if (entry.status === 'uploading' && entry.xhr) entry.xhr.abort();
  }
  try {
    const res = await chatFetch(`conversations/${id}`);
    state.chatActiveConv = await res.json();
    state.chatActiveConvId = id;

    // Restore persisted queue if present and no active stream
    if (state.chatActiveConv.messageQueue && state.chatActiveConv.messageQueue.length > 0
        && !state.chatStreamingConvs.has(id) && !state.chatMessageQueue.has(id)) {
      const restored = state.chatActiveConv.messageQueue.map(content => ({
        id: ++state.chatQueueIdCounter,
        content,
        inFlight: false,
      }));
      state.chatMessageQueue.set(id, restored);
      state.chatQueueSuspended.add(id);
    }

    chatRenderConvList();
    chatRenderMessages();
    chatRenderQueuedMessages();
    chatUpdateHeader();
    chatRestoreDraft(id);
    const resetBtn = document.getElementById('chat-reset-btn');
    if (resetBtn) {
      resetBtn.disabled = state.chatResettingConvs.has(id);
      resetBtn.textContent = state.chatResettingConvs.has(id) ? '\u21BB Resetting...' : '\u21BB Reset';
    }
    const backendSelect = document.getElementById('chat-backend-select');
    if (backendSelect && state.chatActiveConv.backend) {
      backendSelect.value = state.chatActiveConv.backend;
    }
    populateModelSelect(state.chatActiveConv.model, state.chatActiveConv.effort);
    // Update the dreaming banner based on the freshly-loaded kb block.
    if (typeof window.chatUpdateDreamBanner === 'function') window.chatUpdateDreamBanner();
  } catch (err) {
    alert('Failed to load conversation: ' + err.message);
  }
}

export async function chatRenameConversation(id) {
  const conv = state.chatConversations.find(c => c.id === id);
  const newTitle = prompt('Rename conversation:', conv ? conv.title : '');
  if (!newTitle || !newTitle.trim()) return;
  try {
    await chatFetch(`conversations/${id}`, { method: 'PUT', body: { title: newTitle.trim() } });
    if (state.chatActiveConvId === id && state.chatActiveConv) state.chatActiveConv.title = newTitle.trim();
    chatUpdateHeader();
    chatLoadConversations();
  } catch (err) {
    alert('Failed to rename: ' + err.message);
  }
}

export async function chatDeleteConversation(id) {
  if (!confirm('Delete this conversation? This cannot be undone.')) return;
  try {
    await chatFetch(`conversations/${id}`, { method: 'DELETE' });
    state.chatDraftState.delete(id);
    if (state.chatActiveConvId === id) {
      for (const entry of state.chatPendingFiles) {
        if (entry.status === 'uploading' && entry.xhr) entry.xhr.abort();
      }
      state.chatPendingFiles = [];
      chatRenderFileChips();
      state.chatActiveConvId = null;
      state.chatActiveConv = null;
      chatRenderMessages();
      chatUpdateHeader();
      chatUpdateSendButtonState();
    }
    chatLoadConversations();
  } catch (err) {
    alert('Failed to delete: ' + err.message);
  }
}

export async function chatArchiveConversation(id) {
  try {
    await chatFetch(`conversations/${id}/archive`, { method: 'PATCH' });
    state.chatDraftState.delete(id);
    if (state.chatActiveConvId === id) {
      for (const entry of state.chatPendingFiles) {
        if (entry.status === 'uploading' && entry.xhr) entry.xhr.abort();
      }
      state.chatPendingFiles = [];
      chatRenderFileChips();
      state.chatActiveConvId = null;
      state.chatActiveConv = null;
      chatRenderMessages();
      chatUpdateHeader();
      chatUpdateSendButtonState();
    }
    chatLoadConversations();
  } catch (err) {
    alert('Failed to archive: ' + err.message);
  }
}

export async function chatRestoreConversation(id) {
  try {
    await chatFetch(`conversations/${id}/restore`, { method: 'PATCH' });
    chatLoadConversations();
  } catch (err) {
    alert('Failed to restore: ' + err.message);
  }
}

// ── Header / usage display ───────────────────────────────────────────────────

export function chatUpdateHeader() {
  const titleEl = document.getElementById('chat-header-title');
  if (titleEl) {
    titleEl.textContent = state.chatActiveConv ? state.chatActiveConv.title : 'New Chat';
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
    if (state.chatActiveConv && state.chatActiveConv.workingDir) {
      const folderName = state.chatActiveConv.workingDir.split('/').filter(Boolean).slice(-2).join('/') || state.chatActiveConv.workingDir;
      wdEl.innerHTML = ICON_WORKSPACE + ' ' + esc(folderName);
      wdEl.title = state.chatActiveConv.workingDir;
      wdEl.style.display = '';
    } else if (state.chatActiveConv) {
      wdEl.innerHTML = ICON_WORKSPACE + ' workspace';
      wdEl.title = 'Default workspace';
      wdEl.style.display = '';
    } else {
      wdEl.style.display = 'none';
    }
  }
  chatUpdateUsageDisplay();
}

export function chatUpdateUsageDisplay() {
  let el = document.getElementById('chat-header-usage');
  const convUsage = state.chatActiveConv?.usage;
  const sessUsage = state.chatActiveConv?.sessionUsage;
  const isKiro = state.chatActiveConv?.backend === 'kiro';

  // Kiro: check for credits; others: check for tokens/cost
  const hasUsage = isKiro
    ? (sessUsage?.credits > 0 || convUsage?.credits > 0 || sessUsage?.contextUsagePercentage > 0 || convUsage?.contextUsagePercentage > 0)
    : ((sessUsage && (sessUsage.inputTokens > 0 || sessUsage.outputTokens > 0 || sessUsage.costUsd > 0))
      || (convUsage && (convUsage.inputTokens > 0 || convUsage.outputTokens > 0 || convUsage.costUsd > 0)));

  if (!hasUsage) {
    if (el) el.style.display = 'none';
    return;
  }

  if (!el) {
    const actions = document.querySelector('.chat-header-actions');
    if (!actions) return;
    el = document.createElement('div');
    el.className = 'chat-header-usage';
    el.id = 'chat-header-usage';
    actions.parentElement.insertBefore(el, actions);
  }

  const displayUsage = sessUsage || convUsage;

  if (isKiro) {
    // ── Kiro: show credits + context usage ──
    const credits = displayUsage.credits || 0;
    const contextPct = displayUsage.contextUsagePercentage || 0;
    const creditsStr = credits < 0.01 && credits > 0 ? credits.toFixed(4) : credits < 1 ? credits.toFixed(3) : credits.toFixed(2);
    const contextStr = contextPct.toFixed(2);

    let tooltipLines = ['\u2500\u2500 Session \u2500\u2500'];
    tooltipLines.push(`Credits: ${creditsStr}`);
    tooltipLines.push(`Context: ${contextStr}%`);

    if (convUsage && convUsage !== displayUsage && convUsage.credits > 0) {
      tooltipLines.push('');
      tooltipLines.push('\u2500\u2500 Conversation \u2500\u2500');
      const convCredits = convUsage.credits || 0;
      tooltipLines.push(`Credits: ${convCredits < 1 ? convCredits.toFixed(3) : convCredits.toFixed(2)}`);
    }

    el.title = tooltipLines.join('\n');
    el.innerHTML = `<span class="chat-usage-tokens">${ICON_TOKEN} ${creditsStr}</span>`
      + (contextPct > 0 ? `<span class="chat-usage-cost">${contextStr}% context</span>` : '');
    el.style.display = '';
    return;
  }

  // ── Token-based backends (Claude Code, etc.) ──
  const sessionTokens = (displayUsage.inputTokens || 0) + (displayUsage.outputTokens || 0);

  let tooltipLines = ['\u2500\u2500 Session \u2500\u2500'];
  tooltipLines.push(`Input: ${chatFormatTokenCount(displayUsage.inputTokens)} tokens`);
  tooltipLines.push(`Output: ${chatFormatTokenCount(displayUsage.outputTokens)} tokens`);
  const sessCacheTokens = (displayUsage.cacheReadTokens || 0) + (displayUsage.cacheWriteTokens || 0);
  if (sessCacheTokens > 0) {
    tooltipLines.push(`Cache read: ${chatFormatTokenCount(displayUsage.cacheReadTokens)}`);
    tooltipLines.push(`Cache write: ${chatFormatTokenCount(displayUsage.cacheWriteTokens)}`);
  }
  if (displayUsage.costUsd > 0) {
    tooltipLines.push(`Cost: ${chatFormatCost(displayUsage.costUsd)}`);
  }

  if (convUsage && convUsage !== displayUsage) {
    const convTotal = (convUsage.inputTokens || 0) + (convUsage.outputTokens || 0);
    if (convTotal > 0) {
      tooltipLines.push('');
      tooltipLines.push('\u2500\u2500 Conversation \u2500\u2500');
      tooltipLines.push(`Total: ${chatFormatTokenCount(convTotal)} tokens`);
      if (convUsage.costUsd > 0) {
        tooltipLines.push(`Cost: ${chatFormatCost(convUsage.costUsd)}`);
      }
    }
  }

  el.title = tooltipLines.join('\n');
  el.innerHTML = `<span class="chat-usage-tokens">${ICON_TOKEN} ${chatFormatTokenCount(sessionTokens)}</span>`
    + (displayUsage.costUsd > 0 ? `<span class="chat-usage-cost">${chatFormatCost(displayUsage.costUsd)}</span>` : '');
  el.style.display = '';
}

// ── Context menu ──────────────────────────────────────────────────────────────

export function chatShowContextMenu(e, convId) {
  chatCloseContextMenu();
  const menu = document.createElement('div');
  menu.className = 'chat-context-menu';
  if (state.chatViewingArchive) {
    menu.innerHTML = `
      <button class="chat-context-menu-item" data-action="restore">Restore</button>
      <button class="chat-context-menu-item danger" data-action="delete">Delete</button>
    `;
  } else {
    menu.innerHTML = `
      <button class="chat-context-menu-item" data-action="rename">Rename</button>
      <button class="chat-context-menu-item" data-action="archive">Archive</button>
      <button class="chat-context-menu-item danger" data-action="delete">Delete</button>
    `;
  }
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  menu.querySelectorAll('.chat-context-menu-item').forEach(item => {
    item.onclick = () => {
      chatCloseContextMenu();
      if (item.dataset.action === 'rename') chatRenameConversation(convId);
      else if (item.dataset.action === 'delete') chatDeleteConversation(convId);
      else if (item.dataset.action === 'archive') chatArchiveConversation(convId);
      else if (item.dataset.action === 'restore') chatRestoreConversation(convId);
    };
  });

  document.body.appendChild(menu);
  state.chatContextMenuEl = menu;

  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
  });
}

export function chatCloseContextMenu() {
  if (state.chatContextMenuEl) {
    state.chatContextMenuEl.remove();
    state.chatContextMenuEl = null;
  }
}

// ── Message Queue UI ─────────────────────────────────────────────────────────

export function chatRenderQueuedMessages() {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  container.querySelectorAll('.chat-msg-queued').forEach(el => el.remove());
  container.querySelectorAll('.chat-queue-paused-banner').forEach(el => el.remove());
  container.querySelectorAll('.chat-queue-suspended-banner').forEach(el => el.remove());

  const convId = state.chatActiveConvId;
  if (!convId) return;
  const queue = state.chatMessageQueue.get(convId);
  if (!queue || queue.length === 0) return;

  if (state.chatQueueSuspended.has(convId)) {
    const bannerEl = document.createElement('div');
    bannerEl.className = 'chat-queue-suspended-banner';
    bannerEl.innerHTML = `
      <span>${queue.length} queued message${queue.length !== 1 ? 's' : ''} from a previous session</span>
      <button class="chat-queue-resume-btn" onclick="chatResumeSuspendedQueue()">Resume</button>
      <button class="chat-queue-clear-btn" onclick="chatClearQueue()">Clear</button>
    `;
    container.appendChild(bannerEl);
  } else if (state.chatQueuePaused.has(convId)) {
    const bannerEl = document.createElement('div');
    bannerEl.className = 'chat-queue-paused-banner';
    bannerEl.innerHTML = `
      <span>Queue paused due to error.</span>
      <button class="chat-queue-resume-btn" onclick="chatResumeQueue()">Resume queue</button>
      <button class="chat-queue-clear-btn" onclick="chatClearQueue()">Clear queue</button>
    `;
    container.appendChild(bannerEl);
  }

  for (const item of queue) {
    const el = document.createElement('div');
    el.className = 'chat-msg user chat-msg-queued' + (item.inFlight ? ' chat-msg-in-flight' : '');
    el.dataset.queueId = item.id;
    const rendered = chatRenderMarkdown(item.content);
    el.innerHTML = `
      <div class="chat-msg-wrapper">
        <div class="chat-msg-avatar chat-msg-avatar-svg">${ICON_USER}</div>
        <div class="chat-msg-body">
          <div class="chat-msg-role">You <span class="chat-queue-badge">${item.inFlight ? 'Sending...' : 'Queued'}</span></div>
          <div class="chat-msg-content chat-queued-content">${rendered}</div>
          ${!item.inFlight ? `<div class="chat-msg-actions chat-queue-actions" style="opacity:1;">
            <button class="chat-msg-action" data-action="edit-queued" data-queue-id="${item.id}" title="Edit">Edit</button>
            <button class="chat-msg-action" data-action="delete-queued" data-queue-id="${item.id}" title="Delete">Delete</button>
          </div>` : ''}
        </div>
      </div>
    `;
    container.appendChild(el);
  }

  container.querySelectorAll('[data-action="delete-queued"]').forEach(btn => {
    btn.onclick = () => chatDeleteQueuedMessage(Number(btn.dataset.queueId));
  });
  container.querySelectorAll('[data-action="edit-queued"]').forEach(btn => {
    btn.onclick = () => chatEditQueuedMessage(Number(btn.dataset.queueId));
  });
}

export function chatDeleteQueuedMessage(queueId) {
  const convId = state.chatActiveConvId;
  if (!convId) return;
  const queue = state.chatMessageQueue.get(convId);
  if (!queue) return;
  const idx = queue.findIndex(item => item.id === queueId);
  if (idx === -1 || queue[idx].inFlight) return;
  queue.splice(idx, 1);
  if (queue.length === 0) {
    state.chatMessageQueue.delete(convId);
    state.chatQueuePaused.delete(convId);
    state.chatQueueSuspended.delete(convId);
  }
  chatRenderQueuedMessages();
  chatUpdateSendButtonState();
  chatSyncQueueToServer(convId);
}

export function chatEditQueuedMessage(queueId) {
  const convId = state.chatActiveConvId;
  if (!convId) return;
  const queue = state.chatMessageQueue.get(convId);
  if (!queue) return;
  const item = queue.find(i => i.id === queueId);
  if (!item || item.inFlight) return;

  const container = document.getElementById('chat-messages');
  if (!container) return;
  const msgEl = container.querySelector(`.chat-msg-queued[data-queue-id="${queueId}"]`);
  if (!msgEl) return;

  const contentEl = msgEl.querySelector('.chat-queued-content');
  const actionsEl = msgEl.querySelector('.chat-queue-actions');
  if (!contentEl) return;

  const editArea = document.createElement('textarea');
  editArea.className = 'chat-queue-edit-textarea';
  editArea.value = item.content;
  editArea.rows = Math.max(2, item.content.split('\n').length);

  const editActions = document.createElement('div');
  editActions.className = 'chat-queue-edit-actions';
  editActions.innerHTML = `
    <button class="chat-queue-edit-save">Save</button>
    <button class="chat-queue-edit-cancel">Cancel</button>
  `;

  contentEl.replaceWith(editArea);
  if (actionsEl) actionsEl.style.display = 'none';
  editArea.parentElement.appendChild(editActions);
  editArea.focus();
  editArea.setSelectionRange(editArea.value.length, editArea.value.length);

  editActions.querySelector('.chat-queue-edit-save').onclick = () => {
    const newContent = editArea.value.trim();
    if (newContent) {
      item.content = newContent;
    }
    chatRenderQueuedMessages();
    chatSyncQueueToServer(convId);
  };

  editActions.querySelector('.chat-queue-edit-cancel').onclick = () => {
    chatRenderQueuedMessages();
  };

  editArea.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      editActions.querySelector('.chat-queue-edit-save').click();
    } else if (e.key === 'Escape') {
      editActions.querySelector('.chat-queue-edit-cancel').click();
    }
  };
}
