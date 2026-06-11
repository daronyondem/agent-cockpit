import { execFile } from 'child_process';
import fsp from 'fs/promises';
import { homedir } from 'os';
import path from 'path';
import { atomicWriteFile } from '../utils/atomicWrite';
import type { CliProfile } from '../types';
import { buildCliCommandInvocation } from './cliCommandResolver';
import { resolveClaudeCliRuntime } from './backends/claudeCode';
import { collectClaudeTerminalResponses } from './backends/claudeInteractiveTerminal';
import {
  ensureNodePtySpawnHelperExecutable,
  type ClaudeInteractivePtyProcess,
  type ClaudeInteractivePtySpawnOptions,
} from './backends/claudeInteractivePty';

const BASE_API_URL = 'https://api.anthropic.com';
const ANTHROPIC_BETA = 'oauth-2025-04-20';
const CLAUDE_CODE_USER_AGENT = 'claude-code/unknown (agent-cockpit)';
const CREDENTIALS_PATH = path.join(homedir(), '.claude', '.credentials.json');
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CLI_USAGE_PROBE_ARGS = ['--allowed-tools', ''];

// Gap between fetch attempts. User-specified: "do not refresh until 10 min
// has passed since last poll". Interpreted as last *attempt* so transient
// outages back off cleanly instead of hammering.
const REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000;
// Client-visible stale threshold (slightly above refresh floor).
const STALE_AFTER_MS = 15 * 60 * 1000;
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const CLI_USAGE_PROBE_TIMEOUT_MS = 30_000;
const CLI_USAGE_COMMAND_DELAY_MS = 1_200;
const CLI_SETTLE_AFTER_USAGE_MS = 3_000;
const CLI_OUTPUT_BUFFER_LIMIT = 60_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

export interface RateLimit {
  utilization: number | null;
  resets_at: string | null;
}

export interface ExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
  currency?: string | null;
}

export interface RateLimits {
  [key: string]: RateLimit | ExtraUsage | null | undefined;
  five_hour?: RateLimit | null;
  seven_day?: RateLimit | null;
  seven_day_oauth_apps?: RateLimit | null;
  seven_day_opus?: RateLimit | null;
  seven_day_sonnet?: RateLimit | null;
  extra_usage?: ExtraUsage | null;
}

export type ClaudePlanUsageSource = 'oauth-file' | 'oauth-keychain' | 'cli-usage';

export interface ClaudePlanUsageIdentity {
  email: string | null;
  organization: string | null;
  loginMethod: string | null;
}

export interface ClaudePlanUsageAttempt {
  at: string;
  source: ClaudePlanUsageSource;
  ok: boolean;
  error: string | null;
}

export interface ClaudePlanUsageSnapshot {
  fetchedAt: string | null;
  planTier: string | null;
  subscriptionType: string | null;
  rateLimits: RateLimits | null;
  source: ClaudePlanUsageSource | null;
  identity: ClaudePlanUsageIdentity | null;
  attempts: ClaudePlanUsageAttempt[];
  lastError: string | null;
}

export interface ClaudePlanUsageResponse extends ClaudePlanUsageSnapshot {
  stale: boolean;
}

export interface ClaudeCliUsageProbeResult {
  rateLimits: RateLimits | null;
  identity: ClaudePlanUsageIdentity | null;
}

interface ClaudePlanUsageServiceOptions {
  dataRoot?: string;
  cliUsageProbe?: (profile?: CliProfile) => Promise<ClaudeCliUsageProbeResult>;
}

interface StoredCreds {
  accessToken: string;
  expiresAt: number | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  scopes: string[];
  source: Exclude<ClaudePlanUsageSource, 'cli-usage'>;
  identity: ClaudePlanUsageIdentity | null;
}

interface OAuthUsageFetch {
  source: Exclude<ClaudePlanUsageSource, 'cli-usage'>;
  planTier: string | null;
  subscriptionType: string | null;
  identity: ClaudePlanUsageIdentity | null;
  rateLimits: RateLimits | null;
}

interface RefreshResult {
  snapshot: ClaudePlanUsageSnapshot;
  resetThrottle: boolean;
  usedFallback: boolean;
}

class PlanUsageSourceError extends Error {
  source: ClaudePlanUsageSource;
  tokenExpired: boolean;

