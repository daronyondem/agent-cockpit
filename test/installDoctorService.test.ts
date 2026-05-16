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
    const originalAppData = process.env.APPDATA;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    delete process.env.APPDATA;
    delete process.env.LOCALAPPDATA;
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
          if ([path.join(root, 'cli-tools', 'claude.cmd'), 'claude.exe', 'claude.cmd', path.join(root, 'cli-tools', 'codex.cmd'), 'codex.exe', 'codex.cmd', 'kiro-cli'].includes(command)) return { ok: false, stdout: '', stderr: '', error: 'not found' };
          return { ok: true, stdout: '1.0.0', stderr: '' };
        },
        detectHomebrew: async () => false,
        detectPandoc: async () => ({ available: false, binaryPath: null, version: null, checkedAt: '2026-05-15T00:00:00.000Z' }),
        detectLibreOffice: async () => ({ available: false, binaryPath: null, checkedAt: '2026-05-15T00:00:00.000Z' }),
      });

      const status = await service.getStatus();

      expect(commands).toEqual(expect.arrayContaining(['npm.cmd', 'node.exe', 'schtasks.exe', path.join(root, 'cli-tools', 'claude.cmd'), 'claude.exe', 'claude.cmd', path.join(root, 'cli-tools', 'codex.cmd'), 'codex.exe', 'codex.cmd']));
      expect(commands).not.toEqual(expect.arrayContaining(['npx.cmd']));
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
        expect.objectContaining({ id: 'claude-cli:npm-install', command: ['npm.cmd', '--prefix', path.join(root, 'cli-tools'), 'i', '-g', '@anthropic-ai/claude-code@latest'] }),
      ]));
      expect(status.checks.find(item => item.id === 'codex-cli')?.installActions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'codex-cli:npm-install', command: ['npm.cmd', '--prefix', path.join(root, 'cli-tools'), 'i', '-g', '@openai/codex@latest'] }),
      ]));
    } finally {
      if (originalAppData === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = originalAppData;
      }
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
      restorePlatform();
    }
  });

  test('uses installer-recorded Windows Node runtime for npm and PM2 checks', async () => {
    const restorePlatform = mockProcessPlatform('win32');
    const root = makeRoot();
    roots.push(root);
    const runtimeBinDir = path.join(root, 'runtime', 'node v22 win x64');
    const cliToolsDir = path.join(root, 'cli-tools');
    const originalAppData = process.env.APPDATA;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    delete process.env.APPDATA;
    delete process.env.LOCALAPPDATA;
    const npmCli = path.join(runtimeBinDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const npxCli = path.join(runtimeBinDir, 'node_modules', 'npm', 'bin', 'npx-cli.js');
    const nodeExe = path.join(runtimeBinDir, 'node.exe');
    const pm2Bin = path.join(root, 'node_modules', 'pm2', 'bin', 'pm2');
    fs.mkdirSync(path.dirname(npmCli), { recursive: true });
    fs.mkdirSync(path.dirname(pm2Bin), { recursive: true });
    fs.writeFileSync(nodeExe, '');
    fs.writeFileSync(npmCli, '');
    fs.writeFileSync(npxCli, '');
    fs.writeFileSync(pm2Bin, '');
    const commands: Array<{ command: string; args: string[] }> = [];
    try {
      const service = new InstallDoctorService({
        appRoot: root,
        dataRoot: path.join(root, 'data'),
        installStateService: makeInstallState(root, {
          nodeRuntime: {
            source: 'private',
            version: '22.22.3',
            npmVersion: '10.9.8',
            binDir: runtimeBinDir,
            runtimeDir: runtimeBinDir,
            requiredMajor: 22,
            updatedAt: '2026-05-15T00:00:00.000Z',
          },
        }),
        commandRunner: async (command, args) => {
          commands.push({ command, args });
          if (command === 'npm.cmd' || command === 'npx.cmd') {
            return { ok: false, stdout: '', stderr: '', error: 'plain PATH command should not be used' };
          }
          if (command === path.join(runtimeBinDir, 'npm.cmd') || command === path.join(runtimeBinDir, 'npx.cmd')) {
            return { ok: false, stdout: '', stderr: '', error: 'runtime command shim should not be used' };
          }
          if (command === nodeExe && args[0] === npmCli) return { ok: true, stdout: '10.9.8', stderr: '' };
          if (command === nodeExe && args[0] === npxCli) return { ok: false, stdout: '', stderr: '', error: 'npx should not be used for PM2 on Windows' };
          if (command === nodeExe && args[0] === pm2Bin) return { ok: true, stdout: '7.0.1', stderr: '' };
          if ([path.join(cliToolsDir, 'claude.cmd'), path.join(runtimeBinDir, 'claude.cmd'), 'claude.exe', 'claude.cmd', path.join(cliToolsDir, 'codex.cmd'), path.join(runtimeBinDir, 'codex.cmd'), 'codex.exe', 'codex.cmd', 'kiro-cli'].includes(command)) return { ok: false, stdout: '', stderr: '', error: 'not found' };
          if (command === 'schtasks.exe') return { ok: true, stdout: '1.0.0', stderr: '' };
          return { ok: true, stdout: '1.0.0', stderr: '' };
        },
        detectHomebrew: async () => false,
        detectPandoc: async () => ({ available: true, binaryPath: 'C:\\Tools\\pandoc.exe', version: '3.1.1', checkedAt: '2026-05-15T00:00:00.000Z' }),
        detectLibreOffice: async () => ({ available: true, binaryPath: 'C:\\Tools\\soffice.exe', checkedAt: '2026-05-15T00:00:00.000Z' }),
      });

      const status = await service.getStatus();

      expect(commands).toEqual(expect.arrayContaining([
        { command: nodeExe, args: [npmCli, '--version'] },
        { command: nodeExe, args: [pm2Bin, '--version'] },
      ]));
      expect(commands.map(call => call.command)).not.toEqual(expect.arrayContaining(['npm.cmd', 'npx.cmd', path.join(runtimeBinDir, 'npm.cmd'), path.join(runtimeBinDir, 'npx.cmd')]));
      expect(commands.map(call => call.command)).toEqual(expect.arrayContaining([
        path.join(cliToolsDir, 'claude.cmd'),
        path.join(runtimeBinDir, 'claude.cmd'),
        path.join(cliToolsDir, 'codex.cmd'),
        'claude.exe',
        'claude.cmd',
        path.join(runtimeBinDir, 'codex.cmd'),
        'codex.exe',
        'codex.cmd',
      ]));
      expect(status.checks.find(item => item.id === 'npm')).toEqual(expect.objectContaining({ status: 'ok' }));
      expect(status.checks.find(item => item.id === 'pm2')).toEqual(expect.objectContaining({ status: 'ok' }));
      expect(status.checks.find(item => item.id === 'claude-cli')?.installActions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'claude-cli:npm-install', command: [nodeExe, npmCli, '--prefix', cliToolsDir, 'i', '-g', '@anthropic-ai/claude-code@latest'] }),
      ]));
      expect(status.checks.find(item => item.id === 'codex-cli')?.installActions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'codex-cli:npm-install', command: [nodeExe, npmCli, '--prefix', cliToolsDir, 'i', '-g', '@openai/codex@latest'] }),
      ]));
    } finally {
      if (originalAppData === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = originalAppData;
      }
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
      restorePlatform();
    }
  });

  test('detects Claude and Codex after Windows private-runtime npm installs', async () => {
    const restorePlatform = mockProcessPlatform('win32');
    const root = makeRoot();
    roots.push(root);
    const runtimeBinDir = path.join(root, 'runtime', 'node-v22.22.3-win-x64');
    const cliToolsDir = path.join(root, 'cli-tools');
    const npmCli = path.join(runtimeBinDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const npxCli = path.join(runtimeBinDir, 'node_modules', 'npm', 'bin', 'npx-cli.js');
    const nodeExe = path.join(runtimeBinDir, 'node.exe');
    const claudeExe = path.join(cliToolsDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const codexJs = path.join(cliToolsDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(npmCli), { recursive: true });
    fs.writeFileSync(nodeExe, '');
    fs.writeFileSync(npmCli, '');
    fs.writeFileSync(npxCli, '');
    const installCommands: Array<{ command: string; args: string[] }> = [];
    const pathPersistCommands: Array<{ command: string; args: string[] }> = [];
    const originalPath = process.env.PATH;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    delete process.env.LOCALAPPDATA;
    try {
      const service = new InstallDoctorService({
        appRoot: root,
        dataRoot: path.join(root, 'data'),
        installStateService: makeInstallState(root, {
          nodeRuntime: {
            source: 'private',
            version: '22.22.3',
            npmVersion: '10.9.8',
            binDir: runtimeBinDir,
            runtimeDir: runtimeBinDir,
            requiredMajor: 22,
            updatedAt: '2026-05-15T00:00:00.000Z',
          },
        }),
        commandRunner: async (command, args) => {
          if (command === 'powershell.exe') {
            pathPersistCommands.push({ command, args });
            return { ok: true, stdout: 'Added Agent Cockpit CLI tools to PATH.', stderr: '' };
          }
          if (command === nodeExe && args[0] === npmCli) return { ok: true, stdout: '10.9.8', stderr: '' };
          if (command === nodeExe && args[0] === npxCli) return { ok: true, stdout: '7.0.1', stderr: '' };
          if (command === claudeExe) {
            return fs.existsSync(claudeExe)
              ? { ok: true, stdout: '1.0.0', stderr: '' }
              : { ok: false, stdout: '', stderr: '', error: 'not found' };
          }
          if (command === process.execPath && args[0] === codexJs) {
            return fs.existsSync(codexJs)
              ? { ok: true, stdout: '0.50.0', stderr: '' }
              : { ok: false, stdout: '', stderr: '', error: 'not found' };
          }
          if (command === path.join(cliToolsDir, 'claude.cmd') || command === path.join(cliToolsDir, 'codex.cmd') || command === path.join(runtimeBinDir, 'claude.cmd') || command === path.join(runtimeBinDir, 'codex.cmd') || command === 'claude.cmd' || command === 'codex.cmd' || command === 'kiro-cli') return { ok: false, stdout: '', stderr: '', error: 'not found' };
          if (command === 'schtasks.exe') return { ok: true, stdout: 'Ready', stderr: '' };
          return { ok: true, stdout: '1.0.0', stderr: '' };
        },
        installRunner: async (command, args) => {
          installCommands.push({ command, args });
          if (command === nodeExe && args[0] === npmCli && args.includes('@anthropic-ai/claude-code@latest')) {
            fs.mkdirSync(path.dirname(claudeExe), { recursive: true });
            fs.writeFileSync(claudeExe, '');
            return { ok: true, stdout: 'installed claude', stderr: '' };
          }
          if (command === nodeExe && args[0] === npmCli && args.includes('@openai/codex@latest')) {
            fs.mkdirSync(path.dirname(codexJs), { recursive: true });
            fs.writeFileSync(codexJs, '');
            return { ok: true, stdout: 'installed codex', stderr: '' };
          }
          return { ok: false, stdout: '', stderr: '', error: 'unexpected install command' };
        },
        detectHomebrew: async () => false,
        detectPandoc: async () => ({ available: true, binaryPath: 'C:\\Tools\\pandoc.exe', version: '3.1.1', checkedAt: '2026-05-15T00:00:00.000Z' }),
        detectLibreOffice: async () => ({ available: true, binaryPath: 'C:\\Tools\\soffice.exe', checkedAt: '2026-05-15T00:00:00.000Z' }),
      });

      const claudeResult = await service.runInstallAction('claude-cli:npm-install');
      const codexResult = await service.runInstallAction('codex-cli:npm-install');

      expect(claudeResult.success).toBe(true);
      expect(claudeResult.doctor?.checks.find(item => item.id === 'claude-cli')).toEqual(expect.objectContaining({ status: 'ok' }));
      expect(codexResult.success).toBe(true);
      expect(codexResult.doctor?.checks.find(item => item.id === 'codex-cli')).toEqual(expect.objectContaining({ status: 'ok' }));
      expect(installCommands).toEqual([
        { command: nodeExe, args: [npmCli, '--prefix', cliToolsDir, 'i', '-g', '@anthropic-ai/claude-code@latest'] },
        { command: nodeExe, args: [npmCli, '--prefix', cliToolsDir, 'i', '-g', '@openai/codex@latest'] },
      ]);
      expect(pathPersistCommands).toHaveLength(2);
      expect(pathPersistCommands[0]).toEqual(expect.objectContaining({
        command: 'powershell.exe',
        args: expect.arrayContaining(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', expect.stringContaining('SetEnvironmentVariable')]),
      }));
      expect(pathPersistCommands[0].args[pathPersistCommands[0].args.length - 1]).toContain(cliToolsDir);
      expect(process.env.PATH?.split(';')[0]).toBe(cliToolsDir);
      expect(codexResult.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'Repair Agent Cockpit CLI wrappers',
          success: true,
          output: expect.stringContaining('codex'),
        }),
      ]));
      expect(fs.readFileSync(path.join(cliToolsDir, 'codex.ps1'), 'utf8')).toContain(nodeExe);
      expect(fs.readFileSync(path.join(cliToolsDir, 'codex.ps1'), 'utf8')).toContain(codexJs);
      expect(fs.readFileSync(path.join(cliToolsDir, 'codex.cmd'), 'utf8')).toContain(`SET "NODE_EXE=${nodeExe}"`);
      expect(fs.readFileSync(path.join(cliToolsDir, 'claude.ps1'), 'utf8')).toContain(claudeExe);
    } finally {
      process.env.PATH = originalPath;
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
      restorePlatform();
    }
  });

  test('detects self-installed Windows Claude and Codex commands from PATH', async () => {
    const restorePlatform = mockProcessPlatform('win32');
    const root = makeRoot();
    roots.push(root);
    const userBin = path.join(root, 'user-bin');
    const appData = path.join(root, 'AppData', 'Roaming');
    const cliToolsDir = path.join(root, 'cli-tools');
    fs.mkdirSync(userBin, { recursive: true });
    fs.writeFileSync(path.join(userBin, 'claude.exe'), '');
    fs.writeFileSync(path.join(userBin, 'codex.cmd'), '');
    const originalPath = process.env.PATH;
    const originalAppData = process.env.APPDATA;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    process.env.PATH = userBin;
    process.env.APPDATA = appData;
    delete process.env.LOCALAPPDATA;
    const commands: string[] = [];
    try {
      const service = new InstallDoctorService({
        appRoot: root,
        dataRoot: path.join(root, 'data'),
        installStateService: makeInstallState(root),
        commandRunner: async (command) => {
          commands.push(command);
          if (command === 'claude.exe') return { ok: true, stdout: '1.0.0', stderr: '' };
          if (command === 'codex.cmd') return { ok: true, stdout: '0.50.0', stderr: '' };
          if ([
            path.join(cliToolsDir, 'claude.cmd'),
            path.join(appData, 'npm', 'claude.cmd'),
            'claude.cmd',
            path.join(cliToolsDir, 'codex.cmd'),
            path.join(appData, 'npm', 'codex.cmd'),
            'codex.exe',
            'kiro-cli',
          ].includes(command)) return { ok: false, stdout: '', stderr: '', error: 'not found' };
          if (command === 'schtasks.exe') return { ok: true, stdout: 'Ready', stderr: '' };
          return { ok: true, stdout: '1.0.0', stderr: '' };
        },
        detectHomebrew: async () => false,
        detectPandoc: async () => ({ available: true, binaryPath: 'C:\\Tools\\pandoc.exe', version: '3.1.1', checkedAt: '2026-05-15T00:00:00.000Z' }),
        detectLibreOffice: async () => ({ available: true, binaryPath: 'C:\\Tools\\soffice.exe', checkedAt: '2026-05-15T00:00:00.000Z' }),
      });

      const status = await service.getStatus();

      expect(commands).toEqual(expect.arrayContaining(['claude.exe', 'codex.cmd']));
      expect(status.checks.find(item => item.id === 'claude-cli')).toEqual(expect.objectContaining({ status: 'ok' }));
      expect(status.checks.find(item => item.id === 'codex-cli')).toEqual(expect.objectContaining({ status: 'ok' }));
    } finally {
      process.env.PATH = originalPath;
      if (originalAppData === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = originalAppData;
      }
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
      restorePlatform();
    }
  });

  test('detects Claude and Codex from the Windows user npm prefix', async () => {
    const restorePlatform = mockProcessPlatform('win32');
    const root = makeRoot();
    roots.push(root);
    const appData = path.join(root, 'AppData', 'Roaming');
    const userNpmDir = path.join(appData, 'npm');
    const cliToolsDir = path.join(root, 'cli-tools');
    const originalAppData = process.env.APPDATA;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    process.env.APPDATA = appData;
    delete process.env.LOCALAPPDATA;
    const commands: string[] = [];
    try {
      const service = new InstallDoctorService({
        appRoot: root,
        dataRoot: path.join(root, 'data'),
        installStateService: makeInstallState(root),
        commandRunner: async (command) => {
          commands.push(command);
          if (command === path.join(userNpmDir, 'claude.cmd')) return { ok: true, stdout: '1.0.0', stderr: '' };
          if (command === path.join(userNpmDir, 'codex.cmd')) return { ok: true, stdout: '0.50.0', stderr: '' };
          if ([path.join(cliToolsDir, 'claude.cmd'), path.join(cliToolsDir, 'codex.cmd'), 'claude.cmd', 'codex.cmd', 'kiro-cli'].includes(command)) return { ok: false, stdout: '', stderr: '', error: 'not found' };
          if (command === 'schtasks.exe') return { ok: true, stdout: 'Ready', stderr: '' };
          return { ok: true, stdout: '1.0.0', stderr: '' };
        },
        detectHomebrew: async () => false,
        detectPandoc: async () => ({ available: true, binaryPath: 'C:\\Tools\\pandoc.exe', version: '3.1.1', checkedAt: '2026-05-15T00:00:00.000Z' }),
        detectLibreOffice: async () => ({ available: true, binaryPath: 'C:\\Tools\\soffice.exe', checkedAt: '2026-05-15T00:00:00.000Z' }),
      });

      const status = await service.getStatus();

      expect(commands).toEqual(expect.arrayContaining([
        path.join(cliToolsDir, 'claude.cmd'),
        path.join(userNpmDir, 'claude.cmd'),
        path.join(cliToolsDir, 'codex.cmd'),
        path.join(userNpmDir, 'codex.cmd'),
      ]));
      expect(status.checks.find(item => item.id === 'claude-cli')).toEqual(expect.objectContaining({ status: 'ok' }));
      expect(status.checks.find(item => item.id === 'codex-cli')).toEqual(expect.objectContaining({ status: 'ok' }));
    } finally {
      if (originalAppData === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = originalAppData;
      }
      if (originalLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
      restorePlatform();
    }
  });
});
