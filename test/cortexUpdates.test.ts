import fs from 'fs';
import os from 'os';
import path from 'path';
import { CliUpdateService } from '../src/services/cliUpdateService';
import { cortexInstalledUpdateVersion, cortexStableUpdateVersion, resolveCortexUpdateRuntime } from '../src/services/cortexUpdates';
import type { CliProfile, Settings } from '../src/types';

describe('CoCo standalone updates', () => {
  const originalEnv = process.env;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  const installed = '1.2.35+100000.abcdef012345', latest = '1.2.35+191333.f82de3d91715';
  let root: string, command: string, service: CliUpdateService, settings: Settings, profile: CliProfile;
  let exec: jest.SpyInstance, fetcher: jest.SpyInstance;
  function activate(version: string) {
    const dir = path.join(root, '.local/share/cortex', version); fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'cortex'); fs.writeFileSync(target, '#!/bin/sh\n', { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'cortex-version.txt'), version);
    fs.mkdirSync(path.dirname(command), { recursive: true }); fs.rmSync(command, { force: true }); fs.symlinkSync(target, command);
  }
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex update space ')));
    process.env = { ...originalEnv, HOME: root, PATH: '/usr/bin:/bin', SNOWFLAKE_HOME: path.join(root, 'terminal auth') };
    Object.defineProperty(process, 'platform', { value: 'darwin' }); Object.defineProperty(process, 'arch', { value: 'arm64' });
    command = path.join(root, '.local/bin/cortex'); activate(installed);
    profile = { id: 'coco-a', name: 'CoCo A', harness: 'cortex-code', authMode: 'account', configDir: path.join(root, 'account auth'),
      env: { SNOWFLAKE_HOME: '/profile auth', HOME: '/profile home', CORTEX_CHANNEL: 'dev', PRIVATE_TOKEN: 'profile secret' },
      cortexCode: { connection: 'fixture' }, createdAt: '', updatedAt: '' };
    settings = { theme: 'system', sendBehavior: 'enter', systemPrompt: '', cliProfiles: [profile] };
    service = new CliUpdateService(root);
    exec = jest.spyOn(service as any, '_exec').mockImplementation(async (cmd, args) => {
      if (cmd === command && (args as string[]).join(' ') === '--no-auto-update --version') return 'Cortex Code v1.2.35';
      if (cmd === command && (args as string[])[0] === 'update') { activate(latest); return 'Updated'; }
      throw new Error('Unexpected executable');
    });
    fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, text: async () => latest } as Response);
  });
  afterEach(() => {
    jest.restoreAllMocks(); process.env = originalEnv;
    Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', arch);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const check = async () => (await service.checkNow(async () => settings)).items[0];
  const update = (id: string, extra = {}) => service.triggerUpdate(id, { loadSettings: async () => settings, ...extra });
  async function until(ready: () => boolean) {
    for (let attempt = 0; attempt < 400 && !ready(); attempt++) await new Promise(done => setTimeout(done, 5));
    expect(ready()).toBe(true);
  }

  test('groups shared executable profiles independently of account homes, tokens and PATH', async () => {
    settings.cliProfiles!.push({ ...profile, id: 'coco-b', name: 'CoCo B', command, configDir: '/other account', env: { PATH: '/bin' } });
    const status = await service.checkNow(async () => settings);
    expect(status.items).toHaveLength(1);
    expect(status.items[0]).toMatchObject({ currentVersion: installed, latestVersion: latest, updateAvailable: true,
      installMethod: 'self-update', updateSupported: true, updateCommand: [command, 'update', latest], profileIds: ['coco-a', 'coco-b'] });
    const runtime = resolveCortexUpdateRuntime(profile, root);
    expect(runtime.env.HOME).toBe(root); expect(runtime.env.SNOWFLAKE_HOME).toBe(process.env.SNOWFLAKE_HOME);
    expect(runtime.env.CORTEX_CHANNEL).toBe('stable'); expect(runtime.env.PRIVATE_TOKEN).toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/stable_version.txt'), expect.objectContaining({ signal: expect.anything() }));
    expect(exec.mock.calls.every(call => call[0] === command && call[1].join(' ') === '--no-auto-update --version')).toBe(true);
  });

  test('pins the checked full distribution, waits for shutdown and verifies a fresh activation/version', async () => {
    const target = await check();
    let drain!: () => void;
    const onUpdated = jest.fn(() => new Promise<void>(resolve => { drain = resolve; }));
    const pending = update(target.id, { onUpdated });
    await until(() => Boolean(drain));
    expect(service.getStatus(settings).updateInProgress).toBe(true);
    expect((await update(target.id)).error).toContain('already in progress');
    drain(); const result = await pending;
    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, item: { currentVersion: latest, updateAvailable: false } });
    expect(exec.mock.calls.filter(call => call[1][0] === 'update')).toHaveLength(1);
    expect(exec).toHaveBeenCalledWith(command, ['update', latest], expect.objectContaining({ HOME: root }), 120000);
  });

  test('invalidates/drains after a failed native attempt, never retries it and recovers on an explicit later update', async () => {
    const target = await check(); let fail = true;
    exec.mockImplementation(async (_cmd, args: string[]) => {
      if (args.includes('--version')) return 'Cortex Code v1.2.35';
      if (fail) throw new Error('checksum mismatch');
      activate(latest); return 'Updated';
    });
    const onUpdated = jest.fn(async () => {});
    const failed = await update(target.id, { onUpdated });
    expect(failed).toMatchObject({ success: false, error: 'checksum mismatch', item: { currentVersion: installed } });
    expect(onUpdated).toHaveBeenCalledTimes(1); expect(exec.mock.calls.filter(call => call[1][0] === 'update')).toHaveLength(1);
    expect(service.getStatus(settings).updateInProgress).toBe(false);
    fail = false; expect((await update(target.id, { onUpdated })).success).toBe(true);
  });

  test('rejects exit-zero without activation, even though the old version still responds', async () => {
    exec.mockImplementation(async (_cmd, args: string[]) => args.includes('--version') ? 'Cortex Code v1.2.35' : 'done');
    const target = await check();
    expect(await update(target.id)).toMatchObject({ success: false, error: expect.stringContaining('fresh version detection') });
  });

  test('revalidates a changed activation before running a cached updater', async () => {
    const target = await check(); fs.rmSync(command); fs.writeFileSync(command, 'wrapper', { mode: 0o700 });
    const result = await update(target.id);
    expect(result.success).toBe(false); expect(exec.mock.calls.some(call => call[1][0] === 'update')).toBe(false);
  });

  test('retains known version when network checks fail, blocks execution and recovers after refresh', async () => {
    fetcher.mockRejectedValueOnce(new Error('offline'));
    expect(await check()).toMatchObject({ currentVersion: installed, updateSupported: false, lastError: 'offline' });
    expect(await check()).toMatchObject({ currentVersion: installed, updateSupported: true, lastError: null });
  });

  test('reserves during a pending preflight and rechecks newly active chat before mutation', async () => {
    const target = await check(); let resolve!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    let active = false;
    const pending = update(target.id, { hasActiveStreams: () => active });
    await until(() => Boolean(resolve));
    expect((await update(target.id)).error).toContain('already in progress'); active = true;
    resolve({ ok: true, text: async () => latest } as Response);
    expect((await pending).error).toContain('actively running');
    expect(exec.mock.calls.some(call => call[1][0] === 'update')).toBe(false);
  });

  test.each(['linux', 'win32'])('does not enable native updates on %s without platform evidence', async target => {
    Object.defineProperty(process, 'platform', { value: target });
    settings.cliProfiles![0].command = command;
    expect(await check()).toMatchObject({ updateSupported: false, installMethod: 'unknown' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('rejects wrappers, custom aliases, foreign symlinks, mismatched metadata and unknown updater versions', () => {
    const alias = path.join(root, 'custom cortex'); fs.symlinkSync(command, alias);
    expect(cortexInstalledUpdateVersion(alias)).toBeNull();
    fs.writeFileSync(path.join(path.dirname(fs.realpathSync(command)), 'cortex-version.txt'), 'different');
    expect(cortexInstalledUpdateVersion(command)).toBeNull();
    fs.rmSync(command); fs.symlinkSync(alias, command); expect(cortexInstalledUpdateVersion(command)).toBeNull();
  });

  test('shows unverified stable releases before updating and verifies their installation without enabling their own updater', async () => {
    const future = '1.2.36+200000.abcdef012345'; fetcher.mockResolvedValue({ ok: true, text: async () => future });
    const target = await check(); expect(target.updateCaution).toContain('has not been certified');
    exec.mockImplementation(async (_cmd, args: string[]) => {
      if (args[0] === 'update') { activate(future); return 'Updated'; }
      return fs.realpathSync(command).includes(future) ? 'Cortex Code v1.2.36' : 'Cortex Code v1.2.35';
    });
    expect(await update(target.id)).toMatchObject({ success: true, item: { currentVersion: future, updateSupported: false } });
  });

  test.each([{ ok: false, status: 503 }, { ok: true, text: async () => '1.2.35; echo unsafe' }])('rejects invalid stable metadata', async response => {
    fetcher.mockResolvedValue(response);
    await expect(cortexStableUpdateVersion()).rejects.toThrow(/HTTP 503|invalid stable version/);
  });
});
