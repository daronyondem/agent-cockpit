import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { CliAuthCheckResult, CliAuthJobSnapshot, CliProfile } from '../types';
import { CortexConnections, cortexSnowflakeHome } from './cortexConnections';
import { cortexOwnedRedirect, type CortexOAuthOwner } from './cortexOAuth';
import { startCortexLogin, type CortexLoginProcess } from './cortexLogin';
import { verifyCortexAuthentication } from './cortexAuthVerification';
import { cortexVersion, resolveCortexRuntime } from './backends/cortexRuntime';
import { isSetupAccountCliProfile } from './cliProfiles';
import { logger } from '../utils/logger';

interface AuthEntry {
  snapshot: CliAuthJobSnapshot;
  abort: AbortController;
  owner?: CortexOAuthOwner;
  login?: CortexLoginProcess;
  expiresAt?: number;
  submitted: boolean;
  timer?: NodeJS.Timeout;
  wake?: () => void;
  done?: Promise<void>;
}

export class CortexAuth {
  private jobs = new Map<string, AuthEntry>();
  private scopes = new Set<string>();
  private generation = 0;
  private checks = new Map<AbortController, Promise<CliAuthCheckResult>>();

  constructor(private options: {
    connections?: CortexConnections;
    verify?: typeof verifyCortexAuthentication;
    login?: typeof startCortexLogin;
    version?: typeof cortexVersion;
    startupTimeoutMs?: number;
    completionTimeoutMs?: number;
  } = {}) {}

  get connections(): CortexConnections { return this.options.connections || new CortexConnections(); }

  async check(profile: CliProfile): Promise<CliAuthCheckResult> {
    const scope = this.scope(profile);
    if (this.scopes.has(scope)) throw new Error('Cortex Code authentication is already using this Snowflake home.');
    this.scopes.add(scope);
    const abort = new AbortController();
    const pending = Promise.resolve().then(() => (this.options.verify || verifyCortexAuthentication)(profile, abort.signal));
    this.checks.set(abort, pending);
    try { return await pending; }
    finally { this.scopes.delete(scope); this.checks.delete(abort); }
  }

  async start(profile: CliProfile): Promise<CliAuthJobSnapshot> {
    if (profile.disabled || profile.harness !== 'cortex-code' || profile.authMode !== 'account') throw new Error('An enabled Cortex Code account profile is required.');
    if (!isSetupAccountCliProfile(profile) && (profile.configDir || Object.keys(profile.env || {}).some(key => key.toUpperCase() === 'SNOWFLAKE_HOME'))) {
      throw new Error('Remote Cortex Code login uses shared terminal authentication. Log in isolated profiles in their own terminal.');
    }
    const scope = this.scope(profile);
    if (this.scopes.has(scope)) throw new Error('Cortex Code authentication is already using this Snowflake home. Wait for cleanup before retrying.');
    this.scopes.add(scope); // Reserve before the first await, including other profiles.
    const now = new Date().toISOString();
    const snapshot: CliAuthJobSnapshot = { id: `cortex-auth-${crypto.randomUUID()}`, profileId: profile.id, profileName: profile.name,
      harness: 'cortex-code', status: 'running', startedAt: now, updatedAt: now, command: profile.command || 'cortex', args: [], events: [],
      cortex: { phase: 'starting', generation: crypto.randomUUID(), connection: profile.cortexCode?.connection || '' } };
    const entry: AuthEntry = { snapshot, abort: new AbortController(), submitted: false };
    this.jobs.set(snapshot.id, entry);
    const generation = this.generation;
    entry.done = this.run(entry, profile, generation).catch(() => {
      logger.warn('Cortex authentication cleanup failed');
    }).finally(() => { this.scopes.delete(scope); this.trim(); });
    return this.get(snapshot.id)!;
  }

  get(id: string): CliAuthJobSnapshot | null {
    const entry = this.jobs.get(id);
    return entry ? structuredClone(entry.snapshot) : null;
  }

  activeJob(): CliAuthJobSnapshot | null {
    const entry = [...this.jobs.values()].find(item => item.snapshot.status === 'running');
    return entry ? this.get(entry.snapshot.id) : null;
  }

  redirect(id: string, generation: string, raw: string): CliAuthJobSnapshot {
    const entry = this.jobs.get(id);
    if (!entry || entry.snapshot.status !== 'running' || entry.snapshot.cortex?.phase !== 'waiting-for-browser'
      || generation !== entry.snapshot.cortex.generation || entry.submitted || !entry.owner || !entry.login
      || !entry.expiresAt || Date.now() >= entry.expiresAt) throw new Error('This login handoff is no longer active. Start authentication again.');
    const redirect = cortexOwnedRedirect(raw, entry.owner);
    entry.submitted = true;
    entry.owner = undefined; // Consume before writing; never retry an OAuth code.
    this.phase(entry, 'verifying');
    this.deadline(entry, this.options.completionTimeoutMs ?? 90_000);
    try { entry.login.write(`${redirect}\r`); }
    catch { this.finish(entry, 'failed', 'The native login stopped before receiving the redirect. Start authentication again.'); }
    return this.get(id)!;
  }

  cancel(id: string): CliAuthJobSnapshot {
    const entry = this.jobs.get(id);
    if (!entry) throw new Error('Auth job not found');
    this.finish(entry, 'cancelled', 'Authentication cancelled.');
    return this.get(id)!;
  }

