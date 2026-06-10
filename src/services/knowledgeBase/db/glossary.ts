import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { glossaryRowFromDb } from './rowMappers';
import type { KbGlossaryRow } from './types';

export function listGlossary(db: BetterSqlite3Database): KbGlossaryRow[] {
  const rows = db
    .prepare<
      unknown[],
      {
        id: number;
        term: string;
        expansion: string;
        created_at: string;
        updated_at: string;
      }
    >('SELECT id, term, expansion, created_at, updated_at FROM kb_glossary ORDER BY term COLLATE NOCASE')
    .all();
  return rows.map(glossaryRowFromDb);
}

export function getGlossaryTerm(
  db: BetterSqlite3Database,
  id: number,
): KbGlossaryRow | null {
  const row = db
    .prepare<
      unknown[],
      {
        id: number;
        term: string;
        expansion: string;
        created_at: string;
        updated_at: string;
      }
    >('SELECT id, term, expansion, created_at, updated_at FROM kb_glossary WHERE id = ?')
    .get(id);
  return row ? glossaryRowFromDb(row) : null;
}

export function addGlossaryTerm(
  db: BetterSqlite3Database,
  term: string,
  expansion: string,
  now = new Date().toISOString(),
): KbGlossaryRow {
  const info = db
    .prepare(
      `INSERT INTO kb_glossary (term, expansion, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
    )
    .run(term.trim(), expansion.trim(), now, now);
  return getGlossaryTerm(db, Number(info.lastInsertRowid))!;
}

export function updateGlossaryTerm(
  db: BetterSqlite3Database,
  id: number,
  term: string,
  expansion: string,
  now = new Date().toISOString(),
): KbGlossaryRow | null {
  const info = db
    .prepare(
      `UPDATE kb_glossary
         SET term = ?, expansion = ?, updated_at = ?
         WHERE id = ?`,
    )
    .run(term.trim(), expansion.trim(), now, id);
  if (info.changes === 0) return null;
  return getGlossaryTerm(db, id);
}

export function deleteGlossaryTerm(db: BetterSqlite3Database, id: number): boolean {
  const info = db.prepare('DELETE FROM kb_glossary WHERE id = ?').run(id);
  return info.changes > 0;
}
