import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import type { CliProfile, Settings } from '../types';
import { resolveClaudeCliRuntime } from './backends/claudeCode';
import { resolveCodexCliRuntime } from './backends/codex';
import { buildCliCommandInvocation, type CliCommandResolution } from './cliCommandResolver';
import { isSetupAccountCliProfile } from './cliProfiles';

export type CliAuthJobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type CliAuthEventType = 'info' | 'stdout' | 'stderr' | 'error' | 'exit';

export interface CliAuthEvent {
  at: string;
  type: CliAuthEventType;
  text: string;
}

export interface CliAuthJobSnapshot {
  id: string;
  profileId: string;
  profileName: string;
  vendor: CliProfile['vendor'];
  status: CliAuthJobStatus;
  startedAt: string;
  updatedAt: string;
  command: string;
  args: string[];
  events: CliAuthEvent[];
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
}

export interface CliAuthCheckResult {
  profileId: string;
  vendor: CliProfile['vendor'];
  command: string;
  available: boolean;
  authenticated: boolean | null;
  status: 'ok' | 'not-authenticated' | 'unavailable' | 'unsupported' | 'error';
  output: string;
  error?: string;
  exitCode?: number | null;
  modelsAvailable?: boolean;
  modelCount?: number;
  modelListError?: string;
}

type SpawnLike = typeof spawn;

interface CliAuthRuntime extends CliCommandResolution {
  command: string;
  env: NodeJS.ProcessEnv;
  configDir?: string;
}

const MAX_EVENTS = 120;
const MAX_EVENT_TEXT = 4_000;
const RECENT_JOBS_LIMIT = 40;
const DEFAULT_AUTH_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_STATUS_POLL_TIMEOUT_MS = 60_000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2_000;

export class CliProfileAuthService {
  private readonly _baseDir: string;
  private readonly _spawn: SpawnLike;
  private readonly _authTimeoutMs: number;
  private readonly _statusPollTimeoutMs: number;
  private readonly _statusPollIntervalMs: number;
  private readonly _jobs = new Map<string, { snapshot: CliAuthJobSnapshot; child?: ChildProcess; timeout?: NodeJS.Timeout }>();

  constructor(baseDir: string, opts: {
    spawn?: SpawnLike;
    authTimeoutMs?: number;
    statusPollTimeoutMs?: number;
    statusPollIntervalMs?: number;
  } = {}) {
    this._baseDir = baseDir;
    this._spawn = opts.spawn || spawn;
    this._authTimeoutMs = opts.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    this._statusPollTimeoutMs = opts.statusPollTimeoutMs ?? DEFAULT_STATUS_POLL_TIMEOUT_MS;
    this._statusPollIntervalMs = opts.statusPollIntervalMs ?? DEFAULT_STATUS_POLL_INTERVAL_MS;
  }

  defaultConfigDir(profile: Pick<CliProfile, 'id'>): string {
    const slug = String(profile.id || 'profile')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'profile';
    const hash = crypto.createHash('sha1').update(String(profile.id || '')).digest('hex').slice(0, 10);
    return path.join(this._baseDir, 'cli-profiles', `${slug}-${hash}`);
  }

  profileWithAuthDefaults(settings: Settings, profileId: string): { settings: Settings; profile: CliProfile; changed: boolean } {
    const profiles = Array.isArray(settings.cliProfiles) ? settings.cliProfiles : [];
    const profile = profiles.find(candidate => candidate.id === profileId);
    if (!profile) throw new Error(`CLI profile not found: ${profileId}`);
    this._assertCanAuth(profile);

    if (isSetupAccountCliProfile(profile)) {
      const nextProfile = withoutSetupAuthHome(profile);
      if (nextProfile === profile) {
        return { settings, profile, changed: false };
      }
      const nextProfiles = profiles.map(candidate => candidate.id === profile.id ? nextProfile : candidate);
      return {
        settings: { ...settings, cliProfiles: nextProfiles },
        profile: nextProfile,
        changed: true,
      };
    }

    if (profile.configDir) {
      return { settings, profile, changed: false };
    }

    const now = new Date().toISOString();
    const configDir = this.defaultConfigDir(profile);
    const nextProfile = { ...profile, configDir, updatedAt: now };
    const nextProfiles = profiles.map(candidate => candidate.id === profile.id ? nextProfile : candidate);
    return {
      settings: { ...settings, cliProfiles: nextProfiles },
      profile: nextProfile,
      changed: true,
    };
  }

