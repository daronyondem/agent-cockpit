import { state, chatFetch, chatApiUrl, fetchCsrfToken, chatSyncQueueToServer } from './state.js';
import { esc, escWithCode } from './utils.js';
import {
  chatRenderMessages, chatRenderMarkdown, chatAutoResize, chatScrollToBottom,
  chatHighlightCode, chatAppendStreamingMessage, chatUpdateStreamingContent,
  chatArchiveActiveState, chatCombinedTools, chatCombinedAgents,
  chatStartElapsedTimer, chatStartActivityTimer,
} from './rendering.js';
import { chatConnectWs, chatDisconnectWs, chatWsSend } from './websocket.js';
import {
  chatLoadConversations, chatRenderConvList, chatUpdateSendButtonState,
  chatRenderFileChips, chatUpdateHeader, chatUpdateUsageDisplay,
  chatRenderQueuedMessages,
} from './conversations.js';

// ── Queue processing ─────────────────────────────────────────────────────────

export async function chatProcessNextQueuedMessage(convId) {
  if (state.chatQueuePaused.has(convId)) return;
  if (state.chatQueueSuspended.has(convId)) return;
  if (state.chatStreamingConvs.has(convId)) return;
  const queue = state.chatMessageQueue.get(convId);
  if (!queue || queue.length === 0) return;

  const nextItem = queue[0];
  nextItem.inFlight = true;
  chatRenderQueuedMessages();

  const textarea = document.getElementById('chat-textarea');
  if (textarea) {
    textarea.value = nextItem.content;
    chatAutoResize(textarea);
  }

  queue.shift();
  if (queue.length === 0) state.chatMessageQueue.delete(convId);
  chatRenderQueuedMessages();
  chatSyncQueueToServer(convId);

  if (state.chatActiveConvId === convId) {
    await chatSendMessage();
  }
}

export function chatResumeQueue() {
  const convId = state.chatActiveConvId;
  if (!convId) return;
  state.chatQueuePaused.delete(convId);
  chatRenderQueuedMessages();
  if (!state.chatStreamingConvs.has(convId)) {
    chatProcessNextQueuedMessage(convId);
  }
}

export function chatResumeSuspendedQueue() {
  const convId = state.chatActiveConvId;
  if (!convId) return;
  state.chatQueueSuspended.delete(convId);
  chatRenderQueuedMessages();
  if (!state.chatStreamingConvs.has(convId)) {
    chatProcessNextQueuedMessage(convId);
  }
}

export function chatClearQueue() {
  const convId = state.chatActiveConvId;
  if (!convId) return;
  const queue = state.chatMessageQueue.get(convId);
  if (!queue) return;
  const inFlight = queue.filter(i => i.inFlight);
  if (inFlight.length > 0) {
    state.chatMessageQueue.set(convId, inFlight);
  } else {
    state.chatMessageQueue.delete(convId);
  }
  state.chatQueuePaused.delete(convId);
  state.chatQueueSuspended.delete(convId);
  chatRenderQueuedMessages();
  chatUpdateSendButtonState();
  chatSyncQueueToServer(convId);
}

// ── Stream cleanup ───────────────────────────────────────────────────────────

export function chatCleanupStreamState(convId, { force = false } = {}) {
  const st = state.chatStreamingState.get(convId);
  if (!st) return;
  if (st.elapsedTimerInterval) clearInterval(st.elapsedTimerInterval);
  if (st.activityTimerInterval) clearInterval(st.activityTimerInterval);
  if (st.pendingInteraction && !force) {
    return;
  }
  if (st.streamingMsgEl && st.streamingMsgEl.isConnected) {
    st.streamingMsgEl.remove();
  }
  state.chatStreamingState.delete(convId);
}

// ── Sending messages ─────────────────────────────────────────────────────────

