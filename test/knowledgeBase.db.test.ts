/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Knowledge Base SQLite layer tests ───────────────────────────────────────
// Exercises `KbDatabase` directly against a temp-dir-backed SQLite DB. These
// tests are deliberately DB-only (no ChatService, no ingestion orchestrator)
// so we can lock down the exact CRUD contract the higher layers depend on:
//   - Raw insert / update / delete with FK cascades
//   - sha256-based dedupe lookups
//   - Location junction semantics (multi-location, ref counting)
//   - Folder creation / rename / cascade delete rules
//   - Counter aggregation across every status bucket
//   - Entry insert / list / tag filtering / delete-by-raw cascade
//   - Legacy state.json → state.db migration on first open
//
// Any behavior change in db.ts that doesn't break an assertion here is a
// silent regression the orchestrator tests probably won't catch.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import {
  KbDatabase,
  openKbDatabase,
  normalizeFolderPath,
  KB_DB_SCHEMA_VERSION,
} from '../src/services/knowledgeBase/db';

let tmpDir: string;
let dbPath: string;
let rawDir: string;
let db: KbDatabase;

function makeRawFile(contents: string, ext = '.txt'): { rawId: string; sha256: string; filePath: string } {
  const buf = Buffer.from(contents);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const rawId = sha256.slice(0, 16);
  const filePath = path.join(rawDir, `${rawId}${ext}`);
  fs.writeFileSync(filePath, buf);
  return { rawId, sha256, filePath };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-db-'));
  dbPath = path.join(tmpDir, 'state.db');
  rawDir = path.join(tmpDir, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  db = new KbDatabase(dbPath);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed in specific tests */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Schema & bootstrap ──────────────────────────────────────────────────────

describe('schema + root folder', () => {
  test('fresh DB has the expected schema version + empty root folder', () => {
    expect(db.getSchemaVersion()).toBe(KB_DB_SCHEMA_VERSION);
    const folders = db.listFolders();
    expect(folders).toHaveLength(1);
    expect(folders[0].folderPath).toBe('');
  });

  test('counters on an empty DB are all zero', () => {
    const c = db.getCounters();
    expect(c.rawTotal).toBe(0);
    expect(c.entryCount).toBe(0);
    expect(c.pendingCount).toBe(0);
    expect(c.folderCount).toBe(1); // root
    expect(c.rawByStatus.ingesting).toBe(0);
    expect(c.rawByStatus.ingested).toBe(0);
    expect(c.rawByStatus.digested).toBe(0);
    expect(c.rawByStatus.failed).toBe(0);
  });
});

// ─── normalizeFolderPath ─────────────────────────────────────────────────────

describe('normalizeFolderPath', () => {
  test('accepts and normalizes valid paths', () => {
    expect(normalizeFolderPath('')).toBe('');
    expect(normalizeFolderPath('/')).toBe('');
    expect(normalizeFolderPath('a')).toBe('a');
    expect(normalizeFolderPath('a/b')).toBe('a/b');
    expect(normalizeFolderPath('/a/b/')).toBe('a/b');
    expect(normalizeFolderPath('a//b')).toBe('a/b');
  });

  test('rejects path traversal and control characters', () => {
    expect(() => normalizeFolderPath('..')).toThrow();
    expect(() => normalizeFolderPath('a/../b')).toThrow();
    expect(() => normalizeFolderPath('a/\x00/b')).toThrow();
  });

  test('rejects over-long segments', () => {
    const long = 'x'.repeat(129);
    expect(() => normalizeFolderPath(long)).toThrow();
  });
});

// ─── Raw rows ────────────────────────────────────────────────────────────────

describe('raw CRUD', () => {
  test('insertRaw + getRawById / getRawBySha roundtrip', () => {
    const { rawId, sha256 } = makeRawFile('hello world');
    db.insertRaw({
      rawId,
      sha256,
      status: 'ingesting',
      byteLength: 11,
      mimeType: 'text/plain',
      handler: null,
      uploadedAt: '2026-01-01T00:00:00Z',
      metadata: null,
    });
    const byId = db.getRawById(rawId);
    expect(byId?.raw_id).toBe(rawId);
    expect(byId?.sha256).toBe(sha256);
    expect(byId?.status).toBe('ingesting');
    expect(byId?.byte_length).toBe(11);

    const bySha = db.getRawBySha(sha256);
    expect(bySha?.raw_id).toBe(rawId);
  });

  test('updateRawStatus persists error fields when failing', () => {
    const { rawId, sha256 } = makeRawFile('fail me');
    db.insertRaw({
      rawId,
      sha256,
      status: 'ingesting',
      byteLength: 7,
      mimeType: 'text/plain',
      handler: null,
      uploadedAt: '2026-01-01T00:00:00Z',
      metadata: null,
    });
    db.updateRawStatus(rawId, 'failed', {
      errorClass: 'cli_error',
      errorMessage: 'handler exploded',
    });
    const row = db.getRawById(rawId);
    expect(row?.status).toBe('failed');
    expect(row?.error_class).toBe('cli_error');
    expect(row?.error_message).toBe('handler exploded');
  });

  test('setRawHandler + setRawMetadata + setRawDigestedAt update in place', () => {
    const { rawId, sha256 } = makeRawFile('meta');
    db.insertRaw({
      rawId,
      sha256,
      status: 'ingested',
      byteLength: 4,
      mimeType: 'text/plain',
      handler: null,
      uploadedAt: '2026-01-01T00:00:00Z',
      metadata: null,
    });
    db.setRawHandler(rawId, 'passthrough/text');
    db.setRawMetadata(rawId, { pages: 3, author: 'Ada' });
    db.setRawDigestedAt(rawId, '2026-02-02T00:00:00Z');
    const row = db.getRawById(rawId);
    expect(row?.handler).toBe('passthrough/text');
    expect(row?.digested_at).toBe('2026-02-02T00:00:00Z');
    const parsed = JSON.parse(row!.metadata_json!);
    expect(parsed.pages).toBe(3);
    expect(parsed.author).toBe('Ada');
  });

  test('deleteRaw cascades to entries + entry_tags + raw_locations', () => {
    const { rawId, sha256 } = makeRawFile('cascade me');
    db.insertRaw({
      rawId,
      sha256,
      status: 'digested',
      byteLength: 10,
      mimeType: 'text/plain',
      handler: 'passthrough/text',
      uploadedAt: '2026-01-01T00:00:00Z',
      metadata: null,
    });
    db.addLocation({ rawId, folderPath: 'notes', filename: 'a.txt', uploadedAt: '2026-01-01T00:00:00Z' });
    db.insertEntry({
      entryId: `${rawId}-summary`,
      rawId,
      title: 'Summary',
      slug: 'summary',
      summary: 'one-liner',
      schemaVersion: 1,
      digestedAt: '2026-01-02T00:00:00Z',
      tags: ['a', 'b'],
    });
    expect(db.entryExists(`${rawId}-summary`)).toBe(true);
    expect(db.countLocations(rawId)).toBe(1);

    const removed = db.deleteRaw(rawId);
    expect(removed).toEqual([`${rawId}-summary`]);
    expect(db.getRawById(rawId)).toBeNull();
    expect(db.entryExists(`${rawId}-summary`)).toBe(false);
    expect(db.countLocations(rawId)).toBe(0);
  });
});

// ─── Raw locations (multi-location + ref counting) ───────────────────────────

describe('raw_locations multi-location', () => {
  test('addLocation creates the folder if missing', () => {
    const { rawId, sha256 } = makeRawFile('loc');
    db.insertRaw({
      rawId,
      sha256,
      status: 'ingested',
      byteLength: 3,
      mimeType: 'text/plain',
      handler: null,
      uploadedAt: '2026-01-01T00:00:00Z',
      metadata: null,
    });
    db.addLocation({
      rawId,
      folderPath: 'deep/nested/folder',
      filename: 'f.txt',
      uploadedAt: '2026-01-01T00:00:00Z',
    });
    expect(db.folderExists('deep')).toBe(true);
    expect(db.folderExists('deep/nested')).toBe(true);
    expect(db.folderExists('deep/nested/folder')).toBe(true);
    const loc = db.findLocation('deep/nested/folder', 'f.txt');
    expect(loc?.rawId).toBe(rawId);
  });

  test('same rawId across multiple folders shows up in listRawInFolder independently', () => {
    const { rawId, sha256 } = makeRawFile('shared bytes');
    db.insertRaw({
      rawId,
      sha256,
      status: 'ingested',
      byteLength: 12,
      mimeType: 'text/plain',
      handler: null,
      uploadedAt: '2026-01-01T00:00:00Z',
      metadata: null,
    });
    db.addLocation({ rawId, folderPath: '', filename: 'root.txt', uploadedAt: '2026-01-01T00:00:00Z' });
    db.addLocation({ rawId, folderPath: 'notes', filename: 'note.txt', uploadedAt: '2026-01-01T00:00:00Z' });
    db.addLocation({ rawId, folderPath: 'dump', filename: 'dump.txt', uploadedAt: '2026-01-01T00:00:00Z' });

    expect(db.countLocations(rawId)).toBe(3);
    expect(db.listRawInFolder('').map((r) => r.filename)).toEqual(['root.txt']);
    expect(db.listRawInFolder('notes').map((r) => r.filename)).toEqual(['note.txt']);
    expect(db.listRawInFolder('dump').map((r) => r.filename)).toEqual(['dump.txt']);

    // Counter treats this as ONE raw, not three.
    const c = db.getCounters();
    expect(c.rawTotal).toBe(1);
    expect(c.rawByStatus.ingested).toBe(1);
  });

  test('removeLocation + countLocations drive ref counting', () => {
    const { rawId, sha256 } = makeRawFile('ref count');
    db.insertRaw({
      rawId,
      sha256,
      status: 'ingested',
      byteLength: 9,
      mimeType: 'text/plain',
      handler: null,
      uploadedAt: '2026-01-01T00:00:00Z',
      metadata: null,
    });
    db.addLocation({ rawId, folderPath: '', filename: 'a.txt', uploadedAt: '2026-01-01T00:00:00Z' });
    db.addLocation({ rawId, folderPath: '', filename: 'b.txt', uploadedAt: '2026-01-01T00:00:00Z' });
    expect(db.countLocations(rawId)).toBe(2);
    db.removeLocation(rawId, '', 'a.txt');
    expect(db.countLocations(rawId)).toBe(1);
    db.removeLocation(rawId, '', 'b.txt');
    expect(db.countLocations(rawId)).toBe(0);
    // Raw row still exists — ref-counted purge is the orchestrator's job.
    expect(db.getRawById(rawId)).not.toBeNull();
  });

  test('listLocations returns every location sorted', () => {
    const { rawId, sha256 } = makeRawFile('list locs');
    db.insertRaw({
      rawId,
      sha256,
      status: 'ingested',
      byteLength: 9,
      mimeType: 'text/plain',
      handler: null,
      uploadedAt: '2026-01-01T00:00:00Z',
      metadata: null,
    });
    db.addLocation({ rawId, folderPath: 'b', filename: 'z.txt', uploadedAt: '2026-01-01T00:00:00Z' });
    db.addLocation({ rawId, folderPath: 'a', filename: 'y.txt', uploadedAt: '2026-01-01T00:00:00Z' });
    const locs = db.listLocations(rawId);
    expect(locs.map((l) => `${l.folderPath}/${l.filename}`)).toEqual(['a/y.txt', 'b/z.txt']);
  });
});

// ─── Folders (create, rename, delete subtree) ────────────────────────────────

describe('folder operations', () => {
  test('createFolder creates ancestor chain idempotently', () => {
    db.createFolder('a/b/c');
    expect(db.folderExists('a')).toBe(true);
    expect(db.folderExists('a/b')).toBe(true);
    expect(db.folderExists('a/b/c')).toBe(true);
    // Idempotent
    db.createFolder('a/b/c');
    db.createFolder('a/b');
    const folders = db.listFolders().map((f) => f.folderPath);
    expect(folders).toContain('a');
    expect(folders).toContain('a/b');
    expect(folders).toContain('a/b/c');
  });

  test('renameFolder moves subtree + updates raw_locations', () => {
    const { rawId, sha256 } = makeRawFile('move me');
    db.insertRaw({
      rawId,
      sha256,
      status: 'ingested',
      byteLength: 7,
      mimeType: 'text/plain',
      handler: null,
      uploadedAt: '2026-01-01T00:00:00Z',
      metadata: null,
    });
    db.createFolder('old/inner');
    db.addLocation({ rawId, folderPath: 'old', filename: 'top.txt', uploadedAt: '2026-01-01T00:00:00Z' });
    db.addLocation({ rawId, folderPath: 'old/inner', filename: 'inner.txt', uploadedAt: '2026-01-01T00:00:00Z' });

    db.renameFolder('old', 'new');

    expect(db.folderExists('old')).toBe(false);
    expect(db.folderExists('old/inner')).toBe(false);
    expect(db.folderExists('new')).toBe(true);
    expect(db.folderExists('new/inner')).toBe(true);
    const topInNew = db.findLocation('new', 'top.txt');
    const innerInNew = db.findLocation('new/inner', 'inner.txt');
    expect(topInNew?.rawId).toBe(rawId);
    expect(innerInNew?.rawId).toBe(rawId);
  });

  test('renameFolder rejects target collisions', () => {
    db.createFolder('a');
    db.createFolder('b');
    expect(() => db.renameFolder('a', 'b')).toThrow(/already exists/);
  });

  test('deleteFolder refuses to drop root', () => {
    expect(() => db.deleteFolder('')).toThrow(/root/);
  });

  test('listFolderSubtree returns folder + all descendants, deepest first', () => {
    db.createFolder('root');
    db.createFolder('root/mid');
    db.createFolder('root/mid/leaf');
    db.createFolder('root/other');
    const sub = db.listFolderSubtree('root').map((f) => f.folderPath);
    expect(sub).toEqual([
      'root/mid/leaf',
      'root/other',
      'root/mid',
      'root',
    ]);
  });
});

// ─── Counters ────────────────────────────────────────────────────────────────

describe('getCounters', () => {
  test('counts every status bucket + pending = ingested + pending-delete', () => {
    const mk = (label: string, status: any) => {
      const { rawId, sha256 } = makeRawFile(label);
      db.insertRaw({
        rawId,
        sha256,
        status,
        byteLength: label.length,
        mimeType: 'text/plain',
        handler: null,
        uploadedAt: '2026-01-01T00:00:00Z',
        metadata: null,
      });
      return rawId;
    };
    mk('a', 'ingesting');
    mk('b', 'ingested');
    mk('c', 'ingested');
    mk('d', 'digested');
    mk('e', 'failed');
    mk('f', 'pending-delete');

    const c = db.getCounters();
    expect(c.rawTotal).toBe(6);
    expect(c.rawByStatus.ingesting).toBe(1);
    expect(c.rawByStatus.ingested).toBe(2);
    expect(c.rawByStatus.digested).toBe(1);
    expect(c.rawByStatus.failed).toBe(1);
    expect(c.rawByStatus['pending-delete']).toBe(1);
    expect(c.pendingCount).toBe(3); // 2 ingested + 1 pending-delete
  });
});

// ─── Entries ─────────────────────────────────────────────────────────────────

describe('entry CRUD + tag filtering', () => {
  function seedRawWithEntries() {
    const { rawId, sha256 } = makeRawFile('entries source');
    db.insertRaw({
      rawId,
      sha256,
      status: 'digested',
      byteLength: 15,
      mimeType: 'text/plain',
      handler: 'passthrough/text',
      uploadedAt: '2026-01-01T00:00:00Z',
      metadata: null,
    });
    db.addLocation({ rawId, folderPath: 'notes', filename: 'notes.md', uploadedAt: '2026-01-01T00:00:00Z' });
    db.insertEntry({
      entryId: `${rawId}-alpha`,
      rawId,
      title: 'Alpha',
      slug: 'alpha',
      summary: 'first entry',
      schemaVersion: 1,
      digestedAt: '2026-01-02T00:00:00Z',
      tags: ['core', 'shared'],
    });
    db.insertEntry({
      entryId: `${rawId}-beta`,
      rawId,
      title: 'Beta',
      slug: 'beta',
      summary: 'second entry',
      schemaVersion: 1,
      digestedAt: '2026-01-02T00:00:00Z',
      tags: ['shared'],
    });
    return rawId;
  }

  test('insertEntry + getEntry returns tags sorted', () => {
    const rawId = seedRawWithEntries();
    const entry = db.getEntry(`${rawId}-alpha`);
    expect(entry?.title).toBe('Alpha');
    expect(entry?.tags).toEqual(['core', 'shared']);
  });

  test('listEntries filters by rawId, tag, and folder', () => {
    const rawId = seedRawWithEntries();
    expect(db.listEntries({ rawId }).length).toBe(2);
    expect(db.listEntries({ tag: 'core' }).length).toBe(1);
    expect(db.listEntries({ tag: 'shared' }).length).toBe(2);
    expect(db.listEntries({ folderPath: 'notes' }).length).toBe(2);
    expect(db.listEntries({ folderPath: 'other' }).length).toBe(0);
  });

  test('deleteEntriesByRawId cascades to entry_tags', () => {
    const rawId = seedRawWithEntries();
    const removed = db.deleteEntriesByRawId(rawId);
    expect(removed.sort()).toEqual([`${rawId}-alpha`, `${rawId}-beta`].sort());
    expect(db.listEntries({ tag: 'core' }).length).toBe(0);
    expect(db.listEntries({ tag: 'shared' }).length).toBe(0);
  });

  test('entryIdTaken reports collisions for slug allocation', () => {
    const rawId = seedRawWithEntries();
    expect(db.entryIdTaken(`${rawId}-alpha`)).toBe(true);
    expect(db.entryIdTaken(`${rawId}-unknown`)).toBe(false);
  });
});

// ─── Listing filters ─────────────────────────────────────────────────────────

describe('listIngestedRawIds + listPendingDeleteRaw', () => {
  test('returns only rows with the matching status', () => {
    const mk = (label: string, status: any) => {
      const { rawId, sha256 } = makeRawFile(label);
      db.insertRaw({
        rawId,
        sha256,
        status,
        byteLength: label.length,
        mimeType: 'text/plain',
        handler: null,
        uploadedAt: '2026-01-01T00:00:00Z',
        metadata: null,
      });
      return rawId;
    };
    const ing1 = mk('ing-a', 'ingested');
    const ing2 = mk('ing-b', 'ingested');
    mk('dig', 'digested');
    const pend = mk('pend', 'pending-delete');

    const ingested = db.listIngestedRawIds().sort();
    expect(ingested).toEqual([ing1, ing2].sort());
    const pending = db.listPendingDeleteRaw();
    expect(pending.map((r) => r.raw_id)).toEqual([pend]);
  });
});

// ─── Migration from legacy state.json ────────────────────────────────────────

describe('openKbDatabase migration', () => {
  test('fresh DB + no legacy JSON is a no-op open', () => {
    db.close();
    fs.rmSync(dbPath, { force: true });
    const fresh = openKbDatabase({
      dbPath,
      legacyJsonPath: path.join(tmpDir, 'state.json'),
      rawDir,
    });
    expect(fresh.listFolders().length).toBe(1);
    expect(fresh.getCounters().rawTotal).toBe(0);
    fresh.close();
  });

  test('migrates raw entries from state.json into raw + raw_locations and renames the json', () => {
    db.close();
    fs.rmSync(dbPath, { force: true });
    // Seed a legacy raw file on disk + state.json.
    const buf = Buffer.from('legacy content');
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const rawId = sha256.slice(0, 16);
    fs.writeFileSync(path.join(rawDir, `${rawId}.txt`), buf);
    const legacyPath = path.join(tmpDir, 'state.json');
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 2,
        entrySchemaVersion: 1,
        raw: {
          [rawId]: {
            rawId,
            filename: 'legacy.txt',
            mimeType: 'text/plain',
            sizeBytes: buf.length,
            uploadedAt: '2025-12-31T00:00:00Z',
            status: 'ingested',
          },
        },
      }),
    );

    const migrated = openKbDatabase({ dbPath, legacyJsonPath: legacyPath, rawDir });
    try {
      const row = migrated.getRawById(rawId);
      expect(row).not.toBeNull();
      expect(row?.sha256).toBe(sha256); // re-hashed from disk
      expect(row?.status).toBe('ingested');
      const loc = migrated.findLocation('', 'legacy.txt');
      expect(loc?.rawId).toBe(rawId);
    } finally {
      migrated.close();
    }

    // Legacy JSON should have been renamed to .migrated
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(legacyPath + '.migrated')).toBe(true);
  });

  test('snaps mid-flight legacy statuses to failed', () => {
    db.close();
    fs.rmSync(dbPath, { force: true });
    const buf = Buffer.from('mid flight');
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const rawId = sha256.slice(0, 16);
    fs.writeFileSync(path.join(rawDir, `${rawId}.txt`), buf);
    const legacyPath = path.join(tmpDir, 'state.json');
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        raw: {
          [rawId]: {
            rawId,
            filename: 'x.txt',
            mimeType: 'text/plain',
            sizeBytes: buf.length,
            uploadedAt: '2025-12-31T00:00:00Z',
            status: 'ingesting',
          },
        },
      }),
    );
    const migrated = openKbDatabase({ dbPath, legacyJsonPath: legacyPath, rawDir });
    try {
      expect(migrated.getRawById(rawId)?.status).toBe('failed');
    } finally {
      migrated.close();
    }
  });
});

