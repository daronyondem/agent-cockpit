import fs from 'fs/promises';
import path from 'path';
import { atomicWriteFile } from '../utils/atomicWrite';
import { KeyedMutex } from '../utils/keyedMutex';

export type SessionFinalizerJobType =
  | 'session_summary'
  | 'memory_extraction'
  | 'context_map_conversation_final_pass';

export type SessionFinalizerJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'retrying';

export interface SessionFinalizerJob {
  id: string;
  identity: string;
  workspaceHash: string;
  conversationId: string;
  sessionNumber: number;
  type: SessionFinalizerJobType;
  status: SessionFinalizerJobStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  nextAttemptAt?: string;
  errorMessage?: string;
  payload?: Record<string, unknown>;
}

interface SessionFinalizerStore {
  version: 1;
  jobs: SessionFinalizerJob[];
}

export interface EnqueueSessionFinalizerJobInput {
  workspaceHash: string;
  conversationId: string;
  sessionNumber: number;
  type: SessionFinalizerJobType;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}

export interface SessionFinalizerQueueOptions {
  workspacesDir: string;
  handleJob: (job: SessionFinalizerJob) => Promise<void>;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  concurrency?: number;
  retryDelayMs?: number;
}

const STORE_FILENAME = 'session-finalizers.json';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 5_000;

export class SessionFinalizerQueue {
  private readonly workspacesDir: string;
  private readonly handleJob: (job: SessionFinalizerJob) => Promise<void>;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly concurrency: number;
  private readonly retryDelayMs: number;
  private readonly lock = new KeyedMutex();
  private readonly activeJobs = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private stopped = false;

