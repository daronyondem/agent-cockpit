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
export const KB_DB_SCHEMA_VERSION = 2;

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
    digested_at    TEXT NOT NULL,
    needs_synthesis INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_entries_raw ON entries(raw_id);

  CREATE TABLE IF NOT EXISTS entry_tags (
    entry_id TEXT NOT NULL REFERENCES entries(entry_id) ON DELETE CASCADE,
    tag      TEXT NOT NULL,
    PRIMARY KEY (entry_id, tag)
  );
  CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON entry_tags(tag);

  -- ── Synthesis (Dreaming) ──────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS synthesis_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS synthesis_topics (
    topic_id    TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    summary     TEXT,
    content     TEXT,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS synthesis_topic_entries (
    topic_id TEXT NOT NULL REFERENCES synthesis_topics(topic_id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL REFERENCES entries(entry_id) ON DELETE CASCADE,
    PRIMARY KEY (topic_id, entry_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ste_entry ON synthesis_topic_entries(entry_id);

  CREATE TABLE IF NOT EXISTS synthesis_connections (
    source_topic TEXT NOT NULL REFERENCES synthesis_topics(topic_id) ON DELETE CASCADE,
    target_topic TEXT NOT NULL REFERENCES synthesis_topics(topic_id) ON DELETE CASCADE,
    relationship TEXT NOT NULL,
    confidence   TEXT NOT NULL DEFAULT 'inferred',
    evidence     TEXT,
    PRIMARY KEY (source_topic, target_topic)
  );
  CREATE INDEX IF NOT EXISTS idx_conn_target ON synthesis_connections(target_topic);

  -- ── Reflections (Phase E) ─────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS synthesis_reflections (
    reflection_id  TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    type           TEXT NOT NULL,
    summary        TEXT,
    content        TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    original_citation_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS synthesis_reflection_citations (
    reflection_id TEXT NOT NULL REFERENCES synthesis_reflections(reflection_id) ON DELETE CASCADE,
    entry_id      TEXT NOT NULL REFERENCES entries(entry_id) ON DELETE CASCADE,
    PRIMARY KEY (reflection_id, entry_id)
  );
  CREATE INDEX IF NOT EXISTS idx_src_entry ON synthesis_reflection_citations(entry_id);

  -- ── Digestion session (issue #148) ────────────────────────────────────────
  -- Singleton row (id = 1) tracking aggregate digest-queue progress so a
  -- mid-flight page reload can rehydrate the toolbar progress + ETA.
  -- Present only while the per-workspace queue is busy; deleted when the
  -- last task settles. total_elapsed_ms sums per-file digestion durations
  -- (avg = total_elapsed_ms / done).
  CREATE TABLE IF NOT EXISTS digest_session (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    total             INTEGER NOT NULL,
    done              INTEGER NOT NULL,
    total_elapsed_ms  INTEGER NOT NULL,
    started_at        TEXT NOT NULL
  );
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
  entry_count: number;
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

// ── Synthesis types ─────────────────────────────────────────────────────────

/** Parameters for inserting/updating a synthesis topic. */
export interface UpsertTopicParams {
  topicId: string;
  title: string;
  summary: string | null;
  content: string | null;
  updatedAt: string;
}

/** Parameters for inserting a synthesis connection. */
export interface InsertConnectionParams {
  sourceTopic: string;
  targetTopic: string;
  relationship: string;
  confidence: string;
  evidence: string | null;
}

/** DB row shape for synthesis_topics. */
export interface SynthesisTopicRow {
  topicId: string;
  title: string;
  summary: string | null;
  content: string | null;
  updatedAt: string;
  entryCount: number;
  connectionCount: number;
}

/** DB row shape for synthesis_connections. */
export interface SynthesisConnectionRow {
  sourceTopic: string;
  targetTopic: string;
  relationship: string;
  confidence: string;
  evidence: string | null;
}

/** DB row shape for synthesis_reflections. */
export interface SynthesisReflectionRow {
  reflectionId: string;
  title: string;
  type: string;
  summary: string | null;
  content: string;
  createdAt: string;
  citationCount: number;
}

/** Parameters for inserting a reflection. */
export interface InsertReflectionParams {
  reflectionId: string;
  title: string;
  type: string;
  summary: string | null;
  content: string;
  createdAt: string;
  citedEntryIds: string[];
}

/** Synthesis status snapshot for API responses. */
export interface SynthesisSnapshot {
  status: string;
  lastRunAt: string | null;
  lastRunError: string | null;
  topicCount: number;
  connectionCount: number;
  needsSynthesisCount: number;
  godNodes: string[];
  dreamProgress: { phase: string; done: number; total: number } | null;
  reflectionCount: number;
  staleReflectionCount: number;
}

/** One row in the raw_locations table, typed. */
export interface LocationRow {
  rawId: string;
  folderPath: string;
  filename: string;
  uploadedAt: string;
}

/**
 * Singleton row persisted in `digest_session` so that mid-flight reloads
 * can rehydrate the workspace-level digestion progress (issue #148).
 * Present only while the per-workspace queue is busy.
 */
export interface DigestSessionRow {
  total: number;
  done: number;
  totalElapsedMs: number;
  startedAt: string;
}

/**
 * Filter options shared by `listEntries` and `countEntries`. All fields
 * are optional and combine with AND semantics (the multi-tag list is
 * itself an AND match — an entry must carry every listed tag).
 */
export interface ListEntriesFilter {
  folderPath?: string;
  /** Legacy single-tag filter. Merged into `tags` when both are supplied. */
  tag?: string;
  /** Multi-tag filter with AND semantics (entry must have all tags). */
  tags?: string[];
  rawId?: string;
  /** Case-insensitive substring match against entry title. */
  search?: string;
  /** ISO-8601 lower bound on `raw.uploaded_at` (inclusive). */
  uploadedFrom?: string;
  /** ISO-8601 upper bound on `raw.uploaded_at` (inclusive). */
  uploadedTo?: string;
  /** ISO-8601 lower bound on `entries.digested_at` (inclusive). */
  digestedFrom?: string;
  /** ISO-8601 upper bound on `entries.digested_at` (inclusive). */
  digestedTo?: string;
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
    this._recoverFromCrash();
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
      // synthesis_topic_entries and synthesis_reflection_citations also
      // cascade-delete, potentially leaving orphan topics.
      this.db.prepare('DELETE FROM raw WHERE raw_id = ?').run(rawId);
      this._deleteOrphanTopics();
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
           l.uploaded_at AS location_uploaded_at,
           COUNT(e.entry_id) AS entry_count
         FROM raw_locations l
         JOIN raw r ON r.raw_id = l.raw_id
         LEFT JOIN entries e ON e.raw_id = r.raw_id
         WHERE l.folder_path = ?
         GROUP BY r.raw_id, l.folder_path, l.filename, l.uploaded_at
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
    const topicCountRow = this.db
      .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM synthesis_topics')
      .get();
    const connectionCountRow = this.db
      .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM synthesis_connections')
      .get();
    const reflectionCountRow = this.db
      .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM synthesis_reflections')
      .get();
    return {
      rawTotal,
      rawByStatus,
      entryCount: entryCountRow?.n ?? 0,
      pendingCount: rawByStatus.ingested + rawByStatus['pending-delete'],
      folderCount: folderCountRow?.n ?? 0,
      topicCount: topicCountRow?.n ?? 0,
      connectionCount: connectionCountRow?.n ?? 0,
      reflectionCount: reflectionCountRow?.n ?? 0,
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
   * tag(s), rawId, title substring, uploaded date range (from the joined
   * `raw` row), or digested date range. Results are ordered by title
   * for a stable UI. The tags array on each entry is populated via a
   * secondary query — not a JOIN — because multi-tag entries would
   * otherwise duplicate rows. Multi-tag filtering uses AND semantics:
   * an entry must carry every tag in `opts.tags` (legacy single `tag`
   * is merged in).
   */
  listEntries(opts: ListEntriesFilter & { limit?: number; offset?: number } = {}): KbEntry[] {
    const limit = opts.limit ?? DEFAULT_RAW_PAGE_SIZE;
    const offset = opts.offset ?? 0;
    const { joinSql, whereSql, havingSql, params } = this._buildEntryFilter(opts);
    const query = `SELECT e.entry_id, e.raw_id, e.title, e.slug, e.summary, e.schema_version, e.stale_schema, e.digested_at
                   FROM entries e${joinSql}${whereSql}
                   GROUP BY e.entry_id${havingSql}
                   ORDER BY e.title
                   LIMIT ? OFFSET ?`;
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
      .all(...params, limit, offset);
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
   * Count entries matching the same filter options as `listEntries`,
   * without LIMIT/OFFSET. Used by the UI to render page counts.
   */
  countEntries(opts: ListEntriesFilter = {}): number {
    const { joinSql, whereSql, havingSql, params } = this._buildEntryFilter(opts);
    const query = `SELECT COUNT(*) AS n FROM (
                     SELECT e.entry_id FROM entries e${joinSql}${whereSql}
                     GROUP BY e.entry_id${havingSql}
                   ) AS t`;
    const row = this.db.prepare<unknown[], { n: number }>(query).get(...params);
    return row?.n ?? 0;
  }

  /**
   * Build the JOIN / WHERE / HAVING fragments shared by `listEntries`
   * and `countEntries`. Keeping both on the same builder guarantees the
   * filter set stays consistent — the pagination total can never
   * disagree with the page contents.
   */
  private _buildEntryFilter(opts: ListEntriesFilter): {
    joinSql: string;
    whereSql: string;
    havingSql: string;
    params: Array<string | number>;
  } {
    const joins: string[] = [];
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    let havingSql = '';

    if (opts.folderPath !== undefined) {
      joins.push('JOIN raw_locations l ON l.raw_id = e.raw_id');
      clauses.push('l.folder_path = ?');
      params.push(normalizeFolderPath(opts.folderPath));
    }

    // Merge legacy single `tag` into multi-tag list, de-dupe, AND-match.
    const tagList: string[] = [];
    if (opts.tag !== undefined && opts.tag !== '') tagList.push(opts.tag);
    if (Array.isArray(opts.tags)) {
      for (const t of opts.tags) {
        if (typeof t === 'string' && t.trim() !== '') tagList.push(t.trim());
      }
    }
    const uniqueTags = Array.from(new Set(tagList));
    if (uniqueTags.length > 0) {
      joins.push('JOIN entry_tags et ON et.entry_id = e.entry_id');
      clauses.push(`et.tag IN (${uniqueTags.map(() => '?').join(',')})`);
      params.push(...uniqueTags);
      havingSql = ` HAVING COUNT(DISTINCT et.tag) = ${uniqueTags.length}`;
    }

    if (opts.rawId !== undefined) {
      clauses.push('e.raw_id = ?');
      params.push(opts.rawId);
    }

    if (opts.search !== undefined && opts.search.trim() !== '') {
      clauses.push("e.title LIKE ? ESCAPE '\\' COLLATE NOCASE");
      params.push('%' + opts.search.trim().replace(/[\\%_]/g, (c) => '\\' + c) + '%');
    }

    if (opts.digestedFrom !== undefined && opts.digestedFrom !== '') {
      clauses.push('e.digested_at >= ?');
      params.push(opts.digestedFrom);
    }
    if (opts.digestedTo !== undefined && opts.digestedTo !== '') {
      clauses.push('e.digested_at <= ?');
      params.push(opts.digestedTo);
    }

    const hasUploadedFilter =
      (opts.uploadedFrom !== undefined && opts.uploadedFrom !== '') ||
      (opts.uploadedTo !== undefined && opts.uploadedTo !== '');
    if (hasUploadedFilter) {
      joins.push('JOIN raw r ON r.raw_id = e.raw_id');
      if (opts.uploadedFrom !== undefined && opts.uploadedFrom !== '') {
        clauses.push('r.uploaded_at >= ?');
        params.push(opts.uploadedFrom);
      }
      if (opts.uploadedTo !== undefined && opts.uploadedTo !== '') {
        clauses.push('r.uploaded_at <= ?');
        params.push(opts.uploadedTo);
      }
    }

    return {
      joinSql: joins.length ? ' ' + joins.join(' ') : '',
      whereSql: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '',
      havingSql,
      params,
    };
  }

  /**
   * List every distinct tag in use across the KB with its entry count.
   * Feeds the entries-tab tag picker. Ordered by most-used first, then
   * alphabetically, so common tags surface at the top.
   */
  listAllTags(): Array<{ tag: string; count: number }> {
    return this.db
      .prepare<unknown[], { tag: string; count: number }>(
        'SELECT tag, COUNT(*) AS count FROM entry_tags GROUP BY tag ORDER BY count DESC, tag ASC',
      )
      .all();
  }

  /**
   * Return true if an entry with `entryId` exists. Used by the digest
   * orchestrator to disambiguate slug collisions within one run by
   * appending `-2`, `-3`, etc.
   */
  entryIdTaken(entryId: string): boolean {
    return this.entryExists(entryId);
  }

  // ── Synthesis (Dreaming) ──────────────────────────────────────────────────

  /** Get a synthesis_meta value by key, or null if missing. */
  getSynthesisMeta(key: string): string | null {
    const row = this.db
      .prepare<unknown[], { value: string }>(
        'SELECT value FROM synthesis_meta WHERE key = ?',
      )
      .get(key);
    return row?.value ?? null;
  }

  /** Set a synthesis_meta value (upsert). */
  setSynthesisMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO synthesis_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  /** Get the full synthesis status snapshot for API responses. */
  getSynthesisSnapshot(): SynthesisSnapshot {
    const status = this.getSynthesisMeta('status') ?? 'idle';
    const lastRunAt = this.getSynthesisMeta('last_run_at');
    const lastRunError = this.getSynthesisMeta('last_run_error');
    const godNodesRaw = this.getSynthesisMeta('god_nodes');
    const godNodes: string[] = godNodesRaw ? JSON.parse(godNodesRaw) : [];
    const dreamProgressRaw = this.getSynthesisMeta('dream_progress');
    let dreamProgress: SynthesisSnapshot['dreamProgress'] = null;
    if (dreamProgressRaw) {
      try { dreamProgress = JSON.parse(dreamProgressRaw); } catch { /* ignore */ }
    }

    const topicCountRow = this.db
      .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM synthesis_topics')
      .get();
    const connCountRow = this.db
      .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM synthesis_connections')
      .get();
    const needsRow = this.db
      .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM entries WHERE needs_synthesis = 1')
      .get();

    const reflectionCountRow = this.db
      .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM synthesis_reflections')
      .get();
    const staleReflectionCount = this._countStaleReflections();

    return {
      status,
      lastRunAt,
      lastRunError,
      topicCount: topicCountRow?.n ?? 0,
      connectionCount: connCountRow?.n ?? 0,
      needsSynthesisCount: needsRow?.n ?? 0,
      godNodes,
      dreamProgress,
      reflectionCount: reflectionCountRow?.n ?? 0,
      staleReflectionCount,
    };
  }

  /** Count entries that need synthesis. */
  countNeedsSynthesis(): number {
    const row = this.db
      .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM entries WHERE needs_synthesis = 1')
      .get();
    return row?.n ?? 0;
  }

  /** List entry IDs that need synthesis (for the dreaming pipeline). */
  listNeedsSynthesisEntryIds(): string[] {
    return this.db
      .prepare<unknown[], { entry_id: string }>(
        'SELECT entry_id FROM entries WHERE needs_synthesis = 1 ORDER BY entry_id',
      )
      .all()
      .map((r) => r.entry_id);
  }

  /** Mark entries as no longer needing synthesis. */
  clearNeedsSynthesis(entryIds: string[]): void {
    if (entryIds.length === 0) return;
    const placeholders = entryIds.map(() => '?').join(', ');
    this.db
      .prepare(`UPDATE entries SET needs_synthesis = 0 WHERE entry_id IN (${placeholders})`)
      .run(...entryIds);
  }

  /** Mark all entries as needing synthesis (for full rebuild). */
  markAllNeedsSynthesis(): void {
    this.db.exec('UPDATE entries SET needs_synthesis = 1');
  }

  /**
   * When entries are deleted, mark remaining entries that shared a topic
   * with the deleted ones as needing synthesis. This ensures topics
   * referencing deleted content get updated on the next dream run.
   */
  markCoTopicEntriesStale(deletedEntryIds: string[]): void {
    if (deletedEntryIds.length === 0) return;
    const placeholders = deletedEntryIds.map(() => '?').join(', ');
    // Find all entries that share a topic with any of the deleted entries,
    // excluding the deleted entries themselves.
    this.db
      .prepare(
        `UPDATE entries SET needs_synthesis = 1
         WHERE entry_id IN (
           SELECT DISTINCT ste2.entry_id
           FROM synthesis_topic_entries ste1
           JOIN synthesis_topic_entries ste2 ON ste1.topic_id = ste2.topic_id
           WHERE ste1.entry_id IN (${placeholders})
             AND ste2.entry_id NOT IN (${placeholders})
         )`,
      )
      .run(...deletedEntryIds, ...deletedEntryIds);
  }

  // ── Synthesis Topics ────────────────────────────────────────────────────

  upsertTopic(params: UpsertTopicParams): void {
    this.db
      .prepare(
        `INSERT INTO synthesis_topics (topic_id, title, summary, content, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(topic_id) DO UPDATE SET
           title = excluded.title,
           summary = excluded.summary,
           content = excluded.content,
           updated_at = excluded.updated_at`,
      )
      .run(params.topicId, params.title, params.summary, params.content, params.updatedAt);
  }

  deleteTopic(topicId: string): void {
    // CASCADE deletes synthesis_topic_entries and synthesis_connections rows.
    this.db
      .prepare('DELETE FROM synthesis_topics WHERE topic_id = ?')
      .run(topicId);
  }

  /**
   * Delete topics that have zero entries assigned. Called after entry
   * cascade-deletes (e.g. raw file deletion) to clean up orphans.
   */
  _deleteOrphanTopics(): void {
    this.db.exec(
      `DELETE FROM synthesis_topics WHERE topic_id NOT IN (
         SELECT DISTINCT topic_id FROM synthesis_topic_entries
       )`,
    );
  }

  getTopic(topicId: string): SynthesisTopicRow | null {
    const row = this.db
      .prepare<
        unknown[],
        { topic_id: string; title: string; summary: string | null; content: string | null; updated_at: string }
      >(
        'SELECT topic_id, title, summary, content, updated_at FROM synthesis_topics WHERE topic_id = ?',
      )
      .get(topicId);
    if (!row) return null;

    const entryCount = this.db
      .prepare<unknown[], { n: number }>(
        'SELECT COUNT(*) AS n FROM synthesis_topic_entries WHERE topic_id = ?',
      )
      .get(topicId)?.n ?? 0;

    const connectionCount = this.db
      .prepare<unknown[], { n: number }>(
        'SELECT COUNT(*) AS n FROM synthesis_connections WHERE source_topic = ? OR target_topic = ?',
      )
      .get(topicId, topicId)?.n ?? 0;

    return {
      topicId: row.topic_id,
      title: row.title,
      summary: row.summary,
      content: row.content,
      updatedAt: row.updated_at,
      entryCount,
      connectionCount,
    };
  }

  /** List all topics with entry and connection counts. */
  listTopics(): SynthesisTopicRow[] {
    const rows = this.db
      .prepare<
        unknown[],
        { topic_id: string; title: string; summary: string | null; content: string | null; updated_at: string; entry_count: number; conn_count: number }
      >(
        `SELECT
           t.topic_id, t.title, t.summary, t.content, t.updated_at,
           (SELECT COUNT(*) FROM synthesis_topic_entries WHERE topic_id = t.topic_id) AS entry_count,
           (SELECT COUNT(*) FROM synthesis_connections WHERE source_topic = t.topic_id OR target_topic = t.topic_id) AS conn_count
         FROM synthesis_topics t
         ORDER BY t.title`,
      )
      .all();
    return rows.map((r) => ({
      topicId: r.topic_id,
      title: r.title,
      summary: r.summary,
      content: r.content,
      updatedAt: r.updated_at,
      entryCount: r.entry_count,
      connectionCount: r.conn_count,
    }));
  }

  /** List all topics as lightweight summaries (for the all-topics.txt file). */
  listTopicSummaries(): Array<{ topicId: string; title: string; summary: string | null }> {
    return this.db
      .prepare<unknown[], { topic_id: string; title: string; summary: string | null }>(
        'SELECT topic_id, title, summary FROM synthesis_topics ORDER BY title',
      )
      .all()
      .map((r) => ({ topicId: r.topic_id, title: r.title, summary: r.summary }));
  }

  // ── Synthesis Topic-Entry Membership ────────────────────────────────────

  assignEntries(topicId: string, entryIds: string[]): void {
    if (entryIds.length === 0) return;
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO synthesis_topic_entries (topic_id, entry_id) VALUES (?, ?)',
    );
    for (const eid of entryIds) {
      stmt.run(topicId, eid);
    }
  }

  unassignEntries(topicId: string, entryIds: string[]): void {
    if (entryIds.length === 0) return;
    const stmt = this.db.prepare(
      'DELETE FROM synthesis_topic_entries WHERE topic_id = ? AND entry_id = ?',
    );
    for (const eid of entryIds) {
      stmt.run(topicId, eid);
    }
  }

  /** List entry IDs assigned to a topic. */
  listTopicEntryIds(topicId: string): string[] {
    return this.db
      .prepare<unknown[], { entry_id: string }>(
        'SELECT entry_id FROM synthesis_topic_entries WHERE topic_id = ? ORDER BY entry_id',
      )
      .all(topicId)
      .map((r) => r.entry_id);
  }

  /** List topics an entry belongs to. */
  listEntryTopicIds(entryId: string): string[] {
    return this.db
      .prepare<unknown[], { topic_id: string }>(
        'SELECT topic_id FROM synthesis_topic_entries WHERE entry_id = ? ORDER BY topic_id',
      )
      .all(entryId)
      .map((r) => r.topic_id);
  }

  // ── Synthesis Connections ───────────────────────────────────────────────

  upsertConnection(params: InsertConnectionParams): void {
    this.db
      .prepare(
        `INSERT INTO synthesis_connections (source_topic, target_topic, relationship, confidence, evidence)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_topic, target_topic) DO UPDATE SET
           relationship = excluded.relationship,
           confidence = excluded.confidence,
           evidence = excluded.evidence`,
      )
      .run(params.sourceTopic, params.targetTopic, params.relationship, params.confidence, params.evidence);
  }

  removeConnection(sourceTopic: string, targetTopic: string): void {
    this.db
      .prepare('DELETE FROM synthesis_connections WHERE source_topic = ? AND target_topic = ?')
      .run(sourceTopic, targetTopic);
  }

  /** List connections for a topic (both directions). */
  listConnectionsForTopic(topicId: string): SynthesisConnectionRow[] {
    const rows = this.db
      .prepare<
        unknown[],
        { source_topic: string; target_topic: string; relationship: string; confidence: string; evidence: string | null }
      >(
        `SELECT source_topic, target_topic, relationship, confidence, evidence
         FROM synthesis_connections
         WHERE source_topic = ? OR target_topic = ?
         ORDER BY source_topic, target_topic`,
      )
      .all(topicId, topicId);
    return rows.map((r) => ({
      sourceTopic: r.source_topic,
      targetTopic: r.target_topic,
      relationship: r.relationship,
      confidence: r.confidence,
      evidence: r.evidence,
    }));
  }

  /** List all connections (for connections.md generation). */
  listAllConnections(): SynthesisConnectionRow[] {
    const rows = this.db
      .prepare<
        unknown[],
        { source_topic: string; target_topic: string; relationship: string; confidence: string; evidence: string | null }
      >(
        'SELECT source_topic, target_topic, relationship, confidence, evidence FROM synthesis_connections ORDER BY source_topic, target_topic',
      )
      .all();
    return rows.map((r) => ({
      sourceTopic: r.source_topic,
      targetTopic: r.target_topic,
      relationship: r.relationship,
      confidence: r.confidence,
      evidence: r.evidence,
    }));
  }

  /**
   * Find topic pairs that share assigned entries but have no existing
   * connection (either direction). Returns pairs with shared entry count.
   */
  listTopicPairsBySharedEntries(): Array<{
    topicA: string;
    topicB: string;
    sharedEntryCount: number;
  }> {
    const rows = this.db
      .prepare<
        unknown[],
        { topic_a: string; topic_b: string; shared_count: number }
      >(
        `SELECT ste1.topic_id AS topic_a, ste2.topic_id AS topic_b,
                COUNT(*) AS shared_count
         FROM synthesis_topic_entries ste1
         JOIN synthesis_topic_entries ste2
           ON ste1.entry_id = ste2.entry_id AND ste1.topic_id < ste2.topic_id
         WHERE NOT EXISTS (
           SELECT 1 FROM synthesis_connections
           WHERE (source_topic = ste1.topic_id AND target_topic = ste2.topic_id)
              OR (source_topic = ste2.topic_id AND target_topic = ste1.topic_id)
         )
         GROUP BY ste1.topic_id, ste2.topic_id
         ORDER BY shared_count DESC`,
      )
      .all();
    return rows.map((r) => ({
      topicA: r.topic_a,
      topicB: r.topic_b,
      sharedEntryCount: r.shared_count,
    }));
  }

  /**
   * Find 2-hop transitive connection candidates: pairs (A, C) where A→B
   * and B→C exist (in either direction) but A↔C has no direct connection.
   * Returns the intermediate topic and both relationship labels.
   */
  listTransitiveCandidates(): Array<{
    topicA: string;
    topicC: string;
    viaTopicB: string;
    relAB: string;
    relBC: string;
  }> {
    const rows = this.db
      .prepare<
        unknown[],
        { topic_a: string; topic_c: string; via_b: string; rel_ab: string; rel_bc: string }
      >(
        `WITH directed AS (
           SELECT source_topic AS from_t, target_topic AS to_t, relationship
           FROM synthesis_connections
           UNION ALL
           SELECT target_topic AS from_t, source_topic AS to_t, relationship
           FROM synthesis_connections
         )
         SELECT d1.from_t AS topic_a, d2.to_t AS topic_c,
                d1.to_t AS via_b, d1.relationship AS rel_ab, d2.relationship AS rel_bc
         FROM directed d1
         JOIN directed d2 ON d1.to_t = d2.from_t
         WHERE d1.from_t < d2.to_t
           AND d1.from_t != d2.to_t
           AND NOT EXISTS (
             SELECT 1 FROM synthesis_connections
             WHERE (source_topic = d1.from_t AND target_topic = d2.to_t)
                OR (source_topic = d2.to_t AND target_topic = d1.from_t)
           )
         GROUP BY d1.from_t, d2.to_t`,
      )
      .all();
    return rows.map((r) => ({
      topicA: r.topic_a,
      topicC: r.topic_c,
      viaTopicB: r.via_b,
      relAB: r.rel_ab,
      relBC: r.rel_bc,
    }));
  }

  // ── Synthesis Reflections ──────────────────────────────────────────────

  /** Insert a reflection with its citation links. */
  insertReflection(params: InsertReflectionParams): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO synthesis_reflections (reflection_id, title, type, summary, content, created_at, original_citation_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(params.reflectionId, params.title, params.type, params.summary, params.content, params.createdAt, params.citedEntryIds.length);
      const insertCitation = this.db.prepare(
        'INSERT OR IGNORE INTO synthesis_reflection_citations (reflection_id, entry_id) VALUES (?, ?)',
      );
      for (const eid of params.citedEntryIds) {
        insertCitation.run(params.reflectionId, eid);
      }
    });
  }

  /** List all reflections with citation counts. */
  listReflections(): SynthesisReflectionRow[] {
    const rows = this.db
      .prepare<
        unknown[],
        { reflection_id: string; title: string; type: string; summary: string | null; content: string; created_at: string; citation_count: number }
      >(
        `SELECT r.reflection_id, r.title, r.type, r.summary, r.content, r.created_at,
                (SELECT COUNT(*) FROM synthesis_reflection_citations WHERE reflection_id = r.reflection_id) AS citation_count
         FROM synthesis_reflections r
         ORDER BY r.created_at DESC`,
      )
      .all();
    return rows.map((r) => ({
      reflectionId: r.reflection_id,
      title: r.title,
      type: r.type,
      summary: r.summary,
      content: r.content,
      createdAt: r.created_at,
      citationCount: r.citation_count,
    }));
  }

  /** Get a single reflection with its cited entry IDs. */
  getReflection(reflectionId: string): (SynthesisReflectionRow & { citedEntryIds: string[] }) | null {
    const row = this.db
      .prepare<
        unknown[],
        { reflection_id: string; title: string; type: string; summary: string | null; content: string; created_at: string }
      >(
        'SELECT reflection_id, title, type, summary, content, created_at FROM synthesis_reflections WHERE reflection_id = ?',
      )
      .get(reflectionId);
    if (!row) return null;

    const citationCount = this.db
      .prepare<unknown[], { n: number }>(
        'SELECT COUNT(*) AS n FROM synthesis_reflection_citations WHERE reflection_id = ?',
      )
      .get(reflectionId)?.n ?? 0;

    const citedEntryIds = this.db
      .prepare<unknown[], { entry_id: string }>(
        'SELECT entry_id FROM synthesis_reflection_citations WHERE reflection_id = ? ORDER BY entry_id',
      )
      .all(reflectionId)
      .map((r) => r.entry_id);

    return {
      reflectionId: row.reflection_id,
      title: row.title,
      type: row.type,
      summary: row.summary,
      content: row.content,
      createdAt: row.created_at,
      citationCount,
      citedEntryIds,
    };
  }

  /** Delete all reflections (called before regenerating). */
  wipeReflections(): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM synthesis_reflection_citations');
      this.db.exec('DELETE FROM synthesis_reflections');
    });
  }

  /**
   * List IDs of stale reflections — reflections where any cited entry
   * has been updated since the reflection was created, or where a cited
   * entry has been deleted.
   */
  listStaleReflectionIds(): string[] {
    const rows = this.db
      .prepare<unknown[], { reflection_id: string }>(
        `SELECT r.reflection_id
         FROM synthesis_reflections r
         LEFT JOIN synthesis_reflection_citations c ON c.reflection_id = r.reflection_id
         LEFT JOIN entries e ON e.entry_id = c.entry_id
         GROUP BY r.reflection_id
         HAVING COUNT(CASE WHEN c.entry_id IS NOT NULL AND e.entry_id IS NULL THEN 1 END) > 0
             OR COUNT(CASE WHEN e.digested_at > r.created_at THEN 1 END) > 0
             OR COUNT(c.entry_id) < r.original_citation_count`,
      )
      .all();
    return rows.map((r) => r.reflection_id);
  }

  /** Delete specific reflections by ID. */
  deleteReflections(reflectionIds: string[]): void {
    if (reflectionIds.length === 0) return;
    const placeholders = reflectionIds.map(() => '?').join(', ');
    this.transaction(() => {
      this.db
        .prepare(`DELETE FROM synthesis_reflection_citations WHERE reflection_id IN (${placeholders})`)
        .run(...reflectionIds);
      this.db
        .prepare(`DELETE FROM synthesis_reflections WHERE reflection_id IN (${placeholders})`)
        .run(...reflectionIds);
    });
  }

  /** Count stale reflections. */
  private _countStaleReflections(): number {
    const row = this.db
      .prepare<unknown[], { n: number }>(
        `SELECT COUNT(*) AS n FROM (
           SELECT r.reflection_id
           FROM synthesis_reflections r
           LEFT JOIN synthesis_reflection_citations c ON c.reflection_id = r.reflection_id
           LEFT JOIN entries e ON e.entry_id = c.entry_id
           GROUP BY r.reflection_id
           HAVING COUNT(CASE WHEN c.entry_id IS NOT NULL AND e.entry_id IS NULL THEN 1 END) > 0
               OR COUNT(CASE WHEN e.digested_at > r.created_at THEN 1 END) > 0
               OR COUNT(c.entry_id) < r.original_citation_count
         )`,
      )
      .get();
    return row?.n ?? 0;
  }

  // ── Synthesis Bulk Operations ──────────────────────────────────────────

  /** Wipe all synthesis data (for Re-Dream full rebuild). */
  wipeSynthesis(): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM synthesis_reflection_citations');
      this.db.exec('DELETE FROM synthesis_reflections');
      this.db.exec('DELETE FROM synthesis_connections');
      this.db.exec('DELETE FROM synthesis_topic_entries');
      this.db.exec('DELETE FROM synthesis_topics');
      this.setSynthesisMeta('last_run_at', '');
      this.setSynthesisMeta('last_run_error', '');
      this.setSynthesisMeta('god_nodes', '[]');
    });
  }

  /**
   * Detect god nodes: topics with disproportionately many entries or
   * connections (> 3× average, minimum 10 entries). Returns topic IDs.
   */
  detectGodNodes(): string[] {
    const topics = this.listTopics();
    if (topics.length === 0) return [];

    const avgEntries = topics.reduce((sum, t) => sum + t.entryCount, 0) / topics.length;
    const avgConns = topics.reduce((sum, t) => sum + t.connectionCount, 0) / topics.length;
    const entryThreshold = Math.max(avgEntries * 3, 10);
    const connThreshold = Math.max(avgConns * 3, 3);

    return topics
      .filter((t) => t.entryCount > entryThreshold || t.connectionCount > connThreshold)
      .map((t) => t.topicId);
  }

  // ── Digestion session (issue #148) ───────────────────────────────────────

  /**
   * Read the persisted digestion-session snapshot, or `null` if the queue
   * is idle. The digestion orchestrator rehydrates its in-memory session
   * from this row on first access after a server restart.
   */
  getDigestSession(): DigestSessionRow | null {
    const row = this.db
      .prepare<
        unknown[],
        {
          total: number;
          done: number;
          total_elapsed_ms: number;
          started_at: string;
        }
      >(
        'SELECT total, done, total_elapsed_ms, started_at FROM digest_session WHERE id = 1',
      )
      .get();
    if (!row) return null;
    return {
      total: row.total,
      done: row.done,
      totalElapsedMs: row.total_elapsed_ms,
      startedAt: row.started_at,
    };
  }

  /** Upsert the singleton digestion-session row. Called on every counter bump. */
  upsertDigestSession(row: DigestSessionRow): void {
    this.db
      .prepare(
        `INSERT INTO digest_session (id, total, done, total_elapsed_ms, started_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           total = excluded.total,
           done = excluded.done,
           total_elapsed_ms = excluded.total_elapsed_ms,
           started_at = excluded.started_at`,
      )
      .run(row.total, row.done, row.totalElapsedMs, row.startedAt);
  }

  /** Delete the digestion-session row when the queue drains. */
  clearDigestSession(): void {
    this.db.prepare('DELETE FROM digest_session').run();
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

    // ── V2 migration: add needs_synthesis column to existing entries table ──
    this._migrateV2();
    // ── V3 migration: add original_citation_count to synthesis_reflections ──
    this._migrateV3();

    // Create the needs_synthesis partial index AFTER the V2 migration so that
    // V1 databases already have the column by the time we reference it.
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_entries_needs_synthesis ON entries(needs_synthesis)
         WHERE needs_synthesis = 1`,
    );

    // ── Seed synthesis_meta defaults ──
    this.db.exec(
      `INSERT OR IGNORE INTO synthesis_meta (key, value) VALUES ('status', 'idle')`,
    );

    // If the server was killed mid-dream the status stays 'running' in the DB.
    // Nothing can actually be running right after construction, so reset it.
    this.db
      .prepare(`UPDATE synthesis_meta SET value = 'idle' WHERE key = 'status' AND value = 'running'`)
      .run();
  }

  /**
   * V2 migration: add `needs_synthesis` column to the entries table for
   * databases created at schema V1. Safe to call on V2+ DBs (no-op).
   */
  private _migrateV2(): void {
    const cols = this.db
      .prepare<unknown[], { name: string }>('PRAGMA table_info(entries)')
      .all();
    const hasColumn = cols.some((c) => c.name === 'needs_synthesis');
    if (hasColumn) return;
    this.db.exec(
      'ALTER TABLE entries ADD COLUMN needs_synthesis INTEGER NOT NULL DEFAULT 1',
    );
    // Existing entries that were already digested before dreaming existed
    // should default to needing synthesis.
    this.db.exec('UPDATE entries SET needs_synthesis = 1');
    // Update schema_version in meta.
    this.db
      .prepare('UPDATE meta SET value = ? WHERE key = ?')
      .run(String(KB_DB_SCHEMA_VERSION), 'schema_version');
  }

  /**
   * V3 migration: add `original_citation_count` column to synthesis_reflections
   * so stale detection works when cited entries are cascade-deleted.
   */
  private _migrateV3(): void {
    const cols = this.db
      .prepare<unknown[], { name: string }>('PRAGMA table_info(synthesis_reflections)')
      .all();
    if (cols.length === 0) return; // table doesn't exist yet (fresh DB, DDL runs later via SCHEMA_DDL)
    const hasColumn = cols.some((c) => c.name === 'original_citation_count');
    if (hasColumn) return;
    this.db.exec(
      'ALTER TABLE synthesis_reflections ADD COLUMN original_citation_count INTEGER NOT NULL DEFAULT 0',
    );
    // Backfill from current citation counts.
    this.db.exec(
      `UPDATE synthesis_reflections SET original_citation_count = (
         SELECT COUNT(*) FROM synthesis_reflection_citations WHERE reflection_id = synthesis_reflections.reflection_id
       )`,
    );
  }

  /**
   * One-shot crash recovery on DB open. The digestion orchestrator lives in
   * memory, so nothing can actually be digesting at the moment we open the
   * DB — any `status='digesting'` row is a left-over from a server crash.
   * Flip those back to `ingested` so the user can retry them, and clear
   * any stale `digest_session` row (the worker that would have finished
   * it is gone).
   */
  private _recoverFromCrash(): void {
    this.db
      .prepare("UPDATE raw SET status = 'ingested' WHERE status = 'digesting'")
      .run();
    this.db.prepare('DELETE FROM digest_session').run();
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
    entryCount: row.entry_count ?? 0,
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
