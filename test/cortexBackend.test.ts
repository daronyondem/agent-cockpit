import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { CliProfile, CortexRuntimeConfig, SendMessageOptions, SendMessageResult, StreamEvent } from '../src/types';
import { CortexCodeAdapter } from '../src/services/backends/cortex';
import { CortexSessions } from '../src/services/backends/cortexSessions';
import { CortexRuntime } from '../src/services/backends/cortexRuntime';
import { cortexFixture, cortexWire } from './helpers/cortexFixtures';
import { CortexRpcError } from '../src/services/backends/cortexProtocol';
import { cortexMissingSession } from '../src/services/backends/cortexErrors';

describe('Cortex chat adapter ownership and recovery', () => {
  let dir: string;
  let options: SendMessageOptions;
  let adapter: CortexCodeAdapter;
  let sessions: CortexSessions;
  const fixtures: ReturnType<typeof cortexFixture>[] = [];
  const configs: CortexRuntimeConfig[] = [];
  let loadError: { code: number; message: string; data?: unknown } | undefined;
  let hold = false;
  let nextId = 0;
  const collect = async (value: SendMessageResult) => { const events: StreamEvent[] = []; for await (const event of value.stream) events.push(event); return events; };
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-adapter-'));
    fixtures.length = 0; configs.length = 0; loadError = undefined; hold = false; nextId = 0;
    const profile: CliProfile = { id: 'fixture', name: 'Fixture', harness: 'cortex-code', authMode: 'account', command: process.execPath,
      cortexCode: { connection: 'fixture' }, createdAt: '', updatedAt: '' };
    options = { sessionId: 'chat-session', conversationId: 'conversation', workspaceId: 'immutable-workspace',
      cliProfile: profile, workingDir: dir, systemPrompt: 'Current scoped instructions.', isNewSession: true, model: 'claude-sonnet-4-6', effort: 'low' };
    sessions = new CortexSessions(async (config, onClient) => {
      configs.push(config);
      const fixture = cortexFixture(config.cwd); fixtures.push(fixture);
      const runtime = new CortexRuntime(fixture.client, '1.2.35', fixture.runtime.init, config);
      const catalog = fixture.runtime.configOptions;
      let promptId: string | number | undefined;
      fixture.onRequest(message => {
        const reply = (result: unknown) => fixture.send({ jsonrpc: '2.0', id: message.id, result });
        if (message.method === 'session/new') reply({ sessionId: `native-${++nextId}`, configOptions: catalog });
        else if (message.method === 'session/load') {
          fixture.notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD REPLAY' } }, String(message.params?.sessionId));
          if (loadError) fixture.send({ jsonrpc: '2.0', id: message.id, error: loadError });
          else reply({ configOptions: catalog });
        } else if (message.method === 'session/prompt') {
          promptId = message.id;
          if (!hold) {
            fixture.notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ANSWER' } }, runtime.sessionId);
            reply({ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 0, cachedWriteTokens: 0 } });
          }
        } else if (message.method === 'session/cancel') fixture.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
        else if (message.method === 'session/close') reply({});
      });
      onClient?.(fixture.client);
      return runtime;
    });
    adapter = new CortexCodeAdapter({ sessions, workingDir: dir });
  });
  afterEach(async () => { adapter.shutdown(); await adapter.stopping; await fs.rm(dir, { recursive: true, force: true }); });
  const promptText = (fixture: ReturnType<typeof cortexFixture>) => fixture.writes.filter(message => message.method === 'session/prompt')
    .map(message => (message.params?.prompt as Array<{ text?: string }>).map(block => block.text || '').join('\n'));

  test('exports profile-local catalogs, conservative roles and deterministic processor fallbacks', async () => {
    expect(adapter.allowAutomaticOneShotRetry).toBe(false);
    expect(adapter.oneShotImageFormat).toBe('png');
    expect(adapter.metadata.capabilities).toMatchObject({ stdinInput: false, agents: false, goals: false,
      oneShot: { restrictedText: false, toolEnabled: true, sequential: true } });
    expect(adapter.metadata.resumeCapabilities).toMatchObject({ activeTurnResume: 'unsupported', sessionResume: 'supported' });
    expect((await adapter.getMetadata()).models).toEqual([]);
    expect((await adapter.getMetadata({ cliProfile: options.cliProfile })).models?.some(model => model.id === options.model)).toBe(true);
    expect(adapter.metadata.models).toEqual([]);
    expect(await adapter.generateSummary([], 'Saved summary')).toBe('Saved summary');
    expect(await adapter.generateTitle('a title', 'Fallback')).toBe('Fallback');
    await expect(adapter.runOneShot('do work')).rejects.toThrow('zero-tool');
    expect(() => adapter.sendMessage('missing options')).toThrow('workspace identity');
  });

  test('persists native/runtime identities and emits exactly one answer, usage and terminal event', async () => {
    const events = await collect(adapter.sendMessage('first', options));
    expect(events.filter(e => e.type === 'external_session')).toEqual([{ type: 'external_session', sessionId: 'native-1' }]);
    expect(events.filter(e => e.type === 'backend_runtime')).toHaveLength(1);
    expect(events.filter(e => e.type === 'done')).toHaveLength(1);
    expect(events.filter(e => e.type === 'usage')).toHaveLength(1);
    expect(events.filter(e => e.type === 'result')).toEqual([{ type: 'result', content: 'ANSWER' }]);
    expect(promptText(fixtures[0])[0]).toContain(options.systemPrompt);
    await collect(adapter.sendMessage('second', { ...options, isNewSession: false, externalSessionId: 'native-1' }));
    expect(fixtures).toHaveLength(1);
    expect(promptText(fixtures[0])).toHaveLength(2);
    expect(promptText(fixtures[0])[1]).toBe('second');
  });

  test('unavailable profile metadata returns no catalog or private diagnostic and cannot poison subsequent discovery', async () => {
    const unavailable = await adapter.getMetadata({ cliProfile: { ...options.cliProfile!, command: '/PRIVATE_UNAVAILABLE_CORTEX' } });
    expect(unavailable.models).toEqual([]);
    expect(JSON.stringify(unavailable)).not.toContain('PRIVATE');
    expect(fixtures).toHaveLength(0);
    expect((await adapter.getMetadata({ cliProfile: options.cliProfile })).models?.some(model => model.id === options.model)).toBe(true);
  });

  test('abort after native ownership but before prompt submission closes the owner without sending work', async () => {
    const result = adapter.sendMessage('must not submit', options);
    const events: StreamEvent[] = [];
    for await (const event of result.stream) {
      events.push(event);
      if (event.type === 'external_session') result.abort();
    }
    await new Promise(resolve => setImmediate(resolve));
    expect(promptText(fixtures[0])).toEqual([]);
    expect(fixtures[0].client.isClosed).toBe(true);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(events.some(event => event.type === 'result' || event.type === 'usage')).toBe(false);
    await collect(adapter.sendMessage('fresh user work', options));
    expect(promptText(fixtures[1])[0]).toContain('fresh user work');
  });

  test('idle/server shutdown reloads the same session without replaying old transcript or prompts', async () => {
    await collect(adapter.sendMessage('first', options));
    await sessions.evictIdle(0);
    const resumed = await collect(adapter.sendMessage('continue', { ...options, isNewSession: false, externalSessionId: 'native-1' }));
    expect(fixtures[0].client.isClosed).toBe(true);
    expect(fixtures[1].writes.some(message => message.method === 'session/load')).toBe(true);
    expect(resumed.some(event => event.type === 'text' && event.content.includes('REPLAY'))).toBe(false);
    adapter.shutdown(); await adapter.stopping;
    await collect(adapter.sendMessage('after restart', { ...options, isNewSession: false, externalSessionId: 'native-1' }));
    expect(promptText(fixtures[2])).toHaveLength(1);
    expect(promptText(fixtures[2])[0]).toContain('after restart');
  });

  test('MCP token, endpoint, feature and instruction changes replace the process only at the next safe boundary', async () => {
    const mcp = (token: string, endpoint = 'http://127.0.0.1/old') => [{ name: 'memory', command: 'node', args: ['/fixture/memory.cjs'], env: [
      { name: 'MEMORY_TOKEN', value: token }, { name: 'MEMORY_ENDPOINT', value: endpoint }] }];
    const settings = { ...options, mcpServers: mcp('old-secret') };
    await collect(adapter.sendMessage('first', settings));
    for (const changed of [{ mcpServers: mcp('rotated-secret') }, { mcpServers: mcp('rotated-secret', 'http://127.0.0.1/new') },
      { mcpServers: [] }, { systemPrompt: 'New scoped instructions.' }]) {
      const previous = fixtures.at(-1)!;
      const previousConfig = configs.at(-1)!;
      const pluginDir = previousConfig.args.includes('--plugin-dir') ? previousConfig.args.at(-1)! : undefined;
      Object.assign(settings, changed);
      await collect(adapter.sendMessage('continue', { ...settings, isNewSession: false, externalSessionId: 'native-1' }));
      expect(previous.client.isClosed).toBe(true);
      if (pluginDir) await expect(fs.access(pluginDir)).rejects.toThrow();
      expect(fixtures.at(-1)!.writes.some(message => message.method === 'session/load')).toBe(true);
    }
    expect(promptText(fixtures.at(-1)!)[0]).toContain('New scoped instructions.');
    expect(configs[0].env.COCKPIT_CORTEX_MCP_0_0).toBe('old-secret');
    expect(configs[1].env.COCKPIT_CORTEX_MCP_0_0).toBe('rotated-secret');
    expect(configs[2].env.COCKPIT_CORTEX_MCP_0_1).toBe('http://127.0.0.1/new');
    expect(configs[3].args).not.toContain('--plugin-dir');
    expect(configs[3].env.COCKPIT_CORTEX_MCP_0_0).toBeUndefined();
  });

  test('only classified missing-native-session errors create a snapshot and new native session', async () => {
    const missing = 'lost-native';
    loadError = { code: -32603, message: 'Internal error', data: { details: `Failed to load session ${missing}: Session '${missing}' not found` } };
    const snapshot = jest.fn(async () => null);
    const events = await collect(adapter.sendMessage('current request', { ...options, isNewSession: false, externalSessionId: missing, sessionRecovery: { createSnapshot: snapshot } }));
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(events.filter(event => event.type === 'session_recovery')).toHaveLength(1);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(promptText(fixtures[0])).toEqual([]);
    expect(promptText(fixtures[1])[0]).toContain('prior context may be incomplete');
    expect(promptText(fixtures[1])[0]).toContain('current request');
    adapter.onSessionReset('conversation'); await adapter.stopping;
    loadError = { code: -32603, message: 'Internal error', data: { details: 'private auth failure secret' } };
    const rejected = await collect(adapter.sendMessage('never retry', { ...options, isNewSession: false, externalSessionId: missing, sessionRecovery: { createSnapshot: snapshot } }));
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(rejected.filter(event => event.type === 'error')).toEqual([expect.objectContaining({ error: 'Cortex rejected the request.' })]);
    expect(JSON.stringify(rejected)).not.toContain('secret');
    expect(promptText(fixtures.at(-1)!)).toEqual([]);
  });

  test('abort during prompt cancels once and next user turn may reuse a healthy native session', async () => {
    hold = true;
    const result = adapter.sendMessage('wait', options);
    const events: StreamEvent[] = [];
    for await (const event of result.stream) {
      events.push(event);
      if (event.type === 'backend_runtime') setTimeout(result.abort, 5);
    }
    expect(events.filter(event => event.type === 'error')).toEqual([expect.objectContaining({ source: 'abort' })]);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    expect(fixtures[0].writes.filter(message => message.method === 'session/prompt')).toHaveLength(1);
    hold = false;
    expect((await collect(adapter.sendMessage('next', { ...options, isNewSession: false, externalSessionId: 'native-1' }))).some(event => event.type === 'result')).toBe(true);
  });

  test('abort before startup, concurrent sends and resets cannot launch or reuse an old owner', async () => {
    const first = adapter.sendMessage('cancel before consumption', options);
    expect(() => adapter.sendMessage('overlap', options)).toThrow('already active');
    first.abort();
    expect(await collect(first)).toEqual([{ type: 'done' }]);
    expect(fixtures).toHaveLength(0);
    const waiting = adapter.sendMessage('reset before consumption', options);
    adapter.onSessionReset('conversation'); await adapter.stopping;
    const fresh = adapter.sendMessage('fresh', options);
    expect(await collect(waiting)).toEqual([{ type: 'done' }]);
    await collect(fresh);
    expect(fixtures).toHaveLength(1);
    expect(promptText(fixtures[0])[0]).toContain('fresh');
    expect(waiting.sendInput('stale', 'expired')).toBe(false);
  });

  test('failed configuration does not consume the runtime instruction prefix', async () => {
    const failed = await collect(adapter.sendMessage('bad selection', { ...options, model: 'unavailable' }));
    expect(failed.some(event => event.type === 'error')).toBe(true);
    expect(promptText(fixtures[0])).toEqual([]);
    await collect(adapter.sendMessage('corrected selection', options));
    expect(promptText(fixtures[0])[0]).toContain(options.systemPrompt);
  });

  test('missing-session classification is bound to the observed native version, RPC shape and requested ID', () => {
    const native = cortexWire('load-missing')[0].error!;
    const error = new CortexRpcError(native.message, native.code, native.data);
    const id = '00000000-0000-4000-8000-000000000000';
    expect(cortexMissingSession(error, id, '1.2.35')).toBe(true);
    expect(cortexMissingSession(error, id, '1.2.36')).toBe(false);
    expect(cortexMissingSession(error, 'different', '1.2.35')).toBe(false);
    expect(cortexMissingSession(new Error('Session not found'), id, '1.2.35')).toBe(false);
  });

  test('idle cleanup continues after a pool failure and is supervised again after shutdown', async () => {
    adapter.shutdown(); await adapter.stopping;
    jest.useFakeTimers();
    try {
      const evict = jest.spyOn(sessions, 'evictIdle').mockRejectedValueOnce(new Error('PRIVATE cleanup diagnostic')).mockResolvedValue(undefined);
      adapter.sendMessage('pending stream', options);
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(evict).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(evict).toHaveBeenCalledTimes(2);
      expect(fixtures).toHaveLength(0);
    } finally {
      adapter.shutdown(); await adapter.stopping;
      jest.useRealTimers();
    }
  });
});
