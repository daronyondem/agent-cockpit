/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── PDF per-page signal tests ──────────────────────────────────────────────
// Pure unit tests for the helpers that drive the hybrid handler's
// classify-vs-convert decision. Real pdfjs is not involved — every test
// constructs synthetic `TextItem` and `OperatorList` shapes and asserts
// the helper output. The `PdfPageProxyLike` interface lets us swap in a
// minimal mock for the `extractPageSignals` path without dragging the
// real PDF runtime into the test environment.

import {
  countFigures,
  detectTableLikely,
  extractPageSignals,
  flattenTextContent,
  type OpsEnum,
  type OperatorListLike,
  type PdfPageProxyLike,
  type TextItemLike,
} from '../src/services/knowledgeBase/ingestion/pdfSignals';

const OPS: OpsEnum = {
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintInlineImageXObjectGroup: 87,
  paintImageXObjectRepeat: 88,
};

function ti(str: string, x: number, y: number, opts: Partial<TextItemLike> = {}): TextItemLike {
  return {
    str,
    transform: [1, 0, 0, 1, x, y],
    width: opts.width ?? str.length * 5,
    height: opts.height ?? 10,
    hasEOL: opts.hasEOL ?? false,
  };
}

// ── countFigures ─────────────────────────────────────────────────────────────

describe('countFigures', () => {
  test('returns 0 when no image-paint operators present', () => {
    const opList: OperatorListLike = { fnArray: [1, 2, 3], argsArray: [] };
    expect(countFigures(opList, OPS)).toBe(0);
  });

  test('counts every paintImageXObject', () => {
    const opList: OperatorListLike = {
      fnArray: [1, OPS.paintImageXObject, 2, OPS.paintImageXObject, OPS.paintImageXObject],
      argsArray: [],
    };
    expect(countFigures(opList, OPS)).toBe(3);
  });

  test('counts inline + grouped + repeat variants', () => {
    const opList: OperatorListLike = {
      fnArray: [
        OPS.paintImageXObject,
        OPS.paintInlineImageXObject,
        OPS.paintInlineImageXObjectGroup!,
        OPS.paintImageXObjectRepeat!,
      ],
      argsArray: [],
    };
    expect(countFigures(opList, OPS)).toBe(4);
  });

  test('tolerates ops enum without optional variants', () => {
    const minimalOps: OpsEnum = {
      paintImageXObject: 85,
      paintInlineImageXObject: 86,
    };
    const opList: OperatorListLike = {
      fnArray: [85, 86, 87],
      argsArray: [],
    };
    expect(countFigures(opList, minimalOps)).toBe(2);
  });
});

// ── detectTableLikely ───────────────────────────────────────────────────────

describe('detectTableLikely', () => {
  test('returns false on empty input', () => {
    expect(detectTableLikely([])).toBe(false);
  });

  test('returns false for pure prose (single column)', () => {
    const items: TextItemLike[] = [
      ti('First paragraph runs across the page.', 50, 700),
      ti('Second paragraph follows below.', 50, 680),
      ti('Third paragraph still in one column.', 50, 660),
    ];
    expect(detectTableLikely(items)).toBe(false);
  });

  test('returns true for an obvious 3x3 table', () => {
    const items: TextItemLike[] = [
      ti('A1', 100, 700), ti('B1', 200, 700), ti('C1', 300, 700),
      ti('A2', 100, 680), ti('B2', 200, 680), ti('C2', 300, 680),
      ti('A3', 100, 660), ti('B3', 200, 660), ti('C3', 300, 660),
    ];
    expect(detectTableLikely(items)).toBe(true);
  });

  test('tolerates small X jitter within tolerance', () => {
    const items: TextItemLike[] = [
      ti('A1', 100, 700), ti('B1', 200, 700), ti('C1', 300, 700),
      ti('A2', 102, 680), ti('B2', 202, 680), ti('C2', 302, 680),
      ti('A3', 99, 660), ti('B3', 199, 660), ti('C3', 299, 660),
    ];
    expect(detectTableLikely(items)).toBe(true);
  });

  test('rejects when columns are misaligned beyond tolerance', () => {
    const items: TextItemLike[] = [
      ti('A1', 100, 700), ti('B1', 200, 700), ti('C1', 300, 700),
      ti('A2', 130, 680), ti('B2', 230, 680), ti('C2', 330, 680),
      ti('A3', 160, 660), ti('B3', 260, 660), ti('C3', 360, 660),
    ];
    expect(detectTableLikely(items)).toBe(false);
  });

  test('returns false when fewer rows than minTableRows', () => {
    const items: TextItemLike[] = [
      ti('A1', 100, 700), ti('B1', 200, 700),
      ti('A2', 100, 680), ti('B2', 200, 680),
    ];
    expect(detectTableLikely(items)).toBe(false);
  });

  test('groups items into the same row within rowTolerance', () => {
    const items: TextItemLike[] = [
      ti('A1', 100, 700.5), ti('B1', 200, 701), ti('C1', 300, 700.2),
      ti('A2', 100, 680), ti('B2', 200, 680), ti('C2', 300, 680),
      ti('A3', 100, 660), ti('B3', 200, 660), ti('C3', 300, 660),
    ];
    expect(detectTableLikely(items)).toBe(true);
  });
});

