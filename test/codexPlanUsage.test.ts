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

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CodexPlanUsageService', () => {
  let tmpDir: string;
  let service: CodexPlanUsageService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plan-usage-'));
    service = new CodexPlanUsageService(tmpDir);
    mockSpawnFn.mockReset();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
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

      expect(mockSpawnFn).toHaveBeenCalledWith('codex', ['app-server'], expect.any(Object));
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
        responses: { initialize: {} },
        errors: { 'account/read': 'auth required' },
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

      expect(mockSpawnFn).toHaveBeenCalledWith('/opt/codex/bin/codex', ['app-server'], expect.objectContaining({
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
  });
});
