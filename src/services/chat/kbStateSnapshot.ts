import type {
  KbAutoDreamConfig,
  KbCounters,
  KbState,
} from '../../types';
import {
  KbDatabase,
  normalizeFolderPath,
} from '../knowledgeBase/db';
import { computeDigestProgress } from '../knowledgeBase/digest';
import { DEFAULT_KB_AUTO_DREAM_CONFIG, normalizeKbAutoDreamConfig } from '../knowledgeBase/autoDream';
import { resolveConfig, type EmbeddingConfig } from '../knowledgeBase/embeddings';
import type { KbVectorStore } from '../knowledgeBase/vectorStore';

/**
 * Schema version of the `state.json` envelope itself. Bumped only when
 * we change the top-level shape (e.g. add a new top-level map). Distinct
 * from `entrySchemaVersion`, which tracks the digestion output format.
 */
export const KB_STATE_VERSION = 1;

/**
 * Current digestion entry schema version. Bumped when the digestion
 * prompt or the entry YAML frontmatter format changes. When bumped,
 * existing entries in `state.json` get `staleSchema: true` and are
 * surfaced in the KB Browser as "needs re-digestion".
 */
export const KB_ENTRY_SCHEMA_VERSION = 1;

interface KbStateSnapshotServiceDeps {
  getKbVectorStore(hash: string, dimensions?: number): Promise<KbVectorStore | null>;
}

export class KbStateSnapshotService {
  constructor(private readonly deps: KbStateSnapshotServiceDeps) {}

  async buildSnapshot(
    hash: string,
    db: KbDatabase,
    opts: { folderPath?: string; limit?: number; offset?: number },
    flags: { autoDigest: boolean; autoDream?: KbAutoDreamConfig; embedding?: EmbeddingConfig },
  ): Promise<KbState> {
    const folderPath = opts.folderPath !== undefined
      ? normalizeFolderPath(opts.folderPath)
      : '';

    const sessionRow = db.getDigestSession();
    const digestProgress = sessionRow ? computeDigestProgress(sessionRow) : null;
    const synthesisSnapshot = db.getSynthesisSnapshot();
    const counters = await this.withEmbeddingCounters(hash, db, flags.embedding, db.getCounters());

    return {
      version: KB_STATE_VERSION,
      entrySchemaVersion: KB_ENTRY_SCHEMA_VERSION,
      autoDigest: flags.autoDigest,
      autoDream: normalizeKbAutoDreamConfig(flags.autoDream),
      dreamingStatus: synthesisSnapshot.status,
      dreamProgress: synthesisSnapshot.dreamProgress,
      needsSynthesisCount: synthesisSnapshot.needsSynthesisCount,
      counters,
      folders: db.listFolders(),
      raw: db.listRawInFolder(folderPath, {
        limit: opts.limit,
        offset: opts.offset,
      }),
      digestProgress,
      updatedAt: new Date().toISOString(),
    };
  }

  async withEmbeddingCounters(
    hash: string,
    db: KbDatabase,
    cfg: EmbeddingConfig | undefined,
    counters: KbCounters,
  ): Promise<KbCounters> {
    const enriched: KbCounters = {
      ...counters,
      embeddingConfigured: Boolean(cfg),
      entryEmbeddedCount: null,
      topicEmbeddedCount: null,
      embeddingIndexError: null,
    };
    if (!cfg) return enriched;
    try {
      const resolved = resolveConfig(cfg);
      const store = await this.deps.getKbVectorStore(hash, resolved.dimensions);
      if (!store) {
        enriched.embeddingIndexError = 'Vector store unavailable';
        return enriched;
      }
      const [embeddedEntryIds, embeddedTopicIds] = await Promise.all([
        store.embeddedEntryIds(),
        store.embeddedTopicIds(),
      ]);
      enriched.entryEmbeddedCount = db.listEntryIds().filter((entryId) => embeddedEntryIds.has(entryId)).length;
      enriched.topicEmbeddedCount = db.listTopicIds().filter((topicId) => embeddedTopicIds.has(topicId)).length;
    } catch (err: unknown) {
      enriched.embeddingIndexError = (err as Error).message || 'Vector store unavailable';
    }
    return enriched;
  }

  /** Zero-value snapshot used when KB is disabled or not yet initialized. */
  emptySnapshot(autoDigest: boolean, autoDream?: KbAutoDreamConfig): KbState {
    const zeroCounters: KbCounters = {
      rawTotal: 0,
      rawByStatus: {
        ingesting: 0,
        ingested: 0,
        digesting: 0,
        digested: 0,
        failed: 0,
        'pending-delete': 0,
      },
      failedByStage: {
        conversion: 0,
        digestion: 0,
        unknown: 0,
      },
      entryCount: 0,
      pendingCount: 0,
      folderCount: 0,
      documentCount: 0,
      documentNodeCount: 0,
      entrySourceCount: 0,
      topicCount: 0,
      connectionCount: 0,
      reflectionCount: 0,
      staleReflectionCount: 0,
      embeddingConfigured: false,
      entryEmbeddedCount: null,
      topicEmbeddedCount: null,
      embeddingIndexError: null,
    };
    return {
      version: KB_STATE_VERSION,
      entrySchemaVersion: KB_ENTRY_SCHEMA_VERSION,
      autoDigest,
      autoDream: normalizeKbAutoDreamConfig(autoDream ?? DEFAULT_KB_AUTO_DREAM_CONFIG),
      dreamingStatus: 'idle',
      dreamProgress: null,
      needsSynthesisCount: 0,
      counters: zeroCounters,
      folders: [],
      raw: [],
      digestProgress: null,
      updatedAt: new Date().toISOString(),
    };
  }
}
