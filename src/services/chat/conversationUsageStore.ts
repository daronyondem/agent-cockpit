import type { ConversationEntry, Usage, WorkspaceIndex } from '../../types';
import type { UsagePricingCatalog } from '../usagePricing/types';
import { applyCostEstimate } from '../usagePricing/estimator';
import { addToUsage, emptyUsage } from './usageLedgerStore';

interface ConversationLookupResult {
  hash: string;
  index: WorkspaceIndex;
  convEntry: ConversationEntry;
}

interface ConversationUsageStoreDeps {
  convWorkspaceMap: Map<string, string>;
  indexLock: { run<T>(key: string, fn: () => Promise<T>): Promise<T> };
  getConvFromIndex(convId: string): Promise<ConversationLookupResult | null>;
  writeWorkspaceIndex(hash: string, index: WorkspaceIndex): Promise<void>;
}

export interface ConversationUsageMutationResult {
  conversationUsage: Usage;
  sessionUsage: Usage;
  backendId: string;
  modelId: string;
  enrichedUsage: Usage;
  pricingTier?: string;
}

function usagePricingTierForConversation(backendId: string, serviceTier?: string): string | undefined {
  return backendId === 'codex' && serviceTier === 'fast' ? 'priority' : undefined;
}

export class ConversationUsageStore {
  constructor(private readonly deps: ConversationUsageStoreDeps) {}

  async addUsage(
    convId: string,
    usage: Usage,
    pricingCatalog: UsagePricingCatalog,
    backend?: string,
    model?: string,
  ): Promise<ConversationUsageMutationResult | null> {
    if (!usage) return null;
    const hash = this.deps.convWorkspaceMap.get(convId);
    if (!hash) return null;
    return this.deps.indexLock.run(hash, async () => {
      const result = await this.deps.getConvFromIndex(convId);
      if (!result) return null;
      const { index, convEntry } = result;

      const backendId = backend || convEntry.backend;
      const modelId = model || convEntry.model || 'unknown';
      const pricingTier = usage.pricingTier || usagePricingTierForConversation(backendId, convEntry.serviceTier);
      const enrichedUsage = applyCostEstimate(
        backendId,
        modelId,
        usage,
        undefined,
        pricingCatalog.entries,
        pricingCatalog.version,
        pricingTier,
      );

      if (!convEntry.usage) convEntry.usage = emptyUsage();
      addToUsage(convEntry.usage, enrichedUsage);

      if (!convEntry.usageByBackend) convEntry.usageByBackend = {};
      if (!convEntry.usageByBackend[backendId]) convEntry.usageByBackend[backendId] = emptyUsage();
      addToUsage(convEntry.usageByBackend[backendId], enrichedUsage);

      let sessionUsage = emptyUsage();
      const activeSession = convEntry.sessions.find(s => s.active);
      if (activeSession) {
        if (!activeSession.usage) activeSession.usage = emptyUsage();
        addToUsage(activeSession.usage, enrichedUsage);
        sessionUsage = activeSession.usage;

        if (!activeSession.usageByBackend) activeSession.usageByBackend = {};
        if (!activeSession.usageByBackend[backendId]) activeSession.usageByBackend[backendId] = emptyUsage();
        addToUsage(activeSession.usageByBackend[backendId], enrichedUsage);
      }

      await this.deps.writeWorkspaceIndex(hash, index);
      return { conversationUsage: convEntry.usage, sessionUsage, backendId, modelId, enrichedUsage, pricingTier };
    });
  }

  async getUsage(convId: string): Promise<Usage | null> {
    const result = await this.deps.getConvFromIndex(convId);
    if (!result) return null;
    return result.convEntry.usage || emptyUsage();
  }
}
