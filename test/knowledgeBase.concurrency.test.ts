/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── KB workspace task queue tests ───────────────────────────────────────────
// Pins down the bounded-parallelism queue + registry that ingestion and
// digestion share. Everything is gated on deferred promises so the suite
// is deterministic — no setTimeout-based timing races.

import {
  WorkspaceTaskQueue,
  WorkspaceTaskQueueRegistry,
} from '../src/services/knowledgeBase/workspaceTaskQueue';

interface Gate<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function gate<T = void>(): Gate<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yield enough microtasks for any synchronous chains to settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe('WorkspaceTaskQueue', () => {
  test('runs tasks in FIFO order when concurrency = 1', async () => {
    const q = new WorkspaceTaskQueue({ getConcurrency: () => 1 });
    const order: number[] = [];
    const gates = [gate(), gate(), gate()];

    const p1 = q.run(async () => {
      order.push(1);
      await gates[0].promise;
    });
    const p2 = q.run(async () => {
      order.push(2);
      await gates[1].promise;
    });
    const p3 = q.run(async () => {
      order.push(3);
      await gates[2].promise;
    });

    // Only the first task should be running.
    await flushMicrotasks();
    expect(order).toEqual([1]);
    expect(q.stats().inFlight).toBe(1);
    expect(q.stats().queued).toBe(2);

    // Release them in order; each one only starts after its predecessor.
    gates[0].resolve();
    await flushMicrotasks();
    expect(order).toEqual([1, 2]);
    gates[1].resolve();
    await flushMicrotasks();
    expect(order).toEqual([1, 2, 3]);
    gates[2].resolve();
    await Promise.all([p1, p2, p3]);
    expect(q.stats().inFlight).toBe(0);
  });

  test('runs up to concurrency tasks in parallel', async () => {
    const q = new WorkspaceTaskQueue({ getConcurrency: () => 3 });
    const started: number[] = [];
    const gates = Array.from({ length: 5 }, () => gate());

    const promises = gates.map((g, i) =>
      q.run(async () => {
        started.push(i);
        await g.promise;
      }),
    );

    // First 3 should be running; remaining 2 queued.
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2]);
    expect(q.stats().inFlight).toBe(3);
    expect(q.stats().queued).toBe(2);

    // Release task 0; task 3 takes its slot.
    gates[0].resolve();
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2, 3]);
    expect(q.stats().inFlight).toBe(3);

    // Release task 1; task 4 takes its slot.
    gates[1].resolve();
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(q.stats().inFlight).toBe(3);

    // Release the rest.
    gates[2].resolve();
    gates[3].resolve();
    gates[4].resolve();
    await Promise.all(promises);
    expect(q.stats().inFlight).toBe(0);
  });

  test('drain barrier waits for in-flight, runs alone, then resumes', async () => {
    const q = new WorkspaceTaskQueue({ getConcurrency: () => 2 });
    const events: string[] = [];
    const t1 = gate();
    const t2 = gate();
    const barrier = gate();
    const t3 = gate();

    const p1 = q.run(async () => {
      events.push('t1:start');
      await t1.promise;
      events.push('t1:done');
    });
    const p2 = q.run(async () => {
      events.push('t2:start');
      await t2.promise;
      events.push('t2:done');
    });
    const pBarrier = q.runBarrier(async () => {
      events.push('barrier:start');
      await barrier.promise;
      events.push('barrier:done');
    });
    const p3 = q.run(async () => {
      events.push('t3:start');
      await t3.promise;
      events.push('t3:done');
    });

    // Both tasks running, barrier + t3 queued.
    await flushMicrotasks();
    expect(events).toEqual(['t1:start', 't2:start']);
    expect(q.stats()).toEqual({ inFlight: 2, queued: 2, barrierRunning: false });

    // Finish t1 — barrier still waits for t2.
    t1.resolve();
    await flushMicrotasks();
    expect(events).toEqual(['t1:start', 't2:start', 't1:done']);
    expect(q.stats()).toEqual({ inFlight: 1, queued: 2, barrierRunning: false });

    // Finish t2 — barrier should now start, alone.
    t2.resolve();
    await flushMicrotasks();
    expect(events).toEqual([
      't1:start', 't2:start', 't1:done', 't2:done', 'barrier:start',
    ]);
    expect(q.stats()).toEqual({ inFlight: 0, queued: 1, barrierRunning: true });

    // t3 should not have started while the barrier runs.
    expect(events).not.toContain('t3:start');

    // Release barrier — t3 should pick up.
    barrier.resolve();
    await flushMicrotasks();
    expect(events).toEqual([
      't1:start', 't2:start', 't1:done', 't2:done',
      'barrier:start', 'barrier:done', 't3:start',
    ]);
    expect(q.stats().barrierRunning).toBe(false);

    // Drain.
    t3.resolve();
    await Promise.all([p1, p2, pBarrier, p3]);
    expect(q.stats().inFlight).toBe(0);
  });

  test('picks up concurrency changes on the next dispatch', async () => {
    let budget = 1;
    const q = new WorkspaceTaskQueue({ getConcurrency: () => budget });
    const gates = Array.from({ length: 3 }, () => gate());
    const started: number[] = [];

    const promises = gates.map((g, i) =>
      q.run(async () => {
        started.push(i);
        await g.promise;
      }),
    );

    await flushMicrotasks();
    expect(started).toEqual([0]);

    // Bump budget to 3 — currently in-flight stays at 1; new dispatch
    // should pull both queued tasks since 3 > 0+1.
    budget = 3;
    // Trigger a pump by resolving the first task's gate so onSettle fires.
    gates[0].resolve();
    await flushMicrotasks();
    // Now started should include the rest (since after the first settle
    // the pump dispatches up to budget=3).
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(promises);
  });

  test('waitForIdle resolves when the queue drains', async () => {
    const q = new WorkspaceTaskQueue({ getConcurrency: () => 2 });
    expect(q.stats().inFlight).toBe(0);

    // Idle queue resolves immediately.
    await q.waitForIdle();

    const g1 = gate();
    const g2 = gate();
    const p1 = q.run(async () => { await g1.promise; });
    const p2 = q.run(async () => { await g2.promise; });

    let drained = false;
    const drainPromise = q.waitForIdle().then(() => { drained = true; });

    await flushMicrotasks();
    expect(drained).toBe(false);

    g1.resolve();
    await flushMicrotasks();
    expect(drained).toBe(false);

    g2.resolve();
    await Promise.all([p1, p2, drainPromise]);
    expect(drained).toBe(true);
  });

  test('a failing task does not block subsequent tasks', async () => {
    const q = new WorkspaceTaskQueue({ getConcurrency: () => 1 });
    const ran: string[] = [];

    const failing = q.run(async () => {
      ran.push('fail');
      throw new Error('boom');
    });
    const next = q.run(async () => {
      ran.push('next');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    expect(ran).toEqual(['fail', 'next']);
    expect(q.stats().inFlight).toBe(0);
  });

  test('synchronous throws inside a task become rejected promises', async () => {
    const q = new WorkspaceTaskQueue({ getConcurrency: () => 1 });
    // Wrap a synchronous throw in the task callback (via async fn that
    // throws on the first tick) to confirm the queue surfaces it cleanly.
    const sync = q.run(async () => {
      throw new Error('sync fail');
    });
    await expect(sync).rejects.toThrow('sync fail');
    expect(q.stats().inFlight).toBe(0);
  });

  test('clamps concurrency below 1 to a single slot', async () => {
    const q = new WorkspaceTaskQueue({ getConcurrency: () => 0 });
    const gates = [gate(), gate()];
    const order: number[] = [];

    const p1 = q.run(async () => {
      order.push(1);
      await gates[0].promise;
    });
    const p2 = q.run(async () => {
      order.push(2);
      await gates[1].promise;
    });

    await flushMicrotasks();
    expect(order).toEqual([1]);
    expect(q.stats().inFlight).toBe(1);

    gates[0].resolve();
    await flushMicrotasks();
    expect(order).toEqual([1, 2]);
    gates[1].resolve();
    await Promise.all([p1, p2]);
  });
});

