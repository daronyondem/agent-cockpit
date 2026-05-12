import Database from 'better-sqlite3';
import fsp from 'fs/promises';
import { homedir } from 'os';
import path from 'path';
import { atomicWriteFile } from '../utils/atomicWrite';

// Kiro CLI = Amazon Q Developer CLI under the hood. It stores its AWS IdC
// (SSO) access_token and the active CodeWhisperer profile ARN in a local
// SQLite DB. We open that DB read-only and call the same `GetUsageLimits`
// API the CLI's own `/usage` command hits, with the CLI's bearer token.
//
// API shape (captured via mitmproxy):
//   POST https://q.us-east-1.amazonaws.com/?profileArn=<enc>&origin=KIRO_CLI
//   content-type: application/x-amz-json-1.0
//   x-amz-target: AmazonCodeWhispererService.GetUsageLimits
//   authorization: Bearer <IdC access_token>
//   body: {"profileArn":"<arn>","origin":"KIRO_CLI"}

const Q_API_URL = 'https://q.us-east-1.amazonaws.com/';
const Q_TARGET = 'AmazonCodeWhispererService.GetUsageLimits';
const Q_ORIGIN = 'KIRO_CLI';

// Same cadence as ClaudePlanUsageService — don't refresh more than once
// per 10 minutes. Tracks the last *attempt* so failures back off too.
const REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000;
const STALE_AFTER_MS = 15 * 60 * 1000;
// IdC access tokens rotate every ~8 min. Avoid firing a call that's
// about to 401 — if <30s is left we skip and wait for the CLI to refresh.
const EXPIRY_BUFFER_MS = 30 * 1000;

export interface KiroUsageBreakdown {
  currency: string | null;
  currentUsage: number | null;
  currentUsageWithPrecision: number | null;
  currentOverages: number | null;
  currentOveragesWithPrecision: number | null;
  overageCap: number | null;
  overageCapWithPrecision: number | null;
  overageCharges: number | null;
  overageRate: number | null;
  usageLimit: number | null;
  usageLimitWithPrecision: number | null;
  displayName: string | null;
  displayNamePlural: string | null;
  resourceType: string | null;
  unit: string | null;
  nextDateReset: number | null;
  bonuses: unknown[];
}

export interface KiroSubscriptionInfo {
  subscriptionTitle: string | null;
  type: string | null;
  overageCapability: string | null;
  upgradeCapability: string | null;
  subscriptionManagementTarget: string | null;
}

export interface KiroUsageData {
  subscription: KiroSubscriptionInfo | null;
  overageStatus: string | null;
  nextDateReset: number | null;
  breakdown: KiroUsageBreakdown | null;
}

export interface KiroPlanUsageSnapshot {
  fetchedAt: string | null;
  usage: KiroUsageData | null;
  lastError: string | null;
}

export interface KiroPlanUsageResponse extends KiroPlanUsageSnapshot {
  stale: boolean;
}

interface KiroAuth {
  accessToken: string;
  expiresAt: number | null;
  profileArn: string;
}

export class KiroPlanUsageService {
  private _cacheFile: string;
  private _dbPath: string;
  private _snapshot: KiroPlanUsageSnapshot;
  private _lastAttemptAt = 0;
  private _inFlight: Promise<void> | null = null;

  constructor(appRoot: string, options: { dbPath?: string; dataRoot?: string } = {}) {
    const dataRoot = options.dataRoot || path.join(appRoot, 'data');
    this._cacheFile = path.join(dataRoot, 'kiro-plan-usage.json');
    this._dbPath = options.dbPath || defaultKiroDbPath();
    this._snapshot = { fetchedAt: null, usage: null, lastError: null };
  }

  async init(): Promise<void> {
    try {
      const raw = await fsp.readFile(this._cacheFile, 'utf8');
      const parsed = JSON.parse(raw);
      this._snapshot = {
        fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : null,
        usage: parsed.usage ?? null,
        lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[kiroPlanUsage] Failed to load cache:', (err as Error).message);
      }
    }
  }

