// ── Context Map MCP Server ──────────────────────────────────────────────────
//
// Read-only runtime access to the active Context Map graph. The active chat
// CLI can search and inspect reviewed entities/relationships, but cannot write
// candidates or active graph rows through these tools.

import crypto from 'crypto';
import path from 'path';
import express, { type Request, type Response } from 'express';
import type { McpServerConfig } from '../../types';
import type {
  ContextEntityFactRow,
  ContextEntityRow,
  ContextEvidenceRefRow,
  ContextMapDatabase,
  ContextRelationshipRow,
} from './db';

interface ContextMapSession {
  token: string;
  workspaceHash: string;
  createdAt: number;
}

export interface ContextMapChatService {
  getContextMapDb(hash: string): ContextMapDatabase | null;
  getWorkspaceContextMapEnabled(hash: string): Promise<boolean>;
}

export interface ContextMapMcpServer {
  router: express.Router;
  issueContextMapMcpSession(sessionKey: string, hash: string): { token: string; mcpServers: McpServerConfig[] };
  revokeContextMapMcpSession(sessionKey: string): void;
}

export const CONTEXT_MAP_MCP_STUB_PATH = path.resolve(__dirname, 'stub.cjs');

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_PACK_ENTITIES = 5;
const MAX_PACK_ENTITIES = 10;
const MAX_RELATED_LIMIT = 50;

function mintToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArrayArg(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((part) => part.trim()).filter(Boolean);
  }
  return [];
}

