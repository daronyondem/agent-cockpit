const path = require('path');

// ── Mock child_process.execFile ─────────────────────────────────────────────

const mockExecFileFn = jest.fn();
const mockSpawnResult = { unref: jest.fn() };
const mockSpawnFn = jest.fn(() => mockSpawnResult);
jest.mock('child_process', () => ({
  execFile: (...args) => mockExecFileFn(...args),
  spawn: (...args) => mockSpawnFn(...args),
}));

const { UpdateService } = require('../src/services/updateService');

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockExecFile(responses) {
  let callIndex = 0;
  mockExecFileFn.mockImplementation((cmd, args, opts, cb) => {
    const key = cmd + ' ' + args.join(' ');
    const entry = responses[callIndex++] || responses[key];
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
  let service;
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
      expect(service._isNewer('0.1.5', '0.1.5')).toBe(false);
    });

    test('returns true when remote is newer (patch)', () => {
      expect(service._isNewer('0.1.6', '0.1.5')).toBe(true);
    });

    test('returns true when remote is newer (minor)', () => {
      expect(service._isNewer('0.2.0', '0.1.9')).toBe(true);
    });

    test('returns true when remote is newer (major)', () => {
      expect(service._isNewer('1.0.0', '0.9.9')).toBe(true);
    });

    test('returns false when remote is older', () => {
      expect(service._isNewer('0.1.4', '0.1.5')).toBe(false);
    });

    test('returns false when remote is null', () => {
      expect(service._isNewer(null, '0.1.5')).toBe(false);
    });

    test('returns false when local is null', () => {
      expect(service._isNewer('0.1.5', null)).toBe(false);
    });

    test('handles different segment counts', () => {
      expect(service._isNewer('0.1.5.1', '0.1.5')).toBe(true);
      expect(service._isNewer('0.1.5', '0.1.5.1')).toBe(false);
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
      service._latestRemoteVersion = '99.0.0';
      const status = service.getStatus();
      expect(status.updateAvailable).toBe(true);
      expect(status.remoteVersion).toBe('99.0.0');
    });
  });

  // ── start / stop ──────────────────────────────────────────────────────

  describe('start / stop', () => {
    test('starts and stops the polling interval', () => {
      // Mock the version check to avoid real git calls
      mockExecFile([
        { stdout: '' }, // git fetch
        { stdout: JSON.stringify({ version: '0.1.5' }) }, // git show
      ]);

      service.start();
      expect(service._checkInterval).not.toBeNull();

      service.stop();
      expect(service._checkInterval).toBeNull();
    });
  });

  // ── _checkRemoteVersion ────────────────────────────────────────────────

  describe('_checkRemoteVersion', () => {
    test('updates remote version on success', async () => {
      mockExecFile([
        { stdout: '' }, // git fetch
        { stdout: JSON.stringify({ version: '0.2.0' }) }, // git show
      ]);

      await service._checkRemoteVersion();
      expect(service._latestRemoteVersion).toBe('0.2.0');
      expect(service._lastCheckAt).not.toBeNull();
      expect(service._lastError).toBeNull();
    });

    test('sets lastError on failure', async () => {
      mockExecFile([
        { error: 'fatal: could not fetch' },
      ]);

      await service._checkRemoteVersion();
      expect(service._lastError).toBe('fatal: could not fetch');
      expect(service._latestRemoteVersion).toBeNull();
    });
  });

  // ── triggerUpdate guards ──────────────────────────────────────────────

  describe('triggerUpdate', () => {
    test('blocks when update is already in progress', async () => {
      service._updateInProgress = true;
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
        { stdout: ' M server.js\n' }, // git status --porcelain
      ]);

      const result = await service.triggerUpdate({
        hasActiveStreams: () => false,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Uncommitted local changes/);
    });

    test('ignores expected untracked files in git status', async () => {
      // git status shows only runtime artifacts -> should proceed
      mockExecFile([
        { stdout: '?? data/sessions/abc.json\n?? .env\n?? ecosystem.config.js\n?? .DS_Store\n?? .claude/something\n' }, // git status
        { stdout: 'Already on \'main\'\n' }, // git checkout
        { stdout: 'Already up to date.\n' }, // git pull
        { stdout: 'up to date\n' }, // npm install
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
        { stdout: '' }, // git status (clean)
        { stdout: 'Already on \'main\'\n' }, // git checkout
        { stdout: 'Updating abc..def\n' }, // git pull
        { stdout: 'added 0 packages\n' }, // npm install
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
      // PM2 restart uses detached spawn (fire-and-forget)
      expect(mockSpawnFn).toHaveBeenCalledWith('pm2', expect.arrayContaining(['restart']), expect.objectContaining({ detached: true }));
      expect(mockSpawnResult.unref).toHaveBeenCalled();
    });

    test('stops at first failed step and reports error', async () => {
      mockExecFile([
        { stdout: '' }, // git status (clean)
        { stdout: 'Switched to branch \'main\'\n' }, // git checkout
        { error: 'fatal: could not connect to remote' }, // git pull fails
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
        { stdout: '' }, // git status
        { error: 'checkout failed' }, // git checkout fails
      ]);

      await service.triggerUpdate({ hasActiveStreams: () => false });
      expect(service._updateInProgress).toBe(false);
    });

    test('resets updateInProgress flag after success', async () => {
      mockExecFile([
        { stdout: '' },
        { stdout: 'ok' },
        { stdout: 'ok' },
        { stdout: 'ok' },
      ]);

      await service.triggerUpdate({ hasActiveStreams: () => false });
      expect(service._updateInProgress).toBe(false);
    });
  });
});
