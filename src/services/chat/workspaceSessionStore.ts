import fsp from 'fs/promises';
import path from 'path';
import type { ConversationEntry, SessionFile, WorkspaceIndex } from '../../types';
import { atomicWriteFile } from '../../utils/atomicWrite';

export interface WorkspaceSessionLookupResult {
  hash: string;
  index: WorkspaceIndex;
  convEntry: ConversationEntry;
}

interface WorkspaceSessionStoreDeps {
  workspacesDir: string;
  convWorkspaceMap: Map<string, string>;
  resolveWorkspaceId(ref: string): string | null;
  resolveWorkspaceStorageKey(ref: string): string | null;
  resolveWorkspace(ref: string): { workspaceId: string } | null;
  log?: {
    error(message: string, meta?: Record<string, unknown>): void;
  };
}

export class WorkspaceSessionStore {
  constructor(private readonly deps: WorkspaceSessionStoreDeps) {}

  workspaceDir(hash: string): string {
    return path.join(this.deps.workspacesDir, this.deps.resolveWorkspaceStorageKey(hash) || hash);
  }

  workspaceIndexPath(hash: string): string {
    return path.join(this.workspaceDir(hash), 'index.json');
  }

  workspaceContextDir(hash: string): string {
    return path.join(this.workspaceDir(hash), 'workspace-context');
  }

  sessionFilePath(hash: string, convId: string, sessionNumber: number): string {
    return path.join(this.workspaceDir(hash), convId, `session-${sessionNumber}.json`);
  }

  async readWorkspaceIndex(hash: string): Promise<WorkspaceIndex | null> {
    try {
      const data = await fsp.readFile(this.workspaceIndexPath(hash), 'utf8');
      return JSON.parse(data) as WorkspaceIndex;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async writeWorkspaceIndex(hash: string, index: WorkspaceIndex): Promise<void> {
    const dir = this.workspaceDir(hash);
    await fsp.mkdir(dir, { recursive: true });
    const record = this.deps.resolveWorkspace(hash);
    if (record) index.workspaceId = record.workspaceId;
    await atomicWriteFile(this.workspaceIndexPath(hash), JSON.stringify(index, null, 2));
  }

  async readSessionFile(hash: string, convId: string, sessionNumber: number): Promise<SessionFile | null> {
    try {
      const data = await fsp.readFile(this.sessionFilePath(hash, convId, sessionNumber), 'utf8');
      return JSON.parse(data) as SessionFile;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async writeSessionFile(hash: string, convId: string, sessionNumber: number, data: SessionFile): Promise<void> {
    const filePath = this.sessionFilePath(hash, convId, sessionNumber);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, JSON.stringify(data, null, 2));
  }

  async getConvFromIndex(convId: string): Promise<WorkspaceSessionLookupResult | null> {
    const hash = this.deps.convWorkspaceMap.get(convId);
    if (!hash) return null;
    const index = await this.readWorkspaceIndex(hash);
    if (!index) return null;
    const convEntry = index.conversations.find(c => c.id === convId);
    if (!convEntry) return null;
    return { hash, index, convEntry };
  }

  async rebuildConversationWorkspaceMap(): Promise<void> {
    this.deps.convWorkspaceMap.clear();
    let dirs: string[];
    try {
      dirs = await fsp.readdir(this.deps.workspacesDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const storageKey of dirs) {
      if (storageKey.startsWith('.')) continue;
      let index: WorkspaceIndex | null;
      try {
        index = await this.readWorkspaceIndex(storageKey);
      } catch (err) {
        this.deps.log?.error('Skipping workspace because index.json could not be read', {
          workspaceStorageKey: storageKey,
          error: err,
        });
        continue;
      }
      if (!index || !index.conversations) continue;
      const workspaceId = index.workspaceId || this.deps.resolveWorkspaceId(storageKey) || storageKey;
      for (const conv of index.conversations) {
        this.deps.convWorkspaceMap.set(conv.id, workspaceId);
      }
    }
  }
}
