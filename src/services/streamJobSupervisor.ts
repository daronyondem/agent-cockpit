import crypto from 'crypto';
import { StreamJobRegistry } from './streamJobRegistry';
import type {
  ActiveStreamEntry,
  DurableStreamJob,
  StreamJobTerminalInfo,
  StreamErrorSource,
} from '../types';

type AcceptedTurnInput = Omit<DurableStreamJob, 'id' | 'state' | 'createdAt' | 'updatedAt'> & {
  id?: string;
};

type JobPatch = Partial<Omit<DurableStreamJob, 'id' | 'conversationId' | 'createdAt'>>;

export interface PendingMessageSend {
  jobId: string;
  abortRequested?: StreamJobTerminalInfo;
}

export interface RuntimeCleanupResult {
  abortedRuntime: boolean;
  deletedJobs: number;
}

/**
 * Runtime owner for active CLI turn bookkeeping.
 *
 * The registry remains the durable source of active-job truth, while this
 * supervisor owns the process-local attachments that make a job runnable:
 * pending pre-stream sends and active backend iterators.
 */
export class StreamJobSupervisor {
  readonly registry: StreamJobRegistry;
  readonly activeStreams = new Map<string, ActiveStreamEntry>();
  readonly pendingMessageSends = new Map<string, PendingMessageSend>();

  constructor(baseDir: string) {
    this.registry = new StreamJobRegistry(baseDir);
  }

  hasInFlightTurn(conversationId: string): boolean {
    return this.activeStreams.has(conversationId) || this.pendingMessageSends.has(conversationId);
  }

  hasAnyInFlightTurn(): boolean {
    return this.activeStreams.size > 0 || this.pendingMessageSends.size > 0;
  }

  async beginAcceptedTurn(input: AcceptedTurnInput): Promise<PendingMessageSend> {
    const jobId = input.id || crypto.randomUUID();
    const pending: PendingMessageSend = { jobId };
    this.pendingMessageSends.set(input.conversationId, pending);

    try {
      await this.registry.create({
        ...input,
        id: jobId,
        state: 'accepted',
      });
      return pending;
    } catch (err) {
      if (this.pendingMessageSends.get(input.conversationId) === pending) {
        this.pendingMessageSends.delete(input.conversationId);
      }
      throw err;
    }
  }

  clearPending(conversationId: string, pending?: PendingMessageSend): void {
    if (!pending || this.pendingMessageSends.get(conversationId) === pending) {
      this.pendingMessageSends.delete(conversationId);
    }
  }

  attachRuntime(conversationId: string, entry: ActiveStreamEntry): void {
    this.activeStreams.set(conversationId, entry);
  }

  detachRuntime(conversationId: string, entry?: ActiveStreamEntry): boolean {
    if (entry && this.activeStreams.get(conversationId) !== entry) return false;
    return this.activeStreams.delete(conversationId);
  }

  async markPreparing(jobId: string, patch: JobPatch = {}): Promise<DurableStreamJob | null> {
    return this.registry.update(jobId, { ...patch, state: 'preparing' });
  }

  async markRunning(jobId: string, patch: JobPatch = {}): Promise<DurableStreamJob | null> {
    return this.registry.update(jobId, { ...patch, state: 'running' });
  }

  async requestPendingAbort(conversationId: string, message = 'Aborted by user'): Promise<boolean> {
    const pending = this.pendingMessageSends.get(conversationId);
    if (!pending) return false;
    if (!pending.abortRequested) {
      pending.abortRequested = this.terminal(message, 'abort');
      await this.registry.update(pending.jobId, {
        state: 'abort_requested',
        abortRequested: pending.abortRequested,
      });
    }
    return true;
  }

  async requestRuntimeAbort(entry: ActiveStreamEntry, message = 'Aborted by user'): Promise<void> {
    if (!entry.abortRequested) {
      entry.abortRequested = this.terminal(message, 'abort');
      if (entry.jobId) {
        await this.registry.update(entry.jobId, {
          state: 'abort_requested',
          abortRequested: entry.abortRequested,
        });
      }
    }
  }

  async markFinalizing(jobId: string, terminalError: StreamJobTerminalInfo): Promise<DurableStreamJob | null> {
    return this.registry.update(jobId, {
      state: 'finalizing',
      terminalError,
    });
  }

  async completeJob(jobId: string): Promise<boolean> {
    return this.registry.delete(jobId);
  }

  async cleanupRuntimeConversation(conversationId: string): Promise<RuntimeCleanupResult> {
    let deletedJobs = 0;
    let abortedRuntime = false;
    const entry = this.activeStreams.get(conversationId);

    if (entry) {
      abortedRuntime = true;
      try {
        entry.abort();
      } catch (err: unknown) {
        console.warn(`[streamJobSupervisor] Stream abort threw for conv=${conversationId}:`, (err as Error).message);
      }
      this.detachRuntime(conversationId, entry);
      if (entry.jobId) {
        if (await this.completeJob(entry.jobId)) deletedJobs += 1;
        entry.jobId = undefined;
      }
    }

    deletedJobs += await this.registry.deleteActiveForConversation(conversationId);
    return { abortedRuntime, deletedJobs };
  }

  async prepareForShutdown(message = 'Interrupted by server shutdown'): Promise<number> {
    const terminal = this.terminal(message, 'server');
    let marked = 0;

    for (const pending of this.pendingMessageSends.values()) {
      if (await this.markFinalizing(pending.jobId, terminal)) marked += 1;
    }

    for (const entry of this.activeStreams.values()) {
      if (entry.jobId && await this.markFinalizing(entry.jobId, terminal)) marked += 1;
    }

    return marked;
  }

  abortAndDetachAllRuntime(): void {
    for (const [conversationId, entry] of this.activeStreams) {
      console.log(`[shutdown] Aborting active stream for conv=${conversationId}`);
      try {
        entry.abort();
      } catch (err: unknown) {
        console.warn(`[shutdown] Stream abort threw for conv=${conversationId}:`, (err as Error).message);
      }
      entry.jobId = undefined;
    }
    this.activeStreams.clear();
    this.pendingMessageSends.clear();
  }

  terminal(message: string, source: StreamErrorSource): StreamJobTerminalInfo {
    return { message, source, at: new Date().toISOString() };
  }
}
