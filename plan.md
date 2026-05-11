# Maintainability Follow-up Implementation Plan

## Scope

This plan covers the next maintainability wave:

1. Continue splitting `src/routes/chat.ts` by domain.
2. Expand `src/contracts/` and connect web/mobile clients to shared types where practical.
3. Continue splitting `ChatService` into private stores behind the existing facade.
4. Extract more Context Map pipeline stages after the JSON repair boundary.
5. Continue V2 decomposition by moving larger UI subtrees out of `shell.jsx`.
6. Migrate additional backend modules to `src/utils/logger.ts`.
7. Make logger metadata serialization cycle-safe.

The goal is long-term maintainability without broad behavior changes. Each phase should be independently reviewable and should preserve endpoint paths, response shapes, storage formats, and user-facing behavior unless a specific contract fix is explicitly called out.

## Assumptions

- `src/routes/chat.ts` remains the chat API composition root until all domain routers are extracted.
- `ChatService` remains the public service facade; route modules and tests should not need to know about private stores.
- Shared contracts should start with TypeScript types plus small runtime validators. Do not introduce a validation dependency unless the local helpers become clearly insufficient.
- Desktop V2 and mobile PWA can share type-only imports where build boundaries allow it. Runtime client code should not import server-only code.
- Context Map extraction should move orchestration stages only after existing parser repair tests stay green.
- Logger migration should not change operational behavior except log shape, level filtering, and redaction.
- This plan is implementation guidance, not a request to create a PR or commit by itself.

## Global Guardrails

- Keep changes surgical and behavior-compatible.
- Before each phase, record exact success criteria in the working notes or PR description.
- Run focused tests after each slice before continuing.
- Update `docs/` specs for every API, behavior, source-layout, environment, or test change.
- Evaluate mobile PWA impact for every API/contract/frontend-adjacent change.
- Evaluate ADR need before each phase. Write an ADR when the change sets a durable pattern, crosses subsystems, or rejects an obvious alternative.
- Avoid mixing pure move-only refactors with behavior changes in the same slice.
- Do not start a server unless needed. If needed, use PM2 only.

## Baseline Verification

Run before the first implementation slice:

```bash
git status --short --branch
npm run typecheck
npm run web:typecheck
npm run mobile:typecheck
npm test -- --runTestsByPath test/chat.rest.test.ts test/frontendRoutes.test.ts test/streamStore.test.ts
```

If the worktree already has unrelated changes, leave them untouched and note them before editing.

## Phase 1: Expand Shared Contracts

### Goal

Grow `src/contracts/` from the current initial chat contract helpers into a stable boundary for common mutation payloads and response types used by server routes, tests, desktop V2, and the mobile PWA.

### Rationale

Route handlers, `web/AgentCockpitWeb/src/api.js`, `mobile/AgentCockpitPWA/src/api.ts`, tests, and specs currently duplicate API shapes. That makes backend/frontend drift likely, especially while route modules are split.

### Work Plan

1. Inventory mutation endpoints by risk and client usage:
   - conversation create/update/archive/restore/delete/reset
   - send message/input/abort
   - queue PUT/DELETE
   - upload delete/OCR
   - explorer create/save/rename/delete/upload
   - memory enable/delete/restore/consolidation/review actions
   - Context Map enable/settings/entity/candidate/scan actions
   - KB enable/folders/raw/digest/dream/embedding/glossary actions
   - global settings and CLI profile auth actions

2. Create focused contract files instead of one large file:
   - `src/contracts/chat.ts` for existing chat/general contracts
   - `src/contracts/conversations.ts`
   - `src/contracts/streams.ts`
   - `src/contracts/uploads.ts`
   - `src/contracts/explorer.ts`
   - `src/contracts/memory.ts`
   - `src/contracts/contextMap.ts`
   - `src/contracts/knowledgeBase.ts`
   - `src/contracts/settings.ts`

3. Add a small shared validation helper module:
   - record/object checks
   - string/non-empty string
   - boolean
   - finite number/clamp helpers
   - string enum checks
   - array element validation
   - optional object validation

4. Move existing chat validators onto the shared helper primitives without changing behavior.

