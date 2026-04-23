import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';

let env: ChatRouterEnv;

beforeEach(async () => { env = await createChatRouterEnv(); });
afterEach(async () => { await destroyChatRouterEnv(env); });

describe('Message Queue API', () => {
  test('GET /conversations/:id/queue returns empty array by default', async () => {
    const conv = (await env.request('POST', '/api/chat/conversations', { title: 'Queue Test' })).body;
    const res = await env.request('GET', `/api/chat/conversations/${conv.id}/queue`);
    expect(res.status).toBe(200);
    expect(res.body.queue).toEqual([]);
  });

  test('PUT /conversations/:id/queue persists and GET retrieves', async () => {
    const conv = (await env.request('POST', '/api/chat/conversations', { title: 'Queue Test' })).body;
    const putRes = await env.request('PUT', `/api/chat/conversations/${conv.id}/queue`, {
      queue: [{ content: 'msg1' }, { content: 'msg2' }],
    });
    expect(putRes.status).toBe(200);
    expect(putRes.body.ok).toBe(true);

    const getRes = await env.request('GET', `/api/chat/conversations/${conv.id}/queue`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.queue).toEqual([{ content: 'msg1' }, { content: 'msg2' }]);
  });

  test('PUT /conversations/:id/queue persists attachments on queued messages', async () => {
    const conv = (await env.request('POST', '/api/chat/conversations', { title: 'Queue Test' })).body;
    const attachments = [
      { name: 'foo.pdf', path: '/tmp/foo.pdf', size: 1024, kind: 'pdf', meta: '1.0 KB' },
      { name: 'bar.ts',  path: '/tmp/bar.ts',  size: 512,  kind: 'code', meta: '512 B' },
    ];
    const putRes = await env.request('PUT', `/api/chat/conversations/${conv.id}/queue`, {
      queue: [{ content: 'look at these', attachments }, { content: 'plain' }],
    });
    expect(putRes.status).toBe(200);

    const getRes = await env.request('GET', `/api/chat/conversations/${conv.id}/queue`);
    expect(getRes.body.queue).toEqual([
      { content: 'look at these', attachments },
      { content: 'plain' },
    ]);
  });

  test('DELETE /conversations/:id/queue clears the queue', async () => {
    const conv = (await env.request('POST', '/api/chat/conversations', { title: 'Queue Test' })).body;
    await env.request('PUT', `/api/chat/conversations/${conv.id}/queue`, { queue: [{ content: 'msg1' }] });

    const delRes = await env.request('DELETE', `/api/chat/conversations/${conv.id}/queue`);
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    const getRes = await env.request('GET', `/api/chat/conversations/${conv.id}/queue`);
    expect(getRes.body.queue).toEqual([]);
  });

  test('PUT /conversations/:id/queue returns 400 for invalid body', async () => {
    const conv = (await env.request('POST', '/api/chat/conversations', { title: 'Queue Test' })).body;
    // Numbers are not valid QueuedMessage objects
    const res = await env.request('PUT', `/api/chat/conversations/${conv.id}/queue`, { queue: [123] });
    expect(res.status).toBe(400);
  });

  test('PUT /conversations/:id/queue rejects legacy string entries', async () => {
    const conv = (await env.request('POST', '/api/chat/conversations', { title: 'Queue Test' })).body;
    // Legacy shape from the string[] era must be sent by the client as objects
    const res = await env.request('PUT', `/api/chat/conversations/${conv.id}/queue`, { queue: ['legacy'] });
    expect(res.status).toBe(400);
  });

  test('PUT /conversations/:id/queue rejects attachments without path', async () => {
    const conv = (await env.request('POST', '/api/chat/conversations', { title: 'Queue Test' })).body;
    const res = await env.request('PUT', `/api/chat/conversations/${conv.id}/queue`, {
      queue: [{ content: 'bad', attachments: [{ name: 'x' }] }],
    });
    expect(res.status).toBe(400);
  });

  test('PUT /conversations/:id/queue returns 404 for unknown conversation', async () => {
    const res = await env.request('PUT', '/api/chat/conversations/nonexistent/queue', { queue: [{ content: 'msg' }] });
    expect(res.status).toBe(404);
  });

  test('queue is included in GET /conversations/:id response', async () => {
    const conv = (await env.request('POST', '/api/chat/conversations', { title: 'Queue Test' })).body;
    await env.request('PUT', `/api/chat/conversations/${conv.id}/queue`, {
      queue: [{ content: 'hello' }, { content: 'world' }],
    });

    const getRes = await env.request('GET', `/api/chat/conversations/${conv.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.messageQueue).toEqual([{ content: 'hello' }, { content: 'world' }]);
  });

  test('queue is cleared on session reset', async () => {
    const conv = (await env.request('POST', '/api/chat/conversations', { title: 'Queue Test' })).body;
    await env.request('PUT', `/api/chat/conversations/${conv.id}/queue`, { queue: [{ content: 'pending msg' }] });

    await env.request('POST', `/api/chat/conversations/${conv.id}/reset`);

    const getRes = await env.request('GET', `/api/chat/conversations/${conv.id}/queue`);
    expect(getRes.body.queue).toEqual([]);
  });

  test('queue is cleared on archive', async () => {
    const conv = (await env.request('POST', '/api/chat/conversations', { title: 'Queue Test' })).body;
    await env.request('PUT', `/api/chat/conversations/${conv.id}/queue`, { queue: [{ content: 'pending msg' }] });

    await env.request('PATCH', `/api/chat/conversations/${conv.id}/archive`);

    const getRes = await env.request('GET', `/api/chat/conversations/${conv.id}/queue`);
    expect(getRes.body.queue).toEqual([]);
  });
});
