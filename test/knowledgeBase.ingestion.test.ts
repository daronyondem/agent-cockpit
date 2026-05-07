/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Knowledge Base ingestion orchestrator tests ────────────────────────────
// Exercises `KbIngestionService` end-to-end against a real `ChatService`
// backed by a temp directory. We verify:
//   - Upload stages the raw file + creates a state entry (ingesting)
//   - Background conversion transitions the entry to `ingested` with
//     the handler's output written under `converted/<rawId>/`
//   - Dedup on identical content returns the existing entry without
//     touching state.json
//   - Unsupported file types land as `failed` with a clear error message
//   - KbDisabledError is raised when the workspace has KB disabled
//   - Cascade delete removes raw + converted dir + state entry
//   - WS emit callback fires on every mutation with the expected frame

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { ChatService } from '../src/services/chatService';
import { KbIngestionService, KbDisabledError } from '../src/services/knowledgeBase/ingestion';
import { WorkspaceTaskQueueRegistry } from '../src/services/knowledgeBase/workspaceTaskQueue';
import type { KbStateUpdateEvent } from '../src/types';

const WORKSPACE_PATH = '/tmp/kb-ingestion-test';

function workspaceHash(p: string): string {
  return crypto.createHash('sha256').update(p).digest('hex').substring(0, 16);
}

let tmpDir: string;
let chatService: ChatService;
let ingestion: KbIngestionService;
let emitted: Array<{ hash: string; frame: KbStateUpdateEvent }>;
let hash: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ingest-'));
  chatService = new ChatService(tmpDir, { defaultWorkspace: WORKSPACE_PATH });
  await chatService.initialize();
  emitted = [];
  ingestion = new KbIngestionService({
    chatService,
    emit: (h, frame) => emitted.push({ hash: h, frame }),
    queueRegistry: new WorkspaceTaskQueueRegistry(),
  });
  // Bootstrap a workspace with KB enabled.
  await chatService.createConversation('seed', WORKSPACE_PATH);
  hash = workspaceHash(WORKSPACE_PATH);
  await chatService.setWorkspaceKbEnabled(hash, true);
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('enqueueUpload', () => {
  test('rejects when KB is disabled', async () => {
    await chatService.setWorkspaceKbEnabled(hash, false);
    await expect(
      ingestion.enqueueUpload(hash, {
        buffer: Buffer.from('hello'),
        filename: 'greet.txt',
        mimeType: 'text/plain',
      }),
    ).rejects.toBeInstanceOf(KbDisabledError);
  });

  test('stages a text file, writes state, and converts in the background', async () => {
    const content = 'Hello Knowledge Base';
    const result = await ingestion.enqueueUpload(hash, {
      buffer: Buffer.from(content),
      filename: 'hello.md',
      mimeType: 'text/markdown',
    });
    expect(result.deduped).toBe(false);
    expect(result.entry.status).toBe('ingesting');
    expect(result.entry.filename).toBe('hello.md');
    expect(result.entry.sizeBytes).toBe(content.length);

    // Raw file is on disk immediately.
    const rawPath = path.join(chatService.getKbRawDir(hash), `${result.entry.rawId}.md`);
    expect(fs.existsSync(rawPath)).toBe(true);

    // Wait for background conversion to finish, then inspect state.
    await ingestion.waitForIdle(hash);
    const state = await chatService.getKbStateSnapshot(hash);
    const entry = state?.raw.find((r) => r.rawId === result.entry.rawId);
    expect(entry?.status).toBe('ingested');

    // Converted output exists with text.md + meta.json.
    const outDir = path.join(chatService.getKbConvertedDir(hash), result.entry.rawId);
    expect(fs.existsSync(path.join(outDir, 'text.md'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'meta.json'))).toBe(true);

    const textMd = fs.readFileSync(path.join(outDir, 'text.md'), 'utf8');
    expect(textMd).toContain('# hello.md');
    expect(textMd).toContain(content);

    const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf8'));
    expect(meta.rawId).toBe(result.entry.rawId);
    expect(meta.handler).toBe('passthrough/text');

    const db = chatService.getKbDb(hash)!;
    const document = db.getDocument(result.entry.rawId);
    expect(document).toMatchObject({
      rawId: result.entry.rawId,
      docName: 'hello.md',
      unitType: 'section',
      unitCount: 1,
      structureStatus: 'ready',
    });
    expect(db.listDocumentNodes(result.entry.rawId).map((n) => n.title)).toEqual(['hello.md']);

    // WS emit fired at least twice: once on stage, once on status transition.
    expect(emitted.length).toBeGreaterThanOrEqual(2);
    for (const { hash: h, frame } of emitted) {
      expect(h).toBe(hash);
      expect(frame.type).toBe('kb_state_update');
      expect(frame.changed.raw).toContain(result.entry.rawId);
    }
  });

  test('dedupes identical content: reuses rawId and adds a second location when filename differs', async () => {
    const buf = Buffer.from('duplicate me');
    const first = await ingestion.enqueueUpload(hash, {
      buffer: buf,
      filename: 'a.txt',
      mimeType: 'text/plain',
    });
    await ingestion.waitForIdle(hash);

    const second = await ingestion.enqueueUpload(hash, {
      buffer: buf,
      filename: 'b.txt', // different filename, same content → same rawId, new location
      mimeType: 'text/plain',
    });
    expect(second.deduped).toBe(true);
    expect(second.addedLocation).toBe(true);
    expect(second.entry.rawId).toBe(first.entry.rawId);

    const state = await chatService.getKbStateSnapshot(hash);
    // Exactly one raw row; two location rows (a.txt + b.txt in root).
    expect(state!.counters.rawTotal).toBe(1);
    expect(state!.raw).toHaveLength(2);
    const names = state!.raw.map((r) => r.filename).sort();
    expect(names).toEqual(['a.txt', 'b.txt']);
  });

  test('exact dedup (same folder + filename) is a no-op with deduped: true, addedLocation: false', async () => {
    const buf = Buffer.from('exact dup');
    await ingestion.enqueueUpload(hash, {
      buffer: buf,
      filename: 'c.txt',
      mimeType: 'text/plain',
    });
    await ingestion.waitForIdle(hash);

    const again = await ingestion.enqueueUpload(hash, {
      buffer: buf,
      filename: 'c.txt',
      mimeType: 'text/plain',
    });
    expect(again.deduped).toBe(true);
    expect(again.addedLocation).toBe(false);
  });

  test('marks unsupported file types as failed with a clear message', async () => {
    const result = await ingestion.enqueueUpload(hash, {
      buffer: Buffer.from([0x00, 0x01, 0x02, 0x03]),
      filename: 'mystery.xyz',
      mimeType: 'application/octet-stream',
    });
    await ingestion.waitForIdle(hash);
    const state = await chatService.getKbStateSnapshot(hash);
    const entry = state?.raw.find((r) => r.rawId === result.entry.rawId);
    expect(entry?.status).toBe('failed');
    expect(entry?.errorMessage || '').toMatch(/Unsupported file type/);
  });
});

