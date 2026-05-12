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
  - `npm run dev` — Vite development server on port `5174`, with `/api`, `/auth`, and `/logo-full-no-text.svg` proxied to `http://localhost:3334`.
  - `npm run build` — production build that writes to `../../public/mobile-built`.
  - `npm run preview` — local Vite preview server.
  - `npm run typecheck` — `tsc --noEmit`.
- Root `package.json` exposes wrappers for the same package:
  - `npm run mobile:dev` — runs the PWA Vite dev server.
  - `npm run mobile:build` — builds the PWA into ignored `public/mobile-built/`. Startup and self-update call the same production build through `MobileBuildService` when generated assets are missing or stale.
  - `npm run mobile:typecheck` — type-checks the PWA.
- `vite.config.ts` — sets `base: "/mobile/"`, installs the React plugin, and emits the production bundle to `public/mobile-built/`.
- `index.html` — PWA HTML shell with viewport-safe mobile metadata, `theme-color`, `apple-mobile-web-app-capable`, manifest link, SVG/PNG favicon links, explicit `apple-touch-icon`, and root mount.
- `public/manifest.webmanifest`, `public/icon.svg`, `public/icon-192.png`, `public/icon-512.png`, and `public/apple-touch-icon.png` — tracked source install metadata and icons copied into `public/mobile-built/` during build. iOS home-screen installs use the 180x180 PNG `apple-touch-icon`; the manifest also lists PNG icons because Safari is not reliable with SVG-only PWA icons.
- `src/main.tsx` — React entrypoint.
- `src/App.tsx` — mobile UI shell and state machine. It renders conversation list, chat transcript, composer, queue stack/editor, run settings, conversation actions, sessions, workspace files, file preview/share, attachment tray, interaction cards, and stream controls.
- `src/appModel.ts` — browser-only mobile app model helpers for file-delivery marker parsing, typed file preview references, reset-session list reconciliation, conversation-list projection, queue wire content, attachment filtering, workspace path formatting, and shared formatters. These helpers are covered separately so the main UI shell can stay focused on state orchestration.
- `src/useViewportHeightVar.ts` — visual-viewport hook that owns the iOS Safari app-shell sizing variables (`--app-height`, `--app-width`, `--app-top`, and `--app-left`) and document scroll reset behavior.
- `src/api.ts` — same-origin TypeScript API client for current-user, settings, backends, profile metadata, conversations, message pinning, streams, queue, sessions, attachments/OCR, file delivery, workspace explorer, and WebSocket URLs. Conversation create, message-pin, message send, stdin input, and explorer mutation bodies use type-only imports from browser-safe `src/contracts/*` files so mobile request shapes compile against the same contract types as the server. State-changing requests lazily fetch CSRF tokens and send `x-csrf-token`. Multipart uploads use `XMLHttpRequest` for progress and cancel.
- `src/types.ts` — TypeScript mirrors for the PWA data models.
- `src/styles.css` — mobile-first CSS for the PWA shell.

**Served files:** `public/mobile-built/`

`npm run build` writes `index.html`, `manifest.webmanifest`, SVG/PNG icon assets, and hashed CSS/JS assets here. These files are served by the explicit `/mobile` `express.static(public/mobile-built)` mount after `requireAuth`, so unauthenticated visitors are redirected to the normal web login before the PWA shell is served. Generated output is ignored by git; tracked mobile install metadata remains in `mobile/AgentCockpitPWA/public/`.

Production GitHub Release artifacts include `public/mobile-built/index.html` and
the generated mobile asset tree. `scripts/package-release.js` refuses to create
a release tarball when the mobile build shell is missing, the manual release
workflow runs `npm run mobile:typecheck` and `npm run mobile:build`, and the
macOS installer verifies the packaged mobile shell before startup. Production
updates run `npm --prefix mobile/AgentCockpitPWA ci` inside the extracted
release and then run `MobileBuildService` for that release when build markers or
assets are missing or stale before switching the `current` symlink. Dev updates
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
6. While the conversation list is visible, the PWA opens passive WebSocket monitors for conversations returned by `/api/chat/active-streams`. Those sockets use the same reconnect contract as chat views, ignore text deltas, react to `assistant_message`, `title_updated`, terminal `error`, `done`, and interaction-needed `tool_activity` frames, and refresh the list when a stream reaches a terminal state. The list also refreshes on focus/visibility return and every 15 seconds as a fallback for suspended browsers, missed sockets, and activity started from another client. The multi-client WebSocket transport decision is recorded in [ADR-0028](adr/0028-allow-multiple-websocket-clients-per-conversation.md).

For reverse-proxy base paths, the API base is derived from the current URL by replacing `/mobile/...` with `/`, matching the desktop V2 client's base-path behavior.

## Implemented Slice

The PWA currently covers:

