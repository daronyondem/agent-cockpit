import { spawn, type ChildProcess } from 'child_process';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { atomicWriteFile } from '../utils/atomicWrite';
import type { CliProfile } from '../types';
import { resolveCodexCliRuntime } from './backends/codex';
import { buildCliCommandInvocation } from './cliCommandResolver';

// Codex plan usage can be read directly from the ChatGPT OAuth usage endpoint
// when the selected Codex home has `auth.json` tokens. If that is unavailable
// or fails, we fall back to a one-shot `codex app-server` RPC probe. Both paths
// normalize into the same cached shape used by the ContextChip tooltip.

const REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000;
const STALE_AFTER_MS = 15 * 60 * 1000;
// Hard ceiling for the spawned app-server. The two RPCs are sub-second in
// practice; a stuck process gets SIGKILL'd at this point.
const REFRESH_TIMEOUT_MS = 15_000;
const RPC_INITIALIZE_TIMEOUT_MS = 8_000;
const RPC_REQUEST_TIMEOUT_MS = 3_000;
const PROCESS_KILL_GRACE_MS = 1_000;
const OAUTH_REQUEST_TIMEOUT_MS = 10_000;
const OAUTH_REFRESH_AFTER_MS = 8 * 24 * 60 * 60 * 1000;
const CHATGPT_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api';
const CHATGPT_USAGE_PATH = '/wham/usage';
const CODEX_USAGE_PATH = '/api/codex/usage';
const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_PLAN_USAGE_APP_SERVER_ARGS = ['-s', 'read-only', '-a', 'untrusted', 'app-server'];

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
  rpcInitializeTimeoutMs?: number;
  rpcRequestTimeoutMs?: number;
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
  private _rpcInitializeTimeoutMs: number;
  private _rpcRequestTimeoutMs: number;

  constructor(appRoot: string, options: CodexPlanUsageServiceOptions = {}) {
    const dataRoot = options.dataRoot || path.join(appRoot, 'data');
    this._cacheFile = path.join(dataRoot, 'codex-plan-usage.json');
    this._profileCacheDir = path.join(dataRoot, 'codex-plan-usage');
    this._rpcInitializeTimeoutMs = options.rpcInitializeTimeoutMs || RPC_INITIALIZE_TIMEOUT_MS;
    this._rpcRequestTimeoutMs = options.rpcRequestTimeoutMs || RPC_REQUEST_TIMEOUT_MS;
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
      const { account, rateLimits } = await fetchPlanUsage(undefined, {
        rpcInitializeTimeoutMs: this._rpcInitializeTimeoutMs,
        rpcRequestTimeoutMs: this._rpcRequestTimeoutMs,
      });
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
      const { account, rateLimits } = await fetchPlanUsage(profile, {
        rpcInitializeTimeoutMs: this._rpcInitializeTimeoutMs,
        rpcRequestTimeoutMs: this._rpcRequestTimeoutMs,
      });
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

interface FetchPlanUsageOptions {
  rpcInitializeTimeoutMs: number;
  rpcRequestTimeoutMs: number;
}

interface CodexOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  accountId: string | null;
  lastRefresh: Date | null;
  filePath: string;
}

async function fetchPlanUsage(profile: CliProfile | undefined, options: FetchPlanUsageOptions): Promise<FetchResult> {
  try {
    return await fetchFromOAuthUsage(profile);
  } catch {
    return fetchFromAppServer(profile, options);
  }
}

async function fetchFromOAuthUsage(profile?: CliProfile): Promise<FetchResult> {
  const runtime = resolveCodexCliRuntime(profile);
  let credentials = await readCodexOAuthCredentials(runtime.env);
  if (credentialsNeedsRefresh(credentials)) {
    credentials = await refreshCodexOAuthCredentials(credentials);
    await saveCodexOAuthCredentials(credentials);
  }

  const res = await fetch(await resolveCodexUsageURL(runtime.env), {
    headers: {
      'Authorization': `Bearer ${credentials.accessToken}`,
      'Accept': 'application/json',
      'User-Agent': 'AgentCockpit',
      ...(credentials.accountId ? { 'ChatGPT-Account-Id': credentials.accountId } : {}),
    },
    signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Codex usage API ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = await res.json();
  return normalizeOAuthUsage(body, credentials);
}

async function fetchFromAppServer(profile: CliProfile | undefined, options: FetchPlanUsageOptions): Promise<FetchResult> {
  const runtime = resolveCodexCliRuntime(profile);
  const invocation = buildCliCommandInvocation(runtime, CODEX_PLAN_USAGE_APP_SERVER_ARGS);
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

    const client = new RpcClient(proc, options);
    await client.request('initialize', {
      clientInfo: { name: 'agent-cockpit', title: null, version: '1.0.0' },
      capabilities: null,
    }, options.rpcInitializeTimeoutMs);
    const accountPromise = client.request('account/read', { refreshToken: false })
      .catch(() => null);
    let recoveredAccount: CodexAccount | null = null;
    const rateLimitsResult = await client.request('account/rateLimits/read')
      .catch((err: unknown) => {
        const recovered = recoverUsageFromRpcError(err);
        if (recovered) {
          recoveredAccount = recovered.account;
          return { rateLimits: recovered.rateLimits };
        }
        throw err;
      });
    const accountResult = await accountPromise;
    return {
      account: normalizeAccount(accountResult) || recoveredAccount,
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
  private options: FetchPlanUsageOptions;
  private nextId = 1;
  private pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }> = new Map();
  private buffer = '';
  private closed = false;

  constructor(proc: ChildProcess, options: FetchPlanUsageOptions) {
    this.proc = proc;
    this.options = options;
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

  request(method: string, params?: Record<string, unknown>, timeoutMs = this.options.rpcRequestTimeoutMs): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('codex app-server is closed'));
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (!this.proc.killed) this.proc.kill('SIGKILL');
        reject(new Error(`codex RPC timed out waiting for ${method}`));
      }, timeoutMs);
      timer.unref?.();
      const wrappedResolve = (value: unknown) => {
        clearTimeout(timer);
        resolve(value);
      };
      const wrappedReject = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };
      this.pending.set(id, { resolve: wrappedResolve, reject: wrappedReject });
      this.proc.stdin!.write(JSON.stringify(msg) + '\n');
    });
  }
}

