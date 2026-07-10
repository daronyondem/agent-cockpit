import fsp from 'fs/promises';
import path from 'path';
import type {
  CliProfile,
  WorkspaceContextWorkspaceSettings,
  EffortLevel,
  KbAutoDreamConfig,
  Settings,
  WorkspaceIndex,
} from '../../types';
import { backendForCliProfile, cliHarnessForBackend } from '../cliProfiles';
import { DEFAULT_KB_AUTO_DREAM_CONFIG, normalizeKbAutoDreamConfig } from '../knowledgeBase/autoDream';

const WORKSPACE_CONTEXT_EFFORT_LEVELS = new Set<EffortLevel>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

interface WorkspaceFeatureSettingsStoreDeps {
  workspacesDir: string;
  getWorkspaceDir?(hash: string): string;
  indexLock: { run<T>(key: string, fn: () => Promise<T>): Promise<T> };
  readWorkspaceIndex(hash: string): Promise<WorkspaceIndex | null>;
  writeWorkspaceIndex(hash: string, index: WorkspaceIndex): Promise<void>;
  getSettings(): Promise<Settings>;
}

function normalizeWorkspaceContextScanInterval(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(1440, Math.round(value)));
}

function normalizeWorkspaceContextMaintenanceInterval(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(8760, Math.round(value)));
}

