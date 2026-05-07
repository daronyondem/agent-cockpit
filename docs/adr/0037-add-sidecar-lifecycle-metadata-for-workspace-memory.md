---
id: 0037
title: Add sidecar lifecycle metadata for workspace memory
status: Proposed
date: 2026-05-06
supersedes: []
superseded-by: null
tags: [memory, data-model, lifecycle]
affects:
  - src/types/index.ts
  - src/services/chatService.ts
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-api-endpoints.md
  - docs/spec-frontend.md
  - docs/spec-testing.md
---

## Context

Workspace Memory is already backend-agnostic content storage: Claude Code native captures are mirrored under `memory/files/claude/`, MCP/post-session notes are stored under `memory/files/notes/`, and `snapshot.json` exposes a merged parsed view to the UI and APIs.

That storage is not enough for Memory v2. The next planned capabilities are governed writes, contradiction handling, redaction, supersession, `memory_search`, and optional semantic retrieval. Those features need lifecycle metadata that Agent Cockpit owns. Storing that metadata only in Markdown frontmatter would be fragile because `memory/files/claude/` is a mirror of another CLI's native memory directory and is wiped/recreated on capture. Editing those files would either be lost on the next capture or turn the cockpit mirror into an implicit write-back system.

We need a cockpit-owned metadata layer that can annotate both Claude-captured files and cockpit-owned notes without changing the source content contract.

## Decision

Add a versioned sidecar lifecycle index at `memory/state.json`.

The existing layout remains:

- `memory/snapshot.json` — merged parsed content snapshot for current memory files.
- `memory/files/claude/` — mirrored Claude Code native captures; still wiped and rewritten on each capture.
- `memory/files/notes/` — cockpit-owned notes from `memory_note` and post-session extraction; still preserved across captures.

The new sidecar stores cockpit-owned metadata keyed by workspace-relative filename:

```ts
{
  version: 1,
  updatedAt: string,
  entries: {
    "claude/feedback_testing.md": {
      entryId: string,
      filename: string,
      status: "active" | "superseded" | "redacted" | "deleted",
      scope: "workspace" | "user",
      source: "cli-capture" | "memory-note" | "session-extraction",
      createdAt: string,
      updatedAt: string,
      sourceConversationId?: string,
      supersedes?: string[],
      supersededBy?: string,
      confidence?: number,
      redaction?: { kind: string, reason: string }[]
    }
  }
}
```

For v1, write paths persist `state.json` for present files only. Delete and clear-all prune metadata for removed files instead of retaining tombstones. The `deleted` status is reserved for a later audited-forget workflow where retaining a non-content tombstone is intentional.

`ChatService.getWorkspaceMemory()` synthesizes active workspace metadata when older workspaces have a `snapshot.json` but no `state.json`, so existing memory stores remain readable without a migration job. Write paths materialize the sidecar. Claude recapture preserves sidecar metadata for filenames that still exist.

`MemoryFile` gains an optional `metadata` field in API responses and snapshots. This keeps the existing fields stable for current callers while allowing UI/search work to consume lifecycle data in later slices.

## Alternatives Considered

- **Put lifecycle fields only in Markdown frontmatter.** Rejected because Claude-captured files are a mirrored subtree rewritten from native CLI output. Frontmatter edits there would be lost on capture and would blur the line between read-through mirror and write-back.
- **Expand `snapshot.json` only.** Rejected because `snapshot.json` is primarily a derived content view and is frequently rebuilt from files. Lifecycle metadata should have its own authoritative file so future write governance and search indexing do not depend on a derived cache.
- **Move Memory to SQLite immediately.** Rejected for this slice. The current file layout is simple, inspectable, and already wired through tests/UI. SQLite may be useful for search/indexing later, but lifecycle metadata does not require it.
- **Retain deletion tombstones now.** Rejected for v1 because existing delete behavior removes entries from the workspace mirror; preserving tombstones would imply new semantics around suppressing future native recaptures. That should be a separate audited-forget decision.

## Consequences

- + Future governed writes can mark older entries superseded without editing captured source files.
- + Future redaction/search/UI work has a stable metadata contract that works for both Claude captures and cockpit-owned notes.
- + Existing workspaces load without an explicit migration; metadata is synthesized on read and persisted by the next write.
- + `snapshot.json` remains useful for current API callers, with optional lifecycle metadata attached per file.
- - There are now two memory JSON files (`snapshot.json` and `state.json`) that must stay in sync on write paths.
- - Filename-keyed metadata preserves state across normal recaptures but will not survive a future rename unless that workflow explicitly migrates the key.
- ~ The first slice adds lifecycle infrastructure only; it does not yet implement governed write outcomes, `memory_search`, BM25, embeddings, or UI filters.

## References

- Issue #276 — Memory v2: lifecycle, governed writes, and searchable recall
- ADR-0004 — Capture CLI memory at workspace level on session reset
- `docs/spec-backend-services.md` — Workspace Memory
