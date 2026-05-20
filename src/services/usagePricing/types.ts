import type { Usage } from '../../types';
import type {
  UsageCostSnapshot,
  UsageCostSource,
  UsagePricingCatalog,
  UsagePricingEntry,
  UsagePricingProvider,
  UsagePricingResponse,
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
  UsagePricingUnit,
  UsageTokenRatesPerMillion,
} from '../../contracts/usagePricing';

export interface UsageCostEstimate {
  estimatedCostUsd: number;
  costSource: UsageCostSource;
  costSnapshot?: UsageCostSnapshot;
}

export interface UsageCostInput {
  backend: string;
  model: string;
  usage: Usage;
  catalogVersion?: string;
  pricedAt?: string;
  entries?: UsagePricingEntry[];
}