// ─── Synthesis tables (Phase 4 — Dreaming) ─────────────────────────────────

describe('synthesis meta', () => {
  test('get/set round-trips', () => {
    db.setSynthesisMeta('status', 'running');
    expect(db.getSynthesisMeta('status')).toBe('running');
  });

  test('returns null for missing keys', () => {
    expect(db.getSynthesisMeta('nonexistent')).toBeNull();
  });

  test('overwrite existing key', () => {
    db.setSynthesisMeta('status', 'running');
    db.setSynthesisMeta('status', 'idle');
    expect(db.getSynthesisMeta('status')).toBe('idle');
  });
});

describe('synthesis topics CRUD', () => {
  const now = new Date().toISOString();

  test('upsertTopic + getTopic', () => {
    db.upsertTopic({ topicId: 't1', title: 'Topic 1', summary: 'S', content: 'C', updatedAt: now });
    const t = db.getTopic('t1');
    expect(t).toBeTruthy();
    expect(t!.title).toBe('Topic 1');
    expect(t!.content).toBe('C');
  });

  test('upsertTopic updates existing topic', () => {
    db.upsertTopic({ topicId: 't1', title: 'V1', summary: 'S', content: 'C', updatedAt: now });
    db.upsertTopic({ topicId: 't1', title: 'V2', summary: 'S2', content: 'C2', updatedAt: now });
    const t = db.getTopic('t1');
    expect(t!.title).toBe('V2');
    expect(t!.content).toBe('C2');
  });

  test('deleteTopic removes topic', () => {
    db.upsertTopic({ topicId: 't1', title: 'T', summary: 'S', content: 'C', updatedAt: now });
    db.deleteTopic('t1');
    expect(db.getTopic('t1')).toBeNull();
  });

  test('listTopics returns all', () => {
    db.upsertTopic({ topicId: 'a', title: 'A', summary: 'S', content: 'C', updatedAt: now });
    db.upsertTopic({ topicId: 'b', title: 'B', summary: 'S', content: 'C', updatedAt: now });
    expect(db.listTopics()).toHaveLength(2);
  });

  test('listTopicSummaries returns id/title/summary only', () => {
    db.upsertTopic({ topicId: 'x', title: 'X', summary: 'SX', content: 'CX', updatedAt: now });
    const sums = db.listTopicSummaries();
    expect(sums).toHaveLength(1);
    expect(sums[0].topicId).toBe('x');
    expect(sums[0].title).toBe('X');
    expect(sums[0].summary).toBe('SX');
  });
});

