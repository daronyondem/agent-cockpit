import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { CopilotConversations } from '../src/services/backends/copilotConversations';
import { startCopilotSdkRuntime } from '../src/services/backends/copilotSdkRuntime';
import type { SendMessageOptions, StreamEvent } from '../src/types';
import { waitForCopilotPeer, writeCopilotSdkPeer } from './helpers/copilotSdkPeer';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return process.platform === 'win32' || !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
  } catch { return false; }
};
async function collect(stream: AsyncGenerator<StreamEvent>, events: StreamEvent[] = []) {
  for await (const event of stream) events.push(event);
  return events;
}

describe('Copilot SDK conversation ownership through an executable RPC peer', () => {
  let dir: string;
  let peer: ReturnType<typeof writeCopilotSdkPeer>;
  let conversations: CopilotConversations;
  const options = (overrides: Partial<SendMessageOptions> = {}): SendMessageOptions => ({ sessionId: 'cockpit-session', conversationId: 'conversation',
    workingDir: dir, systemPrompt: 'fixture rules', isNewSession: true, cliProfile: peer.profile(), ...overrides });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot conversations ü '));
    peer = writeCopilotSdkPeer(dir);
    conversations = new CopilotConversations();
  });
  afterEach(async () => {
    await conversations.shutdown();
    for (const call of peer.calls().filter(call => call.method === 'orphan')) {
      if (call.child && alive(call.child)) process.kill(call.child, 'SIGKILL');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('creates one session, projects streamed output once, injects configuration and awaits cleanup', async () => {
    const frames = await collect(conversations.sendMessage('hello', options({ model: 'gpt-6.1-sol', effort: 'high',
      mcpServers: [{ name: 'agent-cockpit-memory', command: 'node', args: ['stub.cjs'], env: [{ name: 'TOKEN', value: 'fixture-token' }] }],
    })).stream);
    expect(frames.filter(frame => frame.type === 'text')).toEqual([{ type: 'text', content: 'answer:System instructions:\nfixture rules\n\nUser message:\nhello', streaming: true }]);
    expect(frames.filter(frame => frame.type === 'external_session')).toHaveLength(1);
    expect(frames.at(-1)).toEqual({ type: 'done' });
    expect(peer.calls().filter(call => call.method === 'session.send')).toHaveLength(1);
    expect(peer.calls().find(call => call.method === 'session.create')?.params).toMatchObject({
      reasoningEffort: 'high', streaming: true, workingDirectory: dir, requestUserInput: true,
      mcpServers: { 'agent-cockpit-memory': { command: 'node', args: ['stub.cjs'], tools: ['*'], env: { TOKEN: 'fixture-token' } } },
    });
    expect(alive(peer.calls()[0].pid)).toBe(false);
  }, 15000);

  test('resumes the persisted ID without replay and subtracts the saved cumulative usage', async () => {
    const transcript = path.join(dir, 'home', 'session-state', 'saved', 'events.jsonl');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, JSON.stringify({ type: 'session.usage_checkpoint', data: {
      totalPremiumRequests: 3, accountingSnapshot: { tokenDetails: { input: { tokenCount: 100 }, output: { tokenCount: 20 }, cache_read: { tokenCount: 3 }, cache_write: { tokenCount: 1 } } },
    } }) + '\n');
    const frames = await collect(conversations.sendMessage('next', options({ isNewSession: false, externalSessionId: 'saved' })).stream);
    expect(frames).toContainEqual({ type: 'external_session', sessionId: 'saved' });
    expect(frames.filter(frame => frame.type === 'usage')).toEqual([{ type: 'usage', usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 1, credits: 1, costUsd: 0, costSource: 'none' } }]);
    expect(peer.calls().find(call => call.method === 'session.resume')?.params).toMatchObject({ sessionId: 'saved', continuePendingWork: false });
    expect(peer.calls().find(call => call.method === 'session.send')?.params?.prompt).toBe('next');
    expect(peer.calls().some(call => call.method === 'session.create')).toBe(false);
    const methods = peer.calls().map(call => call.method);
    expect(methods.indexOf('session.usage.getMetrics')).toBeLessThan(methods.indexOf('session.send'));
    expect(methods.lastIndexOf('session.usage.getMetrics')).toBeGreaterThan(methods.indexOf('ack'));
  }, 15000);

  test('does not pause the queued lane until an acknowledged initial prompt has actually started', async () => {
    const frames: StreamEvent[] = [];
    const active = conversations.sendMessage('ACK_BEFORE_START', options());
    const pending = collect(active.stream, frames);
    await waitForCopilotPeer(() => peer.calls().some(call => call.method === 'ack'));
    expect(peer.calls().some(call => call.method === 'session.queue.setDrainPaused')).toBe(false);
    expect(frames.some(frame => frame.type === 'input_ready')).toBe(false);
    fs.writeFileSync(peer.release, 'start');
    await waitForCopilotPeer(() => frames.some(frame => frame.type === 'input_ready' && frame.turnId));
    const methods = peer.calls().map(call => call.method);
    expect(methods.indexOf('session.queue.setDrainPaused')).toBeGreaterThan(methods.indexOf('turn-start'));
    active.abort();
    await pending;
  }, 15000);

  test.each(['error', 'hang'])('metrics %s leaves chat usable and omits uncertain charges', async mode => {
    conversations = new CopilotConversations({ requestTimeoutMs: 1000 });
    const frames = await collect(conversations.sendMessage('hello', options({ cliProfile: peer.profile({ COPILOT_FIXTURE_METRICS: mode }) })).stream);
    expect(frames.some(frame => frame.type === 'text')).toBe(true);
    expect(frames.some(frame => frame.type === 'error' || frame.type === 'usage')).toBe(false);
    expect(alive(peer.calls()[0].pid)).toBe(false);
  }, 15000);

  test('a terminal session error during the baseline query cannot submit a late prompt', async () => {
    const frames = await collect(conversations.sendMessage('must not submit', options({ cliProfile: peer.profile({ COPILOT_FIXTURE_METRICS: 'session-error' }) })).stream);
    expect(frames).toContainEqual({ type: 'error', error: 'Session failed during usage query' });
    expect(peer.calls().some(call => call.method === 'session.send')).toBe(false);
  }, 15000);

  test.each(['unknown baseline', 'unknown ledger'])('omits uncertain charges for %s', async kind => {
    const frames = await collect(conversations.sendMessage('hello', options(kind === 'unknown baseline'
      ? { isNewSession: false, externalSessionId: 'saved' } : { cliProfile: peer.profile({ COPILOT_FIXTURE_LEDGER: 'new' }) })).stream);
    expect(frames.some(frame => frame.type === 'usage')).toBe(false);
    expect(frames.some(frame => frame.type === 'text')).toBe(true);
  }, 15000);

  test('does not report a historical resume checkpoint as usage for a new prompt', async () => {
    const transcript = path.join(dir, 'home', 'session-state', 'saved', 'events.jsonl');
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, JSON.stringify({ type: 'session.usage_checkpoint', data: { totalPremiumRequests: 4,
      accountingSnapshot: { tokenDetails: { input: { tokenCount: 110 }, output: { tokenCount: 30 }, cache_read: { tokenCount: 5 }, cache_write: { tokenCount: 2 } } },
    } }) + '\n');
    const frames = await collect(conversations.sendMessage('new prompt', options({ isNewSession: false, externalSessionId: 'saved', cliProfile: peer.profile({ COPILOT_FIXTURE_LEDGER: 'resume-only' }) })).stream);
    expect(frames.some(frame => frame.type === 'text')).toBe(true);
    expect(frames.some(frame => frame.type === 'usage')).toBe(false);
  }, 15000);

  test('waits beyond a model reply, loop end and child idle until attached background work drains', async () => {
    const seen: StreamEvent[] = [];
    let finished = false;
    const pending = collect(conversations.sendMessage('DEFERRED', options()).stream, seen).then(value => { finished = true; return value; });
    await waitForCopilotPeer(() => seen.some(frame => frame.type === 'text'));
    expect(finished).toBe(false);
    expect(seen.some(frame => frame.type === 'done')).toBe(false);
    fs.writeFileSync(peer.release, 'finish');
    const frames = await pending;
    expect(frames.filter(frame => frame.type === 'done')).toHaveLength(1);
    expect(frames.filter(frame => frame.type === 'text')).toHaveLength(2);
    expect(alive(peer.calls()[0].pid)).toBe(false);
  }, 15000);

  test('handles an idle notification before admission acknowledgement without a second execution', async () => {
    const frames = await collect(conversations.sendMessage('EARLY_IDLE', options()).stream);
    expect(peer.calls().filter(call => call.method === 'session.send')).toHaveLength(1);
    expect(peer.calls().filter(call => call.method === 'ack')).toHaveLength(1);
    expect(frames.filter(frame => frame.type === 'done')).toHaveLength(1);
    expect(frames.some(frame => frame.type === 'error')).toBe(false);
  }, 15000);

  test('does not allocate for an unconsumed cancelled stream and permits later reuse', async () => {
    const turn = conversations.sendMessage('cancel before start', options());
    turn.abort();
    expect(await collect(turn.stream)).toEqual([{ type: 'error', error: 'Copilot turn aborted.', source: 'abort' }, { type: 'done' }]);
    expect(peer.calls()).toEqual([]);
    expect((await collect(conversations.sendMessage('later', options()).stream)).some(frame => frame.type === 'text')).toBe(true);
  }, 15000);

  test('immediate Stop-to-send waits for the previous process to exit', async () => {
    const runtimes: number[] = [];
    const aliveAtReplacement: boolean[] = [];
    conversations = new CopilotConversations({ startRuntime: async (...args) => {
      if (runtimes.length) aliveAtReplacement.push(alive(runtimes.at(-1)!));
      const runtime = await startCopilotSdkRuntime(...args); runtimes.push(runtime.process.pid!); return runtime;
    } });
    const seen: StreamEvent[] = [];
    const first = conversations.sendMessage('DEFERRED', options());
    const pending = collect(first.stream, seen);
    await waitForCopilotPeer(() => seen.some(frame => frame.type === 'text'));
    first.abort();
    const next = collect(conversations.sendMessage('replacement', options()).stream);
    expect((await pending).filter(frame => frame.type === 'error')).toEqual([{ type: 'error', error: 'Copilot turn aborted.', source: 'abort' }]);
    expect((await next).some(frame => frame.type === 'text' && frame.content.includes('replacement'))).toBe(true);
    expect(aliveAtReplacement).toEqual([false]);
    expect(runtimes.every(pid => !alive(pid))).toBe(true);
  }, 15000);

  test('keeps conversations independent, rejects overlapping turns and resets only the selected owner', async () => {
    const firstSeen: StreamEvent[] = [], otherSeen: StreamEvent[] = [];
    const first = collect(conversations.sendMessage('DEFERRED_A', options()).stream, firstSeen);
    const other = collect(conversations.sendMessage('DEFERRED_B', options({ conversationId: 'other' })).stream, otherSeen);
    await waitForCopilotPeer(() => firstSeen.some(frame => frame.type === 'text') && otherSeen.some(frame => frame.type === 'text'));
    expect(await collect(conversations.sendMessage('overlap', options()).stream)).toMatchObject([{ type: 'error', error: expect.stringContaining('active turn') }, { type: 'done' }]);
    expect(peer.calls().filter(call => call.method === 'spawn')).toHaveLength(2);
    await conversations.onSessionReset('conversation');
    expect((await first).some(frame => frame.type === 'error' && frame.source === 'abort')).toBe(true);
    expect(otherSeen.some(frame => frame.type === 'error')).toBe(false);
    fs.writeFileSync(peer.release, 'finish other');
    expect((await other).some(frame => frame.type === 'text' && frame.content.includes('DEFERRED_B'))).toBe(true);
  }, 15000);

  test.each(['reset', 'shutdown'] as const)('%s drains a factory completing after cancellation and closes admission meanwhile', async action => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let ready!: () => void;
    const allocated = new Promise<void>(resolve => { ready = resolve; });
    let pid = 0;
    let first = true;
    conversations = new CopilotConversations({ startRuntime: async (runtime, cwd, config) => {
      const owned = await startCopilotSdkRuntime(runtime, cwd, first ? {} : config);
      if (first) { first = false; pid = owned.process.pid!; ready(); await gate; }
      return owned;
    } });
    const running = collect(conversations.sendMessage('must not submit', options()).stream);
    await allocated;
    let cleaned = false;
    const cleanup = (action === 'reset' ? conversations.onSessionReset('conversation') : conversations.shutdown()).then(() => { cleaned = true; });
    await Promise.resolve(); expect(cleaned).toBe(false);
    expect((await collect(conversations.sendMessage('blocked', options()).stream))[0]).toMatchObject({ type: 'error', error: expect.stringContaining('shutting down or resetting') });
    release(); await cleanup;
    expect((await running).some(frame => frame.type === 'error' && frame.source === 'abort')).toBe(true);
    expect(alive(pid)).toBe(false);
    expect(peer.calls().some(call => call.method === 'session.create' || call.method === 'session.send')).toBe(false);
    expect((await collect(conversations.sendMessage('reused', options()).stream)).some(frame => frame.type === 'text')).toBe(true);
  }, 15000);

  test.each(['backend_runtime', 'external_session'] as const)('reset while suspended at %s cannot submit late work', async boundary => {
    const turn = conversations.sendMessage('must not submit', options());
    while ((await turn.stream.next()).value?.type !== boundary) { /* reach the selected admission boundary */ }
    await conversations.onSessionReset('conversation');
    expect((await collect(turn.stream)).some(frame => frame.type === 'error' && frame.source === 'abort')).toBe(true);
    expect(peer.calls().some(call => call.method === 'session.send')).toBe(false);
    if (boundary === 'backend_runtime') expect(peer.calls().some(call => call.method === 'session.create')).toBe(false);
  }, 15000);

  test('closing the iterator cleans its owned process without needing a native terminal notification', async () => {
    const turn = conversations.sendMessage('DEFERRED', options());
    while ((await turn.stream.next()).value?.type !== 'text') { /* wait for active native work */ }
    await turn.stream.return(undefined);
    expect(alive(peer.calls()[0].pid)).toBe(false);
    expect((await collect(conversations.sendMessage('after close', options()).stream)).some(frame => frame.type === 'text')).toBe(true);
  }, 15000);

  test.each(['return', 'throw'] as const)('iterator %s before first next releases admission without allocating', async action => {
    const turn = conversations.sendMessage('unconsumed', options());
    if (action === 'return') await turn.stream.return(undefined);
    else await expect(turn.stream.throw(new Error('consumer disconnected'))).rejects.toThrow('consumer disconnected');
    expect(peer.calls()).toEqual([]);
    expect((await collect(conversations.sendMessage('after disconnect', options()).stream)).some(frame => frame.type === 'text')).toBe(true);
  }, 15000);

  test('shutdown awaits all cleanup failures and blocks replacement of an owner that did not drain', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    conversations = new CopilotConversations({ startRuntime: async (...args) => {
      const owned = await startCopilotSdkRuntime(...args);
      const first = args[0].profileKey.startsWith('first-owner:');
      return { ...owned, stop: async () => { await owned.stop(); if (first) throw new Error('fixture cleanup failure'); await gate; } };
    } });
    const a: StreamEvent[] = [], b: StreamEvent[] = [];
    const pending = [collect(conversations.sendMessage('DEFERRED_A', options({ cliProfile: { ...peer.profile(), id: 'first-owner' } })).stream, a), collect(conversations.sendMessage('DEFERRED_B', options({ conversationId: 'other' })).stream, b)];
    try {
      await waitForCopilotPeer(() => a.some(frame => frame.type === 'text') && b.some(frame => frame.type === 'text'));
      let settled = false;
      const ending = conversations.shutdown().then(() => null, error => error).then(error => { settled = true; return error; });
      await Promise.resolve(); expect(settled).toBe(false);
      expect((await collect(conversations.sendMessage('during shutdown', options()).stream))[0]).toMatchObject({ type: 'error' });
      release();
      expect(await ending).toBeInstanceOf(AggregateError);
      await Promise.all(pending);
      expect((await collect(conversations.sendMessage('unsafe replacement', options()).stream)).some(frame => frame.type === 'error')).toBe(true);
      expect(peer.calls().filter(call => call.method === 'spawn')).toHaveLength(2);
      expect(peer.calls().filter(call => call.method === 'spawn').every(call => !alive(call.pid))).toBe(true);
    } finally {
      release(); await conversations.shutdown().catch(() => {});
      conversations = new CopilotConversations();
    }
  }, 15000);

  test.each(['opening', 'acknowledgement'])('bounds a hung session %s without replaying work', async stage => {
    conversations = new CopilotConversations({ requestTimeoutMs: process.platform === 'win32' ? 5000 : 1000 });
    const frames = await collect(conversations.sendMessage(stage === 'opening' ? 'hello' : 'HANG_ACK', options({ cliProfile: peer.profile(stage === 'opening' ? { COPILOT_FIXTURE_OPEN: 'hang' } : {}) })).stream);
    expect(frames).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('request timed out') }));
    expect(peer.calls().filter(call => call.method === 'session.send')).toHaveLength(stage === 'opening' ? 0 : 1);
    expect(alive(peer.calls()[0].pid)).toBe(false);
  }, 15000);

  test.each(['EXIT', 'ORPHAN_EXIT'])('reports %s and reaps owned work before finishing', async prompt => {
    const frames = await collect(conversations.sendMessage(prompt, options()).stream);
    expect(frames).toContainEqual(expect.objectContaining({ type: 'error', source: 'transport' }));
    expect(peer.calls().filter(call => call.method === 'session.send')).toHaveLength(1);
    for (const call of peer.calls().filter(call => call.method === 'orphan')) await waitForCopilotPeer(() => !alive(call.child!));
    expect(alive(peer.calls()[0].pid)).toBe(false);
  }, 15000);

  test('recovers a missing session once, emits recovery metadata and uses a fresh usage baseline', async () => {
    const snapshot = jest.fn().mockResolvedValue({ snapshotPath: path.join(dir, 'snapshot.json'), sourceSessionPath: path.join(dir, 'session.json'), sourceSessionNumber: 1, messageCount: 2, capturedAt: '', recoveryCount: 1 });
    const frames = await collect(conversations.sendMessage('recover request', options({ isNewSession: false, externalSessionId: 'missing', sessionRecovery: { createSnapshot: snapshot } })).stream);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(frames.filter(frame => frame.type === 'session_recovery')).toHaveLength(1);
    expect(frames.some(frame => frame.type === 'error')).toBe(false);
    expect(peer.calls().filter(call => call.method === 'session.resume')).toHaveLength(1);
    expect(peer.calls().filter(call => call.method === 'session.create')).toHaveLength(1);
    expect(String(peer.calls().find(call => call.method === 'session.send')?.params?.prompt)).toContain('snapshot.json');
    expect(frames).toContainEqual(expect.objectContaining({ type: 'usage', usage: expect.objectContaining({ inputTokens: 110, credits: 4 }) }));
  }, 15000);

  test.each(['resume after child work', 'after send'])('never recovers/replays %s', async stage => {
    const snapshot = jest.fn();
    const frames = await collect(conversations.sendMessage(stage === 'after send' ? 'FAIL_AFTER_SEND' : 'request', options({ isNewSession: false,
      externalSessionId: stage === 'after send' ? 'saved' : 'missing-after-tool', sessionRecovery: { createSnapshot: snapshot } })).stream);
    expect(frames.some(frame => frame.type === 'error')).toBe(true);
    expect(snapshot).not.toHaveBeenCalled();
    expect(peer.calls().some(call => call.method === 'session.create')).toBe(false);
    expect(peer.calls().filter(call => call.method === 'session.send')).toHaveLength(stage === 'after send' ? 1 : 0);
  }, 15000);

  test('does not replace history after an authorization failure on resume', async () => {
    const frames = await collect(conversations.sendMessage('request', options({ isNewSession: false, externalSessionId: 'denied' })).stream);
    expect(frames).toContainEqual({ type: 'error', error: 'Model not authorized' });
    expect(peer.calls().some(call => call.method === 'session.create' || call.method === 'session.send')).toBe(false);
  }, 15000);

  test('permanent shutdown rejects future lazy streams without allocating a process', async () => {
    await conversations.shutdown({ permanent: true });
    expect((await collect(conversations.sendMessage('late', options()).stream))[0]).toMatchObject({ type: 'error' });
    expect(peer.calls()).toEqual([]);
  });
});
