---
id: 0029
title: Schedule knowledge base auto-dream per workspace
status: Proposed
date: 2026-05-05
supersedes: []
superseded-by: null
tags: [knowledge-base, scheduling, workspace-settings]
affects:
  - src/types/index.ts
  - src/services/knowledgeBase/autoDream.ts
  - src/services/knowledgeBase/dream.ts
  - src/services/chatService.ts
  - src/routes/chat.ts
  - server.ts
  - public/v2/src/api.js
  - public/v2/src/screens/kbBrowser.jsx
  - public/v2/src/app.css
  - docs/spec-data-models.md
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-frontend.md
  - docs/spec-testing.md
  - test/knowledgeBase.autoDream.test.ts
  - test/knowledgeBase.dream.test.ts
  - test/chatService.workspace.test.ts
  - test/chat.kb.test.ts
---

## Context

Knowledge Base dreaming can become stale as users ingest and digest new files. A manual Dream button is enough for one-off cleanup, but it does not cover workspaces that should synthesize their KB continuously or during quiet hours.

The schedule must be workspace-scoped because KB state, pending synthesis flags, and workspace folders are all workspace-scoped. A global Auto-Dream toggle would either run the wrong workspaces or force users to compromise between unrelated projects.

Dreaming already has cooperative stop and incremental continuation semantics. It does not have persisted mid-batch checkpoints, and adding them would be a larger durability design than the scheduling issue needs.

## Decision

Auto-Dream configuration is stored on each `WorkspaceIndex` as `kbAutoDream`, normalized to `{ mode: 'off' }` when absent. Users choose exactly one mode per workspace:

- **Off**: no scheduled dreaming.
- **Interval**: run incremental dreaming every `intervalHours` when pending synthesis exists.
- **Window**: run incremental dreaming only while local server time is inside `[windowStart, windowEnd)`, including overnight windows.

The scheduler is a server-side service that starts after `ChatService.initialize()`, scans KB-enabled workspaces every 60 seconds, and calls the existing incremental `dream(hash)` path. It never starts a second dream while one is already running for the workspace. In interval mode, an in-progress dream simply continues through the next due interval. In window mode, the scheduler requests a cooperative stop when the window closes, but only for runs it started; manual dreams are not stopped by the schedule.

The continuation model stays incremental rather than checkpointed. Already-committed batches clear `needs_synthesis`; unprocessed or failed work keeps `needs_synthesis = 1`; the next scheduled dream picks up those entries. The UI surfaces the caveat that a window end requests a cooperative stop, and an in-flight model call can finish before the run pauses.

## Alternatives Considered

- **Global Auto-Dream setting**: Rejected because KBs are per workspace and users need different timing per project.
- **Interval-only schedule**: Rejected because quiet-hours operation requires a time window such as 2 AM to 6 AM.
- **Window-only schedule**: Rejected because some users want simple "every N hours" operation without caring about a daily window.
- **Persisted dream checkpoints**: Rejected for this issue because existing committed-batch continuation already provides the resume behavior needed for scheduled stops. True checkpointing would add a separate recovery model and storage contract.

## Consequences

- + Users can tune Auto-Dream independently per workspace.
- + Interval mode avoids overlapping runs by treating a currently running dream as the active cycle.
- + Window mode can keep expensive synthesis inside a preferred time range.
- - Window stops are cooperative, so stop latency is bounded by the current in-flight CLI/model call.
- ~ Scheduled continuation depends on `needs_synthesis` rather than a persisted mid-run checkpoint.

## References

- Issue #124
- [Data Models spec](../spec-data-models.md)
- [API Endpoints spec](../spec-api-endpoints.md)
- [Backend Services spec](../spec-backend-services.md)
- [Frontend spec](../spec-frontend.md)
