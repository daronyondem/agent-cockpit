import { spawn, execFile, type ChildProcess } from 'child_process';
import path from 'path';
import os from 'os';
import { BaseBackendAdapter } from './base';
import {
  sanitizeSystemPrompt,
  isApiError,
  extractToolDetails,
  extractToolOutcome,
  extractUsage,
} from './toolUtils';
import type {
  BackendMetadata,
  SendMessageOptions,
  SendMessageResult,
  StreamEvent,
  Message,
  CliEvent,
  CliToolUseBlock,
  CliToolResultBlock,
} from '../../types';

// Re-export shared helpers for backwards compatibility with existing imports
export { sanitizeSystemPrompt, isApiError, shortenPath, extractToolDetails, extractToolOutcome, extractUsage } from './toolUtils';

// ── Icon ────────────────────────────────────────────────────────────────────

const CLAUDE_CODE_ICON = '<svg width="28" height="28" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" rx="128" fill="#D37D5B"/><path d="M256 220L285 85L305 92L275 225L380 145L395 165L285 245L440 265L435 290L285 275L390 380L365 400L265 295L295 440L265 445L245 295L180 420L155 405L230 280L100 340L90 315L225 260L70 250L75 225L225 235L110 145L130 130L235 215L170 85L195 80L245 210L256 220Z" fill="#F9EDE6"/></svg>';

// ── Adapter ─────────────────────────────────────────────────────────────────

interface StreamState {
  proc: ChildProcess | null;
  aborted: boolean;
}

export class ClaudeCodeAdapter extends BaseBackendAdapter {
  constructor(options: { workingDir?: string } = {}) {
    super(options);
    this.workingDir = options.workingDir || path.resolve(os.homedir(), '.openclaw', 'workspace');
  }

