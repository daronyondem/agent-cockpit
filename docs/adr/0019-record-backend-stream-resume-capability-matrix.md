---
id: 0019
title: Record backend stream resume capability matrix
status: Accepted
date: 2026-05-02
supersedes: []
superseded-by: null
tags: [streaming, reliability, backends, resume]
affects:
  - src/types/index.ts
  - src/routes/chat.ts
  - src/services/backends/claudeCode.ts
  - src/services/backends/kiro.ts
  - src/services/backends/codex.ts
  - src/services/streamJobSupervisor.ts
  - test/backends.test.ts
  - test/chat.rest.test.ts
  - test/codexBackend.test.ts
  - test/kiroBackend.test.ts
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-frontend.md
  - docs/spec-server-security.md
  - docs/spec-testing.md
---

## Context

ADR-0017 and ADR-0018 made accepted CLI turns durable enough to reconcile after an Agent Cockpit server restart. That recovery path intentionally interrupts leftover work instead of retrying prompts, because replaying or reconnecting to a partially running backend turn can duplicate tool execution.

Issue #248 Phase 3 requires evaluating Claude Code, Kiro, and Codex separately before adding any backend-specific continuation behavior. All three backends have some form of session or thread resume for later turns, but that is weaker than active-turn resume: it restores conversation context for a new turn and does not prove that Cockpit can reattach to the exact in-flight stream after its process loses the iterator.

## Decision

Expose backend resume capabilities in `BackendMetadata` as two explicit questions:

- `activeTurnResume`: whether Cockpit can safely reattach to the exact in-flight backend turn after a Cockpit server restart without resending the prompt.
- `sessionResume`: whether Cockpit can continue later turns from backend-managed session or thread history.

Current built-in backends all report `activeTurnResume: 'unsupported'` and `sessionResume: 'supported'`:

- Claude Code can continue later turns with `--resume`, but that starts a new CLI invocation and does not reattach to a lost process/stdout stream.
- Kiro can continue later turns by persisting its ACP session id and issuing `session/load`, but that does not reattach to the exact already-running `session/prompt` stream after Cockpit restarts.
- Codex can continue later turns by persisting its thread id and issuing `thread/resume`, but that does not reattach to the already-running turn notification iterator after Cockpit restarts.

Persist backend runtime identifiers on durable stream jobs as operational metadata: `externalSessionId`, optional `activeTurnId`, and optional `processId`. `processStream` records `external_session` events both on the active `SessionEntry` and on the durable job, and consumes `backend_runtime` events for additional identifiers without forwarding that internal event to the browser. Current adapters emit `processId` when their local child process is available; Codex records the app-server turn id from the `turn/start` response path, emits it as `backend_runtime.activeTurnId` from that path, and dedupes `turn/started` if the notification is also emitted.

Startup reconciliation remains conservative while all current backends report active-turn resume as unsupported. It appends one durable assistant `streamError` for interrupted leftover jobs and never re-sends accepted prompts automatically.

## Alternatives Considered

- **Treat session resume as active-turn resume**: Rejected because `--resume`, `session/load`, and `thread/resume` restore context for later work, not ownership of an already-running turn. Using them as active recovery would require resending or restarting work and could duplicate tool execution.
- **Keep the matrix only in documentation**: Rejected because route code, tests, settings UI, and future backend work need a typed contract instead of an implicit table.
- **Implement Codex or Kiro reattach immediately**: Rejected because the current adapters do not yet prove a no-duplicate active-turn reattach path. Capturing runtime identifiers is useful groundwork, but it is not sufficient by itself.
- **Automatically retry interrupted prompts on restart**: Rejected because the accepted prompt may already have caused external side effects before Cockpit lost the iterator.

## Consequences

- + Backend metadata now states the recovery boundary explicitly instead of relying on tribal knowledge.
- + Durable jobs can carry backend runtime identifiers needed for diagnostics and future backend-specific resume work.
- + Startup restart reconciliation remains safe by default and preserves the no-auto-retry guarantee.
- - Adding new adapters or test doubles now requires resume capability metadata.
- ~ Active-turn resume is still future work; this phase records capabilities and identifiers without changing interruption behavior.

## References

- ADR-0017: Persist active stream jobs for restart reconciliation.
- ADR-0018: Route stream lifecycle through supervisor.
- GitHub issue #248, Phase 3.
- `docs/spec-api-endpoints.md`
- `docs/spec-backend-services.md`
- `docs/spec-data-models.md`
- `docs/spec-frontend.md`
- `docs/spec-server-security.md`
- `docs/spec-testing.md`
