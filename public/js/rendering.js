import { state, IMAGE_EXTENSIONS, PARALLEL_THRESHOLD_MS, DEFAULT_BACKEND_ICON, ICON_USER, chatApiUrl } from './state.js';
import { esc, escWithCode, chatFormatTimestamp, chatFormatElapsed, chatFormatElapsedShort } from './utils.js';
import { getBackendIcon, getBackendCapabilities } from './backends.js';
import { chatOpenMemoryPanel } from './memory.js';

// Late-binding callbacks to avoid circular imports with streaming.js / conversations.js.
// main.js wires these after all imports resolve.
let _sendMessage = null;
let _renderQueuedMessages = null;
let _showPlanApproval = null;
let _showUserQuestion = null;

export function setRenderingCallbacks({ sendMessage, renderQueuedMessages, showPlanApproval, showUserQuestion }) {
  _sendMessage = sendMessage;
  _renderQueuedMessages = renderQueuedMessages;
  _showPlanApproval = showPlanApproval;
  _showUserQuestion = showUserQuestion;
}

// ── Auto-resize ──────────────────────────────────────────────────────────────

export function chatAutoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

// ── Scroll ───────────────────────────────────────────────────────────────────

export function chatScrollToBottom() {
  const container = document.getElementById('chat-messages');
  if (container) {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }
}

// ── Message rendering ─────────────────────────────────────────────────────────

export function chatRenderMessages() {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  if (!state.chatActiveConv || state.chatActiveConv.messages.length === 0) {
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
          if (_sendMessage) _sendMessage();
        }
      };
    });
    return;
  }

  // Messages are already just the current session (archived sessions live in separate files)
  const currentSessionMsgs = state.chatActiveConv.messages;

  let html = '';

  // Session activity overview removed — not needed in current UI

  for (let mi = 0; mi < currentSessionMsgs.length; mi++) {
    const msg = currentSessionMsgs[mi];

    // Synthetic memory_update bubble — uses the Agent Cockpit logo as the
    // avatar and stays inline like any other message. See
    // chatAppendMemoryUpdateMessage in streaming.js.
    if (msg.kind === 'memory_update') {
      html += chatRenderMemoryUpdateMessage(msg);
      continue;
    }

    const isUser = msg.role === 'user';
    const backendIcon = !isUser && msg.backend ? getBackendIcon(msg.backend) : null;
    const avatar = isUser ? ICON_USER : (backendIcon || DEFAULT_BACKEND_ICON);
    const avatarClass = isUser ? ' chat-msg-avatar-svg' : (!isUser && backendIcon ? ' chat-msg-avatar-svg' : '');
    const roleLabel = isUser ? 'You' : 'Assistant';
    const backendLabel = msg.backend ? `<span class="chat-msg-model">${esc(state.CHAT_BACKENDS.find(b => b.id === msg.backend)?.label || msg.backend)}</span>` : '';
    const rendered = chatRenderMarkdown(msg.content);
    const caps = msg.backend ? getBackendCapabilities(msg.backend) : {};
    const thinkingHtml = msg.thinking && caps.thinking !== false ? chatRenderThinkingBlock(msg.thinking, false) : '';
    const toolActivityHtml = !isUser && msg.toolActivity ? chatRenderToolActivityBlock(msg.toolActivity) : '';

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
      <div class="chat-msg ${esc(msg.role)}" data-msg-id="${esc(msg.id)}" data-raw-content="${esc(msg.content || '')}">
        <div class="chat-msg-wrapper">
          <div class="chat-msg-avatar${avatarClass}">${avatar}</div>
          <div class="chat-msg-body">
            <div class="chat-msg-role">${roleLabel} ${backendLabel}${timeLabel}</div>
            <div class="chat-msg-content">${thinkingHtml}${toolActivityHtml}${rendered}</div>
            <div class="chat-msg-actions">
              <button class="chat-msg-action" data-action="copy-msg" title="Copy">Copy</button>
              <button class="chat-msg-action" data-action="copy-md" title="Copy Markdown">Copy MD</button>
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
  const streamState = state.chatStreamingState.get(state.chatActiveConvId);
  const pendingInteraction = streamState?.pendingInteraction
    || state.chatPendingInteractions.get(state.chatActiveConvId);

  if (streamState || pendingInteraction) {
    const msgEl = chatAppendStreamingMessage();
    if (streamState) {
      streamState.streamingMsgEl = msgEl;
      chatStartElapsedTimer(state.chatActiveConvId);
    }

    if (pendingInteraction) {
      if (pendingInteraction.type === 'planApproval') {
        if (_showPlanApproval) _showPlanApproval(msgEl, state.chatActiveConvId, pendingInteraction.planContent);
      } else if (pendingInteraction.type === 'userQuestion') {
        if (_showUserQuestion) _showUserQuestion(msgEl, state.chatActiveConvId, pendingInteraction.event);
      }
    } else {
      chatUpdateStreamingContent(msgEl, streamState);
      if (chatCombinedTools(streamState).length || chatCombinedAgents(streamState).length) {
        chatStartActivityTimer(state.chatActiveConvId);
      }
    }
  }

  // Render queued messages after all real messages and streaming bubble
  if (_renderQueuedMessages) _renderQueuedMessages();

  chatScrollToBottom();
}

