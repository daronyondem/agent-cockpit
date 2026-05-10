/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ChatService } from '../src/services/chatService';
import { workspaceHash } from './helpers/workspace';


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


describe('getWorkspaceContext', () => {
  test('returns injection prompt with workspace path', async () => {
    const conv = await service.createConversation('Test', '/tmp/ctx-test');
    const ctx = service.getWorkspaceContext(conv.id);
    expect(ctx).toContain('Workspace discussion history');
    const hash = workspaceHash('/tmp/ctx-test');
    expect(ctx).toContain(hash);
    expect(ctx).toContain('index.json');
  });

  test('returns null for non-existent conversation', () => {
    expect(service.getWorkspaceContext('nope')).toBeNull();
  });
});

// ── Workspace Memory Pointer ────────────────────────────────────────────────

describe('getWorkspaceMemoryPointer', () => {
  test('returns null when memory is disabled for the workspace', async () => {
    await service.createConversation('Test', '/tmp/mem-ptr-off');
    const hash = workspaceHash('/tmp/mem-ptr-off');
    // Default state is disabled.
    const pointer = await service.getWorkspaceMemoryPointer(hash);
    expect(pointer).toBeNull();
  });

  test('returns pointer text with the absolute memory files dir when enabled', async () => {
    await service.createConversation('Test', '/tmp/mem-ptr-on');
    const hash = workspaceHash('/tmp/mem-ptr-on');
    await service.setWorkspaceMemoryEnabled(hash, true);

    const pointer = await service.getWorkspaceMemoryPointer(hash);
    expect(pointer).not.toBeNull();
    expect(pointer).toContain('Workspace memory is available at');
    expect(pointer).toContain(hash);
    expect(pointer).toContain('memory/files/');
    // The pointer should be a self-contained bracketed block.
    expect(pointer!.startsWith('[')).toBe(true);
    expect(pointer!.endsWith(']')).toBe(true);
  });

  test('creates memory/files/ on disk so the model never hits ENOENT', async () => {
    await service.createConversation('Test', '/tmp/mem-ptr-mkdir');
    const hash = workspaceHash('/tmp/mem-ptr-mkdir');
    await service.setWorkspaceMemoryEnabled(hash, true);

    const filesDir = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'memory', 'files');
    expect(fs.existsSync(filesDir)).toBe(false);

    await service.getWorkspaceMemoryPointer(hash);
    expect(fs.existsSync(filesDir)).toBe(true);
  });

  test('returns null when hash is empty', async () => {
    expect(await service.getWorkspaceMemoryPointer('')).toBeNull();
  });
});

// ── Workspace Knowledge Base ────────────────────────────────────────────────

describe('getWorkspaceKbEnabled / setWorkspaceKbEnabled', () => {
  test('defaults to false and persists after set', async () => {
    await service.createConversation('KB Toggle', '/tmp/kb-toggle');
    const hash = workspaceHash('/tmp/kb-toggle');

    expect(await service.getWorkspaceKbEnabled(hash)).toBe(false);

    const result = await service.setWorkspaceKbEnabled(hash, true);
    expect(result).toBe(true);
    expect(await service.getWorkspaceKbEnabled(hash)).toBe(true);
  });

  test('setWorkspaceKbEnabled returns null for unknown workspace', async () => {
    expect(await service.setWorkspaceKbEnabled('nopehash', true)).toBeNull();
  });

  test('enable/disable is independent of memoryEnabled', async () => {
    await service.createConversation('KB/Mem Split', '/tmp/kb-mem-split');
    const hash = workspaceHash('/tmp/kb-mem-split');
    await service.setWorkspaceMemoryEnabled(hash, true);
    await service.setWorkspaceKbEnabled(hash, false);
    expect(await service.getWorkspaceMemoryEnabled(hash)).toBe(true);
    expect(await service.getWorkspaceKbEnabled(hash)).toBe(false);

    await service.setWorkspaceKbEnabled(hash, true);
    await service.setWorkspaceMemoryEnabled(hash, false);
    expect(await service.getWorkspaceMemoryEnabled(hash)).toBe(false);
    expect(await service.getWorkspaceKbEnabled(hash)).toBe(true);
  });
});

