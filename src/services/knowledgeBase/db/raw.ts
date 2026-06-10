import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type {
  KbErrorClass,
  KbRawEntry,
  KbRawStatus,
} from '../../../types';
import {
  createFolder,
  normalizeFolderPath,
} from './folders';
import { rawJoinRowToEntry } from './rowMappers';
import { markCoTopicEntriesStale } from './synthesis';
import { deleteOrphanTopics } from './synthesisGraph';
import { DEFAULT_RAW_PAGE_SIZE } from './types';
import type {
  InsertLocationParams,
  InsertRawParams,
  LocationRow,
  RawDbRow,
  RawError,
  RawJoinRow,
} from './types';

export function getRawById(db: BetterSqlite3Database, rawId: string): RawDbRow | null {
  const row = db
    .prepare<unknown[], RawDbRow>('SELECT * FROM raw WHERE raw_id = ?')
    .get(rawId);
  return row ?? null;
}

export function getRawBySha(db: BetterSqlite3Database, sha256: string): RawDbRow | null {
  const row = db
    .prepare<unknown[], RawDbRow>('SELECT * FROM raw WHERE sha256 = ?')
    .get(sha256);
  return row ?? null;
}

export function insertRaw(db: BetterSqlite3Database, params: InsertRawParams): void {
  db
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

export function updateRawStatus(
  db: BetterSqlite3Database,
  rawId: string,
  status: KbRawStatus,
  error: RawError | null = null,
): void {
  db
    .prepare(
      'UPDATE raw SET status = ?, error_class = ?, error_message = ? WHERE raw_id = ?',
    )
    .run(status, error?.errorClass ?? null, error?.errorMessage ?? null, rawId);
}

export function setRawDigestedAt(
  db: BetterSqlite3Database,
  rawId: string,
  digestedAt: string,
): void {
  db
    .prepare('UPDATE raw SET digested_at = ? WHERE raw_id = ?')
    .run(digestedAt, rawId);
}

export function setRawHandler(
  db: BetterSqlite3Database,
  rawId: string,
  handler: string,
): void {
  db
    .prepare('UPDATE raw SET handler = ? WHERE raw_id = ?')
    .run(handler, rawId);
}

export function setRawMetadata(
  db: BetterSqlite3Database,
  rawId: string,
  metadata: Record<string, unknown> | null,
): void {
  db
    .prepare('UPDATE raw SET metadata_json = ? WHERE raw_id = ?')
    .run(metadata ? JSON.stringify(metadata) : null, rawId);
}

/**
 * Delete a raw row. Returns the list of entry IDs that were cascade
 * deleted (so the caller can remove their on-disk directories). Does
 * NOT delete the raw bytes on disk — that's the orchestrator's job.
 */
export function deleteRaw(db: BetterSqlite3Database, rawId: string): string[] {
  return db.transaction(() => {
    const entries = db
      .prepare<unknown[], { entry_id: string }>(
        'SELECT entry_id FROM entries WHERE raw_id = ?',
      )
      .all(rawId)
      .map((r) => r.entry_id);
    markCoTopicEntriesStale(db, entries);
    // raw cascades → entries + entry_tags; raw_locations cascades too.
    // synthesis_topic_entries and synthesis_reflection_citations also
    // cascade-delete, potentially leaving orphan topics.
    db.prepare('DELETE FROM raw WHERE raw_id = ?').run(rawId);
    deleteOrphanTopics(db);
    return entries;
  })();
}

export function addLocation(db: BetterSqlite3Database, params: InsertLocationParams): void {
  const folderPath = normalizeFolderPath(params.folderPath);
  createFolder(db, folderPath); // idempotent
  db
    .prepare(
      'INSERT INTO raw_locations (raw_id, folder_path, filename, uploaded_at) VALUES (?, ?, ?, ?)',
    )
    .run(params.rawId, folderPath, params.filename, params.uploadedAt);
}

export function removeLocation(
  db: BetterSqlite3Database,
  rawId: string,
  folderPath: string,
  filename: string,
): void {
  db
    .prepare(
      'DELETE FROM raw_locations WHERE raw_id = ? AND folder_path = ? AND filename = ?',
    )
    .run(rawId, normalizeFolderPath(folderPath), filename);
}

export function countLocations(db: BetterSqlite3Database, rawId: string): number {
  const row = db
    .prepare<unknown[], { n: number }>(
      'SELECT COUNT(*) AS n FROM raw_locations WHERE raw_id = ?',
    )
    .get(rawId);
  return row?.n ?? 0;
}

export function findLocation(
  db: BetterSqlite3Database,
  folderPath: string,
  filename: string,
): LocationRow | null {
  const row = db
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

export function listLocations(db: BetterSqlite3Database, rawId: string): LocationRow[] {
  const rows = db
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
export function listRawInFolder(
  db: BetterSqlite3Database,
  folderPath: string,
  opts: { limit?: number; offset?: number } = {},
): KbRawEntry[] {
  const limit = opts.limit ?? DEFAULT_RAW_PAGE_SIZE;
  const offset = opts.offset ?? 0;
  const rows = db
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
export function listPendingDeleteRaw(db: BetterSqlite3Database): RawDbRow[] {
  return db
    .prepare<unknown[], RawDbRow>(
      "SELECT * FROM raw WHERE status = 'pending-delete' ORDER BY raw_id",
    )
    .all();
}

/** List every raw row across the workspace. Used by maintenance jobs. */
export function listAllRaw(db: BetterSqlite3Database): RawDbRow[] {
  return db
    .prepare<unknown[], RawDbRow>('SELECT * FROM raw ORDER BY uploaded_at, raw_id')
    .all();
}

/**
 * List raw IDs with `status = 'ingested'` across the whole workspace
 * (ready for digestion). Used by the "Digest All Pending" batch runner.
 */
export function listIngestedRawIds(db: BetterSqlite3Database): string[] {
  return db
    .prepare<unknown[], { raw_id: string }>(
      "SELECT raw_id FROM raw WHERE status = 'ingested' ORDER BY raw_id",
    )
    .all()
    .map((r) => r.raw_id);
}
