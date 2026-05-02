---
id: 0018
title: Route stream lifecycle through supervisor
status: Accepted
date: 2026-05-02
supersedes: []
superseded-by: null
tags: [streaming, reliability, cli-lifecycle, shutdown]
affects:
  - server.ts
  - src/routes/chat.ts
  - src/services/streamJobRegistry.ts
  - src/services/streamJobSupervisor.ts
  - test/chat.rest.test.ts
  - test/helpers/chatEnv.ts
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-frontend.md
  - docs/spec-server-security.md
  - docs/spec-testing.md
---

## Context

ADR-0017 introduced a durable stream-job registry so accepted CLI turns survive a server-process restart as recoverable operational state. The first implementation deliberately kept the route-level runtime maps (`activeStreams` and pending message sends) as the operational attachment points, with registry calls placed at each route branch that created, aborted, completed, archived, deleted, or reconciled a job.

That solved restart reconciliation, but it left job lifecycle ownership split across the router. Future backend-specific resume work needs a clearer boundary: the durable registry should remain the persisted source of active-job truth, while runtime attachments should be treated as process-local handles for jobs the current process can still drive.

## Decision

Introduce `StreamJobSupervisor` as the chat router's runtime owner for active CLI turns. The supervisor owns:

- the durable `StreamJobRegistry`
- the process-local `activeStreams` map
- the process-local pending-send map for accepted/preparing turns before a backend iterator exists
- state transitions for accepted, preparing, running, abort-requested, finalizing, and completed/deleted jobs
- runtime cleanup for archive/delete paths
- graceful-shutdown marking for active jobs

`activeStreams` remains available to WebSocket code as a runtime attachment map, but it is no longer the only place the router reasons about an active turn. The router goes through the supervisor for message acceptance, pending aborts, runtime aborts, active stream attachment/detachment, archive/delete cleanup, completion, and shutdown preparation.

Graceful shutdown marks attached and pending jobs `finalizing` with `Interrupted by server shutdown` (`source:'server'`) before aborting runtime streams and clearing process-local maps. The job is intentionally left in `stream-jobs.json`; startup reconciliation then persists the terminal `streamError` exactly once if the accepted user message exists. Planned update/restart endpoints still refuse to run while turns are in flight, so this shutdown path is for external signals and unexpected process-manager stops.

`GET /active-streams` continues to merge durable jobs with runtime attachments and now exposes `runtimeAttached` and `pending` booleans for each stream summary so operators can distinguish a durable accepted/preparing job from a running backend iterator in the current process.

## Alternatives Considered

- **Keep registry calls inline in `chat.ts`**: Rejected because the route was becoming the owner of both HTTP behavior and stream lifecycle state transitions. That makes future resume support and shutdown handling harder to verify.
- **Move all stream processing into the supervisor now**: Rejected for this phase because `processStream` still owns detailed transcript persistence, title updates, usage frames, memory watching, and WebSocket emission. Moving that at the same time would create a large behavioral refactor without improving the Phase 2 lifecycle goal.
- **Persist a terminal stream error during graceful shutdown immediately**: Rejected because shutdown has a short deadline and may be interrupted. Marking the durable job finalizing and letting startup reconciliation persist the transcript keeps the recovery path idempotent and shared with restart recovery.

## Consequences

- + Job lifecycle operations have one runtime owner instead of scattered registry mutations.
- + Archive/delete cleanup uses the same supervisor path to abort runtime handles and remove durable active jobs.
- + Graceful external shutdown leaves durable finalizing jobs for startup reconciliation instead of silently dropping active work.
- + `/active-streams` can show whether a job is only durable, pending setup, or attached to a runtime iterator.
- - The supervisor still does not reattach to backend processes after restart; backend-specific resume remains future work.
- ~ `processStream` still owns transcript persistence and terminal frame emission. The supervisor owns lifecycle state, not message rendering or stream parsing.

## References

- Extends ADR-0017.
- GitHub issue #248, Phase 2.
- `docs/spec-api-endpoints.md`
- `docs/spec-backend-services.md`
- `docs/spec-data-models.md`
- `docs/spec-frontend.md`
- `docs/spec-server-security.md`
- `docs/spec-testing.md`
