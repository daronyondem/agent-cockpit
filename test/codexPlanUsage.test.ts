import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

// Mock child_process.spawn before importing the service.
const mockSpawnFn = jest.fn();
jest.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawnFn(...args),
}));

import { CodexPlanUsageService } from '../src/services/codexPlanUsageService';

// ── Mock app-server proc ───────────────────────────────────────────────────
//
// CodexPlanUsageService spawns `codex app-server` and speaks JSON-RPC over its
// stdio. We don't have the real binary in CI, so we fake a minimal proc that
// replies to recognized methods. Stdout is line-delimited JSON-RPC and stdin
// is parsed the same way to dispatch responses.

interface MockOpts {
  /** method name → result object (already in the inner shape, e.g. `{ account: {...} }`) */
  responses?: Record<string, unknown>;
  /** method name → error message (RPC-level error reply) */
  errors?: Record<string, string>;
  /** simulate `codex` not on PATH */
  spawnError?: NodeJS.ErrnoException;
}

class MockProc extends EventEmitter {
  stdin: { write: (data: string) => boolean };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  exitCode: number | null = null;

  constructor(opts: MockOpts) {
    super();
    let buffer = '';
    this.stdin = {
      write: (data: string) => {
        buffer += data;
        const lines = buffer.split('\n');
        buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: { id?: number; method?: string };
          try { msg = JSON.parse(line); } catch { continue; }
          if (!msg.method) continue;
          const respond = (payload: object) => {
            setImmediate(() => {
              this.stdout.emit('data', Buffer.from(JSON.stringify(payload) + '\n'));
            });
          };
          if (opts.errors && opts.errors[msg.method]) {
            respond({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: opts.errors[msg.method] } });
          } else if (opts.responses && msg.method in opts.responses) {
            respond({ jsonrpc: '2.0', id: msg.id, result: opts.responses[msg.method] });
          }
        }
        return true;
      },
    };
  }

  kill(_sig?: string): void {
    if (this.killed) return;
    this.killed = true;
    this.exitCode = -15;
    setImmediate(() => this.emit('close'));
  }
}

function setupMockProc(opts: MockOpts): MockProc {
  const proc = new MockProc(opts);
  mockSpawnFn.mockImplementationOnce(() => {
    if (opts.spawnError) {
      setImmediate(() => proc.emit('error', opts.spawnError));
    }
    return proc;
  });
  return proc;
}

const ACCOUNT_RESULT = {
  account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' },
};

const RATE_LIMITS_RESULT = {
  rateLimits: {
    limitId: 'global',
    limitName: 'main',
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1777593600 },
    secondary: { usedPercent: 6, windowDurationMins: 10080, resetsAt: 1778025600 },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    planType: 'pro',
    rateLimitReachedType: null,
  },
};

