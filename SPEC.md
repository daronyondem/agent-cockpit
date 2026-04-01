# Agent Cockpit — Specification

**Table of Contents:** [1. Overview](#1-overview) | [2. Data Models & File Structure](#2-data-models--file-structure) | [3. API Endpoints](#3-api-endpoints) | [4. Backend Services](#4-backend-services) | [5. Server Initialization & Security](#5-server-initialization--security) | [6. Frontend Behavior](#6-frontend-behavior) | [7. Export, Limitations & Deployment](#7-export-limitations--deployment) | [8. Testing & CI/CD](#8-testing--cicd)

---

## 1. Overview

**Agent Cockpit** is a web-based chat interface for interacting with the Claude Code CLI. It runs on the same machine as the CLI tools. The server spawns local `claude` CLI processes, streams responses back to the browser via Server-Sent Events (SSE), and stores conversations in workspace-scoped JSON files on disk.

### Core Use Case

Install on a machine with Claude Code CLI. Expose via a tunnel (e.g., ngrok). Access from any device and interact with your local CLI remotely through the browser.

### Key Principles

- CLI and web interface **must** run on the same machine — spawns local CLI processes, not remote API calls.
- OAuth protects access. Only whitelisted email addresses can log in.
- Local requests (localhost/127.0.0.1/::1) bypass authentication for development convenience.

---

## 2. Data Models & File Structure

### File Structure

```
agent-cockpit/
├── server.js                           # Express server entry point
├── SPEC.md                             # This file
├── src/
│   ├── config/index.js                 # Loads env vars with defaults
│   ├── middleware/
│   │   ├── auth.js                     # Passport strategies, login page, routes
│   │   ├── csrf.js                     # CSRF token generation and validation
│   │   └── security.js                 # Helmet CSP configuration
│   ├── routes/
│   │   └── chat.js                     # All chat API routes
│   └── services/
│       ├── backends/
│       │   ├── base.js                 # BaseBackendAdapter interface
│       │   ├── claudeCode.js           # Claude Code adapter — CLI spawning, stream parsing
│       │   └── registry.js             # BackendRegistry — maps IDs to adapter instances
│       ├── chatService.js              # Conversation CRUD, messages, sessions, settings
│       └── updateService.js            # Self-update: version checking, git pull, PM2 restart
├── public/
│   ├── index.html                      # HTML shell
│   ├── app.js                          # All frontend JavaScript
│   └── styles.css                      # All CSS with light/dark theme
├── test/                               # Jest test suite
└── data/                               # Runtime data (gitignored, created at startup)
    ├── chat/
    │   ├── workspaces/{hash}/          # Workspace-based storage (see below)
    │   │   ├── index.json              # Source of truth: conversations + session metadata
    │   │   └── {convId}/
    │   │       ├── session-1.json      # Archived session
    │   │       └── session-N.json      # Active session (updated every message)
    │   ├── artifacts/{convId}/         # Per-conversation uploaded files
    │   └── settings.json               # User settings
    └── sessions/                       # Express session JSON files (24h TTL)
```

### Workspace Hash

All workspace hashes throughout the system use: `SHA-256(workspacePath).substring(0, 16)` — a deterministic mapping from absolute workspace path to storage folder name.

### Workspace Index (`workspaces/{hash}/index.json`)

```javascript
{
  workspacePath: string,        // Absolute path to the workspace directory
  instructions: string,         // Per-workspace instructions (appended to system prompt on new sessions)
  conversations: [{
    id: string,                 // UUIDv4
    title: string,              // Auto-set from first user message (max 80 chars)
    backend: string,            // 'claude-code'
    currentSessionId: string,   // UUID of the active CLI session
    lastActivity: string,       // ISO 8601, updated on every message
    lastMessage: string|null,   // First 100 chars of last message content
    sessions: [{
      number: number,           // 1-based session number
      sessionId: string,        // UUID passed to CLI
      summary: string|null,     // LLM-generated summary (null for active session)
      active: boolean,          // true for current session, false for archived
      messageCount: number,
      startedAt: string,        // ISO 8601
      endedAt: string|null      // ISO 8601 (null for active session)
    }]
  }]
}
```

### Session File (`workspaces/{hash}/{convId}/session-N.json`)

```javascript
{
  sessionNumber: number,
  sessionId: string,
  startedAt: string,
  endedAt: string|null,
  messages: Message[]
}
```

### Message

```javascript
{
  id: string,                   // UUIDv4
  role: string,                 // 'user' | 'assistant' | 'system'
  content: string,              // Message text
  backend: string,              // Backend that generated the response
  timestamp: string,            // ISO 8601
  thinking?: string             // Extended thinking (assistant only, omitted if empty)
}
```

### API Response: getConversation

Flat object assembled from workspace index + active session file:

```javascript
{
  id: string,
  title: string,
  backend: string,
  workingDir: string,           // The workspace path
  currentSessionId: string,
  sessionNumber: number,        // Active session number
  messages: Message[]           // Active session messages
}
```

### Settings (`data/chat/settings.json`)

```json
{
  "theme": "system",
  "sendBehavior": "enter",
  "systemPrompt": "",
  "defaultBackend": "claude-code",
  "workingDirectory": ""
}
```

The `systemPrompt` is passed to the CLI via `--append-system-prompt` at the start of each new session. It is additive — Claude Code's built-in system prompt is preserved. Legacy `customInstructions` objects are auto-migrated to `systemPrompt` on first read.

---

## 3. API Endpoints

All chat endpoints are mounted under `/api/chat`. All require authentication via `requireAuth`. State-changing operations (POST, PUT, DELETE) additionally require `csrfGuard`.

### 3.1 Directory Browsing

```
GET /browse?path=<dir_path>&showHidden=true|false
```
- `path` defaults to `os.homedir()` if omitted
- Returns `{ currentPath, parent, dirs[] }`. `403` if permission denied.

```
POST /mkdir  [CSRF]
Body: { parentPath: string, name: string }
```
Creates subdirectory. Validates no `/`, `\`, `..` in name. Returns `{ created: "/path" }`. `400`/`403`/`409` on error.

```
POST /rmdir  [CSRF]
Body: { dirPath: string }
```
Recursively deletes directory. Refuses filesystem root. Returns `{ deleted, parent }`. `400`/`403`/`404` on error.

### 3.2 Conversations

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/conversations?q=<search>` | — | List all, sorted by `updatedAt` desc. Each summary includes `workspaceHash`. |
| GET | `/conversations/:id` | — | Full conversation object. `404` if not found. |
| POST | `/conversations` | Yes | `{ title?, workingDir? }` → creates conversation with initial session. |
| PUT | `/conversations/:id` | Yes | `{ title }` → rename. `404` if not found. |
| DELETE | `/conversations/:id` | Yes | Aborts active stream, removes from workspace index, deletes session folder + artifacts. |

### 3.3 Download

| Method | Path | Description |
|--------|------|-------------|
| GET | `/conversations/:id/download` | Full conversation as `.md` attachment. |
| GET | `/conversations/:id/sessions/:num/download` | Single session as `.md` attachment. |

### 3.4 Sessions

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/conversations/:id/sessions` | — | Session list with `isCurrent` flag and `summary`. |
| GET | `/conversations/:id/sessions/:num/messages` | — | Messages for a specific session. `400`/`404` on error. |
| POST | `/conversations/:id/reset` | Yes | Archives active session (generates LLM summary), creates new session. `409` if streaming. Returns `{ conversation, newSessionNumber, archivedSession }`. |

### 3.5 Backends

```
GET /backends
```
Returns `{ backends: [{ id, label, icon, capabilities }] }` — metadata for every registered adapter.

### 3.6 Messaging and Streaming

**Send message:**
```
POST /conversations/:id/message  [CSRF]
Body: { content: string, backend?: string }
```
- Saves user message, updates backend if changed
- Determines if new CLI session (`messageCount === 0`) or resume
- New sessions: prepends workspace context injection (not stored in messages)
- Spawns CLI process, stores in `activeStreams` map
- Returns `{ userMessage: Message, streamReady: true }`

**Stream response (SSE):**
```
GET /conversations/:id/stream
```
- SSE headers, no socket timeout, keepalive every 5s
- On client disconnect: aborts CLI process, removes from activeStreams
- `404` if no active stream

**SSE event format:**
```
data: {"type":"<type>", ...fields}\n\n
```

**SSE event types:**

| Type | Fields | Description |
|------|--------|-------------|
| `text` | `content`, `streaming` | Text delta from assistant |
| `thinking` | `content`, `streaming` | Extended thinking delta |
| `tool_activity` | `tool`, `description`, `id`, + enriched fields | Tool use notification (see enriched fields below) |
| `turn_boundary` | — | Marks boundary between assistant turns (internal — not forwarded to client) |
| `turn_complete` | — | Notifies client that tools finished and a new turn is starting |
| `result` | `content` | Final result text from CLI |
| `assistant_message` | `message` | Saved assistant message (intermediate or final) |
| `error` | `error` | Error message string |
| `done` | — | Stream complete |

**Enriched `tool_activity` fields** (set by `extractToolDetails()` — see Section 4 for per-tool mapping):

| Field | When set | Description |
|-------|----------|-------------|
| `isAgent` | Agent tool | Sub-agent invocation |
| `subagentType` | Agent tool | `'Explore'`, `'general-purpose'`, etc. |
| `isPlanMode` | EnterPlanMode, ExitPlanMode | Plan mode state change |
| `planAction` | EnterPlanMode, ExitPlanMode | `'enter'` or `'exit'` |
| `isQuestion` | AskUserQuestion | Interactive question for user |
| `questions` | AskUserQuestion | Array of question objects with options |
| `isPlanFile` | Write tool | `true` when writing to `.claude/plans/` |

**Turn boundary behavior:** On `turn_boundary`, accumulated streaming content (text + thinking) is saved as an intermediate assistant message, and a `turn_complete` event is always sent to the client (even when there is no text to save). This allows the frontend to clear stale tool activity spinners when tools finish executing. On stream completion, final content is saved and `assistant_message` + `done` events are sent.

**Abort streaming:**
```
POST /conversations/:id/abort  [CSRF]
```
Kills CLI process (SIGTERM). Returns `{ ok: true }` or `{ ok: false, message: 'No active stream' }`.

**Send interactive input:**
```
POST /conversations/:id/input  [CSRF]
Body: { text: string }
```
Writes to CLI stdin for plan approval / user questions. Returns `{ ok: true }` or `{ ok: false }`.

**Active streams management:** The router maintains an in-memory `Map<conversationId, { stream, abort, sendInput, backend }>`. Only one active CLI process per conversation. Streaming blocks session reset (`409`) and self-update.

**CLI session lifecycle:**
1. New conversation → session initialized with UUID
2. First message → `--session-id <uuid>` (new session)
3. Subsequent messages → `--resume <uuid>`
4. Session reset → new session with fresh UUID
5. `isNewSession` determined by `messageCount === 0`

### 3.7 File Upload

```
POST /conversations/:id/upload  [CSRF]
Content-Type: multipart/form-data
Field: files[] (max 10 files, 50MB each)
```
Destination: `data/chat/artifacts/{conversationId}/`. Returns `{ files: [{ name, path, size }] }`.

```
DELETE /conversations/:id/upload/:filename  [CSRF]
```
Path traversal guard. Returns `{ ok: true }`. `404`/`400` on error.

```
GET /conversations/:id/files/:filename
```
Serves file via `res.sendFile()`. Path traversal guard. No CSRF (used by `<img>` tags).

### 3.8 Settings

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/settings` | — | Returns settings (defaults if file missing). |
| PUT | `/settings` | Yes | Writes full body to `settings.json`. |

### 3.9 Workspace Instructions

Per-workspace instructions appended to the global system prompt on new sessions. Stored in workspace `index.json` under `instructions`.

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/workspaces/:hash/instructions` | — | Returns `{ instructions: string }`. `404` if workspace not found. |
| PUT | `/workspaces/:hash/instructions` | Yes | `{ instructions: string }`. `400` if not string. `404` if workspace not found. |

**System prompt composition on new sessions:**
1. Global system prompt (from `settings.json`)
2. Workspace instructions (from workspace `index.json`)

Concatenated with `\n\n` and passed as `--append-system-prompt`. Not sent on session resume.

### 3.10 Version & Self-Update

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/version` | — | `{ version, remoteVersion, updateAvailable }` |
| GET | `/update-status` | — | Cached status: `{ localVersion, remoteVersion, updateAvailable, lastCheckAt, lastError, updateInProgress }` |
| POST | `/check-version` | Yes | Triggers immediate remote check, returns status. |
| POST | `/update-trigger` | Yes | Full update sequence (see Section 4, UpdateService). |

### 3.11 Error Response Patterns

| Status | Meaning | Body |
|--------|---------|------|
| `400` | Bad input | `{ error: "message" }` |
| `403` | CSRF failure or access denied | `{ error: "Invalid CSRF token" }` |
| `404` | Not found | `{ error: "Conversation not found" }` etc. |
| `409` | Conflict | `{ error: "Cannot reset session while streaming" }` |
| `500` | Server error | `{ error: err.message }` |

Unauthenticated requests redirect to `/auth/login`.

---

## 4. Backend Services

### 4.1 ChatService

**File:** `src/services/chatService.js`

**Constructor:** `new ChatService(appRoot, options)` — sets `baseDir` to `<appRoot>/data/chat`, creates `workspaces/` and `artifacts/` dirs synchronously at startup, initializes in-memory `Map<convId, workspaceHash>` for fast lookup.

#### Methods

| Method | Description |
|--------|-------------|
| `initialize()` | Runs migration if legacy `conversations/` dir exists, builds convId→workspace lookup map. |
| `createConversation(title, workingDir)` | Creates entry in workspace index + empty session-1.json. Falls back to `_defaultWorkspace`. |
| `getConversation(id)` | Returns API-compatible object with messages, or `null`. |
| `listConversations()` | Scans all workspace indexes. Returns summaries sorted by `lastActivity` desc, each with `workspaceHash`. |
| `renameConversation(id, newTitle)` | Updates title in workspace index. Returns full conversation or `null`. |
| `deleteConversation(id)` | Removes from index, deletes session folder + artifacts, removes from lookup map. |
| `updateConversationBackend(convId, backend)` | Updates backend field in workspace index. |
| `addMessage(convId, role, content, backend, thinking)` | Appends to active session + updates index metadata. Auto-titles on first user message. `thinking` omitted if falsy. |
| `updateMessageContent(convId, messageId, newContent)` | Truncates after target message, adds edited content as new message. |
| `resetSession(convId)` | Archives active session (summary, endedAt), creates new session. Returns `{ conversation, newSessionNumber, archivedSession }`. |
| `getSessionHistory(convId)` | Returns sessions array with `isCurrent` flag and `summary`. |
| `getSessionMessages(convId, sessionNumber)` | Reads session file directly. Returns messages or `null`. |
| `sessionToMarkdown(convId, sessionNumber)` | Exports single session as markdown. |
| `conversationToMarkdown(convId)` | Exports all sessions as single markdown document. |
| `getWorkspaceInstructions(hash)` | Returns instructions string, empty string if unset, `null` if workspace not found. |
| `setWorkspaceInstructions(hash, instructions)` | Saves to workspace index. Returns string or `null`. |
| `getWorkspaceHashForConv(convId)` | Returns workspace hash or `null`. |
| `getWorkspaceContext(convId)` | **Synchronous.** Returns injection prompt string or `null`. |
| `searchConversations(query)` | Case-insensitive: checks title/lastMessage first, then deep-searches session files. |
| `getSettings()` | Returns settings from disk or defaults. |
| `saveSettings(settings)` | Writes settings to disk. |

All methods are `async` except `getWorkspaceContext()`.

#### Workspace Context Injection

When a new CLI session starts, the router prepends (not stored in messages):

```
[Workspace discussion history is available at {abs_workspace_path}/
Read index.json for all past and current conversations in this workspace with per-session summaries.
Each conversation subfolder contains session-N.json files with full message histories.
When the user references previous work, decisions, or discussions, consult the relevant session files for context.]
```

#### Migration

On first startup after upgrade, `initialize()` detects legacy `conversations/` directory:
1. Reads all conversation JSON files, groups by workspace
2. Writes workspace index + session files to `workspaces/{hash}/`
3. Renames old dirs to `*_backup/`

### 4.2 Backend Adapter System

The CLI backend layer uses a **pluggable adapter pattern**. New CLI tools can be added without modifying routes, chat service, or frontend.

#### BaseBackendAdapter (`src/services/backends/base.js`)

Abstract base class. Every backend must implement:
- **`get metadata`** — returns `{ id, label, icon, capabilities }` where capabilities: `{ thinking, planMode, agents, toolActivity, userQuestions, stdinInput }` (all booleans)
- **`sendMessage(message, options)`** — returns `{ stream, abort, sendInput }` where `stream` is an async generator yielding events matching the SSE event contract in Section 3
- **`generateSummary(messages, fallback)`** — returns a one-line summary string

#### BackendRegistry (`src/services/backends/registry.js`)

- `register(adapter)` — stores by `metadata.id`. First registered becomes default. Validates `instanceof BaseBackendAdapter`.
- `get(id)` — returns adapter or `null`
- `list()` — returns metadata array
- `getDefault()` — returns first registered or `null`

#### ClaudeCodeAdapter (`src/services/backends/claudeCode.js`)

**Metadata:** `id: 'claude-code'`, all capabilities enabled.

**`sendMessage(message, options)`:**
- `options`: `{ sessionId, isNewSession, workingDir, systemPrompt }`
- Returns `{ stream, abort, sendInput }`
- `abort()` sends SIGTERM to CLI process
- `sendInput(text)` writes to stdin (safe after abort)
- Per-request state: each call creates its own `state` object (no shared mutable state)

**CLI invocation:**
```bash
claude --print \
  --permission-mode bypassPermissions \
  --output-format stream-json \
  --verbose \
  [--session-id <uuid>]              # if isNewSession
  [--append-system-prompt <prompt>]  # if isNewSession and systemPrompt
  [--resume <uuid>]                  # if not isNewSession
  -p "<user message>"
```

**`extractToolDetails(block)`** — parses `tool_use` content blocks into enriched detail objects:

| Tool | Description format | Extra fields |
|------|-------------------|--------------|
| `Read` | `Reading \`{path}\`` or `Reading file` | — |
| `Write` | `Writing \`{path}\`` | `isPlanFile` if path contains `.claude/plans/` |
| `Edit` | `Editing \`{path}\`` or `Editing file` | — |
| `Bash` | `input.description`, or `Running: \`{cmd}\`` (truncated 60 chars), or `Running command` | — |
| `Grep` | `Searching for \`{pattern}\` in {glob}` or `Searching files` | — |
| `Glob` | `Finding files matching \`{pattern}\`` or `Finding files` | — |
| `Agent` | Uses `input.description` | `isAgent: true`, `subagentType` (default `'general-purpose'`) |
| `TodoWrite` | `Updating task list` | — |
| `WebSearch` | `Searching: \`{query}\`` or `Searching the web` | — |
| `WebFetch` | `Fetching: {url}` or `Fetching web content` | — |
| `EnterPlanMode` | `Entering plan mode` | `isPlanMode: true`, `planAction: 'enter'` |
| `ExitPlanMode` | `Plan ready for approval` | `isPlanMode: true`, `planAction: 'exit'` |
| `AskUserQuestion` | `Asking a question` | `isQuestion: true`, `questions` array |
| (unknown) | `Using {name}` | — |

All detail objects include `tool`, `id` (block id or null), and `description`. Long file paths are shortened to `.../{last}/{two}.js` when >3 segments.

**`generateSummary(messages, fallback)`** — spawns `claude --print -p <prompt>` with 30s timeout. Falls back gracefully.

#### Adding a New Backend

1. Create `src/services/backends/myBackend.js` extending `BaseBackendAdapter`
2. Implement `metadata`, `sendMessage()`, `generateSummary()`
3. Register in `server.js` — no other changes needed

### 4.3 UpdateService

**File:** `src/services/updateService.js`

- `start()` — runs `_checkRemoteVersion()` immediately, then polls every 15 minutes (unref'd interval)
- `stop()` — clears polling interval
- `getStatus()` — returns cached `{ localVersion, remoteVersion, updateAvailable, lastCheckAt, lastError, updateInProgress }`
- `checkNow()` — immediate version check, returns status
- `triggerUpdate({ hasActiveStreams })` — full update sequence with guards:
  1. Concurrent guard (`_updateInProgress` flag)
  2. Active streams guard (refuses if CLI streams active)
  3. Dirty tree guard (`git status --porcelain`, ignoring `data/`, `.env`, `ecosystem.config.js`, `.DS_Store`, `.claude/`)
  4. `git checkout main` (30s timeout)
  5. `git pull origin main` (60s timeout)
  6. `npm install --production` (120s timeout)
  7. `pm2 restart ecosystem.config.js` (30s timeout)

Returns `{ success, steps: [{ name, success, output }] }`. On failure, includes `error` field.

- `_checkRemoteVersion()` — `git fetch origin main` + `git show origin/main:package.json`
- `_isNewer(remote, local)` — three-part numeric semver comparison

---

## 5. Server Initialization & Security

### 5.1 Configuration

**File:** `src/config/index.js`

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
| `BASE_PATH` | No | `''` | URL base path prefix (for reverse proxy deployments) |

### 5.2 Server Initialization Order

**File:** `server.js`

1. Create Express app, set `trust proxy: 1`
2. Apply Helmet security headers via `applySecurity(app)`
3. Configure express-session with FileStore (`data/sessions/`, 24h TTL, `retries: 0`)
4. Passport 0.7 polyfill — adds `session.regenerate`/`session.save` stubs if missing
5. Setup Passport with `setupAuth(app, config)`
6. Apply `requireAuth` middleware globally
7. Apply `ensureCsrfToken` middleware globally
8. Parse JSON bodies with `express.json()`
9. Mount CSRF token endpoint at `GET /api/csrf-token`
10. Create BackendRegistry, register ClaudeCodeAdapter
11. Initialize ChatService
12. Initialize UpdateService
13. Mount chat router at `/api/chat`
14. Serve static files from `public/`
15. Call `chatService.initialize()` (migration + lookup map)
16. Start UpdateService (version polling)
17. Listen on configured PORT

### Graceful Shutdown

Signal handlers for `SIGTERM`/`SIGINT`:
1. Call `chatShutdown()` — aborts all active CLI streams
2. Call `server.close()` — stop accepting connections
3. 10-second forced exit timeout (`.unref()` as safety net)

### 5.3 Authentication

**File:** `src/middleware/auth.js`

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

**`requireAuth` middleware:** Localhost passes through without auth. Otherwise requires `req.isAuthenticated()` or redirects to `/auth/login`.

### 5.4 CSRF Protection

**File:** `src/middleware/csrf.js`

- `ensureCsrfToken` (global middleware): generates 32-byte hex token if missing from session
- `csrfGuard` (route-level, POST/PUT/DELETE): validates `x-csrf-token` header or `req.body._csrf` against session token. Returns `403` on mismatch.
- `GET /api/csrf-token`: returns `{ csrfToken }` from session

### 5.5 Security Headers

**File:** `src/middleware/security.js`

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

---

## 6. Frontend Behavior

**Files:** `public/index.html`, `public/app.js`, `public/styles.css`

Vanilla JavaScript SPA — no framework, no bundler, no build step. Uses marked (CDN) for Markdown and highlight.js (CDN) for syntax highlighting.

### Layout

- Flexbox: sidebar (fixed 280px) + main area (flex: 1)
- Sidebar: new chat button, search, conversation list grouped by workspace, settings, sign out, version label
- Main area: header with title + action buttons, messages container, input area with backend selector + file chips + textarea
- Responsive: below ~768px sidebar overlays content

### Conversation Management

- **New conversation:** folder picker modal (via `/browse` API) → user selects directory → POST creates conversation
- **Sidebar list:** grouped by workspace (last 2 path segments of `workingDir`), sorted by `updatedAt` desc. Groups are collapsible (state in localStorage). Each group header has a pencil icon for workspace instructions.
- **Context menu:** right-click on conversation items for rename/delete
- **Search:** debounced, case-insensitive search across titles, last messages, and full content

### Messaging & Streaming

- `chatSendMessage()` gathers completed file paths from pending uploads, appends `[Uploaded files: ...]` to content, POSTs message, opens SSE stream
- Streaming uses `fetch` with manual ReadableStream parsing (not EventSource API)
- **Streaming state persistence:** `chatStreamingState` Map stores per-conversation state (accumulated text, thinking, tools, agents, pending interactions). State survives conversation switches — on return, the streaming bubble is recreated and restored.
- **Elapsed timer:** live timer in streaming bubble header, self-cleans on DOM disconnect
- **Turn boundaries:** intermediate assistant messages saved, content reset. `turn_complete` event clears active tool/agent spinners so the UI reflects that tools have finished.
- **Thinking events:** clear stale tool/agent activity state, ensuring spinners don't persist while the model thinks after tool execution.
- **Plan approval:** renders plan as markdown with approve/reject buttons → POSTs to `/input`
- **User questions:** renders question text + option buttons → POSTs answer to `/input`
- **Stream cleanup:** `chatCleanupStreamState()` accepts `{ force }` option. The `finally` block uses `force: true` to ensure cleanup even when a pending interaction was never resolved. Interaction response handlers also use forced cleanup when the stream has already ended.
- **Send button state:** shows stop (■) when streaming, send (↑) when idle. Disabled during uploads or session resets.

### File Handling

- Files upload **immediately on attach** (not at send time) via XHR with per-file progress tracking
- Sources: drag-and-drop, clipboard paste (images + large text ≥1000 chars), file picker button
- `chatEnsureConversation()` auto-creates conversation on first file attach (promise-cached for concurrent calls)
- File chips show progress bar, checkmark on completion, error indicator on failure
- Remove button: aborts in-progress upload or DELETEs completed file
- At send time: completed file paths embedded as `[Uploaded files: /path/to/file1, ...]`
- **Inline images:** `chatRenderUploadedFiles()` replaces `[Uploaded files: ...]` with `<img>` tags for image extensions (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`). Click opens lightbox overlay.

### Draft Persistence

- `chatSaveDraft()` / `chatRestoreDraft()` — per-conversation drafts stored in `chatDraftState` Map keyed by convId (or `'__new__'` for unsaved conversations)
- Drafts include textarea text + pending files
- Saved on conversation switch/blur, restored on switch/select
- `'__new__'` key migrated to real convId on conversation creation
- Cleared on message send

### Session Management

- **Reset:** archives active session with LLM summary, creates new session. Shows "Archiving session..." indicator. Blocked during streaming. Double-click prevented via `chatResettingConvs` set.
- **History modal:** lists sessions with summaries, view and download buttons
- **View session:** fetches archived messages from API

### Settings Modal

- Theme: System / Light / Dark
- Send behavior: Enter or Shift+Enter
- System prompt textarea (global)
- Default backend selector
- Working directory

### Workspace Instructions Modal

- Per-workspace instructions textarea, triggered by pencil icon on workspace group headers
- Fetches/saves via workspace instructions API

### Theme System

CSS custom properties on `:root` (light) and `[data-theme="dark"]`. Theme applied by setting `data-theme` on `<html>`. Persisted to `localStorage` under `agent-cockpit-theme`. Synced from server settings on init. Listens for system theme changes when set to "system".

### Keyboard Shortcuts

- **Enter** — send message (when send behavior is "enter")
- **Shift+Enter** — newline (or send, depending on setting)
- **Ctrl+Shift+D** — download conversation
- **Ctrl+Shift+R** — reset session

---

## 7. Export, Limitations & Deployment

### Markdown Export Format

**Entire conversation:**
```markdown
# {title}

**Created:** {createdAt}
**Backend:** {backend}

---

### User — {timestamp}
*Backend: {backend}*

{content}

### Assistant — {timestamp}
*Backend: {backend}*

{content}

---
*Session reset — {timestamp}*
---
```

**Single session:**
```markdown
# {title}

**Session {number}** | Started: {startedAt}
**Conversation ID:** {id}

---

### User — {timestamp}
*Backend: {backend}*

{content}
```

### Known Limitations

1. **Input validation** — no validation library, minimal file upload name sanitization, no request body type/length validation
2. **Linting & formatting** — no ESLint or Prettier
3. **Conversation pagination** — `listConversations()` loads all into memory
4. **File upload MIME validation** — Multer accepts any file type
5. **Structured logging** — uses `console.log`/`console.error`
6. **Multi-user support** — settings are global, not per-user

### Deployment

**Local development:**
```bash
cp .env.example .env   # Fill in values
npm install
npm start              # Listens on PORT (default 3334)
```

**Remote access via ngrok:**
```bash
ngrok http 3334
```
Update OAuth callback URLs to include the ngrok URL.

---

## 8. Testing & CI/CD

### Test Suite

**Framework:** Jest 30.x — run with `npm test`

| File | Focus |
|------|-------|
| `test/backends.test.js` | BaseBackendAdapter, BackendRegistry, ClaudeCodeAdapter, extractToolDetails |
| `test/chat.test.js` | Chat routes: /input, SSE forwarding, turn boundaries, turn_complete event forwarding, file upload/serve, workspace instructions |
| `test/chatService.test.js` | ChatService CRUD, messages, sessions, workspace storage, migration, markdown export |
| `test/draftState.test.js` | Draft save/restore, key migration, cleanup, round-trip |
| `test/graceful-shutdown.test.js` | Server shutdown on SIGINT/SIGTERM |
| `test/sessionStore.test.js` | Session file-store persistence |
| `test/updateService.test.js` | Version comparison, status, trigger guards, interval management |

### CI/CD

**Test workflow** (`.github/workflows/test.yml`): Runs on PRs to `main`. Steps: checkout, Node.js 18 setup, `npm ci`, `npm test`.

**Version bump** (`.github/workflows/version-bump.yml`): Runs on push to `main`. Skips `chore: bump version` commits. Steps: `npm version patch --no-git-tag-version`, commit, tag, push.
