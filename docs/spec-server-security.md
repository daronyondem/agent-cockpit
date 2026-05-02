# 5. Server Initialization & Security

[← Back to index](SPEC.md)

---

## 5.1 Configuration

**File:** `src/config/index.ts`

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3334` | Server listen port |
| `SESSION_SECRET` | Yes | — | Secret for signing session cookies |
| `GOOGLE_CLIENT_ID` | Yes | — | Google OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | — | Google OAuth 2.0 client secret |
| `GOOGLE_CALLBACK_URL` | Yes | — | Google OAuth callback URL |
| `GITHUB_CLIENT_ID` | No | — | GitHub OAuth client ID (enables GitHub login if set) |
| `GITHUB_CLIENT_SECRET` | No | — | GitHub OAuth client secret |
| `GITHUB_CALLBACK_URL` | No | — | GitHub OAuth callback URL |
| `ALLOWED_EMAIL` | Yes | — | Comma-separated list of allowed email addresses |
| `DEFAULT_WORKSPACE` | No | `~/.openclaw/workspace` | Default working directory for CLI processes |
| `KIRO_ACP_IDLE_TIMEOUT_MS` | No | `3600000` | Idle timeout (ms) before killing the Kiro ACP process |
| `BASE_PATH` | No | `''` | URL base path prefix (for reverse proxy deployments) |

`src/config/index.ts` loads `.env` through `dotenv`. Outside tests, `.env` values override already-present process environment values so PM2-managed local deployments can pin runtime config from the repo's `.env`. When `NODE_ENV === 'test'`, dotenv does **not** override explicit process env values; subprocess tests such as graceful shutdown can pass an isolated `PORT` without being clobbered by a developer `.env` that points at a running PM2 app.

## 5.2 Server Initialization Order

**File:** `server.ts`

1. Create Express app, set `trust proxy: 1`
2. Apply Helmet security headers via `applySecurity(app)`
3. Configure express-session with FileStore (`data/sessions/`, 24h TTL, `retries: 0`). `cookie.maxAge` is 24h and `rolling: true` is set — every request re-issues the cookie with a fresh 24h expiry, so active users never hit the wall mid-workflow while idle users still expire after 24h of no activity.
4. Passport 0.7 polyfill — adds `session.regenerate`/`session.save` stubs if missing
4a. Mount the public logo route `GET /logo-full-no-text.svg` (serves `public/logo-full-no-text.svg`) — placed before `setupAuth` / `requireAuth` so the unauthenticated login page can load the Agent Cockpit brand mark
5. Setup Passport with `setupAuth(app, config)`
6. Apply `requireAuth` middleware globally
7. Apply `ensureCsrfToken` middleware globally
8. Parse JSON bodies with `express.json()`
9. Mount CSRF token endpoint at `GET /api/csrf-token`
9a. Mount current-user endpoint at `GET /api/me`
10. Create BackendRegistry, register ClaudeCodeAdapter and KiroAdapter
11. Initialize ChatService
12. Initialize UpdateService
13. Mount chat router at `/api/chat`
14. Serve static files from `public/`
15. Call `chatService.initialize()` (migration + lookup map)
16. Reconcile leftover durable stream jobs via `chatResult.reconcileInterruptedJobs()` before the server accepts traffic. This converts unrecoverable accepted/preparing/running jobs from a prior process into one persisted assistant `streamError` when the user message exists, or removes the job when no user message was saved.
17. Start UpdateService (version polling)
18. Listen on configured PORT
19. Attach WebSocket server via `attachWebSocket(server, { sessionStore, sessionSecret, activeStreams, abortStream })` — returns `WsFunctions` object with `send`, `isConnected`, `isStreamAlive`, `clearBuffer`, `shutdown`. `activeStreams` is the stream supervisor's process-local runtime attachment map while this process owns a backend iterator; `data/chat/stream-jobs.json` is the durable supervision layer used for accepted/preparing visibility, backend runtime identifiers (`externalSessionId`, `activeTurnId`, `processId`), and restart reconciliation. Runtime identifiers are diagnostic/current-turn metadata only; startup reconciliation still does not reattach or retry unless a backend explicitly advertises active-turn resume support. WebSocket connection state is transport-only and does not cancel an accepted stream. Transport-independent cancellation goes through CSRF-protected `POST /api/chat/conversations/:id/abort`; legacy WebSocket abort frames delegate to the same router-owned abort function.
20. Wire WebSocket functions into the chat router via `setWsFunctions(wsFns)`

### Graceful Shutdown

Signal handlers for `SIGTERM`/`SIGINT`:
1. Call and await `chatShutdown()` — marks pending/runtime-attached durable stream jobs `finalizing` with `Interrupted by server shutdown`, aborts runtime backend handles, and clears process-local stream maps without deleting those durable jobs
2. Call `backendRegistry.shutdownAll()` — kills long-lived backend processes (e.g. Kiro ACP)
3. Call `wsShutdown()` — closes all WebSocket connections and the WS server
4. Call `server.close()` — stop accepting connections
5. 10-second forced exit timeout (`.unref()` as safety net)

On the next process start, normal durable job reconciliation converts those finalizing shutdown jobs into one persisted assistant `streamError` when the accepted user message exists.

## 5.3 Authentication

**File:** `src/middleware/auth.ts`

**Strategies:**
- **Google OAuth 2.0** (always registered): `passport-google-oauth20`, scope `['profile', 'email']`
- **GitHub OAuth** (optional, if both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` set): `passport-github2`, scope `['user:email']`

