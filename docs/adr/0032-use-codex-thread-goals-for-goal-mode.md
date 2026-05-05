---
id: 0032
title: Use Codex thread goals for goal mode
status: Accepted
date: 2026-05-05
supersedes: []
superseded-by: null
tags:
  - codex
  - goals
  - streaming
  - frontend
affects:
  - src/services/backends/codex.ts
  - src/services/backends/base.ts
  - src/routes/chat.ts
  - src/types/index.ts
  - public/v2/src/api.js
  - public/v2/src/streamStore.js
  - public/v2/src/shell.jsx
  - public/v2/src/app.css
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
  - docs/parity-decisions.md
---

## Context

Codex exposes an experimental `/goal` style workflow through `codex app-server --enable goals`. The app-server owns goal state on the Codex thread and emits structured goal notifications while it decides whether more work is needed. Agent Cockpit already owns the durable stream lifecycle, WebSocket buffering, workspace prompt composition, MCP injection, and conversation UI, so goal mode needs to enter through those existing paths instead of creating a parallel runner.

The first Agent Cockpit slice should let a user set, pause, resume, and clear a Codex goal from the chat composer. Token budget controls are deliberately out of scope for this slice even though Codex's protocol goal object includes budget-related fields.

## Decision

Agent Cockpit uses Codex thread goals as the source of truth for goal mode.

The Codex adapter starts app-server with `--enable goals`, initializes with the experimental client capability, and adds typed adapter methods for `thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`. Setting or resuming a goal creates a normal Agent Cockpit stream job and reuses the existing `processStream` and WebSocket buffering path, but it does not append an optimistic user message. Goal updates and clears are forwarded as lightweight WebSocket frames and are not persisted as chat messages.

The desktop V2 composer surfaces goal mode only for Codex conversations. `/goal` toggles goal mode, `/goal <objective>` sets a goal, and `/goal pause|resume|clear` maps to the matching goal controls. The composer also has a Codex-only Goal checkbox and a compact goal strip above the composer for status and Pause/Resume/Clear actions.

Agent Cockpit does not expose token budget entry or budget editing in v1. If Codex returns `budgetLimited`, the UI may display that status, but there is no budget field in the REST request body and no budget control in the composer.

## Alternatives Considered

- **Rewrite user messages into long-running "keep working until done" prompts**. Rejected because it would lose Codex's native goal state, pause/resume semantics, and structured goal notifications.
- **Add a vendor-neutral Agent Cockpit goal model first**. Rejected for this slice because only Codex currently exposes a native goal protocol and a cross-backend abstraction would be speculative.
- **Put goal controls in the chat topbar**. Rejected because setting a goal is a send-mode decision tied to the composer objective, while the topbar is already used for session/runtime metadata.
- **Expose token budget controls immediately**. Rejected because budget behavior and UX need separate design; v1 only surfaces objective and status.

## Consequences

- + Goal runs share existing stream supervision, reconnect buffering, workspace prompt composition, MCP injection, memory watching, and title update behavior.
- + Pause and clear can be issued while a run is active without treating them as Stop/abort operations.
- + The UI keeps goal entry close to the message composer and avoids adding budget controls before the product semantics are settled.
- - The first slice is Codex-only; Claude Code, Kiro, and the mobile PWA do not expose goal controls.
- ~ Goal state lives in Codex's thread store. Agent Cockpit fetches and mirrors it client-side, but does not persist a separate goal record in conversation JSON.

## References

- [API endpoints spec](../spec-api-endpoints.md#371-codex-goals)
- [Backend services spec](../spec-backend-services.md#codexadapter-srcservicesbackendscodexts)
- [Frontend spec](../spec-frontend.md)
- [Mobile PWA spec](../spec-mobile-pwa.md#deferred-slices)
- [Client parity decisions](../parity-decisions.md)
