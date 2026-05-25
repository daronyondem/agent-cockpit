import {
  buildMessageWindow,
  collectPinnedMessages,
  ConversationMessageStore,
} from '../src/services/chat/conversationMessageStore';
import type { ConversationEntry, Message, SessionFile, WorkspaceIndex } from '../src/types';

function makeMessage(id: string, content: string, role: Message['role'] = 'user'): Message {
  return {
    id,
    role,
    content,
    backend: 'codex',
    timestamp: `2026-05-25T00:00:0${id.replace(/\D/g, '') || '0'}.000Z`,
  };
}

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
      messageCount: 0,
      startedAt: '2026-05-25T00:00:00.000Z',
      endedAt: null,
    }],
    ...overrides,
  };
}

function makeIndex(convEntry = makeConversation()): WorkspaceIndex {
  return {
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/project',
    conversations: [convEntry],
  };
}

describe('conversation message projections', () => {
  const messages = [
    makeMessage('m1', 'one'),
    { ...makeMessage('m2', 'two'), pinned: true },
    makeMessage('m3', 'three'),
    makeMessage('m4', 'four'),
    makeMessage('m5', 'five'),
  ];

  it('collects pinned messages with their source indexes', () => {
    expect(collectPinnedMessages(messages)).toEqual([
      { index: 1, message: messages[1] },
    ]);
  });

  it('builds tail, before, and around windows', () => {
    expect(buildMessageWindow(messages, { limit: 2 })).toMatchObject({
      messages: [messages[3], messages[4]],
      total: 5,
      startIndex: 3,
      endIndex: 5,
      hasOlder: true,
      hasNewer: false,
    });
    expect(buildMessageWindow(messages, { mode: 'before', beforeMessageId: 'm4', limit: 2 })).toMatchObject({
      messages: [messages[1], messages[2]],
      startIndex: 1,
      endIndex: 3,
    });
    expect(buildMessageWindow(messages, { mode: 'around', aroundMessageId: 'm3', beforeCount: 1, afterCount: 1 })).toMatchObject({
      messages: [messages[1], messages[2], messages[3]],
      startIndex: 1,
      endIndex: 4,
    });
    expect(buildMessageWindow(messages, { mode: 'before', beforeMessageId: 'missing' })).toBeNull();
  });

  it('handles empty windows and clamps oversized around windows', () => {
    expect(buildMessageWindow([])).toEqual({
      messages: [],
      total: 0,
      startIndex: 0,
      endIndex: 0,
      hasOlder: false,
      hasNewer: false,
    });

    const largeMessages = Array.from({ length: 600 }, (_, index) => makeMessage(`m${index}`, `message ${index}`));
    const window = buildMessageWindow(largeMessages, {
      mode: 'around',
      aroundMessageId: 'm500',
      beforeCount: 400,
      afterCount: 400,
    });

    expect(window?.messages).toHaveLength(500);
    expect(window).toMatchObject({
      total: 600,
      startIndex: 100,
      endIndex: 600,
      hasOlder: true,
      hasNewer: false,
    });
  });
});

