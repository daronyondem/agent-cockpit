import type { CortexRpcMessage, StreamEvent } from '../src/types';
import { CortexTurn } from '../src/services/backends/cortexTurn';
import { cortexRecord } from '../src/services/backends/cortexProtocol';
import { cortexFixture, cortexWire } from './helpers/cortexFixtures';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const usage = { inputTokens: 2, outputTokens: 3, cachedReadTokens: 5, cachedWriteTokens: 7 };
const fixtures: ReturnType<typeof cortexFixture>[] = [];
const fixture = () => { const f = cortexFixture(); fixtures.push(f); return f; };
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.client.close())); });
async function collect(turn: CortexTurn) { const result: StreamEvent[] = []; for await (const event of turn.stream()) result.push(event); return result; }

function replay(f: ReturnType<typeof cortexFixture>, name: string) {
  f.onRequest(request => {
    if (request.method !== 'session/prompt') return;
    for (const frame of cortexWire(name)) {
      if (frame.method) f.send({ ...frame, params: { ...frame.params, sessionId: 'fixture-session' } });
      else if (frame.result) f.send({ ...frame, id: request.id });
    }
  });
}

test('native wire excerpt flows through the turn bridge; duplicate final replies do not double-count', async () => {
  const f = fixture(); replay(f, 'file-shell');
  const first = await collect(new CortexTurn(f.runtime, { text: 'fixture', allowTools: true }));
  const second = await collect(new CortexTurn(f.runtime, { text: 'fixture again', allowTools: true }));
  for (const events of [first, second]) {
    expect(events.filter(event => event.type === 'usage')).toHaveLength(1);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect(events.find(event => event.type === 'result')).toMatchObject({ content: expect.stringContaining('verified') });
  }
  const prompts = f.writes.filter(frame => frame.method === 'session/prompt');
  f.send({ jsonrpc: '2.0', id: prompts[0].id, result: { stopReason: 'end_turn', usage } });
  expect(prompts).toHaveLength(2);
});

test('headless ordinary tools proceed; repeated human/unknown permissions fail even if cancellation reports a transport error', async () => {
  const ordinary = fixture(); replay(ordinary, 'file-shell');
  const result = await collect(new CortexTurn(ordinary.runtime, { text: 'fixture', allowTools: true, headless: true }));
  expect(result.some(event => event.type === 'result')).toBe(true);
  expect(result.some(event => event.type === 'error')).toBe(false);
  const f = fixture();
  const cancel = jest.spyOn(f.runtime, 'cancel').mockRejectedValue(new Error('PRIVATE cleanup diagnostic'));
  f.onRequest(request => {
    if (request.method !== 'session/prompt') return;
    queueMicrotask(() => {
      const question = cortexWire('questions').find(frame => frame.method === 'session/request_permission')!;
      f.send({ ...question, params: { ...question.params, sessionId: f.runtime.sessionId } });
      f.send({ ...question, id: 'malformed', params: { sessionId: f.runtime.sessionId } });
      f.send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'PRIVATE native diagnostic' } });
    });
  });
  const events = await collect(new CortexTurn(f.runtime, { text: 'question', allowTools: true, headless: true }));
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(events).toEqual([{ type: 'error', error: expect.stringContaining('requires a human decision'), source: 'backend' }, { type: 'done' }]);
  expect(JSON.stringify(events)).not.toContain('PRIVATE');
});

test.each(['auth-error', 'api-error'])('%s produces a terminal error without raw text, fabricated result, usage or retry', async name => {
  const f = fixture(); replay(f, name);
  const events = await collect(new CortexTurn(f.runtime, { text: 'check', allowTools: false }));
  expect(events.map(event => event.type)).toEqual(['error', 'done']);
  expect(JSON.stringify(events)).not.toMatch(/request_id|connections.toml|fixture-id/);
  expect(f.writes.filter(frame => frame.method === 'session/prompt')).toHaveLength(1);
});

test('successful quoted errors flush after classification; absent/partial usage warns without inventing counters', async () => {
  for (const reported of [usage, undefined, { inputTokens: 5 }]) {
    const f = fixture();
    f.onRequest(request => {
      if (request.method !== 'session/prompt') return;
      f.notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reported === usage ? 'Error: a legitimate quoted example' : 'Normal answer' } });
      f.send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn', ...(reported ? { usage: reported } : {}) } });
    });
    const events = await collect(new CortexTurn(f.runtime, { text: 'fixture', allowTools: true }));
    expect(events.some(event => event.type === 'result')).toBe(true);
    expect(events.filter(event => event.type === 'error' && event.terminal !== false)).toEqual([]);
    expect(events.filter(event => event.type === 'usage')).toHaveLength(reported === usage ? 1 : 0);
    expect(events.filter(event => event.type === 'error' && event.terminal === false)).toHaveLength(reported === usage ? 0 : 1);
  }
});