// ── Workspace Context Map ──────────────────────────────────────────────────

describe('getWorkspaceContextMapEnabled / setWorkspaceContextMapEnabled', () => {
  test('defaults to false and persists after set', async () => {
    await service.createConversation('Context Map Toggle', '/tmp/context-map-toggle');
    const hash = workspaceHash('/tmp/context-map-toggle');

    expect(await service.getWorkspaceContextMapEnabled(hash)).toBe(false);

    const result = await service.setWorkspaceContextMapEnabled(hash, true);
    expect(result).toBe(true);
    expect(await service.getWorkspaceContextMapEnabled(hash)).toBe(true);
  });

  test('setWorkspaceContextMapEnabled returns null for unknown workspace', async () => {
    expect(await service.setWorkspaceContextMapEnabled('nopehash', true)).toBeNull();
  });

  test('enable/disable is independent of memoryEnabled and kbEnabled', async () => {
    await service.createConversation('Context Map Split', '/tmp/context-map-split');
    const hash = workspaceHash('/tmp/context-map-split');
    await service.setWorkspaceMemoryEnabled(hash, true);
    await service.setWorkspaceKbEnabled(hash, true);
    await service.setWorkspaceContextMapEnabled(hash, false);

    expect(await service.getWorkspaceMemoryEnabled(hash)).toBe(true);
    expect(await service.getWorkspaceKbEnabled(hash)).toBe(true);
    expect(await service.getWorkspaceContextMapEnabled(hash)).toBe(false);

    await service.setWorkspaceContextMapEnabled(hash, true);
    await service.setWorkspaceMemoryEnabled(hash, false);
    await service.setWorkspaceKbEnabled(hash, false);

    expect(await service.getWorkspaceMemoryEnabled(hash)).toBe(false);
    expect(await service.getWorkspaceKbEnabled(hash)).toBe(false);
    expect(await service.getWorkspaceContextMapEnabled(hash)).toBe(true);
  });

  test('lists only Context Map enabled workspaces', async () => {
    await service.createConversation('Context Map Enabled', '/tmp/context-map-enabled');
    await service.createConversation('Context Map Disabled', '/tmp/context-map-disabled');
    const enabledHash = workspaceHash('/tmp/context-map-enabled');
    const disabledHash = workspaceHash('/tmp/context-map-disabled');

    await service.setWorkspaceContextMapEnabled(enabledHash, true);

    expect(await service.listContextMapEnabledWorkspaceHashes()).toEqual([enabledHash]);
    expect(await service.getWorkspaceContextMapEnabled(disabledHash)).toBe(false);
  });
});

describe('getWorkspaceContextMapSettings / setWorkspaceContextMapSettings', () => {
  test('returns global-mode defaults for a workspace with no override', async () => {
    await service.createConversation('Context Map Defaults', '/tmp/context-map-defaults');
    const hash = workspaceHash('/tmp/context-map-defaults');

    expect(await service.getWorkspaceContextMapSettings(hash)).toEqual({ processorMode: 'global' });
  });

  test('returns null for unknown workspace', async () => {
    expect(await service.getWorkspaceContextMapSettings('nopehash')).toBeNull();
    expect(await service.setWorkspaceContextMapSettings('nopehash', { processorMode: 'global' })).toBeNull();
  });

  test('persists a normalized workspace override', async () => {
    await service.createConversation('Context Map Settings', '/tmp/context-map-settings');
    const hash = workspaceHash('/tmp/context-map-settings');
    const settings = await service.getSettings();
    const profile = {
      id: 'profile-codex-context',
      name: 'Codex Context',
      vendor: 'codex',
      authMode: 'account',
      configDir: '/tmp/codex-context',
      createdAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T00:00:00.000Z',
    };
    await service.saveSettings({
      ...settings,
      cliProfiles: [...(settings.cliProfiles || []), profile],
    } as any);

    const saved = await service.setWorkspaceContextMapSettings(hash, {
      processorMode: 'override',
      cliProfileId: profile.id,
      cliBackend: 'claude-code',
      cliModel: 'gpt-5.4',
      cliEffort: 'high',
      scanIntervalMinutes: 0,
      sources: {
        conversations: true,
        memory: false,
        git: 'yes',
      },
    } as any);

    expect(saved).toEqual({
      processorMode: 'override',
      cliProfileId: profile.id,
      cliBackend: 'codex',
      cliModel: 'gpt-5.4',
      cliEffort: 'high',
      scanIntervalMinutes: 1,
    });
    expect(await service.getWorkspaceContextMapSettings(hash)).toEqual(saved);
  });
});

