/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── KB multi-location + ref-counted delete tests ────────────────────────────
// The Phase 3 KB stores a single raw row per unique sha256 and a variable
// number of `raw_locations` rows tying it into (folder, filename) slots the
// user has uploaded it into. This test pins down the contract:
//
//   - Uploading the same bytes into two folders creates two location rows
//     under one raw_id — no bytes duplicated on disk.
//   - Counters still show a single raw (rawTotal === 1).
//   - `deleteLocation` decrements the location count without touching the
//     other sibling locations or the raw bytes.
//   - The last remaining location drives a full purge (bytes + converted +
//     entries + raw row) regardless of auto-digest setting.
//   - Uploading fresh bytes into an occupied (folder, filename) throws
//     `KbLocationConflictError` so the UI can prompt for rename.
//   - Purge of a raw that owns multiple locations wipes all of them.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { ChatService } from '../src/services/chatService';
import {
  KbIngestionService,
  KbLocationConflictError,
} from '../src/services/knowledgeBase/ingestion';
import { WorkspaceTaskQueueRegistry } from '../src/services/knowledgeBase/workspaceTaskQueue';
import type { KbStateUpdateEvent } from '../src/types';

const WORKSPACE_PATH = '/tmp/kb-multi-loc-test';

function workspaceHash(p: string): string {
  return crypto.createHash('sha256').update(p).digest('hex').substring(0, 16);
}

let tmpDir: string;
let chatService: ChatService;
let ingestion: KbIngestionService;
let emitted: Array<{ hash: string; frame: KbStateUpdateEvent }>;
let hash: string;

