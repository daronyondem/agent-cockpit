import type { CopilotSession, SessionEvent } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import type { SendMessageOptions, SendMessageResult, StreamEvent, ThreadGoal, SessionRecoveryMetadata } from '../../types';
import { logger } from '../../utils/logger';
import { resolveCopilotCliRuntime, resolveCopilotWorkingDir } from './copilotRuntime';
import { startCopilotSdkRuntime, type CopilotSdkRuntime } from './copilotSdkRuntime';
import { copilotSessionConfig, composePrompt } from './copilotSessionConfig';
import { createCopilotSdkEventState, reduceCopilotSdkEvent } from './copilotSdkEvents';
import { copilotContextUsage, copilotUsageMetrics } from './copilotUsage';
import { CopilotLiveUsage } from './copilotLiveUsage';
import { CopilotModelCatalog, assertCopilotSelection } from './copilotCatalog';
import { CopilotInputs } from './copilotInputs';
import { finishCopilotWork } from './copilotAgents';
import { invokeCopilotGoal, pauseCopilotGoal, readCopilotGoal, type CopilotGoalRun } from './copilotGoals';
import crypto from 'crypto';
import { buildHarnessRecoveryPrompt, buildNativeSessionRecovery, buildSessionRecoveryEvent, createRecoverySnapshot, isMissingNativeSessionError } from './sessionRecovery';

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
  inputs?: CopilotInputs;
  session?: CopilotSession;
  ready?: Promise<void>;
  markReady?: () => void;
  control?: { pause: boolean; result: Promise<ThreadGoal | null> };
  pausedGoal?: ThreadGoal;
}

/** One owned runtime per active conversation; persisted sessions survive process cleanup. */
export class CopilotConversations {
  private turns = new Map<string, ConversationTurn>();
  private resets = new Map<string, Promise<void>>();
  private closing: Promise<void> | null = null;
  private closed = false;
  private readonly startRuntime: typeof startCopilotSdkRuntime;
  private readonly requestTimeoutMs: number;
  private readonly catalog: CopilotModelCatalog;

  constructor(private options: { workingDir?: string; startRuntime?: typeof startCopilotSdkRuntime; requestTimeoutMs?: number; catalog?: CopilotModelCatalog } = {}) {
    this.startRuntime = options.startRuntime || startCopilotSdkRuntime;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.catalog = options.catalog || new CopilotModelCatalog();
  }

  sendMessage(message: string, options: SendMessageOptions, goalRun?: CopilotGoalRun): SendMessageResult {
    const key = options.conversationId ? `conversation:${options.conversationId}` : `session:${options.sessionId}`;
    const previous = this.turns.get(key);
    const rejection = this.closed || this.closing || this.resets.has(key) ? 'Copilot is shutting down or resetting.'
      : previous && !previous.control && !previous.controller.signal.aborted ? 'Copilot already has an active turn for this conversation.' : null;
    if (rejection) return { stream: this.rejected(rejection), abort: () => {}, sendInput: () => {} };
    const turn: ConversationTurn = { key, controller: new AbortController(), aborted: false, predecessor: previous ? this.stop(previous) : undefined };
    turn.ready = new Promise(resolve => { turn.markReady = resolve; });
    this.turns.set(key, turn);
    const stream = this.stream(message, options, turn, goalRun);
    const close = stream.return.bind(stream), fail = stream.throw.bind(stream);
    // Generator finally blocks do not run when return/throw precedes first next.
    stream.return = async value => { await this.cancel(turn); return close(value); };
    stream.throw = async error => { await this.cancel(turn); return fail(error); };
    return { stream, sendInput: () => {}, deliverInput: input => turn.inputs && !turn.controller.signal.aborted
      ? turn.inputs.deliver(input) : Promise.resolve({ accepted: false, status: 409, error: 'Copilot input is not active.' }), abort: () => {
      void this.cancel(turn).catch(error => log.warn('Copilot cancellation cleanup failed', { error: String(error) }));
    } };
  }

