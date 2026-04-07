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
  | MemoryUpdateEvent;

// ── Workspace Memory ─────────────────────────────────────────────────────────

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'unknown';

export interface MemoryFile {
  /** Original filename (e.g. "feedback_testing.md"). */
  filename: string;
  /** Parsed frontmatter `name`, if present. */
  name: string | null;
  /** Parsed frontmatter `description`, if present. */
  description: string | null;
  /** Parsed frontmatter `type`, normalized to a known type or 'unknown'. */
  type: MemoryType;
  /** Raw file content (frontmatter + body). */
  content: string;
}

export interface MemorySnapshot {
  /** ISO 8601 timestamp of when this snapshot was captured. */
  capturedAt: string;
  /** Backend the snapshot was extracted from (e.g. "claude-code"). */
  sourceBackend: string;
  /** Absolute path to the source memory directory the snapshot came from. */
  sourcePath: string | null;
  /** Contents of the source `MEMORY.md` index (may be empty). */
  index: string;
  /** Individual memory files. */
  files: MemoryFile[];
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
