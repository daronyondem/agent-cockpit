import fsp from 'fs/promises';
import path from 'path';
import type { CliProfile, Settings } from '../types';
import { atomicWriteFile } from '../utils/atomicWrite';
import { ensureServerConfiguredCliProfiles, isCliVendor, serverConfiguredCliProfileId } from './cliProfiles';

interface PersistedSettings extends Settings {
  customInstructions?: { aboutUser?: string; responseStyle?: string };
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  sendBehavior: 'enter',
  systemPrompt: '',
  defaultBackend: 'claude-code',
  workingDirectory: '',
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

      return this._withDefaultCliProfile(settings);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return this._withDefaultCliProfile({ ...DEFAULT_SETTINGS });
      }
      throw err;
    }
  }

  async saveSettings(settings: Settings): Promise<Settings> {
    const normalized = this._withDefaultCliProfile(this._normalizeCliProfiles(settings));
    await atomicWriteFile(this._settingsFile, JSON.stringify(normalized, null, 2));
    return normalized;
  }

  private _withDefaultCliProfile(settings: Settings): Settings {
    return ensureServerConfiguredCliProfiles(
      settings,
      [settings.defaultBackend || DEFAULT_SETTINGS.defaultBackend],
    ).settings;
  }

  private _normalizeCliProfiles(settings: Settings): Settings {
    const now = new Date().toISOString();
    const profiles = Array.isArray(settings.cliProfiles)
      ? settings.cliProfiles
        .map((profile) => this._normalizeCliProfile(profile, now))
        .filter((profile): profile is CliProfile => !!profile)
      : [];

    const defaultProfile = settings.defaultCliProfileId
      ? profiles.find((profile) => profile.id === settings.defaultCliProfileId && !profile.disabled)
      : undefined;

    const next: Settings = {
      ...settings,
      cliProfiles: profiles,
      ...(defaultProfile ? { defaultBackend: defaultProfile.vendor } : {}),
    };
    if (settings.memory) {
      next.memory = this._normalizeMemorySettings(settings.memory, profiles);
    }
    if (settings.knowledgeBase) {
      next.knowledgeBase = this._normalizeKnowledgeBaseSettings(settings.knowledgeBase, profiles);
    }
    if (settings.defaultCliProfileId && !defaultProfile) {
      delete next.defaultCliProfileId;
    }
    return next;
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

  private _normalizeProfileSelection(
    profiles: CliProfile[],
    profileId: string | undefined,
    backend: string | undefined,
  ): { profileId?: string; backend?: string } {
    const selected = profileId
      ? profiles.find((profile) => profile.id === profileId && !profile.disabled)
      : undefined;
    if (selected) {
      return { profileId: selected.id, backend: selected.vendor };
    }

    if (profileId && !selected) {
      return { backend };
    }

    if (isCliVendor(backend)) {
      const serverConfiguredId = serverConfiguredCliProfileId(backend);
      const legacyProfile = profiles.find((profile) => profile.id === serverConfiguredId && !profile.disabled)
        || profiles.find((profile) => profile.vendor === backend && !profile.disabled);
      if (legacyProfile) {
        return { profileId: legacyProfile.id, backend: legacyProfile.vendor };
      }
    }

    return { backend };
  }

  private _normalizeCliProfile(profile: CliProfile, now: string): CliProfile | null {
    if (!profile || !isCliVendor(profile.vendor)) return null;

    const id = String(profile.id || '').trim();
    if (!id) return null;

    const vendor = profile.vendor;
    const normalized: CliProfile = {
      id,
      name: String(profile.name || '').trim() || id,
      vendor,
      authMode: vendor === 'kiro'
        ? 'server-configured'
        : profile.authMode === 'account' ? 'account' : 'server-configured',
      createdAt: typeof profile.createdAt === 'string' && profile.createdAt ? profile.createdAt : now,
      updatedAt: now,
    };

    const command = profile.command?.trim();
    if (command && vendor !== 'kiro') normalized.command = command;

    const configDir = profile.configDir?.trim();
    if (configDir && vendor !== 'kiro') normalized.configDir = configDir;

    if (profile.env && vendor !== 'kiro') {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(profile.env)) {
        if (!key || typeof value !== 'string') continue;
        env[key] = value;
      }
      if (Object.keys(env).length > 0) normalized.env = env;
    }

    if (profile.disabled) normalized.disabled = true;
    return normalized;
  }
}
