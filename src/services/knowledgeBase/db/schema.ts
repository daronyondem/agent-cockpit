import type { Database as BetterSqlite3Database } from 'better-sqlite3';

/** Version of the DB's own schema. Bumped on destructive schema changes. */
export const KB_DB_SCHEMA_VERSION = 8;

/**
 * Idempotent DDL — safe to run on every open. `CREATE TABLE IF NOT EXISTS`
 * keeps it a no-op on established DBs; fresh DBs get the full shape.
 */
export const SCHEMA_DDL = `
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

  CREATE TABLE IF NOT EXISTS kb_documents (
    raw_id           TEXT PRIMARY KEY REFERENCES raw(raw_id) ON DELETE CASCADE,
    doc_name         TEXT NOT NULL,
    doc_description  TEXT,
    unit_type        TEXT NOT NULL,
    unit_count       INTEGER NOT NULL DEFAULT 0,
    structure_status TEXT NOT NULL DEFAULT 'ready',
    structure_error  TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kb_document_nodes (
    node_id        TEXT NOT NULL,
    raw_id         TEXT NOT NULL REFERENCES kb_documents(raw_id) ON DELETE CASCADE,
    parent_node_id TEXT,
    title          TEXT NOT NULL,
    summary        TEXT,
    start_unit     INTEGER NOT NULL,
    end_unit       INTEGER NOT NULL,
    sort_order     INTEGER NOT NULL,
    source         TEXT NOT NULL,
    metadata_json  TEXT,
    PRIMARY KEY (raw_id, node_id)
  );
  CREATE INDEX IF NOT EXISTS idx_kb_doc_nodes_raw_order ON kb_document_nodes(raw_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_kb_doc_nodes_parent ON kb_document_nodes(raw_id, parent_node_id);

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

  CREATE TABLE IF NOT EXISTS kb_entry_sources (
    entry_id   TEXT NOT NULL REFERENCES entries(entry_id) ON DELETE CASCADE,
    raw_id     TEXT NOT NULL REFERENCES raw(raw_id) ON DELETE CASCADE,
    node_id    TEXT,
    chunk_id   TEXT NOT NULL,
    start_unit INTEGER NOT NULL,
    end_unit   INTEGER NOT NULL,
    PRIMARY KEY (entry_id, raw_id, chunk_id, start_unit, end_unit)
  );
  CREATE INDEX IF NOT EXISTS idx_kb_entry_sources_raw ON kb_entry_sources(raw_id);
  CREATE INDEX IF NOT EXISTS idx_kb_entry_sources_entry ON kb_entry_sources(entry_id);

  CREATE TABLE IF NOT EXISTS kb_glossary (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    term       TEXT NOT NULL COLLATE NOCASE UNIQUE,
    expansion  TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

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

  CREATE TABLE IF NOT EXISTS synthesis_runs (
    run_id        TEXT PRIMARY KEY,
    mode          TEXT NOT NULL,
    status        TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    completed_at  TEXT,
    error_message TEXT
  );

  CREATE TABLE IF NOT EXISTS synthesis_topic_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id    TEXT NOT NULL,
    change_type TEXT NOT NULL,
    old_content TEXT,
    new_content TEXT,
    entry_ids   TEXT,
    run_id      TEXT REFERENCES synthesis_runs(run_id),
    changed_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_topic_history_topic ON synthesis_topic_history(topic_id);
  CREATE INDEX IF NOT EXISTS idx_topic_history_run ON synthesis_topic_history(run_id);

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
    started_at        TEXT NOT NULL,
    chunk_progress_json TEXT
  );
`;

export function getSchemaVersion(db: BetterSqlite3Database): number {
  const row = db
    .prepare<unknown[], { value: string }>(
      'SELECT value FROM meta WHERE key = ?',
    )
    .get('schema_version');
  return row ? Number(row.value) : KB_DB_SCHEMA_VERSION;
}

