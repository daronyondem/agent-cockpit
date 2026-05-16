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
  goalEvent?: GoalEvent;
  turn?: 'progress' | 'final';
  pinned?: boolean;
}

export interface ConversationMessageWindow {
  messages: Message[];
  total: number;
  startIndex: number;
  endIndex: number;
  hasOlder: boolean;
  hasNewer: boolean;
}

export interface ConversationPinnedMessage {
  index: number;
  message: Message;
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
  messageWindow?: ConversationMessageWindow;
  pinnedMessages?: ConversationPinnedMessage[];
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
  protocol?: 'standard' | 'interactive';
  disabled?: boolean;
}

export interface ModelOption {
  id: string;
  label: string;
  default?: boolean;
  supportedEffortLevels?: EffortLevel[];
}

export interface BackendGoalCapability {
  set: boolean;
  clear: boolean;
  pause: boolean;
  resume: boolean;
  status: 'native' | 'transcript' | 'none';
}

export interface BackendCapabilities {
  thinking?: boolean;
  planMode?: boolean;
  agents?: boolean;
  toolActivity?: boolean;
  userQuestions?: boolean;
  stdinInput?: boolean;
  goals?: boolean | BackendGoalCapability;
}

export interface BackendMetadata {
  id: string;
  label: string;
  icon?: string;
  capabilities?: BackendCapabilities;
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

export type ThreadGoalBackend = 'codex' | 'claude-code' | 'claude-code-interactive';
export type ThreadGoalStatus = 'active' | 'paused' | 'budgetLimited' | 'complete' | 'cleared' | 'unknown';
export type ThreadGoalSource = 'native' | 'transcript' | 'runtime' | 'unknown';

export interface ThreadGoalSupportedActions {
  clear: boolean;
  stopTurn: boolean;
  pause: boolean;
  resume: boolean;
}

export interface ThreadGoal {
  backend?: ThreadGoalBackend;
  threadId?: string | null;
  sessionId?: string | null;
  objective: string;
  status: ThreadGoalStatus;
  supportedActions?: ThreadGoalSupportedActions;
  tokenBudget?: number | null;
  tokensUsed?: number | null;
  timeUsedSeconds?: number | null;
  turns?: number | null;
  iterations?: number | null;
  lastReason?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  source?: ThreadGoalSource;
}

export type GoalEventKind = 'set' | 'resumed' | 'paused' | 'achieved' | 'budget_limited' | 'cleared' | 'updated' | 'unknown';

export interface GoalEvent {
  kind: GoalEventKind;
  backend?: ThreadGoalBackend | string;
  objective?: string;
  status?: ThreadGoalStatus;
  reason?: string | null;
  goal?: ThreadGoal | null;
}

export type CodexThreadGoalStatus = Extract<ThreadGoalStatus, 'active' | 'paused' | 'budgetLimited' | 'complete'>;

export type CodexThreadGoal = ThreadGoal & {
  threadId: string;
  status: CodexThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

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
  installChannel: 'production' | 'dev';
  installSource: 'github-release' | 'git-main' | 'unknown';
  installStateSource: 'stored' | 'inferred' | 'legacy' | 'corrupt';
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
  interactiveCompatibility?: CliCompatibilityStatus[];
  blocksAutoUpdate?: boolean;
  updateCaution?: string | null;
}

export interface CliCompatibilityStatus {
  providerId: 'claude-code-interactive';
  command: string;
  currentVersion: string | null;
  testedVersion: string;
  status: 'supported' | 'newer' | 'older' | 'unknown' | 'missing';
  severity: 'none' | 'warning' | 'error';
  message: string | null;
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
      planFilePath?: string;
      isQuestion?: boolean;
      questions?: Array<{ question: string; options?: Array<{ label: string; description?: string }> }>;
    })
  | { type: 'artifact'; artifact?: ConversationArtifact }
  | { type: 'assistant_message'; message: Message }
  | { type: 'title_updated'; title?: string }
  | { type: 'usage'; usage: Usage; sessionUsage?: Usage }
  | { type: 'error'; error?: string; terminal?: boolean; source?: StreamError['source'] }
  | { type: 'goal_updated'; goal: ThreadGoal }
  | { type: 'goal_cleared'; threadId?: string | null }
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
