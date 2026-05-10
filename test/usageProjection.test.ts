const projection = require('../public/v2/src/usageProjection.js');

describe('usage quota projection helpers', () => {
  const fiveHours = 5 * projection.HOUR_MS;
  const resetAtMs = Date.parse('2026-05-10T05:00:00.000Z');

  test('projects end-of-cycle usage from the observed cycle average', () => {
    const result = projection.buildProjection({
      actualPct: 30,
      fetchedAt: '2026-05-10T01:15:00.000Z',
      resetAtMs,
      durationMs: fiveHours,
    });

    expect(Math.round(result.projectedPct)).toBe(120);
    expect(result.status).toBe('over');
    expect(result.className).toBe('tt-bar-proj-over');
    expect(result.label).toBe('projected 120%');
  });

  test('keeps on-track and watch projections separate', () => {
    const onTrack = projection.buildProjection({
      actualPct: 10,
      fetchedAt: '2026-05-10T01:15:00.000Z',
      resetAtMs,
      durationMs: fiveHours,
    });
    const watch = projection.buildProjection({
      actualPct: 20,
      fetchedAt: '2026-05-10T01:15:00.000Z',
      resetAtMs,
      durationMs: fiveHours,
    });

    expect(onTrack.status).toBe('on-track');
    expect(onTrack.label).toBe('projected 40%');
    expect(watch.status).toBe('watch');
    expect(watch.label).toBe('projected 80%');
  });

  test('suppresses noisy projections at the beginning of a cycle', () => {
    const result = projection.buildProjection({
      actualPct: 4,
      fetchedAt: '2026-05-10T00:10:00.000Z',
      resetAtMs,
      durationMs: fiveHours,
    });

    expect(result.status).toBe('pending');
    expect(result.projectedPct).toBeNull();
    expect(result.label).toBe('projection pending');
  });

  test('marks stale snapshots without calculating a projection', () => {
    const result = projection.buildProjection({
      actualPct: 30,
      fetchedAt: '2026-05-10T01:15:00.000Z',
      resetAtMs,
      durationMs: fiveHours,
      stale: true,
    });

    expect(result.status).toBe('stale');
    expect(result.projectedPct).toBeNull();
    expect(result.label).toBe('projection stale');
    expect(result.className).toBe('tt-bar-proj-unknown');
  });

  test('returns unavailable when the reset window cannot describe the observation', () => {
    const result = projection.buildProjection({
      actualPct: 30,
      fetchedAt: '2026-05-10T06:00:00.000Z',
      resetAtMs,
      durationMs: fiveHours,
    });

    expect(result.status).toBe('unknown');
    expect(result.projectedPct).toBeNull();
    expect(result.label).toBe('projection unavailable');
  });

  test('derives known Claude Code quota durations from bucket keys', () => {
    expect(projection.durationFromClaudeKey('five_hour')).toBe(5 * projection.HOUR_MS);
    expect(projection.durationFromClaudeKey('five_hour_opus')).toBe(5 * projection.HOUR_MS);
    expect(projection.durationFromClaudeKey('seven_day')).toBe(7 * projection.DAY_MS);
    expect(projection.durationFromClaudeKey('seven_day_sonnet')).toBe(7 * projection.DAY_MS);
    expect(projection.durationFromClaudeKey('daily_tokens')).toBe(projection.DAY_MS);
    expect(projection.durationFromClaudeKey('unknown_codename')).toBeNull();
  });
});
