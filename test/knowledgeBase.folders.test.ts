/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── KB folder orchestration tests ───────────────────────────────────────────
// Exercises folder create/rename/delete at the `KbIngestionService` level so
// we cover not only the DB semantics (already tested in db.test.ts) but also
// the orchestrator's:
//   - cascade delete (always full purge)
//   - KbValidationError boundaries (root folder, empty path)
//   - WS frame emission with `folders: true`
//   - Interaction with raw_locations across a subtree rename
//
// All tests run against a real ChatService + temp dir like the ingestion
// tests so we catch wiring regressions too.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { ChatService } from '../src/services/chatService';
import {
  KbIngestionService,
  KbValidationError,
  KbDisabledError,
} from '../src/services/knowledgeBase/ingestion';
import { WorkspaceTaskQueueRegistry } from '../src/services/knowledgeBase/workspaceTaskQueue';
import type { KbStateUpdateEvent } from '../src/types';

const WORKSPACE_PATH = '/tmp/kb-folders-test';

function workspaceHash(p: string): string {
  return crypto.createHash('sha256').update(p).digest('hex').substring(0, 16);
}

let tmpDir: string;
let chatService: ChatService;
let ingestion: KbIngestionService;
let emitted: Array<{ hash: string; frame: KbStateUpdateEvent }>;
let hash: string;

async function upload(content: string, filename: string, folderPath = '') {
  const res = await ingestion.enqueueUpload(hash, {
    buffer: Buffer.from(content),
    filename,
    mimeType: 'text/plain',
    folderPath,
  });
  await ingestion.waitForIdle(hash);
  return res;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-folders-'));
  chatService = new ChatService(tmpDir, { defaultWorkspace: WORKSPACE_PATH });
  await chatService.initialize();
  await chatService.saveSettings({
    ...(await chatService.getSettings()),
    defaultBackend: 'claude-code',
  });
  emitted = [];
  ingestion = new KbIngestionService({
    chatService,
    emit: (h, frame) => emitted.push({ hash: h, frame }),
    queueRegistry: new WorkspaceTaskQueueRegistry(),
  });
  await chatService.createConversation('seed', WORKSPACE_PATH);
  hash = workspaceHash(WORKSPACE_PATH);
  await chatService.setWorkspaceKbEnabled(hash, true);
});