  shutdown(): void {
    this.generation++;
    for (const abort of this.checks.keys()) abort.abort();
    for (const entry of this.jobs.values()) this.finish(entry, 'cancelled', 'Authentication cancelled because the server is shutting down.');
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.jobs.values()].flatMap(entry => entry.done ? [entry.done] : []));
    await Promise.allSettled(this.checks.values());
  }

  private async run(entry: AuthEntry, profile: CliProfile, generation: number): Promise<void> {
    let root: string | undefined;
    try {
      const connection = await this.connections.selected(profile.cortexCode?.connection || '');
      if (!this.active(entry, generation)) return;
      this.phase(entry, 'verifying');
      const cached = await (this.options.verify || verifyCortexAuthentication)(profile, entry.abort.signal);
      if (!this.active(entry, generation)) return;
      if (cached.authenticated) { this.finish(entry, 'succeeded', cached.output); return; }
      if (!connection.manualOAuth) throw new Error('Use an OAuth authorization-code connection for remote login. Other connection types can be checked after terminal setup.');
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-cortex-login-'));
      await fs.chmod(root, 0o700);
      const config = resolveCortexRuntime({ profile, workspaceId: 'auth-login', cwd: root });
      const version = await (this.options.version || cortexVersion)(config, entry.abort.signal);
      if (!this.active(entry, generation)) return;
      if (version !== '1.2.35' && !version.startsWith('1.2.35+')) throw new Error('This Cortex Code version has not been verified for remote login. Use terminal login, then Check login.');
      this.phase(entry, 'starting');
      entry.snapshot.cortex!.version = version;
      this.deadline(entry, this.options.startupTimeoutMs ?? 90_000);
      const browserStarted = Date.now();
      const completed = new Promise<void>(resolve => { entry.wake = resolve; });
      entry.login = (this.options.login || startCortexLogin)(config, connection.name, {
        owner: owner => {
          if (!this.active(entry, generation)) return;
          entry.owner = owner;
          entry.expiresAt = browserStarted + connection.browserTimeoutMs;
          this.phase(entry, 'waiting-for-browser');
          entry.snapshot.cortex!.authorizationUrl = owner.authorizationUrl;
          entry.snapshot.cortex!.expiresAt = new Date(entry.expiresAt).toISOString();
          this.deadline(entry, Math.max(1, entry.expiresAt - Date.now()));
        },
        received: () => {
          if (!this.active(entry, generation)) return;
          this.phase(entry, 'verifying');
          // Give the native credential exchange time to write its shared cache.
          this.deadline(entry, this.options.completionTimeoutMs ?? 90_000);
          // Continue observing native completion; don't kill during token exchange.
        },
        ready: () => entry.wake?.(),
        failed: () => this.finish(entry, 'failed', 'Native login failed or expired. Start a new login; do not reuse its redirect.'),
        exit: () => entry.wake?.(),
      });
      // Native startup/onboarding completion follows the credential exchange.
      // Receipt of a callback alone must not race a fresh verification request.
      await completed;
      if (!this.active(entry, generation)) return;
      this.phase(entry, 'verifying');
      const verified = await (this.options.verify || verifyCortexAuthentication)(profile, entry.abort.signal);
      if (!this.active(entry, generation)) return;
      this.finish(entry, verified.authenticated ? 'succeeded' : 'failed', verified.authenticated ? verified.output
        : 'Login did not verify from a fresh process. Check credentials, account/model grants and service availability.');
    } catch (error) {
      const known = error instanceof Error && /^(Use an OAuth|This Cortex Code version|The selected Snowflake|Could not safely)/.test(error.message);
      this.finish(entry, 'failed', known ? error.message : 'Cortex Code login could not start. Check CLI installation, native connections and permissions.');
    } finally {
      clearTimeout(entry.timer);
      await entry.login?.stop();
      entry.owner = undefined; entry.login = undefined; entry.wake = undefined;
      if (root) await fs.rm(root, { recursive: true, force: true });
    }
  }

  private scope(profile: CliProfile): string {
    if (isSetupAccountCliProfile(profile)) return this.connections.home;
    return profile.configDir ? path.resolve(profile.configDir.replace(/^~(?=\/|$)/, os.homedir()))
      : cortexSnowflakeHome({ ...process.env, SNOWFLAKE_HOME: this.connections.home, ...profile.env });
  }

  private active(entry: AuthEntry, generation: number): boolean {
    return entry.snapshot.status === 'running' && this.generation === generation;
  }

  private phase(entry: AuthEntry, phase: 'starting' | 'waiting-for-browser' | 'verifying'): void {
    const { generation, version, connection } = entry.snapshot.cortex!;
    entry.snapshot.cortex = { generation, connection, phase, ...(version ? { version } : {}) };
    this.updated(entry);
  }

  private deadline(entry: AuthEntry, ms: number): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.finish(entry, 'failed', 'Cortex Code login timed out. Start a new login and use its new URL.'), Math.min(ms, 2_147_483_647));
  }

  private finish(entry: AuthEntry, status: 'succeeded' | 'failed' | 'cancelled', message: string): void {
    if (entry.snapshot.status !== 'running') return;
    clearTimeout(entry.timer);
    entry.snapshot.status = status;
    this.updated(entry);
    entry.snapshot.events.push({ at: entry.snapshot.updatedAt, type: status === 'failed' ? 'error' : 'info', text: message });
    if (status !== 'succeeded') entry.snapshot.error = message;
    delete entry.snapshot.cortex;
    entry.owner = undefined;
    entry.abort.abort();
    entry.wake?.();
  }

  private trim(): void {
    const completed = [...this.jobs].filter(([, entry]) => entry.snapshot.status !== 'running');
    for (const [id] of completed.slice(0, Math.max(0, this.jobs.size - 40))) this.jobs.delete(id);
  }

  private updated(entry: AuthEntry): void {
    entry.snapshot.updatedAt = new Date(Math.max(Date.now(), Date.parse(entry.snapshot.updatedAt) + 1)).toISOString();
  }
}
