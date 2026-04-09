// ─── Pandoc detection + runner ───────────────────────────────────────────────
// Required dependency for DOCX ingestion. Pandoc is the only tool in our
// stack that converts OOXML to markdown with semantic table preservation;
// the previous mammoth-based path collapsed tables into flat prose.
//
// Pandoc is an external binary (~100 MB Haskell install) that cannot be
// bundled via npm. Users install it via their platform package manager
// (brew / apt / choco) or from pandoc.org. Detection runs once at startup
// and caches the result for the process lifetime. When pandoc is missing,
// DOCX uploads are rejected at the route level with install instructions.

import { spawn, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface PandocStatus {
  /** True iff `which pandoc` (or `where` on Windows) succeeded. */
  available: boolean;
  /** Absolute path to the detected binary, or null. */
  binaryPath: string | null;
  /** Pandoc version string (e.g. "3.1.12.1"), or null if unavailable. */
  version: string | null;
  /** ISO 8601 timestamp of the most recent detection. */
  checkedAt: string;
}

let cached: PandocStatus | null = null;

/**
 * Resolve the `pandoc` binary on PATH. Returns `null` if missing. Mirrors
 * the shape of `whichSoffice` in libreOffice.ts, except we also probe
 * `pandoc --version` because (a) it's fast and side-effect-free, and
 * (b) the version string is useful in the Settings UI status line.
 */
async function whichPandoc(): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    const child = spawn(cmd, ['pandoc'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.on('error', () => resolve(null));
    child.on('exit', (code) => {
      if (code !== 0) return resolve(null);
      const line = stdout.split(/\r?\n/)[0]?.trim();
      resolve(line || null);
    });
  });
}

/**
 * Extract the version from `pandoc --version` output. The first line of
 * that output is `pandoc 3.1.12.1` (or similar). Returns null if the
 * probe fails — e.g. binary is on PATH but not executable.
 */
async function probePandocVersion(binaryPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binaryPath, ['--version'], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const firstLine = stdout.split(/\r?\n/)[0] || '';
    const match = firstLine.match(/pandoc\s+([0-9.]+)/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Detect Pandoc availability and cache the result. Safe to call
 * repeatedly — subsequent calls return the cached value without
 * re-probing the filesystem.
 */
export async function detectPandoc(): Promise<PandocStatus> {
  if (cached) return cached;
  const binaryPath = await whichPandoc();
  const version = binaryPath ? await probePandocVersion(binaryPath) : null;
  cached = {
    available: binaryPath !== null,
    binaryPath,
    version,
    checkedAt: new Date().toISOString(),
  };
  return cached;
}

/**
 * Return the cached Pandoc status without triggering detection. Returns
 * `null` if detection hasn't run yet — callers should call `detectPandoc()`
 * at least once at startup.
 */
export function getPandocStatus(): PandocStatus | null {
  return cached;
}

/**
 * Shell out to pandoc with the given args. Thin wrapper around
 * `execFile` that enforces a timeout and surfaces stderr in the error
 * message so handler code can build useful error entries. Callers are
 * expected to have already verified `detectPandoc().available` before
 * invoking — this function throws a clear error if the binary isn't
 * found in the cached status.
 */
export async function runPandoc(
  args: string[],
  options: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const status = cached ?? (await detectPandoc());
  if (!status.available || !status.binaryPath) {
    throw new Error('Pandoc not available — refusing to run.');
  }
  try {
    const result = await execFileAsync(status.binaryPath, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const stderr = (e.stderr || '').trim();
    const msg = stderr ? `pandoc failed: ${stderr}` : `pandoc failed: ${e.message}`;
    throw new Error(msg);
  }
}

/**
 * Test-only: clear the cache so detection runs again on next call.
 * Not exported from the package index.
 */
export function _resetPandocCacheForTests(): void {
  cached = null;
}

/**
 * Test-only: inject a fake status for unit tests that don't want to
 * shell out. `runPandoc` will still try to invoke the real binary, so
 * tests that need to mock execution should stub `execFile` via Jest's
 * module mocking instead.
 */
export function _setPandocStatusForTests(status: PandocStatus): void {
  cached = status;
}
