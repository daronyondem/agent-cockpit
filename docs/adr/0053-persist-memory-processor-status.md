---
id: 0053
title: Persist memory processor status
status: Proposed
date: 2026-05-12
supersedes: []
superseded-by: null
tags: [memory, mcp, cli-profiles, settings]
affects:
  - src/services/memoryMcp/index.ts
  - src/services/memoryMcp/stub.cjs
  - src/types/index.ts
  - web/AgentCockpitWeb/src/screens/settingsScreen.jsx
  - docs/spec-backend-services.md
  - docs/spec-api-endpoints.md
  - docs/spec-data-models.md
  - docs/spec-frontend.md
---

## Context

Workspace Memory writes can happen through a hidden `memory_note` MCP call while the visible chat turn continues through a separate active CLI profile. Before this decision, Memory processor `runOneShot()` failures surfaced as generic MCP/tool failures, so a revoked or unauthenticated Memory processor profile could look like the active chat profile failed even when chat itself still worked.

Settings already lets users choose the Memory CLI profile, but it did not show the last processor health. Inline chat/tool output is the primary failure surface, yet a user also needs a persistent place to confirm which Memory processor profile was used after the chat turn has moved on.

## Decision

Persist the last redacted Memory processor status in `Settings.memory.lastProcessorStatus`.

The Memory MCP session registry records optional active chat profile metadata when issuing the MCP token. The `memory_note` HTTP handler classifies processor configuration, CLI authentication, runtime, and bad-output failures separately from internal Memory MCP bearer-token failures and workspace Memory-disabled failures. Processor failure responses include a structured code, a user-readable message, Memory processor profile/backend metadata, active chat profile/backend metadata when known, and a redacted error. Successful write/skip decisions update the status to `last_succeeded`.

The MCP stdio stub preserves the server-provided failure message in the tool result. Global Settings renders the selected Memory processor profile and the matching last known status.

## Alternatives Considered

- **Inline-only failure text**: Only improve the `memory_note` tool result. Rejected because Settings would still have no durable status once the chat turn scrolls away or the page reloads.
- **Dedicated Memory processor status endpoint/store**: Persist status outside Settings and expose a new API. Rejected for this slice because Memory processor selection already lives in global Settings, and the status is small, redacted, and directly tied to that selection.
- **Run proactive auth checks before every memory write**: Verify the processor profile before calling `runOneShot()`. Rejected because it adds latency and still cannot replace classification of the actual processor command failure.

## Consequences

- + Users can distinguish Memory MCP bearer/session auth, disabled workspace Memory, processor configuration, processor CLI authentication, processor runtime, and processor output failures.
- + Profile-related failures can name both the active chat profile and the Memory processor profile when they differ.
- + Settings can show the selected Memory processor and its last known state without another endpoint.
- - Updating processor status writes global settings, so concurrent Settings edits still rely on the existing full-settings save behavior.
- ~ The stored error is bounded and redacted; it is diagnostic context, not a full processor log.

## References

- Issue #273 — Clarify Memory MCP profile auth failures
- [Backend Services — Memory MCP Server](../spec-backend-services.md#memory-mcp-server)
- [API Endpoints — Memory MCP notes](../spec-api-endpoints.md)
- [Data Models — Settings](../spec-data-models.md)
- [Frontend — Settings Memory tab](../spec-frontend.md)
