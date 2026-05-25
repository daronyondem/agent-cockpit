import { execFile, spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BaseBackendAdapter, type BackendCallOptions, type RunOneShotAttachment, type RunOneShotOptions } from './base';
import { extractToolOutcome, shortenPath } from './toolUtils';
import {
  buildNativeSessionRecovery,
  buildSessionRecoveryEvent,
  createRecoverySnapshot,
  isMissingNativeSessionError,
} from './sessionRecovery';
import { buildCliCommandInvocation, resolveCliCommandForRuntime, type CliCommandResolution } from '../cliCommandResolver';
import { logger } from '../../utils/logger';
import type {
  BackendMetadata,
  CliProfile,
  EffortLevel,
  McpServerConfig,
  ModelCapabilities,
  ModelInputModality,
  ModelOutputModality,
  ModelOption,
  SendMessageOptions,
  SendMessageResult,
  StreamEvent,
  Usage,
} from '../../types';

const OPENCODE_ICON = null;
const OPENCODE_EXEC_TIMEOUT_MS = 60_000;
const OPENCODE_MAX_BUFFER = 4 * 1024 * 1024;
const OPENCODE_EFFORT_ORDER: EffortLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const OPENCODE_EFFORT_SET = new Set<string>(OPENCODE_EFFORT_ORDER);
const opencodeLog = logger.child({ module: 'opencode-backend' });

export interface OpenCodeCliRuntime extends CliCommandResolution {
  command: string;
  env: NodeJS.ProcessEnv;
  configDir?: string;
  profileKey: string;
}

export function resolveOpenCodeCliRuntime(profile?: CliProfile): OpenCodeCliRuntime {
  if (profile && profile.vendor !== 'opencode') {
    throw new Error(`CLI profile vendor ${profile.vendor} is not opencode`);
  }

  const requestedCommand = profile?.command?.trim() || 'opencode';
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (profile?.env) {
    for (const [key, value] of Object.entries(profile.env)) {
      env[key] = value;
    }
  }

  const hash = crypto.createHash('sha1').update(JSON.stringify({
    id: profile?.id || null,
    command: requestedCommand,
    env: profile?.env || {},
    opencode: profile?.opencode || {},
  })).digest('hex').slice(0, 12);
  const commandResolution = resolveCliCommandForRuntime('opencode', requestedCommand, env);

  return {
    ...commandResolution,
    env,
    profileKey: profile ? `${profile.id}:${hash}` : `server-configured:${hash}`,
  };
}

interface OpenCodeRunResult {
  text: string;
  sessionId: string | null;
  usage: Usage | null;
  assistantMessageId?: string;
  textRecoveryRecommended?: boolean;
  model?: string;
}

interface StreamState {
  proc: ChildProcess | null;
  aborted: boolean;
}

export class OpenCodeAdapter extends BaseBackendAdapter {
  private _modelCache = new Map<string, ModelOption[]>();

  constructor(options: { workingDir?: string } = {}) {
    super(options);
    this.workingDir = options.workingDir || path.resolve(os.homedir(), '.agent-cockpit', 'workspace');
  }

  get metadata(): BackendMetadata {
    return {
      id: 'opencode',
      label: 'OpenCode',
      icon: OPENCODE_ICON,
      capabilities: {
        thinking: true,
        planMode: false,
        agents: false,
        toolActivity: true,
        userQuestions: false,
        stdinInput: false,
        oneShotMediaInput: {
          image: ['explicit-attachment'],
          pdf: ['explicit-attachment'],
        },
      },
      resumeCapabilities: {
        activeTurnResume: 'unsupported',
        activeTurnResumeReason: 'OpenCode sessions can be resumed for later turns, but opencode run does not expose a safe way to reattach to an already-running process stream.',
        sessionResume: 'supported',
        sessionResumeReason: 'The adapter persists OpenCode session IDs via external_session and passes them back to opencode run --session on later turns.',
      },
      models: [],
    };
  }

  async getMetadata(options: BackendCallOptions = {}): Promise<BackendMetadata> {
    const runtime = resolveOpenCodeCliRuntime(options.cliProfile);
    const provider = options.cliProfile?.opencode?.provider?.trim();
    const cacheKey = `${runtime.profileKey}:${provider || '*'}`;
    let models = this._modelCache.get(cacheKey);
    if (!models) {
      try {
        models = parseOpenCodeModelsOutput(await execOpenCodeModelsOutput(runtime, provider));
        const preferredModel = options.cliProfile?.opencode?.model?.trim();
        if (preferredModel) {
          models = markDefaultModel(ensureModelOption(models, preferredModel), preferredModel);
        } else if (models.length > 0) {
          models = markDefaultModel(models, models[0].id);
        }
        this._modelCache.set(cacheKey, models);
      } catch (err: unknown) {
        opencodeLog.debug('Failed to refresh OpenCode models', {
          profileId: options.cliProfile?.id || null,
          error: (err as Error).message,
        });
        models = fallbackProfileModels(options.cliProfile);
      }
    }

    return {
      ...this.metadata,
      models,
    };
  }

