import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { KiroPlanUsageService } from '../src/services/kiroPlanUsageService';

// ── Fixture helpers ────────────────────────────────────────────────────────

const PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:713669222412:profile/7KHC74QYC9PQ';

function createKiroDb(dbPath: string, opts: {
  accessToken?: string | null;
  expiresAt?: string | null;
  profileArn?: string | null;
  includeTokenRow?: boolean;
  includeProfileRow?: boolean;
} = {}): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE state   (key TEXT PRIMARY KEY, value BLOB);
  `);
  const includeToken = opts.includeTokenRow !== false;
  const includeProfile = opts.includeProfileRow !== false;
  if (includeToken) {
    const tokenBlob = JSON.stringify({
      access_token: opts.accessToken ?? 'aoaTEST',
      refresh_token: 'aorTEST',
      expires_at: opts.expiresAt ?? new Date(Date.now() + 10 * 60_000).toISOString(),
      region: 'us-east-1',
      oauth_flow: 'DeviceCode',
    });
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)').run('kirocli:odic:token', tokenBlob);
  }
  if (includeProfile) {
    const profileBlob = JSON.stringify({
      arn: opts.profileArn ?? PROFILE_ARN,
      profile_name: 'KiroProfile-us-east-1',
    });
    db.prepare('INSERT INTO state (key, value) VALUES (?, ?)').run('api.codewhisperer.profile', profileBlob);
  }
  db.close();
}

const USAGE_BODY = {
  nextDateReset: 1777593600,
  overageConfiguration: { overageStatus: 'ENABLED' },
  subscriptionInfo: {
    overageCapability: 'OVERAGE_CAPABLE',
    subscriptionManagementTarget: 'MANAGE',
    subscriptionTitle: 'KIRO POWER',
    type: 'Q_DEVELOPER_STANDALONE_POWER',
    upgradeCapability: 'UPGRADE_INCAPABLE',
  },
  usageBreakdownList: [
    {
      bonuses: [],
      currency: 'USD',
      currentOverages: 0,
      currentOveragesWithPrecision: 0.0,
      currentUsage: 335,
      currentUsageWithPrecision: 335.27,
      displayName: 'Credit',
      displayNamePlural: 'Credits',
      nextDateReset: 1777593600,
      overageCap: 200000,
      overageCapWithPrecision: 200000.0,
      overageCharges: 0.0,
      overageRate: 0.04,
      resourceType: 'CREDIT',
      unit: 'INVOCATIONS',
      usageLimit: 10000,
      usageLimitWithPrecision: 10000.0,
    },
  ],
  userInfo: { userId: 'd-9067925563.test' },
};

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

// ── Tests ──────────────────────────────────────────────────────────────────

describe('KiroPlanUsageService', () => {
  let tmpDir: string;
  let dbPath: string;
  let service: KiroPlanUsageService;
  const originalFetch = (global as any).fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-plan-usage-'));
    dbPath = path.join(tmpDir, 'kiro-cli.sqlite3');
    service = new KiroPlanUsageService(tmpDir, { dbPath });
  });

  afterEach(() => {
    (global as any).fetch = originalFetch;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── init ──────────────────────────────────────────────────────────────

  describe('init', () => {
    test('starts with empty snapshot when no cache file', async () => {
      await service.init();
      const cached = service.getCached();
      expect(cached.fetchedAt).toBeNull();
      expect(cached.usage).toBeNull();
      expect(cached.stale).toBe(true);
      expect(cached.lastError).toBeNull();
    });

    test('loads persisted snapshot from disk', async () => {
      const cacheFile = path.join(tmpDir, 'data', 'kiro-plan-usage.json');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const snapshot = {
        fetchedAt: new Date().toISOString(),
        usage: {
          subscription: { subscriptionTitle: 'KIRO POWER', type: 'Q_DEVELOPER_STANDALONE_POWER',
            overageCapability: 'OVERAGE_CAPABLE', upgradeCapability: 'UPGRADE_INCAPABLE',
            subscriptionManagementTarget: 'MANAGE' },
          overageStatus: 'ENABLED',
          nextDateReset: 1777593600,
          breakdown: null,
        },
        lastError: null,
      };
      fs.writeFileSync(cacheFile, JSON.stringify(snapshot), 'utf8');

      await service.init();
      const cached = service.getCached();
      expect(cached.usage?.subscription?.subscriptionTitle).toBe('KIRO POWER');
      expect(cached.stale).toBe(false);
    });

    test('tolerates corrupt cache file without throwing', async () => {
      const cacheFile = path.join(tmpDir, 'data', 'kiro-plan-usage.json');
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
      const cacheFile = path.join(tmpDir, 'data', 'kiro-plan-usage.json');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const oldIso = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      fs.writeFileSync(cacheFile, JSON.stringify({
        fetchedAt: oldIso, usage: null, lastError: null,
      }), 'utf8');
      await service.init();
      expect(service.getCached().stale).toBe(true);
    });

    test('marks stale=false when fetchedAt is recent', async () => {
      const cacheFile = path.join(tmpDir, 'data', 'kiro-plan-usage.json');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({
        fetchedAt: new Date(Date.now() - 30_000).toISOString(),
        usage: null, lastError: null,
      }), 'utf8');
      await service.init();
      expect(service.getCached().stale).toBe(false);
    });
  });

  // ── maybeRefresh ──────────────────────────────────────────────────────

  describe('maybeRefresh', () => {
    test('fetches, normalizes, persists, and clears errors', async () => {
      createKiroDb(dbPath);
      const fetchFn = mockFetchOk(USAGE_BODY);

      await service.maybeRefresh('test');
      const cached = service.getCached();

      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(cached.lastError).toBeNull();
      expect(cached.fetchedAt).not.toBeNull();
      expect(cached.usage?.subscription?.subscriptionTitle).toBe('KIRO POWER');
      expect(cached.usage?.overageStatus).toBe('ENABLED');
      expect(cached.usage?.breakdown?.currentUsage).toBe(335);
      expect(cached.usage?.breakdown?.currentUsageWithPrecision).toBe(335.27);
      expect(cached.usage?.breakdown?.usageLimit).toBe(10000);
      expect(cached.usage?.breakdown?.overageCap).toBe(200000);
      expect(cached.usage?.breakdown?.bonuses).toEqual([]);

      // Persisted on disk
      const cacheFile = path.join(tmpDir, 'data', 'kiro-plan-usage.json');
      const onDisk = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      expect(onDisk.usage.subscription.subscriptionTitle).toBe('KIRO POWER');
    });

    test('sends bearer token, x-amz-target, and url-encoded profileArn', async () => {
      createKiroDb(dbPath, { accessToken: 'my-bearer' });
      const fetchFn = mockFetchOk(USAGE_BODY);

      await service.maybeRefresh('test');
      const [url, opts] = fetchFn.mock.calls[0];
      expect(url).toContain('q.us-east-1.amazonaws.com');
      expect(url).toContain('profileArn=' + encodeURIComponent(PROFILE_ARN));
      expect(url).toContain('origin=KIRO_CLI');
      expect(opts.headers['Authorization']).toBe('Bearer my-bearer');
      expect(opts.headers['X-Amz-Target']).toBe('AmazonCodeWhispererService.GetUsageLimits');
      expect(opts.headers['Content-Type']).toBe('application/x-amz-json-1.0');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ profileArn: PROFILE_ARN, origin: 'KIRO_CLI' });
    });

    test('throttles second call within 10 min', async () => {
      createKiroDb(dbPath);
      const fetchFn = mockFetchOk(USAGE_BODY);

      await service.maybeRefresh('first');
      await service.maybeRefresh('second');
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    test('coalesces concurrent refresh calls via in-flight promise', async () => {
      createKiroDb(dbPath);
      const fetchFn = mockFetchOk(USAGE_BODY);

      await Promise.all([
        service.maybeRefresh('a'),
        service.maybeRefresh('b'),
        service.maybeRefresh('c'),
      ]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    test('marks token-expired without calling fetch', async () => {
      createKiroDb(dbPath, { expiresAt: new Date(Date.now() - 1000).toISOString() });
      const fetchFn = mockFetchOk(USAGE_BODY);

      await service.maybeRefresh('test');
      expect(fetchFn).not.toHaveBeenCalled();
      expect(service.getCached().lastError).toBe('token-expired');
    });

    test('token-expired skip does not burn the 10-min throttle', async () => {
      // First call: token expired → snapshot marked, no fetch. The throttle
      // must NOT engage — otherwise stale data persists for 10+ min after
      // kiro-cli has rotated to a fresh token.
      createKiroDb(dbPath, { expiresAt: new Date(Date.now() - 1000).toISOString() });
      const firstFetch = mockFetchOk(USAGE_BODY);
      await service.maybeRefresh('first');
      expect(firstFetch).not.toHaveBeenCalled();
      expect(service.getCached().lastError).toBe('token-expired');

      // Simulate kiro-cli rotating its IdC token: rebuild the DB with a valid one.
      fs.rmSync(dbPath);
      createKiroDb(dbPath, { expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
      const secondFetch = mockFetchOk(USAGE_BODY);

      // Second call right away should proceed (no throttle from the prior skip).
      await service.maybeRefresh('second');
      expect(secondFetch).toHaveBeenCalledTimes(1);
      expect(service.getCached().lastError).toBeNull();
      expect(service.getCached().usage?.breakdown?.usageLimit).toBe(10000);
    });

    test('records lastError when DB file is missing', async () => {
      // Don't create DB — kiro-cli not installed scenario.
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchFn = mockFetchOk(USAGE_BODY);

      await service.maybeRefresh('test');
      expect(fetchFn).not.toHaveBeenCalled();
      expect(service.getCached().lastError).toMatch(/kiro-cli DB unavailable/);
      warn.mockRestore();
    });

    test('records lastError when token row is missing', async () => {
      createKiroDb(dbPath, { includeTokenRow: false });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchFn = mockFetchOk(USAGE_BODY);

      await service.maybeRefresh('test');
      expect(fetchFn).not.toHaveBeenCalled();
      expect(service.getCached().lastError).toMatch(/missing access token/);
      warn.mockRestore();
    });

    test('records lastError when profile row is missing', async () => {
      createKiroDb(dbPath, { includeProfileRow: false });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchFn = mockFetchOk(USAGE_BODY);

      await service.maybeRefresh('test');
      expect(fetchFn).not.toHaveBeenCalled();
      expect(service.getCached().lastError).toMatch(/missing profile/);
      warn.mockRestore();
    });

    test('records lastError on HTTP 401, preserves prior snapshot', async () => {
      // Seed prior good snapshot
      const cacheFile = path.join(tmpDir, 'data', 'kiro-plan-usage.json');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const priorUsage = {
        subscription: { subscriptionTitle: 'KIRO POWER', type: 'Q_DEVELOPER_STANDALONE_POWER',
          overageCapability: 'OVERAGE_CAPABLE', upgradeCapability: 'UPGRADE_INCAPABLE',
          subscriptionManagementTarget: 'MANAGE' },
        overageStatus: 'ENABLED',
        nextDateReset: 1777593600,
        breakdown: null,
      };
      fs.writeFileSync(cacheFile, JSON.stringify({
        fetchedAt: new Date(Date.now() - 60_000).toISOString(),
        usage: priorUsage,
        lastError: null,
      }), 'utf8');
      await service.init();

      createKiroDb(dbPath);
      mockFetchStatus(401, 'unauthorized');
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await service.maybeRefresh('test');
      const cached = service.getCached();
      expect(cached.lastError).toMatch(/401/);
      // Prior data preserved
      expect(cached.usage?.subscription?.subscriptionTitle).toBe('KIRO POWER');
      warn.mockRestore();
    });

    test('records lastError on network failure, preserves prior snapshot', async () => {
      const cacheFile = path.join(tmpDir, 'data', 'kiro-plan-usage.json');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const priorUsage = {
        subscription: { subscriptionTitle: 'KIRO POWER', type: null,
          overageCapability: null, upgradeCapability: null, subscriptionManagementTarget: null },
        overageStatus: 'ENABLED',
        nextDateReset: null,
        breakdown: null,
      };
      fs.writeFileSync(cacheFile, JSON.stringify({
        fetchedAt: new Date(Date.now() - 60_000).toISOString(),
        usage: priorUsage,
        lastError: null,
      }), 'utf8');
      await service.init();

      createKiroDb(dbPath);
      mockFetchReject(new Error('ENETDOWN'));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await service.maybeRefresh('test');
      const cached = service.getCached();
      expect(cached.lastError).toBe('ENETDOWN');
      expect(cached.usage?.subscription?.subscriptionTitle).toBe('KIRO POWER');
      warn.mockRestore();
    });
  });
});
