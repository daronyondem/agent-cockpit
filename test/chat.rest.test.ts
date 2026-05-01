/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';
import type { StreamEvent, ActiveStreamEntry } from '../src/types';

let env: ChatRouterEnv;

beforeEach(async () => { env = await createChatRouterEnv(); });
afterEach(async () => { await destroyChatRouterEnv(env); });

async function startPendingMessage(content = 'first') {
  const conv = await env.chatService.createConversation('Pending Send Guard');
  let releaseUserAdd!: () => void;
  let markUserAddStarted!: () => void;
  let sendCalls = 0;
  const userAddGate = new Promise<void>(resolve => { releaseUserAdd = resolve; });
  const userAddStarted = new Promise<void>(resolve => { markUserAddStarted = resolve; });

  const originalAddMessage = env.chatService.addMessage.bind(env.chatService);
  let userAddAttempts = 0;
  env.chatService.addMessage = (async (...args: Parameters<typeof env.chatService.addMessage>) => {
    if (args[1] === 'user') {
      userAddAttempts += 1;
      if (userAddAttempts === 1) {
        markUserAddStarted();
        await userAddGate;
      }
    }
    return originalAddMessage(...args);
  }) as typeof env.chatService.addMessage;

  env.mockBackend.sendMessage = function() {
    sendCalls += 1;
    return {
      stream: (async function*() { yield { type: 'done' } as StreamEvent; })(),
      abort: () => {},
      sendInput: () => {},
    };
  };

  const sendPromise = env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
    content,
    backend: 'claude-code',
  });
  await userAddStarted;

  return {
    conv,
    releaseUserAdd,
    sendPromise,
    sendCalls: () => sendCalls,
  };
}

