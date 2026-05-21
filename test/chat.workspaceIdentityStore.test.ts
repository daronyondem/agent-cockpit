import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  WorkspaceIdentityPathConflictError,
  WorkspaceIdentityStore,
} from '../src/services/chat/workspaceIdentityStore';
import { workspaceHash } from './helpers/workspace';

async function makeTempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ac-workspace-identity-'));
}

describe('WorkspaceIdentityStore', () => {
  test('migrates existing hash folders into stable workspace identities', async () => {
    const root = await makeTempRoot();
    const workspacesDir = path.join(root, 'workspaces');
    const workspacePath = '/tmp/ac-existing-workspace';
    const legacyHash = workspaceHash(workspacePath);
    await fs.mkdir(path.join(workspacesDir, legacyHash), { recursive: true });
    await fs.writeFile(
      path.join(workspacesDir, legacyHash, 'index.json'),
      JSON.stringify({ workspacePath, conversations: [] }, null, 2),
    );

    const store = new WorkspaceIdentityStore({
      registryPath: path.join(root, 'workspaces.json'),
      workspacesDir,
    });
    await store.initialize();

    const migratedIndex = JSON.parse(await fs.readFile(path.join(workspacesDir, legacyHash, 'index.json'), 'utf8'));
    expect(migratedIndex.workspaceId).toMatch(/[0-9a-f-]{36}/);
    const record = store.resolve(migratedIndex.workspaceId)!;
    expect(record.storageKey).toBe(legacyHash);
    expect(record.legacyHash).toBe(legacyHash);
    expect(record.currentPath).toBe(workspacePath);
    expect(store.resolve(legacyHash)?.workspaceId).toBe(migratedIndex.workspaceId);

    const registry = JSON.parse(await fs.readFile(path.join(root, 'workspaces.json'), 'utf8'));
    expect(registry.workspaces).toHaveLength(1);
    expect(registry.workspaces[0].workspaceId).toBe(migratedIndex.workspaceId);
  });

  test('rebuilds a corrupt registry from workspace indexes and drops stale records', async () => {
    const root = await makeTempRoot();
    const workspacesDir = path.join(root, 'workspaces');
    const workspacePath = '/tmp/ac-corrupt-registry';
    const legacyHash = workspaceHash(workspacePath);
    await fs.mkdir(path.join(workspacesDir, legacyHash), { recursive: true });
    await fs.writeFile(
      path.join(workspacesDir, legacyHash, 'index.json'),
      JSON.stringify({
        workspaceId: '11111111-1111-4111-8111-111111111111',
        workspacePath,
        conversations: [],
      }, null, 2),
    );
    await fs.writeFile(path.join(root, 'workspaces.json'), '{bad json');

    const store = new WorkspaceIdentityStore({
      registryPath: path.join(root, 'workspaces.json'),
      workspacesDir,
    });
    await store.initialize();

    expect(store.resolve('11111111-1111-4111-8111-111111111111')?.storageKey).toBe(legacyHash);
    const registry = JSON.parse(await fs.readFile(path.join(root, 'workspaces.json'), 'utf8'));
    expect(registry.workspaces).toHaveLength(1);
    expect(registry.workspaces[0].workspaceId).toBe('11111111-1111-4111-8111-111111111111');
  });

  test('creates new workspaces with stable IDs and legacy-hash storage keys', async () => {
    const root = await makeTempRoot();
    const workspacesDir = path.join(root, 'workspaces');
    await fs.mkdir(workspacesDir, { recursive: true });
    const store = new WorkspaceIdentityStore({
      registryPath: path.join(root, 'workspaces.json'),
      workspacesDir,
    });
    await store.initialize();

    const record = await store.ensureWorkspaceForPath('/tmp/ac-new-workspace');

    expect(record.workspaceId).toMatch(/[0-9a-f-]{36}/);
    expect(record.storageKey).toBe(workspaceHash('/tmp/ac-new-workspace'));
    expect(record.legacyHash).toBe(record.storageKey);
    expect(store.getByPath('/tmp/ac-new-workspace')?.workspaceId).toBe(record.workspaceId);
  });

  test('serializes concurrent creates for the same workspace path', async () => {
    const root = await makeTempRoot();
    const workspacesDir = path.join(root, 'workspaces');
    await fs.mkdir(workspacesDir, { recursive: true });
    const store = new WorkspaceIdentityStore({
      registryPath: path.join(root, 'workspaces.json'),
      workspacesDir,
    });
    await store.initialize();

    const records = await Promise.all(Array.from({ length: 10 }, () => (
      store.ensureWorkspaceForPath('/tmp/ac-concurrent-workspace')
    )));
    const workspaceIds = new Set(records.map(record => record.workspaceId));

    expect(workspaceIds.size).toBe(1);
    expect(store.list()).toHaveLength(1);
    const registry = JSON.parse(await fs.readFile(path.join(root, 'workspaces.json'), 'utf8'));
    expect(registry.workspaces).toHaveLength(1);
  });

  test('rejects remaps to a path owned by another workspace', async () => {
    const root = await makeTempRoot();
    const workspacesDir = path.join(root, 'workspaces');
    await fs.mkdir(workspacesDir, { recursive: true });
    const store = new WorkspaceIdentityStore({
      registryPath: path.join(root, 'workspaces.json'),
      workspacesDir,
    });
    await store.initialize();

    const first = await store.ensureWorkspaceForPath('/tmp/ac-first-workspace');
    const second = await store.ensureWorkspaceForPath('/tmp/ac-second-workspace');

    await expect(store.updateWorkspacePath(first.workspaceId, second.currentPath))
      .rejects
      .toBeInstanceOf(WorkspaceIdentityPathConflictError);
    expect(store.resolve(first.workspaceId)?.currentPath).toBe('/tmp/ac-first-workspace');
    expect(store.resolve(second.workspaceId)?.currentPath).toBe('/tmp/ac-second-workspace');
  });
});
