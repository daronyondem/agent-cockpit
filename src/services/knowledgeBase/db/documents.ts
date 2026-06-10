import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import {
  documentNodeRowFromDb,
  documentRowFromDb,
} from './rowMappers';
import type {
  KbDocumentNodeRow,
  KbDocumentRow,
  UpsertDocumentStructureParams,
} from './types';

export function upsertDocumentStructure(
  db: BetterSqlite3Database,
  params: UpsertDocumentStructureParams,
): void {
  db.transaction(() => {
    const d = params.document;
    db
      .prepare(
        `INSERT INTO kb_documents
           (raw_id, doc_name, doc_description, unit_type, unit_count, structure_status, structure_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(raw_id) DO UPDATE SET
             doc_name = excluded.doc_name,
             doc_description = excluded.doc_description,
             unit_type = excluded.unit_type,
             unit_count = excluded.unit_count,
             structure_status = excluded.structure_status,
             structure_error = excluded.structure_error,
             updated_at = excluded.updated_at`,
      )
      .run(
        d.rawId,
        d.docName,
        d.docDescription,
        d.unitType,
        d.unitCount,
        d.structureStatus,
        d.structureError,
        d.createdAt,
        d.updatedAt,
      );

    db.prepare('DELETE FROM kb_document_nodes WHERE raw_id = ?').run(d.rawId);
    const insertNode = db.prepare(
      `INSERT INTO kb_document_nodes
         (node_id, raw_id, parent_node_id, title, summary, start_unit, end_unit, sort_order, source, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const node of params.nodes) {
      insertNode.run(
        node.nodeId,
        d.rawId,
        node.parentNodeId,
        node.title,
        node.summary,
        node.startUnit,
        node.endUnit,
        node.sortOrder,
        node.source,
        node.metadata ? JSON.stringify(node.metadata) : null,
      );
    }
  })();
}

export function getDocument(
  db: BetterSqlite3Database,
  rawId: string,
): KbDocumentRow | null {
  const row = db
    .prepare<
      unknown[],
      {
        raw_id: string;
        doc_name: string;
        doc_description: string | null;
        unit_type: string;
        unit_count: number;
        structure_status: string;
        structure_error: string | null;
        created_at: string;
        updated_at: string;
      }
    >('SELECT * FROM kb_documents WHERE raw_id = ?')
    .get(rawId);
  return row ? documentRowFromDb(row) : null;
}

export function listDocumentNodes(
  db: BetterSqlite3Database,
  rawId: string,
): KbDocumentNodeRow[] {
  const rows = db
    .prepare<
      unknown[],
      {
        node_id: string;
        raw_id: string;
        parent_node_id: string | null;
        title: string;
        summary: string | null;
        start_unit: number;
        end_unit: number;
        sort_order: number;
        source: string;
        metadata_json: string | null;
      }
    >('SELECT * FROM kb_document_nodes WHERE raw_id = ? ORDER BY sort_order, start_unit, node_id')
    .all(rawId);
  return rows.map(documentNodeRowFromDb);
}

export function listDocuments(
  db: BetterSqlite3Database,
  opts: { query?: string; limit?: number } = {},
): KbDocumentRow[] {
  const limit = opts.limit ?? 50;
  const params: unknown[] = [];
  let where = '';
  if (opts.query && opts.query.trim() !== '') {
    const needle = '%' + opts.query.trim().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    where = "WHERE doc_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR doc_description LIKE ? ESCAPE '\\' COLLATE NOCASE";
    params.push(needle, needle);
  }
  const rows = db
    .prepare<
      unknown[],
      {
        raw_id: string;
        doc_name: string;
        doc_description: string | null;
        unit_type: string;
        unit_count: number;
        structure_status: string;
        structure_error: string | null;
        created_at: string;
        updated_at: string;
      }
    >(`SELECT * FROM kb_documents ${where} ORDER BY updated_at DESC, doc_name LIMIT ?`)
    .all(...params, limit);
  return rows.map(documentRowFromDb);
}

export function deleteDocumentStructure(
  db: BetterSqlite3Database,
  rawId: string,
): void {
  db.prepare('DELETE FROM kb_documents WHERE raw_id = ?').run(rawId);
}
