---
id: 0034
title: Persist live KB chunk progress
status: Accepted
date: 2026-05-06
supersedes: []
superseded-by: null
tags:
  - knowledge-base
  - pipeline
  - progress
affects:
  - src/types/index.ts
  - src/services/knowledgeBase/db.ts
  - src/services/knowledgeBase/digest.ts
  - public/v2/src/screens/kbBrowser.jsx
  - docs/spec-data-models.md
  - docs/spec-backend-services.md
  - docs/spec-api-endpoints.md
  - docs/spec-frontend.md
  - docs/spec-testing.md
---

## Context

The Pipeline view has a Digest-stage **Chunk** node, but before this decision it was backed by `counters.entrySourceCount`. That counter is durable source lineage from `kb_entry_sources`, so it only increases after digestion has parsed entries and committed them to the DB.

That made an active digestion session look backwards: the UI could show `Digest 0/5 active` while `Chunk 0 ranges`, even though chunk planning had already happened inside the digest job. Large documents make this especially confusing because chunk planning and per-chunk extraction are the critical long-running work the Pipeline should explain.

The existing `digest_session` row already persists aggregate per-workspace file progress so `GET /kb` can rehydrate after a browser refresh. The fix should extend that contract instead of adding a separate transient channel.

## Decision

Agent Cockpit persists live chunk progress as part of the existing `digestProgress` snapshot.

`digest_session` gains nullable `chunk_progress_json`, and `KbDigestProgress` gains optional `chunks: { done, total, active, phase, current? }`. The digestion runner updates this object as each raw moves through chunk `planning`, per-chunk `digesting`, per-chunk `parsing`, and final `committing`.

The Pipeline tab uses `digestProgress.chunks` whenever a digestion session is active. The Chunk node shows `done/total chunks` or `planning` from live progress; only when no live chunk progress exists does it fall back to committed `entrySourceCount` as source ranges.

## Alternatives Considered

- **Keep using `entrySourceCount` and relabel the node as Source Ranges**: rejected because it would avoid the false ordering but still would not show live chunk progress during long digests.
- **Emit chunk progress only through websocket substeps**: rejected because the KB Browser also polls `GET /kb`, and a browser refresh during digestion would lose the live chunk state.
- **Create a separate chunk-progress table**: rejected because the progress is session-scoped, temporary, and cleared when the queue drains; a JSON column on `digest_session` keeps the durable surface small.
- **Track every active chunk as a list**: deferred because `cliConcurrency` can process multiple raws, but the current Pipeline only needs aggregate done/total/active plus the most recently updated chunk. A list can be added later without changing the core session model.

## Consequences

- + The Pipeline no longer implies digestion skipped chunking while entries are still being extracted.
- + Browser refreshes during active digestion preserve both file progress and chunk progress through the same `GET /kb` contract.
- + The UI can distinguish live planned chunks from committed source lineage rows.
- - `digest_session` requires a schema migration from V7 to V8.
- - `digestProgress` becomes a larger public shape; clients must continue treating `chunks` as optional.
- ~ Aggregate sessions still expose only the most recently updated chunk in `current`, not every concurrently active chunk.

## References

- [Data model spec](../spec-data-models.md#knowledge-base-sqlite-schema)
- [Backend services spec](../spec-backend-services.md#knowledge-base-services-srcservicesknowledgebase)
- [API endpoints spec](../spec-api-endpoints.md)
- [Frontend spec](../spec-frontend.md)
- [Testing spec](../spec-testing.md)
- [ADR-0033](0033-adopt-structure-guided-knowledge-base-digestion-and-retrieval.md)
