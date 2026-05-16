// ─── LibreOffice detection ───────────────────────────────────────────────────
// Optional dependency used by the Knowledge Base PPTX ingestion path to
// rasterize slides as PNGs for high-fidelity extraction. When
// `Settings.knowledgeBase.convertSlidesToImages` is enabled and LibreOffice
// is present on PATH, the ingestion step shells out to `soffice --headless`
// to convert the deck to PDF and then rasterizes via unpdf. When
// LibreOffice is missing but the setting is on, we log a warning once and
// fall back to text + speaker notes + embedded media only.
//
// Status checks can force a fresh probe so users who install LibreOffice after
// startup can refresh the UI without restarting Agent Cockpit.

import { resolveCommandOnPath, windowsPath } from './externalToolDetection';

export interface LibreOfficeDetectionOptions {
  refresh?: boolean;
}

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
  return resolveCommandOnPath('soffice', windowsLibreOfficeFallbacks());
}

function windowsLibreOfficeFallbacks(): string[] {
  return [
    windowsPath(process.env.ProgramFiles, 'LibreOffice', 'program', 'soffice.exe'),
    windowsPath(process.env['ProgramFiles(x86)'], 'LibreOffice', 'program', 'soffice.exe'),
    windowsPath(process.env.LOCALAPPDATA, 'Programs', 'LibreOffice', 'program', 'soffice.exe'),
  ].filter((item): item is string => !!item);
}

/**
 * Detect LibreOffice availability and cache the result. User-facing status
 * checks pass `refresh: true` so a just-installed binary is picked up without
 * restarting Agent Cockpit.
 */
export async function detectLibreOffice(options: LibreOfficeDetectionOptions = {}): Promise<LibreOfficeStatus> {
  if (cached && !options.refresh) return cached;
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
 * Returns `null` if detection hasn't run yet.
 */
export function getLibreOfficeStatus(): LibreOfficeStatus | null {
  return cached;
}

/**
 * Test-only: clear the cache so detection runs again on next call.
 * Not exported from the package index.
 */
export function resetLibreOfficeDetection(): void {
  cached = null;
}

export const _resetLibreOfficeCacheForTests = resetLibreOfficeDetection;
