/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';
import { workspaceHash } from './helpers/workspace';
import type { StreamEvent } from '../src/types';

let env: ChatRouterEnv;

beforeEach(async () => { env = await createChatRouterEnv(); });
afterEach(async () => { await destroyChatRouterEnv(env); });

describe('GET /workspaces/:hash/memory', () => {
  test('returns enabled=false and snapshot=null when no snapshot has been captured', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/ws-mem-empty');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    const res = await env.request('GET', `/api/chat/workspaces/${hash}/memory`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.snapshot).toBeNull();
  });

  test('returns 200 with null snapshot and enabled for unknown workspace (legacy empty contract)', async () => {
    const res = await env.request('GET', '/api/chat/workspaces/nonexistent999/memory');
    // The new GET endpoint returns a consistent empty shape regardless of
    // whether the workspace index exists; this mirrors the panel UX which
    // treats "unknown" and "no memory yet" identically.
    expect(res.status).toBe(200);
    expect(res.body.snapshot).toBeNull();
    expect(res.body.enabled).toBe(false);
  });

  test('returns the snapshot when one has been saved', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/ws-mem-full');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    const snapshot = {
      capturedAt: '2026-04-07T12:00:00.000Z',
      sourceBackend: 'claude-code',
      sourcePath: '/tmp/source-mem',
      index: '- [Pref](user_pref.md)\n',
      files: [
        {
          filename: 'user_pref.md',
          name: 'Pref',
          description: 'A preference',
          type: 'user' as const,
          content: '---\nname: Pref\ndescription: A preference\ntype: user\n---\n\nBody',
        },
      ],
    };
    await env.chatService.saveWorkspaceMemory(hash, snapshot);

    const res = await env.request('GET', `/api/chat/workspaces/${hash}/memory`);
    expect(res.status).toBe(200);
    expect(res.body.snapshot.sourceBackend).toBe('claude-code');
    expect(res.body.snapshot.files).toHaveLength(1);
    // Saved files now live under `claude/` in the merged snapshot.
    expect(res.body.snapshot.files[0].filename).toBe('claude/user_pref.md');
    expect(res.body.snapshot.files[0].type).toBe('user');
    expect(res.body.snapshot.files[0].source).toBe('cli-capture');
    expect(res.body.enabled).toBe(false);
  });
});

// ── Workspace memory: enable toggle + entry deletion ─────────────────────