describe('PATCH /conversations/:id/archive', () => {
  test('archives a conversation', async () => {
    const conv = await env.chatService.createConversation('Test');
    const res = await env.request('PATCH', `/api/chat/conversations/${conv.id}/archive`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Should not appear in default list
    const listRes = await env.request('GET', '/api/chat/conversations');
    expect(listRes.body.conversations.find((c: any) => c.id === conv.id)).toBeUndefined();

    // Should appear in archived list
    const archiveRes = await env.request('GET', '/api/chat/conversations?archived=true');
    expect(archiveRes.body.conversations.find((c: any) => c.id === conv.id)).toBeDefined();
  });

  test('returns 404 for non-existent conversation', async () => {
    const res = await env.request('PATCH', '/api/chat/conversations/nope/archive');
    expect(res.status).toBe(404);
  });
});

// ── PATCH /conversations/:id/restore ─────────────────────────────────────────

describe('PATCH /conversations/:id/restore', () => {
  test('restores an archived conversation', async () => {
    const conv = await env.chatService.createConversation('Test');
    await env.chatService.archiveConversation(conv.id);

    const res = await env.request('PATCH', `/api/chat/conversations/${conv.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Should appear in default list again
    const listRes = await env.request('GET', '/api/chat/conversations');
    expect(listRes.body.conversations.find((c: any) => c.id === conv.id)).toBeDefined();
  });

  test('returns 404 for non-existent conversation', async () => {
    const res = await env.request('PATCH', '/api/chat/conversations/nope/restore');
    expect(res.status).toBe(404);
  });
});

// ── PATCH /conversations/:id/unread ──────────────────────────────────────────

describe('PATCH /conversations/:id/unread', () => {
  test('sets unread flag and surfaces it on list', async () => {
    const conv = await env.chatService.createConversation('Test');
    const res = await env.request('PATCH', `/api/chat/conversations/${conv.id}/unread`, { unread: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.unread).toBe(true);

    const listRes = await env.request('GET', '/api/chat/conversations');
    const item = listRes.body.conversations.find((c: any) => c.id === conv.id);
    expect(item.unread).toBe(true);
  });

  test('clears unread flag (omitted from list summary)', async () => {
    const conv = await env.chatService.createConversation('Test');
    await env.chatService.setConversationUnread(conv.id, true);

    const res = await env.request('PATCH', `/api/chat/conversations/${conv.id}/unread`, { unread: false });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.unread).toBe(false);

    const listRes = await env.request('GET', '/api/chat/conversations');
    const item = listRes.body.conversations.find((c: any) => c.id === conv.id);
    expect(item.unread).toBeUndefined();
  });

  test('treats empty body as clear', async () => {
    const conv = await env.chatService.createConversation('Test');
    await env.chatService.setConversationUnread(conv.id, true);

    const res = await env.request('PATCH', `/api/chat/conversations/${conv.id}/unread`, {});
    expect(res.status).toBe(200);
    expect(res.body.unread).toBe(false);
  });

  test('returns 404 for non-existent conversation', async () => {
    const res = await env.request('PATCH', '/api/chat/conversations/nope/unread', { unread: true });
    expect(res.status).toBe(404);
  });
});

// ── GET /conversations?archived=true ──────��─────────────────────────────────

describe('GET /conversations?archived=true', () => {
  test('returns only archived conversations', async () => {
    const c1 = await env.chatService.createConversation('Active');
    const c2 = await env.chatService.createConversation('Archived');
    await env.chatService.archiveConversation(c2.id);

    const activeRes = await env.request('GET', '/api/chat/conversations');
    expect(activeRes.body.conversations).toHaveLength(1);
    expect(activeRes.body.conversations[0].id).toBe(c1.id);

    const archivedRes = await env.request('GET', '/api/chat/conversations?archived=true');
    expect(archivedRes.body.conversations).toHaveLength(1);
    expect(archivedRes.body.conversations[0].id).toBe(c2.id);
  });
});

describe('GET /active-streams', () => {
  test('returns empty list when no streams are active', async () => {
    const res = await env.request('GET', '/api/chat/active-streams');
    expect(res.status).toBe(200);
    expect(res.body.ids).toEqual([]);
  });

  test('returns ids of conversations with live entries in env.activeStreams', async () => {
    const c1 = await env.chatService.createConversation('Live 1');
    const c2 = await env.chatService.createConversation('Live 2');
    const c3 = await env.chatService.createConversation('Idle');

    const makeEntry = (): ActiveStreamEntry => ({
      stream: (async function* () { yield { type: 'done' } as StreamEvent; })(),
      abort: () => {},
      sendInput: () => {},
      backend: 'claude-code',
      needsTitleUpdate: false,
      titleUpdateMessage: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      lastEventAt: '2026-01-01T00:00:01.000Z',
    });
    env.activeStreams.set(c1.id, makeEntry());
    env.activeStreams.set(c2.id, makeEntry());

    const res = await env.request('GET', '/api/chat/active-streams');
    expect(res.status).toBe(200);
    expect(res.body.ids).toEqual(expect.arrayContaining([c1.id, c2.id]));
    expect(res.body.ids).toHaveLength(2);
    expect(res.body.ids).not.toContain(c3.id);
    expect(res.body.streams).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: c1.id,
        backend: 'claude-code',
        startedAt: '2026-01-01T00:00:00.000Z',
        lastEventAt: '2026-01-01T00:00:01.000Z',
        connected: false,
      }),
    ]));

    env.activeStreams.delete(c1.id);
    env.activeStreams.delete(c2.id);
  });
});

describe('POST /conversations/:id/abort', () => {
  test('aborts active stream without requiring an open WebSocket and buffers terminal abort frames', async () => {
    const conv = await env.chatService.createConversation('REST Abort');
    let aborted = false;
    let unblock: () => void;
    const blockPromise = new Promise<void>(r => { unblock = r; });
    env.mockBackend.sendMessage = function() {
      async function* createStream() {
        yield { type: 'text', content: 'working', streaming: true } as StreamEvent;
        await blockPromise;
        yield { type: 'done' } as StreamEvent;
      }
      return {
        stream: createStream(),
        abort: () => { aborted = true; unblock!(); },
        sendInput: () => {},
      };
    };

    const send = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'start',
      backend: 'claude-code',
    });
    expect(send.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(env.activeStreams.has(conv.id)).toBe(true);

    const abort = await env.request('POST', `/api/chat/conversations/${conv.id}/abort`, {});
    expect(abort.status).toBe(200);
    expect(abort.body).toEqual({ ok: true, aborted: true });
    expect(aborted).toBe(true);
    expect(env.activeStreams.has(conv.id)).toBe(false);

    const saved = await env.chatService.getConversation(conv.id);
    const assistant = saved?.messages.filter(m => m.role === 'assistant') || [];
    expect(assistant.map(m => m.content)).toEqual([
      'working',
      'Stream failed: Aborted by user',
    ]);
    expect(assistant[1].streamError).toEqual({ message: 'Aborted by user', source: 'abort' });

    const port = (env.server.address() as any).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/chat/conversations/${conv.id}/ws`);
    const events: any[] = [];
    const gotDone = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const event = JSON.parse(data.toString());
        events.push(event);
        if (event.type === 'done') resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    await gotDone;
    expect(events.find((e: any) => e.type === 'assistant_message' && e.message?.streamError)?.message?.streamError).toEqual({
      message: 'Aborted by user',
      source: 'abort',
    });
    expect(events.find((e: any) => e.type === 'error')).toMatchObject({
      error: 'Aborted by user',
      terminal: true,
      source: 'abort',
    });
    expect(events.find((e: any) => e.type === 'done')).toBeDefined();
    ws.close();
  });

  test('is idempotent when no stream is active and 404s unknown conversations', async () => {
    const conv = await env.chatService.createConversation('REST Abort Idle');
    const idle = await env.request('POST', `/api/chat/conversations/${conv.id}/abort`, {});
    expect(idle.status).toBe(200);
    expect(idle.body).toEqual({ ok: true, aborted: false });

    const missing = await env.request('POST', '/api/chat/conversations/missing/abort', {});
    expect(missing.status).toBe(404);
  });

  test('handles concurrent abort requests without duplicate backend aborts or stream-error messages', async () => {
    const conv = await env.chatService.createConversation('REST Abort Race');
    let abortCalls = 0;
    let unblock: () => void;
    const blockPromise = new Promise<void>(r => { unblock = r; });
    env.mockBackend.sendMessage = function() {
      async function* createStream() {
        yield { type: 'text', content: 'working', streaming: true } as StreamEvent;
        await blockPromise;
        yield { type: 'done' } as StreamEvent;
      }
      return {
        stream: createStream(),
        abort: () => { abortCalls += 1; unblock!(); },
        sendInput: () => {},
      };
    };

    const originalAddStreamErrorMessage = env.chatService.addStreamErrorMessage.bind(env.chatService);
    env.chatService.addStreamErrorMessage = (async (...args: Parameters<typeof env.chatService.addStreamErrorMessage>) => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return originalAddStreamErrorMessage(...args);
    }) as typeof env.chatService.addStreamErrorMessage;

    const send = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'start',
      backend: 'claude-code',
    });
    expect(send.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(env.activeStreams.has(conv.id)).toBe(true);

    const [first, second] = await Promise.all([
      env.request('POST', `/api/chat/conversations/${conv.id}/abort`, {}),
      env.request('POST', `/api/chat/conversations/${conv.id}/abort`, {}),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(abortCalls).toBe(1);

    const saved = await env.chatService.getConversation(conv.id);
    const streamErrors = (saved?.messages || []).filter(m => m.streamError);
    expect(streamErrors).toHaveLength(1);
    expect(streamErrors[0].streamError).toEqual({ message: 'Aborted by user', source: 'abort' });
  });

  test('does not replace an in-flight terminal backend error with a late abort', async () => {
    const conv = await env.chatService.createConversation('REST Abort Terminal Race');
    let abortCalls = 0;
    env.mockBackend.sendMessage = function() {
      async function* createStream() {
        yield { type: 'text', content: 'partial', streaming: true } as StreamEvent;
        yield { type: 'error', error: 'usage limit reached', source: 'backend' } as StreamEvent;
      }
      return {
        stream: createStream(),
        abort: () => { abortCalls += 1; },
        sendInput: () => {},
      };
    };

    const originalAddStreamErrorMessage = env.chatService.addStreamErrorMessage.bind(env.chatService);
    let releasePersist!: () => void;
    let markPersistStarted!: () => void;
    const persistGate = new Promise<void>(resolve => { releasePersist = resolve; });
    const persistStarted = new Promise<void>(resolve => { markPersistStarted = resolve; });
    env.chatService.addStreamErrorMessage = (async (...args: Parameters<typeof env.chatService.addStreamErrorMessage>) => {
      markPersistStarted();
      await persistGate;
      return originalAddStreamErrorMessage(...args);
    }) as typeof env.chatService.addStreamErrorMessage;

    const send = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'start',
      backend: 'claude-code',
    });
    expect(send.status).toBe(200);
    await persistStarted;
    expect(env.activeStreams.has(conv.id)).toBe(true);

    const abortPromise = env.request('POST', `/api/chat/conversations/${conv.id}/abort`, {});
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(abortCalls).toBe(0);

    releasePersist();
    const abort = await abortPromise;
    expect(abort.status).toBe(200);
    expect(abort.body).toEqual({ ok: true, aborted: true });

    const saved = await env.chatService.getConversation(conv.id);
    const streamErrors = (saved?.messages || []).filter(m => m.streamError);
    expect(streamErrors).toHaveLength(1);
    expect(streamErrors[0].streamError).toEqual({ message: 'usage limit reached', source: 'backend' });
    expect(env.activeStreams.has(conv.id)).toBe(false);
  });
});

