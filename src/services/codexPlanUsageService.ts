import { spawn, type ChildProcess } from 'child_process';
import fsp from 'fs/promises';
import path from 'path';
import { atomicWriteFile } from '../utils/atomicWrite';
import type { CliProfile } from '../types';
import { resolveCodexCliRuntime } from './backends/codex';
import { buildCliCommandInvocation } from './cliCommandResolver';

// Codex's `app-server` exposes `account/read` and `account/rateLimits/read`
// over JSON-RPC. Both share the OAuth credentials in `~/.codex/auth.json`,
// so spawning a one-shot `codex app-server`, calling those two methods,
// and killing the process is enough to surface plan tier + 5h/weekly
// rate-limit utilization in the cockpit's ContextChip tooltip.

const REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000;
const STALE_AFTER_MS = 15 * 60 * 1000;
// Hard ceiling for the spawned app-server. The two RPCs are sub-second in
// practice; a stuck process gets SIGKILL'd at this point.
const REFRESH_TIMEOUT_MS = 15_000;
const PROCESS_KILL_GRACE_MS = 1_000;

export interface CodexAccount {
  type: string | null;
  email: string | null;
  planType: string | null;
}

export interface CodexRateLimitWindow {
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexRateLimits {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: CodexCredits | null;
  planType: string | null;
  rateLimitReachedType: string | null;
}

export interface CodexPlanUsageSnapshot {
  fetchedAt: string | null;
  account: CodexAccount | null;
  rateLimits: CodexRateLimits | null;
  lastError: string | null;
}

export interface CodexPlanUsageResponse extends CodexPlanUsageSnapshot {
  stale: boolean;
}

interface CodexPlanUsageServiceOptions {
  dataRoot?: string;
}

export class CodexPlanUsageService {
  private _cacheFile: string;
  private _profileCacheDir: string;
  private _snapshot: CodexPlanUsageSnapshot;
  private _lastAttemptAt = 0;
  private _inFlight: Promise<void> | null = null;
  private _profileSnapshots = new Map<string, CodexPlanUsageSnapshot>();
  private _profileLastAttemptAt = new Map<string, number>();
  private _profileInFlight = new Map<string, Promise<void>>();

  constructor(appRoot: string, options: CodexPlanUsageServiceOptions = {}) {
    const dataRoot = options.dataRoot || path.join(appRoot, 'data');
    this._cacheFile = path.join(dataRoot, 'codex-plan-usage.json');
    this._profileCacheDir = path.join(dataRoot, 'codex-plan-usage');
    this._snapshot = {
      fetchedAt: null,
      account: null,
      rateLimits: null,
      lastError: null,
    };
  }

  async init(): Promise<void> {
    this._snapshot = await this._loadSnapshot(this._cacheFile);
    await this._loadProfileSnapshots();
  }

  getCached(profile?: CliProfile): CodexPlanUsageResponse {
    if (!profile || this._usesDefaultCache(profile)) return this._withStale(this._snapshot);
    const snapshot = profile ? this._getProfileSnapshot(profile) : this._snapshot;
    return this._withStale(snapshot);
  }

  maybeRefresh(reason: string, profile?: CliProfile): Promise<void> {
    if (profile && !this._usesDefaultCache(profile)) return this._maybeRefreshProfile(reason, profile);
    const now = Date.now();
    if (this._inFlight) return this._inFlight;
    if (this._lastAttemptAt && now - this._lastAttemptAt < REFRESH_MIN_INTERVAL_MS) {
      return Promise.resolve();
    }
    this._lastAttemptAt = now;
    this._inFlight = this._refresh(reason).finally(() => {
      this._inFlight = null;
    });
    return this._inFlight;
  }

  private _withStale(snapshot: CodexPlanUsageSnapshot): CodexPlanUsageResponse {
    const now = Date.now();
    const fetchedAtMs = snapshot.fetchedAt
      ? new Date(snapshot.fetchedAt).getTime()
      : null;
    const stale = fetchedAtMs == null || now - fetchedAtMs > STALE_AFTER_MS;
    return { ...snapshot, stale };
  }

  private _emptySnapshot(): CodexPlanUsageSnapshot {
    return {
      fetchedAt: null,
      account: null,
      rateLimits: null,
      lastError: null,
    };
  }

