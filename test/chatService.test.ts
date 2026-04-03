/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { ChatService } from '../src/services/chatService';
import { BackendRegistry } from '../src/services/backends/registry';
import { BaseBackendAdapter } from '../src/services/backends/base';
import type { BackendMetadata, SendMessageOptions, SendMessageResult, Message } from '../src/types';

const DEFAULT_WORKSPACE = '/tmp/test-workspace';

let tmpDir: string;
let service: ChatService;

function workspaceHash(p: string): string {
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
    expect(index.conversations.map((c: any) => c.id).sort()).toEqual([c1.id, c2.id].sort());
  });
});

describe('getConversation', () => {
  test('returns null for non-existent id', async () => {
    expect(await service.getConversation('does-not-exist')).toBeNull();
  });

  test('returns the saved conversation with messages', async () => {
    const conv = await service.createConversation('Get Test');
    const loaded = await service.getConversation(conv.id);
    expect(loaded!.id).toBe(conv.id);
    expect(loaded!.title).toBe('Get Test');
    expect(loaded!.messages).toEqual([]);
  });
});

describe('listConversations', () => {
  test('returns empty array when no conversations', async () => {
    expect(await service.listConversations()).toEqual([]);
  });

  test('returns summaries with most recently updated first', async () => {
    const c1 = await service.createConversation('First');
    const c2 = await service.createConversation('Second');

    await service.addMessage(c2.id, 'user', 'hello', 'claude-code');

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
    expect(updated!.title).toBe('New Name');

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.title).toBe('New Name');
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
    await service.addMessage(conv.id, 'user', 'Hello', 'claude-code');

    (service as any)._generateSessionSummary = async (msgs: any, fallback: string) => fallback;
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
    expect(loaded!.backend).toBe('openai');
  });
});

// ── Messages ─────────────────────────────────────────────────────────────────

