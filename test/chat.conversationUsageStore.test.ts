import { ConversationUsageStore } from '../src/services/chat/conversationUsageStore';
import type { ConversationEntry, Usage, WorkspaceIndex } from '../src/types';
import type { UsagePricingCatalog } from '../src/services/usagePricing/types';

const emptyCatalog: UsagePricingCatalog = {
  schemaVersion: 1,
  version: 'test',
  currency: 'USD',
  entries: [],
};

function makeConversation(overrides: Partial<ConversationEntry> = {}): ConversationEntry {
  return {
    id: 'conv-1',
    title: 'Conversation',
    backend: 'codex',
    model: 'gpt-5',
    serviceTier: 'fast',
    currentSessionId: 'session-1',
    lastActivity: '2026-05-25T00:00:00.000Z',
    lastMessage: null,
    sessions: [{
      number: 1,
      sessionId: 'session-1',
      summary: null,
      active: true,
      messageCount: 0,
      startedAt: '2026-05-25T00:00:00.000Z',
      endedAt: null,
    }],
    ...overrides,
  };
}

function makeUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    costUsd: 0,
    ...overrides,
  };
}

describe('ConversationUsageStore', () => {
  let index: WorkspaceIndex;
  let convWorkspaceMap: Map<string, string>;
  let writes: number;

  beforeEach(() => {
    index = {
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/project',
      conversations: [makeConversation()],
    };
    convWorkspaceMap = new Map([['conv-1', 'workspace-1']]);
    writes = 0;
  });

  function createStore(): ConversationUsageStore {
    return new ConversationUsageStore({
      convWorkspaceMap,
      indexLock: { run: async (_key, fn) => fn() },
      getConvFromIndex: async (convId) => {
        const hash = convWorkspaceMap.get(convId);
        if (!hash) return null;
        const convEntry = index.conversations.find(c => c.id === convId);
        return convEntry ? { hash, index, convEntry } : null;
      },
      writeWorkspaceIndex: async () => {
        writes++;
      },
    });
  }

  it('adds usage to conversation and active-session totals with per-backend buckets', async () => {
    const store = createStore();

    const result = await store.addUsage('conv-1', makeUsage(), emptyCatalog);

    expect(result).toMatchObject({
      backendId: 'codex',
      modelId: 'gpt-5',
      pricingTier: 'priority',
      conversationUsage: { inputTokens: 10, outputTokens: 5 },
      sessionUsage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(index.conversations[0].usageByBackend?.codex).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(index.conversations[0].sessions[0].usageByBackend?.codex).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(writes).toBe(1);
  });

  it('uses explicit backend/model overrides and accumulates repeated usage', async () => {
    const store = createStore();

    await store.addUsage('conv-1', makeUsage({ inputTokens: 1, outputTokens: 1 }), emptyCatalog, 'kiro', 'kiro-default');
    await store.addUsage('conv-1', makeUsage({ inputTokens: 2, outputTokens: 3, credits: 4 }), emptyCatalog, 'kiro', 'kiro-default');

    expect(index.conversations[0].usage).toMatchObject({ inputTokens: 3, outputTokens: 4, credits: 4 });
    expect(index.conversations[0].usageByBackend?.kiro).toMatchObject({ inputTokens: 3, outputTokens: 4, credits: 4 });
    expect(index.conversations[0].sessions[0].usageByBackend?.kiro).toMatchObject({ inputTokens: 3, outputTokens: 4, credits: 4 });
    expect(writes).toBe(2);
  });

  it('preserves an explicit pricing tier from the usage event', async () => {
    const store = createStore();

    const result = await store.addUsage('conv-1', makeUsage({ pricingTier: 'manual-tier' }), emptyCatalog);

    expect(result?.pricingTier).toBe('manual-tier');
    expect(result?.enrichedUsage.pricingTier).toBe('manual-tier');
  });

  it('returns empty session usage when no active session exists', async () => {
    index.conversations[0].sessions[0].active = false;
    const store = createStore();

    const result = await store.addUsage('conv-1', makeUsage(), emptyCatalog);

    expect(result?.conversationUsage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(result?.sessionUsage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('returns null for missing conversations and default usage for existing conversations without totals', async () => {
    const store = createStore();

    await expect(store.addUsage('missing', makeUsage(), emptyCatalog)).resolves.toBeNull();
    await expect(store.getUsage('missing')).resolves.toBeNull();
    await expect(store.getUsage('conv-1')).resolves.toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});
