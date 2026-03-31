const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { ChatService } = require('../src/services/chatService');

const DEFAULT_WORKSPACE = '/tmp/test-workspace';

let tmpDir;
let service;

function workspaceHash(p) {
  return crypto.createHash('sha256').update(p).digest('hex').substring(0, 16);
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatservice-'));
  service = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE });
  await service.initialize();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Conversation CRUD ────────────────────────────────────────────────────────

describe('createConversation', () => {
  test('creates with default title', async () => {
    const conv = await service.createConversation();
    expect(conv.title).toBe('New Chat');
    expect(conv.messages).toEqual([]);
    expect(conv.sessionNumber).toBe(1);
    expect(conv.currentSessionId).toBeDefined();
    expect(conv.backend).toBe('claude-code');
  });

  test('creates with custom title and working dir', async () => {
    const conv = await service.createConversation('My Chat', '/tmp/work');
    expect(conv.title).toBe('My Chat');
    expect(conv.workingDir).toBe('/tmp/work');
  });

  test('uses default workspace when no workingDir given', async () => {
    const conv = await service.createConversation('Test');
    expect(conv.workingDir).toBe(DEFAULT_WORKSPACE);
  });

  test('persists workspace index and session file to disk', async () => {
    const conv = await service.createConversation('Disk Test', '/tmp/work');
    const hash = workspaceHash('/tmp/work');
    const indexPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json');
    expect(fs.existsSync(indexPath)).toBe(true);
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    expect(index.workspacePath).toBe('/tmp/work');
    expect(index.conversations).toHaveLength(1);
    expect(index.conversations[0].title).toBe('Disk Test');

    const sessionPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, conv.id, 'session-1.json');
    expect(fs.existsSync(sessionPath)).toBe(true);
  });

  test('two conversations with same workingDir share workspace', async () => {
    const c1 = await service.createConversation('First', '/tmp/shared');
    const c2 = await service.createConversation('Second', '/tmp/shared');
    const hash = workspaceHash('/tmp/shared');
    const index = JSON.parse(fs.readFileSync(
      path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json'), 'utf8'
    ));
    expect(index.conversations).toHaveLength(2);
    expect(index.conversations.map(c => c.id).sort()).toEqual([c1.id, c2.id].sort());
  });
});

describe('getConversation', () => {
  test('returns null for non-existent id', async () => {
    expect(await service.getConversation('does-not-exist')).toBeNull();
  });

  test('returns the saved conversation with messages', async () => {
    const conv = await service.createConversation('Get Test');
    const loaded = await service.getConversation(conv.id);
    expect(loaded.id).toBe(conv.id);
    expect(loaded.title).toBe('Get Test');
    expect(loaded.messages).toEqual([]);
  });
});

describe('listConversations', () => {
  test('returns empty array when no conversations', async () => {
    expect(await service.listConversations()).toEqual([]);
  });

  test('returns summaries with most recently updated first', async () => {
    const c1 = await service.createConversation('First');
    const c2 = await service.createConversation('Second');

    await service.addMessage(c2.id, 'user', 'hello');

    const list = await service.listConversations();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(c2.id);
    expect(list[0].messageCount).toBe(1);
    expect(list[0].lastMessage).toBe('hello');
    expect(list[1].id).toBe(c1.id);
  });

  test('includes workingDir in listing', async () => {
    await service.createConversation('Test', '/tmp/myproject');
    const list = await service.listConversations();
    expect(list[0].workingDir).toBe('/tmp/myproject');
  });
});

describe('renameConversation', () => {
  test('renames and persists', async () => {
    const conv = await service.createConversation('Old Name');
    const updated = await service.renameConversation(conv.id, 'New Name');
    expect(updated.title).toBe('New Name');

    const loaded = await service.getConversation(conv.id);
    expect(loaded.title).toBe('New Name');
  });

  test('returns null for non-existent id', async () => {
    expect(await service.renameConversation('nope', 'Name')).toBeNull();
  });
});