describe('pending message send lifecycle guards', () => {
  test('abort marks a pending send cancelled before the backend stream starts', async () => {
    const pending = await startPendingMessage('stop before stream');

    const abort = await env.request('POST', `/api/chat/conversations/${pending.conv.id}/abort`, {});
    expect(abort.status).toBe(200);
    expect(abort.body).toEqual({ ok: true, aborted: true });

    pending.releaseUserAdd();
    const send = await pending.sendPromise;
    expect(send.status).toBe(200);
    expect(send.body.streamReady).toBe(false);
    expect(send.body.aborted).toBe(true);
    expect(pending.sendCalls()).toBe(0);
    expect(env.activeStreams.has(pending.conv.id)).toBe(false);

    const saved = await env.chatService.getConversation(pending.conv.id);
    expect(saved?.messages.filter(m => m.role === 'user').map(m => m.content)).toEqual(['stop before stream']);
    const streamErrors = (saved?.messages || []).filter(m => m.streamError);
    expect(streamErrors).toHaveLength(1);
    expect(streamErrors[0].streamError).toEqual({ message: 'Aborted by user', source: 'abort' });
  });

  test('reset, archive, and delete reject while a send is still pending', async () => {
    const pending = await startPendingMessage('block mutations');

    const reset = await env.request('POST', `/api/chat/conversations/${pending.conv.id}/reset`, {});
    expect(reset.status).toBe(409);
    expect(reset.body.error).toBe('Cannot reset session while streaming');

    const archive = await env.request('PATCH', `/api/chat/conversations/${pending.conv.id}/archive`, {});
    expect(archive.status).toBe(409);
    expect(archive.body.error).toBe('Conversation is already streaming');

    const del = await env.request('DELETE', `/api/chat/conversations/${pending.conv.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toBe('Conversation is already streaming');

    pending.releaseUserAdd();
    const send = await pending.sendPromise;
    expect(send.status).toBe(200);
    expect(pending.sendCalls()).toBe(1);
  });

  test('update and restart guards include pending sends', async () => {
    await destroyChatRouterEnv(env);
    const fakeUpdateService = {
      triggerUpdate: jest.fn(async (opts: { hasActiveStreams?: () => boolean }) => (
        opts.hasActiveStreams?.()
          ? { success: false, steps: [], error: 'Cannot update while conversations are actively running.' }
          : { success: true, steps: [] }
      )),
      restart: jest.fn(async (opts: { hasActiveStreams?: () => boolean }) => (
        opts.hasActiveStreams?.()
          ? { success: false, steps: [], error: 'Cannot restart while conversations are actively running.' }
          : { success: true, steps: [] }
      )),
      stop: jest.fn(),
    };
    env = await createChatRouterEnv({ updateService: fakeUpdateService });
    const pending = await startPendingMessage('block restart');

    const update = await env.request('POST', '/api/chat/update-trigger', {});
    expect(update.status).toBe(200);
    expect(update.body.success).toBe(false);
    expect(fakeUpdateService.triggerUpdate).toHaveBeenCalled();

    const restart = await env.request('POST', '/api/chat/server/restart', {});
    expect(restart.status).toBe(409);
    expect(restart.body.success).toBe(false);
    expect(fakeUpdateService.restart).toHaveBeenCalled();

    pending.releaseUserAdd();
    const send = await pending.sendPromise;
    expect(send.status).toBe(200);
  });
});

describe('POST /conversations/:id/message active-stream guard', () => {
  test('concurrent sends only persist one user message and start one stream', async () => {
    const conv = await env.chatService.createConversation('Concurrent Send Guard');

    let releaseFirstAdd!: () => void;
    let markFirstAddStarted!: () => void;
    let unblock!: () => void;
    let sendCalls = 0;
    const firstAddGate = new Promise<void>(resolve => { releaseFirstAdd = resolve; });
    const firstAddStarted = new Promise<void>(resolve => { markFirstAddStarted = resolve; });
    const blockPromise = new Promise<void>(resolve => { unblock = resolve; });

    const originalAddMessage = env.chatService.addMessage.bind(env.chatService);
    let userAddAttempts = 0;
    env.chatService.addMessage = (async (...args: Parameters<typeof env.chatService.addMessage>) => {
      if (args[1] === 'user') {
        userAddAttempts += 1;
        if (userAddAttempts === 1) {
          markFirstAddStarted();
          await firstAddGate;
        }
      }
      return originalAddMessage(...args);
    }) as typeof env.chatService.addMessage;

    env.mockBackend.sendMessage = function() {
      sendCalls += 1;
      async function* createStream() {
        yield { type: 'text', content: 'working', streaming: true } as StreamEvent;
        await blockPromise;
        yield { type: 'done' } as StreamEvent;
      }
      return {
        stream: createStream(),
        abort: () => { unblock(); },
        sendInput: () => {},
      };
    };

    const firstPromise = env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'first',
      backend: 'claude-code',
    });
    await firstAddStarted;

    const secondPromise = env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'second',
      backend: 'claude-code',
    });

    await new Promise(resolve => setTimeout(resolve, 25));
    releaseFirstAdd();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(sendCalls).toBe(1);

    const during = await env.chatService.getConversation(conv.id);
    expect(during?.messages.filter(m => m.role === 'user').map(m => m.content)).toEqual(['first']);

    unblock();
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  test('returns 409 before persisting duplicate user message or mutating send settings', async () => {
    const conv = await env.chatService.createConversation('Active Send Guard', undefined, 'claude-code', 'sonnet', 'medium');

    let unblock: () => void;
    const blockPromise = new Promise<void>(r => { unblock = r; });
    env.mockBackend.sendMessage = function() {
      async function* createStream() {
        yield { type: 'text', content: 'working', streaming: true } as StreamEvent;
        await blockPromise;
        yield { type: 'done' } as StreamEvent;
      }
      return {
        stream: createStream(),
        abort: () => { unblock!(); },
        sendInput: () => {},
      };
    };

    const first = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'first',
      backend: 'claude-code',
      model: 'opus',
      effort: 'high',
    });
    expect(first.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(env.activeStreams.has(conv.id)).toBe(true);

    const second = await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'second',
      backend: 'kiro',
      model: 'kiro-model',
      effort: 'low',
    });
    expect(second.status).toBe(409);

    const during = await env.chatService.getConversation(conv.id);
    expect(during?.messages.filter(m => m.role === 'user').map(m => m.content)).toEqual(['first']);
    expect(during?.backend).toBe('claude-code');
    expect(during?.model).toBe('opus');
    expect(during?.effort).toBe('high');

    unblock!();
    await new Promise(resolve => setTimeout(resolve, 100));
  });
});

// ── DELETE /conversations/:id/upload/:filename ─────────────────────────────��──

describe('DELETE /conversations/:id/upload/:filename', () => {
  test('deletes an uploaded file', async () => {
    const conv = await env.chatService.createConversation('Test');
    const artifactDir = path.join(env.tmpDir, 'data', 'chat', 'artifacts', conv.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'test.txt'), 'hello');

    const res = await env.request('DELETE', `/api/chat/conversations/${conv.id}/upload/test.txt`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'test.txt'))).toBe(false);
  });

  test('returns 404 for non-existent file', async () => {
    const conv = await env.chatService.createConversation('Test');
    const res = await env.request('DELETE', `/api/chat/conversations/${conv.id}/upload/nope.txt`);
    expect(res.status).toBe(404);
  });

  test('sanitizes slashes in filename', async () => {
    const conv = await env.chatService.createConversation('Test');
    const artifactDir = path.join(env.tmpDir, 'data', 'chat', 'artifacts', conv.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'a_b.txt'), 'data');

    // Filename with slash gets sanitized to underscore, matching upload behavior
    const res = await env.request('DELETE', `/api/chat/conversations/${conv.id}/upload/a%2Fb.txt`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'a_b.txt'))).toBe(false);
  });
});

// ── POST /conversations/:id/attachments/ocr ─────────────────────────────────

describe('POST /conversations/:id/attachments/ocr', () => {
  test('returns markdown from the backend runOneShot', async () => {
    const conv = await env.chatService.createConversation('Test');
    const artifactDir = path.join(env.chatService.artifactsDir, conv.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    const imagePath = path.join(artifactDir, 'screenshot.png');
    fs.writeFileSync(imagePath, 'fakeimage');

    env.mockBackend.setOneShotImpl(async () => '# Heading\n\n| col1 | col2 |\n|---|---|\n| a | b |\n');

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/attachments/ocr`, { path: imagePath });
    expect(res.status).toBe(200);
    expect(res.body.markdown).toContain('# Heading');
    expect(res.body.markdown).toContain('| col1 | col2 |');

    const call = env.mockBackend._oneShotCalls[env.mockBackend._oneShotCalls.length - 1];
    expect(call.prompt).toContain(imagePath);
    expect(call.options?.allowTools).toBe(true);
  });

  test('rejects paths outside the conversation artifacts dir', async () => {
    const conv = await env.chatService.createConversation('Test');
    env.mockBackend.setOneShotImpl(async () => 'should not be called');

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/attachments/ocr`, { path: '/etc/passwd' });
    expect(res.status).toBe(400);
    expect(env.mockBackend._oneShotCalls).toHaveLength(0);
  });

  test('rejects paths from a different conversation', async () => {
    const convA = await env.chatService.createConversation('A');
    const convB = await env.chatService.createConversation('B');
    const artifactDirB = path.join(env.chatService.artifactsDir, convB.id);
    fs.mkdirSync(artifactDirB, { recursive: true });
    const imagePathB = path.join(artifactDirB, 'image.png');
    fs.writeFileSync(imagePathB, 'fakeimage');

    env.mockBackend.setOneShotImpl(async () => 'should not be called');

    const res = await env.request('POST', `/api/chat/conversations/${convA.id}/attachments/ocr`, { path: imagePathB });
    expect(res.status).toBe(400);
    expect(env.mockBackend._oneShotCalls).toHaveLength(0);
  });

  test('returns 404 when attachment file does not exist', async () => {
    const conv = await env.chatService.createConversation('Test');
    const artifactDir = path.join(env.chatService.artifactsDir, conv.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    const ghostPath = path.join(artifactDir, 'nope.png');

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/attachments/ocr`, { path: ghostPath });
    expect(res.status).toBe(404);
  });

  test('refuses non-image attachments', async () => {
    const conv = await env.chatService.createConversation('Test');
    const artifactDir = path.join(env.chatService.artifactsDir, conv.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    const txtPath = path.join(artifactDir, 'notes.txt');
    fs.writeFileSync(txtPath, 'plain text');

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/attachments/ocr`, { path: txtPath });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/image/i);
  });

  test('returns 502 when runOneShot throws', async () => {
    const conv = await env.chatService.createConversation('Test');
    const artifactDir = path.join(env.chatService.artifactsDir, conv.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    const imagePath = path.join(artifactDir, 'screenshot.png');
    fs.writeFileSync(imagePath, 'fakeimage');

    env.mockBackend.setOneShotImpl(async () => { throw new Error('cli boom'); });

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/attachments/ocr`, { path: imagePath });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/cli boom/);
  });

  test('returns 502 on empty runOneShot output', async () => {
    const conv = await env.chatService.createConversation('Test');
    const artifactDir = path.join(env.chatService.artifactsDir, conv.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    const imagePath = path.join(artifactDir, 'screenshot.png');
    fs.writeFileSync(imagePath, 'fakeimage');

    env.mockBackend.setOneShotImpl(async () => '   ');

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/attachments/ocr`, { path: imagePath });
    expect(res.status).toBe(502);
  });

  test('rejects request without a path', async () => {
    const conv = await env.chatService.createConversation('Test');
    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/attachments/ocr`, {});
    expect(res.status).toBe(400);
  });
});

