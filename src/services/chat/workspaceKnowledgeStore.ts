import fs from 'fs';
import path from 'path';
import { openKbDatabase, type KbDatabase } from '../knowledgeBase/db';
import { KbVectorStore } from '../knowledgeBase/vectorStore';

interface WorkspaceKnowledgeStoreDeps {
  getWorkspaceDir(hash: string): string;
  resolveWorkspaceId(ref: string): string | null;
  log?: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

export class WorkspaceKnowledgeStore {
  private readonly dbs = new Map<string, KbDatabase>();
  private readonly vectorStores = new Map<string, KbVectorStore>();

  constructor(private readonly deps: WorkspaceKnowledgeStoreDeps) {}

  knowledgeDir(hash: string): string {
    return path.join(this.deps.getWorkspaceDir(hash), 'knowledge');
  }

  dbPath(hash: string): string {
    return path.join(this.knowledgeDir(hash), 'state.db');
  }

  legacyStatePath(hash: string): string {
    return path.join(this.knowledgeDir(hash), 'state.json');
  }

  rawDir(hash: string): string {
    return path.join(this.knowledgeDir(hash), 'raw');
  }

  convertedDir(hash: string): string {
    return path.join(this.knowledgeDir(hash), 'converted');
  }

  entriesDir(hash: string): string {
    return path.join(this.knowledgeDir(hash), 'entries');
  }

  synthesisDir(hash: string): string {
    return path.join(this.knowledgeDir(hash), 'synthesis');
  }

  getDb(hash: string): KbDatabase | null {
    if (!hash) return null;
    const workspaceId = this.deps.resolveWorkspaceId(hash) || hash;
    const cached = this.dbs.get(workspaceId);
    if (cached) return cached;
    fs.mkdirSync(this.knowledgeDir(workspaceId), { recursive: true });
    fs.mkdirSync(this.rawDir(workspaceId), { recursive: true });
    const db = openKbDatabase({
      dbPath: this.dbPath(workspaceId),
      legacyJsonPath: this.legacyStatePath(workspaceId),
      rawDir: this.rawDir(workspaceId),
    });
    this.dbs.set(workspaceId, db);
    return db;
  }

  closeDatabases(): void {
    for (const [hash, db] of this.dbs.entries()) {
      try {
        db.close();
      } catch (err: unknown) {
        this.deps.log?.warn('Failed to close KB database', { workspaceHash: hash, error: err });
      }
    }
    this.dbs.clear();
  }

  async getVectorStore(hash: string, dimensions?: number): Promise<KbVectorStore | null> {
    if (!hash) return null;
    const workspaceId = this.deps.resolveWorkspaceId(hash) || hash;
    const cached = this.vectorStores.get(workspaceId);
    if (cached) return cached;
    const knowledgeDir = this.knowledgeDir(workspaceId);
    fs.mkdirSync(knowledgeDir, { recursive: true });
    const store = new KbVectorStore(knowledgeDir, dimensions);
    await store.ready();
    this.vectorStores.set(workspaceId, store);
    return store;
  }

  async closeVectorStore(hash: string): Promise<void> {
    const workspaceId = this.deps.resolveWorkspaceId(hash) || hash;
    const store = this.vectorStores.get(workspaceId);
    if (!store) return;
    try {
      await store.close();
    } catch (err: unknown) {
      this.deps.log?.warn('Failed to close KB vector store', { workspaceHash: workspaceId, error: err });
    } finally {
      this.vectorStores.delete(workspaceId);
    }
  }

  async closeVectorStores(): Promise<void> {
    for (const hash of [...this.vectorStores.keys()]) {
      await this.closeVectorStore(hash);
    }
    this.vectorStores.clear();
  }
}
