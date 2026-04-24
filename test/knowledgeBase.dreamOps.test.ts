/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── DreamOps: parse + validate + apply tests ──────────────────────────────

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { KbDatabase } from '../src/services/knowledgeBase/db';
import { parseDreamOutput, applyOperations } from '../src/services/knowledgeBase/dreamOps';
import type { DreamOperation } from '../src/services/knowledgeBase/dreamOps';

let tmpDir: string;
let rawDir: string;
let db: KbDatabase;

function makeRaw(contents: string) {
  const buf = Buffer.from(contents);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const rawId = sha256.slice(0, 16);
  fs.writeFileSync(path.join(rawDir, `${rawId}.txt`), buf);
  return { rawId, sha256, byteLength: buf.length };
}

function seedRawAndEntry(entryId: string) {
  const { rawId, sha256, byteLength } = makeRaw(`content-${entryId}`);
  db.insertRaw({
    rawId, sha256, status: 'ingested', byteLength,
    mimeType: 'text/plain', handler: null,
    uploadedAt: new Date().toISOString(), metadata: null,
  });
  db.insertEntry({
    entryId, rawId, title: `Title ${entryId}`, slug: entryId, summary: '',
    schemaVersion: 1, digestedAt: new Date().toISOString(), tags: [],
  });
  return rawId;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-dream-ops-'));
  rawDir = path.join(tmpDir, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  db = new KbDatabase(path.join(tmpDir, 'state.db'));
});

afterEach(() => {
  try { db.close(); } catch { /* */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Parser ─────────────────────────────────────────────────────────────────

describe('parseDreamOutput', () => {
  test('parses clean JSON with operations', () => {
    const raw = JSON.stringify({
      operations: [
        { op: 'create_topic', topic_id: 't1', title: 'T1', summary: 'S1', content: 'C1' },
      ],
    });
    const result = parseDreamOutput(raw);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].op).toBe('create_topic');
    expect(result.warnings).toHaveLength(0);
  });

  test('extracts JSON from markdown fences', () => {
    const raw = `Here is the result:\n\`\`\`json\n${JSON.stringify({
      operations: [
        { op: 'delete_topic', topic_id: 't1' },
      ],
    })}\n\`\`\`\nDone.`;
    const result = parseDreamOutput(raw);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].op).toBe('delete_topic');
  });

  test('extracts JSON from preamble text', () => {
    const raw = `I've analyzed the entries.\n${JSON.stringify({
      operations: [
        { op: 'assign_entries', topic_id: 't1', entry_ids: ['e1'] },
      ],
    })}\nThat is all.`;
    const result = parseDreamOutput(raw);
    expect(result.operations).toHaveLength(1);
  });

  test('returns warning for non-JSON output', () => {
    const result = parseDreamOutput('No JSON here at all');
    expect(result.operations).toHaveLength(0);
    expect(result.warnings[0]).toContain('No JSON object found');
  });

  test('returns warning for invalid JSON', () => {
    const result = parseDreamOutput('{ broken: json }');
    expect(result.operations).toHaveLength(0);
    expect(result.warnings[0]).toContain('JSON parse error');
  });

  test('returns warning for missing operations array', () => {
    const result = parseDreamOutput('{ "data": [] }');
    expect(result.operations).toHaveLength(0);
    expect(result.warnings[0]).toContain('Missing or non-array');
  });

  test('skips unknown op types with warning', () => {
    const raw = JSON.stringify({
      operations: [
        { op: 'unknown_op', topic_id: 't1' },
        { op: 'delete_topic', topic_id: 't1' },
      ],
    });
    const result = parseDreamOutput(raw);
    expect(result.operations).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('unknown op');
  });

  test('validates create_topic requires all fields', () => {
    const raw = JSON.stringify({
      operations: [
        { op: 'create_topic', topic_id: 't1', title: 'T' },
      ],
    });
    const result = parseDreamOutput(raw);
    expect(result.operations).toHaveLength(0);
    expect(result.warnings[0]).toContain('missing summary');
  });

  test('validates update_topic needs at least one field', () => {
    const raw = JSON.stringify({
      operations: [
        { op: 'update_topic', topic_id: 't1' },
      ],
    });
    const result = parseDreamOutput(raw);
    expect(result.operations).toHaveLength(0);
    expect(result.warnings[0]).toContain('no fields to update');
  });

  test('validates merge_topics requires >= 2 source IDs', () => {
    const raw = JSON.stringify({
      operations: [
        { op: 'merge_topics', source_topic_ids: ['t1'], into_topic_id: 't2', title: 'M', summary: 'S', content: 'C' },
      ],
    });
    const result = parseDreamOutput(raw);
    expect(result.operations).toHaveLength(0);
    expect(result.warnings[0]).toContain('2');
  });

  test('validates split_topic requires >= 2 targets', () => {
    const raw = JSON.stringify({
      operations: [
        { op: 'split_topic', source_topic_id: 't1', into: [{ topic_id: 't2', title: 'T', summary: 'S', content: 'C' }] },
      ],
    });
    const result = parseDreamOutput(raw);
    expect(result.operations).toHaveLength(0);
    expect(result.warnings[0]).toContain('2');
  });

  test('validates add_connection requires source, target, relationship', () => {
    const raw = JSON.stringify({
      operations: [
        { op: 'add_connection', source_topic: 'a' },
      ],
    });
    const result = parseDreamOutput(raw);
    expect(result.operations).toHaveLength(0);
    expect(result.warnings[0]).toContain('missing target_topic');
  });

  test('validates connection confidence values', () => {
    const raw = JSON.stringify({
      operations: [
        { op: 'add_connection', source_topic: 'a', target_topic: 'b', relationship: 'rel', confidence: 'invalid' },
      ],
    });
    const result = parseDreamOutput(raw);
    expect(result.operations).toHaveLength(0);
    expect(result.warnings[0]).toContain('invalid confidence');
  });

  test('accepts valid confidence values', () => {
    for (const conf of ['extracted', 'inferred', 'speculative']) {
      const raw = JSON.stringify({
        operations: [
          { op: 'add_connection', source_topic: 'a', target_topic: 'b', relationship: 'rel', confidence: conf },
        ],
      });
      const result = parseDreamOutput(raw);
      expect(result.operations).toHaveLength(1);
    }
  });

  test('handles braces inside string values without truncating', () => {
    const raw = JSON.stringify({
      operations: [
        {
          op: 'create_topic',
          topic_id: 't1',
          title: 'T1',
          summary: 'S1',
          content: 'Example JSON: { "foo": "bar" } and template `${x}` rendered as { "a": { "b": 1 } }.',
        },
      ],
    });
    const result = parseDreamOutput(raw);
    expect(result.warnings).toHaveLength(0);
    expect(result.operations).toHaveLength(1);
    expect((result.operations[0] as { content: string }).content).toContain('"bar"');
  });

  test('handles escaped quotes inside string values', () => {
    const raw = JSON.stringify({
      operations: [
        {
          op: 'create_topic',
          topic_id: 't1',
          title: 'T1',
          summary: 'S1',
          content: 'She said: "use { and } sparingly" then closed the brace }.',
        },
      ],
    });
    const result = parseDreamOutput(raw);
    expect(result.warnings).toHaveLength(0);
    expect(result.operations).toHaveLength(1);
  });

  test('does not cut mid-string on trailing unmatched braces', () => {
    // Regression: naive brace counter would pop depth to 0 inside the content
    // string, returning a slice ending mid-string and producing
    // "Unterminated string in JSON" on JSON.parse.
    const raw = JSON.stringify({
      operations: [
        {
          op: 'create_topic',
          topic_id: 't1',
          title: 'T1',
          summary: 'S1',
          content: 'trailing braces }} should not close the object',
        },
      ],
    });
    const result = parseDreamOutput(raw);
    expect(result.warnings).toHaveLength(0);
    expect(result.operations).toHaveLength(1);
    expect((result.operations[0] as { content: string }).content).toContain('}}');
  });
});

