---
id: 0040
title: Consolidate workspace memory manually
status: Proposed
date: 2026-05-06
supersedes: []
superseded-by: null
tags: [memory, consolidation, governance]
affects:
  - src/types/index.ts
  - src/services/chatService.ts
  - src/services/memoryMcp/index.ts
  - src/routes/chat.ts
  - public/v2/src/api.js
  - public/v2/src/workspaceSettings.jsx
  - public/v2/src/app.css
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-api-endpoints.md
  - docs/spec-frontend.md
  - docs/spec-testing.md
  - test/chat.memory.test.ts
  - test/memoryMcp.test.ts
  - test/frontendRoutes.test.ts
---

## Context

Workspace Memory v2 now has lifecycle metadata, governed writes, user-visible write outcomes, and lexical recall. That makes individual writes safer, but the store can still accumulate near-duplicates, stale project facts, overloaded entries, and inconsistent titles over time.

Semantic retrieval is not required to start addressing this. A manual consolidation pass can use the current active/redacted snapshot plus the configured Memory CLI to produce a review, while applying only low-risk lifecycle metadata changes.

The important constraints are:

- Memory remains human-readable Markdown under `memory/files/`.
- Redacted content must not be sent back to a model in a way that could reintroduce secrets.
- Consolidation should not delete files or rewrite user-visible memory content automatically.
- Merge/split/rename/normalization work needs review because it changes authored content or presentation.

## Decision

Add manual workspace memory consolidation as a proposal-first workflow.

`POST /workspaces/:hash/memory/consolidate/propose` runs the configured Memory CLI against the current active/redacted memory entries and asks for JSON review actions:

- `mark_superseded`
- `merge_candidates`
- `split_candidate`
- `normalize_candidate`
- `keep`

Redacted entries are included only as metadata plus a withheld-content marker; their bodies are not sent to the Memory CLI during consolidation.

`POST /workspaces/:hash/memory/consolidate/apply` applies only `mark_superseded` actions. Applying one of those actions updates `memory/state.json` metadata: the stale entry becomes `superseded`, receives `supersededBy`, and the replacement entry's `supersedes[]` includes the stale entry ID. The Markdown files are not edited or deleted.

Every apply call that has applied or skipped actions writes an audit JSON file under `memory/audits/`. Advisory actions are recorded as skipped so the user can see that the review identified merge/split/normalization work without implying those changes were performed.

## Alternatives Considered

- **Automatic merge/split/rewrite**: Let the Memory CLI rewrite memory Markdown directly. Rejected for this slice because bad consolidation can erase nuance, reintroduce redacted data, or make provenance harder to inspect.
- **Wait for semantic search first**: Build vector similarity before consolidation. Rejected because stale/conflicting entries can be addressed with lifecycle metadata and lexical/manual review now; semantic recall can improve candidate discovery later.
- **Delete superseded content**: Remove old files once superseded. Rejected because preserving lineage is more useful and safer than destructive cleanup.
- **Store proposals as durable pending state**: Persist generated proposals before apply. Rejected for the first version because the proposal is cheap to regenerate and apply already writes a durable audit of what happened.

## Consequences

- + Users can review consolidation suggestions before any state changes.
- + The first automatic consolidation action is metadata-only and reversible by editing sidecar state.
- + Redacted entry bodies are not exposed during consolidation prompts.
- + Audit files provide a local record of applied and skipped actions.
- - Merge/split/normalization remain advisory until an edit/review workflow exists.
- - Lexical/manual consolidation may miss semantically similar entries that use different vocabulary.
- ~ Semantic search can later improve proposal quality without changing the apply contract.

## References

- Issue #276 — Memory v2: lifecycle, governed writes, and searchable recall
- ADR-0037 — Add sidecar lifecycle metadata for workspace memory
- ADR-0038 — Govern workspace memory writes before persistence
- ADR-0039 — Add lexical search before semantic memory retrieval
- `docs/spec-backend-services.md` — Workspace Memory / Memory MCP Server
- `docs/spec-data-models.md` — Workspace Memory Store
- `docs/spec-api-endpoints.md` — Workspace Instructions / Memory endpoints
- `docs/spec-frontend.md` — Workspace Settings Memory tab
