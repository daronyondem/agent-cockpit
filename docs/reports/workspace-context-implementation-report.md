# Workspace Context Implementation Report

Date: 2026-05-19

This report documents the implementation and review record for replacing Context
Map with markdown-first Workspace Context.

## Success Criteria

- Replace the old Context Map graph/candidate/MCP implementation with Workspace Context.
- Store canonical workspace learning as markdown under `workspaces/{hash}/workspace-context/`.
- Install a managed `AGENTS.md` reference to the generated Workspace Context instructions.
- Keep Workspace Context markdown read-only in the UI; users change learning by asking the CLI.
- Keep scheduled catch-up and reset/archive finalizer timing, but route processing through the Workspace Context markdown processor.
- Remove old graph, candidate review, source-bundle, MCP, and data-classification-specific Workspace Context behavior.
- Rename product/docs/UI from Context Map to Workspace Context now, keeping only legacy migration and historical ADR references.
- Run Claude Code Opus 4.7 max-effort documentation review as Phase 10.
- Verify with focused and repo-level tests.

## Implementation Summary

- Deleted the old Context Map graph subsystem under `src/services/contextMap/`, its routes, contract, report script, and old tests.
- Added `src/services/workspaceContext/` with markdown storage, generated instructions, run state, background processing, scheduler, and reset/archive processing.
- Added Workspace Context routes under `/api/chat/workspaces/:hash/workspace-context/*`.
- Migrated global and workspace settings from legacy `contextMap` fields to `workspaceContext` fields.
- Removed Context Map MCP injection from active chat sessions.
- Updated the V2 web settings UI to show Workspace Context processor settings, run controls, and read-only markdown previews.
- Added Workspace Context stream notifications in the composer.
- Updated specs, user docs, AGENTS guidance, ADR metadata, and a new ADR-0068.
- Ran the required Claude Code Opus 4.7 max-effort documentation pass.

## Phase 1: Worktree Cleanup And Old Graph Removal

Goal: remove the old Context Map graph implementation and prevent accidental reuse.

Review 1:
- Finding: old graph services were still present and would keep stale imports alive.
- Fix: removed `src/services/contextMap/*`.

Review 2:
- Finding: old Context Map route implementation still exposed graph/candidate endpoints.
- Fix: removed `src/routes/chat/contextMapRoutes.ts`.

Review 3:
- Finding: old shared contract could still be imported by clients.
- Fix: removed `src/contracts/contextMap.ts`.

Review 4:
- Finding: the old report script depended on the deleted graph schema.
- Fix: removed `scripts/context-map-report.ts` and the `context-map:report` npm script.

Review 5:
- Finding: old graph tests preserved deleted behavior.
- Fix: removed the old `contextMap.*` and `chat.contextMap` tests.

Review 6:
- Finding: maintainability allowlist still referenced the deleted MCP module.
- Fix: removed the obsolete allowlist entry from `scripts/check-maintainability.js`.

Review 7:
- Finding: generated build output could contain stale Context Map strings.
- Fix: excluded ignored build output from source sanity checks; no tracked stale build files were kept.

Review 8:
- Finding: legacy install data still needs one-way migration.
- Fix: retained only explicit legacy `contextMap` field handling in settings/workspace index normalization.

Review 9:
- Finding: historical ADRs still reference deleted files.
- Fix: marked superseded Context Map ADRs archival and updated current ADR `affects` metadata to live Workspace Context paths.

Review 10:
- Finding: no additional high/medium issues found in removal scope.
- Fix: none.

## Phase 2: Workspace Context Markdown Service

Goal: add the markdown-first backend service and canonical filesystem layout.

Review 1:
- Finding: Workspace Context needed stable defaults outside settings code.
- Fix: added `src/services/workspaceContext/defaults.ts`.

Review 2:
- Finding: service needed to create a useful initial markdown structure.
- Fix: added `WORKSPACE_CONTEXT.md`, `context/overview.md`, `runs/`, and `state.json` creation.

Review 3:
- Finding: agent instructions needed to be discoverable by normal CLI filesystem behavior.
- Fix: added managed `AGENTS.md` block installation and repair.

