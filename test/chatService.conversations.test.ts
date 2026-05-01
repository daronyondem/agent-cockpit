/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ChatService } from '../src/services/chatService';
import { workspaceHash } from './helpers/workspace';
import { BackendRegistry } from '../src/services/backends/registry';
import { BaseBackendAdapter } from '../src/services/backends/base';
import type { BackendMetadata, CliProfile, SendMessageOptions, SendMessageResult, Message } from '../src/types';
import { serverConfiguredCliProfileId } from '../src/services/cliProfiles';

const DEFAULT_WORKSPACE = '/tmp/test-workspace';

let tmpDir: string;
let service: ChatService;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatservice-'));
  service = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE });
  await service.initialize();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createConversation', () => {
  test('creates with default title', async () => {
    const conv = await service.createConversation();
    expect(conv.title).toBe('New Chat');
    expect(conv.messages).toEqual([]);
    expect(conv.sessionNumber).toBe(1);
    expect(conv.currentSessionId).toBeDefined();
    expect(conv.backend).toBe('claude-code');
    expect(conv.cliProfileId).toBe(serverConfiguredCliProfileId('claude-code'));
  });

  test('creates with custom title and working dir', async () => {
    const conv = await service.createConversation('My Chat', '/tmp/work');
    expect(conv.title).toBe('My Chat');
    expect(conv.workingDir).toBe('/tmp/work');
  });

  test('uses default workspace when no workingDir given', async () => {
    const conv = await service.createConversation('Test');
    expect(conv.workingDir).toBe(DEFAULT_WORKSPACE);
  });

  test('persists workspace index and session file to disk', async () => {
    const conv = await service.createConversation('Disk Test', '/tmp/work');
    const hash = workspaceHash('/tmp/work');
    const indexPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json');
    expect(fs.existsSync(indexPath)).toBe(true);
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    expect(index.workspacePath).toBe('/tmp/work');
    expect(index.conversations).toHaveLength(1);
    expect(index.conversations[0].title).toBe('Disk Test');

    const sessionPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, conv.id, 'session-1.json');
    expect(fs.existsSync(sessionPath)).toBe(true);
  });

  test('two conversations with same workingDir share workspace', async () => {
    const c1 = await service.createConversation('First', '/tmp/shared');
    const c2 = await service.createConversation('Second', '/tmp/shared');
    const hash = workspaceHash('/tmp/shared');
    const index = JSON.parse(fs.readFileSync(
      path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json'), 'utf8'
    ));
    expect(index.conversations).toHaveLength(2);
    expect(index.conversations.map((c: any) => c.id).sort()).toEqual([c1.id, c2.id].sort());
  });

  test('creates with explicit backend parameter', async () => {
    const conv = await service.createConversation('Kiro Chat', '/tmp/work', 'kiro');
    expect(conv.backend).toBe('kiro');
    expect(conv.cliProfileId).toBe(serverConfiguredCliProfileId('kiro'));
    const retrieved = await service.getConversation(conv.id);
    expect(retrieved!.backend).toBe('kiro');
    expect(retrieved!.cliProfileId).toBe(serverConfiguredCliProfileId('kiro'));

    const settings = await service.getSettings();
    expect(settings.cliProfiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: serverConfiguredCliProfileId('kiro'),
          vendor: 'kiro',
          authMode: 'server-configured',
        }),
      ]),
    );
  });

  test('creates with an explicit CLI profile and resolves its vendor backend', async () => {
    const settings = await service.getSettings();
    const profile: CliProfile = {
      id: 'profile-kiro-work',
      name: 'Kiro Work',
      vendor: 'kiro',
      authMode: 'server-configured',
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    };
    await service.saveSettings({
      ...settings,
      cliProfiles: [...(settings.cliProfiles || []), profile],
    });

    const conv = await service.createConversation(
      'Profile Chat',
      '/tmp/profile-work',
      undefined,
      undefined,
      undefined,
      profile.id,
    );

    expect(conv.backend).toBe('kiro');
    expect(conv.cliProfileId).toBe(profile.id);

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.backend).toBe('kiro');
    expect(loaded!.cliProfileId).toBe(profile.id);
  });

  test('rejects an unknown CLI profile on create', async () => {
    await expect(
      service.createConversation('Bad Profile', undefined, undefined, undefined, undefined, 'missing-profile'),
    ).rejects.toThrow('CLI profile not found: missing-profile');
  });

  test('rejects backend mismatch when creating with a CLI profile', async () => {
    const settings = await service.getSettings();
    const profile: CliProfile = {
      id: 'profile-kiro-mismatch',
      name: 'Kiro Mismatch',
      vendor: 'kiro',
      authMode: 'server-configured',
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    };
    await service.saveSettings({
      ...settings,
      cliProfiles: [...(settings.cliProfiles || []), profile],
    });

    await expect(
      service.createConversation('Mismatch', undefined, 'claude-code', undefined, undefined, profile.id),
    ).rejects.toThrow('CLI profile vendor kiro does not match backend claude-code');
  });

  test('backend defaults to claude-code when not specified', async () => {
    const conv = await service.createConversation('Default Backend');
    expect(conv.backend).toBe('claude-code');
    expect(conv.cliProfileId).toBe(serverConfiguredCliProfileId('claude-code'));
  });

  test('uses defaultCliProfileId when creating without explicit backend/profile', async () => {
    const settings = await service.getSettings();
    const profile: CliProfile = {
      id: 'profile-codex-default',
      name: 'Codex Default',
      vendor: 'codex',
      authMode: 'account',
      configDir: '/tmp/codex-default',
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    };
    await service.saveSettings({
      ...settings,
      defaultCliProfileId: profile.id,
      cliProfiles: [...(settings.cliProfiles || []), profile],
    });

    const conv = await service.createConversation('Default Profile');

    expect(conv.backend).toBe('codex');
    expect(conv.cliProfileId).toBe(profile.id);
  });

  test('migrates existing vendor-only conversations to server-configured profiles on initialize', async () => {
    const migrateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chatservice-cli-profile-migrate-'));
    try {
      const ws = '/tmp/cli-profile-migrate';
      const hash = workspaceHash(ws);
      const workspaceDir = path.join(migrateTmp, 'data', 'chat', 'workspaces', hash);
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, 'index.json'), JSON.stringify({
        workspacePath: ws,
        conversations: [
          {
            id: 'conv-codex',
            title: 'Codex legacy',
            backend: 'codex',
            currentSessionId: 'session-codex',
            lastActivity: '2026-04-29T00:00:00.000Z',
            lastMessage: null,
            sessions: [{
              number: 1,
              sessionId: 'session-codex',
              summary: null,
              active: true,
              messageCount: 0,
              startedAt: '2026-04-29T00:00:00.000Z',
              endedAt: null,
            }],
          },
          {
            id: 'conv-kiro',
            title: 'Kiro legacy',
            backend: 'kiro',
            currentSessionId: 'session-kiro',
            lastActivity: '2026-04-29T00:00:00.000Z',
            lastMessage: null,
            sessions: [{
              number: 1,
              sessionId: 'session-kiro',
              summary: null,
              active: true,
              messageCount: 0,
              startedAt: '2026-04-29T00:00:00.000Z',
              endedAt: null,
            }],
          },
        ],
      }, null, 2));

      const migrating = new ChatService(migrateTmp, { defaultWorkspace: DEFAULT_WORKSPACE });
      await migrating.initialize();

      const index = JSON.parse(fs.readFileSync(path.join(workspaceDir, 'index.json'), 'utf8'));
      expect(index.conversations[0].cliProfileId).toBe(serverConfiguredCliProfileId('codex'));
      expect(index.conversations[1].cliProfileId).toBe(serverConfiguredCliProfileId('kiro'));

      const settings = await migrating.getSettings();
      expect(settings.cliProfiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: serverConfiguredCliProfileId('codex'), vendor: 'codex' }),
          expect.objectContaining({ id: serverConfiguredCliProfileId('kiro'), vendor: 'kiro' }),
        ]),
      );
    } finally {
      fs.rmSync(migrateTmp, { recursive: true, force: true });
    }
  });
});

