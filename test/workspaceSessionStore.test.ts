import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { WorkspaceSessionStore } from '../src/services/chat/workspaceSessionStore';
import type { WorkspaceIndex } from '../src/types';

async function makeTempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'workspace-session-store-'));
}

describe('WorkspaceSessionStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir();
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  function createStore(
    convWorkspaceMap = new Map<string, string>(),
    log: { error: jest.Mock } = { error: jest.fn() },
  ): WorkspaceSessionStore {
    return new WorkspaceSessionStore({
      workspacesDir: root,
      convWorkspaceMap,
      resolveWorkspaceId: (ref) => ref === 'legacy-storage' ? 'workspace-1' : null,
      resolveWorkspaceStorageKey: (ref) => ref === 'workspace-1' ? 'legacy-storage' : null,
      resolveWorkspace: (ref) => (ref === 'workspace-1' || ref === 'legacy-storage')
        ? { workspaceId: 'workspace-1' }
        : null,
      log,
    });
  }

  it('writes and reads workspace indexes through the resolved storage key', async () => {
    const store = createStore();
    const index: WorkspaceIndex = {
      workspaceId: 'stale-workspace-id',
      workspacePath: '/tmp/project',
      conversations: [],
    };

    await store.writeWorkspaceIndex('workspace-1', index);

    const raw = JSON.parse(await fsp.readFile(path.join(root, 'legacy-storage', 'index.json'), 'utf8'));
    expect(raw.workspaceId).toBe('workspace-1');
    await expect(store.readWorkspaceIndex('workspace-1')).resolves.toEqual(raw);
  });

  it('writes and reads session files below the workspace directory', async () => {
    const store = createStore();
    await store.writeSessionFile('workspace-1', 'conv-1', 2, {
      sessionNumber: 2,
      sessionId: 'session-2',
      startedAt: '2026-05-25T00:00:00.000Z',
      endedAt: null,
      messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: '2026-05-25T00:00:00.000Z', backend: 'codex' }],
    });

    await expect(store.readSessionFile('workspace-1', 'conv-1', 2)).resolves.toMatchObject({
      sessionNumber: 2,
      sessionId: 'session-2',
      messages: [{ id: 'm1', content: 'hello' }],
    });
  });

  it('rebuilds the conversation lookup map and skips corrupt workspace indexes', async () => {
    const convWorkspaceMap = new Map<string, string>();
    const log = { error: jest.fn() };
    const store = createStore(convWorkspaceMap, log);
    await fsp.mkdir(path.join(root, 'legacy-storage'), { recursive: true });
    await fsp.mkdir(path.join(root, 'bad-storage'), { recursive: true });
    await fsp.writeFile(path.join(root, 'bad-storage', 'index.json'), '{not-json', 'utf8');
    await fsp.writeFile(path.join(root, 'legacy-storage', 'index.json'), JSON.stringify({
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/project',
      conversations: [{ id: 'conv-1', title: 'One', sessions: [] }],
    }), 'utf8');

    await store.rebuildConversationWorkspaceMap();

    expect(convWorkspaceMap.get('conv-1')).toBe('workspace-1');
    expect(log.error).toHaveBeenCalledWith(
      'Skipping workspace because index.json could not be read',
      expect.objectContaining({ workspaceStorageKey: 'bad-storage' }),
    );
  });

  it('uses the workspace identity resolver when rebuilding indexes without workspaceId', async () => {
    const convWorkspaceMap = new Map<string, string>();
    const store = createStore(convWorkspaceMap);
    await fsp.mkdir(path.join(root, 'legacy-storage'), { recursive: true });
    await fsp.writeFile(path.join(root, 'legacy-storage', 'index.json'), JSON.stringify({
      workspacePath: '/tmp/project',
      conversations: [{ id: 'conv-1', title: 'One', sessions: [] }],
    }), 'utf8');

    await store.rebuildConversationWorkspaceMap();

    expect(convWorkspaceMap.get('conv-1')).toBe('workspace-1');
  });

  it('clears the conversation lookup map when the workspaces directory is missing', async () => {
    const missingRoot = path.join(root, 'missing');
    const convWorkspaceMap = new Map<string, string>([['stale-conv', 'workspace-1']]);
    const store = new WorkspaceSessionStore({
      workspacesDir: missingRoot,
      convWorkspaceMap,
      resolveWorkspaceId: () => null,
      resolveWorkspaceStorageKey: () => null,
      resolveWorkspace: () => null,
    });

    await store.rebuildConversationWorkspaceMap();

    expect(convWorkspaceMap.size).toBe(0);
  });

  it('looks up conversations through the rebuilt workspace map', async () => {
    const convWorkspaceMap = new Map<string, string>([['conv-1', 'workspace-1']]);
    const store = createStore(convWorkspaceMap);
    await store.writeWorkspaceIndex('workspace-1', {
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/project',
      conversations: [{ id: 'conv-1', title: 'One', backend: 'codex', currentSessionId: 'session-1', lastActivity: '2026-05-25T00:00:00.000Z', lastMessage: null, sessions: [] }],
    });

    await expect(store.getConvFromIndex('conv-1')).resolves.toMatchObject({
      hash: 'workspace-1',
      convEntry: { id: 'conv-1', title: 'One' },
    });
    await expect(store.getConvFromIndex('missing')).resolves.toBeNull();
  });
});
