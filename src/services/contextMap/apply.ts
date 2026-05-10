import crypto from 'crypto';
import type {
  ContextCandidateRow,
  ContextEntityRow,
  ContextEntityStatus,
  ContextEvidenceTargetKind,
  ContextEvidenceSourceType,
  ContextMapDatabase,
  ContextRelationshipRow,
  ContextRelationshipStatus,
  ContextSensitivity,
} from './db';

export interface ContextMapApplyResult {
  candidate: ContextCandidateRow;
  applied: Array<{
    kind: 'entity_type' | 'entity' | 'relationship' | 'alias' | 'sensitivity' | 'evidence' | 'status';
    id: string;
    label?: string;
  }>;
  dependenciesApplied?: ContextMapApplyResult[];
}

export interface ContextMapApplyDependency {
  candidateId: string;
  role: 'subject' | 'object';
  name: string;
  typeSlug: string | null;
  summaryMarkdown: string | null;
}

export interface ContextMapApplyOptions {
  includeDependencies?: boolean;
  appliedBy?: 'user' | 'processor';
}

export class ContextMapApplyError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ContextMapApplyError';
    this.statusCode = statusCode;
  }
}

export class ContextMapApplyDependencyError extends ContextMapApplyError {
  readonly dependencies: ContextMapApplyDependency[];

  constructor(message: string, dependencies: ContextMapApplyDependency[]) {
    super(message, 409);
    this.name = 'ContextMapApplyDependencyError';
    this.dependencies = dependencies;
  }
}

const VALID_SENSITIVITY = new Set<ContextSensitivity>([
  'normal',
  'work-sensitive',
  'personal-sensitive',
  'secret-pointer',
]);
const VALID_STATUS = new Set<ContextEntityStatus>(['active', 'pending', 'discarded', 'superseded', 'stale', 'conflict']);
const VALID_EVIDENCE_TARGETS = new Set<ContextEvidenceTargetKind>(['entity', 'fact', 'relationship', 'candidate']);
const VALID_EVIDENCE_SOURCES = new Set<ContextEvidenceSourceType>([
  'conversation_message',
  'conversation_summary',
  'memory_entry',
  'kb_entry',
  'kb_topic',
  'file',
  'workspace_instruction',
  'git_commit',
  'github_issue',
  'github_pull_request',
  'external_connector',
]);

export function applyContextMapCandidate(
  db: ContextMapDatabase,
  candidate: ContextCandidateRow,
  now = new Date().toISOString(),
  options: ContextMapApplyOptions = {},
): ContextMapApplyResult {
  if (candidate.status === 'active') {
    return { candidate, applied: [] };
  }
  if (candidate.status !== 'pending') {
    throw new ContextMapApplyError(`Only pending Context Map candidates can be applied. Current status: ${candidate.status}`, 409);
  }

  const dependencies = collectApplyDependencies(db, candidate);
  if (dependencies.length > 0 && !options.includeDependencies) {
    throw new ContextMapApplyDependencyError(
      'This relationship depends on pending entity candidates. Confirm that those entity candidates should be applied first.',
      dependencies,
    );
  }

  return db.transaction(() => {
    const dependenciesApplied: ContextMapApplyResult[] = [];
    for (const dependency of dependencies) {
      const dependencyCandidate = db.getCandidate(dependency.candidateId);
      if (!dependencyCandidate) {
        throw new ContextMapApplyError(`Pending entity candidate was not found: ${dependency.candidateId}`, 404);
      }
      if (dependencyCandidate.status === 'active') continue;
      dependenciesApplied.push(applySingleContextMapCandidate(db, dependencyCandidate, now, options));
    }
    const result = applySingleContextMapCandidate(db, candidate, now, options);
    return dependenciesApplied.length > 0
      ? { ...result, dependenciesApplied }
      : result;
  });
}

export function getContextMapApplyDependencies(
  db: ContextMapDatabase,
  candidate: ContextCandidateRow,
): ContextMapApplyDependency[] {
  return collectApplyDependencies(db, candidate);
}