describe('deleteConversation', () => {
  test('deletes existing conversation', async () => {
    const conv = await service.createConversation('Delete Me');
    expect(await service.deleteConversation(conv.id)).toBe(true);
    expect(await service.getConversation(conv.id)).toBeNull();
  });

  test('returns false for non-existent id', async () => {
    expect(await service.deleteConversation('nope')).toBe(false);
  });

  test('cleans up artifacts directory on delete', async () => {
    const conv = await service.createConversation('Artifact Cleanup');
    const artifactDir = path.join(tmpDir, 'data', 'chat', 'artifacts', conv.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'test.txt'), 'hello');

    expect(await service.deleteConversation(conv.id)).toBe(true);
    expect(fs.existsSync(artifactDir)).toBe(false);
  });

  test('cleans up session files on delete', async () => {
    const conv = await service.createConversation('Session Cleanup', '/tmp/work');
    await service.addMessage(conv.id, 'user', 'Hello');

    service._generateSessionSummary = async (msgs, fallback) => fallback;
    await service.resetSession(conv.id);

    const hash = workspaceHash('/tmp/work');
    const convDir = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, conv.id);
    expect(fs.existsSync(convDir)).toBe(true);

    expect(await service.deleteConversation(conv.id)).toBe(true);
    expect(fs.existsSync(convDir)).toBe(false);
  });

  test('removes conversation from workspace index', async () => {
    const c1 = await service.createConversation('Keep', '/tmp/shared');
    const c2 = await service.createConversation('Delete', '/tmp/shared');

    await service.deleteConversation(c2.id);

    const hash = workspaceHash('/tmp/shared');
    const index = JSON.parse(fs.readFileSync(
      path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json'), 'utf8'
    ));
    expect(index.conversations).toHaveLength(1);
    expect(index.conversations[0].id).toBe(c1.id);
  });
});

describe('updateConversationBackend', () => {
  test('updates backend in workspace index', async () => {
    const conv = await service.createConversation('Test');
    await service.updateConversationBackend(conv.id, 'openai');

    const loaded = await service.getConversation(conv.id);
    expect(loaded.backend).toBe('openai');
  });
});

// ── Messages ─────────────────────────────────────────────────────────────────

describe('addMessage', () => {
  test('appends message to conversation', async () => {
    const conv = await service.createConversation();
    const msg = await service.addMessage(conv.id, 'user', 'Hello');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Hello');
    expect(msg.id).toBeDefined();

    const loaded = await service.getConversation(conv.id);
    expect(loaded.messages).toHaveLength(1);
  });

  test('auto-titles from first user message', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'What is the meaning of life?');
    const loaded = await service.getConversation(conv.id);
    expect(loaded.title).toBe('What is the meaning of life?');
  });

  test('does not re-title on second user message', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'First question');
    await service.addMessage(conv.id, 'assistant', 'Answer');
    await service.addMessage(conv.id, 'user', 'Second question');
    const loaded = await service.getConversation(conv.id);
    expect(loaded.title).toBe('First question');
  });

  test('re-titles after session reset when title reverts to New Chat', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'First question');

    await service.renameConversation(conv.id, 'Custom Title');
    await service.addMessage(conv.id, 'user', 'Another question');
    const loaded = await service.getConversation(conv.id);
    expect(loaded.title).toBe('Custom Title');
  });

  test('returns null for non-existent conversation', async () => {
    expect(await service.addMessage('nope', 'user', 'hi')).toBeNull();
  });

  test('stores thinking field when provided', async () => {
    const conv = await service.createConversation();
    const msg = await service.addMessage(conv.id, 'assistant', 'Response text', 'claude-code', 'I need to think about this...');
    expect(msg.thinking).toBe('I need to think about this...');

    const loaded = await service.getConversation(conv.id);
    expect(loaded.messages[0].thinking).toBe('I need to think about this...');
  });

  test('persists thinking field to disk', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'assistant', 'Answer', 'claude-code', 'Thinking deeply');

    // Re-read from disk via a fresh service instance
    const service2 = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE });
    await service2.initialize();
    const loaded = await service2.getConversation(conv.id);
    expect(loaded.messages[0].thinking).toBe('Thinking deeply');
  });

  test('omits thinking field when not provided', async () => {
    const conv = await service.createConversation();
    const msg = await service.addMessage(conv.id, 'assistant', 'No thinking');
    expect(msg.thinking).toBeUndefined();

    const loaded = await service.getConversation(conv.id);
    expect(loaded.messages[0].thinking).toBeUndefined();
  });

  test('omits thinking field when null', async () => {
    const conv = await service.createConversation();
    const msg = await service.addMessage(conv.id, 'assistant', 'Null thinking', 'claude-code', null);
    expect(msg.thinking).toBeUndefined();
  });

  test('omits thinking field when empty string', async () => {
    const conv = await service.createConversation();
    const msg = await service.addMessage(conv.id, 'assistant', 'Empty thinking', 'claude-code', '');
    expect(msg.thinking).toBeUndefined();
  });

  test('updates lastActivity and lastMessage in workspace index', async () => {
    const conv = await service.createConversation('Test', '/tmp/idx');
    await service.addMessage(conv.id, 'user', 'Index check message');

    const hash = workspaceHash('/tmp/idx');
    const index = JSON.parse(fs.readFileSync(
      path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json'), 'utf8'
    ));
    expect(index.conversations[0].lastMessage).toBe('Index check message');
    expect(index.conversations[0].lastActivity).toBeDefined();
  });
});

