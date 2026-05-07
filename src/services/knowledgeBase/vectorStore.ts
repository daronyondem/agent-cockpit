/**
 * PGLite-backed vector + full-text search store for the Knowledge Base.
 *
 * Each workspace gets its own PGLite database directory at
 * `<knowledgeDir>/vectors/`.  The store manages two entity types —
 * entries and topics — each with a pgvector embedding column and a
 * PostgreSQL tsvector column for BM25-style keyword search.
 *
 * Search operations:
 *   - vector_search   — cosine-distance nearest neighbours
 *   - keyword_search  — ts_rank full-text match
 *   - hybrid_search   — reciprocal-rank-fusion of both
 *   - find_similar_topics / find_unconnected_similar
 */

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import path from 'node:path';
import { EMBEDDING_DEFAULTS, type ResolvedEmbeddingConfig } from './embeddings';

// ── Types ───────────────────────────────────────────────────────────────────

export interface VectorSearchResult {
  id: string;
  kind: 'entry' | 'topic';
  title: string;
  summary: string;
  score: number;
}

export interface VectorStoreMeta {
  model: string;
  dimensions: number;
}

// ── Store ───────────────────────────────────────────────────────────────────

export class KbVectorStore {
  private db!: PGlite;
  private readonly dbPath: string;
  private dimensions: number;
  private _ready: Promise<void>;

  constructor(knowledgeDir: string, dimensions?: number) {
    this.dbPath = path.join(knowledgeDir, 'vectors');
    this.dimensions = dimensions ?? EMBEDDING_DEFAULTS.dimensions;
    this._ready = this._init();
  }