describe('addMessage', () => {
  test('appends message to conversation', async () => {
    const conv = await service.createConversation();
    const msg = await service.addMessage(conv.id, 'user', 'Hello', 'claude-code');
    expect(msg!.role).toBe('user');
    expect(msg!.content).toBe('Hello');
    expect(msg!.id).toBeDefined();

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.messages).toHaveLength(1);
  });

  test('auto-titles from first user message', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'What is the meaning of life?', 'claude-code');
    const loaded = await service.getConversation(conv.id);
    expect(loaded!.title).toBe('What is the meaning of life?');
  });

  test('does not re-title on second user message', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'First question', 'claude-code');
    await service.addMessage(conv.id, 'assistant', 'Answer', 'claude-code');
    await service.addMessage(conv.id, 'user', 'Second question', 'claude-code');
    const loaded = await service.getConversation(conv.id);
    expect(loaded!.title).toBe('First question');
  });

  test('does not fallback auto-title in post-reset sessions', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'First question', 'claude-code');
    await service.resetSession(conv.id);
    await service.addMessage(conv.id, 'user', 'New topic after reset', 'claude-code');
    const loaded = await service.getConversation(conv.id);
    expect(loaded!.title).toBe('New Chat');
  });

  test('re-titles after session reset when title reverts to New Chat', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'First question', 'claude-code');

    await service.renameConversation(conv.id, 'Custom Title');
    await service.addMessage(conv.id, 'user', 'Another question', 'claude-code');
    const loaded = await service.getConversation(conv.id);
    expect(loaded!.title).toBe('Custom Title');
  });

  test('returns null for non-existent conversation', async () => {
    expect(await service.addMessage('nope', 'user', 'hi', 'claude-code')).toBeNull();
  });

  test('stores thinking field when provided', async () => {
    const conv = await service.createConversation();
    const msg = await service.addMessage(conv.id, 'assistant', 'Response text', 'claude-code', 'I need to think about this...');
    expect(msg!.thinking).toBe('I need to think about this...');

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.messages[0].thinking).toBe('I need to think about this...');
  });

  test('persists thinking field to disk', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'assistant', 'Answer', 'claude-code', 'Thinking deeply');

    const service2 = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE });
    await service2.initialize();
    const loaded = await service2.getConversation(conv.id);
    expect(loaded!.messages[0].thinking).toBe('Thinking deeply');
  });

  test('omits thinking field when not provided', async () => {
    const conv = await service.createConversation();
    const msg = await service.addMessage(conv.id, 'assistant', 'No thinking', 'claude-code');
    expect(msg!.thinking).toBeUndefined();

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.messages[0].thinking).toBeUndefined();
  });

  test('omits thinking field when null', async () => {
    const conv = await service.createConversation();
    const msg = await service.addMessage(conv.id, 'assistant', 'Null thinking', 'claude-code', null);
    expect(msg!.thinking).toBeUndefined();
  });

  test('omits thinking field when empty string', async () => {
    const conv = await service.createConversation();
    const msg = await service.addMessage(conv.id, 'assistant', 'Empty thinking', 'claude-code', '');
    expect(msg!.thinking).toBeUndefined();
  });

  test('stores toolActivity when provided', async () => {
    const conv = await service.createConversation();
    const activity = [
      { tool: 'Read', description: 'Reading `app.js`', id: 'tool_1', duration: 300, startTime: Date.now() - 300 },
      { tool: 'Agent', description: 'Explore code', id: 'tool_2', isAgent: true, subagentType: 'Explore', duration: 5000, startTime: Date.now() - 5000 },
    ];
    const msg = await service.addMessage(conv.id, 'assistant', 'Response', 'claude-code', null, activity);
    expect(msg!.toolActivity).toEqual(activity);

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.messages[0].toolActivity).toEqual(activity);
  });

  test('omits toolActivity when not provided', async () => {
    const conv = await service.createConversation();
    const msg = await service.addMessage(conv.id, 'assistant', 'No tools', 'claude-code');
    expect(msg!.toolActivity).toBeUndefined();

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.messages[0].toolActivity).toBeUndefined();
  });

  test('omits toolActivity when empty array', async () => {
    const conv = await service.createConversation();
    const msg = await service.addMessage(conv.id, 'assistant', 'Empty tools', 'claude-code', null, []);
    expect(msg!.toolActivity).toBeUndefined();
  });

  test('persists toolActivity to disk', async () => {
    const conv = await service.createConversation();
    const activity = [{ tool: 'Bash', description: 'Running tests', id: 'tool_1', duration: 1000, startTime: Date.now() }];
    await service.addMessage(conv.id, 'assistant', 'Answer', 'claude-code', null, activity);

    const service2 = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE });
    await service2.initialize();
    const loaded = await service2.getConversation(conv.id);
    expect(loaded!.messages[0].toolActivity).toEqual(activity);
  });

  test('updates lastActivity and lastMessage in workspace index', async () => {
    const conv = await service.createConversation('Test', '/tmp/idx');
    await service.addMessage(conv.id, 'user', 'Index check message', 'claude-code');

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
    const m1 = await service.addMessage(conv.id, 'user', 'Original', 'claude-code');
    await service.addMessage(conv.id, 'assistant', 'Response', 'claude-code');
    await service.addMessage(conv.id, 'user', 'Follow-up', 'claude-code');

    const result = await service.updateMessageContent(conv.id, m1!.id, 'Edited');
    expect(result!.message.content).toBe('Edited');
    expect(result!.conversation.messages).toHaveLength(1);
    expect(result!.conversation.messages[0].content).toBe('Edited');
  });

  test('returns null for non-existent conversation', async () => {
    expect(await service.updateMessageContent('nope', 'mid', 'text')).toBeNull();
  });

  test('returns null for non-existent message', async () => {
    const conv = await service.createConversation();
    expect(await service.updateMessageContent(conv.id, 'nope', 'text')).toBeNull();
  });
});

// ── Title Generation ────────────────────────────────────────────────────────