describe('updateMessageContent', () => {
  test('forks conversation at edited message', async () => {
    const conv = await service.createConversation();
    const m1 = await service.addMessage(conv.id, 'user', 'Original');
    await service.addMessage(conv.id, 'assistant', 'Response');
    await service.addMessage(conv.id, 'user', 'Follow-up');

    const result = await service.updateMessageContent(conv.id, m1.id, 'Edited');
    expect(result.message.content).toBe('Edited');
    expect(result.conversation.messages).toHaveLength(1);
    expect(result.conversation.messages[0].content).toBe('Edited');
  });

  test('returns null for non-existent conversation', async () => {
    expect(await service.updateMessageContent('nope', 'mid', 'text')).toBeNull();
  });

  test('returns null for non-existent message', async () => {
    const conv = await service.createConversation();
    expect(await service.updateMessageContent(conv.id, 'nope', 'text')).toBeNull();
  });
});

// ── Session Management ───────────────────────────────────────────────────────

describe('resetSession', () => {
  beforeEach(() => {
    service._generateSessionSummary = async (msgs, fallback) => 'Test summary for session';
  });

  test('archives current session and starts new one', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'Hello');
    await service.addMessage(conv.id, 'assistant', 'Hi');

    const result = await service.resetSession(conv.id);
    expect(result.newSessionNumber).toBe(2);
    expect(result.archivedSession).toBeDefined();
    expect(result.archivedSession.summary).toBe('Test summary for session');
    expect(result.archivedSession.messageCount).toBe(2);

    const loaded = await service.getConversation(conv.id);
    expect(loaded.sessionNumber).toBe(2);
    expect(loaded.messages).toHaveLength(0);
  });

  test('creates session files on disk', async () => {
    const conv = await service.createConversation('Test', '/tmp/reset-test');
    await service.addMessage(conv.id, 'user', 'Hello');

    await service.resetSession(conv.id);

    const hash = workspaceHash('/tmp/reset-test');
    const convDir = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, conv.id);

    // Check session-1.json (archived)
    const session1 = JSON.parse(fs.readFileSync(path.join(convDir, 'session-1.json'), 'utf8'));
    expect(session1.messages).toHaveLength(1);
    expect(session1.messages[0].content).toBe('Hello');
    expect(session1.endedAt).toBeDefined();

    // Check session-2.json (new active)
    const session2 = JSON.parse(fs.readFileSync(path.join(convDir, 'session-2.json'), 'utf8'));
    expect(session2.messages).toHaveLength(0);

    // Check workspace index
    const index = JSON.parse(fs.readFileSync(
      path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json'), 'utf8'
    ));
    const convEntry = index.conversations.find(c => c.id === conv.id);
    expect(convEntry.sessions).toHaveLength(2);
    expect(convEntry.sessions[0].active).toBe(false);
    expect(convEntry.sessions[0].summary).toBe('Test summary for session');
    expect(convEntry.sessions[1].active).toBe(true);
  });

  test('multiple resets create sequential sessions', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'Session 1 msg');
    await service.resetSession(conv.id);

    await service.addMessage(conv.id, 'user', 'Session 2 msg');
    await service.resetSession(conv.id);

    const loaded = await service.getConversation(conv.id);
    expect(loaded.sessionNumber).toBe(3);
    expect(loaded.messages).toHaveLength(0);
  });

  test('returns null for non-existent conversation', async () => {
    expect(await service.resetSession('nope')).toBeNull();
  });
});

