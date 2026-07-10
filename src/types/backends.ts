// ── Backend Adapter Types ────────────────────────────────────────────

import type { EffortLevel, ClaudeCodeMode, ServiceTier, CliProfile } from './cliProfiles';
import type { SessionRecoveryOptions } from './sessionRecovery';
import type { StreamEvent } from './streams';

export interface BackendCapabilities {
  thinking: boolean;
  planMode: boolean;
  agents: boolean;
  toolActivity: boolean;
  userQuestions: boolean;
  stdinInput: boolean;
  oneShotMediaInput?: OneShotMediaInputCapabilities;
  goals?: boolean | BackendGoalCapability;
}

export type ModelInputModality = 'text' | 'image' | 'audio' | 'pdf' | 'video';

export type ModelOutputModality = 'text' | 'image' | 'audio' | 'pdf' | 'video';

export type OneShotMediaTransport = 'explicit-attachment' | 'native-file-tool';

export type OneShotMediaInputCapabilities = Partial<Record<ModelInputModality, OneShotMediaTransport[]>>;

export interface ModelCapabilities {
  input?: Partial<Record<ModelInputModality, boolean>>;
  output?: Partial<Record<ModelOutputModality, boolean>>;
  attachment?: boolean;
  toolcall?: boolean;
  reasoning?: boolean;
}

export interface BackendGoalCapability {
  set: boolean;
  clear: boolean;
  pause: boolean;
  resume: boolean;
  status: 'native' | 'transcript' | 'none';
}

export type BackendActiveTurnResumeSupport = 'unsupported' | 'supported';

export type BackendSessionResumeSupport = 'unsupported' | 'supported';

export interface BackendResumeCapabilities {
  /**
   * Whether Agent Cockpit can safely reattach to the same in-flight backend
   * turn after the cockpit server process restarts, without resending the
   * prompt or duplicating tool side effects.
   */
  activeTurnResume: BackendActiveTurnResumeSupport;
  activeTurnResumeReason: string;
  /**
   * Whether the backend can resume later session/thread context on the next
   * user turn after a process respawn. This is deliberately weaker than active
   * turn resume.
   */
  sessionResume: BackendSessionResumeSupport;
  sessionResumeReason: string;
}

export interface ModelOption {
  id: string;
  label: string;
  family: string;
  description?: string;
  costTier?: 'high' | 'medium' | 'low';
  default?: boolean;
  /**
   * Adaptive reasoning effort levels this model supports. Omit for models
   * without effort support (e.g. Haiku). UI uses presence of this field to
   * decide whether to show the effort dropdown. Values are backend/model-
   * specific; Codex may expose `none` / `minimal` / `ultra`, while Claude Code
   * exposes `max` on supported Claude models.
   */
  supportedEffortLevels?: EffortLevel[];
  capabilities?: ModelCapabilities;
}

export interface BackendMetadata {
  id: string;
  label: string;
  icon: string | null;
  capabilities: BackendCapabilities;
  resumeCapabilities: BackendResumeCapabilities;
  models?: ModelOption[];
}

/**
 * ACP-shaped MCP server config for `session/new` and `session/load`.
 *
 * NOTE: `env` is an **array of `{name, value}` objects**, not a plain
 * `Record<string, string>`, because that is what the ACP spec
 * (https://agentclientprotocol.com/protocol/session-setup) requires.
 * Passing a plain object breaks strict ACP servers like kiro-cli.
 */
export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Array<{ name: string; value: string }>;
}

export interface SendMessageOptions {
  sessionId: string;
  /** Stable conversation ID (does not change on session reset). */
  conversationId?: string;
  /** Runtime CLI profile selected for the conversation. */
  cliProfileId?: string;
  /** Full profile record for adapters that support profile-isolated runtimes. */
  cliProfile?: CliProfile;
  isNewSession: boolean;
  workingDir: string | null;
  systemPrompt: string;
  /** Backend-managed session ID from a previous session, for resume/rehydration. */
  externalSessionId?: string | null;
  /**
   * Lazy recovery hook used only when a backend-native session resume fails.
   * Adapters call it after detecting a missing native session and before
   * prompting the fresh native session.
   */
  sessionRecovery?: SessionRecoveryOptions;
  /** Full model ID (e.g., 'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6'). Backends that don't support model selection ignore this. */
  model?: string;
  /**
   * Adaptive reasoning effort level. Backends that don't support effort
   * (or backends whose selected model doesn't) ignore this.
   */
  effort?: EffortLevel;
  /** Claude Code-specific session mode. Backends that are not Claude Code-family ignore this. */
  claudeCodeMode?: ClaudeCodeMode;
  /** Backend service tier override. Currently used by Codex Fast mode. */
  serviceTier?: ServiceTier;
  /**
   * MCP servers to expose to the backend for this session.  Currently
   * only used by ACP-based backends (e.g. Kiro) to forward the
   * Memory MCP stub.  Backends that don't support MCP ignore this.
   */
  mcpServers?: McpServerConfig[];
}

export interface SendMessageResult {
  stream: AsyncGenerator<StreamEvent>;
  abort: () => void;
  sendInput: (text: string) => void;
}