  private _usesDefaultCache(profile: CliProfile): boolean {
    return profile.authMode === 'server-configured'
      && !profile.command
      && !profile.configDir
      && (!profile.env || Object.keys(profile.env).length === 0);
  }

  private _profileKey(profile: CliProfile): string {
    return encodeURIComponent(profile.id);
  }

  private _profileCacheFile(profile: CliProfile): string {
    return path.join(this._profileCacheDir, `${this._profileKey(profile)}.json`);
  }

  private _getProfileSnapshot(profile: CliProfile): CodexPlanUsageSnapshot {
    const key = this._profileKey(profile);
    let snapshot = this._profileSnapshots.get(key);
    if (!snapshot) {
      snapshot = this._emptySnapshot();
      this._profileSnapshots.set(key, snapshot);
    }
    return snapshot;
  }

  private async _loadSnapshot(file: string): Promise<CodexPlanUsageSnapshot> {
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : null,
        account: parsed.account ?? null,
        rateLimits: parsed.rateLimits ?? null,
        lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[codexPlanUsage] Failed to load cache:', (err as Error).message);
      }
      return this._emptySnapshot();
    }
  }

  private async _loadProfileSnapshots(): Promise<void> {
    try {
      const filenames = await fsp.readdir(this._profileCacheDir);
      for (const filename of filenames) {
        if (!filename.endsWith('.json')) continue;
        const key = filename.slice(0, -'.json'.length);
        const snapshot = await this._loadSnapshot(path.join(this._profileCacheDir, filename));
        this._profileSnapshots.set(key, snapshot);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[codexPlanUsage] Failed to load profile caches:', (err as Error).message);
      }
    }
  }

  private async _maybeRefreshProfile(reason: string, profile: CliProfile): Promise<void> {
    const key = this._profileKey(profile);
    const now = Date.now();
    const inFlight = this._profileInFlight.get(key);
    if (inFlight) return inFlight;
    const lastAttemptAt = this._profileLastAttemptAt.get(key) || 0;
    if (lastAttemptAt && now - lastAttemptAt < REFRESH_MIN_INTERVAL_MS) {
      return Promise.resolve();
    }
    this._profileLastAttemptAt.set(key, now);
    const promise = this._refreshProfile(reason, profile).finally(() => {
      this._profileInFlight.delete(key);
    });
    this._profileInFlight.set(key, promise);
    return promise;
  }

  private async _refresh(reason: string): Promise<void> {
    try {
      const { account, rateLimits } = await fetchFromAppServer();
      this._snapshot = {
        fetchedAt: new Date().toISOString(),
        account,
        rateLimits,
        lastError: null,
      };
      await this._persist();
      console.log(`[codexPlanUsage] refresh(${reason}) ok`);
    } catch (err: unknown) {
      const msg = (err as Error).message || String(err);
      this._snapshot = { ...this._snapshot, lastError: msg };
      await this._persist();
      console.warn(`[codexPlanUsage] refresh(${reason}) failed: ${msg}`);
    }
  }

  private async _refreshProfile(reason: string, profile: CliProfile): Promise<void> {
    const key = this._profileKey(profile);
    const file = this._profileCacheFile(profile);
    const current = this._profileSnapshots.get(key) || await this._loadSnapshot(file);
    try {
      const { account, rateLimits } = await fetchFromAppServer(profile);
      const next = {
        fetchedAt: new Date().toISOString(),
        account,
        rateLimits,
        lastError: null,
      };
      this._profileSnapshots.set(key, next);
      await this._persistSnapshot(file, next);
      console.log(`[codexPlanUsage] refresh(${reason}) ok profile=${profile.id}`);
    } catch (err: unknown) {
      const msg = (err as Error).message || String(err);
      const next = { ...current, lastError: msg };
      this._profileSnapshots.set(key, next);
      await this._persistSnapshot(file, next);
      console.warn(`[codexPlanUsage] refresh(${reason}) failed profile=${profile.id}: ${msg}`);
    }
  }

  private async _persist(): Promise<void> {
    await this._persistSnapshot(this._cacheFile, this._snapshot);
  }

  private async _persistSnapshot(file: string, snapshot: CodexPlanUsageSnapshot): Promise<void> {
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await atomicWriteFile(file, JSON.stringify(snapshot, null, 2));
    } catch (err: unknown) {
      console.warn('[codexPlanUsage] Failed to persist cache:', (err as Error).message);
    }
  }
}

