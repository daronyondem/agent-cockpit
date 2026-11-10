import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createCanvas } from '@napi-rs/canvas';
import type { CliProfile, CortexRpcMessage } from '../src/types';
import { CortexCodeAdapter } from '../src/services/backends/cortex';
import { CortexSessions } from '../src/services/backends/cortexSessions';
import { CortexRuntime } from '../src/services/backends/cortexRuntime';
import { cortexFixture, cortexWire } from './helpers/cortexFixtures';
import { cortexRecord } from '../src/services/backends/cortexProtocol';
import { checkBackendRoleEligibility } from '../src/contracts/backendCapabilities';
import { cortexRestrictedPlatform } from '../src/services/backends/cortexRestrictedPolicy';

describe('Cortex ephemeral processors', () => {
  let dir: string;
  let adapter: CortexCodeAdapter;
  let profile: CliProfile;
  let sessions: CortexSessions;
  const fixtures: ReturnType<typeof cortexFixture>[] = [];
  let holdStartup = false;
  let cancelDelay = 0;
  const prompts = (f: ReturnType<typeof cortexFixture>) => f.writes.filter(row => row.method === 'session/prompt');
  const waitFor = async (condition: () => boolean) => {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(condition()).toBe(true);
  };
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-shots-'));
    fixtures.length = 0; holdStartup = false; cancelDelay = 0;
    profile = { id: 'processor', name: 'Processor', harness: 'cortex-code', command: process.execPath, authMode: 'account',
      cortexCode: { connection: 'fixture' }, createdAt: '', updatedAt: '' };
    sessions = new CortexSessions(async (config, onClient, signal) => {
      if (holdStartup) await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
      if (signal?.aborted) throw new Error('PRIVATE startup diagnostic');
      const f = cortexFixture(config.cwd); fixtures.push(f);
      const runtime = new CortexRuntime(f.client, '1.2.35', f.runtime.init, config);
      let pending: CortexRpcMessage | undefined;
      let nonce = '';
      f.onRequest(message => {
        const reply = (result: unknown) => f.send({ jsonrpc: '2.0', id: message.id, result });
        if (message.method === 'session/new') reply({ sessionId: `native-${fixtures.length}`, configOptions: f.runtime.configOptions });
        if (message.method === 'session/close') reply({});
        if (message.method === 'session/cancel' && pending) {
          const cancelled = () => f.send({ jsonrpc: '2.0', id: pending!.id, result: { stopReason: 'cancelled' } });
          if (cancelDelay) setTimeout(cancelled, cancelDelay);
          else cancelled();
        }
        if (message.method !== 'session/prompt') return;
        pending = message;
        const text = (message.params!.prompt as Array<{ text?: string }>)[0].text!;
        queueMicrotask(() => {
          if (text === 'hold') return;
          if (text === 'question' || text === 'plan') {
            const frames = cortexWire(text === 'question' ? 'questions' : 'plan-revision');
            if (text === 'plan') {
              const plan = frames.find(row => cortexRecord(row.params?.update).sessionUpdate === 'plan')!;
              f.send({ ...plan, params: { ...plan.params, sessionId: runtime.sessionId } });
            }
            const request = frames.find(row => row.method === 'session/request_permission')!;
            f.send({ ...request, params: { ...request.params, sessionId: runtime.sessionId } });
            return;
          }
          if (text === 'rpc-error') return f.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'PRIVATE token' } });
          if (text.startsWith('remember:')) nonce = text.slice(9);
          f.notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text === 'recall' ? nonce : 'ANSWER' } }, runtime.sessionId);
          reply({ stopReason: text === 'stopped' ? 'max_tokens' : 'end_turn', usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 0, cachedWriteTokens: 0 } });
        });
      });
      onClient?.(f.client);
      return runtime;
    });
    adapter = new CortexCodeAdapter({ sessions, workingDir: dir });
  });
  afterEach(async () => { await adapter.shutdown(); await fs.rm(dir, { recursive: true, force: true }); });
  const options = () => ({ allowTools: true, cliProfile: profile, model: 'claude-sonnet-4-6', effort: 'low' as const });

  test('restricted MCP remains rejected, with no tool-enabled startup or changed fallback behavior', async () => {
    for (const allowTools of [undefined, false]) {
      await expect(adapter.runOneShot('hostile /command', { cliProfile: profile, allowTools,
        mcpServers: [{ name: 'never', command: 'missing', args: [] }] })).rejects.toThrow('cannot accept MCP');
      expect(await adapter.runSessionShot([], { cliProfile: profile, allowTools })).toEqual([]);
    }
    expect(fixtures).toHaveLength(0);
    expect(checkBackendRoleEligibility(adapter.metadata, { role: 'restrictedText' }).ok).toBe(cortexRestrictedPlatform());
    expect(checkBackendRoleEligibility(adapter.metadata, { role: 'toolEnabled', sequential: true }).ok).toBe(true);
    expect(await adapter.generateTitle('request', 'Fallback')).toBe('Fallback');
    expect(await adapter.generateSummary([], 'Summary')).toBe('Summary');
    expect(fixtures).toHaveLength(0);
  });

  test('validates profile/deadline/pre-abort and handles empty sequences without spawning', async () => {
    await expect(adapter.runOneShot('one', { allowTools: true })).rejects.toThrow('explicit CLI profile');
    await expect(adapter.runOneShot('one', { ...options(), timeoutMs: 0 })).rejects.toThrow('positive');
    await expect(adapter.runOneShot('one', { ...options(), abortSignal: AbortSignal.abort() })).rejects.toThrow('cancelled');
    expect(await adapter.runSessionShot([], options())).toEqual([]);
    expect(fixtures).toHaveLength(0);
  });

  test('uses one native session per sequence, sends only each new prompt and isolates concurrent jobs', async () => {
    expect(await Promise.all([
      adapter.runSessionShot(['remember:alpha', 'recall'], options()),
      adapter.runSessionShot(['remember:beta', 'recall'], options()),
    ])).toEqual([['ANSWER', 'alpha'], ['ANSWER', 'beta']]);
    expect(fixtures).toHaveLength(2);
    for (const f of fixtures) {
      expect(prompts(f)).toHaveLength(2);
      expect(prompts(f)[1].params?.prompt).toEqual([{ type: 'text', text: 'recall' }]);
      expect(f.writes.filter(row => row.method === 'session/new')).toHaveLength(1);
      expect(f.writes.some(row => row.method === 'session/load')).toBe(false);
      expect(f.client.isClosed).toBe(true);
    }
    expect(await adapter.runOneShot('fresh', options())).toBe('ANSWER');
    expect(fixtures).toHaveLength(3);
  });

  test.each(['question', 'plan'])('fails fast on a native %s without inventing an answer or sending the next prompt', async input => {
    await expect(adapter.runSessionShot([input, 'never'], options())).rejects.toThrow('requires a human decision');
    expect(prompts(fixtures[0])).toHaveLength(1);
    expect(fixtures[0].writes.some(row => cortexRecord(cortexRecord(row.result).outcome).outcome === 'cancelled')).toBe(true);
    expect(fixtures[0].client.isClosed).toBe(true);
  });

  test('deadline includes native startup and cancellation stops an active prompt without retry', async () => {
    holdStartup = true;
    await expect(adapter.runOneShot('never', { ...options(), timeoutMs: 30 })).rejects.toThrow('timed out');
    expect(fixtures).toHaveLength(0);
    holdStartup = false;
    const controller = new AbortController();
    const pending = adapter.runOneShot('hold', { ...options(), abortSignal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await waitFor(() => fixtures.length > 0 && prompts(fixtures[0]).length === 1);
    controller.abort(); await rejected;
    expect(fixtures[0].writes.some(row => row.method === 'session/cancel')).toBe(true);
    expect(fixtures[0].client.isClosed).toBe(true);
    await expect(adapter.runOneShot('hold', { ...options(), timeoutMs: 40 })).rejects.toThrow('timed out');
    expect(fixtures).toHaveLength(2);
  });

  test('shutdown drains active and late startups and permits a fresh processor after an update', async () => {
    holdStartup = true;
    const pending = adapter.runOneShot('never', options());
    const rejected = expect(pending).rejects.toThrow('shutdown');
    await adapter.shutdown(); await rejected;
    expect(fixtures).toHaveLength(0);
    holdStartup = false;
    const active = adapter.runOneShot('hold', options());
    const stopped = expect(active).rejects.toThrow('shutdown');
    await waitFor(() => fixtures.length > 0 && prompts(fixtures[0]).length > 0);
    await adapter.shutdown(); await stopped;
    expect(await adapter.runOneShot('new', options())).toBe('ANSWER');
  });

  test('sanitizes native failures and rejects incomplete terminal responses without retry', async () => {
    await expect(adapter.runOneShot('rpc-error', options())).rejects.toThrow('Cortex rejected the request.');
    await expect(adapter.runSessionShot(['stopped', 'never'], options())).rejects.toThrow('before completing');
    expect(fixtures).toHaveLength(2);
    expect(fixtures.every(f => f.client.isClosed && prompts(f).length === 1)).toBe(true);
  });

  test('a pool cleanup failure cannot make shutdown return before active processor cancellation drains', async () => {
    cancelDelay = 30;
    const pending = adapter.runOneShot('hold', options());
    let settled = false;
    const rejected = expect(pending).rejects.toThrow('shutdown').finally(() => { settled = true; });
    await waitFor(() => fixtures.length > 0 && prompts(fixtures[0]).length > 0);
    const failure = jest.spyOn(sessions, 'shutdown').mockRejectedValueOnce(new Error('PRIVATE cleanup diagnostic'));
    await adapter.shutdown();
    expect(settled).toBe(true);
    expect(fixtures[0].client.isClosed).toBe(true);
    await rejected; failure.mockRestore();
  });

  test('attaches verified PNG bytes from a server path outside cwd; rejects unsupported models and media before prompting', async () => {
    const imageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-input-'));
    try {
      const file = path.join(imageDir, 'page.png');
      await fs.writeFile(file, createCanvas(8, 8).toBuffer('image/png'));
      const attachments = [{ path: file, kind: 'image' as const }];
      expect(await adapter.runOneShot('read image', { ...options(), attachments })).toBe('ANSWER');
      expect(prompts(fixtures[0])[0].params?.prompt).toContainEqual(expect.objectContaining({ type: 'image', mimeType: 'image/png' }));
      await expect(adapter.runOneShot('read image', { ...options(), model: 'auto', attachments })).rejects.toThrow('not verified');
      await expect(adapter.runOneShot('read pdf', { ...options(), attachments: [{ path: file, kind: 'pdf' }] })).rejects.toThrow('text or PNG');
      expect(prompts(fixtures[1])).toHaveLength(0);
      expect(prompts(fixtures[2])).toHaveLength(0);
    } finally { await fs.rm(imageDir, { recursive: true, force: true }); }
  });
});
