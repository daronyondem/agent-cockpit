import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { homedir } from 'os';

// ── Mocks ──────────────────────────────────────────────────────────────────
// Keychain fallback — mock execFile before importing the service.
const mockExecFileFn = jest.fn();
jest.mock('child_process', () => ({
  execFile: function (...args: unknown[]) { return mockExecFileFn(...args); },
}));

import { ClaudePlanUsageService } from '../src/services/claudePlanUsageService';

const CREDENTIALS_PATH = path.join(homedir(), '.claude', '.credentials.json');

// ── Helpers ────────────────────────────────────────────────────────────────

type ReadFileOverride = { path: string; content?: string; error?: NodeJS.ErrnoException };

function mockReadFile(overrides: ReadFileOverride[]): jest.SpyInstance {
  return jest.spyOn(fsp, 'readFile').mockImplementation(async (p, enc) => {
    const pStr = String(p);
    const hit = overrides.find(o => o.path === pStr);
    if (hit) {
      if (hit.error) throw hit.error;
      return hit.content!;
    }
    // Delegate unmatched paths to real impl so the service can read/write its cache.
    return (jest.requireActual('fs/promises') as typeof fsp).readFile(p, enc);
  });
}

function validCredsJson(opts: Partial<{
  accessToken: string;
  expiresAt: number;
  subscriptionType: string;
  rateLimitTier: string;
}> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: opts.accessToken ?? 'sk-ant-oat01-TEST',
      refreshToken: 'sk-ant-ort01-TEST',
      expiresAt: opts.expiresAt ?? Date.now() + 60 * 60 * 1000,
      scopes: ['user:inference'],
      subscriptionType: opts.subscriptionType ?? 'max',
      rateLimitTier: opts.rateLimitTier ?? 'max_20x',
    },
  });
}

function mockFetchOk(body: unknown): jest.Mock {
  const fn = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  (global as any).fetch = fn;
  return fn;
}

function mockFetchStatus(status: number, bodyText = 'err'): jest.Mock {
  const fn = jest.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => bodyText,
  });
  (global as any).fetch = fn;
  return fn;
}

function mockFetchReject(err: Error): jest.Mock {
  const fn = jest.fn().mockRejectedValue(err);
  (global as any).fetch = fn;
  return fn;
}

