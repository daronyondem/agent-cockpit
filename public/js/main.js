import { state, chatFetch, apiUrl, chatApiUrl, DEFAULT_BACKEND_ICON, KB_ICON_INGEST, KB_ICON_DIGEST, KB_ICON_DREAM, fetchCsrfToken, chatShowSessionExpired } from './state.js';
import { esc, chatFormatTokenCount, chatFormatCost } from './utils.js';
import { applyTheme } from './theme.js';
import { chatShowModal, chatCloseModal, chatShowAlert, chatShowConfirm, chatShowPrompt } from './modal.js';
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
window.chatTriggerServerRestart = chatTriggerServerRestart;
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
      const kbBtn = e.target.closest('.chat-conv-group-kb-btn');
      if (kbBtn) {
        e.stopPropagation();
        chatOpenKbBrowser(kbBtn.dataset.kbHash, kbBtn.dataset.kbLabel);
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
  if (signoutBtn) signoutBtn.onclick = async () => {
    if (await chatShowConfirm('Sign out?', { title: 'Sign Out', confirmLabel: 'Sign Out' })) {
      window.location.href = '/auth/logout';
    }
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
  if (state.chatStreamingConvs.has(convId)) { chatShowAlert('Cannot reset session while streaming.'); return; }
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
    chatShowAlert('Session reset failed: ' + err.message);
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
    chatShowAlert('Failed to load sessions: ' + err.message);
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
      chatShowAlert('Failed to load session: ' + err.message);
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
    chatShowAlert('Download failed: ' + err.message);
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
  const kbDreamConcurrency = kb.dreamingConcurrency || 2;

  const html = `
    <div class="chat-settings-tabs">
      <button class="chat-settings-tab active" data-tab="general">General</button>
      <button class="chat-settings-tab" data-tab="memory">Memory</button>
      <button class="chat-settings-tab" data-tab="kb">Knowledge Base</button>
      <button class="chat-settings-tab" data-tab="usage">Usage Stats</button>
      <button class="chat-settings-tab" data-tab="server">Server</button>
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
          <div class="chat-settings-label">Pandoc (required for DOCX ingestion)</div>
          <div class="chat-settings-desc" id="chat-settings-pandoc-status">Checking…</div>
          <div class="chat-settings-desc" id="chat-settings-pandoc-info">
            Pandoc is an external binary that converts DOCX to Markdown while
            preserving tables. Install it from
            <a href="https://pandoc.org/installing.html" target="_blank" rel="noreferrer">pandoc.org</a>
            or via your package manager (<code>brew install pandoc</code>,
            <code>apt install pandoc</code>, <code>choco install pandoc</code>),
            then restart the server from the <strong>Server</strong> tab so
            detection can re-run. DOCX uploads are rejected until pandoc is
            detected on the server PATH.
          </div>
        </div>
        <div class="chat-settings-group">
          <div class="chat-settings-label">${KB_ICON_DIGEST} Digestion CLI</div>
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
          <div class="chat-settings-label">${KB_ICON_DREAM} Dreaming CLI</div>
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
          <div class="chat-settings-label">Dreaming Concurrency</div>
          <div class="chat-settings-desc">Maximum number of parallel CLI calls during dreaming. Higher values speed up large KBs at the cost of more concurrent resource usage.</div>
          <input type="number" class="chat-settings-select" id="chat-settings-kb-dream-concurrency" min="1" max="10" value="${kbDreamConcurrency}" style="width:80px;" />
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
      <div class="chat-settings-tab-content" id="chat-tab-server" style="display:none;">
        <div class="chat-settings-group">
          <div class="chat-settings-label">Restart Server</div>
          <div class="chat-settings-desc">
            Restart the Agent Cockpit process via pm2. Use this after installing
            external binaries (like <code>pandoc</code> or <code>libreoffice</code>)
            so startup-time detection runs again. Active conversations will be
            aborted, so wait for them to finish first.
          </div>
          <div id="chat-server-restart-status" style="display:none;margin:8px 0;font-size:13px;"></div>
          <button class="chat-settings-save" id="chat-server-restart-btn" onclick="chatTriggerServerRestart()">Restart Server</button>
        </div>
      </div>
    </div>
  `;

  chatShowModal('Settings', html);

  // Fetch cached pandoc status from the server and render it into the KB
  // tab's Pandoc status row. Safe to call multiple times — the endpoint
  // just reads the module-level cache populated at startup.
  async function chatLoadPandocStatus() {
    const el = document.getElementById('chat-settings-pandoc-status');
    const info = document.getElementById('chat-settings-pandoc-info');
    if (!el) return;
    try {
      const res = await fetch(chatApiUrl('kb/pandoc-status'), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const status = await res.json();
      if (status && status.available) {
        const version = status.version ? ` v${status.version}` : '';
        el.innerHTML = `<span style="color:var(--success,#2e7d32);">Detected${esc(version)}</span> at <code>${esc(status.binaryPath || '')}</code>`;
        if (info) {
          info.textContent = 'Pandoc is an external binary that converts DOCX to Markdown while preserving tables.';
        }
      } else {
        el.innerHTML = '<span style="color:var(--error,#d32f2f);">Not found on PATH.</span> DOCX uploads will be rejected until pandoc is installed and the server is restarted.';
      }
    } catch (err) {
      el.textContent = 'Could not check pandoc status: ' + (err && err.message ? err.message : 'unknown error');
    }
  }

  document.querySelectorAll('.chat-settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.chat-settings-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.chat-settings-tab-content').forEach(c => c.style.display = 'none');
      const target = tab.getAttribute('data-tab');
      const panel = document.getElementById('chat-tab-' + target);
      if (panel) panel.style.display = '';
      if (target === 'usage') chatLoadUsageStats();
      if (target === 'kb') chatLoadPandocStatus();
    });
  });

  // Also trigger on first render if KB is the default-visible tab.
  if (document.getElementById('chat-tab-kb')?.style.display !== 'none') {
    chatLoadPandocStatus();
  }

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
  const kbDreamConcurrencyEl = document.getElementById('chat-settings-kb-dream-concurrency');
  if (kbDreamConcurrencyEl) {
    const val = parseInt(kbDreamConcurrencyEl.value, 10);
    if (val >= 1 && val <= 10) knowledgeBase.dreamingConcurrency = val;
  }
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
    chatShowAlert('Failed to save settings: ' + err.message);
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
  if (!await chatShowConfirm('Clear all usage statistics? This cannot be undone.', { title: 'Clear Stats', confirmLabel: 'Clear', destructive: true })) return;
  try {
    await chatFetch('usage-stats', { method: 'DELETE' });
    state._usageStatsCache = { days: [] };
    chatUpdateUsageStats();
  } catch (err) {
    chatShowAlert('Failed to clear usage stats: ' + err.message);
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
        chatShowAlert('Failed to update memory setting: ' + err.message);
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
        // Refresh the sidebar so the KB button (rendered only when KB is
        // enabled for the workspace) appears/disappears without a reload.
        chatLoadConversations();
      } catch (err) {
        chatShowAlert('Failed to update knowledge base setting: ' + err.message);
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
      if (!await chatShowConfirm(`Delete memory entry "${relpath}"?`, { title: 'Delete Entry', confirmLabel: 'Delete', destructive: true })) return;
      try {
        await chatFetch(`workspaces/${encodeURIComponent(hash)}/memory/entries/${encodeURIComponent(relpath)}`, {
          method: 'DELETE',
        });
        const memRes = await fetch(chatApiUrl(`workspaces/${encodeURIComponent(hash)}/memory`), { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
        container.innerHTML = chatRenderWorkspaceMemoryBrowser(memRes.snapshot || null, Boolean(memRes.enabled), hash);
        chatWireWorkspaceMemoryBrowser(container, hash);
      } catch (err) {
        chatShowAlert('Failed to delete entry: ' + err.message);
      }
    });
  });
  const clearBtn = container.querySelector('.chat-memory-clear-all-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!await chatShowConfirm('Clear all memory entries for this workspace? This cannot be undone.', { title: 'Clear Memory', confirmLabel: 'Clear All', destructive: true })) return;
      try {
        await chatFetch(`workspaces/${encodeURIComponent(hash)}/memory/entries`, {
          method: 'DELETE',
        });
        const memRes = await fetch(chatApiUrl(`workspaces/${encodeURIComponent(hash)}/memory`), { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
        container.innerHTML = chatRenderWorkspaceMemoryBrowser(memRes.snapshot || null, Boolean(memRes.enabled), hash);
        chatWireWorkspaceMemoryBrowser(container, hash);
      } catch (err) {
        chatShowAlert('Failed to clear memory: ' + err.message);
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
    chatShowAlert('Failed to save workspace instructions: ' + err.message);
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

// Manual server restart triggered from the "Server" tab in Global Settings.
// Mirrors the success/fetch-failure handling of chatTriggerUpdate: on success
// we briefly show a status line, then flip to the restart overlay while pm2
// cycles the process, then reload. The "Failed to fetch" branch is critical —
// the script kills the process during the request, so the in-flight fetch
// will reject; we treat that as success too.
async function chatTriggerServerRestart() {
  const statusEl = document.getElementById('chat-server-restart-status');
  const btn = document.getElementById('chat-server-restart-btn');
  if (!await chatShowConfirm('Restart the server now? Any active conversations will be aborted.', { title: 'Restart Server', confirmLabel: 'Restart', destructive: true })) return;
  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.innerHTML = '<span style="color:var(--muted);">Requesting restart...</span>';
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Restarting...';
  }

  try {
    const res = await chatFetch('server/restart', { method: 'POST' });
    const result = await res.json().catch(() => ({}));

    if (res.ok && result.success) {
      if (statusEl) {
        statusEl.innerHTML = '<span style="color:var(--done);">Restart launched. Reconnecting...</span>';
      }
      setTimeout(() => chatShowRestartOverlay(), 500);
      setTimeout(() => window.location.reload(), 6000);
    } else {
      if (statusEl) {
        statusEl.innerHTML = '<span style="color:var(--danger);">' + esc(result.error || ('HTTP ' + res.status)) + '</span>';
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Restart Server';
      }
    }
  } catch (err) {
    // The restart script sleeps 2s before killing pm2, so the fetch above
    // usually resolves cleanly. But if the timing races and the process
    // dies first, a "Failed to fetch" is the expected outcome — treat it
    // as success and show the overlay.
    if (err && (err.message === 'Failed to fetch' || err.name === 'TypeError')) {
      chatShowRestartOverlay();
      setTimeout(() => window.location.reload(), 5000);
      return;
    }
    if (statusEl) {
      statusEl.innerHTML = '<span style="color:var(--danger);">Restart failed: ' + esc(err && err.message ? err.message : 'unknown error') + '</span>';
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Restart Server';
    }
  }
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

// ── KB Browser ────────────────────────────────────────────────────────────
// The KB Browser is a main-area view that swaps with the chat messages list
// when the user clicks the KB button on a workspace group header. It is
// NOT bound to a specific conversation — it's workspace-scoped. When it's
// open, any `kb_state_update` WS frame that targets a conversation in the
// same workspace triggers a refetch. A periodic refetch runs on top for
// the standalone case where no conversation is active (and therefore no
// WS is connected) for the viewed workspace.
//
// PR 2 ships only the Raw tab. Entries tab landed in PR 3. Synthesis
// tab in PR 4.

// ── Dream banner ────────────────────────────────────────────────────────────
// Shows in the chat input area when the active conversation's workspace has
// entries awaiting synthesis, or when a dream run is in progress.

function chatUpdateDreamBanner() {
  const banner = document.getElementById('chat-dream-banner');
  if (!banner) return;

  const kb = state.chatActiveConv?.kb;
  if (!kb || !kb.enabled) {
    banner.style.display = 'none';
    return;
  }

  if (kb.dreamingStatus === 'running') {
    const prog = kb._dreamProgress;
    banner.style.display = '';
    banner.innerHTML = `
      <span>Dreaming in progress</span>
      ${chatKbDreamStepperHtml(prog)}
    `;
    chatStartDreamBannerPoll();
    return;
  }

  if (kb.dreamingNeeded && kb.pendingEntries > 0) {
    banner.style.display = '';
    banner.innerHTML = `
      <span>${KB_ICON_DREAM} ${kb.pendingEntries} entr${kb.pendingEntries === 1 ? 'y' : 'ies'} awaiting synthesis</span>
      <button class="chat-dream-banner-btn" onclick="chatTriggerDream()">Dream now</button>
    `;
    return;
  }

  banner.style.display = 'none';
}

async function chatTriggerDream(mode) {
  const conv = state.chatActiveConv;
  if (!conv?.workspaceHash) return;
  const hash = conv.workspaceHash;
  const endpoint = mode === 'redream'
    ? `workspaces/${encodeURIComponent(hash)}/kb/redream`
    : `workspaces/${encodeURIComponent(hash)}/kb/dream`;
  try {
    await chatFetch(endpoint, { method: 'POST' });
    // Optimistically mark as running so the banner updates immediately.
    if (conv.kb) {
      conv.kb.dreamingStatus = 'running';
      conv.kb._dreamProgress = null;
    }
    chatUpdateDreamBanner();
    chatStartDreamBannerPoll();
  } catch (err) {
    chatShowAlert('Failed to start dreaming: ' + err.message);
  }
}
window.chatTriggerDream = chatTriggerDream;
window.chatUpdateDreamBanner = chatUpdateDreamBanner;

// Poll the conversation for dream status changes.  WS frames may not arrive
// when there is no active chat stream.  This timer fires every 2s while the
// banner shows a running dream and self-clears when the dream finishes.
let _dreamBannerPollTimer = null;
function chatStartDreamBannerPoll() {
  if (_dreamBannerPollTimer) return;
  _dreamBannerPollTimer = setInterval(async () => {
    const conv = state.chatActiveConv;
    if (!conv?.kb || conv.kb.dreamingStatus !== 'running') {
      clearInterval(_dreamBannerPollTimer);
      _dreamBannerPollTimer = null;
      return;
    }
    try {
      const r = await chatFetch(`conversations/${conv.id}`);
      const updated = await r.json();
      if (state.chatActiveConvId === conv.id) {
        state.chatActiveConv = updated;
        chatUpdateDreamBanner();
        if (updated.kb?.dreamingStatus !== 'running') {
          clearInterval(_dreamBannerPollTimer);
          _dreamBannerPollTimer = null;
        }
      }
    } catch { /* ignore */ }
  }, 2000);
}

// ── KB Browser ──────────────────────────────────────────────────────────────

/**
 * State for the currently-open KB browser view. `null` when the view is
 * hidden. Fields are all non-persistent — closing and reopening resets
 * everything.
 */
let chatKbBrowserState = null;

/** Expose the kb_state_update handler to streaming.js (wired via window). */
window.chatHandleKbStateUpdate = function chatHandleKbStateUpdate(convId, event) {
  // Update the dream banner if this event targets the active conversation.
  if (convId === state.chatActiveConvId && state.chatActiveConv?.kb) {
    if (event?.changed?.dreamProgress) {
      state.chatActiveConv.kb.dreamingStatus = 'running';
      state.chatActiveConv.kb._dreamProgress = event.changed.dreamProgress;
    } else if (event?.changed?.synthesis) {
      // Synthesis changed but no progress → dream finished or status reset.
      // Refetch the conversation to get updated kb block.
      chatFetch(`conversations/${convId}`).then(r => r.json()).then(conv => {
        if (state.chatActiveConvId === convId) {
          state.chatActiveConv = conv;
          chatUpdateDreamBanner();
        }
      }).catch(() => {});
      // Clear dream elapsed timer.
      if (chatKbBrowserState?.synthesis) {
        chatKbBrowserState.synthesis._dreamStepStart = null;
      }
    }
    chatUpdateDreamBanner();
  }

  // KB Browser: track substep/batch progress and refetch for matching workspace.
  if (!chatKbBrowserState) return;
  const conv = state.chatConversations.find((c) => c.id === convId);
  if (conv && chatKbBrowserState.hash !== conv.workspaceHash) return;

  // Track substep text per raw item.
  if (event?.changed?.substep) {
    const { rawId, text } = event.changed.substep;
    chatKbBrowserState.substeps[rawId] = text;
    // Record processing start time if not already set.
    if (!chatKbBrowserState.processingStartTimes[rawId]) {
      chatKbBrowserState.processingStartTimes[rawId] = Date.now();
    }
  }

  // Track batch digest progress.
  if (event?.changed?.batchProgress) {
    chatKbBrowserState.batchProgress = event.changed.batchProgress;
  }

  // Track dream progress for the stepper.
  if (event?.changed?.dreamProgress) {
    const prev = chatKbBrowserState.synthesis._dreamProgress;
    const next = event.changed.dreamProgress;
    chatKbBrowserState.synthesis._dreamProgress = next;
    chatKbBrowserState.synthesis._status = 'running';
    // Reset step start time when the phase or done count changes.
    if (!prev || prev.phase !== next.phase || prev.done !== next.done) {
      chatKbBrowserState.synthesis._dreamStepStart = Date.now();
    }
  } else if (event?.changed?.synthesis) {
    // Synthesis changed but no progress → dream finished. Clear running state
    // and refetch synthesis data so the UI exits "Starting…" / stepper.
    chatKbBrowserState.synthesis._dreamProgress = null;
    chatKbBrowserState.synthesis._dreamStepStart = null;
    chatKbBrowserRefetchSynthesis();
  }

  // Clear substep + timer when a raw item finishes processing.
  if (event?.changed?.raw) {
    for (const rawId of event.changed.raw) {
      const kbState = chatKbBrowserState.state;
      const rawRow = kbState?.raw?.find((r) => r.rawId === rawId);
      if (rawRow && rawRow.status !== 'ingesting' && rawRow.status !== 'digesting') {
        delete chatKbBrowserState.substeps[rawId];
        delete chatKbBrowserState.processingStartTimes[rawId];
      }
    }
    // Clear batch progress when last item finishes.
    const bp = chatKbBrowserState.batchProgress;
    if (bp && bp.done >= bp.total) {
      chatKbBrowserState.batchProgress = null;
    }
  }

  chatKbBrowserRefetch();
};

async function chatOpenKbBrowser(hash, label) {
  const messagesEl = document.getElementById('chat-messages');
  const browserEl = document.getElementById('chat-kb-browser');
  const inputArea = document.querySelector('.chat-input-area');
  if (!messagesEl || !browserEl) return;

  // Hide the messages view and the input row. We leave the header as-is
  // — the existing header title/buttons stay visible but are effectively
  // dormant while the KB browser is open.
  messagesEl.style.display = 'none';
  if (inputArea) inputArea.style.display = 'none';
  browserEl.style.display = '';

  chatKbBrowserState = {
    hash,
    label,
    activeTab: 'raw',
    enabled: false,
    autoDigest: false,
    state: null,
    pollTimer: null,
    uploading: false,
    selectedFolder: '',
    pandocStatus: null,
    ingestingRawId: null,
    ingestingFilename: null,
    /** Per-rawId substep text, e.g. { rawId: 'abc', text: 'Running CLI…' } */
    substeps: {},
    /** Per-rawId timestamps when a processing status started (for elapsed timer) */
    processingStartTimes: {},
    /** Batch digest progress: { done, total } or null */
    batchProgress: null,
    entries: { loading: false, items: [], selectedEntryId: null, entryBody: '' },
    synthesis: { loading: false, topics: [], connections: [], selectedTopicId: null, topicDetail: null },
    embedding: { config: null, loading: false, healthStatus: null },
    reflections: { loading: false, items: [], selectedId: null, detail: null, typeFilter: 'all' },
  };

  // Initial render with a loading message; refetch populates it.
  browserEl.innerHTML = chatKbBrowserChrome(label, true);
  chatKbBrowserWireChrome();
  chatKbBrowserLoadPandocStatus();
  await chatKbBrowserRefetch();

  // Periodic refetch catches ingestion/digestion progress even when the
  // WS isn't carrying updates for this workspace. 1500ms is snappy enough
  // for the inline state badges.
  chatKbBrowserState.pollTimer = setInterval(() => {
    if (!chatKbBrowserState) return;
    chatKbBrowserRefetch();
    // Also poll synthesis when the tab is active and a dream is running.
    // WS frames may not arrive if no conversation stream is active.
    const synthRunning = chatKbBrowserState.synthesis?._status === 'running';
    const synthGrace = chatKbBrowserState.synthesis?._dreamTriggeredAt && (Date.now() - chatKbBrowserState.synthesis._dreamTriggeredAt < 15000);
    if (chatKbBrowserState.activeTab === 'synthesis' && (synthRunning || synthGrace)) {
      chatKbBrowserRefetchSynthesis();
    }
  }, 1500);
}

function chatCloseKbBrowser() {
  if (chatKbBrowserState?.pollTimer) {
    clearInterval(chatKbBrowserState.pollTimer);
  }
  chatKbBrowserState = null;
  const messagesEl = document.getElementById('chat-messages');
  const browserEl = document.getElementById('chat-kb-browser');
  const inputArea = document.querySelector('.chat-input-area');
  if (browserEl) {
    browserEl.style.display = 'none';
    browserEl.innerHTML = '';
  }
  if (messagesEl) messagesEl.style.display = '';
  if (inputArea) inputArea.style.display = '';
}
window.chatCloseKbBrowser = chatCloseKbBrowser;

function chatKbBrowserChrome(label, loading) {
  const counters = chatKbBrowserState?.state?.counters;
  const countersHtml = counters
    ? `<span class="chat-kb-header-counters" id="chat-kb-header-counters">${counters.rawTotal} files · ${counters.entryCount} entries · ${counters.folderCount} folders</span>`
    : '<span class="chat-kb-header-counters" id="chat-kb-header-counters"></span>';
  const active = chatKbBrowserState?.activeTab || 'raw';
  return `
    <div class="chat-kb-header">
      <h2>Knowledge Base: ${esc(label || 'Workspace')}</h2>
      ${countersHtml}
      <button class="chat-kb-header-close" id="chat-kb-close-btn">Close</button>
    </div>
    <div class="chat-kb-tabs">
      <button class="chat-kb-tab ${active === 'raw' ? 'active' : ''}" data-kb-tab="raw">${KB_ICON_INGEST} Raw</button>
      <button class="chat-kb-tab ${active === 'entries' ? 'active' : ''}" data-kb-tab="entries">${KB_ICON_DIGEST} Entries</button>
      <button class="chat-kb-tab ${active === 'synthesis' ? 'active' : ''}" data-kb-tab="synthesis">${KB_ICON_DREAM} Synthesis</button>
      <button class="chat-kb-tab ${active === 'reflections' ? 'active' : ''}" data-kb-tab="reflections">&#128161; Reflections</button>
      <button class="chat-kb-tab ${active === 'settings' ? 'active' : ''}" data-kb-tab="settings">&#9881; Settings</button>
    </div>
    <div class="chat-kb-tab-content" id="chat-kb-tab-content">
      ${loading ? '<p class="chat-kb-empty">Loading…</p>' : ''}
    </div>
  `;
}

function chatKbBrowserWireChrome() {
  const closeBtn = document.getElementById('chat-kb-close-btn');
  if (closeBtn) closeBtn.onclick = chatCloseKbBrowser;
  document.querySelectorAll('.chat-kb-tab[data-kb-tab]').forEach((el) => {
    el.onclick = () => {
      if (!chatKbBrowserState) return;
      const tab = el.dataset.kbTab;
      if (tab === chatKbBrowserState.activeTab) return;
      chatKbBrowserState.activeTab = tab;
      document.querySelectorAll('.chat-kb-tab[data-kb-tab]').forEach((t) => {
        t.classList.toggle('active', t.dataset.kbTab === tab);
      });
      chatKbBrowserRenderTab();
      if (tab === 'entries') chatKbBrowserRefetchEntries();
      if (tab === 'synthesis') chatKbBrowserRefetchSynthesis();
      if (tab === 'reflections') chatKbBrowserRefetchReflections();
    };
  });
}

async function chatKbBrowserLoadPandocStatus() {
  if (!chatKbBrowserState) return;
  try {
    const res = await fetch(chatApiUrl('kb/pandoc-status'), { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const status = await res.json();
    if (!chatKbBrowserState) return;
    chatKbBrowserState.pandocStatus = status || null;
  } catch {
    if (!chatKbBrowserState) return;
    // Treat a fetch failure the same as "unknown" — don't block the UI on it.
    chatKbBrowserState.pandocStatus = null;
  }
  chatKbBrowserRenderTab();
}

async function chatKbBrowserRefetch() {
  if (!chatKbBrowserState) return;
  const { hash, selectedFolder } = chatKbBrowserState;
  try {
    const folderParam = encodeURIComponent(selectedFolder || '');
    const res = await fetch(
      chatApiUrl(`workspaces/${encodeURIComponent(hash)}/kb?folder=${folderParam}`),
      { credentials: 'same-origin' },
    );
    if (!res.ok) throw new Error(`GET /kb returned ${res.status}`);
    const data = await res.json();
    if (!chatKbBrowserState || chatKbBrowserState.hash !== hash) return;
    chatKbBrowserState.enabled = Boolean(data.enabled);
    chatKbBrowserState.state = data.state || null;
    chatKbBrowserState.autoDigest = Boolean(data.state?.autoDigest);
    // Track processing start times for items that are being ingested/digested.
    const rawItems = data.state?.raw || [];
    for (const raw of rawItems) {
      const isProcessing = raw.status === 'ingesting' || raw.status === 'digesting';
      if (isProcessing && !chatKbBrowserState.processingStartTimes[raw.rawId]) {
        chatKbBrowserState.processingStartTimes[raw.rawId] = Date.now();
      } else if (!isProcessing) {
        delete chatKbBrowserState.processingStartTimes[raw.rawId];
        delete chatKbBrowserState.substeps[raw.rawId];
      }
    }
    // Update counters in the chrome header without re-rendering the whole
    // chrome (that would drop the tab content and focus).
    const countersEl = document.getElementById('chat-kb-header-counters');
    const counters = chatKbBrowserState.state?.counters;
    if (countersEl && counters) {
      countersEl.textContent = `${counters.rawTotal} files · ${counters.entryCount} entries · ${counters.folderCount} folders`;
    }
    // Skip full re-render for the synthesis tab when the D3 graph is live
    // or a dream is running — the separate synthesis poll handles targeted
    // stepper/status updates without destroying the graph simulation.
    const synthIsActive = chatKbBrowserState.synthesis?._status === 'running' || (chatKbBrowserState.synthesis?._dreamTriggeredAt && (Date.now() - chatKbBrowserState.synthesis._dreamTriggeredAt < 15000));
    const skipSynthesis = chatKbBrowserState.activeTab === 'synthesis' && (_kbGraphSim || synthIsActive);
    const skipReflections = chatKbBrowserState.activeTab === 'reflections';
    const skipRender = skipSynthesis || skipReflections;
    if (!skipRender) {
      chatKbBrowserRenderTab();
    }
    chatKbDismissIngestionProgress();
  } catch (err) {
    console.error('[kb] refetch failed:', err);
  }
}

function chatKbBrowserRenderTab() {
  const content = document.getElementById('chat-kb-tab-content');
  if (!content || !chatKbBrowserState) return;

  // While an XHR upload is in flight the progress bar DOM elements are
  // referenced directly by the upload callbacks. Re-rendering via innerHTML
  // would orphan those references and the progress bar would vanish. Skip
  // re-renders entirely until the upload settles — the post-upload refetch
  // will trigger a fresh render.
  if (chatKbBrowserState.uploading) return;

  if (!chatKbBrowserState.enabled) {
    content.innerHTML = `
      <p class="chat-kb-empty">
        Knowledge Base is disabled for this workspace. Enable it under
        Workspace Settings → Knowledge Base to start uploading files.
      </p>
    `;
    return;
  }

  // Preserve scroll position across re-renders — the full innerHTML swap
  // destroys it, and the 1500ms poll + WS frames trigger re-renders often.
  // Save scroll on the outer browser container AND tab-specific scrollable
  // children (entries list + detail pane each have their own overflow).
  const browserEl = document.getElementById('chat-kb-browser');
  const savedBrowserScroll = browserEl ? browserEl.scrollTop : 0;
  const entriesListEl = content.querySelector('.chat-kb-entries-list');
  const entryDetailEl = content.querySelector('.chat-kb-entry-detail');
  const savedEntriesListScroll = entriesListEl ? entriesListEl.scrollTop : 0;
  const savedEntryDetailScroll = entryDetailEl ? entryDetailEl.scrollTop : 0;

  if (chatKbBrowserState.activeTab === 'settings') {
    content.innerHTML = chatKbBrowserSettingsTab();
    chatKbBrowserWireSettingsTab();
  } else if (chatKbBrowserState.activeTab === 'reflections') {
    content.innerHTML = chatKbBrowserReflectionsTab();
    chatKbBrowserWireReflectionsTab();
  } else if (chatKbBrowserState.activeTab === 'synthesis') {
    content.innerHTML = chatKbBrowserSynthesisTab();
    chatKbBrowserWireSynthesisTab();
  } else if (chatKbBrowserState.activeTab === 'entries') {
    content.innerHTML = chatKbBrowserEntriesTab();
    chatKbBrowserWireEntriesTab();
  } else {
    content.innerHTML = chatKbBrowserRawTab(chatKbBrowserState.state);
    chatKbBrowserWireRawTab();
  }

  // Restore scroll positions.
  if (browserEl && savedBrowserScroll) browserEl.scrollTop = savedBrowserScroll;
  const newEntriesListEl = content.querySelector('.chat-kb-entries-list');
  const newEntryDetailEl = content.querySelector('.chat-kb-entry-detail');
  if (newEntriesListEl && savedEntriesListScroll) newEntriesListEl.scrollTop = savedEntriesListScroll;
  if (newEntryDetailEl && savedEntryDetailScroll) newEntryDetailEl.scrollTop = savedEntryDetailScroll;
}

function chatKbBrowserRawTab(kbState) {
  const raws = Array.isArray(kbState?.raw) ? kbState.raw.slice() : [];
  raws.sort((a, b) => (a.filename || '').localeCompare(b.filename || ''));
  const rows = raws.map((r) => chatKbBrowserRawRow(r)).join('');
  const emptyMsg = raws.length === 0
    ? '<p class="chat-kb-empty">No files in this folder. Drop a file or click Upload.</p>'
    : '';

  // Persistent banner when pandoc detection has run and reported
  // "not available". We skip the banner when `pandocStatus` is still
  // null to avoid a flash during the first few hundred ms.
  const pandoc = chatKbBrowserState?.pandocStatus;
  const pandocBanner = pandoc && pandoc.available === false
    ? `
      <div class="chat-kb-banner chat-kb-banner-warn">
        <strong>Pandoc not installed.</strong> DOCX uploads will be rejected
        until you install pandoc and restart Agent Cockpit. Install it from
        <a href="https://pandoc.org/installing.html" target="_blank" rel="noreferrer">pandoc.org</a>
        or via <code>brew install pandoc</code> / <code>apt install pandoc</code>.
        PDF, PPTX, text, and image uploads are unaffected.
      </div>
    `
    : '';

  const counters = kbState?.counters || { pendingCount: 0, rawByStatus: {} };
  const pendingCount = counters.pendingCount || 0;
  const isDigesting = (counters.rawByStatus?.digesting || 0) > 0;
  const digestAllDisabled = pendingCount === 0 || isDigesting;
  const autoDigestOn = Boolean(chatKbBrowserState.autoDigest);
  const selectedFolder = chatKbBrowserState.selectedFolder || '';
  const crumb = chatKbBrowserFormatBreadcrumb(selectedFolder);

  return `
    ${pandocBanner}
    <div class="chat-kb-toolbar">
      <label class="chat-kb-toolbar-switch">
        <input type="checkbox" id="chat-kb-autodigest-toggle" ${autoDigestOn ? 'checked' : ''} />
        <span>Auto-digest new files</span>
      </label>
      <button class="chat-kb-toolbar-btn" id="chat-kb-new-folder-btn">+ Folder</button>
      <button class="chat-kb-toolbar-btn chat-kb-toolbar-btn-primary" id="chat-kb-digest-all-btn" ${digestAllDisabled ? 'disabled' : ''}>
        ${KB_ICON_DIGEST} ${isDigesting ? 'Digesting\u2026' : `Digest All Pending (${pendingCount})`}
      </button>
      ${chatKbBrowserState.batchProgress ? `<span class="chat-kb-batch-progress">${chatKbBrowserState.batchProgress.done} of ${chatKbBrowserState.batchProgress.total} done</span>` : ''}
    </div>
    <div class="chat-kb-raw-layout">
      <aside class="chat-kb-folder-tree">
        ${chatKbBrowserRenderFolderTree(kbState?.folders || [], selectedFolder)}
      </aside>
      <section class="chat-kb-raw-main">
        <div class="chat-kb-breadcrumb">${crumb}</div>
        <div class="chat-kb-upload" id="chat-kb-upload-zone">
          <div class="chat-kb-upload-hint">
            Drop a file here, or click the button. Uploads go to
            <strong>${esc(selectedFolder || '(root)')}</strong>.
          </div>
          <button class="chat-kb-upload-btn" id="chat-kb-upload-btn">Upload file</button>
          <input type="file" id="chat-kb-upload-input" style="display:none;" />
        </div>
        <div class="chat-kb-upload-progress" id="chat-kb-upload-progress"
             style="display:${chatKbBrowserState.ingestingRawId ? '' : 'none'};">
          <div class="chat-kb-upload-progress-label" id="chat-kb-upload-progress-label">${
            chatKbBrowserState.ingestingRawId
              ? `${KB_ICON_INGEST} Ingesting ${esc(chatKbBrowserState.ingestingFilename || '')}…`
              : ''
          }</div>
          <div class="chat-kb-upload-progress-bar">
            <div class="chat-kb-upload-progress-fill${chatKbBrowserState.ingestingRawId ? ' indeterminate' : ''}"
                 id="chat-kb-upload-progress-fill" style="width:${chatKbBrowserState.ingestingRawId ? '100%' : '0%'};"></div>
          </div>
        </div>
        <ul class="chat-kb-raw-list">
          ${rows}
        </ul>
        ${emptyMsg}
      </section>
    </div>
  `;
}

function chatKbBrowserFormatBreadcrumb(folderPath) {
  const parts = (folderPath || '').split('/').filter(Boolean);
  const segments = [`<a href="#" class="chat-kb-crumb-link" data-kb-folder="">root</a>`];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    segments.push(`<a href="#" class="chat-kb-crumb-link" data-kb-folder="${esc(acc)}">${esc(part)}</a>`);
  }
  return segments.join(' <span class="chat-kb-crumb-sep">/</span> ');
}

function chatKbBrowserRenderFolderTree(folders, selectedFolder) {
  // Flatten every folder + implicit ancestors into a sorted set. Root
  // ('') is always rendered at depth 0.
  const allPaths = new Set(['']);
  for (const f of folders) {
    const p = f.folderPath || '';
    if (!p) continue;
    allPaths.add(p);
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      allPaths.add(parts.slice(0, i).join('/'));
    }
  }
  const sorted = Array.from(allPaths).sort();
  return sorted.map((p) => {
    const depth = p ? p.split('/').length : 0;
    const label = p === '' ? '(root)' : p.split('/').pop();
    const isSelected = p === (selectedFolder || '');
    const controls = p !== '' ? `
      <button class="chat-kb-folder-btn" data-kb-folder-rename="${esc(p)}" title="Rename">✎</button>
      <button class="chat-kb-folder-btn chat-kb-folder-btn-del" data-kb-folder-delete="${esc(p)}" title="Delete">×</button>
    ` : '';
    return `
      <div class="chat-kb-folder-row ${isSelected ? 'selected' : ''}" data-kb-folder-select="${esc(p)}" style="padding-left: ${6 + depth * 14}px;">
        <span class="chat-kb-folder-label" title="${esc(p || 'root')}">${esc(label)}</span>
        ${controls}
      </div>
    `;
  }).join('');
}

function chatKbStatusIcon(status) {
  if (status === 'ingesting' || status === 'ingested') return KB_ICON_INGEST;
  if (status === 'digesting' || status === 'digested') return KB_ICON_DIGEST;
  return '';
}

function chatKbFormatElapsed(ms) {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem < 10 ? '0' : ''}${rem}s`;
}

function chatKbBrowserRawRow(raw) {
  const size = chatKbFormatSize(raw.sizeBytes || 0);
  const when = raw.uploadedAt ? chatKbFormatRelative(raw.uploadedAt) : '';
  const errorLine = raw.errorMessage
    ? `<div class="chat-kb-raw-error">${esc(raw.errorMessage)}</div>`
    : '';
  const canDigest = raw.status === 'ingested' || raw.status === 'pending-delete' || raw.status === 'failed';
  const digestBtn = canDigest
    ? `<button class="chat-kb-raw-digest" data-kb-digest="${esc(raw.rawId)}" title="Digest now">${KB_ICON_DIGEST}</button>`
    : '';
  const statusIcon = chatKbStatusIcon(raw.status);

  // Substep + elapsed timer for items being processed.
  let substepHtml = '';
  const isProcessing = raw.status === 'ingesting' || raw.status === 'digesting';
  if (isProcessing && chatKbBrowserState) {
    const substepText = chatKbBrowserState.substeps[raw.rawId] || '';
    const startTime = chatKbBrowserState.processingStartTimes[raw.rawId];
    const elapsed = startTime ? chatKbFormatElapsed(Date.now() - startTime) : '';
    if (substepText || elapsed) {
      substepHtml = `<div class="chat-kb-raw-substep">${esc(substepText)}${elapsed ? `<span class="chat-kb-elapsed">${esc(elapsed)}</span>` : ''}</div>`;
    }
  }

  return `
    <li class="chat-kb-raw-row" data-kb-raw-id="${esc(raw.rawId)}">
      <span class="chat-kb-raw-filename" title="${esc(raw.filename)}">${esc(raw.filename)}</span>
      <span class="chat-kb-raw-meta">${esc(size)} · ${esc(when)}</span>
      <span class="chat-kb-raw-status ${esc(raw.status)}">${statusIcon} ${esc(raw.status)}</span>
      ${digestBtn}
      <button class="chat-kb-raw-delete"
              data-kb-del="${esc(raw.rawId)}"
              data-kb-del-folder="${esc(raw.folderPath || '')}"
              data-kb-del-filename="${esc(raw.filename)}"
              title="Delete this location">×</button>
      ${substepHtml}
      ${errorLine}
    </li>
  `;
}

function chatKbBrowserWireRawTab() {
  const zone = document.getElementById('chat-kb-upload-zone');
  const btn = document.getElementById('chat-kb-upload-btn');
  const input = document.getElementById('chat-kb-upload-input');
  if (btn && input) {
    btn.onclick = () => input.click();
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (f) chatKbUploadFile(f);
      input.value = '';
    };
  }
  if (zone) {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('dragging');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragging');
      const f = e.dataTransfer?.files?.[0];
      if (f) chatKbUploadFile(f);
    });
  }
  document.querySelectorAll('.chat-kb-raw-delete').forEach((el) => {
    el.onclick = () => chatKbDeleteLocation(
      el.dataset.kbDel,
      el.dataset.kbDelFolder || '',
      el.dataset.kbDelFilename || '',
    );
  });
  document.querySelectorAll('.chat-kb-raw-digest').forEach((el) => {
    el.onclick = () => chatKbDigestRaw(el.dataset.kbDigest);
  });
  document.querySelectorAll('[data-kb-folder-select]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('[data-kb-folder-rename],[data-kb-folder-delete]')) return;
      chatKbBrowserSelectFolder(el.dataset.kbFolderSelect || '');
    };
  });
  document.querySelectorAll('[data-kb-folder-rename]').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      chatKbBrowserRenameFolder(el.dataset.kbFolderRename || '');
    };
  });
  document.querySelectorAll('[data-kb-folder-delete]').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      chatKbBrowserDeleteFolder(el.dataset.kbFolderDelete || '');
    };
  });
  document.querySelectorAll('.chat-kb-crumb-link').forEach((el) => {
    el.onclick = (e) => {
      e.preventDefault();
      chatKbBrowserSelectFolder(el.dataset.kbFolder || '');
    };
  });
  const autoDigestEl = document.getElementById('chat-kb-autodigest-toggle');
  if (autoDigestEl) autoDigestEl.onchange = () => chatKbBrowserToggleAutoDigest(autoDigestEl.checked);
  const newFolderBtn = document.getElementById('chat-kb-new-folder-btn');
  if (newFolderBtn) newFolderBtn.onclick = chatKbBrowserCreateFolder;
  const digestAllBtn = document.getElementById('chat-kb-digest-all-btn');
  if (digestAllBtn) digestAllBtn.onclick = chatKbBrowserDigestAll;
}

function chatKbBrowserSelectFolder(folderPath) {
  if (!chatKbBrowserState) return;
  chatKbBrowserState.selectedFolder = folderPath || '';
  chatKbBrowserRefetch();
}

async function chatKbBrowserToggleAutoDigest(enabled) {
  if (!chatKbBrowserState) return;
  try {
    await chatFetch(
      `workspaces/${encodeURIComponent(chatKbBrowserState.hash)}/kb/auto-digest`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoDigest: enabled }),
      },
    );
    chatKbBrowserState.autoDigest = enabled;
    await chatKbBrowserRefetch();
  } catch (err) {
    chatShowAlert('Could not update auto-digest: ' + err.message);
    const el = document.getElementById('chat-kb-autodigest-toggle');
    if (el) el.checked = !enabled;
  }
}

async function chatKbBrowserCreateFolder() {
  if (!chatKbBrowserState) return;
  const parent = chatKbBrowserState.selectedFolder || '';
  const parentLabel = parent || '(root)';
  const name = await chatShowPrompt(`Folder name (created inside ${parentLabel}):`, { title: 'New Folder' });
  if (!name || !name.trim()) return;
  const folderPath = parent ? `${parent}/${name.trim()}` : name.trim();
  try {
    await chatFetch(
      `workspaces/${encodeURIComponent(chatKbBrowserState.hash)}/kb/folders`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath }),
      },
    );
    await chatKbBrowserRefetch();
  } catch (err) {
    chatShowAlert('Could not create folder: ' + err.message);
  }
}

async function chatKbBrowserRenameFolder(fromPath) {
  if (!chatKbBrowserState || !fromPath) return;
  const toPath = await chatShowPrompt(`Rename folder "${fromPath}" to:`, { title: 'Rename Folder', defaultValue: fromPath });
  if (!toPath || toPath === fromPath) return;
  try {
    await chatFetch(
      `workspaces/${encodeURIComponent(chatKbBrowserState.hash)}/kb/folders`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromPath, toPath: toPath.trim() }),
      },
    );
    // If the renamed folder was the selected one (or an ancestor),
    // rebase the selection so we don't fetch a ghost path next tick.
    if (
      chatKbBrowserState.selectedFolder === fromPath ||
      chatKbBrowserState.selectedFolder.startsWith(`${fromPath}/`)
    ) {
      chatKbBrowserState.selectedFolder =
        chatKbBrowserState.selectedFolder.replace(fromPath, toPath.trim());
    }
    await chatKbBrowserRefetch();
  } catch (err) {
    chatShowAlert('Could not rename folder: ' + err.message);
  }
}

async function chatKbBrowserDeleteFolder(folderPath) {
  if (!chatKbBrowserState || !folderPath) return;
  if (!await chatShowConfirm(`Delete folder "${folderPath}" and everything in it?`, { title: 'Delete Folder', confirmLabel: 'Delete', destructive: true })) return;
  try {
    await chatFetch(
      `workspaces/${encodeURIComponent(chatKbBrowserState.hash)}/kb/folders?folder=${encodeURIComponent(folderPath)}&cascade=true`,
      { method: 'DELETE' },
    );
    // If we were looking at the deleted folder (or a descendant),
    // fall back to root.
    if (
      chatKbBrowserState.selectedFolder === folderPath ||
      chatKbBrowserState.selectedFolder.startsWith(`${folderPath}/`)
    ) {
      chatKbBrowserState.selectedFolder = '';
    }
    await chatKbBrowserRefetch();
  } catch (err) {
    chatShowAlert('Could not delete folder: ' + err.message);
  }
}

async function chatKbBrowserDigestAll() {
  if (!chatKbBrowserState) return;
  // Derive guard from counters — isDigesting is computed in the template.
  const counters = chatKbBrowserState.state?.counters || {};
  if ((counters.rawByStatus?.digesting || 0) > 0) return;
  if (!await chatShowConfirm('Run digestion for every pending file in this workspace?', { title: 'Digest All', confirmLabel: 'Digest All' })) return;
  await chatFetch(
    `workspaces/${encodeURIComponent(chatKbBrowserState.hash)}/kb/digest-all`,
    { method: 'POST' },
  );
  // The 202 fires immediately; refetch picks up the status change from
  // the background work. The button auto-disables via isDigesting.
  await chatKbBrowserRefetch();
}

// ── Entries tab ─────────────────────────────────────────────────────────────

async function chatKbBrowserRefetchEntries() {
  if (!chatKbBrowserState) return;
  chatKbBrowserState.entries.loading = true;
  try {
    const url = chatApiUrl(
      `workspaces/${encodeURIComponent(chatKbBrowserState.hash)}/kb/entries`,
    );
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`GET /kb/entries returned ${res.status}`);
    const data = await res.json();
    if (!chatKbBrowserState) return;
    chatKbBrowserState.entries.items = Array.isArray(data.entries) ? data.entries : [];
  } catch (err) {
    console.error('[kb] entries refetch failed:', err);
  } finally {
    if (chatKbBrowserState) {
      chatKbBrowserState.entries.loading = false;
      if (chatKbBrowserState.activeTab === 'entries') chatKbBrowserRenderTab();
    }
  }
}

function chatKbBrowserEntriesTab() {
  const s = chatKbBrowserState.entries;
  const items = Array.isArray(s.items) ? s.items : [];
  if (s.loading && items.length === 0) {
    return '<p class="chat-kb-empty">Loading entries…</p>';
  }
  if (items.length === 0) {
    return '<p class="chat-kb-empty">No entries yet. Upload files and digest them to populate this list.</p>';
  }
  const rows = items.map((e) => {
    const isSelected = e.entryId === s.selectedEntryId;
    const tagBadges = (e.tags || [])
      .slice(0, 6)
      .map((t) => `<span class="chat-kb-entry-tag">${esc(t)}</span>`)
      .join('');
    return `
      <li class="chat-kb-entry-row ${isSelected ? 'selected' : ''}" data-kb-entry-id="${esc(e.entryId)}">
        <div class="chat-kb-entry-title">${esc(e.title || e.entryId)}</div>
        <div class="chat-kb-entry-summary">${esc(e.summary || '')}</div>
        <div class="chat-kb-entry-tags">${tagBadges}</div>
      </li>
    `;
  }).join('');
  const bodyHtml = s.selectedEntryId && s.entryBody
    ? `<pre class="chat-kb-entry-body">${esc(s.entryBody)}</pre>`
    : '<p class="chat-kb-empty">Click an entry to preview its body.</p>';
  return `
    <div class="chat-kb-entries-layout">
      <ul class="chat-kb-entries-list">${rows}</ul>
      <div class="chat-kb-entry-detail">${bodyHtml}</div>
    </div>
  `;
}

function chatKbBrowserWireEntriesTab() {
  document.querySelectorAll('[data-kb-entry-id]').forEach((el) => {
    el.onclick = () => chatKbBrowserOpenEntry(el.dataset.kbEntryId);
  });
}

async function chatKbBrowserOpenEntry(entryId) {
  if (!chatKbBrowserState || !entryId) return;
  chatKbBrowserState.entries.selectedEntryId = entryId;
  chatKbBrowserState.entries.entryBody = '';
  chatKbBrowserRenderTab();
  try {
    const url = chatApiUrl(
      `workspaces/${encodeURIComponent(chatKbBrowserState.hash)}/kb/entries/${encodeURIComponent(entryId)}`,
    );
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`GET /kb/entries/${entryId} returned ${res.status}`);
    const data = await res.json();
    if (!chatKbBrowserState || chatKbBrowserState.entries.selectedEntryId !== entryId) return;
    chatKbBrowserState.entries.entryBody = data.body || '';
    chatKbBrowserRenderTab();
  } catch (err) {
    chatShowAlert('Could not load entry: ' + err.message);
  }
}

async function chatKbUploadFile(file) {
  if (!chatKbBrowserState || chatKbBrowserState.uploading) return;
  chatKbBrowserState.uploading = true;
  const btn = document.getElementById('chat-kb-upload-btn');
  if (btn) btn.disabled = true;

  // Grab the three progress elements once up front — the browser tab
  // isn't re-rendered while an upload is in flight, so these references
  // stay valid for the lifetime of the request.
  const progressEl = document.getElementById('chat-kb-upload-progress');
  const labelEl = document.getElementById('chat-kb-upload-progress-label');
  const fillEl = document.getElementById('chat-kb-upload-progress-fill');
  if (progressEl) progressEl.style.display = '';
  if (fillEl) {
    fillEl.classList.remove('indeterminate');
    fillEl.style.width = '0%';
  }
  if (labelEl) labelEl.textContent = `Uploading ${file.name}…`;

  // fetch() can't report upload progress, so we fall back to
  // XMLHttpRequest just like `chatUploadSingleFile` does for
  // conversation file chips. We reuse the same CSRF + credentials setup.
  let uploadedRawId = null;
  try {
    if (!state.csrfToken) await fetchCsrfToken();
    uploadedRawId = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const fd = new FormData();
      fd.append('file', file);
      if (chatKbBrowserState.selectedFolder) {
        fd.append('folder', chatKbBrowserState.selectedFolder);
      }
      xhr.open(
        'POST',
        chatApiUrl(`workspaces/${encodeURIComponent(chatKbBrowserState.hash)}/kb/raw`),
      );
      xhr.setRequestHeader('x-csrf-token', state.csrfToken || '');
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        if (fillEl) fillEl.style.width = `${pct}%`;
        if (labelEl) {
          labelEl.textContent = `Uploading ${file.name} — ${pct}% (${chatKbFormatSize(e.loaded)} / ${chatKbFormatSize(e.total)})`;
        }
      };
      xhr.upload.onload = () => {
        if (fillEl) {
          fillEl.style.width = '100%';
          fillEl.classList.add('indeterminate');
        }
        if (labelEl) labelEl.textContent = `Processing ${file.name}…`;
      };
      xhr.onload = () => {
        if (xhr.status === 401) {
          chatShowSessionExpired();
          reject(new Error('Session expired'));
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          let rawId = null;
          try {
            const body = JSON.parse(xhr.responseText);
            rawId = body?.entry?.rawId || null;
          } catch { /* ignore */ }
          resolve(rawId);
          return;
        }
        let message = `HTTP ${xhr.status}`;
        try {
          const body = JSON.parse(xhr.responseText);
          if (body && body.error) message = body.error;
        } catch {
          // Response wasn't JSON — keep the HTTP status fallback.
        }
        reject(new Error(message));
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.onabort = () => reject(new Error('Upload aborted'));
      xhr.send(fd);
    });
    // Start tracking ingestion progress so the progress bar survives the
    // upcoming refetch render cycle (the template checks ingestingRawId).
    if (uploadedRawId && chatKbBrowserState) {
      chatKbBrowserState.ingestingRawId = uploadedRawId;
      chatKbBrowserState.ingestingFilename = file.name;
    }
    // Refetch so the file appears in the list immediately. The template
    // will render the progress bar in "Ingesting…" mode because
    // ingestingRawId is set. chatKbDismissIngestionProgress (called at
    // the end of refetch) will clear it if the raw already left ingesting.
    await chatKbBrowserRefetch();
  } catch (err) {
    chatShowAlert('Upload failed: ' + err.message);
    chatKbHideUploadProgress();
  } finally {
    chatKbBrowserState.uploading = false;
    const btn2 = document.getElementById('chat-kb-upload-btn');
    if (btn2) btn2.disabled = false;
  }
}

/** Clear ingestion tracking state. The next render cycle will hide the bar. */
function chatKbHideUploadProgress() {
  if (chatKbBrowserState) {
    chatKbBrowserState.ingestingRawId = null;
    chatKbBrowserState.ingestingFilename = null;
  }
}

/**
 * Called after every refetch — if we're tracking an ingesting rawId and
 * it has left the `ingesting` status, clear tracking and re-render so
 * the progress bar disappears from the template.
 */
function chatKbDismissIngestionProgress() {
  if (!chatKbBrowserState?.ingestingRawId) return;
  const rawId = chatKbBrowserState.ingestingRawId;
  const raw = (chatKbBrowserState.state?.raw || []).find((r) => r.rawId === rawId);
  // Dismiss if the raw has moved past ingesting OR disappeared from the
  // current page (e.g. user navigated to a different folder).
  if (!raw || raw.status !== 'ingesting') {
    chatKbHideUploadProgress();
  }
}

async function chatKbDeleteLocation(rawId, folderPath, filename) {
  if (!chatKbBrowserState || !rawId) return;
  if (!await chatShowConfirm(`Delete "${filename}" from this folder?\n\nIf it's the last location, the raw file and its entries will be removed.`, { title: 'Delete File', confirmLabel: 'Delete', destructive: true })) return;
  try {
    let url = `workspaces/${encodeURIComponent(chatKbBrowserState.hash)}/kb/raw/${encodeURIComponent(rawId)}`;
    if (filename) {
      url += `?folder=${encodeURIComponent(folderPath || '')}&filename=${encodeURIComponent(filename)}`;
    }
    await chatFetch(url, { method: 'DELETE' });
    await chatKbBrowserRefetch();
  } catch (err) {
    chatShowAlert('Delete failed: ' + err.message);
  }
}

async function chatKbDigestRaw(rawId) {
  if (!chatKbBrowserState || !rawId) return;
  await chatFetch(
    `workspaces/${encodeURIComponent(chatKbBrowserState.hash)}/kb/raw/${encodeURIComponent(rawId)}/digest`,
    { method: 'POST' },
  );
  await chatKbBrowserRefetch();
}

function chatKbFormatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function chatKbFormatRelative(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const delta = Math.max(0, Date.now() - then);
  const min = Math.floor(delta / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

// ── KB Browser: Synthesis tab ────────────────────────────────────────────────

async function chatKbBrowserRefetchSynthesis() {
  if (!chatKbBrowserState) return;
  chatKbBrowserState.synthesis.loading = true;
  try {
    const url = chatApiUrl(
      `workspaces/${encodeURIComponent(chatKbBrowserState.hash)}/kb/synthesis`,
    );
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`GET /kb/synthesis returned ${res.status}`);
    const data = await res.json();
    if (!chatKbBrowserState) return;
    chatKbBrowserState.synthesis.topics = Array.isArray(data.topics) ? data.topics : [];
    chatKbBrowserState.synthesis.connections = Array.isArray(data.connections) ? data.connections : [];
    // Grace period: when we just triggered a dream, the server may not yet
    // report 'running'. Preserve the optimistic status for up to 15 seconds.
    const triggered = chatKbBrowserState.synthesis._dreamTriggeredAt || 0;
    const inGrace = triggered && (Date.now() - triggered < 15000);
    if (data.status === 'running' || !inGrace) {
      chatKbBrowserState.synthesis._status = data.status;
    }
    if (data.status === 'running' && triggered) {
      chatKbBrowserState.synthesis._dreamTriggeredAt = null;
    }
    chatKbBrowserState.synthesis._lastRunAt = data.lastRunAt;
    chatKbBrowserState.synthesis._lastRunError = data.lastRunError;
    chatKbBrowserState.synthesis._needsSynthesisCount = data.needsSynthesisCount || 0;
    if (data.status !== 'running' && !inGrace) {
      // Dream finished — clear progress state.
      chatKbBrowserState.synthesis._dreamProgress = null;
      chatKbBrowserState.synthesis._dreamStepStart = null;
    } else if (data.dreamProgress) {
      // Dream running — update progress from REST (WS may not be connected).
      const prev = chatKbBrowserState.synthesis._dreamProgress;
      const next = data.dreamProgress;
      chatKbBrowserState.synthesis._dreamProgress = next;
      if (!prev || prev.phase !== next.phase || prev.done !== next.done) {
        chatKbBrowserState.synthesis._dreamStepStart = Date.now();
      }
    }
  } catch (err) {
    console.error('[kb] synthesis refetch failed:', err);
  } finally {
    if (chatKbBrowserState) {
      chatKbBrowserState.synthesis.loading = false;
      if (chatKbBrowserState.activeTab === 'synthesis') {
        // Try a targeted DOM patch for the stepper + status to avoid flicker.
        // Fall back to a full re-render when the DOM elements aren't present
        // (e.g. first render, or status just changed to/from running).
        if (!chatKbSynthesisInPlaceUpdate()) {
          chatKbBrowserRenderTab();
        }
      }
    }
  }
}

/**
 * Patch the synthesis stepper and status line in-place without a full
 * innerHTML swap.  Returns true if the patch succeeded, false if a full
 * re-render is needed (DOM elements missing or status transitioned).
 */
function chatKbSynthesisInPlaceUpdate() {
  const stepperSlot = document.getElementById('chat-kb-dream-stepper-slot');
  const statusSlot = document.getElementById('chat-kb-dream-status-line');
  if (!stepperSlot || !statusSlot || !chatKbBrowserState) return false;

  const s = chatKbBrowserState.synthesis;
  const isRunning = s._status === 'running';

  // If the running state changed since last render, force a full re-render
  // so buttons enable/disable and the layout updates.
  const dreamBtn = document.getElementById('chat-kb-dream-btn');
  const wasRunning = dreamBtn?.disabled;
  if (isRunning !== wasRunning) return false;

  // Update stepper.
  if (isRunning) {
    stepperSlot.innerHTML = chatKbDreamStepperHtml(s._dreamProgress);
  } else {
    stepperSlot.innerHTML = '';
  }

  // Update status line.
  const lastRun = s._lastRunAt ? chatKbFormatRelative(s._lastRunAt) : 'never';
  const lastErr = s._lastRunError || '';
  const pending = s._needsSynthesisCount || 0;
  let html = `<span class="chat-kb-dream-status">Last run: ${esc(lastRun)}</span>`;
  if (pending > 0) html += ` · <span class="chat-kb-dream-status">${pending} pending</span>`;
  if (lastErr) html += ` · <span class="chat-kb-dream-status" style="color:var(--error);">${esc(lastErr)}</span>`;
  statusSlot.innerHTML = html;

  return true;
}

function chatKbDreamStepperHtml(prog) {
  if (!prog) {
    return '<div class="chat-kb-dream-stepper"><span class="chat-kb-dream-step active"><span class="chat-dream-banner-spinner"></span> Starting\u2026</span></div>';
  }
  const stepStart = chatKbBrowserState?.synthesis?._dreamStepStart;
  const elapsed = stepStart ? ` \u2014 ${chatKbFormatElapsed(Date.now() - stepStart)}` : '';
  // Four phases: routing → verification → synthesis → discovery
  const phases = ['routing', 'verification', 'synthesis', 'discovery', 'reflection'];
  const currentIdx = phases.indexOf(prog.phase);
  const steps = phases.map((phase, idx) => {
    const label = phase.charAt(0).toUpperCase() + phase.slice(1);
    let cls = '';
    let content = label;
    if (idx < currentIdx) {
      cls = 'done';
      content = '\u2713 ' + label;
    } else if (idx === currentIdx) {
      cls = 'active';
      content = `${label} ${prog.done}/${prog.total}`;
    }
    const spinner = idx === currentIdx ? '<span class="chat-dream-banner-spinner"></span> ' : '';
    return `<span class="chat-kb-dream-step ${cls}">${spinner}${esc(content)}</span>`;
  });
  const arrows = steps.reduce((acc, step, i) =>
    i === 0 ? step : acc + '<span class="chat-kb-dream-step-arrow"></span>' + step, '');
  const activeElapsed = currentIdx >= 0 ? elapsed : '';
  return `<div class="chat-kb-dream-stepper">${arrows}${activeElapsed ? `<span class="chat-kb-elapsed" style="color:var(--muted);opacity:0.7;font-variant-numeric:tabular-nums;font-size:12px;margin-left:8px;">${activeElapsed}</span>` : ''}</div>`;
}

function chatKbBrowserSynthesisTab() {
  const s = chatKbBrowserState.synthesis;

  const topics = Array.isArray(s.topics) ? s.topics : [];
  if (s.loading && topics.length === 0) {
    return '<p class="chat-kb-empty">Loading synthesis data\u2026</p>';
  }

  // Action bar: Dream / Re-dream buttons + status + search
  const pending = s._needsSynthesisCount || 0;
  const isRunning = s._status === 'running';
  const lastRun = s._lastRunAt ? chatKbFormatRelative(s._lastRunAt) : 'never';
  const lastErr = s._lastRunError || '';
  const hash = chatKbBrowserState.hash;

  let statusHtml = `<span class="chat-kb-dream-status">Last run: ${esc(lastRun)}</span>`;
  if (pending > 0) {
    statusHtml += ` \u00b7 <span class="chat-kb-dream-status">${pending} pending</span>`;
  }
  if (lastErr) {
    statusHtml += ` \u00b7 <span class="chat-kb-dream-status" style="color:var(--error);">${esc(lastErr)}</span>`;
  }

  let stepperHtml = '';
  if (isRunning) {
    stepperHtml = chatKbDreamStepperHtml(s._dreamProgress);
  }

  const actionsHtml = `
    <div class="chat-kb-synthesis-actions">
      <button class="chat-kb-dream-btn" id="chat-kb-dream-btn"${isRunning ? ' disabled' : ''} data-dream-hash="${esc(hash)}">
        ${isRunning ? '<span class="chat-dream-banner-spinner"></span> Dreaming\u2026' : `${KB_ICON_DREAM} Dream`}
      </button>
      <button class="chat-kb-dream-btn" id="chat-kb-redream-btn"${isRunning ? ' disabled' : ''} data-dream-hash="${esc(hash)}" style="opacity:0.7;">
        Re-Dream (full rebuild)
      </button>
      <span id="chat-kb-dream-status-line">${statusHtml}</span>
      <span id="chat-kb-dream-stepper-slot">${stepperHtml}</span>
      <span style="flex:1;"></span>
      <input type="text" id="chat-kb-graph-search" class="chat-kb-graph-search" placeholder="Search topics\u2026" />
    </div>
  `;

  if (topics.length === 0) {
    return actionsHtml + '<p class="chat-kb-empty">No topics yet. Run a dream cycle to synthesize entries into topics.</p>';
  }

  return actionsHtml + `
    <div class="chat-kb-graph-layout">
      <div id="chat-kb-graph-container" class="chat-kb-graph-container"></div>
      <div id="chat-kb-graph-panel" class="chat-kb-graph-panel">
        <div class="chat-kb-graph-panel-empty">Click a node to view details</div>
      </div>
    </div>`;
}

// ── D3 Force Graph ─────────────────────────────────────────────────────────

let _kbGraphSim = null; // D3 simulation reference

function chatKbGraphInit() {
  const container = document.getElementById('chat-kb-graph-container');
  if (!container || typeof d3 === 'undefined') return;

  const s = chatKbBrowserState.synthesis;
  const topics = Array.isArray(s.topics) ? s.topics : [];
  const connections = Array.isArray(s.connections) ? s.connections : [];
  if (topics.length === 0) return;

  // Stop any prior simulation.
  if (_kbGraphSim) { _kbGraphSim.stop(); _kbGraphSim = null; }

  // Build nodes + links.
  const topicMap = new Map(topics.map((t) => [t.topicId, t]));
  const nodes = topics.map((t) => ({
    id: t.topicId,
    title: t.title,
    entryCount: t.entryCount || 0,
    connectionCount: t.connectionCount || 0,
    isGodNode: Boolean(t.isGodNode),
  }));
  const links = connections
    .filter((c) => topicMap.has(c.sourceTopic) && topicMap.has(c.targetTopic))
    .map((c) => ({
      source: c.sourceTopic,
      target: c.targetTopic,
      relationship: c.relationship || '',
      confidence: c.confidence || 'inferred',
    }));

  // Dimensions.
  const rect = container.getBoundingClientRect();
  const width = rect.width || 800;
  const height = rect.height || 500;

  // Clear container.
  container.innerHTML = '';

  const svg = d3.select(container)
    .append('svg')
    .attr('width', '100%')
    .attr('height', '100%')
    .attr('viewBox', [0, 0, width, height]);

  // Zoom group.
  const g = svg.append('g');

  // Read computed theme colors from CSS custom properties.
  const cs = getComputedStyle(document.documentElement);
  const themeText = cs.getPropertyValue('--text').trim() || '#e4e6eb';
  const themeMuted = cs.getPropertyValue('--muted').trim() || '#8b8fa5';
  const themeBorder = cs.getPropertyValue('--border').trim() || '#2e3242';

  // Arrow markers for directed edges.
  const defs = svg.append('defs');
  ['extracted', 'inferred', 'speculative'].forEach((conf) => {
    defs.append('marker')
      .attr('id', `arrow-${conf}`)
      .attr('viewBox', '0 -4 8 8')
      .attr('refX', 20)
      .attr('refY', 0)
      .attr('markerWidth', 5)
      .attr('markerHeight', 5)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-3L6,0L0,3')
      .attr('fill', conf === 'extracted' ? themeMuted : themeBorder);
  });

  // Edge styles by confidence.
  function edgeDash(conf) {
    if (conf === 'extracted') return 'none';
    if (conf === 'inferred') return '6,3';
    return '2,3';
  }
  function edgeOpacity(conf) {
    if (conf === 'extracted') return 0.45;
    if (conf === 'inferred') return 0.3;
    return 0.15;
  }

  // Links.
  const link = g.append('g')
    .selectAll('line')
    .data(links)
    .join('line')
    .attr('stroke', themeMuted)
    .attr('stroke-width', 1)
    .attr('stroke-dasharray', (d) => edgeDash(d.confidence))
    .attr('stroke-opacity', (d) => edgeOpacity(d.confidence))
    .attr('marker-end', (d) => `url(#arrow-${d.confidence})`);

  // Node sizing: min 16, scale by entryCount.
  const maxEntries = Math.max(1, ...nodes.map((n) => n.entryCount));
  function nodeRadius(d) {
    return 16 + 12 * (d.entryCount / maxEntries);
  }

  // Node groups.
  const node = g.append('g')
    .selectAll('g')
    .data(nodes)
    .join('g')
    .attr('class', 'chat-kb-graph-node')
    .call(d3.drag()
      .on('start', dragStarted)
      .on('drag', dragged)
      .on('end', dragEnded));

  // Node circles.
  node.append('circle')
    .attr('r', nodeRadius)
    .attr('fill', (d) => d.isGodNode ? 'rgba(234, 179, 8, 0.10)' : 'rgba(148, 163, 184, 0.08)')
    .attr('stroke', (d) => d.isGodNode ? 'rgba(234, 179, 8, 0.50)' : 'rgba(148, 163, 184, 0.35)')
    .attr('stroke-width', 1);

  // Node entry count (single number — hover/click for full title).
  node.append('text')
    .text((d) => d.entryCount)
    .attr('text-anchor', 'middle')
    .attr('dy', 4)
    .attr('font-size', 11)
    .attr('font-weight', 500)
    .attr('fill', (d) => d.isGodNode ? 'rgba(234, 179, 8, 0.85)' : themeMuted)
    .style('pointer-events', 'none');

  // Zoom-based short labels — appear when zoomed past 1.5x.
  const zoomLabel = g.append('g')
    .selectAll('text')
    .data(nodes)
    .join('text')
    .text((d) => {
      const words = d.title.split(/\s+/);
      return words.length <= 2 ? d.title : words.slice(0, 2).join(' ') + '\u2026';
    })
    .attr('text-anchor', 'middle')
    .attr('dy', (d) => nodeRadius(d) + 13)
    .attr('font-size', 9)
    .attr('fill', themeMuted)
    .attr('opacity', 0)
    .style('pointer-events', 'none');

  // Update zoom handler to show/hide labels.
  let _currentZoomScale = 1;
  const zoomBehavior = d3.zoom()
    .scaleExtent([0.1, 4])
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
      const prev = _currentZoomScale >= 1.5;
      _currentZoomScale = event.transform.k;
      const now = _currentZoomScale >= 1.5;
      if (prev !== now) zoomLabel.attr('opacity', now ? 0.85 : 0);
    });
  svg.call(zoomBehavior);

  // Track selected node for highlight.
  let _selectedNodeId = null;
  function updateNodeHighlight() {
    node.select('circle')
      .attr('stroke', (d) => {
        if (d.id === _selectedNodeId) return 'var(--accent-chat)';
        return d.isGodNode ? 'rgba(234, 179, 8, 0.50)' : 'rgba(148, 163, 184, 0.35)';
      })
      .attr('stroke-width', (d) => d.id === _selectedNodeId ? 2 : 1);
  }

  // Click → detail panel.
  node.on('click', (event, d) => {
    event.stopPropagation();
    _selectedNodeId = d.id;
    updateNodeHighlight();
    chatKbGraphShowPanel(d);
  });

  // Click background → clear panel + selection.
  svg.on('click', () => {
    _selectedNodeId = null;
    updateNodeHighlight();
    chatKbGraphClearPanel();
  });

  // Tooltip on hover.
  node.append('title').text((d) => `${d.title}\n${d.entryCount} entries \u00b7 ${d.connectionCount} connections`);

  // Force simulation.
  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id((d) => d.id).distance(120))
    .force('charge', d3.forceManyBody().strength(-300))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius((d) => nodeRadius(d) + 8))
    .on('tick', () => {
      link
        .attr('x1', (d) => d.source.x)
        .attr('y1', (d) => d.source.y)
        .attr('x2', (d) => d.target.x)
        .attr('y2', (d) => d.target.y);
      node.attr('transform', (d) => `translate(${d.x},${d.y})`);
      zoomLabel.attr('x', (d) => d.x).attr('y', (d) => d.y);
    });

  _kbGraphSim = sim;

  // Drag handlers.
  function dragStarted(event, d) {
    if (!event.active) sim.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }
  function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  }
  function dragEnded(event, d) {
    if (!event.active) sim.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }

  // Search-to-focus.
  const searchInput = document.getElementById('chat-kb-graph-search');
  if (searchInput) {
    searchInput.oninput = () => {
      const q = searchInput.value.toLowerCase().trim();
      if (!q) {
        node.attr('opacity', 1);
        link.attr('stroke-opacity', (d) => edgeOpacity(d.confidence));
        return;
      }
      const matchIds = new Set(nodes.filter((n) => n.title.toLowerCase().includes(q)).map((n) => n.id));
      node.attr('opacity', (d) => matchIds.has(d.id) ? 1 : 0.15);
      link.attr('stroke-opacity', (d) =>
        matchIds.has(d.source.id || d.source) || matchIds.has(d.target.id || d.target) ? edgeOpacity(d.confidence) : 0.03);

      // Zoom to first match.
      if (matchIds.size > 0) {
        const firstMatch = nodes.find((n) => matchIds.has(n.id));
        if (firstMatch && firstMatch.x != null) {
          svg.transition().duration(400).call(
            zoomBehavior.transform,
            d3.zoomIdentity.translate(width / 2 - firstMatch.x, height / 2 - firstMatch.y),
          );
        }
      }
    };
  }
}