describe('PUT /workspaces/:hash/memory/enabled', () => {
  test('persists the enable flag and is round-tripped via GET', async () => {
    const conv = await env.chatService.createConversation('Toggle', '/tmp/ws-mem-toggle');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const put = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/memory/enabled`,
      { enabled: true },
    );
    expect(put.status).toBe(200);
    expect(put.body.enabled).toBe(true);

    const get = await env.request('GET', `/api/chat/workspaces/${hash}/memory`);
    expect(get.status).toBe(200);
    expect(get.body.enabled).toBe(true);
  });

  test('rejects non-boolean enabled values', async () => {
    const conv = await env.chatService.createConversation('Toggle Bad', '/tmp/ws-mem-toggle-bad');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    const res = await env.request(
      'PUT',
      `/api/chat/workspaces/${hash}/memory/enabled`,
      { enabled: 'yes' as unknown as boolean },
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /workspaces/:hash/memory/entries/:relpath', () => {
  test('deletes a note entry and returns the updated snapshot', async () => {
    const conv = await env.chatService.createConversation('Del', '/tmp/ws-mem-del');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const relPath = await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: drop\ndescription: drop me\ntype: user\n---\n\nDrop.',
      source: 'memory-note',
      filenameHint: 'drop',
    });

    const res = await env.request(
      'DELETE',
      `/api/chat/workspaces/${hash}/memory/entries/${encodeURIComponent(relPath)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const loaded = await env.chatService.getWorkspaceMemory(hash);
    expect((loaded?.files || []).find((f) => f.filename === relPath)).toBeUndefined();
  });

  test('returns 400 on path traversal attempts', async () => {
    const conv = await env.chatService.createConversation('Traverse', '/tmp/ws-mem-traverse-http');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    const res = await env.request(
      'DELETE',
      `/api/chat/workspaces/${hash}/memory/entries/${encodeURIComponent('../../../etc/passwd')}`,
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /workspaces/:hash/memory/entries (bulk)', () => {
  test('clears every memory entry and returns the emptied snapshot', async () => {
    const conv = await env.chatService.createConversation('ClearAll', '/tmp/ws-mem-clear-all');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    // Seed two note entries so there's something to wipe.
    await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: one\ndescription: first\ntype: user\n---\n\nOne.',
      source: 'memory-note',
      filenameHint: 'one',
    });
    await env.chatService.addMemoryNoteEntry(hash, {
      content: '---\nname: two\ndescription: second\ntype: feedback\n---\n\nTwo.',
      source: 'memory-note',
      filenameHint: 'two',
    });

    const beforeClear = await env.chatService.getWorkspaceMemory(hash);
    expect((beforeClear?.files || []).length).toBe(2);

    const res = await env.request(
      'DELETE',
      `/api/chat/workspaces/${hash}/memory/entries`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe(2);
    expect((res.body.snapshot?.files || []).length).toBe(0);

    const afterClear = await env.chatService.getWorkspaceMemory(hash);
    expect((afterClear?.files || []).length).toBe(0);
  });

  test('is a no-op (200, deleted: 0) when no entries exist', async () => {
    const conv = await env.chatService.createConversation('ClearEmpty', '/tmp/ws-mem-clear-empty');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const res = await env.request(
      'DELETE',
      `/api/chat/workspaces/${hash}/memory/entries`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe(0);
  });
});

// ── Workspace Knowledge Base endpoints ────────────────────────────────────


describe('memory_update WebSocket frame', () => {
  function makeMockMemoryDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-mem-'));
    return dir;
  }

  function writeMemoryFile(dir: string, name: string, body: string) {
    fs.writeFileSync(
      path.join(dir, name),
      `---\nname: ${name}\ndescription: test\ntype: user\n---\n\n${body}`,
    );
  }

  test('emits memory_update frame with all files on first capture during stream', async () => {
    const memDir = makeMockMemoryDir();
    writeMemoryFile(memDir, 'one.md', 'first');

    const conv = await env.chatService.createConversation('Test', '/tmp/ws-mem-frame-1');
    await env.chatService.setWorkspaceMemoryEnabled(env.chatService.getWorkspaceHashForConv(conv.id)!, true);
    env.mockBackend.setMockMemoryDir(memDir);
    env.mockBackend.setStreamDelayMs(900); // keep stream alive past the 500ms watcher debounce
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws, 5000);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'hello',
      backend: 'claude-code',
    });

    // Trigger a memory file change after the watcher has had time to attach
    await new Promise((r) => setTimeout(r, 100));
    writeMemoryFile(memDir, 'two.md', 'second');

    const events = await eventsPromise;
    fs.rmSync(memDir, { recursive: true, force: true });

    const memUpdate = events.find((e) => e.type === 'memory_update');
    expect(memUpdate).toBeDefined();
    expect(memUpdate.fileCount).toBe(2);
    expect(memUpdate.changedFiles).toEqual(expect.arrayContaining(['one.md', 'two.md']));
    expect(typeof memUpdate.capturedAt).toBe('string');
    expect(memUpdate.sourceConversationId).toBe(conv.id);
    expect(memUpdate.displayInChat).toBe(true);
  });

  test('idle connected workspace conversation receives memory_update from another conversation memory capture', async () => {
    const memDir = makeMockMemoryDir();
    const workspacePath = '/tmp/ws-mem-fanout';
    writeMemoryFile(memDir, 'one.md', 'first');

    const activeConv = await env.chatService.createConversation('Active', workspacePath);
    const idleConv = await env.chatService.createConversation('Idle', workspacePath);
    const hash = env.chatService.getWorkspaceHashForConv(activeConv.id)!;
    expect(env.chatService.getWorkspaceHashForConv(idleConv.id)).toBe(hash);
    await env.chatService.setWorkspaceMemoryEnabled(hash, true);

    env.mockBackend.setMockMemoryDir(memDir);
    env.mockBackend.setStreamDelayMs(900);
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const idleWs = await env.connectWs(idleConv.id);
    const idleMemoryUpdate = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for idle memory_update')), 3000);
      idleWs.on('message', (data) => {
        const event = JSON.parse(data.toString());
        if (event.type === 'memory_update') {
          clearTimeout(timer);
          resolve(event);
        }
      });
    });

    const activeWs = await env.connectWs(activeConv.id);
    const activeEventsPromise = env.readWsEvents(activeWs, 5000);

    await env.request('POST', `/api/chat/conversations/${activeConv.id}/message`, {
      content: 'hello',
      backend: 'claude-code',
    });

    await new Promise((r) => setTimeout(r, 100));
    writeMemoryFile(memDir, 'two.md', 'second');

    const frame = await idleMemoryUpdate;
    const activeEvents = await activeEventsPromise;
    idleWs.close();
    fs.rmSync(memDir, { recursive: true, force: true });

    const activeFrame = activeEvents.find((e) => e.type === 'memory_update');
    expect(activeFrame).toBeDefined();
    expect(activeFrame.sourceConversationId).toBe(activeConv.id);
    expect(activeFrame.displayInChat).toBe(true);
    expect(frame.type).toBe('memory_update');
    expect(frame.fileCount).toBe(2);
    expect(frame.changedFiles).toEqual(expect.arrayContaining(['one.md', 'two.md']));
    expect(frame.sourceConversationId).toBe(activeConv.id);
    expect(frame.displayInChat).toBe(false);
  });

  test('changedFiles only includes files that changed since previous frame', async () => {
    const memDir = makeMockMemoryDir();
    writeMemoryFile(memDir, 'a.md', 'A');
    writeMemoryFile(memDir, 'b.md', 'B');

    const conv = await env.chatService.createConversation('Test', '/tmp/ws-mem-frame-2');
    await env.chatService.setWorkspaceMemoryEnabled(env.chatService.getWorkspaceHashForConv(conv.id)!, true);
    env.mockBackend.setMockMemoryDir(memDir);
    env.mockBackend.setStreamDelayMs(1500);
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'x', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws, 6000);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'hello',
      backend: 'claude-code',
    });

    // First memory burst → first frame should include both files
    await new Promise((r) => setTimeout(r, 100));
    fs.utimesSync(path.join(memDir, 'a.md'), new Date(), new Date()); // touch
    await new Promise((r) => setTimeout(r, 700)); // wait past debounce so a frame fires

    // Second burst: change only b.md
    writeMemoryFile(memDir, 'b.md', 'B-changed');

    const events = await eventsPromise;
    fs.rmSync(memDir, { recursive: true, force: true });

    const memUpdates = events.filter((e) => e.type === 'memory_update');
    expect(memUpdates.length).toBeGreaterThanOrEqual(2);
    // First frame: both files are unknown to the diff state, so both appear
    expect(memUpdates[0].changedFiles).toEqual(expect.arrayContaining(['a.md', 'b.md']));
    // Second frame: only b.md changed
    expect(memUpdates[memUpdates.length - 1].changedFiles).toEqual(['b.md']);
  });

  test('does not emit memory_update when adapter has no memory dir', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/ws-mem-frame-3');
    await env.chatService.setWorkspaceMemoryEnabled(env.chatService.getWorkspaceHashForConv(conv.id)!, true);
    env.mockBackend.setMockMemoryDir(null);
    env.mockBackend.setStreamDelayMs(800);
    env.mockBackend.setMockEvents([
      { type: 'text', content: 'hi', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws, 4000);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'hello',
      backend: 'claude-code',
    });

    const events = await eventsPromise;
    expect(events.find((e) => e.type === 'memory_update')).toBeUndefined();
  });
});