  constructor(message: string, source: ClaudePlanUsageSource, options: { tokenExpired?: boolean } = {}) {
    super(message);
    this.name = 'PlanUsageSourceError';
    this.source = source;
    this.tokenExpired = !!options.tokenExpired;
  }
}

export class ClaudePlanUsageService {
  private _cacheFile: string;
  private _profileCacheDir: string;
  private _snapshot: ClaudePlanUsageSnapshot;
  private _lastAttemptAt = 0;
  private _inFlight: Promise<void> | null = null;
  private _profileSnapshots = new Map<string, ClaudePlanUsageSnapshot>();
  private _profileLastAttemptAt = new Map<string, number>();
  private _profileInFlight = new Map<string, Promise<void>>();
  private _cliUsageProbe: (profile?: CliProfile) => Promise<ClaudeCliUsageProbeResult>;

  constructor(appRoot: string, options: ClaudePlanUsageServiceOptions = {}) {
    const dataRoot = options.dataRoot || path.join(appRoot, 'data');
    this._cacheFile = path.join(dataRoot, 'claude-plan-usage.json');
    this._profileCacheDir = path.join(dataRoot, 'claude-plan-usage');
    this._snapshot = this._emptySnapshot();
    this._cliUsageProbe = options.cliUsageProbe || probeClaudeCliUsage;
  }

  async init(): Promise<void> {
    this._snapshot = await this._loadSnapshot(this._cacheFile);
    await this._loadProfileSnapshots();
  }