function applySingleContextMapCandidate(
  db: ContextMapDatabase,
  candidate: ContextCandidateRow,
  now: string,
  options: ContextMapApplyOptions = {},
): ContextMapApplyResult {
  if (candidate.status === 'active') {
    return { candidate, applied: [] };
  }
  if (candidate.status !== 'pending') {
    throw new ContextMapApplyError(`Only pending Context Map candidates can be applied. Current status: ${candidate.status}`, 409);
  }

  const applied: ContextMapApplyResult['applied'] = [];
  const payload = candidate.payload || {};
  const evidenceId = upsertCandidateEvidence(db, candidate, now);

  switch (candidate.candidateType) {
    case 'new_entity_type': {
      const typeSlug = normalizeSlug(readString(payload, ['typeSlug', 'slug', 'type']));
      if (!typeSlug) throw new ContextMapApplyError('Entity type candidates require payload.typeSlug.');
      const label = readString(payload, ['label', 'name']) || titleizeSlug(typeSlug);
      const row = db.upsertEntityType({
        typeSlug,
        label,
        description: readString(payload, ['description', 'summary']) || null,
        origin: 'processor',
        status: 'active',
        now,
      });
      applied.push({ kind: 'entity_type', id: row.typeSlug, label: row.label });
      break;
    }

    case 'new_entity': {
      const entity = applyNewEntity(db, candidate, evidenceId, now);
      applied.push({ kind: 'entity', id: entity.entityId, label: entity.name });
      break;
    }

    case 'entity_update': {
      const entity = applyEntityUpdate(db, candidate, evidenceId, now);
      applied.push({ kind: 'entity', id: entity.entityId, label: entity.name });
      break;
    }

    case 'entity_merge': {
      const merge = applyEntityMerge(db, candidate, evidenceId, now);
      applied.push({ kind: 'entity', id: merge.entityId, label: merge.name });
      break;
    }

    case 'alias_addition': {
      const alias = readString(payload, ['alias']);
      if (!alias) throw new ContextMapApplyError('Alias candidates require payload.alias.');
      const entity = resolveEntity(db, payload);
      db.addAlias(entity.entityId, alias, now);
      if (evidenceId) db.linkEvidence('entity', entity.entityId, evidenceId, now);
      applied.push({ kind: 'alias', id: `${entity.entityId}:${alias}`, label: alias });
      break;
    }

    case 'sensitivity_classification': {
      const sensitivity = normalizeSensitivity(readString(payload, ['sensitivity', 'classification']));
      if (!sensitivity) throw new ContextMapApplyError('Sensitivity candidates require a valid payload.sensitivity.');
      const entity = resolveEntity(db, payload);
      const updated = db.updateEntitySensitivity(entity.entityId, sensitivity, now);
      if (evidenceId) db.linkEvidence('entity', updated.entityId, evidenceId, now);
      applied.push({ kind: 'sensitivity', id: updated.entityId, label: sensitivity });
      break;
    }

    case 'new_relationship': {
      const relationship = applyNewRelationship(db, candidate, evidenceId, now);
      applied.push({ kind: 'relationship', id: relationship.relationshipId, label: relationship.predicate });
      break;
    }

    case 'relationship_update': {
      const relationship = applyRelationshipUpdate(db, candidate, evidenceId, now);
      applied.push({ kind: 'relationship', id: relationship.relationshipId, label: relationship.predicate });
      break;
    }

    case 'relationship_removal': {
      const relationship = applyRelationshipRemoval(db, candidate, evidenceId, now);
      applied.push({ kind: 'status', id: relationship.relationshipId, label: relationship.status });
      break;
    }

    case 'evidence_link': {
      const link = applyEvidenceLink(db, candidate, evidenceId, now);
      applied.push({ kind: 'evidence', id: link.targetId, label: link.targetKind });
      break;
    }

    case 'conflict_flag': {
      const flag = applyConflictFlag(db, candidate, evidenceId, now);
      applied.push({ kind: 'status', id: flag.targetId, label: 'conflict' });
      break;
    }

    default:
      throw new ContextMapApplyError(`Applying ${candidate.candidateType} candidates is not implemented yet.`);
  }

  const updatedCandidate = db.updateCandidateStatus(candidate.candidateId, 'active', now, { appliedAt: now });
  db.insertAuditEvent({
    eventId: `cm-audit-${crypto.randomUUID()}`,
    targetKind: 'candidate',
    targetId: candidate.candidateId,
    eventType: 'applied',
    details: {
      candidateType: candidate.candidateType,
      applied,
      appliedBy: options.appliedBy || 'user',
    },
    createdAt: now,
  });
  return { candidate: updatedCandidate, applied };
}

