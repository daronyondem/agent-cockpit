# Mobile PWA Client

[← Back to index](SPEC.md)

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
- `src/App.tsx` — mobile UI shell and state machine. It renders conversation list, chat transcript, composer, backend-neutral goal controls, queue stack/editor, run settings, conversation actions, sessions, workspace files, file preview/share, attachment tray, interaction cards, and stream controls.
- `src/appModel.ts` — browser-only mobile app model helpers for file-delivery marker parsing, typed file preview references, reset-session list reconciliation, conversation-list projection, queue wire content, attachment filtering, backend-neutral goal timestamp/elapsed/status/action projection, accidental goal-card objective cleanup, workspace path formatting, and shared formatters. These helpers are covered separately so the main UI shell can stay focused on state orchestration.
- `src/useViewportHeightVar.ts` — visual-viewport hook that owns the iOS Safari app-shell sizing variables (`--app-height`, `--app-width`, `--app-top`, and `--app-left`) and document scroll reset behavior.
- `src/api.ts` — same-origin TypeScript API client for current-user, settings, backends, profile metadata, conversations, local directory browsing, message pinning, streams, backend-neutral goal fetch/set/resume/pause/clear, returned goal-event transcript messages, queue, sessions, attachments/OCR, file delivery, workspace explorer, and WebSocket URLs. Conversation create, message-pin, message send, stdin input, and explorer mutation bodies use type-only imports from browser-safe `src/contracts/*` files so mobile request shapes compile against the same contract types as the server. State-changing requests lazily fetch CSRF tokens and send `x-csrf-token`. Multipart uploads use `XMLHttpRequest` for progress and cancel.
- `src/types.ts` — TypeScript mirrors for the PWA data models, including the shared `ThreadGoal` and `GoalEvent` transcript fields plus goal WebSocket frames.
- `src/styles.css` — mobile-first CSS for the PWA shell.

**Served files:** `public/mobile-built/`

`npm run build` writes `index.html`, `manifest.webmanifest`, SVG/PNG icon assets, and hashed CSS/JS assets here. These files are served by the explicit `/mobile` `express.static(public/mobile-built)` mount after `requireAuth`, so unauthenticated visitors are redirected to the normal web login before the PWA shell is served. Generated output is ignored by git; tracked mobile install metadata remains in `mobile/AgentCockpitPWA/public/`.

Production GitHub Release artifacts include `public/mobile-built/index.html` and
the generated mobile asset tree. `scripts/package-release.js` refuses to create
a release archive when the mobile build shell is missing, the manual release
workflow runs `npm run mobile:typecheck` and `npm run mobile:build`, and the
macOS/Windows installers verify the packaged mobile shell before startup.
Production updates run `npm --prefix mobile/AgentCockpitPWA ci` inside the extracted
release and then run `MobileBuildService` for that release when build markers or
assets are missing or stale before activating the release. Dev updates
continue to force `npm --prefix mobile/AgentCockpitPWA install` plus
`npm run mobile:build` before PM2 restart.

`public/mobile/` contains only a hidden ADR placeholder so historical decision records can keep validating affected paths. It is not a generated output directory and does not contain served PWA assets.

## Runtime Architecture

The PWA runs in the phone browser or as an installed home-screen web app. It does not need a separate pairing flow because it is same-origin with the server:

1. The user opens `/mobile/` on the Agent Cockpit server.
2. `requireAuth` protects `/mobile/` like `/v2/`. If no session exists, the user goes through the existing browser auth flow.
3. Once loaded, the PWA calls same-origin `/api/me`, `/api/chat/settings`, `/api/chat/backends`, `/api/chat/active-streams`, and `/api/chat/conversations`.
4. REST calls use `credentials: "same-origin"`, the browser's `connect.sid` cookie, and CSRF tokens from `GET /api/csrf-token`.
5. Streaming uses `ws(s)://<same-origin>/api/chat/conversations/:id/ws` and sends `{ "type": "reconnect" }` on open.
   - Chat-view stream socket transport failures are treated as transient while the conversation is still active. The PWA does not surface a WebSocket transport error banner for an in-flight stream. Instead it polls `GET /api/chat/active-streams`, reconnects with the normal replay contract when the conversation is still active, and refreshes the conversation if the stream already completed while the browser was suspended.
   - `visibilitychange`, browser `focus`, and `online` events trigger the same active-stream check and replay reconnect for the open chat so iOS Safari background/sleep socket loss can recover without a manual refresh.