afterEach(() => {
  chatService.closeKbDatabases?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── createFolder ────────────────────────────────────────────────────────────

describe('createFolder', () => {
  test('creates a new folder and emits a folders frame', async () => {
    emitted.length = 0;
    const normalized = await ingestion.createFolder(hash, 'a/b/c');
    expect(normalized).toBe('a/b/c');
    const db = chatService.getKbDb(hash)!;
    expect(db.folderExists('a')).toBe(true);
    expect(db.folderExists('a/b')).toBe(true);
    expect(db.folderExists('a/b/c')).toBe(true);
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(emitted.some((e) => e.frame.changed.folders === true)).toBe(true);
  });

  test('is idempotent on existing folders', async () => {
    await ingestion.createFolder(hash, 'x');
    await ingestion.createFolder(hash, 'x');
    const db = chatService.getKbDb(hash)!;
    const folders = db.listFolders().map((f) => f.folderPath);
    // 'x' should be present exactly once (plus root).
    expect(folders.filter((f) => f === 'x').length).toBe(1);
  });

  test('rejects creation of root folder', async () => {
    await expect(ingestion.createFolder(hash, '')).rejects.toBeInstanceOf(KbValidationError);
  });

  test('rejects when KB is disabled', async () => {
    await chatService.setWorkspaceKbEnabled(hash, false);
    await expect(ingestion.createFolder(hash, 'x')).rejects.toBeInstanceOf(KbDisabledError);
  });

  test('rejects invalid segments (path traversal)', async () => {
    await expect(ingestion.createFolder(hash, 'a/../b')).rejects.toThrow();
  });
});

// ─── renameFolder ────────────────────────────────────────────────────────────

describe('renameFolder', () => {
  test('moves a subtree + every location in it', async () => {
    await upload('one', 'one.txt', 'projects/alpha');
    await upload('two', 'two.txt', 'projects/alpha/notes');
    const db = chatService.getKbDb(hash)!;
    emitted.length = 0;

    await ingestion.renameFolder(hash, 'projects/alpha', 'archive/alpha');

    expect(db.folderExists('projects/alpha')).toBe(false);
    expect(db.folderExists('projects/alpha/notes')).toBe(false);
    expect(db.folderExists('archive/alpha')).toBe(true);
    expect(db.folderExists('archive/alpha/notes')).toBe(true);
    expect(db.findLocation('archive/alpha', 'one.txt')).not.toBeNull();
    expect(db.findLocation('archive/alpha/notes', 'two.txt')).not.toBeNull();
    expect(emitted.some((e) => e.frame.changed.folders === true)).toBe(true);
  });

  test('rejects rename to root or rename of root', async () => {
    await expect(ingestion.renameFolder(hash, '', 'x')).rejects.toThrow();
    await expect(ingestion.renameFolder(hash, 'x', '')).rejects.toThrow();
  });

  test('rejects KbDisabled', async () => {
    await chatService.setWorkspaceKbEnabled(hash, false);
    await expect(ingestion.renameFolder(hash, 'a', 'b')).rejects.toBeInstanceOf(KbDisabledError);
  });
});

// ─── deleteFolder ────────────────────────────────────────────────────────────

describe('deleteFolder', () => {
  test('refuses to drop a non-empty folder without cascade=true', async () => {
    await upload('hi', 'keep.txt', 'docs');
    await expect(ingestion.deleteFolder(hash, 'docs')).rejects.toBeInstanceOf(KbValidationError);
  });

  test('cascade=true with auto-digest OFF fully purges the raw', async () => {
    await chatService.setWorkspaceKbAutoDigest(hash, false);
    const res = await upload('body', 'a.txt', 'tmp');
    const db = chatService.getKbDb(hash)!;

    await ingestion.deleteFolder(hash, 'tmp', { cascade: true });

    expect(db.folderExists('tmp')).toBe(false);
    expect(db.findLocation('tmp', 'a.txt')).toBeNull();
    expect(db.getRawById(res.entry.rawId)).toBeNull();
  });

  test('cascade=true with auto-digest ON purges raw + bytes + converted dir', async () => {
    await chatService.setWorkspaceKbAutoDigest(hash, true);
    const res = await upload('autobody', 'b.txt', 'scratch');
    const rawId = res.entry.rawId;
    const db = chatService.getKbDb(hash)!;
    const rawPath = path.join(chatService.getKbRawDir(hash), `${rawId}.txt`);
    const convertedDir = path.join(chatService.getKbConvertedDir(hash), rawId);
    expect(fs.existsSync(rawPath)).toBe(true);
    expect(fs.existsSync(convertedDir)).toBe(true);

    await ingestion.deleteFolder(hash, 'scratch', { cascade: true });

    expect(db.folderExists('scratch')).toBe(false);
    expect(db.getRawById(rawId)).toBeNull();
    expect(fs.existsSync(rawPath)).toBe(false);
    expect(fs.existsSync(convertedDir)).toBe(false);
  });

  test('rejects deleting the root folder', async () => {
    await expect(ingestion.deleteFolder(hash, '')).rejects.toBeInstanceOf(KbValidationError);
  });

  test('rejects deleting a nonexistent folder', async () => {
    await expect(ingestion.deleteFolder(hash, 'nope')).rejects.toBeInstanceOf(KbValidationError);
  });

  test('rejects when KB is disabled', async () => {
    await chatService.setWorkspaceKbEnabled(hash, false);
    await expect(ingestion.deleteFolder(hash, 'x')).rejects.toBeInstanceOf(KbDisabledError);
  });
});
