# Frontend Surface Split Review Report

This report tracks maintainability item #4: split the large desktop and mobile
frontend surfaces without changing behavior or visual design.

## Scope

- Desktop: reduce `web/AgentCockpitWeb/src/shell.jsx` by moving chat rendering,
  composer/live-chat, shell/welcome, and related private helpers into focused
  modules.
- Desktop CSS: split `web/AgentCockpitWeb/src/app.css` by owned surface after
  component ownership is clearer.
- Mobile: reduce `mobile/AgentCockpitPWA/src/App.tsx` by moving model hooks,
  screens, modals, and rendering components into focused modules.
- Mobile CSS: split `mobile/AgentCockpitPWA/src/styles.css` by owned surface
  after component ownership is clearer.
- Preserve behavior, storage formats, routes, public contracts, and visual
  design.

## Baseline Verification

- `npm test -- --runTestsByPath test/frontendRoutes.test.ts test/mobileAppModel.test.ts test/streamStore.test.ts`
- `npm run typecheck`
- `npm run web:typecheck`
- `npm run mobile:typecheck`
- `npm run web:build`
- `npm run mobile:build`
- `npm run web:budget`

All baseline commands passed before extraction began. Existing Vite warnings
about unresolved `/icons/deepseek-logo.svg` and `/icons/opencode-logo-*.svg`
were observed during web/mobile builds and left unchanged because the build
already treats them as runtime-resolved public assets.

## Phase 0 Review Cycles

### Cycle 1

- Finding: Medium impact. The requested phased review workflow needs a durable
  repo record; a final chat summary alone is too easy to lose.
- Implemented: Created this review report before frontend code extraction.

### Cycle 2

- Finding: Medium impact. Existing source-string guards in
  `test/frontendRoutes.test.ts` assert that behavior lives in the old large
  entry files, so naive extraction would either fail tests or invite deleting
  useful guards.
- Implemented: Added the acceptance rule that each extraction must move the
  relevant guard to the new owning file while preserving the behavior being
  guarded.

### Cycle 3

- Finding: Medium impact. The desktop JavaScript bundle budget is close to the
  configured ceiling, so even behavior-preserving module moves could mask a
  chunking or dependency regression.
- Implemented: Added `npm run web:budget` to the baseline and final
  verification set; extraction phases must rerun it when desktop imports move.

### Cycle 4

- Finding: Medium impact. CSS ownership should follow component ownership;
  splitting CSS first would create naming churn without clarifying runtime
  boundaries.
- Implemented: Kept CSS splitting as later desktop/mobile phases, after the
  corresponding component modules exist.

### Cycle 5

- Finding: Medium impact. Desktop `shell.jsx` currently both defines the app
  surfaces and bootstraps React, so extracting `App` immediately would couple a
  structural change to the bootstrap path.
- Implemented: Phase 1 starts with pure chat render modules and leaves the
  bootstrap path stable.

### Cycle 6

- Finding: Medium impact. Mobile extraction has stronger TypeScript guardrails
  than desktop extraction, but the large `App.tsx` state graph means hooks
  should be extracted before visual screens.
- Implemented: Ordered mobile work as hooks/model boundaries first, then
  screens/components, then CSS.

### Cycle 7

- Finding: Medium impact. Mobile PWA parity must be explicitly checked even
  when desktop-only files move, because shared tests and docs cover both
  clients together.
- Implemented: Kept mobile typecheck/build and mobile model tests in the
  verification set for the whole goal.

### Cycle 8

- Finding: Medium impact. This is a broad maintainability change but does not
  introduce a new public API, data model, dependency, or hard-to-reverse runtime
  decision.
- Implemented: No ADR is planned unless a later phase introduces a recurring
  architectural rule beyond file ownership and module extraction.

### Cycle 9

- Finding: Medium impact. Spec drift can happen even for refactors because the
  docs name source files and ownership boundaries.
- Implemented: Final verification must include `npm run spec:drift`; source
  coverage docs must be updated alongside moved ownership.

### Cycle 10