describe('generateAndUpdateTitle', () => {
  test('updates conversation title with fallback when no adapter', async () => {
    const conv = await service.createConversation('Old Title');
    const newTitle = await service.generateAndUpdateTitle(conv.id, 'How do I deploy to production?');
    expect(newTitle).toBe('How do I deploy to production?');
    const loaded = await service.getConversation(conv.id);
    expect(loaded!.title).toBe('How do I deploy to production?');
  });

  test('truncates long messages in fallback title', async () => {
    const conv = await service.createConversation('Old Title');
    const longMsg = 'A'.repeat(100);
    const newTitle = await service.generateAndUpdateTitle(conv.id, longMsg);
    expect(newTitle).toBe('A'.repeat(80));
  });

  test('uses adapter generateTitle when available', async () => {
    class TitleAdapter extends BaseBackendAdapter {
      get metadata(): BackendMetadata {
        return { id: 'claude-code', label: 'Test', icon: null, capabilities: {} as any };
      }
      sendMessage(_message: string, _options?: SendMessageOptions): SendMessageResult {
        return { stream: (async function*() {})(), abort: () => {}, sendInput: () => {} };
      }
      async generateSummary(_msgs: Pick<Message, 'role' | 'content'>[], _fb: string): Promise<string> { return _fb; }
      async generateTitle(_msg: string): Promise<string> { return 'LLM Generated Title'; }
    }

    const registry = new BackendRegistry();
    registry.register(new TitleAdapter());
    const svc = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE, backendRegistry: registry });
    await svc.initialize();

    const conv = await svc.createConversation('Old Title');
    const newTitle = await svc.generateAndUpdateTitle(conv.id, 'some message');
    expect(newTitle).toBe('LLM Generated Title');
    const loaded = await svc.getConversation(conv.id);
    expect(loaded!.title).toBe('LLM Generated Title');
  });

  test('returns null for non-existent conversation', async () => {
    expect(await service.generateAndUpdateTitle('nonexistent', 'msg')).toBeNull();
  });
});

// ── Session Management ───────────────────────────────────────────────────────

describe('resetSession', () => {
  beforeEach(() => {
    (service as any)._generateSessionSummary = async (_msgs: any, _fallback: string) => 'Test summary for session';
  });

  test('archives current session and starts new one', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'Hello', 'claude-code');
    await service.addMessage(conv.id, 'assistant', 'Hi', 'claude-code');

    const result = await service.resetSession(conv.id);
    expect(result!.newSessionNumber).toBe(2);
    expect(result!.archivedSession).toBeDefined();
    expect(result!.archivedSession.summary).toBe('Test summary for session');
    expect(result!.archivedSession.messageCount).toBe(2);

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.sessionNumber).toBe(2);
    expect(loaded!.messages).toHaveLength(0);
    expect(loaded!.title).toBe('New Chat');
  });

  test('resets conversation title to New Chat', async () => {
    const conv = await service.createConversation('My Custom Title');
    await service.addMessage(conv.id, 'user', 'Hello', 'claude-code');

    const result = await service.resetSession(conv.id);
    expect(result!.conversation.title).toBe('New Chat');
  });

  test('creates session files on disk', async () => {
    const conv = await service.createConversation('Test', '/tmp/reset-test');
    await service.addMessage(conv.id, 'user', 'Hello', 'claude-code');

    await service.resetSession(conv.id);

    const hash = workspaceHash('/tmp/reset-test');
    const convDir = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, conv.id);

    const session1 = JSON.parse(fs.readFileSync(path.join(convDir, 'session-1.json'), 'utf8'));
    expect(session1.messages).toHaveLength(1);
    expect(session1.messages[0].content).toBe('Hello');
    expect(session1.endedAt).toBeDefined();

    const session2 = JSON.parse(fs.readFileSync(path.join(convDir, 'session-2.json'), 'utf8'));
    expect(session2.messages).toHaveLength(0);

    const index = JSON.parse(fs.readFileSync(
      path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json'), 'utf8'
    ));
    const convEntry = index.conversations.find((c: any) => c.id === conv.id);
    expect(convEntry.sessions).toHaveLength(2);
    expect(convEntry.sessions[0].active).toBe(false);
    expect(convEntry.sessions[0].summary).toBe('Test summary for session');
    expect(convEntry.sessions[1].active).toBe(true);
  });

  test('multiple resets create sequential sessions', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'Session 1 msg', 'claude-code');
    await service.resetSession(conv.id);

    await service.addMessage(conv.id, 'user', 'Session 2 msg', 'claude-code');
    await service.resetSession(conv.id);

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.sessionNumber).toBe(3);
    expect(loaded!.messages).toHaveLength(0);
  });

  test('returns null for non-existent conversation', async () => {
    expect(await service.resetSession('nope')).toBeNull();
  });
});