// ── GET /conversations/:id/files/:filename ──────────────────────────────────

describe('GET /conversations/:id/files/:filename', () => {
  test('serves an uploaded file', async () => {
    const conv = await env.chatService.createConversation('Test');
    const artifactDir = path.join(env.tmpDir, 'data', 'chat', 'artifacts', conv.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'photo.png'), 'fakeimage');

    const res = await env.request('GET', `/api/chat/conversations/${conv.id}/files/photo.png`);
    expect(res.status).toBe(200);
  });

  test('returns 404 for non-existent file', async () => {
    const conv = await env.chatService.createConversation('Test');
    const res = await env.request('GET', `/api/chat/conversations/${conv.id}/files/nope.png`);
    expect(res.status).toBe(404);
  });

  test('sanitizes slashes in filename', async () => {
    const conv = await env.chatService.createConversation('Test');
    const artifactDir = path.join(env.tmpDir, 'data', 'chat', 'artifacts', conv.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'a_b.png'), 'data');

    const res = await env.request('GET', `/api/chat/conversations/${conv.id}/files/a%2Fb.png`);
    expect(res.status).toBe(200);
  });

  test('mode=view returns JSON with content and language', async () => {
    const conv = await env.chatService.createConversation('Test');
    const artifactDir = path.join(env.tmpDir, 'data', 'chat', 'artifacts', conv.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'notes.txt'), 'hello world');

    const res = await env.request('GET', `/api/chat/conversations/${conv.id}/files/notes.txt?mode=view`);
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('hello world');
    expect(res.body.filename).toBe('notes.txt');
    expect(res.body.language).toBe('txt');
  });

  test('mode=download returns file with Content-Disposition', async () => {
    const conv = await env.chatService.createConversation('Test');
    const artifactDir = path.join(env.tmpDir, 'data', 'chat', 'artifacts', conv.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'doc.txt'), 'download me');

    const res = await env.request('GET', `/api/chat/conversations/${conv.id}/files/doc.txt?mode=download`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('doc.txt');
  });
});

