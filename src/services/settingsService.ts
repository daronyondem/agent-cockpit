import fsp from 'fs/promises';
import path from 'path';
import type { Settings } from '../types';

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

      return settings;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ...DEFAULT_SETTINGS };
      }
      throw err;
    }
  }

  async saveSettings(settings: Settings): Promise<Settings> {
    await fsp.writeFile(this._settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    return settings;
  }
}
