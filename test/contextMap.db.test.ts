import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CONTEXT_MAP_DB_SCHEMA_VERSION,
  ContextMapDatabase,
  openContextMapDatabase,
} from '../src/services/contextMap/db';

let tmpDir: string;
let dbPath: string;
let db: ContextMapDatabase;

const NOW = '2026-05-07T20:00:00.000Z';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-map-db-'));
  dbPath = path.join(tmpDir, 'state.db');
  db = new ContextMapDatabase(dbPath);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('schema bootstrap', () => {
  test('fresh DB has schema version and default entity type catalog', () => {
    expect(db.getSchemaVersion()).toBe(CONTEXT_MAP_DB_SCHEMA_VERSION);

    const types = db.listEntityTypes();
    expect(types.map((type) => type.typeSlug)).toEqual([
      'asset',
      'concept',
      'decision',
      'document',
      'feature',
      'organization',
      'person',
      'project',
      'tool',
      'workflow',
    ]);
    expect(db.getEntityType('person')).toMatchObject({
      typeSlug: 'person',
      label: 'Person',
      origin: 'system',
      status: 'active',
    });
  });

  test('openContextMapDatabase creates the workspace context map directory', () => {
    db.close();
    const dir = path.join(tmpDir, 'context-map');
    const opened = openContextMapDatabase(dir);
    try {
      expect(fs.existsSync(path.join(dir, 'state.db'))).toBe(true);
      expect(opened.getSchemaVersion()).toBe(CONTEXT_MAP_DB_SCHEMA_VERSION);
    } finally {
      opened.close();
    }
  });
});

describe('entity types and entities', () => {
  test('upsertEntityType creates and updates workspace-specific types', () => {
    db.upsertEntityType({
      typeSlug: 'stakeholder',
      label: 'Stakeholder',
      description: 'A reviewed workspace-specific role.',
      origin: 'user',
      now: NOW,
    });

    expect(db.getEntityType('stakeholder')).toMatchObject({
      typeSlug: 'stakeholder',
      label: 'Stakeholder',
      origin: 'user',
      status: 'active',
    });

    db.upsertEntityType({
      typeSlug: 'stakeholder',
      label: 'Decision Stakeholder',
      description: null,
      origin: 'processor',
      status: 'pending',
      now: '2026-05-07T21:00:00.000Z',
    });

    expect(db.getEntityType('stakeholder')).toMatchObject({
      label: 'Decision Stakeholder',
      description: null,
      origin: 'processor',
      status: 'pending',
      createdAt: NOW,
      updatedAt: '2026-05-07T21:00:00.000Z',
    });
  });

  test('insertEntity stores readable fields, aliases, and facts', () => {
    db.insertEntity({
      entityId: 'ent-project',
      typeSlug: 'project',
      name: 'Research Engagement',
      summaryMarkdown: 'Durable summary.',
      notesMarkdown: 'Operator notes.',
      confidence: 0.82,
      now: NOW,
    });
    db.addAlias('ent-project', 'Engagement', NOW);
    db.addAlias('ent-project', 'Engagement', NOW);
    db.insertFact({
      factId: 'fact-1',
      entityId: 'ent-project',
      statementMarkdown: 'This project has a reviewed durable fact.',
      confidence: 0.74,
      now: NOW,
    });

    expect(db.getEntity('ent-project')).toMatchObject({
      entityId: 'ent-project',
      typeSlug: 'project',
      name: 'Research Engagement',
      status: 'active',
      sensitivity: 'normal',
      confidence: 0.82,
      summaryMarkdown: 'Durable summary.',
      notesMarkdown: 'Operator notes.',
    });
    expect(db.listAliases('ent-project')).toEqual([
      { entityId: 'ent-project', alias: 'Engagement', createdAt: NOW },
    ]);
    expect(db.listFacts('ent-project')).toMatchObject([
      {
        factId: 'fact-1',
        entityId: 'ent-project',
        statementMarkdown: 'This project has a reviewed durable fact.',
        status: 'active',
        confidence: 0.74,
      },
    ]);
    expect(db.updateEntity('ent-project', {
      name: 'Context Map',
      summaryMarkdown: 'Updated summary.',
      confidence: 0.95,
      updatedAt: '2026-05-07T20:10:00.000Z',
    })).toMatchObject({
      entityId: 'ent-project',
      name: 'Context Map',
      summaryMarkdown: 'Updated summary.',
      confidence: 0.95,
      updatedAt: '2026-05-07T20:10:00.000Z',
    });
  });
});

