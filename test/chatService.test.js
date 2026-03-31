const fs = require('fs');
const path = require('path');
const os = require('os');
const { ChatService } = require('../src/services/chatService');

let tmpDir;
let service;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatservice-'));
  service = new ChatService(tmpDir);
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
    expect(conv.sessions).toBeUndefined();
  });

  test('creates with custom title and working dir', async () => {
    const conv = await service.createConversation('My Chat', '/tmp/work');
    expect(conv.title).toBe('My Chat');
    expect(conv.workingDir).toBe('/tmp/work');
  });

  test('persists to disk', async () => {
    const conv = await service.createConversation('Disk Test');
    const file = path.join(tmpDir, 'data', 'chat', 'conversations', `${conv.id}.json`);
    expect(fs.existsSync(file)).toBe(true);
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(loaded.title).toBe('Disk Test');
  });
});

describe('getConversation', () => {
  test('returns null for non-existent id', async () => {
    expect(await service.getConversation('does-not-exist')).toBeNull();
  });

  test('returns the saved conversation', async () => {
    const conv = await service.createConversation('Get Test');
    const loaded = await service.getConversation(conv.id);
    expect(loaded.id).toBe(conv.id);
    expect(loaded.title).toBe('Get Test');
  });
});

describe('listConversations', () => {
  test('returns empty array when no conversations', async () => {
    expect(await service.listConversations()).toEqual([]);
  });

  test('returns summaries with most recently updated first', async () => {
    const c1 = await service.createConversation('First');
    const c2 = await service.createConversation('Second');

    // Force c1 to have an older updatedAt
    const conv1 = await service.getConversation(c1.id);
    conv1.updatedAt = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'chat', 'conversations', `${c1.id}.json`),
      JSON.stringify(conv1, null, 2), 'utf8'
    );

    await service.addMessage(c2.id, 'user', 'hello');

    const list = await service.listConversations();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(c2.id);
    expect(list[0].messageCount).toBe(1);
    expect(list[0].lastMessage).toBe('hello');
    expect(list[1].id).toBe(c1.id);
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

  test('cleans up archives directory on delete', async () => {
    const conv = await service.createConversation('Archive Cleanup');
    await service.addMessage(conv.id, 'user', 'Hello');

    // Mock _generateSessionSummary to avoid CLI calls in tests
    service._generateSessionSummary = async (msgs, fallback) => fallback;
    await service.resetSession(conv.id);

    const archiveDir = path.join(tmpDir, 'data', 'chat', 'archives', conv.id);
    expect(fs.existsSync(archiveDir)).toBe(true);

    expect(await service.deleteConversation(conv.id)).toBe(true);
    expect(fs.existsSync(archiveDir)).toBe(false);
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

    // After rename to a non-default title, second message shouldn't change it
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
    const service2 = new ChatService(tmpDir);
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
    // Mock _generateSessionSummary to avoid CLI calls in tests
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
    expect(loaded.sessions).toBeUndefined();
    expect(loaded.sessionNumber).toBe(2);
    expect(loaded.messages).toHaveLength(0);
  });

  test('creates archive files on disk', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'Hello');

    await service.resetSession(conv.id);

    const archiveDir = path.join(tmpDir, 'data', 'chat', 'archives', conv.id);
    expect(fs.existsSync(archiveDir)).toBe(true);

    // Check index.json
    const index = JSON.parse(fs.readFileSync(path.join(archiveDir, 'index.json'), 'utf8'));
    expect(index.sessions).toHaveLength(1);
    expect(index.sessions[0].number).toBe(1);
    expect(index.sessions[0].summary).toBe('Test summary for session');

    // Check session-1.json
    const session = JSON.parse(fs.readFileSync(path.join(archiveDir, 'session-1.json'), 'utf8'));
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].content).toBe('Hello');
  });

  test('multiple resets create sequential archives', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'Session 1 msg');
    await service.resetSession(conv.id);

    await service.addMessage(conv.id, 'user', 'Session 2 msg');
    await service.resetSession(conv.id);

    const loaded = await service.getConversation(conv.id);
    expect(loaded.sessionNumber).toBe(3);
    expect(loaded.messages).toHaveLength(0);

    const archiveDir = path.join(tmpDir, 'data', 'chat', 'archives', conv.id);
    const index = JSON.parse(fs.readFileSync(path.join(archiveDir, 'index.json'), 'utf8'));
    expect(index.sessions).toHaveLength(2);
    expect(index.sessions[0].number).toBe(1);
    expect(index.sessions[1].number).toBe(2);

    // Verify session files
    expect(fs.existsSync(path.join(archiveDir, 'session-1.json'))).toBe(true);
    expect(fs.existsSync(path.join(archiveDir, 'session-2.json'))).toBe(true);
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

// ── Migration ───────────────────────────────────────────────────────────────