**Email verification:** Both strategies use `verifyEmail(config, provider)` — parses `ALLOWED_EMAIL` into lowercased array, case-insensitive match, returns `{ id, email, displayName, provider }` or `false`. The `provider` field (`'google'` or `'github'`) is baked into the user object at verification time so downstream code (e.g. `meHandler`) can tell where the user signed in from without re-inspecting the passport strategy.

**Rate limiting:** Applied to `/auth/google*` and `/auth/github*` — 15 min window, 20 requests/IP.

**Auth routes:**

| Route | Method | Description |
|-------|--------|-------------|
| `/auth/login` | GET | Editorial two-column login page. **Left column:** topbar with the Agent Cockpit logo (`<img src="/logo-full-no-text.svg">` — the same asset the V2 sidebar renders, rendered at 90×35) + "Agent Cockpit" wordmark, with a "Readme.md here" link (→ `https://github.com/daronyondem/agent-cockpit`, `target="_blank"`) on the right; centered body with a pulsing-dot "Ready" eyebrow, serif title ("The cockpit _is listening._ Sign in to take the controls."), sub-paragraph, provider buttons for Google (real multi-color G SVG) and — when GitHub config is present — GitHub (real Octocat SVG, tagged "Recommended"), legal paragraph; mono footer with "All systems operational" status + Terms (`#`) / Privacy (`#`) / Docs (→ `https://github.com/daronyondem/agent-cockpit/tree/main/docs`) links. **Right column (hidden below 960px):** radial-gradient editorial canvas with a serif pull-quote about Agent Cockpit attributed to _Daron Yondem · Sr AI/ML Architect, AWS_; the quote's three `<em>` spans (`knowledge base`, `memory`, `multiple CLI vendors`) render in `--accent` blue via the `.pe-quote em` rule. Theme follows `localStorage['ac:v2:theme']` (`'system'` default falls back to `prefers-color-scheme`), applied via an inline pre-paint script that sets `data-theme` on `<html>` before CSS loads. Design tokens (editorial direction, light + dark) are inlined in the response because `/v2/src/tokens.css` is gated behind `requireAuth`. Fonts (JetBrains Mono, Instrument Serif, General Sans) are loaded from the same CDNs as the V2 app — allowed by the CSP `style-src` / `font-src` lists. Accepts `?popup=1` — when set, the provider button hrefs become `/auth/google?popup=1` / `/auth/github?popup=1` so the popup flag propagates through the whole flow. The logo asset is served by a targeted `app.get('/logo-full-no-text.svg', ...)` route mounted in `server.ts` _before_ `app.use(requireAuth)`, so unauthenticated visitors to the login page can load it without opening up the rest of `public/`. |
| `/auth/google` | GET | Initiates Google OAuth flow. If `?popup=1`, the `markPopupIfRequested` middleware sets `req.session.reAuthPopup = true` before passport's redirect; the flag survives the Google roundtrip via express-session. |
| `/auth/google/callback` | GET | Google callback → `finishAuth`: redirects to `/auth/popup-done` when `req.session.reAuthPopup` is set (and unsets the flag), otherwise `/`. Failure redirects to `/auth/denied`. |
| `/auth/github` | GET | Initiates GitHub OAuth flow. Same `?popup=1` handling as Google. |
| `/auth/github/callback` | GET | GitHub callback → `finishAuth` (same popup logic as Google). Failure → `/auth/denied`. |
| `/auth/popup-done` | GET | Terminal page for popup re-auth. Serves a tiny HTML document that calls `window.opener.postMessage({ type: 'ac-reauth-ok' }, window.location.origin)` and then `window.close()`. Same-origin check on the message is enforced implicitly via the `targetOrigin` argument. |
| `/auth/denied` | GET | Access denied page |
| `/auth/logout` | GET | Destroys session, clears cookie, redirects to `/` |

**`requireAuth` middleware:** Localhost passes through without auth. Otherwise requires `req.isAuthenticated()`. For unauthenticated requests to `/api/*` paths, responds with `401 { error: "Not authenticated" }` as JSON (so client `fetch` callers can handle it without trying to parse an HTML login page). All other unauthenticated requests are redirected to `/auth/login`.

