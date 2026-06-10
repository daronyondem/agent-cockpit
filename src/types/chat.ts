// ── Chat Message Types ───────────────────────────────────────────────

import type { Usage } from './usage';
import type { ToolActivity } from './tools';
import type { ConversationArtifact } from './attachments';
import type { GoalEvent } from './goals';
import type { SessionRecoveryMetadata } from './sessionRecovery';
import type { StreamErrorSource } from './streams';

/**
 * Ordered content block on an assistant message. Preserves the interleaving
 * of text, thinking, and tool activity as the CLI emits it so the renderer
 * can show "text → tool → text → tool" in source order instead of grouping
 * all tools and all text into separate buckets.
 *
 * When `contentBlocks` is present on a Message it is authoritative; the
 * legacy `content`, `thinking`, and `toolActivity` fields are derived views
 * kept for back-compat with session files written before this field existed.
 */
export type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool'; activity: ToolActivity }
  | { type: 'artifact'; artifact: ConversationArtifact };

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  backend: string;
  timestamp: string;
  thinking?: string;
  toolActivity?: ToolActivity[];
  /**
   * Ordered interleaving of text / thinking / tool blocks as they arrived
   * from the backend. Assistant messages only. Absent on older messages
   * — the renderer falls back to `content` + `toolActivity` when missing.
   */
  contentBlocks?: ContentBlock[];
  /**
   * Assistant messages only. Marks a durable terminal stream failure that
   * should render as an error outcome rather than a normal assistant reply.
   */
  streamError?: {
    message: string;
    source?: StreamErrorSource;
  };
  /**
   * System messages only. Marks a durable goal lifecycle event that should
   * render as a goal timeline card rather than ordinary chat dialogue.
   */
  goalEvent?: GoalEvent;
  /**
   * System messages only. Diagnostic metadata for a friendly Agent Cockpit
   * recovery notice shown when a backend-native harness session could not be
   * resumed and Agent Cockpit continued in a fresh native session.
   */
  sessionRecovery?: SessionRecoveryMetadata;
  /**
   * Assistant messages only. `progress` = intermediate segment saved at a
   * `turn_boundary` (agent still has more tool work to do). `final` = last
   * segment of the agent run saved at `done`. Absent on user/system messages
   * and on pre-existing assistant messages written before this field existed
   * — the renderer treats absent as `final` for back-compat.
   */
  turn?: 'progress' | 'final';
  /**
   * User-controlled marker for messages that should appear in the pinned
   * navigation strip and retain their emphasis when the conversation reloads.
   */
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
  /** Git branch used by this session when the workspace is in worktree-isolation mode. */
  branchName?: string;
  /** Git ref the session branch was created from. */
  baseRef?: string;
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
