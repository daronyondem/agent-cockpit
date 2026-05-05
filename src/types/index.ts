import type { Request, Response, NextFunction, Express } from 'express';

// ── Usage ────────────────────────────────────────────────────────────────────

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Kiro credits consumed (fractional, Kiro-specific unit). */
  credits?: number;
  /** Percentage of the model's context window used (0–100). Snapshot, not cumulative. */
  contextUsagePercentage?: number;
}

// ── Usage Ledger (daily per-backend/model records) ──────────────────────────

export interface UsageLedgerRecord {
  backend: string;
  model: string;
  usage: Usage;
}

export interface UsageLedgerDay {
  date: string;           // YYYY-MM-DD
  records: UsageLedgerRecord[];
}

export interface UsageLedger {
  days: UsageLedgerDay[];
}

// ── Tool Activity ────────────────────────────────────────────────────────────

export interface ToolActivity {
  tool: string;
  description: string;
  id: string | null;
  duration: number | null;
  startTime: number;
  isAgent?: boolean;
  subagentType?: string;
  parentAgentId?: string;
  outcome?: string;
  status?: string;
  /**
   * Incremented by the server every time a CLI `user` event (tool_result)
   * closes out a batch of tool_uses. Tools emitted back-to-back without an
   * intervening `user` event share the same `batchIndex` — those are the
   * parallel tool calls from a single LLM assistant turn. The frontend uses
   * this to group parallel runs correctly instead of relying on startTime
   * gaps (which drift based on per-tool execution overhead).
   */
  batchIndex?: number;
}

// ── Messages ─────────────────────────────────────────────────────────────────

/**
 * Ordered content block on an assistant message. Preserves the interleaving
 * of text, thinking, and tool activity as the CLI emits it so the renderer
 * can show "text → tool → text → tool" in source order instead of grouping
 * all tools and all text into separate buckets.
 *
 * When `contentBlocks` is present on a Message it is authoritative; the
 * legacy `content`, `thinking`, and `toolActivity` fields are derived views
 * kept for back-compat with session files written before this field existed.
 */
export type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool'; activity: ToolActivity };

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  backend: string;
  timestamp: string;
  thinking?: string;
  toolActivity?: ToolActivity[];
  /**
   * Ordered interleaving of text / thinking / tool blocks as they arrived
   * from the backend. Assistant messages only. Absent on older messages
   * — the renderer falls back to `content` + `toolActivity` when missing.
   */
  contentBlocks?: ContentBlock[];
  /**
   * Assistant messages only. Marks a durable terminal stream failure that
   * should render as an error outcome rather than a normal assistant reply.
   */
  streamError?: {
    message: string;
    source?: StreamErrorSource;
  };
  /**
   * Assistant messages only. `progress` = intermediate segment saved at a
   * `turn_boundary` (agent still has more tool work to do). `final` = last
   * segment of the agent run saved at `done`. Absent on user/system messages
   * and on pre-existing assistant messages written before this field existed
   * — the renderer treats absent as `final` for back-compat.
   */
  turn?: 'progress' | 'final';
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export interface SessionEntry {
  number: number;
  sessionId: string;
  summary: string | null;
  active: boolean;
  messageCount: number;
  startedAt: string;
  endedAt: string | null;
  usage?: Usage | null;
  usageByBackend?: Record<string, Usage> | null;
  /** Backend-managed session ID (e.g. Kiro ACP session ID). Generic — any backend can use this. */
  externalSessionId?: string | null;
}

export interface SessionFile {
  sessionNumber: number;
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  messages: Message[];
}

export interface SessionHistoryItem {
  number: number;
  sessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  messageCount: number;
  summary: string | null;
  isCurrent: boolean;
}

// ── Conversations ────────────────────────────────────────────────────────────

/** Adaptive reasoning effort level. Supported values are model/backend-specific. */
export type EffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Broad type grouping for an attachment, used by the composer to pick an icon
 * tile + color. Derived server-side from file extension at upload time so the
 * client can render type-aware chips without any client-side guessing.
 */
export type AttachmentKind = 'image' | 'pdf' | 'text' | 'code' | 'md' | 'folder' | 'file';

/**
 * Structured metadata for a single attachment on a user message. Produced by
 * `POST /conversations/:id/upload` (enriched response) and carried verbatim on
 * queued messages so the client can render typed chips without re-inferring.
 * `path` is the absolute server path that is appended to the message content
 * as `[Uploaded files: <path>]` when the message ships to the backend — the
 * CLI reads the files from disk using those paths.
 */
