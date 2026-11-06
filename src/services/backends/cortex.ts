import crypto from 'crypto';
import type { BackendMetadata, Message, SendMessageOptions, SendMessageResult, StreamEvent } from '../../types';
import { BaseBackendAdapter, type BackendCallOptions } from './base';
import { CortexSessions } from './cortexSessions';
import type { CortexRuntime } from './cortexRuntime';
import { CortexTurn } from './cortexTurn';
import { cortexModels } from './cortexModels';
import { CortexInputError, CortexMissingSessionError, cortexRuntimeError } from './cortexErrors';
import { buildNativeSessionRecovery, buildSessionRecoveryEvent, createRecoverySnapshot } from './sessionRecovery';
import { logger } from '../../utils/logger';

interface ActiveTurn { aborted: boolean; turn?: CortexTurn }
const log = logger.child({ module: 'cortex-code' });

/** Chat facade. Native goals, steering and processor execution remain gated. */
export class CortexCodeAdapter extends BaseBackendAdapter {
  private active = new Map<string, ActiveTurn>();
  private instructed = new WeakSet<CortexRuntime>();
  private idleTimer?: NodeJS.Timeout;
  stopping: Promise<void> = Promise.resolve();

  constructor(options: { workingDir?: string; sessions?: CortexSessions } = {}) {
    super(options);
    this.sessions = options.sessions || new CortexSessions();
    this.ensureIdleTimer();
  }
  private sessions: CortexSessions;

  private ensureIdleTimer(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      void this.sessions.evictIdle(10 * 60_000).catch(() => log.warn('Cortex idle cleanup failed'));
    }, 10 * 60_000);
    this.idleTimer.unref();
  }

  get metadata(): BackendMetadata {
    return { id: 'cortex-code', label: 'Cortex Code (CoCo)', icon: null, models: [],
      capabilities: { thinking: true, planMode: true, planRevision: true, agents: false,
        toolActivity: true, userQuestions: true, stdinInput: false, goals: false,
        oneShot: { restrictedText: false, toolEnabled: false, sequential: false } },
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
    if (this.active.has(id)) throw new CortexInputError('Cortex conversation is already active.');
    const owner: ActiveTurn = { aborted: false };
    this.active.set(id, owner);
    const abort = () => {
      owner.aborted = true;
      if (owner.turn) void owner.turn.abort();
      else if (this.active.get(id) === owner) void this.sessions.reset(id);
    };
    return { stream: this.stream(id, owner, message, options), abort,
      sendInput: (text, decisionId) => this.active.get(id) === owner && !owner.aborted
        && Boolean(decisionId && owner.turn?.input(text, decisionId)) };
  }

  private async *stream(id: string, owner: ActiveTurn, message: string, options: SendMessageOptions): AsyncGenerator<StreamEvent> {
    let runtime: CortexRuntime | undefined;
    let delegated = false;
    const current = () => !owner.aborted && this.active.get(id) === owner;
    const session = { profile: options.cliProfile!, workspaceId: options.workspaceId!, cwd: options.workingDir!,
      contextKey: crypto.createHash('sha256').update(options.systemPrompt).digest('hex'), mcpServers: options.mcpServers };
    try {
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
      owner.turn = new CortexTurn(runtime, { text, model: options.model, effort: options.effort,
        attachments: options.attachments, attachmentRoot: options.attachmentRoot, allowTools: true });
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

  onSessionReset(conversationId: string): void {
    const owner = this.active.get(conversationId);
    if (owner) { owner.aborted = true; void owner.turn?.abort(); }
    this.active.delete(conversationId);
    this.stopping = this.sessions.reset(conversationId).catch(() => log.warn('Cortex reset cleanup failed'));
  }

  shutdown(): void {
    clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    for (const owner of this.active.values()) { owner.aborted = true; void owner.turn?.abort(); }
    this.active.clear();
    // A later send recreates idle supervision after a CLI update.
    this.stopping = this.sessions.shutdown().catch(() => log.warn('Cortex shutdown cleanup failed'));
  }
}
