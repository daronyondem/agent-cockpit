import fsp from 'fs/promises';
import path from 'path';
import type { CliProfile, Settings } from '../types';
import { atomicWriteFile } from '../utils/atomicWrite';
import {
  backendForCliProfile,
  cliProtocolForBackend,
  cliVendorForBackend,
  ensureServerConfiguredCliProfiles,
  isSetupAccountCliProfile,
  isCliVendor,
  serverConfiguredCliProfileId,
} from './cliProfiles';
import {
  DEFAULT_CONTEXT_MAP_CLI_CONCURRENCY,
  DEFAULT_CONTEXT_MAP_EXTRACTION_CONCURRENCY,
  DEFAULT_CONTEXT_MAP_SCAN_INTERVAL_MINUTES,
  DEFAULT_CONTEXT_MAP_SYNTHESIS_CONCURRENCY,
  MAX_CONTEXT_MAP_PROCESSOR_CONCURRENCY,
} from './contextMap/defaults';

interface PersistedSettings extends Settings {
  customInstructions?: { aboutUser?: string; responseStyle?: string };
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  sendBehavior: 'enter',
  systemPrompt: '',
  workingDirectory: '',
  contextMap: {
    scanIntervalMinutes: DEFAULT_CONTEXT_MAP_SCAN_INTERVAL_MINUTES,
    cliConcurrency: DEFAULT_CONTEXT_MAP_CLI_CONCURRENCY,
    extractionConcurrency: DEFAULT_CONTEXT_MAP_EXTRACTION_CONCURRENCY,
    synthesisConcurrency: DEFAULT_CONTEXT_MAP_SYNTHESIS_CONCURRENCY,
  },
};

export class SettingsService {
  private readonly _settingsFile: string;

  constructor(baseDir: string) {
    this._settingsFile = path.join(baseDir, 'settings.json');
  }

