/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ChatService } from '../src/services/chatService';
import { workspaceHash } from './helpers/workspace';
import { BackendRegistry } from '../src/services/backends/registry';
import { BaseBackendAdapter } from '../src/services/backends/base';
import type { BackendMetadata, SendMessageResult, Message, MemoryMetadataIndex, MemorySnapshot } from '../src/types';

const DEFAULT_WORKSPACE = '/tmp/test-workspace';
const TEST_RESUME_CAPABILITIES: BackendMetadata['resumeCapabilities'] = {
  activeTurnResume: 'unsupported',
  activeTurnResumeReason: 'Test adapter does not support active turn reattach.',
  sessionResume: 'unsupported',
  sessionResumeReason: 'Test adapter does not model session resume.',
};

let tmpDir: string;
let service: ChatService;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatservice-'));
  service = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE });
  await service.initialize();
  await service.saveSettings({
    ...(await service.getSettings()),
    defaultBackend: 'claude-code',
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('workspace memory', () => {
  function memoryDir(hash: string): string {
    return path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'memory');
  }

  function readMemoryState(hash: string): MemoryMetadataIndex {
    return JSON.parse(fs.readFileSync(path.join(memoryDir(hash), 'state.json'), 'utf8'));
  }

  function writeMemoryState(hash: string, state: MemoryMetadataIndex): void {
    fs.writeFileSync(path.join(memoryDir(hash), 'state.json'), JSON.stringify(state, null, 2));
  }

  function makeSnapshot(): MemorySnapshot {
    return {
      capturedAt: '2026-04-07T12:00:00Z',
      sourceBackend: 'claude-code',
      sourcePath: '/fake/source',
      index: '- [Testing](feedback_testing.md) — use real DB\n',
      files: [
        {
          filename: 'feedback_testing.md',
          name: 'testing-preferences',
          description: 'use real DB not mocks',
          type: 'feedback',
          content: `---
name: testing-preferences
description: use real DB not mocks
type: feedback
---

Integration tests must use real DB.
`,
        },
        {
          filename: 'user_role.md',
          name: 'user-role',
          description: 'senior backend engineer',
          type: 'user',
          content: `---
name: user-role
description: senior backend engineer
type: user
---

Backend engineer with deep Go experience.
`,
        },
      ],
    };
  }

  test('saveWorkspaceMemory writes snapshot.json and raw files under claude/', async () => {
    const conv = await service.createConversation('Mem Test', '/tmp/mem-save');
    const hash = workspaceHash('/tmp/mem-save');
    const snapshot = makeSnapshot();

    await service.saveWorkspaceMemory(hash, snapshot);

    const memDir = memoryDir(hash);
    expect(fs.existsSync(path.join(memDir, 'snapshot.json'))).toBe(true);
    expect(fs.existsSync(path.join(memDir, 'state.json'))).toBe(true);
    expect(fs.existsSync(path.join(memDir, 'files', 'claude', 'MEMORY.md'))).toBe(true);
    expect(fs.existsSync(path.join(memDir, 'files', 'claude', 'feedback_testing.md'))).toBe(true);
    expect(fs.existsSync(path.join(memDir, 'files', 'claude', 'user_role.md'))).toBe(true);

    const stored = JSON.parse(fs.readFileSync(path.join(memDir, 'snapshot.json'), 'utf8'));
    expect(stored.files).toHaveLength(2);
    expect(stored.files[0].filename).toBe('claude/feedback_testing.md');
    expect(stored.files[0].source).toBe('cli-capture');
    expect(stored.files[0].metadata).toMatchObject({
      filename: 'claude/feedback_testing.md',
      status: 'active',
      scope: 'workspace',
      source: 'cli-capture',
    });
    expect(stored.sourceBackend).toBe('claude-code');

    const state = readMemoryState(hash);
    expect(Object.keys(state.entries).sort()).toEqual([
      'claude/feedback_testing.md',
      'claude/user_role.md',
    ]);
    expect(state.entries['claude/feedback_testing.md']).toMatchObject({
      entryId: expect.stringMatching(/^mem_[a-f0-9]{16}$/),
      status: 'active',
      scope: 'workspace',
    });

    // Silence unused-variable warning.
    expect(conv.id).toBeDefined();
  });

  test('saveWorkspaceMemory replaces only the claude subtree on re-capture', async () => {
    await service.createConversation('Mem Replace', '/tmp/mem-replace');
    const hash = workspaceHash('/tmp/mem-replace');

    await service.saveWorkspaceMemory(hash, makeSnapshot());

    const smaller: MemorySnapshot = {
      ...makeSnapshot(),
      index: '',
      files: [makeSnapshot().files[0]],
    };
    await service.saveWorkspaceMemory(hash, smaller);

    const claudeDir = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'memory', 'files', 'claude');
    const files = fs.readdirSync(claudeDir);
    expect(files).toEqual(['feedback_testing.md']);

    const state = readMemoryState(hash);
    expect(Object.keys(state.entries)).toEqual(['claude/feedback_testing.md']);
  });

  test('saveWorkspaceMemory preserves notes across re-captures', async () => {
    await service.createConversation('Mem Notes', '/tmp/mem-notes');
    const hash = workspaceHash('/tmp/mem-notes');

    // First add a note.
    await service.addMemoryNoteEntry(hash, {
      content: `---
name: test-note
description: a sticky note
type: project
---

Body.
`,
      source: 'memory-note',
      filenameHint: 'sticky',
    });

    // Then do a Claude capture — the note should still be there.
    await service.saveWorkspaceMemory(hash, makeSnapshot());

    const loaded = await service.getWorkspaceMemory(hash);
    expect(loaded).not.toBeNull();
    const filenames = (loaded!.files || []).map((f) => f.filename);
    expect(filenames.some((f) => f.startsWith('claude/'))).toBe(true);
    expect(filenames.some((f) => f.startsWith('notes/'))).toBe(true);

    const note = loaded!.files.find((f) => f.filename.startsWith('notes/'));
    expect(note?.metadata).toMatchObject({
      filename: note!.filename,
      status: 'active',
      scope: 'workspace',
      source: 'memory-note',
    });
  });

  test('saveWorkspaceMemory preserves sidecar metadata for filenames that still exist', async () => {
    await service.createConversation('Mem Preserve Metadata', '/tmp/mem-preserve-meta');
    const hash = workspaceHash('/tmp/mem-preserve-meta');

    await service.saveWorkspaceMemory(hash, makeSnapshot());
    const state = readMemoryState(hash);
    state.entries['claude/feedback_testing.md'] = {
      ...state.entries['claude/feedback_testing.md'],
      status: 'superseded',
      scope: 'user',
      supersededBy: 'mem_newer',
      updatedAt: '2026-04-08T00:00:00Z',
    };
    fs.writeFileSync(path.join(memoryDir(hash), 'state.json'), JSON.stringify(state, null, 2));

    await service.saveWorkspaceMemory(hash, makeSnapshot());

    const next = readMemoryState(hash);
    expect(next.entries['claude/feedback_testing.md']).toMatchObject({
      status: 'superseded',
      scope: 'user',
      supersededBy: 'mem_newer',
      updatedAt: '2026-04-08T00:00:00Z',
    });
    const loaded = await service.getWorkspaceMemory(hash);
    expect(loaded!.files.find((f) => f.filename === 'claude/feedback_testing.md')?.metadata).toMatchObject({
      status: 'superseded',
      scope: 'user',
      supersededBy: 'mem_newer',
    });
  });

  test('addMemoryNoteEntry writes to notes/ and refreshes snapshot', async () => {
    await service.createConversation('Mem Note Add', '/tmp/mem-note-add');
    const hash = workspaceHash('/tmp/mem-note-add');

    const relPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: new-fact
description: something new
type: user
---

New fact body.
`,
      source: 'memory-note',
      filenameHint: 'new-fact',
    });
    expect(relPath.startsWith('notes/')).toBe(true);

    const snapshot = await service.getWorkspaceMemory(hash);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.files.length).toBe(1);
    expect(snapshot!.files[0].filename).toBe(relPath);
    expect(snapshot!.files[0].source).toBe('memory-note');
    expect(snapshot!.files[0].type).toBe('user');
    expect(snapshot!.files[0].metadata).toMatchObject({
      filename: relPath,
      status: 'active',
      scope: 'workspace',
      source: 'memory-note',
    });

    const state = readMemoryState(hash);
    expect(Object.keys(state.entries)).toEqual([relPath]);
  });

  test('replaceMemoryNoteEntry rewrites only notes entries and refreshes snapshot', async () => {
    await service.createConversation('Mem Note Replace', '/tmp/mem-note-replace');
    const hash = workspaceHash('/tmp/mem-note-replace');

    const relPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: replace_me
description: before
type: project
---

Old body.
`,
      source: 'memory-note',
      filenameHint: 'replace-me',
    });

    const replaced = await service.replaceMemoryNoteEntry(hash, relPath, `---
name: replace_me
description: after
type: project
---

New body.
`);

    expect(replaced).toBe(true);
    const snapshot = await service.getWorkspaceMemory(hash);
    const file = snapshot!.files.find((item) => item.filename === relPath);
    expect(file?.description).toBe('after');
    expect(file?.content).toContain('New body.');

    await expect(service.replaceMemoryNoteEntry(hash, 'claude/source.md', 'Body')).rejects.toThrow(/Only notes/);
    await expect(service.replaceMemoryNoteEntry(hash, 'notes/../claude/source.md', 'Body')).rejects.toThrow(/Path traversal/);
  });

  test('restoreMemoryEntry unsupersedes an entry and unlinks replacement metadata', async () => {
    await service.createConversation('Mem Restore', '/tmp/mem-restore');
    const hash = workspaceHash('/tmp/mem-restore');

    const oldPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: old_pref
description: old preference
type: user
---

Old preference.
`,
      source: 'memory-note',
      filenameHint: 'old-pref',
    });
    const newPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: new_pref
description: new preference
type: user
---

New preference.
`,
      source: 'memory-note',
      filenameHint: 'new-pref',
    });
    const state = readMemoryState(hash);
    const oldEntryId = state.entries[oldPath].entryId;
    const newEntryId = state.entries[newPath].entryId;
    await service.patchMemoryEntryMetadata(hash, [
      { filename: oldPath, patch: { status: 'superseded', supersededBy: newEntryId } },
      { filename: newPath, patch: { supersedes: [oldEntryId] } },
    ]);

    const restored = await service.restoreMemoryEntry(hash, oldPath);

    expect(restored).toMatchObject({ filename: oldPath, status: 'active' });
    const nextState = readMemoryState(hash);
    expect(nextState.entries[oldPath].status).toBe('active');
    expect(nextState.entries[oldPath].supersededBy).toBeUndefined();
    expect(nextState.entries[newPath].supersedes).toBeUndefined();
    await expect(service.restoreMemoryEntry(hash, newPath)).rejects.toThrow(/Only superseded/);
  });

  test('patchMemoryEntryMetadata updates sidecar state and refreshed snapshot metadata', async () => {
    await service.createConversation('Mem Metadata Patch', '/tmp/mem-meta-patch');
    const hash = workspaceHash('/tmp/mem-meta-patch');

    const relPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: patch-me
description: patch me
type: user
---

Body.
`,
      source: 'memory-note',
      filenameHint: 'patch-me',
    });

    const patched = await service.patchMemoryEntryMetadata(hash, [{
      filename: relPath,
      patch: {
        status: 'redacted',
        sourceConversationId: 'conv-meta-patch',
        redaction: [{ kind: 'api_token', reason: 'API tokens must not be written to memory.' }],
      },
    }]);

    expect(patched).toHaveLength(1);
    expect(patched[0]).toMatchObject({
      filename: relPath,
      status: 'redacted',
      sourceConversationId: 'conv-meta-patch',
      redaction: [{ kind: 'api_token', reason: 'API tokens must not be written to memory.' }],
    });

    const state = readMemoryState(hash);
    expect(state.entries[relPath]).toMatchObject({
      status: 'redacted',
      sourceConversationId: 'conv-meta-patch',
    });

    const snapshot = await service.getWorkspaceMemory(hash);
    expect(snapshot?.files.find((file) => file.filename === relPath)?.metadata).toMatchObject({
      status: 'redacted',
      sourceConversationId: 'conv-meta-patch',
      redaction: [{ kind: 'api_token', reason: 'API tokens must not be written to memory.' }],
    });
  });

  test('saveMemoryConsolidationAudit writes an append-only audit file', async () => {
    await service.createConversation('Mem Audit', '/tmp/mem-audit');
    const hash = workspaceHash('/tmp/mem-audit');

    const auditPath = await service.saveMemoryConsolidationAudit(hash, {
      createdAt: '2026-04-07T12:00:00.000Z',
      summary: 'Applied one safe supersession.',
      applied: [{
        action: 'mark_superseded',
        filename: 'notes/old.md',
        supersededBy: 'notes/new.md',
        reason: 'New memory replaces old memory.',
      }],
      skipped: [{
        action: {
          action: 'normalize_candidate',
          filename: 'notes/new.md',
          reason: 'Title could be clearer.',
        },
        reason: 'Advisory item.',
      }],
    });

    expect(auditPath).toBe('audits/consolidation_2026-04-07T12-00-00-000Z.json');
    const audit = JSON.parse(fs.readFileSync(path.join(memoryDir(hash), auditPath), 'utf8'));
    expect(audit).toEqual({
      version: 1,
      createdAt: '2026-04-07T12:00:00.000Z',
      summary: 'Applied one safe supersession.',
      applied: [{
        action: 'mark_superseded',
        filename: 'notes/old.md',
        supersededBy: 'notes/new.md',
        reason: 'New memory replaces old memory.',
      }],
      skipped: [{
        action: {
          action: 'normalize_candidate',
          filename: 'notes/new.md',
          reason: 'Title could be clearer.',
        },
        reason: 'Advisory item.',
      }],
    });
  });

  test('searchWorkspaceMemory returns lexical matches and excludes superseded entries by default', async () => {
    await service.createConversation('Mem Search', '/tmp/mem-search');
    const hash = workspaceHash('/tmp/mem-search');

    const typescriptPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: prefers_typescript
description: user prefers TypeScript examples
type: user
---

Use TypeScript examples when the user asks for frontend code.
`,
      source: 'memory-note',
      filenameHint: 'prefers-typescript',
    });
    const projectPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: launch_deadline
