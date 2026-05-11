import type {
  ContextCandidateType,
  ContextEntityRow,
  ContextMapDatabase,
  ContextSensitivity,
} from './db';
import { applyContextMapCandidate, ContextMapApplyError, getContextMapApplyDependencies } from './apply';
import {
  CONTEXT_MAP_BUILT_IN_ENTITY_TYPES,
  CONTEXT_MAP_TYPE_ALIASES,
  hasRelationshipEvidence,
  isSelfRelationshipPayload,
  normalizeAliasArray,
  normalizeCandidateFacts,
  normalizeCandidateSensitivity,
  normalizedCandidateText,
  normalizeRelationshipPredicate,
  normalizeSlug,
  readPayloadString,
} from './candidatePrimitives';

export interface ContextMapAutoApplyResult {
  applied: number;
  failures: Array<{ candidateId: string; candidateType: ContextCandidateType; errorMessage: string }>;
}

const CONTEXT_MAP_AUTO_APPLY_MIN_CONFIDENCE_BY_TYPE: Partial<Record<ContextCandidateType, number>> = {
  new_entity: 0.8,
  entity_update: 0.9,
  new_relationship: 0.8,
  alias_addition: 0.94,
  evidence_link: 0.96,
  sensitivity_classification: 0.96,
};

const CONTEXT_MAP_AUTO_APPLY_TYPE_ORDER: Partial<Record<ContextCandidateType, number>> = {
  new_entity: 10,
  entity_update: 15,
  alias_addition: 20,
  sensitivity_classification: 20,
  evidence_link: 25,
  new_relationship: 30,
};

export function autoApplyContextMapCandidates(
  db: ContextMapDatabase,
  candidateIds: string[],
  now: string,
): ContextMapAutoApplyResult {
  const failures: ContextMapAutoApplyResult['failures'] = [];
  let applied = 0;
  const candidates = candidateIds
    .map((candidateId) => db.getCandidate(candidateId))
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .sort((a, b) => (
      (CONTEXT_MAP_AUTO_APPLY_TYPE_ORDER[a.candidateType] ?? 100)
      - (CONTEXT_MAP_AUTO_APPLY_TYPE_ORDER[b.candidateType] ?? 100)
      || b.confidence - a.confidence
      || a.candidateId.localeCompare(b.candidateId)
    ));

  for (const candidate of candidates) {
    if (!shouldAutoApplyContextMapCandidate(candidate, db)) continue;
    try {
      const result = applyContextMapCandidate(db, candidate, now, { appliedBy: 'processor' });
      if (result.candidate.status === 'active') applied += 1;
    } catch (err: unknown) {
      if (err instanceof ContextMapApplyError) {
        failures.push({
          candidateId: candidate.candidateId,
          candidateType: candidate.candidateType,
          errorMessage: err.message,
        });
        continue;
      }
      throw err;
    }
  }

  return { applied, failures };
}

function shouldAutoApplyContextMapCandidate(
  candidate: NonNullable<ReturnType<ContextMapDatabase['getCandidate']>>,
  db: ContextMapDatabase,
): boolean {
  if (candidate.status !== 'pending') return false;
  const minConfidence = CONTEXT_MAP_AUTO_APPLY_MIN_CONFIDENCE_BY_TYPE[candidate.candidateType];
  if (minConfidence === undefined || candidate.confidence < minConfidence) return false;
  const payload = candidate.payload || {};
  if (!payload.sourceSpan || typeof payload.sourceSpan !== 'object') return false;

  if (candidate.candidateType === 'new_entity') {
    const sensitivity = normalizeCandidateSensitivity(readPayloadString(payload, ['sensitivity']));
    return sensitivity !== 'secret-pointer'
      && isAutoApplyEntityTypeKnown(db, payload)
      && hasDurableEntityBody(payload);
  }
  if (candidate.candidateType === 'entity_update') {
    return shouldAutoApplyAdditiveEntityUpdate(candidate, db);
  }
  if (candidate.candidateType === 'new_relationship') {
    const predicate = normalizeRelationshipPredicate(readPayloadString(payload, ['predicate', 'relationship', 'label']));
    return Boolean(
      predicate
      && predicate !== 'relates_to'
      && hasRelationshipEvidence(payload)
      && !isSelfRelationshipPayload(payload)
      && hasNoAutoApplyRelationshipDependencies(candidate, db),
    );
  }
  if (candidate.candidateType === 'sensitivity_classification') {
    return shouldAutoApplySensitivityClassification(db, payload);
  }
  return true;
}

