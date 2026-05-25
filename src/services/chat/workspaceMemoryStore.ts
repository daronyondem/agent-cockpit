import fsp from 'fs/promises';
import path from 'path';
import type {
  MemoryConsolidationAudit,
  MemoryMetadataIndex,
  MemoryReviewRun,
  MemorySnapshot,
} from '../../types';
import { atomicWriteFile } from '../../utils/atomicWrite';

interface WorkspaceMemoryStoreDeps {
  getWorkspaceDir(hash: string): string;
}

function validMemoryReviewRunId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

export class WorkspaceMemoryStore {
  constructor(private readonly deps: WorkspaceMemoryStoreDeps) {}

  memoryDir(hash: string): string {
    return path.join(this.deps.getWorkspaceDir(hash), 'memory');
  }

  snapshotPath(hash: string): string {
    return path.join(this.memoryDir(hash), 'snapshot.json');
  }

  statePath(hash: string): string {
    return path.join(this.memoryDir(hash), 'state.json');
  }

  filesDir(hash: string): string {
    return path.join(this.memoryDir(hash), 'files');
  }

  claudeDir(hash: string): string {
    return path.join(this.filesDir(hash), 'claude');
  }

  notesDir(hash: string): string {
    return path.join(this.filesDir(hash), 'notes');
  }

  reviewsDir(hash: string): string {
    return path.join(this.memoryDir(hash), 'reviews');
  }

  reviewRunPath(hash: string, runId: string): string {
    return path.join(this.reviewsDir(hash), `${runId}.json`);
  }

  async ensureFilesDir(hash: string): Promise<string> {
    const filesDir = this.filesDir(hash);
    await fsp.mkdir(filesDir, { recursive: true });
    return filesDir;
  }

  async readSnapshot(hash: string): Promise<MemorySnapshot | null> {
    try {
      const data = await fsp.readFile(this.snapshotPath(hash), 'utf8');
      return JSON.parse(data) as MemorySnapshot;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async writeSnapshot(hash: string, snapshot: MemorySnapshot): Promise<void> {
    await fsp.mkdir(this.memoryDir(hash), { recursive: true });
    await atomicWriteFile(this.snapshotPath(hash), JSON.stringify(snapshot, null, 2));
  }

  async readMetadataIndexFile(hash: string): Promise<unknown | null> {
    try {
      return JSON.parse(await fsp.readFile(this.statePath(hash), 'utf8'));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async writeMetadataIndex(hash: string, index: MemoryMetadataIndex): Promise<void> {
    await fsp.mkdir(this.memoryDir(hash), { recursive: true });
    await atomicWriteFile(this.statePath(hash), JSON.stringify(index, null, 2));
  }

  async saveConsolidationAudit(
    hash: string,
    audit: Omit<MemoryConsolidationAudit, 'version' | 'createdAt'> & { createdAt?: string },
  ): Promise<string> {
    const createdAt = audit.createdAt || new Date().toISOString();
    const dir = path.join(this.memoryDir(hash), 'audits');
    await fsp.mkdir(dir, { recursive: true });
    const safeTimestamp = createdAt.replace(/[:.]/g, '-');
    const name = `consolidation_${safeTimestamp}.json`;
    const relPath = `audits/${name}`;
    const payload: MemoryConsolidationAudit = {
      version: 1,
      createdAt,
      summary: audit.summary,
      applied: audit.applied,
      skipped: audit.skipped,
      appliedDraftOperations: audit.appliedDraftOperations,
      skippedDraftOperations: audit.skippedDraftOperations,
    };
    await atomicWriteFile(path.join(dir, name), JSON.stringify(payload, null, 2));
    return relPath;
  }

  async saveReviewRun(hash: string, run: MemoryReviewRun): Promise<MemoryReviewRun> {
    if (!validMemoryReviewRunId(run.id)) {
      throw new Error('Invalid memory review run id');
    }
    await fsp.mkdir(this.reviewsDir(hash), { recursive: true });
    await atomicWriteFile(this.reviewRunPath(hash, run.id), JSON.stringify(run, null, 2));
    return run;
  }

  async getReviewRun(hash: string, runId: string): Promise<MemoryReviewRun | null> {
    if (!validMemoryReviewRunId(runId)) return null;
    try {
      const raw = await fsp.readFile(this.reviewRunPath(hash, runId), 'utf8');
      return JSON.parse(raw) as MemoryReviewRun;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async listReviewRuns(hash: string): Promise<MemoryReviewRun[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.reviewsDir(hash));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const runs: MemoryReviewRun[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const runId = name.slice(0, -'.json'.length);
      const run = await this.getReviewRun(hash, runId);
      if (run) runs.push(run);
    }
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return runs;
  }
}
