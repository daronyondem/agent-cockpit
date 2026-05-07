export type EffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ServiceTier = 'fast';

export type MessageRole = 'user' | 'assistant' | 'system';

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  credits?: number;
  contextUsagePercentage?: number;
};

export type ToolActivity = {
  tool: string;
  description: string;
  id?: string;
  duration?: number;
  startTime: number;
  isAgent?: boolean;
  subagentType?: string;
  parentAgentId?: string;
  outcome?: string;
  status?: string;
  batchIndex?: number;
};

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'code' | 'md' | 'folder' | 'file';

export type AttachmentMeta = {
  name: string;
  path: string;
  size?: number;
  kind: AttachmentKind;
  meta?: string;
};

export type PendingAttachment = {
  id: string;
  fileName: string;
  status: 'uploading' | 'done' | 'error';
  progress?: number;
  error?: string;
  result?: AttachmentMeta;
  xhr?: XMLHttpRequest;
  ocrStatus?: 'idle' | 'running' | 'done' | 'error';
  ocrMarkdown?: string;
  ocrError?: string;
};

export type QueuedMessage = {
  content: string;
  attachments?: AttachmentMeta[];
};

export type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool'; activity: ToolActivity }
  | { type: 'artifact'; artifact: ConversationArtifact };

export type ConversationArtifact = {
  filename: string;
  path: string;
  kind: AttachmentKind;
  size?: number;
  mimeType?: string;
  title?: string;
  sourceToolId?: string | null;
};

export type StreamError = {
  message: string;
  source?: 'backend' | 'transport' | 'abort' | 'server';
};

export type Message = {
  id: string;
  role: MessageRole;
  content: string;
  backend: string;
  timestamp: string;
  thinking?: string;
  toolActivity?: ToolActivity[];
  contentBlocks?: ContentBlock[];
  streamError?: StreamError;
  turn?: 'progress' | 'final';
};

export type ConversationListItem = {
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
  lastMessage?: string;
  usage?: Usage;
  archived?: boolean;
  unread?: boolean;
};

export type Conversation = {
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
};

export type CurrentUser = {
  displayName?: string | null;
  email?: string | null;
  provider?: 'local' | 'google' | 'github' | null;
};

export type CliProfile = {
  id: string;
  name: string;
  vendor: string;
  disabled?: boolean;
};

export type BackendMetadata = {
  id: string;
  label: string;
  icon?: string;
  models?: ModelOption[];
};

export type ModelOption = {
  id: string;
  label: string;
  default?: boolean;
  supportedEffortLevels?: EffortLevel[];
};

export type Settings = {
  defaultBackend?: string;
  cliProfiles?: CliProfile[];
  defaultCliProfileId?: string;
  defaultModel?: string;
  defaultEffort?: EffortLevel;
  defaultServiceTier?: ServiceTier;
  workingDirectory?: string;
};

export type SendMessageResponse = {
  userMessage: Message;
  streamReady: boolean;
};

export type InputResponse = {
  mode: 'stdin' | 'message';
};

export type BasicOKResponse = {
  ok: boolean;
};

export type ResetSessionResponse = {
  conversation: Conversation;
  newSessionNumber: number;
  archivedSession?: {
    number: number;
    sessionId?: string;
    startedAt: string;
    endedAt: string;
    messageCount: number;
    summary?: string;
  };
};

export type SessionHistoryItem = {
  number: number;
  sessionId?: string;
  startedAt: string;
  endedAt?: string;
  messageCount: number;
  summary?: string;
  isCurrent: boolean;
};

export type ExplorerEntry = {
  name: string;
  type: 'file' | 'dir';
  size?: number;
  mtime?: number;
  modifiedAt?: string;
};

export type ExplorerTreeResponse = {
  path: string;
  parent?: string | null;
  entries: ExplorerEntry[];
};

export type ExplorerPreviewResponse = {
  path: string;
  filename?: string;
  content: string;
  language?: string;
  mimeType?: string;
  size?: number;
  mtime?: number;
  truncated?: boolean;
};

export type FilePreviewResponse = {
  path?: string;
  filename?: string;
  content: string;
  mimeType?: string;
  size?: number;
  truncated?: boolean;
};

export type PendingInteraction =
  | { kind: 'plan'; prompt: string }
  | { kind: 'question'; prompt: string; options: Array<{ label: string; description?: string }> };

export type UserQuestion = {
  question: string;
  options?: Array<{ label: string; description?: string }>;
};

export type StreamEvent =
  | { type: 'text'; content?: string; streaming?: boolean }
  | { type: 'thinking'; content?: string; streaming?: boolean }
  | ({ type: 'tool_activity' } & Partial<ToolActivity> & {
      isPlanMode?: boolean;
      planAction?: 'enter' | 'exit';
      planContent?: string;
      isQuestion?: boolean;
      questions?: UserQuestion[];
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
