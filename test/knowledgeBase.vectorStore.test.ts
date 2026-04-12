/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Knowledge Base PGLite vector store tests ───────────────────────────────
// Exercises `KbVectorStore` directly against a temp-dir-backed PGLite DB.
// Covers:
//   - Schema creation (entry_embeddings, topic_embeddings, store_meta)
//   - Upsert and delete operations
//   - Vector search (cosine distance)
//   - Keyword search (tsvector / ts_rank)
//   - Hybrid search (reciprocal rank fusion)
//   - findSimilarTopics
//   - Stats (counts, embedded IDs)
//   - Wipe all embeddings
//   - Dimension change detection (wipes tables, recreates schema)
//   - Store metadata persistence

import path from 'path';
import os from 'os';
import fs from 'fs';
import { KbVectorStore } from '../src/services/knowledgeBase/vectorStore';

let tmpDir: string;
let store: KbVectorStore;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-vec-test-'));
  store = new KbVectorStore(tmpDir, 3); // 3-dimensional for simple tests
  await store.ready();
});

afterEach(async () => {
  await store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Basic upsert and count ──────────────────────────────────────────────────

test('upsertEntry stores and counts entries', async () => {
  expect(await store.entryCount()).toBe(0);

  await store.upsertEntry('e1', 'Machine Learning', 'Neural networks', [1, 0, 0]);
  await store.upsertEntry('e2', 'Cooking', 'Pasta recipes', [0, 1, 0]);

  expect(await store.entryCount()).toBe(2);
});

test('upsertEntry updates on conflict', async () => {
  await store.upsertEntry('e1', 'Old Title', 'Old Summary', [1, 0, 0]);
  await store.upsertEntry('e1', 'New Title', 'New Summary', [0, 1, 0]);

  expect(await store.entryCount()).toBe(1);

  // Verify the update took effect via keyword search on new title.
  const results = await store.keywordSearchEntries('New Title');
  expect(results.length).toBe(1);
  expect(results[0].title).toBe('New Title');
});

test('upsertTopic stores and counts topics', async () => {
  expect(await store.topicCount()).toBe(0);

  await store.upsertTopic('t1', 'AI Overview', 'Artificial intelligence', [1, 0, 0]);
  expect(await store.topicCount()).toBe(1);
});

// ── Delete ──────────────────────────────────────────────────────────────────

test('deleteEntry removes an entry', async () => {
  await store.upsertEntry('e1', 'Test', 'Summary', [1, 0, 0]);
  expect(await store.entryCount()).toBe(1);

  await store.deleteEntry('e1');
  expect(await store.entryCount()).toBe(0);
});

test('deleteTopic removes a topic', async () => {
  await store.upsertTopic('t1', 'Test', 'Summary', [1, 0, 0]);
  await store.deleteTopic('t1');
  expect(await store.topicCount()).toBe(0);
});

// ── Vector search ───────────────────────────────────────────────────────────

test('vectorSearchEntries returns results sorted by cosine similarity', async () => {
  await store.upsertEntry('e1', 'A', 'a', [1, 0, 0]);
  await store.upsertEntry('e2', 'B', 'b', [0, 1, 0]);
  await store.upsertEntry('e3', 'C', 'c', [0.9, 0.1, 0]);

  const results = await store.vectorSearchEntries([1, 0, 0], 3);
  expect(results.length).toBe(3);
  // e1 should be first (exact match), e3 second (closest to [1,0,0])
  expect(results[0].id).toBe('e1');
  expect(results[1].id).toBe('e3');
  expect(results[0].score).toBeGreaterThan(results[1].score);
});

test('vectorSearchTopics returns results sorted by cosine similarity', async () => {
  await store.upsertTopic('t1', 'Alpha', 'alpha', [1, 0, 0]);
  await store.upsertTopic('t2', 'Beta', 'beta', [0, 1, 0]);

  const results = await store.vectorSearchTopics([1, 0, 0], 2);
  expect(results[0].id).toBe('t1');
  expect(results[0].kind).toBe('topic');
});

// ── Keyword search ──────────────────────────────────────────────────────────

test('keywordSearchEntries matches on title and summary', async () => {
  await store.upsertEntry('e1', 'Machine Learning', 'Neural networks and deep learning', [1, 0, 0]);
  await store.upsertEntry('e2', 'Cooking Guide', 'How to make pasta', [0, 1, 0]);

  const results = await store.keywordSearchEntries('machine learning neural');
  expect(results.length).toBe(1);
  expect(results[0].id).toBe('e1');
  expect(results[0].score).toBeGreaterThan(0);
});

test('keywordSearchTopics matches on topic text', async () => {
  await store.upsertTopic('t1', 'Climate Change', 'Global warming effects', [1, 0, 0]);
  await store.upsertTopic('t2', 'Cooking', 'Food recipes', [0, 1, 0]);

  const results = await store.keywordSearchTopics('climate warming');
  expect(results.length).toBe(1);
  expect(results[0].id).toBe('t1');
});

// ── Hybrid search ───────────────────────────────────────────────────────────

test('hybridSearchEntries combines vector and keyword results', async () => {
  await store.upsertEntry('e1', 'Machine Learning', 'Neural networks', [1, 0, 0]);
  await store.upsertEntry('e2', 'Deep Learning', 'Advanced neural nets', [0.9, 0.1, 0]);
  await store.upsertEntry('e3', 'Cooking', 'Pasta recipes', [0, 1, 0]);

  // Query vector close to e1/e2, keyword matches "machine learning"
  const results = await store.hybridSearchEntries('machine learning', [1, 0, 0], 3);
  // e1 should rank highest (matches both vector and keyword)
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].id).toBe('e1');
});

