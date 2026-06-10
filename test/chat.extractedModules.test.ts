import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import type {
  ConversationEntry,
  KbCounters,
  Message,
  SessionFile,
  WorkspaceIndex,
} from '../src/types';
import {
  effectiveEffort,
  effectiveServiceTier,
  hardCutTitle,
  titleFallbackFromMessage,
} from '../src/services/chat/conversationPolicy';
import {
  memoryEntryId,
  normalizeMemoryMetadata,
  slugify,
} from '../src/services/chat/memoryMetadata';
import {
  conversationToMarkdown,
  messagesToMarkdown,
} from '../src/services/chat/transcriptMarkdown';
import { advanceConversationSession } from '../src/services/chat/sessionTransition';
import { WorkspaceContextStatusService } from '../src/services/chat/workspaceContextStatus';
import { KbStateSnapshotService } from '../src/services/chat/kbStateSnapshot';
import { WorkspaceMemoryStore } from '../src/services/chat/workspaceMemoryStore';
import { WorkspaceMemoryService } from '../src/services/chat/workspaceMemoryService';
import { parseFrontmatter as parseMemoryFrontmatter } from '../src/services/backends/claudeCode';
import { LegacyMigrations } from '../src/services/chat/legacyMigrations';
import { serverConfiguredCliProfileId } from '../src/services/cliProfiles';
import { enableWorktreeIsolation } from '../src/services/chat/worktreeIsolationToggle';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function message(role: Message['role'], content: string, timestamp: string): Message {
  return {
    id: `${role}-${timestamp}`,
    role,
    content,
    backend: 'claude-code',
    timestamp,
  };
}

