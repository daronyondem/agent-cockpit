import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { BaseBackendAdapter, type BackendCallOptions, type RunOneShotOptions } from './base';
import { sanitizeSystemPrompt } from './toolUtils';
import { eventBelongsToActiveStreamWork } from './codexEvents';
import {
  FALLBACK_MODELS,
  buildCodexTurnStartParams,
  normalizeCodexModelOption,
  type ModelListResult,
} from './codexModels';
import { runCodexExec } from './codexExec';
import { CodexAppServerProcessManager, type CodexProcessEntry } from './codexProcess';
import {
  dispatchCodexNotification,
  isTerminalCodexGoalStatus,
  type CodexNotificationDispatchContext,
  type CodexStreamState,
} from './codexStreamDispatch';
import {
  CodexAppServerClient,
  respondToStaleCodexRequest,
  type JsonRpcNotification,
  type PendingUserInput,
  type ThreadGoalClearResult,
  type ThreadGoalGetResult,
  type ThreadGoalSetResult,
  type ThreadReadResult,
  type ThreadResumeResult,
  type ThreadStartResult,
  type ToolRequestUserInputParams,
  type ToolRequestUserInputResponse,
  type TurnStartResult,
} from './codexProtocol';
import {
  CODEX_APP_SERVER_ARGS,
  CODEX_CLIENT_CAPABILITIES,
  DEFAULT_CODEX_APPROVAL_POLICY,
  DEFAULT_CODEX_SANDBOX_MODE,
  buildCodexThreadSecurityParams,
  normalizeCodexGoal,
  resolveCodexCliRuntime,
  type CodexCliRuntime,
} from './codexRuntime';
import {
  buildHarnessRecoveryPrompt,
  buildNativeSessionRecovery,
  buildSessionRecoveryEvent,
  createRecoverySnapshot,
  type NativeSessionRecovery,
} from './sessionRecovery';
import { logger } from '../../utils/logger';
import type {
  BackendMetadata,
  ModelOption,
  McpServerConfig,
  SendMessageOptions,
  SendMessageResult,
  StreamEvent,
  Message,
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  ServiceTier,
  CliProfile,
  CodexThreadGoalStatus,
  ThreadGoal,
} from '../../types';
import { buildCliCommandInvocation } from '../cliCommandResolver';

export { deriveCodexUsage } from './codexUsage';
export { codexImageArtifactEvent, findCodexGeneratedImagePath } from './codexArtifacts';
export { buildCodexTurnStartParams, codexModelSupportsEffort, normalizeCodexModelOption } from './codexModels';
export {
  buildCodexServiceTierArgs,
  buildCodexThreadSecurityParams,
  resolveCodexCliRuntime,
  type CodexCliRuntime,
} from './codexRuntime';
export {
  eventBelongsToActiveChildWork,
  eventBelongsToActiveParentTurn,
  eventBelongsToActiveStreamWork,
  eventIsFromChildThread,
  extractCodexThreadId,
  extractCodexToolDetails,
  extractCodexTurnId,
  isParentTurnCompleted,
  lookupParentAgentId,
  recordSpawnAgentReceivers,
} from './codexEvents';

// ── Icon ────────────────────────────────────────────────────────────────────

const CODEX_ICON = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z" fill="#fff"/><path d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z" fill="url(#codex-gradient)"/><defs><linearGradient gradientUnits="userSpaceOnUse" id="codex-gradient" x1="12" x2="12" y1="3" y2="21"><stop stop-color="#B1A7FF"/><stop offset=".5" stop-color="#7A9DFF"/><stop offset="1" stop-color="#3941FF"/></linearGradient></defs></svg>';
const codexLog = logger.child({ module: 'codex-backend' });
const CODEX_GOAL_STATUS_POLL_MS = 1_000;

function buildCodexGoalTurnPrompt(objective: string | null | undefined): string {
  const trimmedObjective = typeof objective === 'string' ? objective.trim() : '';
  if (!trimmedObjective) return 'Continue working on the active goal and report the result in this chat.';
  return `Work on this active goal and report the result in this chat:\n\n${trimmedObjective}`;
}

function buildCodexGoalReportPrompt(objective: string | null | undefined): string {
  const trimmedObjective = typeof objective === 'string' ? objective.trim() : '';
  if (!trimmedObjective) return 'The goal has completed, but no final report was emitted. Provide the final report in this chat.';
  return `The goal has completed, but no final report was emitted. Provide the final report in this chat.\n\nGoal:\n${trimmedObjective}`;
}

// ── Adapter ─────────────────────────────────────────────────────────────────

export class CodexAdapter extends BaseBackendAdapter {
  private processManager = new CodexAppServerProcessManager();
  private modelCache: ModelOption[] | null = null;
  private profileModelCache: Map<string, ModelOption[]> = new Map();
  private modelRefreshes: Map<string, Promise<ModelOption[]>> = new Map();
  private readonly approvalPolicy: CodexApprovalPolicy;
  private readonly sandbox: CodexSandboxMode;