describe('getSessionHistory', () => {
  beforeEach(() => {
    service._generateSessionSummary = async (msgs, fallback) => 'Test summary';
  });

  test('returns current session when no archives', async () => {
    const conv = await service.createConversation();
    const sessions = await service.getSessionHistory(conv.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].isCurrent).toBe(true);
    expect(sessions[0].number).toBe(1);
  });

  test('returns archived sessions plus current', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'Hello');
    await service.resetSession(conv.id);

    const sessions = await service.getSessionHistory(conv.id);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].isCurrent).toBe(false);
    expect(sessions[0].summary).toBe('Test summary');
    expect(sessions[1].isCurrent).toBe(true);
    expect(sessions[1].number).toBe(2);
  });

  test('returns null for non-existent conversation', async () => {
    expect(await service.getSessionHistory('nope')).toBeNull();
  });
});

describe('getSessionMessages', () => {
  beforeEach(() => {
    service._generateSessionSummary = async (msgs, fallback) => 'Test summary';
  });

  test('returns current session messages', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'Hello');
    await service.addMessage(conv.id, 'assistant', 'Hi');

    const messages = await service.getSessionMessages(conv.id, conv.sessionNumber);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Hello');
  });

  test('returns archived session messages', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'Old msg');
    await service.resetSession(conv.id);

    const messages = await service.getSessionMessages(conv.id, 1);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Old msg');
  });

  test('returns null for non-existent session', async () => {
    const conv = await service.createConversation();
    const messages = await service.getSessionMessages(conv.id, 99);
    expect(messages).toBeNull();
  });

  test('returns null for non-existent conversation', async () => {
    expect(await service.getSessionMessages('nope', 1)).toBeNull();
  });
});

// ── Markdown Export ──────────────────────────────────────────────────────────

describe('conversationToMarkdown', () => {
  beforeEach(() => {
    service._generateSessionSummary = async (msgs, fallback) => 'Test summary';
  });

  test('exports conversation as markdown', async () => {
    const conv = await service.createConversation('Export Test');
    await service.addMessage(conv.id, 'user', 'Hello');
    await service.addMessage(conv.id, 'assistant', 'Hi there');

    const md = await service.conversationToMarkdown(conv.id);
    expect(md).toContain('# Export Test');
    expect(md).toContain('Hello');
    expect(md).toContain('Hi there');
    expect(md).toContain('User');
    expect(md).toContain('Assistant');
  });

  test('includes archived sessions', async () => {
    const conv = await service.createConversation('Session Test');
    await service.addMessage(conv.id, 'user', 'Before reset');
    await service.resetSession(conv.id);
    await service.addMessage(conv.id, 'user', 'After reset');

    const md = await service.conversationToMarkdown(conv.id);
    expect(md).toContain('Before reset');
    expect(md).toContain('After reset');
    expect(md).toContain('Session 1');
    expect(md).toContain('Session 2 (current)');
  });

  test('returns null for non-existent conversation', async () => {
    expect(await service.conversationToMarkdown('nope')).toBeNull();
  });
});

describe('sessionToMarkdown', () => {
  beforeEach(() => {
    service._generateSessionSummary = async (msgs, fallback) => 'Test summary';
  });

  test('exports current session as markdown', async () => {
    const conv = await service.createConversation('MD Test');
    await service.addMessage(conv.id, 'user', 'Hello');
    await service.addMessage(conv.id, 'assistant', 'Hi there');

    const md = await service.sessionToMarkdown(conv.id, conv.sessionNumber);
    expect(md).toContain('User');
    expect(md).toContain('Hello');
    expect(md).toContain('Hi there');
  });

  test('exports archived session as markdown', async () => {
    const conv = await service.createConversation('MD Test');
    await service.addMessage(conv.id, 'user', 'Old msg');
    await service.resetSession(conv.id);

    const md = await service.sessionToMarkdown(conv.id, 1);
    expect(md).toContain('Old msg');
    expect(md).toContain('Session 1');
  });

  test('returns null for non-existent session', async () => {
    const conv = await service.createConversation('MD Test');
    expect(await service.sessionToMarkdown(conv.id, 99)).toBeNull();
  });
});

