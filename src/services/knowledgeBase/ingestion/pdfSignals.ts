// ─── PDF per-page signals (text extraction + figure/table detection) ────────
// Used by the hybrid PDF handler to decide whether each page can be served
// from deterministic pdfjs extraction (`safe-text`) or needs the Ingestion
// CLI to convert the rasterized image to Markdown (`needs-ai`).
//
// Two signals drive the decision:
//
//   - `figureCount`  Non-zero when the page contains a drawn image XObject —
//                    a figure, photo, diagram, OR a single full-page image
//                    (i.e. a scanned page). Any of these means pdfjs's
//                    extracted text is incomplete relative to ground truth.
//
//   - `tableLikely`  Heuristic over `getTextContent()` items. Buckets text
//                    items into rows by Y-coordinate, then checks whether
//                    multiple rows have a consistent column count and tight
//                    X-alignment. Imperfect but catches obvious tables.
//
// The classification rule lives in the handler (`figureCount === 0 &&
// !tableLikely → safe-text`) — this module just produces the signals.
//
// Errors are swallowed and mapped to **conservative needs-ai signals**
// (`figureCount = 1`, `tableLikely = false`, `extractedText = ''`,
// `extractedChars = 0`). The design's failure-mode table calls this out
// explicitly: when pdfjs probes throw, we should assume the page has
// structure and let the AI converter handle it.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PageSignals {
  /** Plain-text body of the page from `getTextContent()`. */
  extractedText: string;
  /** Length of `extractedText` after trimming surrounding whitespace. */
  extractedChars: number;
  /** Count of image-paint operators from `getOperatorList()`. */
  figureCount: number;
  /** True when the layout heuristic suspects a table on this page. */
  tableLikely: boolean;
}

/** Minimal shape of `pdfjs.OPS` we need from the resolved PDF.js module. */
export interface OpsEnum {
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintInlineImageXObjectGroup?: number;
  paintImageXObjectRepeat?: number;
}

/** Minimal shape of a TextItem from `page.getTextContent()`. */
export interface TextItemLike {
  str: string;
  /** PDF transform matrix `[a, b, c, d, e, f]` — `e` is X, `f` is Y. */
  transform: number[];
  width: number;
  height: number;
  /** Marked-content items don't have `str`; we filter them by checking this. */
  hasEOL?: boolean;
}

/** Minimal shape of `getOperatorList()`'s result. */
export interface OperatorListLike {
  fnArray: number[];
  argsArray: any[];
}

