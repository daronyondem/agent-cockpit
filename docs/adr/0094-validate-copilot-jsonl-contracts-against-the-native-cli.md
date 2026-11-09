---
id: 0094
title: Validate Copilot JSONL contracts against the native CLI
status: Superseded
date: 2026-10-26
supersedes: [0093]
superseded-by: 0095
tags: [backends, copilot, usage, testing]
affects:
  - src/services/backends/copilot.ts
  - src/services/backends/copilotUsage.ts
  - src/services/cliCommandResolver.ts
  - test/copilotBackend.test.ts
  - test/copilotUsage.test.ts
  - test/copilotBackend.e2e.test.ts
  - docs/spec-backend-services.md
  - AGENTS.md
---

## Context

The initial Copilot adapter followed a mocked JSONL contract. Native Copilot
1.0.103-0 showed that permitting tools is not a no-tool mode, completion events
omit tool names, and token/premium-request checkpoints are cumulative across
resumed sessions. Older curated model identifiers also become unavailable.
These details affect every feature using the adapter, including Memory,
Knowledge Base, desktop, and mobile.

## Decision

Keep the per-turn CLI transport and shared-login profile model from ADR-0093.
Explicitly enable streaming, disable implicit CLI updates, and use the literal
`--available-tools none` for restricted one-shots. Translate structured failures,
preserve UTF-8 decoding, retain tool names by call ID, and handle cancellation
before spawning and while collecting output.

Keep native usage parsing and baseline reads in `copilotUsage.ts`. Before
resuming, read the last saved native checkpoint from a bounded transcript tail;
subtract it from the final checkpoint to emit disjoint per-turn token and
premium-request counters, including after server restarts. Log missing or
unusable baselines and omit uncertain cumulative charges instead of guessing.
Keep USD pricing unavailable.

Default the curated model catalog to `auto`, refresh explicit identifiers from
`copilot help config`, and omit effort for auto/Haiku. Prefer the npm
`npm-loader.js` entrypoint through the shared Windows Node resolver.
Maintain unit regressions plus an opt-in real-CLI round-trip suite.

## Alternatives Considered

- **Keep mocked shapes as the compatibility source:** rejected because passing
  tests did not detect native permission and cumulative-accounting differences.
- **Cache usage baselines only in memory:** rejected because the first resumed
  turn after a server restart would recharge prior usage.
- **Treat empty tool filters as zero tools:** rejected by a native probe;
  the literal `none` filter exposes zero tools while an empty value does not.

## Consequences

- + Text-only orchestration no longer exposes execution tools.
- + Native session resume preserves accurate per-turn tokens and credits.
- - Baseline accounting depends on private native transcript/checkpoint shapes.
- ~ Native compatibility evidence covers macOS arm64; Windows resolver unit
  tests do not establish native Windows/Linux support.

## References

- [ADR-0093](0093-add-github-copilot-cli-backend.md), superseded.
- [Backend services](../spec-backend-services.md#copilotadapter-srcservicesbackendscopilotts).
- `copilot --help`, `copilot help permissions`, `copilot help config`.
- `npm run e2e:copilot`.
