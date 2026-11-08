import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { cortexInstallCommand } from '../src/services/cortexInstallation';
import { InstallDoctorService } from '../src/services/installDoctorService';
import { resolveCortexRuntime, cortexVersion } from '../src/services/backends/cortexRuntime';

describe('Cortex optional installation', () => {
  let root: string;
  const originalEnv = process.env;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  const ok = { ok: true, stdout: 'fixture', stderr: '' };
  const missing = { ok: false, stdout: '', stderr: '', error: 'not found' };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex install space '));
    process.env = { ...originalEnv, HOME: root, PATH: '/usr/bin:/bin' };
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
  });
  afterEach(() => {
    process.env = originalEnv;
    Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', arch);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const binary = () => path.join(root, '.local/bin/cortex');
  function writeBinary(target = binary()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '#!/bin/sh\nprintf "Cortex Code v1.2.35\\n"\n', { mode: 0o700 });
  }
  function doctor(installRunner = jest.fn().mockResolvedValue(ok), output = 'Cortex Code v1.2.35') {
    const commandRunner = jest.fn(async (command: string) => command === 'cortex' || command === binary()
      ? fs.existsSync(binary()) ? { ...ok, stdout: output } : missing : ok);
    const service = new InstallDoctorService({ appRoot: root, dataRoot: path.join(root, 'data'),
      installStateService: { getStatus: () => ({ channel: 'dev', appDir: root }) } as any,
      commandRunner, installRunner, detectHomebrew: async () => false,
      detectPandoc: async () => ({ available: false, binaryPath: null, version: null, checkedAt: '' }),
      detectLibreOffice: async () => ({ available: false, binaryPath: null, checkedAt: '' }),
    });
    return { service, commandRunner, installRunner };
  }

  test('missing CLI is optional, exposes official actions, and refresh discovers the normal home without PATH changes', async () => {
    const { service } = doctor();
    const check = (await service.getStatus()).checks.find(item => item.id === 'cortex-cli')!;
    expect(check).toMatchObject({ status: 'warning', required: false });
    expect(check.installActions?.map(item => item.id)).toEqual(['cortex-cli:official-install', 'cortex-cli:docs']);
    writeBinary();
    const refreshed = (await service.getStatus()).checks.find(item => item.id === 'cortex-cli')!;
    expect(refreshed).toMatchObject({ status: 'ok', detail: 'Cortex Code v1.2.35' });
    expect(refreshed.summary).toContain('Login has not been checked');
    expect(process.env.PATH).toBe('/usr/bin:/bin');
  });

  test('runs the reviewed standalone installer and verifies detection before reporting success', async () => {
    const install = jest.fn(async () => { writeBinary(); return ok; });
    const { service, commandRunner } = doctor(install);
    const result = await service.runInstallAction('cortex-cli:official-install');
    expect(result.success).toBe(true);
    expect(install).toHaveBeenCalledWith('sh', cortexInstallCommand()!.slice(1), expect.objectContaining({ timeoutMs: 600000 }));
    expect(commandRunner).toHaveBeenCalledWith(binary(), ['--no-auto-update', '--version'], expect.anything());
    expect(result.doctor?.checks.find(item => item.id === 'cortex-cli')?.status).toBe('ok');
  });

  test('rejects exit-zero installers without a responding Cortex binary and surfaces native failures', async () => {
    const { service } = doctor();
    const result = await service.runInstallAction('cortex-cli:official-install');
    expect(result.success).toBe(false); expect(result.error).toContain('refreshed version detection');
    const failed = doctor(jest.fn().mockResolvedValue({ ...missing, error: 'checksum mismatch' }));
    expect((await failed.service.runInstallAction('cortex-cli:official-install')).error).toBe('checksum mismatch');
    writeBinary();
    expect((await doctor(undefined, 'another command').service.getStatus()).checks.find(item => item.id === 'cortex-cli')?.status).toBe('warning');
  });

  test('never starts an install while chat is active and excludes concurrent installs', async () => {
    let finish!: (value: typeof ok) => void;
    const install = jest.fn(() => new Promise<typeof ok>(resolve => { finish = resolve; }));
    const { service } = doctor(install);
    expect((await service.runInstallAction('cortex-cli:official-install', { hasActiveStreams: () => true })).success).toBe(false);
    expect(install).not.toHaveBeenCalled();
    const pending = service.runInstallAction('cortex-cli:official-install');
    while (!finish) await Promise.resolve();
    expect((await service.runInstallAction('cortex-cli:official-install')).error).toContain('already in progress');
    writeBinary(); finish(ok); expect((await pending).success).toBe(true);
  });

  test.each([['win32', 'x64'], ['linux', 'arm64'], ['darwin', 'ia32']])('keeps %s/%s manual without launching a POSIX installer', async (target, cpu) => {
    Object.defineProperty(process, 'platform', { value: target }); Object.defineProperty(process, 'arch', { value: cpu });
    const { service, installRunner, commandRunner } = doctor();
    const check = (await service.getStatus()).checks.find(item => item.id === 'cortex-cli')!;
    expect(check.installActions?.map(item => item.id)).toEqual(['cortex-cli:docs']);
    expect((await service.runInstallAction('cortex-cli:official-install')).error).toBe('Install action not found.');
    expect(installRunner).not.toHaveBeenCalled(); expect(commandRunner).not.toHaveBeenCalledWith('cortex', expect.anything(), expect.anything());
  });

  test.each([['darwin', 'x64'], ['linux', 'x64']])('offers the standalone action for %s/%s without requiring npm', async (target, cpu) => {
    Object.defineProperty(process, 'platform', { value: target }); Object.defineProperty(process, 'arch', { value: cpu });
    const check = (await doctor().service.getStatus()).checks.find(item => item.id === 'cortex-cli')!;
    const command = check.installActions?.find(item => item.id === 'cortex-cli:official-install')?.command;
    expect(command).toEqual(cortexInstallCommand());
    expect(command?.join(' ')).toContain('CORTEX_CHANNEL=stable NON_INTERACTIVE=1 SKIP_PATH_PROMPT=1');
    expect(command?.join(' ')).not.toContain('npm');
  });

  test('download failure does not execute an incomplete script and always removes its temporary file', () => {
    const tools = path.join(root, 'tools'); fs.mkdirSync(tools);
    fs.writeFileSync(path.join(tools, 'curl'), '#!/bin/sh\nexit 22\n', { mode: 0o700 });
    const temp = path.join(root, 'temporary'); fs.mkdirSync(temp);
    expect(() => execFileSync('sh', cortexInstallCommand()!.slice(1), {
      env: { ...process.env, PATH: `${tools}:/usr/bin:/bin`, TMPDIR: temp }, stdio: 'pipe',
    })).toThrow();
    expect(fs.readdirSync(temp)).toEqual([]);
  });

  test('fresh runtime resolution accepts automatic discovery and explicit commands with spaces independently of auth home', async () => {
    writeBinary();
    const profile = { id: 'fixture', harness: 'cortex-code', name: 'fixture', authMode: 'account',
      configDir: path.join(root, 'separate auth'), cortexCode: { connection: 'fixture' }, createdAt: '', updatedAt: '' } as const;
    const automatic = resolveCortexRuntime({ profile, cwd: root, workspaceId: 'fixture' });
    expect(automatic.command).toBe(fs.realpathSync(binary())); expect(await cortexVersion(automatic)).toBe('1.2.35');
    const override = path.join(root, 'custom tools', 'cortex override'); writeBinary(override);
    const explicit = resolveCortexRuntime({ profile: { ...profile, command: override }, cwd: root, workspaceId: 'fixture' });
    expect(explicit.command).toBe(fs.realpathSync(override)); expect(await cortexVersion(explicit)).toBe('1.2.35');
    expect(explicit.env.SNOWFLAKE_HOME).toBe(profile.configDir);
  });
});
