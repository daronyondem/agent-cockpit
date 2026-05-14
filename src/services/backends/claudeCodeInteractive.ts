import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  ClaudeCodeAdapter,
  CLAUDE_CODE_ICON,
  mcpServersToClaudeConfigJson,
  parseClaudeGoalFromJsonl,
  resolveClaudeCliRuntime,
  resolveClaudeProjectDirCandidates,
  sanitizeSystemPrompt,
  type ClaudeCliRuntime,
} from './claudeCode';
import { BaseBackendAdapter, type BackendCallOptions, type RunOneShotOptions } from './base';
import {
  createClaudeTranscriptEventMapperState,
  mapClaudeTranscriptEntryToStreamEvents,
} from './claudeTranscriptEvents';
import { ClaudeTranscriptTailer } from './claudeTranscriptTailer';
import { extractToolDetails } from './toolUtils';
import {
  ClaudeInteractivePtyController,
  type ClaudeInteractivePtyFactory,
  type PendingClaudeQuestion,
} from './claudeInteractivePty';
import {
  createClaudeInteractiveHookHarness,
  hookPayloadString,
  isClaudeInteractiveHookSupported,
  type ClaudeInteractiveHookEvent,
  type ClaudeInteractiveHookHarness,
} from './claudeInteractiveHooks';
import { ClaudeInteractiveSessionManager } from './claudeInteractiveSessionManager';
import type {
  BackendMetadata,
  CliToolUseBlock,
  CliProfile,
  EffortLevel,
  McpServerConfig,
  MemorySnapshot,
  Message,
  SendMessageOptions,
  SendMessageResult,
  StreamEvent,
  ThreadGoal,
} from '../../types';
import { logger } from '../../utils/logger';

interface ClaudeCodeInteractiveAdapterOptions {
  workingDir?: string;
  ptyFactory?: ClaudeInteractivePtyFactory;
  hookFactory?: () => Promise<ClaudeInteractiveHookHarness | null>;
  pollIntervalMs?: number;
  exitGraceMs?: number;
  sessionStartTimeoutMs?: number;
  promptReadyDelayMs?: number;
  promptEnterDelayMs?: number;
  stopHookTimeoutMs?: number;
  exitSettleMs?: number;
  finalTranscriptReadAttempts?: number;
  finalTranscriptReadIntervalMs?: number;
}

interface InteractiveStreamState {
  controller: ClaudeInteractivePtyController | null;
  aborted: boolean;
  promptSubmitted: boolean;
  pendingQuestion: PendingClaudeQuestion | null;
  queuedInputs: string[];
}

const log = logger.child({ module: 'claude-code-interactive' });
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_EXIT_GRACE_MS = 750;
const DEFAULT_SESSION_START_TIMEOUT_MS = 10_000;
const DEFAULT_PROMPT_READY_DELAY_MS = 300;
const DEFAULT_PROMPT_ENTER_DELAY_MS = 120;
const DEFAULT_STOP_HOOK_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_EXIT_SETTLE_MS = 1_000;
const DEFAULT_FINAL_TRANSCRIPT_READ_ATTEMPTS = 40;
const DEFAULT_FINAL_TRANSCRIPT_READ_INTERVAL_MS = 50;
const CLEAR_GOAL_TIMEOUT_MS = 30_000;

export class ClaudeCodeInteractiveAdapter extends BaseBackendAdapter {
  private readonly _delegate: ClaudeCodeAdapter;
  private readonly _sessionManager = new ClaudeInteractiveSessionManager();
  private readonly _ptyFactory?: ClaudeInteractivePtyFactory;
  private readonly _hookFactory?: () => Promise<ClaudeInteractiveHookHarness | null>;
  private readonly _pollIntervalMs: number;
  private readonly _exitGraceMs: number;
  private readonly _sessionStartTimeoutMs: number;
  private readonly _promptReadyDelayMs: number;
  private readonly _promptEnterDelayMs: number;
  private readonly _stopHookTimeoutMs: number;
  private readonly _exitSettleMs: number;
  private readonly _finalTranscriptReadAttempts: number;
  private readonly _finalTranscriptReadIntervalMs: number;

