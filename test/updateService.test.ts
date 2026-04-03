import path from 'path';
import fs from 'fs';

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
const mockWriteFileSync = jest.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
  // Allow writing the temp ecosystem config for CI, mock everything else
  if (String(args[0]).endsWith('ecosystem.config.js')) {
    return originalWriteFileSync(...args);
  }
});

import { UpdateService } from '../src/services/updateService';

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── Tests ───────────────────────────────────────────────────────────────────

describe('UpdateService', () => {
  let service: UpdateService;
  const appRoot = path.join(__dirname, '..');

  const interpreterPath = path.join(appRoot, 'node_modules', '.bin', 'tsx');
  const ecosystemPath = path.join(appRoot, 'ecosystem.config.js');
  const ecosystemExists = originalExistsSync(ecosystemPath);

  beforeEach(() => {
    // Ensure ecosystem.config.js exists for tests (it's gitignored, so absent in CI)
    if (!ecosystemExists) {
      fs.writeFileSync(ecosystemPath, `module.exports = { apps: [{ script: 'server.ts', interpreter: './node_modules/.bin/tsx' }] };`);
    }
    service = new UpdateService(appRoot);
    mockExecFileFn.mockReset();
    mockSpawnFn.mockClear();
    mockWriteFileSync.mockClear();
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
  });

  // ── checkNow ───────────────────────────────────────────────────────────

  describe('checkNow', () => {
    test('triggers a version check and returns status', async () => {
      mockExecFile([
        { stdout: '' },
        { stdout: JSON.stringify({ version: '0.3.0' }) },
      ]);

      const status = await service.checkNow();
      expect(status.remoteVersion).toBe('0.3.0');
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
      expect(result.steps).toHaveLength(5);
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
      expect(result.steps).toHaveLength(5);
      expect(result.steps[0].name).toBe('git checkout main');
      expect(result.steps[1].name).toBe('git pull origin main');
      expect(result.steps[2].name).toBe('npm install');
      expect(result.steps[3].name).toBe('verify interpreter');
      expect(result.steps[4].name).toBe('pm2 restart');
      result.steps.forEach(s => expect(s.success).toBe(true));
      expect(mockWriteFileSync).toHaveBeenCalled();
      expect(mockSpawnFn).toHaveBeenCalledWith('sh', expect.arrayContaining(['-c']), expect.objectContaining({ stdio: 'ignore' }));
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
  });
});
