---
id: 0069
title: Estimate usage costs from persisted pricing catalog
status: Accepted
date: 2026-05-20
supersedes: []
superseded-by: null
tags: [usage, pricing, data-model, settings]
affects:
  - src/contracts/usagePricing.ts
  - src/services/usagePricing/catalog.default.json
  - src/services/usagePricing/catalog.ts
  - src/services/usagePricing/estimator.ts
  - src/services/usagePricing/store.ts
  - src/services/chat/usageLedgerStore.ts
  - src/services/chatService.ts
  - src/routes/chat/statusRoutes.ts
  - web/AgentCockpitWeb/src/api.js
  - web/AgentCockpitWeb/src/screens/settingsScreen.jsx
  - mobile/AgentCockpitPWA/src/App.tsx
  - docs/spec-data-models.md
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
  - docs/spec-testing.md
  - test/usagePricing.test.ts
  - test/usagePricingStore.test.ts
  - test/chat.usageLedgerStore.test.ts
---

## Context

Agent Cockpit's Usage settings previously displayed provider-reported `costUsd`
only. That works for direct API-style providers that emit nonzero spend, but it
leaves subscription CLI usage blank: Codex and Kiro usually report tokens,
context, or credits without per-turn dollars, and Claude Code only reports
`cost_usd` when the CLI/transcript provides it.

Users still need a useful Usage view for subscription plans. The value must be
clearly labeled as an estimate, must not overwrite actual provider-reported
spend, and must remain historically stable when provider token prices change.
The system also needs a release-owned default catalog that can be reviewed
before shipping while allowing local user overrides to survive releases.

## Decision

Use a persisted pricing catalog to estimate API-equivalent dollars for
subscription CLI usage.

Release-owned defaults live in
`src/services/usagePricing/catalog.default.json`. The JSON catalog is validated
on import and carries source URL, verification date, effective date, provider,
model pattern, unit (`tokens` or `credits`), and the rates used. Before each
release that changes the catalog, maintainers verify defaults against official
provider pricing pages and update only this checked-in JSON.

Mutable user overrides live in
`data/chat/usage-pricing-overrides.json`. Overrides are stored outside the repo,
replace the full override catalog on save, and take precedence over built-ins in
the effective catalog. A later release must not overwrite user overrides; the
user must clear or edit them explicitly.

The estimator preserves provider truth first: any usage with `costUsd > 0` is
`Cost` and `costSource: "reported"`. Usage with tokens or credits and a matching
pricing entry receives `estimatedCostUsd`, `costSource: "estimated"`, and a
`costSnapshot` containing the catalog version, entry id, rates, provider/model,
source URL, and price dates. Existing estimated rows are not recalculated.

The UI presents the labels separately: **Cost** for provider-reported dollars
and **Estimated Cost** for computed fallback dollars. Aggregates may show their
combined spend as the headline number, but the split remains visible.

## Alternatives Considered

- **Provider-reported only**: Keep showing `costUsd` and accept blank cost views
  for subscription CLIs. Rejected because the Usage view then fails for the
  dominant local-CLI subscription workflow.
- **Fetch provider prices at runtime**: Scrape or call provider sites from the
  running app. Rejected because provider pricing pages are not a stable runtime
  API, network access may be unavailable, and automatic changes would silently
  rewrite historical estimates unless every lookup were snapshotted anyway.
- **Settings-only user-entered rates**: Require every user to fill in pricing
  before estimates work. Rejected because default estimates should work out of
  the box, while overrides remain necessary for custom contracts or stale
  release defaults.
- **Recompute estimates on read**: Store only tokens/credits and calculate cost
  each time Usage loads. Rejected because future price changes would alter
  historical charts and make old usage impossible to audit.

## Consequences

- + Subscription CLI usage gets useful dollar-equivalent reporting without
  pretending estimates are provider bills.
- + Historical rows remain stable because every estimate stores the computed
  amount and pricing snapshot.
- + Releases can refresh built-in defaults while preserving user override files.
- + Provider-reported nonzero dollars remain authoritative.
- - Maintainers must manually verify catalog defaults before releases that touch
  the pricing JSON.
- - Estimates can still be wrong for unknown, newly renamed, or contract-priced
  models until the built-in catalog or user overrides are updated.
- ~ The repo intentionally stores source URLs and verification dates, not a
  provider-pricing synchronization system.

## References

- [OpenAI API pricing](https://openai.com/api/pricing/)
- [Anthropic Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Kiro pricing](https://kiro.dev/pricing/)
- [Data models spec](../spec-data-models.md#usage-pricing-overrides-datachatusage-pricing-overridesjson)
- [API endpoints spec](../spec-api-endpoints.md#32-chat-status-and-settings)
- [Backend services spec](../spec-backend-services.md#431-usagepricingstore)
- [Frontend spec](../spec-frontend.md)