5. Add contracts for the highest-drift payloads first:
   - `CreateConversationRequest`
   - `SendMessageRequest`
   - `ConversationInputRequest`
   - `ExplorerRenameRequest`
   - `ExplorerSaveFileRequest`
   - `MemoryEnabledRequest`
   - `ContextMapSettingsRequest`
   - `ContextMapCandidateUpdateRequest`
   - `KbFolderCreateRequest`
   - `KbFolderRenameRequest`
   - `SettingsRequest`

6. Update route handlers to call validators at mutation boundaries.

7. Connect clients where import boundaries allow:
   - Mobile PWA can use type-only imports from a package-safe contract path if the tsconfig/module boundary supports it.
   - Desktop V2 can use JSDoc typedef imports initially while `api.js` remains JavaScript.
   - Do not make browser bundles import server-only runtime validator code.

8. Add contract tests:
   - valid payloads normalize as expected
   - invalid payloads fail with stable messages
   - client typechecks compile against shared types

### Verification

Focused:

```bash
npm run typecheck
npm run web:typecheck
npm run mobile:typecheck
npm test -- --runTestsByPath test/chatContracts.test.ts test/chat.rest.test.ts test/frontendRoutes.test.ts
```

Before merging this phase:

```bash
npm test
npm run adr:lint
```

### Success Criteria

- Common mutation payloads have one source of truth.
- Route handlers reject invalid payloads consistently.
- Desktop and mobile clients use shared types where practical.
- Specs reference contract files for payload ownership.
- No browser bundle imports Node-only code.

### Documentation

Update:

- `docs/spec-api-endpoints.md`
- `docs/spec-data-models.md`
- `docs/spec-frontend.md`
- `docs/spec-mobile-pwa.md`
- `docs/spec-testing.md`

### ADR

Likely yes if contracts become the durable API ownership pattern across server and clients.

## Phase 2: Continue Splitting `src/routes/chat.ts`

### Goal

Turn `src/routes/chat.ts` into a composition root plus stream orchestration shell, with focused domain routers for conversation, stream, goal, upload, explorer, memory, Context Map, and KB endpoints.

### Rationale

The file still owns too many domains. Every endpoint change requires navigating unrelated stream, storage, KB, Context Map, memory, explorer, and goal logic.

### Work Plan

1. Define a typed route context:
   - `ChatRouteContext`
   - service dependencies
   - shared callback functions
   - stream supervisor helpers
   - update fan-out helpers
   - MCP session issuers/revokers
   - scheduler/queue handles

2. Move shared utilities out of `chat.ts`:
   - `asyncHandler`
   - `requireConversation`
   - bounded integer parsing
   - workspace hash/path resolution
   - route-level error mapping
   - common broadcast helpers

3. Extract routers in a low-risk order:
   - `conversationRoutes.ts`
   - `uploadRoutes.ts`
   - `explorerRoutes.ts`
   - `streamRoutes.ts`
   - `goalRoutes.ts`
   - `memoryRoutes.ts`
   - `contextMapRoutes.ts`
   - `kbRoutes.ts`

4. Conversation router slice:
   - list/get/create/update/delete
   - archive/restore
   - unread
   - sessions/reset/download
   - queue routes if they are not moved to stream routes

5. Upload router slice:
   - upload
   - delete upload
   - OCR
   - conversation file view/download
   - artifact file serving

6. Explorer router slice:
   - workspace tree
   - preview/raw/download
   - create/save/rename/delete
   - upload prelude and overwrite handling

7. Stream router slice:
   - send message
   - input
   - abort
   - active-streams
   - stream reconciliation endpoints

8. Goal router slice:
   - goal create/update/pause/resume/clear
   - goal status
   - goal-mode send integration routes

9. Memory router slice:
   - workspace memory read/search
   - enable/disable
   - entry delete/restore/clear
   - consolidation propose/apply/draft routes
   - memory review schedule/run/action/draft routes

10. Context Map router slice:
    - enable/settings
    - graph/entity routes
    - review/candidate routes
    - scan/stop/clear
    - route-level candidate apply dependency handling

11. KB router slice:
    - workspace KB state/enable
    - raw upload/download/media/delete
    - folders
    - digestion/dreaming
    - entries/tags/topics/reflections/synthesis
    - embeddings/glossary/status

12. After each extraction:
    - confirm no endpoint path changed
    - confirm route is mounted exactly once
    - run focused tests
    - update specs if ownership or behavior text changes

### Verification

Per router:

```bash
npm run typecheck
npm test -- --runTestsByPath test/chat.rest.test.ts
```

Additional focused tests by router:

```bash
npm test -- --runTestsByPath test/chat.conversations.test.ts test/chat.messageQueue.test.ts
npm test -- --runTestsByPath test/chat.memory.test.ts test/memoryReview.test.ts
npm test -- --runTestsByPath test/chat.kb.test.ts
npm test -- --runTestsByPath test/contextMap.route.test.ts test/contextMap.service.test.ts
npm test -- --runTestsByPath test/frontendRoutes.test.ts test/streamStore.test.ts
```

Final:

```bash
npm test
npm run adr:lint
```

### Success Criteria

- `src/routes/chat.ts` mostly constructs dependencies, mounts domain routers, and exposes shutdown/reconcile handles.
- Domain routers have one clear ownership area.
- Stream lifecycle behavior remains covered by existing tests.
- No endpoint path or response shape changes unless explicitly planned and documented.

### Documentation

Update:

- `docs/spec-api-endpoints.md`
- `docs/spec-backend-services.md`
- `docs/spec-testing.md`
- feature specs for Memory, KB, Context Map, and goals as needed

### ADR

Use existing ADR-0051 unless the route context becomes a stronger architectural commitment that needs a follow-up ADR.

## Phase 3: Split `ChatService` Into Private Stores

### Goal

Keep `ChatService` as the public facade while moving storage and domain concerns into focused private stores.

### Rationale

`ChatService` still mixes workspace indexes, sessions, queue normalization, artifacts, memory, KB state, Context Map state, settings, usage, migrations, and path helpers. This increases risk when touching one domain.

### Work Plan

1. Define store boundaries:
   - `WorkspaceIndexStore`
   - `ConversationStore`
   - `SessionStore`
   - `MessageQueueStore`
   - `ArtifactStore`
   - `UsageStore`
   - `WorkspaceMemoryStore`
   - `WorkspaceKnowledgeStore`
   - `WorkspaceContextMapStore`
   - `WorkspaceInstructionStore`

2. Move pure/path helpers before stateful stores:
   - workspace hash/path helpers
   - session path helpers
   - markdown export helpers
   - queue normalization helpers

3. Extract `WorkspaceIndexStore` first:
   - load index
   - save index
   - locked read-modify-write
   - workspace lookup map rebuild support
   - default workspace handling

4. Extract `ConversationStore`:
   - create/list/get/search
   - rename/delete/archive/restore/unread
   - backend/profile/model/effort/service-tier updates

5. Extract `SessionStore`:
   - add/update message
   - reset session
   - session history
   - session messages
   - session markdown export
   - summary patching

6. Extract `ArtifactStore`:
   - upload/artifact path ownership
   - generated artifact persistence
   - MIME/kind inference through `attachments.ts`
   - filename collision handling

7. Extract `UsageStore`:
   - daily ledger writes
   - clear/read stats
   - ledger lock

8. Extract workspace feature stores:
   - memory enablement, snapshots, metadata, review persistence
   - KB enablement, state, raw/converted/entries path getters
   - Context Map enablement/settings/DB handle cache
   - instruction compatibility pointers

9. Keep public `ChatService` methods delegating to stores.

10. Only after delegation is stable, shrink private fields and remove dead helpers introduced by the move.

### Verification

Focused by store:

```bash
npm run typecheck
npm test -- --runTestsByPath test/chatService.helpers.test.ts test/chatService.conversations.test.ts
npm test -- --runTestsByPath test/chatService.messages.test.ts test/chatService.workspace.test.ts
npm test -- --runTestsByPath test/chatService.workspaceMemory.test.ts test/chatService.usage.test.ts
npm test -- --runTestsByPath test/chatService.concurrency.test.ts test/chatService.migration.test.ts
```

Integration:

```bash
npm test -- --runTestsByPath test/chat.rest.test.ts test/chat.memory.test.ts test/chat.kb.test.ts
npm test
```

### Success Criteria

- Route code still depends on `ChatService`, not individual stores.
- Store modules have narrow ownership and focused tests.
- Atomic write and keyed mutex behavior stays centralized and covered.
- Existing data files remain readable and writable with no migration required unless explicitly documented.

### Documentation

Update:

- `docs/spec-backend-services.md`
- `docs/spec-data-models.md`
- `docs/spec-testing.md`

### ADR

Likely yes if store boundaries become the permanent ChatService architecture.

## Phase 4: Extract Context Map Pipeline Stages

