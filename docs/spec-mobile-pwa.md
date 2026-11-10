# Mobile PWA Client

CoCo P1 extends shared profile/capability types and pure eligibility contracts
without adding a mobile runtime choice or UI flow. No PWA metadata, assets or
administration behavior changes. See [CoCo foundations](spec-cortex-code.md);
native mobile chat acceptance remains a later phase.

P7 C42 updates the desktop/shared responsive setup and Settings profile editor,
desktop catalog ownership and the backend-supplied CoCo icon. Mobile receives
the supplied blue Snowflake logo through existing metadata and renders it in
assistant identities on light and dark themes. No PWA administration screen, endpoint,
manifest, service worker, asset source or protocol change is introduced. The
desktop's profile-catalog hook is not imported by mobile; broader native mobile
model/usage/media acceptance is recorded under C45/C46 below; C47 keeps
consolidated responsive-client checks separate.

Cortex Run Settings retains a saved effort through pending/failed or empty
catalog discovery and when the selected model/effort is no longer advertised.
Show `<level> (saved)` as a disabled selected choice when it cannot be validated,
with model-selection guidance for a missing model or refresh/login guidance for
an empty catalog. Selecting an available model exposes its advertised effort
buttons, including `high`/`xhigh`; never invent choices or silently replace a
saved override. Other harnesses retain existing reconciliation. No wire contract,
PWA manifest or service-worker policy changes are required.

P7 C43 applies shared revision capability policy to mobile/desktop plan cards.
The mobile send pipeline synchronously prevents duplicate/stale submissions,
exposes reply-busy state and preserves newer interactions/drafts on late input
responses. CoCo rejection selects keep_planning and may end with explanatory
text or return to another native gate; approval permits execution.
Question drafts reset on decision/prompt changes. Wire contracts and PWA metadata,
manifest, service worker and asset sources stay unchanged. Native interaction
acceptance is scoped separately from the remaining C45–C47 mobile feature matrix.

P7 C44 adds explicit queue-only guidance for unsupported live steering, serialized
queue saves/drains and an idle Resume queue control. Stop pauses queue ownership
before cancellation; late callbacks and failed/aborted runs retain queued work.
Queue persistence clears only unchanged draft/upload snapshots. Newer drafts,
questions and conversations survive delayed replies. Matching outcomes resolve
decision-bound (`decisionBound:true`) cards during socket replay, and stream end
clears only those cards; superseded socket frames are ignored.
The native queue probe checks current chat flows and persisted queue reload,
while mobile drafts retain their existing in-memory scope. No PWA metadata,
manifest, service-worker, administrative or persistence-format changes are added.

P6 C33/C34/C36 adds server-side tool-enabled sequential execution and verified
PNG OCR through the existing endpoint. No new PWA settings, assets, metadata or
administrative screen is added. Mobile consumers retain the shared profile-local
model/media checks; full native mobile acceptance and remaining selection parity
are P7. Memory processor selection is a desktop administrative control;
the backend rejects unsupported CoCo restricted calls regardless of client.

P6 C37/C38 adds server-side KB conversion/digestion/dreaming certification.
Prepared CoCo PNG siblings use the existing KB media/Markdown routes; originals
remain available. No PWA UI, metadata, asset source or administration changes
are required. Native mobile/browser compatibility remains a separate gate.

P6 C39 certifies the existing server-side Workspace Context service/scheduler
with CoCo. Existing context/state/update routes and frames remain unchanged;
no mobile source, built asset, manifest or settings changes are required.
Full native mobile/browser acceptance remains pending.

P6 C40 certifies the existing Routine backend paths with CoCo, including
proposals, manual/scheduled runs, files/history and timeout. It adds no mobile
UI, routes, frames, assets or manifest changes. Full mobile Routine/proposal
interaction acceptance remains part of the later client gates.

C41 processor preflights and preserved global/workspace settings also apply to
mobile/programmatic callers. Unsupported profiles fail before execution without
relaxing tool restrictions or falling back to another harness. No mobile
settings screen, wire shape, PWA asset source or manifest change is required;
full native mobile acceptance remains separate.

[← Back to index](SPEC.md)

Grok Build uses the shared mobile profile/model/effort, interaction, tool/Agent,
artifact, and native goal flows. Its goal strip labels a supplied token budget
**Soft budget**. Its usage bar labels the value **Reported model cost** and
shows `n/a` when no reported/estimated cost is available. The focused
`src/grokBilling.tsx` component calls `AgentCockpitAPI.getGrokBilling(profileId)`
on profile or message-count change, displays available tier, credit percentage,
prepaid balance, and reset date, hides old profile data immediately on switching,
ignores late responses after effect cleanup, and hides unavailable fields or
failed snapshots. The billing response lives in the browser-safe shared
`src/contracts/grokBilling.ts`. Administrative profile auth/install/update
controls remain on desktop. See [Grok Build](spec-grok-build.md).

Plan approval projection accepts `tool_activity` with `isPlanMode:true` and
`planAction:'exit'`, including absent plan content, and creates both the pending
approval card and notification. The empty-content fallback is **Plan ready for
approval.** Existing content-bearing plan frames remain supported. The same
projection works for revised Grok plans and Claude plan exits. Goal objective
cleanup recognizes pasted Grok harness IDs and display names without stripping
ordinary objectives that mention Grok Build.

---

The mobile PWA is the supported mobile client for Agent Cockpit. It is a browser-based React app served by the same authenticated Node/Express server as the desktop web UI: open the self-hosted server URL on the phone, sign in with the existing web auth flow, and add the app to the home screen.

See [ADR-0025](adr/0025-use-mobile-pwa-as-sole-mobile-client.md).

## Goals

- Provide an installable mobile web client without App Store, TestFlight, EAS, Expo Go, Apple signing, or native sideloading requirements.
- Reuse the existing `/api/chat` REST and WebSocket contracts.
- Keep the mobile app source in one browser-native React codebase under `mobile/AgentCockpitPWA`.
- Serve ignored built assets through the same authenticated Express server under `/mobile/`.

## Source Layout

**Source files:** `mobile/AgentCockpitPWA/`

- `package.json` — isolated Vite React package. Runtime dependencies include React, Vite, `marked`, and DOMPurify; assistant Markdown is rendered client-side and sanitized before insertion. Scripts:
  - `npm run dev` — Vite development server on port `5174`, with `/api` proxied to `http://localhost:3334` including WebSocket upgrade support, and `/auth`, `/logo-full-no-text.svg`, and `/logo-small.svg` proxied to `http://localhost:3334`.
  - `npm run build` — production build that writes to `../../public/mobile-built`.
  - `npm run preview` — local Vite preview server.
  - `npm run typecheck` — `tsc --noEmit`.
  - `npm run visual:capture` — Playwright WebKit screenshot capture for the main mobile PWA states using iPhone device profiles.
- Root `package.json` exposes wrappers for the same package:
  - `npm run mobile:dev` — runs the PWA Vite dev server.
  - `npm run mobile:build` — builds the PWA into ignored `public/mobile-built/`. Startup and self-update call the same production build through `MobileBuildService` when generated assets are missing or stale.
  - `npm run mobile:typecheck` — type-checks the PWA.
  - `npm run mobile:visual:capture` — captures WebKit screenshots through the PWA visual verification harness.
