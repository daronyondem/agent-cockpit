// ── Stream Event Types ───────────────────────────────────────────────

import type { Usage } from './usage';
import type { EffortLevel, ClaudeCodeMode, ServiceTier } from './cliProfiles';
import type { ToolQuestion, ToolOutcome } from './tools';
import type { ConversationArtifact } from './attachments';
import type { GoalUpdatedEvent, GoalClearedEvent } from './goals';
import type { SessionRecoveryEvent } from './sessionRecovery';
import type { MemoryUpdateEvent } from './memory';
import type { WorkspaceContextUpdateEvent } from './workspaceContext';
import type { KbStateUpdateEvent } from './knowledgeBase';

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
  planFilePath?: string;
  isPlanMode?: boolean;
  planAction?: 'enter' | 'exit';
  isQuestion?: boolean;
  questions?: ToolQuestion[];
}

export interface ToolOutcomesEvent {
  type: 'tool_outcomes';
  outcomes: ToolOutcome[];
}

export interface ArtifactEvent {
  type: 'artifact';
  /**
   * Present after processStream has persisted the bytes into the
   * conversation's artifact directory. Frontends render this descriptor.
   */
  artifact?: ConversationArtifact;
  /**
   * Backend-provided absolute path to copy into the conversation artifacts dir.
   * Used for CLI-generated files that already exist on disk.
   */
  sourcePath?: string;
  /**
   * Backend-provided base64 file bytes. Data URLs are accepted; plain base64
   * is expected when `mimeType` is provided separately.
   */
  dataBase64?: string;
  /** Preferred stored basename. Sanitized by ChatService before writing. */
  filename?: string;
  /** MIME type of `dataBase64` or `sourcePath`, when known. */
  mimeType?: string;
  /** Optional human-readable label from the backend/tool. */
  title?: string;
  /** Backend tool/item id that produced the artifact, when known. */
  sourceToolId?: string | null;
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
 * so the session can be resumed after a cockpit server restart. Harness-
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

export type StreamEvent =
  | TextEvent
  | ThinkingEvent
  | ToolActivityEvent
  | ToolOutcomesEvent
  | ArtifactEvent
  | TurnBoundaryEvent
  | ResultEvent
  | UsageEvent
  | ErrorEvent
  | DoneEvent
  | GoalUpdatedEvent
  | GoalClearedEvent
  | SessionRecoveryEvent
  | ExternalSessionEvent
  | BackendRuntimeEvent
  | MemoryUpdateEvent
  | WorkspaceContextUpdateEvent
  | KbStateUpdateEvent;

export type StreamErrorSource = 'backend' | 'transport' | 'abort' | 'server';

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
  claudeCodeMode?: ClaudeCodeMode | null;
  serviceTier?: ServiceTier | null;
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
  deferPlanApprovalInput?: boolean;
  pendingPlanApprovalInput?: string | null;
  pendingPlanApprovalTimer?: NodeJS.Timeout | null;
  abortFinalizing?: Promise<void>;
  finalizeAbort?: () => Promise<void>;
  terminalFinalizing?: Promise<void>;
  done?: Promise<void>;
}
