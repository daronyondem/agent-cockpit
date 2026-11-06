import type { CliProfile } from './cliProfiles';

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
  sessionId?: string;
}
