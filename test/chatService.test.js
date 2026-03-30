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
    expect(conv.sessions).toHaveLength(1);
    expect(conv.sessionNumber).toBe(1);
    expect(conv.backend).toBe('claude-code');
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

  test('increments session message count', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'msg1');
    await service.addMessage(conv.id, 'assistant', 'msg2');
    const loaded = await service.getConversation(conv.id);
    expect(loaded.sessions[0].messageCount).toBe(2);
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
  test('creates new session and archives current', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'Hello');
    await service.addMessage(conv.id, 'assistant', 'Hi');

    const result = await service.resetSession(conv.id);
    expect(result.newSessionNumber).toBe(2);

    const loaded = await service.getConversation(conv.id);
    expect(loaded.sessions).toHaveLength(2);
    expect(loaded.sessions[0].endedAt).not.toBeNull();
    expect(loaded.sessions[1].endedAt).toBeNull();
    expect(loaded.sessionNumber).toBe(2);

    // Check archive file was written
    const archives = fs.readdirSync(path.join(tmpDir, 'data', 'chat', 'archives'));
    expect(archives).toHaveLength(1);
    expect(archives[0]).toContain(conv.id);
  });

  test('adds session divider message', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'Hello');
    await service.resetSession(conv.id);

    const loaded = await service.getConversation(conv.id);
    const divider = loaded.messages.find(m => m.isSessionDivider);
    expect(divider).toBeDefined();
    expect(divider.role).toBe('system');
  });

  test('returns null for non-existent conversation', async () => {
    expect(await service.resetSession('nope')).toBeNull();
  });
});

describe('getSessionHistory', () => {
  test('returns sessions with isCurrent flag', async () => {
    const conv = await service.createConversation();
    const sessions = await service.getSessionHistory(conv.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].isCurrent).toBe(true);
  });

  test('returns null for non-existent conversation', async () => {
    expect(await service.getSessionHistory('nope')).toBeNull();
  });
});

// ── Markdown Export ──────────────────────────────────────────────────────────

describe('conversationToMarkdown', () => {
  test('exports conversation as markdown', async () => {
    const conv = await service.createConversation('Export Test');
    await service.addMessage(conv.id, 'user', 'Hello');
    await service.addMessage(conv.id, 'assistant', 'Hi there');

    const md = await service.conversationToMarkdown(conv.id);
    // Title is auto-set to first user message
    expect(md).toContain('# Hello');
    expect(md).toContain('Hello');
    expect(md).toContain('Hi there');
    expect(md).toContain('User');
    expect(md).toContain('Assistant');
  });

  test('includes session dividers', async () => {
    const conv = await service.createConversation('Session Test');
    await service.addMessage(conv.id, 'user', 'Before reset');
    await service.resetSession(conv.id);
    await service.addMessage(conv.id, 'user', 'After reset');

    const md = await service.conversationToMarkdown(conv.id);
    expect(md).toContain('Session reset');
  });

  test('returns null for non-existent conversation', async () => {
    expect(await service.conversationToMarkdown('nope')).toBeNull();
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
