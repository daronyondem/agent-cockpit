import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { atomicWriteFile } from '../src/utils/atomicWrite';

describe('atomicWriteFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atomic-write-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test('writes new file', async () => {
    const target = path.join(dir, 'out.json');
    await atomicWriteFile(target, '{"a":1}');
    expect(await fsp.readFile(target, 'utf8')).toBe('{"a":1}');
  });

  test('replaces existing file in full', async () => {
    const target = path.join(dir, 'out.json');
    await fsp.writeFile(target, '{"a":1}', 'utf8');
    await atomicWriteFile(target, '{"b":2}');
    expect(await fsp.readFile(target, 'utf8')).toBe('{"b":2}');
  });

  test('many concurrent writes converge to one complete winner (no torn files)', async () => {
    const target = path.join(dir, 'out.json');
    const writes: Promise<void>[] = [];
    // Each writer produces a unique, well-formed JSON payload. Under the
    // old non-atomic writeFile these can byte-interleave — this regression
    // guard passes only when every concurrent writer leaves the final file
    // as one complete JSON object.
    for (let i = 0; i < 20; i++) {
      const payload = JSON.stringify({ writer: i, pad: 'x'.repeat(500 + i * 50) });
      writes.push(atomicWriteFile(target, payload));
    }
    await Promise.all(writes);

    const finalContent = await fsp.readFile(target, 'utf8');
    // Must parse cleanly — no torn concatenation.
    const parsed = JSON.parse(finalContent);
    expect(typeof parsed.writer).toBe('number');
    expect(parsed.writer).toBeGreaterThanOrEqual(0);
    expect(parsed.writer).toBeLessThan(20);
  });

  test('cleans up tmp file if rename fails', async () => {
    // Point at a nonexistent directory so rename fails.
    const target = path.join(dir, 'missing-subdir', 'out.json');
    await expect(atomicWriteFile(target, 'x')).rejects.toThrow();
    // No stray tmp files in the parent dir we own.
    const entries = await fsp.readdir(dir);
    expect(entries.filter(e => e.includes('.tmp.'))).toEqual([]);
  });

  test('parallel reads during write see either old or new content, never torn', async () => {
    const target = path.join(dir, 'out.json');
    await atomicWriteFile(target, '{"v":"old"}');

    const writePromise = atomicWriteFile(target, '{"v":"new"}');
    const reads: Promise<string>[] = [];
    for (let i = 0; i < 50; i++) {
      reads.push(fsp.readFile(target, 'utf8'));
    }
    const [, ...results] = await Promise.all([writePromise, ...reads]);
    for (const r of results as string[]) {
      // Must be one of the two valid payloads, never a partial mix.
      expect(['{"v":"old"}', '{"v":"new"}']).toContain(r);
    }
  });
});
