import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { WorkspaceFeatureSettingsStore, normalizeContextMapWorkspaceSettings } from '../src/services/chat/workspaceFeatureSettingsStore';
import type { Settings, WorkspaceIndex } from '../src/types';

function makeIndex(overrides: Partial<WorkspaceIndex> = {}): WorkspaceIndex {
  return {
    version: 2,
    workspacePath: '/tmp/workspace',
    conversations: [],
    ...overrides,
  } as WorkspaceIndex;
}

describe('WorkspaceFeatureSettingsStore', () => {
  test('normalizes Context Map workspace overrides against enabled profiles', () => {
    expect(normalizeContextMapWorkspaceSettings({
      processorMode: 'override',
      cliProfileId: 'codex-work',
      cliModel: 'gpt-5.4',
      cliEffort: 'xhigh',
      scanIntervalMinutes: 7.4,
    }, [{
      id: 'codex-work',
      name: 'Codex Work',
      vendor: 'codex',
      authMode: 'account',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    }])).toEqual({
      processorMode: 'override',
      cliProfileId: 'codex-work',
      cliBackend: 'codex',
      cliModel: 'gpt-5.4',
      cliEffort: 'xhigh',
      scanIntervalMinutes: 7,
    });
  });

  test('persists KB and Context Map workspace flags through the shared index boundary', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ac-feature-settings-'));
    const indexes = new Map<string, WorkspaceIndex>([['hash-a', makeIndex()]]);
    const settings: Settings = {
      theme: 'system',
      sendBehavior: 'enter',
      systemPrompt: '',
      defaultBackend: 'claude-code',
      cliProfiles: [],
    };
    const store = new WorkspaceFeatureSettingsStore({
      workspacesDir: dir,
      indexLock: { run: async (_key, fn) => fn() },
      readWorkspaceIndex: async (hash) => indexes.get(hash) || null,
      writeWorkspaceIndex: async (hash, index) => { indexes.set(hash, index); },
      getSettings: async () => settings,
    });

    await fsp.mkdir(path.join(dir, 'hash-a'), { recursive: true });
    expect(await store.setKbEnabled('hash-a', true)).toBe(true);
    expect(await store.setKbAutoDigest('hash-a', true)).toBe(true);
    expect(await store.setContextMapEnabled('hash-a', true)).toBe(true);
    expect(await store.setContextMapSettings('hash-a', { scanIntervalMinutes: 12 })).toEqual({
      processorMode: 'global',
      scanIntervalMinutes: 12,
    });

    expect(await store.getKbEnabled('hash-a')).toBe(true);
    expect(await store.getKbAutoDigest('hash-a')).toBe(true);
    expect(await store.getContextMapEnabled('hash-a')).toBe(true);
    expect(await store.listKbEnabledWorkspaceHashes()).toEqual(['hash-a']);
    expect(await store.listContextMapEnabledWorkspaceHashes()).toEqual(['hash-a']);
  });
});