function collectApplyDependencies(
  db: ContextMapDatabase,
  candidate: ContextCandidateRow,
): ContextMapApplyDependency[] {
  if (candidate.candidateType !== 'new_relationship') return [];
  const payload = candidate.payload || {};
  const dependencies = new Map<string, ContextMapApplyDependency>();
  for (const role of ['subject', 'object'] as const) {
    const entityId = readString(payload, [`${role}EntityId`, `${role}Id`]);
    if (entityId) continue;
    const name = readString(payload, [`${role}Name`, `${role}EntityName`]);
    if (!name) continue;
    const typeSlug = normalizeSlug(readString(payload, [`${role}TypeSlug`, `${role}Type`]));
    if (findEntityByName(db, name, typeSlug || undefined)) continue;
    const pending = findPendingEntityCandidateByName(db, name, typeSlug || undefined);
    if (pending && !dependencies.has(pending.candidateId)) dependencies.set(pending.candidateId, {
      candidateId: pending.candidateId,
      role,
      name: readString(pending.payload, ['name', 'entityName', 'title']) || name,
      typeSlug: normalizeSlug(readString(pending.payload, ['typeSlug', 'type'])) || null,
      summaryMarkdown: readString(pending.payload, ['summaryMarkdown', 'summary']),
    });
  }
  return Array.from(dependencies.values());
}

function findPendingEntityCandidateByName(
  db: ContextMapDatabase,
  name: string,
  typeSlug?: string,
): ContextCandidateRow | null {
  const needle = name.trim().toLocaleLowerCase();
  const matches = db.listCandidates('pending').filter((candidate) => {
    if (candidate.candidateType !== 'new_entity') return false;
    const payload = candidate.payload || {};
    const candidateName = readString(payload, ['name', 'entityName', 'title']);
    if (!candidateName || candidateName.trim().toLocaleLowerCase() !== needle) return false;
    if (!typeSlug) return true;
    const candidateTypeSlug = normalizeSlug(readString(payload, ['typeSlug', 'type'])) || 'concept';
    return candidateTypeSlug === typeSlug;
  });
  if (matches.length > 1) {
    throw new ContextMapApplyError(
      `Multiple pending entity candidates match the relationship endpoint: ${name}. Apply the intended entity candidate first.`,
      409,
    );
  }
  return matches[0] || null;
}

