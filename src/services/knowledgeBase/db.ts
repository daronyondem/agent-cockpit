// ─── Knowledge Base SQLite layer ────────────────────────────────────────────
// Per-workspace state.db that owns the metadata index for the KB:
//   - raw: one row per content-addressed raw file
//   - folders: virtual folder tree (root = '')
//   - raw_locations: (rawId, folder, filename) junction; same rawId can
//     live in multiple folders (Option B multi-location)
//   - entries: digested entries (metadata only; bodies live on disk)
//   - entry_tags: tag index for search/browse
//
// All writes go through this class; no code outside `knowledgeBase/` should
// talk to the DB directly. Concurrency is single-threaded per workspace —
// the ingestion orchestrator funnels all work through a per-workspace FIFO,
// so we never need in-DB locking beyond the default WAL mode.
//
// Migration from Phase 1/2 `state.json` is handled by `openKbDatabase`,
// which is the only public entry point. It:
//   1. Opens (or creates) `state.db`
//   2. Runs the schema DDL (idempotent — CREATE TABLE IF NOT EXISTS)
//   3. If the DB is brand-new AND a legacy `state.json` exists, reads the
//      JSON, re-hashes each raw file from disk to populate the sha256
//      column, and inserts raw + raw_locations rows in a single tx
//   4. Renames the old JSON to `state.json.migrated` as a safety copy
//   5. Returns a ready-to-use `KbDatabase` instance

import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type {
  KbCounters,
  KbEntry,
  KbErrorClass,
  KbFolder,
  KbRawEntry,
  KbRawStatus,
} from '../../types';

/** Version of the DB's own schema. Bumped on destructive schema changes. */
export const KB_DB_SCHEMA_VERSION = 1;

/** Default page size for folder listings. */
export const DEFAULT_RAW_PAGE_SIZE = 500;

/**
 * Idempotent DDL — safe to run on every open. `CREATE TABLE IF NOT EXISTS`
 * keeps it a no-op on established DBs; fresh DBs get the full shape.
 */
