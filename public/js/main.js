import { state, chatFetch, apiUrl, DEFAULT_BACKEND_ICON } from './state.js';
import { esc, chatFormatTokenCount, chatFormatCost } from './utils.js';
import { applyTheme } from './theme.js';
import { chatShowModal, chatCloseModal } from './modal.js';
import { loadBackends, getBackendIcon, getBackendCapabilities, populateModelSelect } from './backends.js';
import { setStreamEventHandler } from './websocket.js';
import {
  chatRenderMessages, chatAutoResize, chatRenderMarkdown, chatHighlightCode,
  chatScrollToBottom, chatOpenLightbox, chatCloseLightbox, chatCopyCode,
  chatToggleCodeBlock, chatRenderThinkingBlock, chatRenderToolActivityBlock,
  setRenderingCallbacks,
} from './rendering.js';
import {
  chatLoadConversations, chatRenderConvList, chatNewConversation, chatToggleSidebar,
  chatSelectConversation, chatShowContextMenu, chatCloseContextMenu,
  chatSetGroupCollapsed, chatGetCollapsedGroups,
  chatAddPendingFiles, chatShowDropOverlay, chatShowFolderPicker,
  chatUpdateSendButtonState, chatSaveDraft, chatRenderFileChips,
  chatUpdateHeader, chatUpdateUsageDisplay,
  chatRenderQueuedMessages, chatDeleteQueuedMessage, chatEditQueuedMessage,
} from './conversations.js';
import {
  chatSendMessage, chatStopStreaming, chatRetryLast,
  chatResumeQueue, chatResumeSuspendedQueue, chatClearQueue, chatHandleStreamEvent,
  chatShowPlanApproval, chatShowUserQuestion,
} from './streaming.js';

// ── Wire late-binding callbacks ──────────────────────────────────────────────

setStreamEventHandler(chatHandleStreamEvent);
setRenderingCallbacks({
  sendMessage: chatSendMessage,
  renderQueuedMessages: chatRenderQueuedMessages,
  showPlanApproval: chatShowPlanApproval,
  showUserQuestion: chatShowUserQuestion,
});

// ── Window globals for inline onclick ────────────────────────────────────────

window.chatCopyCode = chatCopyCode;
window.chatToggleCodeBlock = chatToggleCodeBlock;
window.chatOpenLightbox = chatOpenLightbox;
window.chatCloseLightbox = chatCloseLightbox;
window.chatResumeQueue = chatResumeQueue;
window.chatResumeSuspendedQueue = chatResumeSuspendedQueue;
window.chatClearQueue = chatClearQueue;
window.chatRetryLast = chatRetryLast;
window.chatSaveSettings = chatSaveSettings;
window.chatSettingsBackendChanged = chatSettingsBackendChanged;
window.chatUpdateUsageStats = chatUpdateUsageStats;
window.chatClearUsageStats = chatClearUsageStats;
window.chatSaveWorkspaceInstructions = chatSaveWorkspaceInstructions;
window.chatCloseModal = chatCloseModal;
window.chatShowFolderPicker = chatShowFolderPicker;
window.chatViewSession = chatViewSession;

// ── Initialization ───────────────────────────────────────────────────────────

function chatInit() {
  if (state.chatInitialized && state.chatActiveConvId) {
    chatRenderConvList();
    if (state.chatActiveConv) chatRenderMessages();
    chatWireEvents();
    return;
  }
  state.chatInitialized = true;
  chatWireEvents();
  loadBackends();
  chatLoadConversations();

  chatFetch('version').then(res => res.json()).then(v => {
    const textEl = document.getElementById('chat-version-text');
    if (textEl && v.version) textEl.textContent = 'v' + v.version;
    chatCheckUpdateIndicator(v);
  }).catch(() => {});

  const versionLabel = document.getElementById('chat-version-text');
  if (versionLabel) {
    versionLabel.style.cursor = 'pointer';
    versionLabel.title = 'Click to check for updates';
    versionLabel.addEventListener('click', chatManualVersionCheck);
  }

  setInterval(() => {
    chatFetch('update-status').then(res => res.json()).then(chatCheckUpdateIndicator).catch(() => {});
  }, 5 * 60 * 1000);

  chatFetch('settings').then(res => res.json()).then(s => {
    state.chatSettingsData = s;
    applyTheme(s.theme || 'system');
    if (s.defaultModel) populateModelSelect(s.defaultModel);
  }).catch(() => {});
}