// ── Graph detail panel (right side) ───────────────────────────────────────

function chatKbGraphShowPanel(nodeData) {
  const panel = document.getElementById('chat-kb-graph-panel');
  if (!panel) return;

  const godBadge = nodeData.isGodNode ? '<span style="color:rgba(234,179,8,0.85);margin-left:4px;" title="God node">\u2605</span>' : '';
  panel.innerHTML = `
    <div class="chat-kb-graph-panel-header">
      <strong>${esc(nodeData.title)}</strong>${godBadge}
    </div>
    <div class="chat-kb-graph-panel-meta">${nodeData.entryCount} entries \u00b7 ${nodeData.connectionCount} connections</div>
    <div class="chat-kb-graph-panel-body"><span class="chat-dream-banner-spinner"></span> Loading\u2026</div>
  `;

  const hash = chatKbBrowserState.hash;
  fetch(chatApiUrl(`workspaces/${encodeURIComponent(hash)}/kb/synthesis/${encodeURIComponent(nodeData.id)}`), { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((data) => {
      const body = panel.querySelector('.chat-kb-graph-panel-body');
      if (!body) return;
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const connections = Array.isArray(data.connections) ? data.connections : [];
      if (entries.length === 0 && connections.length === 0) {
        body.innerHTML = '<div class="chat-kb-graph-panel-empty">No entries or connections.</div>';
        return;
      }
      let html = '';
      if (entries.length > 0) {
        html += `<div class="chat-kb-graph-panel-section">Entries (${entries.length})</div>`;
        html += '<ul class="chat-kb-graph-panel-list">';
        for (const e of entries) {
          html += `<li>${esc(e.title || e.entryId)}</li>`;
        }
        html += '</ul>';
      }
      if (connections.length > 0) {
        html += `<div class="chat-kb-graph-panel-section" style="margin-top:12px;">Connections (${connections.length})</div>`;
        html += '<ul class="chat-kb-graph-panel-list">';
        for (const c of connections) {
          const other = c.sourceTopic === nodeData.id ? c.targetTopic : c.sourceTopic;
          const otherTopic = (chatKbBrowserState?.synthesis?.topics || []).find((t) => t.topicId === other);
          const label = otherTopic ? otherTopic.title : other;
          const badge = `<span class="chat-kb-conn-confidence">${esc(c.confidence)}</span>`;
          html += `<li>${badge} ${esc(label)} <span style="color:var(--muted);font-style:italic;font-size:11px;">${esc(c.relationship)}</span></li>`;
        }
        html += '</ul>';
      }
      body.innerHTML = html;
    })
    .catch(() => {
      const body = panel.querySelector('.chat-kb-graph-panel-body');
      if (body) body.innerHTML = '<div style="color:var(--error);font-size:12px;">Failed to load.</div>';
    });
}

function chatKbGraphClearPanel() {
  const panel = document.getElementById('chat-kb-graph-panel');
  if (panel) panel.innerHTML = '<div class="chat-kb-graph-panel-empty">Click a node to view details</div>';
}

function chatKbBrowserWireSynthesisTab() {
  // Dream buttons
  const dreamBtn = document.getElementById('chat-kb-dream-btn');
  if (dreamBtn) {
    dreamBtn.onclick = async () => {
      const hash = dreamBtn.dataset.dreamHash;
      if (!hash) return;
      dreamBtn.disabled = true;
      try {
        await chatFetch(`workspaces/${encodeURIComponent(hash)}/kb/dream`, { method: 'POST' });
        chatKbBrowserState.synthesis._status = 'running';
        chatKbBrowserState.synthesis._dreamProgress = null;
        chatKbBrowserState.synthesis._dreamStepStart = null;
        chatKbBrowserState.synthesis._dreamTriggeredAt = Date.now();
        chatKbBrowserRenderTab();
      } catch (err) { chatShowAlert('Dream failed: ' + err.message); }
    };
  }
  const redreamBtn = document.getElementById('chat-kb-redream-btn');
  if (redreamBtn) {
    redreamBtn.onclick = async () => {
      const hash = redreamBtn.dataset.dreamHash;
      if (!hash) return;
      if (!await chatShowConfirm('Re-Dream will wipe all topics and connections and rebuild from scratch. Continue?', { title: 'Re-Dream', confirmLabel: 'Re-Dream', destructive: true })) return;
      redreamBtn.disabled = true;
      try {
        await chatFetch(`workspaces/${encodeURIComponent(hash)}/kb/redream`, { method: 'POST' });
        chatKbBrowserState.synthesis._status = 'running';
        chatKbBrowserState.synthesis._dreamProgress = null;
        chatKbBrowserState.synthesis._dreamStepStart = null;
        chatKbBrowserState.synthesis._dreamTriggeredAt = Date.now();
        chatKbBrowserRenderTab();
      } catch (err) { chatShowAlert('Re-Dream failed: ' + err.message); }
    };
  }
  // Initialize D3 force graph
  chatKbGraphInit();
}

// ── KB Settings tab ─────────────────────────────────────────────────────────

// ── KB Reflections tab ──────────────────────────────────────────────────────

async function chatKbBrowserRefetchReflections() {
  if (!chatKbBrowserState) return;
  chatKbBrowserState.reflections.loading = true;
  try {
    const res = await fetch(chatApiUrl(`workspaces/${chatKbBrowserState.hash}/kb/reflections`), { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!chatKbBrowserState) return;
    chatKbBrowserState.reflections.items = data.reflections || [];
  } catch (err) {
    console.warn('[kb] reflections fetch failed:', err);
  } finally {
    if (chatKbBrowserState) {
      chatKbBrowserState.reflections.loading = false;
      if (chatKbBrowserState.activeTab === 'reflections') chatKbBrowserRenderTab();
    }
  }
}

async function chatKbBrowserRefetchReflectionDetail(reflectionId) {
  if (!chatKbBrowserState) return;
  try {
    const res = await fetch(chatApiUrl(`workspaces/${chatKbBrowserState.hash}/kb/reflections/${reflectionId}`), { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!chatKbBrowserState) return;
    chatKbBrowserState.reflections.detail = data;
    chatKbBrowserState.reflections.selectedId = reflectionId;
    if (chatKbBrowserState.activeTab === 'reflections') chatKbBrowserRenderTab();
  } catch (err) {
    console.warn('[kb] reflection detail fetch failed:', err);
  }
}

function chatKbBrowserReflectionsTab() {
  const s = chatKbBrowserState.reflections;
  const items = Array.isArray(s.items) ? s.items : [];

  if (s.loading && items.length === 0) {
    return '<p class="chat-kb-empty">Loading reflections\u2026</p>';
  }
  if (items.length === 0) {
    return '<p class="chat-kb-empty">No reflections yet. Run Dream to generate cross-topic insights.</p>';
  }

  const staleCount = items.filter((r) => r.isStale).length;
  const staleBanner = staleCount > 0
    ? `<div class="chat-kb-reflections-stale-banner">${staleCount} reflection${staleCount > 1 ? 's are' : ' is'} stale \u2014 run Dream to refresh.</div>`
    : '';

  const typeBadgeClass = {
    pattern: 'chat-kb-ref-type-pattern',
    contradiction: 'chat-kb-ref-type-contradiction',
    gap: 'chat-kb-ref-type-gap',
    trend: 'chat-kb-ref-type-trend',
    insight: 'chat-kb-ref-type-insight',
  };

  // Type filter
  const activeFilter = s.typeFilter || 'all';
  const allTypes = ['all', 'pattern', 'contradiction', 'gap', 'trend', 'insight'];
  const filterOptions = allTypes.map((t) =>
    `<option value="${t}"${t === activeFilter ? ' selected' : ''}>${t === 'all' ? 'All Types' : t.charAt(0).toUpperCase() + t.slice(1)}</option>`
  ).join('');
  const filterHtml = `<div class="chat-kb-reflections-toolbar">
    <select class="chat-kb-reflections-type-filter" id="chat-kb-reflections-type-filter">${filterOptions}</select>
    <span class="chat-kb-reflections-count">${items.length} reflection${items.length !== 1 ? 's' : ''}</span>
  </div>`;

  const filtered = activeFilter === 'all' ? items : items.filter((r) => r.type === activeFilter);

  const listItems = filtered.map((r) => {
    const selected = s.selectedId === r.reflectionId ? ' selected' : '';
    const stale = r.isStale ? ' stale' : '';
    const badgeCls = typeBadgeClass[r.type] || 'chat-kb-ref-type-insight';
    return `<div class="chat-kb-reflection-item${selected}${stale}" data-ref-id="${esc(r.reflectionId)}">
      <div class="chat-kb-reflection-item-header">
        <span class="chat-kb-ref-type-badge ${badgeCls}">${esc(r.type)}</span>
        ${r.isStale ? '<span class="chat-kb-ref-stale-badge">stale</span>' : ''}
      </div>
      <div class="chat-kb-reflection-item-title">${esc(r.title)}</div>
      <div class="chat-kb-reflection-item-meta">${r.citationCount} citation${r.citationCount !== 1 ? 's' : ''}</div>
    </div>`;
  }).join('');

  const emptyFiltered = filtered.length === 0
    ? `<p class="chat-kb-empty" style="padding:12px;">No ${esc(activeFilter)} reflections.</p>`
    : '';

  let detailHtml = '<p class="chat-kb-empty">Select a reflection to view details.</p>';
  if (s.detail && s.selectedId) {
    const d = s.detail;
    const citedList = (d.citedEntries || []).map((e) =>
      `<li class="chat-kb-reflection-citation"><a class="chat-kb-ref-cited-entry-link" data-entry-id="${esc(e.entryId)}">${esc(e.title)}</a> <span class="chat-kb-reflection-citation-id">(${esc(e.entryId)})</span></li>`
    ).join('');
    detailHtml = `
      <div class="chat-kb-reflection-detail-header">
        <span class="chat-kb-ref-type-badge ${typeBadgeClass[d.type] || 'chat-kb-ref-type-insight'}">${esc(d.type)}</span>
        <h3>${esc(d.title)}</h3>
      </div>
      ${d.summary ? `<p class="chat-kb-reflection-summary">${esc(d.summary)}</p>` : ''}
      <div class="chat-kb-reflection-content">${chatKbRenderReflectionMarkdown(d.content)}</div>
      ${citedList ? `<div class="chat-kb-reflection-citations"><h4>Cited Entries</h4><ul>${citedList}</ul></div>` : ''}
    `;
  }

  return `
    ${staleBanner}
    ${filterHtml}
    <div class="chat-kb-reflections-layout">
      <div class="chat-kb-reflections-list">${listItems || emptyFiltered}</div>
      <div class="chat-kb-reflection-detail">${detailHtml}</div>
    </div>
  `;
}

function chatKbBrowserWireReflectionsTab() {
  // Wire type filter dropdown.
  const filterEl = document.getElementById('chat-kb-reflections-type-filter');
  if (filterEl) {
    filterEl.onchange = () => {
      if (!chatKbBrowserState) return;
      chatKbBrowserState.reflections.typeFilter = filterEl.value;
      chatKbBrowserRenderTab();
    };
  }
  document.querySelectorAll('.chat-kb-reflection-item[data-ref-id]').forEach((el) => {
    el.onclick = () => {
      const refId = el.dataset.refId;
      if (!refId || !chatKbBrowserState) return;
      chatKbBrowserRefetchReflectionDetail(refId);
    };
  });
  // Wire citation links (both inline and in cited entries list).
  document.querySelectorAll('.chat-kb-ref-citation-link[data-entry-id], .chat-kb-ref-cited-entry-link[data-entry-id]').forEach((el) => {
    el.onclick = (e) => {
      e.preventDefault();
      const entryId = el.dataset.entryId;
      if (entryId) chatKbOpenEntryPopup(entryId);
    };
  });
}

async function chatKbOpenEntryPopup(entryId) {
  if (!chatKbBrowserState || !entryId) return;
  chatShowModal('Loading entry\u2026', '<div class="chat-modal-body"><p class="chat-kb-empty">Loading\u2026</p></div>');
  try {
    const url = chatApiUrl(
      `workspaces/${encodeURIComponent(chatKbBrowserState.hash)}/kb/entries/${encodeURIComponent(entryId)}`,
    );
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const title = data.entry?.title || data.title || entryId;
    const body = data.body || '(empty)';
    const locations = data.locations || [];
    let sourceHtml = '';
    if (locations.length > 0) {
      const locItems = locations.map((loc) => {
        const folder = loc.folderPath || '/';
        return `<span class="chat-kb-entry-popup-loc">${esc(folder)}/${esc(loc.filename)}</span>`;
      }).join('');
      sourceHtml = `<div class="chat-kb-entry-popup-source"><span class="chat-kb-entry-popup-source-label">Source:</span> ${locItems}</div>`;
    }
    chatShowModal(title, `
      ${sourceHtml}
      <div class="chat-modal-body" style="max-height:60vh;overflow-y:auto;padding:12px 16px;font-size:13px;line-height:1.6;white-space:pre-wrap;">${esc(body)}</div>
    `);
  } catch (err) {
    chatShowModal('Error', `<div class="chat-modal-body" style="padding:16px;"><p>Could not load entry: ${esc(err.message)}</p></div>`);
  }
}

function chatKbRenderReflectionMarkdown(md) {
  if (!md) return '';
  return esc(md)
    .replace(/\[Entry: ([^\]]+)\]\(([^)]+)\)/g, '<a class="chat-kb-ref-citation-link" data-entry-id="$2" title="$2">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

// ── KB Settings tab ─────────────────────────────────────────────────────────

function chatKbBrowserSettingsTab() {
  const emb = chatKbBrowserState?.embedding || {};
  const cfg = emb.config || {};
  const model = cfg.model || 'nomic-embed-text';
  const host = cfg.ollamaHost || 'http://localhost:11434';
  const dims = cfg.dimensions || 768;
  const health = emb.healthStatus;

  let healthHtml = '';
  if (health === 'checking') {
    healthHtml = '<span class="chat-kb-settings-health checking">Checking\u2026</span>';
  } else if (health && health.ok) {
    healthHtml = '<span class="chat-kb-settings-health ok">Connected</span>';
  } else if (health && !health.ok) {
    healthHtml = `<span class="chat-kb-settings-health error">${esc(health.error || 'Connection failed')}</span>`;
  }

  return `
    <div class="chat-kb-settings">
      <h3>Embedding Configuration</h3>
      <p class="chat-kb-settings-desc">
        Embeddings power vector search over your entries and topics.
        Requires <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a> running locally.
      </p>
      <div class="chat-kb-settings-form">
        <label>
          <span>Model</span>
          <input type="text" id="chat-kb-emb-model" value="${esc(model)}" placeholder="nomic-embed-text" />
        </label>
        <label>
          <span>Ollama Host</span>
          <input type="text" id="chat-kb-emb-host" value="${esc(host)}" placeholder="http://localhost:11434" />
        </label>
        <label>
          <span>Dimensions</span>
          <input type="number" id="chat-kb-emb-dims" value="${dims}" min="1" max="4096" />
        </label>
        <div class="chat-kb-settings-actions">
          <button class="chat-kb-toolbar-btn" id="chat-kb-emb-test-btn">Test Connection</button>
          <button class="chat-kb-toolbar-btn chat-kb-toolbar-btn-primary" id="chat-kb-emb-save-btn">Save</button>
          ${healthHtml}
        </div>
      </div>
    </div>
  `;
}

function chatKbBrowserWireSettingsTab() {
  const testBtn = document.getElementById('chat-kb-emb-test-btn');
  const saveBtn = document.getElementById('chat-kb-emb-save-btn');

  if (testBtn) {
    testBtn.onclick = async () => {
      if (!chatKbBrowserState) return;
      chatKbBrowserState.embedding.healthStatus = 'checking';
      chatKbBrowserRenderTab();
      try {
        const hash = chatKbBrowserState.hash;
        const res = await chatFetch(
          `workspaces/${encodeURIComponent(hash)}/kb/embedding-health`,
          { method: 'POST', body: {} },
        );
        const data = await res.json();
        chatKbBrowserState.embedding.healthStatus = data;
      } catch (err) {
        chatKbBrowserState.embedding.healthStatus = { ok: false, error: err.message };
      }
      chatKbBrowserRenderTab();
    };
  }

  if (saveBtn) {
    saveBtn.onclick = async () => {
      if (!chatKbBrowserState) return;
      const model = document.getElementById('chat-kb-emb-model')?.value?.trim() || 'nomic-embed-text';
      const ollamaHost = document.getElementById('chat-kb-emb-host')?.value?.trim() || 'http://localhost:11434';
      const dimensions = parseInt(document.getElementById('chat-kb-emb-dims')?.value, 10) || 768;
      const hash = chatKbBrowserState.hash;
      try {
        const res = await chatFetch(
          `workspaces/${encodeURIComponent(hash)}/kb/embedding-config`,
          { method: 'PUT', body: { model, ollamaHost, dimensions } },
        );
        const data = await res.json();
        chatKbBrowserState.embedding.config = data.embeddingConfig;
        chatShowAlert('Embedding config saved.', { title: 'Success' });
      } catch (err) {
        chatShowAlert('Save failed: ' + err.message);
      }
    };
  }

  // Fetch current config if not loaded yet.
  if (!chatKbBrowserState?.embedding?.config && !chatKbBrowserState?.embedding?.loading) {
    chatKbBrowserState.embedding.loading = true;
    const hash = chatKbBrowserState.hash;
    chatFetch(`workspaces/${encodeURIComponent(hash)}/kb/embedding-config`)
      .then((r) => r.json())
      .then((data) => {
        if (!chatKbBrowserState) return;
        chatKbBrowserState.embedding.config = data.embeddingConfig || {};
        chatKbBrowserState.embedding.loading = false;
        if (chatKbBrowserState.activeTab === 'settings') chatKbBrowserRenderTab();
      })
      .catch(() => {
        if (chatKbBrowserState) chatKbBrowserState.embedding.loading = false;
      });
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────
chatInit();
