import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import { countStaleReflections } from './reflections';
import type {
  InsertTopicHistoryParams,
  SynthesisRunMode,
  SynthesisRunRow,
  SynthesisRunStatus,
  SynthesisSnapshot,
  SynthesisTopicHistoryRow,
} from './types';

/** Get a synthesis_meta value by key, or null if missing. */
export function getSynthesisMeta(db: BetterSqlite3Database, key: string): string | null {
  const row = db
    .prepare<unknown[], { value: string }>(
      'SELECT value FROM synthesis_meta WHERE key = ?',
    )
    .get(key);
  return row?.value ?? null;
}

/** Set a synthesis_meta value (upsert). */
export function setSynthesisMeta(db: BetterSqlite3Database, key: string, value: string): void {
  db
    .prepare(
      'INSERT INTO synthesis_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value);
}

/** Get the full synthesis status snapshot for API responses. */
export function getSynthesisSnapshot(db: BetterSqlite3Database): SynthesisSnapshot {
  const status = getSynthesisMeta(db, 'status') ?? 'idle';
  const lastRunAt = getSynthesisMeta(db, 'last_run_at');
  const lastRunError = getSynthesisMeta(db, 'last_run_error');
  const godNodesRaw = getSynthesisMeta(db, 'god_nodes');
  const godNodes: string[] = godNodesRaw ? JSON.parse(godNodesRaw) : [];
  const dreamProgressRaw = getSynthesisMeta(db, 'dream_progress');
  let dreamProgress: SynthesisSnapshot['dreamProgress'] = null;
  if (dreamProgressRaw) {
    try { dreamProgress = JSON.parse(dreamProgressRaw); } catch { /* ignore */ }
  }

  const topicCountRow = db
    .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM synthesis_topics')
    .get();
  const connCountRow = db
    .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM synthesis_connections')
    .get();
  const needsRow = db
    .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM entries WHERE needs_synthesis = 1')
    .get();

  const reflectionCountRow = db
    .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM synthesis_reflections')
    .get();
  const staleReflectionCount = countStaleReflections(db);

  return {
    status,
    lastRunAt,
    lastRunError,
    topicCount: topicCountRow?.n ?? 0,
    connectionCount: connCountRow?.n ?? 0,
    needsSynthesisCount: needsRow?.n ?? 0,
    godNodes,
    dreamProgress,
    reflectionCount: reflectionCountRow?.n ?? 0,
    staleReflectionCount,
  };
}

export function startSynthesisRun(
  db: BetterSqlite3Database,
  runId: string,
  mode: SynthesisRunMode,
  startedAt: string,
): void {
  db
    .prepare(
      `INSERT INTO synthesis_runs (run_id, mode, status, started_at, completed_at, error_message)
         VALUES (?, ?, 'running', ?, NULL, NULL)`,
    )
    .run(runId, mode, startedAt);
}

export function finishSynthesisRun(
  db: BetterSqlite3Database,
  runId: string,
  status: Exclude<SynthesisRunStatus, 'running'>,
  completedAt: string,
  errorMessage: string | null = null,
): void {
  db
    .prepare(
      `UPDATE synthesis_runs
         SET status = ?, completed_at = ?, error_message = ?
         WHERE run_id = ?`,
    )
    .run(status, completedAt, errorMessage, runId);
}

export function getSynthesisRun(
  db: BetterSqlite3Database,
  runId: string,
): SynthesisRunRow | null {
  const row = db
    .prepare<
      unknown[],
      { run_id: string; mode: SynthesisRunMode; status: SynthesisRunStatus; started_at: string; completed_at: string | null; error_message: string | null }
    >(
      `SELECT run_id, mode, status, started_at, completed_at, error_message
         FROM synthesis_runs
         WHERE run_id = ?`,
    )
    .get(runId);
  return row ? mapSynthesisRun(row) : null;
}

export function listSynthesisRuns(db: BetterSqlite3Database, limit = 50): SynthesisRunRow[] {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const rows = db
    .prepare<
      unknown[],
      { run_id: string; mode: SynthesisRunMode; status: SynthesisRunStatus; started_at: string; completed_at: string | null; error_message: string | null }
    >(
      `SELECT run_id, mode, status, started_at, completed_at, error_message
         FROM synthesis_runs
         ORDER BY started_at DESC
         LIMIT ?`,
    )
    .all(safeLimit);
  return rows.map((row) => mapSynthesisRun(row));
}

export function insertTopicHistory(
  db: BetterSqlite3Database,
  params: InsertTopicHistoryParams,
): SynthesisTopicHistoryRow {
  const entryIdsJson = JSON.stringify(params.entryIds);
  const result = db
    .prepare(
      `INSERT INTO synthesis_topic_history
           (topic_id, change_type, old_content, new_content, entry_ids, run_id, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.topicId,
      params.changeType,
      params.oldContent,
      params.newContent,
      entryIdsJson,
      params.runId ?? null,
      params.changedAt,
    );
  return {
    id: Number(result.lastInsertRowid),
    ...params,
    runId: params.runId ?? null,
    entryIds: params.entryIds,
  };
}

export function listTopicHistory(
  db: BetterSqlite3Database,
  topicId?: string,
): SynthesisTopicHistoryRow[] {
  const select =
    `SELECT id, topic_id, change_type, old_content, new_content, entry_ids, run_id, changed_at
       FROM synthesis_topic_history`;
  const order = ' ORDER BY changed_at DESC, id DESC';
  const rows = topicId
    ? db
      .prepare<
        unknown[],
        { id: number; topic_id: string; change_type: InsertTopicHistoryParams['changeType']; old_content: string | null; new_content: string | null; entry_ids: string | null; run_id: string | null; changed_at: string }
      >(`${select} WHERE topic_id = ?${order}`)
      .all(topicId)
    : db
      .prepare<
        unknown[],
        { id: number; topic_id: string; change_type: InsertTopicHistoryParams['changeType']; old_content: string | null; new_content: string | null; entry_ids: string | null; run_id: string | null; changed_at: string }
      >(`${select}${order}`)
      .all();
  return rows.map((row) => mapTopicHistory(row));
}

/** Count entries that need synthesis. */
export function countNeedsSynthesis(db: BetterSqlite3Database): number {
  const row = db
    .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM entries WHERE needs_synthesis = 1')
    .get();
  return row?.n ?? 0;
}

/** List entry IDs that need synthesis (for the dreaming pipeline). */
export function listNeedsSynthesisEntryIds(db: BetterSqlite3Database): string[] {
  return db
    .prepare<unknown[], { entry_id: string }>(
      'SELECT entry_id FROM entries WHERE needs_synthesis = 1 ORDER BY entry_id',
    )
    .all()
    .map((r) => r.entry_id);
}

/** Mark entries as no longer needing synthesis. */
export function clearNeedsSynthesis(
  db: BetterSqlite3Database,
  entryIds: string[],
): void {
  if (entryIds.length === 0) return;
  const placeholders = entryIds.map(() => '?').join(', ');
  db
    .prepare(`UPDATE entries SET needs_synthesis = 0 WHERE entry_id IN (${placeholders})`)
    .run(...entryIds);
}

/** Mark all entries as needing synthesis (for full rebuild). */
export function markAllNeedsSynthesis(db: BetterSqlite3Database): void {
  db.exec('UPDATE entries SET needs_synthesis = 1');
}

/**
 * When entries are deleted, mark remaining entries that shared a topic
 * with the deleted ones as needing synthesis. This ensures topics
 * referencing deleted content get updated on the next dream run.
 */
export function markCoTopicEntriesStale(
  db: BetterSqlite3Database,
  deletedEntryIds: string[],
): void {
  if (deletedEntryIds.length === 0) return;
  const placeholders = deletedEntryIds.map(() => '?').join(', ');
  // Find all entries that share a topic with any of the deleted entries,
  // excluding the deleted entries themselves.
  db
    .prepare(
      `UPDATE entries SET needs_synthesis = 1
         WHERE entry_id IN (
           SELECT DISTINCT ste2.entry_id
           FROM synthesis_topic_entries ste1
           JOIN synthesis_topic_entries ste2 ON ste1.topic_id = ste2.topic_id
           WHERE ste1.entry_id IN (${placeholders})
             AND ste2.entry_id NOT IN (${placeholders})
         )`,
    )
    .run(...deletedEntryIds, ...deletedEntryIds);
}

function mapSynthesisRun(row: {
  run_id: string;
  mode: SynthesisRunMode;
  status: SynthesisRunStatus;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
}): SynthesisRunRow {
  return {
    runId: row.run_id,
    mode: row.mode,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
  };
}

function mapTopicHistory(row: {
  id: number;
  topic_id: string;
  change_type: InsertTopicHistoryParams['changeType'];
  old_content: string | null;
  new_content: string | null;
  entry_ids: string | null;
  run_id: string | null;
  changed_at: string;
}): SynthesisTopicHistoryRow {
  let entryIds: string[] = [];
  if (row.entry_ids) {
    try {
      const parsed = JSON.parse(row.entry_ids);
      if (Array.isArray(parsed)) {
        entryIds = parsed.filter((id): id is string => typeof id === 'string');
      }
    } catch {
      entryIds = [];
    }
  }
  return {
    id: row.id,
    topicId: row.topic_id,
    changeType: row.change_type,
    oldContent: row.old_content,
    newContent: row.new_content,
    entryIds,
    runId: row.run_id,
    changedAt: row.changed_at,
  };
}