- `vite.config.ts` — sets `base: "/mobile/"`, installs the React plugin, and emits the production bundle to `public/mobile-built/`.
- `index.html` — PWA HTML shell with viewport-safe mobile metadata, `theme-color`, `apple-mobile-web-app-capable`, manifest link, SVG/PNG favicon links, explicit `apple-touch-icon`, design-font preconnects/stylesheets for General Sans, Instrument Serif, and JetBrains Mono, and root mount.
- `public/manifest.webmanifest`, `public/icon.svg`, `public/icon-192.png`, `public/icon-512.png`, and `public/apple-touch-icon.png` — tracked source install metadata and icons copied into `public/mobile-built/` during build. iOS home-screen installs use the 180x180 PNG `apple-touch-icon`; the manifest also lists PNG icons because Safari is not reliable with SVG-only PWA icons.
- `src/main.tsx` — React entrypoint.
- `src/App.tsx` — mobile composition shell. It owns the API client refs, screen routing, dashboard/list state, active conversation/draft/interaction state, modal visibility, high-level conversation CRUD, `applyServerMessage`, `handleError`, notification dispatch, and cross-hook wiring, then composes focused screen modules and state-provider hooks instead of declaring stream, send, goal, attachment, explorer, queue-editor, session, or file-preview implementation bodies inline.
- `src/mobileComponents.tsx` — stable re-export boundary for the mobile screens and modals consumed by `App.tsx`.
- `src/mobileConversationListScreen.tsx` — conversation-list rendering, workspace filtering controls, live/goal row state, and conversation-card presentation.
- `src/mobileChatScreen.tsx` — chat transcript rendering, composer shell, backend-neutral goal strip/event cards, assistant identity projection, message Markdown/file-card rendering, wrapped Markdown code-block copy controls, queue stack, usage meter, and attachment tray. It passes the conversation backend's plan-feedback support to the interaction card.
- `src/interactionCard.tsx` — pending plan-approval and clarifying-question card. Plan cards send explicit `Approve & run` (`yes`) and `Reject` (`no`) decisions, matching desktop; shared `planRevision` capability eligibility controls the `Plan revision feedback` textarea and `Request changes` button (CoCo explicit support, Grok legacy default, explicit denial honored). Question cards keep option chips, free-text answers, and `Answer`. The card receives conversation backend metadata and reply-busy state; all actions/inputs disable during delivery.
- `src/mobileModals.tsx` — stable re-export boundary for modal and secondary-screen modules.
- `src/mobileConversationModals.tsx` — New Conversation/folder picker, conversation actions, Markdown sharing, and run settings sheets.
- `src/mobileSessionScreens.tsx` — session list and read-only session viewer surfaces.
- `src/mobileFileModals.tsx` — workspace files, file preview, and queue editor sheets.
- `src/mobileIcons.tsx` and `src/mobilePrimitives.tsx` — shared mobile SVG icons and small UI primitives used by the screen modules. Deterministic projection/normalization helpers live in `appModel.ts`; stream frame projection lives in `chatStreamEvents.ts`; and repeated lifecycle listener wiring lives in hooks.
- `src/appModel.ts` — browser-only mobile app model helpers for file-delivery marker parsing, typed file preview references, reset-session list reconciliation, conversation-list projection, queue wire content, attachment filtering, backend/profile identity normalization, reset-profile repair selection, OpenRouter display-label normalization, backend-neutral goal slash-command parsing, goal capability/timestamp/elapsed/status/action projection, local runtime-goal preservation, accidental goal-card objective cleanup, stream reconnect backoff, workspace identity/path formatting, transcript pin patching, transcript scroll threshold/signature checks, and shared formatters. These helpers are covered separately so the main UI shell can stay focused on state orchestration.
- `src/chatStreamEvents.ts` — pure stream-frame projection for the mobile chat socket and conversation-list stream monitors. It maps `StreamEvent` values to discriminated action lists, owns notification classification for terminal errors/done/plan/question frames, and owns conversation-list patching from assistant messages.
- `src/useRunSelection.ts` — profile/backend/model/effort/Claude Code mode/Codex speed selection state, profile metadata caching, derived capability projection, default/conversation hydration, profile switching, and related reconciliation effects.
- `src/usePendingAttachments.ts` — pending upload state, upload/delete/OCR handlers, upload progress/cancel wiring, server recovery-message application, and OCR insertion into the composer draft.
- `src/useGoalState.ts` — active goal ids, local goal snapshots, stale-snapshot rejection, backend goal refresh, goal-mode reset, and set/pause/resume/clear API actions.
- `src/useChatStreamConnection.ts` — open-chat WebSocket lifecycle, replay reconnect, reconnect backoff timers, streaming placeholder/text state, `isStreaming` state/ref ownership, visibility resume wiring, active-stream recovery, and dispatch of `chatStreamEventActions`.
- `src/useListStreamMonitor.ts` — best-effort conversation-list WebSocket monitors gated to the list screen, passive list stream-frame dispatch, terminal stream cleanup, and list refresh triggering.
- `src/useSendPipeline.ts` — send-in-flight guard, goal slash-command dispatch, optimistic send, `409` active-stream recovery, accepted-send reconciliation, queue enqueue/drain, queue rollback, and plan/question input submission.
- `src/useFilePreview.ts`, `src/useSessionHistory.ts`, `src/useQueueEditor.ts`, and `src/useWorkspaceExplorer.ts` — focused state-provider hooks for file preview/share, session list/read-only viewer state, message queue editing, and workspace explorer tree/preview/edit/upload flows.
- `src/useMobileLifecycle.ts` — small lifecycle hooks for mobile app-level event wiring. `useVisibleStreamResume()` owns focus/online/visibility listeners that ask the active stream to reconnect when the page becomes visible again. `useVisibleIntervalRefresh()` owns the list screen's focus/visibility/interval refresh loop while keeping the latest refresh callback in a ref.
- `src/useViewportHeightVar.ts` — visual-viewport hook that owns the iOS Safari app-shell sizing variables (`--app-height`, `--app-width`, `--app-top`, and `--app-left`) and document scroll reset behavior.
- `src/api.ts` — same-origin TypeScript API client for current-user, settings, backends, profile metadata, conversations, local directory browsing, message pinning, streams, backend-neutral goal fetch/set/resume/pause/clear, returned goal-event transcript messages, queue, sessions, attachments/OCR, workspace location reads/remaps, workspace and conversation-scoped file delivery, workspace explorer, and WebSocket URLs. Conversation create, message-pin, message send, stdin input, and explorer mutation bodies use type-only imports from browser-safe `src/contracts/*` files so mobile request shapes compile against the same contract types as the server. State-changing requests lazily fetch CSRF tokens and send `x-csrf-token`. Multipart uploads use `XMLHttpRequest` for progress and cancel.
- `src/types.ts` — TypeScript mirrors for the PWA data models. Mobile imports the browser-safe `BrowserStreamFrame` and `StreamErrorSource` contracts from `src/contracts/streamFrames.ts` for WebSocket frames, while continuing to mirror local UI-only state shapes in the PWA package. The shared contract covers text/thinking/tool/artifact/assistant/title/usage/error/done/replay frames, goal frames, and live-only Memory, Workspace Context, and KB update frames. See [ADR-0077](adr/0077-keep-browser-stream-frames-in-a-shared-contract-and-reducer.md).
- `src/styles.css` — mobile CSS aggregator. It imports the focused
  `src/styles/mobile/*.css` modules in cascade order.
- `src/styles/mobile/` — mobile-first CSS modules split by ownership: base
  viewport/reset styles, conversation list, shared controls, modal shell,
  conversation/settings modals, sessions, files, late list/navigation/composer/
  action/file/status refinements, and responsive breakpoints. Chat transcript
  CSS is further split under `src/styles/mobile/chat/` into layout, message,
  goal-event, content, Markdown, and thinking-panel modules.

**Served files:** `public/mobile-built/`

