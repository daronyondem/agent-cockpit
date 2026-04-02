import type { Request, Response, NextFunction, Express } from 'express';

// ── Usage ────────────────────────────────────────────────────────────────────

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
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

export interface ConversationEntry {
  id: string;
  title: string;
  backend: string;
  currentSessionId: string;
  lastActivity: string;
  lastMessage: string | null;
  usage?: Usage;
  sessions: SessionEntry[];
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
  workingDir: string;
  currentSessionId: string;
  sessionNumber: number;
  messages: Message[];
  usage?: Usage;
}

export interface ConversationListItem {
  id: string;
  title: string;
  updatedAt: string;
  backend: string;
  workingDir: string;
  workspaceHash: string;
  messageCount: number;
  lastMessage: string | null;
  usage: Usage | null;
}

// ── Settings ─────────────────────────────────────────────────────────────────

export interface Settings {
  theme: 'light' | 'dark' | 'system';
  sendBehavior: 'enter' | 'ctrlEnter';
  systemPrompt: string;
  defaultBackend: string;
  workingDirectory?: string;
  customInstructions?: {
    aboutUser?: string;
    responseStyle?: string;
  };
}

// ── SSE Stream Events ────────────────────────────────────────────────────────

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
}

export interface ErrorEvent {
  type: 'error';
  error: string;
}

export interface DoneEvent {
  type: 'done';
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
  | DoneEvent;

// ── Backend Adapter ──────────────────────────────────────────────────────────

export interface BackendCapabilities {
  thinking: boolean;
  planMode: boolean;
  agents: boolean;
  toolActivity: boolean;
  userQuestions: boolean;
  stdinInput: boolean;
}

export interface BackendMetadata {
  id: string;
  label: string;
  icon: string | null;
  capabilities: BackendCapabilities;
}

export interface SendMessageOptions {
  sessionId: string;
  isNewSession: boolean;
  workingDir: string | null;
  systemPrompt: string;
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
