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
    expect(state!.autoDigest).toBe(false);

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

    const dbPath = path.join(tmpDir, 'data', 'chat', 'workspaces', hash, 'knowledge', 'state.db');
    expect(fs.existsSync(dbPath)).toBe(true);
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
