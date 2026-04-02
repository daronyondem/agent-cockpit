import path from 'path';

// ── Mock child_process.execFile ─────────────────────────────────────────────

const mockExecFileFn = jest.fn();
const mockSpawnResult = { unref: jest.fn() };
const mockSpawnFn = jest.fn(() => mockSpawnResult);
jest.mock('child_process', () => ({
  execFile: function () { return mockExecFileFn.apply(null, arguments); },
  spawn: function () { return mockSpawnFn.apply(null, arguments); },
}));

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

  beforeEach(() => {
    service = new UpdateService(appRoot);
    mockExecFileFn.mockReset();
    mockSpawnFn.mockClear();
    mockSpawnResult.unref.mockClear();
  });

  afterEach(() => {
    service.stop();
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
      expect(result.steps).toHaveLength(4);
      expect(mockSpawnFn).toHaveBeenCalled();
    });

    test('executes all steps on success', async () => {
      mockExecFile([
        { stdout: '' },
        { stdout: 'Already on \'main\'\n' },
        { stdout: 'Updating abc..def\n' },
        { stdout: 'added 0 packages\n' },
      ]);

      const result = await service.triggerUpdate({
        hasActiveStreams: () => false,
      });
      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(4);
      expect(result.steps[0].name).toBe('git checkout main');
      expect(result.steps[1].name).toBe('git pull origin main');
      expect(result.steps[2].name).toBe('npm install');
      expect(result.steps[3].name).toBe('pm2 restart');
      result.steps.forEach(s => expect(s.success).toBe(true));
      expect(mockSpawnFn).toHaveBeenCalledWith('sh', expect.arrayContaining(['-c']), expect.objectContaining({ detached: true }));
      expect(mockSpawnResult.unref).toHaveBeenCalled();
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
  });
});