  async checkProfile(profile: CliProfile): Promise<CliAuthCheckResult> {
    try {
      this._assertSupported(profile);
      const runtime = await this._runtimeFor(profile);
      const { args } = this._statusCommand(profile);
      const invocation = buildCliCommandInvocation(runtime, args);
      const result = await this._runCommand(invocation.command, invocation.args, runtime.env, 15_000);
      const rawOutput = [result.stdout, result.stderr].filter(Boolean).join('\n');
      const output = redactCliAuthText(rawOutput);
      const status = interpretCliAuthStatus(profile, result.code, rawOutput);
      return {
        profileId: profile.id,
        vendor: profile.vendor,
        command: runtime.displayCommand || runtime.command,
        available: result.spawned,
        authenticated: status.authenticated,
        status: status.authenticated ? 'ok' : 'not-authenticated',
        output,
        exitCode: result.code,
        ...(status.authenticated ? {} : { error: output || status.error || 'CLI status check reported that this profile is not authenticated.' }),
      };
    } catch (err: unknown) {
      const message = (err as Error).message || String(err);
      const unsupported = profile.vendor === 'kiro';
      return {
        profileId: profile.id,
        vendor: profile.vendor,
        command: profile.command || this._defaultCommand(profile),
        available: false,
        authenticated: null,
        status: unsupported ? 'unsupported' : message.includes('ENOENT') ? 'unavailable' : 'error',
        output: '',
        error: message,
      };
    }
  }