  getCached(profile?: CliProfile): ClaudePlanUsageResponse {
    if (!profile || this._usesDefaultCache(profile)) return this._withStale(this._snapshot);
    const snapshot = this._getProfileSnapshot(profile);
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

  private _withStale(snapshot: ClaudePlanUsageSnapshot): ClaudePlanUsageResponse {
    const now = Date.now();
    const fetchedAtMs = snapshot.fetchedAt
      ? new Date(snapshot.fetchedAt).getTime()
      : null;
    const stale = fetchedAtMs == null || now - fetchedAtMs > STALE_AFTER_MS;
    return { ...snapshot, stale };
  }

  private _emptySnapshot(): ClaudePlanUsageSnapshot {
    return {
      fetchedAt: null,
      planTier: null,
      subscriptionType: null,
      rateLimits: null,
      source: null,
      identity: null,
      attempts: [],
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

  private _getProfileSnapshot(profile: CliProfile): ClaudePlanUsageSnapshot {
    const key = this._profileKey(profile);
    let snapshot = this._profileSnapshots.get(key);
    if (!snapshot) {
      snapshot = this._emptySnapshot();
      this._profileSnapshots.set(key, snapshot);
    }
    return snapshot;
  }

  private async _loadSnapshot(file: string): Promise<ClaudePlanUsageSnapshot> {
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : null,
        planTier: typeof parsed.planTier === 'string' ? parsed.planTier : null,
        subscriptionType: typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : null,
        rateLimits: normalizeRateLimits(parsed.rateLimits),
        source: parseSource(parsed.source),
        identity: normalizeIdentity(parsed.identity),
        attempts: normalizeAttempts(parsed.attempts),
        lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[claudePlanUsage] Failed to load cache:', (err as Error).message);
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
        console.warn('[claudePlanUsage] Failed to load profile caches:', (err as Error).message);
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
    const result = await this._buildRefreshSnapshot(this._snapshot);
    this._snapshot = result.snapshot;
    await this._persist();
    if (result.resetThrottle) this._lastAttemptAt = 0;
    logRefreshResult(reason, result);
  }

  private async _refreshProfile(reason: string, profile: CliProfile): Promise<void> {
    const key = this._profileKey(profile);
    const file = this._profileCacheFile(profile);
    const current = this._getProfileSnapshot(profile);
    const result = await this._buildRefreshSnapshot(current, profile);
    this._profileSnapshots.set(key, result.snapshot);
    await this._persistSnapshot(file, result.snapshot);
    if (result.resetThrottle) this._profileLastAttemptAt.set(key, 0);
    logRefreshResult(reason, result, profile);
  }

  private async _buildRefreshSnapshot(
    current: ClaudePlanUsageSnapshot,
    profile?: CliProfile,
  ): Promise<RefreshResult> {
    const attempts: ClaudePlanUsageAttempt[] = [];
    let oauthError: PlanUsageSourceError | null = null;

    try {
      const oauth = await fetchOAuthUsage(profile);
      attempts.push(makeAttempt(oauth.source, true, null));
      return {
        snapshot: {
          fetchedAt: new Date().toISOString(),
          planTier: oauth.planTier,
          subscriptionType: oauth.subscriptionType,
          rateLimits: oauth.rateLimits,
          source: oauth.source,
          identity: oauth.identity,
          attempts: appendAttempts(current.attempts, attempts),
          lastError: null,
        },
        resetThrottle: false,
        usedFallback: false,
      };
    } catch (err: unknown) {
      oauthError = toPlanUsageSourceError(err, defaultOAuthSource(profile));
      attempts.push(makeAttempt(oauthError.source, false, oauthError.message));
    }

    try {
      const cli = await this._cliUsageProbe(profile);
      attempts.push(makeAttempt('cli-usage', true, null));
      return {
        snapshot: {
          ...current,
          fetchedAt: new Date().toISOString(),
          rateLimits: normalizeRateLimits(cli.rateLimits),
          source: 'cli-usage',
          identity: normalizeIdentity(cli.identity),
          attempts: appendAttempts(current.attempts, attempts),
          lastError: null,
        },
        resetThrottle: false,
        usedFallback: true,
      };
    } catch (err: unknown) {
      const cliError = errorMessage(err);
      attempts.push(makeAttempt('cli-usage', false, cliError));
      return {
        snapshot: {
          ...current,
          attempts: appendAttempts(current.attempts, attempts),
          lastError: `oauth failed: ${oauthError.message}; cli-usage failed: ${cliError}`,
        },
        resetThrottle: oauthError.tokenExpired,
        usedFallback: true,
      };
    }
  }

  private async _persist(): Promise<void> {
    await this._persistSnapshot(this._cacheFile, this._snapshot);
  }

  private async _persistSnapshot(file: string, snapshot: ClaudePlanUsageSnapshot): Promise<void> {
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await atomicWriteFile(file, JSON.stringify(snapshot, null, 2));
    } catch (err: unknown) {
      console.warn('[claudePlanUsage] Failed to persist cache:', (err as Error).message);
    }
  }
}

async function fetchOAuthUsage(profile?: CliProfile): Promise<OAuthUsageFetch> {
  let source = defaultOAuthSource(profile);
  try {
    const creds = await readStoredCredentials(profile);
    source = creds.source;
    validateRequiredOAuthScopes(creds);
    if (isExpired(creds.expiresAt)) {
      throw new PlanUsageSourceError('token-expired', source, { tokenExpired: true });
    }
    const res = await fetch(`${BASE_API_URL}/api/oauth/usage`, {
      headers: {
        'Authorization': `Bearer ${creds.accessToken}`,
        'anthropic-beta': ANTHROPIC_BETA,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': CLAUDE_CODE_USER_AGENT,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new PlanUsageSourceError(`usage API ${res.status}: ${text.slice(0, 200)}`, source);
    }
    const body = await res.json();
    return {
      source,
      planTier: creds.rateLimitTier,
      subscriptionType: creds.subscriptionType,
      identity: creds.identity,
      rateLimits: normalizeRateLimits(body),
    };
  } catch (err: unknown) {
    throw toPlanUsageSourceError(err, source);
  }
}

async function readStoredCredentials(profile?: CliProfile): Promise<StoredCreds> {
  const runtime = resolveClaudeCliRuntime(profile);
  if (runtime.configDir) {
    const credentialsPath = path.join(runtime.configDir, '.credentials.json');
    try {
      const raw = await fsp.readFile(credentialsPath, 'utf8');
      return parseCredsBlob(JSON.parse(raw), 'oauth-file');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    throw new Error(`no credentials found at ${credentialsPath}`);
  }

  try {
    const raw = await fsp.readFile(CREDENTIALS_PATH, 'utf8');
    return parseCredsBlob(JSON.parse(raw), 'oauth-file');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (process.platform === 'darwin') {
    try {
      const raw = await keychainRead(KEYCHAIN_SERVICE);
      return parseCredsBlob(JSON.parse(raw), 'oauth-keychain');
    } catch (err: unknown) {
      throw new PlanUsageSourceError(errorMessage(err), 'oauth-keychain');
    }
  }
  throw new Error(`no credentials found at ${CREDENTIALS_PATH}`);
}

function parseCredsBlob(
  blob: unknown,
  source: Exclude<ClaudePlanUsageSource, 'cli-usage'>,
): StoredCreds {
  const b = asRecord(blob) || {};
  const oauth = asRecord(b.claudeAiOauth) || {};
  const accessToken = oauth.accessToken;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('credentials missing claudeAiOauth.accessToken');
  }
  return {
    accessToken,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
    subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
    rateLimitTier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : null,
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes.filter((scope): scope is string => typeof scope === 'string') : [],
    source,
    identity: extractIdentityFromCredentials(b, oauth),
  };
}

function validateRequiredOAuthScopes(creds: StoredCreds): void {
  if (creds.scopes.length === 0 || creds.scopes.includes('user:profile')) return;
  throw new PlanUsageSourceError('oauth-token-missing-user-profile-scope', creds.source);
}

function keychainRead(service: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-w'],
      { timeout: 10_000 },
      (err, stdout) => {
        if (err) return reject(new Error(`keychain read failed: ${err.message}`));
        resolve(stdout.trim());
      },
    );
  });
}

export async function probeClaudeCliUsage(profile?: CliProfile): Promise<ClaudeCliUsageProbeResult> {
  const runtime = resolveClaudeCliRuntime(profile);
  const invocation = buildCliCommandInvocation(runtime, CLI_USAGE_PROBE_ARGS);
  return runClaudeUsagePty(invocation.command, invocation.args, runtime.env);
}

function runClaudeUsagePty(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<ClaudeCliUsageProbeResult> {
  return new Promise((resolve, reject) => {
    let pty: ClaudeInteractivePtyProcess;
    try {
      pty = spawnPty(command, args, {
        cwd: process.cwd(),
        env,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        name: 'xterm-256color',
      });
    } catch (err: unknown) {
      reject(new Error(`claude CLI usage probe failed to start: ${errorMessage(err)}`));
      return;
    }

    let output = '';
    let done = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastTrustWriteAt = 0;
    let usageSent = false;
    let exitDisposable: { dispose(): void } | null = null;
    let dataDisposable: { dispose(): void } | null = null;

    const finish = (timeoutError?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timeoutTimer);
      clearTimeout(usageTimer);
      if (settleTimer) clearTimeout(settleTimer);
      dataDisposable?.dispose();
      exitDisposable?.dispose();
      try {
        pty.write('/exit\r');
      } catch {}
      try {
        pty.kill();
      } catch {}

      try {
        const parsed = parseClaudeCliUsageOutput(output);
        if (parsed.rateLimits || parsed.identity) {
          resolve(parsed);
          return;
        }
        reject(timeoutError || new Error('claude CLI usage probe returned no usage or identity data'));
      } catch (err: unknown) {
        reject(timeoutError || err);
      }
    };

    const maybeSettle = (): void => {
      if (!usageSent) return;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => finish(), CLI_SETTLE_AFTER_USAGE_MS);
      settleTimer.unref?.();
    };

    const timeoutTimer = setTimeout(() => {
      finish(new Error('claude CLI usage probe timed out'));
    }, CLI_USAGE_PROBE_TIMEOUT_MS);
    timeoutTimer.unref?.();

    const usageTimer = setTimeout(() => {
      usageSent = true;
      pty.write('/usage\r');
    }, CLI_USAGE_COMMAND_DELAY_MS);
    usageTimer.unref?.();

    dataDisposable = pty.onData((data) => {
      output = `${output}${data}`.slice(-CLI_OUTPUT_BUFFER_LIMIT);
      for (const response of collectClaudeTerminalResponses(data, {
        rows: DEFAULT_ROWS,
        cols: DEFAULT_COLS,
        terminalName: 'AgentCockpit',
      })) {
        pty.write(response);
      }

      const compact = stripAnsi(output).toLowerCase().replace(/[^a-z0-9]+/g, '');
      const now = Date.now();
      if (
        compact.includes('trust')
        && (compact.includes('doyoutrust') || compact.includes('yesitrust') || compact.includes('trustthefiles'))
        && now - lastTrustWriteAt > 2_000
      ) {
        lastTrustWriteAt = now;
        pty.write('\r');
      }

      const parsed = parseClaudeCliUsageOutput(output);
      if (parsed.rateLimits || parsed.identity) {
        maybeSettle();
      }
    });

    exitDisposable = pty.onExit(() => finish());
  });
}

function spawnPty(
  command: string,
  args: string[],
  options: ClaudeInteractivePtySpawnOptions,
): ClaudeInteractivePtyProcess {
  ensureNodePtySpawnHelperExecutable();
  // Import lazily so normal OAuth plan-usage reads never load the native binding.
  const nodePty = require('node-pty') as { spawn: (file: string, args: string[], options: ClaudeInteractivePtySpawnOptions) => ClaudeInteractivePtyProcess };
  return nodePty.spawn(command, args, options);
}

export function parseClaudeCliUsageOutput(raw: string, now: Date = new Date()): ClaudeCliUsageProbeResult {
  const text = stripAnsi(String(raw || '')).replace(/\r/g, '\n');
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const rateLimits: RateLimits = {};
  const session = parseCliWindow(lines, line => hasPhrase(line, 'current session') || hasPhrase(line, '5 hour') || hasPhrase(line, '5-hour'), now);
  if (session) rateLimits.five_hour = session;

  const weeklyTotal = parseCliWindow(lines, line => (
    (hasPhrase(line, 'current week') || hasPhrase(line, 'weekly total') || hasPhrase(line, 'week total'))
    && !hasPhrase(line, 'opus')
    && !hasPhrase(line, 'sonnet')
    && !hasPhrase(line, 'oauth')
    && !hasPhrase(line, 'api')
  ), now);
  if (weeklyTotal) rateLimits.seven_day = weeklyTotal;

  const weeklyOpus = parseCliWindow(lines, line => hasPhrase(line, 'opus') && (hasPhrase(line, 'week') || hasPhrase(line, 'weekly')), now);
  if (weeklyOpus) rateLimits.seven_day_opus = weeklyOpus;

  const weeklySonnet = parseCliWindow(lines, line => hasPhrase(line, 'sonnet') && (hasPhrase(line, 'week') || hasPhrase(line, 'weekly')), now);
  if (weeklySonnet) rateLimits.seven_day_sonnet = weeklySonnet;

  return {
    rateLimits: Object.keys(rateLimits).length > 0 ? rateLimits : null,
    identity: parseCliIdentity(lines),
  };
}

function parseCliWindow(
  lines: string[],
  matchesLabel: (line: string) => boolean,
  now: Date,
): RateLimit | null {
  for (let i = 0; i < lines.length; i += 1) {
    if (!matchesLabel(lines[i])) continue;
    const block = lines.slice(i, i + 12);
    let utilization: number | null = null;
    let resetsAt: string | null = null;
    for (const line of block) {
      if (utilization == null) utilization = parseUtilization(line);
      if (resetsAt == null) resetsAt = parseResetAt(line, now);
    }
    if (utilization != null || resetsAt != null) {
      return { utilization, resets_at: resetsAt };
    }
  }
  return null;
}

function parseUtilization(line: string): number | null {
  const match = line.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const percent = clamp(Number(match[1]), 0, 100);
  const lower = line.toLowerCase();
  if (/\b(left|remaining|available)\b/.test(lower)) return clamp(100 - percent, 0, 100);
  if (/\b(used|usage|utilized|spent|consumed)\b/.test(lower)) return percent;
  return percent;
}

function parseResetAt(line: string, now: Date): string | null {
  if (!/reset/i.test(line)) return null;
  const match = line.match(/reset(?:s|ting)?(?:\s*(?:at|in))?\s*:?\s*(.+)$/i);
  return parseClaudeCliResetDescription((match ? match[1] : '').trim(), now);
}

function parseClaudeCliResetDescription(value: string, now: Date): string | null {
  const raw = String(value || '')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/(\d{1,2})\s+at\s+(\d)/gi, '$1 at $2')
    .trim();
  if (!raw) return null;

  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return new Date(direct).toISOString();