- Same-origin authenticated load via the existing web auth session.
- App-like viewport locking: the document body does not scroll horizontally or vertically, the root/app shell are fixed to the visual viewport, accidental document scroll is reset during viewport/focus/scroll updates, and only intended panes (conversation list, transcript, modals, queues, attachment trays) scroll inside their own bounds. The viewport meta includes `interactive-widget=resizes-content`, and the React shell maintains `--app-height` / `--app-width` from `window.visualViewport.height` / `window.visualViewport.width` plus `--app-top` / `--app-left` from `window.visualViewport.offsetTop` / `window.visualViewport.offsetLeft` so the top bar, composer, modal sheets, and list screen stay inside the visible iOS viewport even if Safari reports a horizontally panned visual viewport. Those metrics are rounded, CSS variables are rewritten only when the rounded metric tuple changes, and scroll positions are only reset when non-zero so frequent Safari visual-viewport events do not create visible repaint churn. The conversation-list toolbar constrains the workspace selector to its own row and clamps controls/cards to the shell width so child content cannot create a horizontal scroll range. Text inputs and textareas use 16 px text or larger to avoid iOS Safari focus zoom. Desktop max-width framing is limited to fine-pointer/hover devices so touch browsers with unusual viewport reporting still get the full-width mobile shell.
- Current-user display via `GET /api/me`.
- Settings/default loading via `GET /api/chat/settings`.
- Backend metadata loading via `GET /api/chat/backends`.
- Profile-specific backend metadata loading via `GET /api/chat/cli-profiles/:profileId/metadata`.
- Active/archived conversation list via `GET /api/chat/conversations`.
- Flat latest-first conversation list with a workspace select filter. `All conversations` is the default; choosing a workspace filters the list to that `workspaceHash` without introducing collapsible workspace groups.
- Conversation-list previews strip uploaded-file/file-delivery wire markers. Attachment-only previews render as human labels such as `Attachment: IMG_3021.PNG` rather than exposing absolute artifact paths.
- Active-stream summary hydration via `GET /api/chat/active-streams`.
- Conversation-list running badges update automatically from passive WebSocket monitors and REST fallback refreshes; the manual Refresh button remains a recovery control for explicit user-triggered reconciliation.
- Open conversation via `GET /api/chat/conversations/:id`.
- Opening a conversation scrolls the transcript to the newest message. The transcript continues following newly appended messages and streaming text.
- Message pin/unpin through `PATCH /api/chat/conversations/:id/messages/:messageId/pin`. The chat view renders a sticky pinned-message strip below the topbar with pinned count, active pinned preview, dot indicators, and previous/next controls; tapping a pinned item scrolls the transcript to that message and briefly outlines it. Pinned bubbles render a `PINNED` up-arrow tag and accent left rail. Each active-session message exposes Copy, Copy MD, and Pin/Unpin actions.
- Create conversation via `POST /api/chat/conversations`.
- Rename, archive, restore, and delete conversation.
- Reset session via `POST /api/chat/conversations/:id/reset`. The action closes the conversation sheet immediately, shows the chat loading state while the server archives/summarizes the ending session, replaces the open chat with the returned empty active session, clears pending interaction/attachment state, clears the in-memory list preview for that row, and then refreshes the authoritative conversation list so message count, title, and last-message preview match the server.
- Full-conversation markdown download.
- Send message via `POST /api/chat/conversations/:id/message`.
- Stop stream via `POST /api/chat/conversations/:id/abort`.
- WebSocket replay and live streaming for text, assistant messages, title updates, usage, errors, done, and replay start, with automatic active-stream polling/reconnect on mobile browser resume, network return, and transient socket errors.
- Assistant message text, assistant content-block text, thinking blocks, and live streaming text render through `marked` with GitHub Flavored Markdown and hard line breaks enabled, then pass through DOMPurify before insertion. User-authored message text remains plain text after uploaded-file marker stripping, preserving line breaks and avoiding accidental interpretation of user text as HTML/Markdown.
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
- Text previews, image previews, file downloads, and Web Share API / fallback download for delivered files.
- Session list, preview, and markdown download.
- Workspace tree browsing, text preview/edit/save, copy, image/binary open, file/folder creation, rename/move, delete, upload progress/cancel, and conflict overwrite retry.
- CLI profile/backend/model/effort/Codex speed selection. The Run Settings sheet keeps its option groups in an internal scroll region with safe-area bottom padding so long model/profile lists remain reachable on mobile Safari. Profile/backend switching is locked once the active session has messages; model, effort, and Codex speed remain selectable. Codex speed offers Default/Fast, sends `serviceTier` on conversation create/send, and clears stale Fast selection when the chosen runtime is not Codex.
- Mobile-first installable shell with manifest, app icon, standalone display mode, and iOS home-screen metadata.

## Deferred Slices

The PWA intentionally does not yet cover:

- Memory and Knowledge Base mobile panels/live update bubbles.
- Cross-CLI instruction compatibility notifications and pointer creation.
- CLI update notifications and update actions. This is an intentional web-only parity decision because CLI binary updates are server-administration controls; see [parity-decisions.md](parity-decisions.md) and [ADR-0027](adr/0027-manage-cli-updates-from-web-cockpit.md).
- Codex goal composer controls, `/goal` slash commands, and the goal status strip. Goal mode is desktop-web-only for v1 because it adds a separate composer send mode and persistent status/action surface. Mobile can still show normal assistant messages from a goal run started elsewhere through the existing conversation/WebSocket flow, but it does not fetch `/goal`, render goal state, or expose pause/resume/clear controls. See [ADR-0032](adr/0032-use-codex-thread-goals-for-goal-mode.md) and [parity-decisions.md](parity-decisions.md).
- Service worker offline caching. The app is server-backed and currently requires network access to the Agent Cockpit host.
- True remote push notifications. Browser notification support only works while the PWA/browser context is alive enough to receive WebSocket events.
- Reuse of desktop V2 settings, Memory, KB, and usage management screens.

## Verification

The PWA is verified with:

```bash
cd mobile/AgentCockpitPWA
npm run typecheck
npm run build
```

Equivalent root-level commands are:

```bash
npm run mobile:typecheck
npm run mobile:build
```

The generated app is served from:

```text
/mobile/
```

When `WEB_BUILD_MODE=auto`, `MobileBuildService` verifies `public/mobile-built/.agent-cockpit-build.json` at server startup and rebuilds from `mobile/AgentCockpitPWA/` when the source or lockfiles are stale. Dev self-update installs mobile dependencies and forces this build before restarting PM2; production self-update installs mobile dependencies in the staged release and runs the same build preflight only when the packaged mobile marker/assets are missing or stale.
