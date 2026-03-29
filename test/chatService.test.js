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
  test('creates with default title', () => {
    const conv = service.createConversation();
    expect(conv.title).toBe('New Chat');
    expect(conv.messages).toEqual([]);
    expect(conv.sessions).toHaveLength(1);
    expect(conv.sessionNumber).toBe(1);
    expect(conv.backend).toBe('claude-code');
  });

  test('creates with custom title and working dir', () => {
    const conv = service.createConversation('My Chat', '/tmp/work');
    expect(conv.title).toBe('My Chat');
    expect(conv.workingDir).toBe('/tmp/work');
  });

  test('persists to disk', () => {
    const conv = service.createConversation('Disk Test');
    const file = path.join(tmpDir, 'data', 'chat', 'conversations', `${conv.id}.json`);
    expect(fs.existsSync(file)).toBe(true);
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(loaded.title).toBe('Disk Test');
  });
});

describe('getConversation', () => {
  test('returns null for non-existent id', () => {
    expect(service.getConversation('does-not-exist')).toBeNull();
  });

  test('returns the saved conversation', () => {
    const conv = service.createConversation('Get Test');
    const loaded = service.getConversation(conv.id);
    expect(loaded.id).toBe(conv.id);
    expect(loaded.title).toBe('Get Test');
  });
});

describe('listConversations', () => {
  test('returns empty array when no conversations', () => {
    expect(service.listConversations()).toEqual([]);
  });

  test('returns summaries with most recently updated first', () => {
    const c1 = service.createConversation('First');
    const c2 = service.createConversation('Second');

    // Force c1 to have an older updatedAt
    const conv1 = service.getConversation(c1.id);
    conv1.updatedAt = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'chat', 'conversations', `${c1.id}.json`),
      JSON.stringify(conv1, null, 2), 'utf8'
    );

    service.addMessage(c2.id, 'user', 'hello');

    const list = service.listConversations();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(c2.id);
    expect(list[0].messageCount).toBe(1);
    expect(list[0].lastMessage).toBe('hello');
    expect(list[1].id).toBe(c1.id);
  });
});

describe('renameConversation', () => {
  test('renames and persists', () => {
    const conv = service.createConversation('Old Name');
    const updated = service.renameConversation(conv.id, 'New Name');
    expect(updated.title).toBe('New Name');

    const loaded = service.getConversation(conv.id);
    expect(loaded.title).toBe('New Name');
  });

  test('returns null for non-existent id', () => {
    expect(service.renameConversation('nope', 'Name')).toBeNull();
  });
});

describe('deleteConversation', () => {
  test('deletes existing conversation', () => {
    const conv = service.createConversation('Delete Me');
    expect(service.deleteConversation(conv.id)).toBe(true);
    expect(service.getConversation(conv.id)).toBeNull();
  });

  test('returns false for non-existent id', () => {
    expect(service.deleteConversation('nope')).toBe(false);
  });
});

// ── Messages ─────────────────────────────────────────────────────────────────

describe('addMessage', () => {
  test('appends message to conversation', () => {
    const conv = service.createConversation();
    const msg = service.addMessage(conv.id, 'user', 'Hello');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Hello');
    expect(msg.id).toBeDefined();

    const loaded = service.getConversation(conv.id);
    expect(loaded.messages).toHaveLength(1);
  });

  test('auto-titles from first user message', () => {
    const conv = service.createConversation();
    service.addMessage(conv.id, 'user', 'What is the meaning of life?');
    const loaded = service.getConversation(conv.id);
    expect(loaded.title).toBe('What is the meaning of life?');
  });

  test('does not re-title on second user message', () => {
    const conv = service.createConversation();
    service.addMessage(conv.id, 'user', 'First question');
    service.addMessage(conv.id, 'assistant', 'Answer');
    service.addMessage(conv.id, 'user', 'Second question');
    const loaded = service.getConversation(conv.id);
    expect(loaded.title).toBe('First question');
  });

  test('increments session message count', () => {
    const conv = service.createConversation();
    service.addMessage(conv.id, 'user', 'msg1');
    service.addMessage(conv.id, 'assistant', 'msg2');
    const loaded = service.getConversation(conv.id);
    expect(loaded.sessions[0].messageCount).toBe(2);
  });

  test('returns null for non-existent conversation', () => {
    expect(service.addMessage('nope', 'user', 'hi')).toBeNull();
  });
});