describe('getSessionHistory', () => {
  beforeEach(() => {
    (service as any)._generateSessionSummary = async (_msgs: any, _fallback: string) => 'Test summary';
  });

  test('returns current session when no archives', async () => {
    const conv = await service.createConversation();
    const sessions = await service.getSessionHistory(conv.id);
    expect(sessions).toHaveLength(1);
    expect(sessions![0].isCurrent).toBe(true);
    expect(sessions![0].number).toBe(1);
  });

  test('returns archived sessions plus current', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'Hello', 'claude-code');
    await service.resetSession(conv.id);

    const sessions = await service.getSessionHistory(conv.id);
    expect(sessions).toHaveLength(2);
    expect(sessions![0].isCurrent).toBe(false);
    expect(sessions![0].summary).toBe('Test summary');
    expect(sessions![1].isCurrent).toBe(true);
    expect(sessions![1].number).toBe(2);
  });

  test('returns null for non-existent conversation', async () => {
    expect(await service.getSessionHistory('nope')).toBeNull();
  });
});

describe('getSessionMessages', () => {
  beforeEach(() => {
    (service as any)._generateSessionSummary = async (_msgs: any, _fallback: string) => 'Test summary';
  });

  test('returns current session messages', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'Hello', 'claude-code');
    await service.addMessage(conv.id, 'assistant', 'Hi', 'claude-code');

    const messages = await service.getSessionMessages(conv.id, conv.sessionNumber);
    expect(messages).toHaveLength(2);
    expect(messages![0].content).toBe('Hello');
  });

  test('returns archived session messages', async () => {
    const conv = await service.createConversation();
    await service.addMessage(conv.id, 'user', 'Old msg', 'claude-code');
    await service.resetSession(conv.id);

    const messages = await service.getSessionMessages(conv.id, 1);
    expect(messages).toHaveLength(1);
    expect(messages![0].content).toBe('Old msg');
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
    (service as any)._generateSessionSummary = async (_msgs: any, _fallback: string) => 'Test summary';
  });

  test('exports conversation as markdown', async () => {
    const conv = await service.createConversation('Export Test');
    await service.addMessage(conv.id, 'user', 'Hello', 'claude-code');
    await service.addMessage(conv.id, 'assistant', 'Hi there', 'claude-code');

    const md = await service.conversationToMarkdown(conv.id);
    expect(md).toContain('# Export Test');
    expect(md).toContain('Hello');
    expect(md).toContain('Hi there');
    expect(md).toContain('User');
    expect(md).toContain('Assistant');
  });

  test('includes archived sessions', async () => {
    const conv = await service.createConversation('Session Test');
    await service.addMessage(conv.id, 'user', 'Before reset', 'claude-code');
    await service.resetSession(conv.id);
    await service.addMessage(conv.id, 'user', 'After reset', 'claude-code');

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
    (service as any)._generateSessionSummary = async (_msgs: any, _fallback: string) => 'Test summary';
  });

  test('exports current session as markdown', async () => {
    const conv = await service.createConversation('MD Test');
    await service.addMessage(conv.id, 'user', 'Hello', 'claude-code');
    await service.addMessage(conv.id, 'assistant', 'Hi there', 'claude-code');

    const md = await service.sessionToMarkdown(conv.id, conv.sessionNumber);
    expect(md).toContain('User');
    expect(md).toContain('Hello');
    expect(md).toContain('Hi there');
  });

  test('exports archived session as markdown', async () => {
    const conv = await service.createConversation('MD Test');
    await service.addMessage(conv.id, 'user', 'Old msg', 'claude-code');
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

// ── Workspace Instructions ──────────────────────────────────────────────────

describe('getWorkspaceInstructions', () => {
  test('returns empty string for workspace with no instructions', async () => {
    await service.createConversation('Test', '/tmp/ws-inst');
    const hash = workspaceHash('/tmp/ws-inst');
    const instructions = await service.getWorkspaceInstructions(hash);
    expect(instructions).toBe('');
  });

  test('returns null for non-existent workspace', async () => {
    const instructions = await service.getWorkspaceInstructions('nonexistent');
    expect(instructions).toBeNull();
  });
});

describe('setWorkspaceInstructions', () => {
  test('saves and retrieves instructions', async () => {
    await service.createConversation('Test', '/tmp/ws-inst');
    const hash = workspaceHash('/tmp/ws-inst');
    await service.setWorkspaceInstructions(hash, 'Always use TypeScript');
    const instructions = await service.getWorkspaceInstructions(hash);
    expect(instructions).toBe('Always use TypeScript');
  });

  test('persists instructions to disk', async () => {
    await service.createConversation('Test', '/tmp/ws-persist');
    const hash = workspaceHash('/tmp/ws-persist');
    await service.setWorkspaceInstructions(hash, 'Use functional components');

    const indexPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    expect(index.instructions).toBe('Use functional components');
  });

  test('clears instructions when set to empty string', async () => {
    await service.createConversation('Test', '/tmp/ws-clear');
    const hash = workspaceHash('/tmp/ws-clear');
    await service.setWorkspaceInstructions(hash, 'Some instructions');
    await service.setWorkspaceInstructions(hash, '');
    const instructions = await service.getWorkspaceInstructions(hash);
    expect(instructions).toBe('');
  });

  test('returns null for non-existent workspace', async () => {
    const result = await service.setWorkspaceInstructions('nonexistent', 'test');
    expect(result).toBeNull();
  });
});

describe('getWorkspaceHashForConv', () => {
  test('returns hash for existing conversation', async () => {
    const conv = await service.createConversation('Test', '/tmp/hash-test');
    const hash = service.getWorkspaceHashForConv(conv.id);
    expect(hash).toBe(workspaceHash('/tmp/hash-test'));
  });

  test('returns null for non-existent conversation', () => {
    expect(service.getWorkspaceHashForConv('nope')).toBeNull();
  });
});

describe('listConversations includes workspaceHash', () => {
  test('each conversation has workspaceHash', async () => {
    await service.createConversation('Test', '/tmp/list-hash');
    const list = await service.listConversations();
    expect(list[0].workspaceHash).toBe(workspaceHash('/tmp/list-hash'));
  });
});

// ── Migration ───────────────────────────────────────────────────────────────

describe('migration from legacy format', () => {
  test('migrates conversations to workspace format', async () => {
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

    const svc = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE });
    await svc.initialize();

    expect(fs.existsSync(convDir)).toBe(false);
    expect(fs.existsSync(convDir + '_backup')).toBe(true);

    const loaded = await svc.getConversation(convId);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe('Legacy Conv');
    expect(loaded!.messages).toHaveLength(2);

    const hash = workspaceHash('/tmp/legacy-project');
    const indexPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json');
    expect(fs.existsSync(indexPath)).toBe(true);
  });

  test('migrates conversations with archived sessions', async () => {
    const convDir = path.join(tmpDir, 'data', 'chat', 'conversations');
    const archivesDir = path.join(tmpDir, 'data', 'chat', 'archives');
    fs.mkdirSync(convDir, { recursive: true });

    const convId = crypto.randomUUID();

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

    const svc = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE });
    await svc.initialize();

    expect(fs.existsSync(convDir)).toBe(false);
    expect(fs.existsSync(archivesDir)).toBe(false);

    const loaded = await svc.getConversation(convId);
    expect(loaded!.title).toBe('Archived Conv');
    expect(loaded!.messages).toHaveLength(1);
    expect(loaded!.sessionNumber).toBe(2);

    const sessions = await svc.getSessionHistory(convId);
    expect(sessions).toHaveLength(2);
    expect(sessions![0].summary).toBe('Discussed the project setup');
    expect(sessions![0].isCurrent).toBe(false);
    expect(sessions![1].isCurrent).toBe(true);

    const archivedMsgs = await svc.getSessionMessages(convId, 1);
    expect(archivedMsgs).toHaveLength(2);
    expect(archivedMsgs![0].content).toBe('Old msg 1');
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
    expect(loaded!.messages).toHaveLength(1);
    expect(loaded!.messages[0].content).toBe('Session 2 msg');
    expect(loaded!.sessionNumber).toBe(2);

    const archivedMsgs = await svc.getSessionMessages(convId, 1);
    expect(archivedMsgs).toHaveLength(2);
    expect(archivedMsgs![0].content).toBe('Session 1 msg');
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
    expect(fs.existsSync(convDir)).toBe(false);
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
    await service.addMessage(conv.id, 'user', 'The zebra crossed the road', 'claude-code');

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
    await service.saveSettings(input as any);

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
    await service.saveSettings(legacy as any);

    const loaded = await service.getSettings();
    expect(loaded.systemPrompt).toBe('I am a developer\n\nBe concise');
    expect(loaded.customInstructions).toBeUndefined();

    const reloaded = await service.getSettings();
    expect(reloaded.systemPrompt).toBe('I am a developer\n\nBe concise');
  });

  test('migrates partial customInstructions gracefully', async () => {
    const legacy = {
      theme: 'system',
      customInstructions: { aboutUser: '', responseStyle: 'Use bullet points' },
    };
    await service.saveSettings(legacy as any);

    const loaded = await service.getSettings();
    expect(loaded.systemPrompt).toBe('Use bullet points');
    expect(loaded.customInstructions).toBeUndefined();
  });
});