- Finding: Medium impact. Maintainability rules require the repository
  maintainability check before PR, and this work directly targets that concern.
- Implemented: Final verification must include `npm run maintainability:check`
  in addition to focused tests, typechecks, builds, and spec drift.

## Phase 1 Review Cycles

Phase 1 extracted desktop chat rendering from `shell.jsx` into focused modules:

- `web/AgentCockpitWeb/src/chat/messageModel.js`
- `web/AgentCockpitWeb/src/chat/chatTime.js`
- `web/AgentCockpitWeb/src/chat/toolRuns.jsx`
- `web/AgentCockpitWeb/src/chat/messageContent.jsx`
- `web/AgentCockpitWeb/src/chat/messageFeed.jsx`

Verification run during the phase:

- `npm test -- --runTestsByPath test/frontendRoutes.test.ts`
- `npm run web:typecheck`
- `npm run web:build`
- `npm run web:budget`
- `npm run spec:drift`

### Cycle 1

- Finding: Medium impact. The extraction changed two fallback file-card glyphs
  from the original document glyph to the text fallback `File`, and changed two
  tool elapsed placeholders from the original ellipsis glyph to three periods.
- Implemented: Restored the original fallback glyphs/placeholders in
  `chat/messageContent.jsx` and `chat/toolRuns.jsx`.

### Cycle 2

- Finding: No high- or medium-impact issue. Import boundaries stay browser-only:
  new chat modules import React, frontend primitives, chat helpers, and
  browser-safe file-link helpers only.
- Implemented: No change required.

### Cycle 3

- Finding: No high- or medium-impact issue. Source-string guard tests were
  moved to the new owning files instead of removed, preserving route/build
  guard intent.
- Implemented: No change required.

### Cycle 4

- Finding: No high- or medium-impact issue. Vite chunking stayed within the
  configured web bundle budget after moving module boundaries.
- Implemented: No change required.

### Cycle 5

- Finding: No high- or medium-impact issue. `ChatLive` still owns feed state,
  scroll restoration, paging, and side effects; the new modules own rendering
  only.
- Implemented: No change required.

### Cycle 6

- Finding: No high- or medium-impact issue. Plan approval Markdown still uses
  the same sanitized renderer via `renderMarkdown`, so plan cards and assistant
  text share the existing Markdown behavior.
- Implemented: No change required.

### Cycle 7

- Finding: No high- or medium-impact issue. The `FileViewerContext` provider
  still gets the same workspace id, working directory, execution directory,
  conversation id, file viewer opener, and lightbox opener from `ChatLive`.
- Implemented: No change required.

### Cycle 8

- Finding: No high- or medium-impact issue. Goal lifecycle cards still render
  through the same `goalStatusLabel` semantics, now from `chat/messageFeed.jsx`.
- Implemented: No change required.

### Cycle 9

- Finding: No high- or medium-impact issue. Spec files now describe the new
  chat-render module ownership and source coverage.
- Implemented: No change required.

### Cycle 10

- Finding: No high- or medium-impact issue. The desktop shell dropped from
  4,937 lines at baseline to 3,788 lines after Phase 1, while the extracted
  chat modules are focused and under 500 lines each.
- Implemented: No change required.

## Phase 2 Review Cycles

Phase 2 extracted the desktop live-chat container and composer surfaces from
`shell.jsx` into focused chat modules:

- `web/AgentCockpitWeb/src/chat/chatHelpers.js`
- `web/AgentCockpitWeb/src/chat/chatLive.jsx`
- `web/AgentCockpitWeb/src/chat/composer.jsx`
- `web/AgentCockpitWeb/src/chat/composerNotifications.jsx`
- `web/AgentCockpitWeb/src/chat/contextChip.jsx`
- `web/AgentCockpitWeb/src/chat/fileViewerPanel.jsx`
- `web/AgentCockpitWeb/src/chat/chatStatusCards.jsx`

Verification run during the phase:

- `npm test -- --runTestsByPath test/frontendRoutes.test.ts`
- `npm run web:typecheck`
- `npm run web:build`

### Cycle 1