const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS raw (
    raw_id        TEXT PRIMARY KEY,
    sha256        TEXT NOT NULL,
    status        TEXT NOT NULL,
    byte_length   INTEGER NOT NULL,
    mime_type     TEXT,
    handler       TEXT,
    uploaded_at   TEXT NOT NULL,
    digested_at   TEXT,
    error_class   TEXT,
    error_message TEXT,
    metadata_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_raw_status ON raw(status);
  CREATE INDEX IF NOT EXISTS idx_raw_sha256 ON raw(sha256);

  CREATE TABLE IF NOT EXISTS folders (
    folder_path TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS raw_locations (
    raw_id      TEXT NOT NULL REFERENCES raw(raw_id) ON DELETE CASCADE,
    folder_path TEXT NOT NULL REFERENCES folders(folder_path) ON DELETE RESTRICT,
    filename    TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    PRIMARY KEY (raw_id, folder_path, filename)
  );
  CREATE INDEX IF NOT EXISTS idx_raw_loc_folder   ON raw_locations(folder_path);
  CREATE INDEX IF NOT EXISTS idx_raw_loc_filename ON raw_locations(filename);

  CREATE TABLE IF NOT EXISTS entries (
    entry_id       TEXT PRIMARY KEY,
    raw_id         TEXT NOT NULL REFERENCES raw(raw_id) ON DELETE CASCADE,
    title          TEXT NOT NULL,
    slug           TEXT NOT NULL,
    summary        TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    stale_schema   INTEGER NOT NULL DEFAULT 0,
    digested_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_entries_raw ON entries(raw_id);

  CREATE TABLE IF NOT EXISTS entry_tags (
    entry_id TEXT NOT NULL REFERENCES entries(entry_id) ON DELETE CASCADE,
    tag      TEXT NOT NULL,
    PRIMARY KEY (entry_id, tag)
  );
  CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON entry_tags(tag);
`;

/** Raw DB row shape for the `raw` table. */
interface RawDbRow {
  raw_id: string;
  sha256: string;
  status: string;
  byte_length: number;
  mime_type: string | null;
  handler: string | null;
  uploaded_at: string;
  digested_at: string | null;
  error_class: string | null;
  error_message: string | null;
  metadata_json: string | null;
}

/** Raw DB row shape for the joined `raw + raw_locations` result. */
interface RawJoinRow extends RawDbRow {
  location_folder_path: string;
  location_filename: string;
  location_uploaded_at: string;
}

/** Parameters for inserting a brand-new raw row. */
export interface InsertRawParams {
  rawId: string;
  sha256: string;
  status: KbRawStatus;
  byteLength: number;
  mimeType: string | null;
  handler: string | null;
  uploadedAt: string;
  metadata: Record<string, unknown> | null;
}

/** Parameters for inserting a location for an existing raw. */
export interface InsertLocationParams {
  rawId: string;
  folderPath: string;
  filename: string;
  uploadedAt: string;
}

/** Parameters for inserting a digested entry. */
export interface InsertEntryParams {
  entryId: string;
  rawId: string;
  title: string;
  slug: string;
  summary: string;
  schemaVersion: number;
  digestedAt: string;
  tags: string[];
}

/** Stored error details for a raw row (when status === 'failed'). */
export interface RawError {
  errorClass: KbErrorClass;
  errorMessage: string;
}

/** One row in the raw_locations table, typed. */
export interface LocationRow {
  rawId: string;
  folderPath: string;
  filename: string;
  uploadedAt: string;
}

/**
 * Wrapper over a per-workspace SQLite database. Owns one `Database`
 * handle and a set of prepared statements. All methods are synchronous
 * (better-sqlite3 style) — async wouldn't help because the DB lives on
 * the same thread as the caller.
 */
export class KbDatabase {
  private readonly db: BetterSqlite3Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    // WAL gives us concurrent reads during a write and better crash
    // recovery than the default rollback journal. Foreign keys are off
    // by default in SQLite; we need them on for ON DELETE CASCADE to
    // work on the raw → entries → entry_tags chain.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._initSchema();
    this._ensureRootFolder();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  /** Run `fn` inside a transaction. Rolls back on any throw. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── Meta ─────────────────────────────────────────────────────────────────

  getSchemaVersion(): number {
    const row = this.db
      .prepare<unknown[], { value: string }>(
        'SELECT value FROM meta WHERE key = ?',
      )
      .get('schema_version');
    return row ? Number(row.value) : KB_DB_SCHEMA_VERSION;
  }

  // ── Folders ──────────────────────────────────────────────────────────────

  listFolders(): KbFolder[] {
    const rows = this.db
      .prepare<unknown[], { folder_path: string; created_at: string }>(
        'SELECT folder_path, created_at FROM folders ORDER BY folder_path',
      )
      .all();
    return rows.map((r) => ({ folderPath: r.folder_path, createdAt: r.created_at }));
  }

  folderExists(folderPath: string): boolean {
    const row = this.db
      .prepare<unknown[], { folder_path: string }>(
        'SELECT folder_path FROM folders WHERE folder_path = ?',
      )
      .get(folderPath);
    return Boolean(row);
  }

  /**
   * Create `folderPath` and any missing ancestors. Idempotent — calling
   * on an existing folder is a no-op. Root ('') is always present.
   */
  createFolder(folderPath: string): void {
    const normalized = normalizeFolderPath(folderPath);
    if (normalized === '') return; // root always exists

    // Build the ancestor chain: 'a/b/c' → ['a', 'a/b', 'a/b/c']
    const segments = normalized.split('/');
    const chain: string[] = [];
    let acc = '';
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      chain.push(acc);
    }
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO folders (folder_path, created_at) VALUES (?, ?)',
    );
    this.transaction(() => {
      for (const fp of chain) insert.run(fp, now);
    });
  }

  /**
   * Rename `fromPath` to `toPath`, cascading to all descendant folders
   * and every `raw_locations` row in the subtree. Throws if `fromPath`
   * doesn't exist or `toPath` (or any descendant target) already does.
   */
  renameFolder(fromPath: string, toPath: string): void {
    const from = normalizeFolderPath(fromPath);
    const to = normalizeFolderPath(toPath);
    if (from === '') throw new Error('Cannot rename root folder.');
    if (to === '') throw new Error('Cannot rename folder to root.');
    if (from === to) return;

    this.transaction(() => {
      if (!this.folderExists(from)) {
        throw new Error(`Folder ${from} does not exist.`);
      }
      // Collision check: the new name itself + any descendant collisions.
      // We check both the direct target and the prefix rewrite of every
      // existing descendant under `from` against what would become their
      // new path under `to`.
      if (this.folderExists(to)) {
        throw new Error(`Folder ${to} already exists.`);
      }
      const descendants = this.db
        .prepare<unknown[], { folder_path: string }>(
          "SELECT folder_path FROM folders WHERE folder_path LIKE ? || '/%' ORDER BY folder_path",
        )
        .all(from);
      for (const d of descendants) {
        const rewritten = to + d.folder_path.slice(from.length);
        if (this.folderExists(rewritten)) {
          throw new Error(`Folder ${rewritten} already exists (would collide on rename).`);
        }
      }

      // Ensure every ancestor of `to` exists (same as createFolder on a
      // missing parent chain). We need this because we're about to insert
      // the rename target before deleting the old one, and it has a PK
      // constraint on folder_path — we can't rename to a non-existent
      // parent without creating the parent first.
      const toSegments = to.split('/');
      let acc = '';
      const now = new Date().toISOString();
      const insertFolder = this.db.prepare(
        'INSERT OR IGNORE INTO folders (folder_path, created_at) VALUES (?, ?)',
      );
      // All ancestors of `to` except the target itself.
      for (let i = 0; i < toSegments.length - 1; i += 1) {
        acc = acc ? `${acc}/${toSegments[i]}` : toSegments[i];
        insertFolder.run(acc, now);
      }

      // SQLite doesn't support UPDATE on a PK directly while a FK still
      // references the old value — we'd hit an FK violation on
      // raw_locations. Workaround: insert the new folder, re-parent the
      // locations to the new folder, then delete the old folder.
      //
      // Do this in reverse depth order so children move before parents
      // (parents are the PK the children reference).
      const allFolders = [
        { from, to },
        ...descendants.map((d) => ({
          from: d.folder_path,
          to: to + d.folder_path.slice(from.length),
        })),
      ];
      // Deepest first for INSERTs so children exist before their moves.
      // Actually, INSERT order doesn't matter — no FK from folders to
      // folders. But deleting in deepest-first order matters to avoid
      // RESTRICT violations between raw_locations and folders.
      for (const pair of allFolders) {
        insertFolder.run(pair.to, now);
      }
      // Move raw_locations from each old folder to its new counterpart.
      const moveLocations = this.db.prepare(
        'UPDATE raw_locations SET folder_path = ? WHERE folder_path = ?',
      );
      for (const pair of allFolders) {
        moveLocations.run(pair.to, pair.from);
      }
      // Delete deepest old folders first (they can't be referenced by
      // raw_locations any more because we just moved them).
      const deleteFolder = this.db.prepare(
        'DELETE FROM folders WHERE folder_path = ?',
      );
      const sortedDeep = [...allFolders].sort(
        (a, b) => b.from.length - a.from.length,
      );
      for (const pair of sortedDeep) {
        deleteFolder.run(pair.from);
      }
    });
  }

  /**
   * Delete `folderPath`. Does NOT cascade to children. Callers that want
   * to drop a non-empty folder must first transition every
   * `raw_locations` row in the subtree out (either to another folder or
   * via `removeLocation`). This keeps cascade semantics explicit in the
   * orchestrator rather than hidden in the FK layer.
   */
  deleteFolder(folderPath: string): void {
    const normalized = normalizeFolderPath(folderPath);
    if (normalized === '') throw new Error('Cannot delete root folder.');
    this.db
      .prepare('DELETE FROM folders WHERE folder_path = ?')
      .run(normalized);
  }

  /**
   * Find every folder whose path is `folderPath` itself or starts with
   * `folderPath + '/'`. Used by the cascade-delete logic to enumerate
   * the subtree.
   */
  listFolderSubtree(folderPath: string): KbFolder[] {
    const normalized = normalizeFolderPath(folderPath);
    const rows = this.db
      .prepare<unknown[], { folder_path: string; created_at: string }>(
        "SELECT folder_path, created_at FROM folders WHERE folder_path = ? OR folder_path LIKE ? || '/%' ORDER BY LENGTH(folder_path) DESC",
      )
      .all(normalized, normalized);
    return rows.map((r) => ({ folderPath: r.folder_path, createdAt: r.created_at }));
  }

  // ── Raw files ────────────────────────────────────────────────────────────

  getRawById(rawId: string): RawDbRow | null {
    const row = this.db
      .prepare<unknown[], RawDbRow>('SELECT * FROM raw WHERE raw_id = ?')
      .get(rawId);
    return row ?? null;
  }

  getRawBySha(sha256: string): RawDbRow | null {
    const row = this.db
      .prepare<unknown[], RawDbRow>('SELECT * FROM raw WHERE sha256 = ?')
      .get(sha256);
    return row ?? null;
  }

  insertRaw(params: InsertRawParams): void {
    this.db
      .prepare(
        `INSERT INTO raw
         (raw_id, sha256, status, byte_length, mime_type, handler, uploaded_at, digested_at, error_class, error_message, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      )
      .run(
        params.rawId,
        params.sha256,
        params.status,
        params.byteLength,
        params.mimeType,
        params.handler,
        params.uploadedAt,
        params.metadata ? JSON.stringify(params.metadata) : null,
      );
  }

  updateRawStatus(
    rawId: string,
    status: KbRawStatus,
    error: RawError | null = null,
  ): void {
    this.db
      .prepare(
        'UPDATE raw SET status = ?, error_class = ?, error_message = ? WHERE raw_id = ?',
      )
      .run(status, error?.errorClass ?? null, error?.errorMessage ?? null, rawId);
  }

  setRawDigestedAt(rawId: string, digestedAt: string): void {
    this.db
      .prepare('UPDATE raw SET digested_at = ? WHERE raw_id = ?')
      .run(digestedAt, rawId);
  }

  setRawHandler(rawId: string, handler: string): void {
    this.db
      .prepare('UPDATE raw SET handler = ? WHERE raw_id = ?')
      .run(handler, rawId);
  }

  setRawMetadata(rawId: string, metadata: Record<string, unknown> | null): void {
    this.db
      .prepare('UPDATE raw SET metadata_json = ? WHERE raw_id = ?')
      .run(metadata ? JSON.stringify(metadata) : null, rawId);
  }

  /**
   * Delete a raw row. Returns the list of entry IDs that were cascade
   * deleted (so the caller can remove their on-disk directories). Does
   * NOT delete the raw bytes on disk — that's the orchestrator's job.
   */
  deleteRaw(rawId: string): string[] {
    return this.transaction(() => {
      const entries = this.db
        .prepare<unknown[], { entry_id: string }>(
          'SELECT entry_id FROM entries WHERE raw_id = ?',
        )
        .all(rawId)
        .map((r) => r.entry_id);
      // raw cascades → entries + entry_tags; raw_locations cascades too.
      this.db.prepare('DELETE FROM raw WHERE raw_id = ?').run(rawId);
      return entries;
    });
  }

  // ── Raw locations ────────────────────────────────────────────────────────

  addLocation(params: InsertLocationParams): void {
    const folderPath = normalizeFolderPath(params.folderPath);
    this.createFolder(folderPath); // idempotent
    this.db
      .prepare(
        'INSERT INTO raw_locations (raw_id, folder_path, filename, uploaded_at) VALUES (?, ?, ?, ?)',
      )
      .run(params.rawId, folderPath, params.filename, params.uploadedAt);
  }

  removeLocation(rawId: string, folderPath: string, filename: string): void {
    this.db
      .prepare(
        'DELETE FROM raw_locations WHERE raw_id = ? AND folder_path = ? AND filename = ?',
      )
      .run(rawId, normalizeFolderPath(folderPath), filename);
  }

  countLocations(rawId: string): number {
    const row = this.db
      .prepare<unknown[], { n: number }>(
        'SELECT COUNT(*) AS n FROM raw_locations WHERE raw_id = ?',
      )
      .get(rawId);
    return row?.n ?? 0;
  }

  findLocation(folderPath: string, filename: string): LocationRow | null {
    const row = this.db
      .prepare<
        unknown[],
        {
          raw_id: string;
          folder_path: string;
          filename: string;
          uploaded_at: string;
        }
      >(
        'SELECT raw_id, folder_path, filename, uploaded_at FROM raw_locations WHERE folder_path = ? AND filename = ?',
      )
      .get(normalizeFolderPath(folderPath), filename);
    if (!row) return null;
    return {
      rawId: row.raw_id,
      folderPath: row.folder_path,
      filename: row.filename,
      uploadedAt: row.uploaded_at,
    };
  }

  listLocations(rawId: string): LocationRow[] {
    const rows = this.db
      .prepare<
        unknown[],
        {
          raw_id: string;
          folder_path: string;
          filename: string;
          uploaded_at: string;
        }
      >(
        'SELECT raw_id, folder_path, filename, uploaded_at FROM raw_locations WHERE raw_id = ? ORDER BY folder_path, filename',
      )
      .all(rawId);
    return rows.map((r) => ({
      rawId: r.raw_id,
      folderPath: r.folder_path,
      filename: r.filename,
      uploadedAt: r.uploaded_at,
    }));
  }

  /**
   * List raw files in a specific folder (joined with their location
   * filename). Returns one row per (rawId, filename) combination — same
   * rawId listed twice if the same bytes were uploaded under two names
   * in this folder (rare but legal).
   */
  listRawInFolder(
    folderPath: string,
    opts: { limit?: number; offset?: number } = {},
  ): KbRawEntry[] {
    const limit = opts.limit ?? DEFAULT_RAW_PAGE_SIZE;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare<unknown[], RawJoinRow>(
        `SELECT
           r.raw_id, r.sha256, r.status, r.byte_length, r.mime_type, r.handler,
           r.uploaded_at, r.digested_at, r.error_class, r.error_message, r.metadata_json,
           l.folder_path AS location_folder_path,
           l.filename    AS location_filename,
           l.uploaded_at AS location_uploaded_at
         FROM raw_locations l
         JOIN raw r ON r.raw_id = l.raw_id
         WHERE l.folder_path = ?
         ORDER BY l.filename
         LIMIT ? OFFSET ?`,
      )
      .all(normalizeFolderPath(folderPath), limit, offset);
    return rows.map(rawJoinRowToEntry);
  }

  /**
   * List raw files with `status = 'pending-delete'` across the whole
   * workspace. Used by the "Digest All Pending" batch runner. These
   * rows have no raw_locations (that's what triggered the pending-delete
   * transition) so they need their own listing path.
   */
  listPendingDeleteRaw(): RawDbRow[] {
    return this.db
      .prepare<unknown[], RawDbRow>(
        "SELECT * FROM raw WHERE status = 'pending-delete' ORDER BY raw_id",
      )
      .all();
  }

  /**
   * List raw IDs with `status = 'ingested'` across the whole workspace
   * (ready for digestion). Used by the "Digest All Pending" batch runner.
   */
  listIngestedRawIds(): string[] {
    return this.db
      .prepare<unknown[], { raw_id: string }>(
        "SELECT raw_id FROM raw WHERE status = 'ingested' ORDER BY raw_id",
      )
      .all()
      .map((r) => r.raw_id);
  }

  // ── Counters ─────────────────────────────────────────────────────────────

  getCounters(): KbCounters {
    const byStatusRows = this.db
      .prepare<unknown[], { status: string; n: number }>(
        'SELECT status, COUNT(*) AS n FROM raw GROUP BY status',
      )
      .all();
    const rawByStatus: Record<KbRawStatus, number> = {
      ingesting: 0,
      ingested: 0,
      digesting: 0,
      digested: 0,
      failed: 0,
      'pending-delete': 0,
    };
    let rawTotal = 0;
    for (const row of byStatusRows) {
      if (row.status in rawByStatus) {
        rawByStatus[row.status as KbRawStatus] = row.n;
      }
      rawTotal += row.n;
    }
    const entryCountRow = this.db
      .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM entries')
      .get();
    const folderCountRow = this.db
      .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM folders')
      .get();
    return {
      rawTotal,
      rawByStatus,
      entryCount: entryCountRow?.n ?? 0,
      pendingCount: rawByStatus.ingested + rawByStatus['pending-delete'],
      folderCount: folderCountRow?.n ?? 0,
    };
  }

  // ── Entries ──────────────────────────────────────────────────────────────

  insertEntry(params: InsertEntryParams): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO entries
           (entry_id, raw_id, title, slug, summary, schema_version, stale_schema, digested_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(
          params.entryId,
          params.rawId,
          params.title,
          params.slug,
          params.summary,
          params.schemaVersion,
          params.digestedAt,
        );
      const insertTag = this.db.prepare(
        'INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)',
      );
      for (const tag of params.tags) {
        insertTag.run(params.entryId, tag);
      }
    });
  }

  /**
   * Delete all entries for a raw ID and return their entryIds so the
   * caller can rm -rf `entries/<entryId>/` on disk. Used during redigest
   * and during raw purge.
   */
  deleteEntriesByRawId(rawId: string): string[] {
    return this.transaction(() => {
      const ids = this.db
        .prepare<unknown[], { entry_id: string }>(
          'SELECT entry_id FROM entries WHERE raw_id = ?',
        )
        .all(rawId)
        .map((r) => r.entry_id);
      // entry_tags cascades on entries delete.
      this.db.prepare('DELETE FROM entries WHERE raw_id = ?').run(rawId);
      return ids;
    });
  }

  entryExists(entryId: string): boolean {
    const row = this.db
      .prepare<unknown[], { entry_id: string }>(
        'SELECT entry_id FROM entries WHERE entry_id = ?',
      )
      .get(entryId);
    return Boolean(row);
  }

  countEntriesByRawId(rawId: string): number {
    const row = this.db
      .prepare<unknown[], { cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM entries WHERE raw_id = ?',
      )
      .get(rawId);
    return row?.cnt ?? 0;
  }

  getEntry(entryId: string): KbEntry | null {
    const row = this.db
      .prepare<
        unknown[],
        {
          entry_id: string;
          raw_id: string;
          title: string;
          slug: string;
          summary: string;
          schema_version: number;
          stale_schema: number;
          digested_at: string;
        }
      >(
        'SELECT entry_id, raw_id, title, slug, summary, schema_version, stale_schema, digested_at FROM entries WHERE entry_id = ?',
      )
      .get(entryId);
    if (!row) return null;
    return {
      entryId: row.entry_id,
      rawId: row.raw_id,
      title: row.title,
      slug: row.slug,
      summary: row.summary,
      schemaVersion: row.schema_version,
      staleSchema: row.stale_schema === 1,
      digestedAt: row.digested_at,
      tags: this._listTagsForEntry(row.entry_id),
    };
  }

  /**
   * List entries, optionally scoped by folder (via raw_locations join),
   * tag, or rawId. Results are ordered by title for a stable UI. The
   * tags array on each entry is populated via a secondary query — not
   * a JOIN — because multi-tag entries would otherwise duplicate rows.
   */
  listEntries(
    opts: {
      folderPath?: string;
      tag?: string;
      rawId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): KbEntry[] {
    const limit = opts.limit ?? DEFAULT_RAW_PAGE_SIZE;
    const offset = opts.offset ?? 0;

    const clauses: string[] = [];
    const params: Array<string | number> = [];
    let query = `SELECT DISTINCT e.entry_id, e.raw_id, e.title, e.slug, e.summary, e.schema_version, e.stale_schema, e.digested_at
                 FROM entries e`;
    if (opts.folderPath !== undefined) {
      query += ' JOIN raw_locations l ON l.raw_id = e.raw_id';
      clauses.push('l.folder_path = ?');
      params.push(normalizeFolderPath(opts.folderPath));
    }
    if (opts.tag !== undefined) {
      query += ' JOIN entry_tags t ON t.entry_id = e.entry_id';
      clauses.push('t.tag = ?');
      params.push(opts.tag);
    }
    if (opts.rawId !== undefined) {
      clauses.push('e.raw_id = ?');
      params.push(opts.rawId);
    }
    if (clauses.length > 0) {
      query += ' WHERE ' + clauses.join(' AND ');
    }
    query += ' ORDER BY e.title LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db
      .prepare<
        unknown[],
        {
          entry_id: string;
          raw_id: string;
          title: string;
          slug: string;
          summary: string;
          schema_version: number;
          stale_schema: number;
          digested_at: string;
        }
      >(query)
      .all(...params);
    return rows.map((r) => ({
      entryId: r.entry_id,
      rawId: r.raw_id,
      title: r.title,
      slug: r.slug,
      summary: r.summary,
      schemaVersion: r.schema_version,
      staleSchema: r.stale_schema === 1,
      digestedAt: r.digested_at,
      tags: this._listTagsForEntry(r.entry_id),
    }));
  }

  /**
   * Return true if an entry with `entryId` exists. Used by the digest
   * orchestrator to disambiguate slug collisions within one run by
   * appending `-2`, `-3`, etc.
   */
  entryIdTaken(entryId: string): boolean {
    return this.entryExists(entryId);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private _initSchema(): void {
    this.db.exec(SCHEMA_DDL);
    // Seed schema_version + created_at in meta if this is a fresh DB.
    const existing = this.db
      .prepare<unknown[], { value: string }>(
        'SELECT value FROM meta WHERE key = ?',
      )
      .get('schema_version');
    if (!existing) {
      const now = new Date().toISOString();
      const insert = this.db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?)',
      );
      insert.run('schema_version', String(KB_DB_SCHEMA_VERSION));
      insert.run('created_at', now);
    }
  }

  private _ensureRootFolder(): void {
    const row = this.db
      .prepare<unknown[], { folder_path: string }>(
        'SELECT folder_path FROM folders WHERE folder_path = ?',
      )
      .get('');
    if (!row) {
      this.db
        .prepare('INSERT INTO folders (folder_path, created_at) VALUES (?, ?)')
        .run('', new Date().toISOString());
    }
  }

  private _listTagsForEntry(entryId: string): string[] {
    return this.db
      .prepare<unknown[], { tag: string }>(
        'SELECT tag FROM entry_tags WHERE entry_id = ? ORDER BY tag',
      )
      .all(entryId)
      .map((r) => r.tag);
  }
}