function applyNewEntity(
  db: ContextMapDatabase,
  candidate: ContextCandidateRow,
  evidenceId: string | null,
  now: string,
): ContextEntityRow {
  const payload = candidate.payload || {};
  const name = readString(payload, ['name', 'entityName', 'title']);
  if (!name) throw new ContextMapApplyError('Entity candidates require payload.name.');
  const typeSlug = normalizeSlug(readString(payload, ['typeSlug', 'type'])) || 'concept';
  if (!db.getEntityType(typeSlug)) {
    db.upsertEntityType({
      typeSlug,
      label: titleizeSlug(typeSlug),
      origin: 'processor',
      status: 'active',
      now,
    });
  }

  const existing = findEntityByName(db, name, typeSlug);
  const entity = existing || db.insertEntity({
    entityId: stableId('cm-ent', [typeSlug, name.toLocaleLowerCase()]),
    typeSlug,
    name,
    summaryMarkdown: readString(payload, ['summaryMarkdown', 'summary']) || null,
    notesMarkdown: readString(payload, ['notesMarkdown', 'notes']) || null,
    sensitivity: normalizeSensitivity(readString(payload, ['sensitivity'])) || 'normal',
    confidence: candidate.confidence,
    now,
  });

  const aliases = readStringArray(payload.aliases);
  for (const alias of aliases) db.addAlias(entity.entityId, alias, now);
  const facts = readPayloadFacts(payload);
  for (const fact of facts) {
    const factId = stableId('cm-fact', [entity.entityId, fact]);
    if (!db.getFact(factId)) {
      db.insertFact({
        factId,
        entityId: entity.entityId,
        statementMarkdown: fact,
        confidence: candidate.confidence,
        now,
      });
    }
  }

  if (evidenceId) {
    db.linkEvidence('entity', entity.entityId, evidenceId, now);
    for (const fact of facts) db.linkEvidence('fact', stableId('cm-fact', [entity.entityId, fact]), evidenceId, now);
  }
  return entity;
}

function applyEntityUpdate(
  db: ContextMapDatabase,
  candidate: ContextCandidateRow,
  evidenceId: string | null,
  now: string,
): ContextEntityRow {
  const payload = candidate.payload || {};
  const entity = resolveEntity(db, payload);
  const typeSlug = normalizeSlug(readString(payload, ['newTypeSlug', 'updatedTypeSlug']));
  if (typeSlug && !db.getEntityType(typeSlug)) {
    db.upsertEntityType({
      typeSlug,
      label: titleizeSlug(typeSlug),
      origin: 'processor',
      status: 'active',
      now,
    });
  }
  const sensitivity = normalizeSensitivity(readString(payload, ['sensitivity']));
  const updated = db.updateEntity(entity.entityId, {
    typeSlug: typeSlug || undefined,
    name: readString(payload, ['newName', 'updatedName']) || undefined,
    summaryMarkdown: readString(payload, ['summaryMarkdown', 'summary']) ?? undefined,
    notesMarkdown: readString(payload, ['notesMarkdown', 'notes']) ?? undefined,
    sensitivity: sensitivity || undefined,
    confidence: candidate.confidence,
    updatedAt: now,
  });
  addEntityPayloadDetails(db, updated, payload, candidate.confidence, evidenceId, now);
  if (evidenceId) db.linkEvidence('entity', updated.entityId, evidenceId, now);
  return updated;
}

function applyEntityMerge(
  db: ContextMapDatabase,
  candidate: ContextCandidateRow,
  evidenceId: string | null,
  now: string,
): ContextEntityRow {
  const payload = candidate.payload || {};
  const target = resolveEntity(db, {
    entityId: readString(payload, ['targetEntityId', 'intoEntityId']),
    entityName: readString(payload, ['targetName', 'intoName']),
    typeSlug: readString(payload, ['targetTypeSlug', 'intoTypeSlug']),
  });
  const sources = resolveMergeSources(db, payload).filter((source) => source.entityId !== target.entityId);
  if (sources.length === 0) throw new ContextMapApplyError('Entity merge candidates require at least one source entity.');

  for (const source of sources) {
    db.updateEntity(source.entityId, { status: 'superseded', updatedAt: now });
    db.addAlias(target.entityId, source.name, now);
    for (const alias of db.listAliases(source.entityId)) db.addAlias(target.entityId, alias.alias, now);
    if (evidenceId) {
      db.linkEvidence('entity', source.entityId, evidenceId, now);
      db.linkEvidence('entity', target.entityId, evidenceId, now);
    }
  }
  addEntityPayloadDetails(db, target, payload, candidate.confidence, evidenceId, now);
  return target;
}

