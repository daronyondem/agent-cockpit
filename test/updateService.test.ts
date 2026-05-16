import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import dotenv from 'dotenv';

// ── Mock child_process.execFile ─────────────────────────────────────────────

const mockExecFileFn = jest.fn();
const mockSpawnResult = { unref: jest.fn() };
const mockSpawnFn = jest.fn(() => mockSpawnResult);
jest.mock('child_process', () => ({
  execFile: function () { return mockExecFileFn.apply(null, arguments); },
  spawn: function () { return mockSpawnFn.apply(null, arguments); },
}));

// ── Mock fs.existsSync for interpreter/pm2 checks ──────────────────────────

const originalExistsSync = fs.existsSync;
let mockExistsSyncOverrides: Record<string, boolean> = {};
jest.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
  const pStr = p.toString();
  if (pStr in mockExistsSyncOverrides) return mockExistsSyncOverrides[pStr];
  return originalExistsSync(p);
});

const originalReadFileSync = fs.readFileSync.bind(fs);
let mockReadFileSyncOverrides: Record<string, string> = {};
jest.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
  const pStr = String(args[0]);
  if (pStr in mockReadFileSyncOverrides) return mockReadFileSyncOverrides[pStr];
  return originalReadFileSync(...args);
});

const originalWriteFileSync = fs.writeFileSync.bind(fs);
function mockWriteFileSyncNoop(...args: Parameters<typeof fs.writeFileSync>) {
  // Allow writing the temp ecosystem config for CI, mock everything else
  if (String(args[0]).endsWith('ecosystem.config.js')) {
    return originalWriteFileSync(...args);
  }
}
const mockWriteFileSync = jest.spyOn(fs, 'writeFileSync').mockImplementation(mockWriteFileSyncNoop);

import { UpdateService } from '../src/services/updateService';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeWebBuildStatus(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'auto',
    buildDir: path.join(__dirname, '..', 'public', 'v2-built'),
    markerPath: path.join(__dirname, '..', 'public', 'v2-built', '.agent-cockpit-build.json'),
    fresh: true,
    skipped: false,
    didBuild: true,
    previousBuildAvailable: true,
    marker: {
      sourceHash: 'source',
      packageJsonHash: 'package-json',
      packageLockHash: 'package-lock',
      gitSha: 'abc123',
      builtAt: '2026-05-11T00:00:00.000Z',
    },
    expected: {
      sourceHash: 'source',
      packageJsonHash: 'package-json',
      packageLockHash: 'package-lock',
      gitSha: 'abc123',
    },
    output: 'web build output',
    ...overrides,
  };
}

function mockExecFile(responses: Array<{ stdout?: string; stderr?: string; error?: string }>) {
  let callIndex = 0;
  mockExecFileFn.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    const entry = responses[callIndex++];
    if (!entry) {
      cb(null, '', '');
      return;
    }
    if (entry.error) {
      cb(new Error(entry.error), '', entry.stderr || entry.error);
    } else {
      cb(null, entry.stdout || '', entry.stderr || '');
    }
  });
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  originalWriteFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeText(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  originalWriteFileSync(filePath, value);
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

function isCmdShimCall(cmd: string, args: string[], shim: string): boolean {
  return cmd === 'cmd.exe' && args.includes('/c') && String(args[args.length - 1]).includes(shim);
}

function cmdShimOutDir(cmd: string, args: string[]): string | null {
  if (cmd !== 'cmd.exe') return null;
  const match = String(args[args.length - 1]).match(/"--outDir"\s+"([^"]+)"/);
  return match?.[1] || null;
}

function makeProductionInstall(rootPrefix = 'agent-cockpit-install-') {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), rootPrefix));
  const releasesDir = path.join(installDir, 'releases');
  const previousDir = path.join(releasesDir, 'agent-cockpit-v1.0.0');
  const currentLink = path.join(installDir, 'current');
  const dataDir = path.join(installDir, 'data');

  writeJson(path.join(previousDir, 'package.json'), { version: '1.0.0' });
  writeText(path.join(previousDir, '.env'), 'PORT=4444\n');
  writeText(path.join(previousDir, 'ecosystem.config.js'), "module.exports = { apps: [{ name: 'agent-cockpit' }] };\n");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.symlinkSync(previousDir, currentLink);

  const status = {
    schemaVersion: 1 as const,
    channel: 'production' as const,
    source: 'github-release' as const,
    repo: 'daronyondem/agent-cockpit',
    version: '1.0.0',
    branch: null,
    installDir,
    appDir: currentLink,
    dataDir,
    installedAt: '2026-05-11T00:00:00.000Z',
    welcomeCompletedAt: null,
    nodeRuntime: null,
    stateSource: 'stored' as const,
    stateError: null,
  };

  return { installDir, releasesDir, previousDir, currentLink, dataDir, status };
}

function makeReleaseFixture(version = '1.1.0', minimumNodeMajor = 22) {
  const tarballName = `agent-cockpit-v${version}.tar.gz`;
  const tarballBytes = Buffer.from(`release tarball ${version}`);
  const tarballSha = crypto.createHash('sha256').update(tarballBytes).digest('hex');
  const manifest = {
    schemaVersion: 1,
    version,
    packageRoot: `agent-cockpit-v${version}`,
    requiredRuntime: {
      node: {
        engine: `>=${minimumNodeMajor}`,
        minimumMajor: minimumNodeMajor,
      },
    },
    artifacts: [
      {
        name: tarballName,
        role: 'app-tarball',
        size: tarballBytes.length,
        sha256: tarballSha,
      },
    ],
  };
  const manifestRaw = JSON.stringify(manifest);
  const manifestSha = crypto.createHash('sha256').update(manifestRaw).digest('hex');
  const checksumsRaw = `${manifestSha}  release-manifest.json\n${tarballSha}  ${tarballName}\n`;
  return { manifest, manifestRaw, manifestSha, tarballName, tarballBytes, tarballSha, checksumsRaw };
}

function makeWindowsProductionInstall(rootPrefix = 'agent-cockpit-win-install-') {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), rootPrefix));
  const releasesDir = path.join(installDir, 'releases');
  const previousDir = path.join(releasesDir, 'agent-cockpit-v1.0.0');
  const dataDir = path.join(installDir, 'data');

  writeJson(path.join(previousDir, 'package.json'), { version: '1.0.0' });
  writeText(path.join(previousDir, '.env'), 'PORT=4444\nSESSION_SECRET=old-secret\nAUTH_SETUP_TOKEN=old-token\n');
  writeText(path.join(previousDir, 'ecosystem.config.js'), "module.exports = { apps: [{ name: 'agent-cockpit' }] };\n");
  fs.mkdirSync(dataDir, { recursive: true });

  const status = {
    schemaVersion: 1 as const,
    channel: 'production' as const,
    source: 'github-release' as const,
    repo: 'daronyondem/agent-cockpit',
    version: '1.0.0',
    branch: null,
    installDir,
    appDir: previousDir,
    dataDir,
    installedAt: '2026-05-15T00:00:00.000Z',
    welcomeCompletedAt: null,
    nodeRuntime: null,
    startup: { kind: 'scheduled-task' as const, name: 'AgentCockpit', scope: 'current-user' as const },
    stateSource: 'stored' as const,
    stateError: null,
  };

  return { installDir, releasesDir, previousDir, dataDir, status };
}