export function initSchema(db: BetterSqlite3Database): void {
  db.exec(SCHEMA_DDL);
  // Seed schema_version + created_at in meta if this is a fresh DB.
  const existing = db
    .prepare<unknown[], { value: string }>(
      'SELECT value FROM meta WHERE key = ?',
    )
    .get('schema_version');
  if (!existing) {
    const now = new Date().toISOString();
    const insert = db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?)',
    );
    insert.run('schema_version', String(KB_DB_SCHEMA_VERSION));
    insert.run('created_at', now);
  }

  // ── V2 migration: add needs_synthesis column to existing entries table ──
  migrateV2(db);
  // ── V3 migration: add original_citation_count to synthesis_reflections ──
  migrateV3(db);
  // ── V4 migration: add document structure tables ────────────────────────
  migrateV4(db);
  // ── V5 migration: add entry source lineage table ───────────────────────
  migrateV5(db);
  // ── V6 migration: add glossary query-expansion table ──────────────────
  migrateV6(db);
  // ── V7 migration: add synthesis run + topic history tables ────────────
  migrateV7(db);
  // ── V8 migration: add live chunk progress to digest_session ────────────
  migrateV8(db);

  // Create the needs_synthesis partial index AFTER the V2 migration so that
  // V1 databases already have the column by the time we reference it.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entries_needs_synthesis ON entries(needs_synthesis)
         WHERE needs_synthesis = 1`,
  );

  // ── Seed synthesis_meta defaults ──
  db.exec(
    `INSERT OR IGNORE INTO synthesis_meta (key, value) VALUES ('status', 'idle')`,
  );

  // If the server was killed mid-dream the status stays 'running' in the DB.
  // Nothing can actually be running right after construction, so reset it.
  db
    .prepare(`UPDATE synthesis_meta SET value = 'idle' WHERE key = 'status' AND value = 'running'`)
    .run();
}

/**
 * V2 migration: add `needs_synthesis` column to the entries table for
 * databases created at schema V1. Safe to call on V2+ DBs (no-op).
 */
function migrateV2(db: BetterSqlite3Database): void {
  const cols = db
    .prepare<unknown[], { name: string }>('PRAGMA table_info(entries)')
    .all();
  const hasColumn = cols.some((c) => c.name === 'needs_synthesis');
  if (hasColumn) return;
  db.exec(
    'ALTER TABLE entries ADD COLUMN needs_synthesis INTEGER NOT NULL DEFAULT 1',
  );
  // Existing entries that were already digested before dreaming existed
  // should default to needing synthesis.
  db.exec('UPDATE entries SET needs_synthesis = 1');
  // Update schema_version in meta.
  db
    .prepare('UPDATE meta SET value = ? WHERE key = ?')
    .run('2', 'schema_version');
}

/**
 * V3 migration: add `original_citation_count` column to synthesis_reflections
 * so stale detection works when cited entries are cascade-deleted.
 */
function migrateV3(db: BetterSqlite3Database): void {
  const cols = db
    .prepare<unknown[], { name: string }>('PRAGMA table_info(synthesis_reflections)')
    .all();
  if (cols.length === 0) return;
  const hasColumn = cols.some((c) => c.name === 'original_citation_count');
  if (!hasColumn) {
    db.exec(
      'ALTER TABLE synthesis_reflections ADD COLUMN original_citation_count INTEGER NOT NULL DEFAULT 0',
    );
    // Backfill from current citation counts.
    db.exec(
      `UPDATE synthesis_reflections SET original_citation_count = (
           SELECT COUNT(*) FROM synthesis_reflection_citations WHERE reflection_id = synthesis_reflections.reflection_id
         )`,
    );
  }
  db
    .prepare('UPDATE meta SET value = ? WHERE key = ?')
    .run('3', 'schema_version');
}

/**
 * V4 migration: add document structure tables for range-aware retrieval.
 * `SCHEMA_DDL` creates the tables and indexes idempotently before this
 * runs, so the migration only records that the DB has reached V4.
 */
function migrateV4(db: BetterSqlite3Database): void {
  db
    .prepare('UPDATE meta SET value = ? WHERE key = ?')
    .run('4', 'schema_version');
}

/**
 * V5 migration: add entry source lineage table for chunked digestion.
 * `SCHEMA_DDL` creates the table and indexes idempotently before this
 * runs, so the migration only records that the DB has reached V5.
 */
function migrateV5(db: BetterSqlite3Database): void {
  db
    .prepare('UPDATE meta SET value = ? WHERE key = ?')
    .run('5', 'schema_version');
}

/**
 * V6 migration: add glossary query-expansion table.
 * `SCHEMA_DDL` creates the table idempotently before this runs.
 */
function migrateV6(db: BetterSqlite3Database): void {
  db
    .prepare('UPDATE meta SET value = ? WHERE key = ?')
    .run('6', 'schema_version');
}

/**
 * V7 migration: add synthesis run tracking and topic history tables.
 * `SCHEMA_DDL` creates the tables and indexes idempotently before this
 * runs, so the migration only records that the DB has reached V7.
 */
function migrateV7(db: BetterSqlite3Database): void {
  db
    .prepare('UPDATE meta SET value = ? WHERE key = ?')
    .run('7', 'schema_version');
}

/**
 * V8 migration: add `chunk_progress_json` to digest_session so live
 * planning/chunk counters survive KB Browser refetches during digestion.
 */
function migrateV8(db: BetterSqlite3Database): void {
  const cols = db
    .prepare<unknown[], { name: string }>('PRAGMA table_info(digest_session)')
    .all();
  const hasColumn = cols.some((c) => c.name === 'chunk_progress_json');
  if (!hasColumn) {
    db.exec('ALTER TABLE digest_session ADD COLUMN chunk_progress_json TEXT');
  }
  db
    .prepare('UPDATE meta SET value = ? WHERE key = ?')
    .run(String(KB_DB_SCHEMA_VERSION), 'schema_version');
}

/**
 * One-shot crash recovery on DB open. The digestion orchestrator lives in
 * memory, so nothing can actually be digesting at the moment we open the
 * DB — any `status='digesting'` row is a left-over from a server crash.
 * Flip those back to `ingested` so the user can retry them, and clear
 * any stale `digest_session` row (the worker that would have finished
 * it is gone).
 */
export function recoverFromCrash(db: BetterSqlite3Database): void {
  db
    .prepare("UPDATE raw SET status = 'ingested' WHERE status = 'digesting'")
    .run();
  db.prepare('DELETE FROM digest_session').run();
}

export function ensureRootFolder(db: BetterSqlite3Database): void {
  const row = db
    .prepare<unknown[], { folder_path: string }>(
      'SELECT folder_path FROM folders WHERE folder_path = ?',
    )
    .get('');
  if (!row) {
    db
      .prepare('INSERT INTO folders (folder_path, created_at) VALUES (?, ?)')
      .run('', new Date().toISOString());
  }
}
