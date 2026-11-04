import type { CopilotSession, SessionEvent } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import type { SendMessageOptions, SendMessageResult, StreamEvent } from '../../types';
import { logger } from '../../utils/logger';
import { resolveCopilotCliRuntime, resolveCopilotWorkingDir } from './copilotRuntime';
import { startCopilotSdkRuntime, type CopilotSdkRuntime } from './copilotSdkRuntime';
import { copilotSessionConfig, composePrompt } from './copilotSessionConfig';
import { createCopilotSdkEventState, reduceCopilotSdkEvent } from './copilotSdkEvents';
import { copilotTurnUsage, readCopilotUsageBaseline } from './copilotUsage';
import { buildNativeSessionRecovery, buildSessionRecoveryEvent, createRecoverySnapshot, isMissingNativeSessionError } from './sessionRecovery';

const log = logger.child({ module: 'copilot-conversations' });
interface ConversationTurn {
  key: string;
  controller: AbortController;
  aborted: boolean;
  predecessor?: Promise<void>;
  startup?: Promise<CopilotSdkRuntime>;
  runtime?: CopilotSdkRuntime;
  cleanup?: Promise<void>;
  wake?: () => void;
}

/** One owned runtime per active conversation; persisted sessions survive process cleanup. */
export class CopilotConversations {
  private turns = new Map<string, ConversationTurn>();
  private resets = new Map<string, Promise<void>>();
  private closing: Promise<void> | null = null;
  private closed = false;
  private readonly startRuntime: typeof startCopilotSdkRuntime;
  private readonly requestTimeoutMs: number;

