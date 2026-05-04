import { execFile } from 'child_process';
import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { resolveClaudeCliRuntime } from './backends/claudeCode';
import { resolveCodexCliRuntime } from './backends/codex';
import { serverConfiguredCliProfileId } from './cliProfiles';
import type {
  CliInstallMethod,
  CliProfile,
  CliUpdateResult,
  CliUpdateStatus,
  CliUpdatesResponse,
  CliVendor,
  Settings,
  UpdateStep,
} from '../types';

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const EXEC_TIMEOUT_MS = 15_000;
const UPDATE_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 2 * 1024 * 1024;

const VENDOR_LABELS: Record<CliVendor, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  kiro: 'Kiro',
};

const VENDOR_DEFAULT_COMMANDS: Record<CliVendor, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  kiro: 'kiro-cli',
};

const VENDOR_NPM_PACKAGES: Partial<Record<CliVendor, string>> = {
  'claude-code': '@anthropic-ai/claude-code',
  codex: '@openai/codex',
};

interface CliRuntimeTarget {
  id: string;
  vendor: CliVendor;
  command: string;
  env: NodeJS.ProcessEnv;
  profileIds: string[];
  profileNames: string[];
}

interface ProbeResult {
  installMethod: CliInstallMethod;
  resolvedPath: string | null;
}

export class CliUpdateService {
  private _items = new Map<string, CliUpdateStatus>();
  private _checkInterval: ReturnType<typeof setInterval> | null = null;
  private _lastCheckAt: string | null = null;
  private _updateInProgress = new Set<string>();
  private _checkInFlight: Promise<CliUpdatesResponse> | null = null;
  private _loadSettings: (() => Promise<Settings>) | null = null;

  constructor(private readonly _appRoot: string = process.cwd()) {}

  start(loadSettings: () => Promise<Settings>): void {
    this._loadSettings = loadSettings;
    this.checkNow(loadSettings).catch((err: unknown) => {
      console.warn('[cliUpdateService] Initial check failed:', (err as Error).message);
    });
    this._checkInterval = setInterval(() => {
      this.checkNow(loadSettings).catch((err: unknown) => {
        console.warn('[cliUpdateService] Scheduled check failed:', (err as Error).message);
      });
    }, CHECK_INTERVAL_MS);
    this._checkInterval.unref();
  }

  stop(): void {
    if (this._checkInterval) {
      clearInterval(this._checkInterval);
      this._checkInterval = null;
    }
  }

  getStatus(settings: Settings): CliUpdatesResponse {
    const targets = this._targetsFromSettings(settings);
    const items = targets.map((target) => {
      const existing = this._items.get(target.id);
      if (existing) {
        return {
          ...existing,
          profileIds: target.profileIds,
          profileNames: target.profileNames,
          updateInProgress: this._updateInProgress.has(target.id),
        };
      }
      return this._emptyStatus(target);
    });
    return {
      items,
      lastCheckAt: this._lastCheckAt,
      updateInProgress: this._updateInProgress.size > 0,
    };
  }

  async checkNow(loadSettings: () => Promise<Settings> = this._requireSettingsLoader()): Promise<CliUpdatesResponse> {
    if (this._checkInFlight) return this._checkInFlight;
    this._checkInFlight = (async () => {
      const settings = await loadSettings();
      const targets = this._targetsFromSettings(settings);
      const items = await Promise.all(targets.map((target) => this._probeTarget(target)));
      this._items = new Map(items.map((item) => [item.id, item]));
      this._lastCheckAt = new Date().toISOString();
      return this.getStatus(settings);
    })().finally(() => {
      this._checkInFlight = null;
    });
    return this._checkInFlight;
  }

