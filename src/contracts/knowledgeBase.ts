import { asRecord, contractError, optionalFiniteNumber, optionalString, requiredBoolean, requiredNonEmptyString, requiredString } from './validation';

export interface KbEnabledRequest {
  enabled: boolean;
}

export interface KbAutoDigestRequest {
  autoDigest: boolean;
}

export interface KbFolderCreateRequest {
  folderPath: string;
}

export interface KbFolderRenameRequest {
  fromPath: string;
  toPath: string;
}

export interface KbGlossaryTermRequest {
  term: string;
  expansion: string;
}

export interface KbEmbeddingConfigRequest {
  model?: string;
  ollamaHost?: string;
  dimensions?: number;
}

export function validateKbEnabledRequest(body: unknown): KbEnabledRequest {
  const record = asRecord(body);
  return { enabled: requiredBoolean(record, 'enabled', 'enabled must be a boolean') };
}

export function validateKbAutoDigestRequest(body: unknown): KbAutoDigestRequest {
  const record = asRecord(body);
  return { autoDigest: requiredBoolean(record, 'autoDigest', 'autoDigest must be a boolean') };
}

export function validateKbFolderCreateRequest(body: unknown): KbFolderCreateRequest {
  const record = asRecord(body);
  return { folderPath: requiredNonEmptyString(record, 'folderPath', 'folderPath is required.') };
}

export function validateKbFolderRenameRequest(body: unknown): KbFolderRenameRequest {
  const record = asRecord(body);
  return {
    fromPath: requiredString(record, 'fromPath', 'fromPath and toPath are required.'),
    toPath: requiredString(record, 'toPath', 'fromPath and toPath are required.'),
  };
}

export function validateKbGlossaryTermRequest(body: unknown): KbGlossaryTermRequest {
  const record = asRecord(body);
  return {
    term: requiredNonEmptyString(record, 'term', 'term must be a non-empty string'),
    expansion: requiredNonEmptyString(record, 'expansion', 'expansion must be a non-empty string'),
  };
}

export function validateKbEmbeddingConfigRequest(body: unknown): KbEmbeddingConfigRequest {
  const record = asRecord(body);
  const model = optionalString(record, 'model', 'model must be a string');
  const ollamaHost = optionalString(record, 'ollamaHost', 'ollamaHost must be a string');
  const dimensions = optionalFiniteNumber(record, 'dimensions', 'dimensions must be a positive number');
  if (dimensions !== undefined && dimensions < 1) {
    contractError('dimensions must be a positive number');
  }
  return {
    ...(model === undefined ? {} : { model }),
    ...(ollamaHost === undefined ? {} : { ollamaHost }),
    ...(dimensions === undefined ? {} : { dimensions }),
  };
}
