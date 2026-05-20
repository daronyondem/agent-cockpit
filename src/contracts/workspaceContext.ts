import type { ContractEffortLevel } from './conversations';
import { asRecord, contractError, requiredBoolean } from './validation';

export type WorkspaceContextProcessorMode = 'global' | 'override';

export interface WorkspaceContextWorkspaceSettings {
  processorMode?: WorkspaceContextProcessorMode;
  cliProfileId?: string;
  cliBackend?: string;
  cliModel?: string;
  cliEffort?: ContractEffortLevel;
  scanIntervalMinutes?: number;
  maintenanceIntervalHours?: number;
}

export interface WorkspaceContextSettingsRequest {
  settings: WorkspaceContextWorkspaceSettings;
}

export interface WorkspaceContextEnabledRequest {
  enabled: boolean;
}

export function validateWorkspaceContextSettingsRequest(body: unknown): WorkspaceContextSettingsRequest {
  const record = asRecord(body, 'settings must be an object');
  const input = Object.prototype.hasOwnProperty.call(record, 'settings') ? record.settings : body;
  if (!input || typeof input !== 'object' || Array.isArray(input)) contractError('settings must be an object');
  return { settings: input as WorkspaceContextWorkspaceSettings };
}

export function validateWorkspaceContextEnabledRequest(body: unknown): WorkspaceContextEnabledRequest {
  const record = asRecord(body);
  return { enabled: requiredBoolean(record, 'enabled', 'enabled must be a boolean') };
}
