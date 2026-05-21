import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { atomicWriteFile } from '../../utils/atomicWrite';
import { KeyedMutex } from '../../utils/keyedMutex';
import type { WorkspaceIdentityRecord, WorkspaceIdentityRegistry, WorkspaceIndex } from '../../types';

const REGISTRY_SCHEMA_VERSION = 1;
const IDENTITY_LOCK_KEY = 'workspace-identity-registry';

function nowIso(): string {
  return new Date().toISOString();
}

function workspaceHash(workspacePath: string): string {
  return crypto.createHash('sha256').update(workspacePath).digest('hex').substring(0, 16);
}

function isWorkspaceId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizePathKey(value: string): string {
  return value.trim();
}

function normalizeRegistryRecord(value: unknown): WorkspaceIdentityRecord | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<WorkspaceIdentityRecord>;
  if (!isWorkspaceId(raw.workspaceId)) return null;
  if (typeof raw.storageKey !== 'string' || !raw.storageKey.trim()) return null;
  if (typeof raw.currentPath !== 'string' || !raw.currentPath.trim()) return null;
  const legacyHash = typeof raw.legacyHash === 'string' && raw.legacyHash.trim()
    ? raw.legacyHash.trim()
    : workspaceHash(raw.currentPath);
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt
    ? raw.createdAt
    : nowIso();
  const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt
    ? raw.updatedAt
    : createdAt;
  return {
    workspaceId: raw.workspaceId,
    storageKey: raw.storageKey.trim(),
    currentPath: raw.currentPath,
    legacyHash,
    previousPaths: Array.isArray(raw.previousPaths)
      ? raw.previousPaths.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [],
    createdAt,
    updatedAt,
  };
}

export class WorkspaceIdentityStore {
  private readonly registryPath: string;
  private readonly workspacesDir: string;
  private readonly lock = new KeyedMutex();
  private byId = new Map<string, WorkspaceIdentityRecord>();
  private byStorageKey = new Map<string, WorkspaceIdentityRecord>();
  private byLegacyHash = new Map<string, WorkspaceIdentityRecord>();
  private byPath = new Map<string, WorkspaceIdentityRecord>();

  constructor(opts: { registryPath: string; workspacesDir: string }) {
    this.registryPath = opts.registryPath;
    this.workspacesDir = opts.workspacesDir;
  }

  legacyHashForPath(workspacePath: string): string {
    return workspaceHash(workspacePath);
  }

