# Mobile PWA Client

[← Back to index](SPEC.md)

---

The mobile PWA is the supported mobile client for Agent Cockpit. It is a browser-based React app served by the same authenticated Node/Express server as the desktop web UI: open the self-hosted server URL on the phone, sign in with the existing web auth flow, and add the app to the home screen.

See [ADR-0025](adr/0025-use-mobile-pwa-as-sole-mobile-client.md).

## Goals

- Provide an installable mobile web client without App Store, TestFlight, EAS, Expo Go, Apple signing, or native sideloading requirements.
- Reuse the existing `/api/chat` REST and WebSocket contracts.
- Keep the mobile app source in one browser-native React codebase under `mobile/AgentCockpitPWA`.
- Serve built assets from the existing Express static surface under `/mobile/`.

## Source Layout

**Source files:** `mobile/AgentCockpitPWA/`

- `package.json` — isolated Vite React package. Runtime dependencies include React, Vite, `marked`, and DOMPurify; assistant Markdown is rendered client-side and sanitized before insertion. Scripts:
  - `npm run dev` — Vite development server on port `5174`, with `/api`, `/auth`, and `/logo-full-no-text.svg` proxied to `http://localhost:3334`.
  - `npm run build` — production build that writes to `../../public/mobile`.
  - `npm run preview` — local Vite preview server.
  - `npm run typecheck` — `tsc --noEmit`.
- Root `package.json` exposes wrappers for the same package:
  - `npm run mobile:dev` — runs the PWA Vite dev server.
  - `npm run mobile:build` — builds the PWA into `public/mobile/`.
  - `npm run mobile:typecheck` — type-checks the PWA.
- `vite.config.ts` — sets `base: "/mobile/"`, installs the React plugin, and emits the production bundle to `public/mobile/`.
- `index.html` — PWA HTML shell with viewport-safe mobile metadata, `theme-color`, `apple-mobile-web-app-capable`, manifest link, SVG/PNG favicon links, explicit `apple-touch-icon`, and root mount.
- `public/manifest.webmanifest`, `public/icon.svg`, `public/icon-192.png`, `public/icon-512.png`, and `public/apple-touch-icon.png` — install metadata and icons copied into `public/mobile/` during build. iOS home-screen installs use the 180x180 PNG `apple-touch-icon`; the manifest also lists PNG icons because Safari is not reliable with SVG-only PWA icons.
- `src/main.tsx` — React entrypoint.
- `src/App.tsx` — mobile UI shell and state machine. It renders conversation list, chat transcript, composer, queue stack/editor, run settings, conversation actions, sessions, workspace files, file preview/share, attachment tray, interaction cards, and stream controls.
- `src/api.ts` — same-origin TypeScript API client for current-user, settings, backends, profile metadata, conversations, streams, queue, sessions, attachments/OCR, file delivery, workspace explorer, and WebSocket URLs. State-changing requests lazily fetch CSRF tokens and send `x-csrf-token`. Multipart uploads use `XMLHttpRequest` for progress and cancel.
- `src/types.ts` — TypeScript mirrors for the PWA data models.
- `src/styles.css` — mobile-first CSS for the PWA shell.

**Served files:** `public/mobile/`

`npm run build` writes `index.html`, `manifest.webmanifest`, SVG/PNG icon assets, and hashed CSS/JS assets here. These files are served by the existing `express.static(public)` mount after `requireAuth`, so unauthenticated visitors are redirected to the normal web login before the PWA shell is served.

## Runtime Architecture

The PWA runs in the phone browser or as an installed home-screen web app. It does not need a separate pairing flow because it is same-origin with the server:

1. The user opens `/mobile/` on the Agent Cockpit server.
2. `requireAuth` protects `/mobile/` like `/v2/`. If no session exists, the user goes through the existing browser auth flow.
3. Once loaded, the PWA calls same-origin `/api/me`, `/api/chat/settings`, `/api/chat/backends`, `/api/chat/active-streams`, and `/api/chat/conversations`.
4. REST calls use `credentials: "same-origin"`, the browser's `connect.sid` cookie, and CSRF tokens from `GET /api/csrf-token`.
5. Streaming uses `ws(s)://<same-origin>/api/chat/conversations/:id/ws` and sends `{ "type": "reconnect" }` on open.
6. While the conversation list is visible, the PWA opens passive WebSocket monitors for conversations returned by `/api/chat/active-streams`. Those sockets use the same reconnect contract as chat views, ignore text deltas, react to `assistant_message`, `title_updated`, terminal `error`, `done`, and interaction-needed `tool_activity` frames, and refresh the list when a stream reaches a terminal state. The list also refreshes on focus/visibility return and every 15 seconds as a fallback for suspended browsers, missed sockets, and activity started from another client. The multi-client WebSocket transport decision is recorded in [ADR-0028](adr/0028-allow-multiple-websocket-clients-per-conversation.md).

For reverse-proxy base paths, the API base is derived from the current URL by replacing `/mobile/...` with `/`, matching the desktop V2 client's base-path behavior.

## Implemented Slice

The PWA currently covers:

- Same-origin authenticated load via the existing web auth session.
- App-like viewport locking: the document body does not scroll horizontally or vertically, the root/app shell are fixed to the viewport, the shell height tracks the visual viewport, accidental `scrollLeft` is reset during viewport updates, and only intended panes (conversation list, transcript, modals, queues, attachment trays) scroll inside their own bounds. The viewport meta includes `interactive-widget=resizes-content`, and the React shell maintains a `--app-height` CSS variable from `window.visualViewport.height` so the top bar and composer stay anchored as the mobile keyboard appears. Desktop max-width framing is limited to fine-pointer/hover devices so touch browsers with unusual viewport reporting still get the full-width mobile shell.
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
- Create conversation via `POST /api/chat/conversations`.
- Rename, archive, restore, and delete conversation.
- Reset session via `POST /api/chat/conversations/:id/reset`. The action closes the conversation sheet immediately, shows the chat loading state while the server archives/summarizes the ending session, replaces the open chat with the returned empty active session, clears pending interaction/attachment state, clears the in-memory list preview for that row, and then refreshes the authoritative conversation list so message count, title, and last-message preview match the server.
- Full-conversation markdown download.
- Send message via `POST /api/chat/conversations/:id/message`.
- Stop stream via `POST /api/chat/conversations/:id/abort`.
- WebSocket replay and live streaming for text, assistant messages, title updates, usage, errors, done, and replay start.
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
- CLI profile/backend/model/effort selection. Profile/backend switching is locked once the active session has messages; model and effort remain selectable.
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
