import { asRecord, optionalBoolean, optionalString, requiredNonEmptyString, requiredString } from './validation';

export interface ExplorerMkdirRequest {
  parent: string;
  name: string;
}

export interface ExplorerCreateFileRequest {
  parent: string;
  name: string;
  content: string;
}

export interface ExplorerSaveFileRequest {
  path: string;
  content: string;
}

export interface ExplorerRenameRequest {
  from: string;
  to: string;
  overwrite: boolean;
}

export function validateExplorerMkdirRequest(body: unknown): ExplorerMkdirRequest {
  const record = asRecord(body);
  return {
    parent: optionalString(record, 'parent') || '',
    name: requiredNonEmptyString(record, 'name', 'name is required'),
  };
}

export function validateExplorerCreateFileRequest(body: unknown): ExplorerCreateFileRequest {
  const record = asRecord(body);
  return {
    parent: optionalString(record, 'parent') || '',
    name: requiredNonEmptyString(record, 'name', 'name is required'),
    content: optionalString(record, 'content') || '',
  };
}

export function validateExplorerSaveFileRequest(body: unknown): ExplorerSaveFileRequest {
  const record = asRecord(body);
  return {
    path: requiredNonEmptyString(record, 'path', 'path is required'),
    content: requiredString(record, 'content', 'content must be a string'),
  };
}

export function validateExplorerRenameRequest(body: unknown): ExplorerRenameRequest {
  const record = asRecord(body);
  return {
    from: requiredString(record, 'from', 'from and to are required strings'),
    to: requiredString(record, 'to', 'from and to are required strings'),
    overwrite: optionalBoolean(record, 'overwrite') === true,
  };
}
