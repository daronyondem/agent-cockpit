import {
  buildContextMapRunTimings,
  buildExtractionFailureMessage,
  buildExtractionTimingSummary,
  countDraftsByType,
  draftTypeCount,
  emptySynthesisMetadata,
  summarizeExtractionRepairs,
  truncateErrorMessage,
} from '../src/services/contextMap/pipelineMetadata';

describe('Context Map pipeline metadata helpers', () => {
  test('summarizes extraction timing and repair metadata deterministically', () => {
    expect(buildExtractionTimingSummary([
      { sourceType: 'file', sourceId: 'b', durationMs: 20, status: 'failed', candidates: 0 },
      { sourceType: 'conversation_message', sourceId: 'a', durationMs: 20, status: 'succeeded', candidates: 2, repaired: true },
      { sourceType: 'file', sourceId: 'c', durationMs: 5, status: 'succeeded', candidates: 1 },
    ])).toMatchObject({
      total: 3,
      succeeded: 2,
      failed: 1,
      slowest: [
        { sourceId: 'a' },
        { sourceId: 'b' },
        { sourceId: 'c' },
      ],
    });

    expect(summarizeExtractionRepairs([
      { sourceType: 'file', sourceId: 'bad.json', succeeded: false, errorMessage: 'invalid' },
      { sourceType: 'file', sourceId: 'fixed.json', succeeded: true },
    ])).toEqual({
      attempted: 2,
      succeeded: 1,
      failed: 1,
      failures: [{ sourceType: 'file', sourceId: 'bad.json', errorMessage: 'invalid' }],
    });
  });

  test('formats run timings, synthesis defaults, type counts, and compact errors', () => {
    expect(buildContextMapRunTimings({
      totalMs: 100,
      planningMs: 10,
      sourceDiscoveryMs: 20,
      extractionMs: 30,
      synthesisMs: 40,
      persistenceMs: 5,
      autoApplyMs: 6,
      extractionUnits: buildExtractionTimingSummary([]),
      synthesisStages: [],
    })).toMatchObject({ totalMs: 100, extractionMs: 30, autoApplyMs: 6 });

    expect(emptySynthesisMetadata(2)).toEqual({
      attempted: false,
      inputCandidates: 2,
      outputCandidates: 2,
      droppedCandidates: 0,
      openQuestions: [],
    });

    const drafts = [{ candidateType: 'new_entity' as const }, { candidateType: 'new_entity' as const }, { candidateType: 'new_relationship' as const }];
    expect(countDraftsByType(drafts)).toEqual({ new_entity: 2, new_relationship: 1 });
    expect(draftTypeCount(drafts, 'new_entity')).toBe(2);

    expect(buildExtractionFailureMessage([
      { sourceType: 'file', sourceId: 'a.md', errorMessage: 'x'.repeat(300) },
    ])).toContain('1 Context Map extraction unit failed');
    expect(truncateErrorMessage('a\n'.repeat(300))).toHaveLength(220);
  });
});
