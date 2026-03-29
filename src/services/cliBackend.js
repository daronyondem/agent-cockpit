const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

class CLIBackend {
  constructor(options = {}) {
    this.workingDir = options.workingDir || path.resolve(os.homedir(), '.openclaw', 'workspace');
  }

  /**
   * Send a message and get a streaming response.
   * @param {string} message - The user message
   * @param {object} options - { sessionId: string, isNewSession: boolean }
   * @returns {object} { stream: AsyncIterable<StreamEvent>, abort: Function }
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

    return { stream, abort };
  }

  async *_createStream(message, options, state) {
    const { sessionId, isNewSession, workingDir } = options;

    const args = [
      '--print',
      '--permission-mode', 'bypassPermissions',
      '--output-format', 'stream-json',
      '--verbose',
    ];

    // First message in session: create new session; subsequent: resume existing
    if (isNewSession) {
      args.push('--session-id', sessionId);
    } else {
      args.push('--resume', sessionId);
    }

    args.push('-p', message);

    // CLI backend uses its own configured model (e.g. ~/.claude/settings.json)

    try {
      const cwd = workingDir || this.workingDir;
      console.log(`[cliBackend] spawning claude, sessionId=${sessionId} isNew=${isNewSession} promptLen=${message.length} cwd=${cwd}`);
      const proc = spawn('claude', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      // Store on per-request state so abort() can find it
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
            console.log(`[cliBackend] parsed event type=${event.type}`);
            if (event.type === 'assistant' && event.message) {
              for (const block of (event.message.content || [])) {
                if (block.type === 'text' && block.text) {
                  textQueue.push({ type: 'text', content: block.text });
                }
              }
            } else if (event.type === 'content_block_delta') {
              if (event.delta && event.delta.type === 'text_delta' && event.delta.text) {
                textQueue.push({ type: 'text', content: event.delta.text });
              }
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
              textQueue.push({ type: 'text', content: event.delta.text });
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
