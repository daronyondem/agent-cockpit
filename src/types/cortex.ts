import type { CliProfile } from './cliProfiles';
import type { EffortLevel } from './cliProfiles';
import type { AttachmentMeta } from './attachments';
import type { McpServerConfig } from './backends';

export type CortexRecord = Record<string, unknown>;
export type CortexRpcId = string | number;
export interface CortexRpcMessage {
  jsonrpc: '2.0';
  id?: CortexRpcId;
  method?: string;
  params?: CortexRecord;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface CortexProcessIdentity { pid: number; parent: number; group: number; started: string }

export interface CortexRuntimeConfig {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  fingerprint: string;
}

export interface CortexSessionOptions {
  profile: CliProfile;
  workspaceId: string;
  cwd: string;
  /** Instruction/plugin generation; changing it requires a new native runtime. */
  contextKey?: string;
  pluginDir?: string;
  /** Cockpit-owned child environment; never persisted into the CLI profile. */
  managedEnv?: Record<string, string>;
  mcpServers?: McpServerConfig[];
  sessionId?: string;
}

export interface CortexConfigOption {
  id: string;
  currentValue: string;
  options: Array<{ value: string; name: string }>;
}

export interface CortexSelection {
  model?: string;
  effort?: EffortLevel;
  mode?: 'standard' | 'plan';
}

export interface CortexTurnOptions extends CortexSelection {
  text: string;
  attachments?: AttachmentMeta[];
  /** Trusted conversation-specific upload directory, supplied by the server. */
  attachmentRoot?: string;
  allowTools: boolean;
  timeoutMs?: number;
}