  constructor(options: { workingDir?: string; approvalPolicy?: CodexApprovalPolicy; sandbox?: CodexSandboxMode } = {}) {
    super(options);
    this.workingDir = options.workingDir || path.resolve(os.homedir(), '.codex', 'workspace');
    this.approvalPolicy = options.approvalPolicy || DEFAULT_CODEX_APPROVAL_POLICY;
    this.sandbox = options.sandbox || DEFAULT_CODEX_SANDBOX_MODE;

    // Best-effort dynamic model discovery in the background. Failure (CLI
    // missing, auth missing, network blocked) is not fatal — the picker
    // shows the fallback list until the user installs/auths Codex.
    //
    // Skipped under Jest so unit tests don't spawn real codex processes
    // (would prevent Jest from exiting cleanly).
    if (!process.env.JEST_WORKER_ID) {
      this._refreshModels().catch((err) => {
        console.warn(`[codex] model/list refresh failed: ${err.message || err}`);
      });
    }
  }

  get metadata(): BackendMetadata {
    return {
      id: 'codex',
      label: 'Codex',
      icon: CODEX_ICON,
      capabilities: {
        thinking: true,
        planMode: false,
        agents: true,
        toolActivity: true,
        userQuestions: true,
        stdinInput: true,
        oneShotMediaInput: {
          image: ['native-file-tool'],
        },
        goals: {
          set: true,
          clear: true,
          pause: true,
          resume: true,
          status: 'native',
        },
      },
      resumeCapabilities: {
        activeTurnResume: 'unsupported',
        activeTurnResumeReason: 'Codex thread/resume restores the thread for a later turn, but the adapter does not have a safe protocol path to reattach to a turn already running before the cockpit process restarted.',
        sessionResume: 'supported',
        sessionResumeReason: 'The adapter persists Codex thread IDs via external_session and uses thread/resume after process respawn before starting the next turn.',
      },
      models: this.modelCache || FALLBACK_MODELS,
    };
  }

  async getMetadata(options: BackendCallOptions = {}): Promise<BackendMetadata> {
    const models = await this._getModels(options.cliProfile);
    return {
      ...this.metadata,
      models,
    };
  }

  shutdown(): void {
    this.processManager.shutdown();
  }

  onSessionReset(conversationId: string): void {
    this.processManager.killConversation(conversationId);
  }

  sendMessage(message: string, options: SendMessageOptions = {} as SendMessageOptions): SendMessageResult {
    let aborted = false;
    const state: Omit<CodexStreamState, 'aborted'> = {
      client: null,
      threadId: null,
      turnId: null,
      pendingUserInput: null,
      subagentByThreadId: new Map(),
    };

    const stream = this._createStream(message, options, {
      get aborted() { return aborted; },
      get client() { return state.client; },
      set client(c: CodexAppServerClient | null) { state.client = c; },
      get threadId() { return state.threadId; },
      set threadId(t: string | null) { state.threadId = t; },
      get turnId() { return state.turnId; },
      set turnId(t: string | null) { state.turnId = t; },
      get pendingUserInput() { return state.pendingUserInput; },
      set pendingUserInput(p: PendingUserInput | null) { state.pendingUserInput = p; },
      subagentByThreadId: state.subagentByThreadId,
    });

    const abort = () => {
      aborted = true;
      const { client, threadId, turnId } = state;
      if (client && !client.isClosed && threadId && turnId) {
        client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      }
    };

    // Route the user's input either to a pending `item/tool/requestUserInput`
    // request (JSON-RPC response) or to the in-flight turn (`turn/steer`):
    //   • If the server is currently waiting on a user-question, build a
    //     `ToolRequestUserInputResponse` and reply to the original request.
    //     Only the first question gets the user's text — the cockpit UI
    //     surfaces a single question at a time. The server tolerates partial
    //     answers (HashMap is unconstrained on the wire).
    //   • Otherwise append the text to the active turn via `turn/steer`,
    //     passing `expectedTurnId` so the server rejects stale UI input
    //     rather than applying it to a turn the user didn't intend.
    // No-ops when aborted, when text is empty/non-string, or when the
    // client/threadId state isn't populated yet.
    const sendInput = (text: string) => {
      if (aborted) return;
      if (typeof text !== 'string' || !text) return;
      const { client, threadId, turnId, pendingUserInput } = state;
      if (!client || client.isClosed || !threadId) return;

      if (pendingUserInput) {
        const first = pendingUserInput.questions[0];
        const response: ToolRequestUserInputResponse = { answers: {} };
        if (first) response.answers[first.id] = { answers: [text] };
        state.pendingUserInput = null;
        client.respond(pendingUserInput.reqId, response);
        return;
      }

      if (!turnId) return;
      client.request('turn/steer', {
        threadId,
        input: [{ type: 'text', text }],
        expectedTurnId: turnId,
      }).catch((err: Error) => {
        console.warn(`[codex] turn/steer rejected: ${err.message}`);
      });
    };

    return { stream, abort, sendInput };
  }

