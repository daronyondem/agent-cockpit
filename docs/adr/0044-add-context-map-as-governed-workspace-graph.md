---
id: 0044
title: Add Context Map as self-maintained workspace graph
status: Proposed
date: 2026-05-07
supersedes: []
superseded-by: null
tags: [context-map, memory, mcp, governance]
affects:
  - src/types/index.ts
  - src/services/settingsService.ts
  - src/services/chatService.ts
  - src/routes/chat.ts
  - src/services/contextMap/apply.ts
  - src/services/contextMap/db.ts
  - src/services/contextMap/defaults.ts
  - src/services/contextMap/mcp.ts
  - src/services/contextMap/service.ts
  - src/services/contextMap/stub.cjs
  - server.ts
  - public/v2/index.html
  - public/v2/src/api.js
  - public/v2/src/app.css
  - public/v2/src/screens/settingsScreen.jsx
  - public/v2/src/shell.jsx
  - public/v2/src/streamStore.js
  - public/v2/src/workspaceSettings.jsx
  - test/contextMap.db.test.ts
  - test/contextMap.mcp.test.ts
  - test/contextMap.service.test.ts
  - test/settingsService.test.ts
  - test/chatService.workspace.test.ts
  - test/chat.contextMap.test.ts
  - test/frontendRoutes.test.ts
  - test/streamStore.test.ts
  - docs/design-context-map.md
  - docs/SPEC.md
  - docs/spec-data-models.md
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-frontend.md
  - docs/spec-testing.md
---

## Context

Agent Cockpit already has workspace Memory for durable facts/preferences and Knowledge Base for source-document ingestion, topic synthesis, and retrieval. Those features do not model a workspace's durable entities, relationships, evidence trails, review state, or context-pack assembly as a first-class product surface.

The missing capability is broader than a software-project index. It needs to work across software development, personal planning, customer/account research, and manuscript/research workspaces without depending on a specific folder convention or a specific CLI's private memory format.

Several constraints shape the design:

- The active chat CLI should stay focused on the user-visible conversation, not background graph maintenance.
- The workspace graph may contain sensitive personal, professional, or confidential information, so processor-proposed changes need auditability, safe automatic application rules, and a way to surface only ambiguous or risky items for user attention.
- The feature needs reliable relationships, evidence links, lifecycle state, and deduplication, which are awkward and fragile when stored only as freeform Markdown.
- The runtime still needs a compact read path so active sessions can retrieve relevant entities and relationships without injecting the entire graph into every prompt.

## Decision

Add **Context Map** as a separate workspace-level feature that maintains a governed entity and relationship graph for each enabled workspace.

Context Map is independently enableable from Memory and Knowledge Base. It must not depend on Memory, KB, or any workspace-specific folder such as `context/`. Future Memory or KB linkage should be designed explicitly as reviewed evidence, not as broad automatic extraction from those stores.

Use a canonical structured store for Context Map state. SQLite is the preferred source of truth for entities, entity types, aliases, facts, relationships, evidence references, processor runs, processor candidates, conversation cursors, source spans, and audit events. The UI may render readable Markdown-style cards, but those cards are generated from canonical data; editable Markdown files are not a second source of truth.

Context Map has a flexible entity type catalog. It starts with generic defaults such as `person`, `organization`, `project`, `workflow`, `document`, `feature`, `concept`, `decision`, `tool`, and `asset`. The processor may suggest workspace-specific types, but those suggestions go through review.

Processing is asynchronous and background-owned. It is not run inside active chat turns, is not turn-based, and does not wait only for session reset/archive. A scheduler periodically checks Context Map enabled workspaces, finds conversations updated since the last processing pass, and processes only unprocessed message ranges. Session reset/archive forces a final incremental pass for remaining unprocessed ranges.

Each processing run records durable source spans such as conversation id, session epoch, start/end message ids, and source hash. Per-conversation cursors prevent normal processing from re-reading entire conversations. If a source span was already processed, it is skipped; repeated mentions attach evidence without creating duplicate entities, duplicate relationships, or inflated confidence.

Before candidates are persisted, processor output is normalized and consolidated. Deterministic cleanup handles schema normalization, duplicate entity variants, same-name type conflicts, active-entity matches, relationship endpoint resolution, weak relationship scoring, and file/path noise. Larger candidate sets then run through chunked bounded synthesis/ranking: source-shaped chunks are reduced first, then a compact final arbiter reviews the ranked reduced set and returns keep/drop/merge/type/fact decisions over stable refs instead of rewriting full payloads. These passes can merge duplicates, preserve aliases/evidence, drop low-value candidates, and convert weak edges into facts. Synthesis failure is recorded as run metadata and falls back to ranked bounded candidate subsets rather than failing the scan or flooding Needs Attention with raw extraction.