describe('extracted chat modules', () => {
  test('memoryMetadata normalizes sidecar metadata and note slugs', () => {
    expect(slugify('Hello, Memory World!')).toBe('hello-memory-world');
    expect(memoryEntryId('notes/example.md')).toMatch(/^mem_[a-f0-9]{16}$/);

    const normalized = normalizeMemoryMetadata(
      {
        status: 'unknown',
        scope: 'user',
        source: 'bad-source',
        supersedes: ['mem_old', '', 42],
        redaction: [{ kind: 'token', reason: 'secret' }, { kind: 'bad' }],
      },
      'notes/example.md',
      'memory-note',
      '2026-01-01T00:00:00.000Z',
    );

    expect(normalized).toMatchObject({
      filename: 'notes/example.md',
      status: 'active',
      scope: 'user',
      source: 'memory-note',
      supersedes: ['mem_old'],
      redaction: [{ kind: 'token', reason: 'secret' }],
    });
  });

  test('conversationPolicy keeps effort, service tier, and title rules pure', () => {
    expect(effectiveEffort('sonnet', 'max', {
      id: 'sonnet',
      supportedEffortLevels: ['low', 'medium', 'high'],
    })).toBe('high');
    expect(effectiveEffort('low-only', 'high', {
      id: 'low-only',
      supportedEffortLevels: ['low'],
    })).toBe('low');
    expect(effectiveEffort(undefined, 'high', undefined)).toBeUndefined();
    expect(effectiveServiceTier('codex', 'fast')).toBe('fast');
    expect(effectiveServiceTier('claude-code', 'fast')).toBeUndefined();
    expect(titleFallbackFromMessage('line one\nline two')).toBe('line one line two');
    expect(hardCutTitle('one two three four five six seven eight nine')).toBe('one two three four five six seven eight');
  });

  test('transcriptMarkdown renders session and conversation transcripts', () => {
    const messages = [
      message('user', 'Hello', '2026-01-01T00:00:00.000Z'),
      message('assistant', 'Hi there', '2026-01-01T00:01:00.000Z'),
    ];

    const session = messagesToMarkdown('Title', 'conv-1', {
      number: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
    }, messages);
    expect(session).toContain('# Title');
    expect(session).toContain('**Conversation ID:** conv-1');
    expect(session).toContain('Hello');

    const conversation = conversationToMarkdown('Title', 'claude-code', [{
      session: {
        number: 1,
        sessionId: 's1',
        summary: 'old',
        active: false,
        messageCount: 2,
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:02:00.000Z',
      },
      messages,
    }]);
    expect(conversation).toContain('**Backend:** claude-code');
    expect(conversation).toContain('Session 1');
    expect(conversation).toContain('Session reset');
  });

  test('sessionTransition advances the active session with caller-owned persistence', async () => {
    const writes: Record<string, SessionFile> = {};
    const convEntry: ConversationEntry = {
      id: 'conv-1',
      title: 'Existing Title',
      backend: 'claude-code',
      currentSessionId: 's1',
      lastActivity: '2026-01-01T00:00:00.000Z',
      lastMessage: 'previous',
      messageQueue: [{ content: 'queued' }],
      sessions: [{
        number: 1,
        sessionId: 's1',
        summary: null,
        active: true,
        messageCount: 0,
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: null,
      }],
    };
    const archived = await advanceConversationSession({
      readSessionFile: async () => ({
        sessionNumber: 1,
        sessionId: 's1',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: null,
        messages: [message('user', 'Hello', '2026-01-01T00:00:00.000Z')],
      }),
      writeSessionFile: async (_hash, _convId, sessionNumber, data) => {
        writes[String(sessionNumber)] = data;
      },
      newId: () => 's2',
    }, 'workspace-1', convEntry, new Date('2026-01-01T00:05:00.000Z'), {
      branchName: 'ac/conv/session-2',
      baseRef: 'origin/main',
    });

    expect(archived).toMatchObject({ number: 1, messageCount: 1, summary: 'Session 1 (1 messages)' });
    expect(convEntry.currentSessionId).toBe('s2');
    expect(convEntry.title).toBe('New Chat');
    expect(convEntry.messageQueue).toBeUndefined();
    expect(convEntry.sessions).toHaveLength(2);
    expect(convEntry.sessions[1]).toMatchObject({
      number: 2,
      active: true,
      branchName: 'ac/conv/session-2',
      baseRef: 'origin/main',
    });
    expect(writes['1'].endedAt).toBe('2026-01-01T00:05:00.000Z');
    expect(writes['2'].messages).toEqual([]);
  });

  test('workspaceContextStatus reads runs and counts markdown files', async () => {
    const root = tmpDir('workspace-context-status-');
    try {
      const contextDir = path.join(root, 'workspace-context');
      await fsp.mkdir(path.join(contextDir, 'context', 'nested'), { recursive: true });
      await fsp.writeFile(path.join(contextDir, 'state.json'), JSON.stringify({
        lastRun: {
          runId: 'run-1',
          source: 'maintenance',
          status: 'failed',
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:01:00.000Z',
        },
        runs: [
          { runId: 'run-1', source: 'maintenance', status: 'failed', startedAt: '2026-01-01T00:00:00.000Z' },
          { runId: 'run-2', source: 'scheduled', status: 'running', startedAt: '2026-01-01T00:02:00.000Z' },
        ],
      }));
      await fsp.writeFile(path.join(contextDir, 'context', 'a.md'), 'A');
      await fsp.writeFile(path.join(contextDir, 'context', 'nested', 'b.md'), 'B');
      await fsp.writeFile(path.join(contextDir, 'context', '.hidden.md'), 'hidden');

      const service = new WorkspaceContextStatusService({
        getWorkspaceContextDir: () => contextDir,
        getWorkspaceContextEnabled: async () => true,
        log: { warn: jest.fn() },
      });

      const status = await service.getStatus('workspace-1');
      expect(status).toMatchObject({
        enabled: true,
        pending: true,
        runningRuns: 1,
        failedRuns: 1,
        fileCount: 2,
        latestRunId: 'run-1',
        latestRunStatus: 'failed',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('kbStateSnapshot builds empty and populated snapshots', async () => {
    const counters: KbCounters = {
      rawTotal: 1,
      rawByStatus: { ingesting: 0, ingested: 1, digesting: 0, digested: 0, failed: 0, 'pending-delete': 0 },
      failedByStage: { conversion: 0, digestion: 0, unknown: 0 },
      entryCount: 0,
      pendingCount: 1,
      folderCount: 1,
      documentCount: 1,
      documentNodeCount: 0,
      entrySourceCount: 0,
      topicCount: 0,
      connectionCount: 0,
      reflectionCount: 0,
      staleReflectionCount: 0,
    };
    const db = {
      getDigestSession: () => null,
      getSynthesisSnapshot: () => ({
        status: 'idle',
        dreamProgress: null,
        needsSynthesisCount: 0,
      }),
      getCounters: () => counters,
      listFolders: () => [{ folderPath: '', name: 'Root', parentPath: null, rawCount: 1, pendingCount: 1, failedCount: 0 }],
      listRawInFolder: (folderPath: string, opts: { limit?: number; offset?: number }) => [{ rawId: 'raw-1', folderPath, opts }],
      listEntryIds: () => [],
      listTopicIds: () => [],
    };
    const service = new KbStateSnapshotService({
      getKbVectorStore: async () => {
        throw new Error('vector store should not be read without embedding config');
      },
    });

    expect(service.emptySnapshot(false).counters.rawTotal).toBe(0);
    const snapshot = await service.buildSnapshot('workspace-1', db as any, {
      folderPath: '/docs',
      limit: 10,
      offset: 5,
    }, {
      autoDigest: true,
    });

    expect(snapshot).toMatchObject({
      autoDigest: true,
      counters: { rawTotal: 1, embeddingConfigured: false },
      raw: [{ rawId: 'raw-1', folderPath: 'docs', opts: { limit: 10, offset: 5 } }],
    });
  });

  test('workspaceMemoryService manages notes, search, and pointer text', async () => {
    const root = tmpDir('workspace-memory-service-');
    try {
      const store = new WorkspaceMemoryStore({
        getWorkspaceDir: () => root,
      });
      const service = new WorkspaceMemoryService({
        store,
        parseMemoryFrontmatter,
        getWorkspaceMemoryEnabled: async () => true,
        log: { info: jest.fn(), warn: jest.fn() },
      });
      const relPath = await service.addMemoryNoteEntry('workspace-1', {
        content: `---
name: prefers_typescript
description: user prefers TypeScript examples
type: user
---

Use TypeScript examples.
`,
        source: 'memory-note',
        filenameHint: 'prefers typescript',
      });

      const snapshot = await service.getWorkspaceMemory('workspace-1');
      expect(snapshot?.files[0]).toMatchObject({
        filename: relPath,
        source: 'memory-note',
        type: 'user',
      });
      expect(await service.searchWorkspaceMemory('workspace-1', { query: 'typescript' }))
        .toEqual([expect.objectContaining({ filename: relPath, status: 'active' })]);
      expect(await service.getWorkspaceMemoryPointer('workspace-1'))
        .toContain(path.join(root, 'memory', 'files'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('legacyMigrations backfills server-configured CLI profile IDs', async () => {
    const root = tmpDir('legacy-migrations-');
    try {
      const workspacesDir = path.join(root, 'workspaces');
      const workspaceDir = path.join(workspacesDir, 'workspace-1');
      await fsp.mkdir(workspaceDir, { recursive: true });
      const indexPath = path.join(workspaceDir, 'index.json');
      const index: WorkspaceIndex = {
        workspaceId: 'workspace-1',
        workspacePath: '/tmp/workspace',
        conversations: [{
          id: 'conv-1',
          title: 'Legacy',
          backend: 'claude-code',
          currentSessionId: 's1',
          lastActivity: '2026-01-01T00:00:00.000Z',
          lastMessage: null,
          sessions: [],
        }],
      };
      await fsp.writeFile(indexPath, JSON.stringify(index, null, 2));
      const ensured: string[] = [];

      const migrations = new LegacyMigrations({
        workspacesDir,
        legacyConversationsDir: path.join(root, 'conversations'),
        legacyArchivesDir: path.join(root, 'archives'),
        defaultWorkspace: '/tmp/default',
        workspaceHash: () => 'workspace-1',
        newId: () => 'new-id',
        readWorkspaceIndex: async (hash) => JSON.parse(await fsp.readFile(path.join(workspacesDir, hash, 'index.json'), 'utf8')),
        writeWorkspaceIndex: async (hash, next) => {
          await fsp.writeFile(path.join(workspacesDir, hash, 'index.json'), JSON.stringify(next, null, 2));
        },
        writeSessionFile: jest.fn(),
        ensureServerConfiguredCliProfiles: async (harnesses) => {
          ensured.push(...[...harnesses].filter((item): item is string => typeof item === 'string'));
        },
        log: { info: jest.fn(), error: jest.fn() },
      });

      await migrations.migrateCliProfiles();

      const next = JSON.parse(await fsp.readFile(indexPath, 'utf8')) as WorkspaceIndex;
      expect(next.conversations[0].cliProfileId).toBe(serverConfiguredCliProfileId('claude-code'));
      expect(ensured).toEqual(['claude-code']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('worktreeIsolationToggle enables worktree isolation and advances sessions', async () => {
    const writes: Record<string, SessionFile> = {};
    const index: WorkspaceIndex = {
      workspaceId: 'workspace-1',
      workspacePath: '/repo/workspace',
      conversations: [{
        id: 'conv-1',
        title: 'Worktree',
        backend: 'claude-code',
        currentSessionId: 's1',
        lastActivity: '2026-01-01T00:00:00.000Z',
        lastMessage: 'previous',
        sessions: [{
          number: 1,
          sessionId: 's1',
          summary: null,
          active: true,
          messageCount: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: null,
        }],
      }],
    };
    const worktreeIsolation = {
      buildSettings: async () => ({
        enabled: true,
        repoRoot: '/repo',
        workspaceRelPath: 'workspace',
        remoteName: 'origin',
        baseBranch: 'main',
        remoteBaseRef: 'origin/main',
        worktreeBaseDir: '/worktrees',
        enabledAt: '2026-01-01T00:00:00.000Z',
      }),
      assertBaseReady: jest.fn(),
      branchName: (_convId: string, sessionNumber: number) => `ac/conv/session-${sessionNumber}`,
      createConversationWorktree: async (_settings: unknown, conversationId: string, branchName: string) => ({
        mode: 'worktree',
        worktreeRoot: `/worktrees/${conversationId}`,
        executionDir: `/worktrees/${conversationId}/workspace`,
        currentBranch: branchName,
      }),
      removeConversationWorktree: jest.fn(),
    };
    const writeWorkspaceIndex = jest.fn();

    await enableWorktreeIsolation({
      worktreeIsolation: worktreeIsolation as any,
      readSessionFile: async () => ({
        sessionNumber: 1,
        sessionId: 's1',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: null,
        messages: [message('user', 'Hello', '2026-01-01T00:00:00.000Z')],
      }),
      writeSessionFile: async (_hash, _convId, sessionNumber, data) => {
        writes[String(sessionNumber)] = data;
      },
      writeWorkspaceIndex,
      newId: () => 's2',
    }, 'workspace-1', index);

    expect(index.worktreeIsolation?.enabled).toBe(true);
    expect(index.conversations[0].checkout).toMatchObject({
      mode: 'worktree',
      worktreeRoot: '/worktrees/conv-1',
    });
    expect(index.conversations[0].sessions[1]).toMatchObject({
      number: 2,
      active: true,
      branchName: 'ac/conv/session-2',
      baseRef: 'origin/main',
    });
    expect(writes['1'].endedAt).toBeDefined();
    expect(writes['2'].messages).toEqual([]);
    expect(writeWorkspaceIndex).toHaveBeenCalledWith('workspace-1', index);
  });
});