  async initialize(): Promise<void> {
    const existing = await this.readRegistry();
    const existingRecords = new Map<string, WorkspaceIdentityRecord>();
    const records = new Map<string, WorkspaceIdentityRecord>();

    for (const record of existing) {
      existingRecords.set(record.workspaceId, record);
    }

    let dirs: fs.Dirent[] = [];
    try {
      dirs = await fsp.readdir(this.workspacesDir, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    let changed = false;
    for (const entry of dirs) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const storageKey = entry.name;
      const indexPath = path.join(this.workspacesDir, storageKey, 'index.json');
      let index: WorkspaceIndex;
      try {
        index = JSON.parse(await fsp.readFile(indexPath, 'utf8')) as WorkspaceIndex;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }

      const currentPath = typeof index.workspacePath === 'string' && index.workspacePath.trim()
        ? index.workspacePath
        : storageKey;
      const existingForIndex = isWorkspaceId(index.workspaceId) ? existingRecords.get(index.workspaceId) : null;
      const existingForStorage = [...existingRecords.values()].find(record => record.storageKey === storageKey);
      const workspaceId = existingForIndex?.workspaceId
        || existingForStorage?.workspaceId
        || (isWorkspaceId(index.workspaceId) ? index.workspaceId : crypto.randomUUID());
      const previous = existingForIndex || existingForStorage;
      const createdAt = previous?.createdAt || nowIso();
      const updatedAt = nowIso();
      const legacyHash = previous?.legacyHash || storageKey;
      const previousPaths = previous?.previousPaths || [];
      if (previous && previous.currentPath && previous.currentPath !== currentPath && !previousPaths.includes(previous.currentPath)) {
        previousPaths.push(previous.currentPath);
      }
      const record: WorkspaceIdentityRecord = {
        workspaceId,
        storageKey,
        currentPath,
        legacyHash,
        previousPaths,
        createdAt,
        updatedAt,
      };
      records.set(workspaceId, record);

      if (index.workspaceId !== workspaceId) {
        index.workspaceId = workspaceId;
        await atomicWriteFile(indexPath, JSON.stringify(index, null, 2));
        changed = true;
      }
      if (!previous || previous.storageKey !== storageKey || previous.currentPath !== currentPath) {
        changed = true;
      }
    }

    if (existing.length !== records.size) {
      changed = true;
    }
    this.rebuildMaps([...records.values()]);
    if (changed || !(await this.registryExists())) {
      await this.writeRegistry();
    }
  }

  resolve(ref: string | null | undefined): WorkspaceIdentityRecord | null {
    if (!ref) return null;
    return this.byId.get(ref)
      || this.byLegacyHash.get(ref)
      || this.byStorageKey.get(ref)
      || null;
  }

  resolveWorkspaceId(ref: string | null | undefined): string | null {
    return this.resolve(ref)?.workspaceId || null;
  }

  resolveStorageKey(ref: string | null | undefined): string | null {
    return this.resolve(ref)?.storageKey || null;
  }

  getByPath(workspacePath: string): WorkspaceIdentityRecord | null {
    return this.byPath.get(normalizePathKey(workspacePath)) || null;
  }

  async ensureWorkspaceForPath(workspacePath: string): Promise<WorkspaceIdentityRecord> {
    return this.lock.run(IDENTITY_LOCK_KEY, async () => {
      const existing = this.getByPath(workspacePath);
      if (existing) return existing;
      const timestamp = nowIso();
      const workspaceId = crypto.randomUUID();
      const legacyHash = workspaceHash(workspacePath);
      const record: WorkspaceIdentityRecord = {
        workspaceId,
        storageKey: legacyHash,
        currentPath: workspacePath,
        legacyHash,
        previousPaths: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.rebuildMaps([...this.byId.values(), record]);
      await this.writeRegistry();
      return record;
    });
  }

  async updateWorkspacePath(workspaceId: string, workspacePath: string): Promise<WorkspaceIdentityRecord | null> {
    return this.lock.run(IDENTITY_LOCK_KEY, async () => {
      const record = this.resolve(workspaceId);
      if (!record) return null;
      const nextPath = normalizePathKey(workspacePath);
      if (!nextPath) return null;
      if (record.currentPath === nextPath) return record;
      const existing = this.getByPath(nextPath);
      if (existing && existing.workspaceId !== record.workspaceId) {
        throw new WorkspaceIdentityPathConflictError(nextPath);
      }
      const next: WorkspaceIdentityRecord = {
        ...record,
        currentPath: nextPath,
        previousPaths: record.previousPaths.includes(record.currentPath)
          ? record.previousPaths
          : [...record.previousPaths, record.currentPath],
        updatedAt: nowIso(),
      };
      const records = [...this.byId.values()].map(item => item.workspaceId === next.workspaceId ? next : item);
      this.rebuildMaps(records);
      await this.writeRegistry();
      return next;
    });
  }

  list(): WorkspaceIdentityRecord[] {
    return [...this.byId.values()];
  }

  private async registryExists(): Promise<boolean> {
    try {
      await fsp.access(this.registryPath);
      return true;
    } catch {
      return false;
    }
  }

  private async readRegistry(): Promise<WorkspaceIdentityRecord[]> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.registryPath, 'utf8')) as Partial<WorkspaceIdentityRegistry>;
      if (!Array.isArray(parsed.workspaces)) return [];
      return parsed.workspaces
        .map(normalizeRegistryRecord)
        .filter((record): record is WorkspaceIdentityRecord => record !== null);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      if (err instanceof SyntaxError) return [];
      throw err;
    }
  }

  private async writeRegistry(): Promise<void> {
    const registry: WorkspaceIdentityRegistry = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      workspaces: this.list().sort((a, b) => a.currentPath.localeCompare(b.currentPath)),
    };
    await fsp.mkdir(path.dirname(this.registryPath), { recursive: true });
    await atomicWriteFile(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  }

  private rebuildMaps(records: WorkspaceIdentityRecord[]): void {
    this.byId = new Map();
    this.byStorageKey = new Map();
    this.byLegacyHash = new Map();
    this.byPath = new Map();
    for (const record of records) {
      this.byId.set(record.workspaceId, record);
      this.byStorageKey.set(record.storageKey, record);
      this.byLegacyHash.set(record.legacyHash, record);
      this.byPath.set(normalizePathKey(record.currentPath), record);
    }
  }
}

export class WorkspaceIdentityPathConflictError extends Error {
  constructor(readonly workspacePath: string) {
    super('Workspace path is already registered to another workspace');
    this.name = 'WorkspaceIdentityPathConflictError';
  }
}