async function readCodexOAuthCredentials(env: NodeJS.ProcessEnv): Promise<CodexOAuthCredentials> {
  const filePath = codexAuthFilePath(env);
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Codex OAuth credentials not found');
    }
    throw err;
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const tokens = parsed.tokens as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens !== 'object') {
    throw new Error('Codex auth.json contains no OAuth tokens');
  }

  const accessToken = stringToken(tokens, 'access_token', 'accessToken');
  const refreshToken = stringToken(tokens, 'refresh_token', 'refreshToken');
  if (!accessToken || !refreshToken) {
    throw new Error('Codex auth.json is missing OAuth tokens');
  }

  return {
    accessToken,
    refreshToken,
    idToken: stringToken(tokens, 'id_token', 'idToken'),
    accountId: stringToken(tokens, 'account_id', 'accountId'),
    lastRefresh: parseIsoDate(parsed.last_refresh),
    filePath,
  };
}

function codexAuthFilePath(env: NodeJS.ProcessEnv): string {
  const codexHome = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim()
    ? env.CODEX_HOME.trim()
    : path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'auth.json');
}

function codexConfigFilePath(env: NodeJS.ProcessEnv): string {
  const codexHome = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim()
    ? env.CODEX_HOME.trim()
    : path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'config.toml');
}

function credentialsNeedsRefresh(credentials: CodexOAuthCredentials): boolean {
  if (!credentials.refreshToken) return false;
  if (!credentials.lastRefresh) return true;
  return Date.now() - credentials.lastRefresh.getTime() > OAUTH_REFRESH_AFTER_MS;
}

async function refreshCodexOAuthCredentials(credentials: CodexOAuthCredentials): Promise<CodexOAuthCredentials> {
  const res = await fetch(OPENAI_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      scope: 'openid profile email',
    }),
    signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Codex OAuth refresh ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = await res.json() as Record<string, unknown>;
  return {
    ...credentials,
    accessToken: typeof body.access_token === 'string' && body.access_token ? body.access_token : credentials.accessToken,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : credentials.refreshToken,
    idToken: typeof body.id_token === 'string' && body.id_token ? body.id_token : credentials.idToken,
    lastRefresh: new Date(),
  };
}

