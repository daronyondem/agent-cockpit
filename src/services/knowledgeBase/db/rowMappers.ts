import type {
  KbErrorClass,
  KbRawEntry,
  KbRawStatus,
} from '../../../types';
import type {
  KbDocumentNodeRow,
  KbDocumentNodeSource,
  KbDocumentRow,
  KbDocumentStructureStatus,
  KbDocumentUnitType,
  KbGlossaryRow,
  RawJoinRow,
} from './types';

export function rawJoinRowToEntry(row: RawJoinRow): KbRawEntry {
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

export function documentRowFromDb(row: {
  raw_id: string;
  doc_name: string;
  doc_description: string | null;
  unit_type: string;
  unit_count: number;
  structure_status: string;
  structure_error: string | null;
  created_at: string;
  updated_at: string;
}): KbDocumentRow {
  return {
    rawId: row.raw_id,
    docName: row.doc_name,
    docDescription: row.doc_description,
    unitType: row.unit_type as KbDocumentUnitType,
    unitCount: row.unit_count,
    structureStatus: row.structure_status as KbDocumentStructureStatus,
    structureError: row.structure_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function documentNodeRowFromDb(row: {
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
}): KbDocumentNodeRow {
  return {
    nodeId: row.node_id,
    rawId: row.raw_id,
    parentNodeId: row.parent_node_id,
    title: row.title,
    summary: row.summary,
    startUnit: row.start_unit,
    endUnit: row.end_unit,
    sortOrder: row.sort_order,
    source: row.source as KbDocumentNodeSource,
    metadata: row.metadata_json ? parseMetadata(row.metadata_json) : undefined,
  };
}

export function glossaryRowFromDb(row: {
  id: number;
  term: string;
  expansion: string;
  created_at: string;
  updated_at: string;
}): KbGlossaryRow {
  return {
    id: row.id,
    term: row.term,
    expansion: row.expansion,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function parseMetadata(json: string): Record<string, unknown> | undefined {
  try {
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