  get metadata(): BackendMetadata {
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

  sendMessage(message: string, options: SendMessageOptions = {} as SendMessageOptions): SendMessageResult {
    const state: StreamState = { proc: null, aborted: false };

    const stream = this._createStream(message, options, state);
    const abort = () => {
      state.aborted = true;
      if (state.proc) {
        state.proc.kill('SIGTERM');
        state.proc = null;
      }
    };
    const sendInput = (text: string) => {
      if (state.proc && state.proc.stdin && !state.proc.stdin.destroyed) {
        state.proc.stdin.write(text + '\n');
      }
    };

    return { stream, abort, sendInput };
  }

  async generateSummary(messages: Pick<Message, 'role' | 'content'>[], fallback: string): Promise<string> {
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

      return await new Promise<string>((resolve) => {
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

  async generateTitle(userMessage: string, fallback: string): Promise<string> {
    if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
      return fallback || 'New Chat';
    }
    try {
      const truncated = userMessage.substring(0, 2000);
      const prompt = `Generate a short, descriptive title (max 60 characters) for a conversation that starts with this user message. Only output the title text, nothing else — no quotes, no prefix:\n\n${truncated}`;

      return await new Promise<string>((resolve) => {
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

  async *_createStream(
    message: string,
    options: SendMessageOptions,
    state: StreamState,
  ): AsyncGenerator<StreamEvent> {
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
      const cwd = workingDir || this.workingDir || undefined;
      console.log(`[claudeCode] spawning claude, sessionId=${sessionId} isNew=${isNewSession} promptLen=${message.length} systemPromptLen=${(systemPrompt || '').length} cwd=${cwd}`);
      const proc = spawn('claude', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      state.proc = proc;

      let buffer = '';
      const textQueue: StreamEvent[] = [];
      let resolveWait: (() => void) | null = null;
      let done = false;
      let stderrOutput = '';
      const toolNameById: Record<string, string> = {};
      let lastProgressAgentId: string | null = null;
      let detectedModel: string | null = null;

      proc.stdout!.on('data', (chunk: Buffer) => {
        const raw = chunk.toString();
        console.log(`[claudeCode] stdout chunk (${raw.length} bytes)`);
        buffer += raw;
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as CliEvent;
            if (event.type === 'system') {
              const keys = Object.keys(event).filter(k => k !== 'type').join(',');
              const sub = event.subtype || event.event || event.tool || '';
              console.log(`[claudeCode] parsed event type=system subtype=${sub} keys=[${keys}]`);
            } else if (event.type === 'assistant') {
              const blocks = (event.message?.content || []).map(b => b.type + ('name' in b && b.name ? ':' + b.name : '')).join(',');
              console.log(`[claudeCode] parsed event type=assistant blocks=[${blocks}]`);
            } else {
              console.log(`[claudeCode] parsed event type=${event.type}`, event.type === 'content_block_delta' ? `delta.type=${event.delta?.type}` : '');
            }

            if (event.type === 'system' && event.subtype === 'init' && event.model) {
              detectedModel = event.model;
            }

            if (event.type === 'system' && event.subtype) {
              if (event.subtype === 'task_progress' && event.tool_use_id) {
                lastProgressAgentId = event.tool_use_id;
              } else if (event.subtype === 'task_notification' && event.tool_use_id) {
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
                if (lastProgressAgentId === event.tool_use_id) {
                  lastProgressAgentId = null;
                }
              }
            }

            if (event.type === 'assistant' && event.message) {
              for (const block of (event.message.content || [])) {
                if (block.type === 'text' && 'text' in block && block.text) {
                  textQueue.push({ type: 'text', content: block.text });
                } else if (block.type === 'thinking' && 'thinking' in block && block.thinking) {
                  textQueue.push({ type: 'thinking', content: block.thinking });
                } else if (block.type === 'tool_use' && 'name' in block && block.name) {
                  if (block.id) toolNameById[block.id] = block.name;
                  const detail = extractToolDetails(block as CliToolUseBlock);
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
              if (event.message && Array.isArray(event.message.content)) {
                const outcomes: Array<{
                  toolUseId: string;
                  isError: boolean;
                  outcome: string | null;
                  status: string | null;
                }> = [];
                for (const block of event.message.content) {
                  if (block.type === 'tool_result' && 'tool_use_id' in block) {
                    const trBlock = block as CliToolResultBlock;
                    let resultContent = '';
                    if (typeof trBlock.content === 'string') {
                      resultContent = trBlock.content;
                    } else if (Array.isArray(trBlock.content)) {
                      resultContent = trBlock.content.filter(c => c.type === 'text').map(c => c.text || '').join('\n');
                    }
                    const toolName = toolNameById[trBlock.tool_use_id];
                    const extracted = extractToolOutcome(toolName, resultContent);
                    outcomes.push({
                      toolUseId: trBlock.tool_use_id,
                      isError: trBlock.is_error || false,
                      outcome: extracted ? extracted.outcome : (trBlock.is_error ? 'error' : null),
                      status: extracted ? extracted.status : (trBlock.is_error ? 'error' : null),
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
                  textQueue.push({ type: 'result', content: typeof event.result === 'string' ? event.result : JSON.stringify(event.result) });
                }
              }
              const usageEvent = extractUsage(event as { usage?: Record<string, number>; cost_usd?: number });
              if (usageEvent) {
                if (detectedModel) usageEvent.model = detectedModel;
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

      proc.stderr!.on('data', (chunk: Buffer) => {
        const s = chunk.toString();
        console.log(`[claudeCode] stderr: ${s.substring(0, 300)}`);
        stderrOutput += s;
      });

      proc.on('close', (code: number | null, signal: string | null) => {
        console.log(`[claudeCode] process closed code=${code} signal=${signal} bufferLen=${buffer.length}`);
        done = true;
        state.proc = null;
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer) as CliEvent;
            if (event.type === 'content_block_delta' && event.delta?.text) {
              textQueue.push({ type: 'text', content: event.delta.text, streaming: true });
            } else if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && event.delta?.thinking) {
              textQueue.push({ type: 'thinking', content: event.delta.thinking, streaming: true });
            } else if (event.type === 'result') {
              if (event.result) {
                textQueue.push({ type: 'result', content: typeof event.result === 'string' ? event.result : JSON.stringify(event.result) });
              }
              const usageEvent = extractUsage(event as { usage?: Record<string, number>; cost_usd?: number });
              if (usageEvent) {
                if (detectedModel) usageEvent.model = detectedModel;
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

      proc.on('error', (err: Error) => {
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
          yield { type: 'error' as const, error: 'Aborted by user' };
          yield { type: 'done' as const };
          break;
        }

        if (textQueue.length > 0) {
          const event = textQueue.shift()!;
          yield event;
          if (event.type === 'done') break;
        } else if (done) {
          break;
        } else {
          await new Promise<void>((resolve) => {
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
