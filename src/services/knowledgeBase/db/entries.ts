import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { KbEntry } from '../../../types';
import { normalizeFolderPath } from './folders';
import { markCoTopicEntriesStale } from './synthesis';
import { DEFAULT_RAW_PAGE_SIZE } from './types';
import type {
  InsertEntryParams,
  InsertEntrySourceParams,
  KbDocumentUnitType,
  KbEntrySourceRow,
  ListEntriesFilter,
  ReplaceEntryParams,
} from './types';

export function insertEntry(db: BetterSqlite3Database, params: InsertEntryParams): void {
  db.transaction(() => {
    db
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
    const insertTag = db.prepare(
      'INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)',
    );
    for (const tag of params.tags) {
      insertTag.run(params.entryId, tag);
    }
  })();
}

export function insertEntrySources(
  db: BetterSqlite3Database,
  sources: InsertEntrySourceParams[],
): void {
  if (sources.length === 0) return;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO kb_entry_sources
       (entry_id, raw_id, node_id, chunk_id, start_unit, end_unit)
       VALUES (?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const source of sources) {
      insert.run(
        source.entryId,
        source.rawId,
        source.nodeId ?? null,
        source.chunkId,
        source.startUnit,
        source.endUnit,
      );
    }
  })();
}

/**
 * Replace every entry for `rawId` in one DB transaction. Used by redigest
 * after the caller has staged entry files, so a DB insertion failure cannot
 * leave the raw with stale rows deleted and only some replacements inserted.
 */
