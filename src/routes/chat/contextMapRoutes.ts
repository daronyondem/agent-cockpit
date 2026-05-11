import express from 'express';
import crypto from 'crypto';
import { csrfGuard } from '../../middleware/csrf';
import type { ChatService } from '../../services/chatService';
import { applyContextMapCandidate, ContextMapApplyDependencyError, ContextMapApplyError } from '../../services/contextMap/apply';
import type { ContextMapService } from '../../services/contextMap/service';
import type {
  ContextAuditEventRow,
  ContextCandidateStatus,
  ContextEntityFactRow,
  ContextEntityRow,
  ContextEntityStatus,
  ContextEvidenceRefRow,
  ContextRelationshipRow,
  ContextSensitivity,
} from '../../services/contextMap/db';
import {
  validateContextMapCandidateApplyRequest,
  validateContextMapCandidateUpdateRequest,
  validateContextMapEnabledRequest,
  validateContextMapSettingsRequest,
} from '../../contracts/contextMap';
import { isContractValidationError } from '../../contracts/validation';
import type { Request, Response } from '../../types';
import { logger } from '../../utils/logger';
import { param, queryStrings } from './routeUtils';

const log = logger.child({ module: 'context-map-routes' });

const CONTEXT_MAP_CANDIDATE_STATUSES = new Set<ContextCandidateStatus>([
  'pending',
  'active',
  'discarded',
  'superseded',
  'stale',
  'conflict',
  'failed',
]);
const CONTEXT_MAP_DISCARDABLE_CANDIDATE_STATUSES = new Set<ContextCandidateStatus>([
  'pending',
  'stale',
  'conflict',
  'failed',
]);
const CONTEXT_MAP_ENTITY_STATUSES = new Set<ContextEntityStatus>([
  'active',
  'pending',
  'discarded',
  'superseded',
  'stale',
  'conflict',
]);
const CONTEXT_MAP_SENSITIVITIES = new Set<ContextSensitivity>([
  'normal',
  'work-sensitive',
  'personal-sensitive',
  'secret-pointer',
]);

const CONTEXT_MAP_GRAPH_DEFAULT_LIMIT = 50;
const CONTEXT_MAP_GRAPH_MAX_LIMIT = 200;

export interface ContextMapRoutesOptions {
  chatService: ChatService;
  contextMapService: ContextMapService;
  emitFreshContextMapUpdate: (hash: string) => Promise<void>;
}

function contextMapBoundedLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(1, Math.min(max, parsed));
}

function contextMapSecret(entity: ContextEntityRow): boolean {
  return entity.sensitivity === 'secret-pointer';
}

function contextMapEntityMatches(entity: ContextEntityRow, aliases: string[], facts: string[], query: string): boolean {
  if (!query) return true;
  const q = query.toLocaleLowerCase();
  const canReadDetails = !contextMapSecret(entity);
  return entity.name.toLocaleLowerCase().includes(q)
    || aliases.some((alias) => alias.toLocaleLowerCase().includes(q))
    || (canReadDetails && !!entity.summaryMarkdown && entity.summaryMarkdown.toLocaleLowerCase().includes(q))
    || (canReadDetails && !!entity.notesMarkdown && entity.notesMarkdown.toLocaleLowerCase().includes(q))
    || facts.some((fact) => fact.toLocaleLowerCase().includes(q));
}

function contextMapRelationshipKey(relationship: ContextRelationshipRow): string {
  return relationship.relationshipId;
}

function contextMapEvidenceRefForApi(ref: ContextEvidenceRefRow): Record<string, unknown> {
  return {
    evidenceId: ref.evidenceId,
    sourceType: ref.sourceType,
    sourceId: ref.sourceId,
    locator: ref.locator,
    excerpt: ref.excerpt,
    createdAt: ref.createdAt,
  };
}

function contextMapAuditEventForApi(
  event: ContextAuditEventRow,
  opts: { redactDetails?: boolean } = {},
): Record<string, unknown> {
  return {
    eventId: event.eventId,
    targetKind: event.targetKind,
    targetId: event.targetId,
    eventType: event.eventType,
    details: opts.redactDetails ? null : event.details,
    createdAt: event.createdAt,
  };
}

