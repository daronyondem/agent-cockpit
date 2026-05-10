import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';

interface WorkspaceIndex {
  workspacePath?: string;
}

interface CandidateRow {
  candidate_id: string;
  candidate_type: string;
  status: string;
  confidence: number;
  payload_json: string;
}

interface SourceCursorCountRow {
  source_type: string;
  status: string;
  count: number;
}

interface SourceCursorRow {
  source_type: string;
  source_id: string;
  last_processed_at: string;
  last_seen_at: string;
  status: string;
  error_message: string | null;
}

const NON_CANONICAL_FACT_KEYS = ['factsMarkdown', 'factMarkdown', 'keyFacts', 'durableFacts', 'factStatements'];
const AUTO_APPLY_MIN_CONFIDENCE: Record<string, number> = {
  new_entity: 0.8,
  entity_update: 0.9,
  new_relationship: 0.8,
  alias_addition: 0.94,
  evidence_link: 0.96,
  sensitivity_classification: 0.96,
};
const BUILT_IN_ENTITY_TYPES = new Set([
  'person',
  'organization',
  'project',
  'workflow',
  'document',
  'feature',
  'concept',
  'decision',
  'tool',
  'asset',
]);
const TYPE_ALIASES = new Map<string, string>([
  ['company', 'organization'],
  ['team', 'organization'],
  ['institution', 'organization'],
  ['org', 'organization'],
  ['product', 'project'],
  ['repo', 'project'],
  ['repository', 'project'],
  ['feature_proposal', 'feature'],
  ['capability', 'feature'],
  ['product_capability', 'feature'],
  ['subsystem', 'concept'],
  ['component', 'concept'],
  ['architecture', 'concept'],
  ['implementation_behavior', 'concept'],
  ['security_policy', 'concept'],
  ['policy', 'concept'],
  ['principle', 'concept'],
  ['document_collection', 'document'],
  ['specification', 'document'],
  ['spec', 'document'],
  ['adr', 'document'],
  ['issue', 'document'],
  ['github_issue', 'document'],
  ['pull_request', 'document'],
  ['github_pull_request', 'document'],
  ['backend', 'tool'],
  ['cli', 'tool'],
]);

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    workspace: { type: 'string', short: 'w' },
    'data-dir': { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

function printUsage(): void {
  console.log(`Usage:
  npm run context-map:report -- --workspace <hash-or-workspace-path>
  npm run context-map:report -- --db data/chat/workspaces/<hash>/context-map/state.db

Options:
  --workspace, -w <value>  Workspace hash or workspace path to resolve under data/chat/workspaces.
  --db <path>             Direct path to context-map/state.db.
  --data-dir <path>       Workspace data root. Defaults to data/chat/workspaces.
  --json                  Print machine-readable JSON.
`);
}

function resolveDbPath(): string {
  if (values.db) return path.resolve(String(values.db));
  const workspace = values.workspace ? String(values.workspace) : '';
  if (!workspace) throw new Error('Provide --workspace or --db.');
  const dataDir = path.resolve(String(values['data-dir'] || path.join(process.cwd(), 'data', 'chat', 'workspaces')));
  const direct = path.join(dataDir, workspace, 'context-map', 'state.db');
  if (fs.existsSync(direct)) return direct;
  const workspacePath = path.resolve(workspace);
  for (const hash of fs.readdirSync(dataDir)) {
    const indexPath = path.join(dataDir, hash, 'index.json');
    if (!fs.existsSync(indexPath)) continue;
    try {
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as WorkspaceIndex;
      if (index.workspacePath && path.resolve(index.workspacePath) === workspacePath) {
        return path.join(dataDir, hash, 'context-map', 'state.db');
      }
    } catch {
      // Ignore malformed workspace indexes in this diagnostic command.
    }
  }
  throw new Error(`Could not resolve Context Map database for workspace: ${workspace}`);
}

function queryAll<T>(db: Database.Database, sql: string, params: unknown[] = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function queryGet<T>(db: Database.Database, sql: string, params: unknown[] = []): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

function jsonValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return jsonValue(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatDurationMs(value: unknown): string {
  const ms = numberValue(value);
  if (ms === null) return 'n/a';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function hasNonStringFact(payload: Record<string, unknown>): boolean {
  return Array.isArray(payload.facts) && payload.facts.some((fact) => typeof fact !== 'string');
}

function hasNonCanonicalFactField(payload: Record<string, unknown>): boolean {
  return NON_CANONICAL_FACT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(payload, key));
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/[`"']/g, '').replace(/\s+/g, ' ');
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function readString(payload: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeFacts(payload: Record<string, unknown>): string[] {
  const facts = payload.facts;
  if (typeof facts === 'string' && facts.trim()) return [facts.trim()];
  if (!Array.isArray(facts)) return [];
  return facts.filter((fact): fact is string => typeof fact === 'string' && fact.trim().length > 0);
}

function normalizeAliases(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0);
}

function normalizeSensitivity(value: string): string {
  const slug = normalizeSlug(value);
  if (!slug) return '';
  if (slug === 'work_sensitive' || slug === 'confidential' || slug === 'private_work_data') return 'work-sensitive';
  if (slug === 'personal_sensitive' || slug === 'private_personal_data' || slug === 'personal_data') return 'personal-sensitive';
  if (slug === 'secret_pointer' || slug === 'secret_pointer_only' || slug === 'secret' || slug === 'credential') return 'secret-pointer';
  if (slug === 'normal') return 'normal';
  return '';
}

function isSelfRelationship(payload: Record<string, unknown>): boolean {
  const subjectName = readString(payload, ['subjectName', 'subjectEntityName']);
  const objectName = readString(payload, ['objectName', 'objectEntityName']);
  return Boolean(subjectName && objectName && normalizeText(subjectName) === normalizeText(objectName));
}

function hasRelationshipEvidence(payload: Record<string, unknown>): boolean {
  return Boolean(readString(payload, ['evidenceMarkdown', 'rationale', 'reason', 'summaryMarkdown']));
}

function hasSourceSpan(payload: Record<string, unknown>): boolean {
  return Boolean(payload.sourceSpan && typeof payload.sourceSpan === 'object' && !Array.isArray(payload.sourceSpan));
}

function isAutoApplyEligible(db: Database.Database, row: CandidateRow): boolean {
  if (row.status !== 'pending') return false;
  const minConfidence = AUTO_APPLY_MIN_CONFIDENCE[row.candidate_type];
  if (minConfidence === undefined || row.confidence < minConfidence) return false;
  const payload = jsonValue(row.payload_json);
  if (!hasSourceSpan(payload)) return false;

  if (row.candidate_type === 'new_entity') {
    const sensitivity = readString(payload, ['sensitivity']);
    const typeSlug = normalizeSlug(readString(payload, ['typeSlug', 'entityType', 'type'])) || 'concept';
    const aliasedType = TYPE_ALIASES.get(typeSlug) || typeSlug;
    return sensitivity !== 'secret-pointer'
      && BUILT_IN_ENTITY_TYPES.has(aliasedType)
      && Boolean(readString(payload, ['summaryMarkdown', 'summary', 'notesMarkdown', 'notes', 'description']) || normalizeFacts(payload).length > 0);
  }

  if (row.candidate_type === 'entity_update') {
    return isAdditiveEntityUpdateEligible(db, payload);
  }

  if (row.candidate_type === 'new_relationship') {
    const predicate = normalizeSlug(readString(payload, ['predicate', 'relationship', 'label']));
    return Boolean(
      predicate
      && predicate !== 'relates_to'
      && hasRelationshipEvidence(payload)
      && !isSelfRelationship(payload)
      && relationshipEndpointsAreActive(db, payload),
    );
  }

  return true;
}

interface ActiveEntityRow {
  entity_id: string;
  type_slug: string;
  name: string;
  status: string;
  summary_markdown: string | null;
  notes_markdown: string | null;
  sensitivity: string;
}

function getActiveEntityUpdateTarget(db: Database.Database, payload: Record<string, unknown>): ActiveEntityRow | null {
  const entityId = readString(payload, ['entityId', 'targetEntityId']);
  if (entityId) {
    return queryGet<ActiveEntityRow>(
      db,
      'SELECT entity_id, type_slug, name, status, summary_markdown, notes_markdown, sensitivity FROM entities WHERE entity_id = ? AND status = ? LIMIT 1',
      [entityId, 'active'],
    ) || null;
  }
  const name = readString(payload, ['entityName', 'name', 'targetName']);
  if (!name) return null;
  const typeSlug = normalizeSlug(readString(payload, ['typeSlug', 'entityType', 'type']));
  const where = typeSlug ? ' AND type_slug = ?' : '';
  const params = typeSlug ? [normalizeText(name), 'active', typeSlug] : [normalizeText(name), 'active'];
  const rows = queryAll<ActiveEntityRow>(
    db,
    `SELECT entity_id, type_slug, name, status, summary_markdown, notes_markdown, sensitivity
     FROM entities
     WHERE lower(name) = ? AND status = ?${where}`,
    params,
  );
  return rows.length === 1 ? rows[0] : null;
}

function isAdditiveEntityUpdateEligible(db: Database.Database, payload: Record<string, unknown>): boolean {
  const entity = getActiveEntityUpdateTarget(db, payload);
  if (!entity) return false;
  if (readString(payload, ['newName', 'updatedName', 'newTypeSlug', 'updatedTypeSlug', 'status'])) return false;
  const sensitivity = normalizeSensitivity(readString(payload, ['sensitivity', 'classification']));
  if (sensitivity && sensitivity !== entity.sensitivity) return false;

  const summary = readString(payload, ['summaryMarkdown', 'summary']);
  if (summary && entity.summary_markdown && normalizeText(summary) !== normalizeText(entity.summary_markdown)) return false;
  const notes = readString(payload, ['notesMarkdown', 'notes']);
  if (notes && entity.notes_markdown && normalizeText(notes) !== normalizeText(entity.notes_markdown)) return false;

  return Boolean(
    normalizeFacts(payload).length > 0
    || normalizeAliases(payload.aliases).length > 0
    || (summary && !entity.summary_markdown)
    || (notes && !entity.notes_markdown)
  );
}

function relationshipEndpointsAreActive(db: Database.Database, payload: Record<string, unknown>): boolean {
  return (['subject', 'object'] as const).every((role) => {
    const entityId = readString(payload, [`${role}EntityId`, `${role}Id`]);
    if (entityId) return hasActiveEntityById(db, entityId);
    const name = readString(payload, [`${role}Name`, `${role}EntityName`]);
    if (!name) return false;
    const typeSlug = normalizeSlug(readString(payload, [`${role}TypeSlug`, `${role}Type`]));
    return hasActiveEntityByName(db, name, typeSlug || undefined);
  });
}

function hasActiveEntityById(db: Database.Database, entityId: string): boolean {
  const row = db.prepare('SELECT 1 FROM entities WHERE entity_id = ? AND status = ? LIMIT 1').get(entityId, 'active');
  return Boolean(row);
}

function hasActiveEntityByName(db: Database.Database, name: string, typeSlug?: string): boolean {
  const normalized = name.trim().toLocaleLowerCase();
  const entityWhere = typeSlug ? ' AND type_slug = ?' : '';
  const entityArgs = typeSlug ? [normalized, 'active', typeSlug] : [normalized, 'active'];
  if (db.prepare(`SELECT 1 FROM entities WHERE lower(name) = ? AND status = ?${entityWhere} LIMIT 1`).get(...entityArgs)) {
    return true;
  }

  const aliasWhere = typeSlug ? ' AND e.type_slug = ?' : '';
  const aliasArgs = typeSlug ? [normalized, 'active', typeSlug] : [normalized, 'active'];
  return Boolean(db.prepare(`
    SELECT 1
    FROM entity_aliases a
    JOIN entities e ON e.entity_id = a.entity_id
    WHERE lower(a.alias) = ? AND e.status = ?${aliasWhere}
    LIMIT 1
  `).get(...aliasArgs));
}

function confidenceBucket(confidence: number): string {
  if (confidence < 0.8) return '<0.80';
  if (confidence < 0.9) return '0.80-0.89';
  if (confidence < 0.96) return '0.90-0.95';
  return '>=0.96';
}

function main(): void {
  if (values.help) {
    printUsage();
    return;
  }
  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) throw new Error(`Context Map database not found: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    const latestRun = queryGet<{
      run_id: string;
      source: string;
      status: string;
      started_at: string;
      completed_at: string | null;
      error_message: string | null;
      metadata_json: string | null;
    }>(db, 'SELECT * FROM context_runs ORDER BY started_at DESC LIMIT 1');
    const candidateCounts = queryAll<{ status: string; candidate_type: string; count: number }>(
      db,
      'SELECT status, candidate_type, COUNT(*) as count FROM context_candidates GROUP BY status, candidate_type ORDER BY status, candidate_type',
    );
    const entityCounts = queryAll<{ type_slug: string; sensitivity: string; count: number }>(
      db,
      'SELECT type_slug, sensitivity, COUNT(*) as count FROM entities GROUP BY type_slug, sensitivity ORDER BY type_slug, sensitivity',
    );
    const relationshipCounts = queryAll<{ status: string; predicate: string; count: number }>(
      db,
      'SELECT status, predicate, COUNT(*) as count FROM relationships GROUP BY status, predicate ORDER BY status, predicate',
    );
    const sourceCursorCounts = queryAll<SourceCursorCountRow>(
      db,
      'SELECT source_type, status, COUNT(*) as count FROM source_cursors GROUP BY source_type, status ORDER BY source_type, status',
    );
    const missingSourceCursors = queryAll<SourceCursorRow>(
      db,
      `SELECT source_type, source_id, last_processed_at, last_seen_at, status, error_message
       FROM source_cursors
       WHERE status = 'missing'
       ORDER BY last_seen_at DESC, source_type, source_id
       LIMIT 20`,
    );
    const candidateRows = queryAll<CandidateRow>(
      db,
      'SELECT candidate_id, candidate_type, status, confidence, payload_json FROM context_candidates',
    );
    const malformedFactCandidates = candidateRows.filter((row) => hasNonStringFact(jsonValue(row.payload_json)));
    const nonCanonicalFactFieldCandidates = candidateRows.filter((row) => hasNonCanonicalFactField(jsonValue(row.payload_json)));
    const selfRelationshipCandidates = candidateRows.filter((row) => (
      row.candidate_type === 'new_relationship' && isSelfRelationship(jsonValue(row.payload_json))
    ));
    const autoApplyEligible = candidateRows.filter((row) => isAutoApplyEligible(db, row));
    const confidenceBuckets = candidateRows.reduce<Record<string, Record<string, number>>>((acc, row) => {
      const type = row.candidate_type;
      const bucket = confidenceBucket(row.confidence);
      if (!acc[type]) acc[type] = {};
      acc[type][bucket] = (acc[type][bucket] || 0) + 1;
      return acc;
    }, {});

    const metadata = jsonValue(latestRun?.metadata_json);
    const candidateSynthesis = recordValue(metadata.candidateSynthesis);
    const synthesisInputTypes = recordValue(candidateSynthesis.inputCandidateTypes);
    const synthesisOutputTypes = recordValue(candidateSynthesis.outputCandidateTypes);
    const relationshipCandidatesDropped = Number(synthesisInputTypes.new_relationship || 0) > 0
      && Number(synthesisOutputTypes.new_relationship || 0) === 0;
    const report = {
      dbPath,
      latestRun: latestRun ? {
        runId: latestRun.run_id,
        source: latestRun.source,
        status: latestRun.status,
        startedAt: latestRun.started_at,
        completedAt: latestRun.completed_at,
        errorMessage: latestRun.error_message,
        sourcePacketsDiscovered: metadata.sourcePacketsDiscovered ?? null,
        sourcePacketsProcessed: metadata.sourcePacketsProcessed ?? null,
        sourcePacketsSucceeded: metadata.sourcePacketsSucceeded ?? null,
        sourcePacketsSkippedUnchanged: metadata.sourcePacketsSkippedUnchanged ?? null,
        sourceCursorsMarkedMissing: metadata.sourceCursorsMarkedMissing ?? null,
        staleSources: metadata.staleSources ?? null,
        extractionUnitsFailed: metadata.extractionUnitsFailed ?? null,
        candidateSynthesis: metadata.candidateSynthesis ?? null,
        timings: metadata.timings ?? null,
        candidatesInserted: metadata.candidatesInserted ?? null,
        candidatesAutoApplied: metadata.candidatesAutoApplied ?? null,
        candidatesNeedingAttention: metadata.candidatesNeedingAttention ?? null,
      } : null,
      candidateCounts,
      entityCounts,
      relationshipCounts,
      sourceCursors: {
        counts: sourceCursorCounts,
        missing: missingSourceCursors.map((row) => ({
          sourceType: row.source_type,
          sourceId: row.source_id,
          lastProcessedAt: row.last_processed_at,
          lastSeenAt: row.last_seen_at,
          status: row.status,
          errorMessage: row.error_message,
        })),
      },
      confidenceBuckets,
      autoApplyEligibility: {
        eligiblePendingCount: autoApplyEligible.length,
        byType: autoApplyEligible.reduce<Record<string, number>>((acc, row) => {
          acc[row.candidate_type] = (acc[row.candidate_type] || 0) + 1;
          return acc;
        }, {}),
      },
      warnings: {
        malformedFactCandidates: malformedFactCandidates.map((row) => ({
          candidateId: row.candidate_id,
          candidateType: row.candidate_type,
        })),
        nonCanonicalFactFieldCandidates: nonCanonicalFactFieldCandidates.map((row) => ({
          candidateId: row.candidate_id,
          candidateType: row.candidate_type,
        })),
        selfRelationshipCandidates: selfRelationshipCandidates.map((row) => ({
          candidateId: row.candidate_id,
          candidateType: row.candidate_type,
        })),
        relationshipCandidatesDropped: relationshipCandidatesDropped
          ? {
            input: Number(synthesisInputTypes.new_relationship || 0),
            output: Number(synthesisOutputTypes.new_relationship || 0),
          }
          : null,
      },
    };

    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`Context Map report: ${dbPath}`);
    if (!report.latestRun) {
      console.log('No runs recorded.');
      return;
    }
    console.log(`Latest run: ${report.latestRun.status} ${report.latestRun.source} ${report.latestRun.startedAt}`);
    console.log([
      `Extraction: packets ${report.latestRun.sourcePacketsSucceeded ?? 0}/${report.latestRun.sourcePacketsProcessed ?? 0}`,
      `discovered ${report.latestRun.sourcePacketsDiscovered ?? 0}`,
      `skipped unchanged ${report.latestRun.sourcePacketsSkippedUnchanged ?? 0}`,
      `missing sources ${report.latestRun.sourceCursorsMarkedMissing ?? 0}`,
      `failures ${report.latestRun.extractionUnitsFailed ?? 0}`,
    ].join(', '));
    const synthesis = report.latestRun.candidateSynthesis as Record<string, unknown> | null;
    if (synthesis) {
      console.log(`Synthesis: ${synthesis.inputCandidates ?? 0} -> ${synthesis.outputCandidates ?? 0}, fallback ${Boolean(synthesis.fallback)}`);
    }
    const timings = recordValue(report.latestRun.timings);
    if (Object.keys(timings).length > 0) {
      console.log([
        `Timings: total ${formatDurationMs(timings.totalMs)}`,
        `planning ${formatDurationMs(timings.planningMs)}`,
        `source discovery ${formatDurationMs(timings.sourceDiscoveryMs)}`,
        `extraction ${formatDurationMs(timings.extractionMs)}`,
        `synthesis ${formatDurationMs(timings.synthesisMs)}`,
        `persistence ${formatDurationMs(timings.persistenceMs)}`,
        `auto-apply ${formatDurationMs(timings.autoApplyMs)}`,
      ].join(', '));
      const extractionUnits = recordValue(timings.extractionUnits);
      const slowestUnits = Array.isArray(extractionUnits.slowest)
        ? extractionUnits.slowest.slice(0, 5).map(recordValue)
        : [];
      if (slowestUnits.length > 0) {
        console.log(`Slowest extraction units: ${slowestUnits.map((unit) => [
          `${unit.sourceType || 'unknown'}:${unit.sourceId || 'unknown'}`,
          formatDurationMs(unit.durationMs),
          unit.status || 'unknown',
          `${unit.candidates ?? 0} candidates`,
        ].join(' ')).join('; ')}`);
      }
      const synthesisStages = Array.isArray(timings.synthesisStages)
        ? timings.synthesisStages
          .slice()
          .map(recordValue)
          .sort((a, b) => (numberValue(b.durationMs) || 0) - (numberValue(a.durationMs) || 0))
          .slice(0, 5)
        : [];
      if (synthesisStages.length > 0) {
        console.log(`Slowest synthesis stages: ${synthesisStages.map((stage) => [
          `${stage.stage || 'unknown'}${stage.chunkId ? `:${stage.chunkId}` : ''}`,
          formatDurationMs(stage.durationMs),
          `${stage.inputCandidates ?? 0}->${stage.outputCandidates ?? 0}`,
          stage.fallback ? 'fallback' : 'ok',
        ].join(' ')).join('; ')}`);
      }
    }
    console.log(`Candidates: inserted ${report.latestRun.candidatesInserted ?? 0}, auto-applied ${report.latestRun.candidatesAutoApplied ?? 0}, needs attention ${report.latestRun.candidatesNeedingAttention ?? 0}`);
    console.log(`Candidate counts: ${JSON.stringify(candidateCounts)}`);
    console.log(`Confidence buckets: ${JSON.stringify(confidenceBuckets)}`);
    console.log(`Auto-apply eligible pending: ${report.autoApplyEligibility.eligiblePendingCount} ${JSON.stringify(report.autoApplyEligibility.byType)}`);
    console.log(`Entity counts: ${JSON.stringify(entityCounts)}`);
    console.log(`Relationship counts: ${JSON.stringify(relationshipCounts)}`);
    console.log(`Source cursor counts: ${JSON.stringify(report.sourceCursors.counts)}`);
    if (report.sourceCursors.missing.length > 0) {
      console.log(`Missing source cursors: ${JSON.stringify(report.sourceCursors.missing)}`);
    }
    const warningParts = [
      malformedFactCandidates.length ? `${malformedFactCandidates.length} candidates have non-string facts` : '',
      nonCanonicalFactFieldCandidates.length ? `${nonCanonicalFactFieldCandidates.length} candidates use non-canonical fact fields` : '',
      selfRelationshipCandidates.length ? `${selfRelationshipCandidates.length} self-relationship candidates` : '',
      relationshipCandidatesDropped ? `${Number(synthesisInputTypes.new_relationship || 0)} relationship candidates dropped before persistence` : '',
    ].filter(Boolean);
    if (warningParts.length > 0) {
      console.log(`Warnings: ${warningParts.join('; ')}.`);
    }
  } finally {
    db.close();
  }
}

main();