export interface AttachmentMeta {
  /** Basename of the file (e.g. "network-timeline.png"). */
  name: string;
  /** Absolute server path inside the conversation's artifacts dir. */
  path: string;
  /** Raw byte size, when known. */
  size?: number;
  /** Broad kind grouping for the composer chip. */
  kind: AttachmentKind;
  /** Human-readable secondary line for the chip (e.g. "1.8 MB", "service/kb"). */
  meta?: string;
}

/**
 * One entry in a conversation's message queue. `content` is the plain user
 * text (without the `[Uploaded files: …]` tag); `attachments` carry the typed
 * metadata the composer needs to render chips. On drain, the client rebuilds
 * the wire format by appending `[Uploaded files: <paths>]` back onto content.
 *
 * Legacy queues stored as `string[]` are auto-migrated to this shape on read
 * (see `_normalizeQueue` / `_parseUploadedFilesTag` in chatService).
 */
export interface QueuedMessage {
  content: string;
  attachments?: AttachmentMeta[];
}

export interface ConversationEntry {
  id: string;
  title: string;
  /**
   * True once the user has manually renamed the conversation via PUT
   * /conversations/:id. Locks the title against all automatic mutations
   * (resetSession's "New Chat" stamp, addMessage's first-message snapshot,
   * generateAndUpdateTitle's LLM-generated title) so a manual rename
   * survives session resets and subsequent activity.
   */
  titleManuallySet?: boolean;
  backend: string;
  /**
   * Runtime CLI profile selected for this conversation. Phase 1 stores
   * server-configured profiles that preserve the existing vendor behavior;
   * later phases resolve this ID to account/config/env-specific CLI runtime.
   */
  cliProfileId?: string;
  model?: string;
  /** Adaptive reasoning effort level for supported models. */
  effort?: EffortLevel;
  currentSessionId: string;
  lastActivity: string;
  lastMessage: string | null;
  usage?: Usage;
  usageByBackend?: Record<string, Usage>;
  sessions: SessionEntry[];
  archived?: boolean;
  /**
   * True when the conversation has received a new response since the user
   * last opened it. Set by the client when a stream completes on a non-active
   * conversation (or manually via the sidebar dot); cleared when the user
   * selects the conversation. Absent/false for read conversations.
   */
  unread?: boolean;
  messageQueue?: QueuedMessage[];
}

export interface WorkspaceIndex {
  workspacePath: string;
  instructions?: string;
  /**
   * Whether per-workspace Memory is enabled. When false/undefined, the
   * workspace behaves exactly as before this feature: no memory injection,
   * no MCP memory_note exposure, no post-session extraction.
   */
  memoryEnabled?: boolean;
  /**
   * Whether per-workspace Knowledge Base is enabled. When false/undefined,
   * the workspace behaves exactly as before the KB feature: no KB pointer
   * injection, no `kb_ingest` MCP exposure, no pipeline activity. Default
   * is `false` — users opt in per workspace via the KB tab in Workspace
   * Settings.
   */
  kbEnabled?: boolean;
  /**
   * Per-workspace auto-digest flag. When true, ingested files are
   * automatically digested once conversion completes. Default false.
   * Toggling this on does NOT retroactively digest existing ingested
   * files — users must click "Digest All Pending" for that.
   */
  kbAutoDigest?: boolean;
  /**
   * Per-workspace automatic dreaming schedule. Default/off when absent.
   * Interval mode starts incremental dreaming every N hours when pending
   * synthesis exists. Window mode starts only inside the local server-time
   * window and requests a cooperative stop at the window end.
   */
  kbAutoDream?: KbAutoDreamConfig;
  /**
   * Per-workspace embedding configuration for the Knowledge Base vector
   * search layer.  Ollama with nomic-embed-text is the only supported
   * provider.  Changing the model after embeddings exist triggers a
   * re-embed (existing vectors are wiped, entries/topics flagged
   * `needs_embedding`).
   */
  kbEmbedding?: {
    /** Ollama model name. Default `nomic-embed-text`. */
    model?: string;
    /** Ollama server URL. Default `http://localhost:11434`. */
    ollamaHost?: string;
    /** Embedding dimensions (must match the model). Default 768. */
    dimensions?: number;
  };
  conversations: ConversationEntry[];
}

