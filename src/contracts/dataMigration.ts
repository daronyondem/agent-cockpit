import { asRecord, requiredNonEmptyString } from './validation';

export const DATA_EXPORT_SCHEMA_VERSION = 1;
export const DATA_IMPORT_CONFIRMATION = 'REPLACE';

export interface DataExportFileRecord {
  path: string;
  bytes: number;
  sha256: string;
}

export interface DataExportWorkspaceRecord {
  workspaceId: string;
  storageKey: string;
  currentPath: string | null;
  previousPaths: string[];
  memory: { present: boolean; enabled?: boolean | null };
  knowledge: {
    present: boolean;
    enabled?: boolean | null;
    stateDb: boolean;
    vectors: boolean;
    embeddingConfig?: {
      model?: string;
      ollamaHost?: string;
      dimensions?: number;
    } | null;
  };
  workspaceContext: { present: boolean; enabled?: boolean | null };
}

export interface DataExportManifest {
  schemaVersion: 1;
  appVersion: string;
  exportedAt: string;
  sourcePlatform: NodeJS.Platform;
  dataRootName: string;
  includedRoot: 'AGENT_COCKPIT_DATA_DIR';
  auth: {
    included: boolean;
    path: string | null;
    warning?: string;
  };
  counts: {
    workspaces: number;
    files: number;
    bytes: number;
  };
  workspaces: DataExportWorkspaceRecord[];
  files: DataExportFileRecord[];
  excluded: string[];
  warnings: string[];
}

export interface DataImportPreviewResponse {
  uploadId: string;
  manifest: DataExportManifest;
  warnings: string[];
}

export interface DataExportJobStatusResponse {
  jobId: string;
  status: 'running' | 'ready' | 'failed';
  phase: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
  filename?: string;
  manifest?: DataExportManifest;
  error?: string;
}

export interface DataImportConfirmRequest {
  uploadId: string;
  confirmation: string;
}

export interface DataImportConfirmSuccessResponse {
  ok: true;
  pending: true;
  restart: unknown;
  backupPath: string;
  importId: string;
  message: string;
}

export interface DataImportConfirmFailureResponse {
  ok: false;
  pending: false;
  error: string;
  restart?: unknown;
  backupPath?: string;
  importId?: string;
}

export type DataImportConfirmResponse = DataImportConfirmSuccessResponse | DataImportConfirmFailureResponse;

export interface DataMigrationStatusResponse {
  dataRoot: string;
  controlDir: string;
  pendingImport: boolean;
  lastImport: unknown | null;
}

export function validateDataImportConfirmRequest(body: unknown): DataImportConfirmRequest {
  const record = asRecord(body);
  return {
    uploadId: requiredNonEmptyString(record, 'uploadId', 'uploadId is required').trim(),
    confirmation: requiredNonEmptyString(record, 'confirmation', 'confirmation is required').trim(),
  };
}
