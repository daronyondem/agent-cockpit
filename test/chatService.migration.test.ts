/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ChatService } from '../src/services/chatService';
import { workspaceHash } from './helpers/workspace';


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