description: launch deadline and rollout plan
type: project
---

The launch deadline is Friday and the rollout plan needs screenshots.
`,
      source: 'memory-note',
      filenameHint: 'launch-deadline',
    });
    await service.addMemoryNoteEntry(hash, {
      content: `---
name: old_typescript_memory
description: superseded TypeScript preference
type: user
---

Old TypeScript preference that should not be searched.
`,
      source: 'memory-note',
      filenameHint: 'old-typescript',
    });
    const state = readMemoryState(hash);
    const oldPath = Object.keys(state.entries).find((filename) => filename.includes('old-typescript'))!;
    await service.patchMemoryEntryMetadata(hash, [{
      filename: oldPath,
      patch: { status: 'superseded' },
    }]);

    const results = await service.searchWorkspaceMemory(hash, {
      query: 'typescript frontend preference',
      limit: 5,
    });

    expect(results.map((result) => result.filename)).toContain(typescriptPath);
    expect(results.map((result) => result.filename)).not.toContain(oldPath);
    expect(results.map((result) => result.filename)).not.toContain(projectPath);
    expect(results[0]).toMatchObject({
      filename: typescriptPath,
      type: 'user',
      status: 'active',
      snippet: expect.stringMatching(/TypeScript/i),
    });
  });

  test('searchWorkspaceMemory boosts exact and type matches and breaks score ties by recency', async () => {
    await service.createConversation('Mem Search Ranking', '/tmp/mem-search-ranking');
    const hash = workspaceHash('/tmp/mem-search-ranking');

    const densePath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: dense_fruit_note
description: dense fruit note
type: user
---

Apple apple apple apple apple apple apple apple apple.
`,
      source: 'memory-note',
      filenameHint: 'dense-fruit-note',
    });
    const exactPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: apple