`npm run build` writes `index.html`, `manifest.webmanifest`, SVG/PNG icon assets, and hashed CSS/JS assets here. These files are served by the explicit `/mobile` `express.static(public/mobile-built)` mount after `requireAuth`, so unauthenticated visitors are redirected to the normal web login before the PWA shell is served. Generated output is ignored by git; tracked mobile install metadata remains in `mobile/AgentCockpitPWA/public/`.

Production GitHub Release artifacts include `public/mobile-built/index.html` and
the generated mobile asset tree. `scripts/package-release.js` refuses to create
a release archive when the mobile build shell is missing, the manual release
workflow runs `npm run mobile:typecheck` and `npm run mobile:build`, and the
macOS/Linux/Windows installers verify the packaged mobile shell before startup.
Production updates run `npm --prefix mobile/AgentCockpitPWA ci` inside the extracted
release and then run `MobileBuildService` for that release when build markers or
assets are missing or stale before activating the release. Dev updates
continue to force `npm --prefix mobile/AgentCockpitPWA install` plus
`npm run mobile:build` before PM2 restart.

`public/mobile/` contains only a hidden ADR placeholder so historical decision records can keep validating affected paths. It is not a generated output directory and does not contain served PWA assets.

## Runtime Architecture

The PWA runs in the phone browser or as an installed home-screen web app. It does not need a separate pairing flow because it is same-origin with the server:

1. The user opens `/mobile/` on the Agent Cockpit server.
2. `requireAuth` protects `/mobile/` like `/v2/`. If no session exists, the browser is redirected to `/auth/login?next=<encoded /mobile/... path>`; successful password, passkey, or recovery-code login returns to that safe relative `/mobile/...` target instead of falling through `/` to the desktop `/v2/` UI. If the already-loaded PWA receives a `401` from an API request, its `loginURL()` helper also sends the current `/mobile/...` path as `next`.
3. Once loaded, the PWA calls same-origin `/api/me`, `/api/chat/settings`, `/api/chat/backends`, `/api/chat/active-streams`, and `/api/chat/conversations`.
4. REST calls use `credentials: "same-origin"`, the browser's `connect.sid` cookie, and CSRF tokens from `GET /api/csrf-token`.
5. Streaming uses `ws(s)://<same-origin>/api/chat/conversations/:id/ws` and sends `{ "type": "reconnect" }` on open.
   - Chat-view stream socket transport failures are treated as transient while the conversation is still active. The PWA does not surface a WebSocket transport error banner for an in-flight stream, including WebKit/Safari cases where `new WebSocket(url)` rejects the URL/proxy upgrade attempt synchronously with a generic DOM exception. Instead it polls `GET /api/chat/active-streams`, reconnects with the normal replay contract when the conversation is still active, and refreshes the conversation if the stream already completed while the browser was suspended.
   - `visibilitychange`, browser `focus`, and `online` events trigger the same active-stream check and replay reconnect for the open chat so iOS Safari background/sleep socket loss can recover without a manual refresh.
6. While the conversation list is visible, the PWA opens passive WebSocket monitors for conversations returned by `/api/chat/active-streams`. Those sockets use the same reconnect contract as chat views, ignore text deltas, react to `assistant_message`, `title_updated`, `goal_updated`, `goal_cleared`, terminal `error`, `done`, and interaction-needed `tool_activity` frames, and refresh the list when a stream reaches a terminal state. Passive monitor construction is best-effort: if the browser rejects a monitor WebSocket synchronously, the row remains governed by `/active-streams` polling rather than surfacing a list-level error. Known active backend-neutral goals keep their list rows in the running/blue state after the current backend stream ends, without pretending there is still an active WebSocket stream. The list also refreshes on focus/visibility return and every 15 seconds as a fallback for suspended browsers, missed sockets, and activity started from another client. The multi-client WebSocket transport decision is recorded in [ADR-0028](adr/0028-allow-multiple-websocket-clients-per-conversation.md).

For reverse-proxy base paths, the API base is derived from the current URL by replacing `/mobile/...` with `/`, matching the desktop V2 client's base-path behavior.

## Implemented Slice

The PWA currently covers:

