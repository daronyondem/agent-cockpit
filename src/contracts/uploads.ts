import { asRecord, requiredNonEmptyString } from './validation';

export interface UploadDeleteRequest {
  filename: string;
}

export interface AttachmentOcrRequest {
  path: string;
}

export function validateAttachmentOcrRequest(body: unknown): AttachmentOcrRequest {
  const record = asRecord(body);
  return { path: requiredNonEmptyString(record, 'path', 'path is required') };
}
