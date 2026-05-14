import type { Settings } from '../types';
import type {
  BackendMetadata,
  CliUpdatesResponse,
  QueuedMessage,
  UpdateStatus,
  UsageLedger,
} from './responses';
import { asRecord, contractError, optionalString, optionalStringEnum } from './validation';
export { parseServiceTierInput } from './serviceTier';

export interface ApiErrorResponse {
  error: string;
}

export interface VersionResponse {
  version: string;
  remoteVersion: string | null;
  updateAvailable: boolean;
}

export interface BasicOkResponse {
  ok: boolean;
}

export interface CurrentUserResponse {
  displayName: string | null;
  email: string | null;
  provider: 'local' | 'google' | 'github' | null;
}

export interface BackendsResponse {
  backends: BackendMetadata[];
}

export interface UpdateStatusResponse extends UpdateStatus {}

export interface CliUpdatesEnvelope extends CliUpdatesResponse {}

export interface UsageStatsResponse extends UsageLedger {}

export interface QueueResponse {
  queue: QueuedMessage[];
}

export interface QueueUpdateRequest {
  queue: QueuedMessage[];
}

export interface SettingsResponse extends Settings {}

export function validateQueueUpdateRequest(body: unknown): QueueUpdateRequest {
  const record = asRecord(body, 'queue must be an array of QueuedMessage');
  const queue = record.queue;
  if (!Array.isArray(queue)) {
    contractError('queue must be an array of QueuedMessage');
  }

  for (const entry of queue) {
    validateQueuedMessage(entry);
  }

  return { queue: queue as QueuedMessage[] };
}

export function validateSettingsRequest(body: unknown): Settings {
  const record = asRecord(body, 'settings must be an object');
  optionalStringEnum(record, 'theme', ['light', 'dark', 'system'], 'theme must be light, dark, or system');
  optionalStringEnum(record, 'sendBehavior', ['enter', 'ctrlEnter'], 'sendBehavior must be enter or ctrlEnter');
  optionalString(record, 'systemPrompt', 'systemPrompt must be a string');
  optionalString(record, 'defaultBackend', 'defaultBackend must be a string');
  optionalString(record, 'defaultCliProfileId', 'defaultCliProfileId must be a string');
  optionalString(record, 'defaultModel', 'defaultModel must be a string');
  optionalStringEnum(record, 'defaultEffort', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'defaultEffort is invalid');
  optionalStringEnum(record, 'defaultServiceTier', ['fast'], 'defaultServiceTier is invalid');
  optionalString(record, 'workingDirectory', 'workingDirectory must be a string');
  validateCliProfiles(record.cliProfiles);
  validateOptionalObject(record.memory, 'memory');
  validateOptionalObject(record.knowledgeBase, 'knowledgeBase');
  validateOptionalObject(record.contextMap, 'contextMap');
  return record as unknown as Settings;
}

function validateCliProfiles(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) contractError('cliProfiles must be an array');
  for (const profile of value) {
    const record = asRecord(profile, 'cliProfiles entries must be objects');
    optionalString(record, 'id', 'cliProfiles entries must have string ids');
    optionalString(record, 'name', 'cliProfiles entries names must be strings');
    optionalString(record, 'vendor', 'cliProfiles entries vendors must be strings');
    optionalStringEnum(record, 'protocol', ['standard', 'interactive'], 'cliProfiles entries protocols must be standard or interactive');
  }
}

function validateOptionalObject(value: unknown, name: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    contractError(`${name} must be an object`);
  }
}

function validateQueuedMessage(entry: unknown): void {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    contractError('queue entries must be objects with a content string');
  }
  const q = entry as { content?: unknown; attachments?: unknown };
  if (typeof q.content !== 'string') {
    contractError('queue entries must have a string content field');
  }
  if (q.attachments == null) return;
  if (!Array.isArray(q.attachments)) {
    contractError('queue entries attachments must be an array');
  }
  for (const attachment of q.attachments) {
    validateAttachment(attachment);
  }
}

function validateAttachment(attachment: unknown): void {
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
    contractError('each attachment must be an object');
  }
  const meta = attachment as { name?: unknown; path?: unknown };
  if (typeof meta.name !== 'string' || typeof meta.path !== 'string' || meta.path.trim() === '') {
    contractError('each attachment must have string name and non-empty path');
  }
}