describe('relationships and evidence', () => {
  beforeEach(() => {
    db.insertEntity({ entityId: 'ent-a', typeSlug: 'project', name: 'Project A', now: NOW });
    db.insertEntity({ entityId: 'ent-b', typeSlug: 'organization', name: 'Organization B', now: NOW });
  });

  test('insertRelationship stores typed edges with stable qualifier JSON', () => {
    const relationship = db.insertRelationship({
      relationshipId: 'rel-1',
      subjectEntityId: 'ent-a',
      predicate: 'depends_on',
      objectEntityId: 'ent-b',
      qualifiers: { phase: 'planning', priority: 2 },
      confidence: 0.66,
      now: NOW,
    });

    expect(relationship).toMatchObject({
      relationshipId: 'rel-1',
      subjectEntityId: 'ent-a',
      predicate: 'depends_on',
      objectEntityId: 'ent-b',
      status: 'active',
      confidence: 0.66,
      qualifiers: { phase: 'planning', priority: 2 },
    });
    expect(db.listRelationshipsForEntity('ent-b')).toHaveLength(1);

    expect(() => db.insertRelationship({
      relationshipId: 'rel-duplicate',
      subjectEntityId: 'ent-a',
      predicate: 'depends_on',
      objectEntityId: 'ent-b',
      qualifiers: { priority: 2, phase: 'planning' },
      now: NOW,
    })).toThrow();
    expect(db.updateRelationship('rel-1', {
      predicate: 'uses',
      status: 'superseded',
      confidence: 0.55,
      qualifiers: { source: 'review' },
      updatedAt: '2026-05-07T20:15:00.000Z',
    })).toMatchObject({
      relationshipId: 'rel-1',
      predicate: 'uses',
      status: 'superseded',
      confidence: 0.55,
      qualifiers: { source: 'review' },
      updatedAt: '2026-05-07T20:15:00.000Z',
    });
  });

  test('evidence refs dedupe by source + locator and link to targets', () => {
    const first = db.upsertEvidenceRef({
      evidenceId: 'ev-1',
      sourceType: 'conversation_message',
      sourceId: 'conv-1/msg-1',
      locator: { line: 12, path: 'session-1.json' },
      excerpt: 'Source excerpt',
      now: NOW,
    });
    const second = db.upsertEvidenceRef({
      evidenceId: 'ev-2',
      sourceType: 'conversation_message',
      sourceId: 'conv-1/msg-1',
      locator: { path: 'session-1.json', line: 12 },
      excerpt: 'Updated excerpt',
      now: NOW,
    });

    expect(second.evidenceId).toBe(first.evidenceId);
    expect(second.excerpt).toBe('Updated excerpt');

    db.linkEvidence('entity', 'ent-a', first.evidenceId, NOW);
    db.linkEvidence('entity', 'ent-a', first.evidenceId, NOW);

    expect(db.listEvidenceForTarget('entity', 'ent-a')).toMatchObject([
      {
        evidenceId: 'ev-1',
        sourceType: 'conversation_message',
        sourceId: 'conv-1/msg-1',
        locator: { line: 12, path: 'session-1.json' },
        excerpt: 'Updated excerpt',
      },
    ]);
  });
});