function applyNewRelationship(
  db: ContextMapDatabase,
  candidate: ContextCandidateRow,
  evidenceId: string | null,
  now: string,
): ContextRelationshipRow {
  const payload = candidate.payload || {};
  const subject = resolveEntity(db, payload, 'subject');
  const object = resolveEntity(db, payload, 'object');
  const predicate = readString(payload, ['predicate', 'relationship', 'label']);
  if (!predicate) throw new ContextMapApplyError('Relationship candidates require payload.predicate.');
  const qualifiers = isRecord(payload.qualifiers) ? payload.qualifiers : null;
  const existing = db.listRelationshipsForEntity(subject.entityId).find((relationship) => (
    relationship.subjectEntityId === subject.entityId
    && relationship.objectEntityId === object.entityId
    && relationship.predicate.toLocaleLowerCase() === predicate.toLocaleLowerCase()
    && stableStringify(relationship.qualifiers ?? null) === stableStringify(qualifiers)
  ));
  const relationship = existing || db.insertRelationship({
    relationshipId: stableId('cm-rel', [
      subject.entityId,
      predicate.toLocaleLowerCase(),
      object.entityId,
      stableStringify(qualifiers),
    ]),
    subjectEntityId: subject.entityId,
    predicate,
    objectEntityId: object.entityId,
    qualifiers,
    confidence: candidate.confidence,
    now,
  });
  if (evidenceId) db.linkEvidence('relationship', relationship.relationshipId, evidenceId, now);
  return relationship;
}

function applyRelationshipUpdate(
  db: ContextMapDatabase,
  candidate: ContextCandidateRow,
  evidenceId: string | null,
  now: string,
): ContextRelationshipRow {
  const payload = candidate.payload || {};
  const relationship = resolveRelationship(db, payload);
  const subject = resolveOptionalEntity(db, payload, 'newSubject');
  const object = resolveOptionalEntity(db, payload, 'newObject');
  const status = normalizeStatus(readString(payload, ['status'])) as ContextRelationshipStatus | null;
  const qualifiers = Object.prototype.hasOwnProperty.call(payload, 'qualifiers')
    ? isRecord(payload.qualifiers) ? payload.qualifiers : null
    : undefined;
  const updated = db.updateRelationship(relationship.relationshipId, {
    subjectEntityId: subject?.entityId,
    predicate: readString(payload, ['newPredicate', 'updatedPredicate', 'predicate']) || undefined,
    objectEntityId: object?.entityId,
    status: status || undefined,
    confidence: candidate.confidence,
    qualifiers,
    updatedAt: now,
  });
  if (evidenceId) db.linkEvidence('relationship', updated.relationshipId, evidenceId, now);
  return updated;
}

function applyRelationshipRemoval(
  db: ContextMapDatabase,
  candidate: ContextCandidateRow,
  evidenceId: string | null,
  now: string,
): ContextRelationshipRow {
  const payload = candidate.payload || {};
  const relationship = resolveRelationship(db, payload);
  const status = normalizeStatus(readString(payload, ['status'])) as ContextRelationshipStatus | null;
  const updated = db.updateRelationship(relationship.relationshipId, {
    status: status || 'superseded',
    updatedAt: now,
  });
  if (evidenceId) db.linkEvidence('relationship', updated.relationshipId, evidenceId, now);
  return updated;
}

function applyEvidenceLink(
  db: ContextMapDatabase,
  candidate: ContextCandidateRow,
  candidateEvidenceId: string | null,
  now: string,
): { targetKind: ContextEvidenceTargetKind; targetId: string } {
  const payload = candidate.payload || {};
  const targetKind = normalizeEvidenceTarget(readString(payload, ['targetKind', 'kind']));
  const targetId = readString(payload, ['targetId', 'entityId', 'factId', 'relationshipId', 'candidateId']);
  if (!targetKind || !targetId) throw new ContextMapApplyError('Evidence link candidates require targetKind and targetId.');
  const evidenceId = upsertPayloadEvidence(db, payload, now) || candidateEvidenceId;
  if (!evidenceId) throw new ContextMapApplyError('Evidence link candidates require evidence source details or source-span provenance.');
  db.linkEvidence(targetKind, targetId, evidenceId, now);
  return { targetKind, targetId };
}

