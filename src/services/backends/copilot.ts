import type { ChildProcess } from 'child_process';
import os from 'os';
import path from 'path';
import { BaseBackendAdapter, type BackendCallOptions, type RunOneShotAttachment, type RunOneShotOptions } from './base';
import { copilotToolStartEvents, copilotToolCompleteEvents, canonicalCopilotToolName } from './copilotTools';
import { COPILOT_MODELS, COPILOT_EFFORT_SET } from './copilotModels';
import { copilotMcpConfig, composePrompt } from './copilotSessionConfig';
import { copilotTurnUsage, copilotUsageCheckpoint, readCopilotUsageBaseline } from './copilotUsage';
import { CopilotProcessScope, spawnCopilotProcess } from './copilotProcess';
import {
  buildNativeSessionRecovery,
  buildSessionRecoveryEvent,
  createRecoverySnapshot,
  isMissingNativeSessionError,
} from './sessionRecovery';
import { buildCliCommandInvocation } from '../cliCommandResolver';
import { resolveCopilotCliRuntime, resolveCopilotWorkingDir, type CopilotCliRuntime } from './copilotRuntime';
export { resolveCopilotCliRuntime, type CopilotCliRuntime } from './copilotRuntime';
import { logger } from '../../utils/logger';
import type {
  BackendMetadata,
  EffortLevel,
  McpServerConfig,
  SendMessageOptions,
  SendMessageResult,
  StreamEvent,
  Usage,
} from '../../types';

// GitHub Copilot mark — simple rounded badge so the cockpit can render an
// assistant avatar and harness icon without depending on an external asset.
const COPILOT_ICON = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="6" fill="#0D1117"/><path d="M12 6.4c-3.7 0-6.2 1.7-6.2 1.7-.5-1.3-.4-2.6-.4-2.6S4.1 6.6 4.1 8.5c-.5.6-.8 1.4-.8 2.4v2.2c0 2.9 3.9 4.7 8.7 4.7s8.7-1.8 8.7-4.7v-2.2c0-1-.3-1.8-.8-2.4 0-1.9-1.3-3-1.3-3s.1 1.3-.4 2.6c0 0-2.5-1.7-6.2-1.7Z" fill="#fff"/><path d="M9 11.4c-.9 0-1.6.9-1.6 2s.7 2 1.6 2 1.6-.9 1.6-2-.7-2-1.6-2Zm6 0c-.9 0-1.6.9-1.6 2s.7 2 1.6 2 1.6-.9 1.6-2-.7-2-1.6-2Z" fill="#0D1117"/></svg>';

const COPILOT_EXEC_TIMEOUT_MS = 60_000;
const copilotLog = logger.child({ module: 'copilot-backend' });

interface CopilotRunResult {
  text: string;
  sessionId: string | null;
  usage: Usage | null;
}

interface StreamState {
  proc: ChildProcess | null;
  scope?: CopilotProcessScope;
  aborted: boolean;
}

interface CopilotLineInfo {
  sessionId: string | null;
  messageId: string | null;
  deltaMessageId: string | null;
  outputTokens: number;
  premiumRequests: number;
  isResult: boolean;
  checkpointUsage: Usage | null;
}

export class CopilotAdapter extends BaseBackendAdapter {
  private turns = new Map<StreamState, string | undefined>();
  private scopes = new Set<CopilotProcessScope>();
  private closing: Promise<void> | null = null;
  private closed = false;
  private oneShots = new Set<AbortController>();
  constructor(options: { workingDir?: string } = {}) {
    super(options);
    this.workingDir = options.workingDir || path.resolve(os.homedir(), '.agent-cockpit', 'workspace');
  }