export interface Conversation {
  id: string;
  title: string;
  backend: string;
  cliProfileId?: string;
  model?: string;
  effort?: EffortLevel;
  workingDir: string;
  workspaceHash: string;
  currentSessionId: string;
  sessionNumber: number;
  messages: Message[];
  usage?: Usage;
  sessionUsage?: Usage;
  /** Backend-managed session ID from the active session, for resume/rehydration. */
  externalSessionId?: string | null;
  messageQueue?: QueuedMessage[];
  archived?: boolean;
  /** KB status snapshot, populated when workspace has KB enabled. */
  kb?: ConversationKbStatus;
}

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

export interface ConversationListItem {
  id: string;
  title: string;
  updatedAt: string;
  backend: string;
  cliProfileId?: string;
  model?: string;
  effort?: EffortLevel;
  workingDir: string;
  workspaceHash: string;
  /** Per-workspace Knowledge Base toggle. Defaults to false for legacy workspaces. */
  workspaceKbEnabled: boolean;
  messageCount: number;
  lastMessage: string | null;
  usage: Usage | null;
  archived?: boolean;
  /** Mirror of `ConversationEntry.unread` so the sidebar can render unread dots without a second round-trip. */
  unread?: boolean;
}

// ── Settings ─────────────────────────────────────────────────────────────────

export type CliVendor = 'codex' | 'claude-code' | 'kiro';
export type CliAuthMode = 'server-configured' | 'account';

export interface CliProfile {
  id: string;
  name: string;
  vendor: CliVendor;
  /** Optional executable override. When omitted, the vendor default command is used. */
  command?: string;
  /** Server-configured keeps current server-side CLI state; account means Cockpit owns setup for this profile. */
  authMode: CliAuthMode;
  /** Optional vendor config/auth directory for account-isolated profiles. */
  configDir?: string;
  /** Optional runtime environment overrides applied when spawning this profile's CLI. */
  env?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  disabled?: boolean;
}

export interface Settings {
  theme: 'light' | 'dark' | 'system';
  sendBehavior: 'enter' | 'ctrlEnter';
  systemPrompt: string;
  defaultBackend: string;
  /** Runtime CLI profiles available for conversations and background CLI tasks. */
  cliProfiles?: CliProfile[];
  /** Default profile for new conversations once the UI switches from raw backend selection to profile selection. */
  defaultCliProfileId?: string;
  defaultModel?: string;
  /** Default adaptive reasoning effort. Only applies when defaultBackend/model supports it. */
  defaultEffort?: EffortLevel;
  workingDirectory?: string;
  /**
   * Globally-configured Memory CLI used for:
   *   (a) backing the `memory_note` MCP tool — processes incoming notes,
   *       classifies/dedupes, and formats them with frontmatter.
   *   (b) post-session extraction — reads non-Claude session transcripts and
   *       writes new memory entries.
   * The CLI selected here should be a CLI profile. `cliBackend` is retained
   * as a legacy fallback for settings written before CLI profiles existed.
   */
  memory?: {
    cliProfileId?: string;
    /** @deprecated Use cliProfileId. */
    cliBackend?: string;
    cliModel?: string;
    cliEffort?: EffortLevel;
  };
  /**
   * Globally-configured Knowledge Base CLIs. Three separate roles:
   *   - Ingestion: optional vision-capable CLI that converts visual
   *     content (PDF pages with figures/tables, DOCX images, PPTX slides
   *     with charts, standalone uploaded images) into clean Markdown at
   *     ingest time. When unset, those code paths fall back to image-only
   *     references (current behavior).
   *   - Digestion: runs once per raw file to produce structured entries.
   *   - Dreaming: manually invoked to synthesize entries into a coherent
   *     knowledge graph. Incremental by default, full rebuild on demand.
   * All three should point at CLI profiles. Legacy `*CliBackend` fields are
   * retained as fallbacks for older settings files. `convertSlidesToImages` opts into
   * the LibreOffice-backed PPTX slide rasterization path (global, not
   * per-workspace).
   */
  knowledgeBase?: {
    ingestionCliProfileId?: string;
    /** @deprecated Use ingestionCliProfileId. */
    ingestionCliBackend?: string;
    ingestionCliModel?: string;
    ingestionCliEffort?: EffortLevel;
    digestionCliProfileId?: string;
    /** @deprecated Use digestionCliProfileId. */
    digestionCliBackend?: string;
    digestionCliModel?: string;
    digestionCliEffort?: EffortLevel;
    dreamingCliProfileId?: string;
    /** @deprecated Use dreamingCliProfileId. */
    dreamingCliBackend?: string;
    dreamingCliModel?: string;
    dreamingCliEffort?: EffortLevel;
    /**
     * Max documents processed in parallel by ingestion, digestion, and
     * dreaming pipelines per workspace. Within a single document, work
     * stays sequential. Default 2.
     */
    cliConcurrency?: number;
    /**
     * @deprecated Renamed to `cliConcurrency`. Read-time migration in
     * `settingsService.getSettings()` copies this value forward when the
     * new key is missing. Kept on the type for one release cycle so old
     * `settings.json` files continue to load without warnings.
     */
    dreamingConcurrency?: number;
    /** Cosine similarity score above which an entry→topic match skips LLM verification. Default 0.75. */
    dreamingStrongMatchThreshold?: number;
    /** Cosine similarity score below which an entry is routed to new-topic creation. Default 0.45. */
    dreamingBorderlineThreshold?: number;
    /**
     * When true, PPTX ingestion shells out to LibreOffice to render each
     * slide as a PNG (better fidelity for decks that rely on visual
     * layout). When false, only extracted text, speaker notes, and
     * embedded media are captured. Requires LibreOffice on PATH; if
     * missing, a warning is logged and the pipeline falls back to
     * text-only.
     */
    convertSlidesToImages?: boolean;
    /**
     * Per-workspace auto-digest toggle. When true, ingested files are
     * automatically digested once conversion completes. When false, the
     * user must click "Digest All Pending" or per-row Digest. Default
     * false. Stored in workspace settings (this field is per-workspace
     * despite living on the global Settings shape — see WorkspaceIndex).
     * NOTE: toggling from false → true does NOT retroactively digest
     * existing ingested files.
     */
    autoDigest?: boolean;
  };
}