// ── Event wiring ─────────────────────────────────────────────────────────────

function chatWireEvents() {
  const convList = document.getElementById('chat-conv-list');
  if (convList && !convList._delegated) {
    convList._delegated = true;
    convList.addEventListener('click', (e) => {
      const instrBtn = e.target.closest('.chat-conv-group-instructions-btn');
      if (instrBtn) {
        e.stopPropagation();
        chatShowWorkspaceInstructions(instrBtn.dataset.wsHash, instrBtn.dataset.wsLabel);
        return;
      }
      const groupHeader = e.target.closest('.chat-conv-group-header');
      if (groupHeader) {
        const grp = groupHeader.dataset.group;
        const isNowCollapsed = !chatGetCollapsedGroups()[grp];
        chatSetGroupCollapsed(grp, isNowCollapsed);
        chatRenderConvList();
        return;
      }
      const menuBtn = e.target.closest('.chat-conv-item-menu');
      if (menuBtn) {
        e.stopPropagation();
        chatShowContextMenu(e, menuBtn.dataset.convMenu);
        return;
      }
      const convItem = e.target.closest('.chat-conv-item');
      if (convItem) {
        chatSelectConversation(convItem.dataset.convId);
        return;
      }
    });
  }

  const newBtn = document.getElementById('chat-new-btn');
  if (newBtn) newBtn.onclick = chatNewConversation;

  const collapseBtn = document.getElementById('chat-sidebar-collapse');
  if (collapseBtn) collapseBtn.onclick = () => chatToggleSidebar();

  const toggleBtn = document.getElementById('chat-header-toggle');
  if (toggleBtn) toggleBtn.onclick = () => chatToggleSidebar();

  const backendSel = document.getElementById('chat-backend-select');
  if (backendSel && !backendSel._modelWired) {
    backendSel._modelWired = true;
    backendSel.addEventListener('change', () => {
      populateModelSelect();
    });
  }

  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) sendBtn.onclick = () => {
    const ta = document.getElementById('chat-textarea');
    const hasInput = ta && ta.value.trim();
    if (state.chatStreamingConvs.has(state.chatActiveConvId) && !hasInput) chatStopStreaming();
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
        const hasUploading = state.chatPendingFiles.some(entry => entry.status === 'uploading');
        if (!hasUploading && (textarea.value.trim() || state.chatPendingFiles.some(entry => entry.status === 'done'))) {
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
      clearTimeout(state.chatSearchTimeout);
      state.chatSearchTimeout = setTimeout(() => chatLoadConversations(searchInput.value), 300);
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

  document.addEventListener('click', chatCloseContextMenu);

  // Lightbox — converted from inline onclick in index.html
  const lightbox = document.getElementById('chat-lightbox');
  if (lightbox) lightbox.addEventListener('click', chatCloseLightbox);
  const lightboxImg = document.getElementById('chat-lightbox-img');
  if (lightboxImg) lightboxImg.addEventListener('click', e => e.stopPropagation());
}

// ── Session management ───────────────────────────────────────────────────────

async function chatResetSession(convIdOverride) {
  const convId = typeof convIdOverride === 'string' ? convIdOverride : state.chatActiveConvId;
  if (!convId) return;
  if (state.chatStreamingConvs.has(convId)) { alert('Cannot reset session while streaming.'); return; }
  if (state.chatResettingConvs.has(convId)) return;

  state.chatResettingConvs.add(convId);
  chatUpdateSendButtonState();

  const resetBtn = document.getElementById('chat-reset-btn');
  if (resetBtn) { resetBtn.disabled = true; resetBtn.textContent = '\u21BB Resetting...'; }

  let progressEl = null;
  if (convId === state.chatActiveConvId) {
    const container = document.getElementById('chat-messages');
    if (container) {
      progressEl = document.createElement('div');
      progressEl.className = 'chat-msg assistant';
      progressEl.id = 'chat-reset-progress';
      progressEl.innerHTML = `
        <div class="chat-msg-wrapper">
          <div class="chat-msg-avatar chat-msg-avatar-svg">${getBackendIcon(state.chatActiveConv?.backend || 'claude-code')}</div>
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
    if (convId === state.chatActiveConvId) {
      state.chatActiveConv = data.conversation;
      chatRenderMessages();
      chatUpdateHeader();
    }
    chatLoadConversations();
  } catch (err) {
    if (progressEl && progressEl.isConnected) progressEl.remove();
    alert('Session reset failed: ' + err.message);
  } finally {
    state.chatResettingConvs.delete(convId);
    const leftover = document.getElementById('chat-reset-progress');
    if (leftover) leftover.remove();
    if (resetBtn) { resetBtn.disabled = false; resetBtn.textContent = '\u21BB Reset'; }
    chatUpdateSendButtonState();
  }
}

async function chatShowSessions() {
  if (!state.chatActiveConvId) return;
  try {
    const res = await chatFetch(`conversations/${state.chatActiveConvId}/sessions`);
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
              Started: ${esc(started)}${ended ? ` \u2014 Ended: ${esc(ended)}` : ''}
              \u00b7 ${s.messageCount} messages
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
        window.open(apiUrl(`chat/conversations/${state.chatActiveConvId}/sessions/${btn.dataset.session}/download`), '_blank');
      });
    });
  } catch (err) {
    alert('Failed to load sessions: ' + err.message);
  }
}

function chatViewSession(sessionNumber) {
  if (!state.chatActiveConv) return;
  chatCloseModal();

  (async () => {
    let sessionMsgs;
    try {
      if (sessionNumber === state.chatActiveConv.sessionNumber) {
        sessionMsgs = state.chatActiveConv.messages;
      } else {
        const res = await chatFetch(`conversations/${state.chatActiveConvId}/sessions/${sessionNumber}/messages`);
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
        const avatar = isUser ? '\u{1F464}' : (backendIcon || DEFAULT_BACKEND_ICON);
        const avatarClass = !isUser && backendIcon ? ' chat-msg-avatar-svg' : '';
        const roleLabel = isUser ? 'You' : 'Assistant';
        const backendLabel = msg.backend ? `<span class="chat-msg-model">${esc(state.CHAT_BACKENDS.find(b => b.id === msg.backend)?.label || msg.backend)}</span>` : '';
        const rendered = chatRenderMarkdown(msg.content);
        const caps = msg.backend ? getBackendCapabilities(msg.backend) : {};
        const thinkingHtml = msg.thinking && caps.thinking !== false ? chatRenderThinkingBlock(msg.thinking, false) : '';
        const toolActivityHtml = !isUser && msg.toolActivity ? chatRenderToolActivityBlock(msg.toolActivity) : '';
        msgsHtml += `
          <div class="chat-msg ${esc(msg.role)}">
            <div class="chat-msg-wrapper">
              <div class="chat-msg-avatar${avatarClass}">${avatar}</div>
              <div class="chat-msg-body">
                <div class="chat-msg-role">${roleLabel} ${backendLabel}</div>
                <div class="chat-msg-content">${thinkingHtml}${toolActivityHtml}${rendered}</div>
              </div>
            </div>
          </div>
        `;
      }
    }

    const title = `Session ${sessionNumber}` + (sessionDate ? ` \u2014 ${sessionDate}` : '');
    const html = `
      <div class="chat-modal-body" style="padding:0;">
        <div style="padding:8px 16px;border-bottom:1px solid var(--border);">
          <button class="chat-header-btn" id="chat-back-to-sessions" style="font-size:12px;cursor:pointer;">\u2190 Back to Session List</button>
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
  })();
}

// ── Download ─────────────────────────────────────────────────────────────────

async function chatDownloadConversation() {
  if (!state.chatActiveConvId) return;
  try {
    const res = await fetch(chatApiUrl(`conversations/${state.chatActiveConvId}/download`), { credentials: 'same-origin' });
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

// ── Settings ─────────────────────────────────────────────────────────────────

async function chatShowSettings(initialTab) {
  try {
    const res = await chatFetch('settings');
    state.chatSettingsData = await res.json();
  } catch {
    state.chatSettingsData = { theme: 'system', sendBehavior: 'enter', systemPrompt: '', defaultBackend: state.CHAT_BACKENDS[0]?.id || 'claude-code' };
  }

  const s = state.chatSettingsData;
  const html = `
    <div class="chat-settings-tabs">
      <button class="chat-settings-tab active" data-tab="general">General</button>
      <button class="chat-settings-tab" data-tab="usage">Usage Stats</button>
    </div>
    <div class="chat-modal-body">
      <div class="chat-settings-tab-content" id="chat-tab-general">
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
          <select class="chat-settings-select" id="chat-settings-backend" onchange="chatSettingsBackendChanged()">
            ${state.CHAT_BACKENDS.map(b => `<option value="${b.id}"${s.defaultBackend === b.id ? ' selected' : ''}>${esc(b.label)}</option>`).join('')}
          </select>
        </div>
        <div class="chat-settings-group" id="chat-settings-model-group"${(() => { const models = state.BACKEND_MODELS[s.defaultBackend]; return (!models || models.length === 0) ? ' style="display:none;"' : ''; })()}>
          <div class="chat-settings-label">Default Model</div>
          <select class="chat-settings-select" id="chat-settings-model">
            ${(() => { const models = state.BACKEND_MODELS[s.defaultBackend] || []; return models.map(m => `<option value="${m.id}"${s.defaultModel === m.id ? ' selected' : (m.default && !s.defaultModel ? ' selected' : '')}>${esc(m.label)}</option>`).join(''); })()}
          </select>
        </div>
        <div class="chat-settings-group">
          <div class="chat-settings-label">System Prompt</div>
          <div class="chat-settings-desc">Prepended to every new CLI session.</div>
          <textarea class="chat-settings-textarea" id="chat-settings-system-prompt" style="min-height:120px">${esc(s.systemPrompt || '')}</textarea>
        </div>
        <button class="chat-settings-save" onclick="chatSaveSettings()">Save Settings</button>
      </div>
      <div class="chat-settings-tab-content" id="chat-tab-usage" style="display:none;">
        <div class="chat-usage-stats-controls">
          <div class="chat-settings-group" style="flex:1;">
            <div class="chat-settings-label">Time Range</div>
            <select class="chat-settings-select" id="chat-usage-range" onchange="chatUpdateUsageStats()">
              <option value="today">Today</option>
              <option value="week" selected>This Week</option>
              <option value="month">This Month</option>
              <option value="all">All Time</option>
            </select>
          </div>
          <button class="chat-settings-save chat-usage-clear-btn" onclick="chatClearUsageStats()">Clear All Data</button>
        </div>
        <div id="chat-usage-stats-body">
          <div class="chat-usage-loading">Loading...</div>
        </div>
      </div>
    </div>
  `;

  chatShowModal('Settings', html);

  document.querySelectorAll('.chat-settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.chat-settings-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.chat-settings-tab-content').forEach(c => c.style.display = 'none');
      const target = tab.getAttribute('data-tab');
      const panel = document.getElementById('chat-tab-' + target);
      if (panel) panel.style.display = '';
      if (target === 'usage') chatLoadUsageStats();
    });
  });

  if (initialTab === 'usage') {
    document.querySelector('.chat-settings-tab[data-tab="usage"]')?.click();
  }
}

