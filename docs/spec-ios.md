# iOS Native Client

[← Back to index](SPEC.md)

---

The native iOS app is a SwiftUI client for the existing Agent Cockpit server. It does **not** reimplement server responsibilities on-device: CLI process spawning, workspace persistence, first-party owner authentication, Memory, Knowledge Base ingestion, file explorer mutations, and update management remain owned by the Mac-hosted Node/Express server.

## Goals

- Provide a native iOS interface for the production Agent Cockpit API.
- Use the existing REST and WebSocket contracts under `/api/chat`.
- Preserve the server as the single source of truth for conversations, stream state, session files, settings, Memory, and Knowledge Base state.
- Support latest iOS only; older iOS versions are intentionally out of scope.

## Source Layout

**Files:** `ios/AgentCockpit/`

- `Package.swift` — Swift Package used for local core/UI development and tests. Deployment targets are iOS 18+ and macOS 15+; Xcode should build with the latest installed iOS SDK.
- `Sources/AgentCockpitCore/` — testable client core:
  - `Models.swift` mirrors the server data models needed by the native slices: conversations, messages, content blocks, stream errors, usage, attachments, queues, sessions, active stream summaries, workspace explorer entries/previews, current user, mobile device metadata, settings, CLI profiles, backend/model metadata, and send/reset responses.
  - `APIClient.swift` owns base URL parsing, REST request construction, JSON encoding/decoding, mobile web-login URL/exchange, mobile pairing exchange, CSRF token fetching/caching, `/api/me`, conversation CRUD, settings, CLI profile metadata, workspace explorer tree/preview, attachment upload/delete, and chat/session/queue endpoints.
  - `MobilePairingDeepLink.swift` parses `agentcockpit://pair?server=...&challengeId=...&code=...` URLs from web-generated QR codes, validates the callback scheme/action, applies the same server URL parser as manual entry, and exposes `{ serverURL, challengeId, code }` to the SwiftUI connection flow.
  - `StreamEvent.swift` decodes WebSocket stream frames from the server's documented event stream.
  - `StreamReducer.swift` is a pure reducer for applying first-slice stream events to transcript state, so stream behavior can be verified without a simulator.
  - `WebSocketClient.swift` wraps `URLSessionWebSocketTask` and sends an initial `{ "type": "reconnect" }` frame so server replay buffers are used after reconnect.
  - `ConversationStore.swift` is the SwiftUI-facing state store for current user, active-stream summaries, conversation list, archived-list mode, active conversation, CLI profile/backend/model/effort selections, pending attachments, workspace file tree/preview, sessions, persisted queue, draft text, transient stream text, loading/error state, create/rename/archive/restore/delete, send, queue auto-drain, stop, reset, and server reconnect.
- `Sources/AgentCockpitUI/` — SwiftUI views backed by `ConversationStore`. The current UI includes a sidebar, active/archived toggle, new-conversation sheet, transcript, composer, profile/model/effort picker bar, attachment tray, queued-message stack, files sheet, sessions sheet, current-user footer, conversation actions menu, reset control, and a Server settings sheet.
- `App/AgentCockpit/` — native app entrypoint and plist metadata. The bundle id is `com.daronyondem.agentcockpit`; the app registers the `agentcockpit` URL scheme for mobile auth callbacks.
- `SmokeTests/` — plain Swift executable smoke tests for model decoding, URL construction, CSRF behavior, stream reduction, current-user decoding, settings/CLI-profile decoding, backend/model metadata decoding, workspace explorer decoding, session decoding, queue decoding, attachment wire-content composition, REST route construction, active-stream hydration, and queue auto-drain. This exists because Command Line Tools-only installations may not include XCTest; full Xcode can add XCTest/XCUITest coverage later.

## Runtime Architecture

### Server Connection

The app defaults to `http://localhost:3334` for simulator development. On a physical iOS device, `localhost` refers to the device, not the Mac, so the server URL must point at the Mac's LAN address or a tunnel URL.

`AgentCockpitAPI` accepts any base URL and preserves path prefixes. For example, a server mounted at `https://example.com/cockpit` produces:

- REST: `https://example.com/cockpit/api/chat/conversations`
- WebSocket: `wss://example.com/cockpit/api/chat/conversations/:id/ws`

