/**
 * Serializes async operations per key. Callers of `run(key, fn)` for the
 * same key are executed one-at-a-time in FIFO order; different keys run
 * concurrently.
 *
 * Used to serialize read-modify-write cycles on a shared file (e.g. a
 * workspace `index.json`) so two concurrent mutators do not both read the
 * same snapshot, mutate independently, and clobber each other on write.
 *
 * Not reentrant: calling `run(k, …)` from inside a function already
 * holding `k` deadlocks. Keep locked regions self-contained.
 */
export class KeyedMutex {
  private _tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this._tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this._tails.set(key, next);

    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this._tails.get(key) === next) {
        this._tails.delete(key);
      }
    }
  }
}