function chatSettingsBackendChanged() {
  const backendId = document.getElementById('chat-settings-backend')?.value;
  const modelGroup = document.getElementById('chat-settings-model-group');
  const modelSelect = document.getElementById('chat-settings-model');
  if (!modelGroup || !modelSelect) return;

  const models = state.BACKEND_MODELS[backendId];
  if (!models || models.length === 0) {
    modelGroup.style.display = 'none';
    modelSelect.innerHTML = '';
    return;
  }
  modelGroup.style.display = '';
  modelSelect.innerHTML = models.map(m =>
    `<option value="${esc(m.id)}"${m.default ? ' selected' : ''}>${esc(m.label)}</option>`
  ).join('');
}

function chatSaveSettings() {
  const defaultBackend = document.getElementById('chat-settings-backend')?.value || (state.CHAT_BACKENDS[0]?.id || 'claude-code');
  const modelEl = document.getElementById('chat-settings-model');
  const defaultModel = (modelEl && modelEl.closest('.chat-settings-group')?.style.display !== 'none') ? modelEl.value : undefined;
  const settings = {
    theme: document.getElementById('chat-settings-theme')?.value || 'system',
    sendBehavior: document.getElementById('chat-settings-send')?.value || 'enter',
    defaultBackend,
    defaultModel,
    systemPrompt: document.getElementById('chat-settings-system-prompt')?.value || '',
  };
  applyTheme(settings.theme);
  chatFetch('settings', { method: 'PUT', body: settings }).then(() => {
    state.chatSettingsData = settings;
    chatCloseModal();
  }).catch(err => {
    alert('Failed to save settings: ' + err.message);
  });
}