  const timeZone = validTimeZone(raw.match(/\(([A-Za-z_]+\/[A-Za-z0-9_./+-]+)\)/)?.[1] || null);
  const text = raw
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bat\b/gi, ' ')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const relative = text.match(/^(?:in\s+)?(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const multiplier = unit.startsWith('m') ? 60_000 : unit.startsWith('h') ? 3_600_000 : 86_400_000;
    return new Date(now.getTime() + amount * multiplier).toISOString();
  }

  const monthDate = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (monthDate) {
    const nowParts = calendarParts(now, timeZone);
    const month = MONTHS[monthDate[1].slice(0, 3).toLowerCase()];
    const day = Number(monthDate[2]);
    const hour = normalizeHour(Number(monthDate[3]), monthDate[5]);
    const minute = monthDate[4] ? Number(monthDate[4]) : 0;
    let candidate = dateFromCalendarParts(nowParts.year, month, day, hour, minute, timeZone);
    if (candidate.getTime() < now.getTime() - 12 * 3_600_000) {
      candidate = dateFromCalendarParts(nowParts.year + 1, month, day, hour, minute, timeZone);
    }
    return candidate.toISOString();
  }

  const timeOnly = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
    || text.match(/^\b(\d{1,2}):(\d{2})\b$/);
  if (timeOnly) {
    const nowParts = calendarParts(now, timeZone);
    const hour = normalizeHour(Number(timeOnly[1]), timeOnly[3]);
    const minute = timeOnly[2] ? Number(timeOnly[2]) : 0;
    let candidate = dateFromCalendarParts(nowParts.year, nowParts.month, nowParts.day, hour, minute, timeZone);
    if (candidate.getTime() <= now.getTime() - 60_000) {
      candidate = dateFromCalendarParts(nowParts.year, nowParts.month, nowParts.day + 1, hour, minute, timeZone);
    }
    return candidate.toISOString();
  }

  return null;
}

