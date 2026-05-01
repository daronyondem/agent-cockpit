import { execFile } from 'child_process';
import fsp from 'fs/promises';
import { homedir } from 'os';
import path from 'path';
import { atomicWriteFile } from '../utils/atomicWrite';
import type { CliProfile } from '../types';
import { resolveClaudeCliRuntime } from './backends/claudeCode';

const BASE_API_URL = 'https://api.anthropic.com';
const ANTHROPIC_BETA = 'oauth-2025-04-20';
const CREDENTIALS_PATH = path.join(homedir(), '.claude', '.credentials.json');
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

// Gap between fetch attempts. User-specified: "do not refresh until 10 min
// has passed since last poll". Interpreted as last *attempt* so transient
// outages back off cleanly instead of hammering.
const REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000;
// Client-visible stale threshold (slightly above refresh floor).
const STALE_AFTER_MS = 15 * 60 * 1000;
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

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
  five_hour?: RateLimit | null;
  seven_day?: RateLimit | null;
  seven_day_oauth_apps?: RateLimit | null;
  seven_day_opus?: RateLimit | null;
  seven_day_sonnet?: RateLimit | null;
  extra_usage?: ExtraUsage | null;
}

export interface ClaudePlanUsageSnapshot {
  fetchedAt: string | null;
  planTier: string | null;
  subscriptionType: string | null;
  rateLimits: RateLimits | null;
  lastError: string | null;
}

export interface ClaudePlanUsageResponse extends ClaudePlanUsageSnapshot {
  stale: boolean;
}

interface StoredCreds {
  accessToken: string;
  expiresAt: number | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
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

  constructor(appRoot: string) {
    this._cacheFile = path.join(appRoot, 'data', 'claude-plan-usage.json');
    this._profileCacheDir = path.join(appRoot, 'data', 'claude-plan-usage');
    this._snapshot = {
      fetchedAt: null,
      planTier: null,
      subscriptionType: null,
      rateLimits: null,
      lastError: null,
    };
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
        rateLimits: parsed.rateLimits ?? null,
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
    try {
      const creds = await readStoredCredentials();
      if (isExpired(creds.expiresAt)) {
        this._snapshot = { ...this._snapshot, lastError: 'token-expired' };
        await this._persist();
        // Token-expired isn't a real attempt — we never reached the API. Reset
        // the throttle so the next trigger can retry the moment Claude Code
        // refreshes the OAuth token, instead of waiting out the full 10-min cooldown.
        this._lastAttemptAt = 0;
        console.log(`[claudePlanUsage] refresh(${reason}) skipped: access token expired`);
        return;
      }
      const res = await fetch(`${BASE_API_URL}/api/oauth/usage`, {
        headers: {
          'Authorization': `Bearer ${creds.accessToken}`,
          'anthropic-beta': ANTHROPIC_BETA,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`usage API ${res.status}: ${text.slice(0, 200)}`);
      }
      const body = (await res.json()) as RateLimits;
      this._snapshot = {
        fetchedAt: new Date().toISOString(),
        planTier: creds.rateLimitTier,
        subscriptionType: creds.subscriptionType,
        rateLimits: body,
        lastError: null,
      };
      await this._persist();
      console.log(`[claudePlanUsage] refresh(${reason}) ok`);
    } catch (err: unknown) {
      const msg = (err as Error).message || String(err);
      this._snapshot = { ...this._snapshot, lastError: msg };
      await this._persist();
      console.warn(`[claudePlanUsage] refresh(${reason}) failed: ${msg}`);
    }
  }

  private async _refreshProfile(reason: string, profile: CliProfile): Promise<void> {
    const key = this._profileKey(profile);
    const file = this._profileCacheFile(profile);
    const current = this._getProfileSnapshot(profile);
    try {
      const creds = await readStoredCredentials(profile);
      if (isExpired(creds.expiresAt)) {
        const next = { ...current, lastError: 'token-expired' };
        this._profileSnapshots.set(key, next);
        await this._persistSnapshot(file, next);
        this._profileLastAttemptAt.set(key, 0);
        console.log(`[claudePlanUsage] refresh(${reason}) skipped profile=${profile.id}: access token expired`);
        return;
      }
      const res = await fetch(`${BASE_API_URL}/api/oauth/usage`, {
        headers: {
          'Authorization': `Bearer ${creds.accessToken}`,
          'anthropic-beta': ANTHROPIC_BETA,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`usage API ${res.status}: ${text.slice(0, 200)}`);
      }
      const body = (await res.json()) as RateLimits;
      const next = {
        fetchedAt: new Date().toISOString(),
        planTier: creds.rateLimitTier,
        subscriptionType: creds.subscriptionType,
        rateLimits: body,
        lastError: null,
      };
      this._profileSnapshots.set(key, next);
      await this._persistSnapshot(file, next);
      console.log(`[claudePlanUsage] refresh(${reason}) ok profile=${profile.id}`);
    } catch (err: unknown) {
      const msg = (err as Error).message || String(err);
      const next = { ...current, lastError: msg };
      this._profileSnapshots.set(key, next);
      await this._persistSnapshot(file, next);
      console.warn(`[claudePlanUsage] refresh(${reason}) failed profile=${profile.id}: ${msg}`);
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

function isExpired(expiresAt: number | null): boolean {
  if (expiresAt == null) return false;
  return Date.now() + EXPIRY_BUFFER_MS >= expiresAt;
}

async function readStoredCredentials(profile?: CliProfile): Promise<StoredCreds> {
  const runtime = resolveClaudeCliRuntime(profile);
  if (runtime.configDir) {
    const credentialsPath = path.join(runtime.configDir, '.credentials.json');
    try {
      const raw = await fsp.readFile(credentialsPath, 'utf8');
      return parseCredsBlob(JSON.parse(raw));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    throw new Error(`no credentials found at ${credentialsPath}`);
  }

  try {
    const raw = await fsp.readFile(CREDENTIALS_PATH, 'utf8');
    return parseCredsBlob(JSON.parse(raw));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (process.platform === 'darwin') {
    const raw = await keychainRead(KEYCHAIN_SERVICE);
    return parseCredsBlob(JSON.parse(raw));
  }
  throw new Error(`no credentials found at ${CREDENTIALS_PATH}`);
}

function parseCredsBlob(blob: unknown): StoredCreds {
  const b = (blob ?? {}) as Record<string, unknown>;
  const oauth = (b.claudeAiOauth ?? {}) as Record<string, unknown>;
  const accessToken = oauth.accessToken;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('credentials missing claudeAiOauth.accessToken');
  }
  return {
    accessToken,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
    subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
    rateLimitTier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : null,
  };
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