  /** Controls share the turn owner, or attach existing history without running work. */
  async goal(options: SendMessageOptions, pause = false): Promise<ThreadGoal | null> {
    const key = options.conversationId ? `conversation:${options.conversationId}` : `session:${options.sessionId}`;
    if (this.closed || this.closing || this.resets.has(key)) throw new Error('Copilot is shutting down or resetting.');
    const current = this.turns.get(key);
    if (current?.control && !current.controller.signal.aborted) {
      if (!pause || current.control.pause) return current.control.result;
      await current.control.result;
      return this.goal(options, pause);
    }
    if (current && !current.controller.signal.aborted) {
      try {
        await this.wait(current.ready!, current);
        if (!current.session) throw new Error('Copilot session is not available.');
        const goal = await this.wait(pause ? pauseCopilotGoal(current.session) : readCopilotGoal(current.session), current);
        if (pause && goal?.status === 'paused') { current.pausedGoal = goal; await this.cancel(current); }
        return goal;
      } catch (error) {
        // A normal idle close may race a read. Drain it before a read-only attach.
        if (pause || current.aborted || !current.controller.signal.aborted || !options.externalSessionId) throw error;
        await current.cleanup;
        return this.goal(options);
      }
    }
    if (!options.externalSessionId) return null;
    const turn: ConversationTurn = { key, controller: new AbortController(), aborted: false, predecessor: current ? this.stop(current) : undefined };
    this.turns.set(key, turn);
    const result = this.idleGoal(options, turn, pause);
    turn.control = { pause, result };
    return result;
  }