- Finding: Medium impact. The first extraction left `chatLive.jsx` above 1,300
  lines and still owning secondary UI helpers that can be reasoned about
  independently from feed paging and container side effects.
- Implemented: Extracted `ContextChip`, `FileViewerPanel`, and feed-adjacent
  status/interaction cards into `contextChip.jsx`, `fileViewerPanel.jsx`, and
  `chatStatusCards.jsx`.

### Cycle 2

- Finding: High impact. Composer notification helpers stayed in `composer.jsx`
  and referenced dependencies that were not explicit at their new boundary,
  making notification regressions easy to miss at runtime.
- Implemented: Extracted all composer dashboard notifications into
  `composerNotifications.jsx` with explicit `CliUpdateStore`, `Tip`,
  `useCliUpdates`, toast, and workspace-helper imports.

### Cycle 3

- Finding: Medium impact. Source-string coverage still asserted old owner files
  for live-chat, notification, instruction-compatibility, Workspace Context,
  and Memory Review behavior.
- Implemented: Moved those guards in `test/frontendRoutes.test.ts` to
  `chatLive.jsx`, `composer.jsx`, `composerNotifications.jsx`, and
  `contextChip.jsx` while preserving the guarded behavior.

### Cycle 4

- Finding: Medium impact. The spec still described `ChatLive`, `ContextChip`,
  OCR insertion, and queue enqueue behavior as living in `shell.jsx`.
- Implemented: Updated `docs/spec-frontend.md` with the new chat module owner
  list and corrected the owner references for `ChatLive`, `ContextChip`,
  composer OCR, and enqueue behavior.

### Cycle 5

- Finding: Medium impact. Coverage rows still pointed several desktop feature
  surfaces at `shell.jsx`, which would mislead future spec updates.
- Implemented: Updated `docs/spec-coverage.md` rows for backend goals,
  attachments/file delivery, worktree-aware chat surfaces, Memory Review, and
  Workspace Context to include the new focused chat modules.

### Cycle 6

- Finding: No high- or medium-impact issue. `ChatLive` still owns the stateful
  feed responsibilities: paging, scroll restoration, pinned-message jumps,
  topbar conversation actions, and drag-and-drop.
- Implemented: No change required.

### Cycle 7

- Finding: No high- or medium-impact issue. `FileViewerContext` still passes
  the same workspace reference, working directory, execution directory,
  conversation id, file viewer opener, and lightbox opener to message content.
- Implemented: No change required.

### Cycle 8

- Finding: No high- or medium-impact issue. Plan approval and question cards
  still call the same `StreamStore.respond` paths and continue to sanitize plan
  Markdown through `renderMarkdown`.
- Implemented: No change required.

### Cycle 9

- Finding: No high- or medium-impact issue. Vite build output and source
  guards pass after moving module boundaries; the existing public-icon warnings
  remain unchanged runtime-resolved asset warnings.
- Implemented: No change required.

### Cycle 10

- Finding: No high- or medium-impact issue. `shell.jsx` is now 1,051 lines,
  `chatLive.jsx` is 896 lines, and `composer.jsx` is 721 lines after the Phase
  2 splits; the newly extracted helper modules are focused and below 715 lines.
- Implemented: No change required.

## Phase 3 Review Cycles

Phase 3 split the remaining desktop bootstrap/app-shell/welcome surface:

- `web/AgentCockpitWeb/src/shell.jsx` now owns only React bootstrap and provider
  composition.
- `web/AgentCockpitWeb/src/appShell.jsx` owns desktop route/view coordination,
  sidebar state, silent re-auth, update/folder-picker modals, and lazy screen
  loading.
- `web/AgentCockpitWeb/src/welcomeScreen.jsx` owns the Welcome/install-doctor
  setup flow.
- `web/AgentCockpitWeb/src/chatErrorBoundary.jsx` owns the conversation render
  boundary.

Verification run during the phase:

- `npm test -- --runTestsByPath test/frontendRoutes.test.ts`
- `npm run web:typecheck`
- `npm run web:build`
- `npm run web:budget`
- `npm run spec:drift`

