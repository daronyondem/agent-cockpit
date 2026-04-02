const { spawn, execFile } = require('child_process');
const path = require('path');
const os = require('os');
const { BaseBackendAdapter } = require('./base');

// ── Icon ────────────────────────────────────────────────────────────────────

const CLAUDE_CODE_ICON = '<svg width="28" height="28" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" rx="128" fill="#D37D5B"/><path d="M256 220L285 85L305 92L275 225L380 145L395 165L285 245L440 265L435 290L285 275L390 380L365 400L265 295L295 440L265 445L245 295L180 420L155 405L230 280L100 340L90 315L225 260L70 250L75 225L225 235L110 145L130 130L235 215L170 85L195 80L245 210L256 220Z" fill="#F9EDE6"/></svg>';

// ── Helpers ─────────────────────────────────────────────────────────────────

const MAX_SYSTEM_PROMPT_LENGTH = 50000;

/**
 * Strip control characters (keep newlines, tabs, carriage returns) and
 * enforce a max length so the CLI argument stays safe and bounded.
 */
function sanitizeSystemPrompt(prompt) {
  if (!prompt || typeof prompt !== 'string') return '';
  // Remove control chars except \n \r \t
  let cleaned = prompt.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  if (cleaned.length > MAX_SYSTEM_PROMPT_LENGTH) {
    cleaned = cleaned.substring(0, MAX_SYSTEM_PROMPT_LENGTH);
  }
  return cleaned;
}

const API_ERROR_PATTERN = /^API Error:\s*\d{3}\s/;

/**
 * Detect whether text content is an API error message from the Claude CLI
 * (e.g. "API Error: 500 {"type":"error",...}").
 */
function isApiError(text) {
  return API_ERROR_PATTERN.test(text.trim());
}

function shortenPath(filePath) {
  if (!filePath) return '';
  const parts = filePath.split('/');
  if (parts.length <= 3) return filePath;
  return '.../' + parts.slice(-2).join('/');
}

/**
 * Extract a short outcome summary from a tool_result content string.
 * Returns { outcome: string, status: 'success'|'error'|'warning'|null } or null.
 */
function extractToolOutcome(toolName, content) {
  if (content == null) return null;
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  if (!text) return null;

  // Bash: detect exit codes
  if (toolName === 'Bash') {
    // Claude Code tool results often include exit code info
    const exitMatch = text.match(/exit (?:code|status)[:\s]*(\d+)/i) || text.match(/exited with (\d+)/i);
    if (exitMatch) {
      const code = parseInt(exitMatch[1], 10);
      return { outcome: `exit ${code}`, status: code === 0 ? 'success' : 'error' };
    }
    // Check for common error patterns
    if (/error|ENOENT|command not found|permission denied/i.test(text.slice(0, 500))) {
      return { outcome: 'error', status: 'error' };
    }
    return { outcome: 'done', status: 'success' };
  }

  // Grep: count matches
  if (toolName === 'Grep') {
    const lines = text.split('\n').filter(l => l.trim());
    if (text.includes('No matches found') || lines.length === 0) {
      return { outcome: '0 matches', status: 'warning' };
    }
    // Count non-empty lines as approximate matches
    return { outcome: `${lines.length} match${lines.length !== 1 ? 'es' : ''}`, status: 'success' };
  }

  // Glob: count files
  if (toolName === 'Glob') {
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length === 0 || text.includes('No files found') || text.includes('No matches')) {
      return { outcome: '0 files', status: 'warning' };
    }
    return { outcome: `${lines.length} file${lines.length !== 1 ? 's' : ''}`, status: 'success' };
  }

  // Read: success or not found
  if (toolName === 'Read') {
    if (/not found|does not exist|ENOENT|no such file/i.test(text.slice(0, 200))) {
      return { outcome: 'not found', status: 'error' };
    }
    return { outcome: 'read', status: 'success' };
  }

  // Write: success
  if (toolName === 'Write') {
    if (/error|failed/i.test(text.slice(0, 200))) {
      return { outcome: 'failed', status: 'error' };
    }
    return { outcome: 'written', status: 'success' };
  }

  // Edit: success or no match
  if (toolName === 'Edit') {
    if (/not found|no match|not unique/i.test(text.slice(0, 300))) {
      return { outcome: 'no match', status: 'error' };
    }
    return { outcome: 'edited', status: 'success' };
  }

  // Agent: success or error
  if (toolName === 'Agent') {
    if (/error|failed|exception/i.test(text.slice(0, 300))) {
      return { outcome: 'error', status: 'error' };
    }
    return { outcome: 'done', status: 'success' };
  }

  // WebSearch/WebFetch
  if (toolName === 'WebSearch') {
    const lines = text.split('\n').filter(l => l.trim());
    return { outcome: `${Math.max(lines.length, 1)} result${lines.length !== 1 ? 's' : ''}`, status: 'success' };
  }
  if (toolName === 'WebFetch') {
    if (/error|failed|404|500|timeout/i.test(text.slice(0, 200))) {
      return { outcome: 'failed', status: 'error' };
    }
    return { outcome: 'fetched', status: 'success' };
  }

  return null;
}

