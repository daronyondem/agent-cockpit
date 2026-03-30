# Agent Cockpit — Full Specification

This document is a complete specification for Agent Cockpit. It contains every detail needed to rebuild the project from scratch: architecture, data models, API contracts, frontend behavior, authentication, security, styling, testing, CI/CD, and deployment.

---

## 1. Project Overview

**Agent Cockpit** is a web-based chat interface for interacting with the Claude Code CLI. It runs on the same machine as the CLI tools. The server spawns local `claude` CLI processes, streams responses back to the browser via Server-Sent Events (SSE), and stores conversations as JSON files on disk.

### Core Use Case

Install Agent Cockpit on a machine that has Claude Code CLI installed. Expose the server via a tunnel (e.g., ngrok). Access the chat interface from any device — phone, tablet, laptop — and interact with your local Claude Code CLI remotely through the browser.

### Key Principles

- The CLI and the web interface **must** run on the same machine. Agent Cockpit does not connect to a remote API — it spawns local CLI processes.
- Exposing the server via ngrok (or similar) gives remote access to local CLIs.
- OAuth protects access. Only whitelisted email addresses can log in.
- Local requests (localhost/127.0.0.1/::1) bypass authentication for development convenience.

---

## 2. Technology Stack

### Runtime
- **Node.js 18+**
- **CommonJS modules** (`require`/`module.exports` throughout — no ESM)

### Backend
- **Express 4.x** — web framework
- **Passport.js 0.7** — authentication (Google OAuth 2.0, GitHub OAuth)
- **express-session 1.x** with **session-file-store** — file-based session persistence
- **Helmet 8.x** — security headers
- **express-rate-limit 8.x** — rate limiting on auth endpoints
- **Multer 1.x** — file upload handling
- **dotenv** — environment variable loading

### Frontend
- **Vanilla JavaScript** — no framework, no bundler, no build step
- **marked 12.x** (CDN) — Markdown rendering
- **highlight.js 11.9** (CDN) — code syntax highlighting
- Single-page application with all logic in one JS file

### Testing
- **Jest 30.x** — test framework

### CI/CD
- **GitHub Actions** — runs tests on PRs against main

---

## 3. File Structure

```
agent-cockpit/
├── server.js                           # Express server entry point
├── package.json                        # Dependencies and scripts
├── package-lock.json                   # Locked dependency versions
├── .env                                # Environment variables (gitignored)
├── .env.example                        # Template for .env
├── .gitignore                          # node_modules/, data/, .env, *.log, TASK.md
├── README.md                           # Project documentation
├── SPEC.md                             # This file
├── .github/
│   └── workflows/
│       └── test.yml                    # CI: run Jest on PRs to main
├── src/
│   ├── config/
│   │   └── index.js                    # Loads env vars with defaults
│   ├── middleware/
│   │   ├── auth.js                     # Passport strategies, login page, routes
│   │   ├── csrf.js                     # CSRF token generation and validation
│   │   └── security.js                 # Helmet CSP configuration
│   ├── routes/
│   │   └── chat.js                     # All chat API routes
│   └── services/
│       ├── chatService.js              # Conversation CRUD, messages, sessions, settings
│       └── cliBackend.js               # Claude CLI process spawning and streaming
├── public/
│   ├── index.html                      # HTML shell (79 lines)
│   ├── app.js                          # All frontend JavaScript (~1560 lines)
│   └── styles.css                      # All CSS with light/dark theme (~1400 lines)
├── test/
│   ├── chat.test.js                    # Chat route tests — /input endpoint, SSE forwarding, turn boundaries (15 tests)
│   ├── chatService.test.js             # ChatService unit tests (41 tests)
│   ├── cliBackend.test.js              # CLIBackend + extractToolDetails unit tests (33 tests)
│   ├── graceful-shutdown.test.js       # Server shutdown tests (2 tests)
│   └── sessionStore.test.js            # Session file-store tests (4 tests)
└── data/                               # Runtime data (gitignored, created at startup)
    ├── chat/
    │   ├── conversations/              # JSON files, one per conversation
    │   ├── archives/                   # Markdown session archives
    │   ├── artifacts/                  # Reserved directory for uploads
    │   └── settings.json               # User settings
    └── sessions/                       # Express session JSON files
```

---

## 4. Configuration

### File: `src/config/index.js`

Loads environment variables via `dotenv` and exports a config object:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3334` | Server listen port |
| `SESSION_SECRET` | Yes | — | Secret for signing session cookies |
| `GOOGLE_CLIENT_ID` | Yes | — | Google OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | — | Google OAuth 2.0 client secret |
| `GOOGLE_CALLBACK_URL` | Yes | — | Google OAuth callback URL (e.g., `http://localhost:3334/auth/google/callback`) |
| `GITHUB_CLIENT_ID` | No | — | GitHub OAuth client ID (enables GitHub login if set) |
| `GITHUB_CLIENT_SECRET` | No | — | GitHub OAuth client secret |
| `GITHUB_CALLBACK_URL` | No | — | GitHub OAuth callback URL (e.g., `http://localhost:3334/auth/github/callback`) |
| `ALLOWED_EMAIL` | Yes | — | Comma-separated list of allowed email addresses |
| `DEFAULT_WORKSPACE` | No | `~/.openclaw/workspace` | Default working directory for CLI processes |
| `BASE_PATH` | No | `''` | URL base path prefix (for reverse proxy deployments) |

### `.env.example`

```
PORT=3334
SESSION_SECRET=replace-with-a-long-random-string
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3334/auth/google/callback
ALLOWED_EMAIL=you@example.com
DEFAULT_WORKSPACE=~/.openclaw/workspace
BASE_PATH=
```

---

## 5. Server Initialization

### File: `server.js`

The server initializes in this exact order:

1. **Create Express app**, set `trust proxy: 1`
2. **Apply Helmet** security headers via `applySecurity(app)`
3. **Configure express-session** with FileStore:
   - Store: `session-file-store` writing to `data/sessions/`
   - TTL: 24 hours (matches cookie maxAge)
   - `retries: 0` (skip corrupt session files)
   - Cookie: `secure: 'auto'`, `httpOnly: true`, `sameSite: 'lax'`, `maxAge: 24h`
