import { asRecord, requiredNonEmptyString } from './validation';

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