function parseCliIdentity(lines: string[]): ClaudePlanUsageIdentity | null {
  const joined = lines.join('\n');
  const email = firstString(
    matchValue(joined, /(?:account|email)\s*[:：]\s*([^\s<>()]+@[^\s<>()]+)/i),
    joined.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null,
  );
  const organization = firstString(
    matchValue(joined, /(?:organization|org)\s*[:：]\s*([^\n]+)/i),
    matchValue(joined, /workspace\s*[:：]\s*([^\n]+)/i),
  );
  const loginMethod = firstString(
    matchValue(joined, /login\s+method\s*[:：]\s*([^\n]+)/i),
    matchValue(joined, /subscription\s*[:：]\s*([^\n]+)/i),
  );
  return normalizeIdentity({ email, organization, loginMethod });
}

function extractIdentityFromCredentials(
  root: Record<string, unknown>,
  oauth: Record<string, unknown>,
): ClaudePlanUsageIdentity | null {
  const account = asRecord(oauth.account) || asRecord(root.account) || asRecord(root.user) || {};
  const organization = asRecord(oauth.organization) || asRecord(root.organization) || {};
  return normalizeIdentity({
    email: strOrNull(account.email) || strOrNull(oauth.email) || strOrNull(root.email),
    organization: strOrNull(organization.name) || strOrNull(organization.displayName) || strOrNull(oauth.organizationName),
    loginMethod: strOrNull(oauth.loginMethod) || strOrNull(oauth.provider) || strOrNull(root.loginMethod),
  });
}