async function upload(content: Buffer, filename: string, folderPath = '') {
  const res = await ingestion.enqueueUpload(hash, {
    buffer: content,
    filename,
    mimeType: 'text/plain',
    folderPath,
  });
  await ingestion.waitForIdle(hash);
  return res;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-multi-loc-'));
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

describe('multi-location uploads', () => {
  test('same bytes in two folders reuse the same raw_id + single on-disk file', async () => {
    const buf = Buffer.from('shared bytes payload');
    const first = await upload(buf, 'alpha.txt', 'reports');
    const second = await upload(buf, 'alpha.txt', 'archive/2025');

    expect(second.deduped).toBe(true);
    expect(second.addedLocation).toBe(true);
    expect(second.entry.rawId).toBe(first.entry.rawId);

    const db = chatService.getKbDb(hash)!;
    expect(db.countLocations(first.entry.rawId)).toBe(2);
    // Counter should still report one raw.
    const counters = db.getCounters();
    expect(counters.rawTotal).toBe(1);

    // The bytes live under `<rawId>.txt` once.
    const rawPath = path.join(chatService.getKbRawDir(hash), `${first.entry.rawId}.txt`);
    expect(fs.existsSync(rawPath)).toBe(true);

    // Each folder lists its own row with the same rawId.
    const inReports = db.listRawInFolder('reports');
    const inArchive = db.listRawInFolder('archive/2025');
    expect(inReports.map((r) => r.rawId)).toEqual([first.entry.rawId]);
    expect(inArchive.map((r) => r.rawId)).toEqual([first.entry.rawId]);
  });

  test('same bytes in same folder with two different filenames add two locations', async () => {
    const buf = Buffer.from('two names same bytes');
    const a = await upload(buf, 'alpha.txt', 'notes');
    const b = await upload(buf, 'beta.txt', 'notes');

    expect(b.deduped).toBe(true);
    expect(b.addedLocation).toBe(true);
    const db = chatService.getKbDb(hash)!;
    expect(db.countLocations(a.entry.rawId)).toBe(2);
    const names = db.listRawInFolder('notes').map((r) => r.filename).sort();
    expect(names).toEqual(['alpha.txt', 'beta.txt']);
  });

  test('uploading DIFFERENT bytes into an occupied location throws KbLocationConflictError', async () => {
    await upload(Buffer.from('original'), 'x.txt', 'collisions');
    await expect(
      upload(Buffer.from('totally different bytes'), 'x.txt', 'collisions'),
    ).rejects.toBeInstanceOf(KbLocationConflictError);
  });

  test('deleteLocation removes only the one slot and keeps other locations live', async () => {
    const buf = Buffer.from('two-location raw');
    const res = await upload(buf, 'one.txt', 'a');
    await upload(buf, 'two.txt', 'b');
    const rawId = res.entry.rawId;
    const db = chatService.getKbDb(hash)!;
    expect(db.countLocations(rawId)).toBe(2);

    const removed = await ingestion.deleteLocation(hash, rawId, 'a', 'one.txt');
    expect(removed).toBe(true);
    expect(db.countLocations(rawId)).toBe(1);
    // Raw row + bytes still exist because another location holds the ref.
    expect(db.getRawById(rawId)).not.toBeNull();
    const rawPath = path.join(chatService.getKbRawDir(hash), `${rawId}.txt`);
    expect(fs.existsSync(rawPath)).toBe(true);
    // The surviving location is still discoverable.
    expect(db.findLocation('b', 'two.txt')?.rawId).toBe(rawId);
  });

  test('deleting the last location with auto-digest OFF fully purges raw + bytes + converted', async () => {
    await chatService.setWorkspaceKbAutoDigest(hash, false);
    const res = await upload(Buffer.from('solo'), 'only.txt', 'solo');
    const rawId = res.entry.rawId;
    const db = chatService.getKbDb(hash)!;
    const rawPath = path.join(chatService.getKbRawDir(hash), `${rawId}.txt`);
    const convertedDir = path.join(chatService.getKbConvertedDir(hash), rawId);

    await ingestion.deleteLocation(hash, rawId, 'solo', 'only.txt');

    expect(db.getRawById(rawId)).toBeNull();
    expect(fs.existsSync(rawPath)).toBe(false);
    expect(fs.existsSync(convertedDir)).toBe(false);
  });

  test('deleting the last location with auto-digest OFF also cleans up existing entries', async () => {
    await chatService.setWorkspaceKbAutoDigest(hash, false);
    const res = await upload(Buffer.from('has-entries'), 'digested.txt', 'dir');
    const rawId = res.entry.rawId;
    const db = chatService.getKbDb(hash)!;

    // Simulate a previously-digested raw with an entry.
    db.insertEntry({
      entryId: `${rawId}-test`,
      rawId,
      title: 'Test',
      slug: 'test',
      summary: 'Test entry.',
      schemaVersion: 1,
      digestedAt: new Date().toISOString(),
      tags: [],
    });
    db.updateRawStatus(rawId, 'digested');
    expect(db.listEntries({ rawId })).toHaveLength(1);

    // Delete last location → full purge including entries.
    await ingestion.deleteLocation(hash, rawId, 'dir', 'digested.txt');
    expect(db.getRawById(rawId)).toBeNull();
    expect(db.listEntries({ rawId })).toHaveLength(0);
  });

  test('deleting the last location with auto-digest ON purges raw + bytes + converted dir', async () => {
    await chatService.setWorkspaceKbAutoDigest(hash, true);
    const res = await upload(Buffer.from('auto purge'), 'purge.txt', 'ephemeral');
    const rawId = res.entry.rawId;
    const db = chatService.getKbDb(hash)!;
    const rawPath = path.join(chatService.getKbRawDir(hash), `${rawId}.txt`);
    const convertedDir = path.join(chatService.getKbConvertedDir(hash), rawId);

    await ingestion.deleteLocation(hash, rawId, 'ephemeral', 'purge.txt');

    expect(db.getRawById(rawId)).toBeNull();
    expect(fs.existsSync(rawPath)).toBe(false);
    expect(fs.existsSync(convertedDir)).toBe(false);
  });

  test('purgeRaw removes every location no matter how many are attached', async () => {
    const buf = Buffer.from('gonna purge everything');
    const res = await upload(buf, 'a.txt', 'f1');
    await upload(buf, 'b.txt', 'f2');
    await upload(buf, 'c.txt', 'f3');
    const rawId = res.entry.rawId;
    const db = chatService.getKbDb(hash)!;
    expect(db.countLocations(rawId)).toBe(3);

    const purged = await ingestion.purgeRaw(hash, rawId);
    expect(purged).toBe(true);
    expect(db.getRawById(rawId)).toBeNull();
    expect(db.findLocation('f1', 'a.txt')).toBeNull();
    expect(db.findLocation('f2', 'b.txt')).toBeNull();
    expect(db.findLocation('f3', 'c.txt')).toBeNull();
  });

  test('deleteLocation returns false when the slot is not found', async () => {
    const removed = await ingestion.deleteLocation(hash, 'nosuchraw', 'ghost', 'phantom.txt');
    expect(removed).toBe(false);
  });

  test('re-uploading same bytes after purge creates a fresh raw', async () => {
    await chatService.setWorkspaceKbAutoDigest(hash, false);
    const buf = Buffer.from('restore-test');
    const first = await upload(buf, 'file.txt', 'dir');
    const rawId = first.entry.rawId;
    const db = chatService.getKbDb(hash)!;

    // Delete last location → full purge.
    await ingestion.deleteLocation(hash, rawId, 'dir', 'file.txt');
    expect(db.getRawById(rawId)).toBeNull();

    // Re-upload same bytes — creates a brand-new raw since the old one
    // was fully purged. The upload helper awaits conversion so status
    // will be 'ingested' by the time we check.
    const second = await upload(buf, 'file.txt', 'dir2');
    expect(second.entry.rawId).toBe(rawId); // same sha → same rawId
    expect(second.deduped).toBe(false);
    expect(db.getRawById(rawId)?.status).toBe('ingested');
  });
});
