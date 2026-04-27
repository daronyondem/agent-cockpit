import { spawn, type ChildProcess } from 'child_process';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { BaseBackendAdapter, type RunOneShotOptions } from './base';
import { sanitizeSystemPrompt, extractToolOutcome, shortenPath } from './toolUtils';
import type {
  BackendMetadata,
  SendMessageOptions,
  SendMessageResult,
  StreamEvent,
  Message,
  ToolDetail,
  McpServerConfig,
} from '../../types';

// ── Icon ────────────���───────────────────────────────────────────────────────

const KIRO_ICON = '<svg width="28" height="28" viewBox="0 0 1200 1200" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="1200" rx="260" fill="#9046FF"/><mask id="mask0_1106_4856" style="mask-type:luminance" maskUnits="userSpaceOnUse" x="272" y="202" width="655" height="796"><path d="M926.578 202.793H272.637V997.857H926.578V202.793Z" fill="white"/></mask><g mask="url(#mask0_1106_4856)"><path d="M398.554 818.914C316.315 1001.03 491.477 1046.74 620.672 940.156C658.687 1059.66 801.052 970.473 852.234 877.795C964.787 673.567 919.318 465.357 907.64 422.374C827.637 129.443 427.623 128.946 358.8 423.865C342.651 475.544 342.402 534.18 333.458 595.051C328.986 625.86 325.507 645.488 313.83 677.785C306.873 696.424 297.68 712.819 282.773 740.645C259.915 783.881 269.604 867.113 387.87 823.883L399.051 818.914H398.554Z" fill="white"/><path d="M636.123 549.353C603.328 549.353 598.359 510.097 598.359 486.742C598.359 465.623 602.086 448.977 609.293 438.293C615.504 428.852 624.697 424.131 636.123 424.131C647.555 424.131 657.492 428.852 664.447 438.541C672.398 449.474 676.623 466.12 676.623 486.742C676.623 525.998 661.471 549.353 636.375 549.353H636.123Z" fill="black"/><path d="M771.24 549.353C738.445 549.353 733.477 510.097 733.477 486.742C733.477 465.623 737.203 448.977 744.41 438.293C750.621 428.852 759.814 424.131 771.24 424.131C782.672 424.131 792.609 428.852 799.564 438.541C807.516 449.474 811.74 466.12 811.74 486.742C811.74 525.998 796.588 549.353 771.492 549.353H771.24Z" fill="black"/></g></svg>';

// ── Configuration ──────────���────────────────────────────────────────────────

const ACP_IDLE_TIMEOUT_MS = parseInt(process.env.KIRO_ACP_IDLE_TIMEOUT_MS || '', 10) || 3_600_000;

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
  /** Present when the peer is actually sending a JSON-RPC request (e.g. `session/request_permission`),
      not a pure notification — the queue holds both. */
  id?: number;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

