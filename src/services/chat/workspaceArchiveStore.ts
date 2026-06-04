import fsp from 'fs/promises';
import path from 'path';
import { atomicWriteFile } from '../../utils/atomicWrite';
import type {
  ConversationEntry,
  WorkspaceIndex,
} from '../../types';
import type {
  WorkspaceArchiveMetadata,
  WorkspaceArchiveMode,
  WorkspaceOriginalCleanupMode,
  WorkspaceSnapshotMetadata,
  WorkspaceSummaryResponse,
} from '../../contracts/workspaces';

interface WorkspaceArchiveStoreDeps {
  workspacesDir: string;
  indexLock: { run<T>(key: string, fn: () => Promise<T>): Promise<T> };
  readWorkspaceIndex(hash: string): Promise<WorkspaceIndex | null>;
  writeWorkspaceIndex(hash: string, index: WorkspaceIndex): Promise<void>;
  resolveWorkspaceId(ref: string): string | null;
  workspaceLegacyHashForRef(ref: string): string;
  getWorkspaceDir(ref: string): string;
  previousPathsForRef(ref: string): string[];
}

export interface WorkspaceArchiveRequestInput {
  mode: WorkspaceArchiveMode;
  note?: string;
  snapshot?: WorkspaceSnapshotMetadata;
}

export interface WorkspaceArchiveFinalizerTarget {
  conversationId: string;
  sessionNumber: number;
  backendId?: string;
  cliProfileId?: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function pathIsDirectory(workspacePath: string): Promise<boolean> {
  try {
    return (await fsp.stat(workspacePath)).isDirectory();
  } catch {
    return false;
  }
}

function activeSessionNumber(conv: ConversationEntry): number | null {
  const active = conv.sessions.find((session) => session.active);
  return active?.number ?? null;
}

export class WorkspaceArchiveStore {
  constructor(private readonly deps: WorkspaceArchiveStoreDeps) {}

