# Agent Cockpit — Specification

**Table of Contents:** [1. Overview](#1-overview) | [2. Data Models & File Structure](#2-data-models--file-structure) | [3. API Endpoints](#3-api-endpoints) | [4. Backend Services](#4-backend-services) | [5. Server Initialization & Security](#5-server-initialization--security) | [6. Frontend Behavior](#6-frontend-behavior) | [7. Export, Limitations & Deployment](#7-export-limitations--deployment) | [8. Testing & CI/CD](#8-testing--cicd)

---

## 1. Overview

**Agent Cockpit** is a web-based chat interface for interacting with the Claude Code CLI. It runs on the same machine as the CLI tools. The server spawns local `claude` CLI processes, streams responses back to the browser via WebSocket, and stores conversations in workspace-scoped JSON files on disk.

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
├── server.ts                           # Express server entry point (TypeScript, run via tsx)
├── tsconfig.json                       # TypeScript configuration (strict mode, noEmit)
├── SPEC.md                             # This file
├── src/
│   ├── types/
│   │   └── index.ts                    # Shared type definitions (models, events, adapters)
│   ├── config/index.ts                 # Loads env vars with defaults
│   ├── middleware/
│   │   ├── auth.ts                     # Passport strategies, login page, routes
│   │   ├── csrf.ts                     # CSRF token generation and validation
│   │   └── security.ts                 # Helmet CSP configuration
│   ├── routes/
│   │   └── chat.ts                     # All chat API routes
│   └── services/
│       ├── backends/
│       │   ├── base.ts                 # BaseBackendAdapter interface
│       │   ├── claudeCode.ts           # Claude Code adapter — CLI spawning, stream parsing
│       │   └── registry.ts             # BackendRegistry — maps IDs to adapter instances
│       ├── chatService.ts              # Conversation CRUD, messages, sessions, settings
│       └── updateService.ts            # Self-update: version checking, git pull, PM2 restart
├── public/
│   ├── index.html                      # HTML shell
│   ├── app.js                          # All frontend JavaScript (remains JS — no build step)
│   └── styles.css                      # All CSS with light/dark theme
├── test/                               # Jest test suite (TypeScript via ts-jest)
└── data/                               # Runtime data (gitignored, created at startup)
    ├── chat/
    │   ├── workspaces/{hash}/          # Workspace-based storage (see below)
    │   │   ├── index.json              # Source of truth: conversations + session metadata
    │   │   └── {convId}/
    │   │       ├── session-1.json      # Archived session
    │   │       └── session-N.json      # Active session (updated every message)
    │   ├── artifacts/{convId}/         # Per-conversation uploaded files
    │   ├── settings.json               # User settings
    │   └── usage-ledger.json           # Daily per-backend token usage ledger
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
    usage: {                     // Cumulative token/cost tracking (null until first result)
      inputTokens: number,
      outputTokens: number,
      cacheReadTokens: number,
      cacheWriteTokens: number,
      costUsd: number
    }|null,
    usageByBackend: {            // Per-backend usage breakdown (keyed by backend id)
      [backendId]: Usage
    }|null,
    sessions: [{
      number: number,           // 1-based session number
      sessionId: string,        // UUID passed to CLI
      summary: string|null,     // LLM-generated summary (null for active session)
      active: boolean,          // true for current session, false for archived
      messageCount: number,
      startedAt: string,        // ISO 8601
      endedAt: string|null,     // ISO 8601 (null for active session)
      usage: Usage|null,        // Per-session token/cost totals (same shape as conversation usage)
      usageByBackend: { [backendId]: Usage }|null  // Per-backend usage for this session
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
  thinking?: string,            // Extended thinking (assistant only, omitted if empty)
  toolActivity?: [{             // Tool/agent activity log (assistant only, omitted if empty)
    tool: string,               // Tool name: 'Read', 'Write', 'Bash', 'Agent', etc.
    description: string,        // Human-readable description
    id: string|null,            // Block ID from CLI event
    isAgent?: boolean,          // true for Agent tool invocations
    subagentType?: string,      // 'Explore', 'general-purpose', etc. (when isAgent)
    duration: number|null,      // Estimated duration in milliseconds
    startTime: number,          // Unix timestamp ms when event was received
    outcome?: string,           // Short outcome summary (e.g. 'exit 0', '4 matches', 'not found')
    status?: string             // 'success' | 'error' | 'warning' (derived from tool result)
  }]
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
  messages: Message[],          // Active session messages
  usage: Usage,                 // Cumulative token/cost totals (zeroed if no usage yet)
  sessionUsage: Usage           // Active session token/cost totals (zeroed if no usage yet)
}
```

### Usage Ledger (`data/chat/usage-ledger.json`)

Daily per-backend/model token usage records for global statistics:

```javascript
{
  days: [{
    date: string,               // YYYY-MM-DD
    records: [{
      backend: string,          // Backend ID (e.g. 'claude-code')
      model: string,            // Model ID (e.g. 'claude-sonnet-4-20250514') or 'unknown'
      usage: Usage              // Accumulated usage for this backend+model on this day
    }]
  }]
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
| POST | `/conversations/:id/reset` | Yes | Archives active session (generates LLM summary), creates new session, resets title to "New Chat". `409` if streaming. Clears any stale WebSocket event buffer for the conversation. Returns `{ conversation, newSessionNumber, archivedSession }`. |

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

**Stream response (WebSocket — primary):**
```
ws(s)://host/api/chat/conversations/:id/ws
```
- Client opens WebSocket before POSTing the message
- Server authenticates on HTTP upgrade: session cookie parsed and verified against the file-based session store; local requests bypass auth
- Origin validation replaces CSRF for WebSocket connections
- Keepalive: server pings every 30s (under Cloudflare Tunnel's 100s idle timeout)
- **Reconnection with state recovery:** On client disconnect, the CLI process is NOT killed. Instead, a 60-second grace period starts. Events continue to be buffered server-side (ring buffer, max 1000 events). If the client reconnects within the grace period, the server replays all buffered events wrapped in `replay_start`/`replay_end` frames, then resumes live streaming. If the grace period expires without reconnection, the CLI is aborted and the buffer is discarded. If the CLI completes during the disconnect, events (including `done`) are buffered and replayed on reconnect; a cleanup timer (60s) eventually discards the buffer if no reconnect occurs.
- Client-to-server frames (JSON): `{ type: 'input', text }` (stdin), `{ type: 'abort' }` (kill process), `{ type: 'reconnect' }` (explicit replay request)
- Server-to-client frames (JSON): same event types listed below, plus `{ type: 'replay_start', bufferedEvents }` and `{ type: 'replay_end' }` for reconnection replay

**Stream event format (WebSocket):**
```
{"type":"<type>", ...fields}
```

**Stream event types:**

| Type | Fields | Description |
|------|--------|-------------|
| `text` | `content`, `streaming` | Text delta from assistant |
| `thinking` | `content`, `streaming` | Extended thinking delta |
| `tool_activity` | `tool`, `description`, `id`, + enriched fields | Tool use notification (see enriched fields below). Events are accumulated per-turn and persisted as `toolActivity` on the saved assistant message (excluding `isPlanMode` and `isQuestion` meta-events). |
| `tool_outcomes` | `outcomes` | Array of tool result outcomes extracted from CLI `user` events. Each outcome: `{ toolUseId, isError, outcome, status }`. Merged into `toolActivity` accumulator for persistence and forwarded to frontend for live display. |
| `turn_boundary` | — | Marks boundary between assistant turns (internal — not forwarded to client). Triggers persistence of accumulated `toolActivity` on the intermediate message. |
| `turn_complete` | — | Notifies client that tools finished and a new turn is starting |
| `result` | `content` | Final result text from CLI |
| `assistant_message` | `message` | Saved assistant message (intermediate or final) |
| `title_updated` | `title` | Conversation title was auto-updated (sent after first assistant message in a reset session) |
| `usage` | `usage`, `sessionUsage` | Cumulative token/cost totals for conversation (`usage`) and active session (`sessionUsage`), sent after each CLI result event |
| `error` | `error` | Error message string |
| `done` | — | Stream complete |
| `replay_start` | `bufferedEvents` | Reconnection: replay of buffered events is starting |
| `replay_end` | — | Reconnection: replay complete, live events resume |

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

**Auto title update:** When a new session starts after a reset (session number > 1) and the first assistant message is saved, the server asynchronously generates a new conversation title via `generateTitle()` on the backend adapter. A `title_updated` event is sent with the new title. The title update fires only once per session (on the first assistant message) and does not block the stream.

**Usage tracking:** Backend adapters can yield `{ type: 'usage', usage: {...}, model?: string }` events. The Claude Code adapter extracts usage data (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cost_usd`) from CLI `result` events and normalises the field names to camelCase. The model is captured from the CLI's `system/init` event (`model` field) and attached to usage events. The server accumulates usage on both the conversation and active session in the workspace index via `chatService.addUsage()`, tracks per-backend breakdowns in `usageByBackend`, and records daily per-backend/model totals to `usage-ledger.json`. The forwarded `usage` event contains both conversation-level `usage` and `sessionUsage` for the active session. The frontend displays session tokens and cost in the header badge, with conversation totals in the tooltip. A Usage Stats tab in Settings shows per-backend/model historical data with day/week/month/all-time filtering, including separate Backend and Model columns. Backends that do not emit usage events simply leave the counters at zero.

**Abort streaming:**
- WebSocket: client sends `{ type: 'abort' }` frame

**Send interactive input:**
- WebSocket: client sends `{ type: 'input', text: string }` frame

**Active streams management:** The router maintains an in-memory `Map<conversationId, { stream, abort, sendInput, backend }>`. Only one active CLI process per conversation. Streaming blocks session reset (`409`) and self-update. The WebSocket module (`src/ws.ts`) maintains a parallel `Map<conversationId, WebSocket>` for active connections and a `Map<conversationId, ConvBuffer>` for reconnection event buffers. The buffer is cleared before each new stream starts (via `clearBuffer()`). The `isStreamAlive()` function returns `true` if a WS is connected OR the grace period is active, ensuring `processStream` keeps running through brief disconnects.

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

### 3.9 Usage Statistics

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/usage-stats` | — | Returns the usage ledger (`{ days: [...] }`). |
| DELETE | `/usage-stats` | Yes | Clears all usage statistics (resets ledger to empty). |

### 3.10 Workspace Instructions

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

**File:** `src/services/chatService.ts`

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
| `addMessage(convId, role, content, backend, thinking, toolActivity)` | Appends to active session + updates index metadata. Auto-titles on first user message (session 1 only; post-reset sessions rely on LLM title generation). `thinking` omitted if falsy. `toolActivity` omitted if falsy or empty array. |
| `updateMessageContent(convId, messageId, newContent)` | Truncates after target message, adds edited content as new message. |
| `generateAndUpdateTitle(convId, userMessage)` | Generates a new title via the backend adapter's `generateTitle()` and persists it. Returns the new title or `null`. |
| `resetSession(convId)` | Archives active session (summary, endedAt), creates new session, resets title to "New Chat". Returns `{ conversation, newSessionNumber, archivedSession }`. |
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

#### BaseBackendAdapter (`src/services/backends/base.ts`)

Abstract base class. Every backend must implement:
- **`get metadata`** — returns `{ id, label, icon, capabilities }` where capabilities: `{ thinking, planMode, agents, toolActivity, userQuestions, stdinInput }` (all booleans)
- **`sendMessage(message, options)`** — returns `{ stream, abort, sendInput }` where `stream` is an async generator yielding events matching the stream event contract in Section 3
- **`generateSummary(messages, fallback)`** — returns a one-line summary string
- **`generateTitle(userMessage, fallback)`** — returns a short conversation title. Base class provides a default that truncates the user message to 80 chars.

#### BackendRegistry (`src/services/backends/registry.ts`)

- `register(adapter)` — stores by `metadata.id`. First registered becomes default. Validates `instanceof BaseBackendAdapter`.
- `get(id)` — returns adapter or `null`
- `list()` — returns metadata array
- `getDefault()` — returns first registered or `null`

#### ClaudeCodeAdapter (`src/services/backends/claudeCode.ts`)

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

All detail objects include `tool`, `id` (block id or null), and `description`. Long file paths are shortened to `.../{last}/{two}` when >3 segments.

**`extractUsage(event)`** — parses `result` events for usage data. Returns `{ type: 'usage', usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd } }` or `null` if no usage data is present. Field mapping: `input_tokens` → `inputTokens`, `output_tokens` → `outputTokens`, `cache_read_input_tokens` → `cacheReadTokens`, `cache_creation_input_tokens` → `cacheWriteTokens`, `cost_usd` → `costUsd`.

**`generateSummary(messages, fallback)`** — spawns `claude --print -p <prompt>` with 30s timeout. Falls back gracefully.

**`generateTitle(userMessage, fallback)`** — spawns `claude --print -p <prompt>` with 30s timeout to generate a short title (max 60 chars) from the user's first message. Falls back to truncated user message.

#### Adding a New Backend

1. Create `src/services/backends/myBackend.ts` extending `BaseBackendAdapter`
2. Implement `metadata`, `sendMessage()`, `generateSummary()`, and optionally `generateTitle()`
3. Register in `server.ts` — no other changes needed

### 4.3 UpdateService

**File:** `src/services/updateService.ts`

- `start()` — runs `_checkRemoteVersion()` immediately, then polls every 15 minutes (unref'd interval)
- `stop()` — clears polling interval
- `getStatus()` — returns cached `{ localVersion, remoteVersion, updateAvailable, lastCheckAt, lastError, updateInProgress }`
- `checkNow()` — immediate version check, returns status
- `triggerUpdate({ hasActiveStreams })` — full update sequence with guards:
  1. Concurrent guard (`_updateInProgress` flag)
  2. Active streams guard (refuses if CLI streams active)
  3. Dirty tree guard (`git status --porcelain`, ignoring `data/`, `.env`, `ecosystem.config.js`, `.DS_Store`, `.claude/`, `coverage/`, `plans/`)
  4. `git checkout main` (30s timeout)
  5. `git pull origin main` (60s timeout)
  6. `npm install` (120s timeout)
  7. Verify interpreter — reads `ecosystem.config.js` fresh from disk (via `fs.readFileSync`, not `require`, to avoid stale cache), checks the configured interpreter exists. Path-based interpreters (starting with `.` or `/`) are checked on disk; bare commands (e.g. `npx`, `node`) are resolved via `which` on PATH
  8. Write restart script to `data/restart.sh` (sets PATH, sleeps 2s, `pm2 delete` + `pm2 start`), launch via double-fork (`nohup ... &` in subshell) to survive PM2 treekill. Output logged to `data/update-restart.log`

Returns `{ success, steps: [{ name, success, output }] }`. On failure, includes `error` field.

- `_checkRemoteVersion()` — `git fetch origin main` + `git show origin/main:package.json`
- `_isNewer(remote, local)` — three-part numeric semver comparison

---

## 5. Server Initialization & Security

### 5.1 Configuration

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
| `BASE_PATH` | No | `''` | URL base path prefix (for reverse proxy deployments) |

### 5.2 Server Initialization Order

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
10. Create BackendRegistry, register ClaudeCodeAdapter
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
2. Call `wsShutdown()` — closes all WebSocket connections and the WS server
3. Call `server.close()` — stop accepting connections
4. 10-second forced exit timeout (`.unref()` as safety net)

### 5.3 Authentication

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

**`requireAuth` middleware:** Localhost passes through without auth. Otherwise requires `req.isAuthenticated()` or redirects to `/auth/login`.

### 5.4 CSRF Protection

**File:** `src/middleware/csrf.ts`

- `ensureCsrfToken` (global middleware): generates 32-byte hex token if missing from session
- `csrfGuard` (route-level, POST/PUT/DELETE): validates `x-csrf-token` header or `req.body._csrf` against session token. Returns `403` on mismatch.
- `GET /api/csrf-token`: returns `{ csrfToken }` from session

### 5.5 Security Headers

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

---

## 6. Frontend Behavior

**Files:** `public/index.html`, `public/app.js`, `public/styles.css`

Vanilla JavaScript SPA — no framework, no bundler, no build step. Uses marked (CDN) for Markdown and highlight.js (CDN) for syntax highlighting. (Backend is TypeScript; frontend remains vanilla JS.)

### Layout

- Flexbox: sidebar (fixed 280px) + main area (flex: 1)
- Sidebar: new chat button, search, conversation list grouped by workspace, settings, sign out, version label
- Main area: header with title + usage indicator + action buttons, messages container, input area with backend selector + file chips + textarea
- Responsive: below ~768px sidebar overlays content

### Conversation Management

- **New conversation:** folder picker modal (via `/browse` API) → user selects directory → POST creates conversation
- **Sidebar list:** grouped by workspace (last 2 path segments of `workingDir`), sorted by `updatedAt` desc. Groups are collapsible (state in localStorage). Each group header has a pencil icon for workspace instructions.
- **Context menu:** right-click on conversation items for rename/delete
- **Search:** debounced, case-insensitive search across titles, last messages, and full content

### Messaging & Streaming

- `chatSendMessage()` gathers completed file paths from pending uploads, appends `[Uploaded files: ...]` to content, opens WebSocket, POSTs message, receives stream events via WS
- Streaming uses `fetch` with manual ReadableStream parsing (not EventSource API)
- **Streaming state persistence:** `chatStreamingState` Map stores per-conversation state (accumulated text, thinking, tools, agents, tool/agent history, pending interactions). State survives conversation switches — on return, the streaming bubble is recreated and restored.
- **WebSocket auto-reconnect:** On unexpected WS close during streaming, the client automatically attempts reconnection with exponential backoff (1s base, up to 5 attempts). On reconnect, the server replays buffered events wrapped in `replay_start`/`replay_end`. The client resets streaming state on `replay_start` (clears accumulated text/thinking/tools) and reprocesses replayed events from scratch. `assistant_message` events are deduplicated by message ID. `done` events during replay are ignored to prevent stale streams from destroying the current streaming state. After max attempts exhausted, `_doneResolve` is called to clean up. `chatDisconnectWs()` clears reconnect attempts to prevent auto-reconnect on deliberate close. Session reset clears the server-side event buffer to prevent stale events from replaying into the new session.
- **Elapsed timer:** live timer in streaming bubble header, self-cleans on DOM disconnect and nulls out the interval reference so it can restart on conversation switch-back
- **Unified streaming content:** A single `chatUpdateStreamingContent()` function renders all streaming state (thinking, text, tool history, active tools, agents, plan mode) together in one stacked view. Text content and tool activity accumulate and remain visible simultaneously — new progress updates stack below previous content rather than replacing it. Items are grouped by agent via `chatGroupItemsByAgent()`: standalone tools render flat, while each agent card is followed by a scrollable sub-activity panel showing its child tools. Completed items show checkmarks and elapsed durations; running agents show animated spinners with live timers that count up in real-time.
- **Tool activity on completed messages:** When a message has a `toolActivity` array, `chatRenderToolActivityBlock()` renders a collapsible `<details>/<summary>` block (same pattern as thinking blocks) with a summary line (e.g. "15 ops · 2 agents · 5 read, 2 edited") generated by `chatBuildActivitySummary()`. Collapsed by default; expands to show the full chronological tool/agent list. Agent entries render as agent cards, tool entries as history items.
- **Tool outcome indicators:** Each tool/agent in the activity log shows a colored outcome badge when outcome data is available. `chatRenderStatusCheck()` renders status-colored checkmarks (green ✓ for success, red ✗ for error, amber ✓ for warning). `chatRenderOutcomeBadge()` renders a small colored badge with the outcome text (e.g. "exit 0", "4 matches", "not found"). Outcomes are extracted from CLI `tool_result` blocks by `extractToolOutcome()` in the backend, correlated by `tool_use_id`, and persisted on the `toolActivity` entries.
- **Sticky active section:** During streaming, when both completed and running tools exist, a `chat-activity-panel` container wraps them: completed items scroll in a bounded area while running items with spinners stay pinned at the bottom, always visible.
- **Parallel group indicator:** `chatGroupParallelItems()` detects consecutive agent entries whose `startTime` values are within 500ms (`PARALLEL_THRESHOLD_MS`) and wraps them in a `chat-parallel-group` container with a "parallel" label and a left accent border. Works in both persisted activity blocks and streaming display.
- **Agent detail expansion:** Agent cards with long descriptions or outcome data render as expandable `<details>` elements (`chatRenderAgentCard()`). Summary shows agent type, description, outcome badge, and elapsed time; expanding reveals full outcome details.
- **Session activity overview:** `chatRenderSessionOverview()` aggregates `toolActivity` from all assistant messages in the current session and renders a collapsible dashboard at the top of the message list. Shows: total ops/agents/duration summary, status breakdown pills (success/error/warning counts), tool type bar chart sorted by frequency, and agent timeline with types and outcomes. Collapsed by default; only rendered when at least one message has `toolActivity`.
- **Turn boundaries:** intermediate assistant messages saved, content reset. `turn_complete` event archives active tools/agents to history so spinners stop. On `assistant_message`, tool/agent history is cleared after archiving — the saved message's `toolActivity` now owns those entries, preventing duplicates when the next turn adds new agents to the streaming bubble. Agents are only archived when they have received their `tool_outcomes` (outcome/status set) — sub-tool `turn_complete` events within an agent do NOT prematurely archive the parent agent. This ensures agents show spinners and live timers throughout their full execution.
- **Post-completion processing indicator:** When all tools/agents have completed but the model is still working (no text content yet), a "Processing..." indicator with typing dots is shown below the completed activity log. This fills the gap between agent completion and text output, so users always see ongoing work.
- **Thinking events:** do NOT archive active tool/agent state — `turn_complete` handles archiving. This prevents premature archiving that would kill agent spinners and timers.
- **Plan approval:** renders plan as markdown with approve/reject buttons → sends `{ type: 'input', text: 'yes'|'no' }` via WebSocket
- **User questions:** renders question text + option buttons → sends answer via WebSocket `input` frame
- **Auto title update:** handles `title_updated` event by updating the active conversation title, the header, and the sidebar list in-place (no full reload needed).
- **Usage display:** a small indicator in the conversation header shows **session-level** token count and USD cost. Updated in real-time when `usage` events arrive during streaming. Displays on hover a tooltip with session input/output/cache token breakdown and cost, plus conversation-level totals. Hidden when no usage data exists (e.g. new conversation).
- **Stream cleanup:** `chatCleanupStreamState()` accepts `{ force }` option. The `finally` block uses `force: true` to ensure cleanup even when a pending interaction was never resolved. Interaction response handlers also use forced cleanup when the stream has already ended.
- **Send button state:** shows stop (■) when streaming with no text input, send (↑) when idle or when streaming with text input (to queue). Disabled during uploads or session resets.
- **Message queue:** Users can compose and submit messages while the CLI is actively responding. Queued messages are stored client-side in `chatMessageQueue` (Map of convId → array of `{ id, content, inFlight }`). They appear inline in the chat after the streaming bubble, styled as user messages with reduced opacity and an accent left border. Each queued message shows a "Queued" badge and has Edit and Delete buttons. Editing is inline via a textarea replacing the message content. In-flight messages (being dispatched to the CLI) show "Sending..." and cannot be edited or deleted. When a response completes successfully, the next queued message is automatically sent (FIFO). On error, the queue pauses and a banner appears with Resume and Clear buttons. The `chatQueuePaused` Set tracks paused conversations. Queuing a new message while paused un-pauses the queue. Queue state is per-conversation and purely client-side (not persisted to disk).

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

- **Reset:** archives active session with LLM summary, creates new session, resets conversation title to "New Chat" in both header and sidebar. Shows "Archiving session..." indicator. Blocked during streaming. Double-click prevented via `chatResettingConvs` set. Header title is also synced from server data whenever the conversation list reloads (via `chatLoadConversations`), ensuring the header stays consistent even if the inline update is missed. `chatLoadConversations` uses a generation counter to discard stale responses, preventing race conditions where an older response overwrites a title that was already updated by a `title_updated` event. A final `chatLoadConversations()` call in the streaming `finally` block ensures the sidebar and header reflect the latest server state after streaming ends.
- **History modal:** lists sessions with summaries, view and download buttons
- **View session:** fetches archived messages from API

### Settings Modal

Tabbed layout with two tabs:

**General tab:**
- Theme: System / Light / Dark
- Send behavior: Enter or Shift+Enter
- System prompt textarea (global)
- Default backend selector
- Working directory

**Usage Stats tab:**
- Time range filter: Today / This Week / This Month / All Time
- Per-backend usage table: input, output, cache read, cache write, total tokens, and cost
- Daily breakdown table (when multiple days selected): date, backend, tokens, cost
- "Clear All Data" button: clears the usage ledger (requires confirmation)
- Data loaded from `GET /usage-stats` endpoint

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
| `test/backends.test.ts` | BaseBackendAdapter (including generateTitle), BackendRegistry, ClaudeCodeAdapter, extractToolDetails, extractToolOutcome, extractUsage |
| `test/chat.test.ts` | Chat routes: WebSocket streaming (text, tool_activity, stdin input, abort, assistant_message), WebSocket reconnection (replay buffered events, CLI survives disconnect, CLI crash buffers error, abort clears buffer, session reset clears buffer), turn boundaries, turn_complete event forwarding, tool activity persistence, parallel agent persistence, session overview aggregation, auto title update on session reset, usage event forwarding and persistence (including sessionUsage), usage stats endpoints (GET/DELETE), file upload/serve, workspace instructions |
| `test/chatService.test.ts` | ChatService CRUD, messages (including toolActivity persistence), sessions, generateAndUpdateTitle, usage tracking (addUsage with conversationUsage/sessionUsage, usageByBackend, daily ledger with backend+model dimensions, model separation, getUsage, getUsageStats, clearUsageStats), workspace storage, migration, markdown export |
| `test/draftState.test.ts` | Draft save/restore, key migration, cleanup, round-trip |
| `test/messageQueue.test.ts` | Message queue: adding, deleting, rendering, in-flight protection, pause/resume, per-conversation isolation, send button state |
| `test/graceful-shutdown.test.ts` | Server shutdown on SIGINT/SIGTERM |
| `test/sessionStore.test.ts` | Session file-store persistence |
| `test/updateService.test.ts` | Version comparison, status, trigger guards, interval management, interpreter verification, PATH setup for restart |

### CI/CD

**Test workflow** (`.github/workflows/test.yml`): Runs on PRs to `main`. Steps: checkout, Node.js 18 setup, `npm ci`, `npm test`.

**Version bump** (`.github/workflows/version-bump.yml`): Runs on push to `main`. Skips `chore: bump version` commits. Steps: `npm version patch --no-git-tag-version`, commit, tag, push.