description: direct title match
type: user
---

Keep this short.
`,
      source: 'memory-note',
      filenameHint: 'apple-exact',
    });

    const exactResults = await service.searchWorkspaceMemory(hash, {
      query: 'apple',
      limit: 2,
    });
    expect(exactResults.map((result) => result.filename)).toEqual([exactPath, densePath]);

    const userPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: roadmap
description: shared roadmap
type: user
---

Roadmap notes.
`,
      source: 'memory-note',
      filenameHint: 'roadmap-user',
    });
    const projectPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: roadmap
description: shared roadmap
type: project
---

Roadmap notes.
`,
      source: 'memory-note',
      filenameHint: 'roadmap-project',
    });

    const typeResults = await service.searchWorkspaceMemory(hash, {
      query: 'project roadmap',
      limit: 2,
    });
    expect(typeResults[0].filename).toBe(projectPath);
    expect(typeResults.map((result) => result.filename)).toContain(userPath);

    const olderTiePath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: tie_match
description: same tie match
type: feedback
---

Tie match content.
`,
      source: 'memory-note',
      filenameHint: 'tie-match-old',
    });
    const newerTiePath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: tie_match
description: same tie match
type: feedback
---

Tie match content.
`,
      source: 'memory-note',
      filenameHint: 'tie-match-new',
    });
    const state = readMemoryState(hash);
    state.entries[olderTiePath].updatedAt = '2026-01-01T00:00:00.000Z';
    state.entries[newerTiePath].updatedAt = '2026-02-01T00:00:00.000Z';
    writeMemoryState(hash, state);

    const tieResults = await service.searchWorkspaceMemory(hash, {
      query: 'tie match',
      types: ['feedback'],
      limit: 2,
    });
    expect(tieResults.map((result) => result.filename)).toEqual([newerTiePath, olderTiePath]);
  });

  test('deleteMemoryEntry removes a file and refreshes snapshot', async () => {
    await service.createConversation('Mem Delete', '/tmp/mem-delete');
    const hash = workspaceHash('/tmp/mem-delete');

    const relPath = await service.addMemoryNoteEntry(hash, {
      content: `---
