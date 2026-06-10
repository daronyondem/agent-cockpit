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

import {
  ClaudePlanUsageService,
  parseClaudeCliUsageOutput,
  type ClaudeCliUsageProbeResult,
} from '../src/services/claudePlanUsageService';
import type { CliProfile } from '../src/types';

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
    return (jest.requireActual('fs/promises')).readFile(p, enc);
  });
}

function validCredsJson(opts: Partial<{
  accessToken: string;
  expiresAt: number;
  subscriptionType: string;
  rateLimitTier: string;
  scopes: string[];
  email: string;
}> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: opts.accessToken ?? 'sk-ant-oat01-TEST',
      refreshToken: 'sk-ant-ort01-TEST',
      expiresAt: opts.expiresAt ?? Date.now() + 60 * 60 * 1000,
      scopes: opts.scopes ?? ['user:inference', 'user:profile'],
      subscriptionType: opts.subscriptionType ?? 'max',
      rateLimitTier: opts.rateLimitTier ?? 'max_20x',
      account: opts.email ? { email: opts.email } : undefined,
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
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null },
};

function makeClaudeProfile(overrides: Partial<CliProfile> = {}): CliProfile {
  return {
    id: 'profile-claude-work',
    name: 'Claude Work',
    harness: 'claude-code',
    command: '/opt/claude/bin/claude',
    authMode: 'account',
    configDir: '/tmp/claude-work-home',
    createdAt: '2026-04-29T00:00:00.000Z',
    updatedAt: '2026-04-29T00:00:00.000Z',
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ClaudePlanUsageService', () => {
  let tmpDir: string;
  let service: ClaudePlanUsageService;
  let readSpy: jest.SpyInstance | null = null;
  let cliUsageProbe: jest.Mock<Promise<ClaudeCliUsageProbeResult>, [any?]>;
  const originalFetch = (global as any).fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-usage-'));
    cliUsageProbe = jest.fn().mockRejectedValue(new Error('cli unavailable'));
    service = new ClaudePlanUsageService(tmpDir, { cliUsageProbe });
    mockExecFileFn.mockReset();
    mockExecFileFn.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error('keychain unavailable'), '', '');
    });
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
      expect(cached.source).toBeNull();
      expect(cached.identity).toBeNull();
      expect(cached.attempts).toEqual([]);
    });

    test('loads persisted snapshot from disk', async () => {
      const cacheFile = path.join(tmpDir, 'data', 'claude-plan-usage.json');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const snapshot = {
        fetchedAt: new Date().toISOString(),
        planTier: 'max_20x',
        subscriptionType: 'max',
        rateLimits: USAGE_BODY,
        source: 'oauth-file',
        identity: { email: 'daron@example.test', organization: null, loginMethod: null },
        attempts: [{ at: new Date().toISOString(), source: 'oauth-file', ok: true, error: null }],
        lastError: null,
      };
      fs.writeFileSync(cacheFile, JSON.stringify(snapshot), 'utf8');

      await service.init();
      const cached = service.getCached();
      expect(cached.planTier).toBe('max_20x');
      expect(cached.rateLimits).toEqual(USAGE_BODY);
      expect(cached.source).toBe('oauth-file');
      expect(cached.identity?.email).toBe('daron@example.test');
      expect(cached.attempts).toHaveLength(1);
      expect(cached.stale).toBe(false);
    });

    test('loads persisted per-profile snapshots from disk', async () => {
      const profile = makeClaudeProfile({ id: 'profile/claude work' });
      const profileCacheDir = path.join(tmpDir, 'data', 'claude-plan-usage');
      const profileCacheFile = path.join(profileCacheDir, `${encodeURIComponent(profile.id)}.json`);
      fs.mkdirSync(profileCacheDir, { recursive: true });
      fs.writeFileSync(profileCacheFile, JSON.stringify({
        fetchedAt: new Date().toISOString(),
        planTier: 'work_20x',
        subscriptionType: 'team',
        rateLimits: { five_hour: { utilization: 42, resets_at: null } },
        source: 'cli-usage',
        identity: { email: 'work@example.test', organization: 'Work Org', loginMethod: null },
        attempts: [{ at: new Date().toISOString(), source: 'cli-usage', ok: true, error: null }],
        lastError: null,
      }), 'utf8');

      await service.init();

      const cached = service.getCached(profile);
      expect(cached.planTier).toBe('work_20x');
      expect(cached.subscriptionType).toBe('team');
      expect(cached.rateLimits?.five_hour?.utilization).toBe(42);
      expect(cached.identity?.email).toBe('work@example.test');
      expect(service.getCached().rateLimits).toBeNull();
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

    test('returns an empty stale snapshot for unknown profile caches without touching the default cache', async () => {
      const cacheFile = path.join(tmpDir, 'data', 'claude-plan-usage.json');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({
        fetchedAt: new Date(Date.now() - 30_000).toISOString(),
        planTier: 'max_20x',
        subscriptionType: 'max',
        rateLimits: USAGE_BODY,
        source: 'oauth-file',
        identity: null,
        attempts: [],
        lastError: null,
      }), 'utf8');
      await service.init();

      const profileCached = service.getCached(makeClaudeProfile({ id: 'profile-new' }));

      expect(profileCached).toMatchObject({
        fetchedAt: null,
        planTier: null,
        subscriptionType: null,
        rateLimits: null,
        source: null,
        identity: null,
        attempts: [],
        lastError: null,
        stale: true,
      });
      expect(service.getCached().planTier).toBe('max_20x');
    });
  });

  // ── maybeRefresh (creds from file) ────────────────────────────────────

  describe('maybeRefresh — credentials file path', () => {
    test('fetches, persists snapshot, and clears errors', async () => {
      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, content: validCredsJson({ email: 'daron@example.test' }) }]);
      const fetchFn = mockFetchOk(USAGE_BODY);

      await service.maybeRefresh('test');
      const cached = service.getCached();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(cliUsageProbe).not.toHaveBeenCalled();
      expect(cached.rateLimits).toEqual(USAGE_BODY);
      expect(cached.planTier).toBe('max_20x');
      expect(cached.subscriptionType).toBe('max');
      expect(cached.source).toBe('oauth-file');
      expect(cached.identity?.email).toBe('daron@example.test');
      expect(cached.attempts).toEqual([
        expect.objectContaining({ source: 'oauth-file', ok: true, error: null }),
      ]);
      expect(cached.lastError).toBeNull();
      expect(cached.fetchedAt).not.toBeNull();

      // Verify persisted on disk
      const cacheFile = path.join(tmpDir, 'data', 'claude-plan-usage.json');
      const onDisk = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      expect(onDisk.rateLimits).toEqual(USAGE_BODY);
      expect(onDisk.source).toBe('oauth-file');
      expect(onDisk.identity.email).toBe('daron@example.test');
    });

    test('plain server-configured profile uses the default cache', async () => {
      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, content: validCredsJson({ accessToken: 'server-token' }) }]);
      const fetchFn = mockFetchOk(USAGE_BODY);
      const profile = {
        id: 'server-configured-claude-code',
        name: 'Claude Code (Server Configured)',
        harness: 'claude-code' as const,
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
        harness: 'claude-code' as const,
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
      expect(cached.source).toBe('oauth-file');
      expect(service.getCached().rateLimits).toBeNull();

      const profileCache = path.join(tmpDir, 'data', 'claude-plan-usage', 'profile-claude-work.json');
      const onDisk = JSON.parse(fs.readFileSync(profileCache, 'utf8'));
      expect(onDisk.planTier).toBe('work_20x');
      expect(onDisk.rateLimits).toEqual(USAGE_BODY);
    });

    test('sends bearer token, OAuth beta, accept, and Claude Code user-agent headers', async () => {
      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, content: validCredsJson({ accessToken: 'my-token' }) }]);
      const fetchFn = mockFetchOk(USAGE_BODY);

      await service.maybeRefresh('test');
      expect(fetchFn).toHaveBeenCalledWith(
        'https://api.anthropic.com/api/oauth/usage',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer my-token',
            'anthropic-beta': 'oauth-2025-04-20',
            'Accept': 'application/json',
            'User-Agent': expect.stringContaining('claude-code/'),
          }),
        }),
      );
    });

    test('falls back to Claude CLI usage when OAuth credentials are unavailable', async () => {
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, error: enoent }]);
      const fetchFn = mockFetchOk(USAGE_BODY);
      cliUsageProbe.mockResolvedValueOnce({
        rateLimits: {
          five_hour: { utilization: 61, resets_at: '2026-05-17T20:00:00.000Z' },
          seven_day_opus: { utilization: 12, resets_at: null },
        },
        identity: { email: 'cli@example.test', organization: 'Acme', loginMethod: 'Claude Max' },
      });

      await service.maybeRefresh('test');

      const cached = service.getCached();
      expect(fetchFn).not.toHaveBeenCalled();
      expect(cliUsageProbe).toHaveBeenCalledWith(undefined);
      expect(cached.source).toBe('cli-usage');
      expect(cached.identity?.email).toBe('cli@example.test');
      expect(cached.rateLimits?.five_hour?.utilization).toBe(61);
      expect(cached.rateLimits?.seven_day_opus?.utilization).toBe(12);
      expect(cached.lastError).toBeNull();
      expect(['oauth-file', 'oauth-keychain']).toContain(cached.attempts[0].source);
      expect(cached.attempts[0]).toEqual(expect.objectContaining({ ok: false, error: expect.any(String) }));
      expect(cached.attempts[1]).toEqual(expect.objectContaining({ source: 'cli-usage', ok: true, error: null }));
    });

    test('falls back to Claude CLI usage when OAuth token lacks user:profile scope', async () => {
      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, content: validCredsJson({ scopes: ['user:inference'] }) }]);
      const fetchFn = mockFetchOk(USAGE_BODY);
      cliUsageProbe.mockResolvedValueOnce({
        rateLimits: { five_hour: { utilization: 22, resets_at: null } },
        identity: null,
      });

      await service.maybeRefresh('test');

      const cached = service.getCached();
      expect(fetchFn).not.toHaveBeenCalled();
      expect(cached.source).toBe('cli-usage');
      expect(cached.rateLimits?.five_hour?.utilization).toBe(22);
      expect(cached.attempts[0]).toEqual(expect.objectContaining({
        source: 'oauth-file',
        ok: false,
        error: 'oauth-token-missing-user-profile-scope',
      }));
    });

    test('preserves unknown OAuth buckets and null windows', async () => {
      const body = {
        five_hour: null,
        seven_day_omelette: { utilization: 44, resets_at: null },
        enterprise_bucket: null,
        extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 2500, utilization: 25, currency: 'USD' },
      };
      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, content: validCredsJson() }]);
      mockFetchOk(body);

      await service.maybeRefresh('test');

      const cached = service.getCached();
      expect(cached.rateLimits?.five_hour).toBeNull();
      expect(cached.rateLimits?.seven_day_omelette).toEqual({ utilization: 44, resets_at: null });
      expect(cached.rateLimits?.enterprise_bucket).toBeNull();
      expect(cached.rateLimits?.extra_usage?.currency).toBe('USD');
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

    test('keeps per-profile throttle independent from the default cache', async () => {
      const profileConfigDir = path.join(tmpDir, 'profile-home');
      const profile = makeClaudeProfile({ id: 'profile-independent', configDir: profileConfigDir });
      readSpy = mockReadFile([
        { path: CREDENTIALS_PATH, content: validCredsJson({ accessToken: 'server-token', rateLimitTier: 'server' }) },
        { path: path.join(profileConfigDir, '.credentials.json'), content: validCredsJson({ accessToken: 'profile-token', rateLimitTier: 'profile' }) },
      ]);
      const fetchFn = mockFetchOk(USAGE_BODY);

      await service.maybeRefresh('default');
      await service.maybeRefresh('profile', profile);
      await service.maybeRefresh('profile-throttled', profile);

      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer server-token');
      expect(fetchFn.mock.calls[1][1].headers.Authorization).toBe('Bearer profile-token');
      expect(service.getCached().planTier).toBe('server');
      expect(service.getCached(profile).planTier).toBe('profile');
    });

    test('coalesces concurrent per-profile refreshes through the profile in-flight map', async () => {
      const profileConfigDir = path.join(tmpDir, 'profile-home');
      const profile = makeClaudeProfile({ id: 'profile-coalesced', configDir: profileConfigDir });
      readSpy = mockReadFile([
        { path: path.join(profileConfigDir, '.credentials.json'), content: validCredsJson({ accessToken: 'profile-token' }) },
      ]);
      let resolveFetch: ((value: unknown) => void) | null = null;
      const fetchFn = jest.fn().mockImplementation(() => new Promise(resolve => {
        resolveFetch = resolve;
      }));
      (global as any).fetch = fetchFn;

      const refreshes = Promise.all([
        service.maybeRefresh('profile-a', profile),
        service.maybeRefresh('profile-b', profile),
        service.maybeRefresh('profile-c', profile),
      ]);
      await new Promise(resolve => setImmediate(resolve));
      expect(fetchFn).toHaveBeenCalledTimes(1);

      resolveFetch!({
        ok: true,
        status: 200,
        json: async () => USAGE_BODY,
        text: async () => JSON.stringify(USAGE_BODY),
      });
      await refreshes;

      expect(service.getCached(profile).rateLimits).toEqual(USAGE_BODY);
    });

    test('marks token-expired without calling fetch', async () => {
      const expired = Date.now() - 1000;
      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, content: validCredsJson({ expiresAt: expired }) }]);
      const fetchFn = mockFetchOk(USAGE_BODY);

      await service.maybeRefresh('test');
      expect(fetchFn).not.toHaveBeenCalled();
      expect(cliUsageProbe).toHaveBeenCalledTimes(1);
      expect(service.getCached().lastError).toContain('token-expired');
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
      expect(service.getCached().lastError).toContain('token-expired');

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

    test('caps attempt history at eight entries across repeated failures', async () => {
      const expired = Date.now() - 1000;
      readSpy = mockReadFile([{ path: CREDENTIALS_PATH, content: validCredsJson({ expiresAt: expired }) }]);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      for (let index = 0; index < 5; index += 1) {
        await service.maybeRefresh(`expired-${index}`);
      }

      const cached = service.getCached();
      expect(cached.attempts).toHaveLength(8);
      expect(cached.attempts.every(attempt => attempt.ok === false)).toBe(true);
      expect(cached.attempts.map(attempt => attempt.source)).toEqual([
        'oauth-file',
        'cli-usage',
        'oauth-file',
        'cli-usage',
        'oauth-file',
        'cli-usage',
        'oauth-file',
        'cli-usage',
      ]);
      expect(cached.lastError).toContain('token-expired');
      warn.mockRestore();
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
      expect(cached.lastError).toMatch(/oauth failed: usage API 401/);
      expect(cached.lastError).toMatch(/cli-usage failed: cli unavailable/);
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
      expect(cached.lastError).toBe('oauth failed: ENETDOWN; cli-usage failed: cli unavailable');
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
      expect(service.getCached().source).toBe('oauth-keychain');
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
      expect(service.getCached().lastError).toMatch(/cli-usage failed: cli unavailable/);
      warn.mockRestore();
    });
  });

  describe('Claude CLI usage parser', () => {
    test('extracts session and weekly usage plus status identity from terminal text', () => {
      const now = new Date('2026-05-17T12:00:00.000Z');
      const parsed = parseClaudeCliUsageOutput(`
        /usage
        Current session
        39% remaining
        Resets in 2 hours

        Current week
        77% used
        Resets Nov 21 at 5am

        Current week (Opus)
        12% used
        Resets in 2 days

        /status
        Account: daron@example.test
        Organization: Agent Cockpit
        Login Method: Claude Max
      `, now);

      expect(parsed.rateLimits?.five_hour?.utilization).toBe(61);
      expect(parsed.rateLimits?.five_hour?.resets_at).toBe('2026-05-17T14:00:00.000Z');
      expect(parsed.rateLimits?.seven_day?.utilization).toBe(77);
      expect(parsed.rateLimits?.seven_day_opus?.utilization).toBe(12);
      expect(parsed.identity).toEqual({
        email: 'daron@example.test',
        organization: 'Agent Cockpit',
        loginMethod: 'Claude Max',
      });
    });

    test('extracts quota windows from Claude terminal output with collapsed spacing', () => {
      const now = new Date('2026-05-17T15:00:00.000Z');
      const parsed = parseClaudeCliUsageOutput(`
        Settings  StausConfigUsageStats
        Currentsession
        █▌3%used
        Resets3:40pm(America/Los_Angeles)

        Currentweek(allmodels)
        █2%used
        ResetsMay19at12pm(America/Los_Angeles)
      `, now);

      expect(parsed.rateLimits?.five_hour?.utilization).toBe(3);
      expect(parsed.rateLimits?.five_hour?.resets_at).toBe('2026-05-17T22:40:00.000Z');
      expect(parsed.rateLimits?.seven_day?.utilization).toBe(2);
      expect(parsed.rateLimits?.seven_day?.resets_at).toBe('2026-05-19T19:00:00.000Z');
    });

    test('extracts Sonnet weekly windows and minute-relative reset descriptions', () => {
      const now = new Date('2026-05-17T12:00:00.000Z');
      const parsed = parseClaudeCliUsageOutput(`
        Current week Sonnet
        40% used
        Resets in 15 minutes
      `, now);

      expect(parsed.rateLimits?.seven_day_sonnet).toEqual({
        utilization: 40,
        resets_at: '2026-05-17T12:15:00.000Z',
      });
    });

    test('rolls past month/day and time-only reset descriptions forward', () => {
      const monthReset = parseClaudeCliUsageOutput(`
        Current week
        50% used
        Resets Jan 1 at 5am (America/Los_Angeles)
      `, new Date('2026-12-01T12:00:00.000Z'));
      const timeReset = parseClaudeCliUsageOutput(`
        Current session
        25% used
        Resets 4am (America/Los_Angeles)
      `, new Date('2026-05-17T12:00:00.000Z'));

      expect(monthReset.rateLimits?.seven_day?.resets_at).toBe('2027-01-01T13:00:00.000Z');
      expect(timeReset.rateLimits?.five_hour?.resets_at).toBe('2026-05-18T11:00:00.000Z');
    });

    test('returns null usage data when no usage or identity is present', () => {
      const parsed = parseClaudeCliUsageOutput('Welcome to Claude Code\nNo usage information here');

      expect(parsed).toEqual({ rateLimits: null, identity: null });
    });

    test('keeps utilization while leaving unparseable resets null', () => {
      const parsed = parseClaudeCliUsageOutput(`
        Current session
        50% used
        Resets eventually
      `);

      expect(parsed.rateLimits?.five_hour).toEqual({
        utilization: 50,
        resets_at: null,
      });
    });

    test('inverts percent-left values and clamps utilization to 0..100', () => {
      const parsed = parseClaudeCliUsageOutput(`
        Current session
        120% remaining

        Current week
        150% used
      `);

      expect(parsed.rateLimits?.five_hour?.utilization).toBe(0);
      expect(parsed.rateLimits?.seven_day?.utilization).toBe(100);
    });
  });
});
