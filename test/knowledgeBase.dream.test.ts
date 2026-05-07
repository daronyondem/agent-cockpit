/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Dreaming pipeline helper tests ───────────────────────────────────────
//
// Tests for the exported helpers in dream.ts: extractAffectedTopicIds,
// parseVerificationOutput.

// Module mocks — hoisted by Jest so safe to declare before imports.
jest.mock('../src/services/knowledgeBase/embeddings', () => ({
  checkOllamaHealth: jest.fn().mockResolvedValue({ ok: true }),
  resolveConfig: jest.fn().mockReturnValue({ model: 'test', ollamaHost: 'http://localhost:11434', dimensions: 768 }),
  embedText: jest.fn().mockResolvedValue({ embedding: [] }),
  embedBatch: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/services/knowledgeBase/dreamMarkdown', () => ({
  regenerateSynthesisMarkdown: jest.fn(),
}));

jest.mock('../src/services/knowledgeBase/dreamOps', () => ({
  parseDreamOutput: jest.fn().mockReturnValue({ operations: [], warnings: [] }),
  applyOperations: jest.fn().mockReturnValue([]),
}));

import fs from 'fs';
import {
  extractAffectedTopicIds,
  parseVerificationOutput,
  parseDiscoveryOutput,
  parseReflectionOutput,
  identifyTopicClusters,
  buildReflectionPrompt,
  hasParseFailure,
  KbDreamService,
} from '../src/services/knowledgeBase/dream';
import type { DreamOperation } from '../src/services/knowledgeBase/dreamOps';
import * as dreamOpsMod from '../src/services/knowledgeBase/dreamOps';
import * as embeddingsMod from '../src/services/knowledgeBase/embeddings';

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

  test('handles braces inside string values without truncating', () => {
    const raw = JSON.stringify({
      verified: [
        { entry_id: 'e1', topic_id: 't1', note: 'Matches template `{ foo: 1 }`' },
      ],
      rejected: [],
    });
    const result = parseVerificationOutput(raw);
    expect(result.warnings).toHaveLength(0);
    expect(result.verified).toHaveLength(1);
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

  test('handles braces inside string values without truncating', () => {
    const raw = JSON.stringify({
      results: [
        {
          topic_a: 'a', topic_b: 'b', accept: true,
          source_topic: 'a', target_topic: 'b',
          relationship: 'related',
          evidence: 'Both use shape { id, name } in examples',
        },
      ],
    });
    const result = parseDiscoveryOutput(raw);
    expect(result.warnings).toHaveLength(0);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].evidence).toContain('{ id, name }');
  });
});

// ── parseReflectionOutput ────────────────────────────────────────────────