  sendMessage(message: string, options: SendMessageOptions): SendMessageResult {
    const state: StreamState = { proc: null, aborted: false };
    return {
      stream: this._streamMessage(message, options, state),
      abort: () => {
        state.aborted = true;
        state.proc?.kill('SIGTERM');
      },
      sendInput: () => {},
    };
  }

  async runOneShot(prompt: string, options: RunOneShotOptions = {}): Promise<string> {
    const workingDir = resolveOpenCodeWorkingDir(options.workingDir || this.workingDir || process.cwd());
    const runtime = resolveOpenCodeCliRuntime(options.cliProfile);
    const env = buildOpenCodeEnv(runtime.env, options.mcpServers);
    const modelCatalog = await this.openCodeModelCatalog(options.cliProfile);
    const result = await runOpenCodeOnce(runtime, buildOpenCodeRunArgs(prompt, {
      cliProfile: options.cliProfile,
      workingDir,
      model: options.model,
      effort: options.effort,
      modelCatalog,
      allowTools: options.allowTools,
      mcpServers: options.mcpServers,
      attachments: options.attachments,
    }), {
      env,
      timeoutMs: options.timeoutMs ?? OPENCODE_EXEC_TIMEOUT_MS,
      abortSignal: options.abortSignal,
    });
    return result.text.trim();
  }

  async generateSummary(messages: { role: string; content: string }[], fallback: string, options?: BackendCallOptions): Promise<string> {
    const transcript = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    const prompt = `Summarize this conversation in one concise paragraph.\n\n${transcript}`;
    try {
      const summary = await this.runOneShot(prompt, { cliProfile: options?.cliProfile, timeoutMs: OPENCODE_EXEC_TIMEOUT_MS });
      return summary.trim().slice(0, 200) || fallback;
    } catch {
      return fallback;
    }
  }

  async generateTitle(userMessage: string, fallback: string, options?: BackendCallOptions): Promise<string> {
    const prompt = `Generate a concise conversation title of at most 8 words for this message. Return only the title.\n\n${userMessage}`;
    try {
      const title = await this.runOneShot(prompt, { cliProfile: options?.cliProfile, timeoutMs: OPENCODE_EXEC_TIMEOUT_MS });
      return title.replace(/\s+/g, ' ').trim().slice(0, 80) || fallback;
    } catch {
      return fallback || userMessage.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
    }
  }

  private async *_streamMessage(message: string, options: SendMessageOptions, state: StreamState): AsyncGenerator<StreamEvent> {
    yield* this._streamMessageAttempt(message, options, state, false);
  }

