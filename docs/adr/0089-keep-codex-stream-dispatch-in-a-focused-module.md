---
id: 0089
title: Keep Codex stream dispatch in a focused module
status: Accepted
date: 2026-06-10
supersedes: []
superseded-by: null
tags: [backend, codex, maintainability]
affects:
  - src/services/backends/codex.ts
  - src/services/backends/codexStreamDispatch.ts
  - src/services/backends/codexEvents.ts
  - src/services/backends/codexProtocol.ts
  - src/services/backends/codexProcess.ts
  - AGENTS.md
  - docs/agent-project-memory.md
  - docs/spec-backend-services.md
  - docs/spec-coverage.md
  - docs/spec-testing.md
---

## Context

`src/services/backends/codex.ts` previously owned Codex app-server process
management, hand-typed JSON-RPC protocol shapes, tool and artifact mapping,
usage derivation, model normalization, one-shot `codex exec`, and both chat and
goal stream notification loops in one large adapter file.

Issue #428 split the stable Codex facade into focused sibling modules following
the Claude interactive backend precedent. Phases 1-7 moved leaf helpers and
stateful process/protocol classes. Phase 8 then exposed the highest-risk
remaining duplication: `_createStream` and `_createGoalStream` had nearly the
same notification switch, but goal streams add terminal native-goal handling,
polling, runtime-turn emission gates, and follow-up report-turn state.

Keeping the duplicated switch inside `codex.ts` would preserve locality but
leave future protocol updates vulnerable to updating one stream path and missing
the other. Moving it into a shared module changes an ownership boundary and
therefore needs a short ADR, as requested by issue #428.

## Decision

Keep Codex notification dispatch in
`src/services/backends/codexStreamDispatch.ts`. `codex.ts` remains the public
facade and owns `CodexAdapter` orchestration, stream setup, thread
start/resume/recovery, stale server-request handling, goal polling, and
follow-up report-turn sequencing. The dispatcher owns the shared notification
switch for chat and goal streams.

The dispatcher receives an explicit `CodexNotificationDispatchContext` and
mutates only the per-stream state it is handed: active turn bookkeeping, pending
user input, child-thread mapping, usage dedupe through `CodexProcessEntry`, and
goal-report flags. It imports focused siblings (`codexEvents.ts`,
`codexArtifacts.ts`, `codexUsage.ts`, `codexRuntime.ts`, `codexProtocol.ts`,
and `codexProcess.ts`) and must not import `codex.ts`. Existing external
imports continue to use `src/services/backends/codex` because the facade
re-exports the compatibility helpers tested by `test/codexBackend.test.ts`.

## Alternatives Considered

- **Leave both notification switches in `codex.ts`**: Rejected because it keeps
  the most protocol-sensitive duplicated logic in place after the rest of the
  adapter split, making future app-server drift fixes more error-prone.
- **Extract private in-file helpers only**: Rejected because it reduced
  duplication but still left `codex.ts` above the target size and made the
  facade responsible for detailed notification mapping rather than orchestration.
- **Create a generic backend stream dispatcher**: Rejected because Codex
  notification ownership, child-thread demux, native goal terminal states, and
  usage dedupe are app-server-specific. A cross-backend abstraction would hide
  provider behavior instead of clarifying it.

## Consequences

- + Chat and goal streams share one notification switch, so Codex protocol drift
  and ownership fixes apply to both paths.
- + `codex.ts` stays a stable public facade and orchestration layer while meeting
  the maintainability size target from issue #428.
- + The import graph remains acyclic: the facade imports siblings, and siblings
  never import the facade.
- - Stream state mutation now crosses a module boundary, so dispatcher inputs
  must stay explicit and covered by `test/codexBackend.test.ts` behavior tests.
- ~ Codex protocol drift review now includes `codexStreamDispatch.ts` for
  behavioral assumptions even though wire-shaped interfaces remain in the
  focused protocol, event, and model modules.

## References

- Refs #428.
- [ADR-0032: Use Codex thread goals for goal mode](0032-use-codex-thread-goals-for-goal-mode.md)
- [ADR-0055: Own Codex app-server events by turn](0055-own-codex-app-server-events-by-turn.md)
- [ADR-0062: Default Codex to full local access](0062-default-codex-to-full-local-access.md)
- [Backend Services spec](../spec-backend-services.md)