export function replaceEntriesForRawId(
  db: BetterSqlite3Database,
  rawId: string,
  entries: ReplaceEntryParams[],
): string[] {
  return db.transaction(() => {
    const staleIds = listEntryIdsByRawId(db, rawId);
    markCoTopicEntriesStale(db, staleIds);
    db.prepare('DELETE FROM entries WHERE raw_id = ?').run(rawId);

    const insertEntryStmt = db.prepare(
      `INSERT INTO entries
         (entry_id, raw_id, title, slug, summary, schema_version, stale_schema, digested_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    const insertTag = db.prepare(
      'INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)',
    );
    const insertSource = db.prepare(
      `INSERT OR IGNORE INTO kb_entry_sources
         (entry_id, raw_id, node_id, chunk_id, start_unit, end_unit)
         VALUES (?, ?, ?, ?, ?, ?)`,
    );

    for (const entry of entries) {
      if (entry.rawId !== rawId) {
        throw new Error(`Entry ${entry.entryId} belongs to ${entry.rawId}, not ${rawId}.`);
      }
      insertEntryStmt.run(
        entry.entryId,
        entry.rawId,
        entry.title,
        entry.slug,
        entry.summary,
        entry.schemaVersion,
        entry.digestedAt,
      );
      for (const tag of entry.tags) {
        insertTag.run(entry.entryId, tag);
      }
      for (const source of entry.sources) {
        insertSource.run(
          entry.entryId,
          source.rawId,
          source.nodeId ?? null,
          source.chunkId,
          source.startUnit,
          source.endUnit,
        );
      }
    }

    return staleIds;
  })();
}

export function listEntrySources(
  db: BetterSqlite3Database,
  entryId: string,
): KbEntrySourceRow[] {
  const rows = db
    .prepare<
      unknown[],
      {
        entry_id: string;
        raw_id: string;
        node_id: string | null;
        chunk_id: string;
        start_unit: number;
        end_unit: number;
        doc_name: string | null;
        unit_type: string | null;
        node_title: string | null;
      }
    >(
      `SELECT
           s.entry_id, s.raw_id, s.node_id, s.chunk_id, s.start_unit, s.end_unit,
           d.doc_name, d.unit_type, n.title AS node_title
         FROM kb_entry_sources s
         LEFT JOIN kb_documents d ON d.raw_id = s.raw_id
         LEFT JOIN kb_document_nodes n ON n.raw_id = s.raw_id AND n.node_id = s.node_id
         WHERE s.entry_id = ?
         ORDER BY s.start_unit, s.end_unit, s.chunk_id`,
    )
    .all(entryId);
  return rows.map((r) => ({
    entryId: r.entry_id,
    rawId: r.raw_id,
    nodeId: r.node_id,
    chunkId: r.chunk_id,
    startUnit: r.start_unit,
    endUnit: r.end_unit,
    docName: r.doc_name,
    unitType: r.unit_type as KbDocumentUnitType | null,
    nodeTitle: r.node_title,
  }));
}

/**
 * Delete all entries for a raw ID and return their entryIds so the
 * caller can rm -rf `entries/<entryId>/` on disk. Used during redigest
 * and during raw purge.
 */
export function deleteEntriesByRawId(db: BetterSqlite3Database, rawId: string): string[] {
  return db.transaction(() => {
    const ids = listEntryIdsByRawId(db, rawId);
    markCoTopicEntriesStale(db, ids);
    // entry_tags cascades on entries delete.
    db.prepare('DELETE FROM entries WHERE raw_id = ?').run(rawId);
    return ids;
  })();
}

export function listEntryIdsByRawId(db: BetterSqlite3Database, rawId: string): string[] {
  return db
    .prepare<unknown[], { entry_id: string }>(
      'SELECT entry_id FROM entries WHERE raw_id = ? ORDER BY entry_id',
    )
    .all(rawId)
    .map((r) => r.entry_id);
}

export function listEntryIds(db: BetterSqlite3Database): string[] {
  return db
    .prepare<unknown[], { entry_id: string }>(
      'SELECT entry_id FROM entries ORDER BY entry_id',
    )
    .all()
    .map((r) => r.entry_id);
}

export function entryExists(db: BetterSqlite3Database, entryId: string): boolean {
  const row = db
    .prepare<unknown[], { entry_id: string }>(
      'SELECT entry_id FROM entries WHERE entry_id = ?',
    )
    .get(entryId);
  return Boolean(row);
}

export function countEntriesByRawId(db: BetterSqlite3Database, rawId: string): number {
  const row = db
    .prepare<unknown[], { cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM entries WHERE raw_id = ?',
    )
    .get(rawId);
  return row?.cnt ?? 0;
}

export function getEntry(db: BetterSqlite3Database, entryId: string): KbEntry | null {
  const row = db
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
    tags: listTagsForEntry(db, row.entry_id),
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
export function listEntries(
  db: BetterSqlite3Database,
  opts: ListEntriesFilter & { limit?: number; offset?: number } = {},
): KbEntry[] {
  const limit = opts.limit ?? DEFAULT_RAW_PAGE_SIZE;
  const offset = opts.offset ?? 0;
  const { joinSql, whereSql, havingSql, params } = buildEntryFilter(opts);
  const query = `SELECT e.entry_id, e.raw_id, e.title, e.slug, e.summary, e.schema_version, e.stale_schema, e.digested_at
                   FROM entries e${joinSql}${whereSql}
                   GROUP BY e.entry_id${havingSql}
                   ORDER BY e.title
                   LIMIT ? OFFSET ?`;
  const rows = db
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
    tags: listTagsForEntry(db, r.entry_id),
  }));
}

/**
 * Count entries matching the same filter options as `listEntries`,
 * without LIMIT/OFFSET. Used by the UI to render page counts.
 */
export function countEntries(
  db: BetterSqlite3Database,
  opts: ListEntriesFilter = {},
): number {
  const { joinSql, whereSql, havingSql, params } = buildEntryFilter(opts);
  const query = `SELECT COUNT(*) AS n FROM (
                     SELECT e.entry_id FROM entries e${joinSql}${whereSql}
                     GROUP BY e.entry_id${havingSql}
                   ) AS t`;
  const row = db.prepare<unknown[], { n: number }>(query).get(...params);
  return row?.n ?? 0;
}

/**
 * Build the JOIN / WHERE / HAVING fragments shared by `listEntries`
 * and `countEntries`. Keeping both on the same builder guarantees the
 * filter set stays consistent — the pagination total can never
 * disagree with the page contents.
 */
function buildEntryFilter(opts: ListEntriesFilter): {
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
    const needle = '%' + opts.search.trim().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    clauses.push(
      "(e.title LIKE ? ESCAPE '\\' COLLATE NOCASE"
        + " OR EXISTS (SELECT 1 FROM raw_locations rl"
        + " WHERE rl.raw_id = e.raw_id"
        + " AND rl.filename LIKE ? ESCAPE '\\' COLLATE NOCASE))",
    );
    params.push(needle, needle);
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
export function listAllTags(db: BetterSqlite3Database): Array<{ tag: string; count: number }> {
  return db
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
export function entryIdTaken(db: BetterSqlite3Database, entryId: string): boolean {
  return entryExists(db, entryId);
}

function listTagsForEntry(db: BetterSqlite3Database, entryId: string): string[] {
  return db
    .prepare<unknown[], { tag: string }>(
      'SELECT tag FROM entry_tags WHERE entry_id = ? ORDER BY tag',
    )
    .all(entryId)
    .map((r) => r.tag);
}
