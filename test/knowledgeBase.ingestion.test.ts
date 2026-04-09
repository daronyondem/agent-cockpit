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
  });
  // Bootstrap a workspace with KB enabled.
  await chatService.createConversation('seed', WORKSPACE_PATH);
  hash = workspaceHash(WORKSPACE_PATH);
  await chatService.setWorkspaceKbEnabled(hash, true);
});

afterEach(() => {
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
    const state = await chatService.getKbState(hash);
    expect(state?.raw[result.entry.rawId].status).toBe('ingested');

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

    // WS emit fired at least twice: once on stage, once on status transition.
    expect(emitted.length).toBeGreaterThanOrEqual(2);
    for (const { hash: h, frame } of emitted) {
      expect(h).toBe(hash);
      expect(frame.type).toBe('kb_state_update');
      expect(frame.changed.raw).toContain(result.entry.rawId);
    }
  });

  test('dedupes identical content without creating a second entry', async () => {
    const buf = Buffer.from('duplicate me');
    const first = await ingestion.enqueueUpload(hash, {
      buffer: buf,
      filename: 'a.txt',
      mimeType: 'text/plain',
    });
    await ingestion.waitForIdle(hash);

    const second = await ingestion.enqueueUpload(hash, {
      buffer: buf,
      filename: 'b.txt', // different filename, same content → same rawId
      mimeType: 'text/plain',
    });
    expect(second.deduped).toBe(true);
    expect(second.entry.rawId).toBe(first.entry.rawId);

    const state = await chatService.getKbState(hash);
    expect(Object.keys(state!.raw)).toHaveLength(1);
  });

  test('marks unsupported file types as failed with a clear message', async () => {
    const result = await ingestion.enqueueUpload(hash, {
      buffer: Buffer.from([0x00, 0x01, 0x02, 0x03]),
      filename: 'mystery.xyz',
      mimeType: 'application/octet-stream',
    });
    await ingestion.waitForIdle(hash);
    const state = await chatService.getKbState(hash);
    const entry = state?.raw[result.entry.rawId];
    expect(entry?.status).toBe('failed');
    expect(entry?.error || '').toMatch(/Unsupported file type/);
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
    const state = await chatService.getKbState(hash);
    expect(state?.raw[res.entry.rawId]).toBeUndefined();

    // One kb_state_update emitted for the delete.
    expect(emitted).toHaveLength(1);
    expect(emitted[0].frame.changed.raw).toContain(res.entry.rawId);
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