### Cycle 1

- Finding: Medium impact. `shell.jsx` was still over 1,000 lines and mixed
  bootstrap concerns with app route state and Welcome setup logic.
- Implemented: Extracted `appShell.jsx`, `welcomeScreen.jsx`, and
  `chatErrorBoundary.jsx`, leaving `shell.jsx` as an 11-line bootstrap module.

### Cycle 2

- Finding: Medium impact. Source-string guards still treated `shell.jsx` as the
  owner of ChatLive imports, lazy screens, Welcome logic, Memory Review,
  Workspace Context routing, and folder-picker state.
- Implemented: Retargeted guards in `test/frontendRoutes.test.ts` to
  `appShell.jsx`, `welcomeScreen.jsx`, and `shell.jsx` according to the new
  ownership.

### Cycle 3

- Finding: Medium impact. The frontend spec still described `shell.jsx` as the
  real app root and Welcome owner after the extraction.
- Implemented: Updated `docs/spec-frontend.md` to define bootstrap,
  app-shell, welcome, and error-boundary ownership separately.

### Cycle 4

- Finding: Medium impact. The app-shell spec carried stale details about
  provider mounting, the session-expired flow, and `ChatLive` remount behavior.
- Implemented: Corrected the app-shell spec to keep provider composition in
  `shell.jsx`, document the popup re-auth path, and describe the keyed render
  boundary plus store-owned chat state.

### Cycle 5

- Finding: Medium impact. Workspace Context source coverage still pointed at
  `shell.jsx` even though the routing state moved to `appShell.jsx`.
- Implemented: Updated `docs/spec-coverage.md` to reference `appShell.jsx` for
  that desktop Workspace Context surface.

### Cycle 6

- Finding: No high- or medium-impact issue. The Welcome module imports only
  browser-safe frontend APIs and shell display helpers; it does not introduce
  server-only imports.
- Implemented: No change required.

### Cycle 7

- Finding: No high- or medium-impact issue. The build keeps lazy screen chunks
  for KB, Files, Settings, Workspace Settings, Memory Review, and session
  history after moving the lazy imports to `appShell.jsx`.
- Implemented: No change required.

### Cycle 8

- Finding: No high- or medium-impact issue. The error boundary remains scoped
  to `ChatLive` and still resets on conversation switches through
  `key={activeConvId}`.
- Implemented: No change required.

### Cycle 9

- Finding: No high- or medium-impact issue. The shell bootstrap still imports
  through `main.jsx`, so the Vite entry and provider order remain unchanged.
- Implemented: No change required.

### Cycle 10

- Finding: No high- or medium-impact issue. After the split, `shell.jsx` is 11
  lines, `appShell.jsx` is 561 lines, `welcomeScreen.jsx` is 444 lines, and
  `chatErrorBoundary.jsx` is 29 lines.
- Implemented: No change required.

## Phase 4 Review Cycles

Phase 4 split the desktop stylesheet surface without visual redesign:

- `web/AgentCockpitWeb/src/app.css` now owns only the base reset.
- `web/AgentCockpitWeb/src/styles/desktop.css` owns the desktop cascade order.
- Feature CSS moved under `web/AgentCockpitWeb/src/styles/`, with nested
  aggregators for chat, KB Browser, Settings, and Workspace Settings.
- The recursively composed CSS matches the pre-split stylesheet exactly after
  normalizing only the renamed base comment.

Verification run during the phase:

- `npm test -- --runTestsByPath test/frontendRoutes.test.ts`
- `npm run web:typecheck`
- `npm run web:build`
- `npm run web:budget`
- `npm run spec:drift`

### Cycle 1

- Finding: Medium impact. The initial CSS split duplicated the desktop CSS file
  order between `main.jsx` and the frontend route guards.
- Implemented: Added `styles/desktop.css` as the single cascade-order
  aggregator and reduced `main.jsx` to one desktop style import.

### Cycle 2

- Finding: Medium impact. The first extraction trimmed blank lines at section
  boundaries, making future CSS drift comparisons noisy even though behavior was
  unchanged.
