// ── Workspace Knowledge Base Types ───────────────────────────────────

/** KB status block on conversation responses (avoids extra round-trip for the KB status icon). */
export interface ConversationKbStatus {
  enabled: boolean;
  dreamingNeeded: boolean;
  pendingEntries: number;
  /** Raw files awaiting digestion (status = 'ingested' | 'pending-delete'). */
  pendingDigestions: number;
  /** Per-workspace auto-digest toggle — when true, pendingDigestions drains on its own. */
  autoDigest: boolean;
  dreamingStatus: 'idle' | 'running' | 'failed';
  failedItems: number;
}

//
// The per-workspace KB is a three-stage pipeline:
//   1. Ingestion  — our code parses the raw file into a lossless converted
//                   form (`converted/<rawId>/...`).
//   2. Digestion  — a CLI (configured globally) reads one converted item and
//                   emits a structured entry file (`entries/<id>.md`) with
//                   YAML frontmatter.
//   3. Dreaming   — a CLI (configured globally, manual only) integrates
//                   entries into a synthesis layer (`synthesis/*.md`) that
//                   cross-links concepts. Incremental by default.
//
// All pipeline state is tracked in `state.json` at the workspace KB root.
// Schema version lets us evolve the entry format without silently
// re-digesting existing files.

/**
 * Status of an individual raw file progressing through the pipeline.
 * - ingesting: converting handler running
 * - ingested: ready for digestion
 * - digesting: CLI running
 * - digested: has zero or more entries
 * - failed: conversion or digestion failed (see error_class/error_message)
 * - pending-delete: queued for deletion in manual-digest mode, processed
 *   via "Digest All Pending"
 */
export type KbRawStatus =
  | 'ingesting'
  | 'ingested'
  | 'digesting'
  | 'digested'
  | 'failed'
  | 'pending-delete';

/** Status of the workspace's synthesis layer (produced by Dreaming). */
export type KbSynthesisStatus = 'empty' | 'fresh' | 'stale' | 'dreaming';

/**
 * Classes of error that can land on a raw row. Stored as a string in the
 * DB so new classes can be added without a schema migration.
 * - timeout: runOneShot exceeded its timeout
 * - cli_error: CLI exited non-zero
 * - malformed_output: stdout unparseable as entry-delimited YAML/body
 * - schema_rejection: parsed but a field failed validation
 * - unknown: catch-all
 */
export type KbErrorClass =
  | 'timeout'
  | 'cli_error'
  | 'malformed_output'
  | 'schema_rejection'
  | 'unknown';

/**
 * One raw file visible in the KB Browser list. Shape mirrors the `raw`
 * table plus the location fields from `raw_locations`, so the UI has
 * everything it needs for a row in one object. Same rawId can appear in
 * multiple `KbRawEntry` objects (once per location) when identical bytes
 * live in multiple folders.
 */
export interface KbRawEntry {
  /** First 16 chars of sha256(file). Stable across renames, unique per workspace. */
  rawId: string;
  /** Full 64-hex sha256 of the raw bytes. */
  sha256: string;
  /** Original filename as uploaded (per-location — same rawId can have multiple). */
  filename: string;
  /** Virtual folder path the file lives in. '' = root. */
  folderPath: string;
  /** MIME type as detected at upload time. */
  mimeType: string;
  /** Raw byte size of the uploaded file. */
  sizeBytes: number;
  /** Handler that produced the converted form (pdf, docx, pptx, passthrough/text, ...). */
  handler?: string;
  /** ISO 8601 timestamp of the upload (for this specific location). */
  uploadedAt: string;
  /** ISO 8601 timestamp of the most recent successful digestion, or null. */
  digestedAt: string | null;
  /** Current pipeline status for the raw row this location belongs to. */
  status: KbRawStatus;
  /** Error class if status === 'failed'. */
  errorClass?: KbErrorClass | null;
  /** Full error message if status === 'failed'. */
  errorMessage?: string | null;
  /** Handler metadata blob (pageCount, slideCount, etc.). */
  metadata?: Record<string, unknown>;
  /** Number of digested entries currently in the `entries` table for this raw. 0 when not digested. */
  entryCount: number;
}

/** One virtual folder in the KB. '' is root. */
export interface KbFolder {
  folderPath: string;
  createdAt: string;
}

/**
 * One entry digested from a raw file. The body lives on disk at
 * `entries/<entryId>/entry.md`; this is the metadata the UI and the DB
 * care about. `tags` is the associated tag set (joined from entry_tags
 * at read time for convenience).
 */