const USAGE_BODY = {
  five_hour: { utilization: 18, resets_at: new Date(Date.now() + 2 * 3600_000).toISOString() },
  seven_day: { utilization: 77, resets_at: new Date(Date.now() + 20 * 3600_000).toISOString() },
  seven_day_sonnet: { utilization: 2, resets_at: new Date(Date.now() + 3 * 86400_000).toISOString() },
  seven_day_opus: { utilization: 50, resets_at: new Date(Date.now() + 3 * 86400_000).toISOString() },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ClaudePlanUsageService', () => {
  let tmpDir: string;
  let service: ClaudePlanUsageService;
  let readSpy: jest.SpyInstance | null = null;
  const originalFetch = (global as any).fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-usage-'));
    service = new ClaudePlanUsageService(tmpDir);
    mockExecFileFn.mockReset();
    readSpy = null;
  });

  afterEach(() => {
    if (readSpy) readSpy.mockRestore();
    (global as any).fetch = originalFetch;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('stores cache files under a custom data root', () => {
    const dataRoot = path.join(tmpDir, 'external-data');
    const custom = new ClaudePlanUsageService(tmpDir, { dataRoot });

    expect((custom as any)._cacheFile).toBe(path.join(dataRoot, 'claude-plan-usage.json'));
    expect((custom as any)._profileCacheDir).toBe(path.join(dataRoot, 'claude-plan-usage'));
  });

  // ── init ──────────────────────────────────────────────────────────────

  describe('init', () => {
    test('starts with empty snapshot when no cache file', async () => {
      await service.init();
      const cached = service.getCached();
      expect(cached.fetchedAt).toBeNull();
      expect(cached.rateLimits).toBeNull();
      expect(cached.stale).toBe(true);
      expect(cached.lastError).toBeNull();
    });

    test('loads persisted snapshot from disk', async () => {
      const cacheFile = path.join(tmpDir, 'data', 'claude-plan-usage.json');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const snapshot = {
        fetchedAt: new Date().toISOString(),
        planTier: 'max_20x',
        subscriptionType: 'max',
        rateLimits: USAGE_BODY,
        lastError: null,
      };
      fs.writeFileSync(cacheFile, JSON.stringify(snapshot), 'utf8');

      await service.init();
      const cached = service.getCached();
      expect(cached.planTier).toBe('max_20x');
      expect(cached.rateLimits).toEqual(USAGE_BODY);
      expect(cached.stale).toBe(false);
    });

    test('tolerates corrupt cache file without throwing', async () => {
      const cacheFile = path.join(tmpDir, 'data', 'claude-plan-usage.json');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, 'not json', 'utf8');
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(service.init()).resolves.toBeUndefined();
      expect(service.getCached().fetchedAt).toBeNull();
      warn.mockRestore();
    });
  });

  // ── getCached staleness ───────────────────────────────────────────────

  describe('getCached', () => {
    test('marks stale=true when fetchedAt is older than 15 min', async () => {
      const cacheFile = path.join(tmpDir, 'data', 'claude-plan-usage.json');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const oldIso = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      fs.writeFileSync(cacheFile, JSON.stringify({
        fetchedAt: oldIso, planTier: 'max', subscriptionType: 'max', rateLimits: USAGE_BODY, lastError: null,
      }), 'utf8');
      await service.init();
      expect(service.getCached().stale).toBe(true);
    });

    test('marks stale=false when fetchedAt is recent', async () => {
      const cacheFile = path.join(tmpDir, 'data', 'claude-plan-usage.json');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({
        fetchedAt: new Date(Date.now() - 30_000).toISOString(),
        planTier: 'max', subscriptionType: 'max', rateLimits: USAGE_BODY, lastError: null,
      }), 'utf8');
      await service.init();
      expect(service.getCached().stale).toBe(false);
    });
  });

  // ── maybeRefresh (creds from file) ────────────────────────────────────

  describe('maybeRefresh — credentials file path', () => {
    test('fetches, persists snapshot, and clears errors', async () => {
      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, content: validCredsJson() }]);
      const fetchFn = mockFetchOk(USAGE_BODY);

      await service.maybeRefresh('test');
      const cached = service.getCached();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(cached.rateLimits).toEqual(USAGE_BODY);
      expect(cached.planTier).toBe('max_20x');
      expect(cached.subscriptionType).toBe('max');
      expect(cached.lastError).toBeNull();
      expect(cached.fetchedAt).not.toBeNull();

      // Verify persisted on disk
      const cacheFile = path.join(tmpDir, 'data', 'claude-plan-usage.json');
      const onDisk = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      expect(onDisk.rateLimits).toEqual(USAGE_BODY);
    });

    test('plain server-configured profile uses the default cache', async () => {
      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, content: validCredsJson({ accessToken: 'server-token' }) }]);
      const fetchFn = mockFetchOk(USAGE_BODY);
      const profile = {
        id: 'server-configured-claude-code',
        name: 'Claude Code (Server Configured)',
        vendor: 'claude-code' as const,
        authMode: 'server-configured' as const,
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      };

      await service.maybeRefresh('server-profile', profile);

      expect(fetchFn).toHaveBeenCalledWith(
        'https://api.anthropic.com/api/oauth/usage',
        expect.objectContaining({
          headers: expect.objectContaining({ 'Authorization': 'Bearer server-token' }),
        }),
      );
      expect(service.getCached().rateLimits).toEqual(USAGE_BODY);
      expect(service.getCached(profile).rateLimits).toEqual(USAGE_BODY);
      expect(fs.existsSync(path.join(tmpDir, 'data', 'claude-plan-usage', 'server-configured-claude-code.json'))).toBe(false);
    });

    test('uses Claude profile configDir credentials and stores profile cache separately', async () => {
      const profileConfigDir = '/tmp/claude-work-home';
      const profileCredentialsPath = path.join(profileConfigDir, '.credentials.json');
      readSpy = mockReadFile([
        { path: profileCredentialsPath, content: validCredsJson({ accessToken: 'profile-token', rateLimitTier: 'work_20x' }) },
      ]);
      const fetchFn = mockFetchOk(USAGE_BODY);
      const profile = {
        id: 'profile-claude-work',
        name: 'Claude Work',
        vendor: 'claude-code' as const,
        command: '/opt/claude/bin/claude',
        authMode: 'account' as const,
        configDir: profileConfigDir,
        env: { ANTHROPIC_BASE_URL: 'https://example.test' },
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      };

      await service.maybeRefresh('profile-test', profile);
      const cached = service.getCached(profile);

      expect(fetchFn).toHaveBeenCalledWith(
        'https://api.anthropic.com/api/oauth/usage',
        expect.objectContaining({
          headers: expect.objectContaining({ 'Authorization': 'Bearer profile-token' }),
        }),
      );
      expect(cached.planTier).toBe('work_20x');
      expect(cached.rateLimits).toEqual(USAGE_BODY);
      expect(service.getCached().rateLimits).toBeNull();

      const profileCache = path.join(tmpDir, 'data', 'claude-plan-usage', 'profile-claude-work.json');
      const onDisk = JSON.parse(fs.readFileSync(profileCache, 'utf8'));
      expect(onDisk.planTier).toBe('work_20x');
      expect(onDisk.rateLimits).toEqual(USAGE_BODY);
    });

    test('sends bearer token + anthropic-beta header', async () => {
      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, content: validCredsJson({ accessToken: 'my-token' }) }]);
      const fetchFn = mockFetchOk(USAGE_BODY);

      await service.maybeRefresh('test');
      expect(fetchFn).toHaveBeenCalledWith(
        'https://api.anthropic.com/api/oauth/usage',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer my-token',
            'anthropic-beta': 'oauth-2025-04-20',
          }),
        }),
      );
    });

    test('throttles second call within 10 min', async () => {
      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, content: validCredsJson() }]);
      const fetchFn = mockFetchOk(USAGE_BODY);

      await service.maybeRefresh('first');
      await service.maybeRefresh('second');
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    test('coalesces concurrent refresh calls via in-flight promise', async () => {
      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, content: validCredsJson() }]);
      const fetchFn = mockFetchOk(USAGE_BODY);

      await Promise.all([
        service.maybeRefresh('a'),
        service.maybeRefresh('b'),
        service.maybeRefresh('c'),
      ]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    test('marks token-expired without calling fetch', async () => {
      const expired = Date.now() - 1000;
      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, content: validCredsJson({ expiresAt: expired }) }]);
      const fetchFn = mockFetchOk(USAGE_BODY);

      await service.maybeRefresh('test');
      expect(fetchFn).not.toHaveBeenCalled();
      expect(service.getCached().lastError).toBe('token-expired');
    });

    test('token-expired skip does not burn the 10-min throttle', async () => {
      // First call: token expired → snapshot marked, no fetch. Throttle must
      // NOT engage — otherwise stale data persists for 10+ min after Claude
      // Code rotates to a fresh OAuth token.
      const expired = Date.now() - 1000;
      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, content: validCredsJson({ expiresAt: expired }) }]);
      const firstFetch = mockFetchOk(USAGE_BODY);
      await service.maybeRefresh('first');
      expect(firstFetch).not.toHaveBeenCalled();
      expect(service.getCached().lastError).toBe('token-expired');

      // Simulate Claude Code rotating its OAuth token: swap the creds for a fresh one.
      readSpy.mockRestore();
      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, content: validCredsJson() }]);
      const secondFetch = mockFetchOk(USAGE_BODY);

      // Second call right away should proceed (no throttle from the prior skip).
      await service.maybeRefresh('second');
      expect(secondFetch).toHaveBeenCalledTimes(1);
      expect(service.getCached().lastError).toBeNull();
      expect(service.getCached().rateLimits?.five_hour?.utilization).toBe(18);
    });

    test('records lastError on HTTP 401, preserves prior snapshot', async () => {
      // Seed prior good snapshot
      const cacheFile = path.join(tmpDir, 'data', 'claude-plan-usage.json');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({
        fetchedAt: new Date(Date.now() - 60_000).toISOString(),
        planTier: 'max_20x',
        subscriptionType: 'max',
        rateLimits: USAGE_BODY,
        lastError: null,
      }), 'utf8');
      await service.init();

      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, content: validCredsJson() }]);
      mockFetchStatus(401, 'unauthorized');
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await service.maybeRefresh('test');
      const cached = service.getCached();
      expect(cached.lastError).toMatch(/401/);
      // Prior data preserved
      expect(cached.rateLimits).toEqual(USAGE_BODY);
      expect(cached.planTier).toBe('max_20x');
      warn.mockRestore();
    });

    test('records lastError on network failure, preserves prior snapshot', async () => {
      const cacheFile = path.join(tmpDir, 'data', 'claude-plan-usage.json');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({
        fetchedAt: new Date(Date.now() - 60_000).toISOString(),
        planTier: 'max_20x',
        subscriptionType: 'max',
        rateLimits: USAGE_BODY,
        lastError: null,
      }), 'utf8');
      await service.init();

      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, content: validCredsJson() }]);
      mockFetchReject(new Error('ENETDOWN'));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await service.maybeRefresh('test');
      const cached = service.getCached();
      expect(cached.lastError).toBe('ENETDOWN');
      expect(cached.rateLimits).toEqual(USAGE_BODY);
      warn.mockRestore();
    });
  });

  // ── maybeRefresh (keychain fallback, darwin only) ─────────────────────

  describe('maybeRefresh — keychain fallback', () => {
    test('falls back to /usr/bin/security on darwin when credentials file is absent', async () => {
      if (process.platform !== 'darwin') {
        return; // fallback path only exists on macOS
      }
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, error: enoent }]);
      mockExecFileFn.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, validCredsJson({ accessToken: 'kc-token' }) + '\n', '');
      });
      const fetchFn = mockFetchOk(USAGE_BODY);

      await service.maybeRefresh('test');
      expect(mockExecFileFn).toHaveBeenCalledWith(
        '/usr/bin/security',
        expect.arrayContaining(['find-generic-password', '-s', 'Claude Code-credentials', '-w']),
        expect.any(Object),
        expect.any(Function),
      );
      expect(fetchFn).toHaveBeenCalledWith(
        'https://api.anthropic.com/api/oauth/usage',
        expect.objectContaining({
          headers: expect.objectContaining({ 'Authorization': 'Bearer kc-token' }),
        }),
      );
    });

    test('records lastError when keychain read fails', async () => {
      if (process.platform !== 'darwin') return;
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, error: enoent }]);
      mockExecFileFn.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error('user denied access'), '', 'user denied access');
      });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await service.maybeRefresh('test');
      expect(service.getCached().lastError).toMatch(/keychain read failed/);
      warn.mockRestore();
    });
  });
});