// ── Workspace Context ────────────────────────────────────────────────────────

describe('getWorkspaceContext', () => {
  test('returns injection prompt with workspace path', async () => {
    const conv = await service.createConversation('Test', '/tmp/ctx-test');
    const ctx = service.getWorkspaceContext(conv.id);
    expect(ctx).toContain('Workspace discussion history');
    const hash = workspaceHash('/tmp/ctx-test');
    expect(ctx).toContain(hash);
    expect(ctx).toContain('index.json');
  });

  test('returns null for non-existent conversation', () => {
    expect(service.getWorkspaceContext('nope')).toBeNull();
  });
});

// ── Migration ───────────────────────────────────────────────────────────────

describe('migration from legacy format', () => {
  test('migrates conversations to workspace format', async () => {
    // Set up legacy directory structure
    const convDir = path.join(tmpDir, 'data', 'chat', 'conversations');
    fs.mkdirSync(convDir, { recursive: true });

    const convId = crypto.randomUUID();
    const conv = {
      id: convId,
      title: 'Legacy Conv',
      backend: 'claude-code',
      workingDir: '/tmp/legacy-project',
      currentSessionId: 'sess-1',
      sessionNumber: 1,
      updatedAt: '2024-06-01T00:00:00Z',
      messages: [
        { id: 'm1', role: 'user', content: 'Hello', backend: 'claude-code', timestamp: '2024-06-01T00:00:00Z' },
        { id: 'm2', role: 'assistant', content: 'Hi', backend: 'claude-code', timestamp: '2024-06-01T00:01:00Z' },
      ],
    };
    fs.writeFileSync(path.join(convDir, `${convId}.json`), JSON.stringify(conv, null, 2));

    // Create fresh service and initialize (triggers migration)
    const svc = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE });
    await svc.initialize();

    // Old dir should be renamed to backup
    expect(fs.existsSync(convDir)).toBe(false);
    expect(fs.existsSync(convDir + '_backup')).toBe(true);

    // Should be able to load the conversation
    const loaded = await svc.getConversation(convId);
    expect(loaded).not.toBeNull();
    expect(loaded.title).toBe('Legacy Conv');
    expect(loaded.messages).toHaveLength(2);

    // Workspace index should exist
    const hash = workspaceHash('/tmp/legacy-project');
    const indexPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json');
    expect(fs.existsSync(indexPath)).toBe(true);
  });

  test('migrates conversations with archived sessions', async () => {
    const convDir = path.join(tmpDir, 'data', 'chat', 'conversations');
    const archivesDir = path.join(tmpDir, 'data', 'chat', 'archives');
    fs.mkdirSync(convDir, { recursive: true });

    const convId = crypto.randomUUID();

    // Conversation file (current session 2)
    const conv = {
      id: convId,
      title: 'Archived Conv',
      backend: 'claude-code',
      workingDir: '/tmp/archived-project',
      currentSessionId: 'sess-2',
      sessionNumber: 2,
      updatedAt: '2024-06-02T00:00:00Z',
      messages: [
        { id: 'm3', role: 'user', content: 'New session msg', backend: 'claude-code', timestamp: '2024-06-02T00:00:00Z' },
      ],
    };
    fs.writeFileSync(path.join(convDir, `${convId}.json`), JSON.stringify(conv, null, 2));

    // Archive files
    const archiveConvDir = path.join(archivesDir, convId);
    fs.mkdirSync(archiveConvDir, { recursive: true });

    const archiveIndex = {
      conversationId: convId,
      conversationTitle: 'Archived Conv',
      sessions: [{
        number: 1,
        file: 'session-1.json',
        sessionId: 'sess-1',
        startedAt: '2024-06-01T00:00:00Z',
        endedAt: '2024-06-01T12:00:00Z',
        messageCount: 2,
        summary: 'Discussed the project setup',
      }],
    };
    fs.writeFileSync(path.join(archiveConvDir, 'index.json'), JSON.stringify(archiveIndex, null, 2));

    const session1 = {
      sessionNumber: 1,
      sessionId: 'sess-1',
      startedAt: '2024-06-01T00:00:00Z',
      endedAt: '2024-06-01T12:00:00Z',
      messages: [
        { id: 'm1', role: 'user', content: 'Old msg 1', backend: 'claude-code', timestamp: '2024-06-01T00:00:00Z' },
        { id: 'm2', role: 'assistant', content: 'Old reply', backend: 'claude-code', timestamp: '2024-06-01T00:01:00Z' },
      ],
    };
    fs.writeFileSync(path.join(archiveConvDir, 'session-1.json'), JSON.stringify(session1, null, 2));

    // Initialize
    const svc = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE });
    await svc.initialize();

    // Verify migration
    expect(fs.existsSync(convDir)).toBe(false);
    expect(fs.existsSync(archivesDir)).toBe(false);

    const loaded = await svc.getConversation(convId);
    expect(loaded.title).toBe('Archived Conv');
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.sessionNumber).toBe(2);

    // Verify archived session is accessible
    const sessions = await svc.getSessionHistory(convId);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].summary).toBe('Discussed the project setup');
    expect(sessions[0].isCurrent).toBe(false);
    expect(sessions[1].isCurrent).toBe(true);

    // Verify archived messages are accessible
    const archivedMsgs = await svc.getSessionMessages(convId, 1);
    expect(archivedMsgs).toHaveLength(2);
    expect(archivedMsgs[0].content).toBe('Old msg 1');
  });

  test('migrates legacy sessions with dividers', async () => {
    const convDir = path.join(tmpDir, 'data', 'chat', 'conversations');
    fs.mkdirSync(convDir, { recursive: true });

    const convId = crypto.randomUUID();
    const conv = {
      id: convId,
      title: 'Divider Conv',
      backend: 'claude-code',
      workingDir: '/tmp/divider',
      currentSessionId: 'sess-2',
      sessionNumber: 2,
      updatedAt: '2024-06-02T00:00:00Z',
      sessions: [
        { number: 1, sessionId: 'sess-1', startedAt: '2024-06-01T00:00:00Z', endedAt: '2024-06-01T12:00:00Z', messageCount: 2 },
        { number: 2, sessionId: 'sess-2', startedAt: '2024-06-02T00:00:00Z', endedAt: null, messageCount: 1 },
      ],
      messages: [
        { id: 'm1', role: 'user', content: 'Session 1 msg', backend: 'claude-code', timestamp: '2024-06-01T00:00:00Z' },
        { id: 'm2', role: 'assistant', content: 'Reply', backend: 'claude-code', timestamp: '2024-06-01T00:01:00Z' },
        { id: 'div1', role: 'system', content: 'Session reset', isSessionDivider: true, timestamp: '2024-06-01T12:00:00Z' },
        { id: 'm3', role: 'user', content: 'Session 2 msg', backend: 'claude-code', timestamp: '2024-06-02T00:00:00Z' },
      ],
    };
    fs.writeFileSync(path.join(convDir, `${convId}.json`), JSON.stringify(conv, null, 2));

    const svc = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE });
    await svc.initialize();

    const loaded = await svc.getConversation(convId);
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0].content).toBe('Session 2 msg');
    expect(loaded.sessionNumber).toBe(2);

    const archivedMsgs = await svc.getSessionMessages(convId, 1);
    expect(archivedMsgs).toHaveLength(2);
    expect(archivedMsgs[0].content).toBe('Session 1 msg');
  });

  test('groups conversations by workspace during migration', async () => {
    const convDir = path.join(tmpDir, 'data', 'chat', 'conversations');
    fs.mkdirSync(convDir, { recursive: true });

    const conv1 = {
      id: crypto.randomUUID(),
      title: 'Same WS 1',
      backend: 'claude-code',
      workingDir: '/tmp/shared-ws',
      currentSessionId: 's1',
      sessionNumber: 1,
      updatedAt: '2024-06-01T00:00:00Z',
      messages: [],
    };
    const conv2 = {
      id: crypto.randomUUID(),
      title: 'Same WS 2',
      backend: 'claude-code',
      workingDir: '/tmp/shared-ws',
      currentSessionId: 's2',
      sessionNumber: 1,
      updatedAt: '2024-06-02T00:00:00Z',
      messages: [],
    };
    fs.writeFileSync(path.join(convDir, `${conv1.id}.json`), JSON.stringify(conv1, null, 2));
    fs.writeFileSync(path.join(convDir, `${conv2.id}.json`), JSON.stringify(conv2, null, 2));

    const svc = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE });
    await svc.initialize();

    const hash = workspaceHash('/tmp/shared-ws');
    const index = JSON.parse(fs.readFileSync(
      path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json'), 'utf8'
    ));
    expect(index.conversations).toHaveLength(2);
  });

  test('does not error on empty conversations directory', async () => {
    const convDir = path.join(tmpDir, 'data', 'chat', 'conversations');
    fs.mkdirSync(convDir, { recursive: true });

    const svc = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE });
    await expect(svc.initialize()).resolves.not.toThrow();
    expect(fs.existsSync(convDir)).toBe(false); // renamed to _backup
  });
});