export interface KbEntry {
  /** Stable entry ID in the form <rawId>-<slug>[-<n>]. */
  entryId: string;
  /** Parent raw file. */
  rawId: string;
  /** Entry title from the frontmatter. */
  title: string;
  /** Slug portion of the entry ID. */
  slug: string;
  /** One-line summary from the frontmatter. */
  summary: string;
  /** Entry schema version — bumped when the digestion prompt/format changes. */
  schemaVersion: number;
  /** True when the current entrySchemaVersion is newer than this entry's. */
  staleSchema?: boolean;
  /** ISO 8601 timestamp of the digestion that produced this entry. */
  digestedAt: string;
  /** Tag set for this entry (denormalized from entry_tags for UI convenience). */
  tags: string[];
}

/** Source range that contributed to a digested KB entry. */
export interface KbEntrySource {
  entryId: string;
  rawId: string;
  nodeId: string | null;
  chunkId: string;
  startUnit: number;
  endUnit: number;
  docName: string | null;
  unitType: 'page' | 'slide' | 'line' | 'section' | 'unknown' | null;
  nodeTitle: string | null;
}

/** Aggregate counters rendered in the KB Browser header. */
export interface KbCounters {
  rawTotal: number;
  rawByStatus: Record<KbRawStatus, number>;
  failedByStage: {
    conversion: number;
    digestion: number;
    unknown: number;
  };
  entryCount: number;
  pendingCount: number; // ingested + pending-delete
  folderCount: number;
  documentCount: number;
  documentNodeCount: number;
  entrySourceCount: number;
  topicCount: number;
  connectionCount: number;
  reflectionCount: number;
  staleReflectionCount: number;
  /** True when this workspace has an embedding config and can maintain vector indexes. */
  embeddingConfigured?: boolean;
  /** Number of KB entries currently present in the vector store, or null when unavailable. */
  entryEmbeddedCount?: number | null;
  /** Number of synthesis topics currently present in the vector store, or null when unavailable. */
  topicEmbeddedCount?: number | null;
  /** Non-fatal vector-store read error captured while building the state snapshot. */
  embeddingIndexError?: string | null;
}

export type KbDigestChunkPhase = 'planning' | 'digesting' | 'parsing' | 'committing';

export interface KbDigestChunkProgress {
  /** Chunks that have completed CLI extraction + parsing in the active digestion session. */
  done: number;
  /** Chunks planned so far in the active digestion session. Grows as queued raws reach planning. */
  total: number;
  /** Chunks currently inside CLI extraction or parse handling. */
  active: number;
  /** Coarse phase of the most recently updated chunk/digest write step. */
  phase: KbDigestChunkPhase;
  /** Most recently updated raw/chunk. Aggregate sessions may have more than one active chunk. */
  current?: {
    rawId: string;
    chunkId?: string;
    index?: number;
    total?: number;
    startUnit?: number;
    endUnit?: number;
    unitType?: string;
  };
}

/**
 * Aggregate digestion-queue progress for a workspace. Spans every digest
 * call (batch, single-file manual, auto-digest) that runs while the
 * per-workspace queue is busy; the server opens a session on the first
 * enqueue into an idle queue and closes it when `done === total`.
 *
 * Persisted to `digest_session` in the KB DB so a mid-flight reload
 * rehydrates the toolbar without losing ETA accuracy.
 */
export interface KbDigestProgress {
  /** Tasks completed since the session opened. */
  done: number;
  /** Tasks enqueued since the session opened (bumps if new items arrive mid-session). */
  total: number;
  /** Average per-file digestion duration (ms) across completed tasks. 0 until the first task settles. */
  avgMsPerItem: number;
  /** Estimated remaining wall-clock time (ms). Omitted until `done >= 2` to avoid noisy initial estimates. */
  etaMs?: number;
  /** Live aggregate chunk progress for the active digestion session. */
  chunks?: KbDigestChunkProgress;
}

export type KbAutoDreamMode = 'off' | 'interval' | 'window';

export interface KbAutoDreamConfig {
  mode: KbAutoDreamMode;
  /** Positive integer hours for interval mode. */
  intervalHours?: number;
  /** Local server time in HH:mm format for window mode. */
  windowStart?: string;
  /** Local server time in HH:mm format for window mode. */
  windowEnd?: string;
}

export interface KbAutoDreamState extends KbAutoDreamConfig {
  /** ISO timestamp for the next eligible scheduler start, or null when off. */
  nextRunAt: string | null;
  /** True when the current local server time is inside the configured window. */
  windowActive?: boolean;
  /** ISO timestamp for the current/next window end when mode is window. */
  windowEndAt?: string | null;
}

export type KbDreamPhase = 'routing' | 'verification' | 'synthesis' | 'discovery' | 'reflection';

export interface KbDreamProgress {
  phase: KbDreamPhase;
  done: number;
  total: number;
  startedAt?: number;
  phaseStartedAt?: number;
}

/**
 * Snapshot of the KB state surfaced by `GET /kb`. The entries and raws
 * lists are paginated at the endpoint level; this object always holds
 * counters + folder tree + a page of the currently-focused folder.
 */