// ── Stream Events ───────────────────────────────────────────────────────────

export interface TextEvent {
  type: 'text';
  content: string;
  streaming?: boolean;
}

export interface ThinkingEvent {
  type: 'thinking';
  content: string;
  streaming?: boolean;
}

export interface ToolActivityEvent {
  type: 'tool_activity';
  tool: string;
  description: string;
  id: string | null;
  isAgent?: boolean;
  subagentType?: string;
  parentAgentId?: string;
  isPlanFile?: boolean;
  planContent?: string;
  isPlanMode?: boolean;
  planAction?: 'enter' | 'exit';
  isQuestion?: boolean;
  questions?: string[];
}

export interface ToolOutcome {
  toolUseId: string;
  isError: boolean;
  outcome: string | null;
  status: string | null;
}

export interface ToolOutcomesEvent {
  type: 'tool_outcomes';
  outcomes: ToolOutcome[];
}

export interface TurnBoundaryEvent {
  type: 'turn_boundary';
}

export interface ResultEvent {
  type: 'result';
  content: string;
}

export interface UsageEvent {
  type: 'usage';
  usage: Usage;
  sessionUsage?: Usage;
  model?: string;
}

export interface ErrorEvent {
  type: 'error';
  error: string;
  /**
   * `false` means a non-fatal adapter warning. Omitted/true means the error
   * ends the current CLI turn.
   */
  terminal?: boolean;
  source?: StreamErrorSource;
}

export interface DoneEvent {
  type: 'done';
}

/**
 * Emitted by a backend adapter as soon as it obtains a backend-managed
 * session ID that the cockpit needs to persist on the active `SessionEntry`
 * so the session can be resumed after a cockpit server restart. Vendor-
 * agnostic: any backend that manages its own session IDs (ACP-based CLIs
 * like Kiro, hosted API sessions, etc.) can emit this. `processStream`
 * forwards it to `chatService.setExternalSessionId(convId, sessionId)`.
 * Not forwarded to the frontend — it is a server-side persistence signal.
 */
export interface ExternalSessionEvent {
  type: 'external_session';
  sessionId: string;
}

/**
 * Optional backend runtime identifiers for the currently running turn. These
 * are persisted on the durable stream job while it is active so future
 * backend-specific resume work has the identifiers it needs without replaying
 * the user prompt. The event is server-side only and is not forwarded to the
 * browser.
 */
