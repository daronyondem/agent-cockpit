/* Account quota projection helpers for ContextChip tooltips.

   The progress-bar width remains actual usage. These helpers calculate the
   projected end-of-cycle usage from the current-cycle average rate so the
   renderer can color the existing bar and add a short text label. */

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const MIN_ELAPSED_FRACTION = 0.05;

export type ProjectionStatus = 'on-track' | 'watch' | 'over' | 'unknown' | 'stale' | 'pending';

export interface ProjectionOptions {
  actualPct?: number | null;
  fetchedAt?: string | null;
  resetAtMs?: number | null;
  durationMs?: number | null;
  stale?: boolean;
}

export interface ProjectionResult {
  status: ProjectionStatus;
  className: string;
  projectedPct: number | null;
  label: string;
}

function finiteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso || typeof iso !== 'string') return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function epochSecondsToMs(seconds: number | null | undefined): number | null {
  return finiteNumber(seconds) ? seconds * 1000 : null;
}

export function durationFromClaudeKey(key: unknown): number | null {
  const k = String(key || '');
  if (k === 'five_hour' || k.startsWith('five_hour_')) return 5 * HOUR_MS;
  if (k === 'seven_day' || k.startsWith('seven_day_')) return 7 * DAY_MS;
  if (/^(hourly|one_hour|hour)(_|$)/.test(k)) return HOUR_MS;
  if (/^(daily|one_day|day|twenty_four_hour)(_|$)/.test(k)) return DAY_MS;
  if (/^(weekly|one_week|week)(_|$)/.test(k)) return 7 * DAY_MS;
  return null;
}

export function projectionClass(status: ProjectionStatus): string {
  if (status === 'on-track') return 'tt-bar-proj-on-track';
  if (status === 'watch') return 'tt-bar-proj-watch';
  if (status === 'over') return 'tt-bar-proj-over';
  return 'tt-bar-proj-unknown';
}

function formatProjectedPct(pct: number): string {
  if (!finiteNumber(pct)) return '';
  if (pct > 999) return '>999%';
  return Math.round(Math.max(0, pct)) + '%';
}

function statusForProjectedPct(projectedPct: number): ProjectionStatus {
  if (!finiteNumber(projectedPct)) return 'unknown';
  if (projectedPct > 100) return 'over';
  if (projectedPct >= 80) return 'watch';
  return 'on-track';
}

function empty(status: ProjectionStatus, label: string): ProjectionResult {
  return {
    status,
    className: projectionClass(status),
    projectedPct: null,
    label,
  };
}

export function buildProjection(opts: ProjectionOptions = {}): ProjectionResult {
  const actualPct = opts.actualPct;
  const fetchedAt = opts.fetchedAt;
  const resetAtMs = opts.resetAtMs;
  const durationMs = opts.durationMs;
  const stale = !!opts.stale;

  if (stale) return empty('stale', 'projection stale');
  if (!finiteNumber(actualPct)) return empty('unknown', '');
  if (!finiteNumber(resetAtMs) || !finiteNumber(durationMs) || durationMs <= 0) {
    return empty('unknown', '');
  }

  const observedAtMs = parseIsoMs(fetchedAt);
  if (observedAtMs == null) return empty('unknown', '');

  const cycleStartMs = resetAtMs - durationMs;
  if (!Number.isFinite(cycleStartMs) || observedAtMs < cycleStartMs || observedAtMs >= resetAtMs) {
    return empty('unknown', 'projection unavailable');
  }

  const elapsedFraction = (observedAtMs - cycleStartMs) / durationMs;
  if (!finiteNumber(elapsedFraction) || elapsedFraction <= 0) {
    return empty('unknown', 'projection unavailable');
  }

  if (elapsedFraction < MIN_ELAPSED_FRACTION && actualPct < 100) {
    return empty('pending', 'projection pending');
  }

  const projectedPct = actualPct / elapsedFraction;
  const status = statusForProjectedPct(projectedPct);
  return {
    status,
    className: projectionClass(status),
    projectedPct,
    label: 'projected ' + formatProjectedPct(projectedPct),
  };
}

export const UsageProjection = {
  HOUR_MS,
  DAY_MS,
  MIN_ELAPSED_FRACTION,
  buildProjection,
  durationFromClaudeKey,
  epochSecondsToMs,
  parseIsoMs,
  projectionClass,
};

export default UsageProjection;
