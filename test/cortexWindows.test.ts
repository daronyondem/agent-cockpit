import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveCliCommandForRuntime, buildCliCommandInvocation } from '../src/services/cliCommandResolver';
import { resolveCortexRuntime } from '../src/services/backends/cortexRuntime';
import { resolveCortexUpdateRuntime, probeCortexUpdateInstallation } from '../src/services/cortexUpdates';
import { cortexInstallCommand } from '../src/services/cortexInstallation';
import { InstallDoctorService } from '../src/services/installDoctorService';
import type { CliProfile } from '../src/types';
import { CortexAuth } from '../src/services/cortexAuth';
import { CortexConnections, cortexSnowflakeHome } from '../src/services/cortexConnections';
import { cortexOAuthOwner } from '../src/services/cortexOAuth';
import type { CortexLoginCallbacks } from '../src/services/cortexLogin';
import { checkCortexMigrationProfile } from '../src/services/cortexMigration';

describe('CoCo standalone Windows resolution (simulated platform)', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  const originalEnv = process.env;
  let root: string;
  const profile: CliProfile = { id: 'windows-cortex', name: 'CoCo', harness: 'cortex-code', authMode: 'account',
    cortexCode: { connection: 'literal "account"; $(no-shell) & %PATH%' }, createdAt: '', updatedAt: '' };
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cortex Windows space ')));
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    process.env = { LOCALAPPDATA: path.join(root, 'Local App Data'), USERPROFILE: path.join(root, 'user'),
      PATH: '', SNOWFLAKE_HOME: path.join(root, 'terminal auth') };
  });
  afterEach(() => {
    process.env = originalEnv;
    Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', arch);
    jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true });
  });
  function file(target: string) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'fixture', { mode: 0o700 }); return target; }
  const resolve = (changes: Partial<CliProfile> = {}) => resolveCortexRuntime({ profile: { ...profile, ...changes }, cwd: root, workspaceId: 'fixture' });

  test('finds the official standalone directory before PATH and shares the resolver with update discovery', () => {
    const binary = file(path.join(process.env.LOCALAPPDATA!, 'cortex/cortex.exe'));
    const other = file(path.join(root, 'path/cortex.exe'));
    process.env.PATH = path.dirname(other);
    expect(resolve().command).toBe(binary);
    expect(resolveCortexUpdateRuntime(profile, root).command).toBe(binary);
    expect(buildCliCommandInvocation(resolveCliCommandForRuntime('cortex-code', 'cortex'), ['acp', 'serve'])).toEqual({ command: binary, args: ['acp', 'serve'] });
    fs.unlinkSync(binary);
    expect(resolve().command).toBe(other);
  });

  test('accepts explicit executables and case-insensitive Path, retaining connection/plugin/cwd as literal argv', () => {
    const binary = file(path.join(root, 'custom directory/custom.exe'));
    const config = resolve({ command: binary });
    expect(config.args.slice(0, 6)).toEqual(['acp', 'serve', '-c', profile.cortexCode!.connection, '-w', root]);
    expect(resolve({ command: 'custom', env: { Path: `"${path.dirname(binary)}";${path.join(root, 'absent')}` } }).command).toBe(binary);
    const native = resolveCortexRuntime({ profile: { ...profile, command: binary }, cwd: root, workspaceId: 'fixture', pluginDir: path.join(root, 'plugin & literal') });
    expect(native.args.slice(-2)).toEqual(['--plugin-dir', path.join(root, 'plugin & literal')]);
    expect(native.command).toBe(fs.realpathSync(binary));
  });

  test('rejects scripts/shims, directories, missing executables and unsupported architectures without fallback', () => {
    file(path.join(process.env.LOCALAPPDATA!, 'cortex/cortex.exe'));
    for (const command of ['cortex.cmd', 'cortex.bat', 'cortex.ps1', path.join(root, 'cortex.js')]) {
      expect(() => resolve({ command })).toThrow('standalone .exe');
    }
    expect(() => resolve({ command: path.join(root, 'absent.exe') })).toThrow('unavailable');
    fs.mkdirSync(path.join(root, 'directory.exe'));
    expect(() => resolve({ command: path.join(root, 'directory.exe') })).toThrow('unavailable');
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    expect(() => resolve()).toThrow('requires x64');
  });

  test('shared setup auth ignores private overrides; Windows env casing cannot override managed controls', () => {
    file(path.join(process.env.LOCALAPPDATA!, 'cortex/cortex.exe'));
    const config = resolve({ id: 'setup-cortex-code-account', configDir: path.join(root, 'private'),
      env: { snowflake_home: 'private', cortex_oauth_manual: '0', cortex_enable_memory: '1', cortex_acp_test_mode: '1' } });
    expect(config.env).toMatchObject({ SNOWFLAKE_HOME: process.env.SNOWFLAKE_HOME, CORTEX_OAUTH_MANUAL: '1', CORTEX_ENABLE_MEMORY: '0', CORTEX_ACP_TEST_MODE: '0' });
    expect(config.env.snowflake_home).toBeUndefined();
    const custom = resolve({ configDir: '~/custom auth' });
    expect(custom.env.SNOWFLAKE_HOME).toBe(path.join(os.homedir(), 'custom auth'));
    expect(custom.command).toBe(config.command);
    expect(custom.fingerprint).not.toBe(config.fingerprint);
    const home = path.join(root, 'case-sensitive test auth');
    expect(cortexSnowflakeHome({ SNOWFLAKE_HOME: 'older', snowflake_home: home })).toBe(home);
  });

  test('Install Doctor detects a responding standalone binary with manual installation and unknown login', async () => {
    const binary = file(path.join(process.env.LOCALAPPDATA!, 'cortex/cortex.exe'));
    const commandRunner = jest.fn(async () => ({ ok: true, stdout: 'Cortex Code v1.2.35', stderr: '' }));
    const service = new InstallDoctorService({ appRoot: root, dataRoot: path.join(root, 'data'), commandRunner,
      installStateService: { getStatus: () => ({ channel: 'dev', appDir: root }) } as any,
      detectPandoc: async () => ({ available: false, binaryPath: null, version: null, checkedAt: '' }),
      detectLibreOffice: async () => ({ available: false, binaryPath: null, checkedAt: '' }) });
    const check = (await service.getStatus()).checks.find(item => item.id === 'cortex-cli')!;
    expect(check).toMatchObject({ status: 'ok', required: false, summary: expect.stringContaining('Login has not been checked') });
    expect(check.installActions).toBeUndefined();
    expect(commandRunner).toHaveBeenCalledWith(binary, ['--no-auto-update', '--version'], expect.anything());
    expect(cortexInstallCommand()).toBeNull();
    fs.unlinkSync(binary); commandRunner.mockResolvedValue({ ok: false, stdout: '', stderr: 'missing' });
    const missing = (await service.getStatus()).checks.find(item => item.id === 'cortex-cli')!;
    expect(missing).toMatchObject({ status: 'warning', installActions: [{ id: 'cortex-cli:docs' }] });
  });

  test('passive update projection never enables managed Windows updates or queries a release channel', async () => {
    const binary = file(path.join(process.env.LOCALAPPDATA!, 'cortex/cortex.exe'));
    const fetcher = jest.spyOn(globalThis, 'fetch');
    const state = await probeCortexUpdateInstallation('Cortex Code v1.2.35', binary, binary);
    expect(state).toMatchObject({ currentVersion: '1.2.35', updateSupported: false, updateCommand: null, latestVersion: null });
    expect(fetcher).not.toHaveBeenCalled();
    const custom = file(path.join(root, 'custom update/custom.exe'));
    expect(resolveCortexUpdateRuntime({ ...profile, command: 'custom', env: { Path: path.dirname(custom), PRIVATE_TOKEN: 'never inherited', SNOWFLAKE_HOME: 'private' } }, root)).toMatchObject({ command: custom,
      env: { SNOWFLAKE_HOME: process.env.SNOWFLAKE_HOME } });
    expect(resolveCortexUpdateRuntime(profile, root).env.PRIVATE_TOKEN).toBeUndefined();
  });

  test('passive import finds a Windows executable/connection without executing or claiming authentication', async () => {
    file(path.join(process.env.LOCALAPPDATA!, 'cortex/cortex.exe'));
    const connections = new CortexConnections(process.env.SNOWFLAKE_HOME);
    await connections.create({ name: 'fixture', account: 'EXAMPLE', user: 'EXAMPLE' });
    const result = await checkCortexMigrationProfile({ ...profile, cortexCode: { connection: 'fixture' } }, root);
    expect(result).toMatchObject({ status: 'warning', message: expect.stringContaining('executable file and selected Snowflake connection are present') });
    expect(result.message).toContain('Authentication has not been checked');
  });

  test('manual OAuth owns the callback until PTY drain and requires fresh verification on simulated Windows', async () => {
    file(path.join(process.env.LOCALAPPDATA!, 'cortex/cortex.exe'));
    const connections = new CortexConnections(process.env.SNOWFLAKE_HOME);
    await connections.create({ name: 'fixture', account: 'EXAMPLE', user: 'EXAMPLE' });
    const input = { ...profile, cortexCode: { connection: 'fixture' } };
    const result = { profileId: profile.id, harness: profile.harness, command: 'cortex', available: true,
      authenticated: false, status: 'not-authenticated', output: '' };
    const verify = jest.fn().mockResolvedValueOnce(result).mockResolvedValue({ ...result, authenticated: true, status: 'ok' });
    const stop = jest.fn().mockResolvedValue(undefined), write = jest.fn();
    let callbacks!: CortexLoginCallbacks;
    const login = jest.fn((_config, _connection, cb: CortexLoginCallbacks) => { callbacks = cb; return { write, stop }; });
    const service = new CortexAuth({ connections, verify, login, version: async () => '1.2.35' });
    try {
      await expect(service.start({ ...input, env: { snowflake_home: path.join(root, 'other auth') } })).rejects.toThrow('isolated');
      const job = await service.start(input);
      for (let i = 0; i < 100 && !callbacks; i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(login).toHaveBeenCalledWith(expect.objectContaining({ command: resolve().command, env: expect.objectContaining({ SNOWFLAKE_HOME: connections.home }) }), 'fixture', expect.anything());
      callbacks.owner(cortexOAuthOwner('https://fixture.snowflakecomputing.com/oauth/authorize?response_type=code&code_challenge_method=S256&code_challenge=fixture&state=fixture&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2F'));
      const generation = service.get(job.id)!.cortex!.generation;
      service.redirect(job.id, generation, 'http://127.0.0.1:54321/?code=SYNTHETIC&state=fixture&iss=https%3A%2F%2Ffixture.snowflakecomputing.com%2Foauth');
      expect(write).toHaveBeenCalledTimes(1);
      callbacks.ready(); await service.drain();
      expect(service.get(job.id)).toMatchObject({ status: 'succeeded' });
      expect(verify).toHaveBeenCalledTimes(2); expect(stop).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(service.get(job.id))).not.toMatch(/SYNTHETIC|oauth\/authorize/);
    } finally { service.shutdown(); await service.drain(); }
  });
});