  constructor(options: ClaudeCodeInteractiveAdapterOptions = {}) {
    super(options);
    this.workingDir = options.workingDir || path.resolve(os.homedir(), '.openclaw', 'workspace');
    this._delegate = new ClaudeCodeAdapter({ workingDir: this.workingDir || undefined });
    this._ptyFactory = options.ptyFactory;
    this._hookFactory = options.hookFactory;
    this._pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
    this._exitGraceMs = options.exitGraceMs || DEFAULT_EXIT_GRACE_MS;
    this._sessionStartTimeoutMs = options.sessionStartTimeoutMs ?? DEFAULT_SESSION_START_TIMEOUT_MS;
    this._promptReadyDelayMs = options.promptReadyDelayMs ?? DEFAULT_PROMPT_READY_DELAY_MS;
    this._promptEnterDelayMs = options.promptEnterDelayMs ?? DEFAULT_PROMPT_ENTER_DELAY_MS;
    this._stopHookTimeoutMs = options.stopHookTimeoutMs ?? DEFAULT_STOP_HOOK_TIMEOUT_MS;
    this._exitSettleMs = options.exitSettleMs ?? DEFAULT_EXIT_SETTLE_MS;
    this._finalTranscriptReadAttempts = options.finalTranscriptReadAttempts ?? DEFAULT_FINAL_TRANSCRIPT_READ_ATTEMPTS;
    this._finalTranscriptReadIntervalMs = options.finalTranscriptReadIntervalMs ?? DEFAULT_FINAL_TRANSCRIPT_READ_INTERVAL_MS;
  }

  get metadata(): BackendMetadata {
    return {
      ...this._delegate.metadata,
      id: 'claude-code-interactive',
      label: 'Claude Code Interactive',
      icon: CLAUDE_CODE_ICON,
      capabilities: {
        ...this._delegate.metadata.capabilities,
        stdinInput: true,
        goals: {
          set: true,
          clear: true,
          pause: false,
          resume: false,
          status: 'transcript',
        },
      },
      resumeCapabilities: {
        activeTurnResume: 'unsupported',
        activeTurnResumeReason: 'Claude Code Interactive is controlled through a hidden local PTY; Agent Cockpit can resume the session on a later turn, but it cannot safely reattach to an already-running terminal UI after a server restart.',
        sessionResume: 'supported',
        sessionResumeReason: 'Follow-up turns reuse the cockpit session id with Claude Code --resume, while transcript watching reconstructs events for the new turn.',
      },
    };
  }

  sendMessage(message: string, options: SendMessageOptions = {} as SendMessageOptions): SendMessageResult {
    const state: InteractiveStreamState = {
      controller: null,
      aborted: false,
      promptSubmitted: false,
      pendingQuestion: null,
      queuedInputs: [],
    };
    const stream = this._createInteractiveStream(message, options, state);
    const abort = () => {
      state.aborted = true;
      state.controller?.stopTurn();
    };
    const sendInput = (text: string) => {
      const value = text.trim();
      if (!value) return;
      if (!state.controller || !state.promptSubmitted) {
        state.queuedInputs.push(value);
        return;
      }
      state.controller.sendInput(value, state.pendingQuestion);
    };
    return { stream, abort, sendInput };
  }