export interface KbState {
  /** State schema version (the DB layer's schema version — stored in meta table). */
  version: number;
  /** Current digestion entry schema version. */
  entrySchemaVersion: number;
  /** Per-workspace auto-digest flag (mirrors WorkspaceIndex.kbAutoDigest). */
  autoDigest: boolean;
  /** Per-workspace automatic dreaming schedule. */
  autoDream: KbAutoDreamConfig;
  /** Current synthesis status from the persisted KB metadata. */
  dreamingStatus: string;
  /** Live dream progress when the synthesis pipeline is running. */
  dreamProgress: KbDreamProgress | null;
  /** Entries that have been digested but still need the Dream/Synthesis pass. */
  needsSynthesisCount: number;
  /** High-level counters for the header/badges. */
  counters: KbCounters;
  /** Folder tree, flat list sorted by folderPath. */
  folders: KbFolder[];
  /** Raw files in the currently-focused folder (or empty when listing is disabled). */
  raw: KbRawEntry[];
  /**
   * Aggregate digestion progress snapshot when the per-workspace queue is
   * busy; `null` when idle. Populated from the persisted `digest_session`
   * row so a mid-flight page reload hydrates the toolbar progress + ETA.
   */
  digestProgress: KbDigestProgress | null;
  /** ISO 8601 timestamp of the most recent mutation (for cache busting). */
  updatedAt: string;
}

/** API response shape for `GET /kb/synthesis`. */
export interface KbSynthesisState {
  status: string;
  stopping?: boolean;
  lastRunAt: string | null;
  lastRunError: string | null;
  topicCount: number;
  connectionCount: number;
  needsSynthesisCount: number;
  godNodes: string[];
  dreamProgress?: KbDreamProgress | null;
  reflectionCount?: number;
  staleReflectionCount?: number;
  autoDream?: KbAutoDreamState;
  topics: KbSynthesisTopicSummary[];
  connections: KbSynthesisConnectionSummary[];
}

/** Topic summary for the synthesis tab list view. */
export interface KbSynthesisTopicSummary {
  topicId: string;
  title: string;
  summary: string | null;
  entryCount: number;
  connectionCount: number;
  isGodNode: boolean;
}

/** Connection summary for the synthesis tab list view. */
export interface KbSynthesisConnectionSummary {
  sourceTopic: string;
  targetTopic: string;
  relationship: string;
  confidence: string;
}

/** API response shape for `GET /kb/synthesis/:id`. */
export interface KbSynthesisTopicDetail {
  topicId: string;
  title: string;
  summary: string | null;
  content: string | null;
  updatedAt: string;
  entryCount: number;
  connectionCount: number;
  isGodNode: boolean;
  entries: KbEntry[];
  connections: KbSynthesisConnectionSummary[];
}

/** API response shape for `GET /kb/reflections` list items. */
export interface KbReflectionSummary {
  reflectionId: string;
  title: string;
  type: string;
  summary: string | null;
  citationCount: number;
  createdAt: string;
  isStale: boolean;
}

/** API response shape for `GET /kb/reflections/:id`. */
export interface KbReflectionDetail {
  reflectionId: string;
  title: string;
  type: string;
  summary: string | null;
  content: string;
  createdAt: string;
  citationCount: number;
  citedEntries: KbEntry[];
}

/**
 * Lightweight notification emitted when KB state changes during an
 * active stream (or via an HTTP mutation). The full state is fetched
 * separately via `GET /workspaces/:hash/kb` — this frame is only a
 * trigger. Shape mirrors `memory_update` for consistency.
 */
export interface KbStateUpdateEvent {
  type: 'kb_state_update';
  /** ISO 8601 timestamp of the new state. */
  updatedAt: string;
  /**
   * What changed in this tick. Frontend uses this to decide whether to
   * refetch, toast, or highlight the affected row. `folders: true` means
   * the folder tree changed (created/renamed/deleted). `digestProgress`
   * is emitted on every digest enqueue/settle so the toolbar can render
   * live `done / total — ~ETA` across batch, single-file, and
   * auto-digest runs (one unified session per workspace).
   */
  changed: {
    raw?: string[];
    entries?: string[];
    folders?: boolean;
    synthesis?: boolean;
    autoDream?: boolean;
    digestProgress?: KbDigestProgress | null;
    /**
     * Per-workspace digestion-session counter. Fires on every entry-
     * creating settle (single or batch) with `active: true` and the
     * cumulative `entriesCreated`. Fires exactly once with
     * `active: false` when the digestion queue drains to zero, so the
     * frontend can flip from a live count-up to a dismissable
     * "Digestion complete" summary. The session resets on the next
     * enqueue.
     */
    digestion?: { active: boolean; entriesCreated: number };
    dreamProgress?: KbDreamProgress;
    /** Emitted when a cooperative stop has been requested for an in-progress dream run. */
    stopping?: boolean;
    /** Per-raw substep text shown beneath the status badge during long operations. */
    substep?: { rawId: string; text: string };
  };
}
