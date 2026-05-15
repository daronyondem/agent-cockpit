import fs from 'fs';
import os from 'os';
import path from 'path';
import { InstallDoctorService } from '../src/services/installDoctorService';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-doctor-root-'));
  fs.mkdirSync(path.join(root, 'public/v2-built'), { recursive: true });
  fs.mkdirSync(path.join(root, 'public/mobile-built'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public/v2-built/index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(root, 'public/mobile-built/index.html'), '<!doctype html>');
  return root;
}

function makeInstallState(root: string, overrides: Record<string, unknown> = {}) {
  return {
    getStatus: () => ({
      schemaVersion: 1,
      channel: 'production',
      source: 'github-release',
      repo: 'daronyondem/agent-cockpit',
      version: '1.2.3',
      branch: null,
      installDir: root,
      appDir: root,
      dataDir: path.join(root, 'data'),
      installedAt: '2026-05-12T00:00:00.000Z',
      welcomeCompletedAt: null,
      nodeRuntime: null,
      stateSource: 'stored',
      stateError: null,
      ...overrides,
    }),
  } as any;
}

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function mockProcessPlatform(platform: NodeJS.Platform): () => void {
  Object.defineProperty(process, 'platform', { value: platform });
  return () => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  };
}

describe('InstallDoctorService', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports required runtime checks and optional tools', async () => {
    const root = makeRoot();
    roots.push(root);
    const dataRoot = path.join(root, 'data');
    const service = new InstallDoctorService({
      appRoot: root,
      dataRoot,
      installStateService: makeInstallState(root),
      updateService: {
        getStatus: () => ({
          localVersion: '1.2.3',
          remoteVersion: '1.2.4',
          updateAvailable: true,
          lastCheckAt: null,
          lastError: null,
          updateInProgress: false,
          installChannel: 'production',
          installSource: 'github-release',
          installStateSource: 'stored',
        }),
      } as any,
      commandRunner: async () => ({ ok: true, stdout: '1.0.0', stderr: '' }),
      detectPandoc: async () => ({ available: true, binaryPath: '/usr/local/bin/pandoc', version: '3.1.1', checkedAt: '2026-05-12T00:00:00.000Z' }),
      detectLibreOffice: async () => ({ available: true, binaryPath: '/usr/local/bin/soffice', checkedAt: '2026-05-12T00:00:00.000Z' }),
    });

    const status = await service.getStatus();

    expect(status.overallStatus).toBe('ok');
    expect(status.install.channel).toBe('production');
    expect(status.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'node', status: 'ok', required: true }),
      expect.objectContaining({ id: 'npm', status: 'ok', required: true }),
      expect.objectContaining({ id: 'pm2', status: 'ok', required: true }),
      expect.objectContaining({ id: 'data-dir', status: 'ok', required: true }),
      expect.objectContaining({ id: 'web-build', status: 'ok', required: true }),
      expect.objectContaining({ id: 'mobile-build', status: 'ok' }),
      expect.objectContaining({ id: 'pandoc', status: 'ok' }),
      expect.objectContaining({ id: 'libreoffice', status: 'ok' }),
      expect.objectContaining({ id: 'update-channel', status: 'ok', detail: expect.stringContaining('remote=1.2.4') }),
    ]));
    expect(status.checks.map(item => item.id)).not.toContain(['cloud', 'flared'].join(''));
  });

  test('surfaces required errors and optional warnings', async () => {
    const resetPlatform = mockProcessPlatform('darwin');
    const root = makeRoot();
    roots.push(root);
    try {
      fs.rmSync(path.join(root, 'public/v2-built/index.html'));
      const dataRoot = path.join(root, 'data-as-file');
      fs.writeFileSync(dataRoot, 'not a directory');
      const service = new InstallDoctorService({
        appRoot: root,
        dataRoot,
        installStateService: makeInstallState(root, { stateSource: 'corrupt', stateError: 'bad json' }),
        commandRunner: async (command) => {
          if (command === 'npm') return { ok: false, stdout: '', stderr: '', error: 'missing npm' };
          if (['claude', 'codex', 'kiro-cli'].includes(command)) return { ok: false, stdout: '', stderr: '', error: 'not found' };
          return { ok: true, stdout: '1.0.0', stderr: '' };
        },
        detectHomebrew: async () => false,
        detectPandoc: async () => ({ available: false, binaryPath: null, version: null, checkedAt: '2026-05-12T00:00:00.000Z' }),
        detectLibreOffice: async () => ({ available: false, binaryPath: null, checkedAt: '2026-05-12T00:00:00.000Z' }),
      });

      const status = await service.getStatus();

      expect(status.overallStatus).toBe('error');
      expect(status.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'npm', status: 'error', required: true }),
        expect.objectContaining({ id: 'data-dir', status: 'error', required: true }),
        expect.objectContaining({ id: 'web-build', status: 'error', required: true }),
        expect.objectContaining({ id: 'claude-cli', status: 'warning', required: false, remediation: expect.stringContaining('@anthropic-ai/claude-code') }),
        expect.objectContaining({ id: 'codex-cli', status: 'warning', required: false, remediation: expect.stringContaining('@openai/codex') }),
        expect.objectContaining({ id: 'kiro-cli', status: 'warning', required: false, remediation: expect.stringContaining('cli.kiro.dev/install') }),
        expect.objectContaining({ id: 'pandoc', status: 'warning', required: false, remediation: expect.stringContaining('If Homebrew is already installed') }),
        expect.objectContaining({ id: 'pandoc', status: 'warning', required: false, remediation: expect.stringContaining('pandoc.org/installing.html') }),
        expect.objectContaining({ id: 'libreoffice', status: 'warning', required: false, remediation: expect.stringContaining('If Homebrew is already installed') }),
        expect.objectContaining({ id: 'libreoffice', status: 'warning', required: false, remediation: expect.stringContaining('libreoffice.org/download') }),
        expect.objectContaining({ id: 'update-channel', status: 'warning', required: false }),
      ]));
      const pandoc = status.checks.find(item => item.id === 'pandoc');
      const libreOffice = status.checks.find(item => item.id === 'libreoffice');
      expect(pandoc?.installActions).toEqual([
        expect.objectContaining({ kind: 'link', label: 'Open installer', href: expect.stringContaining('pandoc.org') }),
      ]);
      expect(libreOffice?.installActions).toEqual([
        expect.objectContaining({ kind: 'link', label: 'Open download', href: expect.stringContaining('libreoffice.org') }),
      ]);
    } finally {
      resetPlatform();
    }
  });

  test('runs allowlisted install actions and refreshes optional detection', async () => {
    const root = makeRoot();
    roots.push(root);
    const installed = new Set<string>();
    const resetPandocDetection = jest.fn();
    const service = new InstallDoctorService({
      appRoot: root,
      dataRoot: path.join(root, 'data'),
      installStateService: makeInstallState(root),
      commandRunner: async () => ({ ok: true, stdout: '1.0.0', stderr: '' }),
      installRunner: async (command, args) => {
        expect(command).toBe('brew');
        expect(args).toEqual(['install', 'pandoc']);
        installed.add('pandoc');
        return { ok: true, stdout: 'installed pandoc', stderr: '' };
      },
      detectHomebrew: async () => true,
      detectPandoc: async () => installed.has('pandoc')
        ? { available: true, binaryPath: '/opt/homebrew/bin/pandoc', version: '3.1.1', checkedAt: '2026-05-12T00:00:00.000Z' }
        : { available: false, binaryPath: null, version: null, checkedAt: '2026-05-12T00:00:00.000Z' },
      detectLibreOffice: async () => ({ available: true, binaryPath: '/usr/local/bin/soffice', checkedAt: '2026-05-12T00:00:00.000Z' }),
      resetPandocDetection,
    });

    const before = await service.getStatus();
    expect(before.checks.find(item => item.id === 'pandoc')?.installActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pandoc:brew-install', kind: 'command', command: ['brew', 'install', 'pandoc'] }),
      expect.objectContaining({ id: 'pandoc:official-download', kind: 'link' }),
    ]));

    const result = await service.runInstallAction('pandoc:brew-install');

    expect(result.success).toBe(true);
    expect(result.steps[0]).toEqual(expect.objectContaining({ name: 'brew install pandoc', success: true, output: 'installed pandoc' }));
    expect(resetPandocDetection).toHaveBeenCalledTimes(1);
    expect(result.doctor?.checks.find(item => item.id === 'pandoc')).toEqual(expect.objectContaining({ status: 'ok' }));
  });

  test('rejects links and active-stream installs', async () => {
    const root = makeRoot();
    roots.push(root);
    const service = new InstallDoctorService({
      appRoot: root,
      dataRoot: path.join(root, 'data'),
      installStateService: makeInstallState(root),
      commandRunner: async () => ({ ok: true, stdout: '1.0.0', stderr: '' }),
      detectPandoc: async () => ({ available: false, binaryPath: null, version: null, checkedAt: '2026-05-12T00:00:00.000Z' }),
      detectLibreOffice: async () => ({ available: true, binaryPath: '/usr/local/bin/soffice', checkedAt: '2026-05-12T00:00:00.000Z' }),
    });

    await expect(service.runInstallAction('pandoc:official-download')).resolves.toEqual(expect.objectContaining({
      success: false,
      error: expect.stringContaining('download page'),
    }));
    await expect(service.runInstallAction('pandoc:brew-install', { hasActiveStreams: () => true })).resolves.toEqual(expect.objectContaining({
      success: false,
      error: expect.stringContaining('actively running'),
    }));
  });

  test('reports Windows logon startup and Windows-specific remediation', async () => {
    const restorePlatform = mockProcessPlatform('win32');
    const root = makeRoot();
    roots.push(root);
    const commands: string[] = [];
    try {
      const service = new InstallDoctorService({
        appRoot: root,
        dataRoot: path.join(root, 'data'),
        installStateService: makeInstallState(root, {
          startup: { kind: 'scheduled-task', name: 'AgentCockpit', scope: 'current-user' },
        }),
        commandRunner: async (command) => {
          commands.push(command);
          if (command === 'schtasks.exe') return { ok: false, stdout: '', stderr: '', error: 'task not found' };
          if (['claude', 'codex', 'kiro-cli'].includes(command)) return { ok: false, stdout: '', stderr: '', error: 'not found' };
          return { ok: true, stdout: '1.0.0', stderr: '' };
        },
        detectHomebrew: async () => false,
        detectPandoc: async () => ({ available: false, binaryPath: null, version: null, checkedAt: '2026-05-15T00:00:00.000Z' }),
        detectLibreOffice: async () => ({ available: false, binaryPath: null, checkedAt: '2026-05-15T00:00:00.000Z' }),
      });

      const status = await service.getStatus();

      expect(commands).toEqual(expect.arrayContaining(['npm.cmd', 'npx.cmd', 'schtasks.exe']));
      expect(status.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'windows-logon-startup',
          status: 'warning',
          remediation: expect.stringContaining('ONLOGON scheduled task'),
        }),
        expect.objectContaining({
          id: 'pandoc',
          remediation: expect.not.stringContaining('Homebrew'),
        }),
        expect.objectContaining({
          id: 'libreoffice',
          remediation: expect.not.stringContaining('Homebrew'),
        }),
        expect.objectContaining({
          id: 'kiro-cli',
          remediation: expect.not.stringContaining('curl -fsSL'),
        }),
      ]));
      const kiroActions = status.checks.find(item => item.id === 'kiro-cli')?.installActions || [];
      expect(kiroActions).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'kiro-cli:official-install' }),
      ]));
      expect(status.checks.find(item => item.id === 'claude-cli')?.installActions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'claude-cli:npm-install', command: ['npm.cmd', 'i', '-g', '@anthropic-ai/claude-code@latest'] }),
      ]));
      expect(status.checks.find(item => item.id === 'codex-cli')?.installActions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'codex-cli:npm-install', command: ['npm.cmd', 'i', '-g', '@openai/codex@latest'] }),
      ]));
    } finally {
      restorePlatform();
    }
  });
});