function applyConflictFlag(
  db: ContextMapDatabase,
  candidate: ContextCandidateRow,
  evidenceId: string | null,
  now: string,
): { targetKind: 'entity' | 'relationship'; targetId: string } {
  const payload = candidate.payload || {};
  const explicitKind = readString(payload, ['targetKind', 'kind']);
  if (explicitKind === 'relationship' || readString(payload, ['relationshipId'])) {
    const relationship = resolveRelationship(db, payload);
    const updated = db.updateRelationship(relationship.relationshipId, { status: 'conflict', updatedAt: now });
    if (evidenceId) db.linkEvidence('relationship', updated.relationshipId, evidenceId, now);
    return { targetKind: 'relationship', targetId: updated.relationshipId };
  }
  const entity = resolveEntity(db, payload);
  const updated = db.updateEntity(entity.entityId, { status: 'conflict', updatedAt: now });
  if (evidenceId) db.linkEvidence('entity', updated.entityId, evidenceId, now);
  return { targetKind: 'entity', targetId: updated.entityId };
}

function resolveEntity(
  db: ContextMapDatabase,
  payload: Record<string, unknown>,
  prefix?: 'subject' | 'object',
): ContextEntityRow {
  const idKeys = prefix ? [`${prefix}EntityId`, `${prefix}Id`] : ['entityId', 'targetEntityId'];
  const nameKeys = prefix
    ? [`${prefix}Name`, `${prefix}EntityName`]
    : ['entityName', 'name', 'targetName'];
  const typeKeys = prefix ? [`${prefix}TypeSlug`, `${prefix}Type`] : ['typeSlug', 'entityType'];

  const entityId = readString(payload, idKeys);
  if (entityId) {
    const byId = db.getEntity(entityId);
    if (byId) return byId;
    throw new ContextMapApplyError(`Referenced entity was not found: ${entityId}`, 404);
  }

  const name = readString(payload, nameKeys);
  if (!name) throw new ContextMapApplyError('Candidate payload does not identify an entity.');
  const typeSlug = normalizeSlug(readString(payload, typeKeys));
  const entity = findEntityByName(db, name, typeSlug || undefined);
  if (!entity) throw new ContextMapApplyError(`Referenced entity was not found: ${name}`, 404);
  return entity;
}

function resolveOptionalEntity(
  db: ContextMapDatabase,
  payload: Record<string, unknown>,
  prefix: 'newSubject' | 'newObject',
): ContextEntityRow | null {
  const entityPayload = {
    entityId: readString(payload, [`${prefix}EntityId`, `${prefix}Id`]),
    entityName: readString(payload, [`${prefix}Name`, `${prefix}EntityName`]),
    typeSlug: readString(payload, [`${prefix}TypeSlug`, `${prefix}Type`]),
  };
  if (!entityPayload.entityId && !entityPayload.entityName) return null;
  return resolveEntity(db, entityPayload);
}

function resolveRelationship(
  db: ContextMapDatabase,
  payload: Record<string, unknown>,
): ContextRelationshipRow {
  const relationshipId = readString(payload, ['relationshipId', 'targetRelationshipId']);
  if (relationshipId) {
    const byId = db.getRelationship(relationshipId);
    if (byId) return byId;
    throw new ContextMapApplyError(`Referenced relationship was not found: ${relationshipId}`, 404);
  }

  const subject = resolveEntity(db, payload, 'subject');
  const object = resolveEntity(db, payload, 'object');
  const predicate = readString(payload, ['predicate', 'relationship', 'label']);
  if (!predicate) throw new ContextMapApplyError('Relationship candidates require payload.relationshipId or subject/object/predicate.');
  const qualifiers = isRecord(payload.qualifiers) ? payload.qualifiers : null;
  const relationship = db.listRelationshipsForEntity(subject.entityId).find((row) => (
    row.subjectEntityId === subject.entityId
    && row.objectEntityId === object.entityId
    && row.predicate.toLocaleLowerCase() === predicate.toLocaleLowerCase()
    && (!payload.qualifiers || stableStringify(row.qualifiers ?? null) === stableStringify(qualifiers))
  ));
  if (!relationship) throw new ContextMapApplyError(`Referenced relationship was not found: ${predicate}`, 404);
  return relationship;
}