function makeWindowsReleaseFixture(version = '1.1.0', minimumNodeMajor = 22) {
  const zipName = `agent-cockpit-v${version}.zip`;
  const zipBytes = Buffer.from(`release zip ${version}`);
  const zipSha = crypto.createHash('sha256').update(zipBytes).digest('hex');
  const manifest = {
    schemaVersion: 1,
    version,
    packageRoot: `agent-cockpit-v${version}`,
    requiredRuntime: {
      node: {
        engine: `>=${minimumNodeMajor}`,
        minimumMajor: minimumNodeMajor,
      },
    },
    artifacts: [
      {
        name: zipName,
        role: 'app-zip',
        platform: 'win32',
        format: 'zip',
        size: zipBytes.length,
        sha256: zipSha,
      },
    ],
  };
  const manifestRaw = JSON.stringify(manifest);
  const manifestSha = crypto.createHash('sha256').update(manifestRaw).digest('hex');
  const checksumsRaw = `${manifestSha}  release-manifest.json\n${zipSha}  ${zipName}\n`;
  return { manifest, manifestRaw, manifestSha, zipName, zipBytes, zipSha, checksumsRaw };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('UpdateService', () => {
  let service: UpdateService;
  let mockWebBuildEnsureBuilt: jest.Mock;
  let mockMobileBuildEnsureBuilt: jest.Mock;
  const appRoot = path.join(__dirname, '..');

  const interpreterPath = path.join(appRoot, 'node_modules', '.bin', 'tsx');
  const ecosystemPath = path.join(appRoot, 'ecosystem.config.js');
  const ecosystemExists = originalExistsSync(ecosystemPath);

  beforeEach(() => {
    // Ensure ecosystem.config.js exists for tests (it's gitignored, so absent in CI)
    if (!ecosystemExists) {
      fs.writeFileSync(ecosystemPath, `module.exports = { apps: [{ script: 'server.ts', interpreter: './node_modules/.bin/tsx' }] };`);
    }
    mockWebBuildEnsureBuilt = jest.fn().mockResolvedValue(makeWebBuildStatus());
    mockMobileBuildEnsureBuilt = jest.fn().mockResolvedValue(makeWebBuildStatus({
      buildDir: path.join(__dirname, '..', 'public', 'mobile'),
      markerPath: path.join(__dirname, '..', 'public', 'mobile', '.agent-cockpit-build.json'),
      output: 'mobile build output',
    }));
    service = new UpdateService(appRoot, {
      webBuildService: { ensureBuilt: mockWebBuildEnsureBuilt },
      mobileBuildService: { ensureBuilt: mockMobileBuildEnsureBuilt },
    });
    mockExecFileFn.mockReset();
    mockSpawnFn.mockClear();
    mockWriteFileSync.mockClear();
    mockWriteFileSync.mockImplementation(mockWriteFileSyncNoop);
    mockExistsSyncOverrides = {};
    mockReadFileSyncOverrides = {};
    // Default: interpreter exists
    mockExistsSyncOverrides[interpreterPath] = true;
  });

  afterEach(() => {
    service.stop();
    if (!ecosystemExists && originalExistsSync(ecosystemPath)) {
      fs.unlinkSync(ecosystemPath);
    }
  });

  // ── _isNewer ────────────────────────────────────────────────────────────

  describe('_isNewer', () => {
    test('returns false when versions are equal', () => {
      expect((service as any)._isNewer('0.1.5', '0.1.5')).toBe(false);
    });

    test('returns true when remote is newer (patch)', () => {
      expect((service as any)._isNewer('0.1.6', '0.1.5')).toBe(true);
    });

    test('returns true when remote is newer (minor)', () => {
      expect((service as any)._isNewer('0.2.0', '0.1.9')).toBe(true);
    });

    test('returns true when remote is newer (major)', () => {
      expect((service as any)._isNewer('1.0.0', '0.9.9')).toBe(true);
    });

    test('returns false when remote is older', () => {
      expect((service as any)._isNewer('0.1.4', '0.1.5')).toBe(false);
    });

    test('returns false when remote is null', () => {
      expect((service as any)._isNewer(null, '0.1.5')).toBe(false);
    });

    test('returns false when local is null', () => {
      expect((service as any)._isNewer('0.1.5', null)).toBe(false);
    });

    test('handles different segment counts', () => {
      expect((service as any)._isNewer('0.1.5.1', '0.1.5')).toBe(true);
      expect((service as any)._isNewer('0.1.5', '0.1.5.1')).toBe(false);
    });
  });

  describe('Windows command shims', () => {
    test('runs .cmd files through cmd.exe for execFile compatibility', async () => {
      const restorePlatform = mockProcessPlatform('win32');
      try {
        mockExecFileFn.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
          expect(cmd).toBe('cmd.exe');
          expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
          expect(args[3]).toMatch(/^""C:\\Program Files\\node\\npm[.]cmd"/);
          expect(args[3]).toMatch(/"ci"?"$/);
          expect(args[3]).toContain('"C:\\Program Files\\node\\npm.cmd"');
          expect(args[3]).toContain('"mobile/AgentCockpitPWA"');
          cb(null, 'ok\n', '');
        });

        await expect((service as any)._exec('C:\\Program Files\\node\\npm.cmd', ['--prefix', 'mobile/AgentCockpitPWA', 'ci'])).resolves.toBe('ok\n');
      } finally {
        restorePlatform();
      }
    });
  });

  // ── getStatus ──────────────────────────────────────────────────────────

  describe('getStatus', () => {
    test('returns initial state', () => {
      const status = service.getStatus();
      expect(status.localVersion).toBe(require('../package.json').version);
      expect(status.remoteVersion).toBeNull();
      expect(status.updateAvailable).toBe(false);
      expect(status.lastCheckAt).toBeNull();
      expect(status.lastError).toBeNull();
      expect(status.updateInProgress).toBe(false);
    });

    test('returns updateAvailable true when remote is newer', () => {
      (service as any)._latestRemoteVersion = '99.0.0';
      const status = service.getStatus();
      expect(status.updateAvailable).toBe(true);
      expect(status.remoteVersion).toBe('99.0.0');
    });

    test('includes install channel metadata when available', () => {
      service = new UpdateService(appRoot, {
        webBuildService: { ensureBuilt: mockWebBuildEnsureBuilt },
        mobileBuildService: { ensureBuilt: mockMobileBuildEnsureBuilt },
        installStateService: {
          getStatus: () => ({
            schemaVersion: 1,
            channel: 'production',
            source: 'github-release',
            repo: 'daronyondem/agent-cockpit',
            version: '1.0.0',
            branch: null,
            installDir: appRoot,
            appDir: appRoot,
            dataDir: path.join(appRoot, 'data'),
            installedAt: null,
            welcomeCompletedAt: null,
            nodeRuntime: null,
            stateSource: 'stored',
            stateError: null,
          }),
        },
      });

      const status = service.getStatus();

      expect(status.installChannel).toBe('production');
      expect(status.installSource).toBe('github-release');
      expect(status.installStateSource).toBe('stored');
    });
  });

  // ── start / stop ──────────────────────────────────────────────────────

  describe('start / stop', () => {
    test('starts and stops the polling interval', () => {
      mockExecFile([
        { stdout: '' },
        { stdout: JSON.stringify({ version: '0.1.5' }) },
      ]);

      service.start();
      expect((service as any)._checkInterval).not.toBeNull();

      service.stop();
      expect((service as any)._checkInterval).toBeNull();
    });
  });

  // ── _checkRemoteVersion ────────────────────────────────────────────────

  describe('_checkRemoteVersion', () => {
    test('updates remote version on success', async () => {
      mockExecFile([
        { stdout: '' },
        { stdout: JSON.stringify({ version: '0.2.0' }) },
      ]);

      await (service as any)._checkRemoteVersion();
      expect((service as any)._latestRemoteVersion).toBe('0.2.0');
      expect((service as any)._lastCheckAt).not.toBeNull();
      expect((service as any)._lastError).toBeNull();
    });

    test('sets lastError on failure', async () => {
      mockExecFile([
        { error: 'fatal: could not fetch' },
      ]);

      await (service as any)._checkRemoteVersion();
      expect((service as any)._lastError).toBe('fatal: could not fetch');
      expect((service as any)._latestRemoteVersion).toBeNull();
    });

    test('uses the GitHub Release manifest for production installs', async () => {
      const install = makeProductionInstall('agent-cockpit-version-check-');
      const release = makeReleaseFixture('1.2.0');
      try {
        service = new UpdateService(install.currentLink, {
          webBuildService: { ensureBuilt: mockWebBuildEnsureBuilt },
          mobileBuildService: { ensureBuilt: mockMobileBuildEnsureBuilt },
          dataRoot: install.dataDir,
          installStateService: {
            getStatus: () => install.status,
          },
        });
        mockExecFileFn.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
          expect(cmd).toBe('curl');
          expect(args).toEqual([
            '-fsSL',
            'https://github.com/daronyondem/agent-cockpit/releases/latest/download/release-manifest.json',
          ]);
          cb(null, release.manifestRaw, '');
        });

        const status = await service.checkNow();

        expect(status.remoteVersion).toBe('1.2.0');
        expect(status.installChannel).toBe('production');
        expect(mockExecFileFn).toHaveBeenCalledTimes(1);
        expect(mockExecFileFn.mock.calls[0][0]).toBe('curl');
      } finally {
        fs.rmSync(install.installDir, { recursive: true, force: true });
      }
    });
  });

  // ── checkNow ───────────────────────────────────────────────────────────

  describe('checkNow', () => {
    test('triggers a version check and returns status', async () => {
      mockExecFile([
        { stdout: '' },
        { stdout: JSON.stringify({ version: '99.0.0' }) },
      ]);

      const status = await service.checkNow();
      expect(status.remoteVersion).toBe('99.0.0');
      expect(status.lastCheckAt).not.toBeNull();
      expect(status.updateAvailable).toBe(true);
    });

    test('returns status with error when check fails', async () => {
      mockExecFile([
        { error: 'network error' },
      ]);

      const status = await service.checkNow();
      expect(status.lastError).toBe('network error');
      expect(status.remoteVersion).toBeNull();
      expect(status.updateAvailable).toBe(false);
    });
  });

  // ── triggerUpdate guards ──────────────────────────────────────────────

  describe('triggerUpdate', () => {
    test('blocks when update is already in progress', async () => {
      (service as any)._updateInProgress = true;
      const result = await service.triggerUpdate();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already in progress/);
    });

    test('blocks when active streams exist', async () => {
      const result = await service.triggerUpdate({
        hasActiveStreams: () => true,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/actively running/);
    });

    test('blocks when working tree is dirty', async () => {
      mockExecFile([
        { stdout: ' M server.js\n' },
      ]);

      const result = await service.triggerUpdate({
        hasActiveStreams: () => false,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Uncommitted local changes/);
    });

    test('ignores expected untracked files in git status', async () => {
      mockExecFile([
        { stdout: '?? data/sessions/abc.json\n?? .env\n?? ecosystem.config.js\n?? .DS_Store\n?? .claude/something\n' },
        { stdout: 'Already on \'main\'\n' },
        { stdout: 'Already up to date.\n' },
        { stdout: 'up to date\n' },
      ]);

      const result = await service.triggerUpdate({
        hasActiveStreams: () => false,
      });
      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(8);
      expect(result.steps[3].name).toBe('npm --prefix mobile/AgentCockpitPWA install');
      expect(result.steps[4].name).toBe('npm run web:build');
      expect(result.steps[5].name).toBe('npm run mobile:build');
      expect(mockSpawnFn).toHaveBeenCalled();
    });

    test('executes all steps on success', async () => {
      mockExecFile([
        { stdout: '' },                          // git status
        { stdout: 'Already on \'main\'\n' },     // git checkout
        { stdout: 'Updating abc..def\n' },        // git pull
        { stdout: 'added 0 packages\n' },         // npm install
      ]);

      const result = await service.triggerUpdate({
        hasActiveStreams: () => false,
      });
      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(8);
      expect(result.steps[0].name).toBe('git checkout main');
      expect(result.steps[1].name).toBe('git pull origin main');
      expect(result.steps[2].name).toBe('npm install');
      expect(result.steps[3].name).toBe('npm --prefix mobile/AgentCockpitPWA install');
      expect(result.steps[4].name).toBe('npm run web:build');
      expect(result.steps[5].name).toBe('npm run mobile:build');
      expect(result.steps[6].name).toBe('verify interpreter');
      expect(result.steps[7].name).toBe('pm2 restart');
      result.steps.forEach(s => expect(s.success).toBe(true));
      expect(mockWebBuildEnsureBuilt).toHaveBeenCalledWith({ force: true });
      expect(mockMobileBuildEnsureBuilt).toHaveBeenCalledWith({ force: true });
      expect(mockWriteFileSync).toHaveBeenCalled();
      expect(mockSpawnFn).toHaveBeenCalledWith('sh', expect.arrayContaining(['-c']), expect.objectContaining({ stdio: 'ignore' }));
    });

    test('fails when the V2 web build fails and does not restart', async () => {
      mockWebBuildEnsureBuilt.mockResolvedValueOnce(makeWebBuildStatus({
        didBuild: false,
        fresh: false,
        error: 'vite build failed',
      }));
      mockExecFile([
        { stdout: '' },                   // git status
        { stdout: 'ok' },                 // git checkout
        { stdout: 'ok' },                 // git pull
        { stdout: 'ok' },                 // npm install
      ]);

      const result = await service.triggerUpdate({ hasActiveStreams: () => false });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Failed to build V2 web app/);
      expect(result.steps).toHaveLength(5);
      expect(result.steps[4]).toEqual({
        name: 'npm run web:build',
        success: false,
        output: 'vite build failed',
      });
      expect(mockSpawnFn).not.toHaveBeenCalled();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    test('fails when mobile dependency install fails and does not restart', async () => {
      mockExecFile([
        { stdout: '' },
        { stdout: 'ok' },
        { stdout: 'ok' },
        { stdout: 'ok' },
        { error: 'mobile install failed' },
      ]);

      const result = await service.triggerUpdate({ hasActiveStreams: () => false });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Failed to install mobile dependencies/);
      expect(result.steps).toHaveLength(4);
      expect(result.steps[3]).toEqual({
        name: 'npm --prefix mobile/AgentCockpitPWA install',
        success: false,
        output: 'mobile install failed',
      });
      expect(mockWebBuildEnsureBuilt).not.toHaveBeenCalled();
      expect(mockMobileBuildEnsureBuilt).not.toHaveBeenCalled();
      expect(mockSpawnFn).not.toHaveBeenCalled();
    });

    test('fails when the mobile PWA build fails and does not restart', async () => {
      mockMobileBuildEnsureBuilt.mockResolvedValueOnce(makeWebBuildStatus({
        didBuild: false,
        fresh: false,
        error: 'mobile build failed',
      }));
      mockExecFile([
        { stdout: '' },
        { stdout: 'ok' },
        { stdout: 'ok' },
        { stdout: 'ok' },
        { stdout: 'ok' },
      ]);

      const result = await service.triggerUpdate({ hasActiveStreams: () => false });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Failed to build mobile PWA/);
      expect(result.steps).toHaveLength(6);
      expect(result.steps[5]).toEqual({
        name: 'npm run mobile:build',
        success: false,
        output: 'mobile build failed',
      });
      expect(mockSpawnFn).not.toHaveBeenCalled();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    test('stops at first failed step and reports error', async () => {
      mockExecFile([
        { stdout: '' },
        { stdout: 'Switched to branch \'main\'\n' },
        { error: 'fatal: could not connect to remote' },
      ]);

      const result = await service.triggerUpdate({
        hasActiveStreams: () => false,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Failed to pull/);
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].success).toBe(true);
      expect(result.steps[1].success).toBe(false);
    });

    test('resets updateInProgress flag after failure', async () => {
      mockExecFile([
        { stdout: '' },
        { error: 'checkout failed' },
      ]);

      await service.triggerUpdate({ hasActiveStreams: () => false });
      expect((service as any)._updateInProgress).toBe(false);
    });

    test('resets updateInProgress flag after success', async () => {
      mockExecFile([
        { stdout: '' },
        { stdout: 'ok' },
        { stdout: 'ok' },
        { stdout: 'ok' },
      ]);

      await service.triggerUpdate({ hasActiveStreams: () => false });
      expect((service as any)._updateInProgress).toBe(false);
    });

    test('fails when interpreter is missing after npm install', async () => {
      mockExistsSyncOverrides[interpreterPath] = false;
      mockExecFile([
        { stdout: '' },
        { stdout: 'ok' },
        { stdout: 'ok' },
        { stdout: 'ok' },
      ]);

      const result = await service.triggerUpdate({ hasActiveStreams: () => false });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Interpreter not found/);
      expect(result.steps.find(s => s.name === 'verify interpreter')?.success).toBe(false);
      expect(mockSpawnFn).not.toHaveBeenCalled();
    });

    test('succeeds when interpreter is a bare command found on PATH', async () => {
      // Override readFileSync to return a config with a bare command interpreter
      mockReadFileSyncOverrides[ecosystemPath] = `module.exports = { apps: [{ script: 'server.ts', interpreter: 'node' }] };`;

      mockExecFile([
        { stdout: '' },                          // git status
        { stdout: 'ok' },                        // git checkout
        { stdout: 'ok' },                        // git pull
        { stdout: 'ok' },                        // npm install
        { stdout: 'ok' },                        // mobile npm install
        { stdout: '/usr/local/bin/node\n' },     // which node
      ]);

      const result = await service.triggerUpdate({ hasActiveStreams: () => false });
      expect(result.success).toBe(true);
      const verifyStep = result.steps.find(s => s.name === 'verify interpreter');
      expect(verifyStep?.success).toBe(true);
      expect(verifyStep?.output).toMatch(/Found on PATH/);
    });

    test('fails when bare command interpreter is not found on PATH', async () => {
      // Override readFileSync to return a config with a bare command that won't be found
      mockReadFileSyncOverrides[ecosystemPath] = `module.exports = { apps: [{ script: 'server.ts', interpreter: 'nonexistent-cmd' }] };`;

      mockExecFile([
        { stdout: '' },                          // git status
        { stdout: 'ok' },                        // git checkout
        { stdout: 'ok' },                        // git pull
        { stdout: 'ok' },                        // npm install
        { stdout: 'ok' },                        // mobile npm install
        { error: 'not found' },                  // which nonexistent-cmd
      ]);

      const result = await service.triggerUpdate({ hasActiveStreams: () => false });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found on PATH/);
      expect(result.steps.find(s => s.name === 'verify interpreter')?.success).toBe(false);
      expect(mockSpawnFn).not.toHaveBeenCalled();
    });

    test('writes restart script with PATH and pm2 commands', async () => {
      mockExecFile([
        { stdout: '' },
        { stdout: 'ok' },
        { stdout: 'ok' },
        { stdout: 'ok' },
      ]);

      await service.triggerUpdate({ hasActiveStreams: () => false });
      const writeCall = mockWriteFileSync.mock.calls.find(
        (c) => String(c[0]).includes('restart.sh')
      );
      expect(writeCall).toBeDefined();
      const script = String(writeCall![1]);
      expect(script).toContain('node_modules/.bin');
      expect(script).toMatch(/export PATH=.*node_modules\/\.bin/);
      expect(script).toContain('pm2 delete');
      expect(script).toContain('pm2 start');
      expect(script).toContain('sleep 2');
    });

    test('launches restart script via double-fork with nohup', async () => {
      mockExecFile([
        { stdout: '' },
        { stdout: 'ok' },
        { stdout: 'ok' },
        { stdout: 'ok' },
      ]);

      await service.triggerUpdate({ hasActiveStreams: () => false });
      const spawnArgs = mockSpawnFn.mock.calls[0] as unknown[];
      const shellCmd = (spawnArgs[1] as string[])[1];
      expect(shellCmd).toContain('nohup');
      expect(shellCmd).toContain('restart.sh');
      expect(shellCmd).toContain('update-restart.log');
    });

    test('applies a production GitHub Release update and writes rollback restart script', async () => {
      mockWriteFileSync.mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => originalWriteFileSync(...args));
      const install = makeProductionInstall('agent-cockpit-prod-update-');
      const release = makeReleaseFixture('1.1.0');
      const writeState = jest.fn(async (state) => ({ ...install.status, ...state }));
      try {
        service = new UpdateService(install.currentLink, {
          webBuildService: { ensureBuilt: mockWebBuildEnsureBuilt },
          mobileBuildService: { ensureBuilt: mockMobileBuildEnsureBuilt },
          dataRoot: install.dataDir,
          installStateService: {
            getStatus: () => install.status,
            writeState,
          },
        });
        mockExecFileFn.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
          if (cmd === 'curl' && args[1].endsWith('/release-manifest.json')) {
            cb(null, release.manifestRaw, '');
            return;
          }
          if (cmd === 'curl' && args[1].endsWith('/SHA256SUMS')) {
            cb(null, release.checksumsRaw, '');
            return;
          }
          if (cmd === 'curl' && args[1].endsWith(`/${release.tarballName}`)) {
            cb(null, release.tarballBytes, Buffer.alloc(0));
            return;
          }
          if (cmd === 'tar') {
            const extractDir = String(args[args.indexOf('-C') + 1]);
            const packageDir = path.join(extractDir, release.manifest.packageRoot);
            writeText(path.join(packageDir, 'server.ts'), 'console.log("server");\n');
            writeJson(path.join(packageDir, 'package.json'), { version: '1.1.0' });
            writeText(path.join(packageDir, 'public/v2-built/index.html'), '<!doctype html>\n');
            writeText(path.join(packageDir, 'public/mobile-built/index.html'), '<!doctype html>\n');
            cb(null, 'extracted\n', '');
            return;
          }
          if (cmd === 'git' && args[0] === 'rev-parse') {
            cb(null, 'abc123\n', '');
            return;
          }
          if (cmd === 'npm') {
            const outDirIndex = args.indexOf('--outDir');
            if (outDirIndex >= 0) {
              writeText(path.join(String(args[outDirIndex + 1]), 'index.html'), '<!doctype html>\n');
              cb(null, 'built\n', '');
              return;
            }
            cb(null, 'ok\n', '');
            return;
          }
          cb(new Error(`unexpected command ${cmd}`), '', '');
        });

        const result = await service.triggerUpdate({ hasActiveStreams: () => false });

        expect(result.success).toBe(true);
        expect(result.steps.map(step => step.name)).toEqual([
          'download release manifest',
          'download release tarball',
          'extract release',
          'verify Node.js runtime',
          'npm ci',
          'npm --prefix mobile/AgentCockpitPWA ci',
          'npm run web:build',
          'npm run mobile:build',
          'verify release assets',
          'copy runtime config',
          'switch current release',
          'write install manifest',
          'pm2 restart',
        ]);
        expect(writeState).toHaveBeenCalledWith(expect.objectContaining({
          channel: 'production',
          source: 'github-release',
          version: '1.1.0',
          appDir: install.currentLink,
          dataDir: install.dataDir,
          nodeRuntime: expect.objectContaining({
            source: expect.any(String),
            requiredMajor: 22,
          }),
        }));
        expect(fs.realpathSync(install.currentLink)).toBe(fs.realpathSync(path.join(install.releasesDir, 'agent-cockpit-v1.1.0')));
        expect(originalExistsSync(path.join(fs.realpathSync(install.currentLink), '.env'))).toBe(true);
        expect(originalExistsSync(path.join(fs.realpathSync(install.currentLink), 'ecosystem.config.js'))).toBe(true);
        expect(mockWebBuildEnsureBuilt).not.toHaveBeenCalled();
        expect(mockMobileBuildEnsureBuilt).not.toHaveBeenCalled();

        const restartPath = path.join(install.dataDir, 'restart.sh');
        const restartScript = originalReadFileSync(restartPath, 'utf8');
        expect(restartScript).toContain('http://127.0.0.1:4444/api/chat/version');
        expect(restartScript).toContain(`ln -s "${fs.realpathSync(install.previousDir)}" "${install.currentLink}"`);
        expect(restartScript).toContain('curl -fsS');
        expect(mockSpawnFn).toHaveBeenCalledWith('sh', expect.arrayContaining(['-c']), expect.objectContaining({
          cwd: install.currentLink,
          stdio: 'ignore',
        }));
      } finally {
        fs.rmSync(install.installDir, { recursive: true, force: true });
      }
    });

    test('updates a private Node.js runtime before production dependency install when required major increases', async () => {
      mockWriteFileSync.mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => originalWriteFileSync(...args));
      const restorePlatform = mockProcessPlatform('darwin');
      const install = makeProductionInstall('agent-cockpit-prod-node-update-');
      const nodeArch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const nodeVersion = '23.9.0';
      (install.status as any).nodeRuntime = {
        source: 'private',
        version: '22.22.3',
        npmVersion: '10.9.8',
        binDir: path.join(install.installDir, 'runtime', 'node', 'bin'),
        runtimeDir: path.join(install.installDir, 'runtime', 'node'),
        requiredMajor: 22,
        updatedAt: '2026-05-11T00:00:00.000Z',
      };
      const release = makeReleaseFixture('1.1.0', 23);
      const nodeTarballName = `node-v${nodeVersion}-darwin-${nodeArch}.tar.gz`;
      const nodeTarballBytes = Buffer.from('node runtime tarball');
      const nodeTarballSha = crypto.createHash('sha256').update(nodeTarballBytes).digest('hex');
      const nodeChecksums = `${nodeTarballSha}  ${nodeTarballName}\n`;
      const writeState = jest.fn(async (state) => ({ ...install.status, ...state }));
      try {
        service = new UpdateService(install.currentLink, {
          webBuildService: { ensureBuilt: mockWebBuildEnsureBuilt },
          mobileBuildService: { ensureBuilt: mockMobileBuildEnsureBuilt },
          dataRoot: install.dataDir,
          installStateService: {
            getStatus: () => install.status,
            writeState,
          },
        });
        mockExecFileFn.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
          const url = typeof args[1] === 'string' ? args[1] : '';
          if (cmd === 'curl' && url.endsWith('/release-manifest.json')) {
            cb(null, release.manifestRaw, '');
            return;
          }
          if (cmd === 'curl' && url.endsWith('/SHA256SUMS')) {
            cb(null, release.checksumsRaw, '');
            return;
          }
          if (cmd === 'curl' && url.endsWith(`/${release.tarballName}`)) {
            cb(null, release.tarballBytes, Buffer.alloc(0));
            return;
          }
          if (cmd === 'curl' && url.endsWith('/SHASUMS256.txt')) {
            cb(null, nodeChecksums, '');
            return;
          }
          if (cmd === 'curl' && url.endsWith(`/${nodeTarballName}`)) {
            cb(null, nodeTarballBytes, Buffer.alloc(0));
            return;
          }
          if (cmd === 'tar') {
            const extractDir = String(args[args.indexOf('-C') + 1]);
            if (extractDir.includes('.node-extract-')) {
              writeText(path.join(extractDir, `node-v${nodeVersion}-darwin-${nodeArch}`, 'bin/node'), 'node\n');
              writeText(path.join(extractDir, `node-v${nodeVersion}-darwin-${nodeArch}`, 'bin/npm'), 'npm\n');
              cb(null, 'node extracted\n', '');
              return;
            }
            const packageDir = path.join(extractDir, release.manifest.packageRoot);
            writeText(path.join(packageDir, 'server.ts'), 'console.log("server");\n');
            writeJson(path.join(packageDir, 'package.json'), { version: '1.1.0', engines: { node: '>=23' } });
            writeText(path.join(packageDir, 'public/v2-built/index.html'), '<!doctype html>\n');
            writeText(path.join(packageDir, 'public/mobile-built/index.html'), '<!doctype html>\n');
            cb(null, 'extracted\n', '');
            return;
          }
          if (cmd === 'git' && args[0] === 'rev-parse') {
            cb(null, 'abc123\n', '');
            return;
          }
          if (cmd === 'npm') {
            const outDirIndex = args.indexOf('--outDir');
            if (outDirIndex >= 0) {
              writeText(path.join(String(args[outDirIndex + 1]), 'index.html'), '<!doctype html>\n');
              cb(null, 'built\n', '');
              return;
            }
            cb(null, 'ok\n', '');
            return;
          }
          cb(new Error(`unexpected command ${cmd}`), '', '');
        });

        const result = await service.triggerUpdate({ hasActiveStreams: () => false });

        expect(result.success).toBe(true);
        expect(result.steps.map(step => step.name)).toEqual(expect.arrayContaining([
          'install Node.js runtime',
          'npm ci',
        ]));
        expect(result.steps.find(step => step.name === 'install Node.js runtime')?.output)
          .toContain(`v${nodeVersion}`);
        expect(writeState).toHaveBeenCalledWith(expect.objectContaining({
          nodeRuntime: expect.objectContaining({
            source: 'private',
            version: nodeVersion,
            requiredMajor: 23,
            binDir: path.join(install.installDir, 'runtime', 'node', 'bin'),
          }),
        }));
        expect(fs.realpathSync(path.join(install.installDir, 'runtime', 'node')))
          .toBe(fs.realpathSync(path.join(install.installDir, 'runtime', `node-v${nodeVersion}`)));
      } finally {
        restorePlatform();
        fs.rmSync(install.installDir, { recursive: true, force: true });
      }
    });

    test('migrates a system Node production install to a private runtime when required major increases', async () => {
      mockWriteFileSync.mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => originalWriteFileSync(...args));
      const restorePlatform = mockProcessPlatform('darwin');
      const install = makeProductionInstall('agent-cockpit-prod-node-system-');
      const nodeArch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const nodeVersion = '99.1.0';
      const release = makeReleaseFixture('1.1.0', 99);
      const nodeTarballName = `node-v${nodeVersion}-darwin-${nodeArch}.tar.gz`;
      const nodeTarballBytes = Buffer.from('node runtime tarball');
      const nodeTarballSha = crypto.createHash('sha256').update(nodeTarballBytes).digest('hex');
      const nodeChecksums = `${nodeTarballSha}  ${nodeTarballName}\n`;
      const writeState = jest.fn(async (state) => ({ ...install.status, ...state }));
      try {
        service = new UpdateService(install.currentLink, {
          webBuildService: { ensureBuilt: mockWebBuildEnsureBuilt },
          mobileBuildService: { ensureBuilt: mockMobileBuildEnsureBuilt },
          dataRoot: install.dataDir,
          installStateService: {
            getStatus: () => install.status,
            writeState,
          },
        });
        mockExecFileFn.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
          if (cmd === 'curl' && args[1].endsWith('/release-manifest.json')) {
            cb(null, release.manifestRaw, '');
            return;
          }
          if (cmd === 'curl' && args[1].endsWith('/SHA256SUMS')) {
            cb(null, release.checksumsRaw, '');
            return;
          }
          if (cmd === 'curl' && args[1].endsWith(`/${release.tarballName}`)) {
            cb(null, release.tarballBytes, Buffer.alloc(0));
            return;
          }
          if (cmd === 'curl' && args[1].endsWith('/SHASUMS256.txt')) {
            cb(null, nodeChecksums, '');
            return;
          }
          if (cmd === 'curl' && args[1].endsWith(`/${nodeTarballName}`)) {
            cb(null, nodeTarballBytes, Buffer.alloc(0));
            return;
          }
          if (cmd === 'tar') {
            const extractDir = String(args[args.indexOf('-C') + 1]);
            if (extractDir.includes('.node-extract-')) {
              writeText(path.join(extractDir, `node-v${nodeVersion}-darwin-${nodeArch}`, 'bin/node'), 'node\n');
              writeText(path.join(extractDir, `node-v${nodeVersion}-darwin-${nodeArch}`, 'lib/node_modules/npm/bin/npm-cli.js'), 'npm cli\n');
              cb(null, 'node extracted\n', '');
              return;
            }
            const packageDir = path.join(extractDir, release.manifest.packageRoot);
            writeText(path.join(packageDir, 'server.ts'), 'console.log("server");\n');
            writeJson(path.join(packageDir, 'package.json'), { version: '1.1.0', engines: { node: '>=99' } });
            writeText(path.join(packageDir, 'public/v2-built/index.html'), '<!doctype html>\n');
            writeText(path.join(packageDir, 'public/mobile-built/index.html'), '<!doctype html>\n');
            cb(null, 'extracted\n', '');
            return;
          }
          if (String(cmd).endsWith('/bin/node')) {
            cb(null, '12.9.0\n', '');
            return;
          }
          if (cmd === 'git' && args[0] === 'rev-parse') {
            cb(null, 'abc123\n', '');
            return;
          }
          if (cmd === 'npm') {
            const outDirIndex = args.indexOf('--outDir');
            if (outDirIndex >= 0) {
              writeText(path.join(String(args[outDirIndex + 1]), 'index.html'), '<!doctype html>\n');
              cb(null, 'built\n', '');
              return;
            }
            cb(null, 'ok\n', '');
            return;
          }
          cb(new Error(`unexpected command ${cmd}`), '', '');
        });

        const result = await service.triggerUpdate({ hasActiveStreams: () => false });

        expect(result.success).toBe(true);
        expect(result.steps.find(step => step.name === 'verify Node.js runtime')).toEqual(expect.objectContaining({
          success: false,
        }));
        expect(result.steps.find(step => step.name === 'install Node.js runtime')?.output)
          .toContain(`v${nodeVersion}`);
        expect(writeState).toHaveBeenCalledWith(expect.objectContaining({
          nodeRuntime: expect.objectContaining({
            source: 'private',
            version: nodeVersion,
            npmVersion: '12.9.0',
            requiredMajor: 99,
          }),
        }));
        expect(mockExecFileFn.mock.calls.some(call => call[0] === 'npm')).toBe(true);
        expect(fs.realpathSync(install.currentLink)).toBe(fs.realpathSync(path.join(install.releasesDir, 'agent-cockpit-v1.1.0')));
        const finalEnv = originalReadFileSync(path.join(fs.realpathSync(install.currentLink), '.env'), 'utf8');
        const finalEcosystem = originalReadFileSync(path.join(fs.realpathSync(install.currentLink), 'ecosystem.config.js'), 'utf8');
        expect(finalEnv).toContain('PATH=`' + path.join(install.installDir, 'runtime', 'node', 'bin'));
        expect(finalEcosystem).toContain(`"PATH": "${path.join(install.installDir, 'runtime', 'node', 'bin')}`);
      } finally {
        restorePlatform();
        fs.rmSync(install.installDir, { recursive: true, force: true });
      }
    });

    test('rejects a production release with a checksum mismatch without switching current', async () => {
      mockWriteFileSync.mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => originalWriteFileSync(...args));
      const install = makeProductionInstall('agent-cockpit-prod-bad-sha-');
      const release = makeReleaseFixture('1.1.0');
      const badChecksums = `${release.manifestSha}  release-manifest.json\n${'0'.repeat(64)}  ${release.tarballName}\n`;
      const writeState = jest.fn(async (state) => ({ ...install.status, ...state }));
      try {
        service = new UpdateService(install.currentLink, {
          webBuildService: { ensureBuilt: mockWebBuildEnsureBuilt },
          mobileBuildService: { ensureBuilt: mockMobileBuildEnsureBuilt },
          dataRoot: install.dataDir,
          installStateService: {
            getStatus: () => install.status,
            writeState,
          },
        });
        mockExecFileFn.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
          if (cmd === 'curl' && args[1].endsWith('/release-manifest.json')) {
            cb(null, release.manifestRaw, '');
            return;
          }
          if (cmd === 'curl' && args[1].endsWith('/SHA256SUMS')) {
            cb(null, badChecksums, '');
            return;
          }
          if (cmd === 'curl' && args[1].endsWith(`/${release.tarballName}`)) {
            cb(null, release.tarballBytes, Buffer.alloc(0));
            return;
          }
          cb(new Error(`unexpected command ${cmd}`), '', '');
        });

        const result = await service.triggerUpdate({ hasActiveStreams: () => false });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Checksum mismatch/);
        expect(fs.realpathSync(install.currentLink)).toBe(fs.realpathSync(install.previousDir));
        expect(writeState).not.toHaveBeenCalled();
        expect(mockSpawnFn).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(install.installDir, { recursive: true, force: true });
      }
    });

    test('applies a Windows production update with ZIP activation and PowerShell rollback script', async () => {
      mockWriteFileSync.mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => originalWriteFileSync(...args));
      const restorePlatform = mockProcessPlatform('win32');
      const install = makeWindowsProductionInstall();
      const release = makeWindowsReleaseFixture('1.1.0');
      const writeState = jest.fn(async (state) => ({ ...install.status, ...state }));
      try {
        service = new UpdateService(install.previousDir, {
          webBuildService: { ensureBuilt: mockWebBuildEnsureBuilt },
          mobileBuildService: { ensureBuilt: mockMobileBuildEnsureBuilt },
          dataRoot: install.dataDir,
          installStateService: {
            getStatus: () => install.status,
            writeState,
          },
        });
        jest.spyOn(service as any, '_downloadToFile').mockImplementation(async (...args: unknown[]) => {
          const [url, dest] = args as [string, string];
          if (url.endsWith('/release-manifest.json')) {
            writeText(dest, release.manifestRaw);
            return;
          }
          if (url.endsWith('/SHA256SUMS')) {
            writeText(dest, release.checksumsRaw);
            return;
          }
          if (url.endsWith(`/${release.zipName}`)) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            originalWriteFileSync(dest, release.zipBytes);
            return;
          }
          throw new Error(`unexpected download ${url}`);
        });
        mockExecFileFn.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
          if (cmd === 'powershell.exe' && String(args).includes('Expand-Archive')) {
            const command = String(args[args.length - 1]);
            const match = command.match(/-DestinationPath '([^']+)'/);
            const extractDir = match ? match[1] : '';
            const packageDir = path.join(extractDir, release.manifest.packageRoot);
            writeText(path.join(packageDir, 'server.ts'), 'console.log("server");\n');
            writeJson(path.join(packageDir, 'package.json'), { version: '1.1.0' });
            writeText(path.join(packageDir, 'public/v2-built/index.html'), '<!doctype html>\n');
            writeText(path.join(packageDir, 'public/mobile-built/index.html'), '<!doctype html>\n');
            cb(null, 'expanded\n', '');
            return;
          }
          if (cmd === 'git' && args[0] === 'rev-parse') {
            cb(null, 'abc123\n', '');
            return;
          }
          if (cmd === 'npm' || isCmdShimCall(cmd, args, 'npm.cmd')) {
            const outDirIndex = args.indexOf('--outDir');
            if (outDirIndex >= 0) {
              writeText(path.join(String(args[outDirIndex + 1]), 'index.html'), '<!doctype html>\n');
              cb(null, 'built\n', '');
              return;
            }
            const outDir = cmdShimOutDir(cmd, args);
            if (outDir) {
              writeText(path.join(outDir, 'index.html'), '<!doctype html>\n');
              cb(null, 'built\n', '');
              return;
            }
            cb(null, 'ok\n', '');
            return;
          }
          cb(new Error(`unexpected command ${cmd}`), '', '');
        });

        const result = await service.triggerUpdate({ hasActiveStreams: () => false });

        expect(result.success).toBe(true);
        expect(mockExecFileFn.mock.calls.some(([cmd, args]) => isCmdShimCall(String(cmd), args as string[], 'npm.cmd'))).toBe(true);
        expect(result.steps.map(step => step.name)).toEqual([
          'download release manifest',
          'download release zip',
          'extract release zip',
          'verify Node.js runtime',
          'npm ci',
          'npm --prefix mobile/AgentCockpitPWA ci',
          'npm run web:build',
          'npm run mobile:build',
          'verify release assets',
          'copy runtime config',
          'activate release',
          'write install manifest',
          'pm2 restart',
        ]);
        const finalDir = path.join(install.releasesDir, 'agent-cockpit-v1.1.0');
        expect(writeState).toHaveBeenCalledWith(expect.objectContaining({
          channel: 'production',
          source: 'github-release',
          version: '1.1.0',
          appDir: finalDir,
          startup: install.status.startup,
        }));
        const finalEcosystem = originalReadFileSync(path.join(finalDir, 'ecosystem.config.js'), 'utf8');
        expect(finalEcosystem).toContain('run-agent-cockpit.vbs');
        expect(finalEcosystem).toContain('"interpreter": "wscript.exe"');
        expect(finalEcosystem).toContain('"//NoLogo"');
        const runnerScript = originalReadFileSync(path.join(install.installDir, 'bin', 'run-agent-cockpit.vbs'), 'utf8');
        expect(runnerScript).toContain('shell.Run(cmd, 0, True)');
        expect(runnerScript).toContain('--import tsx server.ts');
        expect(runnerScript).toContain('agent-cockpit-runner-error.log');
        const restartPath = path.join(install.dataDir, 'restart.ps1');
        const restartScript = originalReadFileSync(restartPath, 'utf8');
        expect(restartScript).toContain('Invoke-WebRequest -UseBasicParsing');
        expect(restartScript).toContain('[System.IO.File]::WriteAllText');
        expect(restartScript).toContain('System.Text.UTF8Encoding($false)');
        expect(restartScript).toContain(path.join(install.previousDir, 'ecosystem.config.js'));
        expect(mockSpawnFn).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining(['-WindowStyle', 'Hidden', '-File', restartPath]), expect.objectContaining({
          cwd: finalDir,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }));
      } finally {
        restorePlatform();
        fs.rmSync(install.installDir, { recursive: true, force: true });
      }
    });

    test('installs a private Windows Node.js ZIP runtime when a production release requires it', async () => {
      mockWriteFileSync.mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => originalWriteFileSync(...args));
      const restorePlatform = mockProcessPlatform('win32');
      const install = makeWindowsProductionInstall('agent-cockpit-win-node-');
      const nodeVersion = '23.7.0';
      const nodeArch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const nodeArchiveName = `node-v${nodeVersion}-win-${nodeArch}.zip`;
      const nodeBytes = Buffer.from('node zip');
      const nodeSha = crypto.createHash('sha256').update(nodeBytes).digest('hex');
      const checksumsRaw = `${nodeSha}  ${nodeArchiveName}\n`;
      try {
        service = new UpdateService(install.previousDir, {
          webBuildService: { ensureBuilt: mockWebBuildEnsureBuilt },
          mobileBuildService: { ensureBuilt: mockMobileBuildEnsureBuilt },
          dataRoot: install.dataDir,
          installStateService: {
            getStatus: () => install.status,
          },
        });
        jest.spyOn(service as any, '_downloadText').mockResolvedValue(checksumsRaw);
        jest.spyOn(service as any, '_downloadToFile').mockImplementation(async (...args: unknown[]) => {
          const [, dest] = args as [string, string];
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          originalWriteFileSync(dest, nodeBytes);
        });
        mockExecFileFn.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
          if (cmd === 'powershell.exe' && String(args).includes('Expand-Archive')) {
            const command = String(args[args.length - 1]);
            const match = command.match(/-DestinationPath '([^']+)'/);
            const extractDir = match ? match[1] : '';
            writeText(path.join(extractDir, `node-v${nodeVersion}-win-${nodeArch}`, 'node.exe'), 'node\n');
            writeText(path.join(extractDir, `node-v${nodeVersion}-win-${nodeArch}`, 'npm.cmd'), 'npm\n');
            writeText(path.join(extractDir, `node-v${nodeVersion}-win-${nodeArch}`, 'npx.cmd'), 'npx\n');
            cb(null, 'expanded node\n', '');
            return;
          }
          if (isCmdShimCall(cmd, args, 'npm.cmd')) {
            cb(null, '11.0.0\n', '');
            return;
          }
          cb(new Error(`unexpected command ${cmd}`), '', '');
        });

        const steps: any[] = [];
        const runtime = await (service as any)._installPrivateNodeRuntime(install.status, 23, steps);

        expect(runtime).toEqual(expect.objectContaining({
          source: 'private',
          version: nodeVersion,
          npmVersion: '11.0.0',
          binDir: path.join(install.installDir, 'runtime', `node-v${nodeVersion}-win-${nodeArch}`),
          runtimeDir: path.join(install.installDir, 'runtime', `node-v${nodeVersion}-win-${nodeArch}`),
          requiredMajor: 23,
        }));
        expect(steps).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: 'install Node.js runtime', success: true }),
        ]));
      } finally {
        restorePlatform();
        fs.rmSync(install.installDir, { recursive: true, force: true });
      }
    });

    test('uses the previous Windows runtime when rollback restarts the old release', () => {
      mockWriteFileSync.mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => originalWriteFileSync(...args));
      const restorePlatform = mockProcessPlatform('win32');
      const install = makeWindowsProductionInstall('agent-cockpit-win-rollback-');
      const nextDir = path.join(install.releasesDir, 'agent-cockpit-v1.1.0');
      const oldRuntimeDir = path.join(install.installDir, 'runtime', 'node-v22.22.2-win-x64');
      const newRuntimeDir = path.join(install.installDir, 'runtime', 'node-v23.7.0-win-x64');
      writeText(path.join(nextDir, 'ecosystem.config.js'), "module.exports = { apps: [] };\n");
      try {
        service = new UpdateService(install.previousDir, {
          dataRoot: install.dataDir,
          installStateService: {
            getStatus: () => install.status,
          },
        });

        (service as any)._launchWindowsRestartScript({
          appRoot: nextDir,
          healthUrl: 'http://127.0.0.1:4444/api/chat/version',
          rollbackTarget: install.previousDir,
          rollbackInstallStatus: {
            ...install.status,
            nodeRuntime: {
              source: 'private',
              version: '22.22.2',
              npmVersion: '10.9.0',
              binDir: oldRuntimeDir,
              runtimeDir: oldRuntimeDir,
              requiredMajor: 22,
              updatedAt: '2026-05-15T00:00:00.000Z',
            },
          },
          nodeRuntime: {
            source: 'private',
            version: '23.7.0',
            npmVersion: '11.0.0',
            binDir: newRuntimeDir,
            runtimeDir: newRuntimeDir,
            requiredMajor: 23,
            updatedAt: '2026-05-15T00:00:00.000Z',
          },
        });

        const restartPath = path.join(install.dataDir, 'restart.ps1');
        const restartScript = originalReadFileSync(restartPath, 'utf8');
        expect(restartScript).toContain('function Invoke-CheckedNative');
        expect(restartScript).toContain('$LASTEXITCODE');
        expect(restartScript).toContain(path.join(newRuntimeDir, 'npx.cmd'));
        expect(restartScript).toContain(path.join(oldRuntimeDir, 'npx.cmd'));
        expect(restartScript).toContain(`$env:Path = '${oldRuntimeDir}' + ';' + $env:Path`);
        expect(restartScript).toContain(`Invoke-CheckedNative '${path.join(oldRuntimeDir, 'npx.cmd')}' @('pm2', 'save')`);
        expect(mockSpawnFn).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining(['-WindowStyle', 'Hidden', '-File', restartPath]), expect.objectContaining({
          cwd: nextDir,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }));
      } finally {
        restorePlatform();
        fs.rmSync(install.installDir, { recursive: true, force: true });
      }
    });

    test('writes parseable Windows PM2 config with paths containing spaces', () => {
      mockWriteFileSync.mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => originalWriteFileSync(...args));
      const restorePlatform = mockProcessPlatform('win32');
      const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent cockpit win config '));
      const appDir = path.join(installDir, 'releases', 'agent cockpit v1.1.0');
      const dataDir = path.join(installDir, 'data dir');
      const runtimeDir = path.join(installDir, 'runtime', 'node v22 win x64');
      try {
        writeJson(path.join(appDir, 'package.json'), { version: '1.1.0' });
        writeText(path.join(appDir, '.env'), [
          'PORT=4455',
          'SESSION_SECRET=secret with spaces',
          'AUTH_SETUP_TOKEN=token with spaces',
          'WEB_BUILD_MODE=skip',
          'AUTH_ENABLE_LEGACY_OAUTH=true',
          '',
        ].join('\n'));
        service = new UpdateService(appDir, {
          dataRoot: dataDir,
        });

        (service as any)._writeWindowsEcosystemConfig(appDir, {
          source: 'private',
          version: '22.22.2',
          npmVersion: '10.9.0',
          binDir: runtimeDir,
          runtimeDir,
          requiredMajor: 22,
          updatedAt: '2026-05-15T00:00:00.000Z',
        }, { dataDir });

        const source = originalReadFileSync(path.join(appDir, 'ecosystem.config.js'), 'utf8');
        const mod: { exports: any } = { exports: {} };
        new Function('module', 'exports', '__dirname', source)(mod, mod.exports, appDir);
        const app = mod.exports.apps[0];
        expect(app).toEqual(expect.objectContaining({
          name: 'agent-cockpit',
          script: path.join(installDir, 'bin', 'run-agent-cockpit.vbs'),
          interpreter: 'wscript.exe',
          node_args: ['//B', '//NoLogo'],
          cwd: appDir,
          windowsHide: true,
        }));
        expect(app.env).toEqual(expect.objectContaining({
          PORT: 4455,
          SESSION_SECRET: 'secret with spaces',
          AUTH_SETUP_TOKEN: 'token with spaces',
          AGENT_COCKPIT_DATA_DIR: dataDir,
          WEB_BUILD_MODE: 'skip',
          AUTH_ENABLE_LEGACY_OAUTH: 'true',
          PM2_HOME: path.join(installDir, 'pm2'),
        }));
        expect(app.env.PATH.startsWith(`${runtimeDir};`)).toBe(true);
        const runnerScript = originalReadFileSync(path.join(installDir, 'bin', 'run-agent-cockpit.vbs'), 'utf8');
        expect(runnerScript).toContain(`nodeExe = "${path.join(runtimeDir, 'node.exe').replace(/"/g, '""')}"`);
        expect(runnerScript).toContain(`appDir = "${appDir.replace(/"/g, '""')}"`);
        expect(runnerScript).toContain('shell.Run(cmd, 0, True)');
      } finally {
        restorePlatform();
        fs.rmSync(installDir, { recursive: true, force: true });
      }
    });

    test('persists Windows private runtime PATH without dotenv escape corruption', () => {
      mockWriteFileSync.mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => originalWriteFileSync(...args));
      const restorePlatform = mockProcessPlatform('win32');
      const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cockpit-win-dotenv-'));
      const runtimeDir = String.raw`C:\Users\Name\AppData\Local\Agent Cockpit\runtime\node-v22.22.2-win-x64`;
      try {
        writeJson(path.join(appDir, 'package.json'), { version: '1.1.0' });
        writeText(path.join(appDir, '.env'), `${String.raw`PORT=4455
AGENT_COCKPIT_DATA_DIR='C:\Users\Name\AppData\Local\Agent Cockpit\data'`}
`);
        writeText(path.join(appDir, 'ecosystem.config.js'), 'module.exports = { apps: [{ name: "agent-cockpit", env: {} }] };\n');
        service = new UpdateService(appDir, {
          dataRoot: String.raw`C:\Users\Name\AppData\Local\Agent Cockpit\data`,
        });

        (service as any)._persistPrivateRuntimePath(appDir, runtimeDir);

        const parsed = dotenv.parse(originalReadFileSync(path.join(appDir, '.env'), 'utf8'));
        expect(parsed.PATH.startsWith(`${runtimeDir};`)).toBe(true);
        expect(parsed.PATH).not.toContain('\r');
        expect(parsed.PATH).not.toContain('\n');
      } finally {
        restorePlatform();
        fs.rmSync(appDir, { recursive: true, force: true });
      }
    });
  });

  // ── restart (plain server restart, no git pull / npm install) ────────────

  describe('restart', () => {
    test('blocks when update or restart is already in progress', async () => {
      (service as any)._updateInProgress = true;
      const result = await service.restart();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already in progress/);
      // Should not touch disk or fork a subprocess when blocked.
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockSpawnFn).not.toHaveBeenCalled();
    });

    test('blocks when active streams exist', async () => {
      const result = await service.restart({ hasActiveStreams: () => true });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/actively running/);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockSpawnFn).not.toHaveBeenCalled();
    });

    test('writes restart script and double-forks it on success', async () => {
      const result = await service.restart({ hasActiveStreams: () => false });
      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].name).toBe('pm2 restart');
      expect(result.steps[0].success).toBe(true);

      // Same script shape as the update flow — PATH export + pm2 delete + pm2 start.
      const writeCall = mockWriteFileSync.mock.calls.find(
        (c) => String(c[0]).includes('restart.sh'),
      );
      expect(writeCall).toBeDefined();
      const script = String(writeCall![1]);
      expect(script).toContain('node_modules/.bin');
      expect(script).toMatch(/export PATH=.*node_modules\/\.bin/);
      expect(script).toContain('pm2 delete');
      expect(script).toContain('pm2 start');
      expect(script).toContain('sleep 2');

      // Double-fork via nohup inside a subshell.
      const spawnArgs = mockSpawnFn.mock.calls[0] as unknown[];
      const shellCmd = (spawnArgs[1] as string[])[1];
      expect(shellCmd).toContain('nohup');
      expect(shellCmd).toContain('restart.sh');
    });

    test('writes restart artifacts under a custom data root', async () => {
      const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'update-data-'));
      try {
        service = new UpdateService(appRoot, {
          webBuildService: { ensureBuilt: mockWebBuildEnsureBuilt },
          mobileBuildService: { ensureBuilt: mockMobileBuildEnsureBuilt },
          dataRoot,
        });

        const result = await service.restart({ hasActiveStreams: () => false });
        expect(result.success).toBe(true);

        const writeCall = mockWriteFileSync.mock.calls.find(
          (c) => String(c[0]).includes('restart.sh'),
        );
        expect(writeCall).toBeDefined();
        expect(String(writeCall![0])).toBe(path.join(dataRoot, 'restart.sh'));

        const spawnArgs = mockSpawnFn.mock.calls[0] as unknown[];
        const shellCmd = (spawnArgs[1] as string[])[1];
        expect(shellCmd).toContain(path.join(dataRoot, 'restart.sh'));
        expect(shellCmd).toContain(path.join(dataRoot, 'update-restart.log'));
      } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
      }
    });

    test('does not run git or npm commands', async () => {
      await service.restart({ hasActiveStreams: () => false });
      // triggerUpdate shells out to git/npm via execFile — restart() must not.
      expect(mockExecFileFn).not.toHaveBeenCalled();
    });

    test('resets updateInProgress flag after success', async () => {
      await service.restart({ hasActiveStreams: () => false });
      expect((service as any)._updateInProgress).toBe(false);
    });

    test('resets updateInProgress flag after a blocked restart', async () => {
      (service as any)._updateInProgress = true;
      await service.restart();
      // Still true because we were already in-progress before the call — the
      // call should not have cleared a flag it did not own.
      expect((service as any)._updateInProgress).toBe(true);
      (service as any)._updateInProgress = false;
    });
  });
});