// ── Usage Tracking ──────────────────────────────────────────────────────────

describe('addUsage', () => {
  test('accumulates usage on conversation and returns both conversation and session usage', async () => {
    const conv = await service.createConversation('Usage Test');

    const updated = await service.addUsage(conv.id, {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      costUsd: 0.05,
    });

    expect(updated!.conversationUsage.inputTokens).toBe(1000);
    expect(updated!.conversationUsage.outputTokens).toBe(500);
    expect(updated!.conversationUsage.cacheReadTokens).toBe(200);
    expect(updated!.conversationUsage.cacheWriteTokens).toBe(100);
    expect(updated!.conversationUsage.costUsd).toBe(0.05);

    expect(updated!.sessionUsage.inputTokens).toBe(1000);
    expect(updated!.sessionUsage.outputTokens).toBe(500);
    expect(updated!.sessionUsage.costUsd).toBe(0.05);
  });

  test('accumulates across multiple calls', async () => {
    const conv = await service.createConversation('Multi Usage');

    await service.addUsage(conv.id, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, costUsd: 0.01 });
    const updated = await service.addUsage(conv.id, { inputTokens: 200, outputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 10, costUsd: 0.02 });

    expect(updated!.conversationUsage.inputTokens).toBe(300);
    expect(updated!.conversationUsage.outputTokens).toBe(150);
    expect(updated!.conversationUsage.cacheReadTokens).toBe(30);
    expect(updated!.conversationUsage.cacheWriteTokens).toBe(15);
    expect(updated!.conversationUsage.costUsd).toBe(0.03);
  });

  test('returns null for unknown conversation', async () => {
    const result = await service.addUsage('nonexistent', { inputTokens: 100, outputTokens: 50 } as any);
    expect(result).toBeNull();
  });

  test('returns null when usage is null', async () => {
    const conv = await service.createConversation('Null Usage');
    const result = await service.addUsage(conv.id, null as any);
    expect(result).toBeNull();
  });

  test('also tracks usage on active session', async () => {
    const conv = await service.createConversation('Session Usage');
    await service.addUsage(conv.id, { inputTokens: 500, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.03 });

    const hash = workspaceHash(DEFAULT_WORKSPACE);
    const indexPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const convEntry = index.conversations.find((c: any) => c.id === conv.id);
    const activeSession = convEntry.sessions.find((s: any) => s.active);

    expect(activeSession.usage.inputTokens).toBe(500);
    expect(activeSession.usage.outputTokens).toBe(250);
    expect(activeSession.usage.costUsd).toBe(0.03);
  });

  test('tracks usageByBackend on conversation and session', async () => {
    const conv = await service.createConversation('Backend Usage');
    await service.addUsage(conv.id, { inputTokens: 500, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.03 }, 'claude-code');

    const hash = workspaceHash(DEFAULT_WORKSPACE);
    const indexPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const convEntry = index.conversations.find((c: any) => c.id === conv.id);

    expect(convEntry.usageByBackend['claude-code'].inputTokens).toBe(500);
    expect(convEntry.usageByBackend['claude-code'].outputTokens).toBe(250);

    const activeSession = convEntry.sessions.find((s: any) => s.active);
    expect(activeSession.usageByBackend['claude-code'].inputTokens).toBe(500);
  });

  test('records usage to daily ledger with backend and model', async () => {
    const conv = await service.createConversation('Ledger Test');
    await service.addUsage(conv.id, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.05 }, 'claude-code', 'claude-sonnet-4');

    // Wait for fire-and-forget ledger write
    await new Promise(resolve => setTimeout(resolve, 100));

    const ledger = await service.getUsageStats();
    const today = new Date().toISOString().slice(0, 10);
    const dayEntry = ledger.days.find((d: any) => d.date === today);
    expect(dayEntry).toBeDefined();
    const record = dayEntry!.records.find((r: any) => r.backend === 'claude-code' && r.model === 'claude-sonnet-4');
    expect(record).toBeDefined();
    expect(record!.usage.inputTokens).toBe(1000);
    expect(record!.usage.outputTokens).toBe(500);
    expect(record!.usage.costUsd).toBe(0.05);
  });

  test('defaults model to unknown when not provided', async () => {
    const conv = await service.createConversation('Ledger No Model');
    await service.addUsage(conv.id, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 }, 'claude-code');

    await new Promise(resolve => setTimeout(resolve, 100));

    const ledger = await service.getUsageStats();
    const today = new Date().toISOString().slice(0, 10);
    const dayEntry = ledger.days.find((d: any) => d.date === today);
    const record = dayEntry!.records.find((r: any) => r.backend === 'claude-code');
    expect(record).toBeDefined();
    expect(record!.model).toBe('unknown');
  });
});

