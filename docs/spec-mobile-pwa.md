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

- `package.json` — isolated Vite React package. Scripts:
  - `npm run dev` — Vite development server on port `5174`, with `/api`, `/auth`, and `/logo-full-no-text.svg` proxied to `http://localhost:3334`.
  - `npm run build` — production build that writes to `../../public/mobile`.
  - `npm run preview` — local Vite preview server.
  - `npm run typecheck` — `tsc --noEmit`.
- Root `package.json` exposes wrappers for the same package:
  - `npm run mobile:dev` — runs the PWA Vite dev server.
  - `npm run mobile:build` — builds the PWA into `public/mobile/`.
  - `npm run mobile:typecheck` — type-checks the PWA.
- `vite.config.ts` — sets `base: "/mobile/"`, installs the React plugin, and emits the production bundle to `public/mobile/`.
- `index.html` — PWA HTML shell with viewport-safe mobile metadata, `theme-color`, `apple-mobile-web-app-capable`, manifest link, and root mount.
- `public/manifest.webmanifest` and `public/icon.svg` — install metadata and icon copied into `public/mobile/` during build.
- `src/main.tsx` — React entrypoint.
- `src/App.tsx` — mobile UI shell and state machine. It renders conversation list, chat transcript, composer, queue stack/editor, run settings, conversation actions, sessions, workspace files, file preview/share, attachment tray, interaction cards, and stream controls.
- `src/api.ts` — same-origin TypeScript API client for current-user, settings, backends, profile metadata, conversations, streams, queue, sessions, attachments/OCR, file delivery, workspace explorer, and WebSocket URLs. State-changing requests lazily fetch CSRF tokens and send `x-csrf-token`. Multipart uploads use `XMLHttpRequest` for progress and cancel.
- `src/types.ts` — TypeScript mirrors for the PWA data models.
- `src/styles.css` — mobile-first CSS for the PWA shell.

**Served files:** `public/mobile/`

`npm run build` writes `index.html`, `manifest.webmanifest`, `icon.svg`, and hashed CSS/JS assets here. These files are served by the existing `express.static(public)` mount after `requireAuth`, so unauthenticated visitors are redirected to the normal web login before the PWA shell is served.

## Runtime Architecture

The PWA runs in the phone browser or as an installed home-screen web app. It does not need a separate pairing flow because it is same-origin with the server:

1. The user opens `/mobile/` on the Agent Cockpit server.
2. `requireAuth` protects `/mobile/` like `/v2/`. If no session exists, the user goes through the existing browser auth flow.
3. Once loaded, the PWA calls same-origin `/api/me`, `/api/chat/settings`, `/api/chat/backends`, `/api/chat/active-streams`, and `/api/chat/conversations`.
4. REST calls use `credentials: "same-origin"`, the browser's `connect.sid` cookie, and CSRF tokens from `GET /api/csrf-token`.
5. Streaming uses `ws(s)://<same-origin>/api/chat/conversations/:id/ws` and sends `{ "type": "reconnect" }` on open.

For reverse-proxy base paths, the API base is derived from the current URL by replacing `/mobile/...` with `/`, matching the desktop V2 client's base-path behavior.

## Implemented Slice

The PWA currently covers:

- Same-origin authenticated load via the existing web auth session.
- Current-user display via `GET /api/me`.
- Settings/default loading via `GET /api/chat/settings`.
- Backend metadata loading via `GET /api/chat/backends`.
- Profile-specific backend metadata loading via `GET /api/chat/cli-profiles/:profileId/metadata`.
- Active/archived conversation list via `GET /api/chat/conversations`.
- Conversation-list previews strip uploaded-file/file-delivery wire markers. Attachment-only previews render as human labels such as `Attachment: IMG_3021.PNG` rather than exposing absolute artifact paths.
- Active-stream summary hydration via `GET /api/chat/active-streams`.
- Open conversation via `GET /api/chat/conversations/:id`.
- Create conversation via `POST /api/chat/conversations`.
- Rename, archive, restore, and delete conversation.
- Full-conversation markdown download.
- Send message via `POST /api/chat/conversations/:id/message`.
- Stop stream via `POST /api/chat/conversations/:id/abort`.
- WebSocket replay and live streaming for text, assistant messages, title updates, usage, errors, done, and replay start.
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
- Text previews, image previews, file downloads, and Web Share API / fallback download for delivered files.
- Session list, preview, and markdown download.
- Workspace tree browsing, text preview/edit/save, copy, image/binary open, file/folder creation, rename/move, delete, upload progress/cancel, and conflict overwrite retry.
- CLI profile/backend/model/effort selection. Profile/backend switching is locked once the active session has messages; model and effort remain selectable.
- Mobile-first installable shell with manifest, app icon, standalone display mode, and iOS home-screen metadata.

## Deferred Slices

The PWA intentionally does not yet cover:

- Memory and Knowledge Base mobile panels/live update bubbles.
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