// ─── Path helpers ────────────────────────────────────────────────────────────

const FOLDER_SEGMENT_RE = /^[^/\x00-\x1f]+$/;

/**
 * Validate and normalize a folder path. Strips leading/trailing slashes,
 * collapses repeated slashes, rejects `..`, control characters, empty
 * segments, and over-long paths. Returns '' for root.
 */
export function normalizeFolderPath(input: string): string {
  if (input === undefined || input === null) return '';
  const raw = String(input).trim();
  if (raw === '' || raw === '/') return '';
  if (raw.length > 4096) {
    throw new Error('Folder path is too long (max 4096 chars).');
  }
  const segments = raw.split('/').filter((s) => s !== '');
  if (segments.length === 0) return '';
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new Error(`Invalid folder segment: "${seg}"`);
    }
    if (seg.length > 128) {
      throw new Error(`Folder segment too long (max 128 chars): "${seg}"`);
    }
    if (!FOLDER_SEGMENT_RE.test(seg)) {
      throw new Error(`Invalid folder segment: "${seg}"`);
    }
  }
  return segments.join('/');
}

// ─── Opener + migration ─────────────────────────────────────────────────────

/** Options for `openKbDatabase`. */
export interface OpenKbDatabaseOptions {
  /** Absolute path to the workspace's `knowledge/state.db`. */
  dbPath: string;
  /** Absolute path to the legacy `knowledge/state.json`, if any. */
  legacyJsonPath: string;
  /** Absolute path to `knowledge/raw/` for re-hashing migrated files. */
  rawDir: string;
}