describe('getConversation', () => {
  test('returns null for non-existent id', async () => {
    expect(await service.getConversation('does-not-exist')).toBeNull();
  });

  test('returns the saved conversation with messages', async () => {
    const conv = await service.createConversation('Get Test');
    const loaded = await service.getConversation(conv.id);
    expect(loaded!.id).toBe(conv.id);
    expect(loaded!.title).toBe('Get Test');
    expect(loaded!.messages).toEqual([]);
  });

  test('returns externalSessionId when set on active session', async () => {
    const conv = await service.createConversation('Ext Session', '/tmp/ext');
    // Write externalSessionId directly to the workspace index
    const hash = workspaceHash('/tmp/ext');
    const indexPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const activeSession = index.conversations[0].sessions.find((s: any) => s.active);
    activeSession.externalSessionId = 'kiro-acp-session-abc123';
    fs.writeFileSync(indexPath, JSON.stringify(index));

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.externalSessionId).toBe('kiro-acp-session-abc123');
  });

  test('returns archived:true when the conversation has been archived', async () => {
    const conv = await service.createConversation('Archived Get');
    await service.archiveConversation(conv.id);
    const loaded = await service.getConversation(conv.id);
    expect(loaded!.archived).toBe(true);
  });

  test('returns archived:undefined for active conversations', async () => {
    const conv = await service.createConversation('Active Get');
    const loaded = await service.getConversation(conv.id);
    expect(loaded!.archived).toBeUndefined();
  });

  test('returns null externalSessionId when not set', async () => {
    const conv = await service.createConversation('No Ext');
    const loaded = await service.getConversation(conv.id);
    expect(loaded!.externalSessionId).toBeNull();
  });
});

