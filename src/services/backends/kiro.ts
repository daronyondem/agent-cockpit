import { spawn, execFile, type ChildProcess } from 'child_process';
import path from 'path';
import os from 'os';
import { BaseBackendAdapter } from './base';
import { sanitizeSystemPrompt, extractToolOutcome, shortenPath } from './toolUtils';
import type {
  BackendMetadata,
  SendMessageOptions,
  SendMessageResult,
  StreamEvent,
  Message,
  ToolDetail,
} from '../../types';

// ── Icon ────────────���───────────────────────────────────────────────────────

const KIRO_ICON = '<svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="28" height="28" rx="6" fill="#232F3E"/><text x="14" y="19" text-anchor="middle" font-family="Arial,sans-serif" font-weight="bold" font-size="14" fill="#FF9900">K</text></svg>';

// ── Configuration ──────────���────────────────────────────────────────────────

const ACP_IDLE_TIMEOUT_MS = parseInt(process.env.KIRO_ACP_IDLE_TIMEOUT_MS || '', 10) || 600_000;

// ── Kiro Tool Name Normalization ────────────���───────────────────────────────

const KIRO_TOOL_NAME_MAP: Record<string, string> = {
  read: 'Read',
  fs_read: 'Read',
  fsRead: 'Read',
  write: 'Write',
  fs_write: 'Write',
  fsWrite: 'Write',
  shell: 'Bash',
  execute_bash: 'Bash',
  execute_cmd: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  delegate: 'Agent',
  subagent: 'Agent',
  use_subagent: 'Agent',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  todo: 'TodoWrite',
  aws: 'AWS',
  use_aws: 'AWS',
  code: 'Code',
  introspect: 'Introspect',
  knowledge: 'Knowledge',
  session: 'Session',
  report: 'Report',
};

function normalizeKiroToolName(kiroName: string): string {
  return KIRO_TOOL_NAME_MAP[kiroName] || kiroName;
}

export function extractKiroToolDetails(toolCallId: string, kiroName: string, title: string, kind?: string): ToolDetail {
  const normalizedName = normalizeKiroToolName(kiroName);
  const detail: ToolDetail = { tool: normalizedName, id: toolCallId, description: '' };

  if (normalizedName === 'Agent' || kiroName === 'delegate' || kiroName === 'subagent' || kiroName === 'use_subagent') {
    detail.isAgent = true;
    detail.subagentType = 'general-purpose';
  }

  // Use the title from ACP as the description — it's already human-readable
  detail.description = title || `Using ${normalizedName}`;

  return detail;
}

// ── ACP JSON-RPC Client ───────────���────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

interface AcpProcess {
  proc: ChildProcess;
  client: AcpClient;
  loadedSessionId: string | null;
  idleTimer: NodeJS.Timeout | null;
}

class AcpClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pendingRequests: Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }> = new Map();
  private notificationQueue: JsonRpcNotification[] = [];
  private notificationResolve: (() => void) | null = null;
  private buffer = '';
  private closed = false;
  private stopRequested = false;

  constructor(proc: ChildProcess) {
    this.proc = proc;

    proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcMessage;
          if ('method' in msg && msg.method) {
            // Notification or server-to-client request (e.g. session/request_permission)
            // Check method BEFORE id — server requests have both method and id
            this.notificationQueue.push(msg as JsonRpcNotification);
            if (this.notificationResolve) {
              this.notificationResolve();
              this.notificationResolve = null;
            }
          } else if ('id' in msg && msg.id != null) {
            // Response to one of our requests (has id but no method)
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
              this.pendingRequests.delete(msg.id);
              const resp = msg as JsonRpcResponse;
              if (resp.error) {
                pending.reject(new Error(resp.error.message));
              } else {
                pending.resolve(resp.result);
              }
            }
          }
        } catch {
          console.warn('[kiro] Failed to parse ACP message:', line.substring(0, 200));
        }
      }
    });

    proc.on('close', () => {
      this.closed = true;
      // Reject all pending requests
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error('ACP process closed'));
      }
      this.pendingRequests.clear();
      // Wake up any notification waiter
      if (this.notificationResolve) {
        this.notificationResolve();
        this.notificationResolve = null;
      }
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error('ACP process is closed');

    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.proc.stdin!.write(JSON.stringify(msg) + '\n');
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return;
    const msg = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    this.proc.stdin!.write(JSON.stringify(msg) + '\n');
  }

  respond(id: number, result: unknown): void {
    if (this.closed) return;
    const msg = { jsonrpc: '2.0', id, result };
    this.proc.stdin!.write(JSON.stringify(msg) + '\n');
  }

  stopNotifications(): void {
    this.stopRequested = true;
    if (this.notificationResolve) {
      this.notificationResolve();
      this.notificationResolve = null;
    }
  }

  async *notifications(): AsyncGenerator<JsonRpcNotification> {
    while (!this.closed && !this.stopRequested) {
      if (this.notificationQueue.length > 0) {
        yield this.notificationQueue.shift()!;
      } else {
        await new Promise<void>((resolve) => {
          this.notificationResolve = resolve;
          setTimeout(resolve, 100);
        });
      }
    }
    // Drain remaining notifications before exiting
    while (this.notificationQueue.length > 0) {
      yield this.notificationQueue.shift()!;
    }
    this.stopRequested = false;
  }

  hasNotifications(): boolean {
    return this.notificationQueue.length > 0;
  }

  takeRequestNotification(): JsonRpcNotification | null {
    // Look for session/request_permission messages (they have an id from Kiro's side
    // but arrive as method calls we need to respond to)
    return null;
  }

  kill(): void {
    if (!this.closed) {
      this.proc.kill('SIGTERM');
    }
  }
}

