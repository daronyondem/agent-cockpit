import fs from 'fs';
import path from 'path';
import os from 'os';
import { MemoryWatcher } from '../src/services/memoryWatcher';

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// Debounce window for tests. We use a short window so tests run quickly,
// but one long enough that a deliberate "wait 2× debounce then check"
// step is still reliable on CI.
const TEST_DEBOUNCE_MS = 60;
const WAIT_FOR_FIRE_MS = TEST_DEBOUNCE_MS * 3;

describe('MemoryWatcher', () => {
  let tmpDir: string;
  let watcher: MemoryWatcher;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-watcher-'));
    watcher = new MemoryWatcher({ debounceMs: TEST_DEBOUNCE_MS });
  });

  afterEach(() => {
    watcher.unwatchAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Basic watch + unwatch ────────────────────────────────────────────────

  test('watch returns false when the directory does not exist', () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    const result = watcher.watch('k1', missing, () => {});
    expect(result).toBe(false);
    expect(watcher.size).toBe(0);
  });

  test('watch returns false when the path is a file, not a directory', () => {
    const file = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(file, 'hello');
    const result = watcher.watch('k1', file, () => {});
    expect(result).toBe(false);
    expect(watcher.size).toBe(0);
  });

  test('watch returns true and registers a handle for an existing directory', () => {
    const result = watcher.watch('k1', tmpDir, () => {});
    expect(result).toBe(true);
    expect(watcher.isWatching('k1')).toBe(true);
    expect(watcher.size).toBe(1);
  });

  test('watch is idempotent for the same key', () => {
    const spy1 = jest.fn();
    const spy2 = jest.fn();
    expect(watcher.watch('k1', tmpDir, spy1)).toBe(true);
    expect(watcher.watch('k1', tmpDir, spy2)).toBe(true);
    expect(watcher.size).toBe(1);
  });

  test('unwatch removes the entry and unwatch of unknown key is a no-op', () => {
    watcher.watch('k1', tmpDir, () => {});
    expect(watcher.size).toBe(1);
    watcher.unwatch('k1');
    expect(watcher.size).toBe(0);
    expect(watcher.isWatching('k1')).toBe(false);
    // Second unwatch is a no-op, not an error.
    expect(() => watcher.unwatch('k1')).not.toThrow();
    expect(() => watcher.unwatch('never-added')).not.toThrow();
  });

  test('unwatchAll stops every active watcher', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-watcher-b-'));
    try {
      watcher.watch('a', tmpDir, () => {});
      watcher.watch('b', dir2, () => {});
      expect(watcher.size).toBe(2);
      watcher.unwatchAll();
      expect(watcher.size).toBe(0);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  // ── Change detection + debounce ──────────────────────────────────────────

  test('fires onChange when a new .md file is created', async () => {
    const onChange = jest.fn();
    watcher.watch('k1', tmpDir, onChange);

    fs.writeFileSync(path.join(tmpDir, 'feedback_x.md'), '---\ntype: feedback\n---\nhi\n');
    await sleep(WAIT_FOR_FIRE_MS);

    expect(onChange).toHaveBeenCalled();
  });

  test('fires onChange when an existing .md file is updated', async () => {
    const file = path.join(tmpDir, 'user_role.md');
    fs.writeFileSync(file, 'initial');
    const onChange = jest.fn();
    watcher.watch('k1', tmpDir, onChange);

    fs.writeFileSync(file, 'updated');
    await sleep(WAIT_FOR_FIRE_MS);

    expect(onChange).toHaveBeenCalled();
  });

  test('ignores non-.md file changes', async () => {
    const onChange = jest.fn();
    watcher.watch('k1', tmpDir, onChange);

    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'text file');
    fs.writeFileSync(path.join(tmpDir, 'data.json'), '{}');
    await sleep(WAIT_FOR_FIRE_MS);

    expect(onChange).not.toHaveBeenCalled();
  });

  test('debounces rapid bursts into a single onChange call', async () => {
    const onChange = jest.fn();
    watcher.watch('k1', tmpDir, onChange);

    // Simulate Claude Code's extraction agent writing several files
    // in quick succession at the end of a turn.
    fs.writeFileSync(path.join(tmpDir, 'user_role.md'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'feedback_a.md'), 'b');
    fs.writeFileSync(path.join(tmpDir, 'project_x.md'), 'c');
    fs.writeFileSync(path.join(tmpDir, 'reference_y.md'), 'd');

    await sleep(WAIT_FOR_FIRE_MS);

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('fires again after the debounce window closes', async () => {
    const onChange = jest.fn();
    watcher.watch('k1', tmpDir, onChange);

    fs.writeFileSync(path.join(tmpDir, 'feedback_a.md'), 'first');
    await sleep(WAIT_FOR_FIRE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);

    fs.writeFileSync(path.join(tmpDir, 'feedback_b.md'), 'second');
    await sleep(WAIT_FOR_FIRE_MS);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  test('does not fire onChange after unwatch during the debounce window', async () => {
    const onChange = jest.fn();
    watcher.watch('k1', tmpDir, onChange);

    fs.writeFileSync(path.join(tmpDir, 'user_role.md'), 'hi');
    // Unwatch before the debounce timer fires.
    await sleep(TEST_DEBOUNCE_MS / 4);
    watcher.unwatch('k1');
    await sleep(WAIT_FOR_FIRE_MS);

    expect(onChange).not.toHaveBeenCalled();
  });

  test('multiple keys watching different dirs fire independently', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-watcher-b-'));
    try {
      const onA = jest.fn();
      const onB = jest.fn();
      watcher.watch('a', tmpDir, onA);
      watcher.watch('b', dir2, onB);

      fs.writeFileSync(path.join(tmpDir, 'user_role.md'), 'x');
      await sleep(WAIT_FOR_FIRE_MS);

      expect(onA).toHaveBeenCalledTimes(1);
      expect(onB).not.toHaveBeenCalled();

      fs.writeFileSync(path.join(dir2, 'feedback_y.md'), 'y');
      await sleep(WAIT_FOR_FIRE_MS);

      expect(onA).toHaveBeenCalledTimes(1);
      expect(onB).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  test('swallows onChange handler errors without crashing the watcher', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const onChange = jest.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    watcher.watch('k1', tmpDir, onChange);

    fs.writeFileSync(path.join(tmpDir, 'feedback_x.md'), 'hi');
    await sleep(WAIT_FOR_FIRE_MS);

    expect(onChange).toHaveBeenCalled();
    expect(watcher.isWatching('k1')).toBe(true);

    // A second change still fires despite the previous throw.
    fs.writeFileSync(path.join(tmpDir, 'feedback_y.md'), 'ho');
    await sleep(WAIT_FOR_FIRE_MS);
    expect(onChange).toHaveBeenCalledTimes(2);

    errSpy.mockRestore();
  });

  test('swallows async onChange rejections without crashing the watcher', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const onChange = jest.fn().mockRejectedValue(new Error('async boom'));
    watcher.watch('k1', tmpDir, onChange);

    fs.writeFileSync(path.join(tmpDir, 'user_role.md'), 'hi');
    await sleep(WAIT_FOR_FIRE_MS);

    expect(onChange).toHaveBeenCalled();
    expect(watcher.isWatching('k1')).toBe(true);

    errSpy.mockRestore();
  });
});
