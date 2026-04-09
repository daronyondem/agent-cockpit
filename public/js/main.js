import { state, chatFetch, apiUrl, chatApiUrl, DEFAULT_BACKEND_ICON } from './state.js';
import { esc, chatFormatTokenCount, chatFormatCost } from './utils.js';
import { applyTheme } from './theme.js';
import { chatShowModal, chatCloseModal } from './modal.js';
import { loadBackends, getBackendIcon, getBackendCapabilities, populateModelSelect, populateEffortSelect } from './backends.js';
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
window.chatSettingsModelChanged = chatSettingsModelChanged;
window.chatSettingsMemoryBackendChanged = chatSettingsMemoryBackendChanged;
window.chatSettingsMemoryModelChanged = chatSettingsMemoryModelChanged;
window.chatSettingsKbDigestBackendChanged = chatSettingsKbDigestBackendChanged;
window.chatSettingsKbDigestModelChanged = chatSettingsKbDigestModelChanged;
window.chatSettingsKbDreamBackendChanged = chatSettingsKbDreamBackendChanged;
window.chatSettingsKbDreamModelChanged = chatSettingsKbDreamModelChanged;
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
    if (s.defaultModel) populateModelSelect(s.defaultModel, s.defaultEffort);
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
        chatShowWorkspaceSettings(instrBtn.dataset.wsHash, instrBtn.dataset.wsLabel);
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

  const modelSel = document.getElementById('chat-model-select');
  if (modelSel && !modelSel._effortWired) {
    modelSel._effortWired = true;
    modelSel.addEventListener('change', () => {
      populateEffortSelect();
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
          <div class="chat-msg-avatar chat-msg-avatar-cockpit"><img src="logo-small.svg" alt="Agent Cockpit" /></div>
          <div class="chat-msg-body">
            <div class="chat-msg-role">Agent Cockpit</div>
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
  const mem = s.memory || {};
  const memBackendId = mem.cliBackend || s.defaultBackend || (state.CHAT_BACKENDS[0]?.id || 'claude-code');
  const memModels = state.BACKEND_MODELS[memBackendId] || [];
  const memSelectedModel = mem.cliModel || memModels.find((m) => m.default)?.id || (memModels[0]?.id || '');
  const memModel = memModels.find((m) => m.id === memSelectedModel);
  const memLevels = memModel?.supportedEffortLevels || [];
  const memSelectedEffort = mem.cliEffort && memLevels.includes(mem.cliEffort)
    ? mem.cliEffort
    : (memLevels.includes('high') ? 'high' : memLevels[0] || '');

  // Knowledge Base config mirrors the Memory shape but has two separate
  // CLI roles: Digestion (runs per raw file) and Dreaming (manual synthesis).
  // Both fall back to the default backend so fresh installs don't require
  // extra config before the feature starts working.
  const kb = s.knowledgeBase || {};
  const kbDigestBackendId = kb.digestionCliBackend || s.defaultBackend || (state.CHAT_BACKENDS[0]?.id || 'claude-code');
  const kbDigestModels = state.BACKEND_MODELS[kbDigestBackendId] || [];
  const kbDigestSelectedModel = kb.digestionCliModel || kbDigestModels.find((m) => m.default)?.id || (kbDigestModels[0]?.id || '');
  const kbDigestModel = kbDigestModels.find((m) => m.id === kbDigestSelectedModel);
  const kbDigestLevels = kbDigestModel?.supportedEffortLevels || [];
  const kbDigestSelectedEffort = kb.digestionCliEffort && kbDigestLevels.includes(kb.digestionCliEffort)
    ? kb.digestionCliEffort
    : (kbDigestLevels.includes('high') ? 'high' : kbDigestLevels[0] || '');

  const kbDreamBackendId = kb.dreamingCliBackend || s.defaultBackend || (state.CHAT_BACKENDS[0]?.id || 'claude-code');
  const kbDreamModels = state.BACKEND_MODELS[kbDreamBackendId] || [];
  const kbDreamSelectedModel = kb.dreamingCliModel || kbDreamModels.find((m) => m.default)?.id || (kbDreamModels[0]?.id || '');
  const kbDreamModel = kbDreamModels.find((m) => m.id === kbDreamSelectedModel);
  const kbDreamLevels = kbDreamModel?.supportedEffortLevels || [];
  const kbDreamSelectedEffort = kb.dreamingCliEffort && kbDreamLevels.includes(kb.dreamingCliEffort)
    ? kb.dreamingCliEffort
    : (kbDreamLevels.includes('high') ? 'high' : kbDreamLevels[0] || '');

  const kbConvertSlides = Boolean(kb.convertSlidesToImages);

  const html = `
    <div class="chat-settings-tabs">
      <button class="chat-settings-tab active" data-tab="general">General</button>
      <button class="chat-settings-tab" data-tab="memory">Memory</button>
      <button class="chat-settings-tab" data-tab="kb">Knowledge Base</button>
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
          <select class="chat-settings-select" id="chat-settings-model" onchange="chatSettingsModelChanged()">
            ${(() => { const models = state.BACKEND_MODELS[s.defaultBackend] || []; return models.map(m => `<option value="${m.id}"${s.defaultModel === m.id ? ' selected' : (m.default && !s.defaultModel ? ' selected' : '')}>${esc(m.label)}</option>`).join(''); })()}
          </select>
        </div>
        <div class="chat-settings-group" id="chat-settings-effort-group"${(() => {
          const models = state.BACKEND_MODELS[s.defaultBackend] || [];
          const selected = s.defaultModel || models.find(m => m.default)?.id;
          const model = models.find(m => m.id === selected);
          return (!model || !model.supportedEffortLevels || model.supportedEffortLevels.length === 0) ? ' style="display:none;"' : '';
        })()}>
          <div class="chat-settings-label">Default Effort</div>
          <div class="chat-settings-desc">Adaptive reasoning level for the default model. Applied to new conversations when they use the default model.</div>
          <select class="chat-settings-select" id="chat-settings-effort">
            ${(() => {
              const models = state.BACKEND_MODELS[s.defaultBackend] || [];
              const selected = s.defaultModel || models.find(m => m.default)?.id;
              const model = models.find(m => m.id === selected);
              const levels = model?.supportedEffortLevels || [];
              const current = s.defaultEffort && levels.includes(s.defaultEffort)
                ? s.defaultEffort
                : (levels.includes('high') ? 'high' : levels[0]);
              return levels.map(lv => `<option value="${lv}"${lv === current ? ' selected' : ''}>${lv.charAt(0).toUpperCase() + lv.slice(1)}</option>`).join('');
            })()}
          </select>
        </div>
        <div class="chat-settings-group">
          <div class="chat-settings-label">System Prompt</div>
          <div class="chat-settings-desc">Prepended to every new CLI session.</div>
          <textarea class="chat-settings-textarea" id="chat-settings-system-prompt" style="min-height:120px">${esc(s.systemPrompt || '')}</textarea>
        </div>
        <button class="chat-settings-save" onclick="chatSaveSettings()">Save Settings</button>
      </div>
      <div class="chat-settings-tab-content" id="chat-tab-memory" style="display:none;">
        <div class="chat-settings-group">
          <div class="chat-settings-desc">
            The Memory CLI is used to process <code>memory_note</code> MCP calls
            from non-Claude chat sessions and to extract memories from their
            transcripts on session reset. Claude Code sessions continue to use
            their own native memory system regardless of this setting.
          </div>
        </div>
        <div class="chat-settings-group">
          <div class="chat-settings-label">Memory CLI</div>
          <select class="chat-settings-select" id="chat-settings-memory-backend" onchange="chatSettingsMemoryBackendChanged()">
            ${state.CHAT_BACKENDS.map((b) => `<option value="${esc(b.id)}"${b.id === memBackendId ? ' selected' : ''}>${esc(b.label)}</option>`).join('')}
          </select>
        </div>
        <div class="chat-settings-group" id="chat-settings-memory-model-group"${memModels.length === 0 ? ' style="display:none;"' : ''}>
          <div class="chat-settings-label">Memory Model</div>
          <select class="chat-settings-select" id="chat-settings-memory-model" onchange="chatSettingsMemoryModelChanged()">
            ${memModels.map((m) => `<option value="${esc(m.id)}"${m.id === memSelectedModel ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}
          </select>
        </div>
        <div class="chat-settings-group" id="chat-settings-memory-effort-group"${memLevels.length === 0 ? ' style="display:none;"' : ''}>
          <div class="chat-settings-label">Memory Effort</div>
          <div class="chat-settings-desc">Adaptive reasoning level for the Memory CLI. Lower levels are faster and cheaper.</div>
          <select class="chat-settings-select" id="chat-settings-memory-effort">
            ${memLevels.map((lv) => `<option value="${esc(lv)}"${lv === memSelectedEffort ? ' selected' : ''}>${lv.charAt(0).toUpperCase() + lv.slice(1)}</option>`).join('')}
          </select>
        </div>
        <button class="chat-settings-save" onclick="chatSaveSettings()">Save Settings</button>
      </div>
      <div class="chat-settings-tab-content" id="chat-tab-kb" style="display:none;">
        <div class="chat-settings-group">
          <div class="chat-settings-desc">
            The Knowledge Base pipeline has two CLI roles. <strong>Digestion</strong>
            runs once per uploaded file to produce a structured entry. <strong>Dreaming</strong>
            is triggered manually to synthesize entries into a cross-linked
            knowledge graph. Both fall back to the default backend when
            unset. These settings are global — enable the feature per
            workspace in Workspace Settings → Knowledge Base.
          </div>
        </div>
        <div class="chat-settings-group">
          <div class="chat-settings-label">Digestion CLI</div>
          <select class="chat-settings-select" id="chat-settings-kb-digest-backend" onchange="chatSettingsKbDigestBackendChanged()">
            ${state.CHAT_BACKENDS.map((b) => `<option value="${esc(b.id)}"${b.id === kbDigestBackendId ? ' selected' : ''}>${esc(b.label)}</option>`).join('')}
          </select>
        </div>
        <div class="chat-settings-group" id="chat-settings-kb-digest-model-group"${kbDigestModels.length === 0 ? ' style="display:none;"' : ''}>
          <div class="chat-settings-label">Digestion Model</div>
          <select class="chat-settings-select" id="chat-settings-kb-digest-model" onchange="chatSettingsKbDigestModelChanged()">
            ${kbDigestModels.map((m) => `<option value="${esc(m.id)}"${m.id === kbDigestSelectedModel ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}
          </select>
        </div>
        <div class="chat-settings-group" id="chat-settings-kb-digest-effort-group"${kbDigestLevels.length === 0 ? ' style="display:none;"' : ''}>
          <div class="chat-settings-label">Digestion Effort</div>
          <div class="chat-settings-desc">Adaptive reasoning level for the Digestion CLI. Lower levels are faster and cheaper per file.</div>
          <select class="chat-settings-select" id="chat-settings-kb-digest-effort">
            ${kbDigestLevels.map((lv) => `<option value="${esc(lv)}"${lv === kbDigestSelectedEffort ? ' selected' : ''}>${lv.charAt(0).toUpperCase() + lv.slice(1)}</option>`).join('')}
          </select>
        </div>
        <div class="chat-settings-group">
          <div class="chat-settings-label">Dreaming CLI</div>
          <select class="chat-settings-select" id="chat-settings-kb-dream-backend" onchange="chatSettingsKbDreamBackendChanged()">
            ${state.CHAT_BACKENDS.map((b) => `<option value="${esc(b.id)}"${b.id === kbDreamBackendId ? ' selected' : ''}>${esc(b.label)}</option>`).join('')}
          </select>
        </div>
        <div class="chat-settings-group" id="chat-settings-kb-dream-model-group"${kbDreamModels.length === 0 ? ' style="display:none;"' : ''}>
          <div class="chat-settings-label">Dreaming Model</div>
          <select class="chat-settings-select" id="chat-settings-kb-dream-model" onchange="chatSettingsKbDreamModelChanged()">
            ${kbDreamModels.map((m) => `<option value="${esc(m.id)}"${m.id === kbDreamSelectedModel ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}
          </select>
        </div>
        <div class="chat-settings-group" id="chat-settings-kb-dream-effort-group"${kbDreamLevels.length === 0 ? ' style="display:none;"' : ''}>
          <div class="chat-settings-label">Dreaming Effort</div>
          <div class="chat-settings-desc">Adaptive reasoning level for the Dreaming CLI. Higher levels produce richer synthesis at higher cost per run.</div>
          <select class="chat-settings-select" id="chat-settings-kb-dream-effort">
            ${kbDreamLevels.map((lv) => `<option value="${esc(lv)}"${lv === kbDreamSelectedEffort ? ' selected' : ''}>${lv.charAt(0).toUpperCase() + lv.slice(1)}</option>`).join('')}
          </select>
        </div>
        <div class="chat-settings-group">
          <label class="chat-settings-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" id="chat-settings-kb-convert-slides"${kbConvertSlides ? ' checked' : ''} />
            <span>Convert PPTX slides to images for better results (Requires LibreOffice)</span>
          </label>
          <div class="chat-settings-desc">
            When enabled, PPTX ingestion shells out to LibreOffice to render
            each slide as a high-fidelity PNG. Without LibreOffice installed,
            the pipeline still captures text, speaker notes, and embedded
            media, but per-slide visuals are skipped.
          </div>
          <div id="chat-settings-kb-convert-slides-warning" style="display:none;margin-top:6px;font-size:12px;color:var(--error,#d32f2f);"></div>
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

  // PPTX → images checkbox validates LibreOffice availability on check.
  // If the binary is missing, the box reverts to unchecked and a small
  // warning appears underneath. Validation only fires when the user tries
  // to turn the setting ON — unchecking never calls the endpoint.
  const kbConvertEl = document.getElementById('chat-settings-kb-convert-slides');
  const kbConvertWarnEl = document.getElementById('chat-settings-kb-convert-slides-warning');
  if (kbConvertEl && kbConvertWarnEl) {
    kbConvertEl.addEventListener('change', async () => {
      if (!kbConvertEl.checked) {
        kbConvertWarnEl.style.display = 'none';
        kbConvertWarnEl.textContent = '';
        return;
      }
      try {
        const res = await fetch(chatApiUrl('kb/libreoffice-status'), { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const status = await res.json();
        if (status && status.available) {
          kbConvertWarnEl.style.display = 'none';
          kbConvertWarnEl.textContent = '';
          return;
        }
        kbConvertEl.checked = false;
        kbConvertWarnEl.textContent = 'LibreOffice is not installed or not on PATH. Install it (e.g. `brew install --cask libreoffice` on macOS) and restart Agent Cockpit to enable slide-to-image conversion.';
        kbConvertWarnEl.style.display = '';
      } catch (err) {
        kbConvertEl.checked = false;
        kbConvertWarnEl.textContent = 'Could not verify LibreOffice availability: ' + (err && err.message ? err.message : 'unknown error');
        kbConvertWarnEl.style.display = '';
      }
    });
  }

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
    chatSettingsRefreshEffortGroup();
    return;
  }
  modelGroup.style.display = '';
  modelSelect.innerHTML = models.map(m =>
    `<option value="${esc(m.id)}"${m.default ? ' selected' : ''}>${esc(m.label)}</option>`
  ).join('');
  chatSettingsRefreshEffortGroup();
}

function chatSettingsMemoryBackendChanged() {
  const backendId = document.getElementById('chat-settings-memory-backend')?.value;
  const modelGroup = document.getElementById('chat-settings-memory-model-group');
  const modelSelect = document.getElementById('chat-settings-memory-model');
  if (!modelGroup || !modelSelect) return;

  const models = state.BACKEND_MODELS[backendId];
  if (!models || models.length === 0) {
    modelGroup.style.display = 'none';
    modelSelect.innerHTML = '';
    chatSettingsRefreshMemoryEffortGroup();
    return;
  }
  modelGroup.style.display = '';
  modelSelect.innerHTML = models.map(m =>
    `<option value="${esc(m.id)}"${m.default ? ' selected' : ''}>${esc(m.label)}</option>`
  ).join('');
  chatSettingsRefreshMemoryEffortGroup();
}

// ── Knowledge Base settings handlers ─────────────────────────────────────────
// Two parallel copies (Digestion + Dreaming) of the same backend/model/effort
// cascade the Memory tab uses. Factored out into a small helper to keep the
// top-level handlers cheap and obvious.

function chatSettingsKbBackendChanged(role) {
  const backendSel = document.getElementById(`chat-settings-kb-${role}-backend`);
  const modelGroup = document.getElementById(`chat-settings-kb-${role}-model-group`);
  const modelSelect = document.getElementById(`chat-settings-kb-${role}-model`);
  if (!backendSel || !modelGroup || !modelSelect) return;

  const models = state.BACKEND_MODELS[backendSel.value];
  if (!models || models.length === 0) {
    modelGroup.style.display = 'none';
    modelSelect.innerHTML = '';
    chatSettingsRefreshKbEffortGroup(role);
    return;
  }
  modelGroup.style.display = '';
  modelSelect.innerHTML = models.map((m) =>
    `<option value="${esc(m.id)}"${m.default ? ' selected' : ''}>${esc(m.label)}</option>`
  ).join('');
  chatSettingsRefreshKbEffortGroup(role);
}

function chatSettingsRefreshKbEffortGroup(role) {
  const effortGroup = document.getElementById(`chat-settings-kb-${role}-effort-group`);
  const effortSelect = document.getElementById(`chat-settings-kb-${role}-effort`);
  if (!effortGroup || !effortSelect) return;

  const backendId = document.getElementById(`chat-settings-kb-${role}-backend`)?.value;
  const models = state.BACKEND_MODELS[backendId] || [];
  const selectedModelId = document.getElementById(`chat-settings-kb-${role}-model`)?.value;
  const model = models.find((m) => m.id === selectedModelId);
  const levels = model?.supportedEffortLevels || [];

  if (levels.length === 0) {
    effortGroup.style.display = 'none';
    effortSelect.innerHTML = '';
    return;
  }

  const prev = effortSelect.value;
  const kb = state.chatSettingsData?.knowledgeBase || {};
  const stored = role === 'digest' ? kb.digestionCliEffort : kb.dreamingCliEffort;
  let next = null;
  if (prev && levels.includes(prev)) next = prev;
  else if (stored && levels.includes(stored)) next = stored;
  else if (levels.includes('high')) next = 'high';
  else next = levels[0];

  effortGroup.style.display = '';
  effortSelect.innerHTML = levels.map((lv) =>
    `<option value="${lv}"${lv === next ? ' selected' : ''}>${lv.charAt(0).toUpperCase() + lv.slice(1)}</option>`
  ).join('');
}

function chatSettingsKbDigestBackendChanged() { chatSettingsKbBackendChanged('digest'); }
function chatSettingsKbDigestModelChanged() { chatSettingsRefreshKbEffortGroup('digest'); }
function chatSettingsKbDreamBackendChanged() { chatSettingsKbBackendChanged('dream'); }
function chatSettingsKbDreamModelChanged() { chatSettingsRefreshKbEffortGroup('dream'); }

function chatSettingsMemoryModelChanged() {
  chatSettingsRefreshMemoryEffortGroup();
}

function chatSettingsRefreshMemoryEffortGroup() {
  const effortGroup = document.getElementById('chat-settings-memory-effort-group');
  const effortSelect = document.getElementById('chat-settings-memory-effort');
  if (!effortGroup || !effortSelect) return;

  const backendId = document.getElementById('chat-settings-memory-backend')?.value;
  const models = state.BACKEND_MODELS[backendId] || [];
  const selectedModelId = document.getElementById('chat-settings-memory-model')?.value;
  const model = models.find((m) => m.id === selectedModelId);
  const levels = model?.supportedEffortLevels || [];

  if (levels.length === 0) {
    effortGroup.style.display = 'none';
    effortSelect.innerHTML = '';
    return;
  }

  const prev = effortSelect.value;
  const stored = state.chatSettingsData?.memory?.cliEffort;
  let next = null;
  if (prev && levels.includes(prev)) next = prev;
  else if (stored && levels.includes(stored)) next = stored;
  else if (levels.includes('high')) next = 'high';
  else next = levels[0];

  effortGroup.style.display = '';
  effortSelect.innerHTML = levels.map((lv) =>
    `<option value="${lv}"${lv === next ? ' selected' : ''}>${lv.charAt(0).toUpperCase() + lv.slice(1)}</option>`
  ).join('');
}

function chatSettingsModelChanged() {
  chatSettingsRefreshEffortGroup();
}

function chatSettingsRefreshEffortGroup() {
  const effortGroup = document.getElementById('chat-settings-effort-group');
  const effortSelect = document.getElementById('chat-settings-effort');
  if (!effortGroup || !effortSelect) return;

  const backendId = document.getElementById('chat-settings-backend')?.value;
  const models = state.BACKEND_MODELS[backendId] || [];
  const selectedModelId = document.getElementById('chat-settings-model')?.value;
  const model = models.find(m => m.id === selectedModelId);
  const levels = model?.supportedEffortLevels || [];

  if (levels.length === 0) {
    effortGroup.style.display = 'none';
    effortSelect.innerHTML = '';
    return;
  }

  // Preserve the current selection if possible; otherwise fall back to stored
  // default, then to 'high', then to the first supported level.
  const prev = effortSelect.value;
  const stored = state.chatSettingsData?.defaultEffort;
  let next = null;
  if (prev && levels.includes(prev)) next = prev;
  else if (stored && levels.includes(stored)) next = stored;
  else if (levels.includes('high')) next = 'high';
  else next = levels[0];

  effortGroup.style.display = '';
  effortSelect.innerHTML = levels.map(lv =>
    `<option value="${lv}"${lv === next ? ' selected' : ''}>${lv.charAt(0).toUpperCase() + lv.slice(1)}</option>`
  ).join('');
}

function chatSaveSettings() {
  const defaultBackend = document.getElementById('chat-settings-backend')?.value || (state.CHAT_BACKENDS[0]?.id || 'claude-code');
  const modelEl = document.getElementById('chat-settings-model');
  const defaultModel = (modelEl && modelEl.closest('.chat-settings-group')?.style.display !== 'none') ? modelEl.value : undefined;
  const effortEl = document.getElementById('chat-settings-effort');
  const effortGroup = document.getElementById('chat-settings-effort-group');
  // Drop defaultEffort when the effort group is hidden (backend/model doesn't
  // support effort). This matches the "drop on model change" rule.
  const defaultEffort = (effortEl && effortGroup?.style.display !== 'none') ? effortEl.value : undefined;

  // Memory CLI config — only include keys that are visible (i.e. the picker
  // is populated). Missing values are dropped so the server stores a clean
  // shape and falls back to defaults when nothing is configured yet.
  const memBackendEl = document.getElementById('chat-settings-memory-backend');
  const memModelEl = document.getElementById('chat-settings-memory-model');
  const memModelGroup = document.getElementById('chat-settings-memory-model-group');
  const memEffortEl = document.getElementById('chat-settings-memory-effort');
  const memEffortGroup = document.getElementById('chat-settings-memory-effort-group');
  const memory = {};
  if (memBackendEl?.value) memory.cliBackend = memBackendEl.value;
  if (memModelEl?.value && memModelGroup?.style.display !== 'none') memory.cliModel = memModelEl.value;
  if (memEffortEl?.value && memEffortGroup?.style.display !== 'none') memory.cliEffort = memEffortEl.value;

  // Knowledge Base CLI config — same "drop hidden values" rule as Memory.
  // Digestion and Dreaming roles are independent to let users route costly
  // synthesis work through a different (cheaper or smarter) model.
  const kbDigestBackendEl = document.getElementById('chat-settings-kb-digest-backend');
  const kbDigestModelEl = document.getElementById('chat-settings-kb-digest-model');
  const kbDigestModelGroup = document.getElementById('chat-settings-kb-digest-model-group');
  const kbDigestEffortEl = document.getElementById('chat-settings-kb-digest-effort');
  const kbDigestEffortGroup = document.getElementById('chat-settings-kb-digest-effort-group');
  const kbDreamBackendEl = document.getElementById('chat-settings-kb-dream-backend');
  const kbDreamModelEl = document.getElementById('chat-settings-kb-dream-model');
  const kbDreamModelGroup = document.getElementById('chat-settings-kb-dream-model-group');
  const kbDreamEffortEl = document.getElementById('chat-settings-kb-dream-effort');
  const kbDreamEffortGroup = document.getElementById('chat-settings-kb-dream-effort-group');
  const kbConvertSlidesEl = document.getElementById('chat-settings-kb-convert-slides');
  const knowledgeBase = {};
  if (kbDigestBackendEl?.value) knowledgeBase.digestionCliBackend = kbDigestBackendEl.value;
  if (kbDigestModelEl?.value && kbDigestModelGroup?.style.display !== 'none') knowledgeBase.digestionCliModel = kbDigestModelEl.value;
  if (kbDigestEffortEl?.value && kbDigestEffortGroup?.style.display !== 'none') knowledgeBase.digestionCliEffort = kbDigestEffortEl.value;
  if (kbDreamBackendEl?.value) knowledgeBase.dreamingCliBackend = kbDreamBackendEl.value;
  if (kbDreamModelEl?.value && kbDreamModelGroup?.style.display !== 'none') knowledgeBase.dreamingCliModel = kbDreamModelEl.value;
  if (kbDreamEffortEl?.value && kbDreamEffortGroup?.style.display !== 'none') knowledgeBase.dreamingCliEffort = kbDreamEffortEl.value;
  if (kbConvertSlidesEl) knowledgeBase.convertSlidesToImages = Boolean(kbConvertSlidesEl.checked);

  const settings = {
    theme: document.getElementById('chat-settings-theme')?.value || 'system',
    sendBehavior: document.getElementById('chat-settings-send')?.value || 'enter',
    defaultBackend,
    defaultModel,
    defaultEffort,
    systemPrompt: document.getElementById('chat-settings-system-prompt')?.value || '',
    memory: Object.keys(memory).length > 0 ? memory : undefined,
    knowledgeBase: Object.keys(knowledgeBase).length > 0 ? knowledgeBase : undefined,
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

// ── Workspace Settings ───────────────────────────────────────────────────────
// Multi-section modal: "Instructions" (existing textarea) and "Memory"
// (enable toggle + read-only browser with per-entry delete). Opened from
// the pencil icon on each workspace group header in the conversation list.

async function chatShowWorkspaceSettings(hash, label) {
  // Fetch current state in parallel — these are three independent endpoints.
  let instructions = '';
  let memoryEnabled = false;
  let snapshot = null;
  let kbEnabled = false;
  try {
    const [instrRes, memRes, kbRes] = await Promise.all([
      chatFetch(`workspaces/${encodeURIComponent(hash)}/instructions`).then((r) => r.json()).catch(() => ({})),
      fetch(chatApiUrl(`workspaces/${encodeURIComponent(hash)}/memory`), { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
      fetch(chatApiUrl(`workspaces/${encodeURIComponent(hash)}/kb`), { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
    ]);
    instructions = instrRes.instructions || '';
    memoryEnabled = Boolean(memRes.enabled);
    snapshot = memRes.snapshot || null;
    kbEnabled = Boolean(kbRes.enabled);
  } catch {
    // Workspace may not have instructions yet — leave defaults.
  }

  const html = `
    <div class="chat-settings-tabs">
      <button class="chat-settings-tab active" data-tab="instructions">Instructions</button>
      <button class="chat-settings-tab" data-tab="memory">Memory</button>
      <button class="chat-settings-tab" data-tab="kb">Knowledge Base</button>
    </div>
    <div class="chat-modal-body">
      <div class="chat-settings-tab-content" id="chat-ws-tab-instructions">
        <div class="chat-settings-group">
          <div class="chat-settings-desc">Additional instructions prepended to every new CLI session in this workspace. Combined with the global system prompt.</div>
          <textarea class="chat-settings-textarea" id="chat-ws-instructions" style="min-height:160px">${esc(instructions)}</textarea>
        </div>
        <button class="chat-settings-save" onclick="chatSaveWorkspaceInstructions('${esc(hash)}')">Save</button>
      </div>
      <div class="chat-settings-tab-content" id="chat-ws-tab-memory" style="display:none;">
        <div class="chat-settings-group">
          <div class="chat-settings-desc">
            When enabled, memory from prior sessions is injected into every
            new session's system prompt. Claude Code sessions contribute via
            their native memory system; other CLIs contribute via the
            <code>memory_note</code> MCP tool and post-session extraction.
          </div>
          <label class="chat-settings-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" id="chat-ws-memory-enabled"${memoryEnabled ? ' checked' : ''} />
            <span>Enable Memory for this workspace</span>
          </label>
        </div>
        <div class="chat-settings-group" id="chat-ws-memory-browser">
          ${chatRenderWorkspaceMemoryBrowser(snapshot, memoryEnabled, hash)}
        </div>
      </div>
      <div class="chat-settings-tab-content" id="chat-ws-tab-kb" style="display:none;">
        <div class="chat-settings-group">
          <div class="chat-settings-desc">
            When enabled, files you upload to this workspace are ingested,
            digested into structured entries, and (on demand) synthesized
            into a cross-linked knowledge base. The CLI sees a pointer to
            the knowledge directory on new sessions and reads entries as
            needed. Configure the digestion and dreaming CLIs in global
            Settings → Knowledge Base.
          </div>
          <label class="chat-settings-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" id="chat-ws-kb-enabled"${kbEnabled ? ' checked' : ''} />
            <span>Enable Knowledge Base for this workspace</span>
          </label>
        </div>
        <div class="chat-settings-group" id="chat-ws-kb-browser">
          ${chatRenderWorkspaceKbBrowser(kbEnabled)}
        </div>
      </div>
    </div>
  `;

  chatShowModal(`Workspace Settings: ${label}`, html);

  // Tab switching.
  document.querySelectorAll('.chat-settings-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.chat-settings-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.chat-settings-tab-content').forEach((c) => c.style.display = 'none');
      const target = tab.getAttribute('data-tab');
      const panel = document.getElementById('chat-ws-tab-' + target);
      if (panel) panel.style.display = '';
    });
  });

  // Memory-enable toggle — persists immediately on change so the user doesn't
  // need a separate Save button for this one control.
  const toggleEl = document.getElementById('chat-ws-memory-enabled');
  if (toggleEl) {
    toggleEl.addEventListener('change', async () => {
      const enabled = toggleEl.checked;
      try {
        await chatFetch(`workspaces/${encodeURIComponent(hash)}/memory/enabled`, {
          method: 'PUT',
          body: { enabled },
        });
        // Re-render the browser to reflect the toggle.
        const [memRes] = await Promise.all([
          fetch(chatApiUrl(`workspaces/${encodeURIComponent(hash)}/memory`), { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : {}).catch(() => ({})),
        ]);
        const browser = document.getElementById('chat-ws-memory-browser');
        if (browser) {
          browser.innerHTML = chatRenderWorkspaceMemoryBrowser(memRes.snapshot || null, enabled, hash);
          chatWireWorkspaceMemoryBrowser(browser, hash);
        }
      } catch (err) {
        alert('Failed to update memory setting: ' + err.message);
        toggleEl.checked = !enabled;
      }
    });
  }

  // Wire delete buttons on first render.
  const browser = document.getElementById('chat-ws-memory-browser');
  if (browser) chatWireWorkspaceMemoryBrowser(browser, hash);

  // KB-enable toggle — persists immediately like the memory toggle. Ingestion
  // and browser rendering land in PR 2; for now the tab is just a placeholder
  // so users can opt in and the system prompt pointer starts firing.
  const kbToggleEl = document.getElementById('chat-ws-kb-enabled');
  if (kbToggleEl) {
    kbToggleEl.addEventListener('change', async () => {
      const enabled = kbToggleEl.checked;
      try {
        await chatFetch(`workspaces/${encodeURIComponent(hash)}/kb/enabled`, {
          method: 'PUT',
          body: { enabled },
        });
        const kbBrowser = document.getElementById('chat-ws-kb-browser');
        if (kbBrowser) {
          kbBrowser.innerHTML = chatRenderWorkspaceKbBrowser(enabled);
        }
      } catch (err) {
        alert('Failed to update knowledge base setting: ' + err.message);
        kbToggleEl.checked = !enabled;
      }
    });
  }
}

function chatRenderWorkspaceKbBrowser(enabled) {
  if (!enabled) {
    return `<p style="color:var(--muted);font-size:13px;">Knowledge Base is disabled for this workspace.</p>`;
  }
  // PR 1 ships the enable toggle only — ingestion, entries, and synthesis
  // tabs land in subsequent PRs. A placeholder keeps the empty state
  // informative without pretending features exist yet.
  return `
    <p style="color:var(--muted);font-size:13px;">
      Knowledge Base is enabled. File upload, digestion, and the KB Browser
      land in upcoming releases. For now the CLI receives a pointer to the
      knowledge directory on new sessions.
    </p>
  `;
}

function chatRenderWorkspaceMemoryBrowser(snapshot, enabled, hash) {
  if (!enabled) {
    return `<p style="color:var(--muted);font-size:13px;">Memory is disabled for this workspace.</p>`;
  }
  const files = snapshot?.files || [];
  if (files.length === 0) {
    return `<p style="color:var(--muted);font-size:13px;">No memory entries yet. Entries appear here when Claude Code captures memory on session reset, or when a non-Claude CLI calls the <code>memory_note</code> tool.</p>`;
  }
  const order = ['user', 'feedback', 'project', 'reference', 'unknown'];
  const labels = { user: 'User', feedback: 'Feedback', project: 'Project', reference: 'Reference', unknown: 'Other' };
  const grouped = {};
  for (const t of order) grouped[t] = [];
  for (const f of files) {
    (grouped[f.type] || grouped.unknown).push(f);
  }
  const rows = order
    .filter((t) => grouped[t].length > 0)
    .map((t) => `
      <div class="chat-memory-group">
        <div class="chat-memory-group-header">${esc(labels[t])} <span class="chat-memory-group-count">${grouped[t].length}</span></div>
        <ul class="chat-memory-file-list">
          ${grouped[t].map((f) => {
            const heading = f.name || f.filename;
            const sub = f.description || '';
            return `
              <li class="chat-memory-file">
                <div style="display:flex;align-items:flex-start;gap:8px;">
                  <button type="button" class="chat-memory-file-toggle" data-filename="${esc(f.filename)}" style="flex:1;">
                    <div class="chat-memory-file-heading">${esc(heading)}</div>
                    ${sub ? `<div class="chat-memory-file-desc">${esc(sub)}</div>` : ''}
                    <div class="chat-memory-file-name">${esc(f.filename)}</div>
                  </button>
                  <button type="button" class="chat-memory-file-delete" data-relpath="${esc(f.filename)}" title="Delete entry" style="background:transparent;border:none;color:var(--muted);cursor:pointer;padding:4px;">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M6 4V2.5h4V4M5 4l.5 9h5L11 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  </button>
                </div>
                <pre class="chat-memory-file-body" hidden>${esc(f.content || '')}</pre>
              </li>
            `;
          }).join('')}
        </ul>
      </div>
    `).join('');
  return `
    <div class="chat-memory-groups">${rows}</div>
    <div class="chat-memory-clear-all">
      <button type="button" class="chat-memory-clear-all-btn" data-action="clear-all">Clear all memory</button>
      <span class="chat-memory-clear-all-hint">Removes every entry for this workspace. Cannot be undone.</span>
    </div>
  `;
}

function chatWireWorkspaceMemoryBrowser(container, hash) {
  container.querySelectorAll('.chat-memory-file-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pre = btn.closest('.chat-memory-file')?.querySelector('.chat-memory-file-body');
      if (!pre) return;
      pre.hidden = !pre.hidden;
      btn.classList.toggle('expanded', !pre.hidden);
    });
  });
  container.querySelectorAll('.chat-memory-file-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const relpath = btn.dataset.relpath;
      if (!relpath) return;
      if (!confirm(`Delete memory entry "${relpath}"?`)) return;
      try {
        await chatFetch(`workspaces/${encodeURIComponent(hash)}/memory/entries/${encodeURIComponent(relpath)}`, {
          method: 'DELETE',
        });
        const memRes = await fetch(chatApiUrl(`workspaces/${encodeURIComponent(hash)}/memory`), { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
        container.innerHTML = chatRenderWorkspaceMemoryBrowser(memRes.snapshot || null, Boolean(memRes.enabled), hash);
        chatWireWorkspaceMemoryBrowser(container, hash);
      } catch (err) {
        alert('Failed to delete entry: ' + err.message);
      }
    });
  });
  const clearBtn = container.querySelector('.chat-memory-clear-all-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!confirm('Clear all memory entries for this workspace? This cannot be undone.')) return;
      try {
        await chatFetch(`workspaces/${encodeURIComponent(hash)}/memory/entries`, {
          method: 'DELETE',
        });
        const memRes = await fetch(chatApiUrl(`workspaces/${encodeURIComponent(hash)}/memory`), { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
        container.innerHTML = chatRenderWorkspaceMemoryBrowser(memRes.snapshot || null, Boolean(memRes.enabled), hash);
        chatWireWorkspaceMemoryBrowser(container, hash);
      } catch (err) {
        alert('Failed to clear memory: ' + err.message);
      }
    });
  }
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
