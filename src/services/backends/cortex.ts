import crypto from 'crypto';
import type { BackendMetadata, Message, SendMessageOptions, SendMessageResult, StreamEvent } from '../../types';
import { BaseBackendAdapter, type BackendCallOptions, type RunOneShotOptions } from './base';
import { CortexSessions } from './cortexSessions';
import type { CortexRuntime } from './cortexRuntime';
import { CortexTurn } from './cortexTurn';
import { cortexModels } from './cortexModels';
import { CortexInputError, CortexMissingSessionError, cortexRuntimeError } from './cortexErrors';
import { buildNativeSessionRecovery, buildSessionRecoveryEvent, createRecoverySnapshot } from './sessionRecovery';
import { logger } from '../../utils/logger';
import { CortexShots } from './cortexShots';
import { CortexRestrictedShots } from './cortexRestricted';
import { cortexRestrictedPlatform } from './cortexRestrictedPolicy';

interface ActiveTurn { aborted: boolean; turn?: CortexTurn; draining?: Promise<void> }
const log = logger.child({ module: 'cortex-code' });
const CHAT_IDLE_TIMEOUT_MS = 60 * 60_000;

/** Chat and processor facade; native goals and steering stay gated. */
export class CortexCodeAdapter extends BaseBackendAdapter {
  private active = new Map<string, ActiveTurn>();
  private drains = new Set<Promise<void>>();
  private instructed = new WeakSet<CortexRuntime>();
  private idleTimer?: NodeJS.Timeout;
  private restricted = new CortexRestrictedShots();
  stopping: Promise<void> = Promise.resolve();

  constructor(options: { workingDir?: string; sessions?: CortexSessions } = {}) {
    super(options);
    this.sessions = options.sessions || new CortexSessions();
    this.shots = new CortexShots(this.sessions, this.workingDir);
    this.ensureIdleTimer();
  }
  private sessions: CortexSessions;
  private shots: CortexShots;

  get allowAutomaticOneShotRetry(): boolean { return false; }
  get oneShotImageFormat(): 'png' { return 'png'; }
  get decisionsRequireActiveTurn(): boolean { return true; }