  private async idleGoal(options: SendMessageOptions, turn: ConversationTurn, pause: boolean): Promise<ThreadGoal | null> {
    try {
      await this.wait(turn.predecessor || Promise.resolve(), turn);
      const workingDir = resolveCopilotWorkingDir(options.workingDir || this.options.workingDir);
      const runtime = resolveCopilotCliRuntime(options.cliProfile);
      turn.controller.signal.throwIfAborted();
      turn.startup = this.startRuntime(runtime, workingDir, { abortSignal: turn.controller.signal });
      turn.runtime = await this.wait(turn.startup, turn);
      const { provider, onPermissionRequest } = copilotSessionConfig(options, runtime.env, workingDir);
      const session = await this.wait(turn.runtime.client.resumeSession(options.externalSessionId!, {
        provider, onPermissionRequest, workingDirectory: workingDir, enableConfigDiscovery: false, continuePendingWork: false,
      }), turn);
      return await this.wait(pause ? pauseCopilotGoal(session) : readCopilotGoal(session), turn);
    } finally {
      await this.stop(turn);
    }
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
    turn.inputs?.cancel();
    turn.markReady?.();
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

  private async *stream(message: string, options: SendMessageOptions, turn: ConversationTurn, goalRun?: CopilotGoalRun): AsyncGenerator<StreamEvent> {
    let accepting = false;
    const namespace = crypto.randomUUID();
    let state = createCopilotSdkEventState(namespace);
    try {
      await this.wait(turn.predecessor || Promise.resolve(), turn);
      const workingDir = resolveCopilotWorkingDir(options.workingDir || this.options.workingDir);
      const runtime = resolveCopilotCliRuntime(options.cliProfile);
      turn.controller.signal.throwIfAborted();
      turn.startup = this.startRuntime(runtime, workingDir, { abortSignal: turn.controller.signal });
      turn.runtime = await this.wait(turn.startup, turn);
      yield { type: 'backend_runtime', processId: turn.runtime.process.pid ?? null };
      turn.controller.signal.throwIfAborted();
      const catalog = await this.wait(this.catalog.forRuntime(runtime, turn.runtime.client, turn.controller.signal), turn);
      turn.controller.signal.throwIfAborted();
      assertCopilotSelection(catalog, options, runtime.env);
      const queued: StreamEvent[] = [];
      let liveUsage: CopilotLiveUsage | undefined;
      let complete = false;
      let admitted = false;
      let started = false;
      let steeringEnabled = false;
      const notify = () => { turn.wake?.(); };
      const finish = (error?: string, source?: 'transport') => {
        if (complete || !accepting || turn.controller.signal.aborted) return;
        if (error) {
          const ended = finishCopilotWork(state.work, 'interrupted'); state.work = ended.state; queued.push(...ended.events);
          state = { ...state, error };
          queued.push({ type: 'error', error, ...(source ? { source } : {}) });
        }
        complete = true; notify();
      };
      const finishInputs = () => {
        void turn.inputs!.finish().then(() => finish(), () => finish('Copilot input cleanup failed; the turn was stopped.', 'transport'));
      };
      const enableSteering = () => {
        if (!admitted || !started || state.idle || complete || steeringEnabled) return;
        steeringEnabled = true;
        void turn.inputs!.enableSteering();
      };
      const onEvent = (event: SessionEvent) => {
        if (!accepting || complete || turn.controller.signal.aborted) return;
        const projected = reduceCopilotSdkEvent(state, event);
        state = projected.state;
        queued.push(...projected.events);
        turn.inputs?.handle(event);
        if (event.type === 'assistant.usage') liveUsage?.request();
        if (!event.agentId && event.type === 'assistant.turn_start') { started = true; enableSteering(); }
        if (state.error) { turn.inputs?.cancel(); finish(); }
        else if (admitted && state.idle) finishInputs();
        notify();
      };
      accepting = true;
      void turn.runtime.closed.then(error => finish(error.message, 'transport'));
      const config = { ...copilotSessionConfig(options, runtime.env, workingDir, catalog.models,
        request => turn.inputs ? turn.inputs.ask(request) : Promise.reject(new Error('Copilot input is not ready.'))), onEvent };
      let session: CopilotSession;
      let recovered: SessionRecoveryMetadata | undefined;
      let prompt = composePrompt(message, options.systemPrompt, options.isNewSession);
      if (!options.isNewSession && options.externalSessionId) {
        try {
          session = await this.wait(turn.runtime.client.resumeSession(options.externalSessionId, { ...config, continuePendingWork: false }), turn);
        } catch (error) {
          if (goalRun?.kind === 'resume' || turn.controller.signal.aborted || state.hasOutput || !isMissingNativeSessionError(String(error))) throw error;
          let snapshot = null;
          try { snapshot = await this.wait(createRecoverySnapshot(options, { previousNativeSessionId: options.externalSessionId, reason: String(error) }), turn); }
          catch (snapshotError) { log.warn('Cannot create Copilot recovery snapshot', { error: String(snapshotError) }); }
          turn.controller.signal.throwIfAborted();
          const recovery = buildNativeSessionRecovery({ backend: 'copilot', previousNativeSessionId: options.externalSessionId,
            reason: String(error), snapshot, currentPrompt: message });
          recovered = recovery.metadata;
          yield buildSessionRecoveryEvent(recovery.metadata);
          turn.controller.signal.throwIfAborted();
          state = createCopilotSdkEventState(namespace); queued.length = 0; complete = false;
          session = await this.wait(turn.runtime.client.createSession({ ...config, trustWorkingDirectory: 'session' }), turn);
          prompt = composePrompt(recovery.prompt, options.systemPrompt, true);
        }
      } else session = await this.wait(turn.runtime.client.createSession({ ...config, trustWorkingDirectory: 'session' }), turn);
      turn.session = session;
      turn.markReady?.();
      turn.inputs = new CopilotInputs(session, event => {
        if (accepting && !complete && !turn.controller.signal.aborted) { queued.push(event); notify(); }
      }, pending => this.wait(pending, turn), message => finish(message, 'transport'));
      turn.controller.signal.throwIfAborted();
      if (complete) throw new Error(state.error || 'Copilot session closed before prompt submission.');
      yield { type: 'external_session', sessionId: session.sessionId };
      turn.controller.signal.throwIfAborted();
      yield { type: 'backend_runtime', externalSessionId: session.sessionId, processId: turn.runtime.process.pid ?? null };
      turn.controller.signal.throwIfAborted();
      // Read the runtime's reconciled ledger after resume, before this prompt.
      // This also works when a launcher privately chooses the native auth home.
      const baseline = await this.readUsage(session, turn);
      liveUsage = new CopilotLiveUsage(baseline, () => this.readUsage(session, turn), usage => {
        if (accepting && !turn.controller.signal.aborted) { queued.push({ type: 'usage', usage }); notify(); }
      });
      yield { type: 'usage', usage: copilotContextUsage(undefined, undefined, new Date().toISOString()) };
      turn.controller.signal.throwIfAborted();
      if (complete) throw new Error(state.error || 'Copilot session closed before prompt submission.');
      let displayPrompt: string | undefined;
      if (goalRun) {
        const effect = await this.wait(invokeCopilotGoal(session, goalRun), turn);
        prompt = composePrompt(recovered ? buildHarnessRecoveryPrompt(recovered, effect.prompt) : effect.prompt,
          options.systemPrompt, options.isNewSession || !!recovered);
        displayPrompt = effect.displayPrompt;
        const goal = await this.wait(readCopilotGoal(session), turn);
        if (goal) yield { type: 'goal_updated', goal };
        turn.controller.signal.throwIfAborted();
      }
      if (complete) throw new Error(state.error || 'Copilot session closed before prompt submission.');
      // Completion may arrive before the send acknowledgement. Never enqueue a
      // second request or finish before admission has settled.
      void this.wait(session.send({ prompt, ...(displayPrompt ? { displayPrompt } : {}) }), turn).then(() => {
        admitted = true;
        enableSteering();
        if (state.idle) finishInputs();
      }).catch(error => finish(String(error)));
      while (!complete || queued.length) {
        turn.controller.signal.throwIfAborted();
        if (queued.length) yield queued.shift()!;
        else await new Promise<void>(resolve => { turn.wake = resolve; });
      }
      turn.controller.signal.throwIfAborted();
      if (!state.error) {
        try {
          const goal = await this.wait(readCopilotGoal(session), turn);
          if (goal) yield { type: 'goal_updated', goal };
        } catch {
          turn.controller.signal.throwIfAborted();
          log.warn('Copilot goal state unavailable after idle.');
        }
      }
      if (!state.error) await liveUsage.finish();
      while (queued.length) yield queued.shift()!;
      accepting = false;
      await this.stop(turn);
      yield { type: 'done' };
    } catch (error) {
      const ended = finishCopilotWork(state.work, turn.aborted ? 'cancelled' : 'interrupted');
      for (const event of ended.events) yield event;
      if (turn.pausedGoal) {
        await turn.cleanup;
        yield { type: 'goal_updated', goal: turn.pausedGoal };
      } else yield { type: 'error', error: turn.aborted ? 'Copilot turn aborted.' : error instanceof Error ? error.message : String(error),
        ...(turn.aborted ? { source: 'abort' as const } : {}) };
      yield { type: 'done' };
    } finally {
      accepting = false;
      try { await this.stop(turn); }
      catch (error) { log.warn('Copilot turn cleanup failed', { error: String(error) }); }
    }
  }

  private async readUsage(session: CopilotSession, turn: ConversationTurn) {
    try { return copilotUsageMetrics(await this.wait(session.rpc.usage.getMetrics(), turn)); }
    catch {
      turn.controller.signal.throwIfAborted();
      log.warn('Copilot usage metrics unavailable; cumulative usage will not be charged');
      return null;
    }
  }
}
