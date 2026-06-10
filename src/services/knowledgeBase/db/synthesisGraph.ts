import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { setSynthesisMeta } from './synthesis';
import type {
  InsertConnectionParams,
  SynthesisConnectionRow,
  SynthesisTopicRow,
  UpsertTopicParams,
} from './types';

export function upsertTopic(db: BetterSqlite3Database, params: UpsertTopicParams): void {
  db
    .prepare(
      `INSERT INTO synthesis_topics (topic_id, title, summary, content, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(topic_id) DO UPDATE SET
           title = excluded.title,
           summary = excluded.summary,
           content = excluded.content,
           updated_at = excluded.updated_at`,
    )
    .run(params.topicId, params.title, params.summary, params.content, params.updatedAt);
}

export function deleteTopic(db: BetterSqlite3Database, topicId: string): void {
  // CASCADE deletes synthesis_topic_entries and synthesis_connections rows.
  db
    .prepare('DELETE FROM synthesis_topics WHERE topic_id = ?')
    .run(topicId);
}

/**
 * Delete topics that have zero entries assigned. Called after entry
 * cascade-deletes (e.g. raw file deletion) to clean up orphans.
 */
export function deleteOrphanTopics(db: BetterSqlite3Database): void {
  db.exec(
    `DELETE FROM synthesis_topics WHERE topic_id NOT IN (
         SELECT DISTINCT topic_id FROM synthesis_topic_entries
       )`,
  );
}

export function getTopic(
  db: BetterSqlite3Database,
  topicId: string,
): SynthesisTopicRow | null {
  const row = db
    .prepare<
      unknown[],
      { topic_id: string; title: string; summary: string | null; content: string | null; updated_at: string }
    >(
      'SELECT topic_id, title, summary, content, updated_at FROM synthesis_topics WHERE topic_id = ?',
    )
    .get(topicId);
  if (!row) return null;

  const entryCount = db
    .prepare<unknown[], { n: number }>(
      'SELECT COUNT(*) AS n FROM synthesis_topic_entries WHERE topic_id = ?',
    )
    .get(topicId)?.n ?? 0;

  const connectionCount = db
    .prepare<unknown[], { n: number }>(
      'SELECT COUNT(*) AS n FROM synthesis_connections WHERE source_topic = ? OR target_topic = ?',
    )
    .get(topicId, topicId)?.n ?? 0;

  return {
    topicId: row.topic_id,
    title: row.title,
    summary: row.summary,
    content: row.content,
    updatedAt: row.updated_at,
    entryCount,
    connectionCount,
  };
}

/** List all topics with entry and connection counts. */
export function listTopics(db: BetterSqlite3Database): SynthesisTopicRow[] {
  const rows = db
    .prepare<
      unknown[],
      { topic_id: string; title: string; summary: string | null; content: string | null; updated_at: string; entry_count: number; conn_count: number }
    >(
      `SELECT
           t.topic_id, t.title, t.summary, t.content, t.updated_at,
           (SELECT COUNT(*) FROM synthesis_topic_entries WHERE topic_id = t.topic_id) AS entry_count,
           (SELECT COUNT(*) FROM synthesis_connections WHERE source_topic = t.topic_id OR target_topic = t.topic_id) AS conn_count
         FROM synthesis_topics t
         ORDER BY t.title`,
    )
    .all();
  return rows.map((r) => ({
    topicId: r.topic_id,
    title: r.title,
    summary: r.summary,
    content: r.content,
    updatedAt: r.updated_at,
    entryCount: r.entry_count,
    connectionCount: r.conn_count,
  }));
}

/** List all topics as lightweight summaries (for the all-topics.txt file). */
export function listTopicSummaries(
  db: BetterSqlite3Database,
): Array<{ topicId: string; title: string; summary: string | null }> {
  return db
    .prepare<unknown[], { topic_id: string; title: string; summary: string | null }>(
      'SELECT topic_id, title, summary FROM synthesis_topics ORDER BY title',
    )
    .all()
    .map((r) => ({ topicId: r.topic_id, title: r.title, summary: r.summary }));
}

