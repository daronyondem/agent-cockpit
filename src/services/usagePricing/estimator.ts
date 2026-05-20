import type { Usage } from '../../types';
import type {
  UsageCostEstimate,
  UsageCostInput,
  UsagePricingEntry,
} from './types';
import { estimateWithProviderCalculator } from './providerCalculators';

export { findPricingEntry, providerForBackend } from './providerCalculators';

export function estimateUsageCost(input: UsageCostInput): UsageCostEstimate {
  if (input.usage.costSource === 'estimated' && typeof input.usage.estimatedCostUsd === 'number') {
    return {
      estimatedCostUsd: input.usage.estimatedCostUsd,
      costSource: 'estimated',
      ...(input.usage.costSnapshot ? { costSnapshot: input.usage.costSnapshot } : {}),
    };
  }

  if ((input.usage.costUsd || 0) > 0) {
    return { estimatedCostUsd: 0, costSource: 'reported' };
  }

  return estimateWithProviderCalculator(input);
}

export function applyCostEstimate(
  backend: string,
  model: string,
  usage: Usage,
  pricedAt?: string,
  entries?: UsagePricingEntry[],
  catalogVersion?: string,
  pricingTier?: string,
): Usage {
  const estimate = estimateUsageCost({ backend, model, usage, pricedAt, entries, catalogVersion, pricingTier });
  const next: Usage = {
    ...usage,
    costSource: estimate.costSource,
    estimatedCostUsd: undefined,
    costSnapshot: undefined,
  };
  if (estimate.costSource === 'estimated') {
    next.estimatedCostUsd = estimate.estimatedCostUsd;
    if (estimate.costSnapshot) next.costSnapshot = estimate.costSnapshot;
  }
  return next;
}