Processor-proposed changes are persisted as durable `context_candidates` first. The processor then automatically applies high-confidence, additive candidates that are safe to mutate into the active graph without user interruption, currently including normal-sensitivity `new_entity`, durable `new_relationship`, `alias_addition`, `sensitivity_classification`, and `evidence_link` candidates above the configured confidence threshold and with source-span provenance. Candidate application writes the same audit trail whether it was applied automatically or by the user.

Candidates that are destructive, ambiguous, sensitive, low-confidence, conflicting, malformed, or blocked by missing dependencies remain `pending` and are shown as **Needs Attention** items. Users can inspect, edit, apply, discard, merge, split, mark sensitive, mark stale, or resolve conflicts from that surface. Scheduled/background processing should transparently improve the active map by default while preserving a durable change/audit record and surfacing exceptions outside the chat transcript.

Expose Context Map to active chat runtimes through read-only MCP tools such as `entity_search`, `get_entity`, `get_related_entities`, and `context_pack`. The active chat CLI should not write active entities, facts, or relationships. If write-like behavior is introduced later, it should create processor candidates only.

Configure Context Map with global processor defaults plus per-workspace overrides. Global settings define the default processor CLI profile/model/effort, scan interval, and concurrency cap. Workspace settings enable or disable Context Map and choose "use global default" or an override. Source selection is product-owned in the current implementation: conversations are always processed, while initial/manual scans also process workspace instructions and recursively discovered Markdown files. User-facing source controls can be added later only when the underlying processors are implemented and useful enough to warrant that complexity.

## Alternatives Considered

- **Make Context Map part of Memory**: rejected because Memory stores durable notes/facts/preferences, while Context Map models entities, relationships, evidence, processor candidates, and context-pack retrieval. Coupling them would make enablement, UI, and lifecycle semantics harder to reason about.
- **Depend on a workspace `context/` folder or other manual convention**: rejected because that convention can be useful in one workspace but is not reusable across workspace types. Context Map may use such files as evidence, but they cannot be a product primitive.
- **Let the active chat CLI maintain the graph directly**: rejected because it burdens the user-visible conversation path, risks interrupting chat with maintenance suggestions, and makes graph updates dependent on whatever runtime is currently active.
- **Process only at session reset/archive**: rejected because long sessions may run for days. Reset/archive is still a required finalization point, but ongoing scheduled processing is needed for timely continuity.
- **Process whole conversations repeatedly**: rejected because it creates duplicate outputs and can over-emphasize repeated material. Durable cursors and source spans are required for idempotent incremental processing.
- **Store editable Markdown/JSON cards as the canonical model**: rejected because relationships, evidence, conflict detection, lifecycle state, and search need structured querying. Generating readable cards from SQLite avoids two editable sources of truth.
- **Expose MCP write tools immediately**: rejected because the feature handles sensitive and potentially noisy processor output. Read-only MCP gives active sessions retrieval value while preserving background-owned graph maintenance.

## Consequences

- + Context Map becomes reusable across different workspace shapes without leaking assumptions from any one workspace.
- + Active chat sessions can retrieve entity/relationship context without taking on background processing work.
- + Safe high-confidence discoveries improve retrieval without making manual approval the normal user workflow.
- + Needs Attention governance keeps risky processor suggestions auditable before they affect retrieval.
- + A single SQLite source of truth avoids Markdown/JSON sync drift while still allowing readable UI cards.
- - Context Map introduces a new workspace-scoped store, needs-attention workflow, scheduler, MCP server, and settings surface.
- - Incremental processing requires careful cursor/source-span design to avoid duplicates and stale evidence.
- - The feature needs explicit privacy and sensitivity handling from the first implementation slice.
- ~ Graph visualization may be added later, but the primary UI should remain useful as searchable lists, detail views, relationship panels, recent changes, and needs-attention queues.

## References

- Issue #281 - Context Map: workspace entity and relationship memory
- [Context Map scope](../design-context-map.md)
- [SPEC index](../SPEC.md)
- [Data model specification](../spec-data-models.md)
- [API endpoint specification](../spec-api-endpoints.md)
- [Backend service specification](../spec-backend-services.md)
- [Frontend specification](../spec-frontend.md)
- [Testing specification](../spec-testing.md)