describe('WorkspaceTaskQueueRegistry', () => {
  test('returns the same queue instance for the same hash', () => {
    const reg = new WorkspaceTaskQueueRegistry();
    const a = reg.get('hash-1');
    const b = reg.get('hash-1');
    expect(a).toBe(b);
  });

  test('isolates queues across different hashes', async () => {
    const reg = new WorkspaceTaskQueueRegistry();
    const a = reg.get('hash-a');
    const b = reg.get('hash-b');
    expect(a).not.toBe(b);

    reg.setConcurrency('hash-a', 1);
    reg.setConcurrency('hash-b', 1);

    const aGate = gate();
    const bGate = gate();
    const aRan = jest.fn();
    const bRan = jest.fn();

    a.run(async () => { aRan(); await aGate.promise; });
    b.run(async () => { bRan(); await bGate.promise; });

    await flushMicrotasks();
    // Both queues run their first task in parallel — they don't share a budget.
    expect(aRan).toHaveBeenCalled();
    expect(bRan).toHaveBeenCalled();

    aGate.resolve();
    bGate.resolve();
    await reg.waitForIdle('hash-a');
    await reg.waitForIdle('hash-b');
  });

  test('setConcurrency clamps to >= 1 and floors fractional values', async () => {
    const reg = new WorkspaceTaskQueueRegistry();
    reg.setConcurrency('hash', 0);
    const q = reg.get('hash');
    const gates = [gate(), gate()];
    const ran: number[] = [];
    q.run(async () => { ran.push(1); await gates[0].promise; });
    q.run(async () => { ran.push(2); await gates[1].promise; });
    await flushMicrotasks();
    expect(ran).toEqual([1]); // clamped to 1, not 0

    reg.setConcurrency('hash', 2.7);
    gates[0].resolve();
    await flushMicrotasks();
    expect(ran).toEqual([1, 2]);
    gates[1].resolve();
    await reg.waitForIdle('hash');
  });

  test('waitForIdle resolves immediately for unknown hashes', async () => {
    const reg = new WorkspaceTaskQueueRegistry();
    await expect(reg.waitForIdle('never-touched')).resolves.toBeUndefined();
  });

  test('budget is shared across both consumers of the same workspace queue', async () => {
    // Mirrors the production wiring: ingestion + digestion both call
    // registry.get(hash) so a single budget governs both pipelines.
    const reg = new WorkspaceTaskQueueRegistry();
    reg.setConcurrency('hash', 2);
    const q = reg.get('hash');

    const gates = Array.from({ length: 4 }, () => gate());
    const started: string[] = [];

    // Two "ingestion" tasks + two "digestion" tasks all on the same queue.
    const p = [
      q.run(async () => { started.push('ingest-A'); await gates[0].promise; }),
      q.run(async () => { started.push('ingest-B'); await gates[1].promise; }),
      q.run(async () => { started.push('digest-A'); await gates[2].promise; }),
      q.run(async () => { started.push('digest-B'); await gates[3].promise; }),
    ];

    await flushMicrotasks();
    // Only 2 of the 4 should be running — shared budget.
    expect(started).toEqual(['ingest-A', 'ingest-B']);
    expect(q.stats()).toEqual({ inFlight: 2, queued: 2, barrierRunning: false });

    gates[0].resolve();
    await flushMicrotasks();
    expect(started).toEqual(['ingest-A', 'ingest-B', 'digest-A']);

    gates[1].resolve();
    await flushMicrotasks();
    expect(started).toEqual(['ingest-A', 'ingest-B', 'digest-A', 'digest-B']);

    gates[2].resolve();
    gates[3].resolve();
    await Promise.all(p);
  });
});
