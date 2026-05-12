import type { ExplorerEntry, ExplorerPreviewResponse, ExplorerTreeResponse, FilePreviewResponse } from './explorer';

export type EffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ServiceTier = 'fast';
export type AttachmentKind = 'image' | 'pdf' | 'text' | 'code' | 'md' | 'folder' | 'file';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  credits?: number;
  contextUsagePercentage?: number;
}

export interface UsageLedgerRecord {
  backend: string;
  model: string;
  usage: Usage;
}

export interface UsageLedgerDay {
  date: string;
  records: UsageLedgerRecord[];
}

export interface UsageLedger {
  days: UsageLedgerDay[];
}

export interface ToolActivity {
  tool: string;
  description: string;
  id: string | null;
  duration?: number | null;
  startTime: number;
  isAgent?: boolean;
  subagentType?: string;
  parentAgentId?: string;
  outcome?: string;
  status?: string;
  batchIndex?: number;
}

export interface AttachmentMeta {
  name: string;
  path: string;
  size?: number;
  kind: AttachmentKind;
  meta?: string;
}

export interface QueuedMessage {
  content: string;
  attachments?: AttachmentMeta[];
}

export type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool'; activity: ToolActivity }
  | { type: 'artifact'; artifact: ConversationArtifact };

export interface ConversationArtifact {
  filename: string;
  path: string;
  kind: AttachmentKind;
  size?: number;
  mimeType?: string;
  title?: string;
  sourceToolId?: string | null;
}

export interface StreamError {
  message: string;
  source?: 'backend' | 'transport' | 'abort' | 'server';
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  backend: string;
  timestamp: string;
  thinking?: string;
  toolActivity?: ToolActivity[];
  contentBlocks?: ContentBlock[];
  streamError?: StreamError;
  turn?: 'progress' | 'final';
  pinned?: boolean;
}

export interface ConversationListItem {
  id: string;
  title: string;
  updatedAt: string;
  backend: string;
  cliProfileId?: string;
  model?: string;
  effort?: EffortLevel;
  serviceTier?: ServiceTier;
  workingDir: string;
  workspaceHash: string;
  workspaceKbEnabled: boolean;
  messageCount: number;
  lastMessage: string | null;
  usage: Usage | null;
  archived?: boolean;
  unread?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  backend: string;
  cliProfileId?: string;
  model?: string;
  effort?: EffortLevel;
  serviceTier?: ServiceTier;
  workingDir: string;
  workspaceHash: string;
  currentSessionId: string;
  sessionNumber: number;
  messages: Message[];
  usage?: Usage;
  sessionUsage?: Usage;
  externalSessionId?: string;
  messageQueue?: QueuedMessage[];
  archived?: boolean;
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

export interface ResetSessionResponse {
  conversation: Conversation;
  newSessionNumber: number;
  archivedSession?: {
    number: number;
    sessionId?: string | null;
    startedAt: string;
    endedAt: string;
    messageCount: number;
    summary?: string | null;
  };
}

export interface CurrentUserResponse {
  displayName: string | null;
  email: string | null;
  provider: 'local' | 'google' | 'github' | null;
}

export interface CliProfile {
  id: string;
  name: string;
  vendor: 'codex' | 'claude-code' | 'kiro';
  disabled?: boolean;
}

export interface ModelOption {
  id: string;
  label: string;
  default?: boolean;
  supportedEffortLevels?: EffortLevel[];
}

export interface BackendMetadata {
  id: string;
  label: string;
  icon?: string;
  models?: ModelOption[];
}

export interface ContextMapGlobalSettings {
  cliProfileId?: string;
  cliBackend?: string;
  cliModel?: string;
  cliEffort?: EffortLevel;
  scanIntervalMinutes?: number;
  cliConcurrency?: number;
  extractionConcurrency?: number;
  synthesisConcurrency?: number;
}

export interface Settings {
  theme?: 'light' | 'dark' | 'system';
  sendBehavior?: 'enter' | 'ctrlEnter';
  systemPrompt?: string;
  defaultBackend?: string;
  cliProfiles?: CliProfile[];
  defaultCliProfileId?: string;
  defaultModel?: string;
  defaultEffort?: EffortLevel;
  defaultServiceTier?: ServiceTier;
  workingDirectory?: string;
  memory?: Record<string, unknown>;
  knowledgeBase?: Record<string, unknown>;
  contextMap?: ContextMapGlobalSettings;
}

export interface BasicOkResponse {
  ok: boolean;
}

export interface SendMessageResponse {
  userMessage: Message;
  streamReady: boolean;
}

export interface ConversationInputResponse {
  mode: 'stdin' | 'message';
}

export interface StreamJobRuntimeInfo {
  externalSessionId?: string;
  activeTurnId?: string;
  processId?: number;
}

export interface ActiveStreamResponse {
  id: string;
  jobId?: string | null;
  state?: string;
  backend: string;
  startedAt: string | null;
  lastEventAt: string | null;
  connected: boolean;
  runtimeAttached: boolean;
  pending: boolean;
  runtime: StreamJobRuntimeInfo | null;
}

export interface ActiveStreamsResponse {
  ids: string[];
  streams: ActiveStreamResponse[];
}

export interface UpdateStatus {
  localVersion: string;
  remoteVersion: string | null;
  updateAvailable: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  inProgress: boolean;
}

export interface CliUpdateStatus {
  id: string;
  label: string;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  installMethod: 'npm-global' | 'self-update' | 'unknown' | 'missing';
  commandPath?: string | null;
  lastCheckedAt?: string | null;
  lastError?: string | null;
  updateInProgress?: boolean;
}

export interface CliUpdatesResponse {
  items: CliUpdateStatus[];
  lastCheckedAt: string | null;
}

export type StreamEvent =
  | { type: 'text'; content?: string; streaming?: boolean }
  | { type: 'thinking'; content?: string; streaming?: boolean }
  | ({ type: 'tool_activity' } & Partial<ToolActivity> & {
      isPlanMode?: boolean;
      planAction?: 'enter' | 'exit';
      planContent?: string;
      isQuestion?: boolean;
      questions?: Array<{ question: string; options?: Array<{ label: string; description?: string }> }>;
    })
  | { type: 'artifact'; artifact?: ConversationArtifact }
  | { type: 'assistant_message'; message: Message }
  | { type: 'title_updated'; title?: string }
  | { type: 'usage'; usage: Usage; sessionUsage?: Usage }
  | { type: 'error'; error?: string; terminal?: boolean; source?: StreamError['source'] }
  | { type: 'done' }
  | { type: 'replay_start'; bufferedEvents?: number }
  | { type: 'replay_end' }
  | { type: 'turn_complete' };

export type {
  ExplorerEntry,
  ExplorerPreviewResponse,
  ExplorerTreeResponse,
  FilePreviewResponse,
};
