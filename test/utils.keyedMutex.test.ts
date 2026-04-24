import { KeyedMutex } from '../src/utils/keyedMutex';

function defer<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Flush pending microtasks and the immediate queue. A single
// `await Promise.resolve()` only advances one microtask hop, which is not
// enough when several chained awaits need to run to let the next holder
// enter its critical section.
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('KeyedMutex', () => {
  test('same key: operations run sequentially in FIFO order', async () => {
    const mu = new KeyedMutex();
    const order: string[] = [];
    const d1 = defer();
    const d2 = defer();

    const p1 = mu.run('k', async () => {
      order.push('1-start');
      await d1.promise;
      order.push('1-end');
    });
    const p2 = mu.run('k', async () => {
      order.push('2-start');
      await d2.promise;
      order.push('2-end');
    });
    const p3 = mu.run('k', async () => {
      order.push('3-start');
      order.push('3-end');
    });

    // Give microtasks a chance to run. Only #1 should have started.
    await flush();
    expect(order).toEqual(['1-start']);

    d1.resolve();
    await flush();
    // #1 finishes, #2 starts but blocks on d2.
    expect(order).toEqual(['1-start', '1-end', '2-start']);

    d2.resolve();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(['1-start', '1-end', '2-start', '2-end', '3-start', '3-end']);
  });

  test('different keys: operations run concurrently', async () => {
    const mu = new KeyedMutex();
    const order: string[] = [];
    const dA = defer();
    const dB = defer();

    const pA = mu.run('a', async () => {
      order.push('a-start');
      await dA.promise;
      order.push('a-end');
    });
    const pB = mu.run('b', async () => {
      order.push('b-start');
      await dB.promise;
      order.push('b-end');
    });

    await flush();
    // Both should have entered their critical sections.
    expect(order).toEqual(['a-start', 'b-start']);

    // Resolve B first to prove independence from A.
    dB.resolve();
    await pB;
    expect(order).toEqual(['a-start', 'b-start', 'b-end']);

    dA.resolve();
    await pA;
    expect(order).toEqual(['a-start', 'b-start', 'b-end', 'a-end']);
  });

  test('returns the value produced by fn', async () => {
    const mu = new KeyedMutex();
    const v = await mu.run('k', async () => 42);
    expect(v).toBe(42);
  });

  test('error in one function does not corrupt lock state for subsequent operations', async () => {
    const mu = new KeyedMutex();
    const order: string[] = [];

    const p1 = mu.run('k', async () => {
      order.push('1-start');
      throw new Error('boom');
    });
    const p2 = mu.run('k', async () => {
      order.push('2-start');
      return 'ok';
    });

    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
    expect(order).toEqual(['1-start', '2-start']);
  });

  test('synchronous throw in fn is surfaced and chain continues', async () => {
    const mu = new KeyedMutex();
    const p1 = mu.run('k', () => { throw new Error('sync'); });
    const p2 = mu.run('k', async () => 'next');

    await expect(p1).rejects.toThrow('sync');
    await expect(p2).resolves.toBe('next');
  });

  test('lock cleanup: tail entry removed after chain drains', async () => {
    const mu = new KeyedMutex();
    // Access private field via cast for testing cleanup.
    const tails = (mu as unknown as { _tails: Map<string, unknown> })._tails;

    await mu.run('k', async () => 1);
    // After drain the entry should be gone.
    expect(tails.has('k')).toBe(false);

    await mu.run('a', async () => 1);
    await mu.run('b', async () => 2);
    expect(tails.has('a')).toBe(false);
    expect(tails.has('b')).toBe(false);
  });

  test('lock cleanup: entry remains while chain has pending work', async () => {
    const mu = new KeyedMutex();
    const tails = (mu as unknown as { _tails: Map<string, unknown> })._tails;
    const d = defer();

    const p = mu.run('k', async () => { await d.promise; });
    await flush();
    expect(tails.has('k')).toBe(true);

    d.resolve();
    await p;
    expect(tails.has('k')).toBe(false);
  });

  test('same-key concurrent writers see fully serialized read-modify-write', async () => {
    const mu = new KeyedMutex();
    const shared = { count: 0 };
    const N = 50;
    const ops: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      ops.push(mu.run('shared', async () => {
        const snap = shared.count;
        // Yield to simulate async work between read and write.
        await Promise.resolve();
        await Promise.resolve();
        shared.count = snap + 1;
      }));
    }
    await Promise.all(ops);
    // Without the mutex, concurrent RMW would lose updates.
    expect(shared.count).toBe(N);
  });
});