// ── POST /mkdir ─────────────────────────────────────────────────────────────

describe('POST /mkdir', () => {
  test('creates a folder and returns its path', async () => {
    const res = await env.request('POST', '/api/chat/mkdir', { parentPath: env.tmpDir, name: 'new-folder' });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(path.join(env.tmpDir, 'new-folder'));
    expect(fs.existsSync(path.join(env.tmpDir, 'new-folder'))).toBe(true);
  });

  test('returns 400 when parentPath is missing', async () => {
    const res = await env.request('POST', '/api/chat/mkdir', { name: 'test' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when name is missing', async () => {
    const res = await env.request('POST', '/api/chat/mkdir', { parentPath: env.tmpDir });
    expect(res.status).toBe(400);
  });

  test('rejects name containing slash', async () => {
    const res = await env.request('POST', '/api/chat/mkdir', { parentPath: env.tmpDir, name: 'a/b' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid folder name');
  });

  test('rejects name containing backslash', async () => {
    const res = await env.request('POST', '/api/chat/mkdir', { parentPath: env.tmpDir, name: 'a\\b' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid folder name');
  });

  test('rejects dot-dot traversal', async () => {
    const res = await env.request('POST', '/api/chat/mkdir', { parentPath: env.tmpDir, name: '..' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid folder name');
  });

  test('rejects single dot', async () => {
    const res = await env.request('POST', '/api/chat/mkdir', { parentPath: env.tmpDir, name: '.' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid folder name');
  });

  test('returns 409 when folder already exists', async () => {
    fs.mkdirSync(path.join(env.tmpDir, 'existing'));
    const res = await env.request('POST', '/api/chat/mkdir', { parentPath: env.tmpDir, name: 'existing' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Folder already exists');
  });

  test('returns 403 for read-only parent directory', async () => {
    const readonlyDir = path.join(env.tmpDir, 'readonly');
    fs.mkdirSync(readonlyDir);
    fs.chmodSync(readonlyDir, 0o444);
    const res = await env.request('POST', '/api/chat/mkdir', { parentPath: readonlyDir, name: 'nope' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Permission denied');
    // Restore permissions for cleanup
    fs.chmodSync(readonlyDir, 0o755);
  });
});

// ── GET /conversations/:id/sessions/:num/messages ──────────────────────────

describe('GET /conversations/:id/sessions/:num/messages', () => {
  test('returns current session messages', async () => {
    const conv = await env.chatService.createConversation('Test');
    await env.chatService.addMessage(conv.id, 'user', 'Hello', 'claude-code');
    await env.chatService.addMessage(conv.id, 'assistant', 'Hi', 'claude-code');

    const loaded = (await env.chatService.getConversation(conv.id))!;
    const res = await env.request('GET', `/api/chat/conversations/${conv.id}/sessions/${loaded.sessionNumber}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0].content).toBe('Hello');
  });

  test('returns archived session messages', async () => {
    const conv = await env.chatService.createConversation('Test');
    await env.chatService.addMessage(conv.id, 'user', 'Old msg', 'claude-code');

    // Mock summary generation to avoid CLI calls
    (env.chatService as any)._generateSessionSummary = async (msgs: any, fallback: any) => fallback;
    await env.chatService.resetSession(conv.id);

    const res = await env.request('GET', `/api/chat/conversations/${conv.id}/sessions/1/messages`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].content).toBe('Old msg');
  });

  test('returns 404 for non-existent session', async () => {
    const conv = await env.chatService.createConversation('Test');
    const res = await env.request('GET', `/api/chat/conversations/${conv.id}/sessions/99/messages`);
    expect(res.status).toBe(404);
  });

  test('returns 400 for invalid session number', async () => {
    const conv = await env.chatService.createConversation('Test');
    const res = await env.request('GET', `/api/chat/conversations/${conv.id}/sessions/0/messages`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid session number');
  });
});

// ── POST /rmdir ─────────────────────────────────────────────────────────────

describe('POST /rmdir', () => {
  test('deletes a folder and returns parent path', async () => {
    const target = path.join(env.tmpDir, 'to-delete');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'file.txt'), 'data');
    const res = await env.request('POST', '/api/chat/rmdir', { dirPath: target });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(target);
    expect(res.body.parent).toBe(env.tmpDir);
    expect(fs.existsSync(target)).toBe(false);
  });

  test('recursively deletes nested contents', async () => {
    const target = path.join(env.tmpDir, 'nested');
    fs.mkdirSync(path.join(target, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(target, 'sub', 'deep', 'file.txt'), 'data');
    const res = await env.request('POST', '/api/chat/rmdir', { dirPath: target });
    expect(res.status).toBe(200);
    expect(fs.existsSync(target)).toBe(false);
  });

  test('returns 400 when dirPath is missing', async () => {
    const res = await env.request('POST', '/api/chat/rmdir', {});
    expect(res.status).toBe(400);
  });

  test('returns 400 when trying to delete filesystem root', async () => {
    const res = await env.request('POST', '/api/chat/rmdir', { dirPath: '/' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot delete filesystem root');
  });

  test('returns 404 when folder does not exist', async () => {
    const res = await env.request('POST', '/api/chat/rmdir', { dirPath: path.join(env.tmpDir, 'nonexistent') });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Folder does not exist');
  });

  test('returns 400 when path is a file not a directory', async () => {
    const filePath = path.join(env.tmpDir, 'afile.txt');
    fs.writeFileSync(filePath, 'data');
    const res = await env.request('POST', '/api/chat/rmdir', { dirPath: filePath });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Path is not a directory');
  });
});

// ── Workspace instructions API ─────────────────────────────────────────────

describe('GET /workspaces/:hash/instructions', () => {
  test('returns empty instructions for workspace with no instructions', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/ws-api');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    const res = await env.request('GET', `/api/chat/workspaces/${hash}/instructions`);
    expect(res.status).toBe(200);
    expect(res.body.instructions).toBe('');
  });

  test('returns 404 for non-existent workspace', async () => {
    const res = await env.request('GET', '/api/chat/workspaces/nonexistent123/instructions');
    expect(res.status).toBe(404);
  });
});

describe('PUT /workspaces/:hash/instructions', () => {
  test('saves and returns instructions', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/ws-put');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const res = await env.request('PUT', `/api/chat/workspaces/${hash}/instructions`, {
      instructions: 'Always use TypeScript',
    });
    expect(res.status).toBe(200);
    expect(res.body.instructions).toBe('Always use TypeScript');

    // Verify persisted
    const getRes = await env.request('GET', `/api/chat/workspaces/${hash}/instructions`);
    expect(getRes.body.instructions).toBe('Always use TypeScript');
  });

  test('returns 400 when instructions is not a string', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/ws-bad');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;

    const res = await env.request('PUT', `/api/chat/workspaces/${hash}/instructions`, {
      instructions: 123,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('instructions must be a string');
  });

  test('returns 404 for non-existent workspace', async () => {
    const res = await env.request('PUT', '/api/chat/workspaces/nonexistent123/instructions', {
      instructions: 'test',
    });
    expect(res.status).toBe(404);
  });
});

describe('Workspace instructions in system prompt', () => {
  test('combines global system prompt with workspace instructions on new session', async () => {
    await env.chatService.saveSettings({ theme: 'system', systemPrompt: 'Global prompt' } as any);

    const conv = await env.chatService.createConversation('Test', '/tmp/ws-combo');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceInstructions(hash, 'Workspace instructions');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    expect(env.mockBackend._lastOptions!.systemPrompt).toContain('Global prompt');
    expect(env.mockBackend._lastOptions!.systemPrompt).toContain('Workspace instructions');
  });

  test('sends only workspace instructions when no global prompt', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/ws-only');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceInstructions(hash, 'Only workspace');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Hello',
      backend: 'claude-code',
    });

    expect(env.mockBackend._lastOptions!.systemPrompt).toContain('Only workspace');
    expect(env.mockBackend._lastOptions!.systemPrompt).toContain('FILE_DELIVERY');
  });

  test('does not include workspace instructions on subsequent messages', async () => {
    const conv = await env.chatService.createConversation('Test', '/tmp/ws-resume');
    const hash = env.chatService.getWorkspaceHashForConv(conv.id)!;
    await env.chatService.setWorkspaceInstructions(hash, 'Workspace instructions');
    await env.chatService.addMessage(conv.id, 'user', 'First msg', 'claude-code');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Response', streaming: true },
      { type: 'done' },
    ] as StreamEvent[]);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'Second msg',
      backend: 'claude-code',
    });

    expect(env.mockBackend._lastOptions!.systemPrompt).toBe('');
  });
});

// ── GET /api/chat/version ──────────────────────────────────────────────────

describe('GET /api/chat/version', () => {
  test('returns version from package.json', async () => {
    const expected = require('../package.json').version;
    const res = await env.request('GET', '/api/chat/version');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(expected);
    expect(res.body).toHaveProperty('remoteVersion');
    expect(res.body).toHaveProperty('updateAvailable');
  });
});

// ── Usage event forwarding ───────────────────────────────────────────────────

describe('Usage event forwarding', () => {
  test('forwards usage events via WebSocket and persists to conversation', async () => {
    const conv = await env.chatService.createConversation('Usage Test');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'Hello', streaming: true },
      { type: 'usage', usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 50, costUsd: 0.05 } },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'test usage',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    // Verify usage event was forwarded with both conversation and session usage
    const usageEvent = events.find((e: any) => e.type === 'usage');
    expect(usageEvent).toBeDefined();
    expect(usageEvent.usage.inputTokens).toBe(1000);
    expect(usageEvent.usage.outputTokens).toBe(500);
    expect(usageEvent.usage.costUsd).toBe(0.05);
    expect(usageEvent.sessionUsage).toBeDefined();
    expect(usageEvent.sessionUsage.inputTokens).toBe(1000);
    expect(usageEvent.sessionUsage.outputTokens).toBe(500);

    // Verify usage was persisted
    const loaded = (await env.chatService.getConversation(conv.id))!;
    expect(loaded.usage!.inputTokens).toBe(1000);
    expect(loaded.usage!.outputTokens).toBe(500);
    expect(loaded.usage!.costUsd).toBe(0.05);
    expect(loaded.sessionUsage!.inputTokens).toBe(1000);
  });

  test('accumulates usage across multiple usage events', async () => {
    const conv = await env.chatService.createConversation('Multi Usage');

    env.mockBackend.setMockEvents([
      { type: 'text', content: 'First turn', streaming: true },
      { type: 'usage', usage: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02 } },
      { type: 'turn_boundary' },
      { type: 'text', content: 'Second turn', streaming: true },
      { type: 'usage', usage: { inputTokens: 300, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 } },
      { type: 'done' },
    ] as StreamEvent[]);

    const ws = await env.connectWs(conv.id);
    const eventsPromise = env.readWsEvents(ws);

    await env.request('POST', `/api/chat/conversations/${conv.id}/message`, {
      content: 'multi turn',
      backend: 'claude-code',
    });

    const events = await eventsPromise;

    const usageEvents = events.filter((e: any) => e.type === 'usage');
    expect(usageEvents).toHaveLength(2);

    // Second event should show cumulative totals
    expect(usageEvents[1].usage.inputTokens).toBe(800);
    expect(usageEvents[1].usage.outputTokens).toBe(300);
    expect(usageEvents[1].usage.costUsd).toBeCloseTo(0.03);
  });

  test('getConversation includes usage and sessionUsage in response', async () => {
    const conv = await env.chatService.createConversation('API Usage');
    await env.chatService.addUsage(conv.id, { inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 200, costUsd: 0.10 });

    const res = await env.request('GET', `/api/chat/conversations/${conv.id}`);
    expect(res.status).toBe(200);
    expect(res.body.usage).toBeDefined();
    expect(res.body.usage.inputTokens).toBe(2000);
    expect(res.body.usage.outputTokens).toBe(1000);
    expect(res.body.usage.costUsd).toBe(0.10);
    expect(res.body.sessionUsage).toBeDefined();
    expect(res.body.sessionUsage.inputTokens).toBe(2000);
  });
});

// ── Usage stats endpoints ───────────────────────────────────────────────────

describe('Usage stats endpoints', () => {
  test('GET /usage-stats returns empty ledger initially', async () => {
    const res = await env.request('GET', '/api/chat/usage-stats');
    expect(res.status).toBe(200);
    expect(res.body.days).toEqual([]);
  });

  test('GET /usage-stats returns ledger data after usage', async () => {
    const conv = await env.chatService.createConversation('Stats Test');
    await env.chatService.addUsage(conv.id, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.05 }, 'claude-code', 'claude-sonnet-4');
    // Wait for fire-and-forget ledger write
    await new Promise(resolve => setTimeout(resolve, 100));

    const res = await env.request('GET', '/api/chat/usage-stats');
    expect(res.status).toBe(200);
    expect(res.body.days.length).toBeGreaterThan(0);
    const today = new Date().toISOString().slice(0, 10);
    const day = res.body.days.find((d: any) => d.date === today);
    expect(day).toBeDefined();
    const record = day.records.find((r: any) => r.backend === 'claude-code');
    expect(record).toBeDefined();
    expect(record.usage.inputTokens).toBe(1000);
    expect(record.model).toBe('claude-sonnet-4');
  });

  test('DELETE /usage-stats clears all stats', async () => {
    const conv = await env.chatService.createConversation('Clear Stats');
    await env.chatService.addUsage(conv.id, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 }, 'claude-code');
    await new Promise(resolve => setTimeout(resolve, 100));

    const delRes = await env.request('DELETE', '/api/chat/usage-stats');
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    const res = await env.request('GET', '/api/chat/usage-stats');
    expect(res.body.days).toEqual([]);
  });
});

// ── WebSocket streaming ─────────────────────────────────────────────────────