describe('updateMessageContent', () => {
  test('forks conversation at edited message', () => {
    const conv = service.createConversation();
    const m1 = service.addMessage(conv.id, 'user', 'Original');
    service.addMessage(conv.id, 'assistant', 'Response');
    service.addMessage(conv.id, 'user', 'Follow-up');

    const result = service.updateMessageContent(conv.id, m1.id, 'Edited');
    expect(result.message.content).toBe('Edited');
    expect(result.conversation.messages).toHaveLength(1);
    expect(result.conversation.messages[0].content).toBe('Edited');
  });

  test('returns null for non-existent conversation', () => {
    expect(service.updateMessageContent('nope', 'mid', 'text')).toBeNull();
  });

  test('returns null for non-existent message', () => {
    const conv = service.createConversation();
    expect(service.updateMessageContent(conv.id, 'nope', 'text')).toBeNull();
  });
});

// ── Session Management ───────────────────────────────────────────────────────

describe('resetSession', () => {
  test('creates new session and archives current', () => {
    const conv = service.createConversation();
    service.addMessage(conv.id, 'user', 'Hello');
    service.addMessage(conv.id, 'assistant', 'Hi');

    const result = service.resetSession(conv.id);
    expect(result.newSessionNumber).toBe(2);

    const loaded = service.getConversation(conv.id);
    expect(loaded.sessions).toHaveLength(2);
    expect(loaded.sessions[0].endedAt).not.toBeNull();
    expect(loaded.sessions[1].endedAt).toBeNull();
    expect(loaded.sessionNumber).toBe(2);

    // Check archive file was written
    const archives = fs.readdirSync(path.join(tmpDir, 'data', 'chat', 'archives'));
    expect(archives).toHaveLength(1);
    expect(archives[0]).toContain(conv.id);
  });

  test('adds session divider message', () => {
    const conv = service.createConversation();
    service.addMessage(conv.id, 'user', 'Hello');
    service.resetSession(conv.id);

    const loaded = service.getConversation(conv.id);
    const divider = loaded.messages.find(m => m.isSessionDivider);
    expect(divider).toBeDefined();
    expect(divider.role).toBe('system');
  });

  test('returns null for non-existent conversation', () => {
    expect(service.resetSession('nope')).toBeNull();
  });
});

describe('getSessionHistory', () => {
  test('returns sessions with isCurrent flag', () => {
    const conv = service.createConversation();
    const sessions = service.getSessionHistory(conv.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].isCurrent).toBe(true);
  });

  test('returns null for non-existent conversation', () => {
    expect(service.getSessionHistory('nope')).toBeNull();
  });
});

// ── Markdown Export ──────────────────────────────────────────────────────────

describe('conversationToMarkdown', () => {
  test('exports conversation as markdown', () => {
    const conv = service.createConversation('Export Test');
    service.addMessage(conv.id, 'user', 'Hello');
    service.addMessage(conv.id, 'assistant', 'Hi there');

    const md = service.conversationToMarkdown(conv.id);
    // Title is auto-set to first user message
    expect(md).toContain('# Hello');
    expect(md).toContain('Hello');
    expect(md).toContain('Hi there');
    expect(md).toContain('User');
    expect(md).toContain('Assistant');
  });

  test('includes session dividers', () => {
    const conv = service.createConversation('Session Test');
    service.addMessage(conv.id, 'user', 'Before reset');
    service.resetSession(conv.id);
    service.addMessage(conv.id, 'user', 'After reset');

    const md = service.conversationToMarkdown(conv.id);
    expect(md).toContain('Session reset');
  });

  test('returns null for non-existent conversation', () => {
    expect(service.conversationToMarkdown('nope')).toBeNull();
  });
});

// ── Search ───────────────────────────────────────────────────────────────────

describe('searchConversations', () => {
  test('finds by title', () => {
    service.createConversation('Unique Alpha Title');
    service.createConversation('Other');

    const results = service.searchConversations('alpha');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Unique Alpha Title');
  });

  test('finds by message content', () => {
    const conv = service.createConversation('Chat');
    service.addMessage(conv.id, 'user', 'The zebra crossed the road');

    const results = service.searchConversations('zebra');
    expect(results).toHaveLength(1);
  });

  test('returns all when query is empty', () => {
    service.createConversation('A');
    service.createConversation('B');

    const results = service.searchConversations('');
    expect(results).toHaveLength(2);
  });
});

// ── Settings ─────────────────────────────────────────────────────────────────

describe('settings', () => {
  test('returns defaults when no settings file', () => {
    const settings = service.getSettings();
    expect(settings.theme).toBe('system');
    expect(settings.sendBehavior).toBe('enter');
    expect(settings.defaultBackend).toBe('claude-code');
  });

  test('saves and retrieves settings', () => {
    const input = { theme: 'dark', sendBehavior: 'ctrl-enter' };
    service.saveSettings(input);

    const loaded = service.getSettings();
    expect(loaded.theme).toBe('dark');
    expect(loaded.sendBehavior).toBe('ctrl-enter');
  });
});