// ── Memory update inline message ─────────────────────────────────────────────
// Renders a synthetic chat-msg bubble for a memory_update WS frame. The
// message lives in chatActiveConv.messages with kind 'memory_update' so it
// survives every chatRenderMessages() rebuild. The whole bubble is clickable
// to open the read-only memory panel (handled in chatWireMessageActions).

export function chatRenderMemoryUpdateMessage(msg) {
  const data = msg.memoryUpdate || {};
  const fileCount = Number(data.fileCount) || 0;
  const changed = Array.isArray(data.changedFiles) ? data.changedFiles : [];
  const changedCount = changed.length;

  const headline = changedCount === 0
    ? `Memory snapshot refreshed (${fileCount} file${fileCount === 1 ? '' : 's'})`
    : `Memory updated: ${changedCount} file${changedCount === 1 ? '' : 's'} changed`;

  const filesHtml = changedCount > 0
    ? `<div class="chat-memory-msg-files">${changed.slice(0, 5).map(f => esc(f)).join(', ')}${changedCount > 5 ? `, +${changedCount - 5} more` : ''}</div>`
    : '';

  const timeLabel = msg.timestamp ? `<span class="chat-msg-time">${chatFormatTimestamp(msg.timestamp)}</span>` : '';

  return `
    <div class="chat-msg system chat-msg-memory" data-msg-id="${esc(msg.id)}">
      <div class="chat-msg-wrapper">
        <div class="chat-msg-avatar chat-msg-avatar-memory"><img src="logo-small.svg" alt="Agent Cockpit" /></div>
        <div class="chat-msg-body">
          <div class="chat-msg-role">Agent Cockpit ${timeLabel}</div>
          <div class="chat-msg-content">
            <details class="chat-memory-msg-card">
              <summary class="chat-memory-msg-summary">
                <span class="chat-memory-msg-caret" aria-hidden="true"></span>
                <span class="chat-memory-msg-headline">${esc(headline)}</span>
              </summary>
              <div class="chat-memory-msg-body">
                ${filesHtml}
                <button type="button" class="chat-memory-msg-cta" data-action="open-memory">View memory →</button>
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── Thinking / activity blocks ───────────────────────────────────────────────

export function chatRenderThinkingBlock(thinking, expanded) {
  const openAttr = expanded ? ' open' : '';
  return `<details class="chat-thinking-block"${openAttr}>
    <summary class="chat-thinking-toggle">Thinking</summary>
    <div class="chat-thinking-content">${chatRenderMarkdown(thinking)}</div>
  </details>`;
}

export function chatRenderOutcomeBadge(item) {
  if (!item.outcome && !item.status) return '';
  const statusClass = item.status === 'error' ? 'chat-outcome-error'
    : item.status === 'warning' ? 'chat-outcome-warning'
    : 'chat-outcome-success';
  const text = item.outcome ? esc(item.outcome) : '';
  return text ? `<span class="chat-outcome-badge ${statusClass}">${text}</span>` : '';
}

export function chatRenderStatusCheck(item) {
  if (item.status === 'error') return '<span class="chat-activity-check chat-status-error">\u2717</span>';
  if (item.status === 'warning') return '<span class="chat-activity-check chat-status-warning">\u2713</span>';
  return '<span class="chat-activity-check">\u2713</span>';
}

export function chatBuildActivitySummary(toolActivity) {
  if (!toolActivity || toolActivity.length === 0) return 'No activity';
  const agents = toolActivity.filter(t => t.isAgent);
  const tools = toolActivity.filter(t => !t.isAgent);
  const parts = [];
  parts.push(`${toolActivity.length} op${toolActivity.length !== 1 ? 's' : ''}`);
  if (agents.length > 0) {
    parts.push(`${agents.length} agent${agents.length !== 1 ? 's' : ''}`);
  }
  const counts = {};
  for (const t of tools) { counts[t.tool] = (counts[t.tool] || 0) + 1; }
  const labels = { Read: 'read', Write: 'written', Edit: 'edited', Bash: 'command', Grep: 'search', Glob: 'glob', WebSearch: 'web search', WebFetch: 'web fetch', TodoWrite: 'task update' };
  const breakdown = Object.entries(counts).map(([tool, n]) => `${n} ${labels[tool] || tool.toLowerCase()}`);
  if (breakdown.length > 0) parts.push(breakdown.join(', '));
  return parts.join(' \u00b7 ');
}

export function chatRenderAgentCard(t, checkHtml, outcomeBadge, elapsed) {
  const agentType = esc(t.subagentType || 'agent');
  const agentDesc = t.description ? escWithCode(t.description) : '';
  const fullDesc = t.description && t.description.length > 40 ? escWithCode(t.description) : '';
  const outcomeDetail = t.outcome ? `<span class="chat-agent-detail-outcome">Result: ${esc(t.outcome)}</span>` : '';
  const hasDetails = fullDesc || outcomeDetail;
  if (hasDetails) {
    return `<details class="chat-agent-card chat-agent-card-done chat-agent-expandable">
      <summary class="chat-agent-card-summary">
        ${checkHtml}
        <div class="chat-agent-card-header">
          <span class="chat-agent-type">${agentType}</span>
          ${agentDesc ? `<span class="chat-agent-card-desc">${agentDesc}</span>` : ''}
        </div>
        ${outcomeBadge}${elapsed ? `<span class="chat-activity-elapsed">${elapsed}</span>` : ''}
      </summary>
      <div class="chat-agent-card-details">
        ${outcomeDetail}
      </div>
    </details>`;
  }
  return `<div class="chat-agent-card chat-agent-card-done">
    ${checkHtml}
    <div class="chat-agent-card-header">
      <span class="chat-agent-type">${agentType}</span>
      ${agentDesc ? `<span class="chat-agent-card-desc">${agentDesc}</span>` : ''}
    </div>
    ${outcomeBadge}${elapsed ? `<span class="chat-activity-elapsed">${elapsed}</span>` : ''}
  </div>`;
}

export function chatGroupParallelItems(items) {
  const groups = [];
  let i = 0;
  while (i < items.length) {
    if (items[i].isAgent || items[i]._kind === 'agent') {
      const groupStart = i;
      let j = i + 1;
      while (j < items.length
        && (items[j].isAgent || items[j]._kind === 'agent')
        && items[j].startTime && items[groupStart].startTime
        && Math.abs(items[j].startTime - items[groupStart].startTime) < PARALLEL_THRESHOLD_MS) {
        j++;
      }
      if (j - groupStart > 1) {
        groups.push({ type: 'parallel', items: items.slice(groupStart, j) });
        i = j;
        continue;
      }
    }
    groups.push({ type: 'single', item: items[i] });
    i++;
  }
  return groups;
}

export function chatRenderCompletedItem(t) {
  const checkHtml = chatRenderStatusCheck(t);
  const outcomeBadge = chatRenderOutcomeBadge(t);
  if (t.isAgent || t._kind === 'agent') {
    const elapsed = t.duration ? chatFormatElapsedShort(t.duration) : '';
    return chatRenderAgentCard(t, checkHtml, outcomeBadge, elapsed);
  }
  const desc = t.description ? escWithCode(t.description) : esc(t.tool || 'Tool');
  const elapsed = t.duration ? chatFormatElapsedShort(t.duration) : '';
  return `<div class="chat-activity-history-item">${checkHtml} <span class="chat-activity-history-desc">${desc}</span>${outcomeBadge}${elapsed ? `<span class="chat-activity-elapsed">${elapsed}</span>` : ''}</div>`;
}

export function chatRenderToolActivityBlock(toolActivity) {
  if (!toolActivity || toolActivity.length === 0) return '';
  const summary = chatBuildActivitySummary(toolActivity);

  // Use agent-aware grouping so tools nest under their parent agents
  const hasAgents = toolActivity.some(t => t.isAgent);
  let itemsHtml = '';

  if (hasAgents) {
    const sorted = [...toolActivity].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
    const agentGroups = chatGroupItemsByAgent(sorted);
    for (const group of agentGroups) {
      if (group.type === 'agent') {
        itemsHtml += chatRenderCompletedItem(group.agent);
        if (group.items.length > 0) {
          itemsHtml += '<div class="chat-agent-subactivities">';
          for (const t of group.items) {
            itemsHtml += chatRenderCompletedItem(t);
          }
          itemsHtml += '</div>';
        }
      } else if (group.type === 'standalone') {
        for (const t of group.items) {
          itemsHtml += chatRenderCompletedItem(t);
        }
      }
    }
  } else {
    const groups = chatGroupParallelItems(toolActivity);
    for (const group of groups) {
      if (group.type === 'parallel') {
        itemsHtml += '<div class="chat-parallel-group">';
        itemsHtml += '<div class="chat-parallel-label">parallel</div>';
        for (const t of group.items) {
          itemsHtml += chatRenderCompletedItem(t);
        }
        itemsHtml += '</div>';
      } else {
        itemsHtml += chatRenderCompletedItem(group.item);
      }
    }
  }

  return `<details class="chat-activity-block">
    <summary class="chat-activity-toggle">Activity: ${summary}</summary>
    <div class="chat-activity-block-content">${itemsHtml}</div>
  </details>`;
}

// ── Session overview ─────────────────────────────────────────────────────────

export function chatRenderSessionOverview(messages) {
  if (!messages || messages.length === 0) return '';
  const allActivity = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolActivity && msg.toolActivity.length > 0) {
      for (const t of msg.toolActivity) allActivity.push(t);
    }
  }
  if (allActivity.length === 0) return '';

  const totalOps = allActivity.length;
  const agents = allActivity.filter(t => t.isAgent);
  const tools = allActivity.filter(t => !t.isAgent);
  const totalDuration = allActivity.reduce((sum, t) => sum + (t.duration || 0), 0);

  const toolCounts = {};
  for (const t of tools) {
    const name = t.tool || 'Unknown';
    toolCounts[name] = (toolCounts[name] || 0) + 1;
  }
  const sortedTools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);
  const maxCount = sortedTools.length > 0 ? sortedTools[0][1] : 1;

  let successCount = 0, errorCount = 0, warningCount = 0;
  for (const t of allActivity) {
    if (t.status === 'success') successCount++;
    else if (t.status === 'error') errorCount++;
    else if (t.status === 'warning') warningCount++;
  }

  const summaryParts = [`${totalOps} ops`];
  if (agents.length > 0) summaryParts.push(`${agents.length} agent${agents.length !== 1 ? 's' : ''}`);
  if (totalDuration > 0) summaryParts.push(chatFormatElapsedShort(totalDuration) + ' total');

  let barsHtml = '';
  for (const [tool, count] of sortedTools) {
    const pct = Math.max(4, Math.round((count / maxCount) * 100));
    barsHtml += `<div class="chat-overview-bar-row">
      <span class="chat-overview-bar-label">${esc(tool)}</span>
      <div class="chat-overview-bar-track"><div class="chat-overview-bar-fill" style="width:${pct}%"></div></div>
      <span class="chat-overview-bar-count">${count}</span>
    </div>`;
  }

  let statusHtml = '';
  if (successCount || errorCount || warningCount) {
    statusHtml = '<div class="chat-overview-status-row">';
    if (successCount) statusHtml += `<span class="chat-outcome-badge chat-outcome-success">${successCount} success</span>`;
    if (errorCount) statusHtml += `<span class="chat-outcome-badge chat-outcome-error">${errorCount} error</span>`;
    if (warningCount) statusHtml += `<span class="chat-outcome-badge chat-outcome-warning">${warningCount} warning</span>`;
    statusHtml += '</div>';
  }

  let agentsHtml = '';
  if (agents.length > 0) {
    agentsHtml = '<div class="chat-overview-agents">';
    for (const a of agents) {
      const agentType = esc(a.subagentType || 'agent');
      const elapsed = a.duration ? chatFormatElapsedShort(a.duration) : '';
      const desc = a.description ? escWithCode(a.description) : '';
      const outcomeBadge = chatRenderOutcomeBadge(a);
      agentsHtml += `<div class="chat-overview-agent-row">
        <span class="chat-agent-type">${agentType}</span>
        ${desc ? `<span class="chat-overview-agent-desc">${desc}</span>` : ''}
        ${outcomeBadge}
        ${elapsed ? `<span class="chat-activity-elapsed">${elapsed}</span>` : ''}
      </div>`;
    }
    agentsHtml += '</div>';
  }

  return `<details class="chat-session-overview">
    <summary class="chat-session-overview-toggle">Session Overview: ${summaryParts.join(' \u00b7 ')}</summary>
    <div class="chat-session-overview-content">
      ${statusHtml}
      ${barsHtml ? `<div class="chat-overview-bars">${barsHtml}</div>` : ''}
      ${agentsHtml ? `<div class="chat-overview-section"><div class="chat-overview-section-title">Agents</div>${agentsHtml}</div>` : ''}
    </div>
  </details>`;
}

// ── File / image rendering ───────────────────────────────────────────────────

const FILE_CARD_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

export function chatRenderUploadedFiles(html) {
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
        const convId = artifactsIdx >= 0 ? segments[artifactsIdx + 1] : state.chatActiveConvId;
        const url = chatApiUrl(`conversations/${encodeURIComponent(convId)}/files/${encodeURIComponent(filename)}`);
        parts.push(`<div class="chat-inline-image-wrap"><img class="chat-inline-image" src="${url}" alt="${esc(filename)}" title="${esc(filename)}" onclick="chatOpenLightbox(this.src)"></div>`);
      } else {
        nonImages.push(filename);
      }
    }
    let result = '';
    if (nonImages.length) {
      const convId = state.chatActiveConvId;
      result += nonImages.map(filename => {
        const viewUrl = chatApiUrl(`conversations/${encodeURIComponent(convId)}/files/${encodeURIComponent(filename)}?mode=view`);
        const downloadUrl = chatApiUrl(`conversations/${encodeURIComponent(convId)}/files/${encodeURIComponent(filename)}?mode=download`);
        return `<div class="chat-file-card" data-file-path="${esc(filename)}">
      <div class="chat-file-card-icon">${FILE_CARD_ICON}</div>
      <div class="chat-file-card-name" title="${esc(filename)}">${esc(filename)}</div>
      <div class="chat-file-card-actions">
        <button class="chat-file-card-btn chat-file-card-view" data-view-url="${esc(viewUrl)}" data-filename="${esc(filename)}" data-file-path="${esc(filename)}" onclick="chatOpenFileViewer(this)">View</button>
        <a class="chat-file-card-btn chat-file-card-download" href="${esc(downloadUrl)}" download="${esc(filename)}">Download</a>
      </div>
    </div>`;
      }).join('');
    }
    if (parts.length) {
      result += parts.join('');
    }
    return result;
  });
}

// ── Markdown / code ──────────────────────────────────────────────────────────

// ── File delivery markers ───────────────────────────────────────────────────
// The CLI outputs <!-- FILE_DELIVERY:/path/to/file --> when the user asks for
// a deliverable file. We extract these markers before markdown parsing (since
// marked strips HTML comments) and replace them with file card HTML.

const FILE_DELIVERY_RE = /<!--\s*FILE_DELIVERY:(.*?)\s*-->/g;

function chatExtractFileDeliveries(text) {
  const files = [];
  const cleaned = text.replace(FILE_DELIVERY_RE, (_, filePath) => {
    files.push(filePath.trim());
    return ''; // remove marker from text
  });
  return { cleaned, files };
}

function chatRenderFileCards(files) {
  if (!files.length) return '';
  const wsHash = state.chatActiveConv?.workspaceHash || '';
  return files.map(filePath => {
    const filename = filePath.split('/').pop() || filePath;
    const viewUrl = chatApiUrl(`workspaces/${wsHash}/files?path=${encodeURIComponent(filePath)}&mode=view`);
    const downloadUrl = chatApiUrl(`workspaces/${wsHash}/files?path=${encodeURIComponent(filePath)}&mode=download`);
    return `<div class="chat-file-card" data-file-path="${esc(filePath)}">
      <div class="chat-file-card-icon">${FILE_CARD_ICON}</div>
      <div class="chat-file-card-name" title="${esc(filePath)}">${esc(filename)}</div>
      <div class="chat-file-card-actions">
        <button class="chat-file-card-btn chat-file-card-view" data-view-url="${esc(viewUrl)}" data-filename="${esc(filename)}" data-file-path="${esc(filePath)}" onclick="chatOpenFileViewer(this)">View</button>
        <a class="chat-file-card-btn chat-file-card-download" href="${esc(downloadUrl)}" download="${esc(filename)}">Download</a>
      </div>
    </div>`;
  }).join('');
}

export function chatRenderMarkdown(text) {
  if (!text) return '';

  // Extract FILE_DELIVERY markers before markdown parsing
  const { cleaned, files } = chatExtractFileDeliveries(text);
  const fileCardsHtml = chatRenderFileCards(files);

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
    let html = marked.parse(cleaned, { renderer, breaks: true });
    return chatRenderUploadedFiles(html) + fileCardsHtml;
  }
  let html = esc(cleaned).replace(/\n/g, '<br>');
  return chatRenderUploadedFiles(html) + fileCardsHtml;
}

// ── Lightbox ─────────────────────────────────────────────────────────────────

export function chatOpenLightbox(src) {
  const overlay = document.getElementById('chat-lightbox');
  const img = document.getElementById('chat-lightbox-img');
  img.src = src;
  overlay.classList.add('active');
  document.addEventListener('keydown', chatLightboxEscHandler);
}

export function chatCloseLightbox() {
  const overlay = document.getElementById('chat-lightbox');
  overlay.classList.remove('active');
  document.removeEventListener('keydown', chatLightboxEscHandler);
}

function chatLightboxEscHandler(e) {
  if (e.key === 'Escape') chatCloseLightbox();
}

// ── Code highlighting / actions ──────────────────────────────────────────────

export function chatHighlightCode(container) {
  if (typeof hljs === 'undefined') return;
  container.querySelectorAll('.chat-code-block pre code').forEach(el => {
    hljs.highlightElement(el);
  });
}

export function chatCopyCode(btn) {
  const codeEl = btn.closest('.chat-code-block').querySelector('code');
  if (codeEl) {
    navigator.clipboard.writeText(codeEl.textContent).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    });
  }
}

export function chatToggleCodeBlock(expandEl) {
  const block = expandEl.closest('.chat-code-block');
  if (block) {
    block.classList.toggle('collapsed');
    expandEl.textContent = block.classList.contains('collapsed') ? 'Show more' : 'Show less';
  }
}

// ── Message actions ──────────────────────────────────────────────────────────

export function chatWireMessageActions(container) {
  container.querySelectorAll('.chat-msg-action').forEach(btn => {
    btn.onclick = () => {
      const action = btn.dataset.action;
      const msgEl = btn.closest('.chat-msg');

      if (action === 'copy-msg' || action === 'copy-md') {
        let text;
        if (action === 'copy-md') {
          text = msgEl.dataset.rawContent || '';
        } else {
          const content = msgEl.querySelector('.chat-msg-content');
          text = content ? content.textContent : '';
        }
        navigator.clipboard.writeText(text).then(() => {
          const orig = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => btn.textContent = orig, 1500);
        });
      }
    };
  });
  container.querySelectorAll('[data-action="open-memory"]').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      chatOpenMemoryPanel();
    };
  });
}

// ── Streaming message UI ─────────────────────────────────────────────────────

export function chatAppendStreamingMessage() {
  const container = document.getElementById('chat-messages');
  if (!container) return null;

  const currentBackend = document.getElementById('chat-backend-select')?.value
    || state.chatActiveConv?.backend || 'claude-code';
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

export function chatGroupItemsByAgent(items) {
  const groups = [];
  const agentGroupMap = new Map();
  let currentStandalone = null;

  for (const item of items) {
    if (item._kind === 'agent' || item.isAgent) {
      currentStandalone = null;
      const group = { type: 'agent', agent: item, items: [] };
      groups.push(group);
      if (item.id) agentGroupMap.set(item.id, group);
    } else if (item.parentAgentId && agentGroupMap.has(item.parentAgentId)) {
      currentStandalone = null;
      agentGroupMap.get(item.parentAgentId).items.push(item);
    } else {
      let lastAgentGroup = null;
      for (let i = groups.length - 1; i >= 0; i--) {
        if (groups[i].type === 'agent') { lastAgentGroup = groups[i]; break; }
      }
      if (lastAgentGroup) {
        currentStandalone = null;
        lastAgentGroup.items.push(item);
      } else {
        if (!currentStandalone) {
          currentStandalone = { type: 'standalone', items: [] };
          groups.push(currentStandalone);
        }
        currentStandalone.items.push(item);
      }
    }
  }
  return groups;
}

export function chatRenderStreamingItem(item) {
  if (item.completed) {
    return chatRenderCompletedItem(item);
  }
  if (item._kind === 'agent' || item.isAgent) {
    const agentType = esc(item.subagentType || 'agent');
    const agentDesc = item.description ? escWithCode(item.description) : '';
    const initialElapsed = item.startTime ? chatFormatElapsed(Date.now() - item.startTime) : '';
    return `<div class="chat-agent-card">
      <div class="chat-agent-spinner" style="animation-delay:-${Date.now() % 800}ms"></div>
      <div class="chat-agent-card-header">
        <span class="chat-agent-type">${agentType}</span>
        ${agentDesc ? `<span class="chat-agent-card-desc">${agentDesc}</span>` : ''}
      </div>
      ${initialElapsed ? `<span class="chat-agent-timer-live">${initialElapsed}</span>` : ''}
    </div>`;
  }
  const desc = item.description ? escWithCode(item.description) : esc(item.tool || 'Working');
  const initialElapsed = item.startTime ? chatFormatElapsed(Date.now() - item.startTime) : '';
  return `<div class="chat-activity-indicator">
    <div class="chat-typing"><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div></div>
    <span class="chat-activity-label">${desc}</span>
    ${initialElapsed ? `<span class="chat-activity-timer-live">${initialElapsed}</span>` : ''}
  </div>`;
}

export function chatUpdateStreamingContent(msgEl, st) {
  if (!msgEl) return;
  const contentEl = msgEl.querySelector('.chat-msg-content');
  if (!contentEl) return;

  let html = '';

  // 1. Thinking block
  if (st.assistantThinking) {
    html += chatRenderThinkingBlock(st.assistantThinking, true);
  }

  // 2. Tool activity — per-agent layout (before text so agents show on top)
  const allItems = [
    ...chatCombinedTools(st).map(t => ({ ...t, _kind: 'tool' })),
    ...chatCombinedAgents(st).map(a => ({ ...a, _kind: 'agent' })),
  ].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));

  for (let i = 0; i < allItems.length; i++) {
    if (allItems[i].completed && !allItems[i].duration && allItems[i].startTime) {
      const nextStart = allItems[i + 1]?.startTime || Date.now();
      allItems[i] = { ...allItems[i], duration: nextStart - allItems[i].startTime };
    }
  }

  const itemGroups = chatGroupItemsByAgent(allItems);

  function renderAgentCard(agent) {
    const isRunning = !agent.completed;
    const agentType = esc(agent.subagentType || 'agent');
    const agentDesc = agent.description ? escWithCode(agent.description) : '';
    const elapsed = isRunning
      ? (agent.startTime ? chatFormatElapsed(Date.now() - agent.startTime) : '')
      : (agent.duration ? chatFormatElapsedShort(agent.duration) : '');
    const timerClass = isRunning ? 'chat-agent-timer-live' : 'chat-activity-elapsed';
    return `<div class="chat-agent-card${isRunning ? '' : ' chat-agent-card-done'}">
      ${isRunning
        ? `<div class="chat-agent-spinner" style="animation-delay:-${Date.now() % 800}ms"></div>`
        : chatRenderStatusCheck(agent)}
      <div class="chat-agent-card-header">
        <span class="chat-agent-type">${agentType}</span>
        ${agentDesc ? `<span class="chat-agent-card-desc">${agentDesc}</span>` : ''}
      </div>
      ${chatRenderOutcomeBadge(agent)}
      ${elapsed ? `<span class="${timerClass}">${elapsed}</span>` : ''}
    </div>`;
  }

  for (const group of itemGroups) {
    if (group.type === 'standalone') {
      for (const item of group.items) {
        html += chatRenderStreamingItem(item);
      }
    } else if (group.type === 'agent') {
      if (group.agent.completed && group.items.length === 0 && (group.agent.duration || 0) < 2000) {
        continue;
      }
      html += renderAgentCard(group.agent);
      if (group.items.length > 0) {
        html += '<div class="chat-agent-subactivities">';
        for (const item of group.items) {
          html += chatRenderStreamingItem(item);
        }
        html += '</div>';
      }
    } else if (group.type === 'parallel-agents') {
      for (const agent of group.agents) {
        html += renderAgentCard(agent);
      }
    }
  }

  // 3. Text content (after tool activity so agents show on top)
  if (st.assistantContent) {
    html += chatRenderMarkdown(st.assistantContent);
  } else if (st.assistantThinking && !allItems.length) {
    html += '<div class="chat-thinking-status">Thinking...</div>';
  }

  // Post-completion processing indicator
  const hasCompletedItems = st.toolHistory.length > 0 || st.agentHistory.length > 0;
  const hasRunningItems = st.activeTools.length > 0 || st.activeAgents.length > 0;
  if (hasCompletedItems && !hasRunningItems && !st.assistantContent) {
    html += `<div class="chat-activity-indicator">
      <div class="chat-typing"><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div></div>
      <span class="chat-activity-label">Processing...</span>
    </div>`;
  }

  // Plan mode banner
  if (st.planModeActive) {
    html += `<div class="chat-plan-mode-banner">
      <span class="chat-plan-mode-icon">\u{1F4CB}</span> Planning mode active
    </div>`;
  }

  // Fallback: typing dots if nothing to show
  if (!html) {
    html = `<div class="chat-activity-indicator">
      <div class="chat-typing"><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div></div>
      <span class="chat-activity-label">Working...</span>
    </div>`;
  }

  contentEl.innerHTML = html;
  if (st.assistantContent || st.assistantThinking) chatHighlightCode(contentEl);
  contentEl.querySelectorAll('.chat-agent-subactivities').forEach(el => {
    el.scrollTop = el.scrollHeight;
  });
  chatScrollToBottom();
}

// ── Archive / combine helpers ────────────────────────────────────────────────

export function chatArchiveActiveState(st) {
  const now = Date.now();
  for (const tool of st.activeTools) {
    st.toolHistory.push({ ...tool, completed: true, duration: tool.startTime ? now - tool.startTime : null });
  }
  st.activeTools = [];
  const stillRunning = [];
  for (const agent of st.activeAgents) {
    if (agent.outcome !== undefined || agent.status !== undefined) {
      st.agentHistory.push({ ...agent, completed: true, duration: agent.startTime ? now - agent.startTime : null });
    } else {
      stillRunning.push(agent);
    }
  }
  st.activeAgents = stillRunning;
  if (st.activeAgents.length === 0 && st.activeTools.length === 0) {
    if (st.activityTimerInterval) { clearInterval(st.activityTimerInterval); st.activityTimerInterval = null; }
  }
}

export function chatCombinedTools(st) {
  return [...st.toolHistory, ...st.activeTools];
}

export function chatCombinedAgents(st) {
  return [...st.agentHistory, ...st.activeAgents];
}

// ── Timers ───────────────────────────────────────────────────────────────────

export function chatStartElapsedTimer(convId) {
  const stRef = state.chatStreamingState.get(convId);
  if (!stRef || stRef.elapsedTimerInterval) return;
  const timerEl = stRef.streamingMsgEl?.querySelector('.chat-elapsed-timer');
  if (timerEl) timerEl.textContent = chatFormatElapsed(Date.now() - stRef.streamStartTime);
  stRef.elapsedTimerInterval = setInterval(() => {
    const st = state.chatStreamingState.get(convId);
    if (!st || !st.streamingMsgEl || !st.streamingMsgEl.isConnected) {
      clearInterval(stRef.elapsedTimerInterval);
      stRef.elapsedTimerInterval = null;
      return;
    }
    const el = st.streamingMsgEl.querySelector('.chat-elapsed-timer');
    if (el) el.textContent = chatFormatElapsed(Date.now() - st.streamStartTime);
  }, 1000);
}

export function chatStartActivityTimer(convId) {
  const stRef = state.chatStreamingState.get(convId);
  if (!stRef || stRef.activityTimerInterval) return;
  stRef.activityTimerInterval = setInterval(() => {
    const st = state.chatStreamingState.get(convId);
    if (!st || !st.streamingMsgEl || !st.streamingMsgEl.isConnected) {
      clearInterval(stRef.activityTimerInterval);
      stRef.activityTimerInterval = null;
      return;
    }
    if (st.pendingInteraction) return;
    if (st.activeTools.length > 0 || st.activeAgents.length > 0) {
      chatUpdateStreamingContent(st.streamingMsgEl, st);
    }
  }, 1000);
}

// ── File viewer panel ───────────────────────────────────────────────────────

export async function chatOpenFileViewer(btn) {
  const viewUrl = btn.dataset.viewUrl;
  const filename = btn.dataset.filename;
  const panel = document.getElementById('chat-file-viewer');
  const titleEl = document.getElementById('chat-file-viewer-title');
  const contentEl = document.getElementById('chat-file-viewer-content');
  if (!panel || !titleEl || !contentEl) return;

  titleEl.textContent = filename;
  contentEl.textContent = 'Loading...';
  panel.classList.add('active');

  try {
    const res = await fetch(viewUrl, { credentials: 'same-origin' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      contentEl.textContent = `Error: ${err.error || res.statusText}`;
      return;
    }
    const data = await res.json();
    const lang = data.language || '';
    contentEl.innerHTML = `<pre><code class="${lang ? 'language-' + esc(lang) : ''}">${esc(data.content)}</code></pre>`;
    if (typeof hljs !== 'undefined') {
      contentEl.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
    }
  } catch (err) {
    contentEl.textContent = `Error: ${err.message}`;
  }
}

export function chatCloseFileViewer() {
  const panel = document.getElementById('chat-file-viewer');
  if (panel) panel.classList.remove('active');
}
