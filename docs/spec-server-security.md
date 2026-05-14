# 6. Server Initialization & Security

[← Back to index](SPEC.md)

---

## 6.1 Configuration

**File:** `src/config/index.ts`

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3334` | Server listen port |
| `SESSION_SECRET` | Yes | — | Secret for signing session cookies |
| `GOOGLE_CLIENT_ID` | No | — | Legacy Google OAuth client ID. Used only when `AUTH_ENABLE_LEGACY_OAUTH=true`. |
| `GOOGLE_CLIENT_SECRET` | No | — | Legacy Google OAuth client secret. Used only when `AUTH_ENABLE_LEGACY_OAUTH=true`. |
| `GOOGLE_CALLBACK_URL` | No | — | Legacy Google OAuth callback URL. Used only when `AUTH_ENABLE_LEGACY_OAUTH=true`. |
| `GITHUB_CLIENT_ID` | No | — | Legacy GitHub OAuth client ID. Used only when `AUTH_ENABLE_LEGACY_OAUTH=true`. |
| `GITHUB_CLIENT_SECRET` | No | — | Legacy GitHub OAuth client secret. Used only when `AUTH_ENABLE_LEGACY_OAUTH=true`. |
| `GITHUB_CALLBACK_URL` | No | — | Legacy GitHub OAuth callback URL. Used only when `AUTH_ENABLE_LEGACY_OAUTH=true`. |
| `ALLOWED_EMAIL` | No | — | Legacy OAuth comma-separated allowed-email list. Used only when legacy OAuth routes are enabled. |
| `AGENT_COCKPIT_DATA_DIR` | No | `data` under the process working directory | Root directory for mutable runtime data. Chat storage, Express sessions, plan-usage caches, update restart artifacts, and default auth state live under this root. Production Mac installs set this outside the replaceable app code directory. |
| `AUTH_DATA_DIR` | No | `<AGENT_COCKPIT_DATA_DIR>/auth` | Directory for first-party local auth state. The owner account is stored in `owner.json`. Overrides only auth storage when set. |
| `AUTH_SETUP_TOKEN` | Recommended for exposed first-run setup | `''` | Secret token required to create the first owner account from a non-localhost request. Localhost setup is allowed without the token for server-console access. |
| `AUTH_ENABLE_LEGACY_OAUTH` | No | `false` | Transitional flag that registers the old Google/GitHub OAuth routes when set to `true`. Third-party auth is disabled by default. |
| `DEFAULT_WORKSPACE` | No | `~/.openclaw/workspace` | Default working directory for CLI processes |
| `KIRO_ACP_IDLE_TIMEOUT_MS` | No | `3600000` | Idle timeout (ms) before killing the Kiro ACP process |
| `CODEX_IDLE_TIMEOUT_MS` | No | `600000` | Idle timeout (ms) before killing an idle Codex `app-server` process |
| `CODEX_APPROVAL_POLICY` | No | `on-request` | Codex approval policy for interactive threads. Valid values: `untrusted`, `on-failure`, `on-request`, `never`. Invalid values are ignored with a startup warning and the default is used. |
| `CODEX_SANDBOX_MODE` | No | `workspace-write` | Codex sandbox mode for interactive threads. Valid values: `read-only`, `workspace-write`, `danger-full-access`. Invalid values are ignored with a startup warning and the default is used. |
| `BASE_PATH` | No | `''` | URL base path prefix (for reverse proxy deployments) |
| `WEB_BUILD_MODE` | No | `auto` outside tests, `skip` when `NODE_ENV === 'test'` | Controls main V2 web and mobile PWA build startup preflight. `auto` checks and rebuilds missing/stale `public/v2-built/` and `public/mobile-built/` assets before listen; `skip` bypasses both preflights for tests or special deployments. |
| `LOG_LEVEL` | No | `info` | Structured logger threshold for migrated modules. Valid values are `error`, `warn`, `info`, and `debug`; invalid values fall back to `info`. |

`src/config/index.ts` loads `.env` through `dotenv`. Outside tests, `.env` values override already-present process environment values so PM2-managed local deployments can pin runtime config from the repo's `.env`. When `NODE_ENV === 'test'`, dotenv does **not** override explicit process env values; subprocess tests such as graceful shutdown can pass an isolated `PORT` without being clobbered by a developer `.env` that points at a running PM2 app.

[ADR-0054](adr/0054-adopt-mac-installer-and-release-channels.md) keeps this
PM2-managed server startup path as the first supported macOS production install
model. `scripts/install-macos.sh` generates the required runtime secrets and
PM2 ecosystem configuration, writes install-channel metadata, then launches the
same server initialization flow documented below. First-run owner creation
begins at `/auth/setup`; successful owner creation redirects to
`/v2/?welcome=1` so the authenticated welcome flow can show install diagnostics
and mark setup complete.

Server logging is migrating to `src/utils/logger.ts`. The logger writes one structured line per event, applies `LOG_LEVEL` filtering, redacts metadata keys that look like credentials, cookies, session ids, tokens, or passwords before emitting, and serializes cyclic/rich metadata safely (`Error`, `Date`, `Map`, `Set`, `bigint`, functions, symbols, bounded arrays/objects/strings). WebSocket diagnostics, `MemoryWatcher`, `StreamJobSupervisor`, chat stream orchestration, upload OCR failures, `ChatService` maintenance paths, and Context Map processor update-emission failures use this path for migrated slices and avoid logging stdin message content; debug logs record only lengths and operational identifiers.

## 6.2 Server Initialization Order

**File:** `server.ts`

1. Create Express app, set `trust proxy: 1`
2. Apply Helmet security headers via `applySecurity(app)`
3. Configure express-session with FileStore (`<AGENT_COCKPIT_DATA_DIR>/sessions/`, 24h TTL, `retries: 0`). `cookie.maxAge` is 24h and `rolling: true` is set — every request re-issues the cookie with a fresh 24h expiry, so active users never hit the wall mid-workflow while idle users still expire after 24h of no activity.
4. Passport 0.7 polyfill — adds `session.regenerate`/`session.save` stubs if missing
4a. Mount the public logo route `GET /logo-full-no-text.svg` (serves `public/logo-full-no-text.svg`) — placed before `setupAuth` / `requireAuth` so the unauthenticated login page can load the Agent Cockpit brand mark
5. Setup Passport with `setupAuth(app, config)`
6. Apply `requireAuth` middleware globally
7. Apply `ensureCsrfToken` middleware globally
8. Parse JSON bodies with `express.json()`
9. Mount CSRF token endpoint at `GET /api/csrf-token`
9a. Mount current-user endpoint at `GET /api/me`
10. Create BackendRegistry, register ClaudeCodeAdapter, KiroAdapter, and CodexAdapter
11. Initialize ChatService
12. Initialize InstallStateService, UpdateService, InstallDoctorService, CliUpdateService, Claude/Kiro/Codex plan usage services, `WebBuildService`, `MobileBuildService`, and the chat router dependencies, including the Claude Code Interactive adapter registration
13. Mount chat router at `/api/chat`
14. Mount root redirect `/` -> `/v2/`
15. Mount `/v2/src` as an explicit 404 guard so raw V2 source files are not served
16. Mount `/v2` from `public/v2-built/` and `GET /v2/*` as a built-index fallback for future client routes
17. Mount `/mobile` from `public/mobile-built/`, then serve remaining static files from `public/` (including shared images)
18. Call `chatService.initialize()` (migration + lookup map)
19. Reconcile leftover durable stream jobs via `chatResult.reconcileInterruptedJobs()` before the server accepts traffic. This converts unrecoverable accepted/preparing/running jobs from a prior process into one persisted assistant `streamError` when the user message exists, or removes the job when no user message was saved.
20. Check that the configured port is free; exit with a PM2-oriented fatal message when it is already in use
21. Run `webBuildService.ensureBuilt()` and `mobileBuildService.ensureBuilt()` before binding. In `auto` mode these build missing/stale `public/v2-built/` and `public/mobile-built/` assets and write `.agent-cockpit-build.json` markers; if a build fails with no previous `index.html`, startup fails loudly. If a previous build exists and rebuild fails, startup logs the stale-build warning and keeps serving the previous build for that asset tree.
22. Start UpdateService (version polling), CliUpdateService (local CLI update polling), KB Auto-Dream scheduler, Memory Review scheduler, and Context Map scheduler
23. Initialize account plan usage caches and fire best-effort startup refreshes for Claude Code (shared by Claude Code Interactive), Kiro, and Codex
24. Detect LibreOffice and Pandoc in the background for KB ingestion status endpoints
25. Listen on configured PORT
26. Attach WebSocket server via `attachWebSocket(server, { sessionStore, sessionSecret, activeStreams, abortStream })` — returns `WsFunctions` object with `send`, `isConnected`, `isStreamAlive`, `clearBuffer`, `shutdown`. `activeStreams` is the stream supervisor's process-local runtime attachment map while this process owns a backend iterator; `<AGENT_COCKPIT_DATA_DIR>/chat/stream-jobs.json` is the durable supervision layer used for accepted/preparing visibility, backend runtime identifiers (`externalSessionId`, `activeTurnId`, `processId`), and restart reconciliation. Runtime identifiers are diagnostic/current-turn metadata only; startup reconciliation still does not reattach or retry unless a backend explicitly advertises active-turn resume support. Stream processing detaches the process-local runtime and removes the durable job before emitting the client-visible `done` frame so an immediate follow-up send after `done` does not race stale active-stream bookkeeping. WebSocket connection state is transport-only and does not cancel an accepted stream. Transport-independent cancellation goes through CSRF-protected `POST /api/chat/conversations/:id/abort`; legacy WebSocket abort frames delegate to the same router-owned abort function.
27. Wire WebSocket functions into the chat router via `setWsFunctions(wsFns)`

### Graceful Shutdown

Signal handlers for `SIGTERM`/`SIGINT`:
1. Call and await `chatShutdown()` — marks pending/runtime-attached durable stream jobs `finalizing` with `Interrupted by server shutdown`, aborts runtime backend handles, and clears process-local stream maps without deleting those durable jobs
2. Call `backendRegistry.shutdownAll()` — kills long-lived backend processes (e.g. Kiro ACP)
3. Call `wsShutdown()` — closes all WebSocket connections and the WS server
4. Call `server.close()` — stop accepting connections
5. 10-second forced exit timeout (`.unref()` as safety net)

On the next process start, normal durable job reconciliation converts those finalizing shutdown jobs into one persisted assistant `streamError` when the accepted user message exists.

## 6.3 Authentication

**File:** `src/middleware/auth.ts`

**Default model:** Agent Cockpit uses one first-party local owner account per server instance. The owner state is stored in `AUTH_DATA_DIR/owner.json` with mode `0600` after writes. Passwords are stored as `scrypt` hashes with a random per-password salt; plaintext passwords are never stored. The owner session still uses Passport's session helpers so the rest of the app continues to rely on `req.isAuthenticated()` and the existing `connect.sid` cookie.

**First-run setup:** If no owner exists, `/auth/login` redirects to `/auth/setup`. Localhost setup is allowed without a token because it requires server-console/local network access. Non-localhost setup requires `AUTH_SETUP_TOKEN` in the submitted form body; without it, setup returns 403. This prevents an exposed empty backend from being claimed by a remote visitor.

**Recovery and lockout protection:** The owner can regenerate recovery codes through `POST /api/auth/recovery/regenerate`. Only scrypt hashes of recovery codes are stored; plaintext codes are returned only once in the regeneration response. `POST /auth/recovery/login` consumes one unused code, signs in the owner, and disables `policy.passkeyRequired` so the owner can repair a locked account. `PATCH /api/auth/policy` refuses to enable passkey-required mode until at least one passkey and at least one unused recovery code exist.

**Passkeys:** WebAuthn ceremonies use `@simplewebauthn/server`. Registration is started from an authenticated web session with `POST /api/auth/passkeys/register/options`, verified by `POST /api/auth/passkeys/register/verify`, and stored as public credential material only: credential id, public key, counter, transports, created timestamp, and optional last-used timestamp. Login starts with public `POST /api/auth/passkeys/login/options`; verify uses the stored challenge in the anonymous session, validates the assertion against the backend origin/RP ID, updates the credential counter and `lastUsedAt`, and then creates the normal Passport session. The `/auth/login` page exposes password and passkey login; `?popup=1` is preserved through passkey login and finishes at `/auth/popup-done`.

**Local reset command:** `npm run auth:reset -- ...` runs `scripts/auth-reset.ts` with local filesystem access. It can reset the owner password, update email/display name, disable passkey-required mode, delete `<AGENT_COCKPIT_DATA_DIR>/sessions`, and regenerate recovery codes. This is intentionally not exposed as an HTTP endpoint.

**Mobile PWA auth:** The supported mobile client is the PWA served from `/mobile/`. It uses the same browser-owned `connect.sid` session and CSRF token flow as the desktop V2 UI. There is no separate native-client pairing bridge, one-time callback, paired-device registry, or device-revocation route in the active auth surface.

**Web admin surface:** The V2 Settings **Security** tab is the owner-facing management UI for these routes. It reads `/api/auth/status` and `/api/auth/passkeys`, registers/renames/deletes passkeys, regenerates recovery codes, and toggles `policy.passkeyRequired` when safe.

**Legacy OAuth:** Google/GitHub OAuth routes are disabled by default. Setting `AUTH_ENABLE_LEGACY_OAUTH=true` registers the old Google/GitHub Passport strategies and routes as a transitional compatibility path. Legacy OAuth still uses `ALLOWED_EMAIL` to authorize provider identities and stamps `provider: 'google' | 'github'` on the session user. The first-party local owner stamps `provider: 'local'`.

**Rate limiting:** Applied to setup, password login, passkey login, recovery login, and legacy OAuth routes — 15 min window, 20 requests/IP. Jest skips this limiter so auth route tests do not share mutable rate-limit state.

**Auth routes:**

| Route | Method | Description |
|-------|--------|-------------|
| `/api/auth/status` | GET | Public capability probe. Returns `{ setupRequired, providers: { password: true, passkey, legacyOAuth }, passkeys: { registered }, policy, recovery }`. `passkey` is false only before first-run owner setup; `policy` is `{ passkeyRequired }`; `recovery` is `{ configured, total, remaining, createdAt }`. |
| `/auth/setup` | GET | First-run setup page for the single local owner. Redirects to `/auth/login` after the owner exists. Remote requests see a setup-token field; localhost setup does not require the token. |
| `/auth/setup` | POST | Creates the local owner. Form/JSON body `{ email, displayName, password, setupToken? }`. Passwords must be at least 12 characters. Localhost requests can omit `setupToken`; remote requests must match `AUTH_SETUP_TOKEN`. On success, logs in the owner and redirects to `/v2/?welcome=1`. |
| `/auth/login` | GET | First-party login page. If no owner exists, redirects to `/auth/setup`. Accepts `?popup=1`; that mode is carried as a hidden field on the password form so successful login can finish popup re-auth. |
| `/auth/login/password` | POST | Password login for the local owner. Form/JSON body `{ email, password, popup? }`. Valid credentials create the normal session and redirect to `/`; with `popup=1`, it redirects to `/auth/popup-done`. Invalid credentials return 401 with the login page and an error. If `policy.passkeyRequired` is true, password login returns 403 and the owner must use passkey login or recovery. |
| `/api/auth/passkeys` | GET | Authenticated. Lists passkeys as `{ passkeys: [{ id, name, transports?, createdAt, lastUsedAt? }] }`; credential ids, public keys, and counters are not returned. |
| `/api/auth/passkeys/register/options` | POST | Authenticated + `x-csrf-token`. Body `{ name? }`. Generates WebAuthn registration options for the current origin/RP ID, excludes already-registered credentials, stores the challenge in session, and returns the browser JSON options. |
| `/api/auth/passkeys/register/verify` | POST | Authenticated + `x-csrf-token`. Body `{ name?, response }`, where `response` is the JSON-encoded `PublicKeyCredential` from `navigator.credentials.create`. Verifies challenge/origin/RP ID/user verification, stores the credential public material, and returns `{ passkey, passkeys }`. |
| `/api/auth/passkeys/login/options` | POST | Public + rate limited. Body `{ popup? }`. Requires at least one registered passkey, generates assertion options for all registered credentials, stores challenge and mode in session, and returns browser JSON options. |
| `/api/auth/passkeys/login/verify` | POST | Public + rate limited. Body `{ response }`, where `response` is the JSON-encoded `PublicKeyCredential` from `navigator.credentials.get`. Verifies challenge/origin/RP ID/user verification, updates counter/last-used metadata, creates the normal session, and returns `{ redirectTo, user }` so the login page can navigate to `/` or `/auth/popup-done`. |
| `/api/auth/passkeys/:id` | PATCH | Authenticated + `x-csrf-token`. Body `{ name }`. Renames a passkey and returns `{ passkey, passkeys }`. |
| `/api/auth/passkeys/:id` | DELETE | Authenticated + `x-csrf-token`. Deletes a passkey and returns `{ passkeys }`. Returns 409 if deleting the last passkey while `passkeyRequired` is enabled. |
| `/auth/recovery` | GET | Recovery-code login page. Redirects to setup when no owner exists. |
| `/auth/recovery/login` | POST | Form/JSON body `{ email, recoveryCode, popup? }`. The code must match an unused stored recovery-code hash. On success, the code is marked used, `passkeyRequired` is disabled, and the session finishes like password login, including popup mode. |
| `/api/auth/recovery/regenerate` | POST | Authenticated + `x-csrf-token`. Replaces all recovery codes and returns `{ recoveryCodes, recovery }`. |
| `/api/auth/policy` | PATCH | Authenticated + `x-csrf-token`. Body `{ passkeyRequired }`. Returns `{ policy }` or 409 if enabling passkey-required would be unsafe. |
| `/auth/google` | GET | Legacy OAuth only when `AUTH_ENABLE_LEGACY_OAUTH=true`. Initiates Google OAuth flow. If `?popup=1`, sets `req.session.reAuthPopup = true`. |
| `/auth/google/callback` | GET | Legacy OAuth only. Google callback → `finishAuth`: popup completion or `/` redirect. Failure redirects to `/auth/denied`. |
| `/auth/github` | GET | Legacy OAuth only when `AUTH_ENABLE_LEGACY_OAUTH=true` and GitHub credentials are configured. Same `?popup=1` handling as Google. |
| `/auth/github/callback` | GET | Legacy OAuth only. GitHub callback → `finishAuth` (same popup/default logic as Google). Failure → `/auth/denied`. |
| `/auth/popup-done` | GET | Terminal page for popup re-auth. Serves a tiny HTML document that calls `window.opener.postMessage({ type: 'ac-reauth-ok' }, window.location.origin)` and then `window.close()`. Same-origin check on the message is enforced implicitly via the `targetOrigin` argument. |
| `/auth/denied` | GET | Access denied page |
| `/auth/logout` | GET | Destroys session, clears cookie, redirects to `/` |

**`requireAuth` middleware:** Localhost passes through without auth. Otherwise requires `req.isAuthenticated()`. For unauthenticated requests to `/api/*` paths, responds with `401 { error: "Not authenticated" }` as JSON (so client `fetch` callers can handle it without trying to parse an HTML login page). All other unauthenticated requests are redirected to `/auth/login`.

**`meHandler` (`GET /api/me`):** Returns `{ displayName: string | null, email: string | null, provider: 'local' | 'google' | 'github' | null }` from `req.user`. The endpoint sits behind `requireAuth`, so unauthenticated non-local callers get the standard `401 { error: "Not authenticated" }`. Local-bypass requests that arrive without a user object get `200` with all three fields set to `null`, so the v2 sidebar footer can render a neutral placeholder in localhost dev sessions instead of failing the fetch.

See [ADR-0023](adr/0023-use-first-party-owner-authentication.md) for the first-party owner auth decision.

**V2 frontend silent re-auth:** When `AgentApi.chatFetch` sees a 401, it invokes the handler registered via `AgentApi.setSessionExpiredHandler`. The shell wires this (see `web/AgentCockpitWeb/src/shell.jsx`) to a popup flow:

1. `dialog.confirm` with "Sign in" / "Cancel" — if the user declines, nothing happens.
2. On confirm, `window.open('/auth/login?popup=1', 'ac-reauth', ...)`. If the popup is blocked, fall back to a full-page redirect to `/auth/login` (the draft still survives via the localStorage mirror).
3. The main window awaits either a `postMessage({ type: 'ac-reauth-ok' })` from the popup (sent by `/auth/popup-done` after successful first-party login) or the popup closing without a success message (polled via `popup.closed` every 500 ms).
4. In either case, call `AgentApi.invalidateCsrfToken()` — the old cached CSRF token is tied to the old session and would be rejected by `csrfGuard`; the next `chatFetch` re-fetches lazily.
5. On success, call `StreamStore.clearAllStreamErrors()` to sweep stale "session expired" stream-error cards across every conv. The user's draft (input text + completed uploads) is already preserved in `ConvState.input` / `ConvState.pendingAttachments` by the `send()` snapshot/restore logic (`streamStore.js`), so they can just click send again.
6. On close-without-success, verify with a `GET /api/csrf-token`; if still 401, open an error alert and re-enable the handler.

Re-entrancy is guarded by a `reAuthInFlightRef` — overlapping 401s on concurrent requests don't stack dialogs or popups.

## 6.4 CSRF Protection

**File:** `src/middleware/csrf.ts`

- `ensureCsrfToken` (global middleware): generates 32-byte hex token if missing from session
- `csrfGuard` (route-level, POST/PUT/DELETE): validates `x-csrf-token` header or `req.body._csrf` against session token. Returns `403` on mismatch.
- `GET /api/csrf-token`: returns `{ csrfToken }` from session
- `GET /api/me`: returns `{ displayName, email, provider }` (all nullable) from `req.user`. Same auth gating as other `/api/*` routes.

CLI profile remote-auth endpoints that spawn local CLI processes are CSRF-protected (`POST /api/chat/cli-profiles/:id/test`, `POST /api/chat/cli-profiles/:id/auth/start`, and auth-job cancel). They only accept saved Codex/Claude Code account profiles, run with that profile's command/env/config directory, and redact common bearer/access/refresh/API-key patterns from stdout/stderr before exposing job events to the browser. Kiro remote auth is intentionally blocked while Kiro lacks a safe dedicated config-home override.

## 6.5 Security Headers

**File:** `src/middleware/security.ts`

Helmet with CSP directives:
```
default-src: 'self'
script-src: 'self', 'unsafe-inline'
script-src-attr: 'unsafe-inline'
style-src: 'self', 'unsafe-inline', https://cdnjs.cloudflare.com, https://fonts.googleapis.com, https://api.fontshare.com
font-src: 'self', data:, https://fonts.gstatic.com, https://api.fontshare.com, https://cdn.fontshare.com
img-src: 'self', data:, blob:
connect-src: 'self'
object-src: 'none'
base-uri: 'self'
frame-ancestors: 'none'
form-action: 'self'
```

The V2 runtime bundles React, ReactDOM, marked, DOMPurify, and highlight.js through Vite, so no third-party script or connect source is required for the main web app. `cdnjs.cloudflare.com` remains in `style-src` for the current highlight.js theme stylesheet, and `fonts.googleapis.com` / `api.fontshare.com` (style) plus `fonts.gstatic.com` / `api.fontshare.com` / `cdn.fontshare.com` (font) are allowlisted for JetBrains Mono, Instrument Serif, and General Sans.

Cross-Origin Embedder Policy: disabled.

## 6.6 Path Traversal & Root-Delete Guards

Several routes accept user-supplied relative paths that resolve inside a workspace working directory. All of them use the same shape of guard:

1. **Normalize leading separators.** Any leading `/` or `\` is stripped from the input before `path.resolve(root, rel)` — this treats absolute-looking paths as relative to the workspace root instead of accidentally escaping to system paths.
2. **Assert the resolved path is contained.** The resolved absolute path must equal the workspace root or start with `root + path.sep`. On failure the route returns `403 { error: "Access denied: path is outside workspace" }` without touching the filesystem.
3. **Refuse destructive root operations.** The workspace root itself is never a valid target for rename or delete. Those routes return `400 { error: "Cannot rename workspace root" }` / `400 { error: "Cannot delete workspace root" }` before any `fs` call.

**Routes covered by these guards:**

| Route | Guards |
|-------|--------|
| `GET /workspaces/:hash/explorer/tree` | traversal |
| `GET /workspaces/:hash/explorer/preview` | traversal |
| `POST /workspaces/:hash/explorer/upload` | traversal on destination folder; multer `LIMIT_FILE_SIZE` 500 MB |
| `POST /workspaces/:hash/explorer/mkdir` | traversal on parent folder; name rejected for `/`, `\`, `.`, `..`, or empty strings; final absolute path re-verified under the parent root before `fs.mkdir` |
| `POST /workspaces/:hash/explorer/file` | traversal on parent folder; name rejected for `/`, `\`, `.`, `..`, or empty strings; final absolute path re-verified under the parent root; 409 on collision with any existing file or folder (no overwrite); optional seed `content` must be a string ≤ 5 MB UTF-8 or the request returns 413 without writing |
| `PUT /workspaces/:hash/explorer/file` | traversal; refuses directories and workspace root; `content` must be a string; `Buffer.byteLength(content, 'utf8')` checked against the 5 MB edit cap before any write; over-limit payloads return 413 and leave the file untouched |
| `PATCH /workspaces/:hash/explorer/rename` | traversal on both `from` and `to`; root-rename refusal; 409 on non-overwrite conflict |
| `DELETE /workspaces/:hash/explorer/entry` | traversal; root-delete refusal |
| `GET /workspaces/:hash/files` | traversal (pre-existing file-delivery route) |
| `POST /workspaces/:hash/kb/raw` | filename + folder segment validation via `KbValidationError`; MIME-typed stage path verified under `knowledge/raw/` |
| `DELETE /workspaces/:hash/kb/raw/:rawId` | hex-only `rawId` regex gate; staged path verified under `knowledge/raw/` |
| `GET /workspaces/:hash/kb/raw/:rawId` | hex-only `rawId` gate; resolved file path verified under `knowledge/raw/` |

The explorer upload uses multer's disk storage with a randomized `.ac-upload-<ts>-<nonce>-<safe>` prefix in the destination folder so a partial upload never clobbers an existing file. After the stream completes, a collision check against the real target decides whether to unlink the temp file (conflict without overwrite) or rename it into place.

Hidden files (names starting with `.`) are intentionally returned by the explorer tree endpoint — this is a product requirement for the file explorer UI. The traversal guard is the only layer that prevents reading outside the workspace; there is no additional "safe extension" filter because the workspace root is defined by the user and may contain any file type they want to manage.
