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
| `KIRO_ACP_IDLE_TIMEOUT_MS` | No | `600000` | Idle timeout (ms) before killing the Kiro ACP process |
| `BASE_PATH` | No | `''` | URL base path prefix (for reverse proxy deployments) |

## 5.2 Server Initialization Order

**File:** `server.ts`

1. Create Express app, set `trust proxy: 1`
2. Apply Helmet security headers via `applySecurity(app)`
3. Configure express-session with FileStore (`data/sessions/`, 24h TTL, `retries: 0`)
4. Passport 0.7 polyfill — adds `session.regenerate`/`session.save` stubs if missing
5. Setup Passport with `setupAuth(app, config)`
6. Apply `requireAuth` middleware globally
7. Apply `ensureCsrfToken` middleware globally
8. Parse JSON bodies with `express.json()`
9. Mount CSRF token endpoint at `GET /api/csrf-token`
10. Create BackendRegistry, register ClaudeCodeAdapter and KiroAdapter
11. Initialize ChatService
12. Initialize UpdateService
13. Mount chat router at `/api/chat`
14. Serve static files from `public/`
15. Call `chatService.initialize()` (migration + lookup map)
16. Start UpdateService (version polling)
17. Listen on configured PORT
18. Attach WebSocket server via `attachWebSocket(server, { sessionStore, sessionSecret, activeStreams })` — returns `WsFunctions` object with `send`, `isConnected`, `isStreamAlive`, `clearBuffer`, `shutdown`
19. Wire WebSocket functions into the chat router via `setWsFunctions(wsFns)`

### Graceful Shutdown

Signal handlers for `SIGTERM`/`SIGINT`:
1. Call `chatShutdown()` — aborts all active CLI streams
2. Call `backendRegistry.shutdownAll()` — kills long-lived backend processes (e.g. Kiro ACP)
3. Call `wsShutdown()` — closes all WebSocket connections and the WS server
4. Call `server.close()` — stop accepting connections
5. 10-second forced exit timeout (`.unref()` as safety net)

## 5.3 Authentication

**File:** `src/middleware/auth.ts`

**Strategies:**
- **Google OAuth 2.0** (always registered): `passport-google-oauth20`, scope `['profile', 'email']`
- **GitHub OAuth** (optional, if both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` set): `passport-github2`, scope `['user:email']`

**Email verification:** Both strategies use `verifyEmail(config)` — parses `ALLOWED_EMAIL` into lowercased array, case-insensitive match, returns `{ id, email, displayName }` or `false`.

**Rate limiting:** Applied to `/auth/google*` and `/auth/github*` — 15 min window, 20 requests/IP.

**Auth routes:**

| Route | Method | Description |
|-------|--------|-------------|
| `/auth/login` | GET | Login page with Google + GitHub (if configured) buttons |
| `/auth/google` | GET | Initiates Google OAuth flow |
| `/auth/google/callback` | GET | Google callback → `/` on success, `/auth/denied` on failure |
| `/auth/github` | GET | Initiates GitHub OAuth flow |
| `/auth/github/callback` | GET | GitHub callback → `/` on success, `/auth/denied` on failure |
| `/auth/denied` | GET | Access denied page |
| `/auth/logout` | GET | Destroys session, clears cookie, redirects to `/` |

**`requireAuth` middleware:** Localhost passes through without auth. Otherwise requires `req.isAuthenticated()`. For unauthenticated requests to `/api/*` paths, responds with `401 { error: "Not authenticated" }` as JSON (so client `fetch` callers can handle it without trying to parse an HTML login page). All other unauthenticated requests are redirected to `/auth/login`.

**Frontend session-expired handling:** When any API request returns `401`, `chatFetch` / `fetchCsrfToken` / the streaming send path each call `chatShowSessionExpired()` (in `public/js/state.js`), which renders a modal overlay (`#chat-session-expired-overlay`) with a "Sign in again" button pointing at `./auth/login`. The overlay is idempotent — calling it repeatedly does not stack overlays. Drafts are preserved by existing `draftState.js` localStorage persistence and survive the sign-in redirect.

## 5.4 CSRF Protection

**File:** `src/middleware/csrf.ts`

- `ensureCsrfToken` (global middleware): generates 32-byte hex token if missing from session
- `csrfGuard` (route-level, POST/PUT/DELETE): validates `x-csrf-token` header or `req.body._csrf` against session token. Returns `403` on mismatch.
- `GET /api/csrf-token`: returns `{ csrfToken }` from session

## 5.5 Security Headers

**File:** `src/middleware/security.ts`

Helmet with CSP directives:
```
default-src: 'self'
script-src: 'self', 'unsafe-inline', https://cdnjs.cloudflare.com
script-src-attr: 'unsafe-inline'
style-src: 'self', 'unsafe-inline', https://cdnjs.cloudflare.com
img-src: 'self', data:, blob:
connect-src: 'self'
object-src: 'none'
base-uri: 'self'
frame-ancestors: 'none'
form-action: 'self'
```

Cross-Origin Embedder Policy: disabled.
