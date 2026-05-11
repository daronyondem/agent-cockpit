---
id: 0051
title: Adopt shared contracts and logging foundations
status: Accepted
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
  - src/contracts/responses.ts
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
  - src/services/chat/artifactStore.ts
  - src/services/chat/messageQueueStore.ts
  - src/services/chat/usageLedgerStore.ts
  - src/services/chat/workspaceFeatureSettingsStore.ts
  - src/services/chat/workspaceInstructionStore.ts
  - src/services/contextMap/autoApply.ts
  - src/services/contextMap/candidatePrimitives.ts
  - src/services/contextMap/service.ts
  - src/services/contextMap/jsonRepair.ts
  - src/services/contextMap/pipelineMetadata.ts
  - src/services/contextMap/sourcePlanning.ts
  - src/services/memoryWatcher.ts
  - src/services/streamJobSupervisor.ts
  - src/utils/logger.ts
  - src/ws.ts
  - mobile/AgentCockpitPWA/src/api.ts
  - mobile/AgentCockpitPWA/src/appModel.ts
  - mobile/AgentCockpitPWA/src/useViewportHeightVar.ts
  - web/AgentCockpitWeb/src/api.js
  - web/AgentCockpitWeb/src/shell.jsx
  - web/AgentCockpitWeb/src/shellState.jsx
  - web/AgentCockpitWeb/src/streamStore.js
  - web/AgentCockpitWeb/src/chat/attachments.jsx
  - web/AgentCockpitWeb/src/chat/messageParsing.ts
  - web/AgentCockpitWeb/src/chat/queue.jsx
  - test/chatContracts.test.ts
  - test/chat.artifactStore.test.ts
  - test/chat.usageLedgerStore.test.ts
  - test/chat.workspaceFeatureSettingsStore.test.ts
  - test/contextMap.jsonRepair.test.ts
  - test/contextMap.pipelineMetadata.test.ts
  - test/frontendMessageParsing.test.ts
  - test/mobileAppModel.test.ts
  - test/logger.test.ts
  - scripts/check-maintainability.js
  - scripts/check-spec-drift.js
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
- Keep `ChatService` as the public facade while moving pure helpers and private
  persistence into focused modules under `src/services/chat/`, including
  artifact storage, usage ledger storage, workspace feature settings, message
  queue storage, and workspace-instruction compatibility storage.
- Keep Context Map processor orchestration in `service.ts`, but move focused
  work into owned modules under `src/services/contextMap/`: JSON
  extraction/repair, run/synthesis metadata, source planning, candidate
  normalization primitives, and safe auto-apply policy.
- Put pure V2 chat-message parsing helpers, large V2 chat UI subtrees, and
  shell state providers under owned web modules instead of keeping all desktop
  UI behavior inside `shell.jsx`.
- Put mobile projection/parsing helpers and viewport sizing behavior under
  owned PWA modules instead of keeping all mobile behavior inside `App.tsx`.
- Add stable maintainability checks for browser-safe contract boundaries, web
  and mobile server-import boundaries, backend structured logging migration,
  and chat route/spec drift.
- Use `src/utils/logger.ts` as the structured logging entrypoint for migrated
  backend code, with `LOG_LEVEL` filtering, metadata redaction, bounded rich
  value serialization, and cycle-safe metadata handling.

These boundaries define ownership for the completed slices and for similar
changes that touch the same behavior.

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