  getCached(): KiroPlanUsageResponse {
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
      const auth = readKiroAuth(this._dbPath);
      if (isExpired(auth.expiresAt)) {
        this._snapshot = { ...this._snapshot, lastError: 'token-expired' };
        await this._persist();
        // Token-expired isn't a real attempt — we never reached the API. Reset
        // the throttle so the next trigger can retry the moment kiro-cli rotates
        // its IdC token, instead of waiting out the full 10-min cooldown.
        this._lastAttemptAt = 0;
        console.log(`[kiroPlanUsage] refresh(${reason}) skipped: access token expired`);
        return;
      }
      const url = `${Q_API_URL}?profileArn=${encodeURIComponent(auth.profileArn)}&origin=${Q_ORIGIN}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.0',
          'X-Amz-Target': Q_TARGET,
          'Authorization': `Bearer ${auth.accessToken}`,
          'X-Amzn-Codewhisperer-Optout': 'false',
          'Accept': '*/*',
        },
        body: JSON.stringify({ profileArn: auth.profileArn, origin: Q_ORIGIN }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`GetUsageLimits ${res.status}: ${text.slice(0, 200)}`);
      }
      const body = await res.json();
      this._snapshot = {
        fetchedAt: new Date().toISOString(),
        usage: normalizeUsage(body),
        lastError: null,
      };
      await this._persist();
      console.log(`[kiroPlanUsage] refresh(${reason}) ok`);
    } catch (err: unknown) {
      const msg = (err as Error).message || String(err);
      this._snapshot = { ...this._snapshot, lastError: msg };
      await this._persist();
      console.warn(`[kiroPlanUsage] refresh(${reason}) failed: ${msg}`);
    }
  }

  private async _persist(): Promise<void> {
    try {
      await fsp.mkdir(path.dirname(this._cacheFile), { recursive: true });
      await atomicWriteFile(this._cacheFile, JSON.stringify(this._snapshot, null, 2));
    } catch (err: unknown) {
      console.warn('[kiroPlanUsage] Failed to persist cache:', (err as Error).message);
    }
  }
}

function defaultKiroDbPath(): string {
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'kiro-cli', 'data.sqlite3');
  }
  const xdgData = process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
  return path.join(xdgData, 'kiro-cli', 'data.sqlite3');
}

function isExpired(expiresAt: number | null): boolean {
  if (expiresAt == null) return false;
  return Date.now() + EXPIRY_BUFFER_MS >= expiresAt;
}

function readKiroAuth(dbPath: string): KiroAuth {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err: unknown) {
    const msg = (err as Error).message || String(err);
    throw new Error(`kiro-cli DB unavailable at ${dbPath}: ${msg}`);
  }
  try {
    const tokenRow = db
      .prepare("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'")
      .get() as { value?: string } | undefined;
    const profileRow = db
      .prepare("SELECT value FROM state WHERE key = 'api.codewhisperer.profile'")
      .get() as { value?: string } | undefined;
    if (!tokenRow?.value) throw new Error('kiro-cli auth_kv missing access token');
    if (!profileRow?.value) throw new Error('kiro-cli state missing profile');

    const tokenBlob = JSON.parse(tokenRow.value) as {
      access_token?: string;
      expires_at?: string;
    };
    const profileBlob = JSON.parse(profileRow.value) as { arn?: string };
    if (typeof tokenBlob.access_token !== 'string' || !tokenBlob.access_token) {
      throw new Error('kiro-cli token blob missing access_token');
    }
    if (typeof profileBlob.arn !== 'string' || !profileBlob.arn) {
      throw new Error('kiro-cli profile blob missing arn');
    }
    const expiresAt = typeof tokenBlob.expires_at === 'string'
      ? new Date(tokenBlob.expires_at).getTime()
      : null;
    return {
      accessToken: tokenBlob.access_token,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
      profileArn: profileBlob.arn,
    };
  } finally {
    db.close();
  }
}

function normalizeUsage(body: unknown): KiroUsageData {
  const b = (body ?? {}) as Record<string, unknown>;
  const sub = (b.subscriptionInfo ?? {}) as Record<string, unknown>;
  const overage = (b.overageConfiguration ?? {}) as Record<string, unknown>;
  const listRaw = Array.isArray(b.usageBreakdownList) ? b.usageBreakdownList : [];
  const first = (listRaw[0] ?? {}) as Record<string, unknown>;
  return {
    subscription: {
      subscriptionTitle: strOrNull(sub.subscriptionTitle),
      type: strOrNull(sub.type),
      overageCapability: strOrNull(sub.overageCapability),
      upgradeCapability: strOrNull(sub.upgradeCapability),
      subscriptionManagementTarget: strOrNull(sub.subscriptionManagementTarget),
    },
    overageStatus: strOrNull(overage.overageStatus),
    nextDateReset: numOrNull(b.nextDateReset),
    breakdown: listRaw.length > 0 ? {
      currency: strOrNull(first.currency),
      currentUsage: numOrNull(first.currentUsage),
      currentUsageWithPrecision: numOrNull(first.currentUsageWithPrecision),
      currentOverages: numOrNull(first.currentOverages),
      currentOveragesWithPrecision: numOrNull(first.currentOveragesWithPrecision),
      overageCap: numOrNull(first.overageCap),
      overageCapWithPrecision: numOrNull(first.overageCapWithPrecision),
      overageCharges: numOrNull(first.overageCharges),
      overageRate: numOrNull(first.overageRate),
      usageLimit: numOrNull(first.usageLimit),
      usageLimitWithPrecision: numOrNull(first.usageLimitWithPrecision),
      displayName: strOrNull(first.displayName),
      displayNamePlural: strOrNull(first.displayNamePlural),
      resourceType: strOrNull(first.resourceType),
      unit: strOrNull(first.unit),
      nextDateReset: numOrNull(first.nextDateReset),
      bonuses: Array.isArray(first.bonuses) ? first.bonuses : [],
    } : null,
  };
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