// ── Usage Stats ──────────────────────────────────────────────────────────────

async function chatLoadUsageStats() {
  try {
    const res = await chatFetch('usage-stats');
    state._usageStatsCache = await res.json();
    chatUpdateUsageStats();
  } catch (err) {
    const body = document.getElementById('chat-usage-stats-body');
    if (body) body.innerHTML = '<div class="chat-usage-loading">Failed to load usage stats.</div>';
  }
}

function chatUpdateUsageStats() {
  const body = document.getElementById('chat-usage-stats-body');
  if (!body || !state._usageStatsCache) return;

  const range = document.getElementById('chat-usage-range')?.value || 'week';
  const days = state._usageStatsCache.days || [];

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  let filteredDays;
  if (range === 'today') {
    filteredDays = days.filter(d => d.date === todayStr);
  } else if (range === 'week') {
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekStr = weekAgo.toISOString().slice(0, 10);
    filteredDays = days.filter(d => d.date >= weekStr);
  } else if (range === 'month') {
    const monthAgo = new Date(now);
    monthAgo.setDate(monthAgo.getDate() - 30);
    const monthStr = monthAgo.toISOString().slice(0, 10);
    filteredDays = days.filter(d => d.date >= monthStr);
  } else {
    filteredDays = days;
  }

  function getDayRecords(day) {
    if (day.records) return day.records;
    if (day.backends) {
      return Object.entries(day.backends).map(([bid, u]) => ({ backend: bid, model: 'unknown', usage: u }));
    }
    return [];
  }

  const aggregateKey = (r) => `${r.backend}\0${r.model}`;
  const totals = {};
  for (const day of filteredDays) {
    for (const rec of getDayRecords(day)) {
      const key = aggregateKey(rec);
      if (!totals[key]) totals[key] = { backend: rec.backend, model: rec.model, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } };
      totals[key].usage.inputTokens += rec.usage.inputTokens || 0;
      totals[key].usage.outputTokens += rec.usage.outputTokens || 0;
      totals[key].usage.cacheReadTokens += rec.usage.cacheReadTokens || 0;
      totals[key].usage.cacheWriteTokens += rec.usage.cacheWriteTokens || 0;
      totals[key].usage.costUsd += rec.usage.costUsd || 0;
    }
  }

  const keys = Object.keys(totals);
  if (keys.length === 0) {
    body.innerHTML = '<div class="chat-usage-loading">No usage data for this period.</div>';
    return;
  }

  function backendLabel(id) {
    const b = state.CHAT_BACKENDS.find(x => x.id === id);
    return b ? b.label : id;
  }

  function modelLabel(m) {
    if (!m || m === 'unknown') return '-';
    return m;
  }

  let html = '<table class="chat-usage-table"><thead><tr><th>Backend</th><th>Model</th><th>Input</th><th>Output</th><th>Cache R</th><th>Cache W</th><th>Total</th><th>Cost</th></tr></thead><tbody>';
  for (const key of keys) {
    const t = totals[key];
    const u = t.usage;
    const total = u.inputTokens + u.outputTokens;
    html += `<tr>
      <td>${esc(backendLabel(t.backend))}</td>
      <td>${esc(modelLabel(t.model))}</td>
      <td>${chatFormatTokenCount(u.inputTokens)}</td>
      <td>${chatFormatTokenCount(u.outputTokens)}</td>
      <td>${chatFormatTokenCount(u.cacheReadTokens)}</td>
      <td>${chatFormatTokenCount(u.cacheWriteTokens)}</td>
      <td>${chatFormatTokenCount(total)}</td>
      <td>${u.costUsd > 0 ? chatFormatCost(u.costUsd) : '-'}</td>
    </tr>`;
  }
  html += '</tbody></table>';

  if (filteredDays.length > 1) {
    html += '<div class="chat-usage-daily-title">Daily Breakdown</div>';
    html += '<table class="chat-usage-table chat-usage-daily"><thead><tr><th>Date</th><th>Backend</th><th>Model</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>';
    const sortedDays = [...filteredDays].sort((a, b) => b.date.localeCompare(a.date));
    for (const day of sortedDays) {
      for (const rec of getDayRecords(day)) {
        const total = (rec.usage.inputTokens || 0) + (rec.usage.outputTokens || 0);
        html += `<tr>
          <td>${day.date}</td>
          <td>${esc(backendLabel(rec.backend))}</td>
          <td>${esc(modelLabel(rec.model))}</td>
          <td>${chatFormatTokenCount(total)}</td>
          <td>${rec.usage.costUsd > 0 ? chatFormatCost(rec.usage.costUsd) : '-'}</td>
        </tr>`;
      }
    }
    html += '</tbody></table>';
  }

  body.innerHTML = html;
}