export async function chatSendMessage() {
  const textarea = document.getElementById('chat-textarea');
  const hasText = textarea && textarea.value.trim();
  const completedFiles = state.chatPendingFiles.filter(e => e.status === 'done');
  const hasFiles = completedFiles.length > 0;
  if ((!hasText && !hasFiles) || state.chatResettingConvs.has(state.chatActiveConvId)) return;
  if (state.chatPendingFiles.some(e => e.status === 'uploading')) return;

  let content = textarea ? textarea.value.trim() : '';
  if (textarea) { textarea.value = ''; chatAutoResize(textarea); }

  if (hasFiles) {
    const paths = completedFiles.map(e => e.result.path).join(', ');
    content = content
      ? content + '\n\n[Uploaded files: ' + paths + ']'
      : '[Uploaded files: ' + paths + ']';
  }
  state.chatPendingFiles = [];
  chatRenderFileChips();
  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) sendBtn.disabled = true;

  if (!state.chatActiveConvId) {
    state.chatDraftState.delete('__new__');
    try {
      const body = state.chatPendingWorkingDir ? { workingDir: state.chatPendingWorkingDir } : {};
      state.chatPendingWorkingDir = null;
      const res = await chatFetch('conversations', { method: 'POST', body });
      const conv = await res.json();
      state.chatActiveConvId = conv.id;
      state.chatActiveConv = conv;
      chatLoadConversations();
      chatUpdateHeader();
    } catch (err) {
      alert('Failed to create conversation: ' + err.message);
      return;
    }
  }

  if (state.chatStreamingConvs.has(state.chatActiveConvId)) {
    const queue = state.chatMessageQueue.get(state.chatActiveConvId) || [];
    queue.push({ id: ++state.chatQueueIdCounter, content, inFlight: false });
    state.chatMessageQueue.set(state.chatActiveConvId, queue);
    state.chatQueuePaused.delete(state.chatActiveConvId);
    chatRenderQueuedMessages();
    chatUpdateSendButtonState();
    chatScrollToBottom();
    chatSyncQueueToServer(state.chatActiveConvId);
    return;
  }

  state.chatDraftState.delete(state.chatActiveConvId);
  const backend = document.getElementById('chat-backend-select')?.value || (state.CHAT_BACKENDS[0]?.id || 'claude-code');
  const modelSelect = document.getElementById('chat-model-select');
  const model = (modelSelect && modelSelect.style.display !== 'none') ? modelSelect.value : undefined;
  const targetConvId = state.chatActiveConvId;

  // Persist selected backend (and model) as the default for new conversations
  if (state.chatSettingsData) {
    let dirty = false;
    if (state.chatSettingsData.defaultBackend !== backend) {
      state.chatSettingsData.defaultBackend = backend;
      dirty = true;
    }
    if (model !== undefined && state.chatSettingsData.defaultModel !== model) {
      state.chatSettingsData.defaultModel = model;
      dirty = true;
    }
    if (dirty) {
      chatFetch('settings', { method: 'PUT', body: state.chatSettingsData }).catch(() => {});
    }
  }

  state.chatStreamingConvs.add(targetConvId);
  state.chatStreamingState.set(targetConvId, {
    assistantContent: '',
    assistantThinking: '',
    activeTools: [],
    activeAgents: [],
    toolHistory: [],
    agentHistory: [],
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
    const ws = chatConnectWs(targetConvId);
    if (ws.readyState !== WebSocket.OPEN) {
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
    }

    if (!state.csrfToken) await fetchCsrfToken();
    const response = await fetch(chatApiUrl(`conversations/${targetConvId}/message`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': state.csrfToken || '',
      },
      credentials: 'same-origin',
      body: JSON.stringify({ content, backend, model }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || response.statusText);
    }

    const postResult = await response.json();

    if (state.chatActiveConv && state.chatActiveConvId === targetConvId && postResult.userMessage) {
      state.chatActiveConv.messages.push(postResult.userMessage);
      chatRenderMessages();
    }

    const stRef = state.chatStreamingState.get(targetConvId);
    if (!stRef) return;

    if (state.chatActiveConvId === targetConvId && !stRef.streamingMsgEl) {
      stRef.streamingMsgEl = chatAppendStreamingMessage();
      chatStartElapsedTimer(targetConvId);
    }

    await new Promise((resolve) => {
      const st = state.chatStreamingState.get(targetConvId);
      if (st) st._doneResolve = resolve;
    });
  } catch (err) {
    if (err.name !== 'AbortError') {
      if (state.chatActiveConvId === targetConvId) chatAppendError(err.message);
    }
    const errSt = state.chatStreamingState.get(targetConvId);
    if (errSt) errSt._hadError = true;
  } finally {
    const finalSt = state.chatStreamingState.get(targetConvId);
    const hadError = finalSt?._hadError;
    state.chatStreamingConvs.delete(targetConvId);
    chatCleanupStreamState(targetConvId, { force: true });
    chatDisconnectWs(targetConvId);
    chatUpdateSendButtonState();
    chatRenderConvList();
    chatLoadConversations();

    if (hadError && state.chatMessageQueue.has(targetConvId)) {
      state.chatQueuePaused.add(targetConvId);
      chatRenderQueuedMessages();
    } else {
      chatProcessNextQueuedMessage(targetConvId);
    }
  }
}

