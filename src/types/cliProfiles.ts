// ── CLI Profile Types ───────────────────────────────────────────────

/** Adaptive reasoning effort level. Supported values are model/backend-specific. */
export type EffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Claude Code-specific session mode. Omit for regular Claude Code effort handling. */
export type ClaudeCodeMode = 'ultracode';

/** Backend service tier override. Omit to use the selected CLI profile's own configuration. */
export type ServiceTier = 'fast';

export type CliHarness = 'codex' | 'claude-code' | 'kiro' | 'opencode';

export type CliAuthMode = 'server-configured' | 'account';

export type CliCommunicationProtocol = 'standard' | 'interactive';

export type ClaudeCodeProvider = 'anthropic' | 'bedrock';

export interface ClaudeCodeBedrockInferenceProfile {
  id: string;
  name: string;
  inferenceProfileId: string;
  baseModelId?: string;
  default?: boolean;
}

export interface ClaudeCodeBedrockConfig {
  inferenceProfiles?: ClaudeCodeBedrockInferenceProfile[];
}

export interface ClaudeCodeProfileConfig {
  provider?: ClaudeCodeProvider;
  bedrock?: ClaudeCodeBedrockConfig;
}

export interface CliProfile {
  id: string;
  name: string;
  harness: CliHarness;
  /** Claude Code only: how Agent Cockpit communicates with the shared Claude CLI. */
  protocol?: CliCommunicationProtocol;
  /** Claude Code only: provider and provider-specific model routing configuration. */
  claudeCode?: ClaudeCodeProfileConfig;
  /** OpenCode only: provider choice for this logical profile. model is retained for legacy saved profiles; new UI selections happen in the composer. */
  opencode?: {
    provider?: string;
    model?: string;
  };
  /** Optional executable override. When omitted, the harness default command is used. */
  command?: string;
  /** Server-configured keeps current server-side CLI state; account means Cockpit owns setup for this profile. */
  authMode: CliAuthMode;
  /** Optional harness config/auth directory for account-isolated profiles. */
  configDir?: string;
  /** Optional runtime environment overrides applied when spawning this profile's CLI. */
  env?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  disabled?: boolean;
}