async function saveCodexOAuthCredentials(credentials: CodexOAuthCredentials): Promise<void> {
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(await fsp.readFile(credentials.filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    // Recreate the minimal shape if the file disappeared after the read.
  }
  const tokens = {
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    ...(credentials.idToken ? { id_token: credentials.idToken } : {}),
    ...(credentials.accountId ? { account_id: credentials.accountId } : {}),
  };
  json.tokens = tokens;
  json.last_refresh = credentials.lastRefresh?.toISOString() || new Date().toISOString();
  await fsp.mkdir(path.dirname(credentials.filePath), { recursive: true });
  await atomicWriteFile(credentials.filePath, JSON.stringify(json, null, 2));
}

function stringToken(tokens: Record<string, unknown>, snakeKey: string, camelKey: string): string | null {
  const snake = tokens[snakeKey];
  if (typeof snake === 'string' && snake.trim()) return snake;
  const camel = tokens[camelKey];
  if (typeof camel === 'string' && camel.trim()) return camel;
  return null;
}

function parseIsoDate(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function parseJwtPayload(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (payload.length % 4 !== 0) payload += '=';
  try {
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function resolveCodexUsageURL(env: NodeJS.ProcessEnv): Promise<string> {
  const base = normalizeChatGPTBaseUrl(await readChatGPTBaseUrl(env));
  const pathSuffix = base.includes('/backend-api') ? CHATGPT_USAGE_PATH : CODEX_USAGE_PATH;
  return base + pathSuffix;
}

async function readChatGPTBaseUrl(env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const config = await fsp.readFile(codexConfigFilePath(env), 'utf8');
    const parsed = parseChatGPTBaseUrl(config);
    if (parsed) return parsed;
  } catch {
    // Missing config means the standard ChatGPT backend.
  }
  return CHATGPT_BACKEND_BASE_URL;
}

function parseChatGPTBaseUrl(config: string): string | null {
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.split('#', 1)[0]?.trim() || '';
    if (!line) continue;
    const match = /^chatgpt_base_url\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    let value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value.trim() || null;
  }
  return null;
}

function normalizeChatGPTBaseUrl(value: string): string {
  let trimmed = value.trim() || CHATGPT_BACKEND_BASE_URL;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  if ((trimmed.startsWith('https://chatgpt.com') || trimmed.startsWith('https://chat.openai.com'))
    && !trimmed.includes('/backend-api')) {
    trimmed += '/backend-api';
  }
  return trimmed;
}

function normalizeOAuthUsage(raw: unknown, credentials: CodexOAuthCredentials | null): FetchResult {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const jwtPayload = parseJwtPayload(credentials?.idToken || null);
  const profilePayload = jwtPayload?.['https://api.openai.com/profile'];
  const authPayload = jwtPayload?.['https://api.openai.com/auth'];
  const profile = profilePayload && typeof profilePayload === 'object' ? profilePayload as Record<string, unknown> : {};
  const auth = authPayload && typeof authPayload === 'object' ? authPayload as Record<string, unknown> : {};
  const planType = strOrNull(body.plan_type)
    || strOrNull(auth.chatgpt_plan_type)
    || strOrNull(jwtPayload?.chatgpt_plan_type);
  const email = strOrNull(body.email)
    || strOrNull(jwtPayload?.email)
    || strOrNull(profile.email);
  const account: CodexAccount = {
    type: 'chatgpt',
    email,
    planType,
  };

  const rateLimit = body.rate_limit && typeof body.rate_limit === 'object'
    ? body.rate_limit as Record<string, unknown>
    : null;
  const windows = normalizeRateLimitWindowSlots(
    normalizeOAuthWindow(rateLimit?.primary_window),
    normalizeOAuthWindow(rateLimit?.secondary_window),
  );
  const credits = normalizeOAuthCredits(body.credits);
  const hasAnyRateLimitData = !!rateLimit || !!credits || !!planType;
  return {
    account,
    rateLimits: hasAnyRateLimitData ? {
      limitId: null,
      limitName: null,
      primary: windows.primary,
      secondary: windows.secondary,
      credits,
      planType,
      rateLimitReachedType: null,
    } : null,
  };
}

function normalizeOAuthWindow(raw: unknown): CodexRateLimitWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  const durationSeconds = numOrNull(w.limit_window_seconds);
  return {
    usedPercent: numOrNull(w.used_percent),
    windowDurationMins: durationSeconds == null ? null : durationSeconds / 60,
    resetsAt: numOrNull(w.reset_at),
  };
}

function normalizeOAuthCredits(raw: unknown): CodexCredits | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  return {
    hasCredits: c.has_credits === true,
    unlimited: c.unlimited === true,
    balance: balanceStringOrNull(c.balance),
  };
}

function recoverUsageFromRpcError(err: unknown): FetchResult | null {
  const message = err instanceof Error ? err.message : String(err || '');
  const json = extractJSONObjectAfterMarker(message, 'body=');
  if (!json) return null;
  try {
    return normalizeOAuthUsage(JSON.parse(json), null);
  } catch {
    return null;
  }
}

function extractJSONObjectAfterMarker(text: string, marker: string): string | null {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf('{', markerIndex + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
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
  const windows = normalizeRateLimitWindowSlots(normalizeWindow(rl.primary), normalizeWindow(rl.secondary));
  return {
    limitId: strOrNull(rl.limitId),
    limitName: strOrNull(rl.limitName),
    primary: windows.primary,
    secondary: windows.secondary,
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
    balance: balanceStringOrNull(c.balance),
  };
}

function normalizeRateLimitWindowSlots(
  primary: CodexRateLimitWindow | null,
  secondary: CodexRateLimitWindow | null,
): { primary: CodexRateLimitWindow | null; secondary: CodexRateLimitWindow | null } {
  if (primary && secondary) {
    const primaryRole = codexWindowRole(primary);
    const secondaryRole = codexWindowRole(secondary);
    if ((primaryRole === 'weekly' && secondaryRole === 'session')
      || (primaryRole === 'weekly' && secondaryRole === 'unknown')) {
      return { primary: secondary, secondary: primary };
    }
    return { primary, secondary };
  }
  if (primary) {
    return codexWindowRole(primary) === 'weekly'
      ? { primary: null, secondary: primary }
      : { primary, secondary: null };
  }
  if (secondary) {
    return codexWindowRole(secondary) === 'weekly'
      ? { primary: null, secondary }
      : { primary: secondary, secondary: null };
  }
  return { primary: null, secondary: null };
}

function codexWindowRole(window: CodexRateLimitWindow): 'session' | 'weekly' | 'unknown' {
  if (window.windowDurationMins === 300) return 'session';
  if (window.windowDurationMins === 10080) return 'weekly';
  return 'unknown';
}

function balanceStringOrNull(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