  /** Wait until the store is ready (schema created). */
  async ready(): Promise<void> {
    return this._ready;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  private async _init(): Promise<void> {
    this.db = new PGlite(this.dbPath, { extensions: { vector } });
    await this.db.exec('CREATE EXTENSION IF NOT EXISTS vector');
    await this._initSchema();
  }

  private async _initSchema(): Promise<void> {
    const dim = this.dimensions;

    // ── Meta table (tracks embedding config) ────────────────────────────
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS store_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Check for dimension mismatch (provider/model changed).
    const existing = await this.db.query<{ value: string }>(
      `SELECT value FROM store_meta WHERE key = 'dimensions'`,
    );
    if (existing.rows.length > 0) {
      const storedDim = parseInt(existing.rows[0].value, 10);
      if (storedDim !== dim) {
        // Dimension changed — wipe vector data, recreate tables.
        await this._wipeTables();
      }
    }

    // ── Entry embeddings ────────────────────────────────────────────────
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS entry_embeddings (
        entry_id   TEXT PRIMARY KEY,
        title      TEXT NOT NULL DEFAULT '',
        summary    TEXT NOT NULL DEFAULT '',
        embedding  vector(${dim}),
        tsv        tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(summary, '')), 'B')
        ) STORED
      )
    `);
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS entry_emb_idx
        ON entry_embeddings USING hnsw (embedding vector_cosine_ops)
    `);
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS entry_tsv_idx
        ON entry_embeddings USING GIN (tsv)
    `);

    // ── Topic embeddings ────────────────────────────────────────────────
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS topic_embeddings (
        topic_id   TEXT PRIMARY KEY,
        title      TEXT NOT NULL DEFAULT '',
        summary    TEXT NOT NULL DEFAULT '',
        embedding  vector(${dim}),
        tsv        tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(summary, '')), 'B')
        ) STORED
      )
    `);
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS topic_emb_idx
        ON topic_embeddings USING hnsw (embedding vector_cosine_ops)
    `);
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS topic_tsv_idx
        ON topic_embeddings USING GIN (tsv)
    `);

    // ── Persist current config ──────────────────────────────────────────
    await this._upsertMeta('dimensions', String(dim));
  }

  /** Drop and recreate vector tables (dimension change). */
  private async _wipeTables(): Promise<void> {
    await this.db.exec('DROP TABLE IF EXISTS entry_embeddings');
    await this.db.exec('DROP TABLE IF EXISTS topic_embeddings');
  }

  private async _upsertMeta(key: string, value: string): Promise<void> {
    await this.db.query(
      `INSERT INTO store_meta (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }

  async getMeta(): Promise<VectorStoreMeta | null> {
    const rows = await this.db.query<{ key: string; value: string }>(
      `SELECT key, value FROM store_meta WHERE key IN ('model', 'dimensions')`,
    );
    if (rows.rows.length === 0) return null;
    const map = Object.fromEntries(rows.rows.map((r) => [r.key, r.value]));
    return {
      model: map.model ?? '',
      dimensions: parseInt(map.dimensions ?? '0', 10),
    };
  }

  async setModel(model: string): Promise<void> {
    await this._upsertMeta('model', model);
  }

  // ── Upsert ────────────────────────────────────────────────────────────

  async upsertEntry(
    entryId: string,
    title: string,
    summary: string,
    embedding: number[],
  ): Promise<void> {
    await this.ready();
    const vecLiteral = `[${embedding.join(',')}]`;
    await this.db.query(
      `INSERT INTO entry_embeddings (entry_id, title, summary, embedding)
       VALUES ($1, $2, $3, $4::vector)
       ON CONFLICT (entry_id) DO UPDATE SET
         title = EXCLUDED.title,
         summary = EXCLUDED.summary,
         embedding = EXCLUDED.embedding`,
      [entryId, title, summary, vecLiteral],
    );
  }

  async upsertTopic(
    topicId: string,
    title: string,
    summary: string,
    embedding: number[],
  ): Promise<void> {
    await this.ready();
    const vecLiteral = `[${embedding.join(',')}]`;
    await this.db.query(
      `INSERT INTO topic_embeddings (topic_id, title, summary, embedding)
       VALUES ($1, $2, $3, $4::vector)
       ON CONFLICT (topic_id) DO UPDATE SET
         title = EXCLUDED.title,
         summary = EXCLUDED.summary,
         embedding = EXCLUDED.embedding`,
      [topicId, title, summary, vecLiteral],
    );
  }

  async deleteEntry(entryId: string): Promise<void> {
    await this.ready();
    await this.db.query(
      `DELETE FROM entry_embeddings WHERE entry_id = $1`,
      [entryId],
    );
  }

  async deleteTopic(topicId: string): Promise<void> {
    await this.ready();
    await this.db.query(
      `DELETE FROM topic_embeddings WHERE topic_id = $1`,
      [topicId],
    );
  }

  // ── Search: Vector ────────────────────────────────────────────────────

  async vectorSearchEntries(
    queryEmbedding: number[],
    topK = 20,
  ): Promise<VectorSearchResult[]> {
    await this.ready();
    const vecLiteral = `[${queryEmbedding.join(',')}]`;
    const res = await this.db.query<{
      entry_id: string;
      title: string;
      summary: string;
      distance: number;
    }>(
      `SELECT entry_id, title, summary, embedding <=> $1::vector AS distance
       FROM entry_embeddings
       ORDER BY distance
       LIMIT $2`,
      [vecLiteral, topK],
    );
    return res.rows.map((r) => ({
      id: r.entry_id,
      kind: 'entry' as const,
      title: r.title,
      summary: r.summary,
      score: 1 - r.distance, // cosine similarity = 1 - cosine distance
    }));
  }

  async vectorSearchTopics(
    queryEmbedding: number[],
    topK = 20,
  ): Promise<VectorSearchResult[]> {
    await this.ready();
    const vecLiteral = `[${queryEmbedding.join(',')}]`;
    const res = await this.db.query<{
      topic_id: string;
      title: string;
      summary: string;
      distance: number;
    }>(
      `SELECT topic_id, title, summary, embedding <=> $1::vector AS distance
       FROM topic_embeddings
       ORDER BY distance
       LIMIT $2`,
      [vecLiteral, topK],
    );
    return res.rows.map((r) => ({
      id: r.topic_id,
      kind: 'topic' as const,
      title: r.title,
      summary: r.summary,
      score: 1 - r.distance,
    }));
  }

  // ── Search: Keyword (BM25-style via ts_rank) ──────────────────────────

  async keywordSearchEntries(
    query: string,
    topK = 20,
  ): Promise<VectorSearchResult[]> {
    await this.ready();
    const res = await this.db.query<{
      entry_id: string;
      title: string;
      summary: string;
      rank: number;
    }>(
      `SELECT entry_id, title, summary, ts_rank(tsv, q) AS rank
       FROM entry_embeddings, plainto_tsquery('english', $1) q
       WHERE tsv @@ q
       ORDER BY rank DESC
       LIMIT $2`,
      [query, topK],
    );
    return res.rows.map((r) => ({
      id: r.entry_id,
      kind: 'entry' as const,
      title: r.title,
      summary: r.summary,
      score: r.rank,
    }));
  }

  async keywordSearchTopics(
    query: string,
    topK = 20,
  ): Promise<VectorSearchResult[]> {
    await this.ready();
    const res = await this.db.query<{
      topic_id: string;
      title: string;
      summary: string;
      rank: number;
    }>(
      `SELECT topic_id, title, summary, ts_rank(tsv, q) AS rank
       FROM topic_embeddings, plainto_tsquery('english', $1) q
       WHERE tsv @@ q
       ORDER BY rank DESC
       LIMIT $2`,
      [query, topK],
    );
    return res.rows.map((r) => ({
      id: r.topic_id,
      kind: 'topic' as const,
      title: r.title,
      summary: r.summary,
      score: r.rank,
    }));
  }

  // ── Search: Hybrid (Reciprocal Rank Fusion) ───────────────────────────

  async hybridSearchEntries(
    query: string,
    queryEmbedding: number[],
    topK = 20,
  ): Promise<VectorSearchResult[]> {
    const [vecResults, kwResults] = await Promise.all([
      this.vectorSearchEntries(queryEmbedding, topK * 2),
      this.keywordSearchEntries(query, topK * 2),
    ]);
    return rrfMerge(vecResults, kwResults, topK);
  }

  async hybridSearchTopics(
    query: string,
    queryEmbedding: number[],
    topK = 20,
  ): Promise<VectorSearchResult[]> {
    const [vecResults, kwResults] = await Promise.all([
      this.vectorSearchTopics(queryEmbedding, topK * 2),
      this.keywordSearchTopics(query, topK * 2),
    ]);
    return rrfMerge(vecResults, kwResults, topK);
  }

  /** Search both entries and topics, merged via RRF. */
  async hybridSearch(
    query: string,
    queryEmbedding: number[],
    topK = 20,
  ): Promise<VectorSearchResult[]> {
    const [entries, topics] = await Promise.all([
      this.hybridSearchEntries(query, queryEmbedding, topK),
      this.hybridSearchTopics(query, queryEmbedding, topK),
    ]);
    // Interleave and re-sort by score
    return [...entries, ...topics]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  // ── Topic-specific searches ───────────────────────────────────────────

  /** Find topics most similar to a given topic by embedding. */
  async findSimilarTopics(
    topicId: string,
    topK = 10,
  ): Promise<VectorSearchResult[]> {
    await this.ready();
    const res = await this.db.query<{
      topic_id: string;
      title: string;
      summary: string;
      distance: number;
    }>(
      `SELECT t2.topic_id, t2.title, t2.summary,
              t1.embedding <=> t2.embedding AS distance
       FROM topic_embeddings t1, topic_embeddings t2
       WHERE t1.topic_id = $1 AND t2.topic_id != $1
       ORDER BY distance
       LIMIT $2`,
      [topicId, topK],
    );
    return res.rows.map((r) => ({
      id: r.topic_id,
      kind: 'topic' as const,
      title: r.title,
      summary: r.summary,
      score: 1 - r.distance,
    }));
  }

  // ── Stats ─────────────────────────────────────────────────────────────

  async entryCount(): Promise<number> {
    await this.ready();
    const res = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count FROM entry_embeddings`,
    );
    return parseInt(res.rows[0].count, 10);
  }

  async topicCount(): Promise<number> {
    await this.ready();
    const res = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count FROM topic_embeddings`,
    );
    return parseInt(res.rows[0].count, 10);
  }

  /** IDs of all entries currently in the vector store. */
  async embeddedEntryIds(): Promise<Set<string>> {
    await this.ready();
    const res = await this.db.query<{ entry_id: string }>(
      `SELECT entry_id FROM entry_embeddings`,
    );
    return new Set(res.rows.map((r) => r.entry_id));
  }

  /** IDs of all topics currently in the vector store. */
  async embeddedTopicIds(): Promise<Set<string>> {
    await this.ready();
    const res = await this.db.query<{ topic_id: string }>(
      `SELECT topic_id FROM topic_embeddings`,
    );
    return new Set(res.rows.map((r) => r.topic_id));
  }

  // ── Wipe (for provider/model changes) ─────────────────────────────────

  /** Delete all vectors. Tables remain, data is cleared. */
  async wipeAllEmbeddings(): Promise<void> {
    await this.ready();
    await this.db.exec('DELETE FROM entry_embeddings');
    await this.db.exec('DELETE FROM topic_embeddings');
  }

  /** Delete only topic vectors. Entry vectors remain available for retrieval. */
  async wipeTopicEmbeddings(): Promise<void> {
    await this.ready();
    await this.db.exec('DELETE FROM topic_embeddings');
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  async close(): Promise<void> {
    await this.db.close();
  }
}

// ── Reciprocal Rank Fusion ──────────────────────────────────────────────────

const RRF_K = 60; // standard RRF constant

function rrfMerge(
  listA: VectorSearchResult[],
  listB: VectorSearchResult[],
  topK: number,
): VectorSearchResult[] {
  const scores = new Map<string, { result: VectorSearchResult; score: number }>();

  for (let i = 0; i < listA.length; i++) {
    const r = listA[i];
    const existing = scores.get(r.id);
    const rrfScore = 1 / (RRF_K + i + 1);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(r.id, { result: r, score: rrfScore });
    }
  }

  for (let i = 0; i < listB.length; i++) {
    const r = listB[i];
    const existing = scores.get(r.id);
    const rrfScore = 1 / (RRF_K + i + 1);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(r.id, { result: r, score: rrfScore });
    }
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => ({ ...s.result, score: s.score }));
}