  async triggerUpdate(
    itemId: string,
    opts: {
      loadSettings?: () => Promise<Settings>;
      hasActiveStreams?: () => boolean;
      onUpdated?: () => void;
    } = {},
  ): Promise<CliUpdateResult> {
    const loadSettings = opts.loadSettings || this._loadSettings || this._requireSettingsLoader();
    const settings = await loadSettings();
    const target = this._targetsFromSettings(settings).find((candidate) => candidate.id === itemId);
    if (!target) {
      return { success: false, steps: [], error: 'CLI update target not found' };
    }
    if (this._updateInProgress.has(itemId)) {
      return { success: false, steps: [], error: 'CLI update already in progress' };
    }
    if (opts.hasActiveStreams && opts.hasActiveStreams()) {
      return {
        success: false,
        steps: [],
        error: 'Cannot update a CLI while conversations are actively running. Please wait for them to complete or abort them first.',
      };
    }

    const current = this._items.get(itemId) || await this._probeTarget(target);
    if (!current.updateSupported || !current.updateCommand || current.updateCommand.length === 0) {
      return {
        success: false,
        steps: [],
        error: current.lastError || 'This CLI installation cannot be updated safely from Agent Cockpit.',
        item: current,
      };
    }

    this._updateInProgress.add(itemId);
    const steps: UpdateStep[] = [];
    try {
      const [cmd, ...args] = current.updateCommand;
      try {
        const out = await this._exec(cmd, args, target.env, UPDATE_TIMEOUT_MS);
        steps.push({ name: current.updateCommand.join(' '), success: true, output: out.trim() });
      } catch (err: unknown) {
        steps.push({ name: current.updateCommand.join(' '), success: false, output: (err as Error).message });
        return { success: false, steps, error: (err as Error).message, item: current };
      }

      opts.onUpdated?.();
      const refreshed = await this._probeTarget(target);
      this._items.set(itemId, refreshed);
      this._lastCheckAt = new Date().toISOString();
      return { success: true, steps, item: refreshed };
    } finally {
      this._updateInProgress.delete(itemId);
    }
  }

  private _requireSettingsLoader(): () => Promise<Settings> {
    if (!this._loadSettings) {
      throw new Error('CliUpdateService settings loader is not configured');
    }
    return this._loadSettings;
  }

  private _targetsFromSettings(settings: Settings): CliRuntimeTarget[] {
    const now = new Date().toISOString();
    const profiles = Array.isArray(settings.cliProfiles) ? settings.cliProfiles : [];
    const defaultVendor = isCliVendorValue(settings.defaultBackend) ? settings.defaultBackend : 'claude-code';
    const withDefault = profiles.some((profile) => profile.id === serverConfiguredCliProfileId(defaultVendor))
      ? profiles
      : [
        ...profiles,
        {
          id: serverConfiguredCliProfileId(defaultVendor),
          name: `${VENDOR_LABELS[defaultVendor]} (Server Configured)`,
          vendor: defaultVendor,
          authMode: 'server-configured' as const,
          createdAt: now,
          updatedAt: now,
        },
      ];

    const grouped = new Map<string, CliRuntimeTarget>();
    for (const profile of withDefault) {
      if (!profile || profile.disabled || !isCliVendorValue(profile.vendor)) continue;
      const runtime = this._runtimeForProfile(profile);
      const key = this._targetKey(profile.vendor, runtime.command, runtime.env);
      let target = grouped.get(key);
      if (!target) {
        target = {
          id: key,
          vendor: profile.vendor,
          command: runtime.command,
          env: runtime.env,
          profileIds: [],
          profileNames: [],
        };
        grouped.set(key, target);
      }
      target.profileIds.push(profile.id);
      target.profileNames.push(profile.name || profile.id);
    }
    return [...grouped.values()].sort((a, b) => {
      const vendorOrder = a.vendor.localeCompare(b.vendor);
      return vendorOrder || a.command.localeCompare(b.command);
    });
  }

  private _runtimeForProfile(profile: CliProfile): { command: string; env: NodeJS.ProcessEnv } {
    if (profile.vendor === 'codex') return resolveCodexCliRuntime(profile);
    if (profile.vendor === 'claude-code') return resolveClaudeCliRuntime(profile);
    return {
      command: VENDOR_DEFAULT_COMMANDS.kiro,
      env: { ...process.env },
    };
  }

  private _targetKey(vendor: CliVendor, command: string, env: NodeJS.ProcessEnv): string {
    const hash = crypto.createHash('sha1').update(JSON.stringify({
      vendor,
      command,
      PATH: env.PATH || '',
    })).digest('hex').slice(0, 12);
    return `${vendor}:${hash}`;
  }

  private async _probeTarget(target: CliRuntimeTarget): Promise<CliUpdateStatus> {
    const base = this._emptyStatus(target);
    try {
      const versionOut = await this._exec(target.command, this._versionArgs(target.vendor), target.env, EXEC_TIMEOUT_MS);
      const currentVersion = parseVersion(versionOut);
      const resolvedPath = await this._resolveCommand(target.command, target.env);
      const probe = await this._detectInstallMethod(target, resolvedPath);
      const updateCommand = this._updateCommand(target, probe.installMethod);
      const latestVersion = await this._latestVersion(target, probe.installMethod);
      return {
        ...base,
        resolvedPath: probe.resolvedPath,
        installMethod: probe.installMethod,
        currentVersion,
        latestVersion,
        updateAvailable: isNewerVersion(latestVersion, currentVersion),
        updateSupported: !!updateCommand,
        updateCommand,
        lastCheckAt: new Date().toISOString(),
        lastError: currentVersion ? null : 'Could not parse CLI version from output',
      };
    } catch (err: unknown) {
      const message = (err as Error).message || String(err);
      return {
        ...base,
        installMethod: message.includes('ENOENT') || message.includes('not found') ? 'missing' : 'unknown',
        lastCheckAt: new Date().toISOString(),
        lastError: message,
      };
    }
  }

