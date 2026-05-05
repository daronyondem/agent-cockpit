/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  KbDreamScheduler,
  getKbAutoDreamState,
  getKbAutoDreamWindowState,
  normalizeKbAutoDreamConfig,
  validateKbAutoDreamConfig,
} from '../src/services/knowledgeBase/autoDream';

function createDb(opts: { pending?: number; lastRunAt?: string | null } = {}) {
  return {
    countNeedsSynthesis: jest.fn().mockReturnValue(opts.pending ?? 1),
    getSynthesisSnapshot: jest.fn().mockReturnValue({
      lastRunAt: opts.lastRunAt ?? null,
    }),
  };
}

function createScheduler(opts: {
  config: any;
  db?: ReturnType<typeof createDb> | null;
  now?: Date;
  running?: boolean;
  dream?: jest.Mock;
  requestStop?: jest.Mock;
}) {
  let now = opts.now || new Date(2026, 0, 1, 12, 0, 0);
  const chatService = {
    listKbEnabledWorkspaceHashes: jest.fn().mockResolvedValue(['ws']),
    getWorkspaceKbAutoDream: jest.fn().mockResolvedValue(opts.config),
    getKbDb: jest.fn().mockReturnValue(opts.db === undefined ? createDb() : opts.db),
  };
  const kbDreaming = {
    dream: opts.dream || jest.fn().mockResolvedValue({ ok: true }),
    isRunning: jest.fn().mockReturnValue(Boolean(opts.running)),
    requestStop: opts.requestStop || jest.fn().mockReturnValue(true),
  };
  const scheduler = new KbDreamScheduler({
    chatService: chatService as any,
    kbDreaming: kbDreaming as any,
    now: () => now,
    logger: { warn: jest.fn() },
  });
  return {
    scheduler,
    chatService,
    kbDreaming,
    setNow: (value: Date) => { now = value; },
  };
}

describe('auto-dream config helpers', () => {
  test('normalizes invalid persisted config to off', () => {
    expect(normalizeKbAutoDreamConfig(null)).toEqual({ mode: 'off' });
    expect(normalizeKbAutoDreamConfig({ mode: 'interval', intervalHours: 0 })).toEqual({ mode: 'off' });
    expect(normalizeKbAutoDreamConfig({ mode: 'window', windowStart: '02:00', windowEnd: '02:00' })).toEqual({ mode: 'off' });
  });

  test('validates interval and window configs', () => {
    expect(validateKbAutoDreamConfig({ mode: 'interval', intervalHours: 6 }).config).toEqual({
      mode: 'interval',
      intervalHours: 6,
    });
    expect(validateKbAutoDreamConfig({ mode: 'window', windowStart: '02:00', windowEnd: '06:00' }).config).toEqual({
      mode: 'window',
      windowStart: '02:00',
      windowEnd: '06:00',
    });
    expect(validateKbAutoDreamConfig({ mode: 'window', windowStart: '2AM', windowEnd: '06:00' }).error).toMatch(/windowStart/);
  });

  test('computes same-day and overnight window state in local server time', () => {
    const sameDay = getKbAutoDreamWindowState(
      { mode: 'window', windowStart: '02:00', windowEnd: '06:00' },
      new Date(2026, 0, 1, 3, 0, 0),
    );
    expect(sameDay.inside).toBe(true);
    expect(sameDay.windowEndAt?.getHours()).toBe(6);

    const overnight = getKbAutoDreamWindowState(
      { mode: 'window', windowStart: '22:00', windowEnd: '02:00' },
      new Date(2026, 0, 2, 1, 0, 0),
    );
    expect(overnight.inside).toBe(true);
    expect(overnight.windowEndAt?.getHours()).toBe(2);
  });

  test('reports next run timing for interval and window modes', () => {
    const now = new Date(2026, 0, 1, 12, 0, 0);
    const interval = getKbAutoDreamState(
      { mode: 'interval', intervalHours: 6 },
      new Date(2026, 0, 1, 8, 0, 0).toISOString(),
      now,
    );
    expect(interval.nextRunAt).toBe(new Date(2026, 0, 1, 14, 0, 0).toISOString());

    const windowed = getKbAutoDreamState(
      { mode: 'window', windowStart: '02:00', windowEnd: '06:00' },
      null,
      now,
    );
    expect(windowed.nextRunAt).toBe(new Date(2026, 0, 2, 2, 0, 0).toISOString());
    expect(windowed.windowActive).toBe(false);
  });
});