  private async *_streamMessageAttempt(
    message: string,
    options: SendMessageOptions,
    state: StreamState,
    retryingAfterRecovery: boolean,
  ): AsyncGenerator<StreamEvent> {
    let proc: ChildProcess;
    let exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>;
    let runtime: OpenCodeCliRuntime;
    try {
      const workingDir = resolveOpenCodeWorkingDir(options.workingDir || this.workingDir || process.cwd());
      runtime = resolveOpenCodeCliRuntime(options.cliProfile);
      const prompt = composePrompt(message, options.systemPrompt, options.isNewSession);
      const modelCatalog = await this.openCodeModelCatalog(options.cliProfile);
      const args = buildOpenCodeRunArgs(prompt, {
        cliProfile: options.cliProfile,
        workingDir,
        model: options.model,
        effort: options.effort,
        modelCatalog,
        externalSessionId: options.isNewSession ? null : options.externalSessionId,
        mcpServers: options.mcpServers,
        allowTools: true,
        showThinking: true,
      });
      const env = buildOpenCodeEnv(runtime.env, options.mcpServers);
      const invocation = buildCliCommandInvocation(runtime, args);
      proc = spawn(invocation.command, invocation.args, {
        cwd: workingDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      exitPromise = waitForExit(proc);
    } catch (err: unknown) {
      yield { type: 'error', error: formatOpenCodeProcessError(err as Error & { code?: string }) };
      yield { type: 'done' };
      return;
    }
    state.proc = proc;

    yield { type: 'backend_runtime', processId: proc.pid ?? null };

    try {
      const stderrChunks: string[] = [];
      proc.stderr?.on('data', chunk => stderrChunks.push(chunk.toString()));

      let emittedSessionId: string | null = null;
      let assistantMessageId: string | null = null;
      let emittedText = false;
      const textByAssistantMessageId = new Map<string, string>();
      const emittedToolActivityIds = new Set<string>();
      let buffer = '';

      for await (const chunk of proc.stdout || []) {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          const metadata = openCodeLineMetadata(line);
          if (metadata.assistantMessageId) assistantMessageId = metadata.assistantMessageId;
          for (const event of translateOpenCodeLine(line)) {
            if (event.type === 'external_session') {
              if (event.sessionId && event.sessionId !== emittedSessionId) {
                emittedSessionId = event.sessionId;
                yield event;
                yield { type: 'backend_runtime', externalSessionId: event.sessionId, processId: proc.pid ?? null };
              }
            } else if (event.type === 'usage') {
              yield event;
            } else {
              if (event.type === 'tool_activity' && event.id) {
                if (emittedToolActivityIds.has(event.id)) continue;
                emittedToolActivityIds.add(event.id);
              }
              if (event.type === 'text' && event.content.trim()) {
                emittedText = true;
                const textMessageId = metadata.assistantMessageId || assistantMessageId;
                if (textMessageId) {
                  textByAssistantMessageId.set(
                    textMessageId,
                    (textByAssistantMessageId.get(textMessageId) || '') + event.content,
                  );
                }
              }
              yield event;
            }
          }
        }
      }
      if (buffer.trim()) {
        const metadata = openCodeLineMetadata(buffer);
        if (metadata.assistantMessageId) assistantMessageId = metadata.assistantMessageId;
        for (const event of translateOpenCodeLine(buffer)) {
          if (event.type === 'external_session') {
            if (event.sessionId && event.sessionId !== emittedSessionId) {
              emittedSessionId = event.sessionId;
              yield event;
              yield { type: 'backend_runtime', externalSessionId: event.sessionId, processId: proc.pid ?? null };
            }
          } else if (event.type === 'usage') {
            yield event;
          } else {
            if (event.type === 'tool_activity' && event.id) {
              if (emittedToolActivityIds.has(event.id)) continue;
              emittedToolActivityIds.add(event.id);
            }
            if (event.type === 'text' && event.content.trim()) {
              emittedText = true;
              const textMessageId = metadata.assistantMessageId || assistantMessageId;
              if (textMessageId) {
                textByAssistantMessageId.set(
                  textMessageId,
                  (textByAssistantMessageId.get(textMessageId) || '') + event.content,
                );
              }
            }
            yield event;
          }
        }
      }

      const exit = await exitPromise;
      if (exit.error && !state.aborted) {
        yield { type: 'error', error: formatOpenCodeProcessError(exit.error) };
        yield { type: 'done' };
        return;
      }
      if (exit.code !== 0 && !state.aborted) {
        const stderr = stripAnsi(stderrChunks.join('\n')).trim();
        if (
          !retryingAfterRecovery
          && !options.isNewSession
          && options.externalSessionId
          && isMissingNativeSessionError(stderr)
        ) {
          const reason = stderr || `OpenCode session not found: ${options.externalSessionId}`;
          let snapshot = null;
          try {
            snapshot = await createRecoverySnapshot(options, {
              previousNativeSessionId: options.externalSessionId,
              reason,
            });
          } catch (snapshotErr) {
            opencodeLog.warn('Failed to create OpenCode session recovery snapshot', {
              sessionId: options.externalSessionId,
              error: (snapshotErr as Error).message,
            });
          }
          const recovery = buildNativeSessionRecovery({
            backend: 'opencode',
            previousNativeSessionId: options.externalSessionId,
            newNativeSessionId: null,
            reason,
            snapshot,
            currentPrompt: message,
          });
          yield buildSessionRecoveryEvent(recovery.metadata);
          yield* this._streamMessageAttempt(recovery.prompt, {
            ...options,
            isNewSession: true,
            externalSessionId: null,
          }, state, true);
          return;
        }
        yield { type: 'error', error: stderr || `OpenCode exited with code ${exit.code ?? 'unknown'}` };
      }
      if (
        exit.code === 0
        && !state.aborted
        && emittedSessionId
        && shouldRecoverOpenCodeText(emittedText, assistantMessageId, textByAssistantMessageId)
      ) {
        const recoveredText = await fetchOpenCodeSessionText(runtime, emittedSessionId, assistantMessageId);
        if (recoveredText) {
          yield { type: 'text', content: recoveredText, streaming: false };
        }
      }
      yield { type: 'done' };
    } catch (err: unknown) {
      if (state.aborted) {
        yield { type: 'error', error: 'OpenCode turn aborted.', source: 'abort' };
      } else {
        yield { type: 'error', error: (err as Error).message || String(err) };
      }
      yield { type: 'done' };
    }
  }

  private async openCodeModelCatalog(cliProfile?: CliProfile): Promise<ModelOption[]> {
    try {
      return (await this.getMetadata({ cliProfile })).models || [];
    } catch {
      return fallbackProfileModels(cliProfile);
    }
  }
}

function buildOpenCodeRunArgs(prompt: string, options: {
  cliProfile?: CliProfile;
  workingDir?: string | null;
  model?: string;
  effort?: EffortLevel;
  modelCatalog?: ModelOption[];
  externalSessionId?: string | null;
  mcpServers?: McpServerConfig[];
  allowTools?: boolean;
  showThinking?: boolean;
  attachments?: RunOneShotAttachment[];
}): string[] {
  const model = options.model?.trim() || options.cliProfile?.opencode?.model?.trim();
  const args = ['run', '--format', 'json'];
  const cwd = options.workingDir?.trim();
  if (cwd) args.push('--dir', cwd);
  if (model) args.push('--model', model);
  if (options.showThinking) args.push('--thinking');
  if (openCodeModelSupportsEffort(options.modelCatalog, model, options.effort)) {
    args.push('--variant', options.effort!);
  }
  for (const filePath of openCodeAttachmentFiles(options.attachments)) {
    args.push('--file', filePath);
  }
  if (options.externalSessionId) args.push('--session', options.externalSessionId);
  if (options.allowTools || (Array.isArray(options.mcpServers) && options.mcpServers.length > 0)) {
    args.push('--dangerously-skip-permissions');
  }
  args.push(prompt);
  return args;
}

function openCodeAttachmentFiles(attachments: RunOneShotAttachment[] | undefined): string[] {
  const files: string[] = [];
  for (const attachment of attachments || []) {
    if (attachment.kind !== 'image' && attachment.kind !== 'pdf') continue;
    const filePath = attachment.path?.trim();
    if (filePath) files.push(filePath);
  }
  return files;
}

function composePrompt(message: string, systemPrompt: string | undefined, isNewSession: boolean): string {
  const system = isNewSession ? String(systemPrompt || '').trim() : '';
  if (!system) return message;
  return `System instructions:\n${system}\n\nUser message:\n${message}`;
}

function buildOpenCodeEnv(baseEnv: NodeJS.ProcessEnv, mcpServers?: McpServerConfig[]): NodeJS.ProcessEnv {
  if (!Array.isArray(mcpServers) || mcpServers.length === 0) return baseEnv;
  const config = parseInlineConfig(baseEnv.OPENCODE_CONFIG_CONTENT);
  config.mcp = {
    ...(isPlainObject(config.mcp) ? config.mcp : {}),
    ...mcpServersToOpenCodeConfig(mcpServers),
  };
  return {
    ...baseEnv,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  };
}

function mcpServersToOpenCodeConfig(mcpServers: McpServerConfig[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const server of mcpServers) {
    if (!server?.name || !server.command) continue;
    const environment: Record<string, string> = {};
    for (const entry of server.env || []) {
      if (entry?.name && typeof entry.value === 'string') environment[entry.name] = entry.value;
    }
    out[server.name] = {
      type: 'local',
      command: [server.command, ...(Array.isArray(server.args) ? server.args : [])],
      enabled: true,
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
    };
  }
  return out;
}

function parseInlineConfig(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function execOpenCodeText(runtime: OpenCodeCliRuntime, args: string[]): Promise<string> {
  const invocation = buildCliCommandInvocation(runtime, args);
  return await new Promise<string>((resolve, reject) => {
    execFile(invocation.command, invocation.args, {
      env: runtime.env,
      timeout: OPENCODE_EXEC_TIMEOUT_MS,
      maxBuffer: OPENCODE_MAX_BUFFER,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stripAnsi(stderr || err.message || 'OpenCode command failed').trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

async function execOpenCodeModelsOutput(runtime: OpenCodeCliRuntime, provider?: string): Promise<string> {
  const baseArgs = ['models', ...(provider ? [provider] : [])];
  try {
    return await execOpenCodeText(runtime, [...baseArgs, '--verbose']);
  } catch {
    return await execOpenCodeText(runtime, baseArgs);
  }
}

async function runOpenCodeOnce(runtime: OpenCodeCliRuntime, args: string[], options: {
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<OpenCodeRunResult> {
  const invocation = buildCliCommandInvocation(runtime, args);
  return await new Promise<OpenCodeRunResult>((resolve, reject) => {
    const proc = spawn(invocation.command, invocation.args, {
      env: options.env || runtime.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      options.abortSignal?.removeEventListener('abort', onAbort);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const succeed = (result: OpenCodeRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      fail(new Error('OpenCode command timed out'));
    }, options.timeoutMs);
    const onAbort = () => {
      proc.kill('SIGTERM');
      fail(new Error('OpenCode command aborted'));
    };
    options.abortSignal?.addEventListener('abort', onAbort, { once: true });
    proc.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('error', err => fail(new Error(formatOpenCodeProcessError(err))));
    proc.on('close', code => {
      if (code !== 0) {
        fail(new Error(stripAnsi(stderr).trim() || `OpenCode exited with code ${code ?? 'unknown'}`));
        return;
      }
      const result = collectOpenCodeJson(stdout);
      if (result.sessionId && (!result.text.trim() || result.textRecoveryRecommended)) {
        void fetchOpenCodeSessionText(runtime, result.sessionId, result.assistantMessageId || null)
          .then(recoveredText => {
            succeed(recoveredText ? { ...result, text: recoveredText } : result);
          })
          .catch(() => succeed(result));
        return;
      }
      succeed(result);
    });
  });
}

function collectOpenCodeJson(stdout: string): OpenCodeRunResult {
  let text = '';
  let sessionId: string | null = null;
  let usage: Usage | null = null;
  let assistantMessageId: string | null = null;
  const textByAssistantMessageId = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const metadata = openCodeLineMetadata(line);
    if (metadata.sessionId) sessionId = metadata.sessionId;
    if (metadata.assistantMessageId) assistantMessageId = metadata.assistantMessageId;
    for (const event of translateOpenCodeLine(line)) {
      if (event.type === 'text') {
        text += event.content;
        const textMessageId = metadata.assistantMessageId || assistantMessageId;
        if (textMessageId) {
          textByAssistantMessageId.set(
            textMessageId,
            (textByAssistantMessageId.get(textMessageId) || '') + event.content,
          );
        }
      }
      if (event.type === 'external_session') sessionId = event.sessionId;
      if (event.type === 'usage') usage = event.usage;
    }
  }
  return {
    text,
    sessionId,
    usage,
    ...(assistantMessageId ? { assistantMessageId } : {}),
    ...(sessionId && shouldRecoverOpenCodeText(!!text.trim(), assistantMessageId, textByAssistantMessageId)
      ? { textRecoveryRecommended: true }
      : {}),
  };
}

function shouldRecoverOpenCodeText(
  emittedText: boolean,
  assistantMessageId: string | null | undefined,
  textByAssistantMessageId: Map<string, string>,
): boolean {
  if (!assistantMessageId) return !emittedText;
  return !(textByAssistantMessageId.get(assistantMessageId) || '').trim();
}

function translateOpenCodeLine(line: string): StreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const events: StreamEvent[] = [];
  const sessionId = typeof parsed.sessionID === 'string'
    ? parsed.sessionID
    : typeof parsed.part?.sessionID === 'string' ? parsed.part.sessionID : null;
  if (sessionId) events.push({ type: 'external_session', sessionId });
  if (parsed.type === 'text' && typeof parsed.part?.text === 'string') {
    events.push({ type: 'text', content: parsed.part.text, streaming: true });
  }
  if ((parsed.type === 'reasoning' || parsed.part?.type === 'reasoning') && typeof parsed.part?.text === 'string') {
    events.push({ type: 'thinking', content: parsed.part.text, streaming: true });
  }
  if (parsed.type === 'tool_use' || parsed.part?.type === 'tool') {
    const toolEvents = openCodeToolEvents(parsed.part);
    events.push(...toolEvents);
  }
  if (parsed.type === 'step_finish' || parsed.part?.type === 'step-finish') {
    const usage = usageFromOpenCodePart(parsed.part);
    if (usage) events.push({ type: 'usage', usage });
  }
  return events;
}

function openCodeToolEvents(part: any): StreamEvent[] {
  const detail = openCodeToolDetail(part);
  if (!detail) return [];
  const events: StreamEvent[] = [{
    type: 'tool_activity',
    ...detail,
  }];
  const outcome = openCodeToolOutcome(part, detail.tool);
  if (outcome && detail.id) {
    events.push({
      type: 'tool_outcomes',
      outcomes: [{
        toolUseId: detail.id,
        isError: outcome.status === 'error',
        outcome: outcome.outcome,
        status: outcome.status,
      }],
    });
  }
  return events;
}

function openCodeToolDetail(part: any): {
  tool: string;
  description: string;
  id: string | null;
} | null {
  const rawName = typeof part?.tool === 'string' ? part.tool : '';
  if (!rawName) return null;
  const input = isPlainObject(part?.state?.input) ? part.state.input : {};
  const id = typeof part.callID === 'string' ? part.callID : null;
  const mcp = openCodeMcpToolName(rawName);
  if (mcp) {
    return {
      tool: mcp.tool,
      id,
      description: `${mcp.server}.${mcp.tool}`,
    };
  }

  const canonical = canonicalOpenCodeToolName(rawName);
  switch (canonical) {
    case 'Read': {
      const filePath = firstString(input.filePath, input.file_path, part?.state?.title, part?.title);
      return { tool: 'Read', id, description: filePath ? `Reading \`${shortenPath(filePath)}\`` : 'Reading file' };
    }
    case 'Write': {
      const filePath = firstString(input.filePath, input.file_path, part?.state?.title, part?.title);
      return { tool: 'Write', id, description: filePath ? `Writing \`${shortenPath(filePath)}\`` : 'Writing file' };
    }
    case 'Edit': {
      const filePath = firstString(input.filePath, input.file_path, part?.state?.title, part?.title);
      return { tool: 'Edit', id, description: filePath ? `Editing \`${shortenPath(filePath)}\`` : 'Editing file' };
    }
    case 'Bash': {
      const command = firstString(input.command, input.cmd);
      const short = command && command.length > 60 ? command.slice(0, 60) + '...' : command;
      return { tool: 'Bash', id, description: short ? `Running: \`${short}\`` : 'Running command' };
    }
    case 'Grep': {
      const pattern = firstString(input.pattern, input.query);
      return { tool: 'Grep', id, description: pattern ? `Searching for \`${pattern}\`` : 'Searching files' };
    }
    case 'Glob': {
      const pattern = firstString(input.pattern);
      return { tool: 'Glob', id, description: pattern ? `Finding files matching \`${pattern}\`` : 'Finding files' };
    }
    case 'WebFetch': {
      const url = firstString(input.url);
      return { tool: 'WebFetch', id, description: url ? `Fetching: ${url}` : 'Fetching web content' };
    }
    case 'WebSearch': {
      const query = firstString(input.query);
      return { tool: 'WebSearch', id, description: query ? `Searching: \`${query}\`` : 'Searching the web' };
    }
    default:
      return { tool: canonical, id, description: `Using ${canonical}` };
  }
}

function openCodeToolOutcome(part: any, tool: string): { outcome: string; status: string } | null {
  const state = part?.state;
  if (!state || typeof state !== 'object') return null;
  const status = typeof state.status === 'string' ? state.status : '';
  const output = state.output ?? state.error ?? state.message ?? '';
  if (status === 'running' || status === 'pending' || status === 'started' || status === 'in_progress') {
    return null;
  }
  if (status && status !== 'completed' && status !== 'done' && status !== 'success') {
    return { outcome: status === 'error' || status === 'failed' ? 'error' : status, status: status === 'error' || status === 'failed' ? 'error' : 'warning' };
  }
  const extracted = extractToolOutcome(tool, output);
  if (extracted) return extracted;
  if (status === 'completed' || status === 'done' || status === 'success') return { outcome: 'done', status: 'success' };
  return null;
}

function canonicalOpenCodeToolName(rawName: string): string {
  const normalized = rawName.replace(/[-_\s]/g, '').toLowerCase();
  const map: Record<string, string> = {
    bash: 'Bash',
    shell: 'Bash',
    runcommand: 'Bash',
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    grep: 'Grep',
    glob: 'Glob',
    list: 'List',
    ls: 'List',
    webfetch: 'WebFetch',
    fetch: 'WebFetch',
    websearch: 'WebSearch',
    search: 'WebSearch',
  };
  return map[normalized] || rawName;
}

function openCodeMcpToolName(rawName: string): { server: string; tool: string } | null {
  const knownPrefixes = ['agent-cockpit-memory_', 'agent-cockpit-kb-search_'];
  for (const prefix of knownPrefixes) {
    if (rawName.startsWith(prefix)) {
      return {
        server: prefix.slice(0, -1),
        tool: rawName.slice(prefix.length),
      };
    }
  }
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function openCodeLineMetadata(line: string): {
  sessionId: string | null;
  assistantMessageId: string | null;
} {
  const trimmed = line.trim();
  if (!trimmed) return { sessionId: null, assistantMessageId: null };
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { sessionId: null, assistantMessageId: null };
  }
  const sessionId = typeof parsed.sessionID === 'string'
    ? parsed.sessionID
    : typeof parsed.part?.sessionID === 'string' ? parsed.part.sessionID : null;
  const assistantMessageId = typeof parsed.part?.messageID === 'string'
    && (parsed.type === 'step_start' || parsed.type === 'step_finish' || parsed.type === 'text' || parsed.type === 'reasoning')
    ? parsed.part.messageID
    : null;
  return { sessionId, assistantMessageId };
}

async function fetchOpenCodeSessionText(
  runtime: OpenCodeCliRuntime,
  sessionId: string,
  assistantMessageId: string | null,
): Promise<string> {
  try {
    return extractOpenCodeExportText(await execOpenCodeText(runtime, ['export', sessionId]), assistantMessageId);
  } catch (err: unknown) {
    opencodeLog.debug('Failed to recover OpenCode text from exported session', {
      sessionId,
      assistantMessageId,
      error: (err as Error).message,
    });
    return '';
  }
}

function extractOpenCodeExportText(output: string, assistantMessageId?: string | null): string {
  const clean = stripAnsi(output);
  const start = clean.indexOf('{');
  if (start < 0) return '';
  let parsed: any;
  try {
    parsed = JSON.parse(clean.slice(start));
  } catch {
    return '';
  }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const assistantMessages = messages.filter((candidate: any) => candidate?.info?.role === 'assistant');
  const message = assistantMessageId
    ? assistantMessages.find((candidate: any) => candidate?.info?.id === assistantMessageId)
    : assistantMessages[assistantMessages.length - 1];
  if (!message || !Array.isArray(message.parts)) return '';
  return message.parts
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text)
    .join('')
    .trim();
}

function usageFromOpenCodePart(part: any): Usage | null {
  const tokens = part?.tokens;
  if (!tokens || typeof tokens !== 'object') return null;
  const input = numberOrZero(tokens.input);
  const output = numberOrZero(tokens.output);
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  const cost = typeof part.cost === 'number' && Number.isFinite(part.cost) ? part.cost : 0;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: numberOrZero(cache.read),
    cacheWriteTokens: numberOrZero(cache.write),
    costUsd: cost,
    costSource: cost > 0 ? 'reported' : 'none',
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function parseOpenCodeModelsOutput(output: string): ModelOption[] {
  const models: ModelOption[] = [];
  const verboseById = parseOpenCodeVerboseModels(output);
  const seen = new Set<string>();
  for (const id of parseOpenCodeModelIds(output)) {
    if (seen.has(id)) continue;
    seen.add(id);
    const provider = id.split('/')[0] || 'opencode';
    const verbose = verboseById.get(id);
    const supportedEffortLevels = openCodeEffortsFromVariants(verbose?.variants);
    models.push({
      id,
      label: id,
      family: provider,
      ...(supportedEffortLevels.length > 0 ? { supportedEffortLevels } : {}),
      capabilities: openCodeCapabilitiesFromVerbose(verbose),
    });
  }
  return models;
}

function parseOpenCodeModelIds(output: string): string[] {
  const ids: string[] = [];
  let depth = 0;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = stripAnsi(rawLine);
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (depth > 0) {
      depth = Math.max(0, depth + braceDelta(line));
      continue;
    }
    if (trimmed.startsWith('{')) {
      depth = Math.max(0, braceDelta(line));
      continue;
    }
    if (isOpenCodeModelIdLine(trimmed)) ids.push(trimmed);
  }
  return ids;
}

function parseOpenCodeVerboseModels(output: string): Map<string, Record<string, unknown>> {
  const models = new Map<string, Record<string, unknown>>();
  let currentId: string | null = null;
  let jsonLines: string[] = [];
  let depth = 0;

  const finish = () => {
    if (!currentId || jsonLines.length === 0 || depth !== 0) return;
    try {
      const parsed = JSON.parse(jsonLines.join('\n'));
      if (isPlainObject(parsed)) models.set(currentId, parsed);
    } catch {
      // Ignore malformed verbose blocks and keep the plain model entry.
    }
  };

  for (const rawLine of output.split(/\r?\n/)) {
    const line = stripAnsi(rawLine);
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (depth === 0 && isOpenCodeModelIdLine(trimmed)) {
      finish();
      currentId = trimmed;
      jsonLines = [];
      depth = 0;
      continue;
    }
    if (!currentId) continue;
    jsonLines.push(line);
    depth += braceDelta(line);
    if (depth === 0) finish();
  }
  finish();
  return models;
}

function isOpenCodeModelIdLine(value: string): boolean {
  return /^[^\s{}"']+\/[^\s{}"']+$/.test(value) && !value.includes('://');
}

function braceDelta(line: string): number {
  let delta = 0;
  let inString = false;
  let escaping = false;
  for (const ch of line) {
    if (escaping) {
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') delta += 1;
    if (ch === '}') delta -= 1;
  }
  return delta;
}

function openCodeEffortsFromVariants(value: unknown): EffortLevel[] {
  if (!isPlainObject(value)) return [];
  const present = new Set(Object.keys(value).filter(key => OPENCODE_EFFORT_SET.has(key)));
  return OPENCODE_EFFORT_ORDER.filter(level => present.has(level));
}

function openCodeCapabilitiesFromVerbose(value: unknown): ModelCapabilities {
  if (!isPlainObject(value)) return { input: { text: true }, output: { text: true } };
  const capabilities = isPlainObject(value.capabilities) ? value.capabilities : value;
  const input = normalizeOpenCodeInputCapabilities(capabilities.input);
  const output = normalizeOpenCodeOutputCapabilities(capabilities.output);
  return {
    input,
    output,
    ...(typeof capabilities.attachment === 'boolean' ? { attachment: capabilities.attachment } : {}),
    ...(typeof capabilities.toolcall === 'boolean' ? { toolcall: capabilities.toolcall } : {}),
    ...(typeof capabilities.reasoning === 'boolean' ? { reasoning: capabilities.reasoning } : {}),
  };
}

function normalizeOpenCodeInputCapabilities(value: unknown): Partial<Record<ModelInputModality, boolean>> {
  const input: Partial<Record<ModelInputModality, boolean>> = { text: true };
  if (!isPlainObject(value)) return input;
  for (const modality of ['image', 'audio', 'pdf', 'video'] satisfies ModelInputModality[]) {
    if (typeof value[modality] === 'boolean') input[modality] = value[modality];
  }
  return input;
}

function normalizeOpenCodeOutputCapabilities(value: unknown): Partial<Record<ModelOutputModality, boolean>> {
  const output: Partial<Record<ModelOutputModality, boolean>> = { text: true };
  if (!isPlainObject(value)) return output;
  for (const modality of ['text', 'image', 'audio', 'pdf', 'video'] satisfies ModelOutputModality[]) {
    if (typeof value[modality] === 'boolean') output[modality] = value[modality];
  }
  return output;
}

function openCodeModelSupportsEffort(models: ModelOption[] | undefined, model: string | undefined, effort: EffortLevel | undefined): boolean {
  if (!model || !effort) return false;
  const modelOption = models?.find(candidate => candidate.id === model);
  return !!modelOption?.supportedEffortLevels?.includes(effort);
}

function fallbackProfileModels(profile?: CliProfile): ModelOption[] {
  const model = profile?.opencode?.model?.trim();
  return model ? [modelOption(model, true)] : [];
}

function ensureModelOption(models: ModelOption[], model: string): ModelOption[] {
  return models.some(candidate => candidate.id === model) ? models : [modelOption(model), ...models];
}

function markDefaultModel(models: ModelOption[], model: string): ModelOption[] {
  return models.map(candidate => ({
    ...candidate,
    ...(candidate.id === model ? { default: true } : {}),
  }));
}

function modelOption(id: string, isDefault = false): ModelOption {
  const provider = id.includes('/') ? id.split('/')[0] : 'opencode';
  return {
    id,
    label: id,
    family: provider,
    ...(isDefault ? { default: true } : {}),
    capabilities: { input: { text: true }, output: { text: true } },
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*m/g, '');
}

function resolveOpenCodeWorkingDir(workingDir: string | null | undefined): string {
  const cwd = workingDir?.trim() || process.cwd();
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      throw new Error(`OpenCode working directory is not a directory: ${cwd}`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`OpenCode working directory does not exist: ${cwd}`);
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') {
      throw new Error(`OpenCode working directory is not a directory: ${cwd}`);
    }
    throw err;
  }
  return cwd;
}

function formatOpenCodeProcessError(err: Error & { code?: string }): string {
  return err.code === 'ENOENT'
    ? 'OpenCode CLI is not installed or is not available on PATH.'
    : err.message || String(err);
}

function waitForExit(proc: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }> {
  return new Promise(resolve => {
    let settled = false;
    proc.once('error', err => {
      if (settled) return;
      settled = true;
      resolve({ code: null, signal: null, error: err });
    });
    proc.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    });
  });
}

export const __opencodeTestUtils = {
  buildOpenCodeRunArgs,
  collectOpenCodeJson,
  extractOpenCodeExportText,
  mcpServersToOpenCodeConfig,
  openCodeLineMetadata,
  parseOpenCodeModelsOutput,
  openCodeCapabilitiesFromVerbose,
  openCodeModelSupportsEffort,
  resolveOpenCodeCliRuntime,
  resolveOpenCodeWorkingDir,
  translateOpenCodeLine,
};
