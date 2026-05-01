/* eslint-disable @typescript-eslint/no-explicit-any */

import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';
import type { StreamEvent } from '../src/types';

let env: ChatRouterEnv;

beforeEach(async () => { env = await createChatRouterEnv(); });
afterEach(async () => { await destroyChatRouterEnv(env); });

describe('POST /conversations', () => {
  test('creates a conversation with title and workingDir', async () => {
    const res = await env.request('POST', '/api/chat/conversations', {
      title: 'Test Conversation',
      workingDir: '/tmp/test-workspace',
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.title).toBe('Test Conversation');
    expect(res.body.workingDir).toBe('/tmp/test-workspace');
    expect(res.body.sessionNumber).toBe(1);
    expect(res.body.messages).toEqual([]);
  });

  test('creates a conversation with backend and model', async () => {
    const res = await env.request('POST', '/api/chat/conversations', {
      title: 'With Backend',
      workingDir: '/tmp/test-ws-be',
      backend: 'claude-code',
      model: 'opus',
    });
    expect(res.status).toBe(200);
    expect(res.body.backend).toBe('claude-code');
    expect(res.body.model).toBe('opus');
  });

  test('creates a conversation with effort level', async () => {
    const res = await env.request('POST', '/api/chat/conversations', {
      title: 'With Effort',
      backend: 'claude-code',
      model: 'opus',
      effort: 'max',
    });
    expect(res.status).toBe(200);
    expect(res.body.effort).toBe('max');
  });

  test('creates a conversation with default title', async () => {
    const res = await env.request('POST', '/api/chat/conversations', {});
    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
  });
});

// ── PUT /conversations/:id (rename) ───────────────────────────────────────

describe('PUT /conversations/:id', () => {
  test('renames a conversation', async () => {
    const createRes = await env.request('POST', '/api/chat/conversations', {
      title: 'Original Title',
    });
    const convId = createRes.body.id;

    const res = await env.request('PUT', `/api/chat/conversations/${convId}`, {
      title: 'Renamed Title',
    });
    expect(res.status).toBe(200);

    // Verify the rename persisted
    const getRes = await env.request('GET', `/api/chat/conversations/${convId}`);
    expect(getRes.body.title).toBe('Renamed Title');
  });

  test('returns 404 for non-existent conversation', async () => {
    const res = await env.request('PUT', '/api/chat/conversations/nonexistent-id', {
      title: 'New Title',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Conversation not found');
  });
});

// ── DELETE /conversations/:id ─────────────────────────────────────────────

describe('DELETE /conversations/:id', () => {
  test('deletes a conversation', async () => {
    const createRes = await env.request('POST', '/api/chat/conversations', {
      title: 'To Delete',
    });
    const convId = createRes.body.id;

    const res = await env.request('DELETE', `/api/chat/conversations/${convId}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify it no longer appears in the list
    const listRes = await env.request('GET', '/api/chat/conversations');
    expect(listRes.body.conversations.find((c: any) => c.id === convId)).toBeUndefined();
  });

  test('returns 404 for non-existent conversation', async () => {
    const res = await env.request('DELETE', '/api/chat/conversations/nonexistent-id');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Conversation not found');
  });

  test('deleted conversation is not retrievable via GET', async () => {
    const createRes = await env.request('POST', '/api/chat/conversations', {
      title: 'Gone',
    });
    const convId = createRes.body.id;

    await env.request('DELETE', `/api/chat/conversations/${convId}`);

    const getRes = await env.request('GET', `/api/chat/conversations/${convId}`);
    expect(getRes.status).toBe(404);
  });
});

// ── GET /conversations/:id (single) ──────────────────────────────────────

describe('GET /conversations/:id', () => {
  test('returns a conversation by id', async () => {
    const createRes = await env.request('POST', '/api/chat/conversations', {
      title: 'Get Me',
      workingDir: '/tmp/get-test',
    });
    const convId = createRes.body.id;

    const res = await env.request('GET', `/api/chat/conversations/${convId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(convId);
    expect(res.body.title).toBe('Get Me');
    expect(res.body.workingDir).toBe('/tmp/get-test');
    expect(res.body.messages).toBeDefined();
    expect(Array.isArray(res.body.messages)).toBe(true);
  });

  test('returns 404 for non-existent conversation', async () => {
    const res = await env.request('GET', '/api/chat/conversations/nonexistent-id');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Conversation not found');
  });

  test('includes messages in the response', async () => {
    const conv = await env.chatService.createConversation('With Messages');
    await env.chatService.addMessage(conv.id, 'user', 'Hello', 'claude-code');
    await env.chatService.addMessage(conv.id, 'assistant', 'Hi there', 'claude-code');

    const res = await env.request('GET', `/api/chat/conversations/${conv.id}`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0].role).toBe('user');
    expect(res.body.messages[0].content).toBe('Hello');
    expect(res.body.messages[1].role).toBe('assistant');
    expect(res.body.messages[1].content).toBe('Hi there');
  });
});

// ── GET /conversations/:id/sessions ───────────────────────────────────────

describe('GET /conversations/:id/sessions', () => {
  test('returns sessions for a conversation', async () => {
    const conv = await env.chatService.createConversation('Sessions Test');

    const res = await env.request('GET', `/api/chat/conversations/${conv.id}/sessions`);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toBeDefined();
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions.length).toBeGreaterThanOrEqual(1);
    expect(res.body.sessions[0].number).toBe(1);
    expect(res.body.sessions[0].isCurrent).toBe(true);
  });

  test('returns multiple sessions after reset', async () => {
    const conv = await env.chatService.createConversation('Multi Session');
    await env.chatService.addMessage(conv.id, 'user', 'First session msg', 'claude-code');
    await env.chatService.resetSession(conv.id);

    const res = await env.request('GET', `/api/chat/conversations/${conv.id}/sessions`);
    expect(res.status).toBe(200);
    expect(res.body.sessions.length).toBe(2);
    expect(res.body.sessions[0].number).toBe(1);
    expect(res.body.sessions[0].isCurrent).toBe(false);
    expect(res.body.sessions[1].number).toBe(2);
    expect(res.body.sessions[1].isCurrent).toBe(true);
  });

  test('returns 404 for non-existent conversation', async () => {
    const res = await env.request('GET', '/api/chat/conversations/nonexistent-id/sessions');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Conversation not found');
  });
});

// ── GET /conversations/:id/download ───────────────────────────────────────

describe('GET /conversations/:id/download', () => {
  test('downloads conversation as markdown with correct headers', async () => {
    const conv = await env.chatService.createConversation('Download Test');
    await env.chatService.addMessage(conv.id, 'user', 'Hello', 'claude-code');
    await env.chatService.addMessage(conv.id, 'assistant', 'Hi there', 'claude-code');

    const res = await env.request('GET', `/api/chat/conversations/${conv.id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('.md');
    // The body should contain the conversation content as markdown text
    expect(typeof res.body).toBe('string');
    expect(res.body).toContain('Download Test');
  });

  test('returns 404 for non-existent conversation', async () => {
    const res = await env.request('GET', '/api/chat/conversations/nonexistent-id/download');
    expect(res.status).toBe(404);
  });

  test('filename is sanitized from title', async () => {
    const conv = await env.chatService.createConversation('Special <chars> & "quotes"');
    await env.chatService.addMessage(conv.id, 'user', 'msg', 'claude-code');

    const res = await env.request('GET', `/api/chat/conversations/${conv.id}/download`);
    expect(res.status).toBe(200);
    // The disposition filename should not contain special chars
    const disposition = res.headers['content-disposition'] as string;
    expect(disposition).not.toContain('<');
    expect(disposition).not.toContain('>');
    expect(disposition).toContain('.md');
  });
});

// ── GET /settings ─────────────────────────────────────────────────────────

describe('GET /settings', () => {
  test('returns settings object', async () => {
    const res = await env.request('GET', '/api/chat/settings');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
  });

  test('returns previously saved settings', async () => {
    await env.chatService.saveSettings({ theme: 'dark', systemPrompt: 'Be helpful' } as any);

    const res = await env.request('GET', '/api/chat/settings');
    expect(res.status).toBe(200);
    expect(res.body.theme).toBe('dark');
    expect(res.body.systemPrompt).toBe('Be helpful');
  });
});

// ── PUT /settings ─────────────────────────────────────────────────────────

describe('PUT /settings', () => {
  test('saves and returns settings', async () => {
    const res = await env.request('PUT', '/api/chat/settings', {
      theme: 'light',
      systemPrompt: 'You are a coding assistant',
    });
    expect(res.status).toBe(200);
    expect(res.body.theme).toBe('light');
    expect(res.body.systemPrompt).toBe('You are a coding assistant');

    // Verify persisted via GET
    const getRes = await env.request('GET', '/api/chat/settings');
    expect(getRes.body.theme).toBe('light');
    expect(getRes.body.systemPrompt).toBe('You are a coding assistant');
  });

  test('overwrites previous settings', async () => {
    await env.request('PUT', '/api/chat/settings', { theme: 'dark' });
    const res = await env.request('PUT', '/api/chat/settings', { theme: 'system' });
    expect(res.status).toBe(200);
    expect(res.body.theme).toBe('system');
  });
});

// ── GET /backends ─────────────────────────────────────────────────────────

describe('GET /backends', () => {
  test('returns list of registered backends', async () => {
    const res = await env.request('GET', '/api/chat/backends');
    expect(res.status).toBe(200);
    expect(res.body.backends).toBeDefined();
    expect(Array.isArray(res.body.backends)).toBe(true);
    expect(res.body.backends.length).toBeGreaterThanOrEqual(1);
  });

  test('includes mock backend metadata', async () => {
    const res = await env.request('GET', '/api/chat/backends');
    const backend = res.body.backends.find((b: any) => b.id === 'claude-code');
    expect(backend).toBeDefined();
    expect(backend.label).toBe('Claude Code');
    expect(backend.capabilities.thinking).toBe(true);
    expect(backend.models).toBeDefined();
    expect(backend.models.length).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /cli-profiles/:profileId/metadata', () => {
  test('returns backend metadata for a CLI profile', async () => {
    const settings = await env.chatService.getSettings();
    const profileId = settings.defaultCliProfileId!;

    const res = await env.request('GET', `/api/chat/cli-profiles/${encodeURIComponent(profileId)}/metadata`);

    expect(res.status).toBe(200);
    expect(res.body.profileId).toBe(profileId);
    expect(res.body.backend.id).toBe('claude-code');
    expect(res.body.backend.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'sonnet' }),
    ]));
  });

  test('returns 400 for an unknown CLI profile', async () => {
    const res = await env.request('GET', '/api/chat/cli-profiles/missing-profile/metadata');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('CLI profile not found');
  });
});

// ── POST /conversations/:id/reset ─────────────────────────────────────────

describe('POST /conversations/:id/reset', () => {
  test('resets session and returns new session info', async () => {
    const conv = await env.chatService.createConversation('Reset Test');
    await env.chatService.addMessage(conv.id, 'user', 'Hello', 'claude-code');

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/reset`);
    expect(res.status).toBe(200);
    expect(res.body.newSessionNumber).toBeDefined();
    expect(res.body.newSessionNumber).toBeGreaterThan(1);
    expect(res.body.archivedSession).toBeDefined();
    expect(res.body.archivedSession.number).toBe(1);
  });

  test('returns 404 for non-existent conversation', async () => {
    const res = await env.request('POST', '/api/chat/conversations/nonexistent-id/reset');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Conversation not found');
  });

  test('returns 409 when stream is active', async () => {
    const conv = await env.chatService.createConversation('Reset Conflict');

    // Simulate an active stream by adding an entry to env.activeStreams
    env.activeStreams.set(conv.id, {
      stream: (async function* () { yield { type: 'done' } as StreamEvent; })(),
      abort: () => {},
      sendInput: () => {},
      backend: 'claude-code',
      needsTitleUpdate: false,
      titleUpdateMessage: null,
    });

    const res = await env.request('POST', `/api/chat/conversations/${conv.id}/reset`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Cannot reset session while streaming');

    // Clean up
    env.activeStreams.delete(conv.id);
  });

  test('clears messages from the active session', async () => {
    const conv = await env.chatService.createConversation('Reset Clear');
    await env.chatService.addMessage(conv.id, 'user', 'Session 1 message', 'claude-code');
    await env.chatService.addMessage(conv.id, 'assistant', 'Session 1 reply', 'claude-code');

    await env.request('POST', `/api/chat/conversations/${conv.id}/reset`);

    // The new session should have no messages
    const getRes = await env.request('GET', `/api/chat/conversations/${conv.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.messages).toHaveLength(0);
  });
});

// ── File delivery endpoint ──────────────────────────────────────────────────
