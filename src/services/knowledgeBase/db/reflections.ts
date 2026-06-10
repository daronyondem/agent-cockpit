import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type {
  InsertReflectionParams,
  SynthesisReflectionRow,
} from './types';

/** Insert a reflection with its citation links. */
export function insertReflection(
  db: BetterSqlite3Database,
  params: InsertReflectionParams,
): void {
  db.transaction(() => {
    db
      .prepare(
        `INSERT INTO synthesis_reflections (reflection_id, title, type, summary, content, created_at, original_citation_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(params.reflectionId, params.title, params.type, params.summary, params.content, params.createdAt, params.citedEntryIds.length);
    const insertCitation = db.prepare(
      'INSERT OR IGNORE INTO synthesis_reflection_citations (reflection_id, entry_id) VALUES (?, ?)',
    );
    for (const eid of params.citedEntryIds) {
      insertCitation.run(params.reflectionId, eid);
    }
  })();
}

/** List all reflections with citation counts. */
export function listReflections(db: BetterSqlite3Database): SynthesisReflectionRow[] {
  const rows = db
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
export function getReflection(
  db: BetterSqlite3Database,
  reflectionId: string,
): (SynthesisReflectionRow & { citedEntryIds: string[] }) | null {
  const row = db
    .prepare<
      unknown[],
      { reflection_id: string; title: string; type: string; summary: string | null; content: string; created_at: string }
    >(
      'SELECT reflection_id, title, type, summary, content, created_at FROM synthesis_reflections WHERE reflection_id = ?',
    )
    .get(reflectionId);
  if (!row) return null;

  const citationCount = db
    .prepare<unknown[], { n: number }>(
      'SELECT COUNT(*) AS n FROM synthesis_reflection_citations WHERE reflection_id = ?',
    )
    .get(reflectionId)?.n ?? 0;

  const citedEntryIds = db
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
export function wipeReflections(db: BetterSqlite3Database): void {
  db.transaction(() => {
    db.exec('DELETE FROM synthesis_reflection_citations');
    db.exec('DELETE FROM synthesis_reflections');
  })();
}

/**
 * List IDs of stale reflections — reflections where any cited entry
 * has been updated since the reflection was created, or where a cited
 * entry has been deleted.
 */
export function listStaleReflectionIds(db: BetterSqlite3Database): string[] {
  const rows = db
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
export function deleteReflections(
  db: BetterSqlite3Database,
  reflectionIds: string[],
): void {
  if (reflectionIds.length === 0) return;
  const placeholders = reflectionIds.map(() => '?').join(', ');
  db.transaction(() => {
    db
      .prepare(`DELETE FROM synthesis_reflection_citations WHERE reflection_id IN (${placeholders})`)
      .run(...reflectionIds);
    db
      .prepare(`DELETE FROM synthesis_reflections WHERE reflection_id IN (${placeholders})`)
      .run(...reflectionIds);
  })();
}

/** Count stale reflections. */
export function countStaleReflections(db: BetterSqlite3Database): number {
  const row = db
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