function normalizeRateLimits(raw: unknown): RateLimits | null {
  if (raw == null) return null;
  const obj = asRecord(raw);
  if (!obj) return null;
  const out: RateLimits = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'extra_usage') {
      out.extra_usage = normalizeExtraUsage(value);
    } else {
      out[key] = normalizeRateLimit(value);
    }
  }
  return out;
}

function normalizeRateLimit(value: unknown): RateLimit | null {
  if (value == null) return null;
  const obj = asRecord(value);
  if (!obj) return null;
  return {
    utilization: numOrNull(obj.utilization),
    resets_at: strOrNull(obj.resets_at),
  };
}

function normalizeExtraUsage(value: unknown): ExtraUsage | null {
  if (value == null) return null;
  const obj = asRecord(value);
  if (!obj) return null;
  return {
    is_enabled: obj.is_enabled === true,
    monthly_limit: numOrNull(obj.monthly_limit),
    used_credits: numOrNull(obj.used_credits),
    utilization: numOrNull(obj.utilization),
    currency: strOrNull(obj.currency),
  };
}

function normalizeIdentity(value: unknown): ClaudePlanUsageIdentity | null {
  if (!value) return null;
  const obj = asRecord(value);
  if (!obj) return null;
  const identity = {
    email: cleanIdentityValue(obj.email),
    organization: cleanIdentityValue(obj.organization),
    loginMethod: cleanIdentityValue(obj.loginMethod),
  };
  return identity.email || identity.organization || identity.loginMethod ? identity : null;
}

