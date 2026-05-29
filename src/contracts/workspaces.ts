import {
  asRecord,
  contractError,
  optionalBoolean,
  optionalRecord,
  optionalString,
  optionalStringEnum,
  requiredNonEmptyString,
} from './validation';
export type WorkspaceArchiveMode = 'history_only' | 'file_snapshot';
export type WorkspaceSnapshotStatus = 'none' | 'creating' | 'verified' | 'failed' | 'deleted';
export type WorkspaceSnapshotInclusionPolicy = 'include_all' | 'exclude_common';
export type WorkspaceOriginalCleanupMode = 'keep' | 'move_to_trash' | 'delete_permanently';
export type WorkspaceArchiveFinalLearningStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface WorkspaceArchiveFinalLearningPass {
  status: WorkspaceArchiveFinalLearningStatus;
  startedAt?: string;
  completedAt?: string;
  summaryPath?: string;
  error?: string;
}

export interface WorkspaceSnapshotMetadata {
  id: string;
  status: WorkspaceSnapshotStatus;
  archivePath?: string;
  manifestPath?: string;
  sizeBytes?: number;
  fileCount?: number;
  checksum?: string;
  inclusionPolicy?: WorkspaceSnapshotInclusionPolicy;
  createdAt?: string;
  verifiedAt?: string;
  error?: string;
}

export interface WorkspaceArchiveMetadata {
  archivedAt: string;
  note?: string;
  mode: WorkspaceArchiveMode;
  finalLearningPass?: WorkspaceArchiveFinalLearningPass;
  snapshot?: WorkspaceSnapshotMetadata;
  originalCleanup?: {
    mode: WorkspaceOriginalCleanupMode;
    completedAt?: string;
    movedTo?: string;
    error?: string;
  };
}

export interface WorkspaceLocationResponse {
  workspaceId: string;
  workspacePath: string;
  legacyHash: string;
  previousPaths: string[];
}

export interface WorkspaceLocationUpdateRequest {
  workspacePath: string;
}

export function validateWorkspaceLocationUpdateRequest(body: unknown): WorkspaceLocationUpdateRequest {
  const record = asRecord(body);
  return {
    workspacePath: requiredNonEmptyString(record, 'workspacePath', 'workspacePath is required'),
  };
}

export interface WorkspaceSummaryResponse {
  workspaceId: string;
  workspacePath: string;
  legacyHash: string;
  previousPaths: string[];
  archived: boolean;
  archive?: WorkspaceArchiveMetadata;
  pathAvailable: boolean;
  conversationCount: number;
  activeConversationCount: number;
  archivedConversationCount: number;
  memoryEnabled: boolean;
  kbEnabled: boolean;
  workspaceContextEnabled: boolean;
}

export interface WorkspaceArchiveResponse {
  workspace: WorkspaceSummaryResponse;
}

export interface WorkspaceArchiveRequest {
  mode?: WorkspaceArchiveMode;
  note?: string;
  snapshot?: {
    inclusionPolicy?: WorkspaceSnapshotInclusionPolicy;
    cleanupOriginal?: WorkspaceOriginalCleanupMode;
    confirmDeleteOriginal?: string;
  };
}

export interface WorkspaceRestoreRequest {
  restoreFromSnapshot?: boolean;
  destinationPath?: string;
}

export interface WorkspaceSnapshotEstimateRequest {
  inclusionPolicy?: WorkspaceSnapshotInclusionPolicy;
}

export interface WorkspaceSnapshotEstimateResponse {
  workspaceId: string;
  workspacePath: string;
  inclusionPolicy: WorkspaceSnapshotInclusionPolicy;
  fileCount: number;
  directoryCount: number;
  symlinkCount: number;
  excludedCount: number;
  sizeBytes: number;
}

const ARCHIVE_MODES: readonly WorkspaceArchiveMode[] = ['history_only', 'file_snapshot'];
const SNAPSHOT_INCLUSION_POLICIES: readonly WorkspaceSnapshotInclusionPolicy[] = ['include_all', 'exclude_common'];
const ORIGINAL_CLEANUP_MODES: readonly WorkspaceOriginalCleanupMode[] = ['keep', 'move_to_trash', 'delete_permanently'];

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function validateWorkspaceArchiveRequest(body: unknown): WorkspaceArchiveRequest {
  const record = body == null ? {} : asRecord(body);
  const mode = optionalStringEnum(record, 'mode', ARCHIVE_MODES) || 'history_only';
  const note = cleanOptionalString(optionalString(record, 'note'));
  const snapshotRecord = optionalRecord(record, 'snapshot');
  if (mode === 'file_snapshot' && !snapshotRecord) {
    contractError('snapshot is required when mode is file_snapshot');
  }
  if (mode === 'history_only' && snapshotRecord) {
    contractError('snapshot is only allowed when mode is file_snapshot');
  }
  const snapshot = snapshotRecord ? {
    inclusionPolicy: optionalStringEnum(snapshotRecord, 'inclusionPolicy', SNAPSHOT_INCLUSION_POLICIES) || 'exclude_common',
    cleanupOriginal: optionalStringEnum(snapshotRecord, 'cleanupOriginal', ORIGINAL_CLEANUP_MODES) || 'keep',
    confirmDeleteOriginal: cleanOptionalString(optionalString(snapshotRecord, 'confirmDeleteOriginal')),
  } : undefined;
  if (snapshot?.cleanupOriginal === 'delete_permanently' && snapshot.confirmDeleteOriginal !== 'DELETE ORIGINAL') {
    contractError('confirmDeleteOriginal must be DELETE ORIGINAL when cleanupOriginal is delete_permanently');
  }
  return {
    mode,
    ...(note ? { note } : {}),
    ...(snapshot ? { snapshot } : {}),
  };
}

export function validateWorkspaceRestoreRequest(body: unknown): WorkspaceRestoreRequest {
  const record = body == null ? {} : asRecord(body);
  const restoreFromSnapshot = optionalBoolean(record, 'restoreFromSnapshot') ?? false;
  const destinationPath = cleanOptionalString(optionalString(record, 'destinationPath'));
  return {
    restoreFromSnapshot,
    ...(destinationPath ? { destinationPath } : {}),
  };
}

export function validateWorkspaceSnapshotEstimateRequest(body: unknown): WorkspaceSnapshotEstimateRequest {
  const record = body == null ? {} : asRecord(body);
  return {
    inclusionPolicy: optionalStringEnum(record, 'inclusionPolicy', SNAPSHOT_INCLUSION_POLICIES) || 'exclude_common',
  };
}
