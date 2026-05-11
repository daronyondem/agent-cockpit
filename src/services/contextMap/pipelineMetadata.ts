import type { ContextCandidateType } from './db';

export interface ContextMapExtractionFailure {
  sourceType: 'conversation_message' | string;
  sourceId: string;
  errorMessage: string;
}

export interface ContextMapExtractionRepairEvent {
  sourceType: ContextMapExtractionFailure['sourceType'];
  sourceId: string;
  succeeded: boolean;
  errorMessage?: string;
}

export interface ContextMapExtractionUnitTiming {
  sourceType: ContextMapExtractionFailure['sourceType'];
  sourceId: string;
  durationMs: number;
  status: 'succeeded' | 'failed';
  candidates: number;
  repaired?: boolean;
}

export interface ContextMapExtractionTimingSummary {
  total: number;
  succeeded: number;
  failed: number;
  slowest: ContextMapExtractionUnitTiming[];
}

export interface ContextMapRunTimings {
  totalMs: number;
  planningMs: number;
  sourceDiscoveryMs: number;
  extractionMs: number;
  synthesisMs: number;
  persistenceMs: number;
  autoApplyMs: number;
  extractionUnits: ContextMapExtractionTimingSummary;
  synthesisStages: ContextMapSynthesisStageMetadata[];
}

export interface ContextMapSynthesisStageMetadata {
  stage: 'single' | 'chunk' | 'final';
  chunkId?: string;
  durationMs?: number;
  inputCandidates: number;
  outputCandidates: number;
  inputCandidateTypes?: Record<string, number>;
  outputCandidateTypes?: Record<string, number>;
  droppedCandidates: number;
  targetCandidates?: number;
  hardMaxCandidates?: number;
  openQuestions: string[];
  fallback?: boolean;
  errorMessage?: string;
  repairAttempted?: boolean;
  repairSucceeded?: boolean;
  repairErrorMessage?: string;
}

export interface ContextMapSynthesisMetadata {
  attempted: boolean;
  inputCandidates: number;
  outputCandidates: number;
  inputCandidateTypes?: Record<string, number>;
  outputCandidateTypes?: Record<string, number>;
  droppedCandidates: number;
  openQuestions: string[];
  stages?: ContextMapSynthesisStageMetadata[];
  targetCandidates?: number;
  hardMaxCandidates?: number;
  fallback?: boolean;
  errorMessage?: string;
  fallbackBound?: number;
  recoveredRelationshipCandidates?: number;
}

export interface ContextMapCandidateTypeLike {
  candidateType: ContextCandidateType;
}

export function buildExtractionTimingSummary(units: ContextMapExtractionUnitTiming[]): ContextMapExtractionTimingSummary {
  return {
    total: units.length,
    succeeded: units.filter((unit) => unit.status === 'succeeded').length,
    failed: units.filter((unit) => unit.status === 'failed').length,
    slowest: units
      .slice()
      .sort((a, b) => b.durationMs - a.durationMs || a.sourceId.localeCompare(b.sourceId))
      .slice(0, 20),
  };
}

export function buildContextMapRunTimings(opts: {
  totalMs: number;
  planningMs: number;
  sourceDiscoveryMs: number;
  extractionMs: number;
  synthesisMs: number;
  persistenceMs: number;
  autoApplyMs: number;
  extractionUnits: ContextMapExtractionTimingSummary;
  synthesisStages: ContextMapSynthesisStageMetadata[];
}): ContextMapRunTimings {
  return {
    totalMs: opts.totalMs,
    planningMs: opts.planningMs,
    sourceDiscoveryMs: opts.sourceDiscoveryMs,
    extractionMs: opts.extractionMs,
    synthesisMs: opts.synthesisMs,
    persistenceMs: opts.persistenceMs,
    autoApplyMs: opts.autoApplyMs,
    extractionUnits: opts.extractionUnits,
    synthesisStages: opts.synthesisStages,
  };
}

export function emptySynthesisMetadata(inputCandidates: number): ContextMapSynthesisMetadata {
  return {
    attempted: false,
    inputCandidates,
    outputCandidates: inputCandidates,
    droppedCandidates: 0,
    openQuestions: [],
  };
}

export function countDraftsByType(drafts: ContextMapCandidateTypeLike[]): Record<string, number> {
  return drafts.reduce<Record<string, number>>((acc, draft) => {
    acc[draft.candidateType] = (acc[draft.candidateType] || 0) + 1;
    return acc;
  }, {});
}

export function draftTypeCount(drafts: ContextMapCandidateTypeLike[], type: ContextCandidateType): number {
  return drafts.filter((draft) => draft.candidateType === type).length;
}

export function summarizeExtractionRepairs(repairs: ContextMapExtractionRepairEvent[]): Record<string, unknown> | undefined {
  if (repairs.length === 0) return undefined;
  return {
    attempted: repairs.length,
    succeeded: repairs.filter((repair) => repair.succeeded).length,
    failed: repairs.filter((repair) => !repair.succeeded).length,
    failures: repairs
      .filter((repair) => !repair.succeeded)
      .slice(0, 10)
      .map((repair) => ({
        sourceType: repair.sourceType,
        sourceId: repair.sourceId,
        errorMessage: repair.errorMessage,
      })),
  };
}

export function buildExtractionFailureMessage(failures: ContextMapExtractionFailure[]): string {
  const count = failures.length;
  const label = count === 1 ? 'unit' : 'units';
  const details = failures.slice(0, 3).map((failure) => (
    `${failure.sourceType}:${failure.sourceId} (${truncateErrorMessage(failure.errorMessage)})`
  )).join('; ');
  const suffix = count > 3 ? `; plus ${count - 3} more` : '';
  return details
    ? `${count} Context Map extraction ${label} failed: ${details}${suffix}`
    : `${count} Context Map extraction ${label} failed.`;
}

export function truncateErrorMessage(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim();
  return normalized.length <= 220 ? normalized : `${normalized.slice(0, 217)}...`;
}
