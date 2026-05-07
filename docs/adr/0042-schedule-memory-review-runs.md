---
id: 0042
title: Schedule memory review runs
status: Proposed
date: 2026-05-07
supersedes: []
superseded-by: null
tags: [memory, scheduling, governance]
affects:
  - src/types/index.ts
  - src/services/chatService.ts
  - src/services/memoryMcp/index.ts
  - src/services/memoryReview.ts
  - src/routes/chat.ts
  - server.ts
  - public/v2/src/api.js
  - public/v2/src/screens/memoryReview.jsx
  - public/v2/src/workspaceSettings.jsx
  - public/v2/src/shell.jsx
  - public/v2/src/streamStore.js
  - public/v2/src/app.css
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-api-endpoints.md
  - docs/spec-frontend.md
  - docs/spec-testing.md
  - test/chat.memory.test.ts
  - test/frontendRoutes.test.ts
  - test/memoryReview.test.ts
  - test/streamStore.test.ts
---

## Context

ADR-0040 and ADR-0041 made memory consolidation reviewable, but the workflow was still pull-only: the user had to remember to open Workspace Settings, go to the Memory tab, run consolidation, and handle any generated drafts immediately. That is poor ergonomics for maintenance work that is most useful when it runs periodically in the background and waits for a human decision.

The constraints from the earlier Memory decisions still apply:

- The Memory CLI may propose and draft changes, but the server must retain write authority.
- Generated drafts must survive server restarts and page reloads until the user applies or discards them.
- The composer is already the app's lightweight notification area for workspace-scoped attention items.
- Scheduled work must not silently rewrite memory files or apply metadata changes.

## Decision

Add **Memory Review** as a durable, scheduled review-run workflow.

Each workspace gets `WorkspaceIndex.memoryReviewSchedule`, normalized as either `{ mode: 'off' }` or a `window` schedule with day selection, `windowStart`, `windowEnd`, and optional IANA `timezone`. Changing the normalized schedule refreshes `WorkspaceIndex.memoryReviewScheduleUpdatedAt`, which resets scheduled-run guards without deleting historical review runs. `MemoryReviewScheduler` starts with the server, scans memory-enabled workspaces, and starts at most one scheduled run per active window when memory has changed since the newest scheduled run for the current schedule version, no run is already active, and no review is pending. The per-window guard is derived from persisted scheduled-run history so it survives server restarts.

Review runs are persisted under `memory/reviews/<runId>.json`. A run stores source fingerprints, the original proposal, metadata-only safe action items, draft rewrite items, failures, status, source (`manual` or `scheduled`), and timestamps. Manual **Start new review** uses the same run model, retires existing actionable runs before generating a fresh one, and opens the same review page. Scheduled runs never apply anything by themselves.

The composer receives a workspace-scoped `memory_review_update` WebSocket frame with a compact `ConversationMemoryReviewStatus`. When there are pending items, the composer shows a **Memory Review** notification. Its popover has only a **Review** action, which opens the dedicated Memory Review page. The review page renders safe metadata actions and generated draft diffs, then lets the user apply, discard, or regenerate individual items. Workspace Settings uses the same status payload to show the newest run time and whether it was triggered manually or by the schedule.

Workspace Settings keeps the Memory enable toggle, schedule controls, memory search/browser, **Start new review**, **Audit Current Review**, and destructive clear/delete controls. Inline consolidation review UI is no longer the primary action surface.

## Alternatives Considered

- **Keep consolidation entirely manual in Workspace Settings**: Rejected because it makes periodic memory maintenance depend on user memory and hides pending drafts deep inside settings.
- **Let scheduled runs apply safe actions automatically**: Rejected because even metadata-only supersession changes affect recall and should remain explicitly reviewable until trust is built.
- **Store pending drafts only in browser state**: Rejected because scheduled runs happen without the review page open, and drafts need to survive reloads/restarts.
- **Use a chat message as the notification**: Rejected because scheduled maintenance is workspace state, not conversation transcript content. The composer notification area is the established lightweight attention surface.

## Consequences

- + Memory maintenance can happen overnight or during any configured quiet window without automatically changing memory.
- + Pending drafts and safe actions are durable and can be reviewed from any conversation in the same workspace.
- + Manual and scheduled runs share one backend workflow and one review page.
- - Memory Review introduces a new persisted run format that future migrations must account for.
- - Scheduled review generation still depends on the configured Memory CLI profile and may fail until that dependency is configured.
- ~ This schedules proposal/draft generation only; semantic candidate discovery and embeddings remain future Memory work.

## References

- Issue #276 - Memory v2: lifecycle, governed writes, and searchable recall
- ADR-0040 - Consolidate workspace memory manually
- ADR-0041 - Apply memory consolidation drafts
- `docs/spec-backend-services.md` - Workspace Memory / Memory MCP Server / Memory Review Scheduler
- `docs/spec-data-models.md` - Workspace Memory Store
- `docs/spec-api-endpoints.md` - Workspace Instructions / Memory endpoints
- `docs/spec-frontend.md` - Workspace Settings Memory tab / Memory Review page