function resolveMergeSources(db: ContextMapDatabase, payload: Record<string, unknown>): ContextEntityRow[] {
  const ids = readStringArray(
    payload.sourceEntityIds
    ?? payload.sourceIds
    ?? payload.fromEntityIds
    ?? payload.mergeEntityIds,
  );
  const names = readStringArray(payload.sourceNames ?? payload.fromNames ?? payload.mergeNames);
  const rows: ContextEntityRow[] = [];
  for (const id of ids) {
    const entity = db.getEntity(id);
    if (!entity) throw new ContextMapApplyError(`Referenced entity was not found: ${id}`, 404);
    rows.push(entity);
  }
  for (const name of names) rows.push(resolveEntity(db, { name }));
  return rows.filter((row, index) => rows.findIndex((other) => other.entityId === row.entityId) === index);
}

function findEntityByName(db: ContextMapDatabase, name: string, typeSlug?: string): ContextEntityRow | null {
  const needle = name.trim().toLocaleLowerCase();
  return db.listEntities({ status: 'active', ...(typeSlug ? { typeSlug } : {}) })
    .find((entity) => entity.name.trim().toLocaleLowerCase() === needle) || null;
}

function addEntityPayloadDetails(
  db: ContextMapDatabase,
  entity: ContextEntityRow,
  payload: Record<string, unknown>,
  confidence: number,
  evidenceId: string | null,
  now: string,
): void {
  const aliases = readStringArray(payload.aliases);
  for (const alias of aliases) db.addAlias(entity.entityId, alias, now);
  const facts = readPayloadFacts(payload);
  for (const fact of facts) {
    const factId = stableId('cm-fact', [entity.entityId, fact]);
    if (!db.getFact(factId)) {
      db.insertFact({
        factId,
        entityId: entity.entityId,
        statementMarkdown: fact,
        confidence,
        now,
      });
    }
    if (evidenceId) db.linkEvidence('fact', factId, evidenceId, now);
  }
}

function upsertCandidateEvidence(
  db: ContextMapDatabase,
  candidate: ContextCandidateRow,
  now: string,
): string | null {
  const sourceSpan = candidate.payload?.sourceSpan;
  if (!isRecord(sourceSpan)) return null;
  const sourceType = readString(sourceSpan, ['sourceType']) || 'conversation_message';
  if (!VALID_EVIDENCE_SOURCES.has(sourceType as ContextEvidenceSourceType)) return null;
  const sourceId = readString(sourceSpan, ['sourceId', 'conversationId', 'path', 'filename']);
  if (!sourceId) return null;
  const locator = isRecord(sourceSpan.locator)
    ? {
      ...sourceSpan.locator,
      runId: readString(sourceSpan, ['runId']) || candidate.runId || null,
      sourceHash: readString(sourceSpan, ['sourceHash']) || null,
    }
    : {
      spanId: readString(sourceSpan, ['spanId']) || null,
      runId: readString(sourceSpan, ['runId']) || candidate.runId || null,
      sessionEpoch: typeof sourceSpan.sessionEpoch === 'number' ? sourceSpan.sessionEpoch : null,
      startMessageId: readString(sourceSpan, ['startMessageId']) || null,
      endMessageId: readString(sourceSpan, ['endMessageId']) || null,
      sourceHash: readString(sourceSpan, ['sourceHash']) || null,
    };
  const evidenceId = stableId('cm-ev', [sourceType, sourceId, stableStringify(locator)]);
  db.upsertEvidenceRef({
    evidenceId,
    sourceType: sourceType as ContextEvidenceSourceType,
    sourceId,
    locator,
    now,
  });
  db.linkEvidence('candidate', candidate.candidateId, evidenceId, now);
  return evidenceId;
}