- Implemented: Regenerated the split from the original stylesheet while
  preserving section-boundary whitespace exactly.

### Cycle 3

- Finding: Medium impact. Several first-level feature CSS files were still over
  1,000 lines, which kept unrelated concerns coupled inside the new files.
- Implemented: Split chat, KB Browser, Settings, and Workspace Settings again
  behind local aggregators. The largest nested CSS file is now
  `styles/kb/pipeline.css` at 675 lines.

### Cycle 4

- Finding: No high- or medium-impact issue. All CSS aggregators contain only
  top-level `@import` statements, so browser/Vite import ordering remains valid.
- Implemented: No change required.

### Cycle 5

- Finding: No high- or medium-impact issue. Every nested CSS import resolves on
  disk, including camel-case compatibility files such as `workspaceSettings.css`
  and `kbBrowser.css`.
- Implemented: No change required.

### Cycle 6

- Finding: No high- or medium-impact issue. The recursively composed stylesheet
  is byte-equivalent to the pre-split `app.css` after normalizing the base reset
  comment, so cascade and selector content did not drift.
- Implemented: No change required.

### Cycle 7

- Finding: Medium impact. The frontend CSS guard helper included aggregator
  `@import` lines in the composed string instead of modeling bundled CSS output.
- Implemented: Updated `readDesktopCss()` to recursively read imports and strip
  aggregator import lines from the composed guard source.

### Cycle 8

- Finding: No high- or medium-impact issue. Vite still emits one desktop CSS
  asset and the existing runtime-resolved public icon warnings are unchanged.
- Implemented: No change required.

### Cycle 9

- Finding: No high- or medium-impact issue. Spec coverage now points at
  `web/AgentCockpitWeb/src/styles/**/*.css`, so nested style modules remain in
  the documented desktop frontend surface.
- Implemented: No change required.

### Cycle 10

- Finding: No high- or medium-impact issue. The post-split CSS size map is
  bounded: `kb/pipeline.css` 675 lines, `settings/cli.css` 517 lines,
  `shell.css` 509 lines, `filesBrowser.css` 477 lines, and
  `workspace/context.css` 450 lines.
- Implemented: No change required.

## Phase 5 Review Cycles

Phase 5 moved deterministic mobile model logic and lifecycle listener wiring
out of `mobile/AgentCockpitPWA/src/App.tsx`:

- `appModel.ts` now owns workspace identity lookup, chat scroll threshold
  checks, CLI profile/backend identity projection, OpenCode provider labels,
  goal capability normalization, goal unsupported-action copy, and transcript
  pin patching.
- `useMobileLifecycle.ts` now owns focus/online/visibility stream-resume
  listener wiring and the list screen's visible interval refresh loop.

Verification run during the phase:

- `npm test -- --runTestsByPath test/mobileAppModel.test.ts test/frontendRoutes.test.ts`
- `npm run mobile:typecheck`
- `npm run mobile:build`
- `npm run spec:drift`

### Cycle 1

- Finding: Medium impact. Backend/profile identity, goal capability
  normalization, workspace reference lookup, scroll threshold checks, and pin
  patching were deterministic model logic embedded in `App.tsx`.
- Implemented: Moved those helpers to `appModel.ts` and added direct
  `test/mobileAppModel.test.ts` coverage for each boundary.

### Cycle 2

- Finding: Medium impact. App-level focus/online/visibility and list-refresh
  listener mechanics were interleaved with the mobile app shell state machine.
- Implemented: Added `useMobileLifecycle.ts` with `useVisibleStreamResume()` and
  `useVisibleIntervalRefresh()`, then wired `App.tsx` through those hooks.

### Cycle 3

- Finding: Medium impact. Static frontend guards still expected moved mobile
  model helpers to be declared in `App.tsx`.
- Implemented: Retargeted the guards to `appModel.ts` and
  `useMobileLifecycle.ts` while keeping assertions that `App.tsx` consumes the
  extracted helpers.

### Cycle 4

