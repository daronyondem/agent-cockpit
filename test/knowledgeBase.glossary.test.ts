import { expandGlossaryQuery } from '../src/services/knowledgeBase/glossary';

describe('expandGlossaryQuery', () => {
  test('expands matching terms inline and returns trace matches', () => {
    const result = expandGlossaryQuery('Check OEE target', [
      { term: 'OEE target', expansion: 'Overall Equipment Effectiveness target' },
    ]);

    expect(result.expandedQuery).toBe('Check OEE target (Overall Equipment Effectiveness target)');
    expect(result.matches).toEqual([
      { term: 'OEE target', expansion: 'Overall Equipment Effectiveness target' },
    ]);
  });

  test('matches case-insensitively with whole-word boundaries', () => {
    expect(expandGlossaryQuery('oee target', [
      { term: 'OEE', expansion: 'Overall Equipment Effectiveness' },
    ]).expandedQuery).toBe('oee (Overall Equipment Effectiveness) target');

    expect(expandGlossaryQuery('employee target', [
      { term: 'OEE', expansion: 'Overall Equipment Effectiveness' },
    ]).expandedQuery).toBe('employee target');
  });

  test('prefers longer overlapping terms without re-expanding shorter terms', () => {
    const result = expandGlossaryQuery('Check OEE target and OEE', [
      { term: 'OEE', expansion: 'Overall Equipment Effectiveness' },
      { term: 'OEE target', expansion: 'Overall Equipment Effectiveness target' },
    ]);

    expect(result.expandedQuery).toBe(
      'Check OEE target (Overall Equipment Effectiveness target) and OEE (Overall Equipment Effectiveness)',
    );
    expect(result.matches).toEqual([
      { term: 'OEE target', expansion: 'Overall Equipment Effectiveness target' },
      { term: 'OEE', expansion: 'Overall Equipment Effectiveness' },
    ]);
  });
});
