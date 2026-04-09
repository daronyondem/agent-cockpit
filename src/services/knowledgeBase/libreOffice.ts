// ─── LibreOffice detection ───────────────────────────────────────────────────
// Optional dependency used by the Knowledge Base PPTX ingestion path to
// rasterize slides as PNGs for high-fidelity extraction. When
// `Settings.knowledgeBase.convertSlidesToImages` is enabled and LibreOffice
// is present on PATH, the ingestion step shells out to `soffice --headless`
// to convert the deck to PDF and then rasterizes via unpdf. When
// LibreOffice is missing but the setting is on, we log a warning once and
// fall back to text + speaker notes + embedded media only.
//
// Detection is done at startup and cached for the process lifetime; there
// is no hot-reload. Users who install LibreOffice after startup must
// restart the cockpit to pick it up.

import { spawn } from 'child_process';

export interface LibreOfficeStatus {
  /** True iff `which soffice` (or equivalent) succeeded. */
  available: boolean;
  /** Absolute path to the detected binary, or null. */
  binaryPath: string | null;
  /** ISO 8601 timestamp of the most recent detection. */
  checkedAt: string;
}

let cached: LibreOfficeStatus | null = null;

/**
 * Resolve the `soffice` binary on PATH using the platform's "where is
 * this command" shell built-in. Returns `null` if missing.
 *
 * We deliberately use `which`/`where` rather than trying to invoke
 * `soffice --version` to keep startup fast and side-effect-free: the
 * version probe opens a LibreOffice user profile on first run, which
 * is noisy and slow.
 */
async function whichSoffice(): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    const child = spawn(cmd, ['soffice'], { stdio: ['ignore', 'pipe', 'ignore'] });
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
 * Detect LibreOffice availability and cache the result. Safe to call
 * repeatedly — subsequent calls return the cached value without
 * re-probing the filesystem.
 */
export async function detectLibreOffice(): Promise<LibreOfficeStatus> {
  if (cached) return cached;
  const binaryPath = await whichSoffice();
  cached = {
    available: binaryPath !== null,
    binaryPath,
    checkedAt: new Date().toISOString(),
  };
  return cached;
}

/**
 * Return the cached LibreOffice status without triggering detection.
 * Returns `null` if detection hasn't run yet — callers should call
 * `detectLibreOffice()` at least once at startup.
 */
export function getLibreOfficeStatus(): LibreOfficeStatus | null {
  return cached;
}

/**
 * Test-only: clear the cache so detection runs again on next call.
 * Not exported from the package index.
 */
export function _resetLibreOfficeCacheForTests(): void {
  cached = null;
}
