---
id: 0038
title: Govern workspace memory writes before persistence
status: Proposed
date: 2026-05-06
supersedes: []
superseded-by: null
tags: [memory, governance, safety]
affects:
  - src/types/index.ts
  - src/services/memoryMcp/index.ts
  - src/services/chatService.ts
  - public/v2/src/streamStore.js
  - public/v2/src/shell.jsx
  - public/v2/src/workspaceSettings.jsx
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-api-endpoints.md
  - docs/spec-frontend.md
  - docs/spec-testing.md
  - test/memoryMcp.test.ts
  - test/chatService.workspaceMemory.test.ts
  - test/streamStore.test.ts
---

## Context

Workspace Memory accepts writes from multiple paths: Claude native capture, post-session extraction, and the `memory_note` MCP tool exposed to conversation CLIs. Before this decision, the MCP write path treated the Memory CLI as a formatter/deduper that could return either `SKIP:<filename>` or a Markdown file. That was enough for v1 note capture, but it did not expose why a write happened, could not represent "do not remember this because it is ephemeral", could not mark older entries superseded, and had no deterministic guardrail against persisting secrets.

ADR-0037 introduced `memory/state.json` as the Agent Cockpit-owned lifecycle sidecar. The next step is to make write decisions explicit before persistence so the sidecar can record redaction and supersession metadata without editing captured Markdown source files.

## Decision

Govern the `memory_note` MCP write path before it writes Markdown files.

The HTTP handler deterministically redacts sensitive-looking values from raw note content before it is sent to the configured Memory CLI. The initial detector set covers private-key blocks, Authorization bearer/basic values, common API token prefixes, secret assignment patterns, and Luhn-valid payment-card numbers. Redaction produces `{ kind, reason }` metadata; saved entries with redactions are marked `status: redacted` in `memory/state.json`.

The Memory CLI prompt now asks for a JSON decision object:

```json
{
  "action": "saved | skipped_duplicate | skipped_ephemeral | redacted_saved | superseded_saved",
  "reason": "short explanation",
  "entry": "frontmatter markdown for saved actions",
  "duplicateOf": "existing filename for duplicate skips",
  "supersedes": ["existing filename"]
}
```

Legacy `SKIP:<filename>` and frontmatter-only responses remain accepted so existing Memory CLI configurations do not break immediately.

Saved decisions write a new note file under `memory/files/notes/`, then patch lifecycle metadata through `ChatService.patchMemoryEntryMetadata()`. Supersession stores the new entry's `supersedes` list as older entry IDs and marks older filenames `status: superseded` with `supersededBy` pointing at the new entry ID. Skip decisions do not write a file.

Every governed decision is surfaced as a `MemoryWriteOutcome` and returned from `POST /mcp/memory/notes`. Source conversations also receive `memory_update.writeOutcomes`; skip-only decisions use empty `changedFiles` so the chat can explain the decision without implying file changes.

## Alternatives Considered

- **Keep the legacy `SKIP`/Markdown contract.** Rejected because it cannot represent ephemeral skips, redaction, supersession, or user-visible reasons without overloading file content.
- **Let the Memory CLI handle all redaction.** Rejected because secrets would still be sent to the Memory CLI prompt. Deterministic local redaction must happen before model processing.
- **Delete superseded files immediately.** Rejected because supersession is a lifecycle state, not an erase operation. Keeping older files marked `superseded` preserves auditability and allows future review/filter UI.
- **Block every ambiguous/sensitive note instead of saving redacted entries.** Rejected because many useful memories may mention credentials or private values incidentally. Redacted persistence keeps the durable fact while removing the sensitive value.

## Consequences

- + Memory writes now have explicit, testable outcomes and reasons.
- + Sensitive values are scrubbed before they reach the Memory CLI and before they land on disk.
- + New memories can supersede older entries without mutating or deleting captured source files.
- + The frontend can show saved/skipped/redacted/superseded outcomes in the chat bubble and update modal.
- - The Memory MCP handler now has a larger parsing and redaction surface that must be maintained carefully.
- - The JSON outcome contract is stricter than the legacy Markdown contract; compatibility parsing remains for now, but future removal needs a migration window.
- ~ Redacted entries use `status: redacted`; future active-memory filters/search must decide whether to include redacted entries by default or expose them as their own lifecycle bucket.

## References

- Issue #276 — Memory v2: lifecycle, governed writes, and searchable recall
- ADR-0037 — Add sidecar lifecycle metadata for workspace memory
- `docs/spec-backend-services.md` — Workspace Memory / Memory MCP Server
- `docs/spec-data-models.md` — Workspace Memory Store