function extractToolDetails(block) {
  const name = block.name;
  const input = block.input || {};
  const detail = { tool: name, id: block.id || null };

  switch (name) {
    case 'Read':
      detail.description = input.file_path
        ? `Reading \`${shortenPath(input.file_path)}\``
        : 'Reading file';
      break;
    case 'Write':
      detail.description = input.file_path
        ? `Writing \`${shortenPath(input.file_path)}\``
        : 'Writing file';
      detail.isPlanFile = !!(input.file_path && input.file_path.includes('.claude/plans/'));
      if (detail.isPlanFile && input.content) {
        detail.planContent = input.content;
      }
      break;
    case 'Edit':
      detail.description = input.file_path
        ? `Editing \`${shortenPath(input.file_path)}\``
        : 'Editing file';
      break;
    case 'Bash':
      if (input.description) {
        detail.description = input.description;
      } else if (input.command) {
        const cmd = input.command.length > 60
          ? input.command.substring(0, 60) + '...'
          : input.command;
        detail.description = `Running: \`${cmd}\``;
      } else {
        detail.description = 'Running command';
      }
      break;
    case 'Grep':
      detail.description = input.pattern
        ? `Searching for \`${input.pattern}\`${input.glob ? ` in ${input.glob}` : ''}`
        : 'Searching files';
      break;
    case 'Glob':
      detail.description = input.pattern
        ? `Finding files matching \`${input.pattern}\``
        : 'Finding files';
      break;
    case 'Agent':
      detail.description = input.description || 'Running sub-agent';
      detail.subagentType = input.subagent_type || 'general-purpose';
      detail.isAgent = true;
      break;
    case 'TodoWrite':
      detail.description = 'Updating task list';
      break;
    case 'WebSearch':
      detail.description = input.query
        ? `Searching: \`${input.query}\``
        : 'Searching the web';
      break;
    case 'WebFetch':
      detail.description = input.url
        ? `Fetching: ${input.url}`
        : 'Fetching web content';
      break;
    case 'EnterPlanMode':
      detail.description = 'Entering plan mode';
      detail.isPlanMode = true;
      detail.planAction = 'enter';
      break;
    case 'ExitPlanMode':
      detail.description = 'Plan ready for approval';
      detail.isPlanMode = true;
      detail.planAction = 'exit';
      break;
    case 'AskUserQuestion':
      detail.description = 'Asking a question';
      detail.isQuestion = true;
      detail.questions = input.questions || [];
      break;
    default:
      detail.description = `Using ${name}`;
  }

  return detail;
}

/**
 * Extract normalised usage data from a Claude CLI result event.
 * Returns a { type: 'usage', usage: {...} } object, or null if no usage info.
 */
function extractUsage(event) {
  const raw = event.usage;
  const hasCost = typeof event.cost_usd === 'number';
  if (!raw && !hasCost) return null;

  return {
    type: 'usage',
    usage: {
      inputTokens: raw?.input_tokens || 0,
      outputTokens: raw?.output_tokens || 0,
      cacheReadTokens: raw?.cache_read_input_tokens || 0,
      cacheWriteTokens: raw?.cache_creation_input_tokens || 0,
      costUsd: event.cost_usd || 0,
    },
  };
}

// ── Adapter ─────────────────────────────────────────────────────────────────

class ClaudeCodeAdapter extends BaseBackendAdapter {
  constructor(options = {}) {
    super(options);
    this.workingDir = options.workingDir || path.resolve(os.homedir(), '.openclaw', 'workspace');
  }

  get metadata() {
    return {
      id: 'claude-code',
      label: 'Claude Code',
      icon: CLAUDE_CODE_ICON,
      capabilities: {
        thinking: true,
        planMode: true,
        agents: true,
        toolActivity: true,
        userQuestions: true,
        stdinInput: true,
      },
    };
  }

  sendMessage(message, options = {}) {
    const state = { proc: null, aborted: false };

    const stream = this._createStream(message, options, state);
    const abort = () => {
      state.aborted = true;
      if (state.proc) {
        state.proc.kill('SIGTERM');
        state.proc = null;
      }
    };
    const sendInput = (text) => {
      if (state.proc && state.proc.stdin && !state.proc.stdin.destroyed) {
        state.proc.stdin.write(text + '\n');
      }
    };

    return { stream, abort, sendInput };
  }

