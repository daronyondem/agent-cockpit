import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { WorkspaceKnowledgeStore } from '../src/services/chat/workspaceKnowledgeStore';

describe('WorkspaceKnowledgeStore', () => {
  let root: string;
  let store: WorkspaceKnowledgeStore;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'workspace-knowledge-store-'));
    store = new WorkspaceKnowledgeStore({
      getWorkspaceDir: (hash) => path.join(root, hash),
      resolveWorkspaceId: (ref) => ref === 'legacy-storage' ? 'workspace-1' : null,
      log: { warn: jest.fn() },
    });
  });

  afterEach(async () => {
    store.closeDatabases();
    await store.closeVectorStores();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('resolves the KB directory layout through canonical workspace identities', () => {
    expect(store.knowledgeDir('workspace-1')).toBe(path.join(root, 'workspace-1', 'knowledge'));
    expect(store.dbPath('workspace-1')).toBe(path.join(root, 'workspace-1', 'knowledge', 'state.db'));
    expect(store.legacyStatePath('workspace-1')).toBe(path.join(root, 'workspace-1', 'knowledge', 'state.json'));
    expect(store.rawDir('workspace-1')).toBe(path.join(root, 'workspace-1', 'knowledge', 'raw'));
    expect(store.convertedDir('workspace-1')).toBe(path.join(root, 'workspace-1', 'knowledge', 'converted'));
    expect(store.entriesDir('workspace-1')).toBe(path.join(root, 'workspace-1', 'knowledge', 'entries'));
    expect(store.synthesisDir('workspace-1')).toBe(path.join(root, 'workspace-1', 'knowledge', 'synthesis'));
    expect(store.vectorDir('workspace-1')).toBe(path.join(root, 'workspace-1', 'knowledge', 'vectors'));
  });

  it('opens, caches, and closes workspace KB databases', async () => {
    const first = store.getDb('legacy-storage');
    const second = store.getDb('workspace-1');

    expect(first).toBeTruthy();
    expect(second).toBe(first);
    const rawDirStat = await fsp.stat(store.rawDir('workspace-1'));
    expect(rawDirStat.isDirectory()).toBe(true);

    store.closeDatabases();
    const reopened = store.getDb('workspace-1');
    expect(reopened).toBeTruthy();
    expect(reopened).not.toBe(first);
  });

  it('returns null for empty DB and vector-store refs and tolerates missing vector stores on close', async () => {
    expect(store.getDb('')).toBeNull();
    await expect(store.getVectorStore('')).resolves.toBeNull();
    await expect(store.closeVectorStore('workspace-1')).resolves.toBeUndefined();
  });

  it('resets only the derived vector store directory', async () => {
    const vectorDir = store.vectorDir('workspace-1');
    const rawDir = store.rawDir('workspace-1');
    await fsp.mkdir(vectorDir, { recursive: true });
    await fsp.mkdir(rawDir, { recursive: true });
    await fsp.writeFile(path.join(vectorDir, 'PG_VERSION'), '17');
    await fsp.writeFile(path.join(rawDir, 'source.md'), 'source');

    await store.resetVectorStore('legacy-storage');

    await expect(fsp.stat(vectorDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.readFile(path.join(rawDir, 'source.md'), 'utf8')).resolves.toBe('source');
  });
});
