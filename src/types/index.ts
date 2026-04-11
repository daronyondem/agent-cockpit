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
}

// ── Messages ─────────────────────────────────────────────────────────────────

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  backend: string;
  timestamp: string;
  thinking?: string;
  toolActivity?: ToolActivity[];
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

/** Adaptive reasoning effort level. `max` is Opus 4.6 only. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export interface ConversationEntry {
  id: string;
  title: string;
  backend: string;
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
  messageQueue?: string[];
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
  conversations: ConversationEntry[];
}

export interface Conversation {
  id: string;
  title: string;
  backend: string;
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
  messageQueue?: string[];
  /** KB status snapshot, populated when workspace has KB enabled. */
  kb?: ConversationKbStatus;
}

/** KB status block on conversation responses (avoids extra round-trip for the dreaming banner). */
export interface ConversationKbStatus {
  enabled: boolean;
  dreamingNeeded: boolean;
  pendingEntries: number;
  dreamingStatus: 'idle' | 'running' | 'failed';
  failedItems: number;
}

export interface ConversationListItem {
  id: string;
  title: string;
  updatedAt: string;
  backend: string;
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
}

// ── Settings ─────────────────────────────────────────────────────────────────

export interface Settings {
  theme: 'light' | 'dark' | 'system';
  sendBehavior: 'enter' | 'ctrlEnter';
  systemPrompt: string;
  defaultBackend: string;
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
   * The CLI selected here must be a registered backend (e.g. 'claude-code').
   */
  memory?: {
    cliBackend?: string;
    cliModel?: string;
    cliEffort?: EffortLevel;
  };
  /**
   * Globally-configured Knowledge Base CLIs. Two separate roles:
   *   - Digestion: runs once per raw file to produce structured entries.
   *   - Dreaming: manually invoked to synthesize entries into a coherent
   *     knowledge graph. Incremental by default, full rebuild on demand.
   * Both must be registered backends. Shape mirrors `memory` so the
   * config surface stays consistent. `convertSlidesToImages` opts into
   * the LibreOffice-backed PPTX slide rasterization path (global, not
   * per-workspace).
   */
  knowledgeBase?: {
    digestionCliBackend?: string;
    digestionCliModel?: string;
    digestionCliEffort?: EffortLevel;
    dreamingCliBackend?: string;
    dreamingCliModel?: string;
    dreamingCliEffort?: EffortLevel;
    /** Max concurrent CLI calls during dreaming batches. Default 2. */
    dreamingConcurrency?: number;
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
  customInstructions?: {
    aboutUser?: string;
    responseStyle?: string;
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
}

export interface DoneEvent {
  type: 'done';
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
  | MemoryUpdateEvent
  | KbStateUpdateEvent;

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
  /** High-level counters for the header/badges. */
  counters: KbCounters;
  /** Folder tree, flat list sorted by folderPath. */
  folders: KbFolder[];
  /** Raw files in the currently-focused folder (or empty when listing is disabled). */
  raw: KbRawEntry[];
  /** ISO 8601 timestamp of the most recent mutation (for cache busting). */
  updatedAt: string;
}

/** API response shape for `GET /kb/synthesis`. */
export interface KbSynthesisState {
  status: string;
  lastRunAt: string | null;
  lastRunError: string | null;
  topicCount: number;
  connectionCount: number;
  needsSynthesisCount: number;
  godNodes: string[];
  topics: KbSynthesisTopicSummary[];
  connections: KbSynthesisConnectionSummary[];
}

/** Topic summary for the synthesis tab graph view. */
export interface KbSynthesisTopicSummary {
  topicId: string;
  title: string;
  summary: string | null;
  entryCount: number;
  connectionCount: number;
  isGodNode: boolean;
}

/** Connection summary for the synthesis tab graph view. */
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
   * the folder tree changed (created/renamed/deleted). `batchProgress`
   * is emitted during "Digest All Pending" runs so the toolbar button
   * can show live k/N progress.
   */
  changed: {
    raw?: string[];
    entries?: string[];
    folders?: boolean;
    synthesis?: boolean;
    batchProgress?: { done: number; total: number };
    dreamProgress?: { phase: 'discovery' | 'synthesis'; done: number; total: number };
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
   * decide whether to show the effort dropdown.
   */
  supportedEffortLevels?: EffortLevel[];
}

export interface BackendMetadata {
  id: string;
  label: string;
  icon: string | null;
  capabilities: BackendCapabilities;
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
  isNewSession: boolean;
  workingDir: string | null;
  systemPrompt: string;
  /** Backend-managed session ID from a previous session, for resume/rehydration. */
  externalSessionId?: string | null;
  /** Model ID or alias (e.g., 'opus', 'claude-sonnet-4-6'). Backends that don't support model selection ignore this. */
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
  DEFAULT_WORKSPACE: string;
  BASE_PATH: string;
}

// ── Express Extensions ───────────────────────────────────────────────────────

declare module 'express-session' {
  interface SessionData {
    csrfToken?: string;
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
