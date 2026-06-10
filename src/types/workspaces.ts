// ── Workspace Index Types ────────────────────────────────────────────

import type { WorkspaceArchiveMetadata } from '../contracts/workspaces';
import type { CliHarness } from './cliProfiles';
import type { KbAutoDreamConfig } from './knowledgeBase';
import type { WorkspaceContextWorkspaceSettings } from './workspaceContext';
import type { ConversationEntry, WorktreeIsolationSettings } from './conversations';

export type WorkspaceInstructionSourceId = 'agents' | 'claude' | 'kiro';

export interface WorkspaceInstructionSourceStatus {
  id: WorkspaceInstructionSourceId;
  harness: CliHarness;
  label: string;
  expectedPath: string;
  present: boolean;
  paths: string[];
}

export interface WorkspaceInstructionHarnessStatus {
  harness: CliHarness;
  label: string;
  sourceId: WorkspaceInstructionSourceId;
  expectedPath: string;
  covered: boolean;
}

export interface WorkspaceInstructionPointerResult {
  harness: CliHarness;
  label: string;
  path: string;
}

export interface WorkspaceInstructionCompatibilityStatus {
  workspaceId: string;
  workspaceHash: string;
  workspacePath: string;
  sources: WorkspaceInstructionSourceStatus[];
  harnesses: WorkspaceInstructionHarnessStatus[];
  missingHarnesses: WorkspaceInstructionHarnessStatus[];
  hasAnyInstructions: boolean;
  compatible: boolean;
  canCreatePointers: boolean;
  fingerprint: string;
  dismissed: boolean;
  shouldNotify: boolean;
  primarySourceId: WorkspaceInstructionSourceId | null;
}

export interface WorkspaceIndex {
  /** Stable workspace identity. Generated once and preserved across path moves. */
  workspaceId: string;
  workspacePath: string;
  /** Workspace-level lifecycle archive metadata. Absent means active. */
  archive?: WorkspaceArchiveMetadata;
  instructions?: string;
  /**
   * Fingerprint of the last dismissed CLI instruction-file compatibility
   * warning. The fingerprint changes when detected instruction sources or
   * missing harness entrypoints change, so a stale dismissal does not hide a
   * newly-actionable mismatch.
   */
  instructionCompatibilityDismissedFingerprint?: string;
  /**
   * Whether per-workspace Memory is enabled. When false/undefined, the
   * workspace behaves exactly as before this feature: no memory injection,
   * no MCP memory_note exposure, no post-session extraction.
   */
  memoryEnabled?: boolean;
  /**
   * Whether per-workspace Knowledge Base is enabled. When false/undefined,
   * the workspace behaves exactly as before the KB feature: no KB pointer
   * injection, no `kb_ingest` MCP exposure, no pipeline activity. Default
   * is `false` — users opt in per workspace via the KB tab in Workspace
   * Settings.
   */
  kbEnabled?: boolean;
  /**
   * Per-workspace auto-digest flag. When true, ingested files are
   * automatically digested once conversion completes. Default false.
   * Toggling this on does NOT retroactively digest existing ingested
   * files — users must click "Digest All Pending" for that.
   */
  kbAutoDigest?: boolean;
  /**
   * Per-workspace automatic dreaming schedule. Default/off when absent.
   * Interval mode starts incremental dreaming every N hours when pending
   * synthesis exists. Window mode starts only inside the local server-time
   * window and requests a cooperative stop at the window end.
   */
  kbAutoDream?: KbAutoDreamConfig;
  /**
   * Per-workspace embedding configuration for the Knowledge Base vector
   * search layer.  Ollama with nomic-embed-text is the only supported
   * provider.  Changing the model after embeddings exist triggers a
   * re-embed (existing vectors are wiped, entries/topics flagged
   * `needs_embedding`).
   */
  kbEmbedding?: {
    /** Ollama model name. Default `nomic-embed-text`. */
    model?: string;
    /** Ollama server URL. Default `http://localhost:11434`. */
    ollamaHost?: string;
    /** Embedding dimensions (must match the model). Default 768. */
    dimensions?: number;
  };
  /** Whether markdown-first Workspace Context is enabled for this workspace. */
  workspaceContextEnabled?: boolean;
  /**
   * Whether Workspace Routines are enabled for this workspace. When
   * false/undefined, opening the Routines tab must not create routine
   * scaffolding, install AGENTS.md instructions, or run scheduled routines.
   */
  routinesEnabled?: boolean;
  /**
   * Per-workspace Workspace Context overrides. When absent or
   * `processorMode:'global'`, global Settings.workspaceContext defaults apply.
   */
  workspaceContext?: WorkspaceContextWorkspaceSettings;
  /** Per-conversation Git worktree isolation settings for this workspace. */
  worktreeIsolation?: WorktreeIsolationSettings;
  conversations: ConversationEntry[];
}

export interface WorkspaceIdentityRecord {
  workspaceId: string;
  storageKey: string;
  currentPath: string;
  legacyHash: string;
  previousPaths: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceIdentityRegistry {
  schemaVersion: 1;
  workspaces: WorkspaceIdentityRecord[];
}
