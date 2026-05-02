import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { atomicWriteFile } from '../utils/atomicWrite';
import { KeyedMutex } from '../utils/keyedMutex';
import type { DurableStreamJob, StreamJobFile, StreamJobState } from '../types';

export const ACTIVE_STREAM_JOB_STATES: ReadonlySet<StreamJobState> = new Set([
  'accepted',
  'preparing',
  'running',
  'abort_requested',
  'finalizing',
]);

type StreamJobCreateInput = Omit<DurableStreamJob, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
};

type StreamJobPatch = Partial<Omit<DurableStreamJob, 'id' | 'conversationId' | 'createdAt'>>;

export class StreamJobRegistry {
  readonly filePath: string;
  private _lock = new KeyedMutex();
  private static readonly LOCK_KEY = '__stream_jobs__';

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, 'stream-jobs.json');
    fs.mkdirSync(baseDir, { recursive: true });
  }

  async create(input: StreamJobCreateInput): Promise<DurableStreamJob> {
    const now = new Date().toISOString();
    const job: DurableStreamJob = {
      ...input,
      id: input.id || crypto.randomUUID(),
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now,
    };

    await this._mutate((file) => {
      file.jobs = file.jobs.filter((existing) => existing.id !== job.id);
      file.jobs.push(job);
      return file;
    });

    return job;
  }

  async get(id: string): Promise<DurableStreamJob | null> {
    const file = await this._readFile();
    return file.jobs.find((job) => job.id === id) || null;
  }

  async listActive(): Promise<DurableStreamJob[]> {
    const file = await this._readFile();
    return file.jobs.filter((job) => ACTIVE_STREAM_JOB_STATES.has(job.state));
  }

  async update(id: string, patch: StreamJobPatch): Promise<DurableStreamJob | null> {
    let updated: DurableStreamJob | null = null;
    await this._mutate((file) => {
      file.jobs = file.jobs.map((job) => {
        if (job.id !== id) return job;
        updated = {
          ...job,
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        return updated;
      });
      return file;
    });
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    let deleted = false;
    await this._mutate((file) => {
      const next = file.jobs.filter((job) => job.id !== id);
      deleted = next.length !== file.jobs.length;
      file.jobs = next;
      return file;
    });
    return deleted;
  }

  async deleteActiveForConversation(conversationId: string): Promise<number> {
    let deleted = 0;
    await this._mutate((file) => {
      const next = file.jobs.filter((job) => {
        const remove = job.conversationId === conversationId && ACTIVE_STREAM_JOB_STATES.has(job.state);
        if (remove) deleted += 1;
        return !remove;
      });
      file.jobs = next;
      return file;
    });
    return deleted;
  }

  private async _mutate(fn: (file: StreamJobFile) => StreamJobFile): Promise<void> {
    await this._lock.run(StreamJobRegistry.LOCK_KEY, async () => {
      const current = await this._readFileUnlocked();
      const next = fn(current);
      await this._writeFileUnlocked(next);
    });
  }

  private async _readFile(): Promise<StreamJobFile> {
    return this._lock.run(StreamJobRegistry.LOCK_KEY, () => this._readFileUnlocked());
  }

  private async _readFileUnlocked(): Promise<StreamJobFile> {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StreamJobFile>;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
        return { version: 1, jobs: [] };
      }
      return {
        version: 1,
        jobs: parsed.jobs.filter((job): job is DurableStreamJob => {
          return !!job
            && typeof job.id === 'string'
            && typeof job.conversationId === 'string'
            && typeof job.sessionId === 'string'
            && typeof job.backend === 'string'
            && typeof job.state === 'string';
        }),
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, jobs: [] };
      }
      throw err;
    }
  }

  private async _writeFileUnlocked(file: StreamJobFile): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    await atomicWriteFile(this.filePath, JSON.stringify({ version: 1, jobs: file.jobs }, null, 2));
  }
}
