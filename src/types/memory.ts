// ── Workspace Memory Types ───────────────────────────────────────────

export type MemoryProcessorStatus =
  | 'last_succeeded'
  | 'authentication_failed'
  | 'unavailable'
  | 'runtime_failed'
  | 'bad_output';

export interface MemoryProcessorStatusSnapshot {
  status: MemoryProcessorStatus;
  updatedAt: string;
  backendId?: string;
  profileId?: string;
  profileName?: string;
  chatBackendId?: string;
  chatProfileId?: string;
  chatProfileName?: string;
  differsFromChatProfile?: boolean;
  error?: string;
}

/**
 * Fired when the real-time MemoryWatcher re-captures workspace memory
 * during an active stream. Lightweight payload — the frontend uses this
 * only as a trigger to show a "memory updated" pill and to refresh the
 * memory panel if it's open. The full snapshot is fetched separately via
 * `GET /workspaces/:hash/memory`.
 */
export interface MemoryUpdateEvent {
  type: 'memory_update';
  /** ISO 8601 timestamp of the new snapshot. */
  capturedAt: string;
  /** Total number of `.md` files in the new snapshot. */
  fileCount: number;
  /** Filenames added or whose content changed since the source conversation's previous frame. */
  changedFiles: string[];
  /** Conversation that caused the memory write, when the source is conversation-scoped. */
  sourceConversationId?: string | null;
  /** Whether this recipient should render an in-chat Memory update bubble. */
  displayInChat?: boolean;
  /** Governed write decisions that caused, skipped, or annotated this update. */
  writeOutcomes?: MemoryWriteOutcome[];
}

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'unknown';

/** Where a memory file came from. */
export type MemorySource = 'cli-capture' | 'memory-note' | 'session-extraction';

/** Lifecycle state assigned by Agent Cockpit's workspace memory sidecar. */
export type MemoryStatus = 'active' | 'superseded' | 'redacted' | 'deleted';

/** Sharing boundary for a memory entry. V1 only writes workspace-scoped entries. */
export type MemoryScope = 'workspace' | 'user';

export interface MemoryRedaction {
  kind: string;
  reason: string;
}

export type MemoryWriteAction =
  | 'saved'
  | 'skipped_duplicate'
  | 'skipped_ephemeral'
  | 'redacted_saved'
  | 'superseded_saved';

export interface MemoryWriteOutcome {
  action: MemoryWriteAction;
  reason: string;
  filename?: string;
  skipped?: string | boolean;
  duplicateOf?: string;
  superseded?: string[];
  redaction?: MemoryRedaction[];
}

export interface MemorySearchOptions {
  query: string;
  limit?: number;
  types?: MemoryType[];
  statuses?: MemoryStatus[];
}

export interface MemorySearchResult {
  filename: string;
  entryId: string;
  name: string | null;
  description: string | null;
  type: MemoryType;
  source: MemorySource;
  status: MemoryStatus;
  score: number;
  snippet: string;
  content: string;
  metadata: MemoryEntryMetadata;
}

export type MemoryConsolidationActionType =
  | 'mark_superseded'
  | 'merge_candidates'
  | 'split_candidate'
  | 'normalize_candidate'
  | 'keep';

export interface MemoryConsolidationAction {
  action: MemoryConsolidationActionType;
  reason: string;
  filename?: string;
  supersededBy?: string;
  filenames?: string[];
  title?: string;
}

export interface MemoryConsolidationProposal {
  id: string;
  createdAt: string;
  summary: string;
  actions: MemoryConsolidationAction[];
}

export type MemoryConsolidationDraftOperationType = 'create' | 'replace';

export interface MemoryConsolidationDraftOperation {
  operation: MemoryConsolidationDraftOperationType;
  reason: string;
  content: string;
  filename?: string;
  filenameHint?: string;
  supersedes?: string[];
}

