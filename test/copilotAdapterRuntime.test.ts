import fs from 'fs';
import os from 'os';
import path from 'path';
import { CopilotAdapter } from '../src/services/backends/copilot';
import { copilotChatTransport } from '../src/services/backends/copilotRuntime';
import type { SendMessageOptions, StreamEvent } from '../src/types';
import { waitForCopilotPeer, writeCopilotSdkPeer } from './helpers/copilotSdkPeer';

async function collect(stream: AsyncGenerator<StreamEvent>, events: StreamEvent[] = []) {
  for await (const event of stream) events.push(event);
  return events;
}

describe('Copilot facade runtime dispatch and shared lifecycle', () => {
  let dir: string;
  let peer: ReturnType<typeof writeCopilotSdkPeer>;
  let adapter: CopilotAdapter;
  const options = (sdk = true): SendMessageOptions => ({ sessionId: 'session', conversationId: 'conversation',
    isNewSession: true, workingDir: dir, systemPrompt: '', cliProfile: peer.profile(sdk ? { COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:1' } : {}) });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-facade-'));
    peer = writeCopilotSdkPeer(dir);
    adapter = new CopilotAdapter({ workingDir: dir });
  });
  afterEach(async () => { await adapter.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('uses SDK for normal CLI profiles and explicit providers; preserves opaque command overrides', () => {
    expect(copilotChatTransport({ ...peer.profile(), command: 'copilot' })).toBe('sdk');
    expect(copilotChatTransport({ ...peer.profile(), command: undefined })).toBe('sdk');
    expect(copilotChatTransport(peer.profile())).toBe('jsonl');
    expect(copilotChatTransport(options().cliProfile)).toBe('sdk');
  });

  test('sends production chat through SDK while retaining restricted JSONL one-shots', async () => {
    expect(await collect(adapter.sendMessage('hello', options()).stream)).toContainEqual({ type: 'text', content: 'answer:hello', streaming: true });
    expect(await adapter.runOneShot('processor', { cliProfile: options().cliProfile })).toBe('jsonl:processor');
    const spawns = peer.calls().filter(call => call.method === 'spawn');
    expect(spawns[0].args).toContain('--headless');
    expect(spawns[1].args).toEqual(expect.arrayContaining(['--available-tools', 'none']));
    expect(spawns[1].args).not.toContain('--headless');
  }, 15000);

  test('does not retry an SDK failure through JSONL', async () => {
    const frames = await collect(adapter.sendMessage('FAIL_AFTER_SEND', options()).stream);
    expect(frames.some(frame => frame.type === 'error')).toBe(true);
    expect(peer.calls().filter(call => call.method === 'spawn')).toHaveLength(1);
    expect(peer.calls().some(call => call.args?.includes('-p'))).toBe(false);
  }, 15000);

  test.each([true, false])('rejects overlap and drains Stop before switching from SDK=%s', async sdk => {
    const seen: StreamEvent[] = [];
    const active = adapter.sendMessage('DEFERRED', options(sdk));
    const pending = collect(active.stream, seen);
    await waitForCopilotPeer(() => seen.some(frame => frame.type === 'text'));
    expect((await collect(adapter.sendMessage('overlap', options(!sdk)).stream))[0]).toMatchObject({ type: 'error', error: expect.stringContaining('active turn') });
    active.abort();
    const replacement = collect(adapter.sendMessage('replacement', options(!sdk)).stream);
    expect((await pending).some(frame => frame.type === 'error' && frame.source === 'abort')).toBe(true);
    expect((await replacement).some(frame => frame.type === 'text' && frame.content.includes('replacement'))).toBe(true);
    expect(peer.calls().filter(call => call.method === 'spawn')).toHaveLength(2);
  }, 15000);

  test.each([true, false])('reset and reusable shutdown drain SDK=%s and allow later reuse', async sdk => {
    const seen: StreamEvent[] = [];
    const active = collect(adapter.sendMessage('DEFERRED', options(sdk)).stream, seen);
    await waitForCopilotPeer(() => seen.some(frame => frame.type === 'text'));
    await adapter.onSessionReset('conversation');
    expect((await active).some(frame => frame.type === 'error' && frame.source === 'abort')).toBe(true);
    const lazy = adapter.sendMessage('never submit', options(sdk));
    await adapter.shutdown();
    expect((await collect(lazy.stream))[0]).toMatchObject({ type: 'error', source: 'abort' });
    expect((await collect(adapter.sendMessage('reused', options(!sdk)).stream)).some(frame => frame.type === 'text')).toBe(true);
  }, 15000);

  test('closing an unstarted iterator releases facade admission, and permanent shutdown blocks all transports', async () => {
    await adapter.sendMessage('unstarted', options()).stream.return(undefined);
    expect(peer.calls()).toEqual([]);
    expect((await collect(adapter.sendMessage('after close', options()).stream)).some(frame => frame.type === 'text')).toBe(true);
    await adapter.shutdown({ permanent: true });
    for (const sdk of [true, false]) expect((await collect(adapter.sendMessage('blocked', options(sdk)).stream))[0]).toMatchObject({ type: 'error', source: 'abort' });
    expect(peer.calls().filter(call => call.method === 'spawn')).toHaveLength(1);
  }, 15000);
});
