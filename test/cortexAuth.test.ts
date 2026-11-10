import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { CliProfile, CliAuthCheckResult } from '../src/types';
import { CortexAuth } from '../src/services/cortexAuth';
import { CortexConnections } from '../src/services/cortexConnections';
import { cortexOAuthOwner } from '../src/services/cortexOAuth';
import type { CortexLoginCallbacks } from '../src/services/cortexLogin';
import { CliProfileAuthService } from '../src/services/cliProfileAuthService';

function authUrl(state = 'fixture-state'): string {
  return `https://fixture-account.snowflakecomputing.com/oauth/authorize?response_type=code&code_challenge_method=S256&code_challenge=fixture&state=${state}&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2F`;
}
const redirect = 'http://127.0.0.1:54321/?code=PRIVATE_CODE&state=fixture-state&iss=https%3A%2F%2Ffixture-account.snowflakecomputing.com%2Foauth';
const failed: CliAuthCheckResult = { profileId: 'setup-cortex-code-account', harness: 'cortex-code', command: 'fixture', available: true, authenticated: false,
  status: 'not-authenticated', output: '', error: 'Login required.' };
const passed: CliAuthCheckResult = { ...failed, authenticated: true, status: 'ok', output: 'Fresh inference verified.' };

// These fixtures use POSIX shebang commands; Windows has separate simulated tests.
const authSuite = process.platform === 'win32' ? describe.skip : describe;
authSuite('Cortex auth job ownership and lifecycle', () => {
  let dir: string;
  let profile: CliProfile;
  let connections: CortexConnections;
  let callbacks: CortexLoginCallbacks;
  let verify: jest.Mock;
  let login: jest.Mock;
  let stop: jest.Mock;
  let write: jest.Mock;
  const services: CortexAuth[] = [];
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-auth-test-'));
    const command = path.join(dir, 'fixture'); await fs.writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    profile = { id: 'setup-cortex-code-account', name: 'Fixture', harness: 'cortex-code', authMode: 'account', command,
      cortexCode: { connection: 'fixture' }, createdAt: '', updatedAt: '' };
    connections = new CortexConnections(path.join(dir, 'shared-home'));
    await connections.create({ name: 'fixture', account: 'EXAMPLE', user: 'EXAMPLE' });
    verify = jest.fn().mockResolvedValue(failed);
    write = jest.fn(); stop = jest.fn().mockResolvedValue(undefined);
    login = jest.fn((_config, _connection, cb: CortexLoginCallbacks) => { callbacks = cb; return { write, stop }; });
  });
  afterEach(async () => { for (const service of services.splice(0)) { service.shutdown(); await service.drain(); } await fs.rm(dir, { recursive: true, force: true }); });
  function service(extra: object = {}) {
    const value = new CortexAuth({ connections, verify, login, version: async () => '1.2.35', ...extra }); services.push(value); return value;
  }
  async function waiting(value: CortexAuth) {
    const job = await value.start(profile);
    for (let i = 0; i < 100 && !login.mock.calls.length && value.get(job.id)?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(login).toHaveBeenCalledTimes(1);
    callbacks.owner(cortexOAuthOwner(authUrl()));
    return value.get(job.id)!;
  }

  test('shared facade keeps setup/global auth, preserves explicit isolation and delegates checks/jobs', async () => {
    const cortexAuth = service({ verify: jest.fn().mockResolvedValue(passed) });
    const facade = new CliProfileAuthService(dir, { cortexAuth });
    const shared = { ...profile, configDir: '/wrong', env: { snowflake_home: '/wrong', KEEP: 'yes' } };
    const prepared = facade.profileWithAuthDefaults({ cliProfiles: [shared] } as never, shared.id);
    expect(prepared.profile.configDir).toBeUndefined(); expect(prepared.profile.env).toEqual({ KEEP: 'yes' });
    const explicit = { ...profile, id: 'custom', configDir: '/explicit', env: { SNOWFLAKE_HOME: '/separate' } };
    expect(facade.profileWithAuthDefaults({ cliProfiles: [explicit] } as never, explicit.id).profile).toBe(explicit);
    const normal = { ...profile, id: 'shared-custom' };
    expect(facade.profileWithAuthDefaults({ cliProfiles: [normal] } as never, normal.id).changed).toBe(false);
    expect((await facade.checkProfile(profile)).authenticated).toBe(true);
    const job = await facade.startAuth(profile); await cortexAuth.drain();
    expect(facade.getJob(job.id)?.status).toBe('succeeded');
    expect(facade.cancelJob(job.id).status).toBe('succeeded'); await facade.shutdown();
    await expect(cortexAuth.start(explicit)).rejects.toThrow('isolated');
    await expect(cortexAuth.start({ ...profile, disabled: true })).rejects.toThrow('enabled');
  });

  test('retains the active handoff only, validates/consumes once and verifies after native completion', async () => {
    const value = service(); const job = await waiting(value);
    expect(job.cortex).toMatchObject({ phase: 'waiting-for-browser', version: '1.2.35', authorizationUrl: authUrl() });
    expect(new Date(job.cortex!.expiresAt!).getTime() - Date.now()).toBeGreaterThan(590000);
    expect(value.activeJob()?.id).toBe(job.id);
    await expect(value.start({ ...profile, id: 'other' })).rejects.toThrow('already using');
    await expect(value.check(profile)).rejects.toThrow('already using');
    expect(() => value.redirect(job.id, 'old-generation', redirect)).toThrow('no longer active');
    expect(() => value.redirect(job.id, job.cortex!.generation, redirect.replace('54321', '54322'))).toThrow('does not match');
    expect(write).not.toHaveBeenCalled();
    const submitted = value.redirect(job.id, job.cortex!.generation, redirect);
    expect(submitted.cortex?.authorizationUrl).toBeUndefined();
    expect(write).toHaveBeenCalledWith(`${redirect}\r`);
    expect(() => value.redirect(job.id, job.cortex!.generation, redirect)).toThrow('no longer active');
    callbacks.received(); await new Promise(resolve => setTimeout(resolve, 5));
    expect(verify).toHaveBeenCalledTimes(1); // Receipt alone is not exchange completion.
    verify.mockResolvedValue(passed); callbacks.ready(); await value.drain();
    expect(verify).toHaveBeenCalledTimes(2); expect(stop).toHaveBeenCalledTimes(1);
    expect(value.get(job.id)).toMatchObject({ status: 'succeeded', events: [{ text: passed.output }] });
    expect(value.get(job.id)?.cortex).toBeUndefined();
    expect(JSON.stringify(value.get(job.id))).not.toMatch(/PRIVATE_CODE|fixture-state|oauth\/authorize/);
    expect(value.activeJob()).toBeNull();
    expect(await fs.readdir(dir)).toEqual(expect.arrayContaining(['fixture', 'shared-home']));
  });

  test('cancellation drains the native owner before retry; old callbacks cannot mutate a later job', async () => {
    let release!: () => void; stop.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const value = service(); const old = await waiting(value); const oldCallbacks = callbacks;
    expect(value.cancel(old.id).status).toBe('cancelled');
    expect(value.get(old.id)?.cortex).toBeUndefined();
    await expect(value.start(profile)).rejects.toThrow('Wait for cleanup');
    await new Promise(resolve => setTimeout(resolve, 5)); release(); await value.drain();
    stop.mockResolvedValue(undefined); login.mockClear(); verify.mockReset().mockResolvedValueOnce(failed).mockResolvedValue(passed);
    const next = await waiting(value);
    oldCallbacks.owner(cortexOAuthOwner(authUrl('stale'))); oldCallbacks.received(); oldCallbacks.failed();
    expect(value.get(next.id)?.cortex?.authorizationUrl).toBe(authUrl());
    expect(value.get(old.id)?.status).toBe('cancelled'); value.cancel(next.id); await value.drain();
  });

  test('native failure, startup timeout, callback expiry and shutdown scrub secrets and close owned resources', async () => {
    const value = service({ startupTimeoutMs: 15 });
    const job = await value.start(profile); await value.drain(); expect(value.get(job.id)?.status).toBe('failed');
    expect(stop).toHaveBeenCalledTimes(1);
    login.mockClear(); const next = await waiting(value); callbacks.failed(); await value.drain();
    expect(value.get(next.id)?.cortex).toBeUndefined();
    login.mockClear(); const last = await waiting(value);
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 700000);
    expect(() => value.redirect(last.id, last.cortex!.generation, redirect)).toThrow('no longer active'); now.mockRestore();
    value.shutdown(); await value.drain(); expect(value.get(last.id)?.status).toBe('cancelled');
    expect(() => value.cancel('missing')).toThrow('not found'); expect(value.get('missing')).toBeNull();
  });

  test('never registers a URL from a cancelled in-flight startup and supports reusable shutdown', async () => {
    let release!: (version: string) => void;
    const value = service({ version: () => new Promise<string>(resolve => { release = resolve; }) });
    const job = await value.start(profile);
    while (!release) await new Promise(resolve => setTimeout(resolve, 5));
    value.shutdown(); release('1.2.35'); await value.drain(); expect(login).not.toHaveBeenCalled();
    expect(value.get(job.id)?.status).toBe('cancelled');
  });

  test('unsupported versions, non-OAuth connections and missing connection errors are value-free', async () => {
    const value = service({ version: async () => '2.0.0' });
    const first = await value.start(profile); await value.drain(); expect(value.get(first.id)?.error).toContain('not been verified');
    expect(login).not.toHaveBeenCalled();
    await fs.writeFile(path.join(connections.home, 'connections.toml'), '[fixture]\naccount="EXAMPLE"\nauthenticator="SNOWFLAKE"\n');
    verify.mockResolvedValue(failed);
    const second = await value.start(profile); await value.drain(); expect(value.get(second.id)?.error).toContain('OAuth authorization-code');
    const third = await value.start({ ...profile, cortexCode: { connection: 'PRIVATE_MISSING' } }); await value.drain();
    expect(value.get(third.id)?.error).not.toContain('PRIVATE_MISSING');
  });

  test('native exit and failed post-login inference produce a sanitized failure; write errors are not retried', async () => {
    verify.mockResolvedValue(failed);
    const value = service(); const job = await waiting(value); callbacks.exit(); await value.drain();
    expect(value.get(job.id)?.error).toContain('did not verify');
    login.mockClear(); const second = await waiting(value);
    write.mockImplementation(() => { throw new Error('PRIVATE_CODE'); });
    value.redirect(second.id, second.cortex!.generation, redirect); await value.drain();
    expect(value.get(second.id)?.error).not.toContain('PRIVATE_CODE'); expect(write).toHaveBeenCalledTimes(1);
  });

  test('shutdown aborts and drains direct checks before releasing the shared home', async () => {
    let observedAbort = false;
    const value = service({ verify: async (_profile: CliProfile, signal: AbortSignal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { observedAbort = true; resolve(); }, { once: true }));
      return failed;
    } });
    const check = value.check(profile);
    await new Promise(resolve => setImmediate(resolve));
    value.shutdown(); await value.drain();
    expect(observedAbort).toBe(true); expect((await check).authenticated).toBe(false);
  });
});