// ── Search ───────────────────────────────────────────────────────────────────

describe('searchConversations', () => {
  test('finds by title', async () => {
    await service.createConversation('Unique Alpha Title');
    await service.createConversation('Other');

    const results = await service.searchConversations('alpha');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Unique Alpha Title');
  });

  test('finds by message content', async () => {
    const conv = await service.createConversation('Chat');
    await service.addMessage(conv.id, 'user', 'The zebra crossed the road');

    const results = await service.searchConversations('zebra');
    expect(results).toHaveLength(1);
  });

  test('returns all when query is empty', async () => {
    await service.createConversation('A');
    await service.createConversation('B');

    const results = await service.searchConversations('');
    expect(results).toHaveLength(2);
  });
});

// ── Settings ─────────────────────────────────────────────────────────────────

describe('settings', () => {
  test('returns defaults when no settings file', async () => {
    const settings = await service.getSettings();
    expect(settings.theme).toBe('system');
    expect(settings.sendBehavior).toBe('enter');
    expect(settings.defaultBackend).toBe('claude-code');
    expect(settings.systemPrompt).toBe('');
    expect(settings.customInstructions).toBeUndefined();
  });

  test('saves and retrieves settings', async () => {
    const input = { theme: 'dark', sendBehavior: 'ctrl-enter', systemPrompt: 'Be helpful' };
    await service.saveSettings(input);

    const loaded = await service.getSettings();
    expect(loaded.theme).toBe('dark');
    expect(loaded.sendBehavior).toBe('ctrl-enter');
    expect(loaded.systemPrompt).toBe('Be helpful');
  });

  test('migrates legacy customInstructions to systemPrompt', async () => {
    const legacy = {
      theme: 'dark',
      sendBehavior: 'enter',
      customInstructions: { aboutUser: 'I am a developer', responseStyle: 'Be concise' },
      defaultBackend: 'claude-code',
    };
    await service.saveSettings(legacy);

    const loaded = await service.getSettings();
    expect(loaded.systemPrompt).toBe('I am a developer\n\nBe concise');
    expect(loaded.customInstructions).toBeUndefined();

    // Verify migration was persisted
    const reloaded = await service.getSettings();
    expect(reloaded.systemPrompt).toBe('I am a developer\n\nBe concise');
  });

  test('migrates partial customInstructions gracefully', async () => {
    const legacy = {
      theme: 'system',
      customInstructions: { aboutUser: '', responseStyle: 'Use bullet points' },
    };
    await service.saveSettings(legacy);

    const loaded = await service.getSettings();
    expect(loaded.systemPrompt).toBe('Use bullet points');
    expect(loaded.customInstructions).toBeUndefined();
  });
});
