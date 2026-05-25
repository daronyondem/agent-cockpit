import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { ConversationLifecycleStore } from '../src/services/chat/conversationLifecycleStore';
import type { ConversationEntry, WorkspaceIndex } from '../src/types';

function makeConversation(overrides: Partial<ConversationEntry> = {}): ConversationEntry {
  return {
    id: 'conv-1',
    title: 'Conversation',
    backend: 'codex',
    currentSessionId: 'session-1',
    lastActivity: '2026-05-25T00:00:00.000Z',
    lastMessage: null,
    sessions: [{
      number: 1,
      sessionId: 'session-1',
      summary: null,
      active: true,
      messageCount: 2,
      startedAt: '2026-05-25T00:00:00.000Z',
      endedAt: null,
    }],
    ...overrides,
  };
}

function makeIndex(overrides: Partial<WorkspaceIndex> = {}): WorkspaceIndex {
  return {
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/project',
    conversations: [makeConversation()],
    ...overrides,
  };
}

describe('ConversationLifecycleStore', () => {
  let root: string;
  let indexes: Map<string, WorkspaceIndex>;
  let convWorkspaceMap: Map<string, string>;
  let writes: Array<{ hash: string; index: WorkspaceIndex }>;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'conversation-lifecycle-store-'));
    indexes = new Map<string, WorkspaceIndex>();
    convWorkspaceMap = new Map<string, string>();
    writes = [];
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function createWorkspace(storageKey: string, index: WorkspaceIndex): Promise<void> {
    await fsp.mkdir(path.join(root, storageKey), { recursive: true });
    indexes.set(storageKey, index);
    if (index.workspaceId) indexes.set(index.workspaceId, index);
    for (const conv of index.conversations) {
      convWorkspaceMap.set(conv.id, index.workspaceId || storageKey);
    }
  }

  function createStore(): ConversationLifecycleStore {
    return new ConversationLifecycleStore({
      workspacesDir: root,
      convWorkspaceMap,
      indexLock: { run: async (_key, fn) => fn() },
      readWorkspaceIndex: async (hash) => indexes.get(hash) || null,
      writeWorkspaceIndex: async (hash, index) => {
        indexes.set(hash, index);
        if (index.workspaceId) indexes.set(index.workspaceId, index);
        writes.push({ hash, index });
      },
      getConvFromIndex: async (convId) => {
        const hash = convWorkspaceMap.get(convId);
        if (!hash) return null;
        const index = indexes.get(hash);
        if (!index) return null;
        const convEntry = index.conversations.find(c => c.id === convId);
        return convEntry ? { hash, index, convEntry } : null;
      },
      resolveWorkspaceId: (ref) => ref === 'legacy-storage' ? 'workspace-1' : null,
      workspaceLegacyHashForRef: (ref) => ref === 'workspace-1' ? 'legacy-hash' : ref,
    });
  }

  it('lists active and archived conversations with workspace metadata sorted by activity', async () => {
    await createWorkspace('legacy-storage', makeIndex({
      kbEnabled: true,
      conversations: [
        makeConversation({
          id: 'older',
          title: 'Older',
          lastActivity: '2026-05-24T00:00:00.000Z',
        }),
        makeConversation({
          id: 'newer',
          title: 'Newer',
          lastActivity: '2026-05-25T01:00:00.000Z',
          checkout: { mode: 'worktree', executionDir: '/tmp/worktree', worktreeRoot: '/tmp/worktree', currentBranch: 'ac/newer' },
        }),
        makeConversation({
          id: 'archived',
          title: 'Archived',
          archived: true,
          lastActivity: '2026-05-23T00:00:00.000Z',
        }),
      ],
    }));

    const store = createStore();

    await expect(store.listConversations()).resolves.toMatchObject([
      {
        id: 'newer',
        title: 'Newer',
        workspaceId: 'workspace-1',
        workspaceHash: 'legacy-hash',
        workspaceKbEnabled: true,
        messageCount: 2,
        executionDir: '/tmp/worktree',
      },
      { id: 'older' },
    ]);
    await expect(store.listConversations({ archived: true })).resolves.toMatchObject([
      { id: 'archived', archived: true },
    ]);
  });

  it('falls back to identity resolution when listed indexes omit workspaceId', async () => {
    const index = makeIndex({
      workspaceId: undefined as unknown as string,
      conversations: [makeConversation({ id: 'conv-legacy' })],
    });
    await createWorkspace('legacy-storage', index);
    const store = createStore();

    await expect(store.listConversations()).resolves.toMatchObject([
      {
        id: 'conv-legacy',
        workspaceId: 'workspace-1',
        workspaceHash: 'legacy-hash',
      },
    ]);
  });

  it('returns an empty list when the workspaces directory is missing', async () => {
    const store = new ConversationLifecycleStore({
      workspacesDir: path.join(root, 'missing'),
      convWorkspaceMap,
      indexLock: { run: async (_key, fn) => fn() },
      readWorkspaceIndex: async () => null,
      writeWorkspaceIndex: async () => { throw new Error('unexpected write'); },
      getConvFromIndex: async () => null,
      resolveWorkspaceId: () => null,
      workspaceLegacyHashForRef: (ref) => ref,
    });

    await expect(store.listConversations()).resolves.toEqual([]);
  });

  it('renames, archives, restores, and toggles unread through the shared index boundary', async () => {
    const index = makeIndex({ conversations: [makeConversation({ messageQueue: [{ content: 'queued' }] })] });
    await createWorkspace('legacy-storage', index);
    const store = createStore();

    await expect(store.renameConversation('conv-1', 'Renamed')).resolves.toBe(true);
    expect(index.conversations[0]).toMatchObject({ title: 'Renamed', titleManuallySet: true });

    await expect(store.archiveConversation('conv-1')).resolves.toBe(true);
    expect(index.conversations[0].archived).toBe(true);
    expect(index.conversations[0].messageQueue).toBeUndefined();

    await expect(store.restoreConversation('conv-1')).resolves.toBe(true);
    expect(index.conversations[0].archived).toBeUndefined();

    const writeCountBeforeUnread = writes.length;
    await expect(store.setConversationUnread('conv-1', true)).resolves.toBe(true);
    expect(index.conversations[0].unread).toBe(true);
    await expect(store.setConversationUnread('conv-1', true)).resolves.toBe(true);
    expect(writes).toHaveLength(writeCountBeforeUnread + 1);

    await expect(store.setConversationUnread('conv-1', false)).resolves.toBe(true);
    expect(index.conversations[0].unread).toBeUndefined();
    await expect(store.renameConversation('missing', 'Nope')).resolves.toBe(false);
  });

  it('persists external session IDs on the active session only when changed', async () => {
    const index = makeIndex();
    await createWorkspace('legacy-storage', index);
    const store = createStore();

    await store.setExternalSessionId('conv-1', 'external-1');
    expect(index.conversations[0].sessions[0].externalSessionId).toBe('external-1');
    expect(writes).toHaveLength(1);

    await store.setExternalSessionId('conv-1', 'external-1');
    expect(writes).toHaveLength(1);
  });
});
