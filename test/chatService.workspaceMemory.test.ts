/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ChatService } from '../src/services/chatService';
import { workspaceHash } from './helpers/workspace';
import { BackendRegistry } from '../src/services/backends/registry';
import { BaseBackendAdapter } from '../src/services/backends/base';
import type { BackendMetadata, SendMessageResult, Message, MemorySnapshot } from '../src/types';

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
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('workspace memory', () => {
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

    const memDir = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'memory');
    expect(fs.existsSync(path.join(memDir, 'snapshot.json'))).toBe(true);
    expect(fs.existsSync(path.join(memDir, 'files', 'claude', 'MEMORY.md'))).toBe(true);
    expect(fs.existsSync(path.join(memDir, 'files', 'claude', 'feedback_testing.md'))).toBe(true);
    expect(fs.existsSync(path.join(memDir, 'files', 'claude', 'user_role.md'))).toBe(true);

    const stored = JSON.parse(fs.readFileSync(path.join(memDir, 'snapshot.json'), 'utf8'));
    expect(stored.files).toHaveLength(2);
    expect(stored.files[0].filename).toBe('claude/feedback_testing.md');
    expect(stored.files[0].source).toBe('cli-capture');
    expect(stored.sourceBackend).toBe('claude-code');

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