  async getGoal(options: SendMessageOptions): Promise<ThreadGoal | null> {
    const runtime = resolveClaudeCliRuntime(options.cliProfile);
    if (!options.sessionId) return null;
    const cwd = options.workingDir || this.workingDir || process.cwd();
    for (const projectDir of resolveClaudeProjectDirCandidates(cwd, runtime.configDir)) {
      try {
        const content = await fs.readFile(path.join(projectDir, `${options.sessionId}.jsonl`), 'utf8');
        return parseClaudeGoalFromJsonl(content, options.sessionId, 'claude-code-interactive');
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
    }
    return null;
  }

  setGoalObjective(objective: string, options: SendMessageOptions = {} as SendMessageOptions): SendMessageResult {
    return this.sendMessage(`/goal ${objective.trim()}`, options);
  }

  resumeGoal(): SendMessageResult {
    throw new Error('Goal resume is not supported by Claude Code Interactive');
  }

  async pauseGoal(): Promise<ThreadGoal | null> {
    throw new Error('Goal pause is not supported by Claude Code Interactive');
  }

  async clearGoal(options: SendMessageOptions): Promise<{ cleared: boolean; threadId?: string | null; sessionId?: string | null }> {
    const result = this.sendMessage('/goal clear', { ...options, isNewSession: false });
    const iterator = result.stream[Symbol.asyncIterator]();
    const deadline = Date.now() + CLEAR_GOAL_TIMEOUT_MS;
    let terminalError: string | null = null;
    let cleared = false;

    try {
      while (true) {
        const remainingMs = Math.max(1, deadline - Date.now());
        const next = await Promise.race([
          iterator.next().then(value => ({ type: 'event' as const, value })),
          sleep(remainingMs).then(() => ({ type: 'timeout' as const })),
        ]);
        if (next.type === 'timeout') {
          result.abort();
          throw new Error('Claude Code Interactive goal clear timed out');
        }
        if (next.value.done) break;

        const event = next.value.value;
        if (event.type === 'error' && event.terminal !== false) {
          terminalError = event.error;
        } else if (event.type === 'goal_cleared') {
          cleared = true;
          break;
        }
      }
    } finally {
      await iterator.return?.(undefined);
    }

    if (terminalError) throw new Error(terminalError);
    if (!cleared) throw new Error('Claude Code Interactive goal clear did not confirm completion');
    return { cleared, sessionId: options.sessionId || null };
  }

  async generateSummary(
    messages: Pick<Message, 'role' | 'content'>[],
    fallback: string,
    options: BackendCallOptions = {},
  ): Promise<string> {
    return this._delegate.generateSummary(messages, fallback, options);
  }

  async generateTitle(userMessage: string, fallback: string, options: BackendCallOptions = {}): Promise<string> {
    return this._delegate.generateTitle(userMessage, fallback, options);
  }

  async runOneShot(prompt: string, options: RunOneShotOptions = {}): Promise<string> {
    return this._delegate.runOneShot(prompt, options);
  }

  async extractMemory(workspacePath: string, options: BackendCallOptions = {}): Promise<MemorySnapshot | null> {
    return this._delegate.extractMemory(workspacePath, options);
  }

  getMemoryDir(workspacePath: string, options: BackendCallOptions = {}): string | null {
    return this._delegate.getMemoryDir(workspacePath, options);
  }

  shutdown(): void {
    this._sessionManager.shutdown();
  }

  onSessionReset(conversationId: string): void {
    this._sessionManager.kill(conversationId);
  }

  private async *_createInteractiveStream(
    message: string,
    options: SendMessageOptions,
    state: InteractiveStreamState,
  ): AsyncGenerator<StreamEvent> {
    const runtime = resolveClaudeCliRuntime(options.cliProfile);
    const cwd = options.workingDir || this.workingDir || process.cwd();
    const hookHarness = await this._createHookHarness();
    const args = buildInteractiveClaudeArgs(message, options, runtime, this.metadata.models, hookHarness?.settingsJson || null);
    const controller = new ClaudeInteractivePtyController({
      command: runtime.command,
      args,
      cwd,
      env: hookHarness ? { ...runtime.env, ...hookHarness.env } : runtime.env,
      ...(this._ptyFactory ? { factory: this._ptyFactory } : {}),
    });
    const tailer = new ClaudeTranscriptTailer({
      workspacePath: cwd,
      configDir: runtime.configDir,
      sessionId: options.sessionId,
      startAtEnd: true,
    });
    const mapperState = createClaudeTranscriptEventMapperState();
    const synthesizedToolIds = new Set<string>();
    const synthesizedQuestionSignatures = new Set<string>();
    let emittedDone = false;
    let shouldYieldDone = false;
    let emittedAssistantText = false;
    let hookIterator: AsyncIterator<ClaudeInteractiveHookEvent> | null = hookHarness
      ? hookHarness.events[Symbol.asyncIterator]()
      : null;
    let hookNext: Promise<{ type: 'hook'; result: IteratorResult<ClaudeInteractiveHookEvent> }> | null = hookIterator
      ? hookIterator.next().then(result => ({ type: 'hook' as const, result }))
      : null;
    let stopWait: Promise<ClaudeInteractiveHookEvent | null> | null = hookHarness
      ? hookHarness.waitForStop(this._stopHookTimeoutMs).catch(() => null)
      : null;

    const mapEntries = (entries: Awaited<ReturnType<ClaudeTranscriptTailer['readAvailable']>>): StreamEvent[] => {
      const events = entries.flatMap(entry => mapClaudeTranscriptEntryToStreamEvents(entry, mapperState, {
        sessionId: options.sessionId,
        backend: 'claude-code-interactive',
      }));
      return events.filter((event) => {
        if (event.type !== 'tool_activity' || !event.isQuestion) return true;
        if (event.id && synthesizedToolIds.has(event.id)) return false;
        const signature = questionToolSignature(event);
        return !signature || !synthesizedQuestionSignatures.has(signature);
      });
    };

    try {
      controller.start();
      state.controller = controller;
      this._sessionManager.attach(options.conversationId, controller);
      yield { type: 'backend_runtime', processId: controller.pid };

      if (hookHarness) {
        try {
          await hookHarness.waitForSessionStart(this._sessionStartTimeoutMs);
        } catch (err: unknown) {
          log.warn('Claude Code Interactive SessionStart hook did not arrive before prompt fallback', { error: err });
        }
      }

      if (state.aborted) {
        controller.stopTurn();
        emittedDone = true;
        return;
      } else {
        if (this._promptReadyDelayMs > 0) {
          await sleep(this._promptReadyDelayMs);
        }
        controller.sendPrompt(message, { enterDelayMs: this._promptEnterDelayMs });
        state.promptSubmitted = true;
        for (const queued of state.queuedInputs.splice(0)) {
          controller.sendInput(queued, state.pendingQuestion);
        }
      }

      while (!emittedDone) {
        if (state.aborted) {
          controller.stopTurn();
        }

        const entries = await tailer.readAvailable();
        for (const event of mapEntries(entries)) {
          updatePendingQuestion(state, event);
          if (event.type === 'done') {
            emittedDone = true;
            shouldYieldDone = true;
            break;
          }
          if (event.type === 'text' && event.content) emittedAssistantText = true;
          yield event;
          if (emittedDone) break;
        }
        if (emittedDone) break;

        const raceItems: Array<Promise<
          | { type: 'sleep' }
          | { type: 'stop'; event: ClaudeInteractiveHookEvent | null }
          | { type: 'hook'; result: IteratorResult<ClaudeInteractiveHookEvent> }
        >> = [
          sleep(this._pollIntervalMs).then(() => ({ type: 'sleep' as const })),
        ];
        if (stopWait) raceItems.push(stopWait.then(event => ({ type: 'stop' as const, event })));
        if (hookNext) raceItems.push(hookNext);

        const raced = await Promise.race(raceItems);
        if (raced.type === 'hook') {
          if (raced.result.done) {
            hookIterator = null;
            hookNext = null;
          } else {
            hookNext = hookIterator
              ? hookIterator.next().then(result => ({ type: 'hook' as const, result }))
              : null;
            const hookEvents = mapHookEventToStreamEvents(
              raced.result.value,
              synthesizedToolIds,
              synthesizedQuestionSignatures,
            );
            for (const event of hookEvents) {
              updatePendingQuestion(state, event);
              yield event;
            }
            continue;
          }
        } else if (raced.type === 'stop') {
          stopWait = null;
          if (raced.event) {
            const transcriptPath = hookPayloadString(raced.event, 'transcript_path');
            if (transcriptPath) tailer.setTranscriptPath(transcriptPath);
            const finalEntries = [
              ...await tailer.flushBufferedLine(),
              ...await tailer.readUntilQuiet({
                maxAttempts: this._finalTranscriptReadAttempts,
                intervalMs: this._finalTranscriptReadIntervalMs,
              }),
            ];
            let sawDone = false;
            for (const event of mapEntries(finalEntries)) {
              if (event.type === 'done') {
                sawDone = true;
                continue;
              }
              updatePendingQuestion(state, event);
              if (event.type === 'text' && event.content) emittedAssistantText = true;
              yield event;
            }
            const fallbackText = hookPayloadString(raced.event, 'last_assistant_message');
            if (!emittedAssistantText && fallbackText) {
              emittedAssistantText = true;
              yield { type: 'text', content: fallbackText };
            }
            if (!emittedDone || sawDone) {
              emittedDone = true;
              shouldYieldDone = true;
            }
            break;
          }
        }

        if (controller.exited) {
          const finalEntries = await tailer.flushBufferedLine();
          for (const event of mapEntries(finalEntries)) {
            updatePendingQuestion(state, event);
            if (event.type === 'done') {
              emittedDone = true;
              shouldYieldDone = true;
              break;
            }
            if (event.type === 'text' && event.content) emittedAssistantText = true;
            yield event;
          }
          if (!emittedDone && !state.aborted) {
            const exitCode = controller.exitEvent?.exitCode;
            if (typeof exitCode === 'number' && exitCode !== 0) {
              yield { type: 'error', error: `Claude Code Interactive exited with code ${exitCode}` };
              emittedDone = true;
            }
          }
          break;
        }

      }
    } catch (err: unknown) {
      log.error('Claude Code Interactive stream failed', { error: err });
      yield { type: 'error', error: (err as Error).message || String(err) };
      emittedDone = true;
    } finally {
      this._sessionManager.detach(options.conversationId, controller);
      if (!controller.exited) {
        controller.requestExit();
        const exited = await waitForExit(controller, this._exitGraceMs);
        if (!exited) controller.kill();
      }
      if (this._exitSettleMs > 0) {
        await sleep(this._exitSettleMs);
      }
      state.controller = null;
      state.promptSubmitted = false;
      try {
        await hookHarness?.close();
      } catch (err: unknown) {
        log.warn('Claude Code Interactive hook harness cleanup failed', { error: err });
      }
      if (shouldYieldDone || (!emittedDone && !state.aborted)) {
        yield { type: 'done' };
      }
    }
  }

  private async _createHookHarness(): Promise<ClaudeInteractiveHookHarness | null> {
    if (this._hookFactory) return this._hookFactory();
    if (!isClaudeInteractiveHookSupported()) {
      log.warn('Claude Code Interactive hooks are disabled on this platform');
      return null;
    }
    try {
      return await createClaudeInteractiveHookHarness();
    } catch (err: unknown) {
      log.warn('Claude Code Interactive hook harness could not be created; falling back to transcript polling', { error: err });
      return null;
    }
  }
}

function mapHookEventToStreamEvents(
  event: ClaudeInteractiveHookEvent,
  synthesizedToolIds: Set<string>,
  synthesizedQuestionSignatures: Set<string>,
): StreamEvent[] {
  if (event.event !== 'PreToolUse') return [];
  const toolName = hookToolName(event);
  if (toolName !== 'AskUserQuestion') return [];
  const input = hookToolInput(event);
  const id = hookToolUseId(event) || `hook-question-${Date.now()}`;
  const detail = extractToolDetails({
    type: 'tool_use',
    name: toolName,
    id,
    input,
  } as CliToolUseBlock);
  synthesizedToolIds.add(id);
  const signature = questionToolSignature(detail);
  if (signature) synthesizedQuestionSignatures.add(signature);
  return [{ type: 'tool_activity', ...detail }];
}

function hookToolName(event: ClaudeInteractiveHookEvent): string | null {
  return hookPayloadString(event, 'tool_name')
    || hookPayloadString(event, 'toolName')
    || hookPayloadString(event, 'name')
    || hookPayloadString(event, 'tool');
}

function hookToolUseId(event: ClaudeInteractiveHookEvent): string | null {
  return hookPayloadString(event, 'tool_use_id')
    || hookPayloadString(event, 'toolUseId')
    || hookPayloadString(event, 'id');
}

function hookToolInput(event: ClaudeInteractiveHookEvent): Record<string, unknown> {
  const payload = event.payload;
  const value = payload.tool_input ?? payload.toolInput ?? payload.input;
  if (isPlainRecord(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return isPlainRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function questionToolSignature(event: { tool?: string; questions?: unknown }): string | null {
  if (event.tool !== 'AskUserQuestion') return null;
  try {
    return JSON.stringify(event.questions || []);
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function buildInteractiveClaudeArgs(
  _message: string,
  options: SendMessageOptions,
  runtime: ClaudeCliRuntime,
  models: BackendMetadata['models'],
  settingsJson?: string | null,
): string[] {
  const args: string[] = [
    '--permission-mode', 'bypassPermissions',
  ];

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.effort && options.model) {
    const modelOption = models?.find((candidate) => candidate.id === options.model);
    if (modelOption?.supportedEffortLevels?.includes(options.effort as EffortLevel)) {
      args.push('--effort', options.effort);
    }
  }

  if (options.isNewSession) {
    args.push('--session-id', options.sessionId);
    const cleanPrompt = sanitizeSystemPrompt(options.systemPrompt);
    if (cleanPrompt) {
      args.push('--append-system-prompt', cleanPrompt);
    }
  } else {
    args.push('--resume', options.sessionId);
  }

  if (Array.isArray(options.mcpServers) && options.mcpServers.length > 0) {
    args.push('--mcp-config', mcpServersToClaudeConfigJson(options.mcpServers as McpServerConfig[]));
  }

  if (runtime.configDir) {
    // CLAUDE_CONFIG_DIR is already in env; this branch exists to keep the
    // runtime parameter intentionally used in this builder.
  }

  if (settingsJson) {
    args.push('--settings', settingsJson);
  }

  return args;
}

function updatePendingQuestion(state: InteractiveStreamState, event: StreamEvent): void {
  if (event.type === 'tool_activity' && event.isQuestion) {
    const firstQuestion = event.questions?.[0];
    state.pendingQuestion = {
      id: event.id,
      options: firstQuestion?.options || [],
    };
    return;
  }
  if (event.type === 'tool_outcomes' && state.pendingQuestion?.id) {
    if (event.outcomes.some((outcome) => outcome.toolUseId === state.pendingQuestion?.id)) {
      state.pendingQuestion = null;
    }
  } else if (event.type === 'turn_boundary') {
    state.pendingQuestion = null;
  }
}

async function waitForExit(controller: ClaudeInteractivePtyController, timeoutMs: number): Promise<boolean> {
  if (controller.exited) return true;
  return Promise.race([
    controller.exitPromise.then(() => true),
    sleep(timeoutMs).then(() => false),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