Review 4:
- Finding: the generated instructions needed the existing markdown operating-memory mental model, not atomic facts.
- Fix: instruction text asks the CLI to maintain durable markdown, preserve temporal perspective, and organize people/projects/threads naturally.

Review 5:
- Finding: file preview must not allow traversal outside the context folder.
- Fix: `readFile()` normalizes requested paths and rejects absolute or parent-path escapes.

Review 6:
- Finding: stopped runs were being recorded with generic/manual metadata.
- Fix: preserved the active run source, start time, and file list when recording stopped runs.

Review 7:
- Finding: canonical markdown should be written by the configured processor, not parsed from JSON.
- Fix: background prompt asks the processor CLI to edit files directly and returns only a short completion summary.

Review 8:
- Finding: Workspace Context must not introduce data-classification gates.
- Fix: no classification-specific fields, prompts, filters, or route behavior exist in the Workspace Context service.

Review 9:
- Finding: runtime failures need durable operator visibility.
- Fix: run records persist `completed`, `failed`, and `stopped` status plus summary/error metadata.

Review 10:
- Finding: no additional high/medium issues found in service scope.
- Fix: none.

## Phase 3: Runtime Integration

Goal: wire Workspace Context into settings, chat routes, scheduler, and finalizers.

Review 1:
- Finding: fresh settings needed Workspace Context defaults.
- Fix: added `settings.workspaceContext` defaults with scan interval and concurrency.

Review 2:
- Finding: old `contextMap` persisted settings would otherwise be lost or keep stale fields.
- Fix: migrated legacy global settings into `workspaceContext` and stripped removed extraction/synthesis/source fields.

Review 3:
- Finding: old workspace index flags needed migration.
- Fix: migrated `contextMapEnabled/contextMap` to `workspaceContextEnabled/workspaceContext`.

Review 4:
- Finding: old `context-map/` workspace folders should not remain as active data.
- Fix: workspace feature normalization removes legacy `context-map/` folders.

Review 5:
- Finding: session reset/archive finalizer still named old Context Map jobs.
- Fix: renamed finalizer type to `workspace_context_conversation_final_pass`.

Review 6:
- Finding: active chat injection still contained Context Map MCP assumptions.
- Fix: removed Workspace Context MCP injection from conversation and stream routes.

Review 7:
- Finding: scheduled processing should keep the existing five-minute catch-up behavior.
- Fix: added `WorkspaceContextScheduler` using enabled workspace hashes, scan intervals, and global concurrency.

Review 8:
- Finding: reset/archive finalizer source needed validation.
- Fix: route integration validates finalizer source and records `session_reset` or `archive`.

Review 9:
- Finding: route consumers need fresh status after settings and run operations.
- Fix: added Workspace Context status helpers on `ChatService` and update emission.

Review 10:
- Finding: no additional high/medium issues found in runtime integration.
- Fix: none.

## Phase 4: API Surface

Goal: expose only the markdown-first Workspace Context controls.

Review 1:
- Finding: API needed browser-safe request validation.
- Fix: added `src/contracts/workspaceContext.ts`.

Review 2:
- Finding: enablement route needed to install or remove instructions.
- Fix: `PUT /workspace-context/enabled` now ensures or uninstalls managed Workspace Context instructions.

Review 3:
- Finding: manual catch-up should not block HTTP requests.
- Fix: scan route starts background processing and returns immediately.

Review 4:
- Finding: users need a safe stop path for long processor runs.
- Fix: added `/scan/stop` and service abort handling.

Review 5:
- Finding: settings writes needed profile/model/effort normalization.
- Fix: route delegates to `ChatService` workspace settings normalization.

Review 6:
- Finding: read-only preview needs file listing plus safe file reads.
- Fix: added `/files` and `/files/*` routes backed by service path checks.

Review 7:
- Finding: destructive clear should not race with active processing.
- Fix: `DELETE /workspace-context` returns 409 while a run is active.

Review 8:
- Finding: instruction repair should be explicit and idempotent.
- Fix: added `/repair-instructions`.

Review 9:
- Finding: removed old graph endpoints should not be documented as supported.
- Fix: specs now list old Context Map endpoints as removed.