The connection/login screen and Server settings sheet persist `agentCockpit.serverURL` in `UserDefaults`. If no server URL has been saved, the app presents the connection screen before the conversation list. If an API call returns HTTP 401, the same screen is presented again so the user can choose a backend before starting the backend-owned login flow.

If the user enters a host without a scheme, localhost, loopback, `.local`, and private LAN addresses default to `http://`; public hosts default to `https://`. Only `http` and `https` server URLs are accepted.

### Authentication

The existing server session remains authoritative. Native iOS authentication uses `ASWebAuthenticationSession` against the selected backend's first-party web login route rather than embedding login pages in a custom web view. The default auth model does not require Apple ID because the iOS app is a companion client for a user-selected backend and the backend uses Agent Cockpit's own local owner auth.

Initial simulator development can use localhost auth bypass. Public App Store distribution should keep third-party/social login providers out of the primary iOS auth flow unless an equivalent privacy-focused login option is added under App Review Guideline 4.8.

The current app checks session identity with `GET /api/me` and renders the returned `{ displayName, email, provider }` in the sidebar footer. Localhost bypass returns null fields and renders as a local session. Non-local tunnel/LAN access requires a backend session.

Native web login uses the same first-party backend login as the web UI:

1. The connection/login screen accepts a base URL such as the user's Cloudflare tunnel domain before any provider button is used.
2. "Sign in with Passkey or Password" opens `ASWebAuthenticationSession` at `/auth/mobile-login` under that base URL.
3. `/auth/mobile-login` redirects to `/auth/login?mobile=1`; after first-party backend login succeeds, the server redirects to `agentcockpit://auth/callback?code=<one-time-code>`.
4. The app exchanges the code with `POST /api/mobile-auth/exchange`.
5. The exchange response sets the normal `connect.sid` session cookie in the app's `URLSession` cookie storage and returns `{ user, csrfToken, device? }`. The client sends default device metadata `{ deviceName: "Agent Cockpit iOS", platform: "iOS" }` during exchange so the backend can show/revoke mobile sessions.
6. The app reconnects to the configured server URL and then uses the same REST, WebSocket, session-cookie, and CSRF contracts as the web app.

The app registers the `agentcockpit` URL scheme in `App/AgentCockpit/Info.plist`. The native callback scheme is only used after the selected backend has completed owner authentication.

Mobile pairing uses the backend pairing challenge API:

1. The authenticated web session opens **Settings > Security > Mobile pairing** and creates a challenge with `POST /api/mobile-pairing/challenges`.
2. The response includes `{ challengeId, pairingCode, expiresAt, pairingUrl, qrCodeDataUrl }`. `pairingUrl` is `agentcockpit://pair` with `server`, `challengeId`, and `code` query parameters; `qrCodeDataUrl` is a PNG data URL encoding that exact URL.
3. The native connection screen can scan the QR code with AVFoundation. The scanner reads the URL, parses it with `MobilePairingDeepLink`, updates the configured server URL from the `server` parameter, fills the challenge/code state, and immediately exchanges the challenge.
4. Manual fallback remains available by entering the displayed `challengeId` and `pairingCode`.
5. The app exchanges them at `POST /api/mobile-pairing/exchange` with device metadata.
6. The exchange response is the same session shape as mobile web login: `{ user, csrfToken, device }`.

Direct native passkey login is not the default for arbitrary self-hosted backend domains because passkeys are bound to relying-party domains and native associated-domain entitlements cannot cover every user-owned backend domain.

See [ADR-0023](adr/0023-use-first-party-owner-authentication.md) for the first-party owner-auth decision and [ADR-0022](adr/0022-bridge-mobile-oauth-through-one-time-codes.md) for the native one-time-code bridge.

### CSRF

State-changing REST calls fetch `GET /api/csrf-token` lazily and send the returned token in the `x-csrf-token` header. The token is cached in memory and cleared by `invalidateCSRFToken()` after any session refresh. The iOS client uses the same CSRF contract as the web frontend.

### Streaming

The app opens `ws(s)://host/api/chat/conversations/:id/ws` with `URLSessionWebSocketTask`. After connecting, it sends `{ "type": "reconnect" }` to trigger server replay. Stream frames decode into `StreamEvent` and are applied to `ConversationStore`.