async function chatClearUsageStats() {
  if (!confirm('Clear all usage statistics? This cannot be undone.')) return;
  try {
    await chatFetch('usage-stats', { method: 'DELETE' });
    state._usageStatsCache = { days: [] };
    chatUpdateUsageStats();
  } catch (err) {
    alert('Failed to clear usage stats: ' + err.message);
  }
}

// ── Workspace Instructions ───────────────────────────────────────────────────

async function chatShowWorkspaceInstructions(hash, label) {
  let instructions = '';
  try {
    const res = await chatFetch(`workspaces/${encodeURIComponent(hash)}/instructions`);
    const data = await res.json();
    instructions = data.instructions || '';
  } catch {
    // Workspace may not have instructions yet
  }

  const html = `
    <div class="chat-modal-body">
      <div class="chat-settings-group">
        <div class="chat-settings-desc">Additional instructions prepended to every new CLI session in this workspace. Combined with the global system prompt.</div>
        <textarea class="chat-settings-textarea" id="chat-ws-instructions" style="min-height:160px">${esc(instructions)}</textarea>
      </div>
      <button class="chat-settings-save" onclick="chatSaveWorkspaceInstructions('${esc(hash)}')">Save</button>
    </div>
  `;

  chatShowModal(`Instructions: ${label}`, html);
}

