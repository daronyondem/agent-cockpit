import fsp from 'fs/promises';
import path from 'path';
import type { Dirent } from 'fs';
import type { ConversationWorkspaceContextStatus } from '../../types';

export interface ConversationWorkspaceContextStatusRun {
  runId: string;
  source: ConversationWorkspaceContextStatus['latestRunSource'];
  status: ConversationWorkspaceContextStatus['latestRunStatus'];
  startedAt: string;
  completedAt?: string;
}

interface WorkspaceContextStatusServiceDeps {
  getWorkspaceContextDir(hash: string): string;
  getWorkspaceContextEnabled(hash: string): Promise<boolean>;
  log?: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

export function normalizeWorkspaceContextStatusRun(value: unknown): ConversationWorkspaceContextStatusRun | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.runId !== 'string' || typeof record.startedAt !== 'string') return undefined;
  const status = record.status === 'running' || record.status === 'completed' || record.status === 'failed' || record.status === 'stopped' || record.status === 'skipped'
    ? record.status
    : undefined;
  const source = record.source === 'initial_scan' || record.source === 'scheduled' || record.source === 'session_reset' || record.source === 'archive' || record.source === 'manual_catchup' || record.source === 'maintenance'
    ? record.source
    : undefined;
  if (!status || !source) return undefined;
  return {
    runId: record.runId,
    source,
    status,
    startedAt: record.startedAt,
    completedAt: typeof record.completedAt === 'string' ? record.completedAt : undefined,
  };
}

function isStatusRun(value: ConversationWorkspaceContextStatusRun | undefined): value is ConversationWorkspaceContextStatusRun {
  return Boolean(value);
}

export class WorkspaceContextStatusService {
  constructor(private readonly deps: WorkspaceContextStatusServiceDeps) {}

  async getStatus(hash: string): Promise<ConversationWorkspaceContextStatus> {
    const enabled = await this.deps.getWorkspaceContextEnabled(hash);
    const contextDir = this.deps.getWorkspaceContextDir(hash);
    if (!enabled) {
      return {
        enabled: false,
        pending: false,
        runningRuns: 0,
        failedRuns: 0,
        contextDir,
        fileCount: 0,
      };
    }

    const state = await this.readState(hash);
    const runs = state.runs || [];
    const latest = state.lastRun || runs[0];
    const failedRuns = runs.filter((run) => run.status === 'failed').length;
    const runningRuns = runs.filter((run) => run.status === 'running').length;
    const fileCount = await this.countFiles(hash);

    return {
      enabled: true,
      pending: failedRuns + runningRuns > 0,
      runningRuns,
      failedRuns,
      contextDir,
      fileCount,
      ...(latest ? {
        latestRunId: latest.runId,
        latestRunStatus: latest.status,
        latestRunCreatedAt: latest.startedAt,
        latestRunUpdatedAt: latest.completedAt || latest.startedAt,
        latestRunSource: latest.source,
        lastRunId: latest.runId,
        lastRunStatus: latest.status,
        lastRunCreatedAt: latest.startedAt,
        lastRunUpdatedAt: latest.completedAt || latest.startedAt,
        lastRunSource: latest.source,
      } : {}),
    };
  }

  async readState(hash: string): Promise<{ lastRun?: ConversationWorkspaceContextStatusRun; runs: ConversationWorkspaceContextStatusRun[] }> {
    try {
      const state = JSON.parse(await fsp.readFile(path.join(this.deps.getWorkspaceContextDir(hash), 'state.json'), 'utf8'));
      return {
        lastRun: normalizeWorkspaceContextStatusRun(state.lastRun),
        runs: Array.isArray(state.runs) ? state.runs.map(normalizeWorkspaceContextStatusRun).filter(isStatusRun) : [],
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.deps.log?.warn('Failed to read Workspace Context status state', { workspaceHash: hash, error: err });
      }
      return { runs: [] };
    }
  }

  async countFiles(hash: string): Promise<number> {
    const root = path.join(this.deps.getWorkspaceContextDir(hash), 'context');
    let count = 0;
    async function walk(dir: string): Promise<void> {
      let entries: Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(abs);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) count += 1;
      }
    }
    await walk(root);
    return count;
  }
}