describe('listConversations', () => {
  test('returns empty array when no conversations', async () => {
    expect(await service.listConversations()).toEqual([]);
  });

  test('returns summaries with most recently updated first', async () => {
    const c1 = await service.createConversation('First');
    const c2 = await service.createConversation('Second');

    await service.addMessage(c2.id, 'user', 'hello', 'claude-code');

    const list = await service.listConversations();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(c2.id);
    expect(list[0].messageCount).toBe(1);
    expect(list[0].lastMessage).toBe('hello');
    expect(list[1].id).toBe(c1.id);
  });

  test('includes workingDir in listing', async () => {
    await service.createConversation('Test', '/tmp/myproject');
    const list = await service.listConversations();
    expect(list[0].workingDir).toBe('/tmp/myproject');
  });
});

describe('renameConversation', () => {
  test('renames and persists', async () => {
    const conv = await service.createConversation('Old Name');
    const updated = await service.renameConversation(conv.id, 'New Name');
    expect(updated!.title).toBe('New Name');

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.title).toBe('New Name');
  });

  test('returns null for non-existent id', async () => {
    expect(await service.renameConversation('nope', 'Name')).toBeNull();
  });

  test('persists titleManuallySet flag in workspace index', async () => {
    const conv = await service.createConversation('Old Name', '/tmp/rename-flag');
    await service.renameConversation(conv.id, 'Manual Name');

    const hash = workspaceHash('/tmp/rename-flag');
    const index = JSON.parse(fs.readFileSync(
      path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json'), 'utf8'
    ));
    const entry = index.conversations.find((c: any) => c.id === conv.id);
    expect(entry.titleManuallySet).toBe(true);
  });

  test('does not set titleManuallySet on createConversation', async () => {
    const conv = await service.createConversation('Initial Title', '/tmp/create-flag');

    const hash = workspaceHash('/tmp/create-flag');
    const index = JSON.parse(fs.readFileSync(
      path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json'), 'utf8'
    ));
    const entry = index.conversations.find((c: any) => c.id === conv.id);
    expect(entry.titleManuallySet).toBeUndefined();
  });

  test('manual rename survives a session reset', async () => {
    (service as any)._generateSessionSummary = async (_msgs: any, fb: string) => fb;
    const conv = await service.createConversation('Old Name');
    await service.addMessage(conv.id, 'user', 'Hello', 'claude-code');
    await service.renameConversation(conv.id, 'Manual Name');

    const result = await service.resetSession(conv.id);
    expect(result!.conversation.title).toBe('Manual Name');

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.title).toBe('Manual Name');
  });

  test('manual rename survives first-message auto-titling', async () => {
    const conv = await service.createConversation();
    expect(conv.title).toBe('New Chat');
    await service.renameConversation(conv.id, 'Manual Name');

    await service.addMessage(conv.id, 'user', 'This message would normally become the title', 'claude-code');

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.title).toBe('Manual Name');
  });

  test('manual rename survives generateAndUpdateTitle', async () => {
    const conv = await service.createConversation('Old Title');
    await service.renameConversation(conv.id, 'Manual Name');

    const returned = await service.generateAndUpdateTitle(conv.id, 'Some user message');
    expect(returned).toBe('Manual Name');

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.title).toBe('Manual Name');
  });
});

