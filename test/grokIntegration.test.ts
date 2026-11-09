import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import { CliProfileAuthService } from '../src/services/cliProfileAuthService';
import { GrokBuildAdapter } from '../src/services/backends/grok';
import { GrokBillingCache } from '../src/services/backends/grokBilling';
import { startGrokRuntime } from '../src/services/backends/grokRuntime';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';
import type { CliProfile } from '../src/types';

const posix = process.platform === 'win32' ? describe.skip : describe;
posix('Grok profiles, auth, and billing integration', () => {
  let env: ChatRouterEnv;
  let profile: CliProfile;
  beforeEach(async () => {
    env = await createChatRouterEnv();
    const command = path.join(env.tmpDir, 'fake-grok');
    await fsp.copyFile(path.join(__dirname, 'fixtures/grok-acp.cjs'), command);
    await fsp.chmod(command, 0o755);
    profile = { id: 'grok-fixture', name: 'Grok Fixture', harness: 'grok-build', authMode: 'server-configured', command, createdAt: '', updatedAt: '' };
    env.backendRegistry.register(new GrokBuildAdapter({ workingDir: env.tmpDir }));
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({ ...settings, cliProfiles: [...(settings.cliProfiles || []), profile] });
  });
  afterEach(async () => { await env.backendRegistry.shutdownAll(); await destroyChatRouterEnv(env); });

  test('profile selection exposes native models and checks account access without exposing identity', async () => {
    const metadata = await env.request('GET', '/api/chat/cli-profiles/grok-fixture/metadata');
    expect(metadata.status).toBe(200);
    expect(metadata.body.backend).toMatchObject({ id: 'grok-build', models: [{ id: 'grok-4.7' }], resumeCapabilities: { activeTurnResume: 'unsupported' } });
    const checked = await env.request('POST', '/api/chat/cli-profiles/grok-fixture/test', {});
    expect(checked.body.result).toMatchObject({ available: true, authenticated: true, status: 'ok', modelCount: 1 });
    expect(JSON.stringify(checked.body)).not.toContain('PRIVATE_ACCOUNT_METADATA');
  });

  test('billing endpoint is profile-scoped and omits missing allowance fields', async () => {
    const billing = await env.request('GET', '/api/chat/cli-profiles/grok-fixture/grok-billing');
    expect(billing.status).toBe(200);
    expect(billing.body).toMatchObject({ profileId: 'grok-fixture', billing: { subscriptionTier: 'Fixture Tier', prepaidBalanceUsd: 1.23 } });
    expect(billing.body.billing.creditUsagePercent).toBeUndefined();
    const wrong = await env.request('GET', '/api/chat/cli-profiles/server-configured-claude-code/grok-billing');
    expect(wrong.status).toBe(400);
    expect((await env.request('GET', '/api/chat/cli-profiles/missing/grok-billing')).status).toBe(400);
  });

  test('billing endpoint reports upstream Grok failures as unavailable', async () => {
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({ ...settings, cliProfiles: [...(settings.cliProfiles || []),
      { ...profile, id: 'grok-billing-down', env: { GROK_FIXTURE_BILLING: 'error' } }] });
    const billing = await env.request('GET', '/api/chat/cli-profiles/grok-billing-down/grok-billing');
    expect(billing.status).toBe(503);
    expect(billing.body.error).toContain('Billing unavailable');
  });

  test('native catalog effort levels survive conversation creation and effort changes', async () => {
    await env.request('GET', '/api/chat/cli-profiles/grok-fixture/metadata');
    const conversation = await env.chatService.createConversation('Grok effort', env.tmpDir, 'grok-build', 'grok-4.7', 'low', profile.id);
    expect(conversation.effort).toBe('low');
    await env.chatService.updateConversationEffort(conversation.id, 'xhigh');
    expect((await env.chatService.getConversation(conversation.id))?.effort).toBe('high');
  });

  test('streams a revised Grok plan for a second decision without repeating native mode entry', async () => {
    const conversation = await env.chatService.createConversation('Grok plan revision', env.tmpDir, 'grok-build', undefined, undefined, profile.id);
    jest.spyOn(env.backendRegistry.get('grok-build')!, 'generateTitle').mockResolvedValue('Grok plan revision');
    const ws = await env.connectWs(conversation.id);
    const decisions: Promise<unknown>[] = [];
    ws.on('message', data => {
      const event = JSON.parse(String(data));
      if (event.type === 'tool_activity' && event.planAction === 'exit') {
        decisions.push(env.request('POST', `/api/chat/conversations/${conversation.id}/input`, {
          text: decisions.length === 0 ? 'Please revise the plan' : 'approve',
          streamActive: true,
        }));
      }
    });
    const reading = env.readWsEvents(ws, 5000);
    try {
      const sent = await env.request('POST', `/api/chat/conversations/${conversation.id}/message`, { content: 'fixture-plan-revision' });
      expect(sent.status).toBe(200);
      const events = await reading;
      const responses = await Promise.all(decisions) as { status: number; body: { mode: string } }[];
      expect(responses.every(response => response.status === 200 && response.body.mode === 'stdin')).toBe(true);
      expect(events.filter(event => event.type === 'tool_activity' && event.planAction === 'exit').map(event => event.planContent)).toEqual(['# Original plan', '# Revised plan']);
      expect(events.some(event => event.type === 'done')).toBe(true);
      expect(events.some(event => event.type === 'assistant_message' && event.message?.content === 'PLAN_DONE')).toBe(true);
    } finally { ws.close(); }
  });

  test('account auth separates signed-in credentials from blocked entitlement and unknown API-key validity', async () => {
    const service = new CliProfileAuthService(env.tmpDir);
    const blocked = await service.checkProfile({ ...profile, env: { GROK_FIXTURE_AUTH: 'blocked' } });
    expect(blocked).toMatchObject({ available: true, authenticated: true, status: 'error', error: 'Grok Build access is blocked: Fixture access is disabled' });
    const sparseGate = await service.checkProfile({ ...profile, env: { GROK_FIXTURE_AUTH: 'blocked-empty' } });
    expect(sparseGate).toMatchObject({ authenticated: true, status: 'error', error: expect.stringContaining('does not have access') });
    const noAuth = await service.checkProfile({ ...profile, env: { GROK_FIXTURE_AUTH: 'none' } });
    expect(noAuth).toMatchObject({ available: true, authenticated: false, status: 'not-authenticated' });
    const key = await service.checkProfile({ ...profile, env: { GROK_FIXTURE_AUTH: 'none', XAI_API_KEY: 'synthetic-key' } });
    expect(key).toMatchObject({ authenticated: null, status: 'ok' });
  });

  test.each([false, true])('API-key-only runtimes authenticate before creating sessions (hidden method: %s)', async hidden => {
    const trace = path.join(env.tmpDir, 'api-auth-trace.jsonl');
    const adapter = env.backendRegistry.get('grok-build')!;
    await expect(adapter.runOneShot('API_AUTH_OK', { workingDir: env.tmpDir, cliProfile: {
      ...profile, env: { GROK_FIXTURE_AUTH: 'none', XAI_API_KEY: 'synthetic-key', GROK_FIXTURE_TRACE: trace, ...(hidden ? { GROK_FIXTURE_API_HIDDEN: '1' } : {}) },
    } })).resolves.toContain('API_AUTH_OK');
    const calls = (await fsp.readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.find(call => call.method === 'authenticate').params).toEqual({ methodId: 'xai.api_key', _meta: { headless: true } });
    expect(calls.findIndex(call => call.method === 'authenticate')).toBeLessThan(calls.findIndex(call => call.method === 'session/new'));
  });

  test('cached terminal credentials take precedence over an advertised API-key fallback', async () => {
    const trace = path.join(env.tmpDir, 'cached-auth-trace.jsonl');
    const runtime = await startGrokRuntime({ ...profile, env: { XAI_API_KEY: 'synthetic-key', GROK_FIXTURE_TRACE: trace } });
    runtime.client.close();
    const calls = (await fsp.readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(call => call.method === 'authenticate')).toEqual([
      { method: 'authenticate', params: { methodId: 'cached_token', _meta: { headless: true } } },
    ]);
  });

  test('setup account normalization reuses terminal auth while explicit account profiles remain isolated', async () => {
    const service = new CliProfileAuthService(env.tmpDir);
    const account: CliProfile = { ...profile, id: 'setup-grok-build-account', authMode: 'account', configDir: path.join(env.tmpDir, 'stale-home'), env: { GROK_HOME: '/stale', OTHER: 'preserved' } };
    const settings = await env.chatService.getSettings();
    const saved = await env.chatService.saveSettings({ ...settings, cliProfiles: [account] });
    expect(saved.cliProfiles![0]).toMatchObject({ harness: 'grok-build', env: { OTHER: 'preserved' } });
    expect(saved.cliProfiles![0].configDir).toBeUndefined();
    expect(saved.cliProfiles![0].env?.GROK_HOME).toBeUndefined();
    const isolated = service.profileWithAuthDefaults({ ...saved, cliProfiles: [{ ...profile, authMode: 'account' }] }, profile.id);
    expect(isolated.profile.configDir).toContain('cli-profiles');
  });

  test('device-login jobs use the native command and verify credentials afterward', async () => {
    const service = new CliProfileAuthService(env.tmpDir, { authTimeoutMs: 5000, statusPollTimeoutMs: 2000, statusPollIntervalMs: 10 });
    const job = await service.startAuth({ ...profile, authMode: 'account', id: 'setup-grok-build-account' });
    expect(job.args).toEqual(['--no-auto-update', 'login', '--device-auth']);
    let status = service.getJob(job.id)!;
    for (let i = 0; i < 100 && status.status === 'running'; i++) { await new Promise(resolve => setTimeout(resolve, 30)); status = service.getJob(job.id)!; }
    expect(status.status).toBe('succeeded');
    expect(status.events.some(event => event.text.includes('FIXTURE-CODE'))).toBe(true);
    service.shutdown();
  });

  test('Welcome setup accepts Grok and retains the system auth home', async () => {
    const settings = await env.chatService.getSettings();
    await env.chatService.saveSettings({ ...settings, cliProfiles: [...(settings.cliProfiles || []), {
      ...profile, id: 'setup-grok-build-account', authMode: 'account', configDir: '/stale-home', env: { GROK_HOME: '/stale-home' },
    }] });
    const result = await env.request('POST', '/api/chat/cli-profiles/setup-auth/grok-build/test', {});
    expect(result.status).toBe(200);
    expect(result.body.result.authenticated).toBe(true);
    expect(result.body.profile.configDir).toBeUndefined();
    expect(result.body.profile.env?.GROK_HOME).toBeUndefined();
  });

  test('billing cache coalesces requests and refreshes when effective profile configuration changes', async () => {
    const trace = path.join(env.tmpDir, 'rpc-trace.jsonl');
    const cache = new GrokBillingCache();
    const scoped = { ...profile, env: { GROK_FIXTURE_TRACE: trace } };
    const [a, b] = await Promise.all([cache.get(scoped), cache.get(scoped)]);
    expect(a).toEqual(b);
    await cache.get(scoped);
    expect(fs.readFileSync(trace, 'utf8').split('\n').filter(line => line.includes('"_x.ai/billing"'))).toHaveLength(1);
    await cache.get({ ...scoped, env: { ...scoped.env, OTHER: 'changed' } });
    expect(fs.readFileSync(trace, 'utf8').split('\n').filter(line => line.includes('"_x.ai/billing"'))).toHaveLength(2);
  });

  test('unsupported ACP negotiation fails without leaving a live runtime', async () => {
    await expect(startGrokRuntime({ ...profile, env: { GROK_FIXTURE_PROTOCOL: '2' } })).rejects.toThrow('ACP version 1');
  });
});