  async listWorkspaces(opts: { archived?: boolean; includeArchived?: boolean } = {}): Promise<WorkspaceSummaryResponse[]> {
    let dirs: string[];
    try {
      dirs = await fsp.readdir(this.deps.workspacesDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const workspaces: WorkspaceSummaryResponse[] = [];
    for (const storageKey of dirs) {
      if (storageKey.startsWith('.')) continue;
      const index = await this.deps.readWorkspaceIndex(storageKey);
      if (!index) continue;
      const summary = await this.summaryForIndex(storageKey, index);
      if (!opts.includeArchived && summary.archived !== (opts.archived === true)) continue;
      workspaces.push(summary);
    }
    workspaces.sort((a, b) => a.workspacePath.localeCompare(b.workspacePath));
    return workspaces;
  }

  async getWorkspaceSummary(ref: string): Promise<WorkspaceSummaryResponse | null> {
    const workspaceId = this.deps.resolveWorkspaceId(ref) || ref;
    const index = await this.deps.readWorkspaceIndex(workspaceId);
    if (!index) return null;
    return this.summaryForIndex(workspaceId, index);
  }

  async isWorkspaceArchived(ref: string): Promise<boolean> {
    const index = await this.deps.readWorkspaceIndex(this.deps.resolveWorkspaceId(ref) || ref);
    return Boolean(index?.archive);
  }

  async archiveWorkspace(ref: string, request: WorkspaceArchiveRequestInput): Promise<WorkspaceSummaryResponse | null> {
    const workspaceId = this.deps.resolveWorkspaceId(ref) || ref;
    return this.deps.indexLock.run(workspaceId, async () => {
      const index = await this.deps.readWorkspaceIndex(workspaceId);
      if (!index) return null;
      if (!index.archive) {
        const timestamp = nowIso();
        index.archive = {
          archivedAt: timestamp,
          ...(request.note ? { note: request.note } : {}),
          mode: request.mode,
          finalLearningPass: { status: 'queued', startedAt: timestamp },
          ...(request.snapshot ? { snapshot: request.snapshot } : {}),
        };
        index.archive.finalLearningPass!.summaryPath = await this.writeArchiveSummary(workspaceId, index.archive, index);
        await this.deps.writeWorkspaceIndex(workspaceId, index);
      }
      return this.summaryForIndex(workspaceId, index);
    });
  }

  async completeFinalLearningPass(ref: string, error?: string): Promise<WorkspaceSummaryResponse | null> {
    const workspaceId = this.deps.resolveWorkspaceId(ref) || ref;
    return this.deps.indexLock.run(workspaceId, async () => {
      const index = await this.deps.readWorkspaceIndex(workspaceId);
      if (!index?.archive?.finalLearningPass) return index ? this.summaryForIndex(workspaceId, index) : null;
      index.archive.finalLearningPass = {
        ...index.archive.finalLearningPass,
        status: error ? 'failed' : 'completed',
        completedAt: nowIso(),
        ...(error ? { error } : {}),
      };
      if (!error) {
        index.archive.finalLearningPass.summaryPath = await this.writeArchiveSummary(workspaceId, index.archive, index);
      }
      await this.deps.writeWorkspaceIndex(workspaceId, index);
      return this.summaryForIndex(workspaceId, index);
    });
  }

  async restoreWorkspace(ref: string): Promise<WorkspaceSummaryResponse | null> {
    const workspaceId = this.deps.resolveWorkspaceId(ref) || ref;
    return this.deps.indexLock.run(workspaceId, async () => {
      const index = await this.deps.readWorkspaceIndex(workspaceId);
      if (!index) return null;
      delete index.archive;
      await this.deps.writeWorkspaceIndex(workspaceId, index);
      return this.summaryForIndex(workspaceId, index);
    });
  }

  async setOriginalCleanup(
    ref: string,
    cleanup: { mode: WorkspaceOriginalCleanupMode; movedTo?: string; error?: string },
  ): Promise<WorkspaceSummaryResponse | null> {
    const workspaceId = this.deps.resolveWorkspaceId(ref) || ref;
    return this.deps.indexLock.run(workspaceId, async () => {
      const index = await this.deps.readWorkspaceIndex(workspaceId);
      if (!index?.archive) return index ? this.summaryForIndex(workspaceId, index) : null;
      index.archive.originalCleanup = {
        mode: cleanup.mode,
        ...(cleanup.movedTo ? { movedTo: cleanup.movedTo } : {}),
        ...(cleanup.error ? { error: cleanup.error } : { completedAt: nowIso() }),
      };
      await this.deps.writeWorkspaceIndex(workspaceId, index);
      return this.summaryForIndex(workspaceId, index);
    });
  }

  async getFinalizerTargets(ref: string): Promise<WorkspaceArchiveFinalizerTarget[]> {
    const workspaceId = this.deps.resolveWorkspaceId(ref) || ref;
    const index = await this.deps.readWorkspaceIndex(workspaceId);
    if (!index) return [];
    return index.conversations
      .map((conv): WorkspaceArchiveFinalizerTarget | null => {
        const sessionNumber = activeSessionNumber(conv);
        if (!sessionNumber) return null;
        return {
          conversationId: conv.id,
          sessionNumber,
          backendId: conv.backend,
          cliProfileId: conv.cliProfileId,
        };
      })
      .filter((target): target is WorkspaceArchiveFinalizerTarget => target !== null);
  }

  private async summaryForIndex(ref: string, index: WorkspaceIndex): Promise<WorkspaceSummaryResponse> {
    const workspaceId = index.workspaceId || this.deps.resolveWorkspaceId(ref) || ref;
    const archivedConversationCount = index.conversations.filter((conv) => conv.archived).length;
    return {
      workspaceId,
      workspacePath: index.workspacePath,
      legacyHash: this.deps.workspaceLegacyHashForRef(workspaceId),
      previousPaths: this.deps.previousPathsForRef(workspaceId),
      archived: Boolean(index.archive),
      ...(index.archive ? { archive: index.archive } : {}),
      pathAvailable: await pathIsDirectory(index.workspacePath),
      conversationCount: index.conversations.length,
      activeConversationCount: index.conversations.length - archivedConversationCount,
      archivedConversationCount,
      memoryEnabled: Boolean(index.memoryEnabled),
      kbEnabled: Boolean(index.kbEnabled),
      workspaceContextEnabled: Boolean(index.workspaceContextEnabled),
      routinesEnabled: Boolean(index.routinesEnabled),
    };
  }

  private async writeArchiveSummary(
    workspaceId: string,
    archive: WorkspaceArchiveMetadata,
    index: WorkspaceIndex,
  ): Promise<string> {
    const archiveDir = path.join(this.deps.getWorkspaceDir(workspaceId), 'archive');
    await fsp.mkdir(archiveDir, { recursive: true });
    const summaryPath = path.join(archiveDir, 'summary.md');
    const archivedConversationCount = index.conversations.filter((conv) => conv.archived).length;
    const lines = [
      '# Workspace Archive Summary',
      '',
      `- Workspace ID: ${workspaceId}`,
      `- Original path: ${index.workspacePath}`,
      `- Archived at: ${archive.archivedAt}`,
      `- Archive mode: ${archive.mode}`,
      `- Conversations: ${index.conversations.length}`,
      `- Active conversations at archive: ${index.conversations.length - archivedConversationCount}`,
      `- Archived conversations at archive: ${archivedConversationCount}`,
      `- Memory enabled: ${Boolean(index.memoryEnabled)}`,
      `- Knowledge Base enabled: ${Boolean(index.kbEnabled)}`,
      `- Workspace Context enabled: ${Boolean(index.workspaceContextEnabled)}`,
      `- Workspace Routines enabled: ${Boolean(index.routinesEnabled)}`,
      ...(archive.note ? ['', '## Archive Note', '', archive.note] : []),
      '',
    ];
    await atomicWriteFile(summaryPath, lines.join('\n'), 'utf8');
    return summaryPath;
  }
}