describe('KbDreamScheduler', () => {
  test('starts interval auto-dream when due and pending', async () => {
    const db = createDb({
      pending: 2,
      lastRunAt: new Date(2026, 0, 1, 5, 0, 0).toISOString(),
    });
    const { scheduler, kbDreaming } = createScheduler({
      config: { mode: 'interval', intervalHours: 6 },
      db,
      now: new Date(2026, 0, 1, 12, 0, 0),
    });

    await scheduler.checkNow();

    expect(kbDreaming.dream).toHaveBeenCalledWith('ws');
  });

  test('skips interval auto-dream when not due, no pending, or already running', async () => {
    const notDue = createScheduler({
      config: { mode: 'interval', intervalHours: 6 },
      db: createDb({ pending: 1, lastRunAt: new Date(2026, 0, 1, 8, 0, 0).toISOString() }),
      now: new Date(2026, 0, 1, 12, 0, 0),
    });
    await notDue.scheduler.checkNow();
    expect(notDue.kbDreaming.dream).not.toHaveBeenCalled();

    const noPending = createScheduler({
      config: { mode: 'interval', intervalHours: 6 },
      db: createDb({ pending: 0, lastRunAt: null }),
    });
    await noPending.scheduler.checkNow();
    expect(noPending.kbDreaming.dream).not.toHaveBeenCalled();

    const running = createScheduler({
      config: { mode: 'interval', intervalHours: 6 },
      running: true,
    });
    await running.scheduler.checkNow();
    expect(running.kbDreaming.dream).not.toHaveBeenCalled();
  });

  test('starts window auto-dream only inside the configured window', async () => {
    const outside = createScheduler({
      config: { mode: 'window', windowStart: '02:00', windowEnd: '06:00' },
      db: createDb({ pending: 1 }),
      now: new Date(2026, 0, 1, 12, 0, 0),
    });
    await outside.scheduler.checkNow();
    expect(outside.kbDreaming.dream).not.toHaveBeenCalled();

    const inside = createScheduler({
      config: { mode: 'window', windowStart: '02:00', windowEnd: '06:00' },
      db: createDb({ pending: 1 }),
      now: new Date(2026, 0, 1, 3, 0, 0),
    });
    await inside.scheduler.checkNow();
    expect(inside.kbDreaming.dream).toHaveBeenCalledWith('ws');
  });

  test('requests cooperative stop when an auto-owned window run leaves the window', async () => {
    let resolveDream!: (value: unknown) => void;
    const dream = jest.fn().mockReturnValue(new Promise((resolve) => { resolveDream = resolve; }));
    const requestStop = jest.fn().mockReturnValue(true);
    const env = createScheduler({
      config: { mode: 'window', windowStart: '02:00', windowEnd: '06:00' },
      db: createDb({ pending: 1 }),
      now: new Date(2026, 0, 1, 3, 0, 0),
      dream,
      requestStop,
    });

    await env.scheduler.checkNow();
    expect(dream).toHaveBeenCalledWith('ws');

    env.setNow(new Date(2026, 0, 1, 6, 1, 0));
    env.kbDreaming.isRunning.mockReturnValue(true);
    await env.scheduler.checkNow();

    expect(requestStop).toHaveBeenCalledWith('ws');
    resolveDream({ ok: true });
  });

  test('does not stop a manual run at window end', async () => {
    const env = createScheduler({
      config: { mode: 'window', windowStart: '02:00', windowEnd: '06:00' },
      db: createDb({ pending: 1 }),
      now: new Date(2026, 0, 1, 6, 1, 0),
      running: true,
    });

    await env.scheduler.checkNow();

    expect(env.kbDreaming.requestStop).not.toHaveBeenCalled();
  });

  test('lets an auto-owned run continue when switching from window to interval mode', async () => {
    let resolveDream!: (value: unknown) => void;
    const dream = jest.fn().mockReturnValue(new Promise((resolve) => { resolveDream = resolve; }));
    const env = createScheduler({
      config: { mode: 'window', windowStart: '02:00', windowEnd: '06:00' },
      db: createDb({ pending: 1 }),
      now: new Date(2026, 0, 1, 3, 0, 0),
      dream,
    });

    await env.scheduler.checkNow();
    expect(dream).toHaveBeenCalledWith('ws');

    env.chatService.getWorkspaceKbAutoDream.mockResolvedValue({ mode: 'interval', intervalHours: 6 });
    env.kbDreaming.isRunning.mockReturnValue(true);
    await env.scheduler.checkNow();

    expect(env.kbDreaming.requestStop).not.toHaveBeenCalled();
    resolveDream({ ok: true });
  });
});
