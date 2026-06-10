import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { KbDigestChunkProgress } from '../../../types';
import type { DigestSessionRow } from './types';

export function getDigestSession(db: BetterSqlite3Database): DigestSessionRow | null {
  const row = db
    .prepare<
      unknown[],
      {
        total: number;
        done: number;
        total_elapsed_ms: number;
        started_at: string;
        chunk_progress_json: string | null;
      }
    >(
      'SELECT total, done, total_elapsed_ms, started_at, chunk_progress_json FROM digest_session WHERE id = 1',
    )
    .get();
  if (!row) return null;
  return {
    total: row.total,
    done: row.done,
    totalElapsedMs: row.total_elapsed_ms,
    startedAt: row.started_at,
    chunkProgress: parseDigestChunkProgress(row.chunk_progress_json),
  };
}

export function upsertDigestSession(
  db: BetterSqlite3Database,
  row: DigestSessionRow,
): void {
  db
    .prepare(
      `INSERT INTO digest_session (id, total, done, total_elapsed_ms, started_at, chunk_progress_json)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           total = excluded.total,
           done = excluded.done,
           total_elapsed_ms = excluded.total_elapsed_ms,
           started_at = excluded.started_at,
           chunk_progress_json = excluded.chunk_progress_json`,
    )
    .run(
      row.total,
      row.done,
      row.totalElapsedMs,
      row.startedAt,
      row.chunkProgress ? JSON.stringify(row.chunkProgress) : null,
    );
}

export function clearDigestSession(db: BetterSqlite3Database): void {
  db.prepare('DELETE FROM digest_session').run();
}

function parseDigestChunkProgress(raw: string | null): KbDigestChunkProgress | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<KbDigestChunkProgress>;
    if (!parsed || typeof parsed !== 'object') return null;
    const phase = parsed.phase === 'digesting' ||
      parsed.phase === 'parsing' ||
      parsed.phase === 'committing' ||
      parsed.phase === 'planning'
      ? parsed.phase
      : 'planning';
    const progress: KbDigestChunkProgress = {
      done: Math.max(0, Number(parsed.done) || 0),
      total: Math.max(0, Number(parsed.total) || 0),
      active: Math.max(0, Number(parsed.active) || 0),
      phase,
    };
    if (parsed.current && typeof parsed.current === 'object' && typeof parsed.current.rawId === 'string') {
      progress.current = {
        rawId: parsed.current.rawId,
        chunkId: typeof parsed.current.chunkId === 'string' ? parsed.current.chunkId : undefined,
        index: typeof parsed.current.index === 'number' && Number.isFinite(parsed.current.index) ? parsed.current.index : undefined,
        total: typeof parsed.current.total === 'number' && Number.isFinite(parsed.current.total) ? parsed.current.total : undefined,
        startUnit: typeof parsed.current.startUnit === 'number' && Number.isFinite(parsed.current.startUnit) ? parsed.current.startUnit : undefined,
        endUnit: typeof parsed.current.endUnit === 'number' && Number.isFinite(parsed.current.endUnit) ? parsed.current.endUnit : undefined,
        unitType: typeof parsed.current.unitType === 'string' ? parsed.current.unitType : undefined,
      };
    }
    return progress;
  } catch {
    return null;
  }
}
