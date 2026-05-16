// ─── Pandoc detection + runner ───────────────────────────────────────────────
// Required dependency for DOCX ingestion. Pandoc is the only tool in our
// stack that converts OOXML to markdown with semantic table preservation;
// the previous mammoth-based path collapsed tables into flat prose.
//
// Pandoc is an external binary (~100 MB Haskell install) that cannot be
// bundled via npm. Users install it via their platform package manager
// (brew / apt / choco) or from pandoc.org. Status checks can force a fresh
// probe so newly installed tools are detected without restarting the server.
// When pandoc is missing, DOCX uploads are rejected at the route level with
// install instructions.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { detectionEnv, resolveCommandOnPath, windowsPath } from './externalToolDetection';

const execFileAsync = promisify(execFile);

export interface PandocDetectionOptions {
  refresh?: boolean;
}

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
  return resolveCommandOnPath('pandoc', windowsPandocFallbacks());
}

function windowsPandocFallbacks(): string[] {
  return [
    windowsPath(process.env.LOCALAPPDATA, 'Pandoc', 'pandoc.exe'),
    windowsPath(process.env.LOCALAPPDATA, 'Programs', 'Pandoc', 'pandoc.exe'),
    windowsPath(process.env.ProgramFiles, 'Pandoc', 'pandoc.exe'),
    windowsPath(process.env['ProgramFiles(x86)'], 'Pandoc', 'pandoc.exe'),
  ].filter((item): item is string => !!item);
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
      env: await detectionEnv(),
      windowsHide: true,
    });
    const firstLine = stdout.split(/\r?\n/)[0] || '';
    const match = firstLine.match(/pandoc\s+([0-9.]+)/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Detect Pandoc availability and cache the result. User-facing status checks
 * pass `refresh: true` so a just-installed binary is picked up without
 * restarting Agent Cockpit.
 */
export async function detectPandoc(options: PandocDetectionOptions = {}): Promise<PandocStatus> {
  if (cached && !options.refresh) return cached;
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
 * `null` if detection hasn't run yet.
 */
export function getPandocStatus(): PandocStatus | null {
  return cached;
}

/**
 * Shell out to pandoc with the given args. Thin wrapper around
 * `execFile` that enforces a timeout and surfaces stderr in the error
 * message so handler code can build useful error entries. This function
 * refreshes detection before throwing if the cached status says Pandoc is
 * missing.
 */
export async function runPandoc(
  args: string[],
  options: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const status = cached?.available ? cached : await detectPandoc({ refresh: true });
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
export function resetPandocDetection(): void {
  cached = null;
}

export const _resetPandocCacheForTests = resetPandocDetection;

/**
 * Test-only: inject a fake status for unit tests that don't want to
 * shell out. `runPandoc` will still try to invoke the real binary, so
 * tests that need to mock execution should stub `execFile` via Jest's
 * module mocking instead.
 */
export function _setPandocStatusForTests(status: PandocStatus): void {
  cached = status;
}