  constructor(private options: { workingDir?: string; startRuntime?: typeof startCopilotSdkRuntime; requestTimeoutMs?: number } = {}) {
    this.startRuntime = options.startRuntime || startCopilotSdkRuntime;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  sendMessage(message: string, options: SendMessageOptions): SendMessageResult {
    const key = options.conversationId ? `conversation:${options.conversationId}` : `session:${options.sessionId}`;
    const previous = this.turns.get(key);
    const rejection = this.closed || this.closing || this.resets.has(key) ? 'Copilot is shutting down or resetting.'
      : previous && !previous.controller.signal.aborted ? 'Copilot already has an active turn for this conversation.' : null;
    if (rejection) return { stream: this.rejected(rejection), abort: () => {}, sendInput: () => {} };
    const turn: ConversationTurn = { key, controller: new AbortController(), aborted: false, predecessor: previous ? this.stop(previous) : undefined };
    this.turns.set(key, turn);
    const stream = this.stream(message, options, turn);
    const close = stream.return.bind(stream), fail = stream.throw.bind(stream);
    // Generator finally blocks do not run when return/throw precedes first next.
    stream.return = async value => { await this.cancel(turn); return close(value); };
    stream.throw = async error => { await this.cancel(turn); return fail(error); };
    return { stream, sendInput: () => {}, abort: () => {
      void this.cancel(turn).catch(error => log.warn('Copilot cancellation cleanup failed', { error: String(error) }));
    } };
  }

  onSessionReset(conversationId: string): Promise<void> {
    const key = `conversation:${conversationId}`;
    const existing = this.resets.get(key);
    if (existing) return existing;
    const turn = this.turns.get(key);
    const reset = (turn ? this.cancel(turn) : Promise.resolve()).finally(() => this.resets.delete(key));
    this.resets.set(key, reset);
    return reset;
  }

  shutdown(options: { permanent?: boolean } = {}): Promise<void> {
    if (options.permanent) this.closed = true;
    if (this.closing) return this.closing;
    this.closing = Promise.allSettled([...this.turns.values()].map(turn => this.cancel(turn)))
      .then(results => {
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Copilot shutdown cleanup failed.');
      }).finally(() => { this.closing = null; });
    return this.closing;
  }

  private async *rejected(error: string): AsyncGenerator<StreamEvent> {
    yield { type: 'error', error }; yield { type: 'done' };
  }

  private cancel(turn: ConversationTurn): Promise<void> {
    turn.aborted = true;
    return this.stop(turn);
  }

  private stop(turn: ConversationTurn): Promise<void> {
    if (turn.cleanup) return turn.cleanup;
    turn.controller.abort();
    turn.wake?.();
    turn.cleanup = (async () => {
      await turn.predecessor;
      // A factory that ignores cancellation must still be drained on late success.
      const runtime = await turn.startup?.catch(() => undefined);
      await runtime?.stop();
      if (this.turns.get(turn.key) === turn) this.turns.delete(turn.key);
    })();
    return turn.cleanup;
  }

  private wait<T>(pending: Promise<T>, turn: ConversationTurn): Promise<T> {
    const signal = turn.controller.signal;
    let abort!: () => void;
    let timer: NodeJS.Timeout;
    return Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('Copilot turn aborted.'));
        timer = setTimeout(() => reject(new Error('Copilot session request timed out.')), this.requestTimeoutMs);
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      }),
      ...(turn.runtime ? [turn.runtime.closed.then(error => { throw error; })] : []),
    ]).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort); });
  }

  private async *stream(message: string, options: SendMessageOptions, turn: ConversationTurn): AsyncGenerator<StreamEvent> {
    let accepting = false;
    try {
      await this.wait(turn.predecessor || Promise.resolve(), turn);
      const workingDir = resolveCopilotWorkingDir(options.workingDir || this.options.workingDir);
      const runtime = resolveCopilotCliRuntime(options.cliProfile);
      const emptyBaseline = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
      let baseline = !options.isNewSession && options.externalSessionId
        ? await this.wait(readCopilotUsageBaseline(options.externalSessionId, runtime.env), turn)
        : emptyBaseline;
      turn.controller.signal.throwIfAborted();
      turn.startup = this.startRuntime(runtime, workingDir, { abortSignal: turn.controller.signal });
      turn.runtime = await this.wait(turn.startup, turn);
      yield { type: 'backend_runtime', processId: turn.runtime.process.pid ?? null };
      turn.controller.signal.throwIfAborted();
      const queued: StreamEvent[] = [];
      let state = createCopilotSdkEventState();
      let complete = false;
      let admitted = false;
      const notify = () => { turn.wake?.(); };
      const finish = (error?: string, source?: 'transport') => {
        if (complete || !accepting || turn.controller.signal.aborted) return;
        if (error) queued.push({ type: 'error', error, ...(source ? { source } : {}) });
        complete = true; notify();
      };
      const onEvent = (event: SessionEvent) => {
        if (!accepting || complete || turn.controller.signal.aborted) return;
        const projected = reduceCopilotSdkEvent(state, event);
        state = projected.state;
        queued.push(...projected.events);
        if (state.error || (admitted && state.idle)) finish();
        notify();
      };
      accepting = true;
      void turn.runtime.closed.then(error => finish(error.message, 'transport'));
      const config = { ...copilotSessionConfig(options, runtime.env, workingDir), onEvent };
      let session: CopilotSession;
      let prompt = composePrompt(message, options.systemPrompt, options.isNewSession);
      if (!options.isNewSession && options.externalSessionId) {
        try {
          session = await this.wait(turn.runtime.client.resumeSession(options.externalSessionId, { ...config, continuePendingWork: false }), turn);
        } catch (error) {
          if (turn.controller.signal.aborted || state.hasOutput || !isMissingNativeSessionError(String(error))) throw error;
          let snapshot = null;
          try { snapshot = await this.wait(createRecoverySnapshot(options, { previousNativeSessionId: options.externalSessionId, reason: String(error) }), turn); }
          catch (snapshotError) { log.warn('Cannot create Copilot recovery snapshot', { error: String(snapshotError) }); }
          turn.controller.signal.throwIfAborted();
          const recovery = buildNativeSessionRecovery({ backend: 'copilot', previousNativeSessionId: options.externalSessionId,
            reason: String(error), snapshot, currentPrompt: message });
          yield buildSessionRecoveryEvent(recovery.metadata);
          turn.controller.signal.throwIfAborted();
          state = createCopilotSdkEventState(); queued.length = 0; complete = false; baseline = emptyBaseline;
          session = await this.wait(turn.runtime.client.createSession({ ...config, trustWorkingDirectory: 'session' }), turn);
          prompt = composePrompt(recovery.prompt, options.systemPrompt, true);
        }
      } else session = await this.wait(turn.runtime.client.createSession({ ...config, trustWorkingDirectory: 'session' }), turn);
      turn.controller.signal.throwIfAborted();
      if (complete) throw new Error(state.error || 'Copilot session closed before prompt submission.');
      yield { type: 'external_session', sessionId: session.sessionId };
      turn.controller.signal.throwIfAborted();
      yield { type: 'backend_runtime', externalSessionId: session.sessionId, processId: turn.runtime.process.pid ?? null };
      turn.controller.signal.throwIfAborted();
      // Startup/resume snapshots describe history, not this prompt's usage.
      state = { ...state, checkpoint: null };
      // Completion may arrive before the send acknowledgement. Never enqueue a
      // second request or finish before admission has settled.
      void this.wait(session.send({ prompt }), turn).then(() => {
        admitted = true;
        if (state.idle) finish();
      }, error => finish(String(error)));
      while (!complete || queued.length) {
        turn.controller.signal.throwIfAborted();
        if (queued.length) yield queued.shift()!;
        else await new Promise<void>(resolve => { turn.wake = resolve; });
      }
      turn.controller.signal.throwIfAborted();
      if (!state.error && state.checkpoint && baseline) yield { type: 'usage', usage: copilotTurnUsage(state.checkpoint, baseline) };
      accepting = false;
      await this.stop(turn);
      yield { type: 'done' };
    } catch (error) {
      yield { type: 'error', error: turn.aborted ? 'Copilot turn aborted.' : error instanceof Error ? error.message : String(error),
        ...(turn.aborted ? { source: 'abort' as const } : {}) };
      yield { type: 'done' };
    } finally {
      accepting = false;
      try { await this.stop(turn); }
      catch (error) { log.warn('Copilot turn cleanup failed', { error: String(error) }); }
    }
  }
}