### Goal

Move Context Map processing stages out of `src/services/contextMap/service.ts` into focused orchestration modules while preserving processor behavior.

### Rationale

The service currently owns scheduling, source discovery, source packet construction, extraction, parser repair, normalization, synthesis, auto-apply, persistence, and update emission. JSON repair is now extracted; the next step is stage ownership.

### Work Plan

1. Define stage modules:
   - `sourceDiscovery.ts`
   - `sourcePackets.ts`
   - `extractionRunner.ts`
   - `candidateCleanup.ts`
   - `synthesisRunner.ts`
   - `autoApply.ts`
   - `runPersistence.ts`
   - `runProgress.ts`

2. Extract source discovery:
   - workspace instruction discovery
   - high-signal Markdown discovery
   - recursive Markdown selection
   - code-outline file selection
   - source cursor missing-state planning

3. Extract source packet construction:
   - conversation span packets
   - Markdown source packets
   - code-outline packets
   - packet prompt guidance
   - deterministic source hashes

4. Extract extraction runner:
   - ordered job list
   - process-wide extraction limiter integration
   - abort handling
   - parse/repair integration through `jsonRepair.ts`
   - per-unit failure handling

5. Extract candidate cleanup:
   - type alias normalization
   - candidate de-duplication
   - relationship predicate normalization
   - fact normalization
   - sensitivity correction
   - folding/dropping weak candidates

6. Extract synthesis runner:
   - threshold decision
   - chunked synthesis
   - final arbiter
   - process-wide synthesis limiter integration
   - fallback/ranked subset behavior

7. Extract auto-apply orchestration:
   - safe candidate classification
   - pending dependency handling
   - audit attribution

8. Extract persistence:
   - run row lifecycle
   - source span/cursor writes
   - candidate inserts
   - graph writes
   - update fan-out triggers

9. Keep `ContextMapService` as the facade:
   - scheduler entrypoints
   - public route-facing methods
   - dependency wiring
   - stage orchestration

### Verification

Per extraction:

```bash
npm run typecheck
npm test -- --runTestsByPath test/contextMap.jsonRepair.test.ts test/contextMap.service.test.ts
```

If stage tests are added:

```bash
npm test -- --runTestsByPath test/contextMap.sourceDiscovery.test.ts
npm test -- --runTestsByPath test/contextMap.candidateCleanup.test.ts
npm test -- --runTestsByPath test/contextMap.synthesis.test.ts
```

Final:

```bash
npm test -- --runTestsByPath test/contextMap.db.test.ts test/contextMap.mcp.test.ts test/contextMap.service.test.ts
npm test
```

### Success Criteria

- `ContextMapService` orchestrates stages instead of owning every stage inline.
- Deterministic ordering and candidate ids remain stable.
- Existing Context Map service tests pass without loosening assertions.
- New stage modules have focused tests where logic is pure enough to isolate.

### Documentation

Update:

- `docs/spec-context-map.md`
- `docs/spec-backend-services.md`
- `docs/spec-data-models.md`
- `docs/spec-testing.md`

### ADR

Probably not if this is pure decomposition under ADR-0044/ADR-0051. Write a new ADR only if stage boundaries change processing semantics or scheduler ownership.

## Phase 5: Continue V2 Decomposition From `shell.jsx`

### Goal

Move larger UI subtrees and pure helpers out of `web/AgentCockpitWeb/src/shell.jsx` while preserving the V2 runtime behavior and visual output.

### Rationale

`shell.jsx` remains a large coordination and rendering file. Extracting stable subtrees will reduce risk for future UI changes and make focused tests easier.

### Work Plan

1. Inventory top-level render subtrees:
   - app shell/root state
   - sidebar
   - chat live view
   - message feed
   - user message rendering
   - assistant body rendering
   - tool run rendering
   - composer
   - attachment tray/chips
   - queue stack/editor
   - stream error card
   - file delivery cards/viewer integration

2. Extract pure/non-state helpers first:
   - message grouping
   - progress-run collapse
   - tool-run partitioning
   - attachment display helpers
   - time/label formatting helpers

3. Extract component modules in a low-risk order:
   - `chat/UserMessageBody.jsx`
   - `chat/FileDeliveryCards.jsx`
   - `chat/AssistantBody.jsx`
   - `chat/ToolRun.jsx`
   - `chat/MessageFeed.jsx`
   - `chat/Composer.jsx`
   - `chat/AttachmentTray.jsx`
   - `chat/QueueStack.jsx`
   - `chat/StreamErrorCard.jsx`
   - `sidebar/Sidebar.jsx`

