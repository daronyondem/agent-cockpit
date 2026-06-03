import { asRecord, optionalString, requiredNonEmptyString } from './validation';
import type { Message } from './responses';

export interface UploadDeleteRequest {
  filename: string;
}

export interface AttachmentOcrRequest {
  path: string;
  backend?: string;
  cliProfileId?: string;
}

export interface AttachmentOcrResponse {
  markdown: string;
  recoveryMessage?: Message;
}

export function validateAttachmentOcrRequest(body: unknown): AttachmentOcrRequest {
  const record = asRecord(body);
  return {
    path: requiredNonEmptyString(record, 'path', 'path is required'),
    backend: optionalString(record, 'backend'),
    cliProfileId: optionalString(record, 'cliProfileId'),
  };
}
