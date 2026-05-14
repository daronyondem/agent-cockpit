import fs from 'fs';
import os from 'os';
import path from 'path';

const mockExecFileFn = jest.fn();
jest.mock('child_process', () => ({
  execFile: function () { return mockExecFileFn.apply(null, arguments); },
}));

import { CliUpdateService, isNewerVersion, parseVersion } from '../src/services/cliUpdateService';
import type { Settings } from '../src/types';

function mockExecFile(handler: (cmd: string, args: string[]) => string | Error) {
  mockExecFileFn.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
    const result = handler(cmd, args);
    if (result instanceof Error) {
      cb(result, '', result.message);
    } else {
      cb(null, result, '');
    }
  });
}

describe('CliUpdateService helpers', () => {
  test('parseVersion extracts the first semver-looking version', () => {
    expect(parseVersion('codex-cli 0.125.0')).toBe('0.125.0');
    expect(parseVersion('Claude Code 2.1.89')).toBe('2.1.89');
    expect(parseVersion('no version here')).toBeNull();
  });

  test('isNewerVersion compares numeric semver segments', () => {
    expect(isNewerVersion('0.128.0', '0.125.0')).toBe(true);
    expect(isNewerVersion('2.1.89', '2.1.89')).toBe(false);
    expect(isNewerVersion('2.1.88', '2.1.89')).toBe(false);
    expect(isNewerVersion(null, '1.0.0')).toBe(false);
  });
});

describe('CliUpdateService', () => {
  let tmpDir: string;
  let npmRoot: string;
  let codexBin: string;
  let settings: Settings;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-update-'));
    npmRoot = path.join(tmpDir, 'lib', 'node_modules');
    codexBin = path.join(npmRoot, '@openai', 'codex', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(codexBin), { recursive: true });
    fs.writeFileSync(codexBin, '#!/usr/bin/env node\n');
    settings = {
      theme: 'system',
      sendBehavior: 'enter',
      systemPrompt: '',
      defaultBackend: 'codex',
      cliProfiles: [{
        id: 'server-configured-codex',
        name: 'Codex (Server Configured)',
        vendor: 'codex',
        authMode: 'server-configured',
        createdAt: '2026-05-04T00:00:00.000Z',
        updatedAt: '2026-05-04T00:00:00.000Z',
      }],
    };
    mockExecFileFn.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('checks a global npm Codex installation and marks updates available', async () => {
    const service = new CliUpdateService(tmpDir);
    mockExecFile((cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === '--version') return 'codex-cli 0.125.0';
      if (cmd === 'which' && args[0] === 'codex') return codexBin;
      if (cmd === 'npm' && args.join(' ') === 'root -g') return npmRoot;
      if (cmd === 'npm' && args.join(' ') === 'view @openai/codex version') return '0.128.0';
      return new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    });

    const status = await service.checkNow(async () => settings);
    expect(status.items).toHaveLength(1);
    expect(status.items[0]).toMatchObject({
      vendor: 'codex',
      command: 'codex',
      installMethod: 'npm-global',
      currentVersion: '0.125.0',
      latestVersion: '0.128.0',
      updateAvailable: true,
      updateSupported: true,
      updateCommand: ['npm', 'i', '-g', '@openai/codex@latest'],
    });
  });

  test('adds Claude Code Interactive compatibility caution to the shared Claude CLI target', async () => {
    settings = {
      ...settings,
      defaultBackend: 'claude-code-interactive',
      cliProfiles: [{
        id: 'server-configured-claude-code',
        name: 'Claude Code (Server Configured)',
        vendor: 'claude-code',
        authMode: 'server-configured',
        createdAt: '2026-05-04T00:00:00.000Z',
        updatedAt: '2026-05-04T00:00:00.000Z',
      }],
    };
    const claudeBin = path.join(npmRoot, '@anthropic-ai', 'claude-code', 'bin', 'claude.js');
    fs.mkdirSync(path.dirname(claudeBin), { recursive: true });
    fs.writeFileSync(claudeBin, '#!/usr/bin/env node\n');

    const service = new CliUpdateService(tmpDir);
    mockExecFile((cmd, args) => {
      if (cmd === 'claude' && args.join(' ') === '--version') return 'Claude Code 2.1.141';
      if (cmd === 'which' && args[0] === 'claude') return claudeBin;
      if (cmd === 'npm' && args.join(' ') === 'root -g') return npmRoot;
      if (cmd === 'npm' && args.join(' ') === 'view @anthropic-ai/claude-code version') return '2.1.142';
      return new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    });

    const status = await service.checkNow(async () => settings);
    expect(status.items).toHaveLength(1);
    expect(status.items[0]).toMatchObject({
      vendor: 'claude-code',
      currentVersion: '2.1.141',
      latestVersion: '2.1.142',
      interactiveCompatibility: [expect.objectContaining({
        providerId: 'claude-code-interactive',
        testedVersion: '2.1.141',
        status: 'supported',
      })],
      blocksAutoUpdate: false,
    });
    expect(status.items[0].updateCaution).toMatch(/newer than the version tested/);
  });

  test('triggerUpdate runs the supported updater and refreshes status', async () => {
    const service = new CliUpdateService(tmpDir);
    let npmInstallCalled = false;
    let version = '0.125.0';
    mockExecFile((cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === '--version') return `codex-cli ${version}`;
      if (cmd === 'which' && args[0] === 'codex') return codexBin;
      if (cmd === 'npm' && args.join(' ') === 'root -g') return npmRoot;
      if (cmd === 'npm' && args.join(' ') === 'view @openai/codex version') return '0.128.0';
      if (cmd === 'npm' && args.join(' ') === 'i -g @openai/codex@latest') {
        npmInstallCalled = true;
        version = '0.128.0';
        return 'updated';
      }
      return new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    });

    const checked = await service.checkNow(async () => settings);
    const result = await service.triggerUpdate(checked.items[0].id, {
      loadSettings: async () => settings,
      hasActiveStreams: () => false,
    });

    expect(result.success).toBe(true);
    expect(npmInstallCalled).toBe(true);
    expect(result.item?.currentVersion).toBe('0.128.0');
    expect(result.item?.updateAvailable).toBe(false);
  });

  test('triggerUpdate blocks while streams are active', async () => {
    const service = new CliUpdateService(tmpDir);
    mockExecFile((cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === '--version') return 'codex-cli 0.125.0';
      if (cmd === 'which' && args[0] === 'codex') return codexBin;
      if (cmd === 'npm' && args.join(' ') === 'root -g') return npmRoot;
      if (cmd === 'npm' && args.join(' ') === 'view @openai/codex version') return '0.128.0';
      return new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    });
    const checked = await service.checkNow(async () => settings);

    const result = await service.triggerUpdate(checked.items[0].id, {
      loadSettings: async () => settings,
      hasActiveStreams: () => true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/actively running/);
  });
});
