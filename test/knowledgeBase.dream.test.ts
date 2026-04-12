/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Dreaming pipeline helper tests ───────────────────────────────────────
//
// Tests for the exported helpers in dream.ts: extractAffectedTopicIds,
// parseVerificationOutput.

import {
  extractAffectedTopicIds,
  parseVerificationOutput,
  parseDiscoveryOutput,
} from '../src/services/knowledgeBase/dream';
import type { DreamOperation } from '../src/services/knowledgeBase/dreamOps';

// ── extractAffectedTopicIds ───────────────────────────────────────────────

describe('extractAffectedTopicIds', () => {
  test('returns empty array for empty operations', () => {
    expect(extractAffectedTopicIds([])).toEqual([]);
  });

  test('extracts topic_id from create_topic', () => {
    const ops: DreamOperation[] = [
      { op: 'create_topic', topic_id: 'topic-a', title: 'A', summary: 'S', content: 'C' },
    ];
    expect(extractAffectedTopicIds(ops)).toEqual(['topic-a']);
  });

  test('extracts topic_id from update_topic', () => {
    const ops: DreamOperation[] = [
      { op: 'update_topic', topic_id: 'topic-b', title: 'B' },
    ];
    expect(extractAffectedTopicIds(ops)).toEqual(['topic-b']);
  });

  test('extracts topic_id from delete_topic', () => {
    const ops: DreamOperation[] = [
      { op: 'delete_topic', topic_id: 'topic-c' },
    ];
    expect(extractAffectedTopicIds(ops)).toEqual(['topic-c']);
  });

  test('extracts into_topic_id from merge_topics', () => {
    const ops: DreamOperation[] = [
      {
        op: 'merge_topics',
        source_topic_ids: ['x', 'y'],
        into_topic_id: 'topic-merged',
        title: 'Merged',
        summary: 'S',
        content: 'C',
      },
    ];
    expect(extractAffectedTopicIds(ops)).toEqual(['topic-merged']);
  });

  test('extracts into[] topic_ids from split_topic', () => {
    const ops: DreamOperation[] = [
      {
        op: 'split_topic',
        source_topic_id: 'topic-big',
        into: [
          { topic_id: 'topic-a', title: 'A', summary: 'SA', content: 'CA' },
          { topic_id: 'topic-b', title: 'B', summary: 'SB', content: 'CB' },
        ],
      },
    ];
    const result = extractAffectedTopicIds(ops);
    expect(result).toContain('topic-a');
    expect(result).toContain('topic-b');
    expect(result).not.toContain('topic-big');
  });

  test('deduplicates topic IDs', () => {
    const ops: DreamOperation[] = [
      { op: 'create_topic', topic_id: 'topic-a', title: 'A', summary: 'S', content: 'C' },
      { op: 'update_topic', topic_id: 'topic-a', content: 'Updated' },
    ];
    expect(extractAffectedTopicIds(ops)).toEqual(['topic-a']);
  });

  test('skips non-topic operations', () => {
    const ops: DreamOperation[] = [
      { op: 'assign_entries', topic_id: 'topic-a', entry_ids: ['e1'] },
      { op: 'add_connection', source_topic: 'a', target_topic: 'b', relationship: 'r', confidence: 'inferred' },
      { op: 'remove_connection', source_topic: 'a', target_topic: 'b' },
    ];
    expect(extractAffectedTopicIds(ops)).toEqual([]);
  });

  test('handles mixed operations', () => {
    const ops: DreamOperation[] = [
      { op: 'create_topic', topic_id: 'new-topic', title: 'New', summary: 'S', content: 'C' },
      { op: 'assign_entries', topic_id: 'new-topic', entry_ids: ['e1'] },
      { op: 'update_topic', topic_id: 'existing-topic', content: 'Updated' },
      { op: 'add_connection', source_topic: 'new-topic', target_topic: 'existing-topic', relationship: 'r', confidence: 'inferred' },
    ];
    const result = extractAffectedTopicIds(ops);
    expect(result).toContain('new-topic');
    expect(result).toContain('existing-topic');
    expect(result).toHaveLength(2);
  });
});

// ── parseVerificationOutput ───────────────────────────────────────────────

