import { asRecord, contractError, optionalRecord, optionalString, requiredBoolean, requiredNonEmptyString } from './validation';

export interface MemoryEnabledRequest {
  enabled: boolean;
}

export function validateMemoryEnabledRequest(body: unknown): MemoryEnabledRequest {
  const record = asRecord(body);
  return { enabled: requiredBoolean(record, 'enabled', 'enabled must be a boolean') };
}

export interface MemoryConsolidationDraftRequest {
  action: Record<string, unknown>;
}

export interface MemoryConsolidationApplyRequest {
  summary?: string;
  actions: Record<string, unknown>[];
}

export interface MemoryConsolidationDraftApplyRequest {
  summary?: string;
  draft: Record<string, unknown> & { operations: unknown[] };
}

export interface MemoryEntryRestoreRequest {
  relPath: string;
}

export interface MemoryReviewDraftApplyRequest {
  draft?: Record<string, unknown>;
}

export function validateMemoryConsolidationDraftRequest(body: unknown): MemoryConsolidationDraftRequest {
  const record = asRecord(body);
  const action = optionalRecord(record, 'action', 'action must be an object');
  if (!action) contractError('action must be an object');
  return { action };
}

export function validateMemoryConsolidationApplyRequest(body: unknown): MemoryConsolidationApplyRequest {
  const record = asRecord(body);
  const actions = record.actions;
  if (!Array.isArray(actions)) contractError('actions must be an array');
  return {
    summary: optionalString(record, 'summary'),
    actions: actions.map((action) => asRecord(action, 'actions must contain objects')),
  };
}

export function validateMemoryConsolidationDraftApplyRequest(body: unknown): MemoryConsolidationDraftApplyRequest {
  const record = asRecord(body);
  const draft = optionalRecord(record, 'draft', 'draft.operations must be an array');
  if (!draft || !Array.isArray(draft.operations)) contractError('draft.operations must be an array');
  return {
    summary: optionalString(record, 'summary'),
    draft: draft as Record<string, unknown> & { operations: unknown[] },
  };
}

export function validateMemoryEntryRestoreRequest(body: unknown): MemoryEntryRestoreRequest {
  const record = asRecord(body);
  return { relPath: requiredNonEmptyString(record, 'relPath', 'relPath required') };
}

export function validateMemoryReviewDraftApplyRequest(body: unknown): MemoryReviewDraftApplyRequest {
  const record = asRecord(body);
  const draft = optionalRecord(record, 'draft', 'draft must be an object');
  return draft ? { draft } : {};
}