function chatSaveWorkspaceInstructions(hash) {
  const instructions = document.getElementById('chat-ws-instructions')?.value || '';
  chatFetch(`workspaces/${encodeURIComponent(hash)}/instructions`, {
    method: 'PUT',
    body: { instructions },
  }).then(() => {
    chatCloseModal();
  }).catch(err => {
    alert('Failed to save workspace instructions: ' + err.message);
  });
}

// ── Self-update UI ───────────────────────────────────────────────────────────

async function chatManualVersionCheck() {
  const textEl = document.getElementById('chat-version-text');
  if (!textEl) return;
  const original = textEl.textContent;
  textEl.textContent = 'checking\u2026';
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

// ── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;

  if (mod && e.shiftKey && e.key === 'O') {
    e.preventDefault();
    chatNewConversation();
    return;
  }

  if (mod && e.key === 'k') {
    e.preventDefault();
    const searchInput = document.getElementById('chat-search-input');
    if (searchInput) searchInput.focus();
    return;
  }

  if (mod && e.shiftKey && e.key === 'S') {
    e.preventDefault();
    chatToggleSidebar();
    return;
  }

  if (mod && e.shiftKey && e.key === 'C') {
    e.preventDefault();
    if (state.chatActiveConv) {
      const lastAssistant = [...state.chatActiveConv.messages].reverse().find(m => m.role === 'assistant');
      if (lastAssistant) navigator.clipboard.writeText(lastAssistant.content);
    }
    return;
  }

  if (mod && e.shiftKey && e.key === 'R') {
    e.preventDefault();
    chatResetSession();
    return;
  }

  if (mod && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    chatDownloadConversation();
    return;
  }

  if (e.key === '/' && !e.target.closest('input, textarea, select, [contenteditable]')) {
    e.preventDefault();
    const textarea = document.getElementById('chat-textarea');
    if (textarea) textarea.focus();
    return;
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────
chatInit();
