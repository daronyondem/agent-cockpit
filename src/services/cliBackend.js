const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

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

class CLIBackend {
  constructor(options = {}) {
    this.workingDir = options.workingDir || path.resolve(os.homedir(), '.openclaw', 'workspace');
  }

  /**
   * Send a message and get a streaming response.
   * @param {string} message - The user message
   * @param {object} options - { sessionId: string, isNewSession: boolean }
   * @returns {object} { stream, abort, sendInput }
   */
  sendMessage(message, options = {}) {
    // Per-request state — not shared across requests
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

  async *_createStream(message, options, state) {
    const { sessionId, isNewSession, workingDir, systemPrompt } = options;

    const args = [
      '--print',
      '--permission-mode', 'bypassPermissions',
      '--output-format', 'stream-json',
      '--verbose',
    ];

    // First message in session: create new session; subsequent: resume existing
    if (isNewSession) {
      args.push('--session-id', sessionId);
      if (systemPrompt) {
        args.push('--append-system-prompt', systemPrompt);
      }
    } else {
      args.push('--resume', sessionId);
    }

    args.push('-p', message);

    try {
      const cwd = workingDir || this.workingDir;
      console.log(`[cliBackend] spawning claude, sessionId=${sessionId} isNew=${isNewSession} promptLen=${message.length} cwd=${cwd}`);
      const proc = spawn('claude', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      // Store on per-request state so abort() and sendInput() can find it
      state.proc = proc;

      let buffer = '';
      const textQueue = [];
      let resolveWait = null;
      let done = false;
      let stderrOutput = '';

      proc.stdout.on('data', (chunk) => {
        const raw = chunk.toString();
        console.log(`[cliBackend] stdout chunk (${raw.length} bytes)`);
        buffer += raw;
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            console.log(`[cliBackend] parsed event type=${event.type}`, event.type === 'content_block_delta' ? `delta.type=${event.delta?.type}` : '');
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
                textQueue.push({ type: 'result', content: event.result });
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
        console.log(`[cliBackend] stderr: ${s.substring(0, 300)}`);
        stderrOutput += s;
      });

      proc.on('close', (code, signal) => {
        console.log(`[cliBackend] process closed code=${code} signal=${signal} bufferLen=${buffer.length}`);
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
        console.error(`[cliBackend] spawn error:`, err.message);
        done = true;
        state.proc = null;
        textQueue.push({ type: 'error', error: err.message });
        textQueue.push({ type: 'done' });
        if (resolveWait) {
          resolveWait();
          resolveWait = null;
        }
      });

      // Yield events as they arrive
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

module.exports = { CLIBackend };