// ── Stream event handling ────────────────────────────────────────────────────

export function chatHandleStreamEvent(targetConvId, event) {
  const st = state.chatStreamingState.get(targetConvId);
  if (!st) return;
  const isStillActive = (state.chatActiveConvId === targetConvId);

  if (isStillActive && (!st.streamingMsgEl || !st.streamingMsgEl.isConnected)) {
    st.streamingMsgEl = chatAppendStreamingMessage();
  }

  if (event.type === 'replay_start') {
    console.log(`[ws] Replay starting: ${event.bufferedEvents} events for conv=${targetConvId}`);
    st.assistantContent = '';
    st.assistantThinking = '';
    st.activeTools = [];
    st.activeAgents = [];
    st.toolHistory = [];
    st.agentHistory = [];
    st.planModeActive = false;
    st.pendingInteraction = null;
    st._replaying = true;
    if (isStillActive && state.chatActiveConv) {
      chatRenderMessages();
    }
    return;
  } else if (event.type === 'replay_end') {
    st._replaying = false;
    state.chatReconnectAttempts.delete(targetConvId);
    console.log(`[ws] Replay complete for conv=${targetConvId}`);
    if (isStillActive) {
      chatUpdateStreamingContent(st.streamingMsgEl, st);
    }
    return;
  } else if (event.type === 'thinking') {
    st.assistantThinking += event.content;
    if (isStillActive) {
      chatUpdateStreamingContent(st.streamingMsgEl, st);
    }
  } else if (event.type === 'tool_outcomes') {
    for (const outcome of (event.outcomes || [])) {
      const match = st.activeTools.find(t => t.id === outcome.toolUseId)
        || st.activeAgents.find(a => a.id === outcome.toolUseId);
      if (match) {
        match.outcome = outcome.outcome;
        match.status = outcome.status;
      }
    }
    if (isStillActive) {
      chatUpdateStreamingContent(st.streamingMsgEl, st);
    }
  } else if (event.type === 'turn_complete') {
    chatArchiveActiveState(st);
    if (isStillActive && !st.pendingInteraction) {
      chatUpdateStreamingContent(st.streamingMsgEl, st);
    }
  } else if (event.type === 'text') {
    st.assistantContent += event.content;
    if (st.pendingInteraction) {
      // Accumulate silently — don't overwrite dialog
    } else {
      if (isStillActive) {
        chatUpdateStreamingContent(st.streamingMsgEl, st);
      }
    }
  } else if (event.type === 'tool_activity') {
    if (event.isAgent) {
      st.activeAgents.push({ subagentType: event.subagentType || 'agent', description: event.description || '', startTime: event.startTime || Date.now(), id: event.id, isAgent: true, parentAgentId: event.parentAgentId || null });
    } else if (event.isPlanMode) {
      if (event.planAction === 'enter') st.planModeActive = true;
      else if (event.planAction === 'exit') st.planModeActive = false;
    }
    if (!event.isAgent && !event.isPlanMode) {
      st.activeTools.push({ tool: event.tool, description: event.description || '', startTime: event.startTime || Date.now(), id: event.id, parentAgentId: event.parentAgentId || null });
    }
    if (event.isPlanMode && event.planAction === 'exit') {
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
        chatUpdateStreamingContent(st.streamingMsgEl, st);
        chatStartActivityTimer(targetConvId);
      }
    }
  } else if (event.type === 'assistant_message') {
    const savedInteraction = st.pendingInteraction;
    st.assistantContent = '';
    st.assistantThinking = '';
    chatArchiveActiveState(st);
    st.toolHistory = [];
    st.agentHistory = [];
    st.planModeActive = false;
    st.pendingInteraction = savedInteraction;
    if (isStillActive && state.chatActiveConv) {
      if (!state.chatActiveConv.messages.some(m => m.id === event.message.id)) {
        state.chatActiveConv.messages.push(event.message);
      }
      chatRenderMessages();
      chatUpdateHeader();
    }
    chatLoadConversations();
  } else if (event.type === 'title_updated') {
    if (isStillActive && state.chatActiveConv) {
      state.chatActiveConv.title = event.title;
      chatUpdateHeader();
    }
    const sidebarConv = state.chatConversations.find(c => c.id === targetConvId);
    if (sidebarConv) {
      sidebarConv.title = event.title;
      chatRenderConvList();
    }
  } else if (event.type === 'usage') {
    if (isStillActive && state.chatActiveConv) {
      state.chatActiveConv.usage = event.usage;
      if (event.sessionUsage) state.chatActiveConv.sessionUsage = event.sessionUsage;
      chatUpdateUsageDisplay();
    }
  } else if (event.type === 'error') {
    st.pendingInteraction = null;
    chatArchiveActiveState(st);
    st.planModeActive = false;
    st._hadError = true;
    if (isStillActive) chatAppendError(event.error);
  } else if (event.type === 'done') {
    if (st._replaying) return;
    if (st._doneResolve) { st._doneResolve(); delete st._doneResolve; }
    chatCleanupStreamState(targetConvId);
  }
}