/** Minimal shape of a pdfjs `PDFPageProxy`. */
export interface PdfPageProxyLike {
  getTextContent(): Promise<{ items: Array<TextItemLike | { type: string }> }>;
  getOperatorList(): Promise<OperatorListLike>;
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Count image-paint operators in an operator list. Includes
 * `paintImageXObject`, `paintInlineImageXObject`, and the variants
 * (`paintInlineImageXObjectGroup`, `paintImageXObjectRepeat`) — all of them
 * indicate a drawn image, which means pdfjs text alone is incomplete.
 */
export function countFigures(opList: OperatorListLike, ops: OpsEnum): number {
  const targets = new Set<number>();
  targets.add(ops.paintImageXObject);
  targets.add(ops.paintInlineImageXObject);
  if (typeof ops.paintInlineImageXObjectGroup === 'number') {
    targets.add(ops.paintInlineImageXObjectGroup);
  }
  if (typeof ops.paintImageXObjectRepeat === 'number') {
    targets.add(ops.paintImageXObjectRepeat);
  }
  let count = 0;
  for (const fn of opList.fnArray) {
    if (targets.has(fn)) count += 1;
  }
  return count;
}

/**
 * Heuristic table detector over a page's text items.
 *
 * Algorithm:
 *   1. Filter to real text items (skip marked-content), ignore empty strings.
 *   2. Group items into rows by Y-coordinate (transform[5]). Items within
 *      `rowTolerance` device-space units belong to the same row.
 *   3. Drop rows with fewer than `minColumnsPerRow` items.
 *   4. If `minTableRows` consecutive rows share the same column count AND
 *      the X-positions of items in each column line up across rows (within
 *      `xTolerance`), declare `tableLikely = true`.
 *
 * Tunable defaults below are conservative starting values — design §16
 * flags this as a tuning open question.
 */
export function detectTableLikely(
  items: TextItemLike[],
  opts: {
    rowTolerance?: number;
    xTolerance?: number;
    minColumnsPerRow?: number;
    minTableRows?: number;
  } = {},
): boolean {
  const rowTolerance = opts.rowTolerance ?? 2.0;
  const xTolerance = opts.xTolerance ?? 5.0;
  const minColumnsPerRow = opts.minColumnsPerRow ?? 2;
  const minTableRows = opts.minTableRows ?? 3;

  const cleaned = items
    .filter((it) => typeof it.str === 'string' && it.str.trim().length > 0)
    .filter((it) => Array.isArray(it.transform) && it.transform.length >= 6)
    .map((it) => ({
      x: it.transform[4],
      y: it.transform[5],
      str: it.str,
    }));
  if (cleaned.length === 0) return false;

  cleaned.sort((a, b) => b.y - a.y || a.x - b.x);

  const rows: Array<Array<{ x: number; y: number; str: string }>> = [];
  for (const item of cleaned) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last[0].y - item.y) <= rowTolerance) {
      last.push(item);
    } else {
      rows.push([item]);
    }
  }

  const candidateRows = rows.filter((r) => r.length >= minColumnsPerRow);
  if (candidateRows.length < minTableRows) return false;

  let runStart = 0;
  while (runStart <= candidateRows.length - minTableRows) {
    const cols = candidateRows[runStart].length;
    let runEnd = runStart;
    while (
      runEnd + 1 < candidateRows.length &&
      candidateRows[runEnd + 1].length === cols
    ) {
      runEnd += 1;
    }
    if (runEnd - runStart + 1 >= minTableRows) {
      const xByCol: number[][] = Array.from({ length: cols }, () => []);
      for (let i = runStart; i <= runEnd; i += 1) {
        const sortedRow = [...candidateRows[i]].sort((a, b) => a.x - b.x);
        for (let c = 0; c < cols; c += 1) {
          xByCol[c].push(sortedRow[c].x);
        }
      }
      const aligned = xByCol.every((xs) => {
        const min = Math.min(...xs);
        const max = Math.max(...xs);
        return max - min <= xTolerance;
      });
      if (aligned) return true;
    }
    runStart = runEnd + 1;
  }

  return false;
}

/**
 * Concatenate text items into a single string, joining with spaces and
 * inserting newlines on `hasEOL`. Mirrors what most callers want from
 * `getTextContent()` without forcing them to walk the items array.
 */
export function flattenTextContent(
  items: Array<TextItemLike | { type: string }>,
): string {
  const parts: string[] = [];
  for (const it of items) {
    if (typeof (it as TextItemLike).str !== 'string') continue;
    const item = it as TextItemLike;
    parts.push(item.str);
    if (item.hasEOL) parts.push('\n');
  }
  return parts.join('').replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * Extract the per-page signals used by the PDF hybrid classifier.
 *
 * Failures inside pdfjs probes are caught and surface as **conservative
 * needs-ai signals** so the page falls into the AI conversion path rather
 * than silently being dropped from `text.md`.
 */
export async function extractPageSignals(
  page: PdfPageProxyLike,
  ops: OpsEnum,
): Promise<PageSignals> {
  let textContent: { items: Array<TextItemLike | { type: string }> } = { items: [] };
  let textOk = true;
  try {
    textContent = await page.getTextContent();
  } catch {
    textOk = false;
  }

  let figureCount = 0;
  let opsOk = true;
  try {
    const opList = await page.getOperatorList();
    figureCount = countFigures(opList, ops);
  } catch {
    opsOk = false;
  }

  if (!textOk || !opsOk) {
    return {
      extractedText: '',
      extractedChars: 0,
      figureCount: Math.max(figureCount, 1),
      tableLikely: false,
    };
  }

  const realItems = textContent.items.filter(
    (it): it is TextItemLike => typeof (it as TextItemLike).str === 'string',
  );
  const extractedText = flattenTextContent(textContent.items);
  const tableLikely = detectTableLikely(realItems);

  return {
    extractedText,
    extractedChars: extractedText.length,
    figureCount,
    tableLikely,
  };
}