6. While the conversation list is visible, the PWA opens passive WebSocket monitors for conversations returned by `/api/chat/active-streams`. Those sockets use the same reconnect contract as chat views, ignore text deltas, react to `assistant_message`, `title_updated`, `goal_updated`, `goal_cleared`, terminal `error`, `done`, and interaction-needed `tool_activity` frames, and refresh the list when a stream reaches a terminal state. Known active backend-neutral goals keep their list rows in the running/blue state after the current backend stream ends, without pretending there is still an active WebSocket stream. The list also refreshes on focus/visibility return and every 15 seconds as a fallback for suspended browsers, missed sockets, and activity started from another client. The multi-client WebSocket transport decision is recorded in [ADR-0028](adr/0028-allow-multiple-websocket-clients-per-conversation.md).

For reverse-proxy base paths, the API base is derived from the current URL by replacing `/mobile/...` with `/`, matching the desktop V2 client's base-path behavior.

## Implemented Slice

The PWA currently covers:

- Same-origin authenticated load via the existing web auth session.
- Warm editorial cockpit visual system across the mobile shell: warm paper background, white cards/sheets, cyan brand/status accents, the shared desktop-web Agent Cockpit logo asset, serif titles, desktop-matched General Sans assistant prose and controls, JetBrains Mono instrumentation labels, segmented list controls, instrumented conversation cards, meter-style usage rows, rounded bottom sheets, compact session cards, prototype-style icon buttons in chat/actions/files surfaces, and file rows with glyph blocks instead of textual `[dir]` prefixes.
- App-like viewport locking: the document body does not scroll horizontally or vertically, the root/app shell are fixed to the visual viewport, accidental document scroll is reset during viewport/focus/scroll updates, and only intended panes (conversation list, transcript, modals, queues, attachment trays) scroll inside their own bounds. The viewport meta includes `interactive-widget=resizes-content`, and the React shell maintains `--app-height` / `--app-width` from `window.visualViewport.height` / `window.visualViewport.width` plus `--app-top` / `--app-left` from `window.visualViewport.offsetTop` / `window.visualViewport.offsetLeft` so the top bar, composer, modal sheets, and list screen stay inside the visible iOS viewport even if Safari reports a horizontally panned visual viewport. Those metrics are rounded, CSS variables are rewritten only when the rounded metric tuple changes, and scroll positions are only reset when non-zero so frequent Safari visual-viewport events do not create visible repaint churn. The conversation-list toolbar constrains the workspace selector to its own row and clamps controls/cards to the shell width so child content cannot create a horizontal scroll range. Text inputs and textareas use 16 px text or larger to avoid iOS Safari focus zoom. Desktop max-width framing is limited to fine-pointer/hover devices so touch browsers with unusual viewport reporting still get the full-width mobile shell.
- Current-user display via `GET /api/me`.
- Settings/default loading via `GET /api/chat/settings`.
- Backend metadata loading via `GET /api/chat/backends`.
- Profile-specific backend metadata loading via `GET /api/chat/cli-profiles/:profileId/metadata`.
- Active/archived conversation list via `GET /api/chat/conversations`.
- Flat latest-first conversation list with a workspace select filter. `All conversations` is the default; choosing a workspace filters the list to that `workspaceHash` without introducing collapsible workspace groups. Each card renders the workspace label in the header and keeps the timestamp in the footer beside message count/live status so the date appears only once.
- Conversation-list previews strip uploaded-file/file-delivery wire markers. Attachment-only previews render as human labels such as `Attachment: IMG_3021.PNG` rather than exposing absolute artifact paths.
- Active-stream summary hydration via `GET /api/chat/active-streams`.
- Conversation-list running badges update automatically from passive WebSocket monitors and REST fallback refreshes; the manual Refresh icon button remains a recovery control for explicit user-triggered reconciliation.
- Open conversation via `GET /api/chat/conversations/:id`.
- Opening a conversation scrolls the transcript to the newest message. The transcript continues following newly appended messages and streaming text until the user scrolls away from the bottom. During an active stream, that manual scroll pauses auto-follow and shows a floating **Back to end** button inside the transcript area; tapping it scrolls to the latest content and restores auto-follow. Manually scrolling back within 48 px of the bottom restores auto-follow without tapping the button.
- Message pin/unpin through `PATCH /api/chat/conversations/:id/messages/:messageId/pin`. The chat view renders a sticky pinned-message strip below the topbar with pinned count, active pinned preview, dot indicators, and previous/next controls; tapping a pinned item scrolls the transcript to that message and briefly outlines it. Pinned bubbles render a small dashed `PINNED` strip and accent left rail. Each active-session message exposes Copy, Copy MD, and Pin/Unpin as a compact icon pill in the message heading.
- Create conversation via `POST /api/chat/conversations`. The New Conversation working directory is a full-width read-only path display with Browse and Default actions on the following row, and its Create/Cancel controls use the same prototype-style icon button treatment as other mobile sheets. If the conversation list is filtered to a single workspace, opening New Conversation preselects that workspace path and the folder picker opens there; if `All conversations` is selected, the modal keeps the current server settings/default behavior. The folder picker mirrors the desktop web picker: it navigates directories through `GET /api/chat/browse`, can toggle hidden folders, create folders through `POST /api/chat/mkdir`, delete the current folder through `POST /api/chat/rmdir`, select the current folder, or choose the server default by omitting `workingDir`. Folder picker toolbar/footer actions use the same compact icon button styling as the Files sheet, with New folder positioned before Delete, plus Use Default, Cancel, and Select. Parent navigation is exposed as the first row in the directory list when a parent exists.
- Rename, archive, restore, and delete conversation.
- Reset session via `POST /api/chat/conversations/:id/reset`. The action closes the conversation sheet immediately, shows the chat loading state while the server archives/summarizes the ending session, replaces the open chat with the returned empty active session, clears pending interaction/attachment state, clears the in-memory list preview for that row, and then refreshes the authoritative conversation list so message count, title, and last-message preview match the server.
- Sessions sheet via `GET /api/chat/conversations/:id/sessions`. The sheet renders one compact card per session with mono session/date metadata, a serif session title, summary body text, a dashed stats footer, and equal-width `View` / `Share` action buttons. Current sessions are marked with a cyan left rail and live footer status. `Share` opens the existing session markdown download URL.
- Read-only session viewer via `GET /api/chat/conversations/:id/sessions/:num/messages`. Tapping `View` closes the sheet and opens a full-screen frozen transcript with a `Sessions` back button, session share action, read-only turn marker, compact message action pills, pinned-state strips, a three-cell session meter, and a locked read-only footer. The current session view uses the already-loaded active conversation messages; historical sessions load from the session messages endpoint.
- Full-conversation markdown download.
- Send message via `POST /api/chat/conversations/:id/message`.
- Stop stream via `POST /api/chat/conversations/:id/abort`.
- WebSocket replay and live streaming for text, assistant messages, title updates, usage, errors, done, and replay start, with automatic active-stream polling/reconnect on mobile browser resume, network return, and transient socket errors.
- Assistant message text, assistant content-block text, thinking blocks, and live streaming text render through `marked` with GitHub Flavored Markdown and hard line breaks enabled, then pass through DOMPurify before insertion. Assistant markdown prose uses the same General Sans body typography as the desktop web UI `.prose` treatment, while markdown headings keep the serif prose font. Assistant/live CLI message headings use the message backend's metadata label and inline SVG icon from `GET /api/chat/backends`, falling back to the Agent Cockpit logo when no backend icon is available. User-authored message text remains plain text after uploaded-file marker stripping, preserving line breaks and avoiding accidental interpretation of user text as HTML/Markdown.
- Plan approval and clarifying-question cards from `tool_activity` meta-events, answered through `POST /api/chat/conversations/:id/input`.
- Browser Notification API prompts and hidden-tab notifications for stream done/error and interaction-needed events when permission is granted. This is not remote push.
- Queue read/write/clear via `GET`, `PUT`, and `DELETE /api/chat/conversations/:id/queue`.
- Queue auto-drain after clean `done` frames when no plan/question interaction is pending.
- Queue reorder and edit modal, including removal of uploaded attachment references.
- Attachment upload from browser file picker with progress and cancel.
- Delete completed pending uploads via `DELETE /api/chat/conversations/:id/upload/:filename`.
- Image OCR insertion through `POST /api/chat/conversations/:id/attachments/ocr`.
- Send/queue wire-content composition by appending `[Uploaded files: <paths>]`.
- User-message uploaded-file marker stripping and file card rendering.
- Assistant `<!-- FILE_DELIVERY:/absolute/path -->` marker stripping and file card rendering.
- Assistant generated-artifact `contentBlocks` render as the same file cards/image previews, backed by `GET /api/chat/conversations/:id/files/:filename`.
- Text previews, image previews, file downloads, and Web Share API / fallback download for delivered files. File-preview sheets use the shared modal header: the title/subtitle column may shrink and truncates long filenames or paths, while the `Close` button stays visible as a fixed trailing control.
- Session list, preview, and markdown download.
- Workspace tree browsing, parent navigation, text preview/edit/save, copy, image/binary open, file/folder creation, rename/move, delete, upload progress/cancel, and conflict overwrite retry. The root-level parent target can be the empty string returned by the explorer contract, so the Parent control is enabled whenever the current workspace-relative path is non-empty.
- CLI profile/model/effort/Codex speed selection. The Run Settings sheet keeps its option groups in an internal scroll region with safe-area bottom padding so long model/profile lists remain reachable on mobile Safari. Backend metadata is loaded to derive available models and CLI identity for the selected profile's protocol-derived backend. Profile switching is locked once the active session has messages, while model, effort, and Codex speed remain selectable. Claude Code profiles choose **Claude Code** vs **Claude Code Interactive** through the profile Protocol field in Settings; the Run Settings sheet does not expose a separate provider group. Codex speed offers Default/Fast, sends `serviceTier` on conversation create/send/goal, and clears stale Fast selection when the chosen runtime is not Codex.
- Backend-neutral goal mode in the chat composer. The composer metadata row exposes a compact `Goal` toggle whenever the selected profile/backend advertises goal `set` support through `capabilities.goals` or the built-in Codex/Claude Code-family fallback metadata; when enabled, the textarea placeholder and send button switch to goal-setting mode and submitting calls `POST /api/chat/conversations/:id/goal` with the current profile/model/effort selections plus Codex-only speed when applicable. `/goal` clears the composer and enables goal mode; `/goal <objective>` immediately sets a goal after stripping accidental copied goal-card/strip prefixes from the objective; `/goal pause`, `/goal resume`, and `/goal clear` call the matching goal endpoints only when the selected backend advertises that action. Unsupported slash actions surface an inline error, so Claude Code and Claude Code Interactive reject Pause/Resume instead of trying to emulate them. Goal starts and Codex resumes create only the assistant stream path, so no user bubble is added for the objective; the PWA commits a local active goal snapshot before the REST call returns so the composer strip is visible immediately, and the server-returned system `goalEvent` message is upserted into the transcript so the objective and later lifecycle/result state are visible. Goal status refresh preserves that local active runtime snapshot when `GET /goal` returns `null` before the just-started goal is readable from the backend, so the strip does not disappear during the initial status gap. `goal_updated` and `goal_cleared` WebSocket frames update the open chat and known conversation-list rows. An active goal keeps the row running/blue after the current stream's `done` frame by tracking active goal ids separately from active stream ids. A compact goal strip renders above the composer box with status, locally ticking elapsed time for active goals, objective preview, and action buttons derived from `goal.supportedActions`. Codex goals show Pause/Resume/Clear as appropriate. Claude Code-family goals show Clear when idle and never show Pause or Resume; Clear is disabled while a Claude Code or Claude Code Interactive stream is active because the server only runs `/goal clear` while idle. The strip polls `GET /goal` while mounted so paused/completed/budget-limited/transcript-derived changes made by the backend or another client do not stay stale; terminal statuses discovered by polling are deduped into transcript goal-event cards by the server. `Goal set` and `Goal achieved` lifecycle cards use the same blue treatment, while paused and budget-limited lifecycle cards retain warning/error styling. Token budget editing is not exposed in the PWA v1 UI; `budgetLimited` is display-only.
- Mobile-first installable shell with manifest, app icon, standalone display mode, and iOS home-screen metadata.