4. **Passport 0.7 polyfill** — middleware adds `session.regenerate` and `session.save` stubs if missing (required for Passport 0.7 compatibility with session-file-store)
5. **Setup Passport** with `setupAuth(app, config)` — registers strategies, routes
6. **Apply `requireAuth` middleware** globally
7. **Apply `ensureCsrfToken` middleware** globally
8. **Parse JSON bodies** with `express.json()`
9. **Mount CSRF token endpoint** at `GET /api/csrf-token`
10. **Initialize ChatService** with `__dirname` as app root
11. **Initialize CLIBackend** with `DEFAULT_WORKSPACE`
12. **Mount chat router** at `/api/chat`
13. **Serve static files** from `public/`
14. **Listen** on configured PORT

### Graceful Shutdown

Signal handlers for `SIGTERM` and `SIGINT`:
1. Log the signal
2. Call `chatShutdown()` — aborts all active CLI streams (sends SIGTERM to child processes), clears the activeStreams map
3. Call `server.close()` — stop accepting new connections
4. Set a 10-second forced exit timeout with `.unref()` as safety net
5. Exit with code 0 on clean close, code 1 on forced timeout

---

## 6. Authentication

### File: `src/middleware/auth.js`

### Strategies

**Google OAuth 2.0** (always registered):
- Strategy: `passport-google-oauth20`
- Scope: `['profile', 'email']`
- Callback: configured via `GOOGLE_CALLBACK_URL`

