import type { CliProfile } from '../src/types';
import { verifyCortexAuthentication } from '../src/services/cortexAuthVerification';
import { cortexFixture } from './helpers/cortexFixtures';
import { cortexRecord } from '../src/services/backends/cortexProtocol';
import { startCortexRuntime } from '../src/services/backends/cortexRuntime';

const verificationSuite = process.platform === 'win32' ? describe.skip : describe;
verificationSuite('Cortex fresh-process auth verification', () => {
  const profile: CliProfile = { id: 'verify', name: 'Verify', harness: 'cortex-code', authMode: 'account', command: process.execPath,
    cortexCode: { connection: 'fixture' }, createdAt: '', updatedAt: '' };
  const usage = { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cachedWriteTokens: 0 };
  const fixtures: ReturnType<typeof cortexFixture>[] = [];
  afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.client.close())); });
  function start(mode = 'ok'): typeof startCortexRuntime {
    return async (config, onClient) => {
      const fixture = cortexFixture(config.cwd); fixtures.push(fixture);
      onClient?.(fixture.client);
      fixture.onRequest(message => {
        if (message.method === 'session/new' && mode === 'stalled-scope-catalog'
          && JSON.parse(config.env.CORTEX_CODE_EXPERIMENTAL_FEATURES!).restrictedSessionScope !== false) return;
        if (message.method === 'session/new' || message.method === 'session/close') fixture.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fixture-session' } });
        if (message.method !== 'session/prompt') return;
        const prompt = String(cortexRecord((message.params?.prompt as unknown[])[0]).text);
        expect(prompt).toContain('Do not use any tools');
        if (mode === 'timeout') return;
        if (mode === 'permission') {
          fixture.send({ jsonrpc: '2.0', id: 'permission', method: 'session/request_permission', params: { sessionId: 'fixture-session', options: [] } }); return;
        }
        if (mode === 'tool') { fixture.notification({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'bash', rawInput: { command: 'PRIVATE' } }); return; }
        const text = mode === 'missing' ? 'Error: Connection error: Error: No Snowflake connection available. PRIVATE_ACCOUNT'
          : mode === 'grant' ? 'Error: Error: API error 403: PRIVATE_TOKEN'
            : mode === 'wrong' ? 'wrong text PRIVATE_TOKEN' : prompt.match(/COCKPIT_AUTH_[a-f0-9]+/)![0];
        fixture.notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
        fixture.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: mode === 'cancelled' ? 'cancelled' : 'end_turn',
          ...(mode === 'partial' || mode === 'missing' || mode === 'grant' ? {} : { usage }) } });
      });
      return fixture.runtime;
    };
  }

  test('requires an exact unpredictable response and final usage from a new isolated synthetic workspace each time', async () => {
    const first = await verifyCortexAuthentication(profile, undefined, start());
    const second = await verifyCortexAuthentication(profile, undefined, start());
    expect(first).toMatchObject({ authenticated: true, status: 'ok', available: true });
    expect(second.authenticated).toBe(true);
    expect(fixtures[0].runtime.config.cwd).not.toBe(fixtures[1].runtime.config.cwd);
    expect(JSON.stringify(first)).not.toContain('COCKPIT_AUTH_');
    expect(fixtures.every(fixture => fixture.client.isClosed)).toBe(true);
  });
  test('verification does not wait for the optional native SQL guardrail catalog', async () => {
    const result = await verifyCortexAuthentication({ ...profile,
      env: { CORTEX_CODE_EXPERIMENTAL_FEATURES: JSON.stringify({ restrictedSessionScope: true, useThreads: false }) },
    }, undefined, start('stalled-scope-catalog'), 500);
    expect(result).toMatchObject({ available: true, authenticated: true, status: 'ok' });
    expect(fixtures[0].writes.filter(message => message.method === 'session/prompt')).toHaveLength(1);
    expect(fixtures[0].client.isClosed).toBe(true);
  });
  test.each(['partial', 'wrong', 'cancelled', 'grant', 'missing', 'permission', 'tool'])('fails closed and sanitizes native %s output', async mode => {
    const result = await verifyCortexAuthentication(profile, undefined, start(mode));
    expect(result.authenticated).not.toBe(true);
    expect(result.status).toBe(mode === 'missing' ? 'not-authenticated' : 'error');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|COCKPIT_AUTH_|permission/);
    expect(fixtures[0].client.isClosed).toBe(true);
    expect(fixtures[0].writes.filter(message => message.method === 'session/prompt')).toHaveLength(1);
  });
  test('initialization without inference is bounded and cleans its process', async () => {
    const result = await verifyCortexAuthentication(profile, undefined, start('timeout'), 20);
    expect(result.authenticated).toBeNull(); expect(result.error).toContain('timed out');
    expect(fixtures[0].client.isClosed).toBe(true);
  });
  test('external abort and already-aborted checks cannot claim saved auth', async () => {
    const controller = new AbortController(); controller.abort();
    const startup = jest.fn(start());
    expect((await verifyCortexAuthentication(profile, controller.signal, startup)).authenticated).toBeNull();
    expect(startup).not.toHaveBeenCalled();
    const next = new AbortController(); const pending = verifyCortexAuthentication(profile, next.signal, start('timeout'));
    while (!fixtures.length) await new Promise(resolve => setTimeout(resolve, 5));
    next.abort(); expect((await pending).error).toContain('cancelled');
  });
  test('spawn/auth RPC failures and missing CLI paths do not echo error values', async () => {
    const result = await verifyCortexAuthentication(profile, undefined, async () => { throw new Error('PRIVATE_TOKEN https://example.invalid/?code=SECRET'); });
    expect(result.available).toBe(false); expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|example.invalid/);
    expect((await verifyCortexAuthentication({ ...profile, command: '/missing-private-command' })).authenticated).toBeNull();
  });
  test('session setup failures identify the stage without claiming bad credentials or echoing native errors', async () => {
    const startup: typeof startCortexRuntime = async (config, onClient, signal) => {
      const runtime = await start()(config, onClient, signal);
      runtime.sessionId = null;
      jest.spyOn(runtime, 'prepare').mockRejectedValueOnce(new Error('PRIVATE_TOKEN https://example.invalid/?code=SECRET'));
      return runtime;
    };
    const result = await verifyCortexAuthentication(profile, undefined, startup);
    expect(result).toMatchObject({ available: true, authenticated: null, status: 'error' });
    expect(result.error).toContain('ACP session setup failed before login could be verified');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|example.invalid/);
    expect(fixtures[0].client.isClosed).toBe(true);
    expect(fixtures[0].writes.some(message => message.method === 'session/prompt')).toBe(false);
  });
});