describe('getUsage', () => {
  test('returns empty usage for new conversation', async () => {
    const conv = await service.createConversation('Empty Usage');
    const usage = await service.getUsage(conv.id);
    expect(usage!.inputTokens).toBe(0);
    expect(usage!.outputTokens).toBe(0);
    expect(usage!.cacheReadTokens).toBe(0);
    expect(usage!.cacheWriteTokens).toBe(0);
    expect(usage!.costUsd).toBe(0);
  });

  test('returns accumulated usage', async () => {
    const conv = await service.createConversation('Get Usage');
    await service.addUsage(conv.id, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 50, costUsd: 0.05 });

    const usage = await service.getUsage(conv.id);
    expect(usage!.inputTokens).toBe(1000);
    expect(usage!.outputTokens).toBe(500);
    expect(usage!.costUsd).toBe(0.05);
  });

  test('returns null for unknown conversation', async () => {
    const result = await service.getUsage('nonexistent');
    expect(result).toBeNull();
  });
});

describe('getConversation includes usage', () => {
  test('returns empty usage for new conversation', async () => {
    const conv = await service.createConversation('With Usage');
    const loaded = await service.getConversation(conv.id);
    expect(loaded!.usage).toBeDefined();
    expect(loaded!.usage!.inputTokens).toBe(0);
    expect(loaded!.sessionUsage).toBeDefined();
    expect(loaded!.sessionUsage!.inputTokens).toBe(0);
  });

  test('returns accumulated usage and session usage', async () => {
    const conv = await service.createConversation('With Usage');
    await service.addUsage(conv.id, { inputTokens: 500, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02 });

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.usage!.inputTokens).toBe(500);
    expect(loaded!.usage!.outputTokens).toBe(250);
    expect(loaded!.usage!.costUsd).toBe(0.02);

    expect(loaded!.sessionUsage!.inputTokens).toBe(500);
    expect(loaded!.sessionUsage!.outputTokens).toBe(250);
    expect(loaded!.sessionUsage!.costUsd).toBe(0.02);
  });
});