function normalizeAttempts(value: unknown): ClaudePlanUsageAttempt[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      const obj = asRecord(item);
      const source = parseSource(obj?.source);
      if (!obj || !source) return null;
      return {
        at: typeof obj.at === 'string' ? obj.at : new Date().toISOString(),
        source,
        ok: obj.ok === true,
        error: typeof obj.error === 'string' ? obj.error : null,
      };
    })
    .filter((item): item is ClaudePlanUsageAttempt => item != null)
    .slice(-8);
}

function appendAttempts(
  previous: ClaudePlanUsageAttempt[] | undefined,
  next: ClaudePlanUsageAttempt[],
): ClaudePlanUsageAttempt[] {
  return [...(previous || []), ...next].slice(-8);
}

function makeAttempt(
  source: ClaudePlanUsageSource,
  ok: boolean,
  error: string | null,
): ClaudePlanUsageAttempt {
  return {
    at: new Date().toISOString(),
    source,
    ok,
    error,
  };
}

function parseSource(value: unknown): ClaudePlanUsageSource | null {
  return value === 'oauth-file' || value === 'oauth-keychain' || value === 'cli-usage' ? value : null;
}

function defaultOAuthSource(_profile?: CliProfile): Exclude<ClaudePlanUsageSource, 'cli-usage'> {
  return 'oauth-file';
}

function toPlanUsageSourceError(err: unknown, source: ClaudePlanUsageSource): PlanUsageSourceError {
  if (err instanceof PlanUsageSourceError) return err;
  return new PlanUsageSourceError(errorMessage(err), source);
}

function isExpired(expiresAt: number | null): boolean {
  if (expiresAt == null) return false;
  return Date.now() + EXPIRY_BUFFER_MS >= expiresAt;
}

function logRefreshResult(reason: string, result: RefreshResult, profile?: CliProfile): void {
  const suffix = profile ? ` profile=${profile.id}` : '';
  const fallback = result.usedFallback ? ' via CLI fallback' : '';
  if (result.snapshot.lastError) {
    console.warn(`[claudePlanUsage] refresh(${reason}) failed${suffix}${fallback}: ${result.snapshot.lastError}`);
  } else {
    console.log(`[claudePlanUsage] refresh(${reason}) ok${suffix}${fallback}`);
  }
}

function hasPhrase(line: string, phrase: string): boolean {
  return normalizeSearchText(line).includes(normalizeSearchText(phrase))
    || compactSearchText(line).includes(compactSearchText(phrase));
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function compactSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanIdentityValue(value: unknown): string | null {
  const str = strOrNull(value);
  if (!str) return null;
  return str.replace(/\s+/g, ' ').slice(0, 200);
}

function firstString(...values: Array<string | null | undefined>): string | null {
  return values.find(value => typeof value === 'string' && value.trim())?.trim() || null;
}

function matchValue(value: string, regex: RegExp): string | null {
  const match = value.match(regex);
  return match ? match[1].trim() : null;
}

function errorMessage(err: unknown): string {
  return (err as Error)?.message || String(err);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function normalizeHour(hour: number, marker?: string): number {
  const ampm = marker?.toLowerCase();
  if (ampm === 'am') return hour === 12 ? 0 : hour;
  if (ampm === 'pm') return hour === 12 ? 12 : hour + 12;
  return hour;
}

function validTimeZone(value: string | null): string | null {
  if (!value) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch {
    return null;
  }
}

function calendarParts(date: Date, timeZone: string | null): { year: number; month: number; day: number } {
  if (!timeZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
    };
  }
  const parts = dateTimeParts(date, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function dateFromCalendarParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string | null,
): Date {
  if (!timeZone) return new Date(year, month, day, hour, minute, 0, 0);
  return zonedDateTimeToUtc(year, month, day, hour, minute, timeZone);
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const target = Date.UTC(year, month, day, hour, minute, 0, 0);
  let utc = target;
  for (let i = 0; i < 3; i += 1) {
    const parts = dateTimeParts(new Date(utc), timeZone);
    const actual = Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second, 0);
    utc -= actual - target;
  }
  return new Date(utc);
}

function dateTimeParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value || 0);
  const hour = get('hour');
  return {
    year: get('year'),
    month: get('month') - 1,
    day: get('day'),
    hour: hour === 24 ? 0 : hour,
    minute: get('minute'),
    second: get('second'),
  };
}
