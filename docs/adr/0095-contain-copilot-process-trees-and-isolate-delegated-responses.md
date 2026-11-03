---
id: 0095
title: Contain Copilot process trees and isolate delegated responses
status: Superseded
date: 2026-10-29
supersedes: [0094]
superseded-by: 0096
tags: [backends, copilot, lifecycle, protocol, testing]
affects:
  - src/services/backends/copilot.ts
  - src/services/backends/copilotProcess.ts
  - src/services/backends/base.ts
  - src/services/backends/registry.ts
  - src/routes/chat/conversationRoutes.ts
  - server.ts
  - test/copilotProcess.test.ts
  - test/copilotOwnership.test.ts
  - docs/spec-backend-services.md
---

## Context

Review exposed two native-contract errors: npm starts a separate native child,
so killing the launcher does not stop work or close inherited pipes; native
delegation emits child messages into the same JSONL stream, so ignoring event
ownership contaminates root prose and structured responses.

## Decision

Retain the per-turn JSONL/shared-auth adapter from ADR-0094. Own its complete
process tree in a focused Copilot module, with PID/start identity tracking,
TERM/KILL escalation, bounded Windows tree termination, and awaited pipe cleanup.
Use the same path for abort, timeout, iterator close, reset, and reusable shutdown.
Validate real wrapper/child topologies, not only mocked `kill()` callbacks.
Keep still-live tracked children as discovery roots after launcher exit. Let
adapter lifecycle hooks return cleanup promises, await them in reset callers and
the registry, and await registry shutdown before server exit or updater reuse.
Retain the owned group after leader exit. Block work admission during cleanup;
server exit permanently closes Copilot while updates preserve later reuse.
Retain observed child-led groups too, and mark active one-shots cancelled before
termination so a clean launcher exit cannot accept incomplete output.

Suppress child/grandchild text, reasoning, and tool presentation until grouped
child UI exists. Keep session usage independent and count hidden child work for
the no-replay guard. Do not clear root one-shot output on late child tools.

Preserve the deliberately smaller initial product scope: interactive controls,
guided/isolated account setup, quotas/context occupancy, and comprehensive
workflow/browser parity remain follow-ups. Native Copilot has related features;
the deferred part is Cockpit integration. Make media capability claims per
verified explicit model; auto and unknown capabilities fail eligibility closed.

## Alternatives Considered

- **Root-only termination:** rejected because npm wrappers leave native work alive.
- **Merge child text into the root stream:** rejected because JSON processors and
  parent answers require ownership isolation even without grouped child UI.
- **Claim all models support media from one auto-routed smoke test:** rejected
  because routing/account/policy can change the selected model.

## Consequences

- + Stop decisions terminate bounded owned work and preserve unrelated processes.
- + Root structured outputs remain valid when native delegation occurs.
- - Native process/transcript contracts still require compatibility validation.
- ~ Conservative media gating can hide native capabilities until verified.

## References

- [ADR-0094](0094-validate-copilot-jsonl-contracts-against-the-native-cli.md).
- [Backend specification](../spec-backend-services.md#copilotadapter-srcservicesbackendscopilotts).
- PR #571 review of process containment, response ownership, and evidence scope.