  get metadata(): BackendMetadata {
    return {
      id: 'copilot',
      label: 'GitHub Copilot',
      icon: COPILOT_ICON,
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
        activeTurnResumeReason: 'The GitHub Copilot CLI runs one non-interactive process per turn and does not expose a way to reattach to an already-running turn stream.',
        sessionResume: 'supported',
        sessionResumeReason: 'The adapter persists Copilot session IDs via external_session and passes them back with copilot --resume on later turns.',
      },
      models: COPILOT_MODELS,
    };
  }

  async getMetadata(_options: BackendCallOptions = {}): Promise<BackendMetadata> {
    return this.metadata;
  }

  sendMessage(message: string, options: SendMessageOptions): SendMessageResult {
    const state: StreamState = { proc: null, aborted: this.closed || this.closing !== null };
    this.turns.set(state, options.conversationId);
    return {
      stream: this._streamMessage(message, options, state),
      abort: () => {
        state.aborted = true;
        void state.scope?.stop();
      },
      sendInput: () => {},
    };
  }

  shutdown(options: { permanent?: boolean } = {}): Promise<void> {
    if (options.permanent) this.closed = true;
    if (this.closing) return this.closing;
    for (const state of this.turns.keys()) state.aborted = true;
    for (const controller of this.oneShots) controller.abort();
    this.closing = Promise.all([...this.scopes].map(scope => scope.stop()))
      .then(() => {})
      .finally(() => { this.closing = null; });
    return this.closing;
  }

  async onSessionReset(conversationId: string): Promise<void> {
    const cleanup: Promise<void>[] = [];
    for (const [state, id] of this.turns) {
      if (id !== conversationId) continue;
      state.aborted = true;
      if (state.scope) cleanup.push(state.scope.stop());
    }
    await Promise.all(cleanup);
  }

  async runOneShot(prompt: string, options: RunOneShotOptions = {}): Promise<string> {
    if (this.closed || this.closing) throw new Error('Copilot is shutting down.');
    const workingDir = resolveCopilotWorkingDir(options.workingDir || this.workingDir || process.cwd());
    const runtime = resolveCopilotCliRuntime(options.cliProfile);
    const args = buildCopilotRunArgs(prompt, {
      workingDir,
      model: options.model,
      effort: options.effort,
      allowTools: options.allowTools,
      mcpServers: options.mcpServers,
      attachments: options.attachments,
    });
    const controller = new AbortController();
    this.oneShots.add(controller);
    try {
      const result = await runCopilotOnce(runtime, args, {
        cwd: workingDir,
        timeoutMs: options.timeoutMs ?? COPILOT_EXEC_TIMEOUT_MS,
        abortSignal: options.abortSignal ? AbortSignal.any([options.abortSignal, controller.signal]) : controller.signal,
        registerScope: scope => {
          this.scopes.add(scope);
          return () => this.scopes.delete(scope);
        },
      });
      return result.text.trim();
    } finally {
      this.oneShots.delete(controller);
    }
  }

  async generateSummary(messages: { role: string; content: string }[], fallback: string, options?: BackendCallOptions): Promise<string> {
    const transcript = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    const prompt = `Summarize this conversation in one concise paragraph.\n\n${transcript}`;
    try {
      const summary = await this.runOneShot(prompt, { cliProfile: options?.cliProfile, timeoutMs: COPILOT_EXEC_TIMEOUT_MS });
      return summary.trim().slice(0, 200) || fallback;
    } catch (err: unknown) {
      copilotLog.warn('Copilot summary generation failed', { error: err instanceof Error ? err.message : String(err) });
      return fallback;
    }
  }

  async generateTitle(userMessage: string, fallback: string, options?: BackendCallOptions): Promise<string> {
    const prompt = `Generate a concise conversation title of at most 8 words for this message. Return only the title.\n\n${userMessage}`;
    try {
      const title = await this.runOneShot(prompt, { cliProfile: options?.cliProfile, timeoutMs: COPILOT_EXEC_TIMEOUT_MS });
      return title.replace(/\s+/g, ' ').trim().slice(0, 80) || fallback;
    } catch (err: unknown) {
      copilotLog.warn('Copilot title generation failed', { error: err instanceof Error ? err.message : String(err) });
      return fallback || userMessage.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
    }
  }

  private async *_streamMessage(message: string, options: SendMessageOptions, state: StreamState): AsyncGenerator<StreamEvent> {
    try {
      // Stop can detach the stream before native worker termination finishes.
      for (const [previous, conversationId] of this.turns) {
        if (previous !== state && conversationId && conversationId === options.conversationId && previous.aborted) {
          await previous.scope?.stop();
        }
      }
      yield* this._streamMessageAttempt(message, options, state, false);
    } finally {
      this.turns.delete(state);
    }
  }

  private async *_streamMessageAttempt(
    message: string,
    options: SendMessageOptions,
    state: StreamState,
    retryingAfterRecovery: boolean,
  ): AsyncGenerator<StreamEvent> {
    if (state.aborted) {
      yield { type: 'error', error: 'Copilot turn aborted.', source: 'abort' };
      yield { type: 'done' };
      return;
    }
    let proc: ChildProcess;
    let scope: CopilotProcessScope;
    let exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>;
    let workingDir: string;
    let usageBaseline: Usage | null;
    try {
      workingDir = resolveCopilotWorkingDir(options.workingDir || this.workingDir || process.cwd());
      const runtime = resolveCopilotCliRuntime(options.cliProfile);
      usageBaseline = !options.isNewSession && options.externalSessionId
        ? await readCopilotUsageBaseline(options.externalSessionId, runtime.env)
        : copilotUsage(0, 0);
      if (state.aborted) {
        yield { type: 'error', error: 'Copilot turn aborted.', source: 'abort' };
        yield { type: 'done' };
        return;
      }
      const prompt = composePrompt(message, options.systemPrompt, options.isNewSession);
      const args = buildCopilotRunArgs(prompt, {
        workingDir,
        model: options.model,
        effort: options.effort,
        externalSessionId: options.isNewSession ? null : options.externalSessionId,
        mcpServers: options.mcpServers,
        allowTools: true,
      });
      const invocation = buildCliCommandInvocation(runtime, args);
      ({ proc, scope } = spawnCopilotProcess(invocation.command, invocation.args, {
        cwd: workingDir,
        env: runtime.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
      exitPromise = waitForExit(proc);
    } catch (err: unknown) {
      yield { type: 'error', error: formatCopilotProcessError(err as Error & { code?: string }) };
      yield { type: 'done' };
      return;
    }
    state.proc = proc;
    state.scope = scope;
    this.scopes.add(scope);
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    const stderrChunks: string[] = [];
    proc.stderr?.on('data', chunk => stderrChunks.push(chunk.toString()));
    try {
      yield { type: 'backend_runtime', processId: proc.pid ?? null };

      let emittedSessionId: string | null = null;
      let outputTokens = 0;
      let premiumRequests = 0;
      let sawResultUsage = false;
      let checkpointUsage: Usage | null = null;
      let hasTurnOutput = false;
      const emittedToolActivityIds = new Set<string>();
      const toolNames = new Map<string, string>();
      const deltaTextByMessageId = new Map<string, boolean>();
      const protocolErrors: string[] = [];
      let buffer = '';

      const handleLine = function* (this: CopilotAdapter, line: string): Generator<StreamEvent> {
        const info = copilotLineInfo(line);
        const parsed = safeParse(line);
        if (parsed?.type === 'tool.execution_start') hasTurnOutput = true;
        outputTokens += info.outputTokens;
        premiumRequests += info.premiumRequests;
        if (info.checkpointUsage) checkpointUsage = info.checkpointUsage;
        if (info.deltaMessageId) deltaTextByMessageId.set(info.deltaMessageId, true);

        for (const event of translateCopilotLine(line, toolNames)) {
          if (event.type === 'error') {
            protocolErrors.push(event.error);
            continue;
          }
          if (event.type === 'external_session') {
            if (event.sessionId && event.sessionId !== emittedSessionId) {
              emittedSessionId = event.sessionId;
              yield event;
              yield { type: 'backend_runtime', externalSessionId: event.sessionId, processId: proc.pid ?? null };
            }
            continue;
          }
          if (event.type === 'tool_activity' && event.id) {
            if (emittedToolActivityIds.has(event.id)) continue;
            emittedToolActivityIds.add(event.id);
          }
          if (event.type === 'text' || event.type === 'thinking' || event.type === 'tool_activity' || event.type === 'tool_outcomes') {
            hasTurnOutput = true;
          }
          yield event;
        }

        // Final message text fallback when no streaming deltas were produced
        // for this assistant message (e.g. streaming disabled).
        const fallback = copilotFinalMessageText(line);
        if (fallback && fallback.text && !deltaTextByMessageId.get(fallback.messageId)) {
          hasTurnOutput = true;
          yield { type: 'text', content: fallback.text, streaming: false };
        }

        if (info.isResult) {
          sawResultUsage = true;
          yield {
            type: 'usage',
            usage: checkpointUsage && usageBaseline
              ? copilotTurnUsage(checkpointUsage, usageBaseline)
              : copilotUsage(outputTokens, usageBaseline ? Math.max(0, premiumRequests - (usageBaseline.credits || 0)) : 0),
          };
        }
      }.bind(this);

      for await (const chunk of proc.stdout || []) {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          yield* handleLine(line);
        }
      }
      if (buffer.trim()) {
        yield* handleLine(buffer);
      }

      const exit = await exitPromise;
      if (state.aborted) {
        await scope.stop();
        yield { type: 'error', error: 'Copilot turn aborted.', source: 'abort' };
        yield { type: 'done' };
        return;
      }
      if (exit.error && !state.aborted) {
        yield { type: 'error', error: formatCopilotProcessError(exit.error) };
        yield { type: 'done' };
        return;
      }
      if (exit.code !== 0 || protocolErrors.length > 0) {
        const stderr = stripAnsi(stderrChunks.join('\n')).trim();
        const error = [...new Set([...protocolErrors, stderr].filter(Boolean))].join('\n')
          || `Copilot exited with code ${exit.code ?? 'unknown'}`;
        if (
          !retryingAfterRecovery
          && !hasTurnOutput
          && !options.isNewSession
          && options.externalSessionId
          && isMissingNativeSessionError(error)
        ) {
          const reason = error;
          let snapshot = null;
          try {
            snapshot = await createRecoverySnapshot(options, {
              previousNativeSessionId: options.externalSessionId,
              reason,
            });
          } catch (snapshotErr) {
            copilotLog.warn('Failed to create Copilot session recovery snapshot', {
              sessionId: options.externalSessionId,
              error: (snapshotErr as Error).message,
            });
          }
          const recovery = buildNativeSessionRecovery({
            backend: 'copilot',
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
        yield { type: 'error', error };
      }
      if (!sawResultUsage && (outputTokens > 0 || checkpointUsage) && !state.aborted) {
        yield { type: 'usage', usage: checkpointUsage && usageBaseline
          ? copilotTurnUsage(checkpointUsage, usageBaseline)
          : copilotUsage(outputTokens, 0) };
      }
      yield { type: 'done' };
    } catch (err: unknown) {
      if (state.aborted) {
        yield { type: 'error', error: 'Copilot turn aborted.', source: 'abort' };
      } else {
        yield { type: 'error', error: (err as Error).message || String(err) };
      }
      yield { type: 'done' };
    } finally {
      await scope.stop();
      this.scopes.delete(scope);
      if (state.scope === scope) state.scope = undefined;
      if (state.proc === proc) state.proc = null;
    }
  }
}

function buildCopilotRunArgs(prompt: string, options: {
  workingDir?: string | null;
  model?: string;
  effort?: EffortLevel;
  externalSessionId?: string | null;
  mcpServers?: McpServerConfig[];
  allowTools?: boolean;
  attachments?: RunOneShotAttachment[];
}): string[] {
  const args = ['-p', prompt, '--output-format', 'json', '--no-ask-user', '--no-color', '--log-level', 'none', '--stream', 'on', '--no-auto-update'];

  const broadAccess = options.allowTools || (Array.isArray(options.mcpServers) && options.mcpServers.length > 0);
  // --allow-all-tools is required for non-interactive mode. The chat and
  // tool-using paths also need filesystem and URL access, matching the
  // cockpit's local full-execution model.
  args.push(broadAccess ? '--allow-all' : '--allow-all-tools');
  if (!broadAccess) args.push('--available-tools', 'none');

  const model = options.model?.trim();
  if (model) args.push('--model', model);

  const selectedModel = COPILOT_MODELS.find(candidate => candidate.id === model);
  if (options.effort && COPILOT_EFFORT_SET.has(options.effort)
    && selectedModel?.supportedEffortLevels?.includes(options.effort)) {
    args.push('--reasoning-effort', options.effort);
  }

  for (const filePath of copilotAttachmentFiles(options.attachments)) {
    args.push('--attachment', filePath);
  }

  const mcpConfig = copilotMcpConfig(options.mcpServers);
  if (mcpConfig) args.push('--additional-mcp-config', mcpConfig);

  if (options.externalSessionId) args.push('--resume', options.externalSessionId);

  return args;
}

function copilotAttachmentFiles(attachments: RunOneShotAttachment[] | undefined): string[] {
  const files: string[] = [];
  for (const attachment of attachments || []) {
    if (attachment.kind !== 'image' && attachment.kind !== 'pdf') continue;
    const filePath = attachment.path?.trim();
    if (filePath) files.push(filePath);
  }
  return files;
}

function copilotUsage(outputTokens: number, premiumRequests: number): Usage {
  return {
    inputTokens: 0,
    outputTokens: Math.max(0, Math.round(outputTokens)),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    costSource: 'none',
    ...(premiumRequests > 0 ? { credits: premiumRequests } : {}),
  };
}

async function runCopilotOnce(runtime: CopilotCliRuntime, args: string[], options: {
  cwd?: string | null;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  registerScope?: (scope: CopilotProcessScope) => () => void;
}): Promise<CopilotRunResult> {
  if (options.abortSignal?.aborted) throw new Error('Copilot command aborted');
  const invocation = buildCliCommandInvocation(runtime, args);
  return await new Promise<CopilotRunResult>((resolve, reject) => {
    const { proc, scope } = spawnCopilotProcess(invocation.command, invocation.args, {
      cwd: options.cwd || undefined,
      env: runtime.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const unregister = options.registerScope?.(scope);
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
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
      void scope.stop().finally(() => { unregister?.(); reject(err); });
    };
    const succeed = (result: CopilotRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      void scope.stop().finally(() => { unregister?.(); resolve(result); });
    };
    const timeout = setTimeout(() => {
      fail(new Error('Copilot command timed out'));
    }, options.timeoutMs);
    const onAbort = () => {
      fail(new Error('Copilot command aborted'));
    };
    options.abortSignal?.addEventListener('abort', onAbort, { once: true });
    proc.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    proc.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('error', err => fail(new Error(formatCopilotProcessError(err as Error & { code?: string }))));
    proc.on('close', code => {
      try {
        const result = collectCopilotJson(stdout);
        if (code !== 0) {
          fail(new Error(stripAnsi(stderr).trim() || `Copilot exited with code ${code ?? 'unknown'}`));
        } else {
          succeed(result);
        }
      } catch (err: unknown) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });
    if (options.abortSignal?.aborted) onAbort();
  });
}

function collectCopilotJson(stdout: string): CopilotRunResult {
  let sessionId: string | null = null;
  let outputTokens = 0;
  let premiumRequests = 0;
  let checkpointUsage: Usage | null = null;
  const deltaTextByMessageId = new Map<string, string>();
  const finalTextByMessageId = new Map<string, string>();
  const messageOrder: string[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const error = translateCopilotLine(line).find(event => event.type === 'error');
    if (error?.type === 'error') throw new Error(error.error);
    const info = copilotLineInfo(line);
    if (info.sessionId) sessionId = info.sessionId;
    outputTokens += info.outputTokens;
    premiumRequests += info.premiumRequests;
    if (info.checkpointUsage) checkpointUsage = info.checkpointUsage;

    const parsed = safeParse(line);
    if (!parsed) continue;
    if (copilotChildEvent(parsed)) continue;
    if (parsed.type === 'tool.execution_start') {
      deltaTextByMessageId.clear();
      finalTextByMessageId.clear();
      messageOrder.length = 0;
    }
    if (parsed.type === 'assistant.message_delta' && isRecord(parsed.data)) {
      const messageId = stringOrNull(parsed.data.messageId) || 'default';
      const delta = typeof parsed.data.deltaContent === 'string' ? parsed.data.deltaContent : '';
      if (delta) {
        if (!deltaTextByMessageId.has(messageId) && !finalTextByMessageId.has(messageId)) messageOrder.push(messageId);
        deltaTextByMessageId.set(messageId, (deltaTextByMessageId.get(messageId) || '') + delta);
      }
    } else if (parsed.type === 'assistant.message' && isRecord(parsed.data)) {
      const messageId = stringOrNull(parsed.data.messageId) || 'default';
      const content = typeof parsed.data.content === 'string' ? parsed.data.content : '';
      if (content) {
        if (!deltaTextByMessageId.has(messageId) && !finalTextByMessageId.has(messageId)) messageOrder.push(messageId);
        finalTextByMessageId.set(messageId, content);
      }
    }
  }

  const text = messageOrder
    .map(messageId => finalTextByMessageId.get(messageId) || deltaTextByMessageId.get(messageId) || '')
    .join('')
    .trim();

  return {
    text,
    sessionId,
    usage: checkpointUsage || (outputTokens > 0 || premiumRequests > 0 ? copilotUsage(outputTokens, premiumRequests) : null),
  };
}

function translateCopilotLine(line: string, toolNames?: Map<string, string>): StreamEvent[] {
  const parsed = safeParse(line);
  if (!parsed) return [];
  if (copilotChildEvent(parsed)) return [];
  const type = parsed.type;
  const data = isRecord(parsed.data) ? parsed.data : null;
  const events: StreamEvent[] = [];

  if (type === 'assistant.message_delta' && data && typeof data.deltaContent === 'string' && data.deltaContent) {
    events.push({ type: 'text', content: data.deltaContent, streaming: true });
  } else if (type === 'assistant.reasoning_delta' && data && typeof data.deltaContent === 'string' && data.deltaContent) {
    events.push({ type: 'thinking', content: data.deltaContent, streaming: true });
  } else if (type === 'tool.execution_start' && data) {
    const id = stringOrNull(data.toolCallId);
    const name = stringOrNull(data.toolName);
    if (id && name) toolNames?.set(id, name);
    events.push(...copilotToolStartEvents(data));
  } else if (type === 'tool.execution_complete' && data) {
    const id = stringOrNull(data.toolCallId);
    events.push(...copilotToolCompleteEvents({
      ...data,
      toolName: stringOrNull(data.toolName) || (id ? toolNames?.get(id) : undefined),
    }));
    if (id) toolNames?.delete(id);
  } else if (type === 'session.error') {
    events.push({ type: 'error', error: firstString(data?.message, data?.error) || 'Copilot session failed.' });
  } else if (type === 'result') {
    const sessionId = stringOrNull(parsed.sessionId);
    if (sessionId) events.push({ type: 'external_session', sessionId });
    if (typeof parsed.exitCode === 'number' && parsed.exitCode !== 0) {
      const error = isRecord(parsed.error) ? parsed.error.message : parsed.error;
      events.push({ type: 'error', error: firstString(error, parsed.message) || `Copilot exited with code ${parsed.exitCode}` });
    }
  }

  return events;
}

function copilotLineInfo(line: string): CopilotLineInfo {
  const empty: CopilotLineInfo = {
    sessionId: null,
    messageId: null,
    deltaMessageId: null,
    outputTokens: 0,
    premiumRequests: 0,
    isResult: false,
    checkpointUsage: null,
  };
  const parsed = safeParse(line);
  if (!parsed) return empty;
  const checkpointUsage = copilotUsageCheckpoint(parsed);
  if (checkpointUsage) return { ...empty, checkpointUsage };

  if (parsed.type === 'result') {
    const usage = isRecord(parsed.usage) ? parsed.usage : {};
    return {
      ...empty,
      sessionId: stringOrNull(parsed.sessionId),
      premiumRequests: numberOrZero(usage.premiumRequests),
      isResult: true,
    };
  }
  if (parsed.type === 'assistant.message' && isRecord(parsed.data)) {
    return {
      ...empty,
      messageId: stringOrNull(parsed.data.messageId),
      outputTokens: numberOrZero(parsed.data.outputTokens),
    };
  }
  if (parsed.type === 'assistant.message_delta' && isRecord(parsed.data)) {
    const messageId = stringOrNull(parsed.data.messageId);
    const hasDelta = typeof parsed.data.deltaContent === 'string' && parsed.data.deltaContent.length > 0;
    return { ...empty, deltaMessageId: hasDelta ? messageId || 'default' : null };
  }
  return empty;
}

function copilotFinalMessageText(line: string): { messageId: string; text: string } | null {
  const parsed = safeParse(line);
  if (!parsed || copilotChildEvent(parsed) || parsed.type !== 'assistant.message' || !isRecord(parsed.data)) return null;
  const content = typeof parsed.data.content === 'string' ? parsed.data.content.trim() : '';
  if (!content) return null;
  return { messageId: stringOrNull(parsed.data.messageId) || 'default', text: content };
}

function copilotChildEvent(event: Record<string, unknown>): boolean {
  const data = isRecord(event.data) ? event.data : {};
  return Boolean(stringOrNull(event.agentId) || stringOrNull(data.parentToolCallId));
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function safeParse(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;]*m/g, '');
}

function formatCopilotProcessError(err: Error & { code?: string }): string {
  return err.code === 'ENOENT'
    ? 'GitHub Copilot CLI is not installed or is not available on PATH.'
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

export const __copilotTestUtils = {
  buildCopilotRunArgs,
  collectCopilotJson,
  copilotLineInfo,
  copilotMcpConfig,
  canonicalCopilotToolName,
  resolveCopilotCliRuntime,
  resolveCopilotWorkingDir,
  translateCopilotLine,
  COPILOT_MODELS,
};
