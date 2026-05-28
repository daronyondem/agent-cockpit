import type { ChatService } from '../chatService';
import { embedBatch, resolveConfig } from './embeddings';

const VECTOR_REBUILD_BATCH_SIZE = 50;

export class KbVectorMaintenanceError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'KbVectorMaintenanceError';
    this.statusCode = statusCode;
  }
}

export interface KbVectorIndexRebuildResult {
  entriesEmbedded: number;
  topicsEmbedded: number;
  staleEntriesRemoved: number;
  staleTopicsRemoved: number;
}

async function openVectorStoreForRebuild(
  chatService: ChatService,
  hash: string,
  dimensions: number,
) {
  try {
    return await chatService.getKbVectorStore(hash, dimensions);
  } catch {
    await chatService.resetKbVectorStore(hash);
    return chatService.getKbVectorStore(hash, dimensions);
  }
}

export async function rebuildKbVectorIndex(
  chatService: ChatService,
  hash: string,
): Promise<KbVectorIndexRebuildResult> {
  const enabled = await chatService.getWorkspaceKbEnabled(hash);
  if (!enabled) {
    throw new KbVectorMaintenanceError('Knowledge Base is not enabled for this workspace.', 400);
  }

  const db = chatService.getKbDb(hash);
  if (!db) {
    throw new KbVectorMaintenanceError('Knowledge Base database not available.', 404);
  }

  const cfg = await chatService.getWorkspaceKbEmbeddingConfig(hash);
  if (!cfg) {
    throw new KbVectorMaintenanceError('Embedding configuration required.', 400);
  }

  const resolved = resolveConfig(cfg);
  const store = await openVectorStoreForRebuild(chatService, hash, resolved.dimensions);
  if (!store) {
    throw new KbVectorMaintenanceError('Vector store unavailable.', 500);
  }

  let entriesEmbedded = 0;
  let topicsEmbedded = 0;
  let staleEntriesRemoved = 0;
  let staleTopicsRemoved = 0;
  const currentEntryIds = new Set<string>();
  const currentTopicIds = new Set<string>();

  await store.setModel(resolved.model);

  const entryTotal = db.countEntries();
  for (let offset = 0; offset < entryTotal; offset += VECTOR_REBUILD_BATCH_SIZE) {
    const entries = db.listEntries({ limit: VECTOR_REBUILD_BATCH_SIZE, offset });
    if (entries.length === 0) break;
    for (const entry of entries) currentEntryIds.add(entry.entryId);

    const results = await embedBatch(
      entries.map((entry) => `${entry.title} — ${entry.summary}`),
      cfg,
    );
    for (let i = 0; i < entries.length; i += 1) {
      const embedding = results[i]?.embedding;
      if (!Array.isArray(embedding)) continue;
      await store.upsertEntry(entries[i].entryId, entries[i].title, entries[i].summary, embedding);
      entriesEmbedded += 1;
    }
  }

  const topics = db.listTopicSummaries();
  for (const topic of topics) currentTopicIds.add(topic.topicId);
  for (let offset = 0; offset < topics.length; offset += VECTOR_REBUILD_BATCH_SIZE) {
    const slice = topics.slice(offset, offset + VECTOR_REBUILD_BATCH_SIZE);
    const results = await embedBatch(
      slice.map((topic) => `${topic.title} — ${topic.summary ?? ''}`),
      cfg,
    );
    for (let i = 0; i < slice.length; i += 1) {
      const embedding = results[i]?.embedding;
      if (!Array.isArray(embedding)) continue;
      await store.upsertTopic(slice[i].topicId, slice[i].title, slice[i].summary ?? '', embedding);
      topicsEmbedded += 1;
    }
  }

  const embeddedEntryIds = await store.embeddedEntryIds();
  for (const entryId of embeddedEntryIds) {
    if (currentEntryIds.has(entryId)) continue;
    await store.deleteEntry(entryId);
    staleEntriesRemoved += 1;
  }

  const embeddedTopicIds = await store.embeddedTopicIds();
  for (const topicId of embeddedTopicIds) {
    if (currentTopicIds.has(topicId)) continue;
    await store.deleteTopic(topicId);
    staleTopicsRemoved += 1;
  }

  return {
    entriesEmbedded,
    topicsEmbedded,
    staleEntriesRemoved,
    staleTopicsRemoved,
  };
}
