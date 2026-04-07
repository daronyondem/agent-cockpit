import fs from 'fs';
import type { FSWatcher } from 'fs';

/**
 * Real-time filesystem watcher for CLI memory directories.
 *
 * CLIs like Claude Code write memory files automatically at the end of
 * each turn, but those writes are never surfaced through the stream-json
 * output.  Without filesystem watching, Agent Cockpit only captures
 * memory on session reset (#85), which means memories written during
 * long sessions are lost if the user closes the browser or the process
 * crashes before resetting.
 *
 * This service watches a memory directory (per active stream) and
 * invokes a caller-supplied `onChange` callback when `.md` files are
 * created, updated, or deleted.  The callback is debounced (500ms by
 * default) to coalesce bursts — Claude Code's extraction agent writes
 * several files in quick succession at the end of each turn, and we
 * want a single re-snapshot per burst, not one per file.
 *
 * The watcher is intentionally minimal: it does not read file contents,
 * does not parse frontmatter, and does not touch workspace storage.
 * The caller (usually `chatService.captureWorkspaceMemory`) is
 * responsible for the actual capture work.  This keeps the watcher
 * backend-agnostic — any backend that implements `getMemoryDir` can
 * plug in.
 */

/** Callback invoked when a watched memory directory changes. */
export type MemoryChangeHandler = () => void | Promise<void>;

export interface MemoryWatcherOptions {
  /**
   * Debounce window in milliseconds.  Multiple events within this window
   * collapse into a single `onChange` call.  Defaults to 500ms, which
   * matches the advice from the m13v comment on #101 and is comfortably
   * wider than Claude Code's extraction-agent write burst.
   */
  debounceMs?: number;
}

interface WatchEntry {
  watcher: FSWatcher;
  memDir: string;
  onChange: MemoryChangeHandler;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

export class MemoryWatcher {
  private readonly entries = new Map<string, WatchEntry>();
  private readonly debounceMs: number;

  constructor(opts: MemoryWatcherOptions = {}) {
    this.debounceMs = opts.debounceMs ?? 500;
  }

  /**
   * Start watching `memDir` for `.md` file changes.  Returns `true` if
   * a watcher was attached (or one was already attached for this key),
   * `false` if the directory does not exist or cannot be watched.
   *
   * `key` is an opaque identifier owned by the caller — typically a
   * conversation ID.  Calling `watch` twice with the same key is a
   * no-op (the second call is ignored).  Use `unwatch(key)` to stop.
   *
   * The caller is responsible for calling `unwatch` exactly once per
   * successful `watch`.  The watcher never removes itself except on
   * explicit `unwatch` / `unwatchAll` or on an `fs.watch` error event.
   */
  watch(key: string, memDir: string, onChange: MemoryChangeHandler): boolean {
    if (this.entries.has(key)) return true;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(memDir);
    } catch {
      return false;
    }
    if (!stat.isDirectory()) return false;

    let watcher: FSWatcher;
    try {
      watcher = fs.watch(memDir, { persistent: false });
    } catch (err: unknown) {
      console.error(`[memoryWatcher] failed to watch ${memDir}:`, (err as Error).message);
      return false;
    }

    const entry: WatchEntry = {
      watcher,
      memDir,
      onChange,
      debounceTimer: null,
    };
    this.entries.set(key, entry);

    watcher.on('change', (_eventType, filename) => {
      // `filename` may be a Buffer on some platforms; coerce to string.
      const name = typeof filename === 'string' ? filename : filename?.toString() || '';
      // Ignore everything that isn't a markdown file.  Claude Code may
      // write `.tmp` files that are later renamed into place — the
      // rename event on the `.md` name is what we care about.
      if (!name || !name.toLowerCase().endsWith('.md')) return;
      this._scheduleFire(key);
    });

    watcher.on('error', (err: Error) => {
      console.error(`[memoryWatcher] watch error for ${memDir}:`, err.message);
      this.unwatch(key);
    });

    console.log(`[memoryWatcher] watching ${memDir} (key=${key})`);
    return true;
  }

  /** Stop watching for the given key.  No-op if the key is unknown. */
  unwatch(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = null;
    }
    try {
      entry.watcher.close();
    } catch {
      // ignore — watcher may already be closed
    }
    this.entries.delete(key);
    console.log(`[memoryWatcher] stopped watching ${entry.memDir} (key=${key})`);
  }

  /** Stop all active watchers.  Called during server shutdown. */
  unwatchAll(): void {
    for (const key of Array.from(this.entries.keys())) {
      this.unwatch(key);
    }
  }

  /** Number of active watchers.  Exposed for tests and diagnostics. */
  get size(): number {
    return this.entries.size;
  }

  /** Returns true if a watcher is currently active for the given key. */
  isWatching(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Schedule (or re-schedule) the debounced `onChange` call for `key`.
   * Subsequent events within the debounce window reset the timer, so
   * a burst of writes collapses into a single fire.
   */
  private _scheduleFire(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;

    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
    }
    entry.debounceTimer = setTimeout(() => {
      // Re-read `entry` from the map — the caller may have unwatched
      // during the debounce window.
      const current = this.entries.get(key);
      if (!current) return;
      current.debounceTimer = null;

      Promise.resolve()
        .then(() => current.onChange())
        .catch((err: Error) => {
          console.error(`[memoryWatcher] onChange error for key=${key}:`, err.message);
        });
    }, this.debounceMs);
  }
}