describe('runs, cursors, candidates, and audit', () => {
  test('run/source-span/cursor records make incremental processing idempotent', () => {
    db.insertRun({
      runId: 'run-1',
      source: 'scheduled',
      startedAt: NOW,
      metadata: { reason: 'interval' },
    });
    db.insertSourceSpan({
      spanId: 'span-1',
      runId: 'run-1',
      conversationId: 'conv-1',
      sessionEpoch: 2,
      startMessageId: 'msg-1',
      endMessageId: 'msg-3',
      sourceHash: 'hash-1',
      processedAt: NOW,
    });
    db.upsertConversationCursor({
      conversationId: 'conv-1',
      sessionEpoch: 2,
      lastProcessedMessageId: 'msg-3',
      lastProcessedAt: NOW,
      lastProcessedSourceHash: 'hash-1',
    });
    db.upsertSourceCursor({
      sourceType: 'file',
      sourceId: 'README.md',
      lastProcessedSourceHash: 'source-hash-1',
      lastProcessedAt: NOW,
      lastSeenAt: NOW,
      lastRunId: 'run-1',
    });

    expect(db.hasSourceSpan('conv-1', 2, 'msg-1', 'msg-3', 'hash-1')).toBe(true);
    expect(db.listSourceSpans('conv-1')).toMatchObject([
      {
        spanId: 'span-1',
        runId: 'run-1',
        conversationId: 'conv-1',
        sessionEpoch: 2,
        startMessageId: 'msg-1',
        endMessageId: 'msg-3',
        sourceHash: 'hash-1',
      },
    ]);
    expect(() => db.insertSourceSpan({
      spanId: 'span-duplicate',
      runId: 'run-1',
      conversationId: 'conv-1',
      sessionEpoch: 2,
      startMessageId: 'msg-1',
      endMessageId: 'msg-3',
      sourceHash: 'hash-1',
      processedAt: NOW,
    })).toThrow();
    expect(db.getConversationCursor('conv-1')).toMatchObject({
      conversationId: 'conv-1',
      sessionEpoch: 2,
      lastProcessedMessageId: 'msg-3',
      lastProcessedSourceHash: 'hash-1',
    });
    expect(db.listConversationCursors()).toMatchObject([
      {
        conversationId: 'conv-1',
        sessionEpoch: 2,
        lastProcessedMessageId: 'msg-3',
      },
    ]);
    expect(db.getSourceCursor('file', 'README.md')).toMatchObject({
      sourceType: 'file',
      sourceId: 'README.md',
      lastProcessedSourceHash: 'source-hash-1',
      status: 'active',
      lastRunId: 'run-1',
    });
    db.markSourceCursorMissing('file', 'README.md', '2026-05-07T20:04:00.000Z', 'run-1');
    expect(db.listSourceCursors({ status: 'missing' })).toMatchObject([
      {
        sourceType: 'file',
        sourceId: 'README.md',
        status: 'missing',
        lastProcessedSourceHash: 'source-hash-1',
      },
    ]);
    db.upsertSourceCursor({
      sourceType: 'file',
      sourceId: 'README.md',
      lastProcessedSourceHash: 'source-hash-2',
      lastProcessedAt: '2026-05-07T20:05:00.000Z',
      lastSeenAt: '2026-05-07T20:05:00.000Z',
      lastRunId: 'run-1',
    });
    expect(db.getSourceCursor('file', 'README.md')).toMatchObject({
      status: 'active',
      errorMessage: null,
      lastProcessedSourceHash: 'source-hash-2',
    });
    expect(db.finishRun('run-1', 'completed', '2026-05-07T20:05:00.000Z')).toMatchObject({
      runId: 'run-1',
      status: 'completed',
      completedAt: '2026-05-07T20:05:00.000Z',
      metadata: { reason: 'interval' },
    });
    expect(db.listRuns()).toMatchObject([
      {
        runId: 'run-1',
        source: 'scheduled',
        status: 'completed',
      },
    ]);
  });

  test('candidates and audit events persist review state', () => {
    db.insertRun({ runId: 'run-1', source: 'initial_scan', startedAt: NOW });
    db.insertCandidate({
      candidateId: 'cand-1',
      runId: 'run-1',
      candidateType: 'new_entity',
      payload: { name: 'Candidate entity', typeSlug: 'project' },
      confidence: 0.71,
      now: NOW,
    });

    expect(db.listCandidates('pending')).toMatchObject([
      {
        candidateId: 'cand-1',
        runId: 'run-1',
        candidateType: 'new_entity',
        status: 'pending',
        payload: { name: 'Candidate entity', typeSlug: 'project' },
        confidence: 0.71,
      },
    ]);

    db.updateCandidateStatus('cand-1', 'active', '2026-05-07T20:10:00.000Z', {
      appliedAt: '2026-05-07T20:10:00.000Z',
    });
    expect(db.getCandidate('cand-1')).toMatchObject({
      status: 'active',
      appliedAt: '2026-05-07T20:10:00.000Z',
    });

    db.updateCandidateReview('cand-1', {
      payload: { name: 'Edited candidate entity', typeSlug: 'project' },
      confidence: 0.9,
      updatedAt: '2026-05-07T20:12:00.000Z',
    });
    expect(db.getCandidate('cand-1')).toMatchObject({
      payload: { name: 'Edited candidate entity', typeSlug: 'project' },
      confidence: 0.9,
      updatedAt: '2026-05-07T20:12:00.000Z',
    });

    db.insertAuditEvent({
      eventId: 'audit-1',
      targetKind: 'candidate',
      targetId: 'cand-1',
      eventType: 'approved',
      details: { reviewer: 'user' },
      createdAt: '2026-05-07T20:10:00.000Z',
    });
    expect(db.listAuditEvents('candidate', 'cand-1')).toMatchObject([
      {
        eventId: 'audit-1',
        targetKind: 'candidate',
        targetId: 'cand-1',
        eventType: 'approved',
        details: { reviewer: 'user' },
      },
    ]);
  });

  test('clearAll removes graph and processing state while preserving system entity types', () => {
    db.upsertEntityType({
      typeSlug: 'custom-type',
      label: 'Custom Type',
      origin: 'processor',
      now: NOW,
    });
    db.insertRun({ runId: 'run-1', source: 'initial_scan', startedAt: NOW });
    db.upsertSourceCursor({
      sourceType: 'file',
      sourceId: 'README.md',
      lastProcessedSourceHash: 'source-hash-1',
      lastProcessedAt: NOW,
      lastSeenAt: NOW,
      lastRunId: 'run-1',
    });
    db.insertEntity({ entityId: 'ent-1', typeSlug: 'project', name: 'Project', now: NOW });
    db.addAlias('ent-1', 'Alias', NOW);
    db.insertFact({ factId: 'fact-1', entityId: 'ent-1', statementMarkdown: 'Fact.', now: NOW });
    db.insertCandidate({
      candidateId: 'cand-1',
      runId: 'run-1',
      candidateType: 'new_entity',
      payload: { name: 'Candidate' },
      now: NOW,
    });

    const result = db.clearAll();

    expect(result).toMatchObject({
      candidates: 1,
      sourceCursors: 1,
      runs: 1,
      entities: 1,
      aliases: 1,
      facts: 1,
      entityTypes: 1,
    });
    expect(db.listCandidates()).toHaveLength(0);
    expect(db.listSourceCursors()).toHaveLength(0);
    expect(db.listRuns()).toHaveLength(0);
    expect(db.listEntities()).toHaveLength(0);
    expect(db.getEntityType('project')).toBeTruthy();
    expect(db.getEntityType('custom-type')).toBeNull();
  });
});