export interface MemoryConsolidationDraft {
  id: string;
  createdAt: string;
  action: MemoryConsolidationAction;
  summary: string;
  operations: MemoryConsolidationDraftOperation[];
}

export interface MemoryConsolidationSkippedAction {
  action: MemoryConsolidationAction;
  reason: string;
}

export interface MemoryConsolidationSkippedDraftOperation {
  operation: MemoryConsolidationDraftOperation;
  reason: string;
}

export interface MemoryConsolidationApplyResult {
  ok: true;
  applied: MemoryConsolidationAction[];
  skipped: MemoryConsolidationSkippedAction[];
  auditPath: string | null;
  snapshot: MemorySnapshot | null;
}

export interface MemoryConsolidationDraftApplyResult {
  ok: true;
  applied: MemoryConsolidationDraftOperation[];
  skipped: MemoryConsolidationSkippedDraftOperation[];
  createdFiles: string[];
  changedFiles: string[];
  auditPath: string | null;
  snapshot: MemorySnapshot | null;
}

export interface MemoryConsolidationAudit {
  version: 1;
  createdAt: string;
  summary: string;
  applied: MemoryConsolidationAction[];
  skipped: MemoryConsolidationSkippedAction[];
  appliedDraftOperations?: MemoryConsolidationDraftOperation[];
  skippedDraftOperations?: MemoryConsolidationSkippedDraftOperation[];
}

export interface MemoryEntryMetadata {
  /** Stable ID derived from the workspace-relative filename unless explicitly migrated later. */
  entryId: string;
  /** Relative path inside `memory/files/`, using forward slashes. */
  filename: string;
  status: MemoryStatus;
  scope: MemoryScope;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
  sourceConversationId?: string;
  supersedes?: string[];
  supersededBy?: string;
  confidence?: number;
  redaction?: MemoryRedaction[];
}

export interface MemoryMetadataIndex {
  version: 1;
  updatedAt: string;
  entries: Record<string, MemoryEntryMetadata>;
}

export interface MemoryFile {
  /**
   * Relative path inside the workspace memory files dir, using forward
   * slashes. Examples:
   *   - `claude/feedback_testing.md`  (Claude Code native capture)
   *   - `notes/note_2026-04-07T18-30-15_slug.md`  (memory_note MCP tool)
   *   - `notes/session_abc123_1.md`  (post-session extraction)
   *
   * Legacy snapshots may have a bare filename like `feedback_testing.md`;
   * those are treated as living under `claude/` at read time.
   */
  filename: string;
  /** Parsed frontmatter `name`, if present. */
  name: string | null;
  /** Parsed frontmatter `description`, if present. */
  description: string | null;
  /** Parsed frontmatter `type`, normalized to a known type or 'unknown'. */
  type: MemoryType;
  /** Raw file content (frontmatter + body). */
  content: string;
  /**
   * Provenance of this file. Defaults to `cli-capture` for entries loaded
   * from older snapshots that don't carry the field.
   */
  source?: MemorySource;
  /**
   * Agent Cockpit-owned lifecycle metadata loaded from
   * `memory/state.json`. Older workspaces and legacy snapshots may not
   * carry this field; callers should treat absence as active workspace
   * memory until `ChatService` synthesizes it.
   */
  metadata?: MemoryEntryMetadata;
}

export interface MemorySnapshot {
  /** ISO 8601 timestamp of when this snapshot was captured. */
  capturedAt: string;
  /**
   * Backend the most recent CLI-capture came from (e.g. "claude-code"), or
   * the backend that most recently touched the store for non-capture
   * backends (e.g. after a memory_note write).
   */
  sourceBackend: string;
  /** Absolute path to the source memory directory the snapshot came from. */
  sourcePath: string | null;
  /** Contents of the source `MEMORY.md` index (may be empty). */
  index: string;
  /** Individual memory files (both CLI captures and notes). */
  files: MemoryFile[];
}