  async getGoal(options: SendMessageOptions): Promise<ThreadGoal | null> {
    const ctx = await this._getGoalThreadContext(options, { allowStart: false, reuseExistingMcp: true });
    if (!ctx.threadId) return null;
    const result = await ctx.client.request('thread/goal/get', { threadId: ctx.threadId }) as ThreadGoalGetResult;
    return normalizeCodexGoal(result.goal);
  }

  setGoalObjective(objective: string, options: SendMessageOptions = {} as SendMessageOptions): SendMessageResult {
    return this._createGoalRun({ objective: objective.trim() }, options);
  }

  resumeGoal(options: SendMessageOptions = {} as SendMessageOptions): SendMessageResult {
    return this._createGoalRun({ status: 'active' }, options);
  }

  async pauseGoal(options: SendMessageOptions): Promise<ThreadGoal | null> {
    const ctx = await this._getGoalThreadContext(options, { allowStart: false, reuseExistingMcp: true });
    if (!ctx.threadId) return null;
    const result = await ctx.client.request('thread/goal/set', {
      threadId: ctx.threadId,
      status: 'paused',
    }) as ThreadGoalSetResult;
    return normalizeCodexGoal(result.goal);
  }

  async clearGoal(options: SendMessageOptions): Promise<{ cleared: boolean; threadId?: string | null }> {
    const ctx = await this._getGoalThreadContext(options, { allowStart: false, reuseExistingMcp: true });
    if (!ctx.threadId) return { cleared: false, threadId: null };
    const result = await ctx.client.request('thread/goal/clear', { threadId: ctx.threadId }) as ThreadGoalClearResult;
    return { cleared: !!result.cleared, threadId: ctx.threadId };
  }

  private _createGoalRun(
    goalPatch: { objective?: string; status?: Extract<CodexThreadGoalStatus, 'active'> },
    options: SendMessageOptions,
  ): SendMessageResult {
    let aborted = false;
    const state: Omit<CodexStreamState, 'aborted'> = {
      client: null,
      threadId: null,
      turnId: null,
      pendingUserInput: null,
      subagentByThreadId: new Map(),
    };

    const stream = this._createGoalStream(goalPatch, options, {
      get aborted() { return aborted; },
      get client() { return state.client; },
      set client(c: CodexAppServerClient | null) { state.client = c; },
      get threadId() { return state.threadId; },
      set threadId(t: string | null) { state.threadId = t; },
      get turnId() { return state.turnId; },
      set turnId(t: string | null) { state.turnId = t; },
      get pendingUserInput() { return state.pendingUserInput; },
      set pendingUserInput(p: PendingUserInput | null) { state.pendingUserInput = p; },
      subagentByThreadId: state.subagentByThreadId,
    });

    const abort = () => {
      aborted = true;
      const { client, threadId, turnId } = state;
      if (client && !client.isClosed && threadId && turnId) {
        client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      }
    };

    const sendInput = (text: string) => {
      if (aborted) return;
      if (typeof text !== 'string' || !text) return;
      const { client, threadId, turnId, pendingUserInput } = state;
      if (!client || client.isClosed || !threadId) return;

      if (pendingUserInput) {
        const first = pendingUserInput.questions[0];
        const response: ToolRequestUserInputResponse = { answers: {} };
        if (first) response.answers[first.id] = { answers: [text] };
        state.pendingUserInput = null;
        client.respond(pendingUserInput.reqId, response);
        return;
      }

      if (!turnId) return;
      client.request('turn/steer', {
        threadId,
        input: [{ type: 'text', text }],
        expectedTurnId: turnId,
      }).catch((err: Error) => {
        console.warn(`[codex] goal turn/steer rejected: ${err.message}`);
      });
    };

    return { stream, abort, sendInput };
  }

