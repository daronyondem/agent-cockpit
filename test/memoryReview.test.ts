import {
  MemoryReviewScheduler,
  getMemoryReviewWindowState,
  validateMemoryReviewScheduleConfig,
} from '../src/services/memoryReview';

describe('memoryReview schedule validation', () => {
  test('accepts valid window schedules and rejects invalid timezones', () => {
    const valid = validateMemoryReviewScheduleConfig({
      mode: 'window',
      days: 'custom',
      customDays: [1, 3, 5],
      windowStart: '01:00',
      windowEnd: '04:00',
      timezone: 'America/Los_Angeles',
    });
    expect(valid.error).toBeUndefined();
    expect(valid.config).toMatchObject({
      mode: 'window',
      days: 'custom',
      customDays: [1, 3, 5],
      timezone: 'America/Los_Angeles',
    });

    const invalid = validateMemoryReviewScheduleConfig({
      mode: 'window',
      days: 'daily',
      windowStart: '01:00',
      windowEnd: '04:00',
      timezone: 'not/a-zone',
    });
    expect(invalid.error).toMatch(/timezone/i);
  });
});

describe('MemoryReviewScheduler', () => {
  test('starts one scheduled run inside the window and respects the persisted per-window guard', async () => {
    const runs: Array<{ createdAt: string; source: 'scheduled' }> = [];
    const scheduler = new MemoryReviewScheduler({
      now: () => new Date('2026-05-07T09:30:00.000Z'),
      chatService: {
        listMemoryEnabledWorkspaceHashes: async () => ['hash-a'],
        getWorkspaceMemoryReviewSchedule: async () => ({
          mode: 'window',
          days: 'daily',
          windowStart: '09:00',
          windowEnd: '10:00',
          timezone: 'UTC',
        }),
        getWorkspaceMemoryReviewScheduleUpdatedAt: async () => undefined,
        listMemoryReviewRuns: async () => runs,
      },
      runner: {
        isMemoryReviewRunning: () => false,
        hasPendingMemoryReview: async () => false,
        hasMemoryChangedSinceLastScheduledReview: async () => true,
        createMemoryReviewRun: async (hash) => {
          runs.push({ createdAt: '2026-05-07T09:30:00.000Z', source: 'scheduled' });
          return {};
        },
      },
    });

    await scheduler.checkNow();
    await scheduler.checkNow();

    expect(runs).toHaveLength(1);

    const restartedScheduler = new MemoryReviewScheduler({
      now: () => new Date('2026-05-07T09:45:00.000Z'),
      chatService: {
        listMemoryEnabledWorkspaceHashes: async () => ['hash-a'],
        getWorkspaceMemoryReviewSchedule: async () => ({
          mode: 'window',
          days: 'daily',
          windowStart: '09:00',
          windowEnd: '10:00',
          timezone: 'UTC',
        }),
        getWorkspaceMemoryReviewScheduleUpdatedAt: async () => undefined,
        listMemoryReviewRuns: async () => runs,
      },
      runner: {
        isMemoryReviewRunning: () => false,
        hasPendingMemoryReview: async () => false,
        hasMemoryChangedSinceLastScheduledReview: async () => true,
        createMemoryReviewRun: async () => {
          runs.push({ createdAt: '2026-05-07T09:45:00.000Z', source: 'scheduled' });
          return {};
        },
      },
    });

    await restartedScheduler.checkNow();

    expect(runs).toHaveLength(1);
  });

  test('schedule changes reset the persisted guard and manual runs do not count', async () => {
    const runs: Array<{ createdAt: string; source: 'manual' | 'scheduled' }> = [
      { createdAt: '2026-05-07T09:10:00.000Z', source: 'scheduled' },
      { createdAt: '2026-05-07T09:20:00.000Z', source: 'manual' },
    ];
    const started: string[] = [];
    const scheduler = new MemoryReviewScheduler({
      now: () => new Date('2026-05-07T09:45:00.000Z'),
      chatService: {
        listMemoryEnabledWorkspaceHashes: async () => ['hash-a'],
        getWorkspaceMemoryReviewSchedule: async () => ({
          mode: 'window',
          days: 'daily',
          windowStart: '09:00',
          windowEnd: '10:00',
          timezone: 'UTC',
        }),
        getWorkspaceMemoryReviewScheduleUpdatedAt: async () => '2026-05-07T09:30:00.000Z',
        listMemoryReviewRuns: async () => runs,
      },
      runner: {
        isMemoryReviewRunning: () => false,
        hasPendingMemoryReview: async () => false,
        hasMemoryChangedSinceLastScheduledReview: async (_hash, since) => since === '2026-05-07T09:30:00.000Z',
        createMemoryReviewRun: async (hash) => {
          started.push(hash);
          runs.push({ createdAt: '2026-05-07T09:45:00.000Z', source: 'scheduled' });
          return {};
        },
      },
    });

    await scheduler.checkNow();

    expect(started).toEqual(['hash-a']);
  });

  test('window state honors UTC timezone windows', () => {
    const state = getMemoryReviewWindowState({
      mode: 'window',
      days: 'daily',
      windowStart: '09:00',
      windowEnd: '10:00',
      timezone: 'UTC',
    }, new Date('2026-05-07T09:30:00.000Z'));
    expect(state.inside).toBe(true);
  });
});