export function listTopicIds(db: BetterSqlite3Database): string[] {
  return db
    .prepare<unknown[], { topic_id: string }>(
      'SELECT topic_id FROM synthesis_topics ORDER BY topic_id',
    )
    .all()
    .map((r) => r.topic_id);
}

export function assignEntries(
  db: BetterSqlite3Database,
  topicId: string,
  entryIds: string[],
): void {
  if (entryIds.length === 0) return;
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO synthesis_topic_entries (topic_id, entry_id) VALUES (?, ?)',
  );
  for (const eid of entryIds) {
    stmt.run(topicId, eid);
  }
}

export function unassignEntries(
  db: BetterSqlite3Database,
  topicId: string,
  entryIds: string[],
): void {
  if (entryIds.length === 0) return;
  const stmt = db.prepare(
    'DELETE FROM synthesis_topic_entries WHERE topic_id = ? AND entry_id = ?',
  );
  for (const eid of entryIds) {
    stmt.run(topicId, eid);
  }
}

/** List entry IDs assigned to a topic. */
export function listTopicEntryIds(db: BetterSqlite3Database, topicId: string): string[] {
  return db
    .prepare<unknown[], { entry_id: string }>(
      'SELECT entry_id FROM synthesis_topic_entries WHERE topic_id = ? ORDER BY entry_id',
    )
    .all(topicId)
    .map((r) => r.entry_id);
}

/** List topics an entry belongs to. */
export function listEntryTopicIds(db: BetterSqlite3Database, entryId: string): string[] {
  return db
    .prepare<unknown[], { topic_id: string }>(
      'SELECT topic_id FROM synthesis_topic_entries WHERE entry_id = ? ORDER BY topic_id',
    )
    .all(entryId)
    .map((r) => r.topic_id);
}

export function upsertConnection(
  db: BetterSqlite3Database,
  params: InsertConnectionParams,
): void {
  db
    .prepare(
      `INSERT INTO synthesis_connections (source_topic, target_topic, relationship, confidence, evidence)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_topic, target_topic) DO UPDATE SET
           relationship = excluded.relationship,
           confidence = excluded.confidence,
           evidence = excluded.evidence`,
    )
    .run(params.sourceTopic, params.targetTopic, params.relationship, params.confidence, params.evidence);
}

export function removeConnection(
  db: BetterSqlite3Database,
  sourceTopic: string,
  targetTopic: string,
): void {
  db
    .prepare('DELETE FROM synthesis_connections WHERE source_topic = ? AND target_topic = ?')
    .run(sourceTopic, targetTopic);
}

/** List connections for a topic (both directions). */
export function listConnectionsForTopic(
  db: BetterSqlite3Database,
  topicId: string,
): SynthesisConnectionRow[] {
  const rows = db
    .prepare<
      unknown[],
      { source_topic: string; target_topic: string; relationship: string; confidence: string; evidence: string | null }
    >(
      `SELECT source_topic, target_topic, relationship, confidence, evidence
         FROM synthesis_connections
         WHERE source_topic = ? OR target_topic = ?
         ORDER BY source_topic, target_topic`,
    )
    .all(topicId, topicId);
  return rows.map((r) => ({
    sourceTopic: r.source_topic,
    targetTopic: r.target_topic,
    relationship: r.relationship,
    confidence: r.confidence,
    evidence: r.evidence,
  }));
}

/** List all connections (for connections.md generation). */
export function listAllConnections(db: BetterSqlite3Database): SynthesisConnectionRow[] {
  const rows = db
    .prepare<
      unknown[],
      { source_topic: string; target_topic: string; relationship: string; confidence: string; evidence: string | null }
    >(
      'SELECT source_topic, target_topic, relationship, confidence, evidence FROM synthesis_connections ORDER BY source_topic, target_topic',
    )
    .all();
  return rows.map((r) => ({
    sourceTopic: r.source_topic,
    targetTopic: r.target_topic,
    relationship: r.relationship,
    confidence: r.confidence,
    evidence: r.evidence,
  }));
}

/**
 * Find topic pairs that share assigned entries but have no existing
 * connection (either direction). Returns pairs with shared entry count.
 */
