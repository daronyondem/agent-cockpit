---
id: 0047
title: Run session reset finalizers asynchronously
status: Accepted
date: 2026-05-10
supersedes: []
superseded-by: null
tags: [sessions, performance, background-jobs, memory, context-map]
affects:
  - src/routes/chat.ts
  - src/services/sessionFinalizerQueue.ts
  - src/services/chatService.ts
  - src/services/contextMap/service.ts
  - test/chat.conversations.test.ts
  - test/chat.contextMap.test.ts
  - test/chatService.messages.test.ts
  - test/sessionFinalizerQueue.test.ts
  - test/helpers/chatEnv.ts
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-frontend.md
  - docs/spec-testing.md
---

## Context

Session reset must create a new usable session quickly. Before this decision, reset also waited on several expensive finalization tasks: generating an LLM summary for the ended session, capturing native backend memory, running post-session memory extraction, and running a Context Map final pass. Each of those tasks can involve one-shot CLI calls and can take seconds or minutes depending on the backend and workspace.

That made reset latency depend on optional enrichment work. It also held the user on the old session boundary even though the only required synchronous work is archiving the ended session, creating the next session, clearing stale UI/runtime state, and rotating per-session MCP tokens.

Context Map finalization had a second cost: reset/archive used the workspace scan path, which could include workspace source discovery and source packet extraction. For a session boundary, the important missing data is the just-ended conversation range, not every product-owned workspace source.

## Decision

Session reset archives the active session with a deterministic fallback summary, creates the new session, persists background finalizer jobs, rotates MCP tokens, and returns without waiting for the finalizers to execute.

A new `SessionFinalizerQueue` persists per-workspace jobs in `workspaces/{hash}/session-finalizers.json`. Jobs are de-duplicated by `(type, payload.source, conversationId, sessionNumber)`, run in the background with bounded concurrency, retry on failure, and recover `running` jobs back to `pending` after server restart. The queue owns three job types:

- `session_summary` runs backend summary generation later and patches the archived session entry.
- `memory_extraction` captures native backend memory and runs post-session Memory extraction over the archived transcript.
- `context_map_conversation_final_pass` runs Context Map finalization for one archived conversation/session with source `session_reset` or `archive`.

Context Map adds `processConversationSession(hash, conversationId, sessionNumber, { source })` for reset/archive finalizers. That path reads the archived session transcript, processes only that conversation span, and skips workspace source discovery. If another Context Map run is already active for the workspace, the finalizer reports a retryable failure so the queue can try again later.

## Alternatives Considered

- **Keep reset fully synchronous**. Rejected because optional enrichment work dominates reset latency and is not required before the user can start the next session.
- **Fire-and-forget in memory only**. Rejected because a server restart during finalization would silently lose pending summary, memory, or Context Map work.
- **Run a full Context Map workspace scan in the finalizer**. Rejected because reset/archive finalization is about the ended transcript; workspace source discovery belongs to initial, manual, and scheduled workspace scans.
- **Move only summary generation to the background**. Rejected because memory extraction and Context Map finalization are also slow one-shot workloads and leave reset latency exposed.

## Consequences

- + Reset returns after the durable session boundary and enqueue writes, instead of waiting on one-shot summary, memory, and Context Map calls.
- + Finalizer jobs survive server restarts and retry transient failures.
- + Archived sessions have an immediate fallback summary and can be improved later when summary generation completes.
- + Reset/archive Context Map finalization processes only the relevant conversation/session transcript, avoiding workspace source discovery on the hot path.
- - There is a short period where the archived session summary is generic and memory/context-map updates are still pending.
- - Operational state now includes another per-workspace JSON queue that can accumulate failed jobs if a backend or processor stays broken.
- ~ Finalizer completion is observable through existing persisted outputs and logs; there is no separate user-facing finalizer UI yet.

## References

- [API endpoints specification](../spec-api-endpoints.md#35-sessions)
- [Backend services specification](../spec-backend-services.md#durability-primitives)
- [Data models specification](../spec-data-models.md#session-finalizer-store-workspaceshashsession-finalizersjson)
- [Frontend specification](../spec-frontend.md#v2--default-frontend)
- [Testing specification](../spec-testing.md)
