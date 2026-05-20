import type { Usage } from '../../types';
import type {
  UsageCostSnapshot,
  UsageCostSource,
  UsagePricingCatalog,
  UsagePricingEntry,
  UsagePricingProvider,
  UsagePricingResponse,
  UsagePricingTier,
  UsagePricingUnit,
  UsageTokenRatesPerMillion,
} from '../../contracts/usagePricing';
export type {
  UsageCostSnapshot,
  UsageCostSource,
  UsagePricingCatalog,
  UsagePricingEntry,
  UsagePricingProvider,
  UsagePricingResponse,
  UsagePricingTier,
  UsagePricingUnit,
  UsageTokenRatesPerMillion,
} from '../../contracts/usagePricing';

export interface UsageCostEstimate {
  estimatedCostUsd: number;
  costSource: UsageCostSource;
  costSnapshot?: UsageCostSnapshot;
}

export interface UsagePricingContext {
  /** Provider pricing tier selected for the usage event, such as OpenAI priority processing. */
  pricingTier?: UsagePricingTier;
}

export interface UsageCostInput extends UsagePricingContext {
  backend: string;
  model: string;
  usage: Usage;
  catalogVersion?: string;
  pricedAt?: string;
  entries?: UsagePricingEntry[];
}
