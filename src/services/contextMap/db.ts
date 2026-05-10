// ─── Context Map SQLite layer ───────────────────────────────────────────────
// Per-workspace state.db that owns the canonical Context Map store:
//   - entity_types: flexible type catalog with system/user/processor origins
//   - entities + aliases + facts: durable named things and readable fields
//   - relationships: typed evidence-backed edges between entities
//   - evidence_refs + evidence_links: source pointers for entities/facts/edges
//   - context_runs + source_spans + conversation/source cursors: incremental processing
//   - context_candidates + audit_events: review-first governance and history
//
// The UI may render Markdown-like cards from this data, but this database is
// the single source of truth. No editable Markdown/JSON mirror should be
// introduced for the same Context Map state.

import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export const CONTEXT_MAP_DB_SCHEMA_VERSION = 2;

export type ContextEntityStatus = 'active' | 'pending' | 'discarded' | 'superseded' | 'stale' | 'conflict';
export type ContextEntityTypeOrigin = 'system' | 'user' | 'processor';
export type ContextSensitivity = 'normal' | 'work-sensitive' | 'personal-sensitive' | 'secret-pointer';
export type ContextRelationshipStatus = ContextEntityStatus;
export type ContextEvidenceSourceType =
  | 'conversation_message'
  | 'conversation_summary'
  | 'memory_entry'
  | 'kb_entry'
  | 'kb_topic'
  | 'file'
  | 'workspace_instruction'
  | 'git_commit'
  | 'github_issue'
  | 'github_pull_request'
  | 'external_connector';
export type ContextEvidenceTargetKind = 'entity' | 'fact' | 'relationship' | 'candidate';
export type ContextRunSource = 'initial_scan' | 'scheduled' | 'session_reset' | 'archive' | 'manual_rebuild';
export type ContextRunStatus = 'running' | 'completed' | 'failed' | 'stopped';
export type ContextSourceCursorStatus = 'active' | 'missing';
export type ContextSourceCursorType = 'workspace_instruction' | 'file' | 'code_outline';
export type ContextCandidateType =
  | 'new_entity'
  | 'entity_update'
  | 'entity_merge'
  | 'new_relationship'
  | 'relationship_update'
  | 'relationship_removal'
  | 'new_entity_type'
  | 'alias_addition'
  | 'evidence_link'
  | 'sensitivity_classification'
  | 'conflict_flag';
export type ContextCandidateStatus = 'pending' | 'active' | 'discarded' | 'superseded' | 'stale' | 'conflict' | 'failed';

