
import fs from 'fs';
import path from 'path';
import os from 'os';
import { mergeSettingsSecretsForSave, redactSettingsSecrets, SettingsService } from '../src/services/settingsService';
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
    expect(settings.defaultBackend).toBeUndefined();
    expect(settings.defaultCliProfileId).toBeUndefined();
    expect(settings.cliProfiles).toEqual([]);
    expect(settings.systemPrompt).toBe('');
    expect(settings.workspaceContext).toEqual({
      scanIntervalMinutes: 5,
      cliConcurrency: 1,
      maintenanceIntervalHours: 24,
      maintenanceCliConcurrency: 1,
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

  test('redacts global Telegram bot token while preserving configured status', async () => {
    const settings = await service.saveSettings({
      ...(await service.getSettings()),
      integrations: { telegram: { botToken: '123:secret' } },
    });

    const redacted = redactSettingsSecrets(settings);

    expect(redacted.integrations?.telegram?.configured).toBe(true);
    expect(redacted.integrations?.telegram?.botToken).toBeUndefined();
    expect(JSON.stringify(redacted)).not.toContain('123:secret');
  });

  test('preserves and clears global Telegram bot token through whole-settings saves', async () => {
    const current = await service.saveSettings({
      ...(await service.getSettings()),
      integrations: { telegram: { botToken: '123:secret' } },
    });

    const redacted = redactSettingsSecrets(current);
    const saved = await service.saveSettings(mergeSettingsSecretsForSave({
      ...redacted,
      theme: 'dark',
    }, current));

    expect(saved.theme).toBe('dark');
    expect(saved.integrations?.telegram?.botToken).toBe('123:secret');

    const blankTokenSave = await service.saveSettings(mergeSettingsSecretsForSave({
      ...redactSettingsSecrets(saved),
      integrations: { telegram: { configured: true, botToken: '' } },
    }, saved));

    expect(blankTokenSave.integrations?.telegram?.botToken).toBe('123:secret');

    const cleared = await service.saveSettings(mergeSettingsSecretsForSave({
      ...redactSettingsSecrets(blankTokenSave),
      integrations: { telegram: { configured: true, clearBotToken: true } },
    }, blankTokenSave));

    expect(cleared.integrations?.telegram?.botToken).toBeUndefined();
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
        harness: 'codex',
        authMode: 'server-configured',
      }),
    ]);
  });

  test('migrates legacy CLI profile vendor fields to harness on read', async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({
      theme: 'system',
      sendBehavior: 'enter',
      systemPrompt: '',
      defaultCliProfileId: 'legacy-codex',
      defaultBackend: 'codex',
      cliProfiles: [{
        id: 'legacy-codex',
        name: 'Legacy Codex',
        vendor: 'codex',
        authMode: 'account',
        configDir: '/tmp/legacy-codex',
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      }],
    }, null, 2));

    const loaded = await service.getSettings();

    expect(loaded.cliProfiles![0]).toEqual(expect.objectContaining({
      id: 'legacy-codex',
      harness: 'codex',
    }));
    expect((loaded.cliProfiles![0] as any).vendor).toBeUndefined();

    const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(persisted.cliProfiles[0].harness).toBe('codex');
    expect(persisted.cliProfiles[0].vendor).toBeUndefined();
  });

  test('saving a default CLI profile keeps defaultBackend aligned', async () => {
    const settings = await service.getSettings();
    const profile = {
      id: 'profile-codex-work',
      name: 'Codex Work',
      harness: 'codex',
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

  test('saving the first enabled CLI profile promotes it as the default', async () => {
    const settings = await service.getSettings();
    const profile = {
      id: 'profile-codex-first',
      name: 'Codex First',
      harness: 'codex',
      authMode: 'account',
      configDir: '/tmp/codex-first',
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    };

    const saved = await service.saveSettings({
      ...settings,
      cliProfiles: [profile],
    } as any);

    expect(saved.defaultCliProfileId).toBe(profile.id);
    expect(saved.defaultBackend).toBe('codex');
  });

  test('defaultServiceTier is validated after default profile promotion', async () => {
    const settings = await service.getSettings();
    const profile = {
      id: 'profile-claude-first',
      name: 'Claude First',
      harness: 'claude-code',
      authMode: 'account',
      configDir: '/tmp/claude-first',
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    };

    const saved = await service.saveSettings({
      ...settings,
      defaultBackend: 'codex',
      defaultServiceTier: 'fast',
      cliProfiles: [profile],
    } as any);

    expect(saved.defaultCliProfileId).toBe(profile.id);
    expect(saved.defaultBackend).toBe('claude-code');
    expect(saved.defaultServiceTier).toBeUndefined();
  });

  test('saving a disabled default CLI profile clears the default profile', async () => {
    const settings = await service.getSettings();
    const defaultProfileId = serverConfiguredCliProfileId('claude-code');
    const now = '2026-04-29T00:00:00.000Z';

    const saved = await service.saveSettings({
      ...settings,
      defaultCliProfileId: defaultProfileId,
      defaultBackend: 'claude-code',
      cliProfiles: [{
        id: defaultProfileId,
        name: 'Claude Code (Server Configured)',
        harness: 'claude-code',
        authMode: 'server-configured',
        createdAt: now,
        updatedAt: now,
        disabled: true,
      }],
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
          harness: 'kiro',
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

  test('saving an OpenCode profile preserves provider metadata only', async () => {
    const settings = await service.getSettings();
    const saved = await service.saveSettings({
      ...settings,
      cliProfiles: [
        ...(settings.cliProfiles || []),
        {
          id: 'profile-opencode-deepseek',
          name: 'OpenCode DeepSeek',
          harness: 'opencode',
          authMode: 'account',
          command: '/Users/test/.opencode/bin/opencode',
          configDir: '/tmp/opencode-account',
          env: { OPENCODE_CONFIG_CONTENT: '{"theme":"dark"}' },
          protocol: 'interactive',
          opencode: {
            provider: ' deepseek ',
            model: ' deepseek/deepseek-v4-pro ',
          },
          createdAt: '2026-05-24T00:00:00.000Z',
          updatedAt: '2026-05-24T00:00:00.000Z',
        },
      ],
    } as any);

    const profile = saved.cliProfiles!.find((p) => p.id === 'profile-opencode-deepseek')!;
    expect(profile.harness).toBe('opencode');
    expect(profile.authMode).toBe('server-configured');
    expect(profile.protocol).toBeUndefined();
    expect(profile.command).toBe('/Users/test/.opencode/bin/opencode');
    expect(profile.configDir).toBeUndefined();
    expect(profile.env).toBeUndefined();
    expect(profile.opencode).toEqual({
      provider: 'deepseek',
    });
    expect(saved.defaultCliProfileId).toBe(profile.id);
    expect(saved.defaultBackend).toBe('opencode');
  });

  test('saving a non-OpenCode profile drops OpenCode metadata', async () => {
    const settings = await service.getSettings();
    const saved = await service.saveSettings({
      ...settings,
      cliProfiles: [
        {
          id: 'profile-claude-with-opencode',
          name: 'Claude',
          harness: 'claude-code',
          authMode: 'server-configured',
          opencode: {
            provider: 'deepseek',
            model: 'deepseek/deepseek-chat',
          },
          createdAt: '2026-05-24T00:00:00.000Z',
          updatedAt: '2026-05-24T00:00:00.000Z',
        },
      ],
    } as any);

    expect(saved.cliProfiles![0].opencode).toBeUndefined();
  });

  test('saving setup account profiles strips isolated auth homes', async () => {
    const settings = await service.getSettings();
    const saved = await service.saveSettings({
      ...settings,
      defaultCliProfileId: 'setup-claude-code-account',
      defaultBackend: 'claude-code',
      cliProfiles: [{
        id: 'setup-claude-code-account',
        name: 'Claude Code Account',
        harness: 'claude-code',
        authMode: 'account',
        protocol: 'standard',
        configDir: '/tmp/agent-cockpit-private-claude',
        env: {
          CLAUDE_CONFIG_DIR: '/tmp/agent-cockpit-private-claude',
          ANTHROPIC_BASE_URL: 'https://example.test',
        },
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      }],
    } as any);

    const profile = saved.cliProfiles![0];
    expect(profile.configDir).toBeUndefined();
    expect(profile.env).toEqual({ ANTHROPIC_BASE_URL: 'https://example.test' });
    expect(saved.defaultCliProfileId).toBe('setup-claude-code-account');
    expect(saved.defaultBackend).toBe('claude-code');
  });

  test('reading persisted setup account profiles strips isolated auth homes in memory', async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({
      theme: 'system',
      sendBehavior: 'enter',
      systemPrompt: '',
      defaultCliProfileId: 'setup-codex-account',
      defaultBackend: 'codex',
      cliProfiles: [{
        id: 'setup-codex-account',
        name: 'Codex Account',
        harness: 'codex',
        authMode: 'account',
        configDir: '/tmp/agent-cockpit-private-codex',
        env: {
          CODEX_HOME: '/tmp/agent-cockpit-private-codex',
          OPENAI_BASE_URL: 'https://example.test',
        },
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      }],
    }, null, 2));

    const loaded = await service.getSettings();
    const profile = loaded.cliProfiles![0];
    expect(profile.configDir).toBeUndefined();
    expect(profile.env).toEqual({ OPENAI_BASE_URL: 'https://example.test' });
    expect(loaded.defaultCliProfileId).toBe('setup-codex-account');
    expect(loaded.defaultBackend).toBe('codex');

    const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, 'settings.json'), 'utf8'));
    expect(persisted.cliProfiles[0].configDir).toBeUndefined();
    expect(persisted.cliProfiles[0].env).toEqual({ OPENAI_BASE_URL: 'https://example.test' });
  });

  test('saving Memory, KB, and Workspace Context CLI profile selections keeps legacy backend fields aligned', async () => {
    const settings = await service.getSettings();
    const profile = {
      id: 'profile-codex-kb',
      name: 'Codex KB',
      harness: 'codex',
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
      workspaceContext: {
        cliProfileId: profile.id,
        cliBackend: 'claude-code',
        scanIntervalMinutes: 0,
        cliConcurrency: 99,
        maintenanceIntervalHours: 0,
        maintenanceCliConcurrency: 99,
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
    expect(saved.workspaceContext?.cliProfileId).toBe(profile.id);
    expect(saved.workspaceContext?.cliBackend).toBe('codex');
    expect(saved.workspaceContext?.scanIntervalMinutes).toBe(1);
    expect(saved.workspaceContext?.cliConcurrency).toBe(10);
    expect(saved.workspaceContext?.maintenanceIntervalHours).toBe(1);
    expect(saved.workspaceContext?.maintenanceCliConcurrency).toBe(10);
    expect((saved.workspaceContext as any)?.extractionConcurrency).toBeUndefined();
    expect((saved.workspaceContext as any)?.synthesisConcurrency).toBeUndefined();
    expect((saved.workspaceContext as any)?.sources).toBeUndefined();
  });
});