  private ensureIdleTimer(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      void this.sessions.evictIdle(10 * 60_000).catch(() => log.warn('Cortex idle cleanup failed'));
    }, 10 * 60_000);
    this.idleTimer.unref();
  }

  get metadata(): BackendMetadata {
    return { id: 'cortex-code', label: 'Cortex Code (CoCo)',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><rect width="28" height="28" rx="7" fill="#1679a7"/><path d="M14 5v18M6.2 9.5l15.6 9M6.2 18.5l15.6-9M11 7l3 3 3-3M11 21l3-3 3 3" stroke="white" stroke-width="2" fill="none"/></svg>', models: [],
      capabilities: { thinking: true, planMode: true, planRevision: true, agents: false,
        toolActivity: true, userQuestions: true, stdinInput: false, goals: false,
        oneShot: { restrictedText: cortexRestrictedPlatform(), toolEnabled: true, sequential: true },
        oneShotMediaInput: { image: ['explicit-attachment'] } },
      resumeCapabilities: { activeTurnResume: 'unsupported',
        activeTurnResumeReason: 'Interrupted Cortex work is never resent automatically.',
        sessionResume: 'supported', sessionResumeReason: 'Loads the saved native session on the next user turn.' } };
  }

  async getMetadata(options?: BackendCallOptions): Promise<BackendMetadata> {
    if (!options?.cliProfile) return this.metadata;
    try {
      const result = await this.sessions.discover({ profile: options.cliProfile,
        workspaceId: `metadata:${options.cliProfile.id}`, cwd: this.workingDir || process.cwd() });
      return { ...this.metadata, models: cortexModels(result.configOptions, result.version) };
    } catch { return this.metadata; } // No stale catalog or native error text crosses profiles.
  }

  sendMessage(message: string, options?: SendMessageOptions): SendMessageResult {
    this.ensureIdleTimer();
    if (!options?.cliProfile || !options.workspaceId || !options.workingDir) {
      throw new CortexInputError('Cortex chat requires a profile, workspace identity and working directory.');
    }
    const id = options.conversationId || options.sessionId;
    const previous = this.active.get(id);
    if (previous && !previous.aborted) throw new CortexInputError('Cortex conversation is already active.');
    // HTTP Stop may finish before its stream consumer unwinds. Drain that lease
    // independently; the next explicit turn must not depend on consumer progress.
    const draining = previous ? this.drainAbortedOwner(id, previous) : undefined;
    const owner: ActiveTurn = { aborted: false, draining };
    this.active.set(id, owner);
    const abort = () => {
      if (this.active.get(id) !== owner) return;
      owner.aborted = true;
      if (owner.turn) void owner.turn.abort();
      else void this.drainAbortedOwner(id, owner);
    };
    return { stream: this.stream(id, owner, message, options, draining), abort,
      sendInput: (text, decisionId) => this.active.get(id) === owner && !owner.aborted
        && Boolean(decisionId && owner.turn?.input(text, decisionId)) };
  }

  private drainAbortedOwner(id: string, owner: ActiveTurn): Promise<void> {
    const reset = this.sessions.reset(id);
    this.drains.add(reset);
    void reset.finally(() => { this.drains.delete(reset); }).catch(() => {});
    owner.draining = owner.draining ? Promise.all([owner.draining, reset]).then(() => {}) : reset;
    void owner.draining.catch(() => {}); // A later stream reports cleanup failures.
    return owner.draining;
  }

  private async *stream(id: string, owner: ActiveTurn, message: string, options: SendMessageOptions, draining?: Promise<void>): AsyncGenerator<StreamEvent> {
    let runtime: CortexRuntime | undefined;
    let delegated = false;
    const current = () => !owner.aborted && this.active.get(id) === owner;
    const session = { profile: options.cliProfile!, workspaceId: options.workspaceId!, cwd: options.workingDir!,
      contextKey: crypto.createHash('sha256').update(options.systemPrompt).digest('hex'), mcpServers: options.mcpServers };
    try {
      await draining;
      if (!current()) return;
      let recovery: ReturnType<typeof buildNativeSessionRecovery> | undefined;
      try {
        runtime = await this.sessions.acquire(id, { ...session, sessionId: options.isNewSession ? undefined : options.externalSessionId || undefined });
      } catch (error) {
        if (!(error instanceof CortexMissingSessionError) || !options.externalSessionId || !current()) throw error;
        const reason = 'Saved Cortex session was not found';
        const snapshot = await createRecoverySnapshot(options, { previousNativeSessionId: options.externalSessionId, reason });
        if (!current()) return;
        runtime = await this.sessions.acquire(id, session);
        recovery = buildNativeSessionRecovery({ backend: 'cortex-code', previousNativeSessionId: options.externalSessionId,
          newNativeSessionId: runtime.sessionId, reason, snapshot, currentPrompt: message });
      }
      if (!current()) return;
      yield { type: 'external_session', sessionId: runtime.sessionId! };
      yield { type: 'backend_runtime', externalSessionId: runtime.sessionId!, processId: runtime.client.process.pid };
      if (recovery) yield buildSessionRecoveryEvent(recovery.metadata);
      if (!current()) return;
      let text = recovery?.prompt || message;
      if (!this.instructed.has(runtime) && options.systemPrompt) {
        text = `[Current Agent Cockpit instructions]\n${options.systemPrompt}\n[/Current Agent Cockpit instructions]\n\n${text}`;
      }
      // No fixed deadline: Stop/reset/shutdown own chat cancellation. An hour
      // without native activity stops a hung runtime; pending decisions do not count.
      owner.turn = new CortexTurn(runtime, { text, model: options.model, effort: options.effort,
        attachments: options.attachments, attachmentRoot: options.attachmentRoot, allowTools: true,
        timeoutMs: 0, idleTimeoutMs: CHAT_IDLE_TIMEOUT_MS });
      delegated = true;
      yield* owner.turn.stream();
    } catch (error) {
      yield owner.aborted ? { type: 'error', error: 'Cortex turn cancelled', source: 'abort' } : cortexRuntimeError(error);
    } finally {
      if (runtime) {
        if (owner.turn?.didPrompt) this.instructed.add(runtime);
        this.sessions.release(id, runtime);
      }
      if (this.active.get(id) === owner) this.active.delete(id);
      if (!delegated) yield { type: 'done' };
    }
  }

  async generateSummary(_messages: Pick<Message, 'role' | 'content'>[], fallback: string): Promise<string> { return fallback; }

  async runOneShot(prompt: string, options: RunOneShotOptions = {}): Promise<string> {
    return (await this.runSessionShot([prompt], options))[0];
  }

  runSessionShot(prompts: string[], options: RunOneShotOptions = {}): Promise<string[]> {
    return options.allowTools === true ? this.shots.run(prompts, options) : this.restricted.run(prompts, options);
  }

  onSessionReset(conversationId: string): void {
    const owner = this.active.get(conversationId);
    if (owner) { owner.aborted = true; void owner.turn?.abort(); }
    this.active.delete(conversationId);
    this.stopping = Promise.all([this.stopping, owner?.draining, this.sessions.reset(conversationId)])
      .then(() => {}).catch(() => log.warn('Cortex reset cleanup failed'));
  }

  shutdown(): Promise<void> {
    clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    for (const owner of this.active.values()) { owner.aborted = true; void owner.turn?.abort(); }
    this.active.clear();
    // A later send recreates idle supervision after a CLI update.
    this.stopping = Promise.allSettled([this.stopping, this.shots.shutdown(), this.restricted.shutdown(), this.sessions.shutdown(), ...this.drains]).then(results => {
      if (results.some(result => result.status === 'rejected')) log.warn('Cortex shutdown cleanup failed');
    });
    return this.stopping;
  }
}