`ConversationStore.loadConversations()` also reads `GET /api/chat/active-streams` and tracks active IDs. Conversation rows render a native progress indicator for active streams. Opening a conversation whose ID is active starts the WebSocket client immediately so replay frames can hydrate the current turn.

First-slice UI behavior:

- `text` frames append to transient assistant stream text.
- `assistant_message` replaces an existing message with the same ID, or appends it when no match exists, then clears transient stream text. This matches the web client's replay handling and prevents duplicate SwiftUI row IDs when server replay buffers resend a completed assistant message.
- `title_updated` updates the active conversation title.
- `usage` updates the active conversation/session usage totals shown above the composer.
- plan-mode `tool_activity` frames set or clear a native planning indicator.
- plan approval and clarifying-question `tool_activity` frames create a pending native interaction card.
- `replay_start` clears stale transient stream text so replayed frames rebuild the current turn cleanly.
- `error` surfaces an error state and marks streaming false.
- `done` marks streaming false.

Future slices must extend this to Memory/KB live update bubbles and richer tool outcome controls.

## First Vertical Slice

The first implemented slice covers:

- Conversation list via `GET /api/chat/conversations`.
- Active-stream summary hydration via `GET /api/chat/active-streams`.
- Open conversation via `GET /api/chat/conversations/:id`.
- Create conversation via `POST /api/chat/conversations`.
- Rename conversation via `PUT /api/chat/conversations/:id`.
- Archive, restore, and delete via `PATCH /archive`, `PATCH /restore`, and `DELETE /conversations/:id`.
- Send message via `POST /api/chat/conversations/:id/message`.
- Stop stream via `POST /api/chat/conversations/:id/abort`.
- WebSocket event decoding and first-pass stream application.
- Ordered assistant `contentBlocks` rendering for text, thinking, and tool activity rows. Assistant text uses native Markdown parsing, with hard line breaks preserved to match the web frontend's `marked` configuration.
- Conversation rows display only the last two workspace path components, e.g. `/Users/daronyondem/github/agent-cockpit` renders as `github/agent-cockpit`.
- Usage badge rendering from `usage` / `sessionUsage` stream frames and loaded conversation usage. `contextUsagePercentage` is decoded as a number, not an integer, because Kiro can report fractional context-window percentages; the UI renders one decimal below 10% and whole percentages otherwise.
- Current-user check via `GET /api/me`.
- Native SwiftUI shell with sidebar, active/archived toggle, new conversation, current-user footer, server URL settings, mobile web login, manual pairing-code exchange, transcript, composer, send, stop, and conversation action controls.

## Sessions and Queue Slice

The second native slice covers:

- Session list via `GET /api/chat/conversations/:id/sessions`.
- Read-only session preview via `GET /api/chat/conversations/:id/sessions/:num/messages`; current-session preview reuses already-loaded active messages.
- Session reset via `POST /api/chat/conversations/:id/reset`, guarded by a native confirmation dialog and disabled while streaming.
- Queue read via `GET /api/chat/conversations/:id/queue`.
- Queue save via `PUT /api/chat/conversations/:id/queue`, using the typed `QueuedMessage[]` shape. The server returns `{ ok: true }`, so the native store keeps the submitted queue as local truth after a successful save.
- Queue clear via `DELETE /api/chat/conversations/:id/queue`.
- Composer behavior while streaming: non-empty drafts are persisted to the queue instead of attempting a second active send.
- Queue stack rendering below the transcript, with per-item remove and clear controls.
- Queue auto-drain after clean `done` frames. The native store removes the head item from the persisted queue, sends its wire-formatted content through `POST /message`, and restores the original queue if the send fails.
- Queue auto-drain pauses while a plan approval or clarifying question is pending.

## Interaction Slice

The native interaction slice covers:

- Plan mode indicator from `tool_activity` frames with `isPlanMode: true` and `planAction: "enter"`.
- Plan approval card from `tool_activity` frames with `isPlanMode: true`, `planAction: "exit"`, and `planContent`.
- Clarifying question card from `tool_activity` frames with `isQuestion: true` and `questions[]`; the first question is surfaced and option labels can prefill the answer.
- Answer delivery through `POST /api/chat/conversations/:id/input` with `{ text, streamActive }`.
- `{ mode: "stdin" }` clears the pending interaction and leaves the existing stream to continue.
- `{ mode: "message" }` clears the pending interaction and sends the answer as a new user message through the normal `POST /message` path.
- The composer and attachment picker are disabled while an interaction is pending so ordinary messages cannot bypass the card.

