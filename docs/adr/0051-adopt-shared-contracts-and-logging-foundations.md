---
id: 0051
title: Adopt shared contracts and logging foundations
status: Proposed
date: 2026-05-11
supersedes: []
superseded-by: null
tags:
  - maintainability
  - api
  - logging
affects:
  - src/contracts/chat.ts
  - src/contracts/contextMap.ts
  - src/contracts/conversations.ts
  - src/contracts/explorer.ts
  - src/contracts/knowledgeBase.ts
  - src/contracts/memory.ts
  - src/contracts/serviceTier.ts
  - src/contracts/settings.ts
  - src/contracts/streams.ts
  - src/contracts/uploads.ts
  - src/contracts/validation.ts
  - src/routes/chat.ts
  - src/routes/chat/cliProfileRoutes.ts
  - src/routes/chat/contextMapRoutes.ts
  - src/routes/chat/conversationRoutes.ts
  - src/routes/chat/explorerRoutes.ts
  - src/routes/chat/filesystemRoutes.ts
  - src/routes/chat/goalRoutes.ts
  - src/routes/chat/kbRoutes.ts
  - src/routes/chat/memoryRoutes.ts
  - src/routes/chat/routeUtils.ts
  - src/routes/chat/streamRoutes.ts
  - src/routes/chat/statusRoutes.ts
  - src/routes/chat/uploadRoutes.ts
  - src/routes/chat/workspaceInstructionRoutes.ts
  - src/services/chatService.ts
  - src/services/chat/attachments.ts
  - src/services/chat/messageQueueStore.ts
  - src/services/chat/workspaceInstructionStore.ts
  - src/services/contextMap/service.ts
  - src/services/contextMap/jsonRepair.ts
  - src/services/contextMap/pipelineMetadata.ts
  - src/services/memoryWatcher.ts
  - src/services/streamJobSupervisor.ts
  - src/utils/logger.ts
  - src/ws.ts
  - mobile/AgentCockpitPWA/src/api.ts
  - web/AgentCockpitWeb/src/api.js
  - web/AgentCockpitWeb/src/shell.jsx
  - web/AgentCockpitWeb/src/streamStore.js
  - web/AgentCockpitWeb/src/chat/attachments.jsx
  - web/AgentCockpitWeb/src/chat/messageParsing.ts
  - web/AgentCockpitWeb/src/chat/queue.jsx
  - test/chatContracts.test.ts
  - test/contextMap.jsonRepair.test.ts
  - test/contextMap.pipelineMetadata.test.ts
  - test/frontendMessageParsing.test.ts
  - test/logger.test.ts
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-context-map.md
  - docs/spec-coverage.md
  - docs/spec-data-models.md
  - docs/spec-deployment.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
  - docs/spec-server-security.md
  - docs/spec-testing.md
---

## Context

The codebase has accumulated several high-responsibility files:
`src/routes/chat.ts`, `src/services/chatService.ts`,
`src/services/contextMap/service.ts`, `src/ws.ts`, and the V2 shell each own
multiple unrelated concerns. That makes routine changes harder to review
because validation, route registration, parser repair, UI parsing, and
diagnostic behavior are embedded in large modules.

The near-term maintainability goal is not a sweeping rewrite. The codebase
needs a repeatable boundary pattern that can be applied incrementally without
changing endpoint paths, response shapes, data files, or user-facing behavior.

## Decision

Adopt small shared foundations for maintainability work:

- Put request/response boundary types and runtime validators in
  `src/contracts/` when they are used by routes, clients, tests, or specs.
  Keep contract files browser-safe when desktop or mobile clients import them
  for type checking.
- Keep `src/routes/chat.ts` as the composition root for chat dependencies and
  stream orchestration, but move focused route groups into
  `src/routes/chat/*Routes.ts`.
- Keep `ChatService` as the public facade while moving pure helpers into
  focused modules under `src/services/chat/`, including private persistence
  stores such as message queue storage and workspace-instruction compatibility
  storage.
- Keep Context Map processor orchestration in `service.ts`, but move local JSON
  extraction/repair helpers into `src/services/contextMap/jsonRepair.ts` and
  pure run/synthesis metadata helpers into
  `src/services/contextMap/pipelineMetadata.ts`.
- Put pure V2 chat-message parsing helpers and large V2 chat UI subtrees under
  `web/AgentCockpitWeb/src/chat/` instead of inside `shell.jsx`.
- Use `src/utils/logger.ts` as the structured logging entrypoint for migrated
  backend code, with `LOG_LEVEL` filtering, metadata redaction, bounded rich
  value serialization, and cycle-safe metadata handling.

These foundations are allowed to start narrow. New code should prefer them when
touching the same boundary, but existing modules can migrate in focused slices.

## Alternatives Considered

- **Refactor each large module completely before adding new boundaries**:
  rejected because it would create a large behavior-preserving diff with a high
  review burden and little incremental verification value.
- **Introduce a validation/logging framework dependency now**: rejected because
  the immediate need is ownership clarity and testable seams, not a dependency
  migration. Lightweight local helpers are enough for the first slices.
- **Leave helpers inline until a larger rewrite**: rejected because the current
  inline shape keeps tests coupled to large modules and makes future targeted
  changes more expensive.

## Consequences

- + Future route, contract, parser, and logging changes have obvious ownership
  locations.
- + Focused helper tests can verify behavior without booting large route or
  service compositions.
- + Structured logs can be adopted incrementally while preserving existing
  stdout/stderr behavior for unmigrated modules.
- ~ The repository temporarily has both old and new patterns while migration is
  incremental.
- - Shared validators and logging helpers become small platform APIs that need
  docs and tests whenever their behavior expands.

## References

- [API endpoints specification](../spec-api-endpoints.md)
- [Backend services specification](../spec-backend-services.md)
- [Context Map specification](../spec-context-map.md)
- [Frontend behavior specification](../spec-frontend.md)
- [Mobile PWA specification](../spec-mobile-pwa.md)
- [Server initialization and security specification](../spec-server-security.md)
- [Testing specification](../spec-testing.md)
- [Documentation coverage map](../spec-coverage.md)