  async generateSummary(
    messages: Pick<Message, 'role' | 'content'>[],
    fallback: string,
    options: BackendCallOptions = {},
  ): Promise<string> {
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

      const out = await this._execOneShot(prompt, { timeoutMs: 30000, cliProfile: options.cliProfile });
      if (!out) return fallback || `Session (${messages.length} messages)`;
      return out.substring(0, 200);
    } catch {
      return fallback || `Session (${messages.length} messages)`;
    }
  }

  async generateTitle(userMessage: string, fallback: string, options: BackendCallOptions = {}): Promise<string> {
    if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
      return fallback || 'New Chat';
    }
    const titleFallback = () => fallback || userMessage.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
    try {
      const truncated = userMessage.substring(0, 2000);
      const prompt = `Generate a short, descriptive title (max 8 words) for a conversation that starts with this user message. Only output the title text, nothing else — no quotes, no prefix:\n\n${truncated}`;

      const out = await this._execOneShot(prompt, { timeoutMs: 30000, cliProfile: options.cliProfile });
      if (!out) return titleFallback();
      return out.substring(0, 80);
    } catch {
      return titleFallback();
    }
  }

  /**
   * Run a one-shot prompt via `codex exec` and return the model's final
   * answer text. Used by the Memory MCP server, KB digestion, generateTitle,
   * and generateSummary. `codex exec` uses the selected profile's runtime
   * env; account profiles set `CODEX_HOME` so OAuth/API-key state is isolated.
   */
  async runOneShot(prompt: string, options: RunOneShotOptions = {}): Promise<string> {
    return this._execOneShot(prompt, options);
  }

  // ── Private: model discovery ──────────────────────────────────────────────

  private _cacheModels(runtime: CodexCliRuntime, models: ModelOption[]): void {
    if (runtime.profileKey.startsWith('server-configured:')) {
      this.modelCache = models;
    } else {
      this.profileModelCache.set(runtime.profileKey, models);
    }
  }

  private _cachedModels(runtime: CodexCliRuntime): ModelOption[] | null {
    if (runtime.profileKey.startsWith('server-configured:')) {
      return this.modelCache;
    }
    return this.profileModelCache.get(runtime.profileKey) || null;
  }

  private _modelsFor(profile?: CliProfile): ModelOption[] {
    const runtime = resolveCodexCliRuntime(profile);
    return this._cachedModels(runtime) || FALLBACK_MODELS;
  }

  private async _getModels(profile?: CliProfile): Promise<ModelOption[]> {
    const runtime = resolveCodexCliRuntime(profile);
    const cached = this._cachedModels(runtime);
    if (cached && cached.length > 0) return cached;

    let refresh = this.modelRefreshes.get(runtime.profileKey);
    if (!refresh) {
      refresh = this._refreshModels(profile);
      this.modelRefreshes.set(runtime.profileKey, refresh);
      refresh.finally(() => this.modelRefreshes.delete(runtime.profileKey)).catch(() => {});
    }

    try {
      return await refresh;
    } catch (err) {
      console.warn(`[codex] model/list refresh failed: ${(err as Error).message || err}`);
      return this._cachedModels(runtime) || FALLBACK_MODELS;
    }
  }

  private async _refreshModels(profile?: CliProfile): Promise<ModelOption[]> {
    const runtime = resolveCodexCliRuntime(profile);
    const invocation = buildCliCommandInvocation(runtime, CODEX_APP_SERVER_ARGS);
    const proc = spawn(invocation.command, invocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: runtime.env,
    });

    let spawnFailed = false;
    proc.on('error', () => {
      // ENOENT etc — silently fall back. Logged at the catch in constructor.
      spawnFailed = true;
    });

    // Safety: kill the process even if something below hangs.
    const killTimer = setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 15_000);

    try {
      // Wait one tick so the spawn ENOENT event has a chance to fire before
      // we try to write to stdin and crash with EPIPE.
      await new Promise<void>((r) => setImmediate(r));
      if (spawnFailed) return this._cachedModels(runtime) || FALLBACK_MODELS;

      const client = new CodexAppServerClient(proc);
      await client.request('initialize', {
        clientInfo: { name: 'agent-cockpit', title: null, version: '1.0.0' },
        capabilities: CODEX_CLIENT_CAPABILITIES,
      });
      const result = await client.request('model/list', {
        limit: 50,
        includeHidden: false,
      }) as ModelListResult;

      if (result && Array.isArray(result.data) && result.data.length > 0) {
        const models = result.data
          .map(normalizeCodexModelOption)
          .filter((m): m is ModelOption => m !== null);
        // Ensure exactly one default
        if (models.length > 0 && !models.some((m) => m.default)) {
          models[0].default = true;
        }
        if (models.length > 0) {
          this._cacheModels(runtime, models);
          return models;
        }
      }
      return this._cachedModels(runtime) || FALLBACK_MODELS;
    } finally {
      clearTimeout(killTimer);
      if (!proc.killed) proc.kill('SIGTERM');
    }
  }

  // ── Private: streaming session ────────────────────────────────────────────

  private async _resolveThread(
    client: CodexAppServerClient,
    entry: CodexProcessEntry,
    convId: string,
    options: SendMessageOptions,
  ): Promise<{ threadId: string | null; externalSessionId?: string; recovery?: NativeSessionRecovery }> {
    const { isNewSession, workingDir, systemPrompt, externalSessionId, model } = options;
    const cwd = workingDir || this.workingDir || os.homedir();
    let threadId = entry.threadId;

    if (isNewSession && !threadId) {
      const cleanPrompt = sanitizeSystemPrompt(systemPrompt);
      const startParams: Record<string, unknown> = {
        cwd,
        ...buildCodexThreadSecurityParams(this.approvalPolicy, this.sandbox),
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      };
      if (model) startParams.model = model;
      if (cleanPrompt) startParams.developerInstructions = cleanPrompt;

      const result = await client.request('thread/start', startParams) as ThreadStartResult;
      threadId = result.thread.id;
      entry.threadId = threadId;
      console.log(`[codex] Started thread ${threadId} for conv=${convId}`);
      return { threadId, externalSessionId: threadId };
    }

    if (threadId) {
      return { threadId };
    }

    if (externalSessionId) {
      const resumeParams: Record<string, unknown> = {
        threadId: externalSessionId,
        cwd,
        ...buildCodexThreadSecurityParams(this.approvalPolicy, this.sandbox),
        excludeTurns: true,
        persistExtendedHistory: false,
      };
      if (model) resumeParams.model = model;

      try {
        const result = await client.request('thread/resume', resumeParams) as ThreadResumeResult;
        threadId = result.thread.id;
        entry.threadId = threadId;
        const drained = client.drainNotifications((notification) => {
          respondToStaleCodexRequest(client, notification, 'Stale Codex request ignored after thread resume');
        });
        console.log(`[codex] Resumed thread ${threadId} for conv=${convId} (drained ${drained} notifications)`);
        return { threadId };
      } catch (err) {
        const reason = (err as Error).message;
        console.warn(`[codex] Resume failed for ${externalSessionId}: ${reason}. Starting fresh thread.`);
        let snapshot = null;
        try {
          snapshot = await createRecoverySnapshot(options, {
            previousNativeSessionId: externalSessionId,
            reason,
          });
        } catch (snapshotErr) {
          console.warn(`[codex] Failed to create session recovery snapshot for ${externalSessionId}: ${(snapshotErr as Error).message}`);
        }
        const startParams: Record<string, unknown> = {
          cwd,
          ...buildCodexThreadSecurityParams(this.approvalPolicy, this.sandbox),
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        };
        if (model) startParams.model = model;
        const cleanPrompt = sanitizeSystemPrompt(systemPrompt);
        if (cleanPrompt) startParams.developerInstructions = cleanPrompt;
        const result = await client.request('thread/start', startParams) as ThreadStartResult;
        threadId = result.thread.id;
        entry.threadId = threadId;
        return {
          threadId,
          externalSessionId: threadId,
          recovery: buildNativeSessionRecovery({
            backend: 'codex',
            previousNativeSessionId: externalSessionId,
            newNativeSessionId: threadId,
            reason,
            snapshot,
            currentPrompt: '',
          }),
        };
      }
    }

    return { threadId: null };
  }

  private async _getGoalThreadContext(
    options: SendMessageOptions,
    control: { allowStart: boolean; reuseExistingMcp?: boolean },
  ): Promise<{
    client: CodexAppServerClient;
    entry: CodexProcessEntry;
    convId: string;
    threadId: string | null;
    externalSessionId?: string;
    recovery?: NativeSessionRecovery;
  }> {
    const { sessionId, conversationId, mcpServers, cliProfile, serviceTier } = options;
    const convId = conversationId || sessionId;
    const mcpServersForCodex: McpServerConfig[] = Array.isArray(mcpServers) ? mcpServers : [];
    const client = await this.processManager.getOrSpawn(convId, mcpServersForCodex, cliProfile, {
      reuseExistingMcp: control.reuseExistingMcp,
      serviceTier,
    });
    const entry = this.processManager.entry(convId)!;
    const resolved = await this._resolveThread(client, entry, convId, {
      ...options,
      isNewSession: control.allowStart ? options.isNewSession : false,
    });
    return {
      client,
      entry,
      convId,
      threadId: resolved.threadId,
      ...(resolved.externalSessionId ? { externalSessionId: resolved.externalSessionId } : {}),
      ...(resolved.recovery ? { recovery: resolved.recovery } : {}),
    };
  }

  private _drainQueuedNotificationsBeforeRun(
    client: CodexAppServerClient,
    convId: string,
    phase: 'chat' | 'goal',
  ): void {
    const requestMethods = new Map<string, number>();
    const drained = client.drainNotifications((notification) => {
      if (notification.id != null) {
        requestMethods.set(notification.method, (requestMethods.get(notification.method) || 0) + 1);
        respondToStaleCodexRequest(client, notification, 'Stale Codex request ignored before starting a new turn');
      }
    });
    if (drained > 0) {
      codexLog.warn('drained queued Codex notifications before starting turn', {
        conversationId: convId,
        phase,
        drained,
        serverRequests: Object.fromEntries(requestMethods.entries()),
      });
    }
  }

  private async _interruptActiveOrphanTurnIfAny(
    client: CodexAppServerClient,
    convId: string,
    threadId: string,
    phase: 'chat' | 'goal',
  ): Promise<void> {
    try {
      const result = await client.request('thread/read', { threadId, includeTurns: true }) as ThreadReadResult;
      const turns = result.thread?.turns || [];
      const activeTurn = [...turns].reverse().find((turn) => (
        typeof turn.id === 'string' && turn.status === 'inProgress'
      ));
      if (!activeTurn?.id) return;
      codexLog.warn('interrupting orphaned Codex turn before starting new turn', {
        conversationId: convId,
        threadId,
        turnId: activeTurn.id,
      });
      await client.request('turn/interrupt', { threadId, turnId: activeTurn.id }).catch((err: Error) => {
        codexLog.warn('failed to interrupt orphaned Codex turn', {
          conversationId: convId,
          threadId,
          turnId: activeTurn.id,
          errorMessage: err.message,
        });
      });
      this._drainQueuedNotificationsBeforeRun(client, convId, phase);
    } catch (err) {
      codexLog.warn('failed to inspect Codex thread for orphaned active turn', {
        conversationId: convId,
        threadId,
        errorMessage: (err as Error).message,
      });
    }
  }

  private *_handleCodexServerRequest(
    client: CodexAppServerClient,
    notification: JsonRpcNotification,
    params: Record<string, unknown>,
    state: CodexStreamState,
    activeTurnId: string | null,
    mode: 'chat' | 'goal',
  ): Generator<StreamEvent, boolean> {
    if (notification.id == null) return false;
    const reqId = notification.id;
    const method = notification.method;
    const stalePrefix = mode === 'goal' ? 'Stale Codex goal' : 'Stale Codex';

    if (method === 'item/commandExecution/requestApproval'
        || method === 'item/fileChange/requestApproval') {
      if (!eventBelongsToActiveStreamWork(params, state.threadId, activeTurnId, state.subagentByThreadId)) {
        respondToStaleCodexRequest(client, notification, `${stalePrefix} approval request ignored`);
        return true;
      }
      client.respond(reqId, { decision: 'acceptForSession' });
      return true;
    }

    if (method === 'item/permissions/requestApproval') {
      if (!eventBelongsToActiveStreamWork(params, state.threadId, activeTurnId, state.subagentByThreadId)) {
        respondToStaleCodexRequest(client, notification, `${stalePrefix} permissions request ignored`);
        return true;
      }
      client.respond(reqId, {
        permissions: { network: undefined, fileSystem: undefined },
        scope: 'session',
      });
      return true;
    }

    if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
      client.respond(reqId, { decision: 'approved' });
      return true;
    }

    if (method === 'item/tool/requestUserInput') {
      if (!eventBelongsToActiveStreamWork(params, state.threadId, activeTurnId, state.subagentByThreadId)) {
        respondToStaleCodexRequest(client, notification, `${stalePrefix} user-input request ignored`);
        return true;
      }
      const p = params as unknown as ToolRequestUserInputParams;
      const questions = Array.isArray(p.questions) ? p.questions : [];
      state.pendingUserInput = { reqId, itemId: p.itemId, turnId: p.turnId, questions };
      const first = questions[0];
      yield {
        type: 'tool_activity',
        tool: 'AskUserQuestion',
        id: p.itemId,
        description: (first && first.header) || 'Question',
        isQuestion: true,
        questions: questions.map((q) => ({
          question: q.question,
          options: Array.isArray(q.options) ? q.options : [],
        })),
      };
      return true;
    }

    client.respond(reqId, { error: { code: -32601, message: 'Not supported by client' } });
    return true;
  }

  private async *_createGoalStream(
    goalPatch: { objective?: string; status?: Extract<CodexThreadGoalStatus, 'active'> },
    options: SendMessageOptions,
    state: CodexStreamState,
  ): AsyncGenerator<StreamEvent> {
    const { model, effort, cliProfile, serviceTier } = options;
    const runtime = resolveCodexCliRuntime(cliProfile);

    let ctx: Awaited<ReturnType<CodexAdapter['_getGoalThreadContext']>>;
    try {
      ctx = await this._getGoalThreadContext(options, { allowStart: true });
      state.client = ctx.client;
    } catch (err) {
      const errMsg = (err as Error).message;
      if (errMsg.includes('ENOENT') || errMsg.includes('not found')) {
        yield { type: 'error', error: 'Codex CLI is not installed. Install with `npm install -g @openai/codex`' };
      } else {
        yield { type: 'error', error: `Failed to start Codex: ${errMsg}` };
      }
      yield { type: 'done' };
      return;
    }

    const { client, entry, convId, threadId } = ctx;
    const recovery = ctx.recovery || null;
    if (recovery) {
      yield buildSessionRecoveryEvent(recovery.metadata);
    }
    if (ctx.externalSessionId) {
      yield { type: 'external_session', sessionId: ctx.externalSessionId };
    }

    if (!threadId) {
      yield { type: 'error', error: 'No Codex thread ID available for this conversation' };
      yield { type: 'done' };
      return;
    }

    state.threadId = threadId;
    yield {
      type: 'backend_runtime',
      externalSessionId: threadId,
      processId: entry.proc.pid ?? null,
    };

    if (!ctx.externalSessionId) {
      this._drainQueuedNotificationsBeforeRun(client, convId, 'goal');
      await this._interruptActiveOrphanTurnIfAny(client, convId, threadId, 'goal');
    }

    try {
      const setParams: Record<string, unknown> = {
        threadId,
        status: 'active',
      };
      if (goalPatch.objective) setParams.objective = goalPatch.objective;
      const setResult = await client.request('thread/goal/set', setParams) as ThreadGoalSetResult;
      const normalizedGoal = normalizeCodexGoal(setResult.goal);
      if (normalizedGoal) yield { type: 'goal_updated', goal: normalizedGoal };

      const toolByItemId: Map<string, string> = new Map();
      let turnStarted = false;
      let turnEnded = false;
      let emittedText = false;
      let needsReportTurn = false;
      let emittedRuntimeTurnId: string | null = null;
      const emitRuntimeTurnId = (turnId: string): StreamEvent | null => {
        if (emittedRuntimeTurnId === turnId) return null;
        if (state.turnId && state.turnId !== turnId) return null;
        state.turnId = turnId;
        turnStarted = true;
        emittedRuntimeTurnId = turnId;
        return {
          type: 'backend_runtime',
          externalSessionId: threadId,
          activeTurnId: turnId,
          processId: entry.proc.pid ?? null,
        };
      };

      const activeObjective = normalizedGoal?.objective || goalPatch.objective || '';
      const goalTurnPrompt = buildCodexGoalTurnPrompt(activeObjective);
      const userInput = [{
        type: 'text',
        text: recovery
          ? buildHarnessRecoveryPrompt(recovery.metadata, goalTurnPrompt)
          : goalTurnPrompt,
        text_elements: [],
      }];
      const modelCatalog = this._modelsFor(cliProfile);
      const turnParams = buildCodexTurnStartParams(threadId, userInput, model, effort, modelCatalog);
      try {
        const turnResp = await client.request('turn/start', turnParams) as TurnStartResult;
        const turnId = turnResp.turn.id;
        const runtimeEvent = emitRuntimeTurnId(turnId);
        if (runtimeEvent) yield runtimeEvent;
      } catch (err) {
        yield { type: 'error', error: `Codex goal turn failed: ${(err as Error).message}` };
        yield { type: 'done' };
        return;
      }

      const notificationIterator = client.notifications()[Symbol.asyncIterator]();
      let nextNotification = notificationIterator.next();

      while (true) {
        const next = await Promise.race([
          nextNotification.then((result) => ({ type: 'notification' as const, result })),
          new Promise<{ type: 'goal_poll' }>((resolve) => {
            setTimeout(() => resolve({ type: 'goal_poll' }), CODEX_GOAL_STATUS_POLL_MS);
          }),
        ]);

        if (next.type === 'goal_poll') {
          try {
            const goalResult = await client.request('thread/goal/get', { threadId }) as ThreadGoalGetResult;
            const polledGoal = normalizeCodexGoal(goalResult.goal);
            if (isTerminalCodexGoalStatus(goalResult.goal?.status)) {
              if (polledGoal) yield { type: 'goal_updated', goal: polledGoal };
              if (!emittedText) needsReportTurn = true;
              turnEnded = true;
              client.stopNotifications();
              break;
            }
          } catch (err) {
            codexLog.warn('failed to poll Codex goal status while streaming', {
              conversationId: convId,
              threadId,
              errorMessage: (err as Error).message,
            });
          }
          continue;
        }

        if (next.result.done) break;
        const notification = next.result.value;
        nextNotification = notificationIterator.next();

        if (state.aborted) {
          yield { type: 'error', error: 'Aborted by user' };
          yield { type: 'done' };
          return;
        }

        this.processManager.resetIdle(convId);

        const params = (notification.params || {});
        const method = notification.method;

        if (notification.id != null) {
          yield* this._handleCodexServerRequest(client, notification, params, state, state.turnId, 'goal');
          continue;
        }

        const dispatch: CodexNotificationDispatchContext = {
          mode: 'goal',
          client,
          state,
          activeTurnId: state.turnId,
          threadId,
          entry,
          runtime,
          serviceTier,
          model,
          toolByItemId,
          emitRuntimeTurnId,
          emittedText,
          turnEnded,
          needsReportTurn,
        };
        yield* dispatchCodexNotification(dispatch, params, method);
        emittedText = dispatch.emittedText;
        turnEnded = dispatch.turnEnded;
        needsReportTurn = dispatch.needsReportTurn;
      }

      if (!turnEnded && turnStarted) {
        // Notification stream exited before turn/completed. Let processStream
        // persist whatever content was already emitted and close the UI turn.
      }

      if (needsReportTurn && !state.aborted) {
        state.turnId = null;
        state.pendingUserInput = null;
        state.subagentByThreadId.clear();
        yield* this._createStream(
          buildCodexGoalReportPrompt(activeObjective),
          {
            ...options,
            isNewSession: false,
            externalSessionId: threadId,
          },
          state,
        );
        return;
      }

      yield { type: 'done' };
    } catch (err) {
      yield { type: 'error', error: `Codex goal failed: ${(err as Error).message}` };
      yield { type: 'done' };
    }
  }

  private async *_createStream(
    message: string,
    options: SendMessageOptions,
    state: CodexStreamState,
  ): AsyncGenerator<StreamEvent> {
    const { sessionId, conversationId, model, effort, serviceTier, mcpServers, cliProfile } = options;
    const convId = conversationId || sessionId;
    const runtime = resolveCodexCliRuntime(cliProfile);
    const mcpServersForCodex: McpServerConfig[] = Array.isArray(mcpServers) ? mcpServers : [];

    let client: CodexAppServerClient;
    try {
      client = await this.processManager.getOrSpawn(convId, mcpServersForCodex, cliProfile, { serviceTier });
      state.client = client;
    } catch (err) {
      const errMsg = (err as Error).message;
      if (errMsg.includes('ENOENT') || errMsg.includes('not found')) {
        yield { type: 'error', error: 'Codex CLI is not installed. Install with `npm install -g @openai/codex`' };
      } else {
        yield { type: 'error', error: `Failed to start Codex: ${errMsg}` };
      }
      yield { type: 'done' };
      return;
    }

    const entry = this.processManager.entry(convId)!;

    try {
      // ── Resolve thread ───────────────────────────────────────────────
      const resolved = await this._resolveThread(client, entry, convId, options);
      const threadId = resolved.threadId;
      const recovery = resolved.recovery || null;
      if (recovery) {
        yield buildSessionRecoveryEvent(recovery.metadata);
      }
      if (resolved.externalSessionId) {
        yield { type: 'external_session', sessionId: resolved.externalSessionId };
      }

      if (!threadId) {
        yield { type: 'error', error: 'No Codex thread ID available for this conversation' };
        yield { type: 'done' };
        return;
      }

      state.threadId = threadId;
      yield {
        type: 'backend_runtime',
        externalSessionId: threadId,
        processId: entry.proc.pid ?? null,
      };

      if (!resolved.externalSessionId) {
        this._drainQueuedNotificationsBeforeRun(client, convId, 'chat');
        await this._interruptActiveOrphanTurnIfAny(client, convId, threadId, 'chat');
      }

      // ── Build turn input ─────────────────────────────────────────────
      const turnMessage = recovery
        ? buildHarnessRecoveryPrompt(recovery.metadata, message)
        : message;
      const userInput = [{ type: 'text', text: turnMessage, text_elements: [] }];
      const modelCatalog = this._modelsFor(cliProfile);
      const turnParams = buildCodexTurnStartParams(threadId, userInput, model, effort, modelCatalog);

      // ── Send turn ────────────────────────────────────────────────────
      console.log(`[codex] turn/start thread=${threadId} promptLen=${turnMessage.length}`);

      let turnEnded = false;
      let emittedRuntimeTurnId: string | null = null;
      let responseTurnId: string | null = null;
      const emitRuntimeTurnId = (turnId: string): StreamEvent | null => {
        if (emittedRuntimeTurnId === turnId) return null;
        state.turnId = turnId;
        emittedRuntimeTurnId = turnId;
        return {
          type: 'backend_runtime',
          externalSessionId: state.threadId,
          activeTurnId: turnId,
          processId: entry.proc.pid ?? null,
        };
      };

      try {
        const turnResp = await client.request('turn/start', turnParams) as TurnStartResult;
        responseTurnId = turnResp.turn.id;
        const runtimeEvent = emitRuntimeTurnId(responseTurnId);
        if (runtimeEvent) yield runtimeEvent;
        // Acceptance — turn/completed notification will arrive separately.
      } catch (err) {
        yield { type: 'error', error: `Codex turn failed: ${(err as Error).message}` };
        yield { type: 'done' };
        return;
      }

      // ── Stream notifications ─────────────────────────────────────────
      const toolByItemId: Map<string, string> = new Map();
      const notificationIterator = client.notifications()[Symbol.asyncIterator]();
      let nextNotification = notificationIterator.next();

      while (true) {
        const next = await nextNotification.then((result) => ({ type: 'notification' as const, result }));

        if (next.result.done) break;
        const notification = next.result.value;
        nextNotification = notificationIterator.next();

        if (state.aborted) {
          yield { type: 'error', error: 'Aborted by user' };
          yield { type: 'done' };
          return;
        }

        // Reset idle timer on every notification — keeps long-running turns
        // (multi-agent, large refactors) from being SIGTERM'd mid-flight.
        this.processManager.resetIdle(convId);

        const params = (notification.params || {});
        const method = notification.method;

        if (notification.id != null) {
          yield* this._handleCodexServerRequest(client, notification, params, state, responseTurnId, 'chat');
          continue;
        }

        const dispatch: CodexNotificationDispatchContext = {
          mode: 'chat',
          client,
          state,
          activeTurnId: responseTurnId,
          threadId,
          entry,
          runtime,
          serviceTier,
          model,
          toolByItemId,
          emitRuntimeTurnId,
          emittedText: false,
          turnEnded,
          needsReportTurn: false,
        };
        yield* dispatchCodexNotification(dispatch, params, method);
        turnEnded = dispatch.turnEnded;
      }

      if (!turnEnded) {
        // Notification stream exited without a turn/completed — treat as done.
        // Common cause: process closed mid-turn.
      }

      yield { type: 'done' };
    } catch (err) {
      yield { type: 'error', error: `Codex error: ${(err as Error).message}` };
      yield { type: 'done' };
    }
  }

  // ── Private: codex exec one-shot ──────────────────────────────────────────

  /**
   * Run a one-shot prompt against `codex exec` and return the final answer.
   *
   * `codex exec` is a dedicated non-interactive subcommand. Current Codex
   * versions print transcript/status text to stdout, so we ask it to write the
   * final assistant message to a temp file and return that clean payload.
   * Account profiles set `CODEX_HOME` so OAuth/API-key state is isolated.
   */
  private async _execOneShot(prompt: string, options: RunOneShotOptions = {}): Promise<string> {
    return runCodexExec(prompt, options, {
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandbox,
      fallbackWorkingDir: this.workingDir || undefined,
      modelCatalog: this._modelsFor(options.cliProfile),
    });
  }
}