export function listTopicPairsBySharedEntries(db: BetterSqlite3Database): Array<{
  topicA: string;
  topicB: string;
  sharedEntryCount: number;
}> {
  const rows = db
    .prepare<
      unknown[],
      { topic_a: string; topic_b: string; shared_count: number }
    >(
      `SELECT ste1.topic_id AS topic_a, ste2.topic_id AS topic_b,
                COUNT(*) AS shared_count
         FROM synthesis_topic_entries ste1
         JOIN synthesis_topic_entries ste2
           ON ste1.entry_id = ste2.entry_id AND ste1.topic_id < ste2.topic_id
         WHERE NOT EXISTS (
           SELECT 1 FROM synthesis_connections
           WHERE (source_topic = ste1.topic_id AND target_topic = ste2.topic_id)
              OR (source_topic = ste2.topic_id AND target_topic = ste1.topic_id)
         )
         GROUP BY ste1.topic_id, ste2.topic_id
         ORDER BY shared_count DESC`,
    )
    .all();
  return rows.map((r) => ({
    topicA: r.topic_a,
    topicB: r.topic_b,
    sharedEntryCount: r.shared_count,
  }));
}

/**
 * Find 2-hop transitive connection candidates: pairs (A, C) where A→B
 * and B→C exist (in either direction) but A↔C has no direct connection.
 * Returns the intermediate topic and both relationship labels.
 */
export function listTransitiveCandidates(db: BetterSqlite3Database): Array<{
  topicA: string;
  topicC: string;
  viaTopicB: string;
  relAB: string;
  relBC: string;
}> {
  const rows = db
    .prepare<
      unknown[],
      { topic_a: string; topic_c: string; via_b: string; rel_ab: string; rel_bc: string }
    >(
      `WITH directed AS (
           SELECT source_topic AS from_t, target_topic AS to_t, relationship
           FROM synthesis_connections
           UNION ALL
           SELECT target_topic AS from_t, source_topic AS to_t, relationship
           FROM synthesis_connections
         )
         SELECT d1.from_t AS topic_a, d2.to_t AS topic_c,
                d1.to_t AS via_b, d1.relationship AS rel_ab, d2.relationship AS rel_bc
         FROM directed d1
         JOIN directed d2 ON d1.to_t = d2.from_t
         WHERE d1.from_t < d2.to_t
           AND d1.from_t != d2.to_t
           AND NOT EXISTS (
             SELECT 1 FROM synthesis_connections
             WHERE (source_topic = d1.from_t AND target_topic = d2.to_t)
                OR (source_topic = d2.to_t AND target_topic = d1.from_t)
           )
         GROUP BY d1.from_t, d2.to_t`,
    )
    .all();
  return rows.map((r) => ({
    topicA: r.topic_a,
    topicC: r.topic_c,
    viaTopicB: r.via_b,
    relAB: r.rel_ab,
    relBC: r.rel_bc,
  }));
}

/** Wipe all synthesis data (for Re-Dream full rebuild). */
export function wipeSynthesis(db: BetterSqlite3Database): void {
  db.transaction(() => {
    db.exec('DELETE FROM synthesis_reflection_citations');
    db.exec('DELETE FROM synthesis_reflections');
    db.exec('DELETE FROM synthesis_connections');
    db.exec('DELETE FROM synthesis_topic_entries');
    db.exec('DELETE FROM synthesis_topics');
    setSynthesisMeta(db, 'last_run_at', '');
    setSynthesisMeta(db, 'last_run_error', '');
    setSynthesisMeta(db, 'god_nodes', '[]');
  })();
}

/**
 * Detect god nodes: topics with disproportionately many entries or
 * connections (> 3× average, minimum 10 entries). Returns topic IDs.
 */
export function detectGodNodes(db: BetterSqlite3Database): string[] {
  const topics = listTopics(db);
  if (topics.length === 0) return [];

  const avgEntries = topics.reduce((sum, t) => sum + t.entryCount, 0) / topics.length;
  const avgConns = topics.reduce((sum, t) => sum + t.connectionCount, 0) / topics.length;
  const entryThreshold = Math.max(avgEntries * 3, 10);
  const connThreshold = Math.max(avgConns * 3, 3);

  return topics
    .filter((t) => t.entryCount > entryThreshold || t.connectionCount > connThreshold)
    .map((t) => t.topicId);
}
