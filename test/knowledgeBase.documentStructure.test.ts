import { buildDocumentStructure } from '../src/services/knowledgeBase/documentStructure';

describe('buildDocumentStructure', () => {
  const now = '2026-05-05T00:00:00.000Z';

  test('creates page nodes from PDF-style page headings', () => {
    const structure = buildDocumentStructure({
      rawId: 'raw-pdf',
      filename: 'guide.pdf',
      text: '## Page 1\nIntro\n\n## Page 2\nMore\n\n## Page 3\nEnd',
      metadata: { pageCount: 3 },
      now,
    });

    expect(structure.document).toMatchObject({
      rawId: 'raw-pdf',
      docName: 'guide.pdf',
      unitType: 'page',
      unitCount: 3,
      structureStatus: 'ready',
    });
    expect(structure.nodes.map((n) => [n.nodeId, n.startUnit, n.endUnit])).toEqual([
      ['page-1', 1, 1],
      ['page-2', 2, 2],
      ['page-3', 3, 3],
    ]);
  });

  test('creates slide nodes from PPTX-style slide headings', () => {
    const structure = buildDocumentStructure({
      rawId: 'raw-pptx',
      filename: 'deck.pptx',
      text: '## Slide 1\nTitle\n\n## Slide 2\nRoadmap',
      metadata: { slideCount: 2 },
      now,
    });

    expect(structure.document.unitType).toBe('slide');
    expect(structure.document.unitCount).toBe(2);
    expect(structure.nodes.map((n) => n.title)).toEqual(['Slide 1', 'Slide 2']);
  });

  test('creates hierarchical section nodes from markdown headings', () => {
    const structure = buildDocumentStructure({
      rawId: 'raw-md',
      filename: 'notes.md',
      text: '# Root\n\n## Child\n\n### Grandchild\n\n## Sibling',
      metadata: {},
      now,
    });

    expect(structure.document.unitType).toBe('section');
    expect(structure.document.unitCount).toBe(4);
    expect(structure.nodes.map((n) => [n.nodeId, n.parentNodeId, n.title])).toEqual([
      ['section-1', null, 'Root'],
      ['section-2', 'section-1', 'Child'],
      ['section-3', 'section-2', 'Grandchild'],
      ['section-4', 'section-1', 'Sibling'],
    ]);
  });

  test('falls back to one node covering the whole document', () => {
    const structure = buildDocumentStructure({
      rawId: 'raw-txt',
      filename: 'plain.txt',
      text: 'No headings here.',
      metadata: {},
      now,
    });

    expect(structure.document.unitType).toBe('unknown');
    expect(structure.document.unitCount).toBe(1);
    expect(structure.nodes).toEqual([
      expect.objectContaining({
        nodeId: 'root',
        title: 'plain.txt',
        startUnit: 1,
        endUnit: 1,
        source: 'fallback',
      }),
    ]);
  });
});
