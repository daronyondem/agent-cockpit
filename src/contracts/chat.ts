import type { QueuedMessage, Settings } from '../types';
import { asRecord, contractError } from './validation';
export { parseServiceTierInput } from './serviceTier';

export interface ApiErrorResponse {
  error: string;
}

export interface VersionResponse {
  version: string;
  remoteVersion: string | null;
  updateAvailable: boolean;
}

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
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    contractError('settings must be an object');
  }
  return body as Settings;
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