  constructor(opts: SessionFinalizerQueueOptions) {
    this.workspacesDir = opts.workspacesDir;
    this.handleJob = opts.handleJob;
    this.logger = opts.logger ?? console;
    this.concurrency = Math.max(1, Math.min(4, Math.round(opts.concurrency ?? 1)));
    this.retryDelayMs = Math.max(250, opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.recoverRunningJobs();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async enqueue(input: EnqueueSessionFinalizerJobInput): Promise<SessionFinalizerJob> {
    const now = new Date().toISOString();
    const identity = jobIdentity(input.type, input.conversationId, input.sessionNumber, input.payload);
    const job = await this.lock.run(input.workspaceHash, async () => {
      const store = await this.readStore(input.workspaceHash);
      const existing = store.jobs.find((candidate) => candidate.identity === identity);
      if (existing) return existing;

      const next: SessionFinalizerJob = {
        id: `sfj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        identity,
        workspaceHash: input.workspaceHash,
        conversationId: input.conversationId,
        sessionNumber: input.sessionNumber,
        type: input.type,
        status: 'pending',
        attempts: 0,
        maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        createdAt: now,
        updatedAt: now,
        ...(input.payload ? { payload: input.payload } : {}),
      };
      store.jobs.push(next);
      await this.writeStore(input.workspaceHash, store);
      return next;
    });
    this.schedule();
    return job;
  }

  async listJobs(hash?: string): Promise<SessionFinalizerJob[]> {
    if (hash) return (await this.readStore(hash)).jobs;
    const hashes = await this.listWorkspaceHashes();
    const batches = await Promise.all(hashes.map(async (workspaceHash) => (await this.readStore(workspaceHash)).jobs));
    return batches.flat();
  }

  async waitForIdle(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const jobs = await this.listJobs();
      const unfinished = jobs.some((job) => job.status === 'pending' || job.status === 'running' || job.status === 'retrying');
      if (!unfinished && this.activeJobs.size === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for session finalizer queue to become idle');
  }

  private schedule(delayMs = 0): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delayMs);
    this.timer.unref?.();
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (!this.stopped && this.activeJobs.size < this.concurrency) {
        const claim = await this.claimNextJob();
        if (!claim.job) {
          if (claim.nextDelayMs !== null) this.schedule(claim.nextDelayMs);
          return;
        }
        this.runClaimedJob(claim.job);
      }
    } finally {
      this.draining = false;
    }
  }

  private runClaimedJob(job: SessionFinalizerJob): void {
    this.activeJobs.add(job.id);
    this.handleJob(job)
      .then(() => this.markCompleted(job))
      .catch((err: unknown) => this.markFailed(job, (err as Error).message))
      .finally(() => {
        this.activeJobs.delete(job.id);
        this.schedule();
      });
  }

  private async recoverRunningJobs(): Promise<void> {
    const hashes = await this.listWorkspaceHashes();
    await Promise.all(hashes.map((hash) => this.lock.run(hash, async () => {
      const store = await this.readStore(hash);
      let changed = false;
      const now = new Date().toISOString();
      for (const job of store.jobs) {
        if (job.status !== 'running') continue;
        job.status = 'pending';
        job.updatedAt = now;
        delete job.startedAt;
        changed = true;
      }
      if (changed) await this.writeStore(hash, store);
    })));
  }

  private async claimNextJob(): Promise<{ job: SessionFinalizerJob | null; nextDelayMs: number | null }> {
    const hashes = await this.listWorkspaceHashes();
    const nowMs = Date.now();
    let best: SessionFinalizerJob | null = null;
    let bestHash: string | null = null;
    let nextDueMs: number | null = null;

    for (const hash of hashes) {
      const store = await this.readStore(hash);
      for (const job of store.jobs) {
        if (job.status !== 'pending' && job.status !== 'retrying') continue;
        if (job.status === 'retrying' && job.nextAttemptAt) {
          const due = Date.parse(job.nextAttemptAt);
          if (Number.isFinite(due) && due > nowMs) {
            nextDueMs = nextDueMs === null ? due : Math.min(nextDueMs, due);
            continue;
          }
        }
        if (!best || job.createdAt < best.createdAt) {
          best = job;
          bestHash = hash;
        }
      }
    }

    if (!best || !bestHash) {
      return { job: null, nextDelayMs: nextDueMs === null ? null : Math.max(250, nextDueMs - nowMs) };
    }

    return this.lock.run(bestHash, async () => {
      const store = await this.readStore(bestHash);
      const job = store.jobs.find((candidate) => candidate.id === best!.id);
      if (!job || (job.status !== 'pending' && job.status !== 'retrying')) {
        return { job: null, nextDelayMs: 0 };
      }
      const now = new Date().toISOString();
      job.status = 'running';
      job.attempts += 1;
      job.startedAt = now;
      job.updatedAt = now;
      delete job.completedAt;
      delete job.nextAttemptAt;
      delete job.errorMessage;
      await this.writeStore(bestHash, store);
      return { job: { ...job, payload: job.payload ? { ...job.payload } : undefined }, nextDelayMs: null };
    });
  }

  private async markCompleted(job: SessionFinalizerJob): Promise<void> {
    await this.lock.run(job.workspaceHash, async () => {
      const store = await this.readStore(job.workspaceHash);
      const current = store.jobs.find((candidate) => candidate.id === job.id);
      if (!current) return;
      const now = new Date().toISOString();
      current.status = 'completed';
      current.completedAt = now;
      current.updatedAt = now;
      delete current.nextAttemptAt;
      delete current.errorMessage;
      await this.writeStore(job.workspaceHash, store);
    });
  }

  private async markFailed(job: SessionFinalizerJob, errorMessage: string): Promise<void> {
    await this.lock.run(job.workspaceHash, async () => {
      const store = await this.readStore(job.workspaceHash);
      const current = store.jobs.find((candidate) => candidate.id === job.id);
      if (!current) return;
      const now = new Date().toISOString();
      const shouldRetry = current.attempts < current.maxAttempts;
      current.status = shouldRetry ? 'retrying' : 'failed';
      current.updatedAt = now;
      current.errorMessage = errorMessage;
      if (shouldRetry) {
        current.nextAttemptAt = new Date(Date.now() + this.retryDelayMs).toISOString();
      } else {
        current.completedAt = now;
        delete current.nextAttemptAt;
      }
      await this.writeStore(job.workspaceHash, store);
      this.logger.warn(`[session-finalizer] ${current.type} failed for conv=${current.conversationId} session=${current.sessionNumber}: ${errorMessage}`);
      if (shouldRetry) this.schedule(this.retryDelayMs);
    });
  }

  private async listWorkspaceHashes(): Promise<string[]> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(this.workspacesDir, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  private storePath(hash: string): string {
    return path.join(this.workspacesDir, hash, STORE_FILENAME);
  }

  private async readStore(hash: string): Promise<SessionFinalizerStore> {
    try {
      const raw = JSON.parse(await fs.readFile(this.storePath(hash), 'utf8')) as Partial<SessionFinalizerStore>;
      return {
        version: 1,
        jobs: Array.isArray(raw.jobs) ? raw.jobs.filter(isSessionFinalizerJob) : [],
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, jobs: [] };
      throw err;
    }
  }

  private async writeStore(hash: string, store: SessionFinalizerStore): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath(hash)), { recursive: true });
    await atomicWriteFile(this.storePath(hash), `${JSON.stringify(store, null, 2)}\n`);
  }
}

function jobIdentity(
  type: SessionFinalizerJobType,
  conversationId: string,
  sessionNumber: number,
  payload: Record<string, unknown> | undefined,
): string {
  const source = typeof payload?.source === 'string' ? payload.source : '';
  return [type, source, conversationId, String(sessionNumber)].join(':');
}

function isSessionFinalizerJob(value: unknown): value is SessionFinalizerJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<SessionFinalizerJob>;
  return typeof job.id === 'string'
    && typeof job.identity === 'string'
    && typeof job.workspaceHash === 'string'
    && typeof job.conversationId === 'string'
    && typeof job.sessionNumber === 'number'
    && (job.type === 'session_summary'
      || job.type === 'memory_extraction'
      || job.type === 'context_map_conversation_final_pass')
    && (job.status === 'pending'
      || job.status === 'running'
      || job.status === 'completed'
      || job.status === 'failed'
      || job.status === 'retrying')
    && typeof job.attempts === 'number'
    && typeof job.maxAttempts === 'number'
    && typeof job.createdAt === 'string'
    && typeof job.updatedAt === 'string';
}