/** Shape of the Phase 1/2 `state.json` we migrate from. */
interface LegacyKbState {
  version?: number;
  entrySchemaVersion?: number;
  raw?: Record<
    string,
    {
      rawId: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      uploadedAt: string;
      status: string;
      error?: string;
    }
  >;
}

/**
 * Open (or create) a KB database, handling one-shot migration from the
 * legacy `state.json` format if needed. Returns a ready-to-use instance.
 *
 * Migration rules:
 *   - If `state.db` already exists → open it, skip migration entirely.
 *   - Else if `state.json` exists → open a fresh DB, replay the JSON
 *     into the schema in one tx, then rename the JSON to
 *     `state.json.migrated` as a one-release safety copy.
 *   - Else → open a fresh DB with just the empty schema + root folder.
 *
 * Migration hashes each raw file from disk to populate the full sha256
 * column (the legacy format only kept the 16-char rawId). Files that
 * are missing on disk are inserted anyway with sha256 = rawId, with a
 * warning logged — this can only happen if someone tampered with the
 * raw/ directory, but we'd rather preserve the state row so the user
 * can see the broken entry in the UI than silently drop it.
 */
export function openKbDatabase(opts: OpenKbDatabaseOptions): KbDatabase {
  const { dbPath, legacyJsonPath, rawDir } = opts;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const dbAlreadyExists = fs.existsSync(dbPath);
  const db = new KbDatabase(dbPath);

  if (dbAlreadyExists) return db;

  // Fresh DB — check for legacy state.json to migrate.
  if (!fs.existsSync(legacyJsonPath)) return db;

  let legacy: LegacyKbState;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyJsonPath, 'utf8')) as LegacyKbState;
  } catch (err) {
    console.warn(
      `[kb:db] failed to parse legacy state.json at ${legacyJsonPath}: ${(err as Error).message}. Starting fresh.`,
    );
    return db;
  }

  const rawEntries = legacy.raw ?? {};
  const rawIds = Object.keys(rawEntries);
  if (rawIds.length === 0) {
    // Nothing to migrate — still rename the empty JSON so we don't
    // keep retrying.
    safeRename(legacyJsonPath, legacyJsonPath + '.migrated');
    return db;
  }

  db.transaction(() => {
    for (const rawId of rawIds) {
      const row = rawEntries[rawId];
      const ext = path.extname(row.filename) || '';
      const rawFilePath = path.join(rawDir, `${rawId}${ext}`);
      let sha256 = rawId;
      try {
        const buf = fs.readFileSync(rawFilePath);
        sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      } catch (err) {
        console.warn(
          `[kb:db] migration: could not re-hash ${rawFilePath}: ${(err as Error).message}. Falling back to rawId as sha256.`,
        );
      }
      // Migrated rows are always in the legacy terminal states; if a
      // row was stuck as 'ingesting' or 'digesting' at shutdown, snap
      // it to 'failed' so the user can retry it.
      let status: KbRawStatus = 'ingested';
      const legacyStatus = row.status;
      if (legacyStatus === 'ingested' || legacyStatus === 'digested' || legacyStatus === 'failed') {
        status = legacyStatus;
      } else {
        status = 'failed';
      }
      db.insertRaw({
        rawId,
        sha256,
        status,
        byteLength: row.sizeBytes,
        mimeType: row.mimeType,
        handler: null,
        uploadedAt: row.uploadedAt,
        metadata: null,
      });
      if (row.error) {
        db.updateRawStatus(rawId, status, {
          errorClass: 'unknown',
          errorMessage: row.error,
        });
      }
      db.addLocation({
        rawId,
        folderPath: '',
        filename: row.filename,
        uploadedAt: row.uploadedAt,
      });
    }
  });

  safeRename(legacyJsonPath, legacyJsonPath + '.migrated');
  return db;
}

function safeRename(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    console.warn(
      `[kb:db] could not rename ${from} → ${to}: ${(err as Error).message}`,
    );
  }
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function rawJoinRowToEntry(row: RawJoinRow): KbRawEntry {
  return {
    rawId: row.raw_id,
    sha256: row.sha256,
    filename: row.location_filename,
    folderPath: row.location_folder_path,
    mimeType: row.mime_type ?? 'application/octet-stream',
    sizeBytes: row.byte_length,
    handler: row.handler ?? undefined,
    uploadedAt: row.location_uploaded_at,
    digestedAt: row.digested_at,
    status: row.status as KbRawStatus,
    errorClass: (row.error_class as KbErrorClass | null) ?? null,
    errorMessage: row.error_message,
    metadata: row.metadata_json ? parseMetadata(row.metadata_json) : undefined,
  };
}

function parseMetadata(json: string): Record<string, unknown> | undefined {
  try {
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