  async getSettings(): Promise<Settings> {
    try {
      const data = await fsp.readFile(this._settingsFile, 'utf8');
      const settings = JSON.parse(data) as PersistedSettings;

      if (settings.customInstructions && settings.systemPrompt === undefined) {
        const parts: string[] = [];
        if (settings.customInstructions.aboutUser) {
          parts.push(settings.customInstructions.aboutUser.trim());
        }
        if (settings.customInstructions.responseStyle) {
          parts.push(settings.customInstructions.responseStyle.trim());
        }
        settings.systemPrompt = parts.join('\n\n');
        delete settings.customInstructions;
        await this.saveSettings(settings);
      }

      const kb = settings.knowledgeBase;
      if (
        kb &&
        typeof kb.dreamingConcurrency === 'number' &&
        kb.cliConcurrency === undefined
      ) {
        kb.cliConcurrency = kb.dreamingConcurrency;
      }

      const setupAuthHomeMigration = this._stripSetupProfileAuthHomes(settings);
      if (setupAuthHomeMigration.changed) {
        return this.saveSettings(setupAuthHomeMigration.settings);
      }

      return this._normalizeSettings(this._withLegacyDefaultCliProfile(this._withContextMapDefaults(settings)));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return this._normalizeSettings(this._withContextMapDefaults({ ...DEFAULT_SETTINGS }));
      }
      throw err;
    }
  }

  async saveSettings(settings: Settings): Promise<Settings> {
    const normalized = this._normalizeSettings(this._withContextMapDefaults(settings));
    await atomicWriteFile(this._settingsFile, JSON.stringify(normalized, null, 2));
    return normalized;
  }

  private _normalizeSettings(settings: Settings): Settings {
    return this._withValidDefaultServiceTier(this._withFirstAvailableCliProfileDefault(this._normalizeCliProfiles(settings)));
  }

  private _withLegacyDefaultCliProfile(settings: Settings): Settings {
    if (settings.defaultCliProfileId || !settings.defaultBackend) return settings;
    return ensureServerConfiguredCliProfiles(settings, [settings.defaultBackend]).settings;
  }

  private _withFirstAvailableCliProfileDefault(settings: Settings): Settings {
    const profiles = Array.isArray(settings.cliProfiles) ? settings.cliProfiles.filter((profile) => !profile.disabled) : [];
    if (profiles.length === 0) return settings;

    const current = settings.defaultCliProfileId
      ? profiles.find((profile) => profile.id === settings.defaultCliProfileId)
      : undefined;
    const defaultVendor = cliVendorForBackend(settings.defaultBackend);
    const selected = current
      || (defaultVendor ? profiles.find((profile) => profile.vendor === defaultVendor) : undefined)
      || profiles[0];
    if (!selected) return settings;

    return {
      ...settings,
      defaultCliProfileId: selected.id,
      defaultBackend: backendForCliProfile(selected, settings.defaultBackend),
    };
  }

  private _withValidDefaultServiceTier(settings: Settings): Settings {
    if (settings.defaultBackend === 'codex' && settings.defaultServiceTier === 'fast') {
      return settings;
    }
    const next = { ...settings };
    delete next.defaultServiceTier;
    return next;
  }

  private _withContextMapDefaults(settings: Settings): Settings {
    const contextMap = { ...(settings.contextMap || {}) } as NonNullable<Settings['contextMap']> & { sources?: unknown };
    delete contextMap.sources;
    return {
      ...settings,
      contextMap: {
        scanIntervalMinutes: DEFAULT_CONTEXT_MAP_SCAN_INTERVAL_MINUTES,
        cliConcurrency: DEFAULT_CONTEXT_MAP_CLI_CONCURRENCY,
        extractionConcurrency: DEFAULT_CONTEXT_MAP_EXTRACTION_CONCURRENCY,
        synthesisConcurrency: DEFAULT_CONTEXT_MAP_SYNTHESIS_CONCURRENCY,
        ...contextMap,
      },
    };
  }

  private _normalizeCliProfiles(settings: Settings): Settings {
    const now = new Date().toISOString();
    const profiles = Array.isArray(settings.cliProfiles)
      ? settings.cliProfiles
        .map((profile) => this._normalizeCliProfile(
          profile,
          now,
          profile.id === settings.defaultCliProfileId ? settings.defaultBackend : undefined,
        ))
        .filter((profile): profile is CliProfile => !!profile)
      : [];

    const defaultProfile = settings.defaultCliProfileId
      ? profiles.find((profile) => profile.id === settings.defaultCliProfileId && !profile.disabled)
      : undefined;

    const next: Settings = {
      ...settings,
      cliProfiles: profiles,
      ...(defaultProfile
        ? {
            defaultBackend: backendForCliProfile(defaultProfile, settings.defaultBackend),
          }
        : {}),
    };
    if (settings.memory) {
      next.memory = this._normalizeMemorySettings(settings.memory, profiles);
    }
    if (settings.knowledgeBase) {
      next.knowledgeBase = this._normalizeKnowledgeBaseSettings(settings.knowledgeBase, profiles);
    }
    if (settings.contextMap) {
      next.contextMap = this._normalizeContextMapSettings(settings.contextMap, profiles);
    }
    if (settings.defaultCliProfileId && !defaultProfile) {
      delete next.defaultCliProfileId;
    }
    return next;
  }

  private _stripSetupProfileAuthHomes(settings: Settings): { settings: Settings; changed: boolean } {
    if (!Array.isArray(settings.cliProfiles)) return { settings, changed: false };
    let changed = false;
    const cliProfiles = settings.cliProfiles.map((profile) => {
      if (!profile || !isSetupAccountCliProfile(profile)) return profile;
      let next = profile;
      if (typeof profile.configDir === 'string' && profile.configDir.trim()) {
        const { configDir: _configDir, ...rest } = next;
        next = rest;
        changed = true;
      }
      if (next.env) {
        const env: Record<string, string> = {};
        let envChanged = false;
        for (const [key, value] of Object.entries(next.env)) {
          if (isCliAuthHomeEnvKey(next.vendor, key)) {
            envChanged = true;
            continue;
          }
          env[key] = value;
        }
        if (envChanged) {
          const { env: _env, ...rest } = next;
          next = Object.keys(env).length > 0 ? { ...rest, env } : rest;
          changed = true;
        }
      }
      return next;
    });
    return changed ? { settings: { ...settings, cliProfiles }, changed } : { settings, changed: false };
  }

  private _normalizeMemorySettings(memory: NonNullable<Settings['memory']>, profiles: CliProfile[]): NonNullable<Settings['memory']> {
    const selection = this._normalizeProfileSelection(profiles, memory.cliProfileId, memory.cliBackend);
    const next = { ...memory };
    delete next.cliProfileId;
    if (selection.profileId) next.cliProfileId = selection.profileId;
    if (selection.backend) next.cliBackend = selection.backend;
    return next;
  }

  private _normalizeKnowledgeBaseSettings(
    kb: NonNullable<Settings['knowledgeBase']>,
    profiles: CliProfile[],
  ): NonNullable<Settings['knowledgeBase']> {
    const ingestion = this._normalizeProfileSelection(profiles, kb.ingestionCliProfileId, kb.ingestionCliBackend);
    const digestion = this._normalizeProfileSelection(profiles, kb.digestionCliProfileId, kb.digestionCliBackend);
    const dreaming = this._normalizeProfileSelection(profiles, kb.dreamingCliProfileId, kb.dreamingCliBackend);
    const next = { ...kb };
    delete next.ingestionCliProfileId;
    delete next.digestionCliProfileId;
    delete next.dreamingCliProfileId;
    if (ingestion.profileId) next.ingestionCliProfileId = ingestion.profileId;
    if (ingestion.backend) next.ingestionCliBackend = ingestion.backend;
    if (digestion.profileId) next.digestionCliProfileId = digestion.profileId;
    if (digestion.backend) next.digestionCliBackend = digestion.backend;
    if (dreaming.profileId) next.dreamingCliProfileId = dreaming.profileId;
    if (dreaming.backend) next.dreamingCliBackend = dreaming.backend;
    return next;
  }

  private _normalizeContextMapSettings(
    contextMap: NonNullable<Settings['contextMap']>,
    profiles: CliProfile[],
  ): NonNullable<Settings['contextMap']> {
    const selection = this._normalizeProfileSelection(profiles, contextMap.cliProfileId, contextMap.cliBackend);
    const next = { ...contextMap } as NonNullable<Settings['contextMap']> & { sources?: unknown };
    delete next.sources;
    delete next.cliProfileId;
    if (selection.profileId) next.cliProfileId = selection.profileId;
    if (selection.backend) next.cliBackend = selection.backend;
    if (typeof next.scanIntervalMinutes === 'number' && Number.isFinite(next.scanIntervalMinutes)) {
      next.scanIntervalMinutes = Math.max(1, Math.min(1440, Math.round(next.scanIntervalMinutes)));
    } else if (next.scanIntervalMinutes !== undefined) {
      delete next.scanIntervalMinutes;
    }
    if (typeof next.cliConcurrency === 'number' && Number.isFinite(next.cliConcurrency)) {
      next.cliConcurrency = Math.max(1, Math.min(10, Math.round(next.cliConcurrency)));
    } else if (next.cliConcurrency !== undefined) {
      delete next.cliConcurrency;
    }
    if (typeof next.extractionConcurrency === 'number' && Number.isFinite(next.extractionConcurrency)) {
      next.extractionConcurrency = Math.max(1, Math.min(MAX_CONTEXT_MAP_PROCESSOR_CONCURRENCY, Math.round(next.extractionConcurrency)));
    } else if (next.extractionConcurrency !== undefined) {
      delete next.extractionConcurrency;
    }
    if (typeof next.synthesisConcurrency === 'number' && Number.isFinite(next.synthesisConcurrency)) {
      next.synthesisConcurrency = Math.max(1, Math.min(MAX_CONTEXT_MAP_PROCESSOR_CONCURRENCY, Math.round(next.synthesisConcurrency)));
    } else if (next.synthesisConcurrency !== undefined) {
      delete next.synthesisConcurrency;
    }
    return next;
  }

  private _normalizeProfileSelection(
    profiles: CliProfile[],
    profileId: string | undefined,
    backend: string | undefined,
  ): { profileId?: string; backend?: string } {
    const selected = profileId
      ? profiles.find((profile) => profile.id === profileId && !profile.disabled)
      : undefined;
    if (selected) {
      return {
        profileId: selected.id,
        backend: backendForCliProfile(selected, backend),
      };
    }

    if (profileId && !selected) {
      return { backend };
    }

    const vendor = cliVendorForBackend(backend);
    if (vendor) {
      const serverConfiguredId = serverConfiguredCliProfileId(vendor);
      const legacyProfile = profiles.find((profile) => profile.id === serverConfiguredId && !profile.disabled)
        || profiles.find((profile) => profile.vendor === vendor && !profile.disabled);
      if (legacyProfile) {
        return { profileId: legacyProfile.id, backend };
      }
    }

    return { backend };
  }

  private _normalizeCliProfile(profile: CliProfile, now: string, defaultBackend?: string): CliProfile | null {
    if (!profile || !isCliVendor(profile.vendor)) return null;

    const id = String(profile.id || '').trim();
    if (!id) return null;

    const vendor = profile.vendor;
    const normalized: CliProfile = {
      id,
      name: String(profile.name || '').trim() || id,
      vendor,
      ...(vendor === 'claude-code'
        ? { protocol: profile.protocol === 'interactive' ? 'interactive' : profile.protocol === 'standard' ? 'standard' : cliProtocolForBackend(defaultBackend, vendor) || 'standard' }
        : {}),
      authMode: vendor === 'kiro'
        ? 'server-configured'
        : profile.authMode === 'account' ? 'account' : 'server-configured',
      createdAt: typeof profile.createdAt === 'string' && profile.createdAt ? profile.createdAt : now,
      updatedAt: now,
    };

    const command = profile.command?.trim();
    if (command && vendor !== 'kiro') normalized.command = command;

    const isSetupAccount = isSetupAccountCliProfile(normalized);
    const configDir = profile.configDir?.trim();
    if (configDir && vendor !== 'kiro' && !isSetupAccount) normalized.configDir = configDir;

    if (profile.env && vendor !== 'kiro') {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(profile.env)) {
        if (!key || typeof value !== 'string') continue;
        if (isSetupAccount && isCliAuthHomeEnvKey(vendor, key)) continue;
        env[key] = value;
      }
      if (Object.keys(env).length > 0) normalized.env = env;
    }

    if (profile.disabled) normalized.disabled = true;
    return normalized;
  }
}

function isCliAuthHomeEnvKey(vendor: CliProfile['vendor'], key: string): boolean {
  const normalized = key.toUpperCase();
  return (vendor === 'claude-code' && normalized === 'CLAUDE_CONFIG_DIR')
    || (vendor === 'codex' && normalized === 'CODEX_HOME');
}
