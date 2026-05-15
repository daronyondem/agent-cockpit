import fs from 'fs';
import path from 'path';
import { atomicWriteFile } from '../utils/atomicWrite';
import type { InstallChannel, InstallNodeRuntime, InstallSource, InstallStartup, InstallStateSource, InstallStatus } from '../types';

const SCHEMA_VERSION = 1;
const DEFAULT_REPO = 'daronyondem/agent-cockpit';

interface InstallStateServiceOptions {
  appRoot: string;
  dataRoot: string;
  repo?: string;
  branch?: string;
  version?: string;
}

type StoredInstallState = Partial<Omit<InstallStatus, 'stateSource' | 'stateError'>>;

function readPackageVersion(appRoot: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

function normalizeChannel(value: unknown): InstallChannel {
  return value === 'production' ? 'production' : 'dev';
}

function normalizeSource(value: unknown, channel: InstallChannel): InstallSource {
  if (value === 'github-release' || value === 'git-main' || value === 'unknown') return value;
  return channel === 'production' ? 'github-release' : 'git-main';
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeNodeRuntime(value: unknown): InstallNodeRuntime | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<InstallNodeRuntime>;
  const source = raw.source === 'private' || raw.source === 'system' || raw.source === 'unknown'
    ? raw.source
    : 'unknown';
  return {
    source,
    version: stringOrNull(raw.version),
    npmVersion: stringOrNull(raw.npmVersion),
    binDir: stringOrNull(raw.binDir),
    runtimeDir: stringOrNull(raw.runtimeDir),
    requiredMajor: numberOrNull(raw.requiredMajor),
    updatedAt: stringOrNull(raw.updatedAt),
  };
}

function normalizeStartup(value: unknown): InstallStartup | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<InstallStartup>;
  return {
    kind: raw.kind === 'scheduled-task' || raw.kind === 'manual' || raw.kind === 'unknown' ? raw.kind : 'unknown',
    name: stringOrNull(raw.name),
    scope: raw.scope === 'current-user' || raw.scope === 'unknown' ? raw.scope : 'unknown',
  };
}

export class InstallStateService {
  private _appRoot: string;
  private _dataRoot: string;
  private _manifestPath: string;
  private _repo: string;
  private _branch: string;
  private _version: string | null;

  constructor(options: InstallStateServiceOptions) {
    this._appRoot = options.appRoot;
    this._dataRoot = options.dataRoot;
    this._manifestPath = path.join(options.dataRoot, 'install.json');
    this._repo = options.repo || DEFAULT_REPO;
    this._branch = options.branch || 'main';
    this._version = options.version ?? readPackageVersion(options.appRoot);
  }

  getManifestPath(): string {
    return this._manifestPath;
  }

  getStatus(): InstallStatus {
    let raw: string;
    try {
      raw = fs.readFileSync(this._manifestPath, 'utf8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return this._inferredStatus('inferred', null);
      }
      return this._inferredStatus('corrupt', (err as Error).message);
    }

    try {
      const parsed = JSON.parse(raw) as StoredInstallState;
      return this._normalizeStoredStatus(parsed);
    } catch (err: unknown) {
      return this._inferredStatus('corrupt', (err as Error).message);
    }
  }

  async writeState(state: Partial<InstallStatus>): Promise<InstallStatus> {
    const normalized = this._normalizeStoredStatus({
      ...state,
      schemaVersion: SCHEMA_VERSION,
    });
    const persisted: StoredInstallState = {
      schemaVersion: SCHEMA_VERSION,
      channel: normalized.channel,
      source: normalized.source,
      repo: normalized.repo,
      version: normalized.version,
      branch: normalized.branch,
      installDir: normalized.installDir,
      appDir: normalized.appDir,
      dataDir: normalized.dataDir,
      installedAt: normalized.installedAt,
      welcomeCompletedAt: normalized.welcomeCompletedAt,
      nodeRuntime: normalized.nodeRuntime,
      startup: normalized.startup,
    };
    await fs.promises.mkdir(path.dirname(this._manifestPath), { recursive: true });
    await atomicWriteFile(this._manifestPath, JSON.stringify(persisted, null, 2) + '\n');
    return this.getStatus();
  }

  async markWelcomeCompleted(at = new Date().toISOString()): Promise<InstallStatus> {
    const current = this.getStatus();
    return this.writeState({ ...current, welcomeCompletedAt: at });
  }

  private _normalizeStoredStatus(parsed: StoredInstallState): InstallStatus {
    const legacy = parsed.schemaVersion !== SCHEMA_VERSION;
    const channel = normalizeChannel(parsed.channel);
    const source = normalizeSource(parsed.source, channel);
    return {
      schemaVersion: SCHEMA_VERSION,
      channel,
      source,
      repo: stringOrNull(parsed.repo) || this._repo,
      version: stringOrNull(parsed.version) || this._version,
      branch: source === 'git-main' ? stringOrNull(parsed.branch) || this._branch : stringOrNull(parsed.branch),
      installDir: stringOrNull(parsed.installDir) || this._appRoot,
      appDir: stringOrNull(parsed.appDir) || this._appRoot,
      dataDir: stringOrNull(parsed.dataDir) || this._dataRoot,
      installedAt: stringOrNull(parsed.installedAt),
      welcomeCompletedAt: stringOrNull(parsed.welcomeCompletedAt),
      nodeRuntime: normalizeNodeRuntime(parsed.nodeRuntime),
      startup: normalizeStartup(parsed.startup),
      stateSource: legacy ? 'legacy' : 'stored',
      stateError: null,
    };
  }

  private _inferredStatus(stateSource: InstallStateSource, stateError: string | null): InstallStatus {
    return {
      schemaVersion: SCHEMA_VERSION,
      channel: 'dev',
      source: 'git-main',
      repo: this._repo,
      version: this._version,
      branch: this._branch,
      installDir: this._appRoot,
      appDir: this._appRoot,
      dataDir: this._dataRoot,
      installedAt: null,
      welcomeCompletedAt: null,
      nodeRuntime: null,
      startup: null,
      stateSource,
      stateError,
    };
  }
}