describe('deleteConversation', () => {
  test('deletes existing conversation', async () => {
    const conv = await service.createConversation('Delete Me');
    expect(await service.deleteConversation(conv.id)).toBe(true);
    expect(await service.getConversation(conv.id)).toBeNull();
  });

  test('returns false for non-existent id', async () => {
    expect(await service.deleteConversation('nope')).toBe(false);
  });

  test('cleans up artifacts directory on delete', async () => {
    const conv = await service.createConversation('Artifact Cleanup');
    const artifactDir = path.join(tmpDir, 'data', 'chat', 'artifacts', conv.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'test.txt'), 'hello');

    expect(await service.deleteConversation(conv.id)).toBe(true);
    expect(fs.existsSync(artifactDir)).toBe(false);
  });

  test('cleans up session files on delete', async () => {
    const conv = await service.createConversation('Session Cleanup', '/tmp/work');
    await service.addMessage(conv.id, 'user', 'Hello', 'claude-code');

    (service as any)._generateSessionSummary = async (msgs: any, fallback: string) => fallback;
    await service.resetSession(conv.id);

    const hash = workspaceHash('/tmp/work');
    const convDir = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, conv.id);
    expect(fs.existsSync(convDir)).toBe(true);

    expect(await service.deleteConversation(conv.id)).toBe(true);
    expect(fs.existsSync(convDir)).toBe(false);
  });

  test('removes conversation from workspace index', async () => {
    const c1 = await service.createConversation('Keep', '/tmp/shared');
    const c2 = await service.createConversation('Delete', '/tmp/shared');

    await service.deleteConversation(c2.id);

    const hash = workspaceHash('/tmp/shared');
    const index = JSON.parse(fs.readFileSync(
      path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json'), 'utf8'
    ));
    expect(index.conversations).toHaveLength(1);
    expect(index.conversations[0].id).toBe(c1.id);
  });
});

// ── Archive / Restore ───────────────────────────────────────────────────────

describe('archiveConversation', () => {
  test('sets archived flag on conversation', async () => {
    const conv = await service.createConversation('Archive Me');
    expect(await service.archiveConversation(conv.id)).toBe(true);

    // Should not appear in default list
    const active = await service.listConversations();
    expect(active.find(c => c.id === conv.id)).toBeUndefined();

    // Should appear in archived list
    const archived = await service.listConversations({ archived: true });
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe(conv.id);
  });

  test('returns false for non-existent id', async () => {
    expect(await service.archiveConversation('nope')).toBe(false);
  });

  test('does not delete session files or artifacts', async () => {
    const conv = await service.createConversation('Keep Files', '/tmp/work');
    await service.addMessage(conv.id, 'user', 'Hello', 'claude-code');
    const artifactDir = path.join(tmpDir, 'data', 'chat', 'artifacts', conv.id);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'test.txt'), 'hello');

    await service.archiveConversation(conv.id);

    const hash = workspaceHash('/tmp/work');
    const sessionPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, conv.id, 'session-1.json');
    expect(fs.existsSync(sessionPath)).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'test.txt'))).toBe(true);
  });
});

describe('restoreConversation', () => {
  test('restores archived conversation to active list', async () => {
    const conv = await service.createConversation('Restore Me');
    await service.archiveConversation(conv.id);

    expect(await service.restoreConversation(conv.id)).toBe(true);

    const active = await service.listConversations();
    expect(active.find(c => c.id === conv.id)).toBeDefined();

    const archived = await service.listConversations({ archived: true });
    expect(archived.find(c => c.id === conv.id)).toBeUndefined();
  });

  test('returns false for non-existent id', async () => {
    expect(await service.restoreConversation('nope')).toBe(false);
  });
});