describe('deleteRaw', () => {
  test('cascades — removes raw file, converted dir, and state entry', async () => {
    const res = await ingestion.enqueueUpload(hash, {
      buffer: Buffer.from('# Some content'),
      filename: 'note.md',
      mimeType: 'text/markdown',
    });
    await ingestion.waitForIdle(hash);

    const rawPath = path.join(chatService.getKbRawDir(hash), `${res.entry.rawId}.md`);
    const convertedDir = path.join(chatService.getKbConvertedDir(hash), res.entry.rawId);
    expect(fs.existsSync(rawPath)).toBe(true);
    expect(fs.existsSync(convertedDir)).toBe(true);

    emitted.length = 0;
    const removed = await ingestion.deleteRaw(hash, res.entry.rawId);
    expect(removed).toBe(true);
    expect(fs.existsSync(rawPath)).toBe(false);
    expect(fs.existsSync(convertedDir)).toBe(false);
    const state = await chatService.getKbStateSnapshot(hash);
    expect(state?.raw.find((r) => r.rawId === res.entry.rawId)).toBeUndefined();
    expect(state?.counters.rawTotal).toBe(0);

    // At least one kb_state_update emitted for the delete.
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(emitted.some((e) => (e.frame.changed.raw || []).includes(res.entry.rawId))).toBe(true);
  });

  test('deletes embeddings for entries removed with the raw', async () => {
    const res = await ingestion.enqueueUpload(hash, {
      buffer: Buffer.from('# Some content'),
      filename: 'note.md',
      mimeType: 'text/markdown',
    });
    await ingestion.waitForIdle(hash);
    const db = chatService.getKbDb(hash)!;
    const entryId = `${res.entry.rawId}-entry`;
    db.insertEntry({
      entryId,
      rawId: res.entry.rawId,
      title: 'Entry',
      slug: 'entry',
      summary: 'Entry summary.',
      schemaVersion: 1,
      digestedAt: '2026-01-02T00:00:00.000Z',
      tags: [],
    });

    const store = { deleteEntry: jest.fn().mockResolvedValue(undefined) };
    jest.spyOn(chatService, 'getWorkspaceKbEmbeddingConfig').mockResolvedValue({
      model: 'test-embed',
      dimensions: 3,
    });
    jest.spyOn(chatService, 'getKbVectorStore').mockResolvedValue(store as any);

    const removed = await ingestion.deleteRaw(hash, res.entry.rawId);

    expect(removed).toBe(true);
    expect(store.deleteEntry).toHaveBeenCalledWith(entryId);
  });

  test('returns false for an unknown rawId', async () => {
    const removed = await ingestion.deleteRaw(hash, 'nosuchid');
    expect(removed).toBe(false);
  });

  test('rejects when KB is disabled', async () => {
    await chatService.setWorkspaceKbEnabled(hash, false);
    await expect(ingestion.deleteRaw(hash, 'anything')).rejects.toBeInstanceOf(KbDisabledError);
  });
});

// ─── Substep emissions ──────────────────────────────────────────────────────

describe('substep emissions during ingestion', () => {
  test('emits substep frames for converting and storing phases', async () => {
    emitted.length = 0;
    const result = await ingestion.enqueueUpload(hash, {
      buffer: Buffer.from('Substep test content'),
      filename: 'substep.md',
      mimeType: 'text/markdown',
    });
    await ingestion.waitForIdle(hash);

    const substepFrames = emitted
      .filter((e) => e.frame.changed.substep !== undefined)
      .map((e) => e.frame.changed.substep!);

    // Should have at least 2 substep emissions: one for converting, one for storing.
    expect(substepFrames.length).toBeGreaterThanOrEqual(2);
    expect(substepFrames.every((s) => s.rawId === result.entry.rawId)).toBe(true);

    const texts = substepFrames.map((s) => s.text);
    expect(texts.some((t) => /Convert/i.test(t))).toBe(true);
    expect(texts.some((t) => /Stor/i.test(t))).toBe(true);
  });
});
