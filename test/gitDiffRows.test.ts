import { buildSideBySideRows, foldSideBySideRows, inlineDiffParts } from '../web/AgentCockpitWeb/src/gitDiffRows';

function numberedLines(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`);
}

function visibleOldNumbers(folded: Array<any>): number[] {
  return folded
    .filter(entry => entry.kind === 'line' && entry.row.oldNumber != null)
    .map(entry => entry.row.oldNumber);
}

function hiddenOldNumbers(hunk: any): number[] {
  return hunk.hiddenRows
    .filter((row: any) => row.oldNumber != null)
    .map((row: any) => row.oldNumber);
}

function changedText(parts: Array<{ text: string; changed: boolean }>): string {
  return parts.filter(part => part.changed).map(part => part.text).join('');
}

describe('git diff row folding', () => {
  test('keeps clean diffs as plain line rows', () => {
    const rows = buildSideBySideRows('one\ntwo\n', 'one\ntwo\n');
    const folded = foldSideBySideRows(rows, 2);

    expect(folded).toEqual([
      { kind: 'line', row: expect.objectContaining({ type: 'context', oldNumber: 1, newNumber: 1 }) },
      { kind: 'line', row: expect.objectContaining({ type: 'context', oldNumber: 2, newNumber: 2 }) },
    ]);
  });

  test('folds unchanged spans outside separated change hunks', () => {
    const oldLines = numberedLines(30);
    const newLines = numberedLines(30);
    newLines[4] = 'line five changed';
    newLines[24] = 'line twenty five changed';

    const rows = buildSideBySideRows(`${oldLines.join('\n')}\n`, `${newLines.join('\n')}\n`);
    const folded = foldSideBySideRows(rows, 2);
    const hunks = folded.filter(entry => entry.kind === 'hunk');
    const visible = visibleOldNumbers(folded);

    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toEqual(expect.objectContaining({ hiddenBefore: 2 }));
    expect(hunks[1].hiddenBefore).toBeGreaterThan(10);
    expect(hiddenOldNumbers(hunks[0])).toEqual([1, 2]);
    expect(hiddenOldNumbers(hunks[1])).toEqual(Array.from({ length: 15 }, (_, i) => i + 8));
    expect(hunks[0].label).toMatch(/^@@ -3,/);
    expect(visible).toEqual(expect.arrayContaining([3, 5, 7, 23, 25, 27]));
    expect(visible).not.toContain(15);
    expect(folded.length).toBeLessThan(rows.length);
  });

  test('pairs replacement lines and marks inline changed text', () => {
    const rows = buildSideBySideRows(
      '| Workspace file explorer | src/routes/chat.ts | Frontend flow below. |\n',
      '| Workspace file explorer and Git changes | src/routes/chat.ts | Frontend flow below. |\n',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      type: 'changed',
      oldNumber: 1,
      newNumber: 1,
    }));

    const inline = inlineDiffParts(rows[0].oldLine, rows[0].newLine);
    expect(changedText(inline.oldParts)).toBe('');
    expect(changedText(inline.newParts)).toBe('and Git changes ');
  });

  test('marks granular replacement spans on both sides', () => {
    const inline = inlineDiffParts('workspace file explorer', 'workspace Git changes');

    expect(changedText(inline.oldParts)).toBe('file explorer');
    expect(changedText(inline.newParts)).toBe('Git changes');
  });
});