describe('entry-topic assignments', () => {
  const now = new Date().toISOString();

  beforeEach(() => {
    db.upsertTopic({ topicId: 't1', title: 'T1', summary: 'S', content: 'C', updatedAt: now });
    const { rawId: r1Id, sha256: r1Sha } = makeRawFile('needs-synth');
    db.insertRaw({
      rawId: r1Id, sha256: r1Sha, status: 'ingested', byteLength: 11,
      mimeType: 'text/plain', handler: null, uploadedAt: now, metadata: null,
    });
    db.insertEntry({
      entryId: 'e1', rawId: r1Id, title: 'E1', slug: 'e1', summary: '',
      schemaVersion: 1, digestedAt: now, tags: [],
    });
    db.insertEntry({
      entryId: 'e2', rawId: r1Id, title: 'E2', slug: 'e2', summary: '',
      schemaVersion: 1, digestedAt: now, tags: [],
    });
  });

  test('assignEntries + listTopicEntryIds', () => {
    db.assignEntries('t1', ['e1', 'e2']);
    const ids = db.listTopicEntryIds('t1');
    expect(ids).toContain('e1');
    expect(ids).toContain('e2');
  });

  test('unassignEntries removes membership', () => {
    db.assignEntries('t1', ['e1', 'e2']);
    db.unassignEntries('t1', ['e1']);
    expect(db.listTopicEntryIds('t1')).toEqual(['e2']);
  });

  test('listEntryTopicIds returns topics for an entry', () => {
    db.upsertTopic({ topicId: 't2', title: 'T2', summary: 'S', content: 'C', updatedAt: now });
    db.assignEntries('t1', ['e1']);
    db.assignEntries('t2', ['e1']);
    const topics = db.listEntryTopicIds('e1');
    expect(topics).toContain('t1');
    expect(topics).toContain('t2');
  });

  test('duplicate assignment is idempotent', () => {
    db.assignEntries('t1', ['e1']);
    db.assignEntries('t1', ['e1']); // should not throw
    expect(db.listTopicEntryIds('t1')).toEqual(['e1']);
  });

  test('topic entryCount is computed', () => {
    db.assignEntries('t1', ['e1', 'e2']);
    const t = db.getTopic('t1');
    expect(t!.entryCount).toBe(2);
  });
});

