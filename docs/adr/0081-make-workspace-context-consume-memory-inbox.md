---
id: 0081
title: Make Workspace Context consume Memory inbox
status: Accepted
date: 2026-05-29
supersedes: [0042, 0043]
superseded-by: null
tags: [memory, workspace-context, governance]
affects:
  - src/services/workspaceContext/service.ts
  - src/routes/chat/memoryRoutes.ts
  - src/services/memoryMcp/index.ts
  - src/services/chatService.ts
  - src/services/chat/workspaceMemoryStore.ts
  - src/contracts/streamFrames.ts
  - src/types/index.ts
  - web/AgentCockpitWeb/src/workspaceSettings.jsx
  - web/AgentCockpitWeb/src/appShell.jsx
  - web/AgentCockpitWeb/src/chat/composerNotifications.jsx
  - docs/spec-workspace-context.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-api-endpoints.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
  - docs/spec-testing.md
  - docs/spec-coverage.md
  - docs/agent-project-memory.md
  - docs/user/memory.md
  - AGENTS.md
---

## Context

Agent Cockpit had two durable workspace-memory systems with overlapping
responsibilities:

- **Memory** stored atomic notes and captured CLI memory entries under
  `memory/files/`. It supported search, lifecycle metadata, governed writes, and
  manual consolidation endpoints.
- **Workspace Context** stored workspace-owned markdown under
  `workspace-context/context/`. It already performed better as visible durable
  project context because it created organized files that users and agents could
  inspect directly.

The scheduled/manual Memory Review workflow added another layer: persisted
review runs, schedule state, composer notifications, a dedicated review page, and
human apply/discard decisions. Empirical review of the `Daron-Life-General`
workspace showed this imposed a manual-review burden the user did not perform,
while Workspace Context and repo-local context captured more useful durable
state. The product direction is to keep Memory for atomic capture/search, make
Workspace Context the canonical visible workspace memory, and remove the manual
Memory Review user workflow.

## Decision

Workspace Context maintenance consumes the Memory inbox.

When Workspace Context maintenance builds its source plan, it includes active
Memory entries from `memory/files/` as memory-inbox inputs when Memory is enabled
for the workspace. The processor prompt tells the CLI to decide which entries
were incorporated into Workspace Context and to return a single
`workspace-context-memory-actions` JSON block containing `acceptedMemoryFiles`.
The server validates that block against the planned Memory inputs. Accepted
entries are deleted from Memory after the Workspace Context run succeeds; they
are not kept for later manual review. For CLI-captured Memory entries, deletion
also records a hidden deleted tombstone so a future native-memory recapture does
not resurrect an entry already consumed by Workspace Context. The run summary
records how many Memory entries were consumed, and a refresh-only
`memory_update` frame tells open Memory tabs to refetch.

Workspace Context maintenance is the background cleanup path. Memory Review
scheduled/manual generation, review-run persistence, `memory_review_update`
browser frames, the dedicated Memory Review page, the composer Memory Review
notification, and Workspace Settings schedule/start/audit controls are removed.
Former `/memory/review-schedule` and `/memory/reviews/*` endpoints return `410`
with a message that Workspace Context maintenance now consumes accepted Memory
entries automatically.

Low-level Memory search, delete, restore, and consolidation endpoints remain.
They are not exposed as a user-facing manual review workflow in the desktop app;
they remain governed server-side utilities around the Memory inbox.

Workspace Context maintenance scheduling is based only on
`lastMaintenanceCompletedAt`. Recent scan completion no longer suppresses
maintenance, so active workspaces still receive pruning and Memory-inbox cleanup.

## Alternatives Considered

- **Keep scheduled/manual Memory Review**: Rejected because it duplicates
  Workspace Context curation and depends on the user repeatedly reviewing
  generated drafts. In practice this added stale pending state rather than
  improving durable context.
- **Merge Memory and Workspace Context into one UI/concept**: Rejected because
  Memory still has a useful atomic capture/search role. The distinction remains:
  Memory is the inbox and retrieval layer; Workspace Context is the canonical
  visible durable context.
- **Have Workspace Context copy accepted Memory entries but leave originals in
  Memory**: Rejected because it preserves stale overlap and recreates the manual
  cleanup burden. Accepted entries should be deleted to keep Memory clean.
- **Let the Workspace Context processor delete Memory files directly**:
  Rejected because server-side validation must retain path safety, lifecycle
  behavior, tombstone handling, and websocket refresh semantics.

## Consequences

- + Workspace Context becomes the single durable curation surface users can
  inspect directly.
- + Memory entries can still be captured atomically, searched, and injected, but
  accepted entries drain automatically into Workspace Context.
- + The product no longer asks users to operate a separate Memory Review page or
  review schedule.
- + Frequent Workspace Context scans no longer starve maintenance/pruning.
- - Existing persisted `memory/reviews/*.json` and
  `WorkspaceIndex.memoryReviewSchedule` data become legacy data. They are not
  loaded by current UI/API paths.
- - Workspace Context maintenance quality now determines which Memory entries
  are deleted from the inbox, so missing or malformed action blocks fail the run
  visibly rather than silently deleting anything.
- ~ Manual Memory consolidation REST endpoints remain for governed low-level
  operations, but desktop UI helpers for that review flow are removed.

## References

- [ADR-0068: Replace Context Map with Workspace Context markdown](0068-replace-context-map-with-workspace-context-markdown.md)
- [ADR-0041: Apply memory consolidation drafts](0041-apply-memory-consolidation-drafts.md)
- [ADR-0042: Schedule memory review runs](0042-schedule-memory-review-runs.md)
- [ADR-0043: Start Memory Reviews asynchronously](0043-start-memory-reviews-asynchronously.md)
- [Workspace Context specification](../spec-workspace-context.md)
- [Workspace Memory backend services](../spec-backend-services.md)
- [Memory and Workspace Context API endpoints](../spec-api-endpoints.md)