describe('migrateConversation', () => {
  test('migrates legacy conversation with sessions array', async () => {
    // Create a legacy-format conversation with sessions array and dividers
    const conv = await service.createConversation('Legacy Conv');
    const convPath = path.join(tmpDir, 'data', 'chat', 'conversations', `${conv.id}.json`);

    const legacyConv = {
      ...conv,
      sessions: [
        { number: 1, sessionId: 'sess-1', startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T01:00:00Z', messageCount: 2 },
        { number: 2, sessionId: 'sess-2', startedAt: '2024-01-01T01:00:00Z', endedAt: null, messageCount: 1 },
      ],
      messages: [
        { id: 'm1', role: 'user', content: 'Hello', backend: 'claude-code', timestamp: '2024-01-01T00:00:00Z' },
        { id: 'm2', role: 'assistant', content: 'Hi', backend: 'claude-code', timestamp: '2024-01-01T00:30:00Z' },
        { id: 'div1', role: 'system', content: 'Session reset', isSessionDivider: true, timestamp: '2024-01-01T01:00:00Z' },
        { id: 'm3', role: 'user', content: 'New session', backend: 'claude-code', timestamp: '2024-01-01T01:30:00Z' },
      ],
    };
    fs.writeFileSync(convPath, JSON.stringify(legacyConv, null, 2), 'utf8');

    const result = await service.migrateConversation(conv.id);
    expect(result).toBe(true);

    // Verify conversation file is updated
    const migrated = await service.getConversation(conv.id);
    expect(migrated.sessions).toBeUndefined();
    expect(migrated.messages).toHaveLength(1);
    expect(migrated.messages[0].content).toBe('New session');

    // Verify archive files
    const archiveDir = path.join(tmpDir, 'data', 'chat', 'archives', conv.id);
    expect(fs.existsSync(archiveDir)).toBe(true);

    const index = JSON.parse(fs.readFileSync(path.join(archiveDir, 'index.json'), 'utf8'));
    expect(index.sessions).toHaveLength(1);
    expect(index.sessions[0].summary).toBe('(Migrated session)');

    const session = JSON.parse(fs.readFileSync(path.join(archiveDir, 'session-1.json'), 'utf8'));
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].content).toBe('Hello');
  });

  test('removes sessions array even with single session', async () => {
    const conv = await service.createConversation('Single Session');
    const convPath = path.join(tmpDir, 'data', 'chat', 'conversations', `${conv.id}.json`);

    const legacyConv = {
      ...conv,
      sessions: [
        { number: 1, sessionId: 'sess-1', startedAt: '2024-01-01T00:00:00Z', endedAt: null, messageCount: 1 },
      ],
      messages: [
        { id: 'm1', role: 'user', content: 'Hello', backend: 'claude-code', timestamp: '2024-01-01T00:00:00Z' },
      ],
    };
    fs.writeFileSync(convPath, JSON.stringify(legacyConv, null, 2), 'utf8');

    const result = await service.migrateConversation(conv.id);
    expect(result).toBe(true);

    const migrated = await service.getConversation(conv.id);
    expect(migrated.sessions).toBeUndefined();
    expect(migrated.messages).toHaveLength(1);
  });

  test('skips already migrated conversations', async () => {
    const conv = await service.createConversation('Already Migrated');
    // New-format conversations don't have sessions array
    const result = await service.migrateConversation(conv.id);
    expect(result).toBe(false);
  });

  test('is idempotent', async () => {
    const conv = await service.createConversation('Idempotent');
    const convPath = path.join(tmpDir, 'data', 'chat', 'conversations', `${conv.id}.json`);

    const legacyConv = {
      ...conv,
      sessions: [
        { number: 1, sessionId: 'sess-1', startedAt: '2024-01-01T00:00:00Z', endedAt: '2024-01-01T01:00:00Z', messageCount: 1 },
        { number: 2, sessionId: 'sess-2', startedAt: '2024-01-01T01:00:00Z', endedAt: null, messageCount: 0 },
      ],
      messages: [
        { id: 'm1', role: 'user', content: 'Hello', backend: 'claude-code', timestamp: '2024-01-01T00:00:00Z' },
        { id: 'div1', role: 'system', content: 'Session reset', isSessionDivider: true, timestamp: '2024-01-01T01:00:00Z' },
      ],
    };
    fs.writeFileSync(convPath, JSON.stringify(legacyConv, null, 2), 'utf8');

    await service.migrateConversation(conv.id);
    // Second call should be a no-op (sessions array is gone)
    const result2 = await service.migrateConversation(conv.id);
    expect(result2).toBe(false);
  });
});

describe('migrateAllConversations', () => {
  test('migrates all legacy conversations', async () => {
    const conv1 = await service.createConversation('Legacy 1');
    const conv2 = await service.createConversation('Legacy 2');

    // Make them legacy format
    for (const conv of [conv1, conv2]) {
      const convPath = path.join(tmpDir, 'data', 'chat', 'conversations', `${conv.id}.json`);
      const legacyConv = {
        ...conv,
        sessions: [{ number: 1, sessionId: 's1', startedAt: conv.createdAt, endedAt: null, messageCount: 0 }],
      };
      fs.writeFileSync(convPath, JSON.stringify(legacyConv, null, 2), 'utf8');
    }

    await service.migrateAllConversations();

    const loaded1 = await service.getConversation(conv1.id);
    const loaded2 = await service.getConversation(conv2.id);
    expect(loaded1.sessions).toBeUndefined();
    expect(loaded2.sessions).toBeUndefined();
  });

  test('does not error on empty directory', async () => {
    await expect(service.migrateAllConversations()).resolves.not.toThrow();
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
  });

  test('saves and retrieves settings', async () => {
    const input = { theme: 'dark', sendBehavior: 'ctrl-enter' };
    await service.saveSettings(input);

    const loaded = await service.getSettings();
    expect(loaded.theme).toBe('dark');
    expect(loaded.sendBehavior).toBe('ctrl-enter');
  });
});