describe('setConversationUnread', () => {
  test('sets unread flag on conversation entry', async () => {
    const conv = await service.createConversation('Mark Unread', '/tmp/work');
    expect(await service.setConversationUnread(conv.id, true)).toBe(true);

    const hash = workspaceHash('/tmp/work');
    const indexPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const entry = index.conversations.find((c: any) => c.id === conv.id);
    expect(entry.unread).toBe(true);
  });

  test('clears unread flag (deletes field) when unread=false', async () => {
    const conv = await service.createConversation('Clear Unread', '/tmp/work');
    await service.setConversationUnread(conv.id, true);

    expect(await service.setConversationUnread(conv.id, false)).toBe(true);

    const hash = workspaceHash('/tmp/work');
    const indexPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const entry = index.conversations.find((c: any) => c.id === conv.id);
    expect(entry.unread).toBeUndefined();
    expect('unread' in entry).toBe(false);
  });

  test('idempotent — repeat true returns true and does not duplicate', async () => {
    const conv = await service.createConversation('Idempotent');
    expect(await service.setConversationUnread(conv.id, true)).toBe(true);
    expect(await service.setConversationUnread(conv.id, true)).toBe(true);
  });

  test('idempotent — clearing already-clear conversation returns true', async () => {
    const conv = await service.createConversation('Already Clear');
    expect(await service.setConversationUnread(conv.id, false)).toBe(true);
  });

  test('returns false for non-existent id', async () => {
    expect(await service.setConversationUnread('nope', true)).toBe(false);
    expect(await service.setConversationUnread('nope', false)).toBe(false);
  });

  test('listConversations surfaces unread on summary', async () => {
    const conv = await service.createConversation('Surfaced');
    await service.setConversationUnread(conv.id, true);

    const list = await service.listConversations();
    const item = list.find(c => c.id === conv.id);
    expect(item).toBeDefined();
    expect(item!.unread).toBe(true);
  });
});

describe('listConversations with archived filter', () => {
  test('default excludes archived', async () => {
    const c1 = await service.createConversation('Active');
    const c2 = await service.createConversation('Archived');
    await service.archiveConversation(c2.id);

    const list = await service.listConversations();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(c1.id);
  });

  test('archived=true returns only archived', async () => {
    const c1 = await service.createConversation('Active');
    const c2 = await service.createConversation('Archived');
    await service.archiveConversation(c2.id);

    const list = await service.listConversations({ archived: true });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(c2.id);
  });
});

describe('searchConversations with archived filter', () => {
  test('default search excludes archived', async () => {
    await service.createConversation('Alpha Active');
    const c2 = await service.createConversation('Alpha Archived');
    await service.archiveConversation(c2.id);

    const results = await service.searchConversations('alpha');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Alpha Active');
  });

  test('archived search finds only archived', async () => {
    await service.createConversation('Alpha Active');
    const c2 = await service.createConversation('Alpha Archived');
    await service.archiveConversation(c2.id);

    const results = await service.searchConversations('alpha', { archived: true });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Alpha Archived');
  });
});

describe('deleteConversation on archived conversation', () => {
  test('deletes an archived conversation and removes files', async () => {
    const conv = await service.createConversation('Archive Then Delete', '/tmp/work');
    await service.addMessage(conv.id, 'user', 'Hello', 'claude-code');
    await service.archiveConversation(conv.id);

    expect(await service.deleteConversation(conv.id)).toBe(true);
    expect(await service.getConversation(conv.id)).toBeNull();

    const hash = workspaceHash('/tmp/work');
    const convDir = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, conv.id);
    expect(fs.existsSync(convDir)).toBe(false);
  });
});