function shouldAutoApplySensitivityClassification(
  db: ContextMapDatabase,
  payload: Record<string, unknown>,
): boolean {
  const entity = resolveAutoApplyEntityUpdateTarget(db, payload);
  if (!entity) return false;
  const proposed = normalizeCandidateSensitivity(readPayloadString(payload, ['sensitivity', 'classification'])) as ContextSensitivity | '';
  if (!proposed || proposed === entity.sensitivity) return false;
  return sensitivityRank(proposed) > sensitivityRank(entity.sensitivity);
}

function sensitivityRank(sensitivity: ContextSensitivity): number {
  if (sensitivity === 'secret-pointer') return 3;
  if (sensitivity === 'work-sensitive' || sensitivity === 'personal-sensitive') return 2;
  return 1;
}

function shouldAutoApplyAdditiveEntityUpdate(
  candidate: NonNullable<ReturnType<ContextMapDatabase['getCandidate']>>,
  db: ContextMapDatabase,
): boolean {
  const payload = candidate.payload || {};
  const entity = resolveAutoApplyEntityUpdateTarget(db, payload);
  if (!entity) return false;

  if (readPayloadString(payload, ['newName', 'updatedName'])) return false;
  if (readPayloadString(payload, ['newTypeSlug', 'updatedTypeSlug'])) return false;
  if (readPayloadString(payload, ['status'])) return false;

  const sensitivity = normalizeCandidateSensitivity(readPayloadString(payload, ['sensitivity', 'classification']));
  if (sensitivity && sensitivity !== entity.sensitivity) return false;

  const summary = readPayloadString(payload, ['summaryMarkdown', 'summary']);
  if (summary && entity.summaryMarkdown && normalizedCandidateText(summary) !== normalizedCandidateText(entity.summaryMarkdown)) {
    return false;
  }
  const notes = readPayloadString(payload, ['notesMarkdown', 'notes']);
  if (notes && entity.notesMarkdown && normalizedCandidateText(notes) !== normalizedCandidateText(entity.notesMarkdown)) {
    return false;
  }

  return Boolean(
    normalizeCandidateFacts(payload).length > 0
    || normalizeAliasArray(payload.aliases).length > 0
    || (summary && !entity.summaryMarkdown)
    || (notes && !entity.notesMarkdown)
  );
}

function resolveAutoApplyEntityUpdateTarget(
  db: ContextMapDatabase,
  payload: Record<string, unknown>,
): ContextEntityRow | null {
  const entityId = readPayloadString(payload, ['entityId', 'targetEntityId']);
  if (entityId) {
    const entity = db.getEntity(entityId);
    return entity && entity.status === 'active' ? entity : null;
  }

  const name = readPayloadString(payload, ['entityName', 'name', 'targetName']);
  if (!name) return null;
  const typeSlug = normalizeSlug(readPayloadString(payload, ['typeSlug', 'entityType', 'type']));
  const matches = db.listEntities({ status: 'active', ...(typeSlug ? { typeSlug } : {}) })
    .filter((entity) => normalizedCandidateText(entity.name) === normalizedCandidateText(name));
  return matches.length === 1 ? matches[0] : null;
}

function hasNoAutoApplyRelationshipDependencies(
  candidate: NonNullable<ReturnType<ContextMapDatabase['getCandidate']>>,
  db: ContextMapDatabase,
): boolean {
  try {
    return getContextMapApplyDependencies(db, candidate).length === 0;
  } catch (err: unknown) {
    if (err instanceof ContextMapApplyError) return false;
    throw err;
  }
}

function isAutoApplyEntityTypeKnown(db: ContextMapDatabase, payload: Record<string, unknown>): boolean {
  const typeSlug = normalizeSlug(readPayloadString(payload, ['typeSlug', 'entityType', 'type'])) || 'concept';
  const aliased = CONTEXT_MAP_TYPE_ALIASES.get(typeSlug) || typeSlug;
  return CONTEXT_MAP_BUILT_IN_ENTITY_TYPES.has(aliased) || Boolean(db.getEntityType(aliased));
}

function hasDurableEntityBody(payload: Record<string, unknown>): boolean {
  return Boolean(
    readPayloadString(payload, ['summaryMarkdown', 'summary', 'notesMarkdown', 'notes', 'description'])
    || normalizeCandidateFacts(payload).length > 0,
  );
}
