// Bounded-parallelism task queue with drain barriers, scoped per workspace.
//
// Replaces the per-service Promise-chain FIFO that previously serialized
// every KB operation. Ingestion and digestion share a single
// `WorkspaceTaskQueue` instance per workspace so `cliConcurrency` is a
// shared budget across both pipelines (design doc §11).
//
// Folder ops (`createFolder` / `renameFolder` / `deleteFolder`) use
// `runBarrier`: the queue waits for every in-flight task to settle before
// running the barrier alone, then resumes normal dispatch. This avoids
// races where a folder rename rewrites `raw_locations` rows while an
// ingestion is mid-write.

type Resolver<T> = (value: T) => void;
type Rejecter = (reason: unknown) => void;

interface QueueItem {
  kind: 'task' | 'barrier';
  task: () => Promise<unknown>;
  resolve: Resolver<unknown>;
  reject: Rejecter;
}

export interface WorkspaceTaskQueueOpts {
  /**
   * Returns the current concurrency budget for this workspace. Read fresh
   * on every dispatch decision so settings changes propagate without
   * needing to recreate the queue. Values < 1 are clamped to 1.
   */
  getConcurrency: () => number;
}

/**
 * Bounded-parallelism queue for a single workspace. Tasks dispatched via
 * `run()` execute up to `getConcurrency()` at a time; tasks dispatched via
 * `runBarrier()` drain the in-flight set before running and block other
 * work until they complete.
 */
export class WorkspaceTaskQueue {
  private readonly getConcurrency: () => number;
  private readonly items: QueueItem[] = [];
  private inFlight = 0;
  private barrierRunning = false;
  private drainWaiters: Array<() => void> = [];

  constructor(opts: WorkspaceTaskQueueOpts) {
    this.getConcurrency = opts.getConcurrency;
  }

  /** Enqueue a task. Up to `getConcurrency()` tasks run in parallel. */
  run<T>(task: () => Promise<T>): Promise<T> {
    return this._enqueue('task', task);
  }

  /**
   * Enqueue a barrier task. The queue drains in-flight tasks first, then
   * runs the barrier alone, then resumes normal dispatch. New `run()` /
   * `runBarrier()` calls made while a barrier is queued will wait their
   * turn FIFO behind the barrier.
   */
  runBarrier<T>(task: () => Promise<T>): Promise<T> {
    return this._enqueue('barrier', task);
  }

  /**
   * Resolves once the queue is fully idle (no in-flight, no queued, no
   * running barrier). Intended for tests — production code observes
   * progress via `kb_state_update` frames instead.
   */
  waitForIdle(): Promise<void> {
    if (this._isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  /** Test/inspection hook. */
  stats(): { inFlight: number; queued: number; barrierRunning: boolean } {
    return {
      inFlight: this.inFlight,
      queued: this.items.length,
      barrierRunning: this.barrierRunning,
    };
  }

  private _isIdle(): boolean {
    return this.inFlight === 0 && this.items.length === 0 && !this.barrierRunning;
  }

  private _notifyDrainIfIdle(): void {
    if (!this._isIdle()) return;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) w();
  }

  private _enqueue<T>(kind: 'task' | 'barrier', task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.items.push({
        kind,
        task: task as () => Promise<unknown>,
        resolve: resolve as Resolver<unknown>,
        reject,
      });
      this._pump();
    });
  }

  private _pump(): void {
    while (this.items.length > 0) {
      const head = this.items[0];

      if (head.kind === 'barrier') {
        if (this.inFlight > 0 || this.barrierRunning) return;
        this.items.shift();
        this.barrierRunning = true;
        this._runItem(head, () => {
          this.barrierRunning = false;
          this._pump();
        });
        return;
      }

      // Regular task — blocked while a barrier is running, otherwise
      // dispatched up to the current concurrency budget.
      if (this.barrierRunning) return;
      const concurrency = Math.max(1, this.getConcurrency());
      if (this.inFlight >= concurrency) return;
      this.items.shift();
      this.inFlight += 1;
      this._runItem(head, () => {
        this.inFlight -= 1;
        this._pump();
      });
    }
    this._notifyDrainIfIdle();
  }

  private _runItem(item: QueueItem, onSettle: () => void): void {
    // Wrap in an async IIFE so synchronous throws inside `task()` become
    // promise rejections instead of unhandled exceptions.
    (async () => item.task())()
      .then(item.resolve, item.reject)
      .finally(onSettle);
  }
}

/**
 * Per-workspace registry. Both `KbIngestionService` and `KbDigestionService`
 * resolve the same `WorkspaceTaskQueue` instance for a given hash so the
 * `cliConcurrency` budget is shared across both pipelines.
 */
export class WorkspaceTaskQueueRegistry {
  private readonly queues = new Map<string, WorkspaceTaskQueue>();
  private readonly concurrency = new Map<string, number>();
  private readonly defaultConcurrency: number;

  constructor(opts: { defaultConcurrency?: number } = {}) {
    this.defaultConcurrency = opts.defaultConcurrency ?? 2;
  }

  /** Get (or lazily create) the queue for a workspace. */
  get(hash: string): WorkspaceTaskQueue {
    let q = this.queues.get(hash);
    if (!q) {
      q = new WorkspaceTaskQueue({
        getConcurrency: () => this.concurrency.get(hash) ?? this.defaultConcurrency,
      });
      this.queues.set(hash, q);
    }
    return q;
  }

  /**
   * Set the concurrency budget for a workspace. Services call this with the
   * latest `Settings.knowledgeBase.cliConcurrency` value before dispatching
   * a task so the queue picks up the current setting on the next pump.
   */
  setConcurrency(hash: string, concurrency: number): void {
    this.concurrency.set(hash, Math.max(1, Math.floor(concurrency)));
  }

  /**
   * Resolves once the workspace's queue (if any) is fully idle. Returns
   * immediately when no queue has been created for the given hash.
   */
  async waitForIdle(hash: string): Promise<void> {
    const q = this.queues.get(hash);
    if (!q) return;
    await q.waitForIdle();
  }
}
