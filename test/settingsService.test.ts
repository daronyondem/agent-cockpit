/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { SettingsService } from '../src/services/settingsService';
import { serverConfiguredCliProfileId } from '../src/services/cliProfiles';

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
    expect(settings.defaultCliProfileId).toBe(serverConfiguredCliProfileId('claude-code'));
    expect(settings.cliProfiles).toEqual([
      expect.objectContaining({
        id: serverConfiguredCliProfileId('claude-code'),
        name: 'Claude Code (Server Configured)',
        vendor: 'claude-code',
        authMode: 'server-configured',
      }),
    ]);
    expect(settings.systemPrompt).toBe('');
    expect(settings.contextMap).toEqual({
      scanIntervalMinutes: 5,
      cliConcurrency: 1,
      extractionConcurrency: 3,
      synthesisConcurrency: 3,
    });
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

  test('copies legacy dreamingConcurrency forward to cliConcurrency on read', async () => {
    // Read-time migration only — disk file should NOT be rewritten until the
    // next legitimate save (the new key materializes on disk only when the
    // user changes a setting through the UI).
    const legacy = {
      theme: 'system',
      knowledgeBase: {
        dreamingCliBackend: 'claude-code',
        dreamingConcurrency: 4,
      },
    };
    await service.saveSettings(legacy as any);

    const loaded = await service.getSettings();
    expect(loaded.knowledgeBase?.cliConcurrency).toBe(4);
    expect(loaded.knowledgeBase?.dreamingConcurrency).toBe(4);

    // Disk untouched — still has only the legacy key.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'),
    );
    expect(onDisk.knowledgeBase.cliConcurrency).toBeUndefined();
    expect(onDisk.knowledgeBase.dreamingConcurrency).toBe(4);
  });

  test('does not overwrite cliConcurrency when both keys are present', async () => {
    const settings = {
      theme: 'system',
      knowledgeBase: {
        dreamingConcurrency: 4,
        cliConcurrency: 7,
      },
    };
    await service.saveSettings(settings as any);

    const loaded = await service.getSettings();
    expect(loaded.knowledgeBase?.cliConcurrency).toBe(7);
  });

  test('adds server-configured profile for persisted default backend on read', async () => {
    await service.saveSettings({
      theme: 'system',
      sendBehavior: 'enter',
      systemPrompt: '',
      defaultBackend: 'codex',
    } as any);

    const loaded = await service.getSettings();
    expect(loaded.defaultCliProfileId).toBe(serverConfiguredCliProfileId('codex'));
    expect(loaded.cliProfiles).toEqual([
      expect.objectContaining({
        id: serverConfiguredCliProfileId('codex'),
        name: 'Codex (Server Configured)',
        vendor: 'codex',
        authMode: 'server-configured',
      }),
    ]);
  });

  test('saving a default CLI profile keeps defaultBackend aligned', async () => {
    const settings = await service.getSettings();
    const profile = {
      id: 'profile-codex-work',
      name: 'Codex Work',
      vendor: 'codex',
      authMode: 'account',
      configDir: '/tmp/codex-work',
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    };

    const saved = await service.saveSettings({
      ...settings,
      defaultCliProfileId: profile.id,
      cliProfiles: [...(settings.cliProfiles || []), profile],
    } as any);

    expect(saved.defaultBackend).toBe('codex');
    expect(saved.defaultCliProfileId).toBe(profile.id);
  });

  test('saving a disabled default CLI profile clears the default profile', async () => {
    const settings = await service.getSettings();
    const defaultProfileId = serverConfiguredCliProfileId('claude-code');

    const saved = await service.saveSettings({
      ...settings,
      defaultCliProfileId: defaultProfileId,
      cliProfiles: (settings.cliProfiles || []).map((profile) => (
        profile.id === defaultProfileId ? { ...profile, disabled: true } : profile
      )),
    } as any);

    expect(saved.defaultCliProfileId).toBeUndefined();
  });

  test('saving a Kiro profile forces self-configured mode', async () => {
    const settings = await service.getSettings();
    const saved = await service.saveSettings({
      ...settings,
      cliProfiles: [
        ...(settings.cliProfiles || []),
        {
          id: 'profile-kiro-work',
          name: 'Kiro Work',
          vendor: 'kiro',
          authMode: 'account',
          command: '/custom/kiro-cli',
          configDir: '/tmp/kiro-work',
          env: { HOME: '/tmp/kiro-work' },
          createdAt: '2026-04-29T00:00:00.000Z',
          updatedAt: '2026-04-29T00:00:00.000Z',
        },
      ],
    } as any);

    const profile = saved.cliProfiles!.find((p) => p.id === 'profile-kiro-work')!;
    expect(profile.authMode).toBe('server-configured');
    expect(profile.command).toBeUndefined();
    expect(profile.configDir).toBeUndefined();
    expect(profile.env).toBeUndefined();
  });

  test('saving Memory, KB, and Context Map CLI profile selections keeps legacy backend fields aligned', async () => {
    const settings = await service.getSettings();
    const profile = {
      id: 'profile-codex-kb',
      name: 'Codex KB',
      vendor: 'codex',
      authMode: 'account',
      configDir: '/tmp/codex-kb',
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    };

    const saved = await service.saveSettings({
      ...settings,
      cliProfiles: [...(settings.cliProfiles || []), profile],
      memory: { cliProfileId: profile.id, cliBackend: 'claude-code' },
      knowledgeBase: {
        ingestionCliProfileId: profile.id,
        ingestionCliBackend: 'claude-code',
        digestionCliProfileId: profile.id,
        digestionCliBackend: 'claude-code',
        dreamingCliProfileId: profile.id,
        dreamingCliBackend: 'claude-code',
      },
      contextMap: {
        cliProfileId: profile.id,
        cliBackend: 'claude-code',
        scanIntervalMinutes: 0,
        cliConcurrency: 99,
        extractionConcurrency: 0,
        synthesisConcurrency: 99,
        sources: {
          conversations: true,
          git: 'yes',
        },
      },
    } as any);

    expect(saved.memory?.cliProfileId).toBe(profile.id);
    expect(saved.memory?.cliBackend).toBe('codex');
    expect(saved.knowledgeBase?.ingestionCliBackend).toBe('codex');
    expect(saved.knowledgeBase?.digestionCliBackend).toBe('codex');
    expect(saved.knowledgeBase?.dreamingCliBackend).toBe('codex');
    expect(saved.contextMap?.cliProfileId).toBe(profile.id);
    expect(saved.contextMap?.cliBackend).toBe('codex');
    expect(saved.contextMap?.scanIntervalMinutes).toBe(1);
    expect(saved.contextMap?.cliConcurrency).toBe(10);
    expect(saved.contextMap?.extractionConcurrency).toBe(1);
    expect(saved.contextMap?.synthesisConcurrency).toBe(6);
    expect((saved.contextMap as any)?.sources).toBeUndefined();
  });
});