- Finding: Medium impact. The first lifecycle hook implementation updated the
  latest callback refs in effects, leaving a small stale-callback window between
  render and effect commit.
- Implemented: Updated both hooks to assign the latest callback ref during
  render while keeping listener registration in effects.

### Cycle 5

- Finding: No high- or medium-impact issue. The extracted helpers import only
  browser-safe mobile types and app model dependencies; no server modules or
  desktop-only APIs entered the mobile bundle.
- Implemented: No change required.

### Cycle 6

- Finding: No high- or medium-impact issue. The stream reconnect flow still
  uses `resumeStreamConnectionRef.current(conversationID, true)` on focus,
  online, and visible-state transitions.
- Implemented: No change required.

### Cycle 7

- Finding: No high- or medium-impact issue. The list screen still refreshes
  through the same active-stream and conversation-list REST calls while visible.
- Implemented: No change required.

### Cycle 8

- Finding: No high- or medium-impact issue. `mobileAppModel` coverage now
  includes profile/backend normalization, OpenCode labels, goal capability
  defaults, transcript pin patching, and scroll threshold behavior.
- Implemented: No change required.

### Cycle 9

- Finding: No high- or medium-impact issue. The mobile spec and coverage matrix
  now document `useMobileLifecycle.ts` and the broadened `appModel.ts`
  ownership.
- Implemented: No change required.

### Cycle 10

- Finding: No high- or medium-impact issue. After the phase, `App.tsx` is 4,016
  lines, `appModel.ts` is 576 lines, and `useMobileLifecycle.ts` is 48 lines.
- Implemented: No change required.

## Phase 6 Review Cycles

Phase 6 moved mobile screen and component render surfaces out of
`mobile/AgentCockpitPWA/src/App.tsx`:

- `mobileComponents.tsx` is now a stable re-export boundary for the mobile
  screens and modal surfaces consumed by `App.tsx`.
- `mobileConversationListScreen.tsx` owns conversation-list rendering and
  workspace filter presentation.
- `mobileChatScreen.tsx` owns the chat transcript, composer shell, goal strip
  and goal event cards, assistant identity, message Markdown/file rendering,
  queue stack, usage meter, attachments, and interaction card.
- `mobileConversationModals.tsx`, `mobileSessionScreens.tsx`, and
  `mobileFileModals.tsx` split conversation/settings sheets, session viewer
  surfaces, and file/queue sheets.
- `mobileIcons.tsx` and `mobilePrimitives.tsx` own shared SVG icons and small
  UI primitives.

Verification run during the phase:

- `npm test -- --runTestsByPath test/frontendRoutes.test.ts test/mobileAppModel.test.ts`
- `npm run mobile:typecheck`
- `npm run mobile:build`
- `npm run spec:drift`

The existing Vite runtime asset warnings for `/icons/deepseek-logo.svg` and
`/icons/opencode-logo-light.svg` were unchanged.

### Cycle 1

- Finding: Medium impact. The first component extraction moved the large render
  tail into a single `mobileComponents.tsx` file, preserving behavior but still
  leaving a 2,012-line component bucket.
- Implemented: Split the bucket into focused list, chat, modal, icon, and
  primitive modules while keeping `mobileComponents.tsx` as a stable re-export
  boundary.

### Cycle 2

- Finding: Medium impact. Static frontend guards still expected moved mobile
  render helpers in `App.tsx` or the new aggregator instead of the owning
  implementation files.
- Implemented: Retargeted provider-avatar, auto-follow, usage, thinking-block,
  Markdown-share, run-settings, and goal-control guards to the extracted chat
  and conversation modal modules.

### Cycle 3

- Finding: Medium impact. The mobile spec and coverage matrix did not yet
  describe the new component ownership boundaries.
- Implemented: Updated `docs/spec-mobile-pwa.md` and
  `docs/spec-coverage.md` with the new source layout and feature evidence.

### Cycle 4

- Finding: Medium impact. `mobileModals.tsx` still mixed conversation actions,
  settings, folder picking, sessions, file browsing, file preview, and queue
  editing in one 850-line file.