export function normalizeWorkspaceContextWorkspaceSettings(
  value: unknown,
  profiles: CliProfile[],
): WorkspaceContextWorkspaceSettings {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const processorMode = raw.processorMode === 'override' ? 'override' : 'global';
  const settings: WorkspaceContextWorkspaceSettings = { processorMode };

  const scanIntervalMinutes = normalizeWorkspaceContextScanInterval(raw.scanIntervalMinutes);
  if (scanIntervalMinutes !== undefined) settings.scanIntervalMinutes = scanIntervalMinutes;
  const maintenanceIntervalHours = normalizeWorkspaceContextMaintenanceInterval(raw.maintenanceIntervalHours);
  if (maintenanceIntervalHours !== undefined) settings.maintenanceIntervalHours = maintenanceIntervalHours;

  if (processorMode !== 'override') return settings;

  const cliProfileId = typeof raw.cliProfileId === 'string' ? raw.cliProfileId.trim() : '';
  const selectedProfile = cliProfileId
    ? profiles.find((profile) => profile.id === cliProfileId && !profile.disabled)
    : undefined;
  if (selectedProfile) {
    settings.cliProfileId = selectedProfile.id;
    settings.cliBackend = backendForCliProfile(selectedProfile, typeof raw.cliBackend === 'string' ? raw.cliBackend : undefined);
  } else if (typeof raw.cliBackend === 'string' && cliHarnessForBackend(raw.cliBackend)) {
    settings.cliBackend = raw.cliBackend;
  }

  const cliModel = typeof raw.cliModel === 'string' ? raw.cliModel.trim() : '';
  if (cliModel) settings.cliModel = cliModel;

  if (typeof raw.cliEffort === 'string' && WORKSPACE_CONTEXT_EFFORT_LEVELS.has(raw.cliEffort as EffortLevel)) {
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

  async getMemoryEnabled(hash: string): Promise<boolean> {
    const index = await this.readMigratedWorkspaceIndex(hash);
    if (!index) return false;
    return Boolean(index.memoryEnabled);
  }

  async setMemoryEnabled(hash: string, enabled: boolean): Promise<boolean | null> {
    return this.deps.indexLock.run(hash, async () => {
      const index = await this.readMigratedWorkspaceIndex(hash);
      if (!index) return null;
      index.memoryEnabled = Boolean(enabled);
      await this.deps.writeWorkspaceIndex(hash, index);
      return index.memoryEnabled;
    });
  }

  async listMemoryEnabledWorkspaceHashes(): Promise<string[]> {
    return this.listEnabledWorkspaceHashes((index) => Boolean(index.memoryEnabled));
  }

  async getWorkspaceContextEnabled(hash: string): Promise<boolean> {
    const index = await this.readMigratedWorkspaceIndex(hash);
    if (!index) return false;
    return Boolean(index.workspaceContextEnabled);
  }

  async setWorkspaceContextEnabled(hash: string, enabled: boolean): Promise<boolean | null> {
    return this.deps.indexLock.run(hash, async () => {
      const index = await this.readMigratedWorkspaceIndex(hash);
      if (!index) return null;
      index.workspaceContextEnabled = Boolean(enabled);
      await this.deps.writeWorkspaceIndex(hash, index);
      return index.workspaceContextEnabled;
    });
  }

  async getWorkspaceContextSettings(hash: string): Promise<WorkspaceContextWorkspaceSettings | null> {
    const index = await this.readMigratedWorkspaceIndex(hash);
    if (!index) return null;
    const settings = await this.deps.getSettings();
    return normalizeWorkspaceContextWorkspaceSettings(index.workspaceContext, settings.cliProfiles || []);
  }

  async setWorkspaceContextSettings(
    hash: string,
    settings: unknown,
  ): Promise<WorkspaceContextWorkspaceSettings | null> {
    return this.deps.indexLock.run(hash, async () => {
      const index = await this.readMigratedWorkspaceIndex(hash);
      if (!index) return null;
      const globalSettings = await this.deps.getSettings();
      index.workspaceContext = normalizeWorkspaceContextWorkspaceSettings(settings, globalSettings.cliProfiles || []);
      await this.deps.writeWorkspaceIndex(hash, index);
      return index.workspaceContext;
    });
  }

  async listWorkspaceContextEnabledWorkspaceHashes(): Promise<string[]> {
    return this.listEnabledWorkspaceHashes((index) => Boolean(index.workspaceContextEnabled));
  }

  async getRoutinesEnabled(hash: string): Promise<boolean> {
    const index = await this.readMigratedWorkspaceIndex(hash);
    if (!index) return false;
    return Boolean(index.routinesEnabled);
  }

  async setRoutinesEnabled(hash: string, enabled: boolean): Promise<boolean | null> {
    return this.deps.indexLock.run(hash, async () => {
      const index = await this.readMigratedWorkspaceIndex(hash);
      if (!index) return null;
      index.routinesEnabled = Boolean(enabled);
      await this.deps.writeWorkspaceIndex(hash, index);
      return index.routinesEnabled;
    });
  }

  async listRoutinesEnabledWorkspaceHashes(): Promise<string[]> {
    return this.listEnabledWorkspaceHashes((index) => Boolean(index.routinesEnabled));
  }

  private async readMigratedWorkspaceIndex(hash: string): Promise<WorkspaceIndex | null> {
    const index = await this.deps.readWorkspaceIndex(hash);
    if (!index) return null;
    return this.migrateWorkspaceContextIndex(hash, index);
  }

  private async migrateWorkspaceContextIndex(hash: string, index: WorkspaceIndex): Promise<WorkspaceIndex> {
    const legacy = index as WorkspaceIndex & {
      contextMapEnabled?: boolean;
      contextMap?: unknown;
    };
    if (legacy.contextMapEnabled === undefined && legacy.contextMap === undefined) return index;
    if (index.workspaceContextEnabled === undefined && legacy.contextMapEnabled !== undefined) {
      index.workspaceContextEnabled = Boolean(legacy.contextMapEnabled);
    }
    if (index.workspaceContext === undefined && legacy.contextMap !== undefined) {
      const globalSettings = await this.deps.getSettings();
      index.workspaceContext = normalizeWorkspaceContextWorkspaceSettings(legacy.contextMap, globalSettings.cliProfiles || []);
    }
    delete legacy.contextMapEnabled;
    delete legacy.contextMap;
    const workspaceDir = this.deps.getWorkspaceDir ? this.deps.getWorkspaceDir(hash) : path.join(this.deps.workspacesDir, hash);
    await fsp.rm(path.join(workspaceDir, 'context-map'), { recursive: true, force: true });
    await this.deps.writeWorkspaceIndex(hash, index);
    return index;
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
      const index = await this.readMigratedWorkspaceIndex(hash);
      if (index && !index.archive && predicate(index)) hashes.push(index.workspaceId || hash);
    }
    return hashes;
  }
}