export interface ContextEntityTypeRow {
  typeSlug: string;
  label: string;
  description: string | null;
  origin: ContextEntityTypeOrigin;
  status: ContextEntityStatus;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertEntityTypeParams {
  typeSlug: string;
  label: string;
  description?: string | null;
  origin: ContextEntityTypeOrigin;
  status?: ContextEntityStatus;
  now: string;
}

export interface ContextEntityRow {
  entityId: string;
  typeSlug: string;
  name: string;
  status: ContextEntityStatus;
  summaryMarkdown: string | null;
  notesMarkdown: string | null;
  sensitivity: ContextSensitivity;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface InsertEntityParams {
  entityId: string;
  typeSlug: string;
  name: string;
  status?: ContextEntityStatus;
  summaryMarkdown?: string | null;
  notesMarkdown?: string | null;
  sensitivity?: ContextSensitivity;
  confidence?: number;
  now: string;
}

export interface UpdateEntityParams {
  typeSlug?: string;
  name?: string;
  status?: ContextEntityStatus;
  summaryMarkdown?: string | null;
  notesMarkdown?: string | null;
  sensitivity?: ContextSensitivity;
  confidence?: number;
  updatedAt: string;
}

export interface ContextEntityAliasRow {
  entityId: string;
  alias: string;
  createdAt: string;
}

export interface ContextEntityFactRow {
  factId: string;
  entityId: string;
  statementMarkdown: string;
  status: ContextEntityStatus;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface InsertEntityFactParams {
  factId: string;
  entityId: string;
  statementMarkdown: string;
  status?: ContextEntityStatus;
  confidence?: number;
  now: string;
}

export interface ContextRelationshipRow {
  relationshipId: string;
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string;
  status: ContextRelationshipStatus;
  confidence: number;
  qualifiers: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface InsertRelationshipParams {
  relationshipId: string;
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string;
  status?: ContextRelationshipStatus;
  confidence?: number;
  qualifiers?: Record<string, unknown> | null;
  now: string;
}

export interface UpdateRelationshipParams {
  subjectEntityId?: string;
  predicate?: string;
  objectEntityId?: string;
  status?: ContextRelationshipStatus;
  confidence?: number;
  qualifiers?: Record<string, unknown> | null;
  updatedAt: string;
}

export interface ContextEvidenceRefRow {
  evidenceId: string;
  sourceType: ContextEvidenceSourceType;
  sourceId: string;
  locator: Record<string, unknown> | null;
  excerpt: string | null;
  createdAt: string;
}

export interface UpsertEvidenceRefParams {
  evidenceId: string;
  sourceType: ContextEvidenceSourceType;
  sourceId: string;
  locator?: Record<string, unknown> | null;
  excerpt?: string | null;
  now: string;
}

export interface ContextEvidenceLinkRow {
  targetKind: ContextEvidenceTargetKind;
  targetId: string;
  evidenceId: string;
  createdAt: string;
}

export interface ContextRunRow {
  runId: string;
  source: ContextRunSource;
  status: ContextRunStatus;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
}

export interface InsertRunParams {
  runId: string;
  source: ContextRunSource;
  status?: ContextRunStatus;
  startedAt: string;
  metadata?: Record<string, unknown> | null;
}

export interface ContextSourceSpanRow {
  spanId: string;
  runId: string;
  conversationId: string;
  sessionEpoch: number;
  startMessageId: string;
  endMessageId: string;
  sourceHash: string;
  processedAt: string;
}

export interface InsertSourceSpanParams {
  spanId: string;
  runId: string;
  conversationId: string;
  sessionEpoch: number;
  startMessageId: string;
  endMessageId: string;
  sourceHash: string;
  processedAt: string;
}

export interface ContextConversationCursorRow {
  conversationId: string;
  sessionEpoch: number;
  lastProcessedMessageId: string;
  lastProcessedAt: string;
  lastProcessedSourceHash: string;
}

export interface UpsertConversationCursorParams {
  conversationId: string;
  sessionEpoch: number;
  lastProcessedMessageId: string;
  lastProcessedAt: string;
  lastProcessedSourceHash: string;
}

export interface ContextSourceCursorRow {
  sourceType: ContextSourceCursorType;
  sourceId: string;
  lastProcessedSourceHash: string;
  lastProcessedAt: string;
  lastSeenAt: string;
  lastRunId: string | null;
  status: ContextSourceCursorStatus;
  errorMessage: string | null;
}

export interface UpsertSourceCursorParams {
  sourceType: ContextSourceCursorType;
  sourceId: string;
  lastProcessedSourceHash: string;
  lastProcessedAt: string;
  lastSeenAt: string;
  lastRunId?: string | null;
  status?: ContextSourceCursorStatus;
  errorMessage?: string | null;
}

export interface ContextCandidateRow {
  candidateId: string;
  runId: string | null;
  candidateType: ContextCandidateType;
  status: ContextCandidateStatus;
  payload: Record<string, unknown>;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
  errorMessage: string | null;
}

export interface InsertCandidateParams {
  candidateId: string;
  runId?: string | null;
  candidateType: ContextCandidateType;
  status?: ContextCandidateStatus;
  payload: Record<string, unknown>;
  confidence?: number;
  now: string;
}

export interface UpdateCandidateReviewParams {
  payload: Record<string, unknown>;
  confidence: number;
  updatedAt: string;
}

export interface ContextAuditEventRow {
  eventId: string;
  targetKind: string;
  targetId: string;
  eventType: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface ContextMapClearResult {
  auditEvents: number;
  candidates: number;
  sourceSpans: number;
  conversationCursors: number;
  sourceCursors: number;
  runs: number;
  evidenceLinks: number;
  evidenceRefs: number;
  relationships: number;
  facts: number;
  aliases: number;
  entities: number;
  entityTypes: number;
}

export interface InsertAuditEventParams {
  eventId: string;
  targetKind: string;
  targetId: string;
  eventType: string;
  details?: Record<string, unknown> | null;
  createdAt: string;
}

const DEFAULT_ENTITY_TYPES: Array<{ typeSlug: string; label: string; description: string }> = [
  { typeSlug: 'person', label: 'Person', description: 'A durable person or contact relevant to the workspace.' },
  { typeSlug: 'organization', label: 'Organization', description: 'A company, team, institution, or group.' },
  { typeSlug: 'project', label: 'Project', description: 'A durable workstream, initiative, or project.' },
  { typeSlug: 'workflow', label: 'Workflow', description: 'A repeatable process or operating procedure.' },
  { typeSlug: 'document', label: 'Document', description: 'A source document, spec, draft, report, or note.' },
  { typeSlug: 'feature', label: 'Feature', description: 'A product capability, behavior area, or feature proposal.' },
  { typeSlug: 'concept', label: 'Concept', description: 'A recurring idea, theme, framework, or domain concept.' },
  { typeSlug: 'decision', label: 'Decision', description: 'A durable decision, tradeoff, or rejected alternative.' },
  { typeSlug: 'tool', label: 'Tool', description: 'A tool, integration, runtime, command, or platform capability.' },
  { typeSlug: 'asset', label: 'Asset', description: 'A reusable file, artifact, account, profile, or owned resource.' },
];

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS entity_types (
    type_slug   TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    description TEXT,
    origin      TEXT NOT NULL,
    status      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS entities (
    entity_id        TEXT PRIMARY KEY,
    type_slug        TEXT NOT NULL REFERENCES entity_types(type_slug) ON DELETE RESTRICT,
    name             TEXT NOT NULL,
    status           TEXT NOT NULL,
    summary_markdown TEXT,
    notes_markdown   TEXT,
    sensitivity      TEXT NOT NULL,
    confidence       REAL NOT NULL,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_context_entities_type ON entities(type_slug);
  CREATE INDEX IF NOT EXISTS idx_context_entities_status ON entities(status);
  CREATE INDEX IF NOT EXISTS idx_context_entities_name ON entities(name COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS entity_aliases (
    entity_id  TEXT NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
    alias      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (entity_id, alias)
  );
  CREATE INDEX IF NOT EXISTS idx_context_aliases_alias ON entity_aliases(alias COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS entity_facts (
    fact_id            TEXT PRIMARY KEY,
    entity_id          TEXT NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
    statement_markdown TEXT NOT NULL,
    status             TEXT NOT NULL,
    confidence         REAL NOT NULL,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_context_facts_entity ON entity_facts(entity_id);

  CREATE TABLE IF NOT EXISTS relationships (
    relationship_id   TEXT PRIMARY KEY,
    subject_entity_id TEXT NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
    predicate         TEXT NOT NULL,
    object_entity_id  TEXT NOT NULL REFERENCES entities(entity_id) ON DELETE CASCADE,
    status            TEXT NOT NULL,
    confidence        REAL NOT NULL,
    qualifiers_json   TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE (subject_entity_id, predicate, object_entity_id, qualifiers_json)
  );
  CREATE INDEX IF NOT EXISTS idx_context_relationships_subject ON relationships(subject_entity_id);
  CREATE INDEX IF NOT EXISTS idx_context_relationships_object ON relationships(object_entity_id);
  CREATE INDEX IF NOT EXISTS idx_context_relationships_predicate ON relationships(predicate);

  CREATE TABLE IF NOT EXISTS evidence_refs (
    evidence_id  TEXT PRIMARY KEY,
    source_type  TEXT NOT NULL,
    source_id    TEXT NOT NULL,
    locator_json TEXT NOT NULL DEFAULT '',
    excerpt      TEXT,
    created_at   TEXT NOT NULL,
    UNIQUE (source_type, source_id, locator_json)
  );
  CREATE INDEX IF NOT EXISTS idx_context_evidence_source ON evidence_refs(source_type, source_id);

  CREATE TABLE IF NOT EXISTS evidence_links (
    target_kind TEXT NOT NULL,
    target_id   TEXT NOT NULL,
    evidence_id TEXT NOT NULL REFERENCES evidence_refs(evidence_id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (target_kind, target_id, evidence_id)
  );
  CREATE INDEX IF NOT EXISTS idx_context_evidence_links_evidence ON evidence_links(evidence_id);

  CREATE TABLE IF NOT EXISTS context_runs (
    run_id        TEXT PRIMARY KEY,
    source        TEXT NOT NULL,
    status        TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    completed_at  TEXT,
    error_message TEXT,
    metadata_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_context_runs_status ON context_runs(status);
  CREATE INDEX IF NOT EXISTS idx_context_runs_source ON context_runs(source);

  CREATE TABLE IF NOT EXISTS source_spans (
    span_id          TEXT PRIMARY KEY,
    run_id           TEXT NOT NULL REFERENCES context_runs(run_id) ON DELETE CASCADE,
    conversation_id  TEXT NOT NULL,
    session_epoch    INTEGER NOT NULL,
    start_message_id TEXT NOT NULL,
    end_message_id   TEXT NOT NULL,
    source_hash      TEXT NOT NULL,
    processed_at     TEXT NOT NULL,
    UNIQUE (conversation_id, session_epoch, start_message_id, end_message_id, source_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_context_source_spans_conversation ON source_spans(conversation_id);

  CREATE TABLE IF NOT EXISTS conversation_cursors (
    conversation_id             TEXT PRIMARY KEY,
    session_epoch               INTEGER NOT NULL,
    last_processed_message_id   TEXT NOT NULL,
    last_processed_at           TEXT NOT NULL,
    last_processed_source_hash  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS source_cursors (
    source_type                 TEXT NOT NULL,
    source_id                   TEXT NOT NULL,
    last_processed_source_hash  TEXT NOT NULL,
    last_processed_at           TEXT NOT NULL,
    last_seen_at                TEXT NOT NULL,
    last_run_id                 TEXT REFERENCES context_runs(run_id) ON DELETE SET NULL,
    status                      TEXT NOT NULL,
    error_message               TEXT,
    PRIMARY KEY (source_type, source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_context_source_cursors_status ON source_cursors(status);

  CREATE TABLE IF NOT EXISTS context_candidates (
    candidate_id   TEXT PRIMARY KEY,
    run_id         TEXT REFERENCES context_runs(run_id) ON DELETE SET NULL,
    candidate_type TEXT NOT NULL,
    status         TEXT NOT NULL,
    payload_json   TEXT NOT NULL,
    confidence     REAL NOT NULL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    applied_at     TEXT,
    error_message  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_context_candidates_status ON context_candidates(status);
  CREATE INDEX IF NOT EXISTS idx_context_candidates_run ON context_candidates(run_id);

  CREATE TABLE IF NOT EXISTS audit_events (
    event_id     TEXT PRIMARY KEY,
    target_kind  TEXT NOT NULL,
    target_id    TEXT NOT NULL,
    event_type   TEXT NOT NULL,
    details_json TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_context_audit_target ON audit_events(target_kind, target_id);
`;

interface EntityTypeDbRow {
  type_slug: string;
  label: string;
  description: string | null;
  origin: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface EntityDbRow {
  entity_id: string;
  type_slug: string;
  name: string;
  status: string;
  summary_markdown: string | null;
  notes_markdown: string | null;
  sensitivity: string;
  confidence: number;
  created_at: string;
  updated_at: string;
}

interface AliasDbRow {
  entity_id: string;
  alias: string;
  created_at: string;
}

interface FactDbRow {
  fact_id: string;
  entity_id: string;
  statement_markdown: string;
  status: string;
  confidence: number;
  created_at: string;
  updated_at: string;
}

interface RelationshipDbRow {
  relationship_id: string;
  subject_entity_id: string;
  predicate: string;
  object_entity_id: string;
  status: string;
  confidence: number;
  qualifiers_json: string | null;
  created_at: string;
  updated_at: string;
}

interface EvidenceRefDbRow {
  evidence_id: string;
  source_type: string;
  source_id: string;
  locator_json: string | null;
  excerpt: string | null;
  created_at: string;
}

interface EvidenceLinkDbRow {
  target_kind: string;
  target_id: string;
  evidence_id: string;
  created_at: string;
}

interface RunDbRow {
  run_id: string;
  source: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  metadata_json: string | null;
}

interface SourceSpanDbRow {
  span_id: string;
  run_id: string;
  conversation_id: string;
  session_epoch: number;
  start_message_id: string;
  end_message_id: string;
  source_hash: string;
  processed_at: string;
}

interface ConversationCursorDbRow {
  conversation_id: string;
  session_epoch: number;
  last_processed_message_id: string;
  last_processed_at: string;
  last_processed_source_hash: string;
}

interface SourceCursorDbRow {
  source_type: string;
  source_id: string;
  last_processed_source_hash: string;
  last_processed_at: string;
  last_seen_at: string;
  last_run_id: string | null;
  status: string;
  error_message: string | null;
}

interface CandidateDbRow {
  candidate_id: string;
  run_id: string | null;
  candidate_type: string;
  status: string;
  payload_json: string;
  confidence: number;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
  error_message: string | null;
}

interface AuditEventDbRow {
  event_id: string;
  target_kind: string;
  target_id: string;
  event_type: string;
  details_json: string | null;
  created_at: string;
}

export class ContextMapDatabase {
  private readonly db: BetterSqlite3Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._initSchema();
    this._ensureDefaultEntityTypes();
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getSchemaVersion(): number {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
    return row ? Number(row.value) : CONTEXT_MAP_DB_SCHEMA_VERSION;
  }

  clearAll(): ContextMapClearResult {
    return this.transaction(() => ({
      evidenceLinks: this.db.prepare('DELETE FROM evidence_links').run().changes,
      auditEvents: this.db.prepare('DELETE FROM audit_events').run().changes,
      candidates: this.db.prepare('DELETE FROM context_candidates').run().changes,
      sourceSpans: this.db.prepare('DELETE FROM source_spans').run().changes,
      conversationCursors: this.db.prepare('DELETE FROM conversation_cursors').run().changes,
      sourceCursors: this.db.prepare('DELETE FROM source_cursors').run().changes,
      runs: this.db.prepare('DELETE FROM context_runs').run().changes,
      relationships: this.db.prepare('DELETE FROM relationships').run().changes,
      facts: this.db.prepare('DELETE FROM entity_facts').run().changes,
      aliases: this.db.prepare('DELETE FROM entity_aliases').run().changes,
      entities: this.db.prepare('DELETE FROM entities').run().changes,
      evidenceRefs: this.db.prepare('DELETE FROM evidence_refs').run().changes,
      entityTypes: this.db.prepare("DELETE FROM entity_types WHERE origin != 'system'").run().changes,
    }));
  }

  listEntityTypes(): ContextEntityTypeRow[] {
    const rows = this.db
      .prepare('SELECT * FROM entity_types ORDER BY label COLLATE NOCASE')
      .all() as EntityTypeDbRow[];
    return rows.map(mapEntityTypeRow);
  }

  getEntityType(typeSlug: string): ContextEntityTypeRow | null {
    const row = this.db
      .prepare('SELECT * FROM entity_types WHERE type_slug = ?')
      .get(typeSlug) as EntityTypeDbRow | undefined;
    return row ? mapEntityTypeRow(row) : null;
  }

  upsertEntityType(params: UpsertEntityTypeParams): ContextEntityTypeRow {
    this.db.prepare(`
      INSERT INTO entity_types (type_slug, label, description, origin, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(type_slug) DO UPDATE SET
        label = excluded.label,
        description = excluded.description,
        origin = excluded.origin,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      params.typeSlug,
      params.label,
      params.description ?? null,
      params.origin,
      params.status ?? 'active',
      params.now,
      params.now,
    );
    const row = this.getEntityType(params.typeSlug);
    if (!row) throw new Error(`Failed to upsert entity type: ${params.typeSlug}`);
    return row;
  }

  insertEntity(params: InsertEntityParams): ContextEntityRow {
    this.db.prepare(`
      INSERT INTO entities (
        entity_id, type_slug, name, status, summary_markdown, notes_markdown,
        sensitivity, confidence, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.entityId,
      params.typeSlug,
      params.name,
      params.status ?? 'active',
      params.summaryMarkdown ?? null,
      params.notesMarkdown ?? null,
      params.sensitivity ?? 'normal',
      params.confidence ?? 1,
      params.now,
      params.now,
    );
    const row = this.getEntity(params.entityId);
    if (!row) throw new Error(`Failed to insert entity: ${params.entityId}`);
    return row;
  }

  getEntity(entityId: string): ContextEntityRow | null {
    const row = this.db
      .prepare('SELECT * FROM entities WHERE entity_id = ?')
      .get(entityId) as EntityDbRow | undefined;
    return row ? mapEntityRow(row) : null;
  }

  listEntities(opts: { status?: ContextEntityStatus; typeSlug?: string } = {}): ContextEntityRow[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (opts.status) {
      conditions.push('status = ?');
      values.push(opts.status);
    }
    if (opts.typeSlug) {
      conditions.push('type_slug = ?');
      values.push(opts.typeSlug);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM entities ${where} ORDER BY name COLLATE NOCASE`)
      .all(...values) as EntityDbRow[];
    return rows.map(mapEntityRow);
  }

  updateEntitySensitivity(entityId: string, sensitivity: ContextSensitivity, updatedAt: string): ContextEntityRow {
    this.db.prepare(`
      UPDATE entities
      SET sensitivity = ?, updated_at = ?
      WHERE entity_id = ?
    `).run(sensitivity, updatedAt, entityId);
    const row = this.getEntity(entityId);
    if (!row) throw new Error(`Entity not found: ${entityId}`);
    return row;
  }

  updateEntity(entityId: string, params: UpdateEntityParams): ContextEntityRow {
    const current = this.getEntity(entityId);
    if (!current) throw new Error(`Entity not found: ${entityId}`);
    this.db.prepare(`
      UPDATE entities
      SET type_slug = ?, name = ?, status = ?, summary_markdown = ?, notes_markdown = ?,
          sensitivity = ?, confidence = ?, updated_at = ?
      WHERE entity_id = ?
    `).run(
      params.typeSlug ?? current.typeSlug,
      params.name ?? current.name,
      params.status ?? current.status,
      params.summaryMarkdown !== undefined ? params.summaryMarkdown : current.summaryMarkdown,
      params.notesMarkdown !== undefined ? params.notesMarkdown : current.notesMarkdown,
      params.sensitivity ?? current.sensitivity,
      params.confidence ?? current.confidence,
      params.updatedAt,
      entityId,
    );
    const row = this.getEntity(entityId);
    if (!row) throw new Error(`Entity not found: ${entityId}`);
    return row;
  }

  addAlias(entityId: string, alias: string, createdAt: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO entity_aliases (entity_id, alias, created_at)
      VALUES (?, ?, ?)
    `).run(entityId, alias, createdAt);
  }

  listAliases(entityId: string): ContextEntityAliasRow[] {
    const rows = this.db
      .prepare('SELECT * FROM entity_aliases WHERE entity_id = ? ORDER BY alias COLLATE NOCASE')
      .all(entityId) as AliasDbRow[];
    return rows.map((row) => ({
      entityId: row.entity_id,
      alias: row.alias,
      createdAt: row.created_at,
    }));
  }

  insertFact(params: InsertEntityFactParams): ContextEntityFactRow {
    this.db.prepare(`
      INSERT INTO entity_facts (fact_id, entity_id, statement_markdown, status, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.factId,
      params.entityId,
      params.statementMarkdown,
      params.status ?? 'active',
      params.confidence ?? 1,
      params.now,
      params.now,
    );
    const row = this.getFact(params.factId);
    if (!row) throw new Error(`Failed to insert fact: ${params.factId}`);
    return row;
  }

  getFact(factId: string): ContextEntityFactRow | null {
    const row = this.db
      .prepare('SELECT * FROM entity_facts WHERE fact_id = ?')
      .get(factId) as FactDbRow | undefined;
    return row ? mapFactRow(row) : null;
  }

  listFacts(entityId: string): ContextEntityFactRow[] {
    const rows = this.db
      .prepare('SELECT * FROM entity_facts WHERE entity_id = ? ORDER BY created_at, fact_id')
      .all(entityId) as FactDbRow[];
    return rows.map(mapFactRow);
  }

  insertRelationship(params: InsertRelationshipParams): ContextRelationshipRow {
    this.db.prepare(`
      INSERT INTO relationships (
        relationship_id, subject_entity_id, predicate, object_entity_id, status,
        confidence, qualifiers_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.relationshipId,
      params.subjectEntityId,
      params.predicate,
      params.objectEntityId,
      params.status ?? 'active',
      params.confidence ?? 1,
      stableJson(params.qualifiers ?? null) ?? '',
      params.now,
      params.now,
    );
    const row = this.getRelationship(params.relationshipId);
    if (!row) throw new Error(`Failed to insert relationship: ${params.relationshipId}`);
    return row;
  }

  getRelationship(relationshipId: string): ContextRelationshipRow | null {
    const row = this.db
      .prepare('SELECT * FROM relationships WHERE relationship_id = ?')
      .get(relationshipId) as RelationshipDbRow | undefined;
    return row ? mapRelationshipRow(row) : null;
  }

  listRelationshipsForEntity(entityId: string): ContextRelationshipRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM relationships
      WHERE subject_entity_id = ? OR object_entity_id = ?
      ORDER BY predicate COLLATE NOCASE, relationship_id
    `).all(entityId, entityId) as RelationshipDbRow[];
    return rows.map(mapRelationshipRow);
  }

  updateRelationship(relationshipId: string, params: UpdateRelationshipParams): ContextRelationshipRow {
    const current = this.getRelationship(relationshipId);
    if (!current) throw new Error(`Relationship not found: ${relationshipId}`);
    this.db.prepare(`
      UPDATE relationships
      SET subject_entity_id = ?, predicate = ?, object_entity_id = ?, status = ?,
          confidence = ?, qualifiers_json = ?, updated_at = ?
      WHERE relationship_id = ?
    `).run(
      params.subjectEntityId ?? current.subjectEntityId,
      params.predicate ?? current.predicate,
      params.objectEntityId ?? current.objectEntityId,
      params.status ?? current.status,
      params.confidence ?? current.confidence,
      stableJson(params.qualifiers !== undefined ? params.qualifiers : current.qualifiers) ?? '',
      params.updatedAt,
      relationshipId,
    );
    const row = this.getRelationship(relationshipId);
    if (!row) throw new Error(`Relationship not found: ${relationshipId}`);
    return row;
  }

  upsertEvidenceRef(params: UpsertEvidenceRefParams): ContextEvidenceRefRow {
    const locatorJson = stableJson(params.locator ?? null) ?? '';
    this.db.prepare(`
      INSERT INTO evidence_refs (evidence_id, source_type, source_id, locator_json, excerpt, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_type, source_id, locator_json) DO UPDATE SET
        excerpt = COALESCE(excluded.excerpt, evidence_refs.excerpt)
    `).run(
      params.evidenceId,
      params.sourceType,
      params.sourceId,
      locatorJson,
      params.excerpt ?? null,
      params.now,
    );
    const row = this.db.prepare(`
      SELECT * FROM evidence_refs
      WHERE source_type = ? AND source_id = ? AND locator_json = ?
    `).get(params.sourceType, params.sourceId, locatorJson) as EvidenceRefDbRow | undefined;
    if (!row) throw new Error(`Failed to upsert evidence ref: ${params.evidenceId}`);
    return mapEvidenceRefRow(row);
  }

  linkEvidence(targetKind: ContextEvidenceTargetKind, targetId: string, evidenceId: string, createdAt: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO evidence_links (target_kind, target_id, evidence_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(targetKind, targetId, evidenceId, createdAt);
  }

  listEvidenceForTarget(targetKind: ContextEvidenceTargetKind, targetId: string): ContextEvidenceRefRow[] {
    const rows = this.db.prepare(`
      SELECT er.*
      FROM evidence_refs er
      JOIN evidence_links el ON el.evidence_id = er.evidence_id
      WHERE el.target_kind = ? AND el.target_id = ?
      ORDER BY er.created_at, er.evidence_id
    `).all(targetKind, targetId) as EvidenceRefDbRow[];
    return rows.map(mapEvidenceRefRow);
  }

  insertRun(params: InsertRunParams): ContextRunRow {
    this.db.prepare(`
      INSERT INTO context_runs (run_id, source, status, started_at, completed_at, error_message, metadata_json)
      VALUES (?, ?, ?, ?, NULL, NULL, ?)
    `).run(
      params.runId,
      params.source,
      params.status ?? 'running',
      params.startedAt,
      stableJson(params.metadata ?? null),
    );
    const row = this.getRun(params.runId);
    if (!row) throw new Error(`Failed to insert run: ${params.runId}`);
    return row;
  }

  getRun(runId: string): ContextRunRow | null {
    const row = this.db
      .prepare('SELECT * FROM context_runs WHERE run_id = ?')
      .get(runId) as RunDbRow | undefined;
    return row ? mapRunRow(row) : null;
  }

  listRuns(opts: { source?: ContextRunSource; status?: ContextRunStatus } = {}): ContextRunRow[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (opts.source) {
      conditions.push('source = ?');
      values.push(opts.source);
    }
    if (opts.status) {
      conditions.push('status = ?');
      values.push(opts.status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM context_runs ${where} ORDER BY started_at, run_id`)
      .all(...values) as RunDbRow[];
    return rows.map(mapRunRow);
  }

  finishRun(runId: string, status: ContextRunStatus, completedAt: string, errorMessage?: string | null): ContextRunRow {
    this.db.prepare(`
      UPDATE context_runs
      SET status = ?, completed_at = ?, error_message = ?
      WHERE run_id = ?
    `).run(status, completedAt, errorMessage ?? null, runId);
    const row = this.getRun(runId);
    if (!row) throw new Error(`Run not found: ${runId}`);
    return row;
  }

  updateRunMetadata(runId: string, metadata: Record<string, unknown> | null): ContextRunRow {
    this.db.prepare(`
      UPDATE context_runs
      SET metadata_json = ?
      WHERE run_id = ?
    `).run(stableJson(metadata ?? null), runId);
    const row = this.getRun(runId);
    if (!row) throw new Error(`Run not found: ${runId}`);
    return row;
  }

  insertSourceSpan(params: InsertSourceSpanParams): ContextSourceSpanRow {
    this.db.prepare(`
      INSERT INTO source_spans (
        span_id, run_id, conversation_id, session_epoch, start_message_id,
        end_message_id, source_hash, processed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.spanId,
      params.runId,
      params.conversationId,
      params.sessionEpoch,
      params.startMessageId,
      params.endMessageId,
      params.sourceHash,
      params.processedAt,
    );
    const row = this.getSourceSpan(params.spanId);
    if (!row) throw new Error(`Failed to insert source span: ${params.spanId}`);
    return row;
  }

  getSourceSpan(spanId: string): ContextSourceSpanRow | null {
    const row = this.db
      .prepare('SELECT * FROM source_spans WHERE span_id = ?')
      .get(spanId) as SourceSpanDbRow | undefined;
    return row ? mapSourceSpanRow(row) : null;
  }

  listSourceSpans(conversationId?: string): ContextSourceSpanRow[] {
    const rows = conversationId
      ? this.db.prepare(`
        SELECT * FROM source_spans
        WHERE conversation_id = ?
        ORDER BY processed_at, span_id
      `).all(conversationId) as SourceSpanDbRow[]
      : this.db.prepare('SELECT * FROM source_spans ORDER BY processed_at, span_id').all() as SourceSpanDbRow[];
    return rows.map(mapSourceSpanRow);
  }

  hasSourceSpan(conversationId: string, sessionEpoch: number, startMessageId: string, endMessageId: string, sourceHash: string): boolean {
    const row = this.db.prepare(`
      SELECT span_id FROM source_spans
      WHERE conversation_id = ?
        AND session_epoch = ?
        AND start_message_id = ?
        AND end_message_id = ?
        AND source_hash = ?
    `).get(conversationId, sessionEpoch, startMessageId, endMessageId, sourceHash);
    return Boolean(row);
  }

  upsertConversationCursor(params: UpsertConversationCursorParams): ContextConversationCursorRow {
    this.db.prepare(`
      INSERT INTO conversation_cursors (
        conversation_id, session_epoch, last_processed_message_id,
        last_processed_at, last_processed_source_hash
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        session_epoch = excluded.session_epoch,
        last_processed_message_id = excluded.last_processed_message_id,
        last_processed_at = excluded.last_processed_at,
        last_processed_source_hash = excluded.last_processed_source_hash
    `).run(
      params.conversationId,
      params.sessionEpoch,
      params.lastProcessedMessageId,
      params.lastProcessedAt,
      params.lastProcessedSourceHash,
    );
    const row = this.getConversationCursor(params.conversationId);
    if (!row) throw new Error(`Failed to upsert conversation cursor: ${params.conversationId}`);
    return row;
  }

  getConversationCursor(conversationId: string): ContextConversationCursorRow | null {
    const row = this.db
      .prepare('SELECT * FROM conversation_cursors WHERE conversation_id = ?')
      .get(conversationId) as ConversationCursorDbRow | undefined;
    return row ? mapConversationCursorRow(row) : null;
  }

  listConversationCursors(): ContextConversationCursorRow[] {
    const rows = this.db
      .prepare('SELECT * FROM conversation_cursors ORDER BY conversation_id')
      .all() as ConversationCursorDbRow[];
    return rows.map(mapConversationCursorRow);
  }

  upsertSourceCursor(params: UpsertSourceCursorParams): ContextSourceCursorRow {
    this.db.prepare(`
      INSERT INTO source_cursors (
        source_type, source_id, last_processed_source_hash, last_processed_at,
        last_seen_at, last_run_id, status, error_message
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_type, source_id) DO UPDATE SET
        last_processed_source_hash = excluded.last_processed_source_hash,
        last_processed_at = excluded.last_processed_at,
        last_seen_at = excluded.last_seen_at,
        last_run_id = excluded.last_run_id,
        status = excluded.status,
        error_message = excluded.error_message
    `).run(
      params.sourceType,
      params.sourceId,
      params.lastProcessedSourceHash,
      params.lastProcessedAt,
      params.lastSeenAt,
      params.lastRunId ?? null,
      params.status ?? 'active',
      params.errorMessage ?? null,
    );
    const row = this.getSourceCursor(params.sourceType, params.sourceId);
    if (!row) throw new Error(`Failed to upsert source cursor: ${params.sourceType}:${params.sourceId}`);
    return row;
  }

  markSourceCursorMissing(
    sourceType: ContextSourceCursorType,
    sourceId: string,
    seenAt: string,
    runId?: string | null,
    errorMessage?: string | null,
  ): ContextSourceCursorRow {
    this.db.prepare(`
      UPDATE source_cursors
      SET status = 'missing',
        last_seen_at = ?,
        last_run_id = ?,
        error_message = ?
      WHERE source_type = ? AND source_id = ?
    `).run(
      seenAt,
      runId ?? null,
      errorMessage ?? 'Source was not discovered during the latest workspace source scan.',
      sourceType,
      sourceId,
    );
    const row = this.getSourceCursor(sourceType, sourceId);
    if (!row) throw new Error(`Source cursor not found: ${sourceType}:${sourceId}`);
    return row;
  }

  getSourceCursor(sourceType: ContextSourceCursorType, sourceId: string): ContextSourceCursorRow | null {
    const row = this.db
      .prepare('SELECT * FROM source_cursors WHERE source_type = ? AND source_id = ?')
      .get(sourceType, sourceId) as SourceCursorDbRow | undefined;
    return row ? mapSourceCursorRow(row) : null;
  }

  listSourceCursors(opts?: { status?: ContextSourceCursorStatus }): ContextSourceCursorRow[] {
    const rows = opts?.status
      ? this.db
        .prepare('SELECT * FROM source_cursors WHERE status = ? ORDER BY source_type, source_id')
        .all(opts.status) as SourceCursorDbRow[]
      : this.db
        .prepare('SELECT * FROM source_cursors ORDER BY source_type, source_id')
        .all() as SourceCursorDbRow[];
    return rows.map(mapSourceCursorRow);
  }

  insertCandidate(params: InsertCandidateParams): ContextCandidateRow {
    this.db.prepare(`
      INSERT INTO context_candidates (
        candidate_id, run_id, candidate_type, status, payload_json,
        confidence, created_at, updated_at, applied_at, error_message
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      params.candidateId,
      params.runId ?? null,
      params.candidateType,
      params.status ?? 'pending',
      stableJson(params.payload) || '{}',
      params.confidence ?? 1,
      params.now,
      params.now,
    );
    const row = this.getCandidate(params.candidateId);
    if (!row) throw new Error(`Failed to insert candidate: ${params.candidateId}`);
    return row;
  }

  getCandidate(candidateId: string): ContextCandidateRow | null {
    const row = this.db
      .prepare('SELECT * FROM context_candidates WHERE candidate_id = ?')
      .get(candidateId) as CandidateDbRow | undefined;
    return row ? mapCandidateRow(row) : null;
  }

  listCandidates(status?: ContextCandidateStatus): ContextCandidateRow[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM context_candidates WHERE status = ? ORDER BY created_at, candidate_id').all(status) as CandidateDbRow[]
      : this.db.prepare('SELECT * FROM context_candidates ORDER BY created_at, candidate_id').all() as CandidateDbRow[];
    return rows.map(mapCandidateRow);
  }

  updateCandidateStatus(
    candidateId: string,
    status: ContextCandidateStatus,
    updatedAt: string,
    opts: { appliedAt?: string | null; errorMessage?: string | null } = {},
  ): ContextCandidateRow {
    this.db.prepare(`
      UPDATE context_candidates
      SET status = ?, updated_at = ?, applied_at = ?, error_message = ?
      WHERE candidate_id = ?
    `).run(status, updatedAt, opts.appliedAt ?? null, opts.errorMessage ?? null, candidateId);
    const row = this.getCandidate(candidateId);
    if (!row) throw new Error(`Candidate not found: ${candidateId}`);
    return row;
  }

  updateCandidateReview(candidateId: string, params: UpdateCandidateReviewParams): ContextCandidateRow {
    this.db.prepare(`
      UPDATE context_candidates
      SET payload_json = ?, confidence = ?, updated_at = ?
      WHERE candidate_id = ?
    `).run(
      stableJson(params.payload) || '{}',
      params.confidence,
      params.updatedAt,
      candidateId,
    );
    const row = this.getCandidate(candidateId);
    if (!row) throw new Error(`Candidate not found: ${candidateId}`);
    return row;
  }

  insertAuditEvent(params: InsertAuditEventParams): ContextAuditEventRow {
    this.db.prepare(`
      INSERT INTO audit_events (event_id, target_kind, target_id, event_type, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      params.eventId,
      params.targetKind,
      params.targetId,
      params.eventType,
      stableJson(params.details ?? null),
      params.createdAt,
    );
    const row = this.getAuditEvent(params.eventId);
    if (!row) throw new Error(`Failed to insert audit event: ${params.eventId}`);
    return row;
  }

  getAuditEvent(eventId: string): ContextAuditEventRow | null {
    const row = this.db
      .prepare('SELECT * FROM audit_events WHERE event_id = ?')
      .get(eventId) as AuditEventDbRow | undefined;
    return row ? mapAuditEventRow(row) : null;
  }

  listAuditEvents(targetKind: string, targetId: string): ContextAuditEventRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM audit_events
      WHERE target_kind = ? AND target_id = ?
      ORDER BY created_at, event_id
    `).all(targetKind, targetId) as AuditEventDbRow[];
    return rows.map(mapAuditEventRow);
  }

  private _initSchema(): void {
    this.db.exec(SCHEMA_DDL);
    this.db.prepare(`
      INSERT INTO meta (key, value)
      VALUES ('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(CONTEXT_MAP_DB_SCHEMA_VERSION));
  }

  private _ensureDefaultEntityTypes(): void {
    const now = new Date(0).toISOString();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO entity_types (type_slug, label, description, origin, status, created_at, updated_at)
      VALUES (?, ?, ?, 'system', 'active', ?, ?)
    `);
    const tx = this.db.transaction(() => {
      for (const type of DEFAULT_ENTITY_TYPES) {
        stmt.run(type.typeSlug, type.label, type.description, now, now);
      }
    });
    tx();
  }
}

export function openContextMapDatabase(contextMapDir: string): ContextMapDatabase {
  fs.mkdirSync(contextMapDir, { recursive: true });
  return new ContextMapDatabase(path.join(contextMapDir, 'state.db'));
}

function mapEntityTypeRow(row: EntityTypeDbRow): ContextEntityTypeRow {
  return {
    typeSlug: row.type_slug,
    label: row.label,
    description: row.description,
    origin: row.origin as ContextEntityTypeOrigin,
    status: row.status as ContextEntityStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEntityRow(row: EntityDbRow): ContextEntityRow {
  return {
    entityId: row.entity_id,
    typeSlug: row.type_slug,
    name: row.name,
    status: row.status as ContextEntityStatus,
    summaryMarkdown: row.summary_markdown,
    notesMarkdown: row.notes_markdown,
    sensitivity: row.sensitivity as ContextSensitivity,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFactRow(row: FactDbRow): ContextEntityFactRow {
  return {
    factId: row.fact_id,
    entityId: row.entity_id,
    statementMarkdown: row.statement_markdown,
    status: row.status as ContextEntityStatus,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRelationshipRow(row: RelationshipDbRow): ContextRelationshipRow {
  return {
    relationshipId: row.relationship_id,
    subjectEntityId: row.subject_entity_id,
    predicate: row.predicate,
    objectEntityId: row.object_entity_id,
    status: row.status as ContextRelationshipStatus,
    confidence: row.confidence,
    qualifiers: parseJsonObject(row.qualifiers_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvidenceRefRow(row: EvidenceRefDbRow): ContextEvidenceRefRow {
  return {
    evidenceId: row.evidence_id,
    sourceType: row.source_type as ContextEvidenceSourceType,
    sourceId: row.source_id,
    locator: parseJsonObject(row.locator_json),
    excerpt: row.excerpt,
    createdAt: row.created_at,
  };
}

function mapRunRow(row: RunDbRow): ContextRunRow {
  return {
    runId: row.run_id,
    source: row.source as ContextRunSource,
    status: row.status as ContextRunStatus,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapSourceSpanRow(row: SourceSpanDbRow): ContextSourceSpanRow {
  return {
    spanId: row.span_id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    sessionEpoch: row.session_epoch,
    startMessageId: row.start_message_id,
    endMessageId: row.end_message_id,
    sourceHash: row.source_hash,
    processedAt: row.processed_at,
  };
}

function mapConversationCursorRow(row: ConversationCursorDbRow): ContextConversationCursorRow {
  return {
    conversationId: row.conversation_id,
    sessionEpoch: row.session_epoch,
    lastProcessedMessageId: row.last_processed_message_id,
    lastProcessedAt: row.last_processed_at,
    lastProcessedSourceHash: row.last_processed_source_hash,
  };
}

function mapSourceCursorRow(row: SourceCursorDbRow): ContextSourceCursorRow {
  return {
    sourceType: row.source_type as ContextSourceCursorType,
    sourceId: row.source_id,
    lastProcessedSourceHash: row.last_processed_source_hash,
    lastProcessedAt: row.last_processed_at,
    lastSeenAt: row.last_seen_at,
    lastRunId: row.last_run_id,
    status: row.status as ContextSourceCursorStatus,
    errorMessage: row.error_message,
  };
}

function mapCandidateRow(row: CandidateDbRow): ContextCandidateRow {
  return {
    candidateId: row.candidate_id,
    runId: row.run_id,
    candidateType: row.candidate_type as ContextCandidateType,
    status: row.status as ContextCandidateStatus,
    payload: parseJsonObject(row.payload_json) || {},
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at,
    errorMessage: row.error_message,
  };
}

function mapAuditEventRow(row: AuditEventDbRow): ContextAuditEventRow {
  return {
    eventId: row.event_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    eventType: row.event_type,
    details: parseJsonObject(row.details_json),
    createdAt: row.created_at,
  };
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stableJson(value: Record<string, unknown> | null): string | null {
  if (!value) return null;
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    out[key] = sortJsonValue(input[key]);
  }
  return out;
}