// ── Adapter ���────────────────────────────────────────────────────────────────

export class KiroAdapter extends BaseBackendAdapter {
  private processes: Map<string, AcpProcess> = new Map();
  private sessionMap: Map<string, string> = new Map();

  constructor(options: { workingDir?: string } = {}) {
    super(options);
    this.workingDir = options.workingDir || path.resolve(os.homedir(), '.kiro', 'workspace');
  }

  get metadata(): BackendMetadata {
    return {
      id: 'kiro',
      label: 'Kiro',
      icon: KIRO_ICON,
      capabilities: {
        thinking: true,
        planMode: false,
        agents: true,
        toolActivity: true,
        userQuestions: false,
        stdinInput: false,
      },
    };
  }

  shutdown(): void {
    for (const [convId, entry] of this.processes) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.proc.kill('SIGTERM');
    }
    this.processes.clear();
  }

  onSessionReset(conversationId: string): void {
    // Clean up session mapping
    for (const [key, _] of this.sessionMap) {
      // We can't easily reverse-lookup which sessionMap entries belong to this conversation
      // So the adapter will just let stale entries expire naturally.
      // The ACP process is the important thing to clean up.
    }

    const acpEntry = this.processes.get(conversationId);
    if (acpEntry) {
      if (acpEntry.idleTimer) clearTimeout(acpEntry.idleTimer);
      acpEntry.proc.kill('SIGTERM');
      this.processes.delete(conversationId);
    }
  }

  sendMessage(message: string, options: SendMessageOptions = {} as SendMessageOptions): SendMessageResult {
    let aborted = false;
    let currentClient: AcpClient | null = null;

    const stream = this._createStream(message, options, {
      get aborted() { return aborted; },
      set client(c: AcpClient | null) { currentClient = c; },
    });

    const abort = () => {
      aborted = true;
      if (currentClient && !currentClient.isClosed) {
        const kiroSessionId = this.sessionMap.get(options.sessionId);
        if (kiroSessionId) {
          currentClient.request('session/cancel', { sessionId: kiroSessionId }).catch(() => {});
        }
      }
    };

    const sendInput = (_text: string) => {
      // Kiro uses session/request_permission, not stdin. No-op.
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
        execFile('kiro-cli', ['chat', '--no-interactive', '--trust-all-tools', prompt], { timeout: 30000 }, (err, stdout) => {
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
        execFile('kiro-cli', ['chat', '--no-interactive', '--trust-all-tools', prompt], { timeout: 30000 }, (err, stdout) => {
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

  // ── Private ─────────���─────────────────────────────────────────────────────

  private _resetIdleTimer(conversationId: string): void {
    const entry = this.processes.get(conversationId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      console.log(`[kiro] Idle timeout for conv=${conversationId}, killing ACP process`);
      entry.proc.kill('SIGTERM');
      this.processes.delete(conversationId);
    }, ACP_IDLE_TIMEOUT_MS);
  }

  private async _getOrSpawnClient(conversationId: string): Promise<AcpClient> {
    const existing = this.processes.get(conversationId);
    if (existing && !existing.proc.killed && existing.proc.exitCode === null) {
      this._resetIdleTimer(conversationId);
      return existing.client;
    }

    // Clean up dead entry if present
    if (existing) {
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      this.processes.delete(conversationId);
    }

    console.log(`[kiro] Spawning kiro-cli acp for conv=${conversationId}`);
    const proc = spawn('kiro-cli', ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Capture spawn errors (e.g. ENOENT if kiro-cli is not in PATH)
    proc.on('error', (err) => {
      console.error(`[kiro] Process spawn error: ${err.message}`);
    });

    proc.on('close', (code, signal) => {
      console.log(`[kiro] Process closed for conv=${conversationId} code=${code} signal=${signal}`);
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      console.error(`[kiro] stderr: ${chunk.toString().substring(0, 500)}`);
    });

    const client = new AcpClient(proc);

    // Initialize handshake
    await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: 'agent-cockpit', version: '1.0.0' },
    });
    console.log(`[kiro] ACP initialized for conv=${conversationId}`);

    this.processes.set(conversationId, {
      proc,
      client,
      loadedSessionId: null,
      idleTimer: null,
    });
    this._resetIdleTimer(conversationId);

    return client;
  }

  private async *_createStream(
    message: string,
    options: SendMessageOptions,
    state: { readonly aborted: boolean; client: AcpClient | null },
  ): AsyncGenerator<StreamEvent> {
    const { sessionId, conversationId, isNewSession, workingDir, systemPrompt, externalSessionId } = options;
    const convId = conversationId || sessionId; // fallback to sessionId if conversationId not provided
    const cwd = workingDir || this.workingDir || undefined;

    let client: AcpClient;
    try {
      client = await this._getOrSpawnClient(convId);
      state.client = client;
    } catch (err) {
      const errMsg = (err as Error).message;
      if (errMsg.includes('ENOENT') || errMsg.includes('not found')) {
        yield { type: 'error', error: 'Kiro CLI is not installed. Install it from https://kiro.dev/cli/' };
      } else {
        yield { type: 'error', error: `Failed to start Kiro: ${errMsg}` };
      }
      yield { type: 'done' };
      return;
    }

    try {
      // ── Session setup ──────────────────────────────────────────────────
      let kiroSessionId = this.sessionMap.get(sessionId);

      if (isNewSession) {
        const result = await client.request('session/new', { cwd, mcpServers: [] }) as { sessionId: string };
        kiroSessionId = result.sessionId;
        this.sessionMap.set(sessionId, kiroSessionId);
        console.log(`[kiro] Created new session: ${kiroSessionId} for cockpit session ${sessionId}`);
      } else if (!kiroSessionId && externalSessionId) {
        // Rehydrate from persisted externalSessionId (server restart scenario)
        kiroSessionId = externalSessionId;
        this.sessionMap.set(sessionId, kiroSessionId);
      }

      if (!kiroSessionId) {
        yield { type: 'error', error: 'No Kiro session ID available for this conversation' };
        yield { type: 'done' };
        return;
      }

      // Load session if this is a different process than the one that created it
      const acpEntry = this.processes.get(convId);
      if (acpEntry && acpEntry.loadedSessionId !== kiroSessionId) {
        if (!isNewSession) {
          await client.request('session/load', { sessionId: kiroSessionId, cwd, mcpServers: [] });
          console.log(`[kiro] Loaded session: ${kiroSessionId}`);
        }
        acpEntry.loadedSessionId = kiroSessionId;
      }

      // ── Build prompt ─────────────────��─────────────────────────────────
      let promptText = message;
      if (isNewSession) {
        const cleanPrompt = sanitizeSystemPrompt(systemPrompt);
        if (cleanPrompt) {
          promptText = cleanPrompt + '\n\n' + message;
        }
      }

      // ── Send prompt ────────────────────────────────────────────────────
      console.log(`[kiro] Sending prompt to session=${kiroSessionId} len=${promptText.length}`);
      // When the session/prompt response arrives, signal the notification loop to stop
      client.request('session/prompt', {
        sessionId: kiroSessionId,
        prompt: [{ type: 'text', text: promptText }],
      }).then(() => {
        client.stopNotifications();
      }).catch(() => {
        client.stopNotifications();
      });

      // ── Stream notifications ───────────────────────────────────────────
      const toolNameById: Record<string, string> = {};
      const activeToolIds = new Set<string>();
      // Subagent tracking: map sessionId → agent name, toolCallId → sessionId
      const subagentNames: Map<string, string> = new Map();
      const toolToSubagent: Map<string, string> = new Map();
      const emittedSubagents = new Set<string>();

      for await (const notification of client.notifications()) {
        if (state.aborted) {
          yield { type: 'error', error: 'Aborted by user' };
          yield { type: 'done' };
          return;
        }

        const params = (notification.params || {}) as Record<string, unknown>;

        // ── Permission requests (auto-approve) ─────────────────────────
        if (notification.method === 'session/request_permission') {
          const reqId = (notification as any).id;
          if (reqId != null) {
            client.respond(reqId, {
              outcome: { outcome: 'selected', optionId: 'allow_always' },
            });
          }
          continue;
        }

        // ── Kiro internal notifications ────────────────────────────────
        if (notification.method.startsWith('_kiro.dev/')) {
          // Extract subagent info from list_update
          if (notification.method === '_kiro.dev/subagent/list_update') {
            const subagents = (notification.params as any)?.subagents as Array<{ sessionId: string; sessionName: string; agentName?: string; initialQuery?: string }> | undefined;
            if (subagents) {
              for (const sa of subagents) {
                if (sa.sessionId && sa.sessionName) {
                  subagentNames.set(sa.sessionId, sa.sessionName);
                  // Emit agent activity for new subagents
                  if (!emittedSubagents.has(sa.sessionId)) {
                    emittedSubagents.add(sa.sessionId);
                    yield {
                      type: 'tool_activity',
                      tool: 'Agent',
                      id: sa.sessionId,
                      description: sa.sessionName,
                      isAgent: true,
                      subagentType: sa.agentName || 'kiro_default',
                    };
                  }
                }
              }
            }
          }
          // Map toolCallId → sessionId from subagent session updates
          if (notification.method === '_kiro.dev/session/update') {
            const intUpdate = (notification.params as any)?.update as Record<string, unknown> | undefined;
            const intSessionId = (notification.params as any)?.sessionId as string | undefined;
            if (intUpdate && intSessionId && intUpdate.toolCallId) {
              toolToSubagent.set(intUpdate.toolCallId as string, intSessionId);
            }
          }
          continue;
        }

        // ── Session updates ────────────────────────────────────────────
        if (notification.method === 'session/update') {
          const update = params.update as Record<string, unknown>;
          if (!update) continue;

          const updateType = update.sessionUpdate as string;

          // ── Agent message chunk ──────────────────────────────────────
          if (updateType === 'agent_message_chunk') {
            const content = update.content as Record<string, unknown>;
            if (content && content.type === 'text' && content.text) {
              if (activeToolIds.size > 0) {
                // Tools are active — suppress agent reasoning text.
                // Agent activities already show what's happening.
              } else {
                // No tools active — this is the final response
                yield { type: 'text', content: content.text as string, streaming: true };
              }
            }
          }

          // ── Tool call (pending) ──────────────────────────────────────
          else if (updateType === 'tool_call') {
            const toolCallId = update.toolCallId as string;
            const title = update.title as string || '';
            const kind = update.kind as string || '';
            const status = update.status as string || 'pending';
            const toolName = kind || title.split(' ')[0] || 'unknown';

            toolNameById[toolCallId] = toolName;

            if (status === 'pending' || status === 'in_progress') {
              // Check for thinking tool — special-case
              if (toolName === 'thinking') {
                // Will emit thinking content when tool_call_update arrives
                continue;
              }

              activeToolIds.add(toolCallId);
              const detail = extractKiroToolDetails(toolCallId, toolName, title, kind);

              // Check if this tool belongs to a subagent
              const subagentSessionId = toolToSubagent.get(toolCallId);
              if (subagentSessionId && subagentNames.has(subagentSessionId)) {
                detail.parentAgentId = subagentSessionId;
              }

              yield { type: 'tool_activity', ...detail };
            }
          }

          // ── Tool call update (completed) ─────────────────────────────
          else if (updateType === 'tool_call_update') {
            const toolCallId = update.toolCallId as string;
            const status = update.status as string || 'completed';
            const toolName = toolNameById[toolCallId] || 'unknown';
            const contentArray = update.content as Array<{ content?: { type: string; text?: string } }> | undefined;
            let resultText = '';
            if (contentArray && Array.isArray(contentArray)) {
              resultText = contentArray
                .filter(c => c.content?.type === 'text')
                .map(c => c.content?.text || '')
                .join('\n');
            }

            activeToolIds.delete(toolCallId);

            // Thinking tool — emit as ThinkingEvent
            if (toolName === 'thinking') {
              if (resultText) {
                yield { type: 'thinking', content: resultText };
              }
              continue;
            }

            const normalizedName = normalizeKiroToolName(toolName);
            const extracted = extractToolOutcome(normalizedName, resultText);
            yield {
              type: 'tool_outcomes',
              outcomes: [{
                toolUseId: toolCallId,
                isError: status === 'error',
                outcome: extracted ? extracted.outcome : (status === 'error' ? 'error' : 'done'),
                status: extracted ? extracted.status : (status === 'error' ? 'error' : 'success'),
              }],
            };

          }

          // ── Turn end ─────────────────────────────────────────────────
          else if (updateType === 'turn_end') {
            yield { type: 'done' };
            return;
          }
        }

        // ── Other notification methods (ignore) ───────────────────────
      }

      // Notification loop exited — either turn_end, prompt response, or process closed
      yield { type: 'done' };
    } catch (err) {
      yield { type: 'error', error: `Kiro error: ${(err as Error).message}` };
      yield { type: 'done' };
    }
  }
}
