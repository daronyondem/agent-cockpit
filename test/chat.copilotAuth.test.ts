import { createChatRouterEnv, destroyChatRouterEnv, type ChatRouterEnv } from './helpers/chatEnv';
import { writeCopilotSdkPeer, waitForCopilotPeer } from './helpers/copilotSdkPeer';
import { CopilotAdapter } from '../src/services/backends/copilot';
import { CliProfileAuthService } from '../src/services/cliProfileAuthService';
import { CopilotAuthCleanupError } from '../src/services/backends/copilotProfileStatus';

let env: ChatRouterEnv;
let provider: string | undefined;
beforeEach(async () => { provider = process.env.COPILOT_PROVIDER_BASE_URL; delete process.env.COPILOT_PROVIDER_BASE_URL; env = await createChatRouterEnv(); });
afterEach(async () => { await destroyChatRouterEnv(env); if (provider === undefined) delete process.env.COPILOT_PROVIDER_BASE_URL; else process.env.COPILOT_PROVIDER_BASE_URL = provider; });
async function fixture(scenario: 'success' | 'denied' | 'expired' | 'wait') {
  const peer = writeCopilotSdkPeer(env.tmpDir, scenario);
  const { env: _env, ...profile } = peer.profile();
  const settings = await env.chatService.getSettings();
  await env.chatService.saveSettings({ ...settings, cliProfiles: [profile] });
  return { peer, profile };
}
async function job(id: string) { return (await env.request('GET', `/api/chat/cli-profiles/auth-jobs/${id}`)).body.job; }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('an auth cleanup failure does not prevent the server from draining other backends', async () => {
  const auth = jest.spyOn(CliProfileAuthService.prototype, 'shutdown').mockRejectedValueOnce(new CopilotAuthCleanupError('Fixture auth cleanup failed'));
  const backend = jest.spyOn(env.mockBackend, 'shutdown');
  try {
    await env.chatShutdown();
    await env.backendRegistry.shutdownAll({ permanent: true });
    expect(backend).toHaveBeenCalledTimes(1);
  } finally { auth.mockRestore(); backend.mockRestore(); }
});

test.each(['success', 'denied', 'expired'] as const)('guided Copilot auth uses fresh owned verification and reports %s accurately', async scenario => {
  const { peer, profile } = await fixture(scenario);
  const adapter = new CopilotAdapter(); env.backendRegistry.register(adapter);
  const refresh = jest.spyOn(adapter, 'refreshAccountState');
  const response = await env.request('POST', `/api/chat/cli-profiles/${profile.id}/auth/start`, {});
  expect(response.status).toBe(200);
  expect(response.body.profile).toMatchObject({ authMode: 'server-configured' });
  expect(response.body.profile.configDir).toBeUndefined(); expect(response.body.profile.env).toBeUndefined();
  let terminal: any;
  await waitForCopilotPeer(() => peer.calls().some(call => call.method === 'auth.getStatus'));
  for (let i = 0; i < 500; i++) { terminal = await job(response.body.job.id); if (terminal.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  expect(terminal.status).toBe(scenario === 'success' ? 'succeeded' : 'failed');
  if (scenario !== 'success') expect(terminal.error).toContain(scenario === 'denied' ? 'HTTP 403' : 'credentials did not verify');
  const calls = peer.calls(), launches = calls.filter(call => call.method === 'spawn');
  expect(launches).toHaveLength(2);
  expect(launches[0].args).toEqual(['--no-auto-update', 'login', '--device-code']);
  expect(launches[1].args).toContain('--headless');
  expect(calls.filter(call => call.method.startsWith('session.'))).toHaveLength(0);
  expect(calls.some(call => call.method === 'models.list')).toBe(scenario !== 'expired');
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(launches.map(call => alive(call.pid))).toEqual([false, false]);
  const stored = (await env.chatService.getSettings()).cliProfiles![0];
  expect(stored.configDir).toBeUndefined(); expect(stored.env).toBeUndefined();
});

test('cancels native login descendants, holds the shared lock, and admits a fresh job after cleanup', async () => {
  const { peer, profile } = await fixture('wait');
  const start = await env.request('POST', `/api/chat/cli-profiles/${profile.id}/auth/start`, {});
  await waitForCopilotPeer(() => peer.calls().some(call => call.method === 'auth-child'));
  const concurrent = await env.request('POST', `/api/chat/cli-profiles/${profile.id}/auth/start`, {});
  expect(concurrent.status).toBe(400); expect(concurrent.body.error).toContain('share the terminal login');
  const stopped = await env.request('POST', `/api/chat/cli-profiles/auth-jobs/${start.body.job.id}/cancel`, {});
  expect(stopped.body.job.status).toBe('cancelled');
  const childPid = (peer.calls().find(call => call.method === 'auth-child') as unknown as { childPid: number }).childPid;
  await waitForCopilotPeer(() => !alive(childPid) && !alive(peer.calls()[0].pid));
  expect((await job(start.body.job.id)).status).toBe('cancelled');
  const next = writeCopilotSdkPeer(env.tmpDir, 'success');
  expect(next.command).toBe(profile.command);
  const retry = await env.request('POST', `/api/chat/cli-profiles/${profile.id}/auth/start`, {});
  expect(retry.status).toBe(200);
  let final: any;
  for (let i = 0; i < 500; i++) { final = await job(retry.body.job.id); if (final.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  expect(final.status).toBe('succeeded');
});
