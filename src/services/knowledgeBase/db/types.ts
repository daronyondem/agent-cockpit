import type {
  KbDigestChunkProgress,
  KbDreamProgress,
  KbErrorClass,
  KbRawStatus,
} from '../../../types';

/** Default page size for folder listings. */
export const DEFAULT_RAW_PAGE_SIZE = 500;

/** Raw DB row shape for the `raw` table. */
export interface RawDbRow {
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
export interface RawJoinRow extends RawDbRow {
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

/** Parameters for inserting one source range that contributed to an entry. */
export interface InsertEntrySourceParams {
  entryId: string;
  rawId: string;
  nodeId?: string | null;
  chunkId: string;
  startUnit: number;
  endUnit: number;
}

/** Parameters for atomically replacing one raw's digested entries. */
export interface ReplaceEntryParams extends InsertEntryParams {
  sources: Array<Omit<InsertEntrySourceParams, 'entryId'>>;
}

/** Stored error details for a raw row (when status === 'failed'). */
export interface RawError {
  errorClass: KbErrorClass;
  errorMessage: string;
}

export type KbDocumentUnitType = 'page' | 'slide' | 'line' | 'section' | 'unknown';
export type KbDocumentStructureStatus = 'ready' | 'failed';
export type KbDocumentNodeSource = 'deterministic' | 'ai' | 'fallback';

export interface KbDocumentRow {
  rawId: string;
  docName: string;
  docDescription: string | null;
  unitType: KbDocumentUnitType;
  unitCount: number;
  structureStatus: KbDocumentStructureStatus;
  structureError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KbDocumentNodeRow {
  nodeId: string;
  rawId: string;
  parentNodeId: string | null;
  title: string;
  summary: string | null;
  startUnit: number;
  endUnit: number;
  sortOrder: number;
  source: KbDocumentNodeSource;
  metadata?: Record<string, unknown>;
}

export interface KbEntrySourceRow {
  entryId: string;
  rawId: string;
  nodeId: string | null;
  chunkId: string;
  startUnit: number;
  endUnit: number;
  docName: string | null;
  unitType: KbDocumentUnitType | null;
  nodeTitle: string | null;
}

export interface KbGlossaryRow {
  id: number;
  term: string;
  expansion: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertDocumentStructureParams {
  document: KbDocumentRow;
  nodes: KbDocumentNodeRow[];
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

export type SynthesisRunMode = 'incremental' | 'redream';
export type SynthesisRunStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface SynthesisRunRow {
  runId: string;
  mode: SynthesisRunMode;
  status: SynthesisRunStatus;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

export interface InsertTopicHistoryParams {
  topicId: string;
  changeType: 'created' | 'updated' | 'merged_into' | 'split_from' | 'deleted';
  oldContent: string | null;
  newContent: string | null;
  entryIds: string[];
  runId?: string | null;
  changedAt: string;
}

export interface SynthesisTopicHistoryRow extends InsertTopicHistoryParams {
  id: number;
  runId: string | null;
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
  dreamProgress: KbDreamProgress | null;
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
  chunkProgress?: KbDigestChunkProgress | null;
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