// ─── Apply operations ───────────────────────────────────────────────────────

describe('applyOperations', () => {
  test('create_topic inserts a new topic', () => {
    const ops: DreamOperation[] = [
      { op: 'create_topic', topic_id: 'test-topic', title: 'Test', summary: 'Sum', content: 'Body' },
    ];
    const warnings = applyOperations(db, ops);
    expect(warnings).toHaveLength(0);
    const topic = db.getTopic('test-topic');
    expect(topic).toBeTruthy();
    expect(topic!.title).toBe('Test');
    expect(topic!.content).toBe('Body');
  });

  test('update_topic modifies existing topic', () => {
    db.upsertTopic({ topicId: 't1', title: 'Old', summary: 'S', content: 'C', updatedAt: new Date().toISOString() });
    const ops: DreamOperation[] = [
      { op: 'update_topic', topic_id: 't1', title: 'New' },
    ];
    const warnings = applyOperations(db, ops);
    expect(warnings).toHaveLength(0);
    expect(db.getTopic('t1')!.title).toBe('New');
    expect(db.getTopic('t1')!.content).toBe('C');
  });

  test('update_topic warns when topic not found', () => {
    const ops: DreamOperation[] = [
      { op: 'update_topic', topic_id: 'nonexistent', title: 'X' },
    ];
    const warnings = applyOperations(db, ops);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not found');
  });

  test('delete_topic removes a topic', () => {
    db.upsertTopic({ topicId: 't1', title: 'T', summary: 'S', content: 'C', updatedAt: new Date().toISOString() });
    const ops: DreamOperation[] = [{ op: 'delete_topic', topic_id: 't1' }];
    applyOperations(db, ops);
    expect(db.getTopic('t1')).toBeNull();
  });

  test('assign_entries links entries to topic', () => {
    db.upsertTopic({ topicId: 't1', title: 'T', summary: 'S', content: 'C', updatedAt: new Date().toISOString() });
    seedRawAndEntry('e1');
    const ops: DreamOperation[] = [
      { op: 'assign_entries', topic_id: 't1', entry_ids: ['e1'] },
    ];
    applyOperations(db, ops);
    expect(db.listTopicEntryIds('t1')).toContain('e1');
  });

  test('unassign_entries removes entry-topic link', () => {
    db.upsertTopic({ topicId: 't1', title: 'T', summary: 'S', content: 'C', updatedAt: new Date().toISOString() });
    seedRawAndEntry('e1');
    db.assignEntries('t1', ['e1']);
    const ops: DreamOperation[] = [
      { op: 'unassign_entries', topic_id: 't1', entry_ids: ['e1'] },
    ];
    applyOperations(db, ops);
    expect(db.listTopicEntryIds('t1')).not.toContain('e1');
  });

  test('merge_topics combines source topics into one', () => {
    const now = new Date().toISOString();
    db.upsertTopic({ topicId: 't1', title: 'A', summary: 'S', content: 'C', updatedAt: now });
    db.upsertTopic({ topicId: 't2', title: 'B', summary: 'S', content: 'C', updatedAt: now });
    seedRawAndEntry('e1');
    db.assignEntries('t1', ['e1']);
    const ops: DreamOperation[] = [{
      op: 'merge_topics',
      source_topic_ids: ['t1', 't2'],
      into_topic_id: 't-merged',
      title: 'Merged',
      summary: 'MS',
      content: 'MC',
    }];
    applyOperations(db, ops);
    expect(db.getTopic('t1')).toBeNull();
    expect(db.getTopic('t2')).toBeNull();
    expect(db.getTopic('t-merged')!.title).toBe('Merged');
    expect(db.listTopicEntryIds('t-merged')).toContain('e1');
  });

  test('split_topic splits one topic into two+', () => {
    const now = new Date().toISOString();
    db.upsertTopic({ topicId: 't1', title: 'Big', summary: 'S', content: 'C', updatedAt: now });
    seedRawAndEntry('e1');
    db.assignEntries('t1', ['e1']);
    const ops: DreamOperation[] = [{
      op: 'split_topic',
      source_topic_id: 't1',
      into: [
        { topic_id: 'ta', title: 'A', summary: 'SA', content: 'CA' },
        { topic_id: 'tb', title: 'B', summary: 'SB', content: 'CB' },
      ],
    }];
    applyOperations(db, ops);
    expect(db.getTopic('t1')).toBeNull();
    expect(db.getTopic('ta')!.title).toBe('A');
    expect(db.getTopic('tb')!.title).toBe('B');
    expect(db.listTopicEntryIds('ta')).toContain('e1');
    expect(db.listTopicEntryIds('tb')).toContain('e1');
  });

  test('add_connection creates a connection', () => {
    const now = new Date().toISOString();
    db.upsertTopic({ topicId: 'a', title: 'A', summary: 'S', content: 'C', updatedAt: now });
    db.upsertTopic({ topicId: 'b', title: 'B', summary: 'S', content: 'C', updatedAt: now });
    const ops: DreamOperation[] = [{
      op: 'add_connection',
      source_topic: 'a',
      target_topic: 'b',
      relationship: 'influences',
      confidence: 'inferred',
    }];
    applyOperations(db, ops);
    const conns = db.listConnectionsForTopic('a');
    expect(conns).toHaveLength(1);
    expect(conns[0].relationship).toBe('influences');
  });

  test('remove_connection deletes a connection', () => {
    const now = new Date().toISOString();
    db.upsertTopic({ topicId: 'a', title: 'A', summary: 'S', content: 'C', updatedAt: now });
    db.upsertTopic({ topicId: 'b', title: 'B', summary: 'S', content: 'C', updatedAt: now });
    db.upsertConnection({
      sourceTopic: 'a', targetTopic: 'b',
      relationship: 'rel', confidence: 'inferred', evidence: null,
    });
    const ops: DreamOperation[] = [{ op: 'remove_connection', source_topic: 'a', target_topic: 'b' }];
    applyOperations(db, ops);
    expect(db.listConnectionsForTopic('a')).toHaveLength(0);
  });

  test('multiple operations execute in a single transaction', () => {
    const ops: DreamOperation[] = [
      { op: 'create_topic', topic_id: 't1', title: 'T1', summary: 'S', content: 'C' },
      { op: 'create_topic', topic_id: 't2', title: 'T2', summary: 'S', content: 'C' },
      { op: 'add_connection', source_topic: 't1', target_topic: 't2', relationship: 'related', confidence: 'inferred' },
    ];
    const warnings = applyOperations(db, ops);
    expect(warnings).toHaveLength(0);
    expect(db.listTopics()).toHaveLength(2);
    expect(db.listAllConnections()).toHaveLength(1);
  });
});
