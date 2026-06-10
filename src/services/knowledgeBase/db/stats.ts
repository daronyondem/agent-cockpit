import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { KbCounters, KbRawStatus } from '../../../types';
import { countStaleReflections } from './reflections';

export function getCounters(db: BetterSqlite3Database): KbCounters {
  const byStatusRows = db
    .prepare<unknown[], { status: string; n: number }>(
      'SELECT status, COUNT(*) AS n FROM raw GROUP BY status',
    )
    .all();
  const rawByStatus: Record<KbRawStatus, number> = {
    ingesting: 0,
    ingested: 0,
    digesting: 0,
    digested: 0,
    failed: 0,
    'pending-delete': 0,
  };
  let rawTotal = 0;
  for (const row of byStatusRows) {
    if (row.status in rawByStatus) {
      rawByStatus[row.status as KbRawStatus] = row.n;
    }
    rawTotal += row.n;
  }
  const failedByStageRow = db
    .prepare<
      unknown[],
      {
        conversion: number;
        digestion: number;
      }
    >(
      `SELECT
           COALESCE(SUM(CASE WHEN r.status = 'failed' AND d.raw_id IS NULL THEN 1 ELSE 0 END), 0) AS conversion,
           COALESCE(SUM(CASE WHEN r.status = 'failed' AND d.raw_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS digestion
         FROM raw r
         LEFT JOIN kb_documents d ON d.raw_id = r.raw_id`,
    )
    .get();
  const conversionFailedCount = failedByStageRow?.conversion ?? 0;
  const digestionFailedCount = failedByStageRow?.digestion ?? 0;
  const failedByStage = {
    conversion: conversionFailedCount,
    digestion: digestionFailedCount,
    unknown: Math.max(0, rawByStatus.failed - conversionFailedCount - digestionFailedCount),
  };
  const entryCountRow = db
    .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM entries')
    .get();
  const folderCountRow = db
    .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM folders')
    .get();
  const documentCountRow = db
    .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM kb_documents')
    .get();
  const documentNodeCountRow = db
    .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM kb_document_nodes')
    .get();
  const entrySourceCountRow = db
    .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM kb_entry_sources')
    .get();
  const topicCountRow = db
    .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM synthesis_topics')
    .get();
  const connectionCountRow = db
    .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM synthesis_connections')
    .get();
  const reflectionCountRow = db
    .prepare<unknown[], { n: number }>('SELECT COUNT(*) AS n FROM synthesis_reflections')
    .get();
  const staleReflectionCount = countStaleReflections(db);
  return {
    rawTotal,
    rawByStatus,
    failedByStage,
    entryCount: entryCountRow?.n ?? 0,
    pendingCount: rawByStatus.ingested + rawByStatus['pending-delete'],
    folderCount: folderCountRow?.n ?? 0,
    documentCount: documentCountRow?.n ?? 0,
    documentNodeCount: documentNodeCountRow?.n ?? 0,
    entrySourceCount: entrySourceCountRow?.n ?? 0,
    topicCount: topicCountRow?.n ?? 0,
    connectionCount: connectionCountRow?.n ?? 0,
    reflectionCount: reflectionCountRow?.n ?? 0,
    staleReflectionCount,
  };
}