4. Keep shared UI primitives where they already live:
   - do not create a new design system layer unless repeated duplication requires it
   - preserve class names for CSS/static tests

5. Add focused tests for pure helpers:
   - grouping/collapse behavior
   - tool partitioning
   - file marker parsing already covered
   - queue helper behavior if extracted

6. Use `frontendRoutes.test.ts` as a static guard while extracting components.

7. After each component extraction:
   - run web typecheck
   - run static frontend tests
   - run web build
   - visually inspect only if a component has meaningful layout risk

### Verification

Focused:

```bash
npm run web:typecheck
npm test -- --runTestsByPath test/frontendMessageParsing.test.ts test/frontendRoutes.test.ts test/streamStore.test.ts
npm run web:build
npm run web:budget
```

If component helper tests are added:

```bash
npm test -- --runTestsByPath test/frontendMessageGrouping.test.ts test/frontendToolRun.test.ts
```

### Success Criteria

- `shell.jsx` becomes a root coordinator instead of owning every chat subtree.
- CSS class names and behavior remain stable.
- Static frontend tests remain green.
- Vite build and bundle budget stay green.
- No mobile PWA source changes are required unless a shared helper is intentionally adopted there.

### Documentation

Update:

- `docs/spec-frontend.md`
- `docs/spec-testing.md`

### ADR

Usually no. Use ADR-0051 unless extracting a new durable frontend architecture pattern.

## Phase 6: Migrate More Backend Modules to `src/utils/logger.ts`

### Goal

Adopt the structured logger in backend modules beyond `src/ws.ts`, prioritizing high-signal operational areas.

### Rationale

Consistent logs make runtime issues easier to diagnose. Redaction and log levels reduce accidental sensitive output and debug noise.

### Work Plan

1. Improve logger first with cycle-safe serialization. See Phase 7.

2. Prioritize migration targets:
   - `server.ts`
   - `src/services/updateService.ts`
   - `src/services/cliUpdateService.ts`
   - `src/services/sessionFinalizerQueue.ts`
   - `src/services/memoryReview.ts`
   - `src/services/knowledgeBase/autoDream.ts`
   - `src/services/contextMap/service.ts`
   - backend adapters where logs are operational and not test-sensitive

3. Use child loggers:
   - `{ subsystem: 'server' }`
   - `{ subsystem: 'update' }`
   - `{ subsystem: 'cli-update' }`
   - `{ subsystem: 'session-finalizer' }`
   - `{ subsystem: 'memory-review' }`
   - `{ subsystem: 'kb-auto-dream' }`
   - `{ subsystem: 'context-map' }`
   - `{ subsystem: 'backend', backend: '<id>' }`

4. Convert one module per slice:
   - replace direct `console.log/warn/error`
   - preserve message meaning
   - avoid logging prompt content, user message content, file contents, tokens, cookies, auth payloads, or full environment maps
   - prefer identifiers, counts, durations, statuses, and error messages

5. Update tests that assert exact log strings only when needed.

6. Add logger tests for:
   - Error object serialization
   - nested redaction
   - cyclic metadata
   - max-depth/max-array handling if added

### Verification

Per module:

```bash
npm run typecheck
npm test -- --runTestsByPath test/logger.test.ts
```

Targeted:

```bash
npm test -- --runTestsByPath test/graceful-shutdown.test.ts test/updateService.test.ts test/cliUpdateService.test.ts
npm test -- --runTestsByPath test/memoryReview.test.ts test/contextMap.service.test.ts
```

Final:

```bash
npm test
```

### Success Criteria

- Migrated modules use structured logs consistently.
- Redaction behavior is covered by tests.
- Debug-only logs are gated by `LOG_LEVEL=debug`.
- Operational info/warn/error logs remain useful without exposing sensitive content.

### Documentation

Update:

- `docs/spec-backend-services.md`
- `docs/spec-server-security.md`
- `docs/spec-deployment.md`
- `docs/spec-testing.md`

### ADR

No new ADR needed if this continues ADR-0051. Write one only if logger output format or operational policy becomes externally supported.

## Phase 7: Add Cycle-safe Logger Metadata Serialization

### Goal

