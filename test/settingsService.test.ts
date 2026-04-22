/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { SettingsService } from '../src/services/settingsService';

let tmpDir: string;
let service: SettingsService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settingsservice-'));
  service = new SettingsService(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Settings ─────────────────────────────────────────────────────────────────

describe('settings', () => {
  test('returns defaults when no settings file', async () => {
    const settings = await service.getSettings();
    expect(settings.theme).toBe('system');
    expect(settings.sendBehavior).toBe('enter');
    expect(settings.defaultBackend).toBe('claude-code');
    expect(settings.systemPrompt).toBe('');
    expect((settings as any).customInstructions).toBeUndefined();
  });

  test('saves and retrieves settings', async () => {
    const input = { theme: 'dark', sendBehavior: 'ctrl-enter', systemPrompt: 'Be helpful' };
    await service.saveSettings(input as any);

    const loaded = await service.getSettings();
    expect(loaded.theme).toBe('dark');
    expect(loaded.sendBehavior).toBe('ctrl-enter');
    expect(loaded.systemPrompt).toBe('Be helpful');
  });

  test('migrates legacy customInstructions to systemPrompt', async () => {
    const legacy = {
      theme: 'dark',
      sendBehavior: 'enter',
      customInstructions: { aboutUser: 'I am a developer', responseStyle: 'Be concise' },
      defaultBackend: 'claude-code',
    };
    await service.saveSettings(legacy as any);

    const loaded = await service.getSettings();
    expect(loaded.systemPrompt).toBe('I am a developer\n\nBe concise');
    expect((loaded as any).customInstructions).toBeUndefined();

    const reloaded = await service.getSettings();
    expect(reloaded.systemPrompt).toBe('I am a developer\n\nBe concise');
  });

  test('migrates partial customInstructions gracefully', async () => {
    const legacy = {
      theme: 'system',
      customInstructions: { aboutUser: '', responseStyle: 'Use bullet points' },
    };
    await service.saveSettings(legacy as any);

    const loaded = await service.getSettings();
    expect(loaded.systemPrompt).toBe('Use bullet points');
    expect((loaded as any).customInstructions).toBeUndefined();
  });
});