describe('parseReflectionOutput', () => {
  test('parses valid reflections', () => {
    const raw = JSON.stringify({
      reflections: [
        {
          title: 'Pattern A',
          type: 'pattern',
          summary: 'A summary',
          content: 'Content with [Entry: Foo](entry-1)',
          cited_entry_ids: ['entry-1'],
        },
      ],
    });
    const result = parseReflectionOutput(raw);
    expect(result.reflections).toHaveLength(1);
    expect(result.reflections[0].title).toBe('Pattern A');
    expect(result.reflections[0].type).toBe('pattern');
    expect(result.reflections[0].cited_entry_ids).toEqual(['entry-1']);
    expect(result.warnings).toHaveLength(0);
  });

  test('returns warning when no JSON found', () => {
    const result = parseReflectionOutput('no json here');
    expect(result.reflections).toHaveLength(0);
    expect(result.warnings[0]).toContain('no JSON');
  });

  test('returns warning for missing reflections array', () => {
    const result = parseReflectionOutput(JSON.stringify({ other: 'data' }));
    expect(result.reflections).toHaveLength(0);
    expect(result.warnings[0]).toContain('missing "reflections" array');
  });

  test('defaults invalid type to insight', () => {
    const raw = JSON.stringify({
      reflections: [
        { title: 'X', type: 'unknown_type', content: 'C', cited_entry_ids: ['e1'] },
      ],
    });
    const result = parseReflectionOutput(raw);
    expect(result.reflections[0].type).toBe('insight');
  });

  test('skips reflections without cited_entry_ids', () => {
    const raw = JSON.stringify({
      reflections: [
        { title: 'No Citations', type: 'pattern', content: 'C', cited_entry_ids: [] },
      ],
    });
    const result = parseReflectionOutput(raw);
    expect(result.reflections).toHaveLength(0);
    expect(result.warnings[0]).toContain('no valid cited_entry_ids');
  });

  test('skips items missing title or content', () => {
    const raw = JSON.stringify({
      reflections: [
        { type: 'pattern', content: 'C', cited_entry_ids: ['e1'] },
        { title: 'T', type: 'pattern', cited_entry_ids: ['e1'] },
      ],
    });
    const result = parseReflectionOutput(raw);
    expect(result.reflections).toHaveLength(0);
    expect(result.warnings).toHaveLength(2);
  });

  test('handles markdown fenced JSON', () => {
    const raw = '```json\n' + JSON.stringify({
      reflections: [
        { title: 'Fenced', type: 'trend', summary: '', content: 'C', cited_entry_ids: ['e1'] },
      ],
    }) + '\n```';
    const result = parseReflectionOutput(raw);
    expect(result.reflections).toHaveLength(1);
    expect(result.reflections[0].title).toBe('Fenced');
  });

  test('returns empty reflections for empty array', () => {
    const result = parseReflectionOutput(JSON.stringify({ reflections: [] }));
    expect(result.reflections).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test('handles braces inside string values without truncating', () => {
    const raw = JSON.stringify({
      reflections: [
        {
          title: 'Template Patterns',
          type: 'pattern',
          summary: 'Both use object literals',
          content: 'Entries share the shape `{ id: string, parent: { kind: "topic" } }` across modules.',
          cited_entry_ids: ['e1', 'e2'],
        },
      ],
    });
    const result = parseReflectionOutput(raw);
    expect(result.warnings).toHaveLength(0);
    expect(result.reflections).toHaveLength(1);
    expect(result.reflections[0].content).toContain('{ kind: "topic" }');
  });
});

// ── identifyTopicClusters ────────────────────────────────────────────────

describe('identifyTopicClusters', () => {
  test('returns empty for empty input', () => {
    expect(identifyTopicClusters([], [])).toEqual([]);
  });

  test('returns empty when all topics are singletons', () => {
    const clusters = identifyTopicClusters(['a', 'b', 'c'], []);
    expect(clusters).toEqual([]);
  });

  test('identifies a single connected component', () => {
    const clusters = identifyTopicClusters(
      ['a', 'b', 'c'],
      [
        { sourceTopic: 'a', targetTopic: 'b' },
        { sourceTopic: 'b', targetTopic: 'c' },
      ],
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sort()).toEqual(['a', 'b', 'c']);
  });

  test('identifies two separate clusters', () => {
    const clusters = identifyTopicClusters(
      ['a', 'b', 'c', 'd'],
      [
        { sourceTopic: 'a', targetTopic: 'b' },
        { sourceTopic: 'c', targetTopic: 'd' },
      ],
    );
    expect(clusters).toHaveLength(2);
    const sorted = clusters.map((c) => c.sort()).sort((a, b) => a[0].localeCompare(b[0]));
    expect(sorted[0]).toEqual(['a', 'b']);
    expect(sorted[1]).toEqual(['c', 'd']);
  });

  test('excludes singletons from clusters', () => {
    const clusters = identifyTopicClusters(
      ['a', 'b', 'c'],
      [{ sourceTopic: 'a', targetTopic: 'b' }],
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].sort()).toEqual(['a', 'b']);
    // 'c' is a singleton — not in any cluster.
  });
});

// ── buildReflectionPrompt ─────────────────────────────────────────────────

describe('buildReflectionPrompt', () => {
  const baseTopic = {
    topicId: 'topic-a',
    title: 'Auth Patterns',
    summary: 'Patterns for authentication',
    content: 'Full content here',
    entryCount: 3,
    connectionCount: 1,
  };

  test('returns a string containing the topic title and summary', () => {
    const prompt = buildReflectionPrompt([baseTopic], [], []);
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('Auth Patterns');
    expect(prompt).toContain('Patterns for authentication');
    expect(prompt).toContain('topic-a');
  });

  test('includes entry count and connection count for each topic', () => {
    const prompt = buildReflectionPrompt([baseTopic], [], []);
    expect(prompt).toContain('Entries: 3');
    expect(prompt).toContain('Connections: 1');
  });

  test('renders connection lines with arrow notation', () => {
    const connections = [
      { sourceTopic: 'topic-a', targetTopic: 'topic-b', relationship: 'depends on', confidence: 'inferred' },
    ];
    const prompt = buildReflectionPrompt([baseTopic], connections, []);
    expect(prompt).toContain('topic-a → topic-b: depends on (inferred)');
  });

  test('shows "No internal connections." when connections array is empty', () => {
    const prompt = buildReflectionPrompt([baseTopic], [], []);
    expect(prompt).toContain('No internal connections.');
  });

  test('includes entry lines with id, title, and summary', () => {
    const entries = [
      { entryId: 'entry-1', title: 'OAuth Guide', summary: 'How to set up OAuth' },
    ];
    const prompt = buildReflectionPrompt([baseTopic], [], entries);
    expect(prompt).toContain('entry-1: "OAuth Guide" — How to set up OAuth');
  });

  test('includes the task instruction and output format', () => {
    const prompt = buildReflectionPrompt([baseTopic], [], []);
    expect(prompt).toContain('You are a knowledge analyst');
    expect(prompt).toContain('"reflections"');
    expect(prompt).toContain('cited_entry_ids');
  });

  test('handles null summary and content in topics', () => {
    const topic = { ...baseTopic, summary: null, content: null };
    const prompt = buildReflectionPrompt([topic], [], []);
    expect(prompt).toContain('Summary: none');
  });

  test('renders multiple topics and entries correctly', () => {
    const topics = [
      baseTopic,
      { topicId: 'topic-b', title: 'DB Migrations', summary: 'Database migration patterns', content: null, entryCount: 5, connectionCount: 2 },
    ];
    const entries = [
      { entryId: 'e1', title: 'Entry One', summary: 'First entry' },
      { entryId: 'e2', title: 'Entry Two', summary: 'Second entry' },
    ];
    const connections = [
      { sourceTopic: 'topic-a', targetTopic: 'topic-b', relationship: 'related to', confidence: 'extracted' },
    ];
    const prompt = buildReflectionPrompt(topics, connections, entries);
    expect(prompt).toContain('Auth Patterns');
    expect(prompt).toContain('DB Migrations');
    expect(prompt).toContain('e1: "Entry One"');
    expect(prompt).toContain('e2: "Entry Two"');
    expect(prompt).toContain('topic-a → topic-b: related to (extracted)');
  });
});

// ── KbDreamService ────────────────────────────────────────────────────────

describe('KbDreamService', () => {
  // Shared mock factories — each test gets fresh mocks via beforeEach.

  function createMockDb() {
    return {
      setSynthesisMeta: jest.fn(),
      startSynthesisRun: jest.fn(),
      finishSynthesisRun: jest.fn(),
      listNeedsSynthesisEntryIds: jest.fn().mockReturnValue([]),
      listTopicSummaries: jest.fn().mockReturnValue([]),
      wipeSynthesis: jest.fn(),
      markAllNeedsSynthesis: jest.fn(),
      _deleteOrphanTopics: jest.fn(),
      detectGodNodes: jest.fn().mockReturnValue([]),
      listReflections: jest.fn().mockReturnValue([]),
      getEntry: jest.fn().mockReturnValue({ title: 'Test', summary: 'Summary', tags: [] }),
      clearNeedsSynthesis: jest.fn(),
      listTopicConnections: jest.fn().mockReturnValue([]),
      listTopics: jest.fn().mockReturnValue([]),
      listTopicEntryIds: jest.fn().mockReturnValue([]),
      listStaleReflectionIds: jest.fn().mockReturnValue([]),
      listAllConnections: jest.fn().mockReturnValue([]),
      deleteReflections: jest.fn(),
      wipeReflections: jest.fn(),
    };
  }

  function createMockChatService(mockDb: ReturnType<typeof createMockDb>) {
    return {
      getWorkspaceKbEnabled: jest.fn().mockResolvedValue(true),
      getKbDb: jest.fn().mockReturnValue(mockDb),
      getSettings: jest.fn().mockResolvedValue({
        knowledgeBase: { dreamingCliBackend: 'test-backend' },
      }),
      getKbKnowledgeDir: jest.fn().mockReturnValue('/tmp/kb'),
      getKbEntriesDir: jest.fn().mockReturnValue('/tmp/kb/entries'),
      getKbSynthesisDir: jest.fn().mockReturnValue('/tmp/kb/synthesis'),
      getWorkspaceKbEmbeddingConfig: jest.fn().mockResolvedValue(undefined),
      getKbVectorStore: jest.fn().mockResolvedValue(null),
    };
  }

  function createMockKbSearchMcp() {
    return {
      issueKbSearchSession: jest.fn().mockReturnValue({ token: 'tok', mcpServers: [] }),
      revokeKbSearchSession: jest.fn(),
    };
  }

  function createMockAdapter() {
    return {
      metadata: { id: 'test-backend', name: 'Test' },
      runOneShot: jest.fn().mockResolvedValue(null),
    };
  }

  function createMockBackendRegistry(adapter: ReturnType<typeof createMockAdapter>) {
    return {
      get: jest.fn().mockReturnValue(adapter),
    };
  }

  let mockDb: ReturnType<typeof createMockDb>;
  let mockChatService: ReturnType<typeof createMockChatService>;
  let mockKbSearchMcp: ReturnType<typeof createMockKbSearchMcp>;
  let mockAdapter: ReturnType<typeof createMockAdapter>;
  let mockBackendRegistry: ReturnType<typeof createMockBackendRegistry>;
  let service: KbDreamService;

  beforeEach(() => {
    jest.clearAllMocks();
    (embeddingsMod.embedBatch as jest.Mock).mockResolvedValue([]);
    mockDb = createMockDb();
    mockChatService = createMockChatService(mockDb);
    mockKbSearchMcp = createMockKbSearchMcp();
    mockAdapter = createMockAdapter();
    mockBackendRegistry = createMockBackendRegistry(mockAdapter);
    service = new KbDreamService({
      chatService: mockChatService as any,
      backendRegistry: mockBackendRegistry as any,
      kbSearchMcp: mockKbSearchMcp as any,
    });
  });

  // ── isRunning ───────────────────────────────────────────────────────────

  test('isRunning returns false initially', () => {
    expect(service.isRunning('ws-hash')).toBe(false);
  });

  test('isRunning returns true during a run', async () => {
    // Make the dream hang on getSettings so we can observe running state.
    let resolveSettings!: (v: any) => void;
    mockChatService.getSettings.mockReturnValue(
      new Promise((resolve) => { resolveSettings = resolve; }),
    );

    const promise = service.dream('ws-hash');
    // Yield to let _run reach past running.add but stall on getSettings.
    await new Promise((r) => setImmediate(r));

    expect(service.isRunning('ws-hash')).toBe(true);

    // Unblock and let it finish (will throw because settings has no backend, but that's ok).
    resolveSettings({ knowledgeBase: { dreamingCliBackend: 'test-backend' } });
    await promise;

    expect(service.isRunning('ws-hash')).toBe(false);
  });

  // ── dream: KB not enabled ──────────────────────────────────────────────

  test('dream throws when KB is not enabled', async () => {
    mockChatService.getWorkspaceKbEnabled.mockResolvedValue(false);
    await expect(service.dream('ws-hash')).rejects.toThrow(
      'Knowledge Base is not enabled for this workspace.',
    );
  });

  // ── dream: already running ─────────────────────────────────────────────

  test('dream throws when already running for the same workspace', async () => {
    // First call will hang on getSettings.
    let resolveSettings!: (v: any) => void;
    mockChatService.getSettings.mockReturnValueOnce(
      new Promise((resolve) => { resolveSettings = resolve; }),
    );

    const first = service.dream('ws-hash');
    await new Promise((r) => setImmediate(r));

    await expect(service.dream('ws-hash')).rejects.toThrow(
      'A dreaming run is already in progress for this workspace.',
    );

    // Clean up the hanging promise.
    resolveSettings({ knowledgeBase: { dreamingCliBackend: 'test-backend' } });
    await first;
  });

  test('dream marks workspace running before async preflight yields', async () => {
    let resolveEnabled!: (v: boolean) => void;
    mockChatService.getWorkspaceKbEnabled.mockReturnValueOnce(
      new Promise((resolve) => { resolveEnabled = resolve; }),
    );

    const first = service.dream('ws-hash');
    await new Promise((r) => setImmediate(r));

    await expect(service.dream('ws-hash')).rejects.toThrow(
      'A dreaming run is already in progress for this workspace.',
    );

    resolveEnabled(true);
    await first;
  });

  // ── dream: db not available ────────────────────────────────────────────

  test('dream throws when KB database is not available', async () => {
    mockChatService.getKbDb.mockReturnValue(null);
    await expect(service.dream('ws-hash')).rejects.toThrow(
      'Knowledge Base database not available.',
    );
  });

  // ── dream: no stale entries → returns immediately ─────────────────────

  test('dream with no stale entries returns 0 processed', async () => {
    mockDb.listNeedsSynthesisEntryIds.mockReturnValue([]);

    const result = await service.dream('ws-hash');

    expect(result.mode).toBe('incremental');
    expect(result.processedEntries).toBe(0);
    expect(result.errors).toEqual([]);
    expect(mockDb.setSynthesisMeta).toHaveBeenCalledWith('status', 'running');
    expect(mockDb.setSynthesisMeta).toHaveBeenCalledWith('status', 'idle');
    expect(mockDb.startSynthesisRun).toHaveBeenCalledWith(expect.any(String), 'incremental', expect.any(String));
    expect(mockDb.finishSynthesisRun).toHaveBeenCalledWith(
      expect.any(String),
      'completed',
      expect.any(String),
      null,
    );
    expect(mockDb._deleteOrphanTopics).toHaveBeenCalled();
    expect(mockKbSearchMcp.revokeKbSearchSession).toHaveBeenCalledWith('ws-hash');
  });

  // ── redream: calls wipeSynthesis + markAllNeedsSynthesis ───────────────

  test('redream calls wipeSynthesis and markAllNeedsSynthesis', async () => {
    mockDb.listNeedsSynthesisEntryIds.mockReturnValue([]);

    const result = await service.redream('ws-hash');

    expect(result.mode).toBe('full-rebuild');
    expect(mockDb.startSynthesisRun).toHaveBeenCalledWith(expect.any(String), 'redream', expect.any(String));
    expect(mockDb.wipeSynthesis).toHaveBeenCalled();
    expect(mockDb.markAllNeedsSynthesis).toHaveBeenCalled();
  });

  test('redream wipes topic embeddings without deleting entry embeddings', async () => {
    const mockStore = {
      wipeTopicEmbeddings: jest.fn().mockResolvedValue(undefined),
      wipeAllEmbeddings: jest.fn().mockResolvedValue(undefined),
    };
    mockChatService.getWorkspaceKbEmbeddingConfig.mockResolvedValue({
      model: 'test',
      ollamaHost: 'http://localhost:11434',
      dimensions: 768,
    });
    mockChatService.getKbVectorStore.mockResolvedValue(mockStore as any);
    mockDb.listNeedsSynthesisEntryIds.mockReturnValue([]);

    await service.redream('ws-hash');

    expect(mockStore.wipeTopicEmbeddings).toHaveBeenCalled();
    expect(mockStore.wipeAllEmbeddings).not.toHaveBeenCalled();
  });

  test('redream refreshes entry embeddings during cold start', async () => {
    const mockStore = {
      wipeTopicEmbeddings: jest.fn().mockResolvedValue(undefined),
      setModel: jest.fn().mockResolvedValue(undefined),
      upsertEntry: jest.fn().mockResolvedValue(undefined),
      upsertTopic: jest.fn().mockResolvedValue(undefined),
      embeddedTopicIds: jest.fn().mockResolvedValue(new Set()),
    };
    mockChatService.getWorkspaceKbEmbeddingConfig.mockResolvedValue({
      model: 'test',
      ollamaHost: 'http://localhost:11434',
      dimensions: 768,
    });
    mockChatService.getKbVectorStore.mockResolvedValue(mockStore as any);
    mockDb.listNeedsSynthesisEntryIds.mockReturnValue(['entry-1']);
    mockDb.listTopicSummaries.mockReturnValue([]);
    (embeddingsMod.embedBatch as jest.Mock).mockResolvedValue([{ embedding: [1, 0, 0] }]);

    await service.redream('ws-hash');

    expect(mockStore.upsertEntry).toHaveBeenCalledWith('entry-1', 'Test', 'Summary', [1, 0, 0]);
  });

  // ── dream: cold-start path with entries but no topics ─────────────────

  test('dream triggers cold-start path when entries exist but no topics', async () => {
    // Provide stale entries so the pipeline does not return early.
    mockDb.listNeedsSynthesisEntryIds.mockReturnValue(['entry-1']);
    // No existing topics → cold start.
    mockDb.listTopicSummaries.mockReturnValue([]);
    // No embedding config → forces cold start branch.
    mockChatService.getWorkspaceKbEmbeddingConfig.mockResolvedValue(undefined);

    // The adapter.runOneShot will return a valid-looking output.
    // The mocked parseDreamOutput (from jest.mock) returns { operations: [], warnings: [] }.
    mockAdapter.runOneShot.mockResolvedValue('{"operations":[]}');

    const result = await service.dream('ws-hash');

    expect(result.processedEntries).toBe(1);
    expect(mockAdapter.runOneShot).toHaveBeenCalled();
    expect(mockDb.clearNeedsSynthesis).toHaveBeenCalledWith(['entry-1']);
  });

  // ── dream: running flag is cleared on error ───────────────────────────

  test('running flag is cleared even when _run throws', async () => {
    mockChatService.getKbDb.mockReturnValue(null);

    try { await service.dream('ws-hash'); } catch { /* expected */ }

    expect(service.isRunning('ws-hash')).toBe(false);
  });

  // ── dream: emits synthesis change events ──────────────────────────────

  test('dream emits synthesis change events via emit callback', async () => {
    const emitFn = jest.fn();
    const serviceWithEmit = new KbDreamService({
      chatService: mockChatService as any,
      backendRegistry: mockBackendRegistry as any,
      kbSearchMcp: mockKbSearchMcp as any,
      emit: emitFn,
    });
    mockDb.listNeedsSynthesisEntryIds.mockReturnValue([]);

    await serviceWithEmit.dream('ws-hash');

    // Should have been called at least for the initial running and final idle transitions.
    expect(emitFn).toHaveBeenCalled();
    const calls = emitFn.mock.calls;
    // Each call receives (hash, frame).
    expect(calls[0][0]).toBe('ws-hash');
    expect(calls[0][1].type).toBe('kb_state_update');
  });

  // ── dream: revokes MCP session in finally block ───────────────────────

  test('dream revokes MCP session even if pipeline throws', async () => {
    // Force an error inside the try block by making getSettings throw.
    mockChatService.getSettings.mockRejectedValue(new Error('settings boom'));

    const result = await service.dream('ws-hash');

    // The error should be captured in result.errors.
    expect(result.errors.length).toBeGreaterThan(0);
    expect(mockDb.finishSynthesisRun).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      expect.any(String),
      'settings boom',
    );
    expect(mockKbSearchMcp.revokeKbSearchSession).toHaveBeenCalledWith('ws-hash');
  });

  // ── dream: no dreaming backend configured ─────────────────────────────

  test('dream captures error when no dreaming CLI backend is configured', async () => {
    mockDb.listNeedsSynthesisEntryIds.mockReturnValue(['entry-1']);
    mockChatService.getSettings.mockResolvedValue({ knowledgeBase: {} });

    const result = await service.dream('ws-hash');

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('No Dreaming CLI backend configured');
  });

  // ── dream: unregistered backend ───────────────────────────────────────

  test('dream captures error when backend is not registered', async () => {
    mockDb.listNeedsSynthesisEntryIds.mockReturnValue(['entry-1']);
    mockBackendRegistry.get.mockReturnValue(null);

    const result = await service.dream('ws-hash');

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('is not registered');
  });

  // ── Cooperative stop ──────────────────────────────────────────────────

  test('isStopRequested returns false when no stop requested', () => {
    expect(service.isStopRequested('ws-hash')).toBe(false);
  });

  test('requestStop returns false when no run is in progress', () => {
    expect(service.requestStop('ws-hash')).toBe(false);
    expect(service.isStopRequested('ws-hash')).toBe(false);
  });

  test('requestStop sets flag and emits WS frame while a run is in progress', async () => {
    const emitFn = jest.fn();
    const svc = new KbDreamService({
      chatService: mockChatService as any,
      backendRegistry: mockBackendRegistry as any,
      kbSearchMcp: mockKbSearchMcp as any,
      emit: emitFn,
    });

    // Hang the run on getSettings so we can observe a live state.
    let resolveSettings!: (v: any) => void;
    mockChatService.getSettings.mockReturnValue(
      new Promise((resolve) => { resolveSettings = resolve; }),
    );

    const promise = svc.dream('ws-hash');
    await new Promise((r) => setImmediate(r));

    expect(svc.requestStop('ws-hash')).toBe(true);
    expect(svc.isStopRequested('ws-hash')).toBe(true);

    // WS frame with stopping:true should have been emitted immediately.
    const stoppingFrame = emitFn.mock.calls.find(
      ([, frame]) => frame?.changed?.stopping === true,
    );
    expect(stoppingFrame).toBeDefined();

    // Let the run finish cleanly.
    resolveSettings({ knowledgeBase: { dreamingCliBackend: 'test-backend' } });
    await promise;

    // Flag cleared after the run exits.
    expect(svc.isStopRequested('ws-hash')).toBe(false);
  });

  test('stop during cold-start synthesis preserves committed batches and returns stopped=true', async () => {
    // Three pending entries → three single-entry batches (SYNTHESIS_BATCH_SIZE=10,
    // so in practice a single batch — we force per-batch by returning them one
    // at a time in the cold-start sort via tag distribution).
    mockDb.listNeedsSynthesisEntryIds.mockReturnValue(['e1', 'e2', 'e3']);
    mockDb.listTopicSummaries.mockReturnValue([]);
    mockChatService.getWorkspaceKbEmbeddingConfig.mockResolvedValue(undefined);

    // First batch completes; request stop immediately after it commits.
    // Cold-start batches 3 entries in a single batch (batch size 10), so we
    // trigger the stop during the runOneShot call and rely on the stop check
    // at the top of the next iteration. With only 1 batch here, we validate
    // the top-level phase check by triggering stop during the single batch.
    let callCount = 0;
    mockAdapter.runOneShot.mockImplementation(async () => {
      callCount++;
      // Request stop during the first (and only) batch so the post-synthesis
      // _checkStop short-circuits the rest of _run.
      service.requestStop('ws-hash');
      return '{"operations":[]}';
    });

    const result = await service.dream('ws-hash');

    expect(callCount).toBeGreaterThan(0);
    expect(result.stopped).toBe(true);
    // The batch that was in-flight still committed.
    expect(mockDb.clearNeedsSynthesis).toHaveBeenCalledWith(['e1', 'e2', 'e3']);
    // Status ends idle (not failed).
    expect(mockDb.setSynthesisMeta).toHaveBeenCalledWith('status', 'idle');
    // stopped_at meta persisted.
    expect(mockDb.setSynthesisMeta).toHaveBeenCalledWith('stopped_at', expect.any(String));
    expect(mockDb.finishSynthesisRun).toHaveBeenCalledWith(
      expect.any(String),
      'stopped',
      expect.any(String),
      null,
    );
    // last_run_at NOT touched on stop.
    const lastRunAtCalls = mockDb.setSynthesisMeta.mock.calls.filter(
      (c: unknown[]) => c[0] === 'last_run_at',
    );
    expect(lastRunAtCalls).toHaveLength(0);
    // Running flag released.
    expect(service.isRunning('ws-hash')).toBe(false);
    // Stop flag cleared.
    expect(service.isStopRequested('ws-hash')).toBe(false);
  });

  test('a second dream() after a stop processes remaining needs_synthesis entries', async () => {
    // First run: three entries, stop triggered after first CLI call commits.
    mockDb.listNeedsSynthesisEntryIds
      .mockReturnValueOnce(['e1', 'e2', 'e3']) // first dream
      .mockReturnValueOnce(['e3']); // second dream — only e3 still flagged

    mockDb.listTopicSummaries.mockReturnValue([]);
    mockChatService.getWorkspaceKbEmbeddingConfig.mockResolvedValue(undefined);

    mockAdapter.runOneShot.mockImplementationOnce(async () => {
      service.requestStop('ws-hash');
      return '{"operations":[]}';
    }).mockImplementationOnce(async () => '{"operations":[]}');

    const r1 = await service.dream('ws-hash');
    expect(r1.stopped).toBe(true);

    const r2 = await service.dream('ws-hash');
    expect(r2.stopped).toBeUndefined();
    expect(r2.processedEntries).toBe(1);
    expect(mockDb.clearNeedsSynthesis).toHaveBeenLastCalledWith(['e3']);
  });

  // ── Parse-failure retry + debug logging ───────────────────────────────

  test('retries CLI once when parser reports a JSON parse failure', async () => {
    mockDb.listNeedsSynthesisEntryIds.mockReturnValue(['entry-1']);
    mockDb.listTopicSummaries.mockReturnValue([]);
    mockChatService.getWorkspaceKbEmbeddingConfig.mockResolvedValue(undefined);

    // First parse returns a parse-failure warning; second parse succeeds.
    (dreamOpsMod.parseDreamOutput as jest.Mock)
      .mockReturnValueOnce({ operations: [], warnings: ['JSON parse error at pos 42'] })
      .mockReturnValueOnce({ operations: [], warnings: [] });

    mockAdapter.runOneShot.mockResolvedValue('{"broken": ');

    const result = await service.dream('ws-hash');

    // CLI invoked twice (retry) and the entry was processed on the second attempt.
    expect(mockAdapter.runOneShot).toHaveBeenCalledTimes(2);
    expect(result.processedEntries).toBe(1);
    expect(mockDb.clearNeedsSynthesis).toHaveBeenCalledWith(['entry-1']);
  });

  test('writes parse-failure debug log when both attempts fail to parse', async () => {
    mockDb.listNeedsSynthesisEntryIds.mockReturnValue(['entry-1']);
    mockDb.listTopicSummaries.mockReturnValue([]);
    mockChatService.getWorkspaceKbEmbeddingConfig.mockResolvedValue(undefined);
    mockChatService.getKbKnowledgeDir.mockReturnValue('/tmp/kb/knowledge');

    (dreamOpsMod.parseDreamOutput as jest.Mock)
      .mockReturnValueOnce({ operations: [], warnings: ['JSON parse error: foo'] })
      .mockReturnValueOnce({ operations: [], warnings: ['No JSON object found in output.'] });

    mockAdapter.runOneShot
      .mockResolvedValueOnce('first garbled output')
      .mockResolvedValueOnce('second garbled output');

    const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);

    try {
      await service.dream('ws-hash');

      expect(mockAdapter.runOneShot).toHaveBeenCalledTimes(2);
      expect(mkdirSpy).toHaveBeenCalledWith(
        expect.stringContaining('_dream_debug'),
        expect.objectContaining({ recursive: true }),
      );
      expect(writeSpy).toHaveBeenCalledTimes(1);
      const [filepath, contents] = writeSpy.mock.calls[0] as [string, string, string];
      expect(filepath).toMatch(/_dream_debug\/parse-failure-cold-start-.*\.txt$/);
      expect(contents).toContain('first garbled output');
      expect(contents).toContain('second garbled output');
      expect(contents).toContain('ATTEMPT BOUNDARY');
    } finally {
      mkdirSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  test('does not retry CLI when first attempt parses cleanly', async () => {
    mockDb.listNeedsSynthesisEntryIds.mockReturnValue(['entry-1']);
    mockDb.listTopicSummaries.mockReturnValue([]);
    mockChatService.getWorkspaceKbEmbeddingConfig.mockResolvedValue(undefined);

    // Default mock returns { operations: [], warnings: [] } — no parse failure.
    mockAdapter.runOneShot.mockResolvedValue('{"operations":[]}');

    await service.dream('ws-hash');

    expect(mockAdapter.runOneShot).toHaveBeenCalledTimes(1);
  });

  test('does not retry when CLI returns null on the first attempt', async () => {
    mockDb.listNeedsSynthesisEntryIds.mockReturnValue(['entry-1']);
    mockDb.listTopicSummaries.mockReturnValue([]);
    mockChatService.getWorkspaceKbEmbeddingConfig.mockResolvedValue(undefined);

    mockAdapter.runOneShot.mockResolvedValue(null);

    const result = await service.dream('ws-hash');

    // No retry on null output — the caller preserves the existing skip behavior.
    expect(mockAdapter.runOneShot).toHaveBeenCalledTimes(1);
    // Entry is NOT marked processed when CLI returned nothing.
    expect(result.processedEntries).toBe(0);
    expect(mockDb.clearNeedsSynthesis).not.toHaveBeenCalledWith(['entry-1']);
  });
});

// ── hasParseFailure ───────────────────────────────────────────────────────

describe('hasParseFailure', () => {
  test('returns false for empty warnings array', () => {
    expect(hasParseFailure([])).toBe(false);
  });

  test('returns true when a warning contains "JSON parse error"', () => {
    expect(hasParseFailure(['JSON parse error at position 42'])).toBe(true);
  });

  test('returns true when a warning contains "no JSON found"', () => {
    expect(hasParseFailure(['No JSON found in output.'])).toBe(true);
  });

  test('returns true when a warning contains "no JSON object found"', () => {
    expect(hasParseFailure(['No JSON object found in output.'])).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(hasParseFailure(['json parse error: bad token'])).toBe(true);
    expect(hasParseFailure(['NO JSON FOUND'])).toBe(true);
  });

  test('returns false for structural/schema warnings (which a retry would not fix)', () => {
    expect(hasParseFailure(['missing "verified" array'])).toBe(false);
    expect(hasParseFailure(['op #3: unknown op "foo"'])).toBe(false);
    expect(hasParseFailure(['reflection #1 has no valid cited_entry_ids'])).toBe(false);
  });

  test('returns true if any warning is a parse failure (mixed set)', () => {
    expect(hasParseFailure(['missing "reflections" array', 'JSON parse error: boom'])).toBe(true);
  });
});