## CLI Profile, Backend, Model, and Effort Slice

The third native slice covers:

- Settings loading via `GET /api/chat/settings`, including `cliProfiles`, `defaultCliProfileId`, `defaultBackend`, `defaultModel`, and `defaultEffort`.
- Backend metadata loading via `GET /api/chat/backends`.
- Profile-specific backend metadata loading via `GET /api/chat/cli-profiles/:profileId/metadata`.
- `Settings`, `CliProfile`, `CliVendor`, and `CliAuthMode` decoding.
- `BackendMetadata`, `ModelOption`, `BackendCapabilities`, and `BackendResumeCapabilities` decoding.
- Composer selection hydration from the active conversation's stored `cliProfileId`, `backend`, `model`, and `effort`.
- Profile picker when active CLI profiles exist. Changing profile selects the profile vendor backend, fetches profile-specific metadata, and reconciles model/effort.
- Backend picker fallback when no CLI profiles are available. Changing backend selects that backend's default model when available, otherwise the first model.
- Model picker when the selected backend exposes models.
- Effort picker only when the selected model exposes `supportedEffortLevels`.
- Effort reconciliation: keep the current effort when the new model supports it; otherwise prefer `high` when supported, then the first supported effort. Models without effort support clear the effort selection.
- Profile/backend switching is locked once the active session has messages, matching the web client and server guard. Model and effort remain selectable.
- Send requests include the selected `cliProfileId`, `backend`, `model`, and `effort` in `POST /api/chat/conversations/:id/message`.

## Attachment Slice

The fourth native slice covers:

- File selection with SwiftUI `fileImporter`.
- Multipart upload to `POST /api/chat/conversations/:id/upload` using the `files` field.
- Delete uploaded pending files via `DELETE /api/chat/conversations/:id/upload/:filename`.
- `AttachmentMeta`, `AttachmentKind`, and `PendingAttachment` models.
- Pending attachment tray with uploading, ready, and error states.
- Send/queue wire-content composition by appending `[Uploaded files: <paths>]` to the user message, matching the server/web queue contract.

Native attachment progress, upload cancel, image OCR (`POST /attachments/ocr`), drag/drop, and folder-upload expansion are not implemented yet.

## Workspace Files Slice

The fifth native slice covers:

- Read-only workspace tree browsing with `GET /api/chat/workspaces/:hash/explorer/tree?path=<rel>`.
- Read-only text preview with `GET /api/chat/workspaces/:hash/explorer/preview?path=<rel>&mode=view`.
- `ExplorerEntry`, `ExplorerEntryType`, `ExplorerTreeResponse`, and `ExplorerPreviewResponse` decoding.
- A native Files sheet reachable from the active conversation toolbar. It shows the current path, parent navigation, directory/file rows, file sizes, refresh, and a monospaced text preview.

Native file creation, edit/save, rename, delete, upload, binary raw preview, and downloads are not implemented yet.

## Simulator Verification

Full simulator automation requires full Xcode, not just Command Line Tools:

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
xcodebuild -version
xcrun simctl list devices available
```

When Xcode is available, verification should run:

```sh
swift run --package-path ios/AgentCockpit AgentCockpitCoreSmokeTests
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project ios/AgentCockpit/AgentCockpit.xcodeproj \
  -scheme AgentCockpit \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath ios/AgentCockpit/.derivedData \
  build
```

The simulator smoke path is:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl boot <device-udid>
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl install <device-udid> ios/AgentCockpit/.derivedData/Build/Products/Debug-iphonesimulator/AgentCockpit.app
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl launch <device-udid> com.daronyondem.agentcockpit
```

The app bundle uses `App/AgentCockpit/Info.plist`. That plist must include standard install-time bundle keys, including `CFBundleExecutable`, `CFBundlePackageType`, `CFBundleShortVersionString`, and `CFBundleVersion`; otherwise `simctl install` rejects the bundle.

The repository server must still be managed through pm2, per project instructions:

```sh
npx pm2 start ecosystem.config.js
```

Do not run `node server.js` directly.