export interface BackendRuntimeEvent {
  type: 'backend_runtime';
  /** Backend-managed conversation/session/thread id, when separate from cockpit ids. */
  externalSessionId?: string | null;
  /** Backend-managed active turn id, when the backend exposes one. */
  activeTurnId?: string | null;
  /** Local process id for process-backed backends. Diagnostic only. */
  processId?: number | null;
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
  /** Filenames added or whose content changed since the previous frame for this conversation. */
  changedFiles: string[];
}

export type StreamEvent =
  | TextEvent
  | ThinkingEvent
  | ToolActivityEvent
  | ToolOutcomesEvent
  | TurnBoundaryEvent
  | ResultEvent
  | UsageEvent
  | ErrorEvent
  | DoneEvent
  | ExternalSessionEvent
  | BackendRuntimeEvent
  | MemoryUpdateEvent
  | KbStateUpdateEvent;

export type StreamErrorSource = 'backend' | 'transport' | 'abort' | 'server';

// ── Durable stream jobs ─────────────────────────────────────────────────────

export type StreamJobState =
  | 'accepted'
  | 'preparing'
  | 'running'
  | 'abort_requested'
  | 'finalizing';

export interface StreamJobTerminalInfo {
  message: string;
  source: StreamErrorSource;
  at: string;
}

export interface StreamJobRuntimeInfo {
  externalSessionId?: string | null;
  activeTurnId?: string | null;
  processId?: number | null;
}

export interface DurableStreamJob {
  id: string;
  state: StreamJobState;
  conversationId: string;
  sessionId: string;
  userMessageId?: string | null;
  backend: string;
  cliProfileId?: string | null;
  model?: string | null;
  effort?: EffortLevel | null;
  workingDir?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  lastEventAt?: string | null;
  runtime?: StreamJobRuntimeInfo | null;
  abortRequested?: StreamJobTerminalInfo | null;
  terminalError?: StreamJobTerminalInfo | null;
}

export interface StreamJobFile {
  version: 1;
  jobs: DurableStreamJob[];
}

// ── Workspace Memory ─────────────────────────────────────────────────────────

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'unknown';

/** Where a memory file came from. */
export type MemorySource = 'cli-capture' | 'memory-note' | 'session-extraction';

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

// ── Workspace Knowledge Base ────────────────────────────────────────────────
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

/** Aggregate counters rendered in the KB Browser header. */
export interface KbCounters {
  rawTotal: number;
  rawByStatus: Record<KbRawStatus, number>;
  entryCount: number;
  pendingCount: number; // ingested + pending-delete
  folderCount: number;
  topicCount: number;
  connectionCount: number;
  reflectionCount: number;
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
  dreamProgress?: {
    phase: string;
    done: number;
    total: number;
    startedAt?: number;
    phaseStartedAt?: number;
  } | null;
  reflectionCount?: number;
  staleReflectionCount?: number;
  autoDream?: KbAutoDreamState;
  topics: KbSynthesisTopicSummary[];
  connections: KbSynthesisConnectionSummary[];
}

/** Topic summary for the synthesis tab list and atlas views. */
export interface KbSynthesisTopicSummary {
  topicId: string;
  title: string;
  summary: string | null;
  entryCount: number;
  connectionCount: number;
  isGodNode: boolean;
}

/** Connection summary for the synthesis tab list and atlas views. */
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
    dreamProgress?: { phase: 'routing' | 'verification' | 'synthesis' | 'discovery' | 'reflection'; done: number; total: number };
    /** Emitted when a cooperative stop has been requested for an in-progress dream run. */
    stopping?: boolean;
    /** Per-raw substep text shown beneath the status badge during long operations. */
    substep?: { rawId: string; text: string };
  };
}

// ── Backend Adapter ──────────────────────────────────────────────────────────

export interface BackendCapabilities {
  thinking: boolean;
  planMode: boolean;
  agents: boolean;
  toolActivity: boolean;
  userQuestions: boolean;
  stdinInput: boolean;
}

export type BackendActiveTurnResumeSupport = 'unsupported' | 'supported';
export type BackendSessionResumeSupport = 'unsupported' | 'supported';

export interface BackendResumeCapabilities {
  /**
   * Whether Agent Cockpit can safely reattach to the same in-flight backend
   * turn after the cockpit server process restarts, without resending the
   * prompt or duplicating tool side effects.
   */
  activeTurnResume: BackendActiveTurnResumeSupport;
  activeTurnResumeReason: string;
  /**
   * Whether the backend can resume later session/thread context on the next
   * user turn after a process respawn. This is deliberately weaker than active
   * turn resume.
   */
  sessionResume: BackendSessionResumeSupport;
  sessionResumeReason: string;
}