name: to-delete
description: will be deleted
type: project
---

Body.
`,
      source: 'memory-note',
      filenameHint: 'to-delete',
    });

    const deleted = await service.deleteMemoryEntry(hash, relPath);
    expect(deleted).toBe(true);

    const snapshot = await service.getWorkspaceMemory(hash);
    expect(snapshot?.files.length || 0).toBe(0);

    const state = readMemoryState(hash);
    expect(state.entries).toEqual({});
  });

  test('deleteMemoryEntry rejects path traversal', async () => {
    await service.createConversation('Mem Traverse', '/tmp/mem-traverse');
    const hash = workspaceHash('/tmp/mem-traverse');

    await expect(
      service.deleteMemoryEntry(hash, '../../../etc/passwd'),
    ).rejects.toThrow(/traversal/i);
  });

  test('clearWorkspaceMemory wipes every entry across claude/ and notes/', async () => {
    await service.createConversation('Mem Clear', '/tmp/mem-clear');
    const hash = workspaceHash('/tmp/mem-clear');

    // Seed a CLI-capture snapshot with a claude/ entry and add a note entry.
    await service.saveWorkspaceMemory(hash, {
      capturedAt: new Date().toISOString(),
      sourceBackend: 'claude-code',
      sourcePath: null,
      index: '',
      files: [
        {
          filename: 'keep_me.md',
          name: 'keep-me',
          description: 'captured',
          type: 'project',
          content: '---\nname: keep-me\ndescription: captured\ntype: project\n---\n\nBody.',
        },
      ],
    });
    await service.addMemoryNoteEntry(hash, {
      content: '---\nname: note-one\ndescription: first\ntype: user\n---\n\nOne.',
      source: 'memory-note',
      filenameHint: 'note-one',
    });
    await service.addMemoryNoteEntry(hash, {
      content: '---\nname: note-two\ndescription: second\ntype: feedback\n---\n\nTwo.',
      source: 'session-extraction',
      filenameHint: 'note-two',
    });

    const beforeClear = await service.getWorkspaceMemory(hash);
    expect(beforeClear?.files.length).toBe(3);

    const deleted = await service.clearWorkspaceMemory(hash);
    expect(deleted).toBe(3);

    const afterClear = await service.getWorkspaceMemory(hash);
    expect(afterClear?.files.length || 0).toBe(0);

    const state = readMemoryState(hash);
    expect(state.entries).toEqual({});
  });

  test('clearWorkspaceMemory returns 0 and is a no-op when no entries exist', async () => {
    await service.createConversation('Mem Clear Empty', '/tmp/mem-clear-empty');
    const hash = workspaceHash('/tmp/mem-clear-empty');

    const deleted = await service.clearWorkspaceMemory(hash);
    expect(deleted).toBe(0);
  });

  test('clearWorkspaceMemory leaves the Memory-enabled flag untouched', async () => {
    await service.createConversation('Mem Clear Flag', '/tmp/mem-clear-flag');
    const hash = workspaceHash('/tmp/mem-clear-flag');

    await service.setWorkspaceMemoryEnabled(hash, true);
    await service.addMemoryNoteEntry(hash, {
      content: '---\nname: x\ndescription: x\ntype: user\n---\n\nX.',
      source: 'memory-note',
      filenameHint: 'x',
    });

    await service.clearWorkspaceMemory(hash);
    expect(await service.getWorkspaceMemoryEnabled(hash)).toBe(true);
  });

  test('getWorkspaceMemoryEnabled defaults to false and persists after set', async () => {
    await service.createConversation('Mem Toggle', '/tmp/mem-toggle');
    const hash = workspaceHash('/tmp/mem-toggle');

    expect(await service.getWorkspaceMemoryEnabled(hash)).toBe(false);

    const result = await service.setWorkspaceMemoryEnabled(hash, true);
    expect(result).toBe(true);
    expect(await service.getWorkspaceMemoryEnabled(hash)).toBe(true);
  });

  test('getWorkspaceMemory returns null when none stored', async () => {
    await service.createConversation('Mem None', '/tmp/mem-none');
    const hash = workspaceHash('/tmp/mem-none');
    expect(await service.getWorkspaceMemory(hash)).toBeNull();
  });

  test('getWorkspaceMemory returns the stored snapshot', async () => {
    await service.createConversation('Mem Get', '/tmp/mem-get');
    const hash = workspaceHash('/tmp/mem-get');
    const snapshot = makeSnapshot();
    await service.saveWorkspaceMemory(hash, snapshot);

    const loaded = await service.getWorkspaceMemory(hash);
    expect(loaded).not.toBeNull();
    expect(loaded!.files).toHaveLength(2);
    expect(loaded!.sourceBackend).toBe('claude-code');
    expect(loaded!.files[0].metadata?.status).toBe('active');
  });

  test('getWorkspaceMemory synthesizes active metadata for legacy snapshots without state', async () => {
    await service.createConversation('Mem Legacy Metadata', '/tmp/mem-legacy-meta');
    const hash = workspaceHash('/tmp/mem-legacy-meta');
    const memDir = memoryDir(hash);
    fs.mkdirSync(path.join(memDir, 'files', 'claude'), { recursive: true });
    fs.writeFileSync(path.join(memDir, 'snapshot.json'), JSON.stringify({
      capturedAt: '2026-04-07T12:00:00Z',
      sourceBackend: 'claude-code',
      sourcePath: null,
      index: '',
      files: [
        {
          filename: 'claude/legacy.md',
          name: 'legacy',
          description: 'legacy entry',
          type: 'project',
          content: '---\nname: legacy\ndescription: legacy entry\ntype: project\n---\n\nBody.',
          source: 'cli-capture',
        },
      ],
    }, null, 2));

    const loaded = await service.getWorkspaceMemory(hash);
    expect(loaded?.files[0].metadata).toMatchObject({
      filename: 'claude/legacy.md',
      status: 'active',
      scope: 'workspace',
      source: 'cli-capture',
    });
    expect(fs.existsSync(path.join(memDir, 'state.json'))).toBe(false);
  });

  test('captureWorkspaceMemory invokes adapter extractMemory and persists', async () => {
    const conv = await service.createConversation('Mem Capture', '/tmp/mem-cap');
    const hash = workspaceHash('/tmp/mem-cap');

    const snapshot = makeSnapshot();
    class StubAdapter extends BaseBackendAdapter {
      get metadata(): BackendMetadata {
        return {
          id: 'claude-code',
          label: 'Stub',
          icon: null,
          capabilities: {
            thinking: false, planMode: false, agents: false,
            toolActivity: false, userQuestions: false, stdinInput: false,
          },
          resumeCapabilities: TEST_RESUME_CAPABILITIES,
        };
      }
      sendMessage(_m: string): SendMessageResult {
        return {
          stream: (async function*() { yield { type: 'done' as const }; })(),
          abort: () => {},
          sendInput: () => {},
        };
      }
      async generateSummary(_msgs: Pick<Message, 'role' | 'content'>[], _fallback: string): Promise<string> {
        return 'summary';
      }
      async extractMemory(workspacePath: string): Promise<MemorySnapshot | null> {
        expect(workspacePath).toBe('/tmp/mem-cap');
        return snapshot;
      }
    }

    const registry = new BackendRegistry();
    registry.register(new StubAdapter());
    // Swap in the registry for this test.
    (service as any)._backendRegistry = registry;

    const result = await service.captureWorkspaceMemory(conv.id, 'claude-code');
    expect(result).not.toBeNull();
    expect(result!.files).toHaveLength(2);

    const loaded = await service.getWorkspaceMemory(hash);
    expect(loaded).not.toBeNull();
    expect(loaded!.files).toHaveLength(2);
  });

  test('captureWorkspaceMemory returns null when adapter has no memory', async () => {
    const conv = await service.createConversation('Mem NoMem', '/tmp/mem-nomem');

    class NoMemAdapter extends BaseBackendAdapter {
      get metadata(): BackendMetadata {
        return {
          id: 'claude-code',
          label: 'NoMem',
          icon: null,
          capabilities: {
            thinking: false, planMode: false, agents: false,
            toolActivity: false, userQuestions: false, stdinInput: false,
          },
          resumeCapabilities: TEST_RESUME_CAPABILITIES,
        };
      }
      sendMessage(_m: string): SendMessageResult {
        return {
          stream: (async function*() { yield { type: 'done' as const }; })(),
          abort: () => {},
          sendInput: () => {},
        };
      }
      async generateSummary(): Promise<string> { return 'ok'; }
    }

    const registry = new BackendRegistry();
    registry.register(new NoMemAdapter());
    (service as any)._backendRegistry = registry;

    const result = await service.captureWorkspaceMemory(conv.id, 'claude-code');
    expect(result).toBeNull();
  });

  test('captureWorkspaceMemory swallows extraction errors and returns null', async () => {
    const conv = await service.createConversation('Mem Err', '/tmp/mem-err');

    class BrokenAdapter extends BaseBackendAdapter {
      get metadata(): BackendMetadata {
        return {
          id: 'claude-code',
          label: 'Broken',
          icon: null,
          capabilities: {
            thinking: false, planMode: false, agents: false,
            toolActivity: false, userQuestions: false, stdinInput: false,
          },
          resumeCapabilities: TEST_RESUME_CAPABILITIES,
        };
      }
      sendMessage(_m: string): SendMessageResult {
        return {
          stream: (async function*() { yield { type: 'done' as const }; })(),
          abort: () => {},
          sendInput: () => {},
        };
      }
      async generateSummary(): Promise<string> { return 'ok'; }
      async extractMemory(): Promise<MemorySnapshot | null> {
        throw new Error('boom');
      }
    }

    const registry = new BackendRegistry();
    registry.register(new BrokenAdapter());
    (service as any)._backendRegistry = registry;

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await service.captureWorkspaceMemory(conv.id, 'claude-code');
    expect(result).toBeNull();
    errSpy.mockRestore();
  });
});

// ── Attachment + Queue Migration Helpers ───────────────────────────────────