## Deferred Slices

The PWA intentionally does not yet cover:

- Memory and Knowledge Base mobile panels/live update bubbles.
- Cross-CLI instruction compatibility notifications and pointer creation.
- CLI update notifications and update actions. This is an intentional web-only parity decision because CLI binary updates are server-administration controls; see [parity-decisions.md](parity-decisions.md) and [ADR-0027](adr/0027-manage-cli-updates-from-web-cockpit.md).
- Workspace Git Changes status/diff view. This is currently a deliberate desktop-web-only slice because the shipped UI is a side-by-side code review surface that needs wide panes; see [parity-decisions.md](parity-decisions.md), [API spec](spec-api-endpoints.md#313-workspace-git-changes), and [Frontend spec](spec-frontend.md).
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

`npm run visual:capture` uses Playwright WebKit with the `iPhone 13` and `iPhone 15 Pro` device profiles and saves viewport screenshots under `mobile/AgentCockpitPWA/tmp/visual/`. It captures the conversation list, then opens the first conversation when present and captures chat, run settings, conversation actions, sessions, read-only session viewer, and files sheet states without triggering destructive actions. It targets the Vite dev server at `http://127.0.0.1:5174/mobile/` by default; run `npm run mobile:dev` first, set `PWA_URL` to capture another served instance, set `PWA_DEVICES` to override the comma-separated device profile list, or set `PWA_SCREENSHOT_DIR` to choose a different output directory. The authenticated server's production CSP omits `upgrade-insecure-requests`, so WebKit captures against a local HTTP `PWA_URL` such as `http://127.0.0.1:3335/mobile/` do not get upgraded to HTTPS by CSP.

The generated app is served from:

```text
/mobile/
```

When `WEB_BUILD_MODE=auto`, `MobileBuildService` verifies `public/mobile-built/.agent-cockpit-build.json` at server startup and rebuilds from `mobile/AgentCockpitPWA/` when the source or lockfiles are stale. Dev self-update installs mobile dependencies and forces this build before restarting PM2; production self-update installs mobile dependencies in the staged release and runs the same build preflight only when the packaged mobile marker/assets are missing or stale.
