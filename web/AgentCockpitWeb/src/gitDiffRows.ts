export const DEFAULT_DIFF_CONTEXT_LINES = 3;

export type SideBySideRowType = 'context' | 'changed' | 'removed' | 'added';

export interface SideBySideRow {
  type: SideBySideRowType;
  oldNumber: number | null;
  newNumber: number | null;
  oldLine: string;
  newLine: string;
}

export interface InlineDiffPart {
  text: string;
  changed: boolean;
}

export type FoldedSideBySideRow =
  | { kind: 'line'; row: SideBySideRow }
  | { kind: 'hunk'; id: string; label: string; hiddenBefore: number; hiddenRows: SideBySideRow[] };

const INLINE_TOKEN_PRODUCT_LIMIT = 80000;

export function linesOf(text: string): string[] {
  if (text === '') return [];
  const raw = String(text || '').split('\n');
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop();
  return raw;
}

export function buildSideBySideRows(oldText: string, newText: string): SideBySideRow[] {
  const oldLines = linesOf(oldText);
  const newLines = linesOf(newText);
  const product = oldLines.length * newLines.length;
  if (product > 400000) {
    const max = Math.max(oldLines.length, newLines.length);
    const rows: SideBySideRow[] = [];
    for (let i = 0; i < max; i += 1) {
      const oldLine = i < oldLines.length ? oldLines[i] : '';
      const newLine = i < newLines.length ? newLines[i] : '';
      const type = oldLine === newLine ? 'context' : 'changed';
      rows.push({
        type,
        oldNumber: i < oldLines.length ? i + 1 : null,
        newNumber: i < newLines.length ? i + 1 : null,
        oldLine,
        newLine,
      });
    }
    return pairChangedRows(rows);
  }

  const dp = Array.from({ length: oldLines.length + 1 }, () => Array(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: SideBySideRow[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      rows.push({ type: 'context', oldNumber: i + 1, newNumber: j + 1, oldLine: oldLines[i], newLine: newLines[j] });
      i += 1;
      j += 1;
    } else if (j >= newLines.length || (i < oldLines.length && dp[i + 1][j] >= dp[i][j + 1])) {
      rows.push({ type: 'removed', oldNumber: i + 1, newNumber: null, oldLine: oldLines[i], newLine: '' });
      i += 1;
    } else {
      rows.push({ type: 'added', oldNumber: null, newNumber: j + 1, oldLine: '', newLine: newLines[j] });
      j += 1;
    }
  }
  return pairChangedRows(rows);
}

export function inlineDiffParts(oldText: string, newText: string): { oldParts: InlineDiffPart[]; newParts: InlineDiffPart[] } {
  if (oldText === newText) {
    return {
      oldParts: [{ text: oldText, changed: false }],
      newParts: [{ text: newText, changed: false }],
    };
  }

  const oldTokens = tokenizeInline(oldText);
  const newTokens = tokenizeInline(newText);
  if (oldTokens.length * newTokens.length > INLINE_TOKEN_PRODUCT_LIMIT) {
    return inlineDiffByAffix(oldText, newText);
  }

  const dp = Array.from({ length: oldTokens.length + 1 }, () => Array(newTokens.length + 1).fill(0));
  for (let i = oldTokens.length - 1; i >= 0; i -= 1) {
    for (let j = newTokens.length - 1; j >= 0; j -= 1) {
      dp[i][j] = oldTokens[i] === newTokens[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const oldParts: InlineDiffPart[] = [];
  const newParts: InlineDiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < oldTokens.length || j < newTokens.length) {
    if (i < oldTokens.length && j < newTokens.length && oldTokens[i] === newTokens[j]) {
      appendPart(oldParts, oldTokens[i], false);
      appendPart(newParts, newTokens[j], false);
      i += 1;
      j += 1;
    } else if (j >= newTokens.length || (i < oldTokens.length && dp[i + 1][j] >= dp[i][j + 1])) {
      appendPart(oldParts, oldTokens[i], true);
      i += 1;
    } else {
      appendPart(newParts, newTokens[j], true);
      j += 1;
    }
  }

  return { oldParts: absorbChangedWhitespace(oldParts), newParts: absorbChangedWhitespace(newParts) };
}

function pairChangedRows(rows: SideBySideRow[]): SideBySideRow[] {
  const paired: SideBySideRow[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.type !== 'removed' && row.type !== 'added') {
      paired.push(row);
      continue;
    }

    const removed: SideBySideRow[] = [];
    const added: SideBySideRow[] = [];
    while (i < rows.length && (rows[i].type === 'removed' || rows[i].type === 'added')) {
      if (rows[i].type === 'removed') removed.push(rows[i]);
      else added.push(rows[i]);
      i += 1;
    }
    i -= 1;

    const max = Math.max(removed.length, added.length);
    for (let k = 0; k < max; k += 1) {
      const oldRow = removed[k];
      const newRow = added[k];
      if (oldRow && newRow) {
        paired.push({
          type: 'changed',
          oldNumber: oldRow.oldNumber,
          newNumber: newRow.newNumber,
          oldLine: oldRow.oldLine,
          newLine: newRow.newLine,
        });
      } else if (oldRow) {
        paired.push(oldRow);
      } else if (newRow) {
        paired.push(newRow);
      }
    }
  }
  return paired;
}

function tokenizeInline(text: string): string[] {
  return String(text || '').match(/\s+|[\p{L}\p{N}_]+|./gu) || [];
}

function appendPart(parts: InlineDiffPart[], text: string, changed: boolean): void {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last && last.changed === changed) {
    last.text += text;
  } else {
    parts.push({ text, changed });
  }
}

function inlineDiffByAffix(oldText: string, newText: string): { oldParts: InlineDiffPart[]; newParts: InlineDiffPart[] } {
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix += 1;

  let suffix = 0;
  const maxSuffix = Math.min(oldText.length - prefix, newText.length - prefix);
  while (
    suffix < maxSuffix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldParts: InlineDiffPart[] = [];
  const newParts: InlineDiffPart[] = [];
  appendPart(oldParts, oldText.slice(0, prefix), false);
  appendPart(newParts, newText.slice(0, prefix), false);
  appendPart(oldParts, oldText.slice(prefix, oldText.length - suffix), true);
  appendPart(newParts, newText.slice(prefix, newText.length - suffix), true);
  appendPart(oldParts, oldText.slice(oldText.length - suffix), false);
  appendPart(newParts, newText.slice(newText.length - suffix), false);
  return { oldParts, newParts };
}

function absorbChangedWhitespace(parts: InlineDiffPart[]): InlineDiffPart[] {
  for (let i = 1; i < parts.length - 1; i += 1) {
    if (!parts[i].changed && /^\s+$/.test(parts[i].text) && parts[i - 1].changed && parts[i + 1].changed) {
      parts[i].changed = true;
    }
  }

  const merged: InlineDiffPart[] = [];
  for (const part of parts) {
    appendPart(merged, part.text, part.changed);
  }
  return merged;
}

export function foldSideBySideRows(rows: SideBySideRow[], contextLines = DEFAULT_DIFF_CONTEXT_LINES): FoldedSideBySideRow[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const changeIndexes: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i]?.type !== 'context') changeIndexes.push(i);
  }

  if (!changeIndexes.length) {
    return rows.map(row => ({ kind: 'line', row }));
  }

  const context = Math.max(0, Math.floor(Number(contextLines) || 0));
  const hunks: Array<{ start: number; end: number }> = [];
  for (const index of changeIndexes) {
    const start = Math.max(0, index - context);
    const end = Math.min(rows.length - 1, index + context);
    const last = hunks[hunks.length - 1];
    if (!last || start > last.end + 1) {
      hunks.push({ start, end });
    } else {
      last.end = Math.max(last.end, end);
    }
  }

  const folded: FoldedSideBySideRow[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const hiddenRows = rows.slice(cursor, hunk.start);
    folded.push({
      kind: 'hunk',
      id: `${cursor}:${hunk.start}:${hunk.end}`,
      label: hunkLabel(rows, hunk.start, hunk.end),
      hiddenBefore: hiddenRows.length,
      hiddenRows,
    });
    for (let i = hunk.start; i <= hunk.end; i += 1) {
      folded.push({ kind: 'line', row: rows[i] });
    }
    cursor = hunk.end + 1;
  }
  return folded;
}

function hunkLabel(rows: SideBySideRow[], start: number, end: number): string {
  const oldRange = sideRange(rows, start, end, 'oldNumber');
  const newRange = sideRange(rows, start, end, 'newNumber');
  return `@@ -${oldRange.start},${oldRange.count} +${newRange.start},${newRange.count} @@`;
}

function sideRange(rows: SideBySideRow[], start: number, end: number, key: 'oldNumber' | 'newNumber'): { start: number; count: number } {
  let first: number | null = null;
  let count = 0;
  for (let i = start; i <= end; i += 1) {
    const number = rows[i]?.[key];
    if (number == null) continue;
    if (first == null) first = number;
    count += 1;
  }
  if (first != null) return { start: first, count };
  return { start: previousLineNumber(rows, start, key), count: 0 };
}

function previousLineNumber(rows: SideBySideRow[], start: number, key: 'oldNumber' | 'newNumber'): number {
  for (let i = start - 1; i >= 0; i -= 1) {
    const number = rows[i]?.[key];
    if (number != null) return number;
  }
  return 0;
}