**`meHandler` (`GET /api/me`):** Returns `{ displayName: string | null, email: string | null, provider: 'google' | 'github' | null }` from `req.user`. The endpoint sits behind `requireAuth`, so unauthenticated non-local callers get the standard `401 { error: "Not authenticated" }`. Local-bypass requests that arrive without a user object get `200` with all three fields set to `null`, so the v2 sidebar footer can render a neutral placeholder in localhost dev sessions instead of failing the fetch.

**V1 frontend session-expired handling:** When any API request returns `401`, `chatFetch` / `fetchCsrfToken` / the streaming send path each call `chatShowSessionExpired()` (in `public/js/state.js`), which renders a modal overlay (`#chat-session-expired-overlay`) with a "Sign in again" button pointing at `./auth/login`. The overlay is idempotent — calling it repeatedly does not stack overlays. Drafts are preserved by existing `draftState.js` localStorage persistence and survive the sign-in redirect.

**V2 frontend silent re-auth:** When `AgentApi.chatFetch` sees a 401, it invokes the handler registered via `AgentApi.setSessionExpiredHandler`. The shell wires this (see `public/v2/src/shell.jsx`) to a popup flow:

1. `dialog.confirm` with "Sign in" / "Cancel" — if the user declines, nothing happens.
2. On confirm, `window.open('/auth/login?popup=1', 'ac-reauth', ...)`. If the popup is blocked, fall back to a full-page redirect to `/auth/login` (the draft still survives via the localStorage mirror).
3. The main window awaits either a `postMessage({ type: 'ac-reauth-ok' })` from the popup (sent by `/auth/popup-done` after successful OAuth) or the popup closing without a success message (polled via `popup.closed` every 500 ms).
4. In either case, call `AgentApi.invalidateCsrfToken()` — the old cached CSRF token is tied to the old session and would be rejected by `csrfGuard`; the next `chatFetch` re-fetches lazily.
5. On success, call `StreamStore.clearAllStreamErrors()` to sweep stale "session expired" stream-error cards across every conv. The user's draft (input text + completed uploads) is already preserved in `ConvState.input` / `ConvState.pendingAttachments` by the `send()` snapshot/restore logic (`streamStore.js`), so they can just click send again.
6. On close-without-success, verify with a `GET /api/csrf-token`; if still 401, open an error alert and re-enable the handler.

Re-entrancy is guarded by a `reAuthInFlightRef` — overlapping 401s on concurrent requests don't stack dialogs or popups.

## 5.4 CSRF Protection

**File:** `src/middleware/csrf.ts`

- `ensureCsrfToken` (global middleware): generates 32-byte hex token if missing from session
- `csrfGuard` (route-level, POST/PUT/DELETE): validates `x-csrf-token` header or `req.body._csrf` against session token. Returns `403` on mismatch.
- `GET /api/csrf-token`: returns `{ csrfToken }` from session
- `GET /api/me`: returns `{ displayName, email, provider }` (all nullable) from `req.user`. Same auth gating as other `/api/*` routes.

CLI profile remote-auth endpoints that spawn local CLI processes are CSRF-protected (`POST /api/chat/cli-profiles/:id/test`, `POST /api/chat/cli-profiles/:id/auth/start`, and auth-job cancel). They only accept saved Codex/Claude Code account profiles, run with that profile's command/env/config directory, and redact common bearer/access/refresh/API-key patterns from stdout/stderr before exposing job events to the browser. Kiro remote auth is intentionally blocked while Kiro lacks a safe dedicated config-home override.

## 5.5 Security Headers

**File:** `src/middleware/security.ts`

Helmet with CSP directives:
```
default-src: 'self'
script-src: 'self', 'unsafe-inline', https://cdnjs.cloudflare.com, https://esm.sh, https://unpkg.com
script-src-attr: 'unsafe-inline'
style-src: 'self', 'unsafe-inline', https://cdnjs.cloudflare.com, https://fonts.googleapis.com, https://api.fontshare.com
font-src: 'self', data:, https://fonts.gstatic.com, https://api.fontshare.com, https://cdn.fontshare.com
img-src: 'self', data:, blob:
connect-src: 'self', https://esm.sh, https://unpkg.com
object-src: 'none'
base-uri: 'self'
frame-ancestors: 'none'
form-action: 'self'
```

`unpkg.com` (script) + `fonts.googleapis.com` / `api.fontshare.com` (style) + `fonts.gstatic.com` / `api.fontshare.com` / `cdn.fontshare.com` (font) are allowlisted for the `/v2/` redesign preview (React + Babel Standalone from unpkg; General Sans / Instrument Serif / JetBrains Mono from Google Fonts + Fontshare). These entries can be narrowed after the v2 cutover if the vendored-asset alternative is chosen.

Cross-Origin Embedder Policy: disabled.

## 5.6 Path Traversal & Root-Delete Guards

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