describe('connections', () => {
  const now = new Date().toISOString();

  beforeEach(() => {
    db.upsertTopic({ topicId: 'a', title: 'A', summary: 'S', content: 'C', updatedAt: now });
    db.upsertTopic({ topicId: 'b', title: 'B', summary: 'S', content: 'C', updatedAt: now });
    db.upsertTopic({ topicId: 'c', title: 'C', summary: 'S', content: 'C', updatedAt: now });
  });

  test('upsertConnection + listConnectionsForTopic', () => {
    db.upsertConnection({
      sourceTopic: 'a', targetTopic: 'b', relationship: 'influences',
      confidence: 'inferred', evidence: null,
    });
    const conns = db.listConnectionsForTopic('a');
    expect(conns).toHaveLength(1);
    expect(conns[0].relationship).toBe('influences');
  });

  test('removeConnection', () => {
    db.upsertConnection({
      sourceTopic: 'a', targetTopic: 'b', relationship: 'r',
      confidence: 'inferred', evidence: null,
    });
    db.removeConnection('a', 'b');
    expect(db.listConnectionsForTopic('a')).toHaveLength(0);
  });

  test('listAllConnections returns all', () => {
    db.upsertConnection({
      sourceTopic: 'a', targetTopic: 'b', relationship: 'r1',
      confidence: 'inferred', evidence: null,
    });
    db.upsertConnection({
      sourceTopic: 'b', targetTopic: 'c', relationship: 'r2',
      confidence: 'extracted', evidence: null,
    });
    expect(db.listAllConnections()).toHaveLength(2);
  });

  test('topic connectionCount is computed', () => {
    db.upsertConnection({
      sourceTopic: 'a', targetTopic: 'b', relationship: 'r',
      confidence: 'inferred', evidence: null,
    });
    db.upsertConnection({
      sourceTopic: 'a', targetTopic: 'c', relationship: 'r',
      confidence: 'inferred', evidence: null,
    });
    const t = db.getTopic('a');
    expect(t!.connectionCount).toBe(2);
  });

  test('deleting a topic cascades its connections', () => {
    db.upsertConnection({
      sourceTopic: 'a', targetTopic: 'b', relationship: 'r',
      confidence: 'inferred', evidence: null,
    });
    db.deleteTopic('a');
    expect(db.listAllConnections()).toHaveLength(0);
  });
});