test('abort closes an outstanding question, retains reported partial-turn usage, and never retries', async () => {
  const f = fixture();
  let prompt: CortexRpcMessage;
  f.onRequest(request => {
    if (request.method === 'session/prompt') {
      prompt = request;
      const question = cortexWire('questions').find(frame => frame.method === 'session/request_permission')!;
      f.send({ ...question, params: { ...question.params, sessionId: 'fixture-session' } });
    }
    if (request.method === 'session/cancel') f.send({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'cancelled', usage } });
  });
  const turn = new CortexTurn(f.runtime, { text: 'ask', allowTools: true });
  const events: StreamEvent[] = [];
  for await (const event of turn.stream()) {
    events.push(event);
    if (event.type === 'tool_activity' && event.isQuestion) await turn.abort();
  }
  expect(turn.pendingId).toBeNull();
  expect(events.some(event => event.type === 'error' && event.source === 'abort')).toBe(true);
  expect(events.filter(event => event.type === 'usage')).toHaveLength(1);
  expect(events.some(event => event.type === 'result')).toBe(false);
  expect(f.writes.filter(frame => frame.method === 'session/prompt')).toHaveLength(1);
  expect(f.writes.find(frame => frame.id === 0 && !frame.method)).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } });
});

test('validation, RPC errors, process death and pre-start cancellation end once with sanitized failures', async () => {
  const invalid = fixture();
  const events = await collect(new CortexTurn(invalid.runtime, { text: 'bad model', model: 'private-model', allowTools: true }));
  expect(events).toMatchObject([{ type: 'error', error: expect.stringContaining('unavailable') }, { type: 'done' }]);
  expect(invalid.writes).toEqual([]);
  for (const death of [false, true]) {
    const f = fixture();
    f.onRequest(request => {
      if (request.method !== 'session/prompt') return;
      if (death) f.child.emit('exit', 1);
      else f.send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'PRIVATE_URL?code=secret' } });
    });
    const failed = await collect(new CortexTurn(f.runtime, { text: 'fixture', allowTools: true }));
    expect(failed.map(event => event.type)).toEqual(['error', 'done']);
    expect(JSON.stringify(failed)).not.toContain('PRIVATE');
  }
  const f = fixture();
  const turn = new CortexTurn(f.runtime, { text: 'cancel before start', allowTools: true });
  await turn.abort();
  expect((await collect(turn)).map(event => event.type)).toEqual(['error', 'done']);
  expect(f.writes.map(message => message.method)).toEqual(['session/close']);
  expect(f.client.isClosed).toBe(true);
  await expect(collect(turn)).rejects.toThrow('already consumed');
});

test('turn listeners reject foreign-session updates and question replies, including after completion', async () => {
  const f = fixture();
  f.onRequest(request => {
    if (request.method !== 'session/prompt') return;
    f.notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PRIVATE_FOREIGN' } }, 'other');
    f.notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Owned' } });
    f.send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn', usage } });
  });
  const turn = new CortexTurn(f.runtime, { text: 'fixture', allowTools: true });
  expect(JSON.stringify(await collect(turn))).not.toContain('PRIVATE_FOREIGN');
  expect(turn.input('approve', 'old-decision')).toBe(false);
  expect(cortexRecord(f.writes.find(frame => frame.method === 'session/prompt')?.params).prompt).toEqual([{ type: 'text', text: 'fixture' }]);
});

test('normal code changes remain tools; explicit delivery markers yield one scoped artifact and clean text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-turn-delivery-'));
  const file = path.join(dir, 'output.txt'); await fs.writeFile(file, 'OUTPUT');
  const f = cortexFixture(dir); fixtures.push(f);
  try {
    for (const delivery of [false, true]) {
      f.onRequest(request => {
        if (request.method !== 'session/prompt') return;
        f.notification({ sessionUpdate: 'tool_call', toolCallId: 'write', title: 'write', kind: 'edit', status: 'pending', rawInput: { file_path: file } });
        f.notification({ sessionUpdate: 'tool_call_update', toolCallId: 'write', status: 'completed', content: [{ type: 'diff', path: file, newText: 'OUTPUT' }] });
        const text = delivery ? `Here it is.\n<!-- FILE_DELIVERY:${file} -->` : 'Updated the code.';
        for (const chunk of text.match(/.{1,3}/gs)!) f.notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
        f.send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn', usage } });
      });
      const events = await collect(new CortexTurn(f.runtime, { text: 'fixture', allowTools: true }));
      expect(events.filter(event => event.type === 'artifact')).toHaveLength(delivery ? 1 : 0);
      expect(events.filter(event => event.type === 'text').map(event => event.content).join('')).not.toContain('FILE_DELIVERY');
      if (delivery) expect(events.find(event => event.type === 'artifact')).toMatchObject({ filename: 'output.txt', sourceToolId: 'write' });
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
