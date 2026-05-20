---
id: 0070
title: Use provider calculators for usage pricing
status: Accepted
date: 2026-05-20
supersedes: []
superseded-by: null
tags: [usage, pricing, architecture]
affects:
  - AGENTS.md
  - docs/agent-project-memory.md
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-frontend.md
  - docs/spec-testing.md
  - src/contracts/usagePricing.ts
  - src/services/usagePricing/providerCalculators.ts
  - src/services/usagePricing/estimator.ts
  - src/services/usagePricing/catalog.default.json
  - src/services/chat/usageLedgerStore.ts
  - src/services/chatService.ts
  - src/services/backends/codex.ts
  - test/usagePricing.test.ts
  - test/chat.usageLedgerStore.test.ts
  - test/chatService.usage.test.ts
  - web/AgentCockpitWeb/src/screens/settingsScreen.jsx
---

## Context

Agent Cockpit records token, cache, dollar, and credit usage from multiple CLI
providers. The previous estimator was a single centralized path keyed by
backend, provider, model pattern, and pricing unit. That was adequate while
pricing differences were mostly token rates versus Kiro credits.

Codex Fast changes the shape of the problem. OpenAI priority processing has
separate rates from regular API processing, while Codex CLI token counts still
arrive as provider-reported token counters. Claude has its own token/cache
pricing and may report direct spend. Kiro is credit-based. Future CLI providers
are likely to add more provider-specific context rather than fit one uniform
formula.

If all of those branches continue to grow inside one estimator, each pricing
change risks coupling unrelated providers and making historical ledger behavior
harder to reason about.

## Decision

Usage pricing uses a provider calculator registry under
`src/services/usagePricing/providerCalculators.ts`.

The public estimator remains responsible for the cross-provider invariants:
provider-reported nonzero `costUsd` wins, already-persisted estimates are not
recalculated, and unpriced usage returns `costSource: "none"`. After those
checks, the estimator dispatches to the provider calculator for OpenAI,
Anthropic, or Kiro.

Pricing entries and stored snapshots may carry an optional `pricingTier`. The
ledger groups rows by backend, model, and pricing tier when present. Codex Fast
maps to OpenAI priority pricing by setting `pricingTier: "priority"` on Codex
usage context; default Codex usage keeps no tier and matches standard pricing.

Future providers should add a calculator or provider-specific context instead
of expanding a generic estimator branch.

## Alternatives Considered

- **Keep one generic estimator with more conditionals**. Rejected because Codex
  service tiers, Claude token/cache pricing, Kiro credits, and future provider
  rules would be coupled in one function even when their pricing semantics
  differ.
- **Persist only conversation service tier and derive pricing at read time**.
  Rejected because historical usage estimates must remain stable after catalog
  changes, and raw ledgers need enough context to distinguish default and
  priority rows.
- **Create separate usage ledgers per provider**. Rejected because the API and
  Settings Usage tab already operate on one daily ledger, and splitting files
  would make cross-provider summaries more complex without improving the
  pricing boundary.

## Consequences

- + Provider pricing behavior is isolated behind focused calculators while the
  public estimator keeps stable cost-source semantics.
- + Codex default and Fast/Priority usage no longer merge into one daily row or
  one pricing snapshot.
- + User pricing overrides can target a provider pricing tier without affecting
  standard pricing for the same model pattern.
- - The ledger shape gains an optional grouping dimension, so UI summaries and
  tests must include tier handling.
- ~ Legacy rows do not infer pricing tiers. They remain untiered and continue to
  use standard/no-tier pricing if lazily enriched.

## References

- [ADR-0069: Estimate usage costs from persisted pricing catalog](0069-estimate-usage-costs-from-persisted-pricing-catalog.md)
- [Usage tracking API spec](../spec-api-endpoints.md)
- [UsagePricingStore spec](../spec-backend-services.md#431-usagepricingstore)
- [Usage ledger data model](../spec-data-models.md)