export interface ModelOption {
  id: string;
  label: string;
  family: string;
  description?: string;
  costTier?: 'high' | 'medium' | 'low';
  default?: boolean;
  /**
   * Adaptive reasoning effort levels this model supports. Omit for models
   * without effort support (e.g. Haiku). UI uses presence of this field to
   * decide whether to show the effort dropdown. Values are backend/model-
   * specific; Codex may expose `none` / `minimal`, while Claude Code exposes
   * `max` on supported Opus models.
   */
  supportedEffortLevels?: EffortLevel[];
}

export interface BackendMetadata {
  id: string;
  label: string;
  icon: string | null;
  capabilities: BackendCapabilities;
  resumeCapabilities: BackendResumeCapabilities;
  models?: ModelOption[];
}

/**
 * ACP-shaped MCP server config for `session/new` and `session/load`.
 *
 * NOTE: `env` is an **array of `{name, value}` objects**, not a plain
 * `Record<string, string>`, because that is what the ACP spec
 * (https://agentclientprotocol.com/protocol/session-setup) requires.
 * Passing a plain object breaks strict ACP servers like kiro-cli.
 */
export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Array<{ name: string; value: string }>;
}

export interface SendMessageOptions {
  sessionId: string;
  /** Stable conversation ID (does not change on session reset). */
  conversationId?: string;
  /** Runtime CLI profile selected for the conversation. */
  cliProfileId?: string;
  /** Full profile record for adapters that support profile-isolated runtimes. */
  cliProfile?: CliProfile;
  isNewSession: boolean;
  workingDir: string | null;
  systemPrompt: string;
  /** Backend-managed session ID from a previous session, for resume/rehydration. */
  externalSessionId?: string | null;
  /** Full model ID (e.g., 'claude-opus-4-7', 'claude-sonnet-4-6'). Backends that don't support model selection ignore this. */
  model?: string;
  /**
   * Adaptive reasoning effort level. Backends that don't support effort
   * (or backends whose selected model doesn't) ignore this.
   */
  effort?: EffortLevel;
  /**
   * MCP servers to expose to the backend for this session.  Currently
   * only used by ACP-based backends (e.g. Kiro) to forward the
   * Memory MCP stub.  Backends that don't support MCP ignore this.
   */
  mcpServers?: McpServerConfig[];
}

export interface SendMessageResult {
  stream: AsyncGenerator<StreamEvent>;
  abort: () => void;
  sendInput: (text: string) => void;
}

// ── Config ───────────────────────────────────────────────────────────────────

export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface AppConfig {
  PORT: number;
  SESSION_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_CALLBACK_URL: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_CALLBACK_URL?: string;
  ALLOWED_EMAIL: string;
  AUTH_DATA_DIR: string;
  AUTH_SETUP_TOKEN: string;
  AUTH_ENABLE_LEGACY_OAUTH: boolean;
  DEFAULT_WORKSPACE: string;
  BASE_PATH: string;
  CODEX_APPROVAL_POLICY: CodexApprovalPolicy;
  CODEX_SANDBOX_MODE: CodexSandboxMode;
}

// ── Express Extensions ───────────────────────────────────────────────────────

declare module 'express-session' {
  interface SessionData {
    csrfToken?: string;
    passport?: { user?: unknown };
    reAuthPopup?: boolean;
    passkeyRegistration?: {
      challenge: string;
      rpId: string;
      origin: string;
      name?: string;
    };
    passkeyAuthentication?: {
      challenge: string;
      rpId: string;
      origin: string;
      popup?: boolean;
    };
  }
}

// ── Update Service ───────────────────────────────────────────────────────────

export interface UpdateStatus {
  localVersion: string;
  remoteVersion: string | null;
  updateAvailable: boolean;
  lastCheckAt: string | null;
  lastError: string | null;
  updateInProgress: boolean;
}

export interface UpdateStep {
  name: string;
  success: boolean;
  output?: string;
}

export interface UpdateResult {
  success: boolean;
  steps: UpdateStep[];
  error?: string;
}

// ── CLI Update Service ──────────────────────────────────────────────────────

export type CliInstallMethod = 'npm-global' | 'self-update' | 'unknown' | 'missing';