describe('updateConversationBackend', () => {
  test('updates backend in workspace index', async () => {
    const conv = await service.createConversation('Test');
    await service.updateConversationBackend(conv.id, 'openai');

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.backend).toBe('openai');
  });

  test('clears contextUsagePercentage on backend change', async () => {
    const conv = await service.createConversation('Test');
    await service.updateConversationBackend(conv.id, 'kiro');
    await service.addUsage(conv.id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, contextUsagePercentage: 42 }, 'kiro');

    let usage = await service.getUsage(conv.id);
    expect(usage!.contextUsagePercentage).toBe(42);

    await service.updateConversationBackend(conv.id, 'claude-code');

    usage = await service.getUsage(conv.id);
    expect(usage!.contextUsagePercentage).toBeUndefined();
  });

  test('preserves contextUsagePercentage when backend is unchanged', async () => {
    const conv = await service.createConversation('Test');
    await service.updateConversationBackend(conv.id, 'kiro');
    await service.addUsage(conv.id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, contextUsagePercentage: 42 }, 'kiro');

    await service.updateConversationBackend(conv.id, 'kiro');

    const usage = await service.getUsage(conv.id);
    expect(usage!.contextUsagePercentage).toBe(42);
  });
});

describe('updateConversationCliProfile', () => {
  test('updates backend and profile in the workspace index', async () => {
    const settings = await service.getSettings();
    const profile: CliProfile = {
      id: 'profile-kiro-switch',
      name: 'Kiro Switch',
      vendor: 'kiro',
      authMode: 'server-configured',
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    };
    await service.saveSettings({
      ...settings,
      cliProfiles: [...(settings.cliProfiles || []), profile],
    });
    const conv = await service.createConversation('Test');

    await service.updateConversationCliProfile(conv.id, profile.id);

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.backend).toBe('kiro');
    expect(loaded!.cliProfileId).toBe(profile.id);
  });

  test('clears contextUsagePercentage when profile changes vendor', async () => {
    const settings = await service.getSettings();
    const profile: CliProfile = {
      id: 'profile-kiro-usage',
      name: 'Kiro Usage',
      vendor: 'kiro',
      authMode: 'server-configured',
      createdAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
    };
    await service.saveSettings({
      ...settings,
      cliProfiles: [...(settings.cliProfiles || []), profile],
    });
    const conv = await service.createConversation('Test');
    await service.addUsage(conv.id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, contextUsagePercentage: 42 }, 'claude-code');

    await service.updateConversationCliProfile(conv.id, profile.id);

    const usage = await service.getUsage(conv.id);
    expect(usage!.contextUsagePercentage).toBeUndefined();
  });
});

describe('model selection', () => {
  test('creates conversation with model', async () => {
    const conv = await service.createConversation('Test', undefined, undefined, 'opus');
    expect(conv.model).toBe('opus');

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.model).toBe('opus');
  });

  test('creates conversation without model', async () => {
    const conv = await service.createConversation('Test');
    expect(conv.model).toBeUndefined();
  });

  test('updateConversationModel sets model', async () => {
    const conv = await service.createConversation('Test');
    await service.updateConversationModel(conv.id, 'haiku');

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.model).toBe('haiku');
  });

  test('updateConversationModel clears model with null', async () => {
    const conv = await service.createConversation('Test', undefined, undefined, 'opus');
    await service.updateConversationModel(conv.id, null);

    const loaded = await service.getConversation(conv.id);
    expect(loaded!.model).toBeUndefined();
  });

  test('model appears in listConversations', async () => {
    await service.createConversation('Test', undefined, undefined, 'sonnet');
    const list = await service.listConversations();
    expect(list[0].model).toBe('sonnet');
  });
});

// ── Effort selection ─────────────────────────────────────────────────────────

