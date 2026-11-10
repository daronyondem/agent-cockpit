import { asRecord, optionalString, optionalStringEnum, requiredNonEmptyString } from './validation';
import type { Message } from './responses';
import { CONTRACT_EFFORT_LEVELS, type ContractEffortLevel } from './conversations';

export interface UploadDeleteRequest {
  filename: string;
}

export interface AttachmentOcrRequest {
  path: string;
  backend?: string;
  cliProfileId?: string;
  model?: string;
  effort?: ContractEffortLevel;
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
    model: optionalString(record, 'model'),
    effort: optionalStringEnum(record, 'effort', CONTRACT_EFFORT_LEVELS),
  };
}
