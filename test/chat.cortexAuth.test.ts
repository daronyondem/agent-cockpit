import fs from 'fs/promises';
import path from 'path';
import { CortexAuth } from '../src/services/cortexAuth';
import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';

describe('Cortex setup HTTP boundaries', () => {
  let env: ChatRouterEnv;
  let previousHome: string | undefined;
  beforeEach(async () => {
    env = await createChatRouterEnv(); previousHome = process.env.SNOWFLAKE_HOME;
    process.env.SNOWFLAKE_HOME = path.join(env.tmpDir, 'snowflake');
  });
  afterEach(async () => {
    jest.restoreAllMocks(); await destroyChatRouterEnv(env);
    if (previousHome === undefined) delete process.env.SNOWFLAKE_HOME; else process.env.SNOWFLAKE_HOME = previousHome;
  });
  const base = '/api/chat/cli-profiles';

  test('create-only connection route validates body, lists safe summaries and requires CSRF', async () => {
    expect((await env.request('GET', `${base}/cortex-code/connections`)).body).toEqual({ connections: [], job: null });
    const input = { name: 'fixture', account: 'PRIVATE_ACCOUNT', user: 'PRIVATE_USER' };
    const created = await env.request('POST', `${base}/cortex-code/connections`, input);
    expect(created.status).toBe(200); expect(created.headers['cache-control']).toBe('no-store');
    expect(created.body.connections).toEqual([{ name: 'fixture', manualOAuth: true, browserTimeoutMs: 600000 }]);
    expect(JSON.stringify(created.body)).not.toMatch(/PRIVATE/);
    expect((await env.request('POST', `${base}/cortex-code/connections`, input)).status).toBe(400);
    expect((await env.request('POST', `${base}/cortex-code/connections`, { ...input, token: 'PRIVATE' })).status).toBe(400);
    const csrf = await fetch(`${env.baseUrl}${base}/cortex-code/connections`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, name: 'other' }) });
    expect(csrf.status).toBe(403);
    expect(await fs.readFile(path.join(process.env.SNOWFLAKE_HOME!, 'connections.toml'), 'utf8')).toContain('PRIVATE_ACCOUNT');
  });

  test('setup persists only connection selection, retains shared auth and existing defaults, and leaves isolated profiles untouched', async () => {
    const check = jest.spyOn(CortexAuth.prototype, 'check').mockImplementation(async profile => ({ profileId: profile.id, harness: 'cortex-code', command: 'cortex',
      available: true, authenticated: true, status: 'ok', output: 'Fresh inference verified.' }));
    const settings = await env.chatService.getSettings(); const defaultId = settings.defaultCliProfileId;
    const isolated = { id: 'isolated', name: 'Isolated', harness: 'cortex-code' as const, authMode: 'account' as const,
      configDir: '/private/explicit', env: { SNOWFLAKE_HOME: '/private/explicit' }, cortexCode: { connection: 'other' }, createdAt: '', updatedAt: '' };
    await env.chatService.saveSettings({ ...settings, cliProfiles: [...(settings.cliProfiles || []), isolated] });
    const result = await env.request('POST', `${base}/setup-auth/cortex-code/test`, { connection: 'fixture' });
    expect(result.status).toBe(200); expect(result.body.profile.id).toBe('setup-cortex-code-account');
    expect(check.mock.calls[0][0]).toMatchObject({ cortexCode: { connection: 'fixture' } });
    expect(result.body.profile.configDir).toBeUndefined(); expect(result.body.profile.env).toBeUndefined();
    expect(result.body.settings.defaultCliProfileId).toBe(defaultId);
    expect(result.body.settings.cliProfiles.find((profile: { id: string }) => profile.id === 'isolated')).toMatchObject({ configDir: isolated.configDir, env: isolated.env });
    const again = await env.request('POST', `${base}/setup-auth/cortex-code/test`, { connection: 'changed' });
    expect(again.body.profile.cortexCode).toEqual({ connection: 'changed' });
    expect(again.body.settings.cliProfiles.filter((profile: { harness: string }) => profile.harness === 'cortex-code')).toHaveLength(2);
    expect((await env.request('POST', `${base}/setup-auth/cortex-code/test`, {})).status).toBe(400);
  });

  test('start/redirect/poll/cancel delegate to the owned job without caching the active URL', async () => {
    const job = { id: 'job', profileId: 'setup-cortex-code-account', profileName: 'Fixture', harness: 'cortex-code' as const, status: 'running' as const,
      startedAt: '', updatedAt: '', command: 'cortex', args: [], events: [] };
    jest.spyOn(CortexAuth.prototype, 'start').mockResolvedValue(job);
    jest.spyOn(CortexAuth.prototype, 'get').mockReturnValue(job);
    jest.spyOn(CortexAuth.prototype, 'cancel').mockReturnValue({ ...job, status: 'cancelled' });
    const submit = jest.spyOn(CortexAuth.prototype, 'redirect').mockReturnValue(job);
    const start = await env.request('POST', `${base}/setup-auth/cortex-code/start`, { connection: 'fixture' });
    expect(start.status).toBe(200); expect(start.headers['cache-control']).toBe('no-store');
    const poll = await env.request('GET', `${base}/auth-jobs/job`); expect(poll.body.job.id).toBe('job'); expect(poll.headers['cache-control']).toBe('no-store');
    const valid = { generation: 'generation', redirectUrl: 'http://127.0.0.1:54321/?code=PRIVATE' };
    const sent = await env.request('POST', `${base}/auth-jobs/job/redirect`, valid);
    expect(sent.status).toBe(200); expect(submit).toHaveBeenCalledWith('job', valid.generation, valid.redirectUrl);
    expect(sent.headers['cache-control']).toBe('no-store'); expect(JSON.stringify(sent.body)).not.toContain('PRIVATE');
    expect((await env.request('POST', `${base}/auth-jobs/job/redirect`, { ...valid, arbitrary: 'PRIVATE' })).status).toBe(400);
    expect((await fetch(`${env.baseUrl}${base}/auth-jobs/job/redirect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid) })).status).toBe(403);
    expect((await env.request('POST', `${base}/auth-jobs/job/cancel`, {})).body.job.status).toBe('cancelled');
    submit.mockImplementation(() => { throw new Error('This login handoff is no longer active.'); });
    expect((await env.request('POST', `${base}/auth-jobs/job/redirect`, valid)).status).toBe(400);
    expect(await fs.readFile(path.join(env.chatService.baseDir, 'settings.json'), 'utf8')).not.toContain('PRIVATE');
  });

  test('server shutdown waits for auth cleanup instead of exiting with an owned native process', async () => {
    let finish!: () => void;
    const drain = jest.spyOn(CortexAuth.prototype, 'drain').mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    let finished = false;
    const shutdown = env.chatShutdown().then(() => { finished = true; });
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    expect(finished).toBe(false); finish(); await shutdown;
    expect(finished).toBe(true); drain.mockRestore();
  });
});
