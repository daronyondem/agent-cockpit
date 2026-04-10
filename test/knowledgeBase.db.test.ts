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
