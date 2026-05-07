---
id: 0039
title: Add lexical search before semantic memory retrieval
status: Proposed
date: 2026-05-06
supersedes: []
superseded-by: null
tags: [memory, retrieval, mcp]
affects:
  - src/types/index.ts
  - src/services/chatService.ts
  - src/services/memoryMcp/index.ts
  - src/services/memoryMcp/stub.cjs
  - src/routes/chat.ts
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-api-endpoints.md
  - docs/spec-testing.md
  - test/chatService.workspaceMemory.test.ts
  - test/memoryMcp.test.ts
---

## Context

Workspace Memory v1 exposes read access primarily as a filesystem pointer. That works, but it pushes every CLI toward either reading the whole `memory/files/` tree or guessing which file matters. Memory v2 needs targeted recall that can be used during ordinary conversations without dumping all memory content into the prompt.

The Knowledge Base already has embedding-backed hybrid retrieval configured per workspace through Ollama. Memory does not yet have an equivalent embedding setting, index lifecycle, or dependency story. Reusing KB embeddings implicitly would make Memory depend on KB configuration and would surprise users who enabled Memory but did not configure KB embeddings.

## Decision

Add local lexical Memory search before semantic Memory retrieval.

`ChatService.searchWorkspaceMemory(hash, { query, limit?, types?, statuses? })` searches the merged workspace memory snapshot using BM25-style lexical scoring over tokenized name, description, type, filename, and content. Name and description are weighted by including them multiple times in the searchable text. Results include filename, entry ID, type, source, lifecycle status, score, snippet, content, and the sidecar metadata.

The default lifecycle filter is `active + redacted`. `superseded` and `deleted` entries are excluded unless a future caller deliberately opts into those statuses.

Expose this through a new `memory_search` MCP tool on the existing `agent-cockpit-memory` stub. The stub forwards to `POST /mcp/memory/search` using the same per-session memory token. The endpoint returns JSON results and caps content at 4000 characters per result for MCP responses. The chat system prompt addendum now teaches CLIs to use `memory_search` for targeted recall and `memory_note` for durable writes.

This decision explicitly does not add embeddings, RRF, or Ollama dependency for Memory yet. Semantic retrieval can be added later behind a separate Memory embedding configuration or another explicit dependency decision.

## Alternatives Considered

- **Immediately reuse the KB embedding configuration.** Rejected because Memory and KB are independent workspace features. A Memory-enabled workspace should not silently depend on a KB-specific Ollama host/model setting.
- **Add a Memory embedding configuration now.** Rejected for this slice because lexical recall covers the immediate need without introducing index build/rebuild behavior, health checks, model dimensions, or user-facing settings.
- **Keep only the filesystem pointer.** Rejected because it gives the CLI no compact retrieval path and encourages broad reads of the entire memory tree.
- **Search all lifecycle states by default.** Rejected because superseded memories should not influence normal recall once a newer entry replaces them. Redacted entries remain searchable because their sensitive values have been removed and they may still contain useful durable context.

## Consequences

- + CLIs can retrieve relevant memory with a small, explicit MCP call instead of scanning every file.
- + Memory search works in every memory-enabled workspace without Ollama or KB embedding setup.
- + The result contract is reusable for future REST/UI/search-index work.
- - Lexical recall will miss semantic matches that do not share terms with the query.
- - Search currently scans the merged snapshot in process; a future large memory store may need an indexed backing store.
- ~ Semantic Memory retrieval remains a future enhancement with its own dependency/configuration decision.

## References

- Issue #276 — Memory v2: lifecycle, governed writes, and searchable recall
- ADR-0037 — Add sidecar lifecycle metadata for workspace memory
- ADR-0038 — Govern workspace memory writes before persistence
- `docs/spec-backend-services.md` — Workspace Memory / Memory MCP Server
- `docs/spec-data-models.md` — Workspace Memory Store
