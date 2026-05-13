import type {
  AttachmentKind,
  AttachmentMeta,
  BackendMetadata,
  BasicOkResponse,
  ContentBlock,
  Conversation,
  ConversationArtifact,
  ConversationInputResponse,
  ConversationListItem,
  CodexThreadGoal,
  CodexThreadGoalStatus,
  CurrentUserResponse,
  EffortLevel,
  Message,
  QueuedMessage,
  SendMessageResponse,
  ServiceTier,
  SessionHistoryItem,
  Settings,
  ToolActivity,
  Usage,
} from '../../../src/contracts/responses';

export type {
  AttachmentKind,
  AttachmentMeta,
  BackendMetadata,
  ContentBlock,
  Conversation,
  ConversationArtifact,
  ConversationListItem,
  CodexThreadGoal,
  CodexThreadGoalStatus,
  EffortLevel,
  Message,
  QueuedMessage,
  SendMessageResponse,
  ServiceTier,
  SessionHistoryItem,
  Settings,
  ToolActivity,
  Usage,
};

export type ThreadGoal = CodexThreadGoal;
export type ThreadGoalStatus = CodexThreadGoalStatus;

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

export type StreamError = {
  message: string;
  source?: 'backend' | 'transport' | 'abort' | 'server';
};

export type CurrentUser = CurrentUserResponse;

export type CliProfile = {
  id: string;
  name: string;
  vendor: string;
  disabled?: boolean;
};

export type ModelOption = {
  id: string;
  label: string;
  default?: boolean;
  supportedEffortLevels?: EffortLevel[];
};

export type InputResponse = ConversationInputResponse;

export type BasicOKResponse = BasicOkResponse;

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

export type DirectoryBrowseResponse = {
  currentPath: string;
  parent?: string | null;
  dirs: string[];
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
  | { type: 'goal_updated'; goal: ThreadGoal }
  | { type: 'goal_cleared'; threadId?: string | null }
  | { type: 'done' }
  | { type: 'replay_start'; bufferedEvents?: number }
  | { type: 'replay_end' }
  | { type: 'turn_complete' };