Review 10:
- Finding: no additional high/medium API issues found.
- Fix: none.

## Phase 5: Frontend Workspace Context Experience

Goal: replace graph/candidate UI with simple settings, run controls, and markdown preview.

Review 1:
- Finding: global Settings still exposed old processor knobs.
- Fix: global Workspace Context tab now shows only CLI profile/model/effort, scan interval, and concurrency.

Review 2:
- Finding: workspace settings still had graph/candidate-oriented sections.
- Fix: replaced with overview, processor, files, runs, and danger sections.

Review 3:
- Finding: UI could imply user approval/review workflow.
- Fix: removed Needs Attention/candidate/review controls and copy.

Review 4:
- Finding: markdown preview must be read-only.
- Fix: files tab renders loaded markdown content without edit controls.

Review 5:
- Finding: composer notification should point to operational status, not a graph review queue.
- Fix: composer icon opens Workspace Context run status.

Review 6:
- Finding: stale CSS names still used `ws-cm` and `state-context-map`.
- Fix: renamed current selectors to `ws-wc`, `state-workspace-context`, and `ws-form-workspace-context`.

Review 7:
- Finding: stream updates needed a new frame name.
- Fix: frontend store handles `workspace_context_update`.

Review 8:
- Finding: API helper names still exposed Context Map concepts.
- Fix: replaced frontend API helpers with Workspace Context settings/files/run helpers.

Review 9:
- Finding: global/workspace tabs needed consistent naming.
- Fix: updated tab labels and settings copy to Workspace Context.

Review 10:
- Finding: no additional high/medium frontend issues found.
- Fix: none.

## Phase 6: Tests And Fixtures

Goal: replace old graph tests with focused Workspace Context regression coverage.

Review 1:
- Finding: service behavior needed direct filesystem tests.
- Fix: added `test/workspaceContext.service.test.ts`.

Review 2:
- Finding: route behavior needed API-level coverage.
- Fix: added `test/chat.workspaceContext.test.ts`.

Review 3:
- Finding: workspace settings migration needed regression coverage.
- Fix: updated `test/chat.workspaceFeatureSettingsStore.test.ts`.

Review 4:
- Finding: global settings migration and stale-field stripping needed coverage.
- Fix: updated `test/settingsService.test.ts`.

Review 5:
- Finding: conversation status serialization needed contract coverage.
- Fix: updated `test/chatContracts.test.ts`.

Review 6:
- Finding: finalizer queue job type changed.
- Fix: updated `test/sessionFinalizerQueue.test.ts`.

Review 7:
- Finding: frontend static tests still expected graph/candidate UI.
- Fix: updated `test/frontendRoutes.test.ts`.

Review 8:
- Finding: stream store needed event coverage for Workspace Context status patches.
- Fix: updated `test/streamStore.test.ts`.

Review 9:
- Finding: test environment still constructed old dependencies.
- Fix: updated `test/helpers/chatEnv.ts` to provide Workspace Context service dependencies.

Review 10:
- Finding: no additional high/medium test gaps found after focused pass.
- Fix: none.

## Phase 7: Documentation And Specs

Goal: make current documentation describe Workspace Context as the real system.

Review 1:
- Finding: root spec index still pointed to Context Map.
- Fix: updated root and docs SPEC indexes to Workspace Context.

Review 2:
- Finding: API docs still described graph/candidate endpoints.
- Fix: updated `docs/spec-api-endpoints.md`.

Review 3:
- Finding: backend service docs still described graph extraction.
- Fix: updated `docs/spec-backend-services.md`.

Review 4:
- Finding: data model docs still described SQLite graph tables as current.
- Fix: updated `docs/spec-data-models.md` to markdown folder/run state.

Review 5:
- Finding: frontend docs still described graph and review queue UI.
- Fix: updated `docs/spec-frontend.md`.

Review 6:
- Finding: testing docs still referenced old suites.
- Fix: updated `docs/spec-testing.md` and `docs/spec-coverage.md`.

Review 7:
- Finding: user docs still had Context Map entry.
- Fix: replaced `docs/user/context-map.md` with `docs/user/workspace-context.md` and updated user indexes.