// ── Plan approval ────────────────────────────────────────────────────────────

export function chatShowPlanApproval(msgEl, convId, planContent) {
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
        chatWsSend(convId, { type: 'input', text });
        const approvalState = state.chatStreamingState.get(convId);
        if (approvalState) {
          approvalState.pendingInteraction = null;
          if (!state.chatStreamingConvs.has(convId)) {
            chatCleanupStreamState(convId, { force: true });
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

// ── User question ────────────────────────────────────────────────────────────

export function chatShowUserQuestion(msgEl, convId, event) {
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
      chatWsSend(convId, { type: 'input', text });
      const questionState = state.chatStreamingState.get(convId);
      if (questionState) {
        questionState.pendingInteraction = null;
        if (!state.chatStreamingConvs.has(convId)) {
          chatCleanupStreamState(convId, { force: true });
        }
      }
      contentEl.innerHTML = `<div style="font-size:12px;color:var(--muted);font-style:italic;">Answered: ${esc(text)}</div>`;
    } catch (err) {
      contentEl.innerHTML = `<div style="font-size:12px;color:var(--danger);">Failed to send response: ${esc(err.message)}</div>`;
    }
  };

  chatScrollToBottom();
}

// ── Error display ────────────────────────────────────────────────────────────

function chatFormatErrorMessage(errorMsg) {
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
    if (code === '500') return 'The API returned an internal server error. This is usually a temporary issue \u2014 try again.';
    if (code === '429') return 'Rate limit exceeded. Please wait a moment before retrying.';
    if (code === '529') return 'The API is temporarily overloaded. Please try again shortly.';
    return `API error ${code}${detail ? ': ' + detail : ''}`;
  }
  return errorMsg;
}

export function chatAppendError(errorMsg) {
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

// ── Stop / retry ─────────────────────────────────────────────────────────────

export async function chatStopStreaming() {
  if (!state.chatActiveConvId) return;
  chatWsSend(state.chatActiveConvId, { type: 'abort' });
}

export function chatRetryLast() {
  if (!state.chatActiveConv) return;
  const lastUser = [...state.chatActiveConv.messages].reverse().find(m => m.role === 'user');
  if (lastUser) {
    const textarea = document.getElementById('chat-textarea');
    if (textarea) {
      textarea.value = lastUser.content;
      chatAutoResize(textarea);
      chatSendMessage();
    }
  }
}