function writeAuthJson(codexHome: string, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
    tokens: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      id_token: makeJwt({
        email: 'jwt@example.com',
        'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
      }),
      account_id: 'account-123',
    },
    last_refresh: new Date().toISOString(),
    ...overrides,
  }), 'utf8');
}

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(payload)}.`;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CodexPlanUsageService', () => {
  let tmpDir: string;
  let service: CodexPlanUsageService;
  let originalCodexHome: string | undefined;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plan-usage-'));
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(tmpDir, 'codex-home');
    originalFetch = global.fetch;
    service = new CodexPlanUsageService(tmpDir);
    mockSpawnFn.mockReset();
  });

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    global.fetch = originalFetch;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('stores cache files under a custom data root', () => {
    const dataRoot = path.join(tmpDir, 'external-data');
    const custom = new CodexPlanUsageService(tmpDir, { dataRoot });

    expect((custom as any)._cacheFile).toBe(path.join(dataRoot, 'codex-plan-usage.json'));
    expect((custom as any)._profileCacheDir).toBe(path.join(dataRoot, 'codex-plan-usage'));
  });

  // ── init ─────────────────────────────────────────────────────────────────

  describe('init', () => {
    test('starts with empty snapshot when no cache file', async () => {
      await service.init();
      const cached = service.getCached();
      expect(cached.fetchedAt).toBeNull();
      expect(cached.account).toBeNull();
      expect(cached.rateLimits).toBeNull();
      expect(cached.lastError).toBeNull();
      expect(cached.stale).toBe(true);
    });

    test('loads persisted snapshot from disk', async () => {
      const cacheFile = path.join(tmpDir, 'data', 'codex-plan-usage.json');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const snapshot = {
        fetchedAt: new Date().toISOString(),
        account: { type: 'chatgpt', email: 'u@e.com', planType: 'pro' },
        rateLimits: null,
        lastError: null,
      };
      fs.writeFileSync(cacheFile, JSON.stringify(snapshot), 'utf8');
      await service.init();
      const cached = service.getCached();
      expect(cached.account?.planType).toBe('pro');
      expect(cached.stale).toBe(false);
    });

    test('tolerates corrupt cache file without throwing', async () => {
      const cacheFile = path.join(tmpDir, 'data', 'codex-plan-usage.json');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, 'not json', 'utf8');
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(service.init()).resolves.toBeUndefined();
      expect(service.getCached().fetchedAt).toBeNull();
      warn.mockRestore();
    });
  });

  // ── getCached staleness ─────────────────────────────────────────────────

  describe('getCached', () => {
    test('marks stale=true when fetchedAt older than 15 min', async () => {
      const cacheFile = path.join(tmpDir, 'data', 'codex-plan-usage.json');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({
        fetchedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        account: null,
        rateLimits: null,
        lastError: null,
      }), 'utf8');
      await service.init();
      expect(service.getCached().stale).toBe(true);
    });

    test('marks stale=false when fetchedAt is recent', async () => {
      const cacheFile = path.join(tmpDir, 'data', 'codex-plan-usage.json');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({
        fetchedAt: new Date(Date.now() - 30_000).toISOString(),
        account: null,
        rateLimits: null,
        lastError: null,
      }), 'utf8');
      await service.init();
      expect(service.getCached().stale).toBe(false);
    });
  });

  // ── maybeRefresh ─────────────────────────────────────────────────────────

  describe('maybeRefresh', () => {
    test('spawns app-server, runs RPCs, normalizes, persists', async () => {
      const proc = setupMockProc({
        responses: {
          initialize: {},
          'account/read': ACCOUNT_RESULT,
          'account/rateLimits/read': RATE_LIMITS_RESULT,
        },
      });
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});

      await service.maybeRefresh('test');
      const cached = service.getCached();

      expect(mockSpawnFn).toHaveBeenCalledWith('codex', ['-s', 'read-only', '-a', 'untrusted', 'app-server'], expect.any(Object));
      expect(cached.lastError).toBeNull();
      expect(cached.fetchedAt).not.toBeNull();
      expect(cached.account?.planType).toBe('pro');
      expect(cached.account?.email).toBe('user@example.com');
      expect(cached.rateLimits?.primary?.usedPercent).toBe(12);
      expect(cached.rateLimits?.primary?.windowDurationMins).toBe(300);
      expect(cached.rateLimits?.secondary?.usedPercent).toBe(6);
      expect(cached.rateLimits?.secondary?.windowDurationMins).toBe(10080);
      expect(cached.rateLimits?.credits?.hasCredits).toBe(false);

      // Process is killed once fetch completes.
      expect(proc.killed).toBe(true);

      // Persisted on disk.
      const cacheFile = path.join(tmpDir, 'data', 'codex-plan-usage.json');
      const onDisk = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      expect(onDisk.account.planType).toBe('pro');
      expect(onDisk.rateLimits.primary.windowDurationMins).toBe(300);
      log.mockRestore();
    });

    test('uses direct OAuth usage API before spawning app-server', async () => {
      writeAuthJson(process.env.CODEX_HOME!);
      global.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({
          plan_type: 'pro',
          rate_limit: {
            primary_window: { used_percent: 22, limit_window_seconds: 18_000, reset_at: 1777593600 },
            secondary_window: { used_percent: 31, limit_window_seconds: 604_800, reset_at: 1778025600 },
          },
          credits: { has_credits: true, unlimited: false, balance: 12.5 },
        }),
      } as Response));
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});

      await service.maybeRefresh('oauth');
      const cached = service.getCached();

      expect(mockSpawnFn).not.toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
          'ChatGPT-Account-Id': 'account-123',
        }),
      }));
      expect(cached.account).toEqual({ type: 'chatgpt', email: 'jwt@example.com', planType: 'pro' });
      expect(cached.rateLimits?.primary?.usedPercent).toBe(22);
      expect(cached.rateLimits?.primary?.windowDurationMins).toBe(300);
      expect(cached.rateLimits?.secondary?.windowDurationMins).toBe(10080);
      expect(cached.rateLimits?.credits?.balance).toBe('12.5');
      log.mockRestore();
    });

    test('refreshes stale OAuth token before usage API fetch', async () => {
      writeAuthJson(process.env.CODEX_HOME!, {
        last_refresh: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
      });
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            id_token: makeJwt({ email: 'refreshed@example.com' }),
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            plan_type: 'plus',
            rate_limit: {
              primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: 1777593600 },
            },
          }),
        });
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});

      await service.maybeRefresh('oauth-refresh');
      const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME!, 'auth.json'), 'utf8'));

      expect(global.fetch).toHaveBeenNthCalledWith(1, 'https://auth.openai.com/oauth/token', expect.objectContaining({
        method: 'POST',
      }));
      expect(global.fetch).toHaveBeenNthCalledWith(2, 'https://chatgpt.com/backend-api/wham/usage', expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer new-access-token' }),
      }));
      expect(onDisk.tokens.access_token).toBe('new-access-token');
      expect(onDisk.tokens.refresh_token).toBe('new-refresh-token');
      expect(service.getCached().account?.email).toBe('refreshed@example.com');
      log.mockRestore();
    });

    test('throttles second call within 10 min', async () => {
      setupMockProc({
        responses: {
          initialize: {},
          'account/read': ACCOUNT_RESULT,
          'account/rateLimits/read': RATE_LIMITS_RESULT,
        },
      });
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});

      await service.maybeRefresh('first');
      await service.maybeRefresh('second');
      expect(mockSpawnFn).toHaveBeenCalledTimes(1);
      log.mockRestore();
    });

    test('coalesces concurrent refresh calls via in-flight promise', async () => {
      setupMockProc({
        responses: {
          initialize: {},
          'account/read': ACCOUNT_RESULT,
          'account/rateLimits/read': RATE_LIMITS_RESULT,
        },
      });
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});

      await Promise.all([
        service.maybeRefresh('a'),
        service.maybeRefresh('b'),
        service.maybeRefresh('c'),
      ]);
      expect(mockSpawnFn).toHaveBeenCalledTimes(1);
      log.mockRestore();
    });

    test('records lastError when codex CLI is not installed (ENOENT)', async () => {
      const enoent = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
      setupMockProc({ spawnError: enoent });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await service.maybeRefresh('test');
      expect(service.getCached().lastError).toMatch(/codex app-server unavailable/);
      warn.mockRestore();
    });

    test('records lastError on RPC failure, preserves prior snapshot', async () => {
      // Seed prior good snapshot so we can verify it survives a failed refresh.
      const cacheFile = path.join(tmpDir, 'data', 'codex-plan-usage.json');
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const priorAccount = { type: 'chatgpt', email: 'u@e.com', planType: 'plus' };
      fs.writeFileSync(cacheFile, JSON.stringify({
        fetchedAt: new Date(Date.now() - 60_000).toISOString(),
        account: priorAccount,
        rateLimits: null,
        lastError: null,
      }), 'utf8');
      await service.init();

      setupMockProc({
        responses: { initialize: {}, 'account/read': ACCOUNT_RESULT },
        errors: { 'account/rateLimits/read': 'auth required' },
      });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await service.maybeRefresh('test');
      const cached = service.getCached();
      expect(cached.lastError).toMatch(/auth required/);
      // Prior data preserved.
      expect(cached.account?.planType).toBe('plus');
      warn.mockRestore();
    });

    test('normalizes missing account gracefully', async () => {
      setupMockProc({
        responses: {
          initialize: {},
          'account/read': {}, // no `account` key
          'account/rateLimits/read': RATE_LIMITS_RESULT,
        },
      });
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});

      await service.maybeRefresh('test');
      const cached = service.getCached();
      expect(cached.account).toBeNull();
      expect(cached.rateLimits?.primary?.usedPercent).toBe(12);
      log.mockRestore();
    });

    test('normalizes missing rateLimits gracefully', async () => {
      setupMockProc({
        responses: {
          initialize: {},
          'account/read': ACCOUNT_RESULT,
          'account/rateLimits/read': {}, // no `rateLimits` key
        },
      });
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});

      await service.maybeRefresh('test');
      const cached = service.getCached();
      expect(cached.rateLimits).toBeNull();
      expect(cached.account?.planType).toBe('pro');
      log.mockRestore();
    });

    test('uses Codex profile command/env and stores profile cache separately', async () => {
      setupMockProc({
        responses: {
          initialize: {},
          'account/read': ACCOUNT_RESULT,
          'account/rateLimits/read': RATE_LIMITS_RESULT,
        },
      });
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      const profile = {
        id: 'profile-codex-work',
        name: 'Codex Work',
        vendor: 'codex' as const,
        command: '/opt/codex/bin/codex',
        authMode: 'account' as const,
        configDir: '/tmp/codex-work-home',
        env: { OPENAI_BASE_URL: 'https://example.test' },
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      };

      await service.maybeRefresh('profile-test', profile);
      const cached = service.getCached(profile);

      expect(mockSpawnFn).toHaveBeenCalledWith('/opt/codex/bin/codex', ['-s', 'read-only', '-a', 'untrusted', 'app-server'], expect.objectContaining({
        env: expect.objectContaining({
          CODEX_HOME: '/tmp/codex-work-home',
          OPENAI_BASE_URL: 'https://example.test',
        }),
      }));
      expect(cached.account?.email).toBe('user@example.com');
      expect(service.getCached().account).toBeNull();

      const profileCache = path.join(tmpDir, 'data', 'codex-plan-usage', 'profile-codex-work.json');
      const onDisk = JSON.parse(fs.readFileSync(profileCache, 'utf8'));
      expect(onDisk.account.email).toBe('user@example.com');
      log.mockRestore();
    });

    test('plain server-configured profile uses the default cache', async () => {
      setupMockProc({
        responses: {
          initialize: {},
          'account/read': ACCOUNT_RESULT,
          'account/rateLimits/read': RATE_LIMITS_RESULT,
        },
      });
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      const profile = {
        id: 'server-configured-codex',
        name: 'Codex (Server Configured)',
        vendor: 'codex' as const,
        authMode: 'server-configured' as const,
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      };

      await service.maybeRefresh('default-cache', profile);
      const cached = service.getCached(profile);

      expect(cached.account?.email).toBe('user@example.com');
      expect(service.getCached().account?.email).toBe('user@example.com');
      expect(fs.existsSync(path.join(tmpDir, 'data', 'codex-plan-usage', 'server-configured-codex.json'))).toBe(false);
      log.mockRestore();
    });

    test('recovers rate limits from Codex RPC error body', async () => {
      setupMockProc({
        responses: {
          initialize: {},
          'account/read': {},
        },
        errors: {
          'account/rateLimits/read': `
            failed to fetch codex rate limits: Decode error;
            body={
              "email": "body@example.com",
              "plan_type": "prolite",
              "rate_limit": {
                "primary_window": {
                  "used_percent": 4,
                  "limit_window_seconds": 18000,
                  "reset_at": 1776216359
                },
                "secondary_window": {
                  "used_percent": 19,
                  "limit_window_seconds": 604800,
                  "reset_at": 1776395384
                }
              },
              "credits": {
                "has_credits": false,
                "unlimited": false,
                "balance": "0E-10"
              }
            }`,
        },
      });
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});

      await service.maybeRefresh('recover-body');
      const cached = service.getCached();

      expect(cached.lastError).toBeNull();
      expect(cached.account?.email).toBe('body@example.com');
      expect(cached.account?.planType).toBe('prolite');
      expect(cached.rateLimits?.primary?.usedPercent).toBe(4);
      expect(cached.rateLimits?.primary?.windowDurationMins).toBe(300);
      expect(cached.rateLimits?.secondary?.usedPercent).toBe(19);
      expect(cached.rateLimits?.credits?.balance).toBe('0E-10');
      log.mockRestore();
    });

    test('normalizes weekly-only rate limit into secondary slot', async () => {
      setupMockProc({
        responses: {
          initialize: {},
          'account/read': ACCOUNT_RESULT,
          'account/rateLimits/read': {
            rateLimits: {
              ...RATE_LIMITS_RESULT.rateLimits,
              primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1778025600 },
              secondary: null,
            },
          },
        },
      });
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});

      await service.maybeRefresh('weekly-only');
      const cached = service.getCached();

      expect(cached.rateLimits?.primary).toBeNull();
      expect(cached.rateLimits?.secondary?.usedPercent).toBe(5);
      expect(cached.rateLimits?.secondary?.windowDurationMins).toBe(10080);
      log.mockRestore();
    });

    test('normalizes reversed weekly and session windows', async () => {
      setupMockProc({
        responses: {
          initialize: {},
          'account/read': ACCOUNT_RESULT,
          'account/rateLimits/read': {
            rateLimits: {
              ...RATE_LIMITS_RESULT.rateLimits,
              primary: { usedPercent: 43, windowDurationMins: 10080, resetsAt: 1778025600 },
              secondary: { usedPercent: 17, windowDurationMins: 300, resetsAt: 1777593600 },
            },
          },
        },
      });
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});

      await service.maybeRefresh('reversed-windows');
      const cached = service.getCached();

      expect(cached.rateLimits?.primary?.usedPercent).toBe(17);
      expect(cached.rateLimits?.primary?.windowDurationMins).toBe(300);
      expect(cached.rateLimits?.secondary?.usedPercent).toBe(43);
      expect(cached.rateLimits?.secondary?.windowDurationMins).toBe(10080);
      log.mockRestore();
    });

    test('times out a hung RPC method within the request budget', async () => {
      service = new CodexPlanUsageService(tmpDir, { rpcRequestTimeoutMs: 25 });
      const proc = setupMockProc({
        responses: {
          initialize: {},
          'account/read': ACCOUNT_RESULT,
          // no account/rateLimits/read response
        },
      });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await service.maybeRefresh('timeout');
      const cached = service.getCached();

      expect(cached.lastError).toBe('codex RPC timed out waiting for account/rateLimits/read');
      expect(proc.killed).toBe(true);
      warn.mockRestore();
    });
  });
});
