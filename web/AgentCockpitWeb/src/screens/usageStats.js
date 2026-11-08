import { isUsageCostUnavailable } from '../../../../src/contracts/usagePresentation';

const usageReportedCost = usage => Number(usage && usage.costUsd) || 0;
const usageEstimatedCost = usage => Number(usage && usage.estimatedCostUsd) || 0;

/* Sum every record across the given days into a single usage total. */
export function totalsFor(days){
  const t = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, estimatedCostUsd: 0, hasUnpricedUsage: false };
  for (const d of days || []) {
    for (const r of (d.records || [])) {
      const u = r.usage || {};
      t.inputTokens      += u.inputTokens      || 0;
      t.outputTokens     += u.outputTokens     || 0;
      t.cacheReadTokens  += u.cacheReadTokens  || 0;
      t.cacheWriteTokens += u.cacheWriteTokens || 0;
      t.costUsd          += usageReportedCost(u);
      t.estimatedCostUsd += usageEstimatedCost(u);
      t.hasUnpricedUsage ||= isUsageCostUnavailable(u, r.backend);
    }
  }
  return t;
}


export function aggregatePerModel(days){
  const map = new Map();
  for (const d of days || []) {
    for (const r of (d.records || [])) {
      const pricingTier = r.pricingTier || '';
      const key = `${r.backend}\u0001${r.model}\u0001${pricingTier}`;
      const slot = map.get(key) || {
        backend: r.backend, model: r.model, pricingTier,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, estimatedCostUsd: 0, hasUnpricedUsage: false,
      };
      const u = r.usage || {};
      slot.inputTokens      += u.inputTokens      || 0;
      slot.outputTokens     += u.outputTokens     || 0;
      slot.cacheReadTokens  += u.cacheReadTokens  || 0;
      slot.cacheWriteTokens += u.cacheWriteTokens || 0;
      slot.costUsd          += usageReportedCost(u);
      slot.estimatedCostUsd += usageEstimatedCost(u);
      slot.hasUnpricedUsage ||= isUsageCostUnavailable(u, r.backend);
      map.set(key, slot);
    }
  }
  return Array.from(map.values()).sort((a, b) => (b.costUsd + b.estimatedCostUsd) - (a.costUsd + a.estimatedCostUsd));
}
