// ── Install And Update Types ─────────────────────────────────────────

import type { CliHarness } from './cliProfiles';

export type InstallChannel = 'production' | 'dev';

export type InstallSource = 'github-release' | 'git-main' | 'unknown';

export type InstallStateSource = 'stored' | 'inferred' | 'legacy' | 'corrupt';

export type InstallNodeRuntimeSource = 'private' | 'system' | 'unknown';

export interface InstallNodeRuntime {
  source: InstallNodeRuntimeSource;
  version: string | null;
  npmVersion: string | null;
  binDir: string | null;
  runtimeDir: string | null;
  requiredMajor: number | null;
  updatedAt: string | null;
}

export interface InstallStartup {
  kind: 'scheduled-task' | 'launch-agent' | 'systemd-user' | 'manual' | 'unknown';
  name: string | null;
  scope: 'current-user' | 'unknown';
}

export interface InstallStatus {
  schemaVersion: 1;
  channel: InstallChannel;
  source: InstallSource;
  repo: string;
  version: string | null;
  branch: string | null;
  installDir: string | null;
  appDir: string | null;
  dataDir: string;
  installedAt: string | null;
  welcomeCompletedAt: string | null;
  nodeRuntime: InstallNodeRuntime | null;
  startup?: InstallStartup | null;
  stateSource: InstallStateSource;
  stateError: string | null;
}

export type InstallDoctorCheckStatus = 'ok' | 'warning' | 'error';

export type InstallDoctorActionKind = 'command' | 'link';

export interface InstallDoctorAction {
  id: string;
  kind: InstallDoctorActionKind;
  label: string;
  description?: string;
  command?: string[];
  href?: string;
}

export interface InstallDoctorCheck {
  id: string;
  label: string;
  status: InstallDoctorCheckStatus;
  required: boolean;
  summary: string;
  detail?: string;
  remediation?: string;
  installActions?: InstallDoctorAction[];
}

export interface InstallDoctorStatus {
  generatedAt: string;
  overallStatus: InstallDoctorCheckStatus;
  install: InstallStatus;
  checks: InstallDoctorCheck[];
}

export interface InstallDoctorActionResult {
  success: boolean;
  action?: InstallDoctorAction;
  steps: UpdateStep[];
  doctor?: InstallDoctorStatus;
  error?: string;
}

export interface UpdateStatus {
  localVersion: string;
  remoteVersion: string | null;
  updateAvailable: boolean;
  lastCheckAt: string | null;
  lastError: string | null;
  updateInProgress: boolean;
  installChannel: InstallChannel;
  installSource: InstallSource;
  installStateSource: InstallStateSource;
}

export interface UpdateStep {
  name: string;
  success: boolean;
  output?: string;
}

export interface UpdateResult {
  success: boolean;
  steps: UpdateStep[];
  error?: string;
}

export type CliInstallMethod = 'npm-global' | 'self-update' | 'unknown' | 'missing';

export interface CliUpdateStatus {
  id: string;
  harness: CliHarness;
  label: string;
  command: string;
  resolvedPath: string | null;
  profileIds: string[];
  profileNames: string[];
  installMethod: CliInstallMethod;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  updateSupported: boolean;
  updateInProgress: boolean;
  lastCheckAt: string | null;
  lastError: string | null;
  updateCommand: string[] | null;
  interactiveCompatibility?: CliCompatibilityStatus[];
  blocksAutoUpdate?: boolean;
  updateCaution?: string | null;
}

export interface CliUpdatesResponse {
  items: CliUpdateStatus[];
  lastCheckAt: string | null;
  updateInProgress: boolean;
}

export interface CliUpdateResult {
  success: boolean;
  item?: CliUpdateStatus;
  steps: UpdateStep[];
  error?: string;
}

export interface CliCompatibilityStatus {
  providerId: 'claude-code-interactive';
  command: string;
  currentVersion: string | null;
  testedVersion: string;
  status: 'supported' | 'newer' | 'older' | 'unknown' | 'missing';
  severity: 'none' | 'warning' | 'error';
  message: string | null;
}
