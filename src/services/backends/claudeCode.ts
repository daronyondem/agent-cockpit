import { spawn, execFile, type ChildProcess } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { BaseBackendAdapter, type RunOneShotOptions } from './base';
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
  MemorySnapshot,
  MemoryFile,
  MemoryType,
} from '../../types';

// Re-export shared helpers for backwards compatibility with existing imports
export { sanitizeSystemPrompt, isApiError, shortenPath, extractToolDetails, extractToolOutcome, extractUsage } from './toolUtils';

// ── Icon ────────────────────────────────────────────────────────────────────

const CLAUDE_CODE_ICON = '<svg width="28" height="28" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" rx="128" fill="#D37D5B"/><path d="M256 220L285 85L305 92L275 225L380 145L395 165L285 245L440 265L435 290L285 275L390 380L365 400L265 295L295 440L265 445L245 295L180 420L155 405L230 280L100 340L90 315L225 260L70 250L75 225L225 235L110 145L130 130L235 215L170 85L195 80L245 210L256 220Z" fill="#F9EDE6"/></svg>';

function filterStdinWarning(stderr: string): string {
  return String(stderr || '')
    .split('\n')
    .filter(l => !l.includes('no stdin data received'))
    .join('\n')
    .trim();
}

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
      models: [
        {
          id: 'opus',
          label: 'Opus 4.6',
          family: 'opus',
          description: 'Most capable — complex reasoning, architecture, nuanced tasks',
          costTier: 'high',
          supportedEffortLevels: ['low', 'medium', 'high', 'max'],
        },
        {
          id: 'sonnet',
          label: 'Sonnet 4.6',
          family: 'sonnet',
          description: 'Balanced — fast and capable for most coding tasks',
          costTier: 'medium',
          default: true,
          supportedEffortLevels: ['low', 'medium', 'high'],
        },
        {
          id: 'haiku',
          label: 'Haiku 4.5',
          family: 'haiku',
          description: 'Fastest and cheapest — simple tasks, quick iterations',
          costTier: 'low',
        },
        {
          id: 'opus[1m]',
          label: 'Opus 4.6 (1M context)',
          family: 'opus',
          description: 'Extended context window for large codebases',
          costTier: 'high',
          supportedEffortLevels: ['low', 'medium', 'high', 'max'],
        },
        {
          id: 'sonnet[1m]',
          label: 'Sonnet 4.6 (1M context)',
          family: 'sonnet',
          description: 'Extended context window with balanced performance',
          costTier: 'medium',
          supportedEffortLevels: ['low', 'medium', 'high'],
        },
      ],
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
        const child = execFile('claude', ['--print', '-p', prompt], { timeout: 30000 }, (err, stdout) => {
          if (err || !stdout.trim()) {
            resolve(fallback || `Session (${messages.length} messages)`);
          } else {
            resolve(stdout.trim().substring(0, 200));
          }
        });
        child.stdin?.end();
      });
    } catch {
      return fallback || `Session (${messages.length} messages)`;
    }
  }

  getMemoryDir(workspacePath: string): string | null {
    if (!workspacePath) return null;
    // Canonicalize worktrees to the main repo path so all worktrees of
    // one repo share a single memory directory.
    const canonicalPath = resolveCanonicalWorkspacePath(workspacePath);
    return resolveClaudeMemoryDir(canonicalPath);
  }

  async extractMemory(workspacePath: string): Promise<MemorySnapshot | null> {
    if (!workspacePath) {
      console.log('[memory] ClaudeCode.extractMemory: empty workspacePath');
      return null;
    }
    // If the workspace is a git worktree, resolve to the main repo's path
    // so all worktrees of the same repo share one memory directory.
    // Non-git workspaces and main repos pass through unchanged.
    const canonicalPath = resolveCanonicalWorkspacePath(workspacePath);
    if (canonicalPath !== workspacePath) {
      console.log(`[memory] ClaudeCode.extractMemory: canonicalized worktree ${workspacePath} -> ${canonicalPath}`);
    }
    const memDir = resolveClaudeMemoryDir(canonicalPath);
    if (!memDir) {
      const sanitized = canonicalPath.replace(/[^a-zA-Z0-9]/g, '-');
      console.log(`[memory] ClaudeCode.extractMemory: no memory dir found for workspacePath=${canonicalPath} (sanitized=${sanitized})`);
      return null;
    }
    console.log(`[memory] ClaudeCode.extractMemory: resolved memDir=${memDir}`);

    let entries: string[];
    try {
      entries = await fsp.readdir(memDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }

    const mdFiles = entries.filter(f => f.toLowerCase().endsWith('.md'));
    let indexContent = '';
    const files: MemoryFile[] = [];

    for (const filename of mdFiles) {
      const full = path.join(memDir, filename);
      let content: string;
      try {
        content = await fsp.readFile(full, 'utf8');
      } catch {
        continue;
      }
      if (filename === 'MEMORY.md') {
        indexContent = content;
        continue;
      }
      const meta = parseFrontmatter(content);
      files.push({
        filename,
        name: meta.name,
        description: meta.description,
        type: meta.type,
        content,
      });
    }

    if (!indexContent && files.length === 0) return null;

    files.sort((a, b) => a.filename.localeCompare(b.filename));

    return {
      capturedAt: new Date().toISOString(),
      sourceBackend: 'claude-code',
      sourcePath: memDir,
      index: indexContent,
      files,
    };
  }

  /**
   * Run the Claude CLI in one-shot (`--print`) mode against a single
   * prompt and return the full text output.  Used by the Memory MCP
   * server when Claude Code is the configured Memory CLI.
   */
  async runOneShot(prompt: string, options: RunOneShotOptions = {}): Promise<string> {
    const { model, effort, timeoutMs = 60000, workingDir, allowTools, mcpServers } = options;
    const args = ['--print', '-p', prompt];
    // Digestion / Dreaming need to read every file under the workspace
    // KB directory; they run with `allowTools: true` so Claude's
    // sandboxed tool use can proceed without per-call prompting. Memory
    // callers leave this off so a buggy prompt can't read the disk.
    if (allowTools) {
      args.push('--permission-mode', 'bypassPermissions');
    }
    // Wire MCP servers (e.g. KB Search tools during dreaming).
    if (Array.isArray(mcpServers) && mcpServers.length > 0) {
      args.push('--mcp-config', mcpServersToClaudeConfigJson(mcpServers));
    }
    if (model) args.push('--model', model);
    if (effort && model) {
      const modelOption = this.metadata.models?.find(m => m.id === model);
      if (modelOption?.supportedEffortLevels?.includes(effort)) {
        args.push('--effort', effort);
      }
    }
    return await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'claude',
        args,
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, cwd: workingDir || undefined },
        (err, stdout, stderr) => {
          if (err) {
            // Filter the stdin warning — it's not the real error.
            const filtered = filterStdinWarning(stderr || '');
            // Build a concise error message — don't echo the full command
            // (it contains the entire prompt and is useless in error output).
            const execErr = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string; signal?: string };
            let msg: string;
            if (execErr.killed) {
              msg = `Process killed (timeout after ${timeoutMs / 1000}s)`;
            } else if (filtered) {
              msg = filtered;
            } else {
              msg = `Process exited with code ${execErr.code ?? 'unknown'}`;
            }
            reject(new Error(`claude --print failed: ${msg}`));
            return;
          }
          resolve((stdout || '').trim());
        },
      );
      // Close stdin immediately so the CLI doesn't wait 3s and warn.
      child.stdin?.end();
    });
  }

  async generateTitle(userMessage: string, fallback: string): Promise<string> {
    if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
      return fallback || 'New Chat';
    }
    try {
      const truncated = userMessage.substring(0, 2000);
      const prompt = `Generate a short, descriptive title (max 60 characters) for a conversation that starts with this user message. Only output the title text, nothing else — no quotes, no prefix:\n\n${truncated}`;

      return await new Promise<string>((resolve) => {
        const child = execFile('claude', ['--print', '-p', prompt], { timeout: 30000 }, (err, stdout) => {
          if (err || !stdout.trim()) {
            resolve(fallback || userMessage.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat');
          } else {
            resolve(stdout.trim().substring(0, 80));
          }
        });
        child.stdin?.end();
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
    const { sessionId, isNewSession, workingDir, systemPrompt, model, effort, mcpServers } = options;

    const args = [
      '--print',
      '--permission-mode', 'bypassPermissions',
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (model) {
      args.push('--model', model);
    }

    // Only forward --effort when the selected model actually supports the level.
    // This guards against stale conversation state after a model downgrade.
    if (effort && model) {
      const modelOption = this.metadata.models?.find(m => m.id === model);
      if (modelOption?.supportedEffortLevels?.includes(effort)) {
        args.push('--effort', effort);
      }
    }

    if (isNewSession) {
      args.push('--session-id', sessionId);
      const cleanPrompt = sanitizeSystemPrompt(systemPrompt);
      if (cleanPrompt) {
        args.push('--append-system-prompt', cleanPrompt);
      }
    } else {
      args.push('--resume', sessionId);
    }

    // Transform the ACP-shaped mcpServers array into Claude Code's
    // `--mcp-config` JSON (env is a plain object, not an array). This
    // lets the cockpit wire the Memory MCP stub for Claude Code sessions
    // the same way it does for Kiro, so `memory_note` is available as
    // `mcp__agent-cockpit-memory__memory_note` in the model's tool list.
    if (Array.isArray(mcpServers) && mcpServers.length > 0) {
      const configJson = mcpServersToClaudeConfigJson(mcpServers);
      args.push('--mcp-config', configJson);
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
          const filteredStderr = filterStdinWarning(stderrOutput);
          const stdinTimedOut = !filteredStderr && stderrOutput.includes('no stdin data received');
          if (!stdinTimedOut) {
            textQueue.push({ type: 'error', error: filteredStderr || `Process exited with code ${code}` });
          }
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

// ── MCP config ──────────────────────────────────────────────────────────────

/**
 * Transform the ACP-shaped `mcpServers` array the cockpit builds for
 * `memoryMcp.issueMemoryMcpSession` into the JSON string that Claude
 * Code's `--mcp-config` flag accepts.
 *
 * - ACP shape: `[{ name, command, args, env: [{name, value}] }]`
 * - Claude Code shape: `{ mcpServers: { [name]: { command, args, env: {K: V} } } }`
 *
 * The ACP env-as-array format is a protocol requirement for Kiro; Claude
 * Code expects a plain `Record<string,string>`, so we flatten here.
 */
export function mcpServersToClaudeConfigJson(
  servers: Array<{
    name: string;
    command: string;
    args: string[];
    env?: Array<{ name: string; value: string }>;
  }>,
): string {
  const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  for (const server of servers) {
    const envObj: Record<string, string> = {};
    for (const pair of server.env || []) {
      if (pair && typeof pair.name === 'string') envObj[pair.name] = pair.value;
    }
    mcpServers[server.name] = {
      command: server.command,
      args: Array.isArray(server.args) ? server.args : [],
      ...(Object.keys(envObj).length > 0 ? { env: envObj } : {}),
    };
  }
  return JSON.stringify({ mcpServers });
}

// ── Memory helpers ──────────────────────────────────────────────────────────

/**
 * If `workspacePath` is a git worktree, returns the absolute path to the
 * main repository's workspace (so all worktrees of one repo share memory).
 * For main repos, non-git workspaces, or anything we can't confidently
 * resolve, returns `workspacePath` unchanged.  Pure filesystem — does not
 * shell out to `git`.
 *
 * Detection is intentionally conservative: we only canonicalize when
 * `workspacePath/.git` is a FILE containing a `gitdir:` pointer (the
 * on-disk signature of a worktree).  A `.git` directory means this is
 * already the main repo, and no `.git` at all means it isn't a git
 * workspace — both are returned as-is.
 */
export function resolveCanonicalWorkspacePath(workspacePath: string): string {
  if (!workspacePath) return workspacePath;
  const gitEntry = path.join(workspacePath, '.git');

  let stat: fs.Stats;
  try {
    stat = fs.statSync(gitEntry);
  } catch {
    return workspacePath;
  }
  if (stat.isDirectory()) return workspacePath;
  if (!stat.isFile()) return workspacePath;

  let gitFileContent: string;
  try {
    gitFileContent = fs.readFileSync(gitEntry, 'utf8');
  } catch {
    return workspacePath;
  }

  // Worktree .git file looks like: "gitdir: <path-to-worktree-metadata>"
  const match = gitFileContent.match(/^\s*gitdir:\s*(.+?)\s*$/m);
  if (!match) return workspacePath;

  let worktreeGitDir = match[1];
  if (!path.isAbsolute(worktreeGitDir)) {
    worktreeGitDir = path.resolve(workspacePath, worktreeGitDir);
  }

  // Inside the worktree's gitdir, `commondir` points at the main .git dir.
  // It's usually "../.." (relative to the worktree gitdir) but can be absolute.
  const commondirFile = path.join(worktreeGitDir, 'commondir');
  let commonDirRaw: string;
  try {
    commonDirRaw = fs.readFileSync(commondirFile, 'utf8').trim();
  } catch {
    return workspacePath;
  }
  if (!commonDirRaw) return workspacePath;

  const mainGitDir = path.isAbsolute(commonDirRaw)
    ? commonDirRaw
    : path.resolve(worktreeGitDir, commonDirRaw);

  // The main repo's workspace is the directory containing the main .git dir.
  const mainWorkspace = path.dirname(mainGitDir);

  // Sanity check: the resolved main workspace should actually exist and
  // contain a `.git` directory.  If not, bail out and keep the original.
  try {
    const mainGitStat = fs.statSync(path.join(mainWorkspace, '.git'));
    if (!mainGitStat.isDirectory()) return workspacePath;
  } catch {
    return workspacePath;
  }

  return mainWorkspace;
}

/**
 * Claude Code stores per-project memory under:
 *   ~/.claude/projects/{sanitized-path}/memory/
 *
 * The sanitized path is produced by replacing every non-alphanumeric
 * character in the absolute workspace path with `-`.  For long paths
 * (>200 chars) Claude Code appends a hash suffix we can't reproduce
 * in Node (Bun.hash vs djb2), so we fall back to a directory scan.
 *
 * Returns the absolute path where memory *will live*, even if the
 * directory does not exist yet or contains no `.md` files — callers
 * like the real-time memory watcher need to know the target path up
 * front so they can create and watch it before Claude Code writes
 * anything.  Only returns `null` when the workspace path is long
 * enough to require a hash suffix *and* no existing dir matches —
 * in that case the watcher can't attach until a session-reset capture
 * reveals the real dirname.
 */
export function resolveClaudeMemoryDir(workspacePath: string): string | null {
  // Prefer $HOME env var over os.homedir() so tests can sandbox the
  // lookup by pointing HOME at a temp directory — os.homedir() caches
  // its result in some runtimes and ignores later env-var changes.
  const home = process.env.HOME || os.homedir();
  const projectsDir = path.join(home, '.claude', 'projects');
  const sanitized = workspacePath.replace(/[^a-zA-Z0-9]/g, '-');

  // Short paths: the sanitized name is the exact dirname, so return
  // the deterministic path regardless of whether anything has been
  // written yet.  `extractMemory` independently handles ENOENT when
  // actually reading files, so returning a non-existent path here is
  // safe and lets the watcher attach early.
  const direct = path.join(projectsDir, sanitized, 'memory');
  if (sanitized.length <= 200) {
    return direct;
  }

  // Long paths: Claude Code appends a hash we can't reproduce.  First
  // check the exact sanitized path (no hash) in case Claude Code didn't
  // truncate, then scan for a prefix match.
  if (dirHasMemory(direct)) return direct;

  let entries: string[];
  try {
    entries = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }

  const prefix = sanitized.slice(0, Math.min(sanitized.length, 200));
  const candidates: string[] = [];
  for (const entry of entries) {
    if (entry === sanitized || entry.startsWith(prefix + '-') || entry.startsWith(prefix)) {
      const candidate = path.join(projectsDir, entry, 'memory');
      if (dirHasMemory(candidate)) candidates.push(candidate);
    }
  }

  if (candidates.length === 0) return null;
  // Deterministic pick: shortest dir name (no suffix) wins.
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0];
}

function dirHasMemory(memDir: string): boolean {
  try {
    const stat = fs.statSync(memDir);
    if (!stat.isDirectory()) return false;
    const files = fs.readdirSync(memDir);
    return files.some(f => f.toLowerCase().endsWith('.md'));
  } catch {
    return false;
  }
}

interface ParsedFrontmatter {
  name: string | null;
  description: string | null;
  type: MemoryType;
}

/**
 * Parses the YAML frontmatter at the top of a Claude Code memory file.
 * Only extracts `name`, `description`, and `type` — the fields the
 * memory system documents.  We don't pull in a full YAML parser for
 * this; frontmatter in these files is simple `key: value` pairs.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const result: ParsedFrontmatter = { name: null, description: null, type: 'unknown' };
  if (!content.startsWith('---')) return result;

  const end = content.indexOf('\n---', 3);
  if (end === -1) return result;

  const block = content.slice(3, end);
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    let value = line.slice(sep + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value) continue;
    if (key === 'name') result.name = value;
    else if (key === 'description') result.description = value;
    else if (key === 'type') {
      const t = value.toLowerCase();
      if (t === 'user' || t === 'feedback' || t === 'project' || t === 'reference') {
        result.type = t;
      }
    }
  }
  return result;
}
