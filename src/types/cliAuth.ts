import type { CliProfile } from './cliProfiles';
import type { CortexAuthHandoff } from '../contracts/cortexAuth';

export type CliAuthJobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type CliAuthEventType = 'info' | 'stdout' | 'stderr' | 'error' | 'exit';
export interface CliAuthEvent { at: string; type: CliAuthEventType; text: string }
export interface CliAuthJobSnapshot {
  id: string;
  profileId: string;
  profileName: string;
  harness: CliProfile['harness'];
  status: CliAuthJobStatus;
  startedAt: string;
  updatedAt: string;
  command: string;
  args: string[];
  events: CliAuthEvent[];
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  cortex?: CortexAuthHandoff;
}
export interface CliAuthCheckResult {
  profileId: string;
  harness: CliProfile['harness'];
  command: string;
  available: boolean;
  authenticated: boolean | null;
  status: 'ok' | 'not-authenticated' | 'unavailable' | 'unsupported' | 'error';
  output: string;
  error?: string;
  exitCode?: number | null;
  modelsAvailable?: boolean;
  modelCount?: number;
  modelListError?: string;
}