describe('parseVerificationOutput', () => {
  test('parses valid verified/rejected JSON', () => {
    const raw = JSON.stringify({
      verified: [
        { entry_id: 'e1', topic_id: 'topic-a' },
        { entry_id: 'e2', topic_id: 'topic-b' },
      ],
      rejected: [
        { entry_id: 'e3', topic_id: 'topic-a' },
      ],
    });
    const result = parseVerificationOutput(raw);
    expect(result.verified).toHaveLength(2);
    expect(result.verified[0]).toEqual({ entry_id: 'e1', topic_id: 'topic-a' });
    expect(result.verified[1]).toEqual({ entry_id: 'e2', topic_id: 'topic-b' });
    expect(result.warnings).toHaveLength(0);
  });

  test('parses JSON inside markdown fences', () => {
    const raw = `Here is the result:
\`\`\`json
{
  "verified": [{ "entry_id": "e1", "topic_id": "t1" }],
  "rejected": []
}
\`\`\``;
    const result = parseVerificationOutput(raw);
    expect(result.verified).toHaveLength(1);
    expect(result.verified[0]).toEqual({ entry_id: 'e1', topic_id: 't1' });
    expect(result.warnings).toHaveLength(0);
  });

  test('returns warning when no JSON found', () => {
    const result = parseVerificationOutput('Just some text with no JSON');
    expect(result.verified).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/no JSON found/);
  });

  test('returns warning when JSON is malformed', () => {
    const result = parseVerificationOutput('{ bad json }}}');
    expect(result.verified).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/parse error/);
  });

  test('returns warning when verified array is missing', () => {
    const result = parseVerificationOutput(JSON.stringify({ rejected: [] }));
    expect(result.verified).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/missing "verified" array/);
  });

  test('skips entries with invalid shape', () => {
    const raw = JSON.stringify({
      verified: [
        { entry_id: 'e1', topic_id: 'topic-a' },
        { entry_id: 123, topic_id: 'topic-b' }, // invalid: not a string
        { entry_id: 'e3' }, // missing topic_id
      ],
      rejected: [],
    });
    const result = parseVerificationOutput(raw);
    expect(result.verified).toHaveLength(1);
    expect(result.verified[0]).toEqual({ entry_id: 'e1', topic_id: 'topic-a' });
  });

  test('handles JSON with preamble text', () => {
    const raw = `I analyzed the entries and here is my decision:
{"verified": [{"entry_id": "e1", "topic_id": "t1"}], "rejected": [{"entry_id": "e2", "topic_id": "t1"}]}`;
    const result = parseVerificationOutput(raw);
    expect(result.verified).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });
});

// ── parseDiscoveryOutput ─────────────────────────────────────────────────

describe('parseDiscoveryOutput', () => {
  test('parses valid accepted results', () => {
    const raw = JSON.stringify({
      results: [
        {
          topic_a: 'a', topic_b: 'b', accept: true,
          source_topic: 'a', target_topic: 'b',
          relationship: 'depends on', confidence: 'inferred',
          evidence: 'Both discuss auth patterns',
        },
        {
          topic_a: 'c', topic_b: 'd', accept: false,
          source_topic: 'c', target_topic: 'd',
          relationship: 'related', confidence: 'speculative',
          evidence: '',
        },
      ],
    });
    const result = parseDiscoveryOutput(raw);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].sourceTopic).toBe('a');
    expect(result.accepted[0].targetTopic).toBe('b');
    expect(result.accepted[0].relationship).toBe('depends on');
    expect(result.accepted[0].confidence).toBe('inferred');
    expect(result.warnings).toHaveLength(0);
  });

  test('returns warning when no JSON found', () => {
    const result = parseDiscoveryOutput('No useful output here');
    expect(result.accepted).toEqual([]);
    expect(result.warnings[0]).toMatch(/no JSON found/);
  });

  test('returns warning when results array is missing', () => {
    const result = parseDiscoveryOutput(JSON.stringify({ foo: 'bar' }));
    expect(result.accepted).toEqual([]);
    expect(result.warnings[0]).toMatch(/missing "results" array/);
  });

  test('defaults confidence to inferred when missing', () => {
    const raw = JSON.stringify({
      results: [
        {
          topic_a: 'a', topic_b: 'b', accept: true,
          source_topic: 'a', target_topic: 'b',
          relationship: 'related',
        },
      ],
    });
    const result = parseDiscoveryOutput(raw);
    expect(result.accepted[0].confidence).toBe('inferred');
  });

  test('skips entries with missing required fields', () => {
    const raw = JSON.stringify({
      results: [
        { topic_a: 'a', topic_b: 'b', accept: true, source_topic: 'a' },
        {
          topic_a: 'c', topic_b: 'd', accept: true,
          source_topic: 'c', target_topic: 'd', relationship: 'valid',
        },
      ],
    });
    const result = parseDiscoveryOutput(raw);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].sourceTopic).toBe('c');
  });

  test('parses JSON inside markdown fences', () => {
    const raw = `\`\`\`json
{
  "results": [
    { "topic_a": "x", "topic_b": "y", "accept": true,
      "source_topic": "x", "target_topic": "y",
      "relationship": "extends", "confidence": "extracted",
      "evidence": "Explicit reference" }
  ]
}
\`\`\``;
    const result = parseDiscoveryOutput(raw);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].confidence).toBe('extracted');
  });

  test('handles all rejected results', () => {
    const raw = JSON.stringify({
      results: [
        { topic_a: 'a', topic_b: 'b', accept: false },
        { topic_a: 'c', topic_b: 'd', accept: false },
      ],
    });
    const result = parseDiscoveryOutput(raw);
    expect(result.accepted).toEqual([]);
    expect(result.warnings).toHaveLength(0);
  });
});