- Same-origin authenticated load via the existing web auth session.
- Warm editorial cockpit visual system across the mobile shell: warm paper background, white cards/sheets, cyan brand/status accents, the shared desktop-web Agent Cockpit logo asset, serif titles, desktop-matched General Sans assistant prose and controls, JetBrains Mono instrumentation labels, segmented list controls, instrumented conversation cards, meter-style usage rows with separate **Cost** and **Estimated Cost** cells (Estimated Cost displays rounded up to whole USD; for every backend, Cost displays `n/a` when the usage `costSource` is `none`), rounded bottom sheets, compact session cards, prototype-style icon buttons in chat/actions/files surfaces, and file rows with glyph blocks instead of textual `[dir]` prefixes.
- App-like viewport locking: the document body does not scroll horizontally or vertically, the root/app shell are fixed to the visual viewport, accidental document scroll is reset during viewport/focus/scroll updates, and only intended panes (conversation list, transcript, modals, queues, attachment trays) scroll inside their own bounds. The viewport meta includes `interactive-widget=resizes-content`, and the React shell maintains `--app-height` / `--app-width` from `window.visualViewport.height` / `window.visualViewport.width` plus `--app-top` / `--app-left` from `window.visualViewport.offsetTop` / `window.visualViewport.offsetLeft` so the top bar, composer, modal sheets, and list screen stay inside the visible iOS viewport even if Safari reports a horizontally panned visual viewport. Those metrics are rounded, CSS variables are rewritten only when the rounded metric tuple changes, and scroll positions are only reset when non-zero so frequent Safari visual-viewport events do not create visible repaint churn. The conversation-list toolbar constrains the workspace selector to its own row and clamps controls/cards to the shell width so child content cannot create a horizontal scroll range. Text inputs and textareas use 16 px text or larger to avoid iOS Safari focus zoom. Desktop max-width framing is limited to fine-pointer/hover devices so touch browsers with unusual viewport reporting still get the full-width mobile shell.
- Current-user display via `GET /api/me`.
- Settings/default loading via `GET /api/chat/settings`.
- Backend metadata loading via `GET /api/chat/backends`.
- Profile-specific backend metadata loading via `GET /api/chat/cli-profiles/:profileId/metadata`. Copilot refreshes selected-profile metadata on a 60-second timer and window focus, cancels stale selection/unmount callbacks, and derives effort choices from that model's runtime list. Run Settings displays **Fallback models** and its reason when discovery is unavailable/custom. A saved Copilot model missing from the current catalog remains selected; Run Settings explains that it is unavailable and asks the user to choose from the list. No catalog render writes a replacement to saved conversation state. Copilot sends `effort:null` when the effort control is absent/cleared, removing an old stored effort rather than retaining it on the next message. The server rejects unavailable model/effort requests before adding a user message. There are no PWA asset, manifest, or service-worker changes.
- GitHub Copilot profiles use the same metadata-driven model picker, assistant
  label/icon, thinking/text/tool frames, session recovery notices, and usage
  counters as desktop. `auto` is the default model; Haiku/auto do not show
  reasoning-effort choices. SDK profiles support native questions and explicit
  steering and grouped delegated tools/summaries; opaque JSONL profiles do not. Copilot SDK goals expose native set/status/pause/resume; Clear and plan mode remain unavailable. Per-turn token/credit accounting
  is performed on the server, and `costSource:'none'` keeps mobile cost `n/a`.
  No Copilot-specific PWA assets, manifest, or service-worker changes are needed.
  Gemini's unverified effort options are also hidden. Auto routing is not
  eligible for media processors. Exact verified provider/model capabilities
  govern images/PDFs; custom OpenAI `gpt-6.1-sol` images and Anthropic
  `claude-sonnet-4.6` images/PDFs are verified. Hosted SDK PDFs stay gated.
  Delegated prose cannot contaminate the root answer; SDK child tools and
  summaries render within Agent cards, while JSONL keeps root-only activity.
  Production sends use owned SDK sessions for the normal CLI and server-visible
  custom providers, retaining JSONL for opaque overrides. Both paths reuse the
  shared frame union; delegated outcomes add optional summary. Server-side
  profile checks distinguish credentials from catalog access, while CLI-profile
  authentication/account administration stays in full web Settings. PWA metadata,
  service worker and static assets are unchanged. The current browser suite
  covers PWA lifecycle/questions/steering/delegation/goals/usage/artifacts and full
  web auth at narrow widths; injected auth/catalog cases are not hosted-account
  proof. The [testing spec](spec-testing.md#copilot-published-ci-evidence)
  records 40 passing macOS and Ubuntu SDK browser cases separately from earlier
  JSONL evidence and platform auth/application limits. See the
  [known gaps](reference/backend-capabilities.md#copilot-known-capability-gaps).
  Session reset waits for backend cleanup before replacing its session/checkout.
  During that interval, sends and goal starts/resume return temporary `503` with
  `Retry-After: 1`; repeat resets and worktree changes retain busy `409`. The
  mobile send pipeline preserves the draft/attachments, removes optimistic
  bubbles, and finishes local streaming when no server stream exists. A
  workspace mode change reserves all its conversations.
  Archive/delete use the same reservation and wait for backend cleanup; conflicts
  return `409`, and concurrent sends retain their draft through the existing
  temporary `503` handling. A send immediately following Copilot Stop waits for
  the old workers before a new CLI process can start.
  The PWA retains streaming state through abort completion and refreshes before exposing Send; the native browser suite holds the abort request to verify that boundary.
- Active/archived conversation list via `GET /api/chat/conversations`.
- Workspace-level archives are respected by the shared conversation-list contract: archived workspaces are excluded from the mobile active and archived conversation lists unless a caller explicitly asks for `includeArchivedWorkspaces`, which the PWA does not do. The PWA does not expose workspace archive management, remapping, file snapshot restore, or archived-data deletion; those remain desktop filesystem-management workflows.
- Flat latest-first conversation list with a workspace select filter. `All conversations` is the default; choosing a workspace filters the list to that `workspaceId` without introducing collapsible workspace groups. Each card renders the workspace label in the header and keeps the timestamp in the footer beside message count/live status so the date appears only once.
- Conversation-list previews strip uploaded-file/file-delivery wire markers. Attachment-only previews render as human labels such as `Attachment: IMG_3021.PNG` rather than exposing absolute artifact paths.
- Live tool/delegated presentation is owned by `liveToolActivities.ts` and
  `agentTools.tsx`. `useChatStreamConnection` stores `streamTools` separately
  from root text, forwards ordinary tool frames/outcomes through the pure
  immutable reducer, ignores duplicate IDs and excludes question/plan frames.
  Clear live tools on replay start, saved assistant messages, new turns and
  terminal state. Outcome patches carry status, duration and optional summary.
  `App` passes these tools into `ChatScreen`; a live bubble exists even before
  root text when tools are active. Tool state participates in the scroll key.
- `AgentToolsProvider` indexes both saved messages (ordered blocks, legacy
  activity fallback) and live tools by Agent ID. Known child rows are suppressed
  at top level and shown once inside the ancestor card, including cross-message
  children and flattened nested agents. Agent headers show type and running or
  terminal outcome (legacy duration-only activities fall back to done), with
  error/warning styling. Ordinary child rows show tool,
  description and outcome. Escaped plain-text Summary disclosures preserve
  whitespace; no child content becomes a parent message. Read-only session
  screens use the same provider/view. Files without summaries remain compatible.
  This changes the built PWA client and CSS; `public/mobile`, manifest, service
  worker and offline policy require no changes.
- Active-stream summary hydration via `GET /api/chat/active-streams`.
- Conversation-list running badges update automatically from passive WebSocket monitors and REST fallback refreshes; the manual Refresh icon button remains a recovery control for explicit user-triggered reconciliation.
- Open conversation via `GET /api/chat/conversations/:id`.
- Opening a conversation scrolls the transcript to the newest message. Submitting a normal non-streaming chat message opts the transcript back into tail-following before the optimistic user bubble and assistant placeholder render, so the sent turn remains visible even if a prior layout scroll event had paused follow mode. The transcript continues following newly appended messages and streaming assistant block changes (text, thinking, tool activity, tool outcomes, and artifacts) until the user scrolls away from the bottom. During an active stream, that manual scroll pauses auto-follow and shows a floating **Back to end** button inside the transcript area; tapping it scrolls to the latest content, restores auto-follow, and repeats the end scroll on the next animation frames so iOS visual-viewport/composer layout changes cannot leave the viewport above the tail. Manually scrolling back within 48 px of the bottom restores auto-follow without tapping the button.
- Message pin/unpin through `PATCH /api/chat/conversations/:id/messages/:messageId/pin`. The chat view renders a sticky pinned-message strip below the topbar with pinned count, active pinned preview, dot indicators, and previous/next controls; tapping a pinned item scrolls the transcript to that message and briefly outlines it. Pinned bubbles render a small dashed `PINNED` strip and accent left rail. Each active-session message exposes Copy, Copy MD, and Pin/Unpin as a compact icon pill in the message heading.
- Create conversation via `POST /api/chat/conversations`. The New Conversation working directory is a full-width read-only path display with Browse and Default actions on the following row, and its Create/Cancel controls use the same prototype-style icon button treatment as other mobile sheets. If the conversation list is filtered to a single workspace, opening New Conversation preselects that workspace path and the folder picker opens there; if `All conversations` is selected, the modal keeps the current server settings/default behavior. When the selected runtime is Claude Code/Claude Code Interactive and the selected model supports `xhigh`, the current Run Settings Mode selection is included as `claudeCodeMode` (`"ultracode"` or `null` for Default); otherwise the field is omitted. The folder picker mirrors the desktop web picker: it navigates directories through `GET /api/chat/browse`, can toggle hidden folders, create folders through `POST /api/chat/mkdir`, delete the current folder through `POST /api/chat/rmdir`, select the current folder, or choose the server default by omitting `workingDir`. Folder picker toolbar/footer actions use the same compact icon button styling as the Files sheet, with New folder positioned before Delete, plus Use Default, Cancel, and Select. Parent navigation is exposed as the first row in the directory list when a parent exists.
- Rename, archive, restore, and delete conversation.
- Reset session via `POST /api/chat/conversations/:id/reset`. The action closes the conversation sheet immediately, shows the chat loading state while the server archives/summarizes the ending session, replaces the open chat with the returned empty active session, clears pending interaction/attachment state, clears the in-memory list preview for that row, and then refreshes the authoritative conversation list so message count, title, and last-message preview match the server. When the stored conversation profile no longer exists, the PWA includes `{ cliProfileId, backend }` for the selected replacement profile if the current picker, a single backend-compatible profile, or the sole enabled profile provides an unambiguous repair. If no replacement can be chosen, reset is blocked locally with an error instead of sending an ambiguous request.
- Sessions sheet via `GET /api/chat/conversations/:id/sessions`. The sheet renders one compact card per session with mono session/date metadata, a serif session title, summary body text, a dashed stats footer, and equal-width `View` / `Share` action buttons. Current sessions are marked with a cyan left rail and live footer status. `Share` opens the existing session markdown download URL.
- Read-only session viewer via `GET /api/chat/conversations/:id/sessions/:num/messages`. Tapping `View` closes the sheet and opens a full-screen frozen transcript with a `Sessions` back button, session share action, read-only turn marker, compact message action pills, pinned-state strips, a three-cell session meter, and a locked read-only footer. The current session view uses the already-loaded active conversation messages; historical sessions load from the session messages endpoint.
- The conversation action sheet's **Share Markdown** action opens a picker with **All sessions** and **Current session**. All sessions opens `GET /api/chat/conversations/:id/download`; current session opens `GET /api/chat/conversations/:id/sessions/:sessionNumber/download` for the active session shown in the chat screen.
- Send message via `POST /api/chat/conversations/:id/message`. Submitting a normal chat message clears the composer immediately, appends a local pending user bubble, patches the open conversation's runtime metadata to the selected profile/backend/model/effort/Claude Code mode/Codex speed for that turn, marks the conversation as streaming, and shows an assistant live bubble with animated three-dot placeholder before the REST response returns. A synchronous send-in-flight guard prevents a second tap or stale render from issuing another normal send while the first POST is unresolved. This optimistic runtime patch makes the live assistant heading use the newly selected CLI identity during the first turn after changing profiles on an empty session. The request includes `claudeCodeMode: "ultracode"` only for Claude Code-family models that support `xhigh`, includes `claudeCodeMode: null` when the user explicitly chooses Default, and omits the field for other backends/models. When the server acknowledges the message, the pending user bubble is replaced with the returned `userMessage`; if the request fails before any active server stream is visible, the pending bubble is removed, the draft/attachments are restored, and the conversation runtime metadata reverts to the pre-send snapshot. `409 { error: "Conversation is already streaming" }` is a recoverable active-stream collision: the PWA removes only the optimistic pending message, restores the draft/attachments, keeps or re-enters active streaming state, clears the inline error banner, and reconnects through the normal WebSocket replay path instead of requiring the user to leave and reopen the conversation. For non-conflict send failures, the PWA first checks `GET /api/chat/active-streams`; when the server is still active, it treats the turn as accepted, keeps the composer cleared, keeps the optimistic user bubble visible, reconnects the stream, and fetches the server conversation to replace the optimistic bubble with the persisted user message when it is already available. The assistant placeholder switches to streamed Markdown on the first `text`/`thinking` frame and clears when an `assistant_message`, terminal `done`, abort, or non-streaming send completion finishes the turn.
- Stop stream via `POST /api/chat/conversations/:id/abort`. Close the local stream socket immediately, but retain streaming state until the abort request and conversation/goal/list refreshes complete. Send must remain unavailable while the server is still finalizing the aborted turn, including a delayed abort response, so immediate replacement does not collide with the old stream.
- WebSocket replay and live streaming for text, assistant messages, title updates, usage, errors, done, and replay start, with automatic active-stream polling/reconnect on mobile browser resume, network return, and transient socket errors.
- Assistant message text, assistant content-block text, thinking blocks, and live streaming text render through `marked` with GitHub Flavored Markdown and hard line breaks enabled, then pass through DOMPurify before insertion. Assistant markdown prose uses the same General Sans body typography as the desktop web UI `.prose` treatment, while markdown headings keep the serif prose font. Fenced and indented Markdown code blocks render as bounded monospace panels with a language label, per-block **Copy** button, preserved line breaks, and long-line wrapping (`white-space: pre-wrap` plus break-word/anywhere wrapping) so CLI-supplied text does not create horizontal overflow on narrow screens. Thinking blocks render as full-width dashed Markdown panels rather than inline flex chips so multi-paragraph Claude Code reasoning keeps normal line flow on narrow mobile screens. Assistant/live CLI message headings use the message backend's metadata label and inline SVG icon from `GET /api/chat/backends`, falling back to the Agent Cockpit logo when no backend icon is available. System messages without `goalEvent`, including native-session recovery notices, use the Agent Cockpit logo and **Agent Cockpit** heading instead of the selected harness identity. User-authored message text remains plain text after uploaded-file marker stripping, preserving line breaks and avoiding accidental interpretation of user text as HTML/Markdown.
- Plan approval and clarifying-question cards from `tool_activity` meta-events, answered through `POST /api/chat/conversations/:id/input`. Plan decisions come only from the explicit approve/reject buttons, so free text is never interpreted as approval; `useSendPipeline.submitInteraction(answer?)` sends a button's decision instead of the typed draft. It captures the submitted interaction object before awaiting the input response and uses a functional state update to clear only that same object after acknowledgement. On `{ mode: 'message' }` it sends the answer as a normal message with `clearComposer:false` and `restoreDraftOnFailure:false`, preserving the separate composer draft/uploads on success and failure, including edits made while the answer is sending; those uploads are not included in the answer request; `sendMessageNow` lets only that same interaction object past its pending-card guard, because the cleared state has not re-rendered yet, while a newer card still blocks the send. A subsequent question or replacement plan received while the HTTP request is pending stays visible and answerable, even when questions reuse one native tool ID.
- Correlated questions retain `inputRequestId` as `PendingInteraction.requestId` and submit it through the optional fourth identity argument of `api.sendInput`. Duplicate submissions are locked while pending; an old acknowledgement never clears a newer question's typed answer. A new request resets the answer, including repeated identical prompts. `allowFreeform:false` hides the textarea/Answer button and submits choices directly; otherwise choices prefill an editable answer. Stale correlated inputs never fall back to a normal message. Active replay reconstructs unanswered questions; matching tool outcomes resolve only their exact ID. Done/terminal errors clear correlated questions while legacy post-stream interactions keep their fallback behavior.
- `useChatStreamConnection` owns `inputTurnId`, accepts only the current socket/conversation's frames, and clears readiness on reconnect, socket closure and terminal state. `chatStreamEvents.ts` projects input readiness and exact request outcomes. A current Copilot token exposes **Steer** in the composer metadata row and selects the streaming composer hint even when static Copilot metadata leaves steering disabled; the ordinary Send action remains Queue during streaming. `useSendPipeline.steerDraft` posts the normal text/file wire content with current turn ID and a unique input ID, holds the draft/files until confirmed consumption, and blocks duplicate send/queue/steer operations. Stop stays available in the top bar. On success it removes only submitted unchanged text/files; on refusal/network error it preserves them and shows the existing error banner, without automatic resend or queue append. A conversation switch prevents a late acknowledgement from clearing another conversation's draft.
- Hosted qualification is scoped to the [owner's clean `9cb25d6` report](https://github.com/daronyondem/agent-cockpit/pull/571#issuecomment-6658673116): a narrow Chrome client on macOS, not a physical phone. Chat/questions, Stop followed by a new send, reload/recall, model/effort, files and retained delegated cards passed. Steering during a running command in an existing hosted conversation failed with `No response was returned`; its input HTTP/native trace was not captured, so this remains an open, unclassified finding. New fixed-model browser coverage exercises that running-tool/resumed-session sequence and cold-resume without replay, but does not establish a hosted fix. Physical-device behavior, live PWA delegation and hosted goal pause/reload/fresh-limit resume remain unconfirmed. No PWA implementation, metadata, manifest or service-worker change accompanies this qualification update.
- Browser Notification API prompts and hidden-tab notifications for stream done/error and interaction-needed events when permission is granted. This is not remote push.
- Queue read/write/clear via `GET`, `PUT`, and `DELETE /api/chat/conversations/:id/queue`.
- Queue auto-drain after clean `done` frames when no plan/question interaction is pending. The queue drainer sends the head without clearing the live composer draft/attachments; if the follow-up send is blocked by a still-active server stream or another send failure, the original queued item is restored at the queue head and persisted back to the server.
- Queue reorder and edit modal, including removal of uploaded attachment references.
- Attachment upload from browser file picker with progress and cancel. DNG uploads are normalized by the server into a generated `<original>.dng.preview.jpg` JPEG sidecar capped to a 2576 px long edge; the returned attachment chip/path is the JPEG preview (`kind: image`), while the original RAW file stays in the conversation artifacts directory and is not shown as a separate attachment. HEIC/HEIF has no special server conversion here; if Safari supplies JPEG bytes they use the normal JPEG path, otherwise unsupported uploads fail through the normal upload-error chip state.
- Delete completed pending uploads via `DELETE /api/chat/conversations/:id/upload/:filename`. Deleting a generated DNG preview attachment also removes the paired original DNG on the server.
- Pending plan/question cards retain optional `decisionId` from `tool_activity.id`. `ApiClient.sendInput(conversationID,text,streamActive,decisionId?)` echoes it in the shared request contract. CoCo requires the exact current decision generation; a 409 keeps the interaction/error visible and does not create a new user message. Newer interactions received while the response is pending remain intact. No PWA manifest or service-worker policy changes accompany this field.
- Image OCR insertion through `POST /api/chat/conversations/:id/attachments/ocr` with the selected `cliProfileId`, `backend`, `model` and `effort`; the server rejects OCR when the selected profile/backend cannot transport one-shot image input or the selected/default model does not report `model.capabilities.input.image`. When OCR repairs a missing stored conversation profile to the selected profile, the response includes a persisted Agent Cockpit system `recoveryMessage`; the PWA applies it through the same server-message upsert path used by stream events before inserting the returned Markdown into the draft.
- Send/queue wire-content composition by appending `[Uploaded files: <paths>]`.
- User-message uploaded-file marker stripping and file card rendering.
- Assistant `<!-- FILE_DELIVERY:/absolute/path -->` marker stripping and file card rendering. Only assistant markers create delivered-file references; a marker quoted in a user prompt does not advertise a file before the harness creates it. Delivered files use `GET /api/chat/conversations/:id/workspace-file` for previews/downloads so worktree-isolated conversations read from their execution checkout instead of the canonical base checkout.
- Assistant Markdown links that point at `data/chat/workspaces/<storageKey>/workspace-context/context/*.md` are intercepted in the mobile transcript and opened as file-preview references through `GET /api/chat/conversations/:id/workspace-context-file`; the server validates that the file belongs to the active conversation workspace. Preview sheets render `language:"markdown"` / `.md` responses as sanitized Markdown instead of raw code text.
- Assistant generated-artifact `contentBlocks` render as the same file cards/image previews, backed by `GET /api/chat/conversations/:id/files/:filename`.
- Text previews, markdown previews, image previews, file downloads, and Web Share API / fallback download for delivered files. File-preview references created from conversation responses preserve `executionDir` and `checkout` on list items even though the UI still groups workspaces by canonical `workingDir`/`workspaceId`. File-preview sheets use the shared modal header: the title/subtitle column may shrink and truncates long filenames or paths, while the `Close` button stays visible as a fixed trailing control.
- Session list, preview, and markdown download.
- Workspace tree browsing, parent navigation, text preview/edit/save, copy, image/binary open, file/folder creation, rename/move, delete, upload progress/cancel, and conflict overwrite retry. The root-level parent target can be the empty string returned by the explorer contract, so the Parent control is enabled whenever the current workspace-relative path is non-empty.
- CLI profile/model/effort/Claude Code mode/Codex speed selection. The Run Settings sheet keeps its option groups in an internal scroll region with safe-area bottom padding so long model/profile lists remain reachable on mobile Safari. Backend metadata is loaded to derive available models and CLI identity for the selected profile's protocol-derived backend, including OpenCode provider-scoped model catalogs discovered through the selected OpenCode profile. Profile switching is locked once the active session has messages, while model, effort, Claude Code mode, and Codex speed remain selectable. Claude Code profiles choose **Claude Code** vs **Claude Code Interactive** through the profile Protocol field in Settings; the Run Settings sheet does not expose a separate provider group. The **Mode** group appears only when the selected backend is Claude Code-family and the selected model supports `xhigh`; it offers Default and Ultracode, sends `claudeCodeMode` on conversation create/send/goal, and clears stale mode selection when the chosen runtime/model cannot support it. OpenRouter-backed OpenCode model choices hide a leading `openrouter/` provider prefix in visible labels while retaining the full id for the selected value sent to the server. Chat message authors mirror the desktop identity rule: normal harnesses render backend metadata labels, while OpenCode messages use the selected profile's `opencode.provider` label and recognized provider avatar assets when available, including DeepSeek, Ollama, OpenRouter, and OpenCode; model ids remain in the run settings metadata, not the message author. Codex speed offers Default/Fast, sends `serviceTier` on conversation create/send/goal, and clears stale Fast selection when the chosen runtime is not Codex.
- Backend-neutral goal mode in the chat composer. The composer metadata row exposes a compact `Goal` toggle whenever the selected profile/backend advertises goal `set` support through `capabilities.goals` or the built-in Codex/Claude Code-family fallback metadata; when enabled, the textarea placeholder and send button switch to goal-setting mode and submitting calls `POST /api/chat/conversations/:id/goal` with the current profile/model/effort selections plus Claude Code-only mode and Codex-only speed when applicable. `/goal` clears the composer and enables goal mode; `/goal <objective>` immediately sets a goal after stripping accidental copied goal-card/strip prefixes from the objective; `/goal pause`, `/goal resume`, and `/goal clear` call the matching goal endpoints only when the selected backend advertises that action. Unsupported slash actions surface an inline error, so Claude Code and Claude Code Interactive reject Pause/Resume instead of trying to emulate them. Goal starts and Codex resumes create only the assistant stream path, so no user bubble is added for the objective; the PWA commits a local active goal snapshot before the REST call returns so the composer strip is visible immediately, and the server-returned system `goalEvent` message is upserted into the transcript so the objective and later lifecycle/result state are visible. Goal status refresh preserves that local active runtime snapshot when `GET /goal` returns `null` before the just-started goal is readable from the backend, so the strip does not disappear during the initial status gap. `goal_updated` and `goal_cleared` WebSocket frames update the open chat and known conversation-list rows. An active goal keeps the row running/blue after the current stream's `done` frame by tracking active goal ids separately from active stream ids. A compact goal strip renders above the composer box with status, locally ticking elapsed time for active goals, objective preview, and action buttons derived from `goal.supportedActions`. Codex goals show Pause/Resume/Clear as appropriate. Claude Code-family goals show Clear when idle and never show Pause or Resume; Clear is disabled while a Claude Code or Claude Code Interactive stream is active because the server only runs `/goal clear` while idle. The strip polls `GET /goal` while mounted so paused/completed/budget-limited/transcript-derived changes made by the backend or another client do not stay stale; terminal statuses discovered by polling are deduped into transcript goal-event cards by the server. `Goal set` and `Goal achieved` lifecycle cards use the same blue treatment, while paused and budget-limited lifecycle cards retain warning/error styling. Token budget editing is not exposed in the PWA v1 UI; `budgetLimited` is display-only.
- Mobile-first installable shell with manifest, app icon, standalone display mode, and iOS home-screen metadata.

## Deferred Slices

The PWA intentionally does not yet cover:

- Memory and Knowledge Base mobile panels/live update bubbles.
- Cross-CLI instruction compatibility notifications and pointer creation.
- CLI update notifications and update actions. This is an intentional web-only parity decision because CLI binary updates are server-administration controls; see [parity-decisions.md](parity-decisions.md) and [ADR-0027](adr/0027-manage-cli-updates-from-web-cockpit.md).
- Data-root export/import migration. This is an installation-administration workflow that can destructively replace all active Agent Cockpit data after backup, so it remains in the desktop web Settings → Migration tab. The PWA continues to use the same server/data root after a desktop-triggered import restart.
- Workspace Git Changes status/diff view. This is currently a deliberate desktop-web-only slice because the shipped UI is a side-by-side code review surface that needs wide panes; see [parity-decisions.md](parity-decisions.md), [API spec](spec-api-endpoints.md#313-workspace-git-changes), and [Frontend spec](spec-frontend.md).
- Workspace Worktrees settings. The PWA consumes worktree-aware conversation metadata and delivered-file endpoints, but enabling/disabling worktree isolation remains a desktop Workspace Settings workflow.
- Workspace Routines management. Routine proposal cards, schedule/profile/channel editing, run history, and markdown workflow editing remain in desktop Workspace Settings for now; the server-side scheduler and external outreach channels still operate independently of the mobile client. See [ADR-0084](adr/0084-represent-workspace-routines-as-markdown-workflows.md), [Workspace Routines](spec-routines.md), and [parity-decisions.md](parity-decisions.md).
- Service worker offline caching. The app is server-backed and currently requires network access to the Agent Cockpit host.
- True remote push notifications. Browser notification support only works while the PWA/browser context is alive enough to receive WebSocket events.
- Reuse of desktop V2 settings, Memory, KB, and usage management screens.

## Verification

The PWA is verified with:

```bash
cd mobile/AgentCockpitPWA
npm run typecheck
npm run build
npm run visual:capture
```

Equivalent root-level commands are:

```bash
npm run mobile:typecheck
npm run mobile:build
npm run mobile:visual:capture
```

Browser-safe mobile model helpers are covered by `test/mobileAppModel.test.ts`, including optimistic transcript replacement/removal helpers used by the chat send path, goal slash-command parsing, reset-profile repair selection, stream reconnect backoff, and local runtime-goal preservation. Pure mobile stream event projection is covered by `test/mobileChatStreamEvents.test.ts`; the static guards in `test/frontendRoutes.test.ts` assert that `App.tsx` consumes the extracted hooks while stream, send, goal, and list-monitor behavior live in their owning modules, and that mobile chat Markdown code blocks keep per-block copy controls plus wrapping styles.

`npm run visual:capture` uses Playwright WebKit with the `iPhone 13` and `iPhone 15 Pro` device profiles and saves viewport screenshots under `mobile/AgentCockpitPWA/tmp/visual/`. It captures the conversation list, then opens the first conversation when present and captures chat, run settings, conversation actions, sessions, read-only session viewer, and files sheet states without triggering destructive actions. It targets the Vite dev server at `http://127.0.0.1:5174/mobile/` by default; run `npm run mobile:dev` first, set `PWA_URL` to capture another served instance, set `PWA_DEVICES` to override the comma-separated device profile list, or set `PWA_SCREENSHOT_DIR` to choose a different output directory. The authenticated server's production CSP omits `upgrade-insecure-requests`, so WebKit captures against a local HTTP `PWA_URL` such as `http://127.0.0.1:3335/mobile/` do not get upgraded to HTTPS by CSP.

The generated app is served from:

```text
/mobile/
```

When `WEB_BUILD_MODE=auto`, `MobileBuildService` verifies `public/mobile-built/.agent-cockpit-build.json` at server startup and rebuilds from `mobile/AgentCockpitPWA/` when the source or lockfiles are stale. The service uses `npm.cmd` through the shared `.cmd` wrapper on Windows and `npm` elsewhere. Dev self-update installs mobile dependencies and forces this build before restarting PM2; production self-update installs mobile dependencies in the staged release and runs the same build preflight only when the packaged mobile marker/assets are missing or stale.

### CoCo usage display (P7 C45)

`mobileChatScreen.tsx` composes `usageBar.tsx`, preserving session usage priority
and existing harness price/context formatting. CoCo has separate Cost and
Estimated Cost n/a cells for unknown Snowflake prices and a collapsible Token
breakdown with Fresh input, Output, Cache read and Cache write (including zero).
The total includes all four buckets via browser-safe
`src/contracts/usagePresentation.ts`. Missing context stays n/a; zero/missing
CoCo context has no fabricated minimum progress fill. The expanded details
explain that costs exclude unpriced CoCo usage. Existing positive reported costs
and rounded-up estimates stay intact for other harnesses. Build mobile assets;
no PWA manifest, identity, auth, service worker or offline policy changes.
Rendered tests live in `test/cortexUsageUi.test.ts`; the isolated native
`scripts/probe-cortex-usage.ts` verifies display, reload and PM2 restart counters.

### CoCo mobile acceptance and OCR ownership (P7 C46)

Native CoCo 1.2.35/macOS Chromium acceptance passed; see the tracker and testing
specification for exact reports, failures and physical/platform limits.

The send pipeline carries explicit `{name}` upload references from each message's
attachment snapshot, including persisted queue entries, alongside the existing
uploaded-file wire text. The server resolves filenames within the conversation's
uploads; paths/kinds supplied by clients or pasted into prose cannot create native
media. Native CoCo still validates PNG bytes, model, version and limits.

`usePendingAttachments.ts` sends the current Run Settings model/effort as well
as profile/backend to OCR. This matters before the first chat message, when the
saved conversation can still use Auto while the composer has selected a verified
image model. The route validates those optional invocation overrides and keeps
the stored chat model/effort unchanged. Existing clients omitting them retain
saved-selection fallback. Profile repair/locking and image byte/model gates stay
unchanged; CoCo PNG support is still limited to Sonnet 4.6/CLI 1.2.35.

The hook reserves a per-attachment OCR job synchronously, suppressing duplicate
requests before React renders. It tracks current options/attachments and binds
results to conversation, currentSessionId, attachment and job identity. Removal,
clear/send, reset, navigation and unmount cannot insert late text or recovery
messages into another draft/session. A model/effort/profile change may cache a
still-owned successful result, but does not insert it automatically or overwrite
the newer runtime selection. Explicit Insert OCR uses the cached Markdown;
failures retain the image/draft and allow an explicit retry. Completing OCR uses
the latest draft appender, preserving edits made during the request. Suppressing
a stale response does not claim cancellation of the server's bounded OCR job.

`test/cortexMobileAttachments.test.ts` covers deferred completion, duplicate
calls, cached insertion, navigation/reset/removal/clear/model/unmount ownership,
failure and explicit retry. Route/contract and desktop store tests cover selected
model/effort, legacy omission, invalid/unverified selection and unchanged stored
chat values. The opt-in `scripts/probe-cortex-mobile.ts` uses real CoCo through
production Chromium assets at 390×844 in an isolated PM2/data/workspace fixture:
profile/model/effort selection and locking, unsupported Goal/Speed/Mode controls,
PNG/text upload, native OCR/cache, image and text chat, thinking/tools, socket
replay, explicit durable artifacts, actual download bytes after original-file
mutation, reset/read-only history, descendant Stop cleanup and fresh inference
without retrying interrupted work. Python fixtures are syntax-checked before
native execution. Native C43/C44/C45 probes provide the separate decision,
queue and usage portions of the acceptance matrix. This is browser acceptance
with a native macOS CLI, not physical iOS/Android/Safari/share-sheet certification.

Rebuild ignored mobile output after source changes. No PWA manifest, identity,
service-worker/offline cache policy, administration screen or public asset source
change accompanies C46. C26, strict Memory, C47 and platform gates stay separate.

The read-only session screen stays above chat and below modal backdrops (z-index
10 and 20 respectively). Artifact preview dialogs opened from history remain
visible and their Close controls receive pointer input; the native probe clicks
them without forcing or bypassing hit testing. The read-only viewer itself has
no composer, while the underlying current-chat screen can remain mounted.
Selecting Sessions first dismisses the Conversation actions sheet, so it cannot
remain mounted and intercept input after the session list closes. The rendered
selection/history test verifies that transition before native pointer checks.

### Consolidated client and responsive setup verification (P7 C47)

The full desktop/mobile behavior suite, types and production builds pass. The
standard desktop Welcome/Settings setup remains the narrow-browser setup path;
no PWA administration, source asset, manifest, identity or offline/service-worker
change is introduced. The auth probe checks 1280/390/320 px clipboard transfer,
transient clearing/reload recovery and no persistent browser handoff material
with synthetic browser-local callbacks, separately from native saved-auth/fresh
inference. C43–C46 retain the native mobile chat matrix for unchanged production
source. This does not certify physical iOS/Android/Safari clipboard behavior,
C26's human remote-browser OAuth, or another native platform.


P8 C48 adds optional CoCo detection/installation to desktop Welcome, including
narrow desktop viewports. The mobile PWA has no installation/admin screen;
its source, manifest, service-worker and metadata remain unchanged. Existing
mobile chat/attachment/auth ownership contracts are unaffected.


P8 C49 CLI Update remains desktop server administration. CoCo update/runtime
cleanup is shared backend behavior; the PWA adds no update control, route/body,
manifest, service-worker or source asset change. Mobile chat uses fresh runtimes
after the existing reusable backend shutdown; interrupted tool work is not replayed.

Current Copilot browser qualification passes 40 combined desktop/PWA and narrow
Settings Chromium cases on macOS and Ubuntu with the real SDK runtime, fixed
local replies and isolated auth/data. The Windows SDK startup failure and
remaining hosted/platform auth limits are recorded in the
[testing spec](spec-testing.md#copilot-published-ci-evidence). The catalog,
structured-input and delegation checkpoint counts below are implementation
history, not the current total or a claim of hosted authentication.

Copilot browser regression coverage in `test/e2e/copilot.ui.pw.ts` uses the real
CLI with fixed local replies and an isolated PM2 fixture server. Mobile cases
exercise profile selection, streamed Memory tool/result presentation, native
Stop followed by immediate send and reload, draft/attachment preservation on a
temporary reset rejection, and reset/archive/restore/delete navigation. Memory
management panels and live Memory bubbles are outside the current PWA scope;
this coverage does not add those surfaces. See `npm run e2e:copilot-ui` and the testing spec.

The runtime model-catalog checkpoint adds a browser case per client using an
injected account/fallback catalog, including exact effort choices, missing saved
IDs, explicit effort clearing on send, and post-navigation fallback status.
Ten combined Chromium cases pass locally on macOS: eight real SDK/local-provider
workflows plus these two catalog fixtures. This does not certify a successful
hosted catalog or new mobile media transport.

The structured-input checkpoint expands the shared Chromium suite to eighteen
cases (sixteen real SDK/local-provider workflows plus two catalog fixtures).
Both clients pass repeated questions after reload, stale answer rejection,
freeform input, Stop during a question with a retained draft/file, native
steering consumption, and late-steering draft/file preservation. The CLI is
1.0.105 on macOS arm64; these checks do not certify hosted access or native
Windows/Linux SDK behavior. No public/mobile assets, manifest, service-worker,
or offline caching behavior changes are required.


The delegated-work checkpoint expands that suite to twenty-two Chromium cases:
twenty real SDK/local-provider workflows and two catalog fixtures, all passing
on CLI 1.0.105/macOS arm64. The new case per client holds a real background
child after its tool, keeps the parent stream active through an early reply,
reopens the active stream without duplicated cards/children, releases completion
and verifies saved summaries after reload. A second case stops a real delegated
worker, checks cancelled history and cold resume without replay. Desktop
initial history hydration now preserves live/replayed rows; Stop checks expand
the existing desktop progress disclosure. Both clients retain legacy completed
activities without explicit outcomes. No PWA metadata/offline-policy changes.

### Copilot native goal controls

SDK profile metadata enables the shared goal composer, slash commands, strip and
persisted lifecycle cards. Opaque JSONL profiles keep goals unavailable. Copilot
Clear stays hidden. A paused goal shows a labeled **Fresh AI credit limit** number
input; Resume stays disabled until its value is finite and positive, then sends
`{aiCreditLimit:number}`. API actions also validate before optimistic streaming.
No default window is chosen. Native `aiCreditsUsed / aiCreditLimit` is labeled
**AI credits**, independently of token budgets and USD. Copilot omits an unreported
elapsed timer. Reload reads the native saved objective; Stop/pause retains it.
Intentional Pause saves a paused lifecycle card without a stream-failure notice.
See [backend control semantics](spec-backend-services.md#copilot-native-goals-copilotgoalsts).

### Copilot usage visibility

`copilotUsage.tsx` owns the mobile Copilot usage and quota panels, composed by
`mobileChatScreen.tsx`. Show all four disjoint token buckets, AI credits with
complete/partial/unavailable provenance, Copilot-only premium requests, unavailable
USD cost/estimate, measured context counts/limit and observation time. Do not
reuse another harness's credits or dollar totals as Copilot billing.
`AgentCockpitAPI.getCopilotQuota(profileId)` reads the shared quota contract.
The account panel refreshes on profile/message changes and every minute, ignores
late responses from the previous profile, clears visible data on HTTP failure,
and cancels its timer on unmount. Label stale account readings and unknown quota
units; retain native percentage, unlimited and reset metadata. Account timestamps
explicitly allow delayed service aggregation. Context persists through reload.
Usage and account quota use separate collapsed disclosures to preserve chat/composer space. Expanded usage has two columns; quota uses full-width rows. Values wrap, and expanded contents scroll within 180px rather than truncating measurement times or unknown-unit labels. No manifest, service worker, PWA installation or public asset policy changes.

### Copilot media and live artifacts

The existing upload/send pipeline keeps its wire format and draft/file retention
on an actionable media-admission `400`. SDK image/PDF eligibility is exact to
the effective model and provider, with unknown transports gated server-side.
PDF support is not implied by a vision flag.

`chatStreamEvents.ts` accepts a stored descriptor from an `artifact` browser
frame and emits `append-stream-artifact` plus removal of the writing placeholder.
`useChatStreamConnection.ts` owns `streamArtifacts`; the pure `liveArtifacts.ts`
append helper deduplicates by filename and sourceToolId without mutating prior
state. Starting/replaying a stream, receiving its saved assistant message, or
ending the stream clears live artifacts. Stale sockets/conversations retain the
existing event guards. Saved assistant content blocks replace live cards, so
reconnect/reload and Stop do not duplicate outputs.

ChatScreen renders live artifact FileCards with the same artifact references,
Preview and Share behavior as saved history. Artifact filename changes participate
in scroll-follow signatures; cards alone keep the streaming response visible.
Already-delivered files are persisted by the server before the frame is sent.
Normal FILE_DELIVERY cards and the composer remain available. No PWA manifest,
service-worker, static public/mobile, or installation behavior changes.

### Copilot guided auth impact

Copilot device login is managed in the full web app's Global Settings → CLI
Profiles, like the existing account-auth administration flows. The mobile PWA
continues selecting shared self-configured Copilot profiles; it does not expose
an independent-account/login screen or store credentials. No mobile request,
manifest, service-worker or public/mobile asset contract changes are needed.
The full web auth controls are verified at desktop and narrow browser widths;
that narrow test is not a mobile-PWA auth feature. Existing desktop/mobile chat
qualification continues covering profile selection, reload and native workflows.
