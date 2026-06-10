// ── Workspace Context Types ──────────────────────────────────────────

import type { EffortLevel } from './cliProfiles';

export type ConversationWorkspaceContextRunStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'skipped';

export type ConversationWorkspaceContextRunSource = 'initial_scan' | 'scheduled' | 'session_reset' | 'archive' | 'manual_catchup' | 'maintenance';

export type WorkspaceContextRunSkippedReason = 'scan-running' | 'maintenance-running' | 'already-running';

export interface ConversationWorkspaceContextStatus {
  enabled: boolean;
  pending: boolean;
  runningRuns: number;
  failedRuns: number;
  contextDir?: string;
  fileCount?: number;
  latestRunId?: string;
  latestRunStatus?: ConversationWorkspaceContextRunStatus;
  latestRunCreatedAt?: string;
  latestRunUpdatedAt?: string;
  latestRunSource?: ConversationWorkspaceContextRunSource;
  lastRunId?: string;
  lastRunStatus?: ConversationWorkspaceContextRunStatus;
  lastRunCreatedAt?: string;
  lastRunUpdatedAt?: string;
  lastRunSource?: ConversationWorkspaceContextRunSource;
}

export type WorkspaceContextRunStatus = ConversationWorkspaceContextRunStatus;

export type WorkspaceContextRunSource = ConversationWorkspaceContextRunSource;

export interface WorkspaceContextRunRecord {
  runId: string;
  source: WorkspaceContextRunSource;
  status: WorkspaceContextRunStatus;
  startedAt: string;
  completedAt?: string;
  filesConsidered: number;
  summary: string | null;
  errorMessage?: string;
  skippedReason?: WorkspaceContextRunSkippedReason;
}

export interface WorkspaceContextState {
  version: number;
  contextDir: string;
  lastRun?: WorkspaceContextRunRecord;
  /** Legacy aggregate completion timestamp retained for older state files. */
  lastCompletedAt?: string;
  lastScanCompletedAt?: string;
  lastMaintenanceCompletedAt?: string;
  runs: WorkspaceContextRunRecord[];
}

export interface WorkspaceContextGlobalSettings {
  cliProfileId?: string;
  /** @deprecated Use cliProfileId. */
  cliBackend?: string;
  cliModel?: string;
  cliEffort?: EffortLevel;
  /** Background scan interval in minutes. Default 5. */
  scanIntervalMinutes?: number;
  /** Max workspace scans started by the scheduler at once. Default 1. */
  cliConcurrency?: number;
  /** Background maintenance interval in hours. Default 24. */
  maintenanceIntervalHours?: number;
  /** Max workspace maintenance runs started by the scheduler at once. Default 1. */
  maintenanceCliConcurrency?: number;
}

export type WorkspaceContextProcessorMode = 'global' | 'override';

export interface WorkspaceContextWorkspaceSettings {
  /** Use global processor defaults unless explicitly set to override. */
  processorMode?: WorkspaceContextProcessorMode;
  cliProfileId?: string;
  /** @deprecated Use cliProfileId. */
  cliBackend?: string;
  cliModel?: string;
  cliEffort?: EffortLevel;
  scanIntervalMinutes?: number;
  maintenanceIntervalHours?: number;
}

export interface WorkspaceContextUpdateEvent {
  type: 'workspace_context_update';
  updatedAt: string;
  workspaceContext: ConversationWorkspaceContextStatus;
}
