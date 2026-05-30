import type {
  ConversationArtifact,
  Message,
  ThreadGoal,
  ToolActivity,
  Usage,
} from './responses';

export type StreamErrorSource = 'backend' | 'transport' | 'abort' | 'server';

export interface ToolQuestionOption {
  label: string;
  description?: string;
}

export interface ToolQuestion {
  question: string;
  options?: ToolQuestionOption[];
}

export interface ToolOutcome {
  toolUseId: string;
  isError: boolean;
  outcome: string | null;
  status: string | null;
}

export interface BrowserMemoryUpdateFrame {
  type: 'memory_update';
  capturedAt?: string;
  fileCount?: number;
  changedFiles?: string[];
  sourceConversationId?: string | null;
  displayInChat?: boolean;
  writeOutcomes?: Record<string, unknown>[];
}

export interface BrowserWorkspaceContextUpdateFrame {
  type: 'workspace_context_update';
  updatedAt?: string | null;
  workspaceContext?: Record<string, unknown> | null;
}

export interface BrowserKbStateUpdateFrame {
  type: 'kb_state_update';
  updatedAt?: string;
  changed?: Record<string, unknown>;
}

export type BrowserStreamFrame =
  | { type: 'text'; content?: string; streaming?: boolean }
  | { type: 'thinking'; content?: string; streaming?: boolean }
  | ({ type: 'tool_activity' } & Partial<ToolActivity> & {
      isPlanMode?: boolean;
      planAction?: 'enter' | 'exit';
      planContent?: string;
      isPlanFile?: boolean;
      planFilePath?: string;
      isQuestion?: boolean;
      questions?: ToolQuestion[];
    })
  | { type: 'tool_outcomes'; outcomes?: ToolOutcome[] }
  | { type: 'artifact'; artifact?: ConversationArtifact }
  | { type: 'assistant_message'; message: Message }
  | { type: 'title_updated'; title?: string }
  | { type: 'usage'; usage: Usage; sessionUsage?: Usage }
  | { type: 'error'; error?: string; terminal?: boolean; source?: StreamErrorSource }
  | { type: 'goal_updated'; goal: ThreadGoal }
  | { type: 'goal_cleared'; threadId?: string | null }
  | { type: 'done' }
  | { type: 'replay_start'; bufferedEvents?: number }
  | { type: 'replay_end' }
  | { type: 'turn_complete' }
  | BrowserMemoryUpdateFrame
  | BrowserWorkspaceContextUpdateFrame
  | BrowserKbStateUpdateFrame;