  async startAuth(profile: CliProfile): Promise<CliAuthJobSnapshot> {
    this._assertCanAuth(profile);
    for (const { snapshot } of this._jobs.values()) {
      if (snapshot.profileId === profile.id && snapshot.status === 'running') {
        throw new Error(`Authentication is already running for ${profile.name}`);
      }
    }

    const runtime = await this._runtimeFor(profile);
    const { args } = this._loginCommand(profile);
    const statusArgs = this._statusCommand(profile).args;
    const now = new Date().toISOString();
    const snapshot: CliAuthJobSnapshot = {
      id: `auth-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
      profileId: profile.id,
      profileName: profile.name,
      vendor: profile.vendor,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      command: runtime.displayCommand || runtime.command,
      args,
      events: [],
    };

    this._addEvent(snapshot, 'info', `Starting ${this._vendorLabel(profile)} authentication.`);
    const invocation = buildCliCommandInvocation(runtime, args);
    const child = this._spawn(invocation.command, invocation.args, {
      env: runtime.env,
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timeout = setTimeout(() => {
      const entry = this._jobs.get(snapshot.id);
      if (!entry || entry.snapshot.status !== 'running') return;
      entry.snapshot.status = 'failed';
      entry.snapshot.error = `${this._vendorLabel(profile)} authentication timed out. Start authentication again and complete the browser login before the code expires.`;
      entry.snapshot.updatedAt = new Date().toISOString();
      this._addEvent(entry.snapshot, 'error', entry.snapshot.error);
      entry.child?.kill('SIGTERM');
      this._jobs.set(snapshot.id, { snapshot: entry.snapshot });
    }, this._authTimeoutMs);
    this._jobs.set(snapshot.id, { snapshot, child, timeout });
    this._trimJobs();

    child.stdout?.on('data', chunk => this._addEvent(snapshot, 'stdout', chunk.toString()));
    child.stderr?.on('data', chunk => this._addEvent(snapshot, 'stderr', chunk.toString()));
    child.on('error', err => {
      this._clearJobTimeout(snapshot.id);
      snapshot.status = 'failed';
      snapshot.error = err.message;
      snapshot.updatedAt = new Date().toISOString();
      this._addEvent(snapshot, 'error', err.message);
      this._jobs.set(snapshot.id, { snapshot });
    });
    child.on('close', (code, signal) => {
      void this._handleAuthClose(profile, runtime, statusArgs, snapshot, code, signal);
    });

    return this.getJob(snapshot.id)!;
  }

  getJob(jobId: string): CliAuthJobSnapshot | null {
    const entry = this._jobs.get(jobId);
    return entry ? this._cloneSnapshot(entry.snapshot) : null;
  }

  cancelJob(jobId: string): CliAuthJobSnapshot {
    const entry = this._jobs.get(jobId);
    if (!entry) throw new Error(`Auth job not found: ${jobId}`);
    if (entry.snapshot.status !== 'running') return this._cloneSnapshot(entry.snapshot);
    if (entry.timeout) clearTimeout(entry.timeout);
    entry.snapshot.status = 'cancelled';
    entry.snapshot.updatedAt = new Date().toISOString();
    entry.snapshot.error = 'Authentication cancelled.';
    this._addEvent(entry.snapshot, 'info', 'Authentication cancelled.');
    entry.child?.kill('SIGTERM');
    return this._cloneSnapshot(entry.snapshot);
  }

  shutdown(): void {
    for (const [jobId, entry] of this._jobs) {
      if (entry.snapshot.status !== 'running') continue;
      if (entry.timeout) clearTimeout(entry.timeout);
      entry.snapshot.status = 'cancelled';
      entry.snapshot.updatedAt = new Date().toISOString();
      entry.snapshot.error = 'Authentication cancelled because the server is shutting down.';
      entry.child?.kill('SIGTERM');
      this._jobs.set(jobId, { snapshot: entry.snapshot });
    }
  }

  private _assertSupported(profile: CliProfile): void {
    if (profile.vendor !== 'codex' && profile.vendor !== 'claude-code') {
      throw new Error('Remote authentication is not supported for Kiro profiles yet.');
    }
  }

  private _assertCanAuth(profile: CliProfile): void {
    this._assertSupported(profile);
    if (profile.disabled) {
      throw new Error(`CLI profile is disabled: ${profile.name}`);
    }
    if (profile.authMode !== 'account') {
      throw new Error('Remote authentication is only available for account profiles.');
    }
  }

  private async _runtimeFor(profile: CliProfile): Promise<CliAuthRuntime> {
    const runtime = profile.vendor === 'codex'
      ? resolveCodexCliRuntime(profile)
      : resolveClaudeCliRuntime(profile);
    if (runtime.configDir) {
      await fsp.mkdir(runtime.configDir, { recursive: true });
    }
    return runtime;
  }

  private _loginCommand(profile: CliProfile): { args: string[] } {
    if (profile.vendor === 'codex') return { args: ['login', '--device-auth'] };
    return { args: ['auth', 'login', '--claudeai'] };
  }

  private _statusCommand(profile: CliProfile): { args: string[] } {
    if (profile.vendor === 'codex') return { args: ['login', 'status'] };
    return { args: ['auth', 'status', '--json'] };
  }

  private _defaultCommand(profile: CliProfile): string {
    if (profile.vendor === 'codex') return 'codex';
    if (profile.vendor === 'claude-code') return 'claude';
    return 'kiro-cli';
  }

  private _vendorLabel(profile: CliProfile): string {
    return profile.vendor === 'codex' ? 'Codex' : profile.vendor === 'claude-code' ? 'Claude Code' : 'Kiro';
  }

  private _addEvent(snapshot: CliAuthJobSnapshot, type: CliAuthEventType, text: string): void {
    const cleaned = redactCliAuthText(text).trim();
    if (!cleaned) return;
    snapshot.events.push({
      at: new Date().toISOString(),
      type,
      text: cleaned.slice(0, MAX_EVENT_TEXT),
    });
    if (snapshot.events.length > MAX_EVENTS) {
      snapshot.events.splice(0, snapshot.events.length - MAX_EVENTS);
    }
    snapshot.updatedAt = new Date().toISOString();
  }

  private _clearJobTimeout(jobId: string): void {
    const entry = this._jobs.get(jobId);
    if (entry?.timeout) clearTimeout(entry.timeout);
  }

  private async _handleAuthClose(
    profile: CliProfile,
    runtime: CliAuthRuntime,
    statusArgs: string[],
    snapshot: CliAuthJobSnapshot,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    this._clearJobTimeout(snapshot.id);
    snapshot.exitCode = code;
    snapshot.signal = signal;

    if (snapshot.status === 'cancelled') {
      snapshot.updatedAt = new Date().toISOString();
      this._addEvent(snapshot, 'exit', snapshot.error || 'Authentication cancelled.');
      this._jobs.set(snapshot.id, { snapshot });
      return;
    }

    if (snapshot.status === 'failed') {
      snapshot.updatedAt = new Date().toISOString();
      this._addEvent(snapshot, 'exit', snapshot.error || 'Authentication failed.');
      this._jobs.set(snapshot.id, { snapshot });
      return;
    }

    if (code !== 0) {
      snapshot.status = 'failed';
      snapshot.error = `${this._vendorLabel(profile)} auth exited with code ${code ?? 'unknown'}.`;
      snapshot.updatedAt = new Date().toISOString();
      this._addEvent(snapshot, 'exit', snapshot.error);
      this._jobs.set(snapshot.id, { snapshot });
      return;
    }

    this._addEvent(snapshot, 'info', `Verifying ${this._vendorLabel(profile)} authentication status.`);
    try {
      await this._pollAuthenticated(profile, runtime, statusArgs, snapshot);
      snapshot.status = 'succeeded';
      snapshot.updatedAt = new Date().toISOString();
      this._addEvent(snapshot, 'exit', 'Authentication completed.');
    } catch (err: unknown) {
      snapshot.status = 'failed';
      snapshot.error = (err as Error).message || String(err);
      snapshot.updatedAt = new Date().toISOString();
      this._addEvent(snapshot, 'exit', snapshot.error);
    }
    this._jobs.set(snapshot.id, { snapshot });
  }

  private async _pollAuthenticated(
    profile: CliProfile,
    runtime: CliAuthRuntime,
    statusArgs: string[],
    snapshot: CliAuthJobSnapshot,
  ): Promise<void> {
    const startedAt = Date.now();
    let lastOutput = '';
    while (Date.now() - startedAt <= this._statusPollTimeoutMs) {
      const invocation = buildCliCommandInvocation(runtime, statusArgs);
      const result = await this._runCommand(
        invocation.command,
        invocation.args,
        runtime.env,
        Math.min(15_000, Math.max(1_000, this._statusPollTimeoutMs)),
      );
      const rawOutput = [result.stdout, result.stderr].filter(Boolean).join('\n');
      const output = redactCliAuthText(rawOutput).trim();
      const status = interpretCliAuthStatus(profile, result.code, rawOutput);
      if (status.authenticated) {
        if (output) this._addEvent(snapshot, 'info', output);
        return;
      }
      lastOutput = output || status.error || `${this._vendorLabel(profile)} status exited with code ${result.code ?? 'unknown'}.`;
      await this._sleep(this._statusPollIntervalMs);
    }
    throw new Error(
      `${this._vendorLabel(profile)} authentication did not verify before timeout. ` +
      (lastOutput || 'Start authentication again or run Check CLI for details.'),
    );
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private _trimJobs(): void {
    const entries = [...this._jobs.entries()];
    if (entries.length <= RECENT_JOBS_LIMIT) return;
    const removable = entries
      .filter(([, entry]) => entry.snapshot.status !== 'running')
      .sort((a, b) => a[1].snapshot.updatedAt.localeCompare(b[1].snapshot.updatedAt));
    for (const [jobId] of removable.slice(0, entries.length - RECENT_JOBS_LIMIT)) {
      this._jobs.delete(jobId);
    }
  }

  private _cloneSnapshot(snapshot: CliAuthJobSnapshot): CliAuthJobSnapshot {
    return {
      ...snapshot,
      args: [...snapshot.args],
      events: snapshot.events.map(event => ({ ...event })),
    };
  }

  private _runCommand(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
  ): Promise<{ spawned: boolean; code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = this._spawn(command, args, {
        env,
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => {
        if (settled) return;
        child.kill('SIGTERM');
        settled = true;
        reject(new Error(`${command} ${args.join(' ')} timed out`));
      }, timeoutMs);
      child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ spawned: true, code, stdout, stderr });
      });
    });
  }
}

function withoutSetupAuthHome(profile: CliProfile): CliProfile {
  if (!isSetupAccountCliProfile(profile)) return profile;
  const { configDir: _configDir, env, ...rest } = profile;
  const nextEnv = stripSetupAuthHomeEnv(profile.vendor, env);
  const changed = Boolean(configDirWasPresent(profile) || nextEnv !== env);
  if (!changed) return profile;
  return {
    ...rest,
    ...(nextEnv && Object.keys(nextEnv).length > 0 ? { env: nextEnv } : {}),
    updatedAt: new Date().toISOString(),
  };
}

function configDirWasPresent(profile: CliProfile): boolean {
  return typeof profile.configDir === 'string' && profile.configDir.trim().length > 0;
}

function stripSetupAuthHomeEnv(vendor: CliProfile['vendor'], env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return env;
  const stripped: Record<string, string> = {};
  let changed = false;
  for (const [key, value] of Object.entries(env)) {
    const normalized = key.toUpperCase();
    const remove = (vendor === 'claude-code' && normalized === 'CLAUDE_CONFIG_DIR')
      || (vendor === 'codex' && normalized === 'CODEX_HOME');
    if (remove) {
      changed = true;
      continue;
    }
    stripped[key] = value;
  }
  if (!changed) return env;
  return Object.keys(stripped).length > 0 ? stripped : undefined;
}

export function redactCliAuthText(input: string): string {
  return String(input || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[@-_]/g, '')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/(access[_-]?token["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/(refresh[_-]?token["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/(sk-[A-Za-z0-9]{8})[A-Za-z0-9_-]+/g, '$1[REDACTED]');
}

function interpretCliAuthStatus(
  profile: CliProfile,
  exitCode: number | null,
  rawOutput: string,
): { authenticated: boolean; error?: string } {
  if (profile.vendor !== 'claude-code') {
    return exitCode === 0
      ? { authenticated: true }
      : { authenticated: false, error: `CLI status exited with code ${exitCode ?? 'unknown'}.` };
  }
  if (exitCode !== 0) {
    return { authenticated: false, error: `Claude Code status exited with code ${exitCode ?? 'unknown'}.` };
  }
  const status = parseClaudeAuthStatusJson(rawOutput);
  if (status?.loggedIn === true) return { authenticated: true };
  if (status?.loggedIn === false) return { authenticated: false, error: 'Claude Code status reported loggedIn=false.' };
  return { authenticated: false, error: 'Claude Code status output did not include loggedIn=true.' };
}

function parseClaudeAuthStatusJson(rawOutput: string): { loggedIn?: boolean } | null {
  const text = String(rawOutput || '').trim();
  if (!text) return null;
  const candidates = [text];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { loggedIn?: unknown };
      return typeof parsed?.loggedIn === 'boolean' ? { loggedIn: parsed.loggedIn } : {};
    } catch {}
  }
  return null;
}
