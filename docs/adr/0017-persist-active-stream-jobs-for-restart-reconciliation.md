---
id: 0017
title: Persist active stream jobs for restart reconciliation
status: Accepted
date: 2026-05-02
supersedes: []
superseded-by: null
tags: [streaming, reliability, restart, cli-lifecycle]
affects:
  - server.ts
  - src/routes/chat.ts
  - src/services/streamJobRegistry.ts
  - src/types/index.ts
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

ADR-0016 made accepted CLI turns independent of browser WebSocket lifetime, but it still kept active turn ownership in process memory. If the Agent Cockpit server restarted while a CLI turn was accepted, preparing, running, aborting, or finalizing, the router lost `activeStreams`, pending-send state, and replay buffers. The browser could only recover from already-persisted messages, and retrying the same user prompt would risk duplicating tool side effects.

The current backends do not expose a proven safe way to reattach to a partially running turn across a cockpit server restart. Claude Code, Codex, and Kiro can resume later session context in different ways, but that is not the same as reconnecting to the exact in-flight stream without re-sending the prompt.

## Decision

The chat router persists every accepted message turn in a durable stream-job registry at `data/chat/stream-jobs.json`.

The registry records the conversation, session, user message once available, backend/profile/model/effort, working directory, timestamps, state, abort request, and terminal-error metadata. The first implemented lifecycle is:

`accepted -> preparing -> running -> abort_requested -> finalizing`

Terminal jobs are cleared from the registry after the durable transcript is authoritative. The transcript, not the job file, is the long-term record of completion or interruption.

On server startup, after `ChatService.initialize()` rebuilds workspace lookup maps and before the HTTP server starts listening, the router reconciles any leftover active jobs. Because backend-specific active reattach is not yet proven safe, startup reconciliation does not retry prompts. If the original user message exists, it appends one durable assistant `streamError` message:

`Interrupted by server restart` with `source: 'server'`

If an abort or terminal error was already recorded on the job, reconciliation persists that terminal reason instead. If the matching terminal stream-error message already exists, reconciliation removes the stale job without duplicating the transcript marker.

`GET /active-streams` merges runtime `activeStreams` entries with durable active jobs so accepted/preparing jobs are visible before a backend stream object exists.

## Alternatives Considered

- **Retry prompts after restart**: Rejected because prompts can run tools, mutate files, or call external systems. Automatically replaying the same user message can duplicate side effects.
- **Persist WebSocket replay buffers**: Rejected for this phase because replay buffers are transport recovery data. They do not supervise backend work and cannot recreate a lost async iterator after process restart.
- **Implement backend reattach first**: Rejected because each backend has different process/session semantics. A conservative durable interruption is safer than claiming resume support before it is proven per backend.
- **Store jobs inside workspace indexes**: Rejected because active stream ownership is process-wide operational state, not workspace domain state. A single registry avoids touching every workspace index during startup reconciliation.

## Consequences

- + Accepted turns no longer disappear silently across server restarts.
- + Restart reconciliation unsticks the UI through durable server truth without browser participation.
- + The server records an interruption marker without re-sending prompts or duplicating tools.
- + The pre-stream setup window is modeled explicitly instead of depending only on an in-memory pending map.
- - Partial output that was only in memory and not yet persisted as an assistant message can still be lost on server restart.
- - Active backend reattach remains future work and must be designed separately for Claude Code, Codex, and Kiro.
- ~ Terminal jobs are removed from the registry once transcript state is durable, so the registry is an active-job file rather than an audit log.

## References

- Extends ADR-0016 by replacing its restart limitation with durable interruption reconciliation.
- GitHub issue #248.
- `docs/spec-api-endpoints.md`
- `docs/spec-backend-services.md`
- `docs/spec-data-models.md`
- `docs/spec-frontend.md`
- `docs/spec-server-security.md`
- `docs/spec-testing.md`