- Implemented: Split it into `mobileConversationModals.tsx`,
  `mobileSessionScreens.tsx`, and `mobileFileModals.tsx`; `mobileModals.tsx`
  now only re-exports those surfaces.

### Cycle 5

- Finding: No high- or medium-impact issue. The extracted modules import only
  browser-safe mobile types, the mobile API client type, mobile model helpers,
  and peer mobile UI modules.
- Implemented: No change required.

### Cycle 6

- Finding: No high- or medium-impact issue. `App.tsx` remains the state machine
  and event-handler owner, and the extracted modules remain presentational
  composition surfaces with typed callbacks.
- Implemented: No change required.

### Cycle 7

- Finding: No high- or medium-impact issue. The public import path consumed by
  `App.tsx` stays stable through `mobileComponents.tsx`, so the split does not
  force state-shell churn.
- Implemented: No change required.

### Cycle 8

- Finding: No high- or medium-impact issue. Mobile typecheck and focused
  frontend/mobile model tests pass after the split.
- Implemented: No change required.

### Cycle 9

- Finding: No high- or medium-impact issue. `mobile:build` emits the expected
  production bundle, with only the pre-existing runtime-resolved icon warnings.
- Implemented: No change required.

### Cycle 10

- Finding: No high- or medium-impact issue. After the phase, `App.tsx` is 2,050
  lines; the largest extracted modules are `mobileChatScreen.tsx` at 813 lines,
  `mobileConversationModals.tsx` at 419 lines, `mobileSessionScreens.tsx` at
  251 lines, and `mobileFileModals.tsx` at 168 lines.
- Implemented: No change required.

## Phase 7 Review Cycles

Phase 7 split the mobile PWA stylesheet:

- `mobile/AgentCockpitPWA/src/styles.css` is now a cascade-order aggregator.
- `mobile/AgentCockpitPWA/src/styles/mobile/` contains focused modules for
  base viewport styles, conversation list, chat transcript/Markdown, shared
  controls, modal shell, conversation/settings modals, sessions, files,
  list/navigation/composer/actions/file/status refinements, and responsive
  breakpoints.

Verification run during the phase:

- `npm test -- --runTestsByPath test/frontendRoutes.test.ts test/mobileAppModel.test.ts`
- `npm run mobile:typecheck`
- `npm run mobile:build`
- `npm run spec:drift`

The existing Vite runtime asset warnings for `/icons/deepseek-logo.svg` and
`/icons/opencode-logo-light.svg` were unchanged.

### Cycle 1

- Finding: Medium impact. `mobile/AgentCockpitPWA/src/styles.css` was a
  2,887-line stylesheet covering every mobile surface.
- Implemented: Split it into `src/styles/mobile/*.css` modules and kept
  `styles.css` as the import aggregator.

### Cycle 2

- Finding: Medium impact. The first line-range split put an import boundary
  inside a multi-line selector, which PostCSS rejected during `mobile:build`.
- Implemented: Regenerated the split from selector markers so every imported
  CSS file is syntactically valid while the composed CSS still matches the
  original cascade exactly.

### Cycle 3

- Finding: Medium impact. The late-cascade `mobile-refinements.css` module was
  too broad and mixed list, navigation, composer/goal, action, file toolbar, and
  status utilities.
- Implemented: Split it into `list-refinements.css`, `navigation.css`,
  `composer-goals.css`, `actions.css`, `file-toolbar.css`, and `status.css`.

### Cycle 4

- Finding: Medium impact. Mobile static guards read `styles.css` directly, so
  they would only see import statements after the split.
- Implemented: Added `readMobileCss()` to recursively compose the mobile CSS
  imports and assert that `styles.css` remains the module aggregator.

### Cycle 5

- Finding: Medium impact. The mobile spec and coverage matrix did not yet list
  the new mobile CSS ownership structure.
- Implemented: Updated `docs/spec-mobile-pwa.md` and
  `docs/spec-coverage.md` with the mobile CSS aggregator and module directory.

### Cycle 6

