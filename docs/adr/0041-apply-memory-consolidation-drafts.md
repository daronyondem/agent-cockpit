---
id: 0041
title: Apply memory consolidation drafts
status: Proposed
date: 2026-05-07
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
  - test/chatService.workspaceMemory.test.ts
  - test/memoryMcp.test.ts
  - test/frontendRoutes.test.ts
---

## Context

ADR-0040 introduced manual memory consolidation proposals and deliberately applied only metadata-only `mark_superseded` actions. That was the right first boundary, but it left useful merge/split/normalization suggestions as advisory text with no supported way to turn them into reviewed memory files.

The next slice needs to apply those deeper actions without giving the Memory CLI direct write access. The constraints remain:

- Memory files are human-readable Markdown and must stay reviewable before content changes.
- Redacted source entries must not be sent back to a model for rewrite.
- Claude-captured `memory/files/claude/` entries are mirrors of another CLI's native memory directory, so rewriting them in place would be lost or imply write-back ownership we do not have.
- Applying deeper consolidation must preserve provenance through sidecar lifecycle metadata and audit files.

## Decision

Add a draft/apply-draft workflow for advisory consolidation actions.

`POST /workspaces/:hash/memory/consolidate/draft` accepts one `merge_candidates`, `split_candidate`, or `normalize_candidate` action from a proposal. It resolves the selected source files, rejects deleted/superseded/redacted sources, then asks the configured Memory CLI for exact JSON draft operations. Draft operations are limited to:

- `create`: a complete new Markdown memory note with `supersedes` source filenames.
- `replace`: a complete replacement Markdown file for a selected `notes/*` entry.

The Memory tab renders the generated draft content inline before apply. `POST /workspaces/:hash/memory/consolidate/drafts/apply` applies only the reviewed draft payload:

- `create` writes a new `memory/files/notes/note_<timestamp>_<slug>.md`, marks the new entry's sidecar `supersedes[]`, and marks source entries `superseded` with `supersededBy`.
- `replace` rewrites only selected `notes/*` entries in place. It never rewrites `claude/*` entries.
- Generated content is deterministically redacted before write; if redaction occurs, the written entry metadata is marked `redacted`.
- Every apply writes a consolidation audit with `appliedDraftOperations` and `skippedDraftOperations`.

## Alternatives Considered

- **Directly apply advisory actions from the original proposal**: Rejected because merge/split/normalization need exact content diffs, not only a reason string.
- **Allow the Memory CLI to write files directly**: Rejected because the server must retain path validation, deterministic redaction, metadata updates, and audit persistence.
- **Rewrite Claude-captured files in place**: Rejected because `claude/*` is a mirror that can be replaced on the next native memory capture. Normalizing those entries creates a cockpit-owned note instead.
- **Persist pending drafts as durable state before apply**: Rejected for this slice because the draft is shown immediately in the Memory tab and the durable audit records what was actually applied.

## Consequences

- + Merge/split/normalization can now be completed without unreviewed content writes.
- + Redacted sources are excluded from rewrite prompts, preventing secret reconstruction attempts.
- + All applied content changes stay local, audited, and visible as Markdown files.
- - Applying split drafts can only record one `supersededBy` target per old source even when several new notes supersede it; the new notes each carry `supersedes[]` back to the source.
- - Draft generation still depends on the configured Memory CLI profile and does not use embeddings or semantic candidate discovery.
- ~ The proposal/apply endpoint from ADR-0040 remains metadata-only; deeper content changes use the separate draft/apply-draft contract.

## References

- Issue #276 - Memory v2: lifecycle, governed writes, and searchable recall
- ADR-0040 - Consolidate workspace memory manually
- `docs/spec-backend-services.md` - Workspace Memory / Memory MCP Server
- `docs/spec-data-models.md` - Workspace Memory Store
- `docs/spec-api-endpoints.md` - Workspace Instructions / Memory endpoints
- `docs/spec-frontend.md` - Workspace Settings Memory tab