describe('listConversations includes usage', () => {
  test('returns usage in conversation list', async () => {
    const conv = await service.createConversation('List Usage');
    await service.addUsage(conv.id, { inputTokens: 300, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 });

    const list = await service.listConversations();
    const found = list.find((c: any) => c.id === conv.id);
    expect(found!.usage).toBeDefined();
    expect(found!.usage!.inputTokens).toBe(300);
    expect(found!.usage!.costUsd).toBe(0.01);
  });

  test('returns null usage for conversation without usage', async () => {
    await service.createConversation('No Usage');
    const list = await service.listConversations();
    expect(list[0].usage).toBeNull();
  });
});

describe('usage stats ledger', () => {
  test('getUsageStats returns empty ledger initially', async () => {
    const ledger = await service.getUsageStats();
    expect(ledger.days).toEqual([]);
  });

  test('clearUsageStats resets ledger', async () => {
    const conv = await service.createConversation('Ledger Clear');
    await service.addUsage(conv.id, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 }, 'claude-code');
    // Wait for ledger write
    await new Promise(resolve => setTimeout(resolve, 100));

    let ledger = await service.getUsageStats();
    expect(ledger.days.length).toBeGreaterThan(0);

    await service.clearUsageStats();
    ledger = await service.getUsageStats();
    expect(ledger.days).toEqual([]);
  });

  test('ledger accumulates across multiple addUsage calls', async () => {
    const conv = await service.createConversation('Ledger Accum');
    await service.addUsage(conv.id, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 }, 'claude-code', 'claude-sonnet-4');
    await new Promise(resolve => setTimeout(resolve, 50));
    await service.addUsage(conv.id, { inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02 }, 'claude-code', 'claude-sonnet-4');
    await new Promise(resolve => setTimeout(resolve, 100));

    const ledger = await service.getUsageStats();
    const today = new Date().toISOString().slice(0, 10);
    const dayEntry = ledger.days.find((d: any) => d.date === today);
    expect(dayEntry).toBeDefined();
    const record = dayEntry!.records.find((r: any) => r.backend === 'claude-code' && r.model === 'claude-sonnet-4');
    expect(record).toBeDefined();
    expect(record!.usage.inputTokens).toBe(300);
    expect(record!.usage.outputTokens).toBe(150);
    expect(record!.usage.costUsd).toBeCloseTo(0.03);
  });

  test('ledger separates different models for same backend', async () => {
    const conv = await service.createConversation('Ledger Models');
    await service.addUsage(conv.id, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 }, 'claude-code', 'claude-sonnet-4');
    await new Promise(resolve => setTimeout(resolve, 50));
    await service.addUsage(conv.id, { inputTokens: 500, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.10 }, 'claude-code', 'claude-opus-4');
    await new Promise(resolve => setTimeout(resolve, 100));

    const ledger = await service.getUsageStats();
    const today = new Date().toISOString().slice(0, 10);
    const dayEntry = ledger.days.find((d: any) => d.date === today);
    expect(dayEntry!.records.length).toBe(2);

    const sonnet = dayEntry!.records.find((r: any) => r.model === 'claude-sonnet-4');
    expect(sonnet!.usage.inputTokens).toBe(100);

    const opus = dayEntry!.records.find((r: any) => r.model === 'claude-opus-4');
    expect(opus!.usage.inputTokens).toBe(500);
  });
});
