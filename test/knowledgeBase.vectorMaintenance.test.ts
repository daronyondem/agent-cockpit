
jest.mock('../src/services/knowledgeBase/embeddings', () => ({
  resolveConfig: jest.fn((cfg) => ({
    model: cfg?.model ?? 'test-model',
    ollamaHost: cfg?.ollamaHost ?? 'http://localhost:11434',
    dimensions: cfg?.dimensions ?? 3,
  })),
  embedBatch: jest.fn(async (texts: string[]) => texts.map((_, index) => ({
    embedding: [index + 1, 0, 0],
  }))),
}));

import { rebuildKbVectorIndex } from '../src/services/knowledgeBase/vectorMaintenance';
import * as embeddingsMod from '../src/services/knowledgeBase/embeddings';

describe('rebuildKbVectorIndex', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function buildHarness(overrides: Record<string, unknown> = {}) {
    const entries = [
      { entryId: 'entry-1', title: 'Entry One', summary: 'First summary' },
      { entryId: 'entry-2', title: 'Entry Two', summary: 'Second summary' },
    ];
    const topics = [
      { topicId: 'topic-1', title: 'Topic One', summary: 'Topic summary' },
    ];
    const db = {
      countEntries: jest.fn(() => entries.length),
      listEntries: jest.fn(({ limit, offset }) => entries.slice(offset, offset + limit)),
      listTopicSummaries: jest.fn(() => topics),
    };
    const store = {
      setModel: jest.fn().mockResolvedValue(undefined),
      upsertEntry: jest.fn().mockResolvedValue(undefined),
      upsertTopic: jest.fn().mockResolvedValue(undefined),
      embeddedEntryIds: jest.fn().mockResolvedValue(new Set(['entry-1', 'entry-old'])),
      embeddedTopicIds: jest.fn().mockResolvedValue(new Set(['topic-1', 'topic-old'])),
      deleteEntry: jest.fn().mockResolvedValue(undefined),
      deleteTopic: jest.fn().mockResolvedValue(undefined),
    };
    const chatService = {
      getWorkspaceKbEnabled: jest.fn().mockResolvedValue(true),
      getKbDb: jest.fn(() => db),
      getWorkspaceKbEmbeddingConfig: jest.fn().mockResolvedValue({
        model: 'test-model',
        ollamaHost: 'http://localhost:11434',
        dimensions: 3,
      }),
      getKbVectorStore: jest.fn().mockResolvedValue(store),
      resetKbVectorStore: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    return { chatService, db, store };
  }

  test('embeds current entries and topics without touching synthesis state', async () => {
    const { chatService, store } = buildHarness();

    const result = await rebuildKbVectorIndex(chatService as any, 'workspace-1');

    expect(embeddingsMod.embedBatch).toHaveBeenCalledWith([
      'Entry One — First summary',
      'Entry Two — Second summary',
    ], expect.any(Object));
    expect(embeddingsMod.embedBatch).toHaveBeenCalledWith([
      'Topic One — Topic summary',
    ], expect.any(Object));
    expect(store.upsertEntry).toHaveBeenCalledWith('entry-1', 'Entry One', 'First summary', [1, 0, 0]);
    expect(store.upsertEntry).toHaveBeenCalledWith('entry-2', 'Entry Two', 'Second summary', [2, 0, 0]);
    expect(store.upsertTopic).toHaveBeenCalledWith('topic-1', 'Topic One', 'Topic summary', [1, 0, 0]);
    expect(store.deleteEntry).toHaveBeenCalledWith('entry-old');
    expect(store.deleteTopic).toHaveBeenCalledWith('topic-old');
    expect(result).toEqual({
      entriesEmbedded: 2,
      topicsEmbedded: 1,
      staleEntriesRemoved: 1,
      staleTopicsRemoved: 1,
    });
  });

  test('requires saved embedding configuration', async () => {
    const { chatService } = buildHarness({
      getWorkspaceKbEmbeddingConfig: jest.fn().mockResolvedValue(undefined),
    });

    await expect(rebuildKbVectorIndex(chatService as any, 'workspace-1'))
      .rejects.toMatchObject({
        message: 'Embedding configuration required.',
        statusCode: 400,
      });
    expect(chatService.getKbVectorStore).not.toHaveBeenCalled();
  });

  test('resets and recreates the vector store when opening existing PGLite state fails', async () => {
    const { chatService, store } = buildHarness();
    chatService.getKbVectorStore = jest.fn()
      .mockRejectedValueOnce(new Error('Aborted(). Build with -sASSERTIONS for more info.'))
      .mockResolvedValueOnce(store);

    const result = await rebuildKbVectorIndex(chatService as any, 'workspace-1');

    expect(chatService.resetKbVectorStore).toHaveBeenCalledWith('workspace-1');
    expect(chatService.getKbVectorStore).toHaveBeenNthCalledWith(1, 'workspace-1', 3);
    expect(chatService.getKbVectorStore).toHaveBeenNthCalledWith(2, 'workspace-1', 3);
    expect(store.upsertEntry).toHaveBeenCalledWith('entry-1', 'Entry One', 'First summary', [1, 0, 0]);
    expect(store.upsertTopic).toHaveBeenCalledWith('topic-1', 'Topic One', 'Topic summary', [1, 0, 0]);
    expect(result.entriesEmbedded).toBe(2);
    expect(result.topicsEmbedded).toBe(1);
  });
});