test('hybridSearch searches both entries and topics', async () => {
  await store.upsertEntry('e1', 'Machine Learning', 'ML stuff', [1, 0, 0]);
  await store.upsertTopic('t1', 'AI Overview', 'Machine learning summary', [0.9, 0.1, 0]);

  const results = await store.hybridSearch('machine learning', [1, 0, 0], 5);
  expect(results.length).toBe(2);
  const ids = results.map((r) => r.id);
  expect(ids).toContain('e1');
  expect(ids).toContain('t1');
});

// ── Similar topics ──────────────────────────────────────────────────────────

test('findSimilarTopics excludes the query topic itself', async () => {
  await store.upsertTopic('t1', 'A', 'a', [1, 0, 0]);
  await store.upsertTopic('t2', 'B', 'b', [0.9, 0.1, 0]);
  await store.upsertTopic('t3', 'C', 'c', [0, 1, 0]);

  const results = await store.findSimilarTopics('t1', 5);
  const ids = results.map((r) => r.id);
  expect(ids).not.toContain('t1');
  expect(ids[0]).toBe('t2'); // most similar to t1
});

// ── Embedded IDs ────────────────────────────────────────────────────────────

test('embeddedEntryIds returns the set of stored entry IDs', async () => {
  await store.upsertEntry('e1', 'A', 'a', [1, 0, 0]);
  await store.upsertEntry('e2', 'B', 'b', [0, 1, 0]);

  const ids = await store.embeddedEntryIds();
  expect(ids.size).toBe(2);
  expect(ids.has('e1')).toBe(true);
  expect(ids.has('e2')).toBe(true);
});

test('embeddedTopicIds returns the set of stored topic IDs', async () => {
  await store.upsertTopic('t1', 'A', 'a', [1, 0, 0]);
  const ids = await store.embeddedTopicIds();
  expect(ids.has('t1')).toBe(true);
});

// ── Wipe ────────────────────────────────────────────────────────────────────

test('wipeAllEmbeddings clears all data but tables remain', async () => {
  await store.upsertEntry('e1', 'A', 'a', [1, 0, 0]);
  await store.upsertTopic('t1', 'B', 'b', [0, 1, 0]);

  await store.wipeAllEmbeddings();

  expect(await store.entryCount()).toBe(0);
  expect(await store.topicCount()).toBe(0);

  // Tables still exist — can insert again.
  await store.upsertEntry('e2', 'C', 'c', [0, 0, 1]);
  expect(await store.entryCount()).toBe(1);
});

// ── Metadata ────────────────────────────────────────────────────────────────

test('setModel and getMeta persist model info', async () => {
  await store.setModel('nomic-embed-text');
  const meta = await store.getMeta();
  expect(meta).not.toBeNull();
  expect(meta!.model).toBe('nomic-embed-text');
  expect(meta!.dimensions).toBe(3);
});

// ── Dimension change ────────────────────────────────────────────────────────

test('reopening with different dimensions wipes existing data', async () => {
  await store.upsertEntry('e1', 'A', 'a', [1, 0, 0]);
  expect(await store.entryCount()).toBe(1);
  await store.close();

  // Reopen with different dimensions.
  const store2 = new KbVectorStore(tmpDir, 5);
  await store2.ready();

  // Data should be wiped because dimensions changed (3 → 5).
  expect(await store2.entryCount()).toBe(0);

  // Can insert with new dimensions.
  await store2.upsertEntry('e2', 'B', 'b', [1, 0, 0, 0, 0]);
  expect(await store2.entryCount()).toBe(1);
  await store2.close();

  // Reassign so afterEach cleanup works.
  store = new KbVectorStore(tmpDir, 5);
  await store.ready();
});

// ── topK limits ─────────────────────────────────────────────────────────────

test('vector search respects topK limit', async () => {
  for (let i = 0; i < 10; i++) {
    await store.upsertEntry(`e${i}`, `Entry ${i}`, `Summary ${i}`, [Math.random(), Math.random(), Math.random()]);
  }
  const results = await store.vectorSearchEntries([1, 0, 0], 3);
  expect(results.length).toBe(3);
});