describe('needs_synthesis column', () => {
  const now = new Date().toISOString();

  beforeEach(() => {
    const { rawId: r1Id, sha256: r1Sha } = makeRawFile('needs-synth');
    db.insertRaw({
      rawId: r1Id, sha256: r1Sha, status: 'ingested', byteLength: 11,
      mimeType: 'text/plain', handler: null, uploadedAt: now, metadata: null,
    });
    db.insertEntry({
      entryId: 'e1', rawId: r1Id, title: 'E1', slug: 'e1', summary: '',
      schemaVersion: 1, digestedAt: now, tags: [],
    });
    db.insertEntry({
      entryId: 'e2', rawId: r1Id, title: 'E2', slug: 'e2', summary: '',
      schemaVersion: 1, digestedAt: now, tags: [],
    });
  });

  test('new entries default to needs_synthesis=1', () => {
    expect(db.countNeedsSynthesis()).toBe(2);
    expect(db.listNeedsSynthesisEntryIds()).toEqual(expect.arrayContaining(['e1', 'e2']));
  });

  test('clearNeedsSynthesis clears specific entries', () => {
    db.clearNeedsSynthesis(['e1']);
    expect(db.countNeedsSynthesis()).toBe(1);
    expect(db.listNeedsSynthesisEntryIds()).toEqual(['e2']);
  });

  test('markAllNeedsSynthesis resets all to 1', () => {
    db.clearNeedsSynthesis(['e1', 'e2']);
    expect(db.countNeedsSynthesis()).toBe(0);
    db.markAllNeedsSynthesis();
    expect(db.countNeedsSynthesis()).toBe(2);
  });

  test('markCoTopicEntriesStale marks co-topic entries', () => {
    db.upsertTopic({ topicId: 't1', title: 'T', summary: 'S', content: 'C', updatedAt: now });
    db.assignEntries('t1', ['e1', 'e2']);
    db.clearNeedsSynthesis(['e1', 'e2']);
    // Mark e1 as "deleted" → e2 should become stale (shared topic).
    // e1 itself is excluded (the method assumes it's being deleted).
    db.markCoTopicEntriesStale(['e1']);
    expect(db.countNeedsSynthesis()).toBe(1);
    expect(db.listNeedsSynthesisEntryIds()).toEqual(['e2']);
  });
});

