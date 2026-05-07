---
id: 0043
title: Start Memory Reviews asynchronously
status: Proposed
date: 2026-05-07
supersedes: []
superseded-by: null
tags: [memory, api, frontend]
affects:
  - src/routes/chat.ts
  - src/services/memoryMcp/index.ts
  - public/v2/src/screens/memoryReview.jsx
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-frontend.md
---

## Context

Manual Memory Review generation can take several minutes because it asks the configured Memory CLI to audit up to 50 memory entries and may then draft exact merge/split/normalize operations. The previous manual start endpoint kept the HTTP request open until all proposal and draft work finished. That made successful generations vulnerable to browser, reverse proxy, or CDN request limits and could surface as HTTP 524 even when the server eventually persisted a usable review.

The UI already has a durable review page that can load a persisted run and poll while `status === 'running'`, so the user workflow does not require the start request itself to block until generation completes.

## Decision

Manual Memory Review start requests persist a new `running` review run, emit the usual review update event, start proposal/draft generation in the background, and return `202` immediately with the persisted run and compact status.

The Memory Review service exposes separate entry points for the two call patterns:

- `startMemoryReviewRun()` starts generation and returns the current persisted run immediately for HTTP callers.
- `createMemoryReviewRun()` uses the same start path but awaits completion for scheduler and worker callers that need the final run object.

The dedicated Memory Review page remains responsible for showing in-progress generation and polling the run until it becomes `pending_review`, `completed`, or `failed`.

## Alternatives Considered

- **Keep the manual endpoint synchronous and only raise CLI timeouts**: rejected because longer child-process timeouts do not address HTTP/proxy request limits.
- **Increase proxy/browser request limits**: rejected because the application should not depend on deployment-specific timeout tuning for a durable background workflow.
- **Move all review generation to a separate queue worker**: rejected for now because the existing in-process scheduler and persisted run files already provide enough durability for this workflow.

## Consequences

- + Manual review starts return quickly and no longer fail the user interaction solely because generation outlives the HTTP request.
- + The same persisted run file is used by manual starts, scheduled starts, websocket updates, and review-page polling.
- - Background generation failures can no longer be returned directly by the already-completed POST response; they must be persisted on the run and shown by polling or websocket update.
- ~ Callers must choose the service entry point that matches their workflow: immediate persisted start vs. awaited completion.

## References

- [ADR-0042: Schedule Memory Review runs](0042-schedule-memory-review-runs.md)
- [API endpoint specification](../spec-api-endpoints.md)
- [Backend service specification](../spec-backend-services.md)
- [Frontend specification](../spec-frontend.md)
