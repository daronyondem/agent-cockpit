import { execFile } from 'child_process';
import fsp from 'fs/promises';
import { homedir } from 'os';
import path from 'path';
import { atomicWriteFile } from '../utils/atomicWrite';

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
  private _snapshot: ClaudePlanUsageSnapshot;
  private _lastAttemptAt = 0;
  private _inFlight: Promise<void> | null = null;

  constructor(appRoot: string) {
    this._cacheFile = path.join(appRoot, 'data', 'claude-plan-usage.json');
    this._snapshot = {
      fetchedAt: null,
      planTier: null,
      subscriptionType: null,
      rateLimits: null,
      lastError: null,
    };
  }

  async init(): Promise<void> {
    try {
      const raw = await fsp.readFile(this._cacheFile, 'utf8');
      const parsed = JSON.parse(raw);
      this._snapshot = {
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
    }
  }

  getCached(): ClaudePlanUsageResponse {
    const now = Date.now();
    const fetchedAtMs = this._snapshot.fetchedAt
      ? new Date(this._snapshot.fetchedAt).getTime()
      : null;
    const stale = fetchedAtMs == null || now - fetchedAtMs > STALE_AFTER_MS;
    return { ...this._snapshot, stale };
  }

  maybeRefresh(reason: string): Promise<void> {
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

  private async _persist(): Promise<void> {
    try {
      await fsp.mkdir(path.dirname(this._cacheFile), { recursive: true });
      await atomicWriteFile(this._cacheFile, JSON.stringify(this._snapshot, null, 2));
    } catch (err: unknown) {
      console.warn('[claudePlanUsage] Failed to persist cache:', (err as Error).message);
    }
  }
}

function isExpired(expiresAt: number | null): boolean {
  if (expiresAt == null) return false;
  return Date.now() + EXPIRY_BUFFER_MS >= expiresAt;
}

async function readStoredCredentials(): Promise<StoredCreds> {
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