describe('god-node detection', () => {
  const now = new Date().toISOString();

  test('detectGodNodes returns empty when no outliers', () => {
    db.upsertTopic({ topicId: 'a', title: 'A', summary: 'S', content: 'C', updatedAt: now });
    db.upsertTopic({ topicId: 'b', title: 'B', summary: 'S', content: 'C', updatedAt: now });
    expect(db.detectGodNodes()).toEqual([]);
  });

  test('detectGodNodes flags high-entry-count topics', () => {
    // Create topics with varying entry counts.
    const { rawId: gRawId, sha256: gSha } = makeRawFile('god-raw');
    db.insertRaw({
      rawId: gRawId, sha256: gSha, status: 'ingested', byteLength: 7,
      mimeType: 'text/plain', handler: null, uploadedAt: now, metadata: null,
    });
    // Create many entries for the "god" topic and few for others.
    for (let i = 0; i < 30; i++) {
      db.insertEntry({
        entryId: `e${i}`, rawId: gRawId, title: `E${i}`, slug: `e${i}`, summary: '',
        schemaVersion: 1, digestedAt: now, tags: [],
      });
    }
    db.upsertTopic({ topicId: 'god', title: 'God', summary: 'S', content: 'C', updatedAt: now });
    db.upsertTopic({ topicId: 'small1', title: 'S1', summary: 'S', content: 'C', updatedAt: now });
    db.upsertTopic({ topicId: 'small2', title: 'S2', summary: 'S', content: 'C', updatedAt: now });
    db.upsertTopic({ topicId: 'small3', title: 'S3', summary: 'S', content: 'C', updatedAt: now });
    // 30 entries in "god", 2 in small1, 2 in small2, 2 in small3 → avg ~9, 3x = ~27 → 30 > 27
    db.assignEntries('god', Array.from({ length: 30 }, (_, i) => `e${i}`));
    db.assignEntries('small1', ['e0', 'e1']);
    db.assignEntries('small2', ['e2', 'e3']);
    db.assignEntries('small3', ['e4', 'e5']);

    const gods = db.detectGodNodes();
    expect(gods).toContain('god');
    expect(gods).not.toContain('small1');
  });
});