function upsertPayloadEvidence(
  db: ContextMapDatabase,
  payload: Record<string, unknown>,
  now: string,
): string | null {
  const evidence = isRecord(payload.evidence) ? payload.evidence : payload;
  const sourceType = readString(evidence, ['sourceType']);
  const sourceId = readString(evidence, ['sourceId']);
  if (!sourceType || !sourceId || !VALID_EVIDENCE_SOURCES.has(sourceType as ContextEvidenceSourceType)) return null;
  const locator = isRecord(evidence.locator) ? evidence.locator : null;
  const evidenceId = readString(evidence, ['evidenceId']) || stableId('cm-ev', [sourceType, sourceId, stableStringify(locator)]);
  db.upsertEvidenceRef({
    evidenceId,
    sourceType: sourceType as ContextEvidenceSourceType,
    sourceId,
    locator,
    excerpt: readString(evidence, ['excerpt']) || null,
    now,
  });
  return evidenceId;
}

function normalizeSensitivity(value: string | null): ContextSensitivity | null {
  return value && VALID_SENSITIVITY.has(value as ContextSensitivity)
    ? value as ContextSensitivity
    : null;
}

function normalizeStatus(value: string | null): ContextEntityStatus | null {
  return value && VALID_STATUS.has(value as ContextEntityStatus)
    ? value as ContextEntityStatus
    : null;
}

function normalizeEvidenceTarget(value: string | null): ContextEvidenceTargetKind | null {
  return value && VALID_EVIDENCE_TARGETS.has(value as ContextEvidenceTargetKind)
    ? value as ContextEvidenceTargetKind
    : null;
}

function normalizeSlug(value: string | null): string {
  return (value || '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function titleizeSlug(slug: string): string {
  return slug.split('-').filter(Boolean).map((part) => (
    part.charAt(0).toLocaleUpperCase() + part.slice(1)
  )).join(' ') || 'Concept';
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function readStringArray(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

const FACT_PAYLOAD_KEYS = [
  'facts',
  'factsMarkdown',
  'factMarkdown',
  'keyFacts',
  'durableFacts',
  'factStatements',
];

function readPayloadFacts(payload: Record<string, unknown>): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();
  for (const key of FACT_PAYLOAD_KEYS) {
    for (const fact of readFactField(payload[key])) {
      const normalized = fact.toLocaleLowerCase();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      facts.push(fact);
    }
  }
  return facts;
}

function readFactField(value: unknown): string[] {
  if (typeof value === 'string') {
    const lines = value.split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
      .filter(Boolean);
    return lines.length > 1 ? readFactArray(lines) : readFactArray(value);
  }
  return readFactArray(value);
}

function readFactArray(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.replace(/\s+/g, ' ').trim()];
  if (!Array.isArray(value)) return [];
  const facts: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const fact = readFactString(item);
    const key = fact.toLocaleLowerCase();
    if (!fact || seen.has(key)) continue;
    seen.add(key);
    facts.push(fact.length <= 1_000 ? fact : `${fact.slice(0, 997)}...`);
  }
  return facts;
}

function readFactString(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (!isRecord(value)) return '';
  for (const key of ['markdown', 'statementMarkdown', 'text', 'value', 'content', 'summaryMarkdown', 'description']) {
    const item = value[key];
    if (typeof item === 'string' && item.trim()) return item.replace(/\s+/g, ' ').trim();
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stableId(prefix: string, parts: string[]): string {
  return `${prefix}-${sha256(parts.join('\0')).slice(0, 32)}`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(',')}}`;
}