describe('effort selection', () => {
  // Build an isolated service with a backend registry that knows about the
  // canonical opus/sonnet/haiku supportedEffortLevels so _effectiveEffort has
  // something to look up.
  let svc: ChatService;

  beforeEach(async () => {
    class EffortAwareAdapter extends BaseBackendAdapter {
      get metadata(): BackendMetadata {
        return {
          id: 'claude-code',
          label: 'Claude Code',
          icon: null,
          capabilities: {
            thinking: true,
            planMode: true,
            agents: true,
            toolActivity: true,
            userQuestions: true,
            stdinInput: true,
          },
          models: [
            { id: 'opus', label: 'Opus', family: 'opus', supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
            { id: 'sonnet', label: 'Sonnet', family: 'sonnet', default: true, supportedEffortLevels: ['low', 'medium', 'high'] },
            { id: 'codex', label: 'Codex', family: 'gpt', supportedEffortLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
            { id: 'low-only', label: 'Low Only', family: 'gpt', supportedEffortLevels: ['low'] },
            { id: 'haiku', label: 'Haiku', family: 'haiku' },
          ],
        };
      }
      sendMessage(_m: string, _o: SendMessageOptions): SendMessageResult {
        return { stream: (async function*() {})(), abort: () => {}, sendInput: () => {} };
      }
      async generateSummary(_msgs: Pick<Message, 'role' | 'content'>[], fb: string): Promise<string> { return fb; }
    }
    const registry = new BackendRegistry();
    registry.register(new EffortAwareAdapter());
    svc = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE, backendRegistry: registry });
    await svc.initialize();
  });

  test('creates conversation with supported effort', async () => {
    const conv = await svc.createConversation('T', undefined, 'claude-code', 'opus', 'max');
    expect(conv.effort).toBe('max');
    const loaded = await svc.getConversation(conv.id);
    expect(loaded!.effort).toBe('max');
  });

  test('silently downgrades effort when model does not support the level', async () => {
    // Sonnet does not support 'max' → downgrade to 'high'.
    const conv = await svc.createConversation('T', undefined, 'claude-code', 'sonnet', 'max');
    expect(conv.effort).toBe('high');
  });

  test('drops effort when model has no effort support', async () => {
    const conv = await svc.createConversation('T', undefined, 'claude-code', 'haiku', 'high');
    expect(conv.effort).toBeUndefined();
  });

  test('drops effort when no model is specified', async () => {
    const conv = await svc.createConversation('T', undefined, 'claude-code', undefined, 'high');
    expect(conv.effort).toBeUndefined();
  });

  test('updateConversationModel downgrades stored effort on switch to weaker model', async () => {
    const conv = await svc.createConversation('T', undefined, 'claude-code', 'opus', 'max');
    expect(conv.effort).toBe('max');

    await svc.updateConversationModel(conv.id, 'sonnet');
    const loaded = await svc.getConversation(conv.id);
    expect(loaded!.model).toBe('sonnet');
    expect(loaded!.effort).toBe('high');
  });

  test('updateConversationModel clears effort when new model has no support', async () => {
    const conv = await svc.createConversation('T', undefined, 'claude-code', 'opus', 'max');
    await svc.updateConversationModel(conv.id, 'haiku');
    const loaded = await svc.getConversation(conv.id);
    expect(loaded!.effort).toBeUndefined();
  });

  test('updateConversationEffort sets a new supported level', async () => {
    const conv = await svc.createConversation('T', undefined, 'claude-code', 'opus', 'high');
    await svc.updateConversationEffort(conv.id, 'max');
    const loaded = await svc.getConversation(conv.id);
    expect(loaded!.effort).toBe('max');
  });

  test('updateConversationEffort downgrades when level is unsupported', async () => {
    const conv = await svc.createConversation('T', undefined, 'claude-code', 'sonnet', 'high');
    // sonnet does not support max — should downgrade to high
    await svc.updateConversationEffort(conv.id, 'max');
    const loaded = await svc.getConversation(conv.id);
    expect(loaded!.effort).toBe('high');
  });

  test('unsupported effort prefers high before lower supported levels', async () => {
    const conv = await svc.createConversation('T', undefined, 'claude-code', 'codex', 'max');
    expect(conv.effort).toBe('high');
  });

  test('unsupported effort falls back to first supported level when high is unavailable', async () => {
    const conv = await svc.createConversation('T', undefined, 'claude-code', 'low-only', 'high');
    expect(conv.effort).toBe('low');
  });

  test('updateConversationEffort clears effort with null', async () => {
    const conv = await svc.createConversation('T', undefined, 'claude-code', 'opus', 'max');
    await svc.updateConversationEffort(conv.id, null);
    const loaded = await svc.getConversation(conv.id);
    expect(loaded!.effort).toBeUndefined();
  });

  test('effort appears in listConversations', async () => {
    await svc.createConversation('T', undefined, 'claude-code', 'opus', 'max');
    const list = await svc.listConversations();
    expect(list[0].effort).toBe('max');
  });
});

// ── Messages ─────────────────────────────────────────────────────────────────
