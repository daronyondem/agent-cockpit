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
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 146.36 139.16"><path fill="#29b5e8" fill-rule="evenodd" d="M134.81,60.1l-16.47,9.49L134.81,79a8.65,8.65,0,1,1-8.67,15l-29.51-17a8.68,8.68,0,0,1-4.33-7.75,8.48,8.48,0,0,1,.31-2,8.68,8.68,0,0,1,4-5.19l29.51-16.94A8.69,8.69,0,0,1,138,48.31,8.58,8.58,0,0,1,134.81,60.1Zm-15.59,46L89.72,89.13a8.72,8.72,0,0,0-13.06,7.48v33.9a8.69,8.69,0,0,0,17.37,0v-19L110.54,121a8.66,8.66,0,1,0,8.68-15Zm-34-33.16L72.92,85.09a2.44,2.44,0,0,1-1.54.65H67.77a2.51,2.51,0,0,1-1.54-.65L54,72.9a2.45,2.45,0,0,1-.64-1.52v-3.6A2.5,2.5,0,0,1,54,66.25L66.23,54.06a2.5,2.5,0,0,1,1.54-.64h3.61a2.45,2.45,0,0,1,1.54.64L85.18,66.25a2.49,2.49,0,0,1,.63,1.53v3.6A2.44,2.44,0,0,1,85.18,72.9Zm-9.8-3.38A2.59,2.59,0,0,0,74.73,68l-3.55-3.51a2.51,2.51,0,0,0-1.54-.64h-.13a2.46,2.46,0,0,0-1.53.64L64.43,68a2.51,2.51,0,0,0-.63,1.55v.13a2.41,2.41,0,0,0,.63,1.52L68,74.7a2.48,2.48,0,0,0,1.53.64h.13a2.51,2.51,0,0,0,1.54-.64l3.55-3.53a2.49,2.49,0,0,0,.65-1.52ZM19.93,33.08,49.44,50a8.73,8.73,0,0,0,13.07-7.49V8.64a8.69,8.69,0,0,0-17.37,0v19l-16.53-9.5a8.65,8.65,0,1,0-8.68,15ZM84.69,51.16a8.64,8.64,0,0,0,5-1.13l29.5-17a8.65,8.65,0,1,0-8.68-15L94,27.61v-19a8.69,8.69,0,0,0-17.37,0v33.9A8.66,8.66,0,0,0,84.69,51.16ZM54.48,88a8.58,8.58,0,0,0-5,1.13L19.93,106.06a8.66,8.66,0,1,0,8.68,15l16.53-9.49v19a8.69,8.69,0,0,0,17.37,0V96.61A8.65,8.65,0,0,0,54.48,88Zm-8-15.87a8.61,8.61,0,0,0-4-10L13,45.14A8.69,8.69,0,0,0,1.17,48.31,8.59,8.59,0,0,0,4.35,60.1l16.47,9.49L4.35,79A8.65,8.65,0,1,0,13,94l29.48-17A8.59,8.59,0,0,0,46.47,72.13Zm93.15-56.22H138.3v1.63h1.32c.61,0,1-.28,1-.8S140.26,15.91,139.62,15.91Zm-2.94-1.5h3c1.62,0,2.7.89,2.7,2.27a2.16,2.16,0,0,1-1.08,1.9l1.17,1.68v.34h-1.69L139.62,19H138.3V20.6h-1.62Zm8.3,3.22a5.48,5.48,0,0,0-5.58-5.83c-3.31,0-5.51,2.39-5.51,5.83,0,3.28,2.2,5.82,5.51,5.82A5.47,5.47,0,0,0,145,17.63Zm1.38,0c0,3.89-2.6,7.14-7,7.14s-6.89-3.28-6.89-7.14,2.57-7.14,6.89-7.14S146.36,13.73,146.36,17.63Z"/></svg>', models: [],
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