Make `src/utils/logger.ts` robust when callers pass cyclic objects, `Error` instances, arrays with repeated references, large metadata objects, or non-JSON primitives.

### Rationale

The current logger uses `JSON.stringify()` after redaction. Future logger migration could accidentally pass a cyclic object and throw while handling an operational event.

### Work Plan

1. Add `safeLogValue(value, options)`:
   - uses a `WeakSet` for seen objects
   - returns `"[Circular]"` for cycles
   - serializes `Error` as `{ name, message, stack? }`
   - serializes `Date` as ISO string
   - serializes `bigint` as string
   - serializes functions/symbols as readable placeholders
   - handles arrays recursively
   - handles plain objects recursively

2. Add bounds:
   - max depth, default 6
   - max array length, default 50
   - max object keys, default 50
   - max string length, default 2000

3. Preserve redaction:
   - redact before or during serialization
   - any key matching the secret regex becomes `"[REDACTED]"`
   - redaction must apply even inside cyclic structures before cycle replacement

4. Update `sanitizeLogMeta()` or replace it with a clearer name while preserving existing exports if tests/imports use it.

5. Update `writeLog()` to use safe serialization and never throw on bad metadata.

6. Add tests:
   - cyclic object does not throw
   - repeated object reference does not throw
   - nested secret key redacts
   - `Error` metadata serializes to message/name
   - large array/object truncates
   - invalid `LOG_LEVEL` still defaults to `info`

### Verification

```bash
npm run typecheck
npm test -- --runTestsByPath test/logger.test.ts test/graceful-shutdown.test.ts
```

### Success Criteria

- Logger calls cannot throw because metadata is cyclic or too large.
- Redaction still applies recursively.
- Existing logger public API remains compatible.
- Tests cover edge cases.

### Documentation

Update:

- `docs/spec-backend-services.md`
- `docs/spec-server-security.md`
- `docs/spec-testing.md`

### ADR

No new ADR needed unless serialization limits become a supported operational contract.

## Phase Ordering Recommendation

Use this order to reduce conflict and maximize verification:

1. Phase 7: make logger serialization cycle-safe before migrating more modules.
2. Phase 1: expand contracts for high-drift payloads.
3. Phase 2: split route modules, using the new contracts.
4. Phase 3: split ChatService stores behind the facade.
5. Phase 4: extract Context Map stages.
6. Phase 5: decompose V2 UI.
7. Phase 6: migrate additional backend modules to logger as ongoing cleanup after cycle-safe serialization exists.

If the branch needs to stay smaller, split this plan into separate PR-sized chunks:

- PR A: logger serialization + logging docs/tests.
- PR B: contracts expansion.
- PR C: route module extraction.
- PR D: ChatService store extraction.
- PR E: Context Map stage extraction.
- PR F: V2 component extraction.
- PR G: additional logger migrations.

## Cross-phase Review Checklist

Run this checklist after every phase:

- Are endpoint paths unchanged?
- Are response shapes unchanged?
- Did any runtime validation behavior change? If yes, is it documented and tested?
- Did desktop V2 still compile/build?
- Did mobile PWA still compile/build when API contracts changed?
- Did specs under `docs/` reflect the new source layout and behavior?
- Is an ADR required?
- Did new modules introduce circular imports?
- Did any moved code lose test coverage?
- Did any logger migration expose sensitive data?
- Did any low-impact cleanup sneak into a behavior-sensitive slice?

## Final Verification for the Full Plan

Run all of this after the final phase:

```bash
npm run typecheck
npm run web:typecheck
npm run mobile:typecheck
npm run web:build
npm run web:budget
npm run mobile:build
npm test
npm run adr:lint
npm audit
npm audit --prefix mobile/AgentCockpitPWA
```

## Definition of Done

- `src/routes/chat.ts` has clear composition-root responsibilities and domain routers own their endpoint groups.
- `src/contracts/` covers the highest-risk shared mutation payloads.
- Desktop V2 and mobile PWA use shared contract types where practical.
- `ChatService` delegates major storage concerns to private stores while preserving its public API.
- Context Map processor stages have focused modules and tests for pure logic.
- `shell.jsx` is reduced by moving major chat UI subtrees into focused modules.
- Logger metadata serialization is cycle-safe.
- Additional backend modules use structured logging without sensitive metadata leaks.
- Specs, tests, and ADRs are updated.
- Final verification passes.
