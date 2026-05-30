import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { WorkspaceMemoryStore } from '../src/services/chat/workspaceMemoryStore';
import type { MemorySnapshot } from '../src/types';

describe('WorkspaceMemoryStore', () => {
  let root: string;
  let store: WorkspaceMemoryStore;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'workspace-memory-store-'));
    store = new WorkspaceMemoryStore({
      getWorkspaceDir: (hash) => path.join(root, hash),
    });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('resolves memory paths and creates the files directory for pointer reads', async () => {
    expect(store.memoryDir('workspace-1')).toBe(path.join(root, 'workspace-1', 'memory'));
    expect(store.snapshotPath('workspace-1')).toBe(path.join(root, 'workspace-1', 'memory', 'snapshot.json'));
    expect(store.filesDir('workspace-1')).toBe(path.join(root, 'workspace-1', 'memory', 'files'));
    expect(await store.ensureFilesDir('workspace-1')).toBe(store.filesDir('workspace-1'));
    const stat = await fsp.stat(store.filesDir('workspace-1'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('reads and writes snapshots and metadata indexes', async () => {
    const snapshot: MemorySnapshot = {
      capturedAt: '2026-05-25T00:00:00.000Z',
      sourceBackend: 'memory-note',
      sourcePath: null,
      index: '',
      files: [],
    };

    await expect(store.readSnapshot('workspace-1')).resolves.toBeNull();
    await store.writeSnapshot('workspace-1', snapshot);
    await expect(store.readSnapshot('workspace-1')).resolves.toEqual(snapshot);

    await expect(store.readMetadataIndexFile('workspace-1')).resolves.toBeNull();
    await store.writeMetadataIndex('workspace-1', {
      version: 1,
      updatedAt: '2026-05-25T00:00:00.000Z',
      entries: {},
    });
    await expect(store.readMetadataIndexFile('workspace-1')).resolves.toMatchObject({ version: 1, entries: {} });
  });

  it('throws when persisted snapshot or metadata JSON is corrupt', async () => {
    await fsp.mkdir(store.memoryDir('workspace-1'), { recursive: true });
    await fsp.writeFile(store.snapshotPath('workspace-1'), '{not-json', 'utf8');
    await expect(store.readSnapshot('workspace-1')).rejects.toThrow();

    await fsp.writeFile(store.statePath('workspace-1'), '{not-json', 'utf8');
    await expect(store.readMetadataIndexFile('workspace-1')).rejects.toThrow();
  });

  it('writes consolidation audits under the memory audit directory', async () => {
    const relPath = await store.saveConsolidationAudit('workspace-1', {
      createdAt: '2026-05-25T00:00:00.000Z',
      summary: 'Reviewed memory',
      applied: [],
      skipped: [],
    });

    expect(relPath).toBe('audits/consolidation_2026-05-25T00-00-00-000Z.json');
    const raw = JSON.parse(await fsp.readFile(path.join(store.memoryDir('workspace-1'), relPath), 'utf8'));
    expect(raw).toMatchObject({
      version: 1,
      createdAt: '2026-05-25T00:00:00.000Z',
      summary: 'Reviewed memory',
    });
  });
});