describe('getKbStateSnapshot / getKbDb', () => {
  test('getKbStateSnapshot returns null for unknown workspace', async () => {
    expect(await service.getKbStateSnapshot('nopehash')).toBeNull();
  });

  test('getKbStateSnapshot returns empty in-memory snapshot when disabled (no DB on disk)', async () => {
    await service.createConversation('KB Snap Disabled', '/tmp/kb-snap-disabled');
    const hash = workspaceHash('/tmp/kb-snap-disabled');

    const state = await service.getKbStateSnapshot(hash);
    expect(state).not.toBeNull();
    expect(state!.version).toBe(1);
    expect(state!.raw).toEqual([]);
    expect(state!.folders).toEqual([]);
    expect(state!.counters.rawTotal).toBe(0);
    expect(state!.counters.embeddingConfigured).toBe(false);
    expect(state!.counters.entryEmbeddedCount).toBeNull();
    expect(state!.counters.topicEmbeddedCount).toBeNull();
    expect(state!.counters.embeddingIndexError).toBeNull();
    expect(state!.autoDigest).toBe(false);
    expect(state!.dreamingStatus).toBe('idle');
    expect(state!.dreamProgress).toBeNull();
    expect(state!.needsSynthesisCount).toBe(0);

    // Should NOT have written state.db to disk for a disabled workspace.
    const dbPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'knowledge', 'state.db');
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  test('getKbStateSnapshot opens DB and returns empty-but-initialized state when enabled', async () => {
    await service.createConversation('KB Snap Enabled', '/tmp/kb-snap-enabled');
    const hash = workspaceHash('/tmp/kb-snap-enabled');
    await service.setWorkspaceKbEnabled(hash, true);

    const state = await service.getKbStateSnapshot(hash);
    expect(state).not.toBeNull();
    expect(state!.version).toBe(1);
    expect(state!.entrySchemaVersion).toBe(1);
    // Root folder always exists after DB init.
    expect(state!.folders.some((f) => f.folderPath === '')).toBe(true);
    expect(state!.raw).toEqual([]);
    expect(state!.counters.embeddingConfigured).toBe(false);
    expect(state!.counters.entryEmbeddedCount).toBeNull();
    expect(state!.counters.topicEmbeddedCount).toBeNull();
    expect(state!.dreamingStatus).toBe('idle');
    expect(state!.dreamProgress).toBeNull();
    expect(state!.needsSynthesisCount).toBe(0);

    const dbPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'knowledge', 'state.db');
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  test('getKbStateSnapshot includes persisted dream progress', async () => {
    await service.createConversation('KB Snap Dream', '/tmp/kb-snap-dream');
    const hash = workspaceHash('/tmp/kb-snap-dream');
    await service.setWorkspaceKbEnabled(hash, true);
    const db = service.getKbDb(hash);
    expect(db).not.toBeNull();
    db!.setSynthesisMeta('status', 'running');
    db!.setSynthesisMeta('dream_progress', JSON.stringify({
      phase: 'reflection',
      done: 3,
      total: 9,
      startedAt: 100,
      phaseStartedAt: 200,
    }));

    const state = await service.getKbStateSnapshot(hash);

    expect(state!.dreamingStatus).toBe('running');
    expect(state!.dreamProgress).toEqual({
      phase: 'reflection',
      done: 3,
      total: 9,
      startedAt: 100,
      phaseStartedAt: 200,
    });
  });

  test('getKbStateSnapshot includes pending dream count', async () => {
    await service.createConversation('KB Snap Dream Pending', '/tmp/kb-snap-dream-pending');
    const hash = workspaceHash('/tmp/kb-snap-dream-pending');
    await service.setWorkspaceKbEnabled(hash, true);
    const db = service.getKbDb(hash)!;
    db.insertRaw({
      rawId: 'raw-dream-pending',
      sha256: 'sha-dream-pending',
      status: 'digested',
      byteLength: 10,
      mimeType: 'text/plain',
      handler: 'passthrough/text',
      uploadedAt: '2026-01-01T00:00:00Z',
      metadata: null,
    });
    db.insertEntry({
      entryId: 'entry-dream-pending',
      rawId: 'raw-dream-pending',
      title: 'Dream Pending',
      slug: 'dream-pending',
      summary: 'pending synthesis',
      schemaVersion: 1,
      digestedAt: '2026-01-01T00:00:00Z',
      tags: [],
    });

    const state = await service.getKbStateSnapshot(hash);

    expect(state!.needsSynthesisCount).toBe(1);
  });

  test('getKbStateSnapshot includes vector coverage counters when embeddings are configured', async () => {
    await service.createConversation('KB Snap Vectors', '/tmp/kb-snap-vectors');
    const hash = workspaceHash('/tmp/kb-snap-vectors');
    await service.setWorkspaceKbEnabled(hash, true);
    await service.setWorkspaceKbEmbeddingConfig(hash, {
      model: 'test-embed',
      ollamaHost: 'http://localhost:11434',
      dimensions: 123,
    });
    const db = service.getKbDb(hash)!;
    db.insertRaw({
      rawId: 'raw-vector',
      sha256: 'sha-vector',
      status: 'digested',
      byteLength: 10,
      mimeType: 'text/plain',
      handler: 'passthrough/text',
      uploadedAt: '2026-01-01T00:00:00Z',
      metadata: null,
    });
    db.insertEntry({
      entryId: 'entry-present',
      rawId: 'raw-vector',
      title: 'Present',
      slug: 'present',
      summary: 'present entry',
      schemaVersion: 1,
      digestedAt: '2026-01-01T00:00:00Z',
      tags: [],
    });
    db.upsertTopic({
      topicId: 'topic-present',
      title: 'Present Topic',
      summary: 'present topic',
      content: null,
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const store = {
      embeddedEntryIds: jest.fn().mockResolvedValue(new Set(['entry-present', 'entry-stale'])),
      embeddedTopicIds: jest.fn().mockResolvedValue(new Set(['topic-present', 'topic-stale'])),
    };
    const getStore = jest.spyOn(service, 'getKbVectorStore').mockResolvedValue(store as any);

    const state = await service.getKbStateSnapshot(hash);

    expect(getStore).toHaveBeenCalledWith(hash, 123);
    expect(state!.counters.embeddingConfigured).toBe(true);
    expect(state!.counters.entryEmbeddedCount).toBe(1);
    expect(state!.counters.topicEmbeddedCount).toBe(1);
    expect(state!.counters.embeddingIndexError).toBeNull();
  });

  test('getKbStateSnapshot keeps vector coverage failures non-fatal', async () => {
    await service.createConversation('KB Snap Vector Error', '/tmp/kb-snap-vector-error');
    const hash = workspaceHash('/tmp/kb-snap-vector-error');
    await service.setWorkspaceKbEnabled(hash, true);
    await service.setWorkspaceKbEmbeddingConfig(hash, {
      model: 'test-embed',
      ollamaHost: 'http://localhost:11434',
      dimensions: 123,
    });
    jest.spyOn(service, 'getKbVectorStore').mockRejectedValue(new Error('vector unavailable'));

    const state = await service.getKbStateSnapshot(hash);

    expect(state).not.toBeNull();
    expect(state!.counters.embeddingConfigured).toBe(true);
    expect(state!.counters.entryEmbeddedCount).toBeNull();
    expect(state!.counters.topicEmbeddedCount).toBeNull();
    expect(state!.counters.embeddingIndexError).toBe('vector unavailable');
  });

  test('getKbDb returns a usable KbDatabase and caches it', async () => {
    await service.createConversation('KB DB Cache', '/tmp/kb-db-cache');
    const hash = workspaceHash('/tmp/kb-db-cache');
    await service.setWorkspaceKbEnabled(hash, true);

    const db1 = service.getKbDb(hash);
    const db2 = service.getKbDb(hash);
    expect(db1).not.toBeNull();
    expect(db1).toBe(db2); // cached, same instance

    // The DB should expose folder/counters methods.
    const counters = db1!.getCounters();
    expect(counters.rawTotal).toBe(0);
    expect(counters.folderCount).toBeGreaterThanOrEqual(1);
  });

  test('getWorkspaceKbAutoDigest is false by default and toggles via setter', async () => {
    await service.createConversation('KB Auto Digest', '/tmp/kb-auto-digest');
    const hash = workspaceHash('/tmp/kb-auto-digest');
    expect(await service.getWorkspaceKbAutoDigest(hash)).toBe(false);
    await service.setWorkspaceKbAutoDigest(hash, true);
    expect(await service.getWorkspaceKbAutoDigest(hash)).toBe(true);
    // Unknown workspaces → null.
    expect(await service.setWorkspaceKbAutoDigest('nopehash', true)).toBeNull();
  });

  test('getWorkspaceKbAutoDream defaults to off and persists per workspace', async () => {
    await service.createConversation('KB Auto Dream', '/tmp/kb-auto-dream');
    const hash = workspaceHash('/tmp/kb-auto-dream');

    expect(await service.getWorkspaceKbAutoDream(hash)).toEqual({ mode: 'off' });

    const saved = await service.setWorkspaceKbAutoDream(hash, {
      mode: 'window',
      windowStart: '02:00',
      windowEnd: '06:00',
    });

    expect(saved).toEqual({ mode: 'window', windowStart: '02:00', windowEnd: '06:00' });
    expect(await service.getWorkspaceKbAutoDream(hash)).toEqual(saved);
    expect(await service.setWorkspaceKbAutoDream('nopehash', { mode: 'off' })).toBeNull();
  });

  test('listKbEnabledWorkspaceHashes returns only KB-enabled workspaces', async () => {
    await service.createConversation('KB Enabled A', '/tmp/kb-enabled-a');
    await service.createConversation('KB Disabled B', '/tmp/kb-disabled-b');
    const hashA = workspaceHash('/tmp/kb-enabled-a');
    const hashB = workspaceHash('/tmp/kb-disabled-b');

    await service.setWorkspaceKbEnabled(hashA, true);

    const hashes = await service.listKbEnabledWorkspaceHashes();
    expect(hashes).toContain(hashA);
    expect(hashes).not.toContain(hashB);
  });
});

describe('getWorkspaceKbPointer', () => {
  test('returns null when KB is disabled for the workspace', async () => {
    await service.createConversation('KB Ptr Off', '/tmp/kb-ptr-off');
    const hash = workspaceHash('/tmp/kb-ptr-off');
    expect(await service.getWorkspaceKbPointer(hash)).toBeNull();
  });

  test('returns pointer text with the knowledge dir when enabled', async () => {
    await service.createConversation('KB Ptr On', '/tmp/kb-ptr-on');
    const hash = workspaceHash('/tmp/kb-ptr-on');
    await service.setWorkspaceKbEnabled(hash, true);

    const pointer = await service.getWorkspaceKbPointer(hash);
    expect(pointer).not.toBeNull();
    expect(pointer).toContain('Workspace knowledge base is available at');
    expect(pointer).toContain(hash);
    expect(pointer).toContain('knowledge');
    expect(pointer).toContain('state.db');
    expect(pointer).toContain('entries/');
    expect(pointer!.startsWith('[')).toBe(true);
    expect(pointer!.endsWith(']')).toBe(true);
  });

  test('creates knowledge/entries/ on disk so the model never hits ENOENT', async () => {
    await service.createConversation('KB Ptr Mkdir', '/tmp/kb-ptr-mkdir');
    const hash = workspaceHash('/tmp/kb-ptr-mkdir');
    await service.setWorkspaceKbEnabled(hash, true);

    const entriesDir = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'knowledge', 'entries');
    expect(fs.existsSync(entriesDir)).toBe(false);

    await service.getWorkspaceKbPointer(hash);
    expect(fs.existsSync(entriesDir)).toBe(true);
  });

  test('returns null when hash is empty', async () => {
    expect(await service.getWorkspaceKbPointer('')).toBeNull();
  });
});

// ── Workspace Instructions ──────────────────────────────────────────────────

describe('getWorkspaceInstructions', () => {
  test('returns empty string for workspace with no instructions', async () => {
    await service.createConversation('Test', '/tmp/ws-inst');
    const hash = workspaceHash('/tmp/ws-inst');
    const instructions = await service.getWorkspaceInstructions(hash);
    expect(instructions).toBe('');
  });

  test('returns null for non-existent workspace', async () => {
    const instructions = await service.getWorkspaceInstructions('nonexistent');
    expect(instructions).toBeNull();
  });
});

describe('setWorkspaceInstructions', () => {
  test('saves and retrieves instructions', async () => {
    await service.createConversation('Test', '/tmp/ws-inst');
    const hash = workspaceHash('/tmp/ws-inst');
    await service.setWorkspaceInstructions(hash, 'Always use TypeScript');
    const instructions = await service.getWorkspaceInstructions(hash);
    expect(instructions).toBe('Always use TypeScript');
  });

  test('persists instructions to disk', async () => {
    await service.createConversation('Test', '/tmp/ws-persist');
    const hash = workspaceHash('/tmp/ws-persist');
    await service.setWorkspaceInstructions(hash, 'Use functional components');

    const indexPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    expect(index.instructions).toBe('Use functional components');
  });

  test('clears instructions when set to empty string', async () => {
    await service.createConversation('Test', '/tmp/ws-clear');
    const hash = workspaceHash('/tmp/ws-clear');
    await service.setWorkspaceInstructions(hash, 'Some instructions');
    await service.setWorkspaceInstructions(hash, '');
    const instructions = await service.getWorkspaceInstructions(hash);
    expect(instructions).toBe('');
  });

  test('returns null for non-existent workspace', async () => {
    const result = await service.setWorkspaceInstructions('nonexistent', 'test');
    expect(result).toBeNull();
  });
});

// ── Workspace Instruction Compatibility ────────────────────────────────────

describe('workspace instruction compatibility', () => {
  function makeWorkspace(name: string): { dir: string; hash: string } {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir, { recursive: true });
    return { dir, hash: workspaceHash(dir) };
  }

  test('does not notify when no vendor instruction files exist', async () => {
    const ws = makeWorkspace('instr-none');
    await service.createConversation('Test', ws.dir);

    const status = await service.getWorkspaceInstructionCompatibility(ws.hash);
    expect(status).not.toBeNull();
    expect(status!.hasAnyInstructions).toBe(false);
    expect(status!.compatible).toBe(true);
    expect(status!.shouldNotify).toBe(false);
  });

  test('notifies when AGENTS.md exists but vendor entrypoints are missing', async () => {
    const ws = makeWorkspace('instr-agents');
    fs.writeFileSync(path.join(ws.dir, 'AGENTS.md'), '# Agent Instructions\n');
    await service.createConversation('Test', ws.dir);

    const status = await service.getWorkspaceInstructionCompatibility(ws.hash);
    expect(status!.shouldNotify).toBe(true);
    expect(status!.primarySourceId).toBe('agents');
    expect(status!.missingVendors.map(item => item.vendor).sort()).toEqual(['claude-code', 'kiro']);
  });

  test('creates missing pointers from AGENTS.md without overwriting existing files', async () => {
    const ws = makeWorkspace('instr-create');
    fs.writeFileSync(path.join(ws.dir, 'AGENTS.md'), '# Agent Instructions\n');
    fs.writeFileSync(path.join(ws.dir, 'CLAUDE.md'), 'existing claude instructions\n');
    await service.createConversation('Test', ws.dir);

    const result = await service.createWorkspaceInstructionPointers(ws.hash);
    expect(result).not.toBeNull();
    expect(result!.created.map(item => item.path)).toEqual(['.kiro/steering/agents-md.md']);
    expect(fs.readFileSync(path.join(ws.dir, 'CLAUDE.md'), 'utf8')).toBe('existing claude instructions\n');
    expect(fs.readFileSync(path.join(ws.dir, '.kiro', 'steering', 'agents-md.md'), 'utf8')).toContain('#[[file:AGENTS.md]]');
    expect(result!.status.shouldNotify).toBe(false);
    expect(result!.status.compatible).toBe(true);
  });

  test('creates AGENTS.md first when only CLAUDE.md exists', async () => {
    const ws = makeWorkspace('instr-claude-only');
    fs.writeFileSync(path.join(ws.dir, 'CLAUDE.md'), '# Claude Instructions\n');
    await service.createConversation('Test', ws.dir);

    const result = await service.createWorkspaceInstructionPointers(ws.hash);
    expect(result).not.toBeNull();
    expect(result!.created.map(item => item.path)).toEqual(['AGENTS.md', '.kiro/steering/agents-md.md']);
    expect(fs.readFileSync(path.join(ws.dir, 'AGENTS.md'), 'utf8')).toContain('[CLAUDE.md](CLAUDE.md)');
    expect(fs.readFileSync(path.join(ws.dir, '.kiro', 'steering', 'agents-md.md'), 'utf8')).toContain('#[[file:AGENTS.md]]');
    expect(result!.status.shouldNotify).toBe(false);
  });

  test('dismisses only the current compatibility fingerprint', async () => {
    const ws = makeWorkspace('instr-dismiss');
    fs.writeFileSync(path.join(ws.dir, 'AGENTS.md'), '# Agent Instructions\n');
    await service.createConversation('Test', ws.dir);

    const dismissed = await service.dismissWorkspaceInstructionCompatibility(ws.hash);
    expect(dismissed!.dismissed).toBe(true);
    expect(dismissed!.shouldNotify).toBe(false);

    fs.mkdirSync(path.join(ws.dir, '.kiro', 'steering'), { recursive: true });
    fs.writeFileSync(path.join(ws.dir, '.kiro', 'steering', 'agents-md.md'), '#[[file:AGENTS.md]]\n');
    const changed = await service.getWorkspaceInstructionCompatibility(ws.hash);
    expect(changed!.dismissed).toBe(false);
    expect(changed!.shouldNotify).toBe(true);
    expect(changed!.missingVendors.map(item => item.vendor)).toEqual(['claude-code']);
  });
});

describe('getWorkspaceHashForConv', () => {
  test('returns hash for existing conversation', async () => {
    const conv = await service.createConversation('Test', '/tmp/hash-test');
    const hash = service.getWorkspaceHashForConv(conv.id);
    expect(hash).toBe(workspaceHash('/tmp/hash-test'));
  });

  test('returns null for non-existent conversation', () => {
    expect(service.getWorkspaceHashForConv('nope')).toBeNull();
  });
});

describe('listConversations includes workspaceHash', () => {
  test('each conversation has workspaceHash', async () => {
    await service.createConversation('Test', '/tmp/list-hash');
    const list = await service.listConversations();
    expect(list[0].workspaceHash).toBe(workspaceHash('/tmp/list-hash'));
  });

  test('workspaceKbEnabled defaults to false', async () => {
    await service.createConversation('Test', '/tmp/kb-off');
    const list = await service.listConversations();
    const conv = list.find(c => c.workingDir === '/tmp/kb-off');
    expect(conv).toBeDefined();
    expect(conv!.workspaceKbEnabled).toBe(false);
  });

  test('workspaceKbEnabled is true after flipping the workspace flag', async () => {
    await service.createConversation('Test', '/tmp/kb-on');
    const hash = workspaceHash('/tmp/kb-on');
    await service.setWorkspaceKbEnabled(hash, true);
    const list = await service.listConversations();
    const conv = list.find(c => c.workingDir === '/tmp/kb-on');
    expect(conv).toBeDefined();
    expect(conv!.workspaceKbEnabled).toBe(true);
  });
});

// ── Migration ───────────────────────────────────────────────────────────────