Review 8:
- Finding: product positioning still named the old feature.
- Fix: updated positioning and quickstart language to Workspace Context.

Review 9:
- Finding: stale Context Map spec/design files could mislead readers.
- Fix: converted them into compatibility stubs pointing to Workspace Context.

Review 10:
- Finding: no additional high/medium documentation issues found in current specs.
- Fix: none.

## Phase 8: ADR And Agent Guidance

Goal: document the decision and keep agent workflow guidance aligned.

Review 1:
- Finding: replacing graph storage is hard to reverse and crosses subsystems.
- Fix: added ADR-0068.

Review 2:
- Finding: old Context Map ADRs needed explicit supersession metadata.
- Fix: marked ADR-0044, ADR-0045, and ADR-0046 as superseded by ADR-0068.

Review 3:
- Finding: current cross-cutting ADRs had stale `affects` paths to deleted files.
- Fix: updated affected frontmatter to live Workspace Context paths or removed obsolete report-script path.

Review 4:
- Finding: ADR index was stale after metadata changes.
- Fix: regenerated `docs/adr/README.md` with `scripts/adr-index.js`.

Review 5:
- Finding: AGENTS still instructed future agents to use Context Map modules.
- Fix: updated AGENTS to Workspace Context guidance and a no-graph/no-candidate/no-MCP boundary.

Review 6:
- Finding: project memory doc still referred to Context Map.
- Fix: updated `docs/agent-project-memory.md`.

Review 7:
- Finding: release/update docs mentioned the old report script.
- Fix: removed the deleted script from current docs/metadata.

Review 8:
- Finding: historical ADR content remains old by design.
- Fix: no content rewrite; only frontmatter was updated where needed for supersession/path validity.

Review 9:
- Finding: ADR lint needed validation after metadata changes.
- Fix: ran `npm run adr:lint`; it passed.

Review 10:
- Finding: no additional high/medium ADR or agent-guidance issues found.
- Fix: none.

## Phase 9: Cleanup And Stale Reference Pass

Goal: remove technical debt from the rename and deletion.

Review 1:
- Finding: CSS had stale `ws-cm-*` selectors.
- Fix: renamed active Workspace Context styles to `ws-wc-*`.

Review 2:
- Finding: JS state class used old `state-context-map`.
- Fix: renamed to `state-workspace-context`.

Review 3:
- Finding: seeded E2E settings still included extraction/synthesis concurrency.
- Fix: removed old seeded fields from `scripts/run-claude-interactive-ui-e2e.ts`.

Review 4:
- Finding: `package.json` still exposed the old report script.
- Fix: removed `context-map:report`.

Review 5:
- Finding: stale `Context Map` strings remained in current code searches.
- Fix: reduced current code hits to legacy migration names and historical/compatibility docs only.

Review 6:
- Finding: classification-specific Workspace Context checks could accidentally remain after earlier experiments.
- Fix: targeted search confirmed no Workspace Context classification-gate references; Memory redaction references remain unrelated.

Review 7:
- Finding: old graph endpoints could drift back through docs.
- Fix: current Workspace Context spec explicitly marks them unsupported.

Review 8:
- Finding: deleted old files could be revived by generated output.
- Fix: generated build artifacts are ignored and were not added to tracked changes.

Review 9:
- Finding: mobile PWA impact needed evaluation.
- Fix: no mobile source behavior changed; mobile typecheck and build passed.

Review 10:
- Finding: no additional high/medium cleanup issues found.
- Fix: none.

## Phase 10: Claude Code Opus 4.7 Max-Effort Documentation Pass

Goal: use Claude Code with Opus 4.7 max effort to review and revise technical and end-user markdown docs, excluding historical ADR content.

Review 1:
- Finding: README public copy still described Context Map.
- Fix: Claude docs pass updated README to Workspace Context.

Review 2:
- Finding: root SPEC redirect/index language still had old naming.
- Fix: Claude docs pass updated root SPEC language.

Review 3:
- Finding: AGENTS guidance needed final wording cleanup.
- Fix: Claude docs pass revised Workspace Context guidance.