**GitHub OAuth** (conditionally registered — only if `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are both set):
- Strategy: `passport-github2`
- Scope: `['user:email']`
- Callback: configured via `GITHUB_CALLBACK_URL`

### Email Verification

Both strategies share the same `verifyEmail(config)` callback:
1. Parse `ALLOWED_EMAIL` into a comma-separated, lowercased, trimmed array
2. Extract email from OAuth profile (`profile.emails?.[0]?.value`)
3. Case-insensitive comparison against allowed list
4. On match: return user object `{ id, email, displayName }`
5. On no match: return `false` with message `'Access denied: unauthorized email.'`

### Serialization

- `serializeUser`: stores the full user object `{ id, email, displayName }` in the session
- `deserializeUser`: returns it as-is (no database lookup)

### Rate Limiting

Applied to all `/auth/google*` and `/auth/github*` routes:
- Window: 15 minutes
- Max: 20 requests per IP per window
- Standard headers enabled, legacy headers disabled
- Message: `'Too many authentication attempts, please try again later.'`

### Auth Routes

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/auth/login` | GET | Public | Renders HTML login page with Google (always) and GitHub (if configured) sign-in buttons |
| `/auth/google` | GET | Public | Initiates Google OAuth flow |
| `/auth/google/callback` | GET | Public | Google OAuth callback, redirects to `/` on success, `/auth/denied` on failure |
| `/auth/github` | GET | Public | Initiates GitHub OAuth flow (only if configured) |
| `/auth/github/callback` | GET | Public | GitHub OAuth callback, redirects to `/` on success, `/auth/denied` on failure |
| `/auth/denied` | GET | Public | Renders HTML "Access Denied" page with link back to `/auth/login` |
| `/auth/logout` | GET | Any | Destroys session, clears `connect.sid` cookie, redirects to `/` |

### Login Page

Self-contained HTML page (no external templates):
- Dark background (`#0f172a`), centered card layout
- Title: "Agent Cockpit", subtitle: "Sign in to continue"
- Google button: blue (`#4285f4`) with inline SVG Google icon
- GitHub button: dark (`#24292f`) with inline SVG GitHub icon (only if `hasGitHub` is true)
- Styled with inline `<style>` block

### Access Denied Page

Self-contained HTML:
- Dark background, centered card
- Red "Access Denied" heading
- Message: "This dashboard is private. Your account is not authorized."
- Link: "Try a different account" → `/auth/login`

### `requireAuth` Middleware

Applied globally to all routes after Passport setup:
- If request is from localhost (`localhost`, `127.0.0.1`, `::1`): pass through (no auth needed)
- If `req.isAuthenticated()`: pass through
- Otherwise: redirect to `/auth/login`

---

## 7. CSRF Protection

### File: `src/middleware/csrf.js`

### `ensureCsrfToken` (middleware, applied globally)

- Checks `req.session.csrfToken`
- If missing: generates a 32-byte random hex token via `crypto.randomBytes(32).toString('hex')`
- Sets `res.locals.csrfToken` for template access (unused in current SPA)

### `csrfGuard` (route-level, applied to POST/PUT/DELETE)

- Reads token from `x-csrf-token` header OR `req.body._csrf`
- Compares against `req.session.csrfToken`
- Returns `403 { error: 'Invalid CSRF token' }` on mismatch

### CSRF Token Endpoint

`GET /api/csrf-token` — returns `{ csrfToken: string }` from the session.

---

## 8. Security Headers

### File: `src/middleware/security.js`

Uses Helmet with the following CSP directives:

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

Cross-Origin Embedder Policy: disabled (`false`).

---

## 9. API Endpoints

All chat endpoints are mounted under `/api/chat`. All require authentication (via `requireAuth` middleware). State-changing operations (POST, PUT, DELETE) additionally require `csrfGuard`.

### 9.1 Directory Browsing

```
GET /api/chat/browse?path=<dir_path>&showHidden=true|false
```

- `path` defaults to `os.homedir()` if omitted
- Resolves the path with `path.resolve()`
- Validates: exists, is directory
- Returns `403` if permission denied reading directory
- Filters hidden files (starting with `.`) unless `showHidden=true`
- Sorts directory names case-insensitively

**Response:**
```json
{
  "currentPath": "/absolute/resolved/path",
  "parent": "/parent/path",       // null if at root
  "dirs": ["dir1", "dir2", ...]
}
```

### 9.2 Conversations

**List conversations:**
```
GET /api/chat/conversations?q=<search_query>
```
Returns `{ conversations: ConversationSummary[] }` sorted by `updatedAt` descending. If `q` is provided, searches titles, last messages, and full message content.

**Get single conversation:**
```
GET /api/chat/conversations/:id
```
Returns the full conversation object. `404` if not found.

**Create conversation:**
```
POST /api/chat/conversations  [CSRF]
Body: { title?: string, workingDir?: string }
```
Creates a new conversation with an initial session. Returns the full conversation object.

**Rename conversation:**
```
PUT /api/chat/conversations/:id  [CSRF]
Body: { title: string }
```
Returns updated conversation. `404` if not found.

**Delete conversation:**
```
DELETE /api/chat/conversations/:id  [CSRF]
```
Aborts any active stream for this conversation first. Deletes the conversation JSON file and cleans up the per-conversation artifacts subdirectory. Returns `{ ok: true }`. `404` if not found.

### 9.3 Download

**Download entire conversation as Markdown:**
```
GET /api/chat/conversations/:id/download
```
Returns a `.md` file attachment. Filename is derived from the conversation title (sanitized, max 50 chars).

**Download single session as Markdown:**
```
GET /api/chat/conversations/:id/sessions/:num/download
```
Returns a `.md` file attachment for the specified session number. Filename: `{title}-session-{num}.md`.

### 9.4 Sessions

**Get session history:**
```
GET /api/chat/conversations/:id/sessions
```
Returns `{ sessions: Session[] }` with `isCurrent` computed flag.

**Reset session:**
```
POST /api/chat/conversations/:id/reset  [CSRF]
```
Returns `409` if conversation is currently streaming. Archives current session to Markdown, starts a new session with a fresh UUID. Returns `{ conversation, archiveFilename, newSessionNumber }`.

### 9.5 Messaging and Streaming

**Send message:**
```
POST /api/chat/conversations/:id/message  [CSRF]
Body: { content: string, backend?: string }
```
- Validates content is a non-empty string
- Saves user message to conversation
- Updates conversation backend if changed
- Determines if this is a new CLI session (first message in current session) or a resume
- Spawns CLI process via `cliBackend.sendMessage()`
- Stores stream reference in `activeStreams` map
- Returns `{ userMessage: Message, streamReady: true }`

**Stream response (SSE):**
```
GET /api/chat/conversations/:id/stream
```
- Returns `404` if no active stream for this conversation
- Sets SSE headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`
- Disables socket timeout
- Sends keepalive comment every 5 seconds
- On client disconnect: aborts the CLI process and removes from activeStreams

**SSE event format:**
```
data: {"type":"text","content":"chunk of response text","streaming":true}\n\n
data: {"type":"thinking","content":"thinking text","streaming":true}\n\n
data: {"type":"tool_activity","tool":"Read","description":"Reading `app.js`","id":"tool_1"}\n\n
data: {"type":"tool_activity","tool":"Agent","description":"Explore code","isAgent":true,"subagentType":"Explore"}\n\n
data: {"type":"tool_activity","tool":"EnterPlanMode","isPlanMode":true,"planAction":"enter","description":"Entering plan mode"}\n\n
data: {"type":"tool_activity","tool":"ExitPlanMode","isPlanMode":true,"planAction":"exit","description":"Plan ready for approval"}\n\n
data: {"type":"tool_activity","tool":"AskUserQuestion","isQuestion":true,"questions":[...],"description":"Asking a question"}\n\n
data: {"type":"turn_boundary"}\n\n
data: {"type":"result","content":"final result text"}\n\n
data: {"type":"assistant_message","message":{...full message object}}\n\n
data: {"type":"error","error":"error message"}\n\n
data: {"type":"done"}\n\n
```

**SSE event types:**

| Type | Fields | Description |
|------|--------|-------------|
| `text` | `content`, `streaming` | Text delta from assistant. `streaming: true` for new content (vs. replayed history) |
| `thinking` | `content`, `streaming` | Extended thinking delta from assistant |
| `tool_activity` | `tool`, `description`, `id`, + optional enriched fields | Tool use notification with human-readable description |
| `turn_boundary` | (none) | Marks boundary between assistant turns (e.g., between tool use rounds) |
| `result` | `content` | Final result text from CLI |
| `assistant_message` | `message` | Saved assistant message (intermediate on turn boundary, or final) |
| `error` | `error` | Error message string |
| `done` | (none) | Stream complete |

**Enriched `tool_activity` fields** (set by `extractToolDetails()`):

| Field | When set | Description |
|-------|----------|-------------|
| `isAgent` | Agent tool | Indicates sub-agent invocation |
| `subagentType` | Agent tool | Agent type: `'Explore'`, `'general-purpose'`, etc. |
| `isPlanMode` | EnterPlanMode, ExitPlanMode | Plan mode state change |
| `planAction` | EnterPlanMode, ExitPlanMode | `'enter'` or `'exit'` |
| `isQuestion` | AskUserQuestion | Interactive question for user |
| `questions` | AskUserQuestion | Array of question objects with options |
| `isPlanFile` | Write tool | `true` when writing to `.claude/plans/` |

**Turn boundary behavior:** When a `turn_boundary` event arrives, the router saves any accumulated streaming content (text + thinking) as an intermediate assistant message. This preserves multi-turn responses (e.g., text before and after tool use) in the conversation history.

On stream completion: if there's response content, saves it as an assistant message, sends the `assistant_message` event, then sends `done`. If only a `result` event was received (no streaming deltas), the result text is saved as the final message.

**Abort streaming:**
```
POST /api/chat/conversations/:id/abort  [CSRF]
```
Kills the CLI process (SIGTERM), removes from activeStreams. Returns `{ ok: true }` or `{ ok: false, message: 'No active stream' }`.

**Send interactive input:**
```
POST /api/chat/conversations/:id/input  [CSRF]
Body: { text: string }
```
Writes text to the CLI process's stdin pipe for interactive responses (plan approval, user questions). Returns `{ ok: true }` on success, or `{ ok: false, message: 'No active stream' }` if no active stream exists.

### 9.6 File Upload

```
POST /api/chat/conversations/:id/upload  [CSRF]
Content-Type: multipart/form-data
Field: files[] (max 10 files)
```

- Uses Multer with diskStorage
- Destination: `data/chat/artifacts/{conversationId}/` — per-conversation subdirectory created on first upload (`mkdir recursive`)
- Filename: original name with `/` and `\` replaced by `_`
- File size limit: 50MB per file
- Returns `{ files: [{ name, path, size }] }` where `path` is the absolute filesystem path to the uploaded file in the artifacts directory

### 9.7 Settings

**Get settings:**
```
GET /api/chat/settings
```
Returns settings object. Defaults if file doesn't exist:
```json
{
  "theme": "system",
  "sendBehavior": "enter",
  "customInstructions": { "aboutUser": "", "responseStyle": "" },
  "defaultBackend": "claude-code",
  "workingDirectory": ""
}
```

**Save settings:**
```
PUT /api/chat/settings  [CSRF]
Body: settings object
```
Writes the full body to `data/chat/settings.json`.

---

## 10. Backend Services

### 10.1 ChatService

**File:** `src/services/chatService.js`

**Constructor:** `new ChatService(appRoot)`
- Sets `baseDir` to `<appRoot>/data/chat`
- Creates directories synchronously at startup (only time sync I/O is used): `conversations/`, `archives/`, `artifacts/`

**All methods are `async`** and use `fs.promises` for file I/O.

#### Data Model: Conversation

```javascript
{
  id: string,              // UUIDv4
  title: string,           // Auto-set from first user message (max 80 chars)
  createdAt: string,       // ISO 8601
  updatedAt: string,       // ISO 8601, updated on every save
  backend: string,         // 'claude-code'
  workingDir: string|null, // Filesystem path for CLI working directory
  currentSessionId: string,// UUID of the active CLI session
  sessionNumber: number,   // Current session number (1-based)
  messages: Message[],     // All messages across all sessions
  sessions: Session[]      // Session metadata
}
```

#### Data Model: Message

```javascript
{
  id: string,                   // UUIDv4
  role: string,                 // 'user' | 'assistant' | 'system'
  content: string,              // Message text
  backend: string,              // Backend that generated the response
  timestamp: string,            // ISO 8601
  thinking?: string,            // Extended thinking text (assistant messages only, omitted if empty/null)
  isSessionDivider?: boolean,   // true for session reset markers
  sessionNumber?: number        // Set on session divider messages
}
```

#### Data Model: Session

```javascript
{
  number: number,          // 1-based session number
  sessionId: string,       // UUID passed to CLI as session ID
  startedAt: string,       // ISO 8601
  endedAt: string|null,    // ISO 8601 when session ends, null if current
  messageCount: number     // Messages in this session
}
```

#### Methods

| Method | Description |
|--------|-------------|
| `createConversation(title, workingDir)` | Creates conversation with initial session. Title defaults to 'New Chat'. |
| `getConversation(id)` | Reads JSON from disk. Returns `null` if file not found (ENOENT). |
| `saveConversation(conv)` | Updates `updatedAt`, writes JSON to disk with 2-space indentation. |
| `listConversations()` | Reads all `.json` files in conversations dir. Returns summaries sorted by `updatedAt` desc. Each summary: `{ id, title, createdAt, updatedAt, backend, workingDir, messageCount, lastMessage }` where `lastMessage` is first 100 chars of last message content. |
| `renameConversation(id, newTitle)` | Updates title and saves. Returns `null` if not found. |
| `deleteConversation(id)` | Deletes the JSON file and removes the per-conversation artifacts subdirectory (`data/chat/artifacts/{id}/`) if it exists. Returns `true`/`false`. |
| `addMessage(convId, role, content, backend, thinking)` | Appends message. Auto-titles from first user message (80 chars, newlines→spaces). Increments current session's `messageCount`. Optional `thinking` parameter stores extended thinking text on the message (omitted if falsy). |
| `updateMessageContent(convId, messageId, newContent)` | Forks conversation: truncates all messages after the target message, adds edited content as a new message. Returns `{ conversation, message }`. |
| `resetSession(convId)` | Archives current session to Markdown file in `archives/`. Marks session as ended. Inserts a session divider message. Creates new session with fresh UUID. Returns `{ conversation, archiveFilename, newSessionNumber }`. |
| `getSessionHistory(convId)` | Returns sessions array with computed `isCurrent` flag. |
| `sessionToMarkdown(convId, sessionNumber)` | Public wrapper for `_sessionToMarkdown`. |
| `_sessionToMarkdown(conv, session)` | Generates Markdown for a single session. Format: title, session metadata, then each message with role, timestamp, backend, and content. |
| `conversationToMarkdown(convId)` | Exports entire conversation as Markdown including session reset markers. |
| `searchConversations(query)` | Case-insensitive search. First checks title and last message from summaries, then deep-searches full message content for remaining conversations. |
| `getSettings()` | Returns settings from disk or defaults. |
| `saveSettings(settings)` | Writes settings to disk. |

### 10.2 CLIBackend

**File:** `src/services/cliBackend.js`

**Constructor:** `new CLIBackend(options)` — takes `{ workingDir }`, defaults to `~/.openclaw/workspace`.

#### Helper Functions

**`shortenPath(filePath)`** — shortens long file paths for display. Returns the original path if ≤3 segments, otherwise `.../{last}/{two}.js`. Returns empty string for falsy input.

**`extractToolDetails(block)`** — parses a `tool_use` content block and returns an enriched detail object for UI display. Handles all Claude Code tool types:

| Tool | Description format |
|------|-------------------|
| `Read` | `Reading \`{shortenPath}\`` or `Reading file` |
| `Write` | `Writing \`{shortenPath}\``, sets `isPlanFile` if path contains `.claude/plans/` |
| `Edit` | `Editing \`{shortenPath}\`` or `Editing file` |
| `Bash` | Uses `input.description` if present, else `Running: \`{command}\`` (truncated at 60 chars), else `Running command` |
| `Grep` | `Searching for \`{pattern}\` in {glob}` or `Searching files` |
| `Glob` | `Finding files matching \`{pattern}\`` or `Finding files` |
| `Agent` | Uses `input.description`, sets `isAgent: true`, `subagentType` (default `'general-purpose'`) |
| `TodoWrite` | `Updating task list` |
| `WebSearch` | `Searching: \`{query}\`` or `Searching the web` |
| `WebFetch` | `Fetching: {url}` or `Fetching web content` |
| `EnterPlanMode` | `Entering plan mode`, sets `isPlanMode: true`, `planAction: 'enter'` |
| `ExitPlanMode` | `Plan ready for approval`, sets `isPlanMode: true`, `planAction: 'exit'` |
| `AskUserQuestion` | `Asking a question`, sets `isQuestion: true`, `questions` array |
| (unknown) | `Using {name}` |

All detail objects include `tool` (name), `id` (block id or null), and `description`.

#### `sendMessage(message, options)`

**Parameters:**
- `message` — user's message text
- `options.sessionId` — UUID for the CLI session
- `options.isNewSession` — boolean: `--session-id` (new) vs `--resume` (existing)
- `options.workingDir` — optional override for CLI working directory

**Returns:** `{ stream: AsyncIterable<StreamEvent>, abort: Function, sendInput: Function }`

- `stream` — async iterable yielding stream events
- `abort()` — sets aborted flag and sends SIGTERM to CLI process
- `sendInput(text)` — writes text + newline to the CLI process's stdin pipe (for interactive responses like plan approval and user questions). Safe to call after abort (no-op if process is gone).

**Per-request state** — each call creates its own `state` object with `proc` and `aborted` flag. No shared mutable state between concurrent requests.

**CLI invocation:**
```bash
claude --print \
  --permission-mode bypassPermissions \
  --output-format stream-json \
  --verbose \
  [--session-id <uuid>]    # if isNewSession
  [--resume <uuid>]        # if not isNewSession
  -p "<user message>"
```

**Process spawn:**
- Command: `claude` (must be on PATH)
- Working directory: `options.workingDir` or constructor default
- stdio: stdin `pipe`, stdout `pipe`, stderr `pipe`
- Environment: inherits `process.env`

**Stream parsing:**
- Buffers stdout line-by-line
- Each line is parsed as JSON
- Event type `assistant` with `message.content[]`:
  - `type: 'text'` → yields `{ type: 'text', content }`
  - `type: 'thinking'` → yields `{ type: 'thinking', content }`
  - `type: 'tool_use'` → yields `{ type: 'tool_activity', ...extractToolDetails(block) }`
- Event type `content_block_delta`:
  - `delta.type: 'text_delta'` → yields `{ type: 'text', content, streaming: true }`
  - `delta.type: 'thinking_delta'` → yields `{ type: 'thinking', content, streaming: true }`
- Event type `user` → yields `{ type: 'turn_boundary' }`
- Event type `result` → yields `{ type: 'result', content }`
- Unparseable lines → yields `{ type: 'text', content: line }`
- On close with non-zero exit code → yields `{ type: 'error', error: stderrOutput }`
- On process error → yields `{ type: 'error', error: err.message }`
- Always yields `{ type: 'done' }` at end

**Abort:**
- Sets `aborted` flag
- Sends SIGTERM to child process
- Stream yields `{ type: 'error', error: 'Aborted by user' }` then `{ type: 'done' }`

**Polling loop:**
- Generator yields events from a queue
- Waits with `Promise` resolved by stdout/close events or a 100ms timeout

---

## 11. Frontend

### 11.1 HTML Structure

**File:** `public/index.html`

Single-page layout:
- `<head>`: highlight.js CDN CSS (github-dark theme), local `styles.css`
- `<body class="chat-active">`:
  - `.chat-layout` — flex container
    - `.chat-sidebar` — left panel:
      - `.chat-sidebar-header` — collapse toggle + "New Chat" button
      - `.chat-search` — search input
      - `.chat-conv-list` — conversation list (populated by JS)
      - `.chat-sidebar-footer` — Settings button
      - `.chat-sidebar-footer` — Sign Out button
    - `.chat-main` — right panel:
      - `.chat-header` — sidebar toggle, title, action buttons (Download, Reset, Sessions)
      - `.chat-messages` — message area with empty state (prompt cards)
      - `.chat-input-area` — backend selector, file chips, textarea, attach/send buttons, input hint
- `<script>`: highlight.js CDN, marked CDN, local `app.js`

### 11.2 Frontend JavaScript

**File:** `public/app.js` (~1560 lines)

#### Constants

```javascript
CHAT_BACKENDS[]             // Array of { id, label } backend definitions; currently: [{ id: 'claude-code', label: 'Claude Code' }]
CLAUDE_CODE_ICON            // Inline SVG string (28×28) — rounded-square icon used as avatar for Claude Code assistant messages
```

#### Global State

```javascript
csrfToken                   // CSRF token string
chatConversations[]         // Array of conversation summaries
chatActiveConvId            // UUID of selected conversation
chatActiveConv              // Full conversation object
chatStreamingConvs          // Set of conversation IDs with active streams
chatStreamingState          // Map<convId, StreamState> — per-conversation streaming state for persistence across view switches
chatAbortController         // Current abort controller (not used for SSE; abort via API)
chatSidebarCollapsed        // Boolean
chatSearchTimeout           // Debounce timer for search
chatContextMenuEl           // Active context menu DOM element
chatSettingsData            // Settings object from server
chatInitialized             // Boolean — prevents double init
chatPendingWorkingDir       // Working dir selected for new conversation
chatPendingFiles[]          // Files queued for upload
```

**`chatStreamingState` Map entry shape:**
```javascript
{
  assistantContent: string,      // Accumulated streaming text
  assistantThinking: string,     // Accumulated thinking text
  activeTools: Array,            // Current tool_activity events
  activeAgents: Array,           // Current agent cards
  planModeActive: boolean,       // Plan mode banner visible
  pendingInteraction: object|null, // { type: 'planApproval' } or { type: 'userQuestion', event }
  streamingMsgEl: HTMLElement|null // Reference to current streaming bubble DOM element
}
```

#### API Communication

- `apiUrl(path)` — constructs full URL from relative path using `API_BASE` (derived from `window.location.href` + `./api/`)
- `chatApiUrl(path)` — prepends `chat/` to path
- `chatFetch(path, opts)` — fetch wrapper that:
  - Fetches CSRF token if missing
  - Adds `x-csrf-token` header
  - Serializes JSON body if not FormData
  - Includes `credentials: 'same-origin'`
  - Throws on non-OK response with error message from body

#### Initialization (`chatInit`)

1. Wire event listeners
2. Load conversations list
3. Fetch settings from server → apply theme

#### Conversation Management

- `chatNewConversation()` — opens folder picker modal, then calls `chatCreateConversationWithDir(workingDir)`
- `chatCreateConversationWithDir(workingDir)` — POSTs new conversation, adds to list, selects it
- `chatSelectConversation(id)` — fetches full conversation, renders messages, updates header
- `chatRenameConversation(id)` — prompts for new name, PUTs update
- `chatDeleteConversation(id)` — confirms, DELETEs, clears selection if active
- `chatLoadConversations(query)` — fetches list, renders sidebar
- `chatGroupConversations(convs)` — groups by relative date: "Today", "Yesterday", "Previous 7 Days", "Previous 30 Days", "Older"

#### Messaging

- `chatSendMessage()` — POSTs message, initializes `chatStreamingState` entry for the conversation, opens EventSource to `/stream`. The SSE loop writes all state to the Map entry rather than closure-local variables, enabling state persistence across conversation switches. After `chatRenderMessages()` renders the user message, the streaming bubble is only created if one wasn't already created by the render's streaming state restoration (guarded by `!state.streamingMsgEl` check to prevent duplicate bubbles).
- `chatStopStreaming()` — POSTs abort endpoint
- `chatAppendStreamingMessage()` — inserts empty assistant message bubble with pulsing cursor
- `chatUpdateStreamingMessage(msgEl, content, thinking)` — renders Markdown incrementally into the streaming bubble. Optionally shows thinking block in a collapsible `<details>` element.
- `chatUpdateStreamingActivity(msgEl, tools, agents, planMode)` — renders rich tool activity display: activity history (completed tools with checkmarks), current tool with description, agent cards with spinners and type labels, plan mode banner.
- `chatShowPlanApproval(msgEl, convId)` — shows approve/reject buttons for plan approval. On click, POSTs to `/conversations/:id/input` with `"yes"` or `"no"`, clears `pendingInteraction` state.
- `chatShowUserQuestion(msgEl, convId, event)` — renders question text, clickable option buttons, and text input. On selection, POSTs answer to `/conversations/:id/input`, clears `pendingInteraction` state.
- `chatUpdateSendButtonState()` — updates send button to show stop (■) when the current conversation is streaming, or send (↑) when idle. Called on conversation switch and stream completion.
- `chatRetryLast()` — sends the last user message again (for regeneration)
- Streaming uses `fetch` with manual ReadableStream parsing (not EventSource API) — reads SSE lines from the response body, parses `data:` lines as JSON
- **Streaming state restoration:** When `chatRenderMessages()` is called and `chatStreamingState` has an entry for the active conversation, it re-creates the streaming bubble and restores the UI: pending interactions (plan approval/user question), accumulated text/thinking, or active tool/agent display. Uses `streamingMsgEl.isConnected` to detect orphaned DOM nodes destroyed by `innerHTML` replacement. On `assistant_message` events, streaming state (content, thinking, tools, agents) is reset **before** calling `chatRenderMessages()` so the restored bubble shows typing dots rather than stale content duplicating the completed message.

#### File Handling

- Drag-and-drop onto chat area → `chatAddPendingFiles(files)`
- Paste from clipboard → detects image, creates File from blob
- File input button → opens native file picker
- `chatRenderFileChips()` — shows file names, sizes, and remove buttons above textarea
- `chatUploadFiles(convId, files)` — POSTs FormData to upload endpoint
- Files are uploaded when the user sends a message, before the message content is sent. The absolute file paths (from the upload response's `path` field) are embedded in the message text as `[Uploaded files: /abs/path/to/file1, /abs/path/to/file2]`, giving Claude Code CLI the full paths to read the files regardless of its working directory.

#### Session Management

- `chatResetSession()` — POSTs reset endpoint, reloads conversation
- `chatShowSessions()` — opens modal with session list, each with "View" and "Download" buttons
- `chatViewSession(sessionNumber)` — fetches session Markdown, displays in modal
- Session download: navigates to `GET .../sessions/:num/download`

#### Downloads

- `chatDownloadConversation()` — navigates to `GET .../download` endpoint (triggers file download)
- Session download via session history modal's Download button

#### Settings Modal

- `chatShowSettings()` — opens modal with:
  - Theme dropdown: System (default), Light, Dark
  - Send behavior: Enter to send / Shift+Enter to send
  - Working directory text input
- `chatSaveSettings()` — PUTs settings, applies theme immediately

#### UI Utilities

- `chatToggleSidebar()` — adds/removes `.collapsed` CSS class
- `chatAutoResize(textarea)` — sets height to scrollHeight, max ~200px
- `chatRenderMessages()` — renders all messages in the active conversation
- `chatRenderMarkdown(text)` — uses `marked.parse()` for Markdown rendering
- `chatHighlightCode(container)` — applies highlight.js to `<code>` blocks, adds copy buttons and expandable wrappers for long code blocks
- `chatShowFolderPicker(initialPath)` — modal with directory browser (calls `GET /api/chat/browse`), supports navigation, hidden file toggle, manual path entry
- `chatShowModal(title, bodyHtml)` — generic modal with overlay, close button
- `chatShowContextMenu(e, convId)` — right-click context menu on conversation items (Rename, Delete)
- `esc(str)` — HTML entity escaping for `&`, `<`, `>`, `"`
- `escWithCode(str)` — like `esc()` but also converts backtick-wrapped text to `<code>` elements (for tool descriptions)

#### Keyboard Shortcuts

- **Enter** — send message (when send behavior is "enter")
- **Shift+Enter** — newline (when send behavior is "enter"), or send (when "shift+enter")
- **Ctrl+Shift+D** — download conversation
- **Ctrl+Shift+R** — reset session

### 11.3 CSS & Theming

**File:** `public/styles.css` (~1400 lines)

#### Theme System

Uses CSS custom properties on `:root` (light) and `[data-theme="dark"]`:

**Light theme (default):**
- Background: `#f5f6f8`
- Surface: `#ffffff`
- Text: `#1a1d23`
- Accent: `#6366f1` (indigo for chat)
- User message bg: `#eff6ff`
- Assistant message bg: `var(--surface)`

**Dark theme:**
- Background: `#0f1117`
- Surface: `#1a1d27`
- Text: `#e4e6eb`
- User message bg: `#1e293b`
- Links: `#93b4f8` (readable blue in dark mode)

Theme is applied by setting `data-theme` attribute on `<html>`:
- `applyTheme('system')` checks `prefers-color-scheme`
- Listens for system theme changes and reapplies if set to "system"
- Persists to `localStorage` under key `agent-cockpit-theme`
- Synced from server settings on init

#### Layout

- Flexbox: sidebar (fixed `280px` width) + main area (flex: 1)
- Sidebar collapses with `.collapsed` class (translateX off-screen on mobile)
- Messages area: flex-direction column, overflow-y auto, scrolls to bottom
- Input area: fixed at bottom of main area

#### Key Components

- **Message bubbles**: user (blue tint) aligned right, assistant (surface) aligned left
- **Message avatars**: user messages show 👤 emoji in circular accent-colored badge; Claude Code assistant messages show an inline SVG icon (`.chat-msg-avatar-svg` — `border-radius: 6px`, no background, 28×28); other backends fall back to ⚡ emoji; error messages show `!` in red badge
- **Code blocks**: dark background (`#1e1e2e`), header with language label and copy button, expandable for blocks > ~25 lines
- **Modal**: centered overlay, max-width 600px, close button, scrollable body
- **Context menu**: absolute positioned, border, shadow, appears on right-click
- **File chips**: horizontal row of chips showing filename, size, and remove button
- **Drag-and-drop overlay**: full-screen overlay when dragging files
- **Prompt cards**: centered cards in empty state for quick conversation starters
- **Sidebar footer**: Settings and Sign Out buttons at bottom of sidebar
- **Activity history** (`.chat-activity-history`): completed tool activities shown with checkmark icons and muted text
- **Agent cards** (`.chat-agent-card`): sub-agent visualization with spinning animation (`.chat-agent-spinner`), agent type label, and description text
- **Plan mode banner** (`.chat-plan-mode-banner`): green accent indicator showing "Plan mode active"
- **Plan approval** (`.chat-plan-approval`): card with approve/reject buttons for interactive plan approval
- **User question** (`.chat-user-question`): question text with clickable option buttons and text input fallback
- **Streaming indicator dot** (`.chat-conv-streaming-dot`): 8×8 pulsing dot next to streaming conversations in sidebar, uses `streaming-pulse` keyframe animation (1.5s ease-in-out infinite)

#### Responsive

- Below ~768px: sidebar overlays content, toggle button visible in header
- Textarea: auto-resizes with content, max height ~200px

---

## 12. Storage

All data is file-based. No database.

### Conversations
- Path: `data/chat/conversations/{uuid}.json`
- Format: JSON with 2-space indentation
- Contains full conversation history, all messages, all session metadata

### Archives
- Path: `data/chat/archives/{convId}_{sessionNumber}_{timestamp}.md`
- Created when a session is reset
- Markdown format with headers, timestamps, roles

### Sessions (Express)
- Path: `data/sessions/`
- Managed by `session-file-store`
- JSON files with session data (user info, CSRF token)
- TTL: 24 hours, auto-pruned

### Settings
- Path: `data/chat/settings.json`
- Single JSON file for user preferences

### Artifacts
- Path: `data/chat/artifacts/{conversationId}/`
- Per-conversation subdirectories created on first file upload
- Stores uploaded files separate from the project workspace
- Cleaned up when the conversation is deleted

---

## 13. Active Streams Management

The chat router maintains an in-memory `Map<conversationId, { stream, abort, sendInput, backend }>`:

- **Set** when `POST /conversations/:id/message` spawns a CLI process
- **Read** when `GET /conversations/:id/stream` connects the SSE endpoint
- **Deleted** when: stream completes, client disconnects, abort is called, conversation is deleted, or server shuts down
- **Prevents** concurrent streams per conversation (only one active CLI process per conversation at a time)
- **Blocks** session reset while streaming (returns `409`)

---

## 14. CLI Session Lifecycle

1. **New conversation** created → first session initialized with a UUID
2. **First message** sent → `isNewSession=true`, CLI invoked with `--session-id <uuid>`
3. **Subsequent messages** → `isNewSession=false`, CLI invoked with `--resume <uuid>`
4. **Session reset** → current session marked ended, new session created with fresh UUID
5. **Next message after reset** → `isNewSession=true` (messageCount is 0), new `--session-id` used

The `isNewSession` flag is determined by checking if the current session's `messageCount === 0`.

---

## 15. Markdown Export Format

### Entire Conversation

```markdown
# {title}

**Created:** {createdAt}
**Backend:** {backend}

---

### User — {localeString}
*Backend: {backend}*

{content}

### Assistant — {localeString}
*Backend: {backend}*

{content}

---
*Session reset — {localeString}*
---

### User — {localeString}
...
```

### Single Session

```markdown
# {title}

**Session {number}** | Started: {startedAt}
**Conversation ID:** {id}

---

### User — {localeString}
*Backend: {backend}*

{content}

---

### Assistant — {localeString}
*Backend: {backend}*

{content}

---
```

---

## 16. Testing

### Framework: Jest 30.x

### Test Files (95 tests total)

**`test/chatService.test.js`** (38 tests):
- Creates conversations with title, working directory
- Lists conversations sorted by updatedAt
- Gets, renames, deletes conversations
- Cleans up artifacts directory on conversation deletion
- Handles missing conversation (returns null)
- Adds messages, verifies auto-titling from first user message
- Stores `thinking` field when provided on assistant messages
- Persists `thinking` field to disk (verified via fresh ChatService instance)
- Omits `thinking` field when not provided, null, or empty string
- Updates message content (fork behavior: truncates subsequent messages)
- Resets sessions: archives, creates divider, starts new session
- Gets session history with isCurrent flag
- Exports session and conversation to Markdown
- Searches conversations by title, last message, and full content
- Gets and saves settings with defaults
- Uses temporary directories (`os.tmpdir()`) for isolation

**`test/cliBackend.test.js`** (37 tests):
- **extractToolDetails** (29 tests): Tests all 13 tool types — Read (with/without path), Write (with/without path, plan file detection), Edit (with/without path), Bash (with description/command/nothing, long command truncation at 60 chars), Grep (with pattern+glob, pattern only, nothing), Glob (with/without pattern), Agent (with/without inputs, subagentType default), TodoWrite, WebSearch (with/without query), WebFetch (with/without URL), EnterPlanMode, ExitPlanMode, AskUserQuestion (with/without questions). Tests edge cases: unknown tool, block id preservation, missing input graceful handling, shortenPath behavior (short paths unchanged, long paths shortened to last 2 segments).
- **CLIBackend** (4 tests): Constructor defaults to `~/.openclaw/workspace`, `sendMessage` returns `{ stream, abort, sendInput }`, abort yields error and done events, `sendInput` does not throw after abort.

**`test/chat.test.js`** (14 tests):
- Uses mock CLI backend with configurable events and Express test server
- **POST /input**: returns `ok:false` when no active stream, forwards text to `sendInput`, handles empty text, requires CSRF token
- **SSE tool_activity forwarding**: enriched fields (tool, description, id), `isAgent` flag with `subagentType`, `isPlanMode`/`planAction`, `isQuestion` with `questions` array
- **Turn boundary intermediate messages**: saves intermediate message on turn_boundary, saves thinking with intermediate message, skips empty boundaries, skips non-streaming text, saves result text as final message when no streaming deltas
- **POST /abort**: returns `ok:false` when no active stream

**`test/graceful-shutdown.test.js`** (2 tests):
- Spawns actual server process with dummy env vars
- Sends SIGINT → verifies clean exit (code 0) with shutdown log
- Sends SIGTERM → verifies clean exit (code 0) with shutdown log
- Uses real process spawn, not mocks

**`test/sessionStore.test.js`** (4 tests):
- Session persists to disk as JSON files
- Session retrieves correctly after write
- Session survives store recreation (simulates server restart)
- Session destroy removes the file

### Running Tests

```bash
npm test
```

### CI

Runs on every PR against `main` via GitHub Actions. Tests must pass to merge (branch protection).

---

## 17. CI/CD

### File: `.github/workflows/test.yml`

**Trigger:** Pull requests targeting `main` branch

**Job:** `test` on `ubuntu-latest`

**Steps:**
1. Checkout code
2. Setup Node.js 18 with npm cache
3. `npm ci`
4. `npm test`

---

## 18. Package Scripts

```json
{
  "start": "node server.js",
  "test": "jest"
}
```

---

## 19. Production Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `dotenv` | ^16.4.7 | Load `.env` into `process.env` |
| `express` | ^4.21.2 | Web framework |
| `express-rate-limit` | ^8.3.1 | Rate limiting on auth endpoints |
| `express-session` | ^1.18.1 | Session management |
| `helmet` | ^8.0.0 | Security headers (CSP, etc.) |
| `multer` | ^1.4.5-lts.1 | Multipart file upload |
| `on-headers` | ^1.0.2 | Response header hook (dependency) |
| `passport` | ^0.7.0 | Authentication framework |
| `passport-github2` | ^0.1.12 | GitHub OAuth strategy |
| `passport-google-oauth20` | ^2.0.0 | Google OAuth strategy |
| `session-file-store` | ^1.5.0 | File-based session persistence |

### Dev Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `jest` | ^30.3.0 | Testing framework |

### External CDN Libraries (Frontend)

| Library | Version | URL |
|---------|---------|-----|
| highlight.js | 11.9.0 | `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/` |
| marked | 12.0.2 | `https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js` |

---

## 20. Error Handling Patterns

### API Responses

- **Success**: returns JSON object (varies by endpoint)
- **Client error**: `400` with `{ error: "message" }` (bad input)
- **Auth error**: redirect to `/auth/login` (unauthenticated) or `403` (CSRF, denied)
- **Not found**: `404` with `{ error: "Conversation not found" }` etc.
- **Conflict**: `409` with `{ error: "Cannot reset session while streaming" }`
- **Server error**: `500` with `{ error: err.message }`

### Frontend

- `chatFetch` throws on non-OK responses, extracts error from JSON body
- Callers use try/catch, display errors via alert or inline messages

---

## 21. Known Limitations and Future Work

Items from the project's improvement list that remain unimplemented:

1. **Input validation & sanitization** — no validation library, directory browser has no path constraint, file upload names minimally sanitized, no request body type/length validation
2. **Linting & formatting** — no ESLint or Prettier configuration
3. **Conversation pagination** — `listConversations()` loads all conversation files into memory
4. **File upload MIME validation** — Multer accepts any file type
5. **Structured logging** — uses `console.log`/`console.error` throughout
6. **Multi-user support** — settings are global (single `settings.json`), not per-user

---

## 22. Deployment Notes

### Local Development
```bash
cp .env.example .env   # Fill in values
npm install
npm start              # Listens on PORT (default 3334)
```

### Remote Access via ngrok
```bash
ngrok http 3334
```
Update Google/GitHub OAuth **Authorized JavaScript origins** and **Authorized redirect URIs** to include the ngrok URL.

### Process Manager (PM2)
```bash
pm2 start server.js --name agent-cockpit
pm2 restart agent-cockpit   # After code changes
```

### Recommended Claude Code CLI Settings

Add to `~/.claude/settings.json` on the host machine:
```json
{
  "attribution": {
    "gitCommit": "",
    "pullRequest": ""
  },
  "permissions": {
    "allow": [
      "Edit(**)"
    ]
  }
}
```

- `attribution.gitCommit: ""` — removes Co-Authored-By trailer from commits
- `attribution.pullRequest: ""` — removes Claude attribution from PR descriptions
- `permissions.allow: ["Edit(**)"]` — allows Claude Code to edit files without interactive prompts (important since Agent Cockpit has no interactive terminal)
