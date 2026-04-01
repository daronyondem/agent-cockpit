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
            console.log(`[claudeCode] parsed event type=${event.type}`, event.type === 'content_block_delta' ? `delta.type=${event.delta?.type}` : '');
            if (event.type === 'assistant' && event.message) {
              for (const block of (event.message.content || [])) {
                if (block.type === 'text' && block.text) {
                  textQueue.push({ type: 'text', content: block.text });
                } else if (block.type === 'thinking' && block.thinking) {
                  textQueue.push({ type: 'thinking', content: block.thinking });
                } else if (block.type === 'tool_use' && block.name) {
                  textQueue.push({ type: 'tool_activity', ...extractToolDetails(block) });
                }
              }
            } else if (event.type === 'content_block_delta') {
              if (event.delta && event.delta.type === 'text_delta' && event.delta.text) {
                textQueue.push({ type: 'text', content: event.delta.text, streaming: true });
              } else if (event.delta && event.delta.type === 'thinking_delta' && event.delta.thinking) {
                textQueue.push({ type: 'thinking', content: event.delta.thinking, streaming: true });
              }
            } else if (event.type === 'user') {
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
            } else if (event.type === 'result' && event.result) {
              textQueue.push({ type: 'result', content: event.result });
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

module.exports = { ClaudeCodeAdapter, extractToolDetails, shortenPath, sanitizeSystemPrompt, isApiError };
