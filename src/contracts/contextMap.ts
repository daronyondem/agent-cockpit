import type { ContractEffortLevel } from './conversations';
import { asRecord, contractError, optionalBoolean, optionalFiniteNumber, requiredBoolean } from './validation';

export type ContextMapProcessorMode = 'global' | 'override';

export interface ContextMapWorkspaceSettings {
  processorMode?: ContextMapProcessorMode;
  cliProfileId?: string;
  cliBackend?: string;
  cliModel?: string;
  cliEffort?: ContractEffortLevel;
  scanIntervalMinutes?: number;
}

export interface ContextMapSettingsRequest {
  settings: ContextMapWorkspaceSettings;
}

export interface ContextMapEnabledRequest {
  enabled: boolean;
}

export interface ContextMapCandidateUpdateRequest {
  payload: Record<string, unknown>;
  confidence?: number;
}

export interface ContextMapCandidateApplyRequest {
  includeDependencies: boolean;
}

export function validateContextMapSettingsRequest(body: unknown): ContextMapSettingsRequest {
  const record = asRecord(body, 'settings must be an object');
  const input = Object.prototype.hasOwnProperty.call(record, 'settings') ? record.settings : body;
  if (!input || typeof input !== 'object' || Array.isArray(input)) contractError('settings must be an object');
  return { settings: input as ContextMapWorkspaceSettings };
}

export function validateContextMapEnabledRequest(body: unknown): ContextMapEnabledRequest {
  const record = asRecord(body);
  return { enabled: requiredBoolean(record, 'enabled', 'enabled must be a boolean') };
}

export function validateContextMapCandidateUpdateRequest(body: unknown): ContextMapCandidateUpdateRequest {
  const record = asRecord(body);
  const payload = record.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) contractError('payload must be an object');
  const confidence = optionalFiniteNumber(record, 'confidence', 'confidence must be a number');
  return {
    payload: payload as Record<string, unknown>,
    ...(confidence === undefined ? {} : { confidence }),
  };
}

export function validateContextMapCandidateApplyRequest(body: unknown): ContextMapCandidateApplyRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { includeDependencies: false };
  }
  const includeDependencies = optionalBoolean(body as Record<string, unknown>, 'includeDependencies', 'includeDependencies must be a boolean');
  return { includeDependencies: includeDependencies === true };
}
