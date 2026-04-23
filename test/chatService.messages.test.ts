/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ChatService } from '../src/services/chatService';
import { workspaceHash } from './helpers/workspace';
import { BackendRegistry } from '../src/services/backends/registry';
import { BaseBackendAdapter } from '../src/services/backends/base';
import type { BackendMetadata, SendMessageOptions, SendMessageResult, Message } from '../src/types';

const DEFAULT_WORKSPACE = '/tmp/test-workspace';

let tmpDir: string;
let service: ChatService;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatservice-'));
  service = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE });
  await service.initialize();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

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

  test('tags assistant message with turn kind and persists it', async () => {
    const conv = await service.createConversation();
    const progress = await service.addMessage(conv.id, 'assistant', 'working…', 'claude-code', null, undefined, 'progress');
    const final = await service.addMessage(conv.id, 'assistant', 'done', 'claude-code', null, undefined, 'final');
    expect(progress!.turn).toBe('progress');
    expect(final!.turn).toBe('final');

    const service2 = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE });
    await service2.initialize();
    const loaded = await service2.getConversation(conv.id);
    expect(loaded!.messages[0].turn).toBe('progress');
    expect(loaded!.messages[1].turn).toBe('final');
  });

  test('omits turn when not provided', async () => {
    const conv = await service.createConversation();
    const msg = await service.addMessage(conv.id, 'assistant', 'legacy', 'claude-code');
    expect(msg!.turn).toBeUndefined();
  });

  test('ignores turn for non-assistant roles', async () => {
    const conv = await service.createConversation();
    const msg = await service.addMessage(conv.id, 'user', 'hi', 'claude-code', null, undefined, 'progress');
    expect(msg!.turn).toBeUndefined();
  });

  test('preserves parentAgentId on tool activity entries', async () => {
    const conv = await service.createConversation();
    const activity = [
      { tool: 'Agent', description: 'Research task', id: 'agent_1', isAgent: true, subagentType: 'Explore', duration: 5000, startTime: Date.now() - 5000 },
      { tool: 'Read', description: 'Reading file', id: 'tool_1', parentAgentId: 'agent_1', duration: 300, startTime: Date.now() - 300 },
    ];
    const msg = await service.addMessage(conv.id, 'assistant', 'Done', 'kiro', null, activity);
    expect(msg!.toolActivity![1].parentAgentId).toBe('agent_1');

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.messages[0].toolActivity![1].parentAgentId).toBe('agent_1');
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

  test('hard-cuts fallback title to 8 words', async () => {
    const conv = await service.createConversation('Old Title');
    const tenWords = 'one two three four five six seven eight nine ten';
    const newTitle = await service.generateAndUpdateTitle(conv.id, tenWords);
    expect(newTitle).toBe('one two three four five six seven eight');
    const loaded = await service.getConversation(conv.id);
    expect(loaded!.title).toBe('one two three four five six seven eight');
  });

  test('hard-cuts adapter-returned title to 8 words', async () => {
    class LongTitleAdapter extends BaseBackendAdapter {
      get metadata(): BackendMetadata {
        return { id: 'claude-code', label: 'Test', icon: null, capabilities: {} as any };
      }
      sendMessage(_message: string, _options?: SendMessageOptions): SendMessageResult {
        return { stream: (async function*() {})(), abort: () => {}, sendInput: () => {} };
      }
      async generateSummary(_msgs: Pick<Message, 'role' | 'content'>[], _fb: string): Promise<string> { return _fb; }
      async generateTitle(_msg: string): Promise<string> {
        return 'A Very Long Title With Many Words That Exceeds The Limit';
      }
    }

    const registry = new BackendRegistry();
    registry.register(new LongTitleAdapter());
    const svc = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE, backendRegistry: registry });
    await svc.initialize();

    const conv = await svc.createConversation('Old Title');
    const newTitle = await svc.generateAndUpdateTitle(conv.id, 'some message');
    expect(newTitle).toBe('A Very Long Title With Many Words That');
    const loaded = await svc.getConversation(conv.id);
    expect(loaded!.title).toBe('A Very Long Title With Many Words That');
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

  test('clears contextUsagePercentage on reset', async () => {
    const conv = await service.createConversation('Test');
    await service.updateConversationBackend(conv.id, 'kiro');
    await service.addUsage(conv.id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, contextUsagePercentage: 42 }, 'kiro');

    let usage = await service.getUsage(conv.id);
    expect(usage!.contextUsagePercentage).toBe(42);

    await service.resetSession(conv.id);

    usage = await service.getUsage(conv.id);
    expect(usage!.contextUsagePercentage).toBeUndefined();
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
