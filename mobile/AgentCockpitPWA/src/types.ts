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
  GoalEvent,
  Message,
  QueuedMessage,
  SendMessageResponse,
  ServiceTier,
  SessionHistoryItem,
  Settings,
  ToolActivity,
  ThreadGoal,
  ThreadGoalStatus,
  Usage,
} from '../../../src/contracts/responses';
import type { BrowserStreamFrame, StreamErrorSource } from '../../../src/contracts/streamFrames';

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
  GoalEvent,
  Message,
  QueuedMessage,
  SendMessageResponse,
  ServiceTier,
  SessionHistoryItem,
  Settings,
  ToolActivity,
  ThreadGoal,
  ThreadGoalStatus,
  Usage,
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

export type StreamError = {
  message: string;
  source?: StreamErrorSource;
};

export type CurrentUser = CurrentUserResponse;

export type CliProfile = {
  id: string;
  name: string;
  harness: string;
  protocol?: string;
  opencode?: {
    provider?: string;
  };
  disabled?: boolean;
};

export type ModelOption = {
  id: string;
  label: string;
  default?: boolean;
  supportedEffortLevels?: EffortLevel[];
  capabilities?: ModelCapabilities;
};

export type ModelInputModality = 'text' | 'image' | 'audio' | 'pdf' | 'video';
export type ModelOutputModality = 'text' | 'image' | 'audio' | 'pdf' | 'video';

export type ModelCapabilities = {
  input?: Partial<Record<ModelInputModality, boolean>>;
  output?: Partial<Record<ModelOutputModality, boolean>>;
  attachment?: boolean;
  toolcall?: boolean;
  reasoning?: boolean;
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

export type StreamEvent = BrowserStreamFrame;