interface FetchResult {
  account: CodexAccount | null;
  rateLimits: CodexRateLimits | null;
}

async function fetchFromAppServer(profile?: CliProfile): Promise<FetchResult> {
  const runtime = resolveCodexCliRuntime(profile);
  const invocation = buildCliCommandInvocation(runtime, ['app-server']);
  let proc: ChildProcess;
  try {
    proc = spawn(invocation.command, invocation.args, { stdio: ['pipe', 'pipe', 'pipe'], env: runtime.env });
  } catch (err: unknown) {
    throw new Error(`spawn ${runtime.displayCommand || runtime.command} app-server failed: ${(err as Error).message}`);
  }

  let spawnFailed: Error | null = null;
  proc.on('error', (err) => { spawnFailed = err; });

  // Hard kill if anything below hangs.
  const killTimer = setTimeout(() => {
    if (!proc.killed) proc.kill('SIGKILL');
  }, REFRESH_TIMEOUT_MS);

  try {
    // Yield once so the spawn `error` event has a chance to fire (ENOENT
    // when `codex` isn't installed) before we try to write to stdin.
    await new Promise<void>((r) => setImmediate(r));
    if (spawnFailed) {
      throw new Error(`${runtime.displayCommand || runtime.command} app-server unavailable: ${(spawnFailed as Error).message}`);
    }

    const client = new RpcClient(proc);
    await client.request('initialize', {
      clientInfo: { name: 'agent-cockpit', title: null, version: '1.0.0' },
      capabilities: null,
    });
    const [accountResult, rateLimitsResult] = await Promise.all([
      client.request('account/read', { refreshToken: false }),
      client.request('account/rateLimits/read'),
    ]);
    return {
      account: normalizeAccount(accountResult),
      rateLimits: normalizeRateLimits(rateLimitsResult),
    };
  } finally {
    clearTimeout(killTimer);
    if (!proc.killed) {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, PROCESS_KILL_GRACE_MS).unref();
    }
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class RpcClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }> = new Map();
  private buffer = '';
  private closed = false;

  constructor(proc: ChildProcess) {
    this.proc = proc;
    proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if ('id' in msg && msg.id != null && !('method' in msg)) {
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              if (msg.error) p.reject(new Error(msg.error.message));
              else p.resolve(msg.result);
            }
          }
        } catch {
          // Non-JSON or partial line — ignore. Notifications and
          // server-to-client requests are dropped on the floor; we only
          // care about responses to our own requests.
        }
      }
    });
    proc.on('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error('codex app-server closed'));
      this.pending.clear();
    });
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('codex app-server is closed'));
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin!.write(JSON.stringify(msg) + '\n');
    });
  }
}

function normalizeAccount(raw: unknown): CodexAccount | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const acct = r.account as Record<string, unknown> | undefined;
  if (!acct || typeof acct !== 'object') return null;
  return {
    type: strOrNull(acct.type),
    email: strOrNull(acct.email),
    planType: strOrNull(acct.planType),
  };
}

function normalizeRateLimits(raw: unknown): CodexRateLimits | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rl = r.rateLimits as Record<string, unknown> | undefined;
  if (!rl || typeof rl !== 'object') return null;
  return {
    limitId: strOrNull(rl.limitId),
    limitName: strOrNull(rl.limitName),
    primary: normalizeWindow(rl.primary),
    secondary: normalizeWindow(rl.secondary),
    credits: normalizeCredits(rl.credits),
    planType: strOrNull(rl.planType),
    rateLimitReachedType: strOrNull(rl.rateLimitReachedType),
  };
}

function normalizeWindow(raw: unknown): CodexRateLimitWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  return {
    usedPercent: numOrNull(w.usedPercent),
    windowDurationMins: numOrNull(w.windowDurationMins),
    resetsAt: numOrNull(w.resetsAt),
  };
}

function normalizeCredits(raw: unknown): CodexCredits | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  return {
    hasCredits: c.hasCredits === true,
    unlimited: c.unlimited === true,
    balance: typeof c.balance === 'string' ? c.balance : null,
  };
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