describe('ConversationMessageStore', () => {
  let index: WorkspaceIndex;
  let convWorkspaceMap: Map<string, string>;
  let sessionFiles: Map<string, SessionFile>;
  let writes: string[];
  let nextId: number;

  beforeEach(() => {
    index = makeIndex();
    convWorkspaceMap = new Map([['conv-1', 'workspace-1']]);
    sessionFiles = new Map();
    writes = [];
    nextId = 1;
  });

  function sessionKey(hash: string, convId: string, sessionNumber: number): string {
    return `${hash}:${convId}:${sessionNumber}`;
  }

  function createStore(): ConversationMessageStore {
    return new ConversationMessageStore({
      convWorkspaceMap,
      indexLock: { run: async (_key, fn) => fn() },
      getConvFromIndex: async (convId) => {
        const hash = convWorkspaceMap.get(convId);
        if (!hash) return null;
        const convEntry = index.conversations.find(c => c.id === convId);
        return convEntry ? { hash, index, convEntry } : null;
      },
      readSessionFile: async (hash, convId, sessionNumber) => sessionFiles.get(sessionKey(hash, convId, sessionNumber)) || null,
      writeSessionFile: async (hash, convId, sessionNumber, data) => {
        sessionFiles.set(sessionKey(hash, convId, sessionNumber), data);
        writes.push(`session:${sessionNumber}`);
      },
      writeWorkspaceIndex: async () => {
        writes.push('index');
      },
      newId: () => `generated-${nextId++}`,
    });
  }

  it('appends messages, creates missing session files, and updates index metadata', async () => {
    index.conversations[0].title = 'New Chat';
    const store = createStore();

    const msg = await store.addMessage('conv-1', 'user', 'hello\nworld', '', null);

    expect(msg).toMatchObject({ id: 'generated-1', role: 'user', backend: 'codex', content: 'hello\nworld' });
    expect(index.conversations[0]).toMatchObject({
      title: 'hello world',
      lastMessage: 'hello\nworld',
    });
    expect(index.conversations[0].sessions[0].messageCount).toBe(1);
    expect(sessionFiles.get(sessionKey('workspace-1', 'conv-1', 1))?.messages).toMatchObject([
      { id: 'generated-1', content: 'hello\nworld' },
    ]);
    expect(writes).toEqual(['session:1', 'index']);
  });

  it('persists assistant-only message metadata when supplied', async () => {
    const store = createStore();
    const msg = await store.addMessage(
      'conv-1',
      'assistant',
      'answer',
      'codex',
      'thinking',
      [{ tool: 'shell', description: 'Shell', id: 'tool-1', duration: null, startTime: 1, status: 'done' }],
      'final',
      [{ type: 'text', content: 'answer' }],
      { streamError: { message: 'failed', source: 'backend' } },
    );

    expect(msg).toMatchObject({
      id: 'generated-1',
      role: 'assistant',
      thinking: 'thinking',
      toolActivity: [{ tool: 'shell', description: 'Shell' }],
      turn: 'final',
      contentBlocks: [{ type: 'text', content: 'answer' }],
      streamError: { message: 'failed' },
    });
  });

  it('edits by truncating from the edited message and appending replacement user input', async () => {
    sessionFiles.set(sessionKey('workspace-1', 'conv-1', 1), {
      sessionNumber: 1,
      sessionId: 'session-1',
      startedAt: '2026-05-25T00:00:00.000Z',
      endedAt: null,
      messages: [
        makeMessage('m1', 'first'),
        makeMessage('m2', 'old assistant', 'assistant'),
        makeMessage('m3', 'later'),
      ],
    });
    const store = createStore();

    const msg = await store.updateMessageContent('conv-1', 'm2', 'replacement');

    expect(msg).toMatchObject({ id: 'generated-1', role: 'user', content: 'replacement' });
    expect(sessionFiles.get(sessionKey('workspace-1', 'conv-1', 1))?.messages.map(m => m.content)).toEqual([
      'first',
      'replacement',
    ]);
    expect(index.conversations[0].sessions[0].messageCount).toBe(2);
    expect(index.conversations[0].lastMessage).toBe('replacement');
  });

  it('toggles pinned state and reads session history/messages', async () => {
    const message = makeMessage('m1', 'first');
    sessionFiles.set(sessionKey('workspace-1', 'conv-1', 1), {
      sessionNumber: 1,
      sessionId: 'session-1',
      startedAt: '2026-05-25T00:00:00.000Z',
      endedAt: null,
      messages: [message],
    });
    index.conversations[0].sessions.push({
      number: 0,
      sessionId: '',
      summary: 'Earlier work',
      active: false,
      messageCount: 3,
      startedAt: '2026-05-24T00:00:00.000Z',
      endedAt: '2026-05-24T01:00:00.000Z',
    });
    const store = createStore();

    await expect(store.setMessagePinned('conv-1', 'm1', true)).resolves.toMatchObject({ pinned: true });
    await expect(store.getSessionMessages('conv-1', 1)).resolves.toEqual([{ ...message, pinned: true }]);
    await expect(store.getSessionHistory('conv-1')).resolves.toMatchObject([
      { number: 1, sessionId: 'session-1', isCurrent: true },
      { number: 0, sessionId: null, summary: 'Earlier work', isCurrent: false },
    ]);
    const unpinned = await store.setMessagePinned('conv-1', 'm1', false);
    expect(unpinned?.pinned).toBeUndefined();
  });
});