export interface CliUpdateStatus {
  id: string;
  vendor: CliVendor;
  label: string;
  command: string;
  resolvedPath: string | null;
  profileIds: string[];
  profileNames: string[];
  installMethod: CliInstallMethod;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  updateSupported: boolean;
  updateInProgress: boolean;
  lastCheckAt: string | null;
  lastError: string | null;
  updateCommand: string[] | null;
}

export interface CliUpdatesResponse {
  items: CliUpdateStatus[];
  lastCheckAt: string | null;
  updateInProgress: boolean;
}

export interface CliUpdateResult {
  success: boolean;
  item?: CliUpdateStatus;
  steps: UpdateStep[];
  error?: string;
}

// ── WebSocket Frames ────────────────────────────────────────────────────────

export interface WsInputFrame {
  type: 'input';
  text: string;
}

export interface WsAbortFrame {
  type: 'abort';
}

export interface WsReconnectFrame {
  type: 'reconnect';
}

export type WsClientFrame = WsInputFrame | WsAbortFrame | WsReconnectFrame;

export interface WsTitleUpdatedFrame {
  type: 'title_updated';
  title: string;
}

export interface WsAssistantMessageFrame {
  type: 'assistant_message';
  message: Message;
}

export interface WsTurnCompleteFrame {
  type: 'turn_complete';
}

export interface WsReplayStartFrame {
  type: 'replay_start';
  bufferedEvents: number;
}

export interface WsReplayEndFrame {
  type: 'replay_end';
}

export type WsServerFrame =
  | StreamEvent
  | WsTitleUpdatedFrame
  | WsAssistantMessageFrame
  | WsTurnCompleteFrame
  | WsReplayStartFrame
  | WsReplayEndFrame;

// ── Active Stream ────────────────────────────────────────────────────────────

export interface ActiveStreamEntry {
  stream: AsyncGenerator<StreamEvent>;
  abort: () => void;
  sendInput: (text: string) => void;
  backend: string;
  needsTitleUpdate: boolean;
  titleUpdateMessage: string | null;
  jobId?: string;
  startedAt?: string;
  lastEventAt?: string;
  abortRequested?: {
    message: string;
    source: StreamErrorSource;
    at: string;
  };
  abortFinalizing?: Promise<void>;
  finalizeAbort?: () => Promise<void>;
  terminalFinalizing?: Promise<void>;
  done?: Promise<void>;
}

// ── Tool Detail Extraction ───────────────────────────────────────────────────

export interface ToolDetail {
  tool: string;
  id: string | null;
  description: string;
  isAgent?: boolean;
  subagentType?: string;
  isPlanFile?: boolean;
  planContent?: string;
  isPlanMode?: boolean;
  planAction?: 'enter' | 'exit';
  isQuestion?: boolean;
  questions?: string[];
  parentAgentId?: string;
}

export interface ToolOutcomeResult {
  outcome: string;
  status: 'success' | 'error' | 'warning';
}

// ── CLI Event Shapes (raw from Claude CLI stream-json) ───────────────────────

export interface CliToolUseBlock {
  type: 'tool_use';
  name: string;
  id?: string;
  input?: Record<string, unknown>;
}

export interface CliTextBlock {
  type: 'text';
  text?: string;
}

export interface CliThinkingBlock {
  type: 'thinking';
  thinking?: string;
}

export interface CliToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export type CliContentBlock = CliToolUseBlock | CliTextBlock | CliThinkingBlock | CliToolResultBlock;

export interface CliAssistantEvent {
  type: 'assistant';
  message?: {
    content?: CliContentBlock[];
  };
}

export interface CliContentBlockDeltaEvent {
  type: 'content_block_delta';
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
  };
}

export interface CliUserEvent {
  type: 'user';
  message?: {
    content?: CliContentBlock[];
  };
}

export interface CliResultEvent {
  type: 'result';
  result?: string | Record<string, unknown>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  cost_usd?: number;
}

export interface CliSystemEvent {
  type: 'system';
  subtype?: string;
  model?: string;
  tool_use_id?: string;
  status?: string;
  summary?: string;
  event?: string;
  tool?: string;
}

export type CliEvent =
  | CliAssistantEvent
  | CliContentBlockDeltaEvent
  | CliUserEvent
  | CliResultEvent
  | CliSystemEvent;

// Re-export Express types for convenience
export type { Request, Response, NextFunction, Express };
