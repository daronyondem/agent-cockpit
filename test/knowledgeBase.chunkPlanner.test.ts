import { planDigestChunks } from '../src/services/knowledgeBase/chunkPlanner';
import type { KbDocumentNodeRow, KbDocumentRow } from '../src/services/knowledgeBase/db';

function doc(unitCount: number): KbDocumentRow {
  return {
    rawId: 'raw-1',
    docName: 'guide.pdf',
    docDescription: null,
    unitType: 'page',
    unitCount,
    structureStatus: 'ready',
    structureError: null,
    createdAt: '2026-05-05T00:00:00Z',
    updatedAt: '2026-05-05T00:00:00Z',
  };
}

function node(nodeId: string, startUnit: number, endUnit: number, sortOrder = startUnit): KbDocumentNodeRow {
  return {
    nodeId,
    rawId: 'raw-1',
    parentNodeId: null,
    title: nodeId,
    summary: null,
    startUnit,
    endUnit,
    sortOrder,
    source: 'deterministic',
    metadata: undefined,
  };
}

describe('planDigestChunks', () => {
  test('keeps a small document as one chunk', () => {
    const chunks = planDigestChunks(doc(10), [node('all', 1, 10)], { maxUnitsPerChunk: 25 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      rawId: 'raw-1',
      nodeIds: ['all'],
      startUnit: 1,
      endUnit: 10,
      reason: 'structure',
    });
  });

  test('splits a large page list by budget', () => {
    const chunks = planDigestChunks(doc(185), [node('all', 1, 185)], { maxUnitsPerChunk: 25 });
    expect(chunks).toHaveLength(8);
    expect(chunks[0]).toMatchObject({ startUnit: 1, endUnit: 25, reason: 'split-large-node' });
    expect(chunks[7]).toMatchObject({ startUnit: 176, endUnit: 185 });
  });

  test('preserves natural structure nodes where possible', () => {
    const chunks = planDigestChunks(
      doc(6),
      [node('intro', 1, 2), node('body', 3, 4), node('end', 5, 6)],
      { maxUnitsPerChunk: 2 },
    );
    expect(chunks.map((c) => c.nodeIds)).toEqual([['intro'], ['body'], ['end']]);
    expect(chunks.map((c) => [c.startUnit, c.endUnit])).toEqual([[1, 2], [3, 4], [5, 6]]);
  });

  test('fills uncovered unit gaps with fallback chunks', () => {
    const chunks = planDigestChunks(
      doc(6),
      [node('one', 1, 1), node('three', 3, 3), node('six', 6, 6)],
      { maxUnitsPerChunk: 2 },
    );
    expect(chunks.map((c) => [c.startUnit, c.endUnit, c.reason])).toEqual([
      [1, 1, 'structure'],
      [2, 2, 'fallback'],
      [3, 3, 'structure'],
      [4, 5, 'fallback'],
      [6, 6, 'structure'],
    ]);
  });

  test('merges small adjacent structure nodes up to the budget', () => {
    const chunks = planDigestChunks(
      doc(4),
      [node('a', 1, 1), node('b', 2, 2), node('c', 3, 3), node('d', 4, 4)],
      { maxUnitsPerChunk: 3 },
    );
    expect(chunks.map((c) => c.nodeIds)).toEqual([['a', 'b', 'c'], ['d']]);
    expect(chunks.map((c) => [c.startUnit, c.endUnit])).toEqual([[1, 3], [4, 4]]);
  });

  test('splits adjacent structure nodes when the estimated text budget would be exceeded', () => {
    const chunks = planDigestChunks(
      doc(6),
      [
        node('a', 1, 1),
        node('b', 2, 2),
        node('c', 3, 3),
        node('d', 4, 4),
        node('e', 5, 5),
        node('f', 6, 6),
      ],
      {
        maxUnitsPerChunk: 25,
        maxEstimatedTokensPerChunk: 1000,
        unitTextLengths: {
          1: 2000,
          2: 2000,
          3: 2000,
          4: 2000,
          5: 2000,
          6: 2000,
        },
      },
    );
    expect(chunks.map((c) => [c.startUnit, c.endUnit, c.estimatedTokens])).toEqual([
      [1, 2, 1000],
      [3, 4, 1000],
      [5, 6, 1000],
    ]);
  });

  test('falls back to complete ordered unit coverage when no nodes exist', () => {
    const chunks = planDigestChunks(doc(500), [], { maxUnitsPerChunk: 25 });
    expect(chunks).toHaveLength(20);
    expect(chunks[0]).toMatchObject({ startUnit: 1, endUnit: 25, reason: 'fallback' });
    expect(chunks[19]).toMatchObject({ startUnit: 476, endUnit: 500, reason: 'fallback' });
  });
});
