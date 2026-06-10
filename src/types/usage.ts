// ── Usage Types ─────────────────────────────────────────────────────

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Cost source for display: provider-reported dollars, estimated fallback, or none. */
  costSource?: 'reported' | 'estimated' | 'none';
  /** Computed API-equivalent fallback cost. Provider-reported spend stays in costUsd. */
  estimatedCostUsd?: number;
  /** Pricing provenance for a persisted estimate. */
  costSnapshot?: {
    catalogVersion: string;
    pricedAt: string;
    provider: 'openai' | 'anthropic' | 'kiro';
    model: string;
    pricingTier?: string;
    pricingEntryId: string;
    sourceUrl: string;
    verifiedAt: string;
    effectiveDate: string;
    currency: 'USD';
    unit: 'tokens' | 'credits';
    ratesPerMillion?: {
      input: number;
      output: number;
      cachedInput?: number;
      cacheWrite?: number;
    };
    usdPerCredit?: number;
  };
  /** Kiro credits consumed (fractional, Kiro-specific unit). */
  credits?: number;
  /** Provider pricing tier for a raw usage event, such as OpenAI priority. Not meaningful on aggregate totals. */
  pricingTier?: string;
  /** Percentage of the model's context window used (0–100). Snapshot, not cumulative. */
  contextUsagePercentage?: number;
}

export interface UsageLedgerRecord {
  backend: string;
  model: string;
  /** Optional pricing tier for rows where provider pricing differs by service tier. */
  pricingTier?: string;
  usage: Usage;
}

export interface UsageLedgerDay {
  date: string;           // YYYY-MM-DD
  records: UsageLedgerRecord[];
}

export interface UsageLedger {
  days: UsageLedgerDay[];
}
