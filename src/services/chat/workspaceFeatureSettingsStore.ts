import fsp from 'fs/promises';
import type {
  CliProfile,
  ContextMapWorkspaceSettings,
  EffortLevel,
  KbAutoDreamConfig,
  Settings,
  WorkspaceIndex,
} from '../../types';
import { backendForCliProfile, cliVendorForBackend } from '../cliProfiles';
import { DEFAULT_KB_AUTO_DREAM_CONFIG, normalizeKbAutoDreamConfig } from '../knowledgeBase/autoDream';

const CONTEXT_MAP_EFFORT_LEVELS = new Set<EffortLevel>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

interface WorkspaceFeatureSettingsStoreDeps {
  workspacesDir: string;
  indexLock: { run<T>(key: string, fn: () => Promise<T>): Promise<T> };
  readWorkspaceIndex(hash: string): Promise<WorkspaceIndex | null>;
  writeWorkspaceIndex(hash: string, index: WorkspaceIndex): Promise<void>;
  getSettings(): Promise<Settings>;
}

function normalizeContextMapScanInterval(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(1440, Math.round(value)));
}

export function normalizeContextMapWorkspaceSettings(
  value: unknown,
  profiles: CliProfile[],
): ContextMapWorkspaceSettings {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const processorMode = raw.processorMode === 'override' ? 'override' : 'global';
  const settings: ContextMapWorkspaceSettings = { processorMode };

  const scanIntervalMinutes = normalizeContextMapScanInterval(raw.scanIntervalMinutes);
  if (scanIntervalMinutes !== undefined) settings.scanIntervalMinutes = scanIntervalMinutes;

  if (processorMode !== 'override') return settings;

  const cliProfileId = typeof raw.cliProfileId === 'string' ? raw.cliProfileId.trim() : '';
  const selectedProfile = cliProfileId
    ? profiles.find((profile) => profile.id === cliProfileId && !profile.disabled)
    : undefined;
  if (selectedProfile) {
    settings.cliProfileId = selectedProfile.id;
    settings.cliBackend = backendForCliProfile(selectedProfile, typeof raw.cliBackend === 'string' ? raw.cliBackend : undefined);
  } else if (typeof raw.cliBackend === 'string' && cliVendorForBackend(raw.cliBackend)) {
    settings.cliBackend = raw.cliBackend;
  }

  const cliModel = typeof raw.cliModel === 'string' ? raw.cliModel.trim() : '';
  if (cliModel) settings.cliModel = cliModel;

  if (typeof raw.cliEffort === 'string' && CONTEXT_MAP_EFFORT_LEVELS.has(raw.cliEffort as EffortLevel)) {
    settings.cliEffort = raw.cliEffort as EffortLevel;
  }

  return settings;
}

export class WorkspaceFeatureSettingsStore {
  constructor(private readonly deps: WorkspaceFeatureSettingsStoreDeps) {}

  async getKbEnabled(hash: string): Promise<boolean> {
    const index = await this.deps.readWorkspaceIndex(hash);
    if (!index) return false;
    return Boolean(index.kbEnabled);
  }

  async setKbEnabled(hash: string, enabled: boolean): Promise<boolean | null> {
    return this.deps.indexLock.run(hash, async () => {
      const index = await this.deps.readWorkspaceIndex(hash);
      if (!index) return null;
      index.kbEnabled = Boolean(enabled);
      await this.deps.writeWorkspaceIndex(hash, index);
      return index.kbEnabled;
    });
  }

  async getKbAutoDigest(hash: string): Promise<boolean> {
    const index = await this.deps.readWorkspaceIndex(hash);
    if (!index) return false;
    return Boolean(index.kbAutoDigest);
  }

  async setKbAutoDigest(hash: string, autoDigest: boolean): Promise<boolean | null> {
    return this.deps.indexLock.run(hash, async () => {
      const index = await this.deps.readWorkspaceIndex(hash);
      if (!index) return null;
      index.kbAutoDigest = Boolean(autoDigest);
      await this.deps.writeWorkspaceIndex(hash, index);
      return index.kbAutoDigest;
    });
  }

  async getKbAutoDream(hash: string): Promise<KbAutoDreamConfig> {
    const index = await this.deps.readWorkspaceIndex(hash);
    if (!index) return { ...DEFAULT_KB_AUTO_DREAM_CONFIG };
    return normalizeKbAutoDreamConfig(index.kbAutoDream);
  }

  async setKbAutoDream(hash: string, autoDream: KbAutoDreamConfig): Promise<KbAutoDreamConfig | null> {
    return this.deps.indexLock.run(hash, async () => {
      const index = await this.deps.readWorkspaceIndex(hash);
      if (!index) return null;
      index.kbAutoDream = normalizeKbAutoDreamConfig(autoDream);
      await this.deps.writeWorkspaceIndex(hash, index);
      return index.kbAutoDream;
    });
  }

  async listKbEnabledWorkspaceHashes(): Promise<string[]> {
    return this.listEnabledWorkspaceHashes((index) => Boolean(index.kbEnabled));
  }

  async getContextMapEnabled(hash: string): Promise<boolean> {
    const index = await this.deps.readWorkspaceIndex(hash);
    if (!index) return false;
    return Boolean(index.contextMapEnabled);
  }

  async setContextMapEnabled(hash: string, enabled: boolean): Promise<boolean | null> {
    return this.deps.indexLock.run(hash, async () => {
      const index = await this.deps.readWorkspaceIndex(hash);
      if (!index) return null;
      index.contextMapEnabled = Boolean(enabled);
      await this.deps.writeWorkspaceIndex(hash, index);
      return index.contextMapEnabled;
    });
  }

  async getContextMapSettings(hash: string): Promise<ContextMapWorkspaceSettings | null> {
    const index = await this.deps.readWorkspaceIndex(hash);
    if (!index) return null;
    const settings = await this.deps.getSettings();
    return normalizeContextMapWorkspaceSettings(index.contextMap, settings.cliProfiles || []);
  }

  async setContextMapSettings(
    hash: string,
    settings: unknown,
  ): Promise<ContextMapWorkspaceSettings | null> {
    return this.deps.indexLock.run(hash, async () => {
      const index = await this.deps.readWorkspaceIndex(hash);
      if (!index) return null;
      const globalSettings = await this.deps.getSettings();
      index.contextMap = normalizeContextMapWorkspaceSettings(settings, globalSettings.cliProfiles || []);
      await this.deps.writeWorkspaceIndex(hash, index);
      return index.contextMap;
    });
  }

  async listContextMapEnabledWorkspaceHashes(): Promise<string[]> {
    return this.listEnabledWorkspaceHashes((index) => Boolean(index.contextMapEnabled));
  }

  private async listEnabledWorkspaceHashes(predicate: (index: WorkspaceIndex) => boolean): Promise<string[]> {
    let dirs: string[];
    try {
      dirs = await fsp.readdir(this.deps.workspacesDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const hashes: string[] = [];
    for (const hash of dirs) {
      if (hash.startsWith('.')) continue;
      const index = await this.deps.readWorkspaceIndex(hash);
      if (index && predicate(index)) hashes.push(hash);
    }
    return hashes;
  }
}