- Finding: Medium impact. `chat-transcript.css` still grouped chat layout,
  messages, goal cards, content, Markdown, and thinking panels in one 683-line
  module.
- Implemented: Split it into `styles/mobile/chat/layout.css`,
  `messages.css`, `goal-events.css`, `content.css`, `markdown.css`, and
  `thinking.css`.

### Cycle 7

- Finding: No high- or medium-impact issue. `mobile:build` passes with the same
  generated CSS/JS asset sizes and only the pre-existing runtime icon warnings.
- Implemented: No change required.

### Cycle 8

- Finding: No high- or medium-impact issue. Focused frontend/mobile model tests
  still cover viewport, modal reachability, provider avatars, Markdown
  thinking blocks, auto-follow, Markdown sharing, and goal-control styles via
  the composed mobile CSS helper.
- Implemented: No change required.

### Cycle 9

- Finding: No high- or medium-impact issue. `spec:drift` remains clean after
  documenting the mobile CSS module directory.
- Implemented: No change required.

### Cycle 10

- Finding: No high- or medium-impact issue. After the final split, the largest
  mobile CSS modules are `sessions.css` at 352 lines,
  `conversation-list.css` at 350 lines, `shared-controls.css` at 286 lines,
  and `chat/layout.css` at 234 lines.
- Implemented: No change required.

## Final Review Cycles

Final verification covered the whole frontend surface split after all phases.

Verification run during the final pass:

- `npm run maintainability:check`
- `npm run spec:drift`
- `npm test -- --runTestsByPath test/frontendRoutes.test.ts test/mobileAppModel.test.ts test/streamStore.test.ts`
- `npm run web:typecheck`
- `npm run web:build`
- `npm run web:budget`
- `npm run mobile:typecheck`
- `npm run mobile:build`

The existing Vite runtime asset warnings for `/icons/deepseek-logo.svg`,
`/icons/opencode-logo-light.svg`, and desktop
`/icons/opencode-logo-dark.svg` were unchanged.

### Cycle 1

- Finding: Medium impact. The final CSS size review found the mobile
  `chat-transcript.css` module was still too broad after Phase 7.
- Implemented: Split it into focused chat CSS modules under
  `mobile/AgentCockpitPWA/src/styles/mobile/chat/`.

### Cycle 2

- Finding: Medium impact. The coverage matrix used
  `styles/mobile/*.css`, which missed the nested mobile chat CSS modules.
- Implemented: Updated the Mobile PWA source evidence to
  `mobile/AgentCockpitPWA/src/styles/mobile/**/*.css`.

### Cycle 3

- Finding: No high- or medium-impact issue. `npm run maintainability:check`
  passes after the desktop and mobile module splits.
- Implemented: No change required.

### Cycle 4

- Finding: No high- or medium-impact issue. `npm run spec:drift` remains clean
  with the new specs and coverage rows.
- Implemented: No change required.

### Cycle 5

- Finding: No high- or medium-impact issue. Focused frontend, mobile model, and
  stream-store tests pass together.
- Implemented: No change required.

### Cycle 6

- Finding: No high- or medium-impact issue. Desktop typecheck, production build,
  and bundle budget pass after the shell/chat/CSS extraction.
- Implemented: No change required.

### Cycle 7

- Finding: No high- or medium-impact issue. Mobile typecheck and production
  build pass after the model/component/CSS extraction.
- Implemented: No change required.

### Cycle 8

- Finding: No high- or medium-impact issue. New frontend modules stay inside
  browser-safe boundaries; mobile imports shared contracts only through the
  existing browser-safe contract paths.
- Implemented: No change required.

### Cycle 9

- Finding: No high- or medium-impact issue. No recurring architecture or agent
  workflow rule changed, so no ADR or `AGENTS.md` update is needed.
- Implemented: No change required.

### Cycle 10

- Finding: No high- or medium-impact issue. The final line-count map leaves
  `shell.jsx` as bootstrap, desktop chat/app shell modules bounded, `App.tsx`
  at 2,050 lines, and mobile render/CSS modules split by ownership.
- Implemented: No change required.
