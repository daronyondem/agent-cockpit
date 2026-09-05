---
id: 0091
title: Support long context usage pricing
status: Proposed
date: 2026-09-04
supersedes: []
superseded-by: null
tags: [usage, pricing, data-model]
affects:
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-frontend.md
  - docs/spec-testing.md
  - src/contracts/usagePricing.ts
  - src/contracts/responses.ts
  - src/services/usagePricing/catalog.default.json
  - src/services/usagePricing/catalog.ts
  - src/services/usagePricing/providerCalculators.ts
  - src/types/usage.ts
  - test/usagePricing.test.ts
  - test/usagePricingStore.test.ts
  - web/AgentCockpitWeb/src/screens/settingsScreen.jsx
---

## Context

Agent Cockpit estimates API-equivalent dollars from provider token usage through
a release-owned pricing catalog plus user overrides. That worked while one
token-rate table was enough for a model and pricing tier.

GPT-6 Astra adds a long-context pricing threshold: requests above a published
prompt-input token threshold use different input, cached-input, cache-write, and
output rates. Historical estimated usage must still remain stable, overrides
must survive releases, and existing providers that do not have long-context
pricing should not gain extra branching.

## Decision

Usage token pricing entries may carry optional paired long-context fields:
`longContextThresholdTokens` and `longContextRatesPerMillion`.

If either field is present, both are required. The threshold must be positive,
and the long-context rate table follows the same non-negative rate validation as
`ratesPerMillion`. Built-in catalogs and user override requests both enforce
that paired shape.

The OpenAI/Codex provider calculator selects the long-context table when fresh
input plus cache-read plus cache-write tokens are greater than the threshold.
When selected, the long-context table applies to the full estimated request, and
`costSnapshot.ratesPerMillion` stores the applied table. The snapshot records
`longContextThresholdTokens` only when the long-context table was used.

The Usage settings override editor preserves long-context fields returned by
the server across load/save cycles, but it does not expose new table columns for
manual editing in this pass.

## Alternatives Considered

- **Add separate catalog entries for short and long context**. Rejected because
  entry matching currently keys on provider, model pattern, and optional pricing
  tier, not per-request token count. Encoding token thresholds as competing
  entries would make precedence ambiguous.
- **Store both short and long rate tables in every cost snapshot**. Rejected
  because historical estimates need the applied rates and provenance, not every
  alternate rate that was available at pricing time.
- **Hardcode GPT-6 Astra threshold logic in the OpenAI calculator**. Rejected
  because provider calculators should read pricing policy from the catalog so
  future long-context models can be added by catalog update plus focused tests.

## Consequences

- + GPT-6 Astra estimates can match published short-context and long-context
  OpenAI pricing without changing the ledger grouping model.
- + User overrides can represent long-context token pricing without losing those
  fields on save.
- + Historical cost snapshots remain compact and audit the exact rate table used
  for the stored estimate.
- - The pricing contract gains another optional shape that validators, docs, and
  settings preservation code must keep in sync.
- ~ The threshold rule is catalog-driven but currently only the OpenAI/Codex
  token calculator uses it.

## References

- [ADR-0069: Estimate usage costs from persisted pricing catalog](0069-estimate-usage-costs-from-persisted-pricing-catalog.md)
- [ADR-0070: Use provider calculators for usage pricing](0070-use-provider-calculators-for-usage-pricing.md)
- [Usage pricing API spec](../spec-api-endpoints.md#310-usage-statistics)
- [UsagePricingStore spec](../spec-backend-services.md#431-usagepricingstore)
- [Usage ledger data model](../spec-data-models.md#usage-pricing-overrides-datachatusage-pricing-overridesjson)