function contextMapFactForApi(db: { listEvidenceForTarget: (kind: 'fact', id: string) => ContextEvidenceRefRow[] }, fact: ContextEntityFactRow, includeEvidence: boolean): Record<string, unknown> {
  return {
    factId: fact.factId,
    statementMarkdown: fact.statementMarkdown,
    status: fact.status,
    confidence: fact.confidence,
    updatedAt: fact.updatedAt,
    evidence: includeEvidence ? db.listEvidenceForTarget('fact', fact.factId).map(contextMapEvidenceRefForApi) : [],
  };
}

export function createContextMapRouter(opts: ContextMapRoutesOptions): express.Router {
  const { chatService, contextMapService, emitFreshContextMapUpdate } = opts;
  const router = express.Router();

  router.get('/workspaces/:hash/context-map/settings', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const settings = await chatService.getWorkspaceContextMapSettings(hash);
      if (settings === null) return res.status(404).json({ error: 'Workspace not found' });
      const enabled = await chatService.getWorkspaceContextMapEnabled(hash);
      res.json({ enabled, settings });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/context-map/scan', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const workspaceSettings = await chatService.getWorkspaceContextMapSettings(hash);
      if (workspaceSettings === null) return res.status(404).json({ error: 'Workspace not found' });
      if (!(await chatService.getWorkspaceContextMapEnabled(hash))) {
        return res.status(403).json({ error: 'Context Map is disabled' });
      }
      if (contextMapService.isRunning(hash)) {
        return res.status(409).json({ error: 'Context Map scan already running' });
      }
      void contextMapService.processWorkspace(hash, { source: 'manual_rebuild' }).then((result) => {
        if (result.runId && result.stopped) {
          log.info('Context Map manual scan stopped', { workspace: hash, runId: result.runId });
        } else if (result.runId) {
          log.info('Context Map manual scan completed', { workspace: hash, runId: result.runId });
        }
      }).catch((err: unknown) => {
        log.warn('Context Map manual scan failed', { workspace: hash, error: err });
      });
      res.json({ ok: true, started: true, source: 'manual_rebuild' });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/context-map/scan/stop', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const workspaceSettings = await chatService.getWorkspaceContextMapSettings(hash);
      if (workspaceSettings === null) return res.status(404).json({ error: 'Workspace not found' });
      const stopped = await contextMapService.stopWorkspace(hash);
      if (!stopped) return res.status(409).json({ error: 'No Context Map scan is running' });
      res.json({ ok: true, stopped: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/workspaces/:hash/context-map', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const workspaceSettings = await chatService.getWorkspaceContextMapSettings(hash);
      if (workspaceSettings === null) return res.status(404).json({ error: 'Workspace not found' });
      if (contextMapService.isRunning(hash)) {
        return res.status(409).json({ error: 'Context Map scan is running. Stop the scan before clearing the map.' });
      }
      const db = chatService.getContextMapDb(hash);
      if (!db) return res.status(404).json({ error: 'Workspace not found' });
      const deleted = db.clearAll();
      await emitFreshContextMapUpdate(hash);
      res.json({ ok: true, deleted });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:hash/context-map/graph', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const workspaceSettings = await chatService.getWorkspaceContextMapSettings(hash);
      if (workspaceSettings === null) return res.status(404).json({ error: 'Workspace not found' });
      const enabled = await chatService.getWorkspaceContextMapEnabled(hash);
      const rawQuery = typeof req.query.query === 'string' ? req.query.query.trim() : '';
      const types = new Set(queryStrings(req.query.type ?? req.query.types));
      const statusFilters = new Set(queryStrings(req.query.status ?? req.query.statuses));
      const includeAllStatuses = statusFilters.has('all');
      statusFilters.delete('all');
      for (const status of statusFilters) {
        if (!CONTEXT_MAP_ENTITY_STATUSES.has(status as ContextEntityStatus)) {
          return res.status(400).json({ error: 'Invalid entity status' });
        }
      }
      const sensitivityFilters = new Set(queryStrings(req.query.sensitivity ?? req.query.sensitivities));
      for (const sensitivity of sensitivityFilters) {
        if (!CONTEXT_MAP_SENSITIVITIES.has(sensitivity as ContextSensitivity)) {
          return res.status(400).json({ error: 'Invalid sensitivity' });
        }
      }
      const limit = contextMapBoundedLimit(req.query.limit, CONTEXT_MAP_GRAPH_DEFAULT_LIMIT, CONTEXT_MAP_GRAPH_MAX_LIMIT);
      if (!enabled) {
        return res.json({
          enabled,
          query: rawQuery,
          types: Array.from(types),
          statuses: includeAllStatuses ? ['all'] : Array.from(statusFilters),
          sensitivities: Array.from(sensitivityFilters),
          counts: { entities: 0, relationships: 0 },
          entities: [],
          relationships: [],
        });
      }
      const db = chatService.getContextMapDb(hash);
      if (!db) return res.status(404).json({ error: 'Workspace not found' });
      const allScopedEntities = db.listEntities().filter((entity) => {
        const statusMatches = includeAllStatuses
          || (statusFilters.size > 0 ? statusFilters.has(entity.status) : entity.status === 'active');
        if (!statusMatches) return false;
        return sensitivityFilters.size === 0 || sensitivityFilters.has(entity.sensitivity);
      });
      const activeIds = new Set(allScopedEntities.map((entity) => entity.entityId));
      const allRelationshipMap = new Map<string, ContextRelationshipRow>();
      for (const entity of allScopedEntities) {
        for (const relationship of db.listRelationshipsForEntity(entity.entityId)) {
          if (relationship.status !== 'active') continue;
          if (!activeIds.has(relationship.subjectEntityId) || !activeIds.has(relationship.objectEntityId)) continue;
          allRelationshipMap.set(contextMapRelationshipKey(relationship), relationship);
        }
      }

      const enriched = allScopedEntities.map((entity) => {
        const aliases = db.listAliases(entity.entityId).map((alias) => alias.alias);
        const facts = contextMapSecret(entity)
          ? []
          : db.listFacts(entity.entityId)
            .filter((fact) => fact.status === 'active')
            .map((fact) => fact.statementMarkdown);
        const relationships = db.listRelationshipsForEntity(entity.entityId)
          .filter((relationship) => relationship.status === 'active'
            && activeIds.has(relationship.subjectEntityId)
            && activeIds.has(relationship.objectEntityId));
        return { entity, aliases, facts, relationships };
      }).filter((entry) => {
        if (types.size > 0 && !types.has(entry.entity.typeSlug)) return false;
        return contextMapEntityMatches(entry.entity, entry.aliases, entry.facts, rawQuery);
      });

      const entities = enriched.slice(0, limit).map((entry) => ({
        entityId: entry.entity.entityId,
        typeSlug: entry.entity.typeSlug,
        name: entry.entity.name,
        status: entry.entity.status,
        summaryMarkdown: contextMapSecret(entry.entity) ? null : entry.entity.summaryMarkdown,
        notesMarkdown: contextMapSecret(entry.entity) ? null : entry.entity.notesMarkdown,
        sensitivity: entry.entity.sensitivity,
        confidence: entry.entity.confidence,
        aliases: entry.aliases,
        facts: entry.facts.slice(0, 3),
        factCount: entry.facts.length,
        relationshipCount: entry.relationships.length,
        evidenceCount: contextMapSecret(entry.entity) ? 0 : db.listEvidenceForTarget('entity', entry.entity.entityId).length,
        updatedAt: entry.entity.updatedAt,
      }));

      const returnedIds = new Set(entities.map((entity) => entity.entityId));
      const relationshipMap = new Map<string, ContextRelationshipRow>();
      for (const entity of enriched) {
        if (!returnedIds.has(entity.entity.entityId)) continue;
        for (const relationship of entity.relationships) {
          relationshipMap.set(contextMapRelationshipKey(relationship), relationship);
        }
      }
      const relationships = Array.from(relationshipMap.values()).map((relationship) => ({
        relationshipId: relationship.relationshipId,
        subjectEntityId: relationship.subjectEntityId,
        subjectName: db.getEntity(relationship.subjectEntityId)?.name || relationship.subjectEntityId,
        predicate: relationship.predicate,
        objectEntityId: relationship.objectEntityId,
        objectName: db.getEntity(relationship.objectEntityId)?.name || relationship.objectEntityId,
        confidence: relationship.confidence,
        qualifiers: relationship.qualifiers,
      }));

      res.json({
        enabled,
        query: rawQuery,
        types: Array.from(types),
        statuses: includeAllStatuses ? ['all'] : Array.from(statusFilters),
        sensitivities: Array.from(sensitivityFilters),
        counts: { entities: allScopedEntities.length, relationships: allRelationshipMap.size },
        entities,
        relationships,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:hash/context-map/entities/:entityId', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const workspaceSettings = await chatService.getWorkspaceContextMapSettings(hash);
      if (workspaceSettings === null) return res.status(404).json({ error: 'Workspace not found' });
      if (!(await chatService.getWorkspaceContextMapEnabled(hash))) {
        return res.status(403).json({ error: 'Context Map is disabled' });
      }
      const db = chatService.getContextMapDb(hash);
      if (!db) return res.status(404).json({ error: 'Workspace not found' });
      const entityId = param(req, 'entityId');
      const entity = db.getEntity(entityId);
      if (!entity) return res.status(404).json({ error: 'Entity not found' });
      const secret = contextMapSecret(entity);
      const relationships = db.listRelationshipsForEntity(entity.entityId).map((relationship) => ({
        relationshipId: relationship.relationshipId,
        subjectEntityId: relationship.subjectEntityId,
        subjectName: db.getEntity(relationship.subjectEntityId)?.name || relationship.subjectEntityId,
        predicate: relationship.predicate,
        objectEntityId: relationship.objectEntityId,
        objectName: db.getEntity(relationship.objectEntityId)?.name || relationship.objectEntityId,
        status: relationship.status,
        confidence: relationship.confidence,
        qualifiers: relationship.qualifiers,
        evidence: secret ? [] : db.listEvidenceForTarget('relationship', relationship.relationshipId).map(contextMapEvidenceRefForApi),
      }));
      res.json({
        enabled: true,
        entity: {
          entityId: entity.entityId,
          typeSlug: entity.typeSlug,
          name: entity.name,
          status: entity.status,
          summaryMarkdown: secret ? null : entity.summaryMarkdown,
          notesMarkdown: secret ? null : entity.notesMarkdown,
          sensitivity: entity.sensitivity,
          confidence: entity.confidence,
          createdAt: entity.createdAt,
          updatedAt: entity.updatedAt,
          aliases: db.listAliases(entity.entityId).map((alias) => alias.alias),
          facts: secret ? [] : db.listFacts(entity.entityId).map((fact) => contextMapFactForApi(db, fact, true)),
          relationships,
          evidence: secret ? [] : db.listEvidenceForTarget('entity', entity.entityId).map(contextMapEvidenceRefForApi),
          audit: db.listAuditEvents('entity', entity.entityId)
            .map((event) => contextMapAuditEventForApi(event, { redactDetails: secret })),
        },
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:hash/context-map/entities/:entityId', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const workspaceSettings = await chatService.getWorkspaceContextMapSettings(hash);
      if (workspaceSettings === null) return res.status(404).json({ error: 'Workspace not found' });
      if (!(await chatService.getWorkspaceContextMapEnabled(hash))) {
        return res.status(403).json({ error: 'Context Map is disabled' });
      }
      const db = chatService.getContextMapDb(hash);
      if (!db) return res.status(404).json({ error: 'Workspace not found' });
      const entityId = param(req, 'entityId');
      const existing = db.getEntity(entityId);
      if (!existing) return res.status(404).json({ error: 'Entity not found' });

      const body = (req.body || {}) as { entity?: unknown };
      const input = Object.prototype.hasOwnProperty.call(body, 'entity') ? body.entity : req.body;
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return res.status(400).json({ error: 'entity must be an object' });
      }
      const raw = input as Record<string, unknown>;
      const patch: {
        typeSlug?: string;
        name?: string;
        status?: ContextEntityStatus;
        summaryMarkdown?: string | null;
        notesMarkdown?: string | null;
        sensitivity?: ContextSensitivity;
        confidence?: number;
        updatedAt: string;
      } = { updatedAt: new Date().toISOString() };

      if (Object.prototype.hasOwnProperty.call(raw, 'name')) {
        if (typeof raw.name !== 'string' || !raw.name.trim()) {
          return res.status(400).json({ error: 'name must be a non-empty string' });
        }
        patch.name = raw.name.trim();
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'typeSlug')) {
        if (typeof raw.typeSlug !== 'string' || !raw.typeSlug.trim()) {
          return res.status(400).json({ error: 'typeSlug must be a non-empty string' });
        }
        const typeSlug = raw.typeSlug.trim();
        if (!db.listEntityTypes().some((type) => type.typeSlug === typeSlug)) {
          return res.status(400).json({ error: 'typeSlug must reference an existing entity type' });
        }
        patch.typeSlug = typeSlug;
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'status')) {
        if (typeof raw.status !== 'string' || !CONTEXT_MAP_ENTITY_STATUSES.has(raw.status as ContextEntityStatus)) {
          return res.status(400).json({ error: 'Invalid entity status' });
        }
        patch.status = raw.status as ContextEntityStatus;
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'sensitivity')) {
        if (typeof raw.sensitivity !== 'string' || !CONTEXT_MAP_SENSITIVITIES.has(raw.sensitivity as ContextSensitivity)) {
          return res.status(400).json({ error: 'Invalid sensitivity' });
        }
        patch.sensitivity = raw.sensitivity as ContextSensitivity;
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'summaryMarkdown')) {
        if (raw.summaryMarkdown !== null && typeof raw.summaryMarkdown !== 'string') {
          return res.status(400).json({ error: 'summaryMarkdown must be a string or null' });
        }
        patch.summaryMarkdown = raw.summaryMarkdown === null ? null : raw.summaryMarkdown.trim();
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'notesMarkdown')) {
        if (raw.notesMarkdown !== null && typeof raw.notesMarkdown !== 'string') {
          return res.status(400).json({ error: 'notesMarkdown must be a string or null' });
        }
        patch.notesMarkdown = raw.notesMarkdown === null ? null : raw.notesMarkdown.trim();
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'confidence')) {
        if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence)) {
          return res.status(400).json({ error: 'confidence must be a number' });
        }
        patch.confidence = Math.max(0, Math.min(1, raw.confidence));
      }

      const entity = db.transaction(() => {
        const updated = db.updateEntity(entityId, patch);
        db.insertAuditEvent({
          eventId: `cm-audit-${crypto.randomUUID()}`,
          targetKind: 'entity',
          targetId: entityId,
          eventType: 'edited',
          details: {
            previous: {
              typeSlug: existing.typeSlug,
              name: existing.name,
              status: existing.status,
              summaryMarkdown: existing.summaryMarkdown,
              notesMarkdown: existing.notesMarkdown,
              sensitivity: existing.sensitivity,
              confidence: existing.confidence,
            },
          },
          createdAt: patch.updatedAt,
        });
        return updated;
      });
      await emitFreshContextMapUpdate(hash);
      res.json({ ok: true, entity });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:hash/context-map/review', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const workspaceSettings = await chatService.getWorkspaceContextMapSettings(hash);
      if (workspaceSettings === null) return res.status(404).json({ error: 'Workspace not found' });
      const enabled = await chatService.getWorkspaceContextMapEnabled(hash);
      const statusParam = typeof req.query.status === 'string' ? req.query.status.trim() : '';
      const status = statusParam || 'pending';
      if (status !== 'all' && !CONTEXT_MAP_CANDIDATE_STATUSES.has(status as ContextCandidateStatus)) {
        return res.status(400).json({ error: 'Invalid candidate status' });
      }
      if (!enabled) {
        return res.json({ enabled, status, candidates: [], counts: {}, runs: [] });
      }
      const db = chatService.getContextMapDb(hash);
      if (!db) return res.status(404).json({ error: 'Workspace not found' });
      const allCandidates = db.listCandidates();
      const candidates = status === 'all'
        ? allCandidates
        : allCandidates.filter((candidate) => candidate.status === status);
      const counts = allCandidates.reduce((acc, candidate) => {
        acc[candidate.status] = (acc[candidate.status] || 0) + 1;
        return acc;
      }, {} as Record<ContextCandidateStatus, number>);
      const runIds = new Set(candidates.map((candidate) => candidate.runId).filter(Boolean) as string[]);
      const allRuns = db.listRuns();
      const recentRuns = allRuns.slice(-5);
      const runMap = new Map<string, (typeof allRuns)[number]>();
      for (const run of allRuns) {
        if (runIds.has(run.runId)) runMap.set(run.runId, run);
      }
      for (const run of recentRuns) runMap.set(run.runId, run);
      const runs = Array.from(runMap.values()).sort((a, b) => (
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
        || b.runId.localeCompare(a.runId)
      ));
      res.json({ enabled, status, candidates, counts, runs });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:hash/context-map/candidates/:candidateId', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const workspaceSettings = await chatService.getWorkspaceContextMapSettings(hash);
      if (workspaceSettings === null) return res.status(404).json({ error: 'Workspace not found' });
      if (!(await chatService.getWorkspaceContextMapEnabled(hash))) {
        return res.status(403).json({ error: 'Context Map is disabled' });
      }
      const db = chatService.getContextMapDb(hash);
      if (!db) return res.status(404).json({ error: 'Workspace not found' });
      const candidateId = param(req, 'candidateId');
      const existing = db.getCandidate(candidateId);
      if (!existing) return res.status(404).json({ error: 'Candidate not found' });
      if (existing.status !== 'pending') {
        return res.status(409).json({ error: 'Only pending candidates can be edited' });
      }
      const body = validateContextMapCandidateUpdateRequest(req.body);
      const existingSourceSpan = existing.payload.sourceSpan;
      const nextPayload = { ...body.payload };
      if (existingSourceSpan && !Object.prototype.hasOwnProperty.call(nextPayload, 'sourceSpan')) {
        nextPayload.sourceSpan = existingSourceSpan;
      }
      const confidence = typeof body.confidence === 'number'
        ? Math.max(0, Math.min(1, body.confidence))
        : existing.confidence;
      const now = new Date().toISOString();
      const candidate = db.transaction(() => {
        const updated = db.updateCandidateReview(candidateId, {
          payload: nextPayload,
          confidence,
          updatedAt: now,
        });
        db.insertAuditEvent({
          eventId: `cm-audit-${crypto.randomUUID()}`,
          targetKind: 'candidate',
          targetId: candidateId,
          eventType: 'edited',
          details: {
            previousPayload: existing.payload,
            previousConfidence: existing.confidence,
          },
          createdAt: now,
        });
        return updated;
      });
      await emitFreshContextMapUpdate(hash);
      res.json({ ok: true, candidate });
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/context-map/candidates/:candidateId/discard', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const workspaceSettings = await chatService.getWorkspaceContextMapSettings(hash);
      if (workspaceSettings === null) return res.status(404).json({ error: 'Workspace not found' });
      if (!(await chatService.getWorkspaceContextMapEnabled(hash))) {
        return res.status(403).json({ error: 'Context Map is disabled' });
      }
      const db = chatService.getContextMapDb(hash);
      if (!db) return res.status(404).json({ error: 'Workspace not found' });
      const candidateId = param(req, 'candidateId');
      const existing = db.getCandidate(candidateId);
      if (!existing) return res.status(404).json({ error: 'Candidate not found' });
      if (existing.status !== 'discarded' && !CONTEXT_MAP_DISCARDABLE_CANDIDATE_STATUSES.has(existing.status)) {
        return res.status(409).json({ error: `Candidate status cannot be discarded: ${existing.status}` });
      }
      const now = new Date().toISOString();
      const candidate = existing.status === 'discarded'
        ? existing
        : db.transaction(() => {
          const updated = db.updateCandidateStatus(candidateId, 'discarded', now);
          db.insertAuditEvent({
            eventId: `cm-audit-${crypto.randomUUID()}`,
            targetKind: 'candidate',
            targetId: candidateId,
            eventType: 'discarded',
            details: { previousStatus: existing.status },
            createdAt: now,
          });
          return updated;
        });
      await emitFreshContextMapUpdate(hash);
      res.json({ ok: true, candidate });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/context-map/candidates/:candidateId/apply', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const workspaceSettings = await chatService.getWorkspaceContextMapSettings(hash);
      if (workspaceSettings === null) return res.status(404).json({ error: 'Workspace not found' });
      if (!(await chatService.getWorkspaceContextMapEnabled(hash))) {
        return res.status(403).json({ error: 'Context Map is disabled' });
      }
      const db = chatService.getContextMapDb(hash);
      if (!db) return res.status(404).json({ error: 'Workspace not found' });
      const candidateId = param(req, 'candidateId');
      const existing = db.getCandidate(candidateId);
      if (!existing) return res.status(404).json({ error: 'Candidate not found' });
      const { includeDependencies } = validateContextMapCandidateApplyRequest(req.body);
      const result = applyContextMapCandidate(db, existing, new Date().toISOString(), { includeDependencies });
      await emitFreshContextMapUpdate(hash);
      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      if (err instanceof ContextMapApplyDependencyError) {
        return res.status(err.statusCode).json({ error: err.message, dependencies: err.dependencies });
      }
      if (err instanceof ContextMapApplyError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/context-map/candidates/:candidateId/reopen', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const workspaceSettings = await chatService.getWorkspaceContextMapSettings(hash);
      if (workspaceSettings === null) return res.status(404).json({ error: 'Workspace not found' });
      if (!(await chatService.getWorkspaceContextMapEnabled(hash))) {
        return res.status(403).json({ error: 'Context Map is disabled' });
      }
      const db = chatService.getContextMapDb(hash);
      if (!db) return res.status(404).json({ error: 'Workspace not found' });
      const candidateId = param(req, 'candidateId');
      const existing = db.getCandidate(candidateId);
      if (!existing) return res.status(404).json({ error: 'Candidate not found' });
      if (existing.status !== 'discarded' && existing.status !== 'pending') {
        return res.status(409).json({ error: `Candidate status cannot be restored: ${existing.status}` });
      }
      const now = new Date().toISOString();
      const candidate = existing.status === 'pending'
        ? existing
        : db.transaction(() => {
          const updated = db.updateCandidateStatus(candidateId, 'pending', now);
          db.insertAuditEvent({
            eventId: `cm-audit-${crypto.randomUUID()}`,
            targetKind: 'candidate',
            targetId: candidateId,
            eventType: 'reopened',
            details: { previousStatus: existing.status },
            createdAt: now,
          });
          return updated;
        });
      await emitFreshContextMapUpdate(hash);
      res.json({ ok: true, candidate });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:hash/context-map/enabled', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { enabled } = validateContextMapEnabledRequest(req.body);
      const hash = param(req, 'hash');
      const wasEnabled = await chatService.getWorkspaceContextMapEnabled(hash);
      if (enabled === false && contextMapService.isRunning(hash)) {
        await contextMapService.stopWorkspace(hash);
      }
      const result = await chatService.setWorkspaceContextMapEnabled(hash, enabled);
      if (result === null) return res.status(404).json({ error: 'Workspace not found' });
      await emitFreshContextMapUpdate(hash);
      const initialScanStarted = result === true && wasEnabled === false;
      if (initialScanStarted) {
        void contextMapService.processWorkspace(hash).then((scanResult) => {
          if (scanResult.runId && scanResult.stopped) {
            log.info('Context Map initial scan stopped after enable', { workspace: hash, runId: scanResult.runId });
          } else if (scanResult.runId) {
            log.info('Context Map initial scan completed after enable', { workspace: hash, runId: scanResult.runId });
          }
        }).catch((err: unknown) => {
          log.warn('Context Map initial scan failed after enable', { workspace: hash, error: err });
        });
      }
      res.json({ enabled: result, initialScanStarted });
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:hash/context-map/settings', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { settings: input } = validateContextMapSettingsRequest(req.body);
      const hash = param(req, 'hash');
      const settings = await chatService.setWorkspaceContextMapSettings(hash, input);
      if (settings === null) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ settings });
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
