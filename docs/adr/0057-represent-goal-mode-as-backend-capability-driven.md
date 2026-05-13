---
id: 0057
title: Represent goal mode as backend-capability driven
status: Proposed
date: 2026-05-13
supersedes: []
superseded-by: null
tags:
  - goals
  - codex
  - claude-code
  - frontend
affects:
  - src/types/index.ts
  - src/contracts/responses.ts
  - src/services/backends/base.ts
  - src/services/backends/codex.ts
  - src/services/backends/claudeCode.ts
  - src/services/chat/goalEventMessages.ts
  - src/routes/chat/goalRoutes.ts
  - src/routes/chat.ts
  - web/AgentCockpitWeb/src/goalState.js
  - web/AgentCockpitWeb/src/streamStore.js
  - web/AgentCockpitWeb/src/shell.jsx
  - mobile/AgentCockpitPWA/src/App.tsx
  - mobile/AgentCockpitPWA/src/api.ts
  - mobile/AgentCockpitPWA/src/appModel.ts
  - mobile/AgentCockpitPWA/src/types.ts
  - mobile/AgentCockpitPWA/src/styles.css
  - test/backends.test.ts
  - test/chat.rest.test.ts
  - test/codexBackend.test.ts
  - test/goalState.test.ts
  - test/frontendRoutes.test.ts
  - test/mobileAppModel.test.ts
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
  - docs/spec-testing.md
  - docs/spec-coverage.md
  - docs/parity-decisions.md
  - BACKENDS.md
---

## Context

Agent Cockpit first exposed goal mode through Codex because Codex provides native thread-goal RPCs over `codex app-server --enable goals`. That path supports structured goal state, pause, resume, clear, and goal update notifications.

Claude Code now exposes user-facing goal behavior through its `/goal` slash command. The semantics are similar from a user's perspective, but the integration boundary is different: Claude Code stores goal status in session transcript `goal_status` attachments and does not expose the same native pause/resume RPCs that Codex does.

The product should make "Goal" feel like one Agent Cockpit concept without implying false parity. Users should not need to understand the underlying protocol, but the UI must not show actions a backend cannot perform reliably.

## Decision

Agent Cockpit represents goal mode as backend-capability driven.

The shared goal shape is backend-neutral and can describe Codex native goals or Claude Code transcript-derived goals. Backend metadata advertises structured goal capabilities: set, clear, pause, resume, and status source. Codex advertises native set/clear/pause/resume/status support. Claude Code advertises set/clear and transcript-derived status, but not pause or resume.

Goal lifecycle visibility is also backend-neutral. Accepted goal prompts, route-level pause/resume/clear actions, and terminal goal outcomes are persisted as system `Message.goalEvent` messages. These messages are visible in the desktop and mobile transcripts as goal cards, but they are not saved as user prompts and do not become the backend's ordinary dialogue history.

Codex keeps using native `thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`. Claude Code starts goals by running `/goal <objective>`, clears goals by running `/goal clear`, and reads status from the Claude session JSONL transcript. Claude Code pause/resume is not emulated in Agent Cockpit; unsupported route calls return clear errors and the desktop and mobile UIs hide those controls.

## Alternatives Considered

- **Emulate Claude Code pause/resume in Agent Cockpit**: Rejected because it would require clearing and later recreating Claude's CLI-owned hook state, which may not preserve Claude's real session semantics and would imply support the CLI does not expose.
- **Keep goal mode Codex-only**: Rejected because Claude Code provides a comparable user-facing `/goal` workflow and Agent Cockpit can support it with a narrower capability set.
- **Build a fully persisted vendor-neutral goal store first**: Rejected because Codex and Claude already own their goal state differently. Persisting lifecycle transcript events is enough for user visibility without creating a parallel source of truth that would need reconciliation.
- **Show identical controls for every goal backend**: Rejected because users would reasonably expect identical behavior from identical buttons. Controls must render from backend capabilities.

## Consequences

- + The desktop and mobile Goal UI can support Codex and Claude Code without making the user choose a separate workflow per backend.
- + Goal prompts and outcomes are visible in conversation history even when the underlying backend treats goal work as background/control-plane state rather than normal chat text.
- + Codex's richer native controls remain available.
- + Claude Code does not show Pause/Resume controls that would be unreliable.
- - Claude Code goal status is best-effort because it depends on transcript `goal_status` attachments rather than a documented JSON-RPC goal API.
- ~ Future backends can join the Goal UI by declaring their supported actions instead of matching Codex's full feature set.

## References

- [ADR-0032: Use Codex thread goals for goal mode](0032-use-codex-thread-goals-for-goal-mode.md)
- [API endpoint spec](../spec-api-endpoints.md#371-goals)
- [Backend services spec](../spec-backend-services.md)
- [Frontend spec](../spec-frontend.md)