describe('wipeSynthesis', () => {
  const now = new Date().toISOString();

  test('removes all topics, connections, and meta', () => {
    db.upsertTopic({ topicId: 't1', title: 'T', summary: 'S', content: 'C', updatedAt: now });
    db.upsertTopic({ topicId: 't2', title: 'T2', summary: 'S', content: 'C', updatedAt: now });
    db.upsertConnection({
      sourceTopic: 't1', targetTopic: 't2', relationship: 'r',
      confidence: 'inferred', evidence: null,
    });
    db.setSynthesisMeta('status', 'idle');

    db.wipeSynthesis();

    expect(db.listTopics()).toHaveLength(0);
    expect(db.listAllConnections()).toHaveLength(0);
    // wipeSynthesis resets last_run_at to empty, but preserves status key.
    expect(db.getSynthesisMeta('last_run_at')).toBe('');
  });
});

describe('V1→V2 migration index ordering', () => {
  // Regression: the needs_synthesis partial index used to live in SCHEMA_DDL,
  // which runs before _migrateV2(). On V1 databases the column doesn't exist
  // yet, so CREATE INDEX failed and the DB couldn't open. The fix moves the
  // index creation to _initSchema() AFTER _migrateV2().
  test('opening a V1 database with entries succeeds and creates the index', () => {
    // Build a V1-shaped DB manually: entries table WITHOUT needs_synthesis.
    db.close();
    fs.rmSync(dbPath, { force: true });
    const Database = require('better-sqlite3');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '1');
      INSERT INTO meta (key, value) VALUES ('created_at', '2026-01-01T00:00:00Z');
      CREATE TABLE raw (
        raw_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, status TEXT NOT NULL,
        byte_length INTEGER NOT NULL, mime_type TEXT, handler TEXT,
        uploaded_at TEXT NOT NULL, digested_at TEXT, error_class TEXT,
        error_message TEXT, metadata_json TEXT
      );
      CREATE TABLE folders (folder_path TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      INSERT INTO folders (folder_path, created_at) VALUES ('', '2026-01-01T00:00:00Z');
      CREATE TABLE raw_locations (
        raw_id TEXT NOT NULL, folder_path TEXT NOT NULL, filename TEXT NOT NULL,
        uploaded_at TEXT NOT NULL, PRIMARY KEY (raw_id, folder_path, filename)
      );
      CREATE TABLE entries (
        entry_id TEXT PRIMARY KEY, raw_id TEXT NOT NULL, title TEXT NOT NULL,
        slug TEXT NOT NULL, summary TEXT NOT NULL, schema_version INTEGER NOT NULL,
        stale_schema INTEGER NOT NULL DEFAULT 0, digested_at TEXT NOT NULL
      );
      CREATE TABLE entry_tags (
        entry_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (entry_id, tag)
      );
      CREATE TABLE synthesis_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE synthesis_topics (
        topic_id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT,
        content TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE synthesis_topic_entries (
        topic_id TEXT NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY (topic_id, entry_id)
      );
      CREATE TABLE synthesis_connections (
        source_topic TEXT NOT NULL, target_topic TEXT NOT NULL,
        relationship TEXT NOT NULL, confidence TEXT NOT NULL DEFAULT 'inferred',
        evidence TEXT, PRIMARY KEY (source_topic, target_topic)
      );
    `);
    // Insert a raw + entry so needs_synthesis migration has rows to touch.
    raw.exec(`
      INSERT INTO raw (raw_id, sha256, status, byte_length, mime_type, handler, uploaded_at)
        VALUES ('r1', 'abc123', 'digested', 10, 'text/plain', 'passthrough/text', '2026-01-01T00:00:00Z');
      INSERT INTO entries (entry_id, raw_id, title, slug, summary, schema_version, digested_at)
        VALUES ('r1-test', 'r1', 'Test', 'test', 'sum', 1, '2026-01-01T00:00:00Z');
    `);
    raw.close();

    // Re-open via KbDatabase — this must NOT throw.
    const migrated = new KbDatabase(dbPath);
    try {
      expect(migrated.getSchemaVersion()).toBe(KB_DB_SCHEMA_VERSION);
      // The V2 column exists and the entry defaults to needs_synthesis=1.
      expect(migrated.countNeedsSynthesis()).toBe(1);
      // The index exists (verify by using it in a query).
      expect(migrated.listNeedsSynthesisEntryIds()).toEqual(['r1-test']);
    } finally {
      migrated.close();
    }
  });
});

describe('stale running status recovery', () => {
  test('reopening a DB with status=running resets it to idle', () => {
    db.setSynthesisMeta('status', 'running');
    expect(db.getSynthesisMeta('status')).toBe('running');
    db.close();

    // Re-open — simulates server restart.
    db = new KbDatabase(dbPath);
    expect(db.getSynthesisMeta('status')).toBe('idle');
  });

  test('does not touch idle or failed statuses on reopen', () => {
    db.setSynthesisMeta('status', 'failed');
    db.close();
    db = new KbDatabase(dbPath);
    expect(db.getSynthesisMeta('status')).toBe('failed');
  });
});

describe('getSynthesisSnapshot', () => {
  const now = new Date().toISOString();

  test('returns comprehensive snapshot', () => {
    db.upsertTopic({ topicId: 't1', title: 'T', summary: 'S', content: 'C', updatedAt: now });
    db.upsertTopic({ topicId: 't2', title: 'T2', summary: 'S', content: 'C', updatedAt: now });
    db.upsertConnection({
      sourceTopic: 't1', targetTopic: 't2', relationship: 'r',
      confidence: 'inferred', evidence: null,
    });
    db.setSynthesisMeta('status', 'idle');
    db.setSynthesisMeta('last_run_at', now);

    const snap = db.getSynthesisSnapshot();
    expect(snap.topicCount).toBe(2);
    expect(snap.connectionCount).toBe(1);
    expect(snap.status).toBe('idle');
    expect(snap.lastRunAt).toBe(now);
  });
});