interface KiroSessionNewResult {
  sessionId: string;
}

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

  drainNotifications(): number {
    const count = this.notificationQueue.length;
    this.notificationQueue = [];
    return count;
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

// ── Image attachment for ACP session/prompt ────────────────────────────────
//
// Kiro's `fs_read` tool in Image mode base64-inlines image bytes into the
// conversation transcript, which can blow the upstream model's prompt budget
// (manifests as JSON-RPC `-32603 Internal error: Prompt is too long`). To
// avoid that path entirely, when the prompt mentions an image file by
// basename and that file exists in `workingDir`, attach it as a proper ACP
// `{type:"image"}` content block instead. This is fully encapsulated inside
// the Kiro adapter — callers pass plain text prompts and a `workingDir` like
// before.

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const MAX_IMAGE_ATTACHMENTS = 5;

// True when `basename` appears in `prompt` not as a prefix/suffix of a
// longer filename. Required because filename chars (letters/digits/`.`/`_`/`-`)
// flow into each other: e.g. `foo.png` is a substring of `foo.png.ai.png`,
// so a naive `includes` would attach both files when only the longer one is
// the intended target — overflowing Kiro's 10 MB attachment cap.
function basenameAppearsAsToken(prompt: string, basename: string): boolean {
  const isFilenameChar = (c: string) => /[A-Za-z0-9._-]/.test(c);
  let from = 0;
  while (true) {
    const idx = prompt.indexOf(basename, from);
    if (idx < 0) return false;
    const before = idx === 0 ? '' : prompt[idx - 1];
    const afterIdx = idx + basename.length;
    const after = afterIdx >= prompt.length ? '' : prompt[afterIdx];
    if (!isFilenameChar(before) && !isFilenameChar(after)) return true;
    from = idx + 1;
  }
}

export async function collectImageContentBlocks(
  prompt: string,
  workingDir: string | undefined,
): Promise<Array<{ type: 'image'; mimeType: string; data: string }>> {
  if (!workingDir) return [];
  let entries: string[];
  try {
    entries = await fsp.readdir(workingDir);
  } catch {
    return [];
  }
  const blocks: Array<{ type: 'image'; mimeType: string; data: string }> = [];
  for (const entry of entries) {
    if (blocks.length >= MAX_IMAGE_ATTACHMENTS) break;
    const ext = path.extname(entry).toLowerCase();
    const mimeType = IMAGE_MIME_BY_EXT[ext];
    if (!mimeType) continue;
    if (!basenameAppearsAsToken(prompt, entry)) continue;
    try {
      const filePath = path.join(workingDir, entry);
      const buf = await fsp.readFile(filePath);
      blocks.push({ type: 'image', mimeType, data: buf.toString('base64') });
    } catch {
      // skip unreadable files
    }
  }
  return blocks;
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
      models: [
        {
          id: 'auto',
          label: 'auto',
          family: 'router',
          description: "Kiro's model router — picks the optimal model per task",
          costTier: 'medium',
          default: true,
        },
        {
          id: 'claude-opus-4.7',
          label: 'claude-opus-4.7',
          family: 'opus',
          description: 'Latest Anthropic model — enhanced agentic capabilities and 3x higher resolution vision',
          costTier: 'high',
        },
        {
          id: 'claude-opus-4.6',
          label: 'claude-opus-4.6',
          family: 'opus',
          description: 'State-of-the-art coding; strong on agentic tasks and large codebases',
          costTier: 'high',
        },
        {
          id: 'claude-opus-4.5',
          label: 'claude-opus-4.5',
          family: 'opus',
          description: 'Maximum reasoning depth for complex multi-system problems and tradeoff analysis',
          costTier: 'high',
        },
        {
          id: 'claude-sonnet-4.6',
          label: 'claude-sonnet-4.6',
          family: 'sonnet',
          description: 'Approaches Opus intelligence while being more token-efficient for iterative workflows',
          costTier: 'medium',
        },
        {
          id: 'claude-sonnet-4.5',
          label: 'claude-sonnet-4.5',
          family: 'sonnet',
          description: 'Best model for complex agents with extended autonomous operation',
          costTier: 'medium',
        },
        {
          id: 'claude-sonnet-4.0',
          label: 'claude-sonnet-4.0',
          family: 'sonnet',
          description: 'Consistent baseline Sonnet — no routing or optimization layers',
          costTier: 'medium',
        },
        {
          id: 'claude-haiku-4.5',
          label: 'claude-haiku-4.5',
          family: 'haiku',
          description: 'Fast — matches Sonnet 4 performance at roughly one-third the cost',
          costTier: 'low',
        },
        {
          id: 'deepseek-3.2',
          label: 'deepseek-3.2',
          family: 'other',
          description: 'Open-weight model optimized for agentic workflows and multi-step reasoning',
          costTier: 'low',
        },
        {
          id: 'minimax-m2.5',
          label: 'minimax-m2.5',
          family: 'other',
          description: 'Open-weight model delivering frontier-class coding at reduced cost',
          costTier: 'low',
        },
        {
          id: 'minimax-m2.1',
          label: 'minimax-m2.1',
          family: 'other',
          description: 'Open-weight model — strong multilingual programming across many languages',
          costTier: 'low',
        },
        {
          id: 'glm-5',
          label: 'glm-5',
          family: 'other',
          description: 'Sparse mixture-of-experts — repository-scale context and long agentic tasks',
          costTier: 'low',
        },
        {
          id: 'qwen3-coder-next',
          label: 'qwen3-coder-next',
          family: 'other',
          description: 'Purpose-built coding agent — 256K context and strong error recovery',
          costTier: 'low',
        },
      ],
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

      const out = await this._acpOneShot(prompt, { timeoutMs: 30000 });
      if (!out) return fallback || `Session (${messages.length} messages)`;
      return out.substring(0, 200);
    } catch {
      return fallback || `Session (${messages.length} messages)`;
    }
  }

  /**
   * Run a one-shot prompt against an ephemeral `kiro-cli acp` session and
   * return the model's final answer text. Used by the Memory MCP server,
   * KB digestion, and the OCR endpoint via this `runOneShot` entry point;
   * also used internally for `generateTitle` / `generateSummary` so every
   * Kiro one-shot call goes through the same structured ACP path.
   *
   * Why ACP instead of `kiro-cli chat --no-interactive`:
   * `kiro-cli chat` prints tool-call narration ("Reading images: ...",
   * " (using tool: read)", " ✓ Successfully ...", " - Completed in Xs")
   * inline with the answer text. Parsing it back out is fragile and
   * version-dependent. ACP is a structured JSON-RPC protocol where
   * `agent_message_chunk` (assistant text) is distinct from `tool_call`
   * notifications, so we get the final answer without any string parsing.
   */
  async runOneShot(prompt: string, options: RunOneShotOptions = {}): Promise<string> {
    return this._acpOneShot(prompt, options);
  }

  async generateTitle(userMessage: string, fallback: string): Promise<string> {
    if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
      return fallback || 'New Chat';
    }
    const titleFallback = () => fallback || userMessage.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
    try {
      const truncated = userMessage.substring(0, 2000);
      const prompt = `Generate a short, descriptive title (max 8 words) for a conversation that starts with this user message. Only output the title text, nothing else — no quotes, no prefix:\n\n${truncated}`;

      const out = await this._acpOneShot(prompt, { timeoutMs: 30000 });
      if (!out) return titleFallback();
      return out.substring(0, 80);
    } catch {
      return titleFallback();
    }
  }

  // ── Private ─────────���─────────────────────────────────────────────────────

  /**
   * Spawn an ephemeral `kiro-cli acp` process, run a single prompt, collect
   * the model's final answer, and return it. The single shared one-shot
   * primitive used by `runOneShot`, `generateTitle`, and `generateSummary`.
   *
   * Buffer rule: append `agent_message_chunk` text only when no tool is
   * currently active; **clear** the buffer on each `tool_call`; remove from
   * the active set on `tool_call_update`. This discards any pre-tool
   * reasoning ("Let me read the image first.") and retains only the
   * post-tool final answer.
   */
  private _acpOneShot(prompt: string, options: RunOneShotOptions = {}): Promise<string> {
    const { timeoutMs = 60000, workingDir, model, mcpServers } = options;
    const cwd = workingDir || this.workingDir || os.homedir();
    const mcpServersForAcp: McpServerConfig[] = Array.isArray(mcpServers) ? mcpServers : [];

    const proc = spawn('kiro-cli', ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stderrBuf = '';
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    });

    const client = new AcpClient(proc);
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (!proc.killed) proc.kill('SIGTERM');
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      timer = setTimeout(() => {
        settle(() => reject(new Error(`kiro-cli acp runOneShot timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      proc.on('error', (err) => {
        const msg = err.message.includes('ENOENT')
          ? 'Kiro CLI is not installed. Install it from https://kiro.dev/cli/'
          : `kiro-cli acp spawn failed: ${err.message}`;
        settle(() => reject(new Error(msg)));
      });

      (async () => {
        try {
          await client.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: true, writeTextFile: true },
              terminal: true,
            },
            clientInfo: { name: 'agent-cockpit', version: '1.0.0' },
          });

          const sessionResult = await client.request('session/new', {
            cwd,
            mcpServers: mcpServersForAcp,
          }) as KiroSessionNewResult;
          const kiroSessionId = sessionResult.sessionId;

          if (model) {
            try {
              await Promise.race([
                client.request('session/set_model', { sessionId: kiroSessionId, modelId: model }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
              ]);
            } catch {
              // Ignore — fall back to default model
            }
          }

          const imageBlocks = await collectImageContentBlocks(prompt, cwd);
          const promptArray: Array<Record<string, unknown>> = [
            { type: 'text', text: prompt },
            ...imageBlocks,
          ];

          let promptError: Error | null = null;
          client.request('session/prompt', {
            sessionId: kiroSessionId,
            prompt: promptArray,
          }).then(() => {
            client.stopNotifications();
          }).catch((err: Error) => {
            promptError = err;
            client.stopNotifications();
          });

          let buffer = '';
          const activeToolIds = new Set<string>();

          for await (const notification of client.notifications()) {
            if (notification.method === 'session/request_permission') {
              const reqId = notification.id;
              if (reqId != null) {
                client.respond(reqId, {
                  outcome: { outcome: 'selected', optionId: 'allow_always' },
                });
              }
              continue;
            }

            if (notification.method !== 'session/update') continue;

            const params = (notification.params || {}) as Record<string, unknown>;
            const update = params.update as Record<string, unknown>;
            if (!update) continue;

            const updateType = update.sessionUpdate as string;

            if (updateType === 'agent_message_chunk') {
              const content = update.content as Record<string, unknown> | undefined;
              if (content && content.type === 'text' && typeof content.text === 'string' && activeToolIds.size === 0) {
                buffer += content.text;
              }
            } else if (updateType === 'tool_call') {
              const toolCallId = update.toolCallId as string;
              const status = (update.status as string) || 'pending';
              const kind = (update.kind as string) || '';
              const title = (update.title as string) || '';
              const toolName = kind || title.split(' ')[0] || 'unknown';
              if (toolName === 'thinking') continue;
              if (status === 'pending' || status === 'in_progress') {
                activeToolIds.add(toolCallId);
                buffer = '';
              }
            } else if (updateType === 'tool_call_update') {
              const toolCallId = update.toolCallId as string;
              activeToolIds.delete(toolCallId);
            }
          }

          if (promptError) {
            const stderr = stderrBuf.trim();
            settle(() => reject(new Error(`kiro-cli acp prompt failed: ${promptError!.message}${stderr ? ` | stderr: ${stderr.slice(0, 200)}` : ''}`)));
            return;
          }

          settle(() => resolve(buffer.trim()));
        } catch (err) {
          const stderr = stderrBuf.trim();
          settle(() => reject(new Error(`kiro-cli acp runOneShot failed: ${(err as Error).message}${stderr ? ` | stderr: ${stderr.slice(0, 200)}` : ''}`)));
        }
      })();
    });
  }

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
    const { sessionId, conversationId, isNewSession, workingDir, systemPrompt, externalSessionId, mcpServers } = options;
    const convId = conversationId || sessionId; // fallback to sessionId if conversationId not provided
    const cwd = workingDir || this.workingDir || undefined;
    // ACP expects `mcpServers: []` at minimum; forward any configured servers
    // (e.g. the Memory MCP stub) from the caller.
    const mcpServersForAcp = Array.isArray(mcpServers) ? mcpServers : [];

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
        const result = await client.request('session/new', { cwd, mcpServers: mcpServersForAcp }) as KiroSessionNewResult;
        kiroSessionId = result.sessionId;
        this.sessionMap.set(sessionId, kiroSessionId);
        console.log(`[kiro] Created new session: ${kiroSessionId} for cockpit session ${sessionId}`);
        // Signal processStream to persist the Kiro session ID onto the
        // cockpit's SessionEntry.externalSessionId so we can rehydrate
        // after a cockpit server restart (in-memory sessionMap is wiped).
        yield { type: 'external_session', sessionId: kiroSessionId };
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
          await client.request('session/load', { sessionId: kiroSessionId, cwd, mcpServers: mcpServersForAcp });
          // `session/load` replays the full session history as `session/update`
          // notifications before returning. Drain them so they don't leak into
          // the next `session/prompt`'s stream (which would concatenate prior
          // assistant turns into the current response).
          const drained = client.drainNotifications();
          console.log(`[kiro] Loaded session: ${kiroSessionId} (drained ${drained} replayed notifications)`);
        }
        acpEntry.loadedSessionId = kiroSessionId;
      }

      // ── Model selection ──────────────────────────────────────────────
      // session/set_model is silently ignored (no response) if sessionId is
      // wrong or model is unsupported, so we race against a timeout to avoid
      // blocking the prompt indefinitely.
      if (options.model) {
        try {
          await Promise.race([
            client.request('session/set_model', {
              sessionId: kiroSessionId,
              modelId: options.model,
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
          ]);
          console.log(`[kiro] Set model to ${options.model} for session ${kiroSessionId}`);
        } catch (err) {
          const reason = (err as Error).message;
          console.warn(`[kiro] Failed to set model (${reason}), continuing with default`);
          yield { type: 'error', error: `Failed to switch to model "${options.model}" — ${reason === 'timeout' ? 'Kiro did not respond (model may be unavailable)' : reason}. Using default model.` };
        }
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
      // Empirically, Kiro holds the `session/prompt` JSON-RPC response until
      // the turn is fully done — after all subagents, tool calls, permission
      // requests, and streaming chunks complete. The response body's
      // `stopReason` IS the end-of-turn signal; Kiro does NOT emit a
      // `session/update` with `sessionUpdate: 'turn_end'` on the ACP
      // channel. Once the response arrives, stop notifications immediately.
      client.request('session/prompt', {
        sessionId: kiroSessionId,
        prompt: [{ type: 'text', text: promptText }],
      }).then((resp) => {
        const stopReason = (resp as { stopReason?: string } | null)?.stopReason;
        console.log(`[kiro] Turn ended session=${kiroSessionId} stopReason=${stopReason}`);
        client.stopNotifications();
      }).catch((err) => {
        console.warn(`[kiro] session/prompt failed for session=${kiroSessionId}: ${(err as Error).message}`);
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

        // Reset idle timer on every notification — keeps long-running turns
        // (multi-agent, large refactors) from being SIGTERM'd mid-flight.
        this._resetIdleTimer(convId);

        const params = (notification.params || {}) as Record<string, unknown>;

        // ── Permission requests (auto-approve) ─────────────────────────
        if (notification.method === 'session/request_permission') {
          const reqId = notification.id;
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
            const subagents = notification.params?.subagents as Array<{ sessionId: string; sessionName: string; agentName?: string; initialQuery?: string }> | undefined;
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
            const intUpdate = notification.params?.update as Record<string, unknown> | undefined;
            const intSessionId = notification.params?.sessionId as string | undefined;
            if (intUpdate && intSessionId && intUpdate.toolCallId) {
              toolToSubagent.set(intUpdate.toolCallId as string, intSessionId);
            }
          }
          // Extract credits and context usage from metadata
          if (notification.method === '_kiro.dev/metadata') {
            const meta = notification.params as Record<string, unknown> | undefined;
            if (meta) {
              const credits = typeof meta.credits === 'number' ? meta.credits : undefined;
              const contextPct = typeof meta.contextUsagePercentage === 'number' ? meta.contextUsagePercentage : undefined;
              if (credits !== undefined || contextPct !== undefined) {
                yield {
                  type: 'usage',
                  usage: {
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    costUsd: 0,
                    credits,
                    contextUsagePercentage: contextPct,
                  },
                };
              }
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
          // Defensive: Kiro does not emit this on the ACP channel (the
          // `session/prompt` response body's `stopReason` is the real
          // end-of-turn signal), but the ACP spec lists `turn_end` as a
          // valid `sessionUpdate` so handle it if it ever arrives.
          else if (updateType === 'turn_end') {
            yield { type: 'done' };
            return;
          }
        }

        // ── Other notification methods (ignore) ───────────────────────
      }

      // Notification loop exited — session/prompt response arrived and
      // called stopNotifications(), or the ACP process closed.
      yield { type: 'done' };
    } catch (err) {
      yield { type: 'error', error: `Kiro error: ${(err as Error).message}` };
      yield { type: 'done' };
    }
  }
}