function boolArg(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function lowerIncludes(haystack: string | null | undefined, needle: string): boolean {
  return !!haystack && haystack.toLocaleLowerCase().includes(needle);
}

function evidenceFor(db: ContextMapDatabase, targetKind: 'entity' | 'fact' | 'relationship', targetId: string): ContextEvidenceRefRow[] {
  return db.listEvidenceForTarget(targetKind, targetId);
}

function serializeEvidence(refs: ContextEvidenceRefRow[]): Array<Record<string, unknown>> {
  return refs.map((ref) => ({
    evidence_id: ref.evidenceId,
    source_type: ref.sourceType,
    source_id: ref.sourceId,
    locator: ref.locator,
    excerpt: ref.excerpt,
  }));
}

function filterEvidence(
  refs: ContextEvidenceRefRow[],
  opts: { includeFiles: boolean; includeConversations: boolean },
): ContextEvidenceRefRow[] {
  return refs.filter((ref) => {
    if (ref.sourceType === 'file' && !opts.includeFiles) return false;
    if ((ref.sourceType === 'conversation_message' || ref.sourceType === 'conversation_summary') && !opts.includeConversations) return false;
    return true;
  });
}

function serializeEntityBase(entity: ContextEntityRow): Record<string, unknown> {
  const secret = entity.sensitivity === 'secret-pointer';
  return {
    entity_id: entity.entityId,
    type: entity.typeSlug,
    name: entity.name,
    summary: secret ? null : entity.summaryMarkdown,
    sensitivity: entity.sensitivity,
    confidence: entity.confidence,
    updated_at: entity.updatedAt,
  };
}

function activeFacts(db: ContextMapDatabase, entityId: string): ContextEntityFactRow[] {
  return db.listFacts(entityId).filter((fact) => fact.status === 'active');
}

function serializeFact(fact: ContextEntityFactRow, includeEvidence: boolean, db: ContextMapDatabase): Record<string, unknown> {
  const out: Record<string, unknown> = {
    fact_id: fact.factId,
    statement: fact.statementMarkdown,
    confidence: fact.confidence,
  };
  if (includeEvidence) out.evidence = serializeEvidence(evidenceFor(db, 'fact', fact.factId));
  return out;
}

function relationshipOtherEntityId(entityId: string, relationship: ContextRelationshipRow): string {
  return relationship.subjectEntityId === entityId
    ? relationship.objectEntityId
    : relationship.subjectEntityId;
}

function serializeRelationship(
  db: ContextMapDatabase,
  entityId: string,
  relationship: ContextRelationshipRow,
  includeEvidence: boolean,
): Record<string, unknown> | null {
  if (relationship.status !== 'active') return null;
  const other = db.getEntity(relationshipOtherEntityId(entityId, relationship));
  if (!other || other.status !== 'active') return null;
  const out: Record<string, unknown> = {
    relationship_id: relationship.relationshipId,
    predicate: relationship.predicate,
    direction: relationship.subjectEntityId === entityId ? 'outgoing' : 'incoming',
    subject_entity_id: relationship.subjectEntityId,
    object_entity_id: relationship.objectEntityId,
    other_entity: serializeEntityBase(other),
    confidence: relationship.confidence,
    qualifiers: relationship.qualifiers,
  };
  if (includeEvidence) out.evidence = serializeEvidence(evidenceFor(db, 'relationship', relationship.relationshipId));
  return out;
}

function serializeEntityDetail(
  db: ContextMapDatabase,
  entity: ContextEntityRow,
  opts: { includeEvidence: boolean },
): Record<string, unknown> {
  const secret = entity.sensitivity === 'secret-pointer';
  const aliases = db.listAliases(entity.entityId).map((alias) => alias.alias);
  const facts = secret ? [] : activeFacts(db, entity.entityId).map((fact) => serializeFact(fact, opts.includeEvidence, db));
  const relationships = db.listRelationshipsForEntity(entity.entityId)
    .map((relationship) => serializeRelationship(db, entity.entityId, relationship, opts.includeEvidence))
    .filter((relationship): relationship is Record<string, unknown> => !!relationship);

  const out: Record<string, unknown> = {
    ...serializeEntityBase(entity),
    aliases,
    notes: secret ? null : entity.notesMarkdown,
    facts,
    relationships,
  };
  if (opts.includeEvidence && !secret) {
    out.evidence = serializeEvidence(evidenceFor(db, 'entity', entity.entityId));
  }
  return out;
}

function scoreEntity(db: ContextMapDatabase, entity: ContextEntityRow, query: string): number {
  const q = query.toLocaleLowerCase();
  const secret = entity.sensitivity === 'secret-pointer';
  const aliases = db.listAliases(entity.entityId).map((alias) => alias.alias);
  const facts = secret
    ? []
    : activeFacts(db, entity.entityId).map((fact) => fact.statementMarkdown);

  let score = 0;
  const name = entity.name.toLocaleLowerCase();
  if (name === q) score += 100;
  else if (name.startsWith(q)) score += 80;
  else if (name.includes(q)) score += 60;

  for (const alias of aliases) {
    const a = alias.toLocaleLowerCase();
    if (a === q) score += 70;
    else if (a.includes(q)) score += 45;
  }
  if (!secret && lowerIncludes(entity.summaryMarkdown, q)) score += 25;
  if (!secret && lowerIncludes(entity.notesMarkdown, q)) score += 15;
  for (const fact of facts) {
    if (fact.toLocaleLowerCase().includes(q)) score += 20;
  }
  return score;
}

function searchEntities(
  db: ContextMapDatabase,
  args: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const query = stringArg(args.query);
  if (!query) return [];
  const types = new Set(stringArrayArg(args.types));
  const limit = boundedInteger(args.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);

  return db.listEntities({ status: 'active' })
    .filter((entity) => types.size === 0 || types.has(entity.typeSlug))
    .map((entity) => ({ entity, score: scoreEntity(db, entity, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.entity.name.localeCompare(b.entity.name))
    .slice(0, limit)
    .map(({ entity, score }) => ({
      ...serializeEntityBase(entity),
      aliases: db.listAliases(entity.entityId).map((alias) => alias.alias),
      score,
    }));
}

function handleGetRelatedEntities(db: ContextMapDatabase, args: Record<string, unknown>): Record<string, unknown> {
  const entityId = stringArg(args.id || args.entity_id);
  if (!entityId) return { error: 'id is required' };
  const seed = db.getEntity(entityId);
  if (!seed || seed.status !== 'active') return { error: `Entity "${entityId}" not found` };

  const maxDepth = boundedInteger(args.depth, 1, 1, 2);
  const limit = boundedInteger(args.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_RELATED_LIMIT);
  const predicateFilter = new Set(stringArrayArg(args.relationshipTypes ?? args.relationship_types));
  const visited = new Set<string>([seed.entityId]);
  let frontier = [seed.entityId];
  const related: Array<Record<string, unknown>> = [];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0 && related.length < limit; depth++) {
    const next: string[] = [];
    for (const currentId of frontier) {
      for (const relationship of db.listRelationshipsForEntity(currentId)) {
        if (relationship.status !== 'active') continue;
        if (predicateFilter.size > 0 && !predicateFilter.has(relationship.predicate)) continue;
        const otherId = relationshipOtherEntityId(currentId, relationship);
        if (visited.has(otherId)) continue;
        const other = db.getEntity(otherId);
        if (!other || other.status !== 'active') continue;
        visited.add(otherId);
        next.push(otherId);
        related.push({
          distance: depth,
          entity: serializeEntityBase(other),
          via: {
            relationship_id: relationship.relationshipId,
            predicate: relationship.predicate,
            subject_entity_id: relationship.subjectEntityId,
            object_entity_id: relationship.objectEntityId,
            from_entity_id: currentId,
            to_entity_id: otherId,
            direction: relationship.subjectEntityId === currentId ? 'outgoing' : 'incoming',
            confidence: relationship.confidence,
            qualifiers: relationship.qualifiers,
          },
        });
        if (related.length >= limit) break;
      }
      if (related.length >= limit) break;
    }
    frontier = next;
  }

  return { seed: serializeEntityBase(seed), depth: maxDepth, related };
}

function handleContextPack(db: ContextMapDatabase, args: Record<string, unknown>): Record<string, unknown> {
  const maxEntities = boundedInteger(args.maxEntities ?? args.max_entities, DEFAULT_PACK_ENTITIES, 1, MAX_PACK_ENTITIES);
  const includeFiles = boolArg(args.includeFiles ?? args.include_files, true);
  const includeConversations = boolArg(args.includeConversations ?? args.include_conversations, true);
  const entities = searchEntities(db, { ...args, limit: maxEntities }).map((entry) => {
    const entityId = String(entry.entity_id || '');
    const entity = db.getEntity(entityId);
    if (!entity) return null;
    const detail = serializeEntityDetail(db, entity, { includeEvidence: true });
    if (Array.isArray(detail.evidence)) {
      detail.evidence = serializeEvidence(filterEvidence(evidenceFor(db, 'entity', entity.entityId), { includeFiles, includeConversations }));
    }
    if (Array.isArray(detail.facts)) {
      detail.facts = activeFacts(db, entity.entityId).map((fact) => ({
        ...serializeFact(fact, true, db),
        evidence: serializeEvidence(filterEvidence(evidenceFor(db, 'fact', fact.factId), { includeFiles, includeConversations })),
      }));
    }
    if (Array.isArray(detail.relationships)) {
      detail.relationships = detail.relationships.map((relationship) => {
        if (!relationship || typeof relationship !== 'object' || Array.isArray(relationship)) return relationship;
        const rel = relationship as Record<string, unknown>;
        const relationshipId = typeof rel.relationship_id === 'string' ? rel.relationship_id : '';
        return {
          ...rel,
          evidence: relationshipId
            ? serializeEvidence(filterEvidence(evidenceFor(db, 'relationship', relationshipId), { includeFiles, includeConversations }))
            : [],
        };
      });
    }
    return detail;
  }).filter((entry): entry is Record<string, unknown> => !!entry);

  return {
    query: stringArg(args.query),
    entities,
    evidence_filters: {
      include_files: includeFiles,
      include_conversations: includeConversations,
    },
  };
}

function dispatchTool(db: ContextMapDatabase, tool: string, args: Record<string, unknown>): unknown {
  if (tool === 'entity_search') {
    return { query: stringArg(args.query), entities: searchEntities(db, args) };
  }
  if (tool === 'get_entity') {
    const entityId = stringArg(args.id ?? args.entity_id);
    if (!entityId) return { error: 'id is required' };
    const entity = db.getEntity(entityId);
    if (!entity || entity.status !== 'active') return { error: `Entity "${entityId}" not found` };
    return serializeEntityDetail(db, entity, { includeEvidence: boolArg(args.includeEvidence ?? args.include_evidence, false) });
  }
  if (tool === 'get_related_entities') {
    return handleGetRelatedEntities(db, args);
  }
  if (tool === 'context_pack') {
    return handleContextPack(db, args);
  }
  return { error: `Unknown tool: ${tool}` };
}

interface CreateContextMapMcpDeps {
  chatService: ContextMapChatService;
}

export function createContextMapMcpServer({ chatService }: CreateContextMapMcpDeps): ContextMapMcpServer {
  const sessions = new Map<string, ContextMapSession>();
  const byKey = new Map<string, string>();

  function issueContextMapMcpSession(sessionKey: string, hash: string): { token: string; mcpServers: McpServerConfig[] } {
    const cachedToken = byKey.get(sessionKey);
    const cached = cachedToken ? sessions.get(cachedToken) : undefined;
    let token: string;
    if (cached && cached.workspaceHash === hash) {
      token = cached.token;
    } else {
      if (cachedToken) revokeContextMapMcpSession(sessionKey);
      token = mintToken();
      sessions.set(token, { token, workspaceHash: hash, createdAt: Date.now() });
      byKey.set(sessionKey, token);
    }

    const port = Number(process.env.PORT) || 3334;
    const endpoint = `http://127.0.0.1:${port}/api/chat/mcp/context-map/call`;

    return {
      token,
      mcpServers: [
        {
          name: 'agent-cockpit-context-map',
          command: 'node',
          args: [CONTEXT_MAP_MCP_STUB_PATH],
          env: [
            { name: 'CONTEXT_MAP_TOKEN', value: token },
            { name: 'CONTEXT_MAP_ENDPOINT', value: endpoint },
          ],
        },
      ],
    };
  }

  function revokeContextMapMcpSession(sessionKey: string): void {
    const token = byKey.get(sessionKey);
    if (!token) return;
    sessions.delete(token);
    byKey.delete(sessionKey);
  }

  const router = express.Router();

  router.post('/context-map/call', async (req: Request, res: Response) => {
    const token = req.header('x-context-map-token') || '';
    const session = token ? sessions.get(token) : undefined;
    if (!session) return res.status(401).json({ error: 'Invalid Context Map token' });

    if (!(await chatService.getWorkspaceContextMapEnabled(session.workspaceHash))) {
      return res.status(403).json({ error: 'Context Map is disabled' });
    }

    const tool = stringArg(req.body?.tool);
    const args = (req.body?.arguments && typeof req.body.arguments === 'object' && !Array.isArray(req.body.arguments))
      ? req.body.arguments as Record<string, unknown>
      : {};
    if (!tool) return res.status(400).json({ error: 'tool is required' });
    if (!['entity_search', 'get_entity', 'get_related_entities', 'context_pack'].includes(tool)) {
      return res.status(400).json({ error: `Unknown tool: ${tool}` });
    }

    const db = chatService.getContextMapDb(session.workspaceHash);
    if (!db) return res.status(404).json({ error: 'Context Map database unavailable' });

    try {
      res.json(dispatchTool(db, tool, args));
    } catch (err) {
      console.error('[contextMapMcp] Tool call failed:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return {
    router,
    issueContextMapMcpSession,
    revokeContextMapMcpSession,
  };
}