  private _emptyStatus(target: CliRuntimeTarget): CliUpdateStatus {
    return {
      id: target.id,
      vendor: target.vendor,
      label: VENDOR_LABELS[target.vendor],
      command: target.command,
      resolvedPath: null,
      profileIds: target.profileIds,
      profileNames: target.profileNames,
      installMethod: 'unknown',
      currentVersion: null,
      latestVersion: null,
      updateAvailable: false,
      updateSupported: false,
      updateInProgress: this._updateInProgress.has(target.id),
      lastCheckAt: null,
      lastError: null,
      updateCommand: null,
    };
  }

  private _versionArgs(vendor: CliVendor): string[] {
    return vendor === 'kiro' ? ['version'] : ['--version'];
  }

  private async _detectInstallMethod(target: CliRuntimeTarget, resolvedPath: string | null): Promise<ProbeResult> {
    const npmPackage = VENDOR_NPM_PACKAGES[target.vendor];
    if (npmPackage && resolvedPath) {
      const realResolved = await safeRealpath(resolvedPath);
      const npmRoot = (await this._exec('npm', ['root', '-g'], target.env, EXEC_TIMEOUT_MS).catch(() => '')).trim();
      if (npmRoot) {
        const packageDir = path.join(npmRoot, npmPackage);
        const realPackageDir = await safeRealpath(packageDir);
        if (realResolved && realPackageDir && isSubpath(realResolved, realPackageDir)) {
          return { installMethod: 'npm-global', resolvedPath: realResolved };
        }
      }
    }
    if (target.vendor === 'kiro') {
      return { installMethod: 'self-update', resolvedPath };
    }
    return { installMethod: resolvedPath ? 'unknown' : 'missing', resolvedPath };
  }

  private async _latestVersion(target: CliRuntimeTarget, installMethod: CliInstallMethod): Promise<string | null> {
    if (installMethod !== 'npm-global') return null;
    const npmPackage = VENDOR_NPM_PACKAGES[target.vendor];
    if (!npmPackage) return null;
    const out = await this._exec('npm', ['view', npmPackage, 'version'], target.env, EXEC_TIMEOUT_MS);
    return parseVersion(out);
  }

  private _updateCommand(target: CliRuntimeTarget, installMethod: CliInstallMethod): string[] | null {
    if (installMethod === 'npm-global') {
      const npmPackage = VENDOR_NPM_PACKAGES[target.vendor];
      return npmPackage ? ['npm', 'i', '-g', `${npmPackage}@latest`] : null;
    }
    if (target.vendor === 'kiro' && installMethod === 'self-update') {
      return [target.command, 'update', '--non-interactive'];
    }
    return null;
  }

  private async _resolveCommand(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
    if (command.includes('/') || command.includes('\\')) {
      const resolved = path.isAbsolute(command) ? command : path.resolve(this._appRoot, command);
      try {
        await fsp.access(resolved);
        return resolved;
      } catch {
        return null;
      }
    }
    const resolver = process.platform === 'win32' ? 'where' : 'which';
    const out = await this._exec(resolver, [command], env, EXEC_TIMEOUT_MS).catch(() => '');
    const first = out.trim().split(/\r?\n/).find(Boolean);
    return first || null;
  }

  private _exec(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, {
        cwd: this._appRoot,
        env,
        timeout,
        maxBuffer: MAX_BUFFER,
      }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || '').trim() || err.message));
        } else {
          resolve(String(stdout || '').trim());
        }
      });
    });
  }
}

function isCliVendorValue(value: unknown): value is CliVendor {
  return value === 'codex' || value === 'claude-code' || value === 'kiro';
}

async function safeRealpath(p: string): Promise<string | null> {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

function isSubpath(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function parseVersion(output: string | null | undefined): string | null {
  const match = String(output || '').match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : null;
}

export function isNewerVersion(remote: string | null, local: string | null): boolean {
  if (!remote || !local) return false;
  const r = remote.split(/[-+]/)[0].split('.').map(Number);
  const l = local.split(/[-+]/)[0].split('.').map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i += 1) {
    const rv = r[i] || 0;
    const lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}