// ── flattenTextContent ──────────────────────────────────────────────────────

describe('flattenTextContent', () => {
  test('skips marked-content items without `str`', () => {
    const items = [
      ti('hello ', 0, 0),
      { type: 'beginMarkedContent' } as any,
      ti('world', 0, 0),
    ];
    expect(flattenTextContent(items)).toBe('hello world');
  });

  test('inserts newlines on hasEOL', () => {
    const items: TextItemLike[] = [
      ti('first line', 0, 0, { hasEOL: true }),
      ti('second line', 0, 0),
    ];
    expect(flattenTextContent(items)).toBe('first line\nsecond line');
  });

  test('trims surrounding whitespace', () => {
    const items: TextItemLike[] = [
      ti('   ', 0, 0),
      ti('content', 0, 0),
      ti('   ', 0, 0),
    ];
    expect(flattenTextContent(items)).toBe('content');
  });
});

// ── extractPageSignals ──────────────────────────────────────────────────────

function makePage(
  textItems: Array<TextItemLike | { type: string }>,
  fnArray: number[],
  opts: { textThrows?: boolean; opsThrows?: boolean } = {},
): PdfPageProxyLike {
  return {
    async getTextContent() {
      if (opts.textThrows) throw new Error('getTextContent failed');
      return { items: textItems };
    },
    async getOperatorList() {
      if (opts.opsThrows) throw new Error('getOperatorList failed');
      return { fnArray, argsArray: [] };
    },
  };
}

describe('extractPageSignals', () => {
  test('safe-text page: prose, no figures, no table', async () => {
    const items: TextItemLike[] = [
      ti('Plain prose paragraph one.', 50, 700, { hasEOL: true }),
      ti('Plain prose paragraph two.', 50, 680),
    ];
    const page = makePage(items, [1, 2, 3]);
    const sig = await extractPageSignals(page, OPS);
    expect(sig.figureCount).toBe(0);
    expect(sig.tableLikely).toBe(false);
    expect(sig.extractedText).toBe('Plain prose paragraph one.\nPlain prose paragraph two.');
    expect(sig.extractedChars).toBe(sig.extractedText.length);
  });

  test('needs-ai: figure present', async () => {
    const items: TextItemLike[] = [ti('Figure caption.', 50, 700)];
    const page = makePage(items, [1, OPS.paintImageXObject, 2]);
    const sig = await extractPageSignals(page, OPS);
    expect(sig.figureCount).toBe(1);
    expect(sig.tableLikely).toBe(false);
  });

  test('needs-ai: table layout detected', async () => {
    const items: TextItemLike[] = [
      ti('A1', 100, 700), ti('B1', 200, 700), ti('C1', 300, 700),
      ti('A2', 100, 680), ti('B2', 200, 680), ti('C2', 300, 680),
      ti('A3', 100, 660), ti('B3', 200, 660), ti('C3', 300, 660),
    ];
    const page = makePage(items, [1, 2, 3]);
    const sig = await extractPageSignals(page, OPS);
    expect(sig.figureCount).toBe(0);
    expect(sig.tableLikely).toBe(true);
  });

  test('getTextContent throws → conservative needs-ai signals', async () => {
    const page = makePage([], [1, 2], { textThrows: true });
    const sig = await extractPageSignals(page, OPS);
    expect(sig.figureCount).toBeGreaterThanOrEqual(1);
    expect(sig.tableLikely).toBe(false);
    expect(sig.extractedText).toBe('');
    expect(sig.extractedChars).toBe(0);
  });

  test('getOperatorList throws → conservative needs-ai signals', async () => {
    const items: TextItemLike[] = [ti('Plain prose.', 50, 700)];
    const page = makePage(items, [], { opsThrows: true });
    const sig = await extractPageSignals(page, OPS);
    expect(sig.figureCount).toBeGreaterThanOrEqual(1);
    expect(sig.tableLikely).toBe(false);
    expect(sig.extractedText).toBe('');
  });

  test('blank page: no items, no figures → safe-text empty', async () => {
    const page = makePage([], [1, 2, 3]);
    const sig = await extractPageSignals(page, OPS);
    expect(sig.figureCount).toBe(0);
    expect(sig.tableLikely).toBe(false);
    expect(sig.extractedText).toBe('');
    expect(sig.extractedChars).toBe(0);
  });
});