Review 4:
- Finding: historical ADRs should not be content-rewritten by docs pass.
- Fix: docs pass left ADR bodies unchanged.

Review 5:
- Finding: docs pass surfaced ADR lint risk from deleted paths.
- Fix: followed up with ADR frontmatter corrections and ADR lint.

Review 6:
- Finding: docs pass should not touch source/tests.
- Fix: confirmed only docs/AGENTS/README/SPEC were affected by that pass.

Review 7:
- Finding: compatibility stubs needed to remain concise.
- Fix: verified current `docs/spec-context-map.md` and `docs/design-context-map.md` are short pointers, not stale full docs.

Review 8:
- Finding: user-facing docs should not describe approval queues.
- Fix: current user Workspace Context docs describe inspection, run controls, and markdown preview only.

Review 9:
- Finding: no additional high/medium docs issues found after the Opus pass.
- Fix: none.

Review 10:
- Finding: no additional high/medium docs issues found in final docs scan.
- Fix: none.

## Final 10-Cycle Review

Final Review 1:
- Finding: TypeScript boundaries could have stale imports after deleting Context Map.
- Fix: ran root typecheck; it passed.

Final Review 2:
- Finding: web code could have stale API/helper names.
- Fix: ran web typecheck; it passed.

Final Review 3:
- Finding: focused Workspace Context routes/service/settings/frontend tests needed to prove the new behavior.
- Fix: ran the focused Jest set; 9 suites and 184 tests passed.

Final Review 4:
- Finding: maintainability rules could still reference deleted modules.
- Fix: ran `npm run maintainability:check`; it passed.

Final Review 5:
- Finding: route/docs drift could have appeared after route replacement.
- Fix: ran `npm run spec:drift`; it passed with 142 documented route declarations.

Final Review 6:
- Finding: ADR metadata could still fail after supersession changes.
- Fix: ran `npm run adr:lint`; all 67 ADRs passed.

Final Review 7:
- Finding: broader Jest coverage could catch regressions outside Workspace Context.
- Fix: ran full Jest; 92 suites passed, 1 skipped, 2023 tests passed, 9 skipped.

Final Review 8:
- Finding: production web bundle could fail or exceed budget after UI edits.
- Fix: ran `npm run web:build` and `npm run web:budget`; both passed.

Final Review 9:
- Finding: mobile PWA compatibility should be checked even without mobile source edits.
- Fix: ran `npm run mobile:typecheck` and `npm run mobile:build`; both passed.

Final Review 10:
- Finding: final stale-reference and whitespace checks needed a last pass.
- Fix: ran targeted `rg` checks for old Context Map UI/code names and Workspace Context classification-gate terms, plus `git diff --check`; no high/medium issues remained.

## Verification Commands

- `npm run typecheck` - passed.
- `npm run web:typecheck` - passed.
- `npm test -- test/workspaceContext.service.test.ts test/chat.workspaceContext.test.ts test/frontendRoutes.test.ts test/streamStore.test.ts test/settingsService.test.ts test/chatService.workspace.test.ts test/chat.workspaceFeatureSettingsStore.test.ts test/sessionFinalizerQueue.test.ts test/chatContracts.test.ts --runInBand` - passed, 9 suites / 184 tests.
- `npm run maintainability:check` - passed.
- `npm run spec:drift` - passed, 142 documented route declarations.
- `npm run adr:lint` - passed, 67 ADRs.
- `npm test -- --runInBand` - passed, 92 suites passed / 1 skipped, 2023 tests passed / 9 skipped.
- `npm run web:build` - passed.
- `npm run web:budget` - passed, JS 786.3 KiB / 850.0 KiB, CSS 192.4 KiB / 230.0 KiB.
- `npm run mobile:typecheck` - passed.
- `npm run mobile:build` - passed.
- `git diff --check` - passed.

## Remaining Notes

- Historical ADR bodies still describe Context Map because ADRs are retained as decision history. Current specs, user docs, AGENTS guidance, routes, services, contracts, tests, and UI now describe Workspace Context.
- Legacy `contextMap` field names remain only in migration code and migration documentation so existing installs can be normalized into `workspaceContext`.
- No PR was created.
