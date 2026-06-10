// ── Conversation Types ───────────────────────────────────────────────

import type { Usage } from './usage';
import type { EffortLevel, ClaudeCodeMode, ServiceTier } from './cliProfiles';
import type { AttachmentMeta, QueuedMessage } from './attachments';
import type { ConversationKbStatus } from './knowledgeBase';
import type { ConversationWorkspaceContextStatus } from './workspaceContext';
import type { Message, ConversationMessageWindow, ConversationPinnedMessage, SessionEntry } from './chat';

export interface ConversationEntry {
  id: string;
  title: string;
  /**
   * True once the user has manually renamed the conversation via PUT
   * /conversations/:id. Locks the title against all automatic mutations
   * (resetSession's "New Chat" stamp, addMessage's first-message snapshot,
   * generateAndUpdateTitle's LLM-generated title) so a manual rename
   * survives session resets and subsequent activity.
   */
  titleManuallySet?: boolean;
  backend: string;
  /**
   * Runtime CLI profile selected for this conversation. Phase 1 stores
   * server-configured profiles that preserve the existing harness behavior;
   * later phases resolve this ID to account/config/env-specific CLI runtime.
   */
  cliProfileId?: string;
  model?: string;
  /** Adaptive reasoning effort level for supported models. */
  effort?: EffortLevel;
  /** Claude Code-specific session mode. Only valid for Claude Code-family backends. */
  claudeCodeMode?: ClaudeCodeMode;
  /** Backend service tier override. Currently used by Codex Fast mode. */
  serviceTier?: ServiceTier;
  currentSessionId: string;
  lastActivity: string;
  lastMessage: string | null;
  usage?: Usage;
  usageByBackend?: Record<string, Usage>;
  sessions: SessionEntry[];
  archived?: boolean;
  /**
   * True when the conversation has received a new response since the user
   * last opened it. Set by the client when a stream completes on a non-active
   * conversation (or manually via the sidebar dot); cleared when the user
   * selects the conversation. Absent/false for read conversations.
   */
  unread?: boolean;
  messageQueue?: QueuedMessage[];
  /** Checkout used to run this conversation's CLI. Omitted means shared workspace folder. */
  checkout?: ConversationCheckout;
}

export interface WorktreeIsolationSettings {
  enabled: boolean;
  repoRoot: string;
  workspaceRelPath: string;
  remoteName: string;
  baseBranch: string;
  remoteBaseRef: string;
  worktreeBaseDir: string;
  enabledAt: string;
}

export interface ConversationCheckout {
  mode: 'shared' | 'worktree';
  repoRoot?: string;
  worktreeRoot?: string;
  executionDir?: string;
  workspaceRelPath?: string;
  currentBranch?: string;
  remoteBaseRef?: string;
  updatedAt?: string;
}

export interface Conversation {
  id: string;
  title: string;
  titleManuallySet?: boolean;
  backend: string;
  cliProfileId?: string;
  model?: string;
  effort?: EffortLevel;
  claudeCodeMode?: ClaudeCodeMode;
  serviceTier?: ServiceTier;
  workingDir: string;
  executionDir?: string;
  checkout?: ConversationCheckout;
  /** Stable workspace identity. Prefer this over legacy workspaceHash for grouping and workspace routes. */
  workspaceId: string;
  /** Legacy path-derived storage alias. Retained for migration/debug metadata. */
  workspaceHash: string;
  currentSessionId: string;
  sessionNumber: number;
  messages: Message[];
  messageWindow?: ConversationMessageWindow;
  pinnedMessages?: ConversationPinnedMessage[];
  usage?: Usage;
  sessionUsage?: Usage;
  /** Backend-managed session ID from the active session, for resume/rehydration. */
  externalSessionId?: string | null;
  messageQueue?: QueuedMessage[];
  archived?: boolean;
  /** KB status snapshot, populated when workspace has KB enabled. */
  kb?: ConversationKbStatus;
  /** Workspace Context run snapshot for composer notifications. */
  workspaceContext?: ConversationWorkspaceContextStatus;
}

export interface ConversationListItem {
  id: string;
  title: string;
  updatedAt: string;
  backend: string;
  cliProfileId?: string;
  model?: string;
  effort?: EffortLevel;
  claudeCodeMode?: ClaudeCodeMode;
  serviceTier?: ServiceTier;
  workingDir: string;
  executionDir?: string;
  checkout?: ConversationCheckout;
  /** Stable workspace identity. Prefer this over legacy workspaceHash for grouping and workspace routes. */
  workspaceId: string;
  /** Legacy path-derived storage alias. Retained for migration/debug metadata. */
  workspaceHash: string;
  /** Per-workspace Knowledge Base toggle. Defaults to false for legacy workspaces. */
  workspaceKbEnabled: boolean;
  messageCount: number;
  lastMessage: string | null;
  usage: Usage | null;
  archived?: boolean;
  /** Mirror of `ConversationEntry.unread` so the sidebar can render unread dots without a second round-trip. */
  unread?: boolean;
}