  async generateSummary(messages, fallback) {
    if (!messages || messages.length === 0) return fallback || 'Empty session';
    try {
      let sessionText = '';
      for (const msg of messages) {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        const content = msg.content.substring(0, 500);
        sessionText += `${role}: ${content}\n\n`;
        if (sessionText.length > 4000) break;
      }
      const prompt = `Summarize the following chat session in one concise sentence (100-150 characters max). Only output the summary, nothing else:\n\n${sessionText}`;

      return await new Promise((resolve) => {
        execFile('claude', ['--print', '-p', prompt], { timeout: 30000 }, (err, stdout) => {
          if (err || !stdout.trim()) {
            resolve(fallback || `Session (${messages.length} messages)`);
          } else {
            resolve(stdout.trim().substring(0, 200));
          }
        });
      });
    } catch {
      return fallback || `Session (${messages.length} messages)`;
    }
  }

  async generateTitle(userMessage, fallback) {
    if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
      return fallback || 'New Chat';
    }
    try {
      const truncated = userMessage.substring(0, 2000);
      const prompt = `Generate a short, descriptive title (max 60 characters) for a conversation that starts with this user message. Only output the title text, nothing else — no quotes, no prefix:\n\n${truncated}`;

      return await new Promise((resolve) => {
        execFile('claude', ['--print', '-p', prompt], { timeout: 30000 }, (err, stdout) => {
          if (err || !stdout.trim()) {
            resolve(fallback || userMessage.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat');
          } else {
            resolve(stdout.trim().substring(0, 80));
          }
        });
      });
    } catch {
      return fallback || userMessage.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async *_createStream(message, options, state) {
    const { sessionId, isNewSession, workingDir, systemPrompt } = options;

    const args = [
      '--print',
      '--permission-mode', 'bypassPermissions',
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (isNewSession) {
      args.push('--session-id', sessionId);
      const cleanPrompt = sanitizeSystemPrompt(systemPrompt);
      if (cleanPrompt) {
        args.push('--append-system-prompt', cleanPrompt);
      }
    } else {
      args.push('--resume', sessionId);
    }

    args.push('-p', message);

    try {
      const cwd = workingDir || this.workingDir;
      console.log(`[claudeCode] spawning claude, sessionId=${sessionId} isNew=${isNewSession} promptLen=${message.length} systemPromptLen=${(systemPrompt || '').length} cwd=${cwd}`);
      const proc = spawn('claude', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      state.proc = proc;

      let buffer = '';
      const textQueue = [];
      let resolveWait = null;
      let done = false;
      let stderrOutput = '';
      const toolNameById = {};  // Track tool names by id for outcome extraction
      let lastProgressAgentId = null;  // tool_use_id from the most recent task_progress — identifies current agent context

      proc.stdout.on('data', (chunk) => {
        const raw = chunk.toString();
        console.log(`[claudeCode] stdout chunk (${raw.length} bytes)`);
        buffer += raw;
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            // Debug: log all event types with key fields
            if (event.type === 'system') {
              const keys = Object.keys(event).filter(k => k !== 'type').join(',');
              const sub = event.subtype || event.event || event.tool || '';
              console.log(`[claudeCode] parsed event type=system subtype=${sub} keys=[${keys}]`);
            } else if (event.type === 'assistant') {
              const blocks = (event.message?.content || []).map(b => b.type + (b.name ? ':' + b.name : '')).join(',');
              console.log(`[claudeCode] parsed event type=assistant blocks=[${blocks}]`);
            } else {
              console.log(`[claudeCode] parsed event type=${event.type}`, event.type === 'content_block_delta' ? `delta.type=${event.delta?.type}` : '');
            }
            // Handle system events for agent lifecycle (task_started, task_progress, task_notification)
            if (event.type === 'system' && event.subtype) {
              if (event.subtype === 'task_progress' && event.tool_use_id) {
                // Track which agent context we're in — subsequent inner tools belong to this agent
                lastProgressAgentId = event.tool_use_id;
              } else if (event.subtype === 'task_notification' && event.tool_use_id) {
                // Agent task completed — emit tool_outcomes so frontend can mark it done
                const status = event.status === 'completed' ? 'success' : (event.status || 'success');
                textQueue.push({
                  type: 'tool_outcomes',
                  outcomes: [{
                    toolUseId: event.tool_use_id,
                    isError: status === 'error',
                    outcome: event.summary || event.status || 'done',
                    status,
                  }],
                });
                // Clear context if this was the active agent
                if (lastProgressAgentId === event.tool_use_id) {
                  lastProgressAgentId = null;
                }
              }
            }

            if (event.type === 'assistant' && event.message) {
              for (const block of (event.message.content || [])) {
                if (block.type === 'text' && block.text) {
                  textQueue.push({ type: 'text', content: block.text });
                } else if (block.type === 'thinking' && block.thinking) {
                  textQueue.push({ type: 'thinking', content: block.thinking });
                } else if (block.type === 'tool_use' && block.name) {
                  if (block.id) toolNameById[block.id] = block.name;
                  const detail = extractToolDetails(block);
                  // Attribute inner tools to the agent identified by the most recent task_progress
                  if (!detail.isAgent && lastProgressAgentId) {
                    detail.parentAgentId = lastProgressAgentId;
                  }
                  textQueue.push({ type: 'tool_activity', ...detail });
                }
              }
            } else if (event.type === 'content_block_delta') {
              if (event.delta && event.delta.type === 'text_delta' && event.delta.text) {
                textQueue.push({ type: 'text', content: event.delta.text, streaming: true });
              } else if (event.delta && event.delta.type === 'thinking_delta' && event.delta.thinking) {
                textQueue.push({ type: 'thinking', content: event.delta.thinking, streaming: true });
              }
            } else if (event.type === 'user') {
              // Extract tool outcomes from tool_result blocks before emitting turn_boundary
              if (event.message && Array.isArray(event.message.content)) {
                const outcomes = [];
                for (const block of event.message.content) {
                  if (block.type === 'tool_result' && block.tool_use_id) {
                    // content can be string or array of content blocks
                    let resultContent = '';
                    if (typeof block.content === 'string') {
                      resultContent = block.content;
                    } else if (Array.isArray(block.content)) {
                      resultContent = block.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
                    }
                    const toolName = toolNameById[block.tool_use_id];
                    const extracted = extractToolOutcome(toolName, resultContent);
                    outcomes.push({
                      toolUseId: block.tool_use_id,
                      isError: block.is_error || false,
                      outcome: extracted ? extracted.outcome : (block.is_error ? 'error' : null),
                      status: extracted ? extracted.status : (block.is_error ? 'error' : null),
                    });
                  }
                }
                if (outcomes.length > 0) {
                  textQueue.push({ type: 'tool_outcomes', outcomes });
                }
              }
              textQueue.push({ type: 'turn_boundary' });
            } else if (event.type === 'result') {
              if (event.result) {
                const resultStr = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
                if (isApiError(resultStr)) {
                  textQueue.push({ type: 'error', error: resultStr.trim() });
                } else {
                  textQueue.push({ type: 'result', content: event.result });
                }
              }
              // Extract usage data from result event
              const usageEvent = extractUsage(event);
              if (usageEvent) {
                textQueue.push(usageEvent);
              }
            }
          } catch {
            textQueue.push({ type: 'text', content: line });
          }
          if (resolveWait) {
            resolveWait();
            resolveWait = null;
          }
        }
      });

      proc.stderr.on('data', (chunk) => {
        const s = chunk.toString();
        console.log(`[claudeCode] stderr: ${s.substring(0, 300)}`);
        stderrOutput += s;
      });

      proc.on('close', (code, signal) => {
        console.log(`[claudeCode] process closed code=${code} signal=${signal} bufferLen=${buffer.length}`);
        done = true;
        state.proc = null;
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer);
            if (event.type === 'content_block_delta' && event.delta?.text) {
              textQueue.push({ type: 'text', content: event.delta.text, streaming: true });
            } else if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && event.delta?.thinking) {
              textQueue.push({ type: 'thinking', content: event.delta.thinking, streaming: true });
            } else if (event.type === 'result') {
              if (event.result) {
                textQueue.push({ type: 'result', content: event.result });
              }
              const usageEvent = extractUsage(event);
              if (usageEvent) {
                textQueue.push(usageEvent);
              }
            }
          } catch {
            if (buffer.trim()) {
              textQueue.push({ type: 'text', content: buffer.trim() });
            }
          }
        }
        if (code !== 0 && code !== null) {
          textQueue.push({ type: 'error', error: stderrOutput || `Process exited with code ${code}` });
        }
        textQueue.push({ type: 'done' });
        if (resolveWait) {
          resolveWait();
          resolveWait = null;
        }
      });

      proc.on('error', (err) => {
        console.error(`[claudeCode] spawn error:`, err.message);
        done = true;
        state.proc = null;
        textQueue.push({ type: 'error', error: err.message });
        textQueue.push({ type: 'done' });
        if (resolveWait) {
          resolveWait();
          resolveWait = null;
        }
      });

      while (true) {
        if (state.aborted) {
          yield { type: 'error', error: 'Aborted by user' };
          yield { type: 'done' };
          break;
        }

        if (textQueue.length > 0) {
          const event = textQueue.shift();
          yield event;
          if (event.type === 'done') break;
        } else if (done) {
          break;
        } else {
          await new Promise((resolve) => {
            resolveWait = resolve;
            setTimeout(resolve, 100);
          });
        }
      }
    } finally {
      // no cleanup needed
    }
  }
}

module.exports = { ClaudeCodeAdapter, extractToolDetails, extractToolOutcome, extractUsage, shortenPath, sanitizeSystemPrompt, isApiError };
