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
��       ├── backends/
│       │   ├── base.ts                 # BaseBackendAdapter interface
│       │   ├── claudeCode.ts           # Claude Code adapter — CLI spawning, stream parsing
│       │   ├── kiro.ts                 # Kiro adapter — ACP (Agent Client Protocol) over kiro-cli
│       │   ��── toolUtils.ts            # Shared tool helpers (extractToolDetails, extractUsage, etc.)
│       │   └── registry.ts             # BackendRegistry — maps IDs to adapter instances
│       ├── knowledgeBase/
│       │   ├── libreOffice.ts          # LibreOffice (soffice) detection cache
│       │   ├── pandoc.ts               # Pandoc detection + `runPandoc` subprocess helper
│       │   ├── ingestion.ts            # KbIngestionService: per-workspace FIFO queue, enqueueUpload, deleteRaw, waitForIdle
│       │   └── handlers/
│       │       ├── index.ts            # pickHandler dispatch + ingestFile + UnsupportedFileTypeError
│       │       ├── pdf.ts              # PDF page-by-page 150 DPI rasterization via unpdf + @napi-rs/canvas
│       │       ├── docx.ts             # DOCX → GFM markdown via pandoc subprocess + flattened embedded media
│       │       ├── pptx.ts             # PPTX text/notes/media via adm-zip + fast-xml-parser, optional LO rasterization
│       │       └── passthrough.ts      # Text (md/txt/json/...) + image passthrough with truncation + media copy
│       ├── chatService.ts              # Conversation CRUD, messages, sessions, settings
│       └── updateService.ts            # Self-update: version checking, git pull, PM2 restart
├── public/
│   ├── index.html                      # HTML shell
│   ├── styles.css                      # All CSS with light/dark theme
│   └── js/                             # Frontend ES modules (no build step)
│       ├── main.js                     # Entry point: init, event wiring, settings, sessions, update, shortcuts
│       ├── state.js                    # Shared mutable state object, API helpers, constants
│       ├── utils.js                    # Pure utilities: HTML escape, formatting
│       ├── theme.js                    # Theme detection, toggle, persistence
│       ├── modal.js                    # Generic modal show/close
│       ├── backends.js                 # Backend loading, selection, icons, capabilities
│       ├── websocket.js                # WebSocket connect, reconnect, send, disconnect
│       ├── rendering.js                # Message/content rendering, markdown, lightbox, code, streaming UI, timers
│       ├── conversations.js            # Sidebar, conversation CRUD, file uploads, drafts, queue UI, context menu
│       ├── streaming.js                # Message sending, stream event handling, plan approval, user questions, queue processing
│       └── memory.js                   # Workspace memory panel: fetch + render the saved snapshot, group by type, expand file bodies
│       (KB Browser UI lives inside main.js for now — see Section 6 → Knowledge Base Browser)
├── test/                               # Jest test suite (TypeScript via ts-jest)
└── data/                               # Runtime data (gitignored, created at startup)
    ├── chat/
    │   ├── workspaces/{hash}/          # Workspace-based storage (see below)
    │   │   ├── index.json              # Source of truth: conversations + session metadata (includes `memoryEnabled` and `kbEnabled` flags)
    │   │   ├── memory/                 # Per-workspace memory store (opt-in per workspace)
    │   │   │   ├── snapshot.json       # Merged snapshot: claude captures + notes (parsed metadata + content)
    │   │   │   └── files/              # Raw .md entries, split by source
    │   │   │       ├── claude/         # Claude Code native captures; wiped and rewritten on each capture
    │   │   │       │   ├── MEMORY.md   # Source index from Claude Code (if present)
    │   │   │       │   └── *.md        # Per-topic memory files with YAML frontmatter
    │   │   │       └── notes/          # `memory_note` MCP writes + post-session extractions; preserved across captures
    │   │   │           └── *.md        # Per-note memory files with YAML frontmatter
    │   │   ├── knowledge/              # Per-workspace Knowledge Base (opt-in per workspace). Created lazily on first enable.
    │   │   │   ├── state.json          # KbState: raw/entries/synthesis source of truth
    │   │   │   ├── raw/<rawId>.<ext>   # Uploaded files, stored verbatim (rawId = sha256[:16])
    │   │   │   ├── converted/<rawId>/  # Ingestion output: text.md + meta.json + optional media/ (populated by PR 2 on upload)
    │   │   │   ├── entries/<id>.md     # Digestion output (YAML frontmatter + body) — populated by PR 3
    │   │   │   └── synthesis/          # Dreaming output — populated by PR 4
    │   │   │       ├── manifest.json   # Artifact lineage
    │   │   │       └── *.md            # Synthesis layer files
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
  memoryEnabled: boolean|undefined, // Opt-in per-workspace Memory feature. Defaults to false.
  kbEnabled: boolean|undefined,     // Opt-in per-workspace Knowledge Base feature. Defaults to false.
  conversations: [{
    id: string,                 // UUIDv4
    title: string,              // Auto-set from first user message (max 80 chars)
    backend: string,            // 'claude-code'
    model?: string,             // Selected model alias (e.g. 'opus', 'sonnet', 'haiku'); absent = backend default
    effort?: string,            // Adaptive reasoning effort: 'low' | 'medium' | 'high' | 'max' (Opus only); absent = model default. Silently downgraded when the current model doesn't support the stored level.
    currentSessionId: string,   // UUID of the active CLI session
    lastActivity: string,       // ISO 8601, updated on every message
    lastMessage: string|null,   // First 100 chars of last message content
    usage: {                     // Cumulative token/cost tracking (null until first result)
      inputTokens: number,
      outputTokens: number,
      cacheReadTokens: number,
      cacheWriteTokens: number,
      costUsd: number,
      credits?: number,                // Kiro only: accumulated credits consumed (fractional)
      contextUsagePercentage?: number  // Kiro only: context window usage snapshot (0–100)
    }|null,
    usageByBackend: {            // Per-backend usage breakdown (keyed by backend id)
      [backendId]: Usage
    }|null,
    archived: boolean|undefined, // true when conversation is archived; absent/false = active
    messageQueue: string[]|undefined, // Persisted follow-up message queue (content strings); absent when empty
    sessions: [{
      number: number,           // 1-based session number
      sessionId: string,        // UUID passed to CLI
      summary: string|null,     // LLM-generated summary (null for active session)
      active: boolean,          // true for current session, false for archived
      messageCount: number,
      startedAt: string,        // ISO 8601
      endedAt: string|null,     // ISO 8601 (null for active session)
      usage: Usage|null,        // Per-session token/cost totals (same shape as conversation usage)
      usageByBackend: { [backendId]: Usage }|null,  // Per-backend usage for this session
      externalSessionId: string|null  // Backend-managed session ID (e.g. Kiro ACP session ID); null for backends that don't need it
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
    parentAgentId?: string,     // ID of parent agent (when tool runs inside a sub-agent)
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
  model?: string,               // Selected model alias (e.g. 'opus', 'sonnet', 'haiku')
  effort?: string,              // Adaptive reasoning effort: 'low' | 'medium' | 'high' | 'max'
  workingDir: string,           // The workspace path
  currentSessionId: string,
  sessionNumber: number,        // Active session number
  messages: Message[],          // Active session messages
  usage: Usage,                 // Cumulative token/cost totals (zeroed if no usage yet)
  sessionUsage: Usage,          // Active session token/cost totals (zeroed if no usage yet)
  externalSessionId: string|null // Backend-managed session ID (for resume after server restart)
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
  "defaultModel": "sonnet",
  "defaultEffort": "high",
  "workingDirectory": "",
  "memory": {
    "cliBackend": "claude-code",
    "cliModel": "sonnet",
    "cliEffort": "high"
  },
  "knowledgeBase": {
    "digestionCliBackend": "claude-code",
    "digestionCliModel": "sonnet",
    "digestionCliEffort": "high",
    "dreamingCliBackend": "claude-code",
    "dreamingCliModel": "opus",
    "dreamingCliEffort": "high",
    "convertSlidesToImages": false
  }
}
```

`defaultEffort` is the default adaptive reasoning level for new conversations. It only applies when the chosen model matches `defaultModel` AND the model supports that effort level; otherwise the per-conversation selection falls back to `high` (or, defensively, the first supported level of the chosen model). The settings modal only renders the **Default Effort** field when `defaultBackend`/`defaultModel` resolve to a model that declares `supportedEffortLevels`; changing the default model to one without effort support drops `defaultEffort` on save.

The `systemPrompt` is passed to the CLI via `--append-system-prompt` at the start of each new session. It is additive — Claude Code's built-in system prompt is preserved. Legacy `customInstructions` objects are auto-migrated to `systemPrompt` on first read.

The `memory` block configures the globally-shared **Memory CLI** used for `memory_note` MCP processing and post-session extraction (see Section 5 — Workspace Memory).

The `knowledgeBase` block configures the globally-shared **Digestion CLI** and **Dreaming CLI** for the per-workspace Knowledge Base feature (see **Workspace Knowledge Base** subsection under `ChatService` below). Both CLIs default to `defaultBackend` when unset. `convertSlidesToImages` opts into the LibreOffice-backed PPTX slide rasterization path; when enabled but LibreOffice is absent on `PATH`, ingestion logs a warning and falls back to text + speaker notes + embedded media only. LibreOffice presence is detected at server startup (`which soffice` / `where soffice`) and cached for the process lifetime.

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
| GET | `/conversations?q=<search>&archived=true` | — | List all, sorted by `updatedAt` desc. Each summary includes `workspaceHash` and `workspaceKbEnabled` (mirrors the workspace-level KB toggle so the sidebar can gate the KB button). Pass `archived=true` to list only archived conversations (default: active only). |
| GET | `/conversations/:id` | — | Full conversation object. `404` if not found. |
| POST | `/conversations` | Yes | `{ title?, workingDir?, backend? }` → creates conversation with initial session. `backend` defaults to the server's default backend. |
| PUT | `/conversations/:id` | Yes | `{ title }` → rename. `404` if not found. |
| DELETE | `/conversations/:id` | Yes | Aborts active stream, removes from workspace index, deletes session folder + artifacts. Works on both active and archived conversations. |
| PATCH | `/conversations/:id/archive` | Yes | Sets `archived: true` on the conversation. Aborts active stream. Files remain on disk. `404` if not found. |
| PATCH | `/conversations/:id/restore` | Yes | Removes `archived` flag, restoring the conversation to the active list. `404` if not found. |

### 3.3 Message Queue

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/conversations/:id/queue` | — | Returns `{ queue: string[] }`. Empty array if none persisted. |
| PUT | `/conversations/:id/queue` | Yes | `{ queue: string[] }` → replaces the full queue. `400` if body is invalid. `404` if conversation not found. |
| DELETE | `/conversations/:id/queue` | Yes | Clears the queue. `404` if conversation not found. |

The queue is also included in the `GET /conversations/:id` response as `messageQueue` (omitted when empty). Queue is automatically cleared on session reset and archive.

### 3.4 Download

| Method | Path | Description |
|--------|------|-------------|
| GET | `/conversations/:id/download` | Full conversation as `.md` attachment. |
| GET | `/conversations/:id/sessions/:num/download` | Single session as `.md` attachment. |

### 3.5 Sessions

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/conversations/:id/sessions` | — | Session list with `isCurrent` flag and `summary`. |
| GET | `/conversations/:id/sessions/:num/messages` | — | Messages for a specific session. `400`/`404` on error. |
| POST | `/conversations/:id/reset` | Yes | Archives active session (generates LLM summary), creates new session, resets title to "New Chat", clears message queue. `409` if streaming. Clears any stale WebSocket event buffer for the conversation. After archiving, invokes `captureWorkspaceMemory(convId, endingBackend)` so the ending backend's native memory is mirrored to `workspaces/{hash}/memory/`, then runs post-session extraction via `memoryMcp.extractMemoryFromSession` for every backend (including Claude Code) — the Memory CLI scans the just-ended transcript and writes any new memory notes into `memory/files/notes/`. Both steps are best-effort — failures do not block the reset. Also calls `memoryMcp.revokeMemoryMcpSession(convId)` to rotate the MCP token for the next session. Returns `{ conversation, newSessionNumber, archivedSession }`. |

### 3.6 Backends

```
GET /backends
```
Returns `{ backends: [{ id, label, icon, capabilities, models? }] }` — metadata for every registered adapter. The optional `models` array lists available models: `[{ id, label, family, description?, costTier?, default?, supportedEffortLevels? }]`. `supportedEffortLevels` is an optional array of `'low' | 'medium' | 'high' | 'max'` indicating which adaptive reasoning levels the model accepts; the UI uses its presence to decide whether to show the effort dropdown. Backends without model selection (e.g. Kiro) omit the `models` field entirely.

### 3.7 Messaging and Streaming

**Send message:**
```
POST /conversations/:id/message  [CSRF]
Body: { content: string, backend?: string, model?: string, effort?: string }
```
- Saves user message, updates backend and/or model if changed
- If `effort` differs from the stored value, updates it (and silently downgrades when the current model doesn't support the requested level)
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
| `memory_update` | `capturedAt`, `fileCount`, `changedFiles` | Real-time `MemoryWatcher` re-captured workspace memory during this stream. Lightweight payload (no full snapshot) — frontend injects a synthetic system message (`kind: 'memory_update'`) into the conversation's in-memory messages array, which renders as an inline chat bubble with the Agent Cockpit logo as the avatar. Clicking the bubble refetches the snapshot from `GET /workspaces/:hash/memory` and opens the memory panel. |
| `kb_state_update` | `updatedAt`, `changed` | Workspace Knowledge Base state changed. `changed` has optional `raw`/`entries`/`synthesis` string arrays listing the rawIds / entryIds / synthesis artifact ids that were mutated in this frame. The frame carries no full state — the frontend reacts by refetching `GET /workspaces/:hash/kb`. Fan-out is workspace-scoped: the chat router iterates `activeStreams` and sends the frame to every conversation whose workspace hash matches. See **KB Ingestion** under ChatService / Workspace Knowledge Base for the pipeline. |
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

### 3.8 File Upload

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

### 3.9 Settings

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/settings` | — | Returns settings (defaults if file missing). |
| PUT | `/settings` | Yes | Writes full body to `settings.json`. |

### 3.10 Usage Statistics

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/usage-stats` | — | Returns the usage ledger (`{ days: [...] }`). |
| DELETE | `/usage-stats` | Yes | Clears all usage statistics (resets ledger to empty). |

### 3.11 Workspace Instructions

Per-workspace instructions appended to the global system prompt on new sessions. Stored in workspace `index.json` under `instructions`.

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/workspaces/:hash/instructions` | — | Returns `{ instructions: string }`. `404` if workspace not found. |
| PUT | `/workspaces/:hash/instructions` | Yes | `{ instructions: string }`. `400` if not string. `404` if workspace not found. |
| GET | `/workspaces/:hash/memory` | — | Returns `{ enabled: boolean, snapshot: MemorySnapshot \| null }` for the workspace. Always 200 — an enabled workspace with no entries returns `snapshot: null`. Read-only viewer endpoint consumed by the frontend memory panel. |
| PUT | `/workspaces/:hash/memory/enabled` | Yes | `{ enabled: boolean }`. Toggles the per-workspace memory switch (stored on `WorkspaceIndex.memoryEnabled`). `400` if not boolean. `404` if workspace not found. |
| DELETE | `/workspaces/:hash/memory/entries/:relpath(*)` | Yes | Deletes a single memory entry by its relative path (`claude/<name>` or `notes/<name>`). Path is validated against the workspace's memory files dir to prevent traversal (`400` on attempts). `404` if the entry doesn't exist. On success, rewrites `snapshot.json` and emits a `memory_update` WS frame to any active stream in that workspace. |
| DELETE | `/workspaces/:hash/memory/entries` | Yes | Bulk-clears every memory entry for the workspace — wipes both `claude/` (CLI capture) and `notes/` (memory_note + session extraction), then rewrites `snapshot.json`. Leaves the per-workspace `memoryEnabled` flag untouched. Returns `{ ok: true, deleted: number, snapshot }`. Emits a `memory_update` WS frame (empty `changedFiles`) to any active stream in that workspace. No-op returns 200 with `deleted: 0` when there were no entries. Powers the "Clear all memory" button in Workspace Settings → Memory. |
| POST | `/mcp/memory/notes` | No CSRF (bearer) | Internal endpoint called by `stub.cjs` on behalf of non-Claude CLIs. Auth via `X-Memory-Token` header (per-session token minted by `memoryMcp.issueMemoryMcpSession`). Body: `{ content, type?, tags? }`. Loads the workspace snapshot for dedup context, spawns the configured Memory CLI via `runOneShot`, parses the response (either `SKIP: <filename>` or a frontmatter markdown doc), and writes new entries via `addMemoryNoteEntry`. Returns `{ ok, filename }` or `{ ok, skipped }`. `403` if memory is disabled on the workspace. |
| GET | `/workspaces/:hash/kb` | — | Returns `{ enabled: boolean, state: KbState }` for the workspace. Always 200 for an existing workspace — an enabled workspace with no files yet returns an empty state scaffold (`raw: {}, entries: {}, synthesis.status: 'empty'`). `404` if the workspace doesn't exist. Persists `state.json` on first call for enabled workspaces; returns an in-memory-only empty scaffold (not written to disk) for disabled workspaces so the KB Browser can still render its disabled state. |
| PUT | `/workspaces/:hash/kb/enabled` | Yes | `{ enabled: boolean }`. Toggles the per-workspace Knowledge Base switch (stored on `WorkspaceIndex.kbEnabled`). `400` if not boolean. `404` if workspace not found. Independent of the Memory toggle — enabling KB does not touch `memoryEnabled`. |
| POST | `/workspaces/:hash/kb/raw` | Yes | `multipart/form-data` with a single `file` field (max 200 MB). Hashes the buffer to derive `rawId = sha256[:16]`, stages `raw/<rawId>.<ext>`, and writes the `ingesting` state entry synchronously before returning. A background conversion job is scheduled on the workspace's FIFO queue. Returns **202** with `{ entry: KbRawEntry, deduped: boolean }`. `deduped: true` indicates the identical content already exists — the existing entry is returned unchanged and no new work is scheduled. `400 { error: "KB disabled" }` if KB is off for the workspace, `400` if no file field, `404` if workspace not found, `400` with a `MulterError`-derived JSON message if the file exceeds the 200 MB limit. **Pre-flight format guards:** returns `400 { error: "Legacy .doc format is not supported..." }` for any `.doc` upload and `400 { error: "DOCX ingestion requires Pandoc..." }` for `.docx` uploads when `detectPandoc()` reports the binary is missing — both checks run before the raw entry is created so no failed entry sticks around. Emits a `kb_state_update` WS frame on every state mutation (stage, in-flight status change, completion). |
| DELETE | `/workspaces/:hash/kb/raw/:rawId` | Yes | Cascade-deletes the raw file, its `converted/<rawId>/` directory, and the `state.json` entry for `rawId`. Returns `{ ok: true }` on success, `404 { error: "raw not found" }` for unknown rawId, `400` if KB is disabled, `404` if workspace not found. The `rawId` must match `^[a-f0-9]{1,64}$` (hex only) or the route returns `400`. Emits a `kb_state_update` WS frame on success. |
| GET | `/workspaces/:hash/kb/raw/:rawId` | — | Streams the raw file bytes with `Content-Type` set from the stored `mimeType` (defaults to `application/octet-stream`) and `Content-Disposition: inline; filename="<original>"`. Used by the KB Browser raw list "download" action. `400` if `rawId` fails hex validation, `404` for unknown workspace/rawId. Also path-resolves the computed file path and verifies it stays inside `knowledge/raw/` (traversal guard). No CSRF — safe read. |
| GET | `/kb/libreoffice-status` | — | Returns the cached `LibreOfficeStatus` (`{ available, binaryPath, checkedAt }`). Used by the global Settings → Knowledge Base "Convert PPTX slides to images" checkbox to validate on-click: if `available` is `false`, the frontend auto-unchecks the box and shows a warning underneath. Safe to call on every check because `detectLibreOffice()` is cached at module level after the first invocation (server startup). |
| GET | `/kb/pandoc-status` | — | Returns the cached `PandocStatus` (`{ available, binaryPath, version, checkedAt }`). Unlike LibreOffice, pandoc is **required** (not optional) for DOCX ingestion — the route layer rejects `.docx` uploads with a 400 when this endpoint reports `available: false`. The KB Browser Raw tab and global Settings → Knowledge Base tab both fetch this endpoint to surface a persistent install banner. Cached at module level after `detectPandoc()` runs at server startup. |

**System prompt composition on new sessions:**
1. Global system prompt (from `settings.json`)
2. Workspace instructions (from workspace `index.json`)
3. **Memory MCP addendum** — appended for every backend whenever `memoryEnabled` is true. Instructs the CLI to call `memory_note` via the `agent-cockpit-memory` MCP server for durable user/feedback/project/reference facts it encounters during the session. Claude Code gets this addendum too — its native `#` flow handles explicit saves, but `memory_note` captures incidental facts mentioned conversationally.

Concatenated with `\n\n` and passed as the backend's system prompt. Not sent on session resume.

Memory content itself is **not** dumped into the system prompt. Instead, a short filesystem pointer is prepended to the user message on new sessions — see **Workspace Memory → Injection trigger** below.

### 3.12 Version & Self-Update

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/version` | — | `{ version, remoteVersion, updateAvailable }` |
| GET | `/update-status` | — | Cached status: `{ localVersion, remoteVersion, updateAvailable, lastCheckAt, lastError, updateInProgress }` |
| POST | `/check-version` | Yes | Triggers immediate remote check, returns status. |
| POST | `/update-trigger` | Yes | Full update sequence (see Section 4, UpdateService). |
| POST | `/server/restart` | Yes | Plain pm2 restart (no git pull / npm install) via `UpdateService.restart()`. Returns `409` if an update is in progress or active conversation streams exist. Used by the Server tab in Global Settings so users can re-trigger startup-time detection (e.g. pandoc) after installing external binaries. |

### 3.13 Error Response Patterns

| Status | Meaning | Body |
|--------|---------|------|
| `400` | Bad input | `{ error: "message" }` |
| `401` | Session expired / not authenticated (API routes only) | `{ error: "Not authenticated" }` |
| `403` | CSRF failure or access denied | `{ error: "Invalid CSRF token" }` |
| `404` | Not found | `{ error: "Conversation not found" }` etc. |
| `409` | Conflict | `{ error: "Cannot reset session while streaming" }` |
| `500` | Server error | `{ error: err.message }` |

Unauthenticated requests to `/api/*` return `401 { error: "Not authenticated" }` as JSON so the client can react without trying to parse an HTML login page. All other unauthenticated requests redirect to `/auth/login`.

---

## 4. Backend Services

### 4.1 ChatService

**File:** `src/services/chatService.ts`

**Constructor:** `new ChatService(appRoot, options)` — sets `baseDir` to `<appRoot>/data/chat`, creates `workspaces/` and `artifacts/` dirs synchronously at startup, initializes in-memory `Map<convId, workspaceHash>` for fast lookup.

#### Methods

| Method | Description |
|--------|-------------|
| `initialize()` | Runs migration if legacy `conversations/` dir exists, builds convId→workspace lookup map. |
| `createConversation(title, workingDir, backend, model?, effort?)` | Creates entry in workspace index + empty session-1.json. Falls back to `_defaultWorkspace`. `backend` defaults to the registry's first registered adapter. `model` is the optional model alias to persist. `effort` is the optional adaptive reasoning level; silently downgraded (or dropped) if the chosen model doesn't support it. |
| `getConversation(id)` | Returns API-compatible object with messages, or `null`. |
| `listConversations(opts?)` | Scans all workspace indexes. Returns summaries sorted by `lastActivity` desc, each with `workspaceHash` and `workspaceKbEnabled` (defaults to `false` for legacy workspaces). Pass `{ archived: true }` to list only archived; default returns active only. |
| `renameConversation(id, newTitle)` | Updates title in workspace index. Returns full conversation or `null`. |
| `archiveConversation(id)` | Sets `archived: true` on conversation entry in workspace index. Returns `true` or `false` if not found. Files remain on disk. |
| `restoreConversation(id)` | Removes `archived` flag from conversation entry. Returns `true` or `false` if not found. |
| `deleteConversation(id)` | Removes from index, deletes session folder + artifacts, removes from lookup map. Works on both active and archived conversations. |
| `updateConversationBackend(convId, backend)` | Updates backend field in workspace index. |
| `updateConversationModel(convId, model)` | Updates model field in workspace index. Pass `null` to clear. Silently downgrades the stored `effort` when the new model doesn't support the current level, or clears it if the new model has no effort support at all. |
| `updateConversationEffort(convId, effort)` | Updates effort field in workspace index. Pass `null` to clear. Silently downgrades the requested level to what the conversation's current model supports. |
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
| `getWorkspaceContext(convId)` | **Synchronous.** Returns the workspace discussion-history pointer text or `null`. Prepended to the user message on new sessions. |
| `getWorkspaceMemoryPointer(hash)` | Returns a bracketed pointer block telling the CLI where the workspace's `memory/files/` dir lives on disk, or `null` when memory is disabled for the workspace. `mkdir -p`s `memory/files/` so the model never hits ENOENT on a brand-new workspace. Prepended to the user message on new sessions alongside `getWorkspaceContext`. |
| `saveWorkspaceMemory(hash, snapshot)` | Persists a `MemorySnapshot` to `workspaces/{hash}/memory/`. Only wipes and rewrites `memory/files/claude/` (Claude native captures); `memory/files/notes/` (memory_note writes + session extractions) is preserved across captures. The merged snapshot written to `snapshot.json` combines both directories. Runs legacy migration before writing (any loose files at `memory/files/` root are moved into `claude/`). |
| `getWorkspaceMemory(hash)` | Loads the stored snapshot, reconciles it with any notes that may have been added since the last CLI capture, and returns the merged view. Returns `null` if neither a stored snapshot nor any notes exist. |
| `captureWorkspaceMemory(convId, backendId)` | Resolves the workspace for `convId`, invokes the backend adapter's `extractMemory()`, and persists the result via `saveWorkspaceMemory`. Returns the raw adapter snapshot or `null`. Never throws — extraction/save errors are logged. |
| `addMemoryNoteEntry(hash, { content, source, filenameHint? })` | Writes a single memory entry into `memory/files/notes/` with a timestamped, slug-based filename (`note_<ts>_<slug>.md` or `session_<ts>_<slug>.md` depending on `source`). Calls `_refreshSnapshotIndex` so `getWorkspaceMemory` immediately reflects the write. Returns the relative path (`notes/<name>`). Used by the Memory MCP server handler and the post-session extraction path. |
| `deleteMemoryEntry(hash, relPath)` | Deletes a single memory entry by its relative path (`claude/<name>` or `notes/<name>`). Validates the path stays inside `memory/files/` (throws on traversal) and refuses non-`.md` files. Rewrites `snapshot.json` on success. Returns `true` if deleted, `false` if the file didn't exist. |
| `clearWorkspaceMemory(hash)` | Wipes every `.md` under `memory/files/claude/` and `memory/files/notes/`, then rewrites `snapshot.json` to reflect the empty state. Leaves the workspace's `memoryEnabled` flag untouched so the user can keep the feature on and start over. Returns the number of files deleted. Used by the "Clear all memory" button in Workspace Settings → Memory. |
| `getWorkspaceMemoryEnabled(hash)` | Returns the per-workspace Memory toggle (`WorkspaceIndex.memoryEnabled`). Defaults to `false` for legacy workspaces. |
| `setWorkspaceMemoryEnabled(hash, enabled)` | Persists the toggle to the workspace index. Returns the new value or `null` if the workspace doesn't exist. |
| `getWorkspaceKbEnabled(hash)` | Returns the per-workspace Knowledge Base toggle (`WorkspaceIndex.kbEnabled`). Defaults to `false`. |
| `setWorkspaceKbEnabled(hash, enabled)` | Persists the KB toggle to the workspace index. Returns the new value or `null` if the workspace doesn't exist. Independent of the Memory toggle. |
| `getKbState(hash)` | Reads the per-workspace `KbState` from `knowledge/state.json`. Returns `null` when the workspace doesn't exist or when no state file has been written yet. |
| `saveKbState(hash, state)` | Persists a `KbState` to `knowledge/state.json`, bumping `updatedAt` to now. Creates the `knowledge/` dir on first write. Returns the persisted state. |
| `getOrInitKbState(hash)` | Returns the workspace KB state, creating and persisting an empty scaffold on first call for an enabled workspace. Returns an in-memory empty scaffold (not persisted) for disabled workspaces so the UI can render the disabled state without polluting disk. Returns `null` for unknown workspaces. |
| `getWorkspaceKbPointer(hash)` | Returns a bracketed pointer block telling the CLI where the workspace's `knowledge/` dir lives on disk, or `null` when KB is disabled. `mkdir -p`s `knowledge/entries/` so the CLI never hits ENOENT on a brand-new enabled workspace. Prepended to the user message on new sessions alongside the discussion-history and memory pointers. |
| `getKbRawDir(hash)` / `getKbConvertedDir(hash)` / `getKbEntriesDir(hash)` / `getKbSynthesisDir(hash)` | Public path getters exposing the per-workspace KB subdirectories (synchronous, no I/O). Used by `KbIngestionService` and the chat route handlers so they don't need to recompute workspace paths. |
| `getKbRawFilePath(hash, rawId)` | Async helper that looks up the stored `rawId` in `state.json` and returns the absolute path to `raw/<rawId>.<ext>` (using the persisted extension), or `null` if the entry or workspace doesn't exist. Powers `GET /workspaces/:hash/kb/raw/:rawId`. |
| `searchConversations(query, opts?)` | Case-insensitive: checks title/lastMessage first, then deep-searches session files. Respects `{ archived }` filter same as `listConversations`. |
| `getSettings()` | Returns settings from disk or defaults. |
| `saveSettings(settings)` | Writes settings to disk. |

All methods are `async` except `getWorkspaceContext()`. `getWorkspaceMemoryPointer()` is `async` so it can `mkdir -p` the memory dir on first access.

#### Workspace Context Injection

When a new CLI session starts, the router prepends up to three bracketed pointer blocks to the outgoing user message (not stored in the conversation's message list). The first is always present; the second is added only when Memory is enabled for the workspace; the third is added only when Knowledge Base is enabled for the workspace.

```
[Workspace discussion history is available at {abs_workspace_path}/
Read index.json for all past and current conversations in this workspace with per-session summaries.
Each conversation subfolder contains session-N.json files with full message histories.
When the user references previous work, decisions, or discussions, consult the relevant session files for context.]

[Workspace memory is available at {abs_workspace_path}/memory/files/
Contains .md files with YAML frontmatter (type, name, description) followed by body text.
Read these when the user references preferences, feedback, decisions, project context, or prior work style.]

[Workspace knowledge base is available at {abs_workspace_path}/knowledge/
- state.json: pipeline state (raw uploads, digested entries, synthesis status).
- entries/*.md: digested knowledge entries with YAML frontmatter (title, tags, source).
- synthesis/*.md: cross-entry synthesis (created by the Dreaming stage).
Read these when the user references documents they've uploaded, domain knowledge, or asks questions the digested entries may cover.]
```

These prefixes are **only added on new sessions**. On resumed sessions the CLI already has them in its conversation history from the original first user message, so the pointers remain visible to the model across `--resume` without re-injection. The memory pointer is produced by `chatService.getWorkspaceMemoryPointer(hash)`, which returns `null` when memory is disabled and otherwise `mkdir -p`s `memory/files/` before returning so the model never hits ENOENT on a brand-new workspace. The KB pointer is produced by `chatService.getWorkspaceKbPointer(hash)` with the same "return null when disabled / `mkdir -p` when enabled" contract, targeting `knowledge/entries/`.

#### Workspace Memory

CLI backends may have their own memory systems (e.g. Claude Code stores memory under `~/.claude/projects/{sanitized}/memory/`). Agent Cockpit captures that memory at the **workspace** level so it survives CLI switches, session resets, and fresh conversations. Non-Claude CLIs that don't have a native memory system instead write memory via an MCP tool (`memory_note`) that the cockpit exposes to them — see **Memory MCP Server** below.

Memory is **opt-in per workspace** via a toggle stored on `WorkspaceIndex.memoryEnabled`. When the toggle is off, every code path that would read or write memory (capture, watcher, injection, MCP addendum) is skipped, and the memory store stays inert. Toggling is done via the workspace Settings modal (Instructions + Memory tabs).

**On-disk layout:** `memory/files/` is split into two subdirectories that correspond to the two write paths:
- `memory/files/claude/` — Claude Code native captures. Wiped and rewritten every time `saveWorkspaceMemory` is called, so the directory always mirrors the current state of the CLI's extraction output.
- `memory/files/notes/` — Entries written via the `memory_note` MCP tool and by post-session extraction. Preserved across captures. Each file has a timestamped, slug-based name (`note_<ts>_<slug>.md` or `session_<ts>_<slug>.md`).
The merged snapshot (`memory/snapshot.json`) combines both directories so callers of `getWorkspaceMemory(hash)` see a single file list with a `source` field (`cli-capture | memory-note | session-extraction`) on each entry.

**Capture trigger (Claude Code):** On `POST /conversations/:id/reset`, after the session is archived, the router calls `chatService.captureWorkspaceMemory(convId, endingBackend)` — gated on `getWorkspaceMemoryEnabled(hash)`. The ending backend's `extractMemory(workspacePath)` is invoked and the resulting `MemorySnapshot` is persisted via `saveWorkspaceMemory` (which only wipes the `claude/` subtree, preserving notes). Capture is best-effort — extraction or persistence errors are logged and never block the reset.

**Post-session extraction (all backends):** After the same reset, the router additionally calls `memoryMcp.extractMemoryFromSession({ workspaceHash, conversationId, messages })` with the pre-reset transcript for every backend (including Claude Code). This spawns the globally-configured Memory CLI via `runOneShot` with a prompt that lists existing memory entries (for dedup context) and asks the CLI to extract any new durable memories. The CLI is expected to reply with either `NONE` or one or more frontmatter markdown entries separated by `===` delimiters. Each new entry is written to `notes/` via `addMemoryNoteEntry(hash, { source: 'session-extraction', ... })`. Claude Code still receives its native `captureWorkspaceMemory` first so explicit `#` saves are mirrored to `claude/`; extraction runs on top to catch incidental durable facts mentioned conversationally. This path is best-effort and swallows all errors.

**Real-time capture (MemoryWatcher):** Session-reset capture misses memories written during long sessions if the browser is closed before the user resets. To close that gap, `src/services/memoryWatcher.ts` wraps `fs.watch()` on the backend's memory directory and re-captures into workspace storage whenever a `.md` file changes. The router (`createChatRouter`) owns one `MemoryWatcher` instance. When a message is sent and a WebSocket is connected for the conversation, the router calls `adapter.getMemoryDir(workingDir)`; if a directory is returned, `memoryWatcher.watch(convId, memDir, onChange)` is invoked alongside `processStream`. The `onChange` handler calls `chatService.captureWorkspaceMemory(convId, backendId)` — the same code path as session-reset capture — so there is a single write path into workspace memory storage. Change events are debounced (500ms default) to collapse bursts from Claude Code's extraction agent into a single re-snapshot. Non-`.md` files are ignored. The watcher is scoped to a processStream's lifecycle: it is unwatched in `processStream`'s `onDone` callback, in the `processStream().catch` branch, on `DELETE /conversations/:id`, on `PATCH /conversations/:id/archive`, and via `memoryWatcher.unwatchAll()` in `shutdown()`.

**`memory_update` WebSocket frame:** After each successful re-capture, the router emits a lightweight `memory_update` `StreamEvent` over the active conversation's WebSocket: `{ type: 'memory_update', capturedAt, fileCount, changedFiles }`. `changedFiles` is computed by maintaining a per-conversation `Map<convId, Map<filename, fingerprint>>` in the router (`memoryFingerprints`); fingerprints are a cheap `length:hash` of the first 256 chars of file content (djb2). The diff returns any filename whose fingerprint changed or didn't exist in the previous frame. The map is cleared in every unwatch path (`onDone`, `.catch`, delete, archive, shutdown) so a re-watched conversation starts fresh and reports all files as changed on the first capture. The frame is only sent when the WebSocket is currently connected — if not, the snapshot is still persisted but no frame fires.

**Memory panel UI:** The frontend dispatcher (`public/js/streaming.js`) handles `memory_update` by injecting a synthetic `system` message with `kind: 'memory_update'` into `state.chatActiveConv.messages` (`chatAppendMemoryUpdateMessage`), then triggering a normal `chatRenderMessages()` rebuild. Because the message lives in the conversation's message array, it survives every subsequent re-render (unlike a transient appended DOM node, which would be wiped by the next `innerHTML` reset). The synthetic message is rendered by `chatRenderMemoryUpdateMessage` in `public/js/rendering.js` as a regular chat-msg bubble using the Agent Cockpit logo (`logo-small.svg`) as the avatar; the body is a clickable card showing how many files changed and a preview of the changed filenames. Synthetic messages are client-side only — they are not persisted to backend session files and do not survive a page reload or conversation switch. Clicking the card opens the read-only memory panel modal (`public/js/memory.js → chatOpenMemoryPanel`), which fetches `GET /workspaces/:hash/memory` via raw `fetch` (so a 404 can be treated as the "no snapshot yet" empty state rather than an exception). The `workspaceHash` field is included on the `Conversation` API response. The panel groups files by type (user / feedback / project / reference / other) and lets the user expand each file to see the raw `.md` content. The panel has a Refresh button that re-fetches the snapshot. No editing — the panel is strictly read-only.

**Read access (pointer, not dump):** On `POST /conversations/:id/message` for a new session, the router calls `chatService.getWorkspaceMemoryPointer(hash)` and prepends the returned bracketed block to the outgoing user message alongside the existing workspace discussion-history pointer from `getWorkspaceContext(convId)`. The pointer is a 3-line text block that names the absolute path to `memory/files/` and tells the CLI to read its `.md` files when the user references preferences, feedback, decisions, project context, or prior work style. Gated on `getWorkspaceMemoryEnabled(hash)`: when the toggle is off, the pointer is skipped entirely. The memory **content** is never serialized into the system prompt — the CLI reads the files on demand via its own file tools, so (a) resumed sessions keep access because the pointer lives in the CLI's conversation history from the first user message, (b) mid-session additions (notes written from another tab via `memory_note`) are visible on the very next turn because each read fetches fresh content, and (c) the static token cost per spawn is bounded by the pointer length rather than the memory size. For every backend (Claude Code included), an additional **Memory MCP addendum** is appended to the system prompt that teaches the CLI to call the `memory_note` MCP tool when it encounters durable facts — see the Memory MCP Server subsection below.

#### Memory MCP Server

**File:** `src/services/memoryMcp/index.ts` (router + factory) and `src/services/memoryMcp/stub.cjs` (stdio shim).

Exposes a `memory_note` MCP tool to every CLI backend so they can persist durable memory into workspace storage. Kiro has no native memory system; Claude Code does (via `#`) but gets `memory_note` too, so incidental durable facts mentioned conversationally are still captured.

**Architecture:**
1. **Stub (`stub.cjs`)** — A dependency-free CommonJS Node script that implements the minimal MCP protocol (`initialize`, `tools/list`, `tools/call`) over stdio. It exposes exactly one tool — `memory_note` with `{ content, type?, tags? }` — and forwards `tools/call` invocations to Agent Cockpit's HTTP endpoint over localhost via `X-Memory-Token`. The stub is spawned by the CLI's MCP host (Kiro's ACP `mcpServers` field, or Claude Code's `--mcp-config` flag) as `node <stub.cjs>` with `MEMORY_TOKEN` and `MEMORY_ENDPOINT` in its env.

2. **Session registry** — `createMemoryMcpServer` maintains an in-memory `Map<token, { conversationId, workspaceHash, createdAt }>` and a reverse `Map<convId, token>`. `issueMemoryMcpSession(convId, hash)` is **idempotent per conversation**: if a token is already cached for the same `{convId, workspaceHash}` pair, it is returned unchanged; otherwise a fresh 24-byte hex token is minted and stored. Idempotency is load-bearing — the chat route calls this on every message, but the MCP stub is only spawned once per CLI session and captures its bearer token from its spawn-time env forever. Minting a fresh token on every message would revoke the live token the still-running stub is holding, causing every subsequent `memory_note` HTTP call to fail with `401 Invalid or missing memory token`. Token rotation only happens at real lifetime boundaries: `revokeMemoryMcpSession(convId)` is called on session reset, conversation delete, and workspace-hash change.

3. **HTTP endpoint** — `POST /api/chat/mcp/memory/notes` (mounted under the chat router at `/mcp/memory/notes`). The handler:
   - Validates `X-Memory-Token` against the session registry (`401` on mismatch)
   - Enforces `getWorkspaceMemoryEnabled(hash)` (`403` if disabled)
   - Loads the current merged snapshot for dedup context
   - Resolves the **Memory CLI** from `Settings.memory.cliBackend` (falling back to `settings.defaultBackend`)
   - Calls the adapter's `runOneShot(prompt, { model, effort, timeoutMs: 90s })` with a prompt template that lists existing entries and asks the CLI to reply with either `SKIP: <filename>` (duplicate) or a single frontmatter markdown document
   - On SKIP, returns `{ ok, skipped }`. Otherwise writes the entry via `addMemoryNoteEntry(hash, { content, source: 'memory-note', filenameHint })` and emits a `memory_update` WS frame to any active stream in the same conversation.

4. **Wiring into backends** — When a message is sent for a memory-enabled workspace, the chat route (`src/routes/chat.ts`) calls `memoryMcp.issueMemoryMcpSession` and passes the resulting array as `mcpServers` on `SendMessageOptions`. `KiroAdapter` forwards it to ACP's `session/new` and `session/load` (env as an array of `{name, value}` pairs per the ACP spec). `ClaudeCodeAdapter` transforms the array into Claude Code's `--mcp-config` JSON shape via `mcpServersToClaudeConfigJson` (env as a plain `Record<string, string>`, keyed by server name) and passes it as a JSON string argument. Both paths spawn the same `stub.cjs` with the same env vars.

5. **Memory CLI helper** — `BaseBackendAdapter.runOneShot(prompt, options?)` is the cross-backend primitive used by the MCP handler and the post-session extraction path. The default base class implementation throws; `ClaudeCodeAdapter` overrides it with `execFile('claude', ['--print', '-p', prompt, '--model', ...])` and `KiroAdapter` with `execFile('kiro-cli', ['chat', '--no-interactive', '--trust-all-tools', prompt])`. Both respect a 60-90s hard timeout and throw a typed error on non-zero exit.

**Claude Code path resolution:** `resolveClaudeMemoryDir(workspacePath)` first tries the exact sanitized match (`/workspace/path` → `-workspace-path`) and falls back to scanning `~/.claude/projects/` for directories whose name starts with the first 200 sanitized chars — this handles the hashed-suffix case Claude Code uses for long paths, where Bun's hash can't be reproduced in Node. The `HOME` env var is preferred over `os.homedir()` so tests can sandbox the lookup. `ClaudeCodeAdapter.getMemoryDir(workspacePath)` exposes this same path resolution (wrapped with `resolveCanonicalWorkspacePath` for worktrees) as a pure function the `MemoryWatcher` can call without reading the directory contents.

**Worktree canonicalization:** Before the path lookup, `ClaudeCodeAdapter.extractMemory` and `getMemoryDir` both call `resolveCanonicalWorkspacePath(workspacePath)`, a pure-filesystem helper that detects git worktrees by looking for a `.git` **file** (not directory) containing a `gitdir:` pointer. When a worktree is detected, it reads the `commondir` file inside the worktree's metadata dir to locate the main repo's `.git` directory, and returns its parent as the canonical workspace path. This ensures all worktrees of one repo share a single memory store. Non-git workspaces (no `.git` entry) and main repos (`.git` is a directory) pass through unchanged, as do any worktrees whose metadata is malformed or whose resolved main repo no longer exists.

**`MemorySnapshot` shape:**
```typescript
{
  capturedAt: string,        // ISO 8601
  sourceBackend: string,     // e.g. 'claude-code'
  sourcePath: string | null, // absolute path the snapshot was read from
  index: string,             // raw contents of source MEMORY.md (may be '')
  files: Array<{
    filename: string,
    name: string | null,         // from YAML frontmatter
    description: string | null,  // from YAML frontmatter
    type: 'user' | 'feedback' | 'project' | 'reference' | 'unknown',
    content: string              // raw .md (frontmatter + body)
  }>
}
```

#### Workspace Knowledge Base

Per-workspace **Knowledge Base** gives each workspace a curated store of documents the CLI can consult on demand. The feature is **opt-in per workspace** via `WorkspaceIndex.kbEnabled` (defaults to `false`) and is independent of the Memory toggle — enabling one does not enable the other. When the toggle is off, every KB code path (pointer injection, pipeline, UI browser) short-circuits and the `knowledge/` directory is never created on disk.

The feature is delivered across five sequential PRs. **PR 1** landed the storage layer, types, settings plumbing, feature toggles, and system-prompt pointer. **PR 2** (current) adds the ingestion stage: per-format handlers, background conversion, the upload endpoint, and the KB Browser UI for uploading/listing/deleting raw files. Later phases add: digestion via the Digestion CLI (PR 3), dreaming / cross-entry synthesis via the Dreaming CLI (PR 4), and the `knowledge_search` MCP tool (PR 5).

**Pipeline stages:**
1. **Ingestion** (PR 2 — active) — Our code. Accepts a raw upload, stores it under `knowledge/raw/<rawId>.<ext>`, extracts text + media into `knowledge/converted/<rawId>/` via format-specific handlers. LibreOffice is used as an opt-in helper for PPTX slide rasterization when `Settings.knowledgeBase.convertSlidesToImages` is true.
2. **Digestion** — Per-item. Spawns the Digestion CLI (`Settings.knowledgeBase.digestionCliBackend`) one-shot per converted item, producing one or more `knowledge/entries/<id>.md` files with YAML frontmatter (`title`, `tags`, `source`).
3. **Dreaming** — Cross-entry, manual trigger. Spawns the Dreaming CLI (`Settings.knowledgeBase.dreamingCliBackend`) with the current entry set and asks it to produce synthesis artifacts under `knowledge/synthesis/`, tracking lineage in `synthesis/manifest.json`.

All three stages run **serialized per workspace** — the KB pipeline holds at most one in-flight CLI invocation per workspace hash, so a background digestion cannot overlap with a user-triggered dreaming pass on the same store.

**`KbState` shape** (persisted to `knowledge/state.json`, source of truth for the pipeline):
```typescript
{
  version: number,              // KB_STATE_VERSION — bumped on schema migration
  entrySchemaVersion: number,   // KB_ENTRY_SCHEMA_VERSION — bumped on entry frontmatter change
  raw: Record<string, KbRawEntry>,        // rawId → ingestion record (file info, status)
  entries: Record<string, KbEntryRef>,    // entryId → digested entry pointer (path, title, rawId)
  synthesis: KbSynthesisState,  // Dreaming status: { status, lastRunAt, artifacts[] }
  updatedAt: string             // ISO 8601
}
```
`KbRawEntry.status` cycles through `ingesting | ingested | digesting | digested | failed`. PR 2 uses the `ingesting → ingested → failed` transitions; `digesting`/`digested` are set by PR 3. `KbSynthesisState.status` cycles through `idle | running | completed | failed`. PR 1 shipped the empty scaffold (`raw: {}`, `entries: {}`, `synthesis: { status: 'idle', artifacts: [] }`); PR 2 populates `raw` as files are uploaded; subsequent PRs will populate `entries` and `synthesis`.

**Feature gating:** `getOrInitKbState(hash)` is the single entry point for UI/pipeline reads. It returns an in-memory empty scaffold when KB is disabled (not persisted to disk, so workspaces that never opt in stay clean) and a persisted empty scaffold on first access when KB is enabled. `getWorkspaceKbPointer(hash)` follows the same pattern as `getWorkspaceMemoryPointer`: returns `null` when disabled, otherwise `mkdir -p`s `knowledge/entries/` so the CLI can read the directory without hitting ENOENT on a brand-new workspace, and returns a bracketed text block naming the absolute path.

**Pointer injection:** On new sessions, the chat route prepends three bracketed blocks to the outgoing user message — discussion history (always), memory (when enabled), knowledge base (when enabled) — see **Workspace Context Injection** above. KB content itself is never serialized into the system prompt; the CLI reads `state.json` and `entries/*.md` on demand via its own file tools, so resumed sessions keep access and mid-session additions are visible on the next turn.

**LibreOffice detection** (`src/services/knowledgeBase/libreOffice.ts`): `detectLibreOffice()` runs once at server startup (fire-and-forget, so it never blocks port binding) and caches the result at module level. It uses `which soffice` on POSIX and `where soffice` on Windows — not `soffice --version`, because launching the full binary would spawn a user profile at startup. The cached `LibreOfficeStatus` (`{ available, binaryPath, checkedAt }`) is consulted by the ingestion stage (PR 2) when `Settings.knowledgeBase.convertSlidesToImages` is true; if LibreOffice is unavailable, ingestion logs a warning and falls back to extracting text + speaker notes + embedded media only. The cached status is also exposed via `GET /kb/libreoffice-status` so the global Settings modal can validate the checkbox on click: when the user turns the "Convert PPTX slides to images" box on, the frontend fetches the endpoint, and if `available` is `false` the box auto-reverts to unchecked and a warning appears underneath telling the user to install LibreOffice and restart the cockpit. Detection is cached for the process lifetime, so installing LibreOffice while the server is running requires a restart to pick up.

**Pandoc detection** (`src/services/knowledgeBase/pandoc.ts`): Mirror of the LibreOffice module, with one key difference — pandoc is **required**, not optional, for DOCX ingestion. `detectPandoc()` runs once at server startup, uses `which pandoc` / `where pandoc` to locate the binary, then probes `pandoc --version` (cheap and side-effect-free) to surface the version string in the Settings UI. Result is cached as `PandocStatus` (`{ available, binaryPath, version, checkedAt }`) at module level. The shared `runPandoc(args, { timeoutMs, maxBuffer })` helper throws immediately when the cached status reports unavailable, so callers don't have to re-check. When pandoc is missing, the route layer rejects `.docx` uploads pre-flight with a `400` containing an install hint (`brew`/`apt`/`choco` one-liners and `https://pandoc.org/installing.html`). The frontend surfaces the same state in two places: the KB Browser Raw tab renders a persistent warning banner (`chat-kb-banner-warn`) above the upload zone when `GET /kb/pandoc-status` returns `available: false`, and the global Settings → Knowledge Base tab shows a "Pandoc (required for DOCX ingestion)" status row — green "Detected vX.Y.Z at /path" or red "Not found on PATH" — refreshed on tab open.

**Global settings:** `Settings.knowledgeBase` configures the Digestion and Dreaming CLIs separately (each with its own `cliBackend`, `cliModel`, `cliEffort`) and the `convertSlidesToImages` opt-in. Both CLI roles fall back to `Settings.defaultBackend` when unset. The settings modal exposes cascading backend → model → effort pickers per role, mirroring the existing Memory CLI picker pattern.

**Workspace settings:** The workspace Settings modal has a Knowledge Base tab with a single checkbox (`kbEnabled`). Once enabled, the full-screen **KB Browser** (see Section 6) becomes the upload UI and entry list. Saving the toggle hits `PUT /workspaces/:hash/kb/enabled` and does not touch `memoryEnabled`.

**Ingestion pipeline (PR 2 — active):** `KbIngestionService` (`src/services/knowledgeBase/ingestion.ts`) is the single entry point the chat route calls for uploads. It is constructed with `{ chatService, emit }` where `emit(hash, frame)` is a workspace-scoped WS fan-out callback the router provides.

- **rawId derivation** — `sha256(buffer).substring(0, 16)`. Stable across renames, so uploading the same content twice dedupes to the existing entry (`deduped: true` is returned and no background job is scheduled). Dedup is skipped when the existing entry is in `failed` state so the user can retry after fixing the root cause.
- **Staging (synchronous)** — `enqueueUpload(hash, { buffer, filename, mimeType })` writes `raw/<rawId>.<ext>` and updates `state.raw[rawId]` to `{ rawId, filename, mimeType, sizeBytes, status: 'ingesting', addedAt }` before returning. A `kb_state_update` frame is emitted for the stage.
- **Per-workspace FIFO queue** — A `Map<hash, Promise<unknown>>` chains background conversion jobs so a single workspace can only have one handler running at a time; different workspaces run in parallel. `waitForIdle(hash)` returns when the in-flight chain is exhausted (used by tests and by the delete path to avoid TOCTOU against a still-running handler).
- **Handler dispatch** — `pickHandler(filename, mimeType)` matches on extension first (`.pdf`→pdfHandler, `.docx`→docxHandler, `.pptx`→pptxHandler, passthrough-supported text/image extensions→passthroughHandler), then falls back to a MIME-type map. Unknown files throw `UnsupportedFileTypeError` from `ingestFile`, which the orchestrator catches and records as `status: 'failed'` with a human-readable error message on `state.raw[rawId]`.
- **Conversion output** — Each handler writes into `converted/<rawId>/`:
  - `text.md` — extracted text (or image index) with an `# <filename>` header. PDF is a **thin index** of `## Page N` sections each containing a single `![Page N](pages/page-NNNN.png)` link — no extracted prose — because the pipeline now rasterizes pages at 150 DPI and lets the multimodal Digestion CLI read the images directly. DOCX is GFM-flavored markdown from pandoc (tables preserved) with a `## Embedded Media` block when media is present. PPTX has `## Slide N` sections with optional `### Speaker Notes` plus a `## Embedded Media` block. Passthrough preserves markdown as-is or wraps other text in a code fence tagged with the file extension.
  - `meta.json` — `{ rawId, handler, extractedAt, metadata }` where `metadata` is handler-specific (`pageCount`, `wordCount`, `slideCount`, `totalSlideCount`, `hiddenSlideCount`, `slidesToImagesRequested`, `slideImagesWarning`, `truncated`, `mediaCount`, …).
  - `media/` — copied embedded media (DOCX `word/media/`, PPTX `ppt/media/`, passthrough images). Text handlers that find no media omit the directory.
- **Completion** — On success the orchestrator sets `status: 'ingested'` and emits a `kb_state_update` frame. On failure it sets `status: 'failed'`, records the error string on the entry, and still emits a frame so the UI can surface the red status.
- **Cascade delete** — `deleteRaw(hash, rawId)` removes the raw file, the `converted/<rawId>/` directory (recursive), and the entry from `state.json`. Returns `true` if the entry existed, `false` otherwise. Throws `KbDisabledError` if KB is toggled off for the workspace.
- **WS fan-out** — The chat router instantiates `KbIngestionService` with an `emit` callback that walks `activeStreams` and, for every conversation whose workspace hash matches the frame, calls the WS module's `send`. The KB Browser is conversation-agnostic though, so it also polls `GET /workspaces/:hash/kb` every 1.5s while open to pick up changes even when no CLI stream is active in the target workspace.

**Format handlers (`src/services/knowledgeBase/handlers/`):**
- **`pdf.ts`** — Rasterizes each PDF page to a 150 DPI PNG using `unpdf`'s `renderPageAsImage` backed by a statically-imported `@napi-rs/canvas`. Files land under `converted/<rawId>/pages/page-NNNN.png` (zero-padded, 1-indexed). `text.md` is a **thin markdown index** — `# <filename>` plus one `## Page N\n\n![Page N](pages/page-NNNN.png)` section per page — deliberately stripped of any extracted text, because the previous pdfjs text path mangled tables and multi-column layouts in the same way mammoth mangled DOCX. The Digestion CLI (multimodal) is expected to follow the image links and reason about layout + tables visually. Per-page render failures are isolated (a single bad page doesn't kill the whole doc) and surfaced as a `_[Failed to rasterize this page.]_` placeholder in the index plus a `failedPages` metadata key. Metadata: `pageCount`, `renderedPageCount`, `rasterDpi` (always 150). Handler tag: `pdf/rasterized`. Media files are the list of rendered page images.
- **`docx.ts`** — Shells out to `pandoc` via the shared `runPandoc` helper (`--from=docx --to=gfm --extract-media=<outDir>/media --wrap=none <tempDocx>`). Pandoc is the only tool in the stack that preserves semantic tables from OOXML; the previous `mammoth`-based path collapsed tables into flat prose and broke downstream digestion quality. Handler buffers the upload to a temp `.docx`, runs pandoc, flattens pandoc's nested `media/media/` output into a single `media/` dir (rewriting markdown references with collision-safe basenames), and prepends `# <filename>`. Returns `handler: 'docx/pandoc'`. **Pandoc is required** — the route layer rejects `.docx` uploads pre-flight when `detectPandoc()` reports missing. Legacy `.doc` (OLE binary format) is unsupported end-to-end: the route returns a `400` with the message `Legacy .doc format is not supported. Please resave the document as .docx…`.
- **`pptx.ts`** — Uses `adm-zip` + `fast-xml-parser` (`removeNSPrefix: true`) to walk `ppt/slides/slide*.xml`, `ppt/notesSlides/notesSlide*.xml`, and `ppt/media/`. Writes `## Slide N` blocks with extracted text and optional `### Speaker Notes`. **Hidden slides** (those with `show="0"` on the `<p:sld>` root element) are filtered out during text extraction and the survivors are renumbered 1..N — this is required because LibreOffice's PDF export *also* skips hidden slides when rasterizing, so keeping them in the markdown with their original numbers would drift "Slide N" out of sync with `slides/slide-NNN.png` and attach notes/body to the wrong image. The metadata carries `slideCount` (visible), `totalSlideCount` (visible + hidden), and `hiddenSlideCount`, and a short `> **Note:** X of Y slides in this deck are marked hidden…` line is injected near the top of `text.md` whenever `hiddenSlideCount > 0` so downstream digestion sees the skip. When `convertSlidesToImages` is requested at ingestion time, the handler checks the cached `LibreOfficeStatus`; if unavailable, it records `slideImagesWarning` in metadata and injects a "Slide rasterization note" into `text.md` explaining LibreOffice is missing. When available, it shells out to `soffice --headless --convert-to pdf --outdir <tmp>` and then uses `unpdf`'s `renderPageAsImage` backed by a statically-imported `@napi-rs/canvas` (with a pre-built `CanvasFactory` passed to `getDocumentProxy` so pdfjs's internal auxiliary canvases also go through the native backend) to rasterize each slide into `slides/slide-NNN.png`. Canvas is a regular dependency (not an optional peer) since the same backend powers the new PDF rasterization path — no dynamic-import probe, no "install the optional peer dep" warning branch.
- **`passthrough.ts`** — Handles text types (`txt, md, json, yaml, csv, tsv, log, xml, html, ...`) and image types (`png, jpg, jpeg, gif, webp, svg, bmp, ico, tiff, heic`). Markdown is inlined verbatim under the filename header; other text gets wrapped in a code fence tagged with the extension. Files larger than 200 KB are truncated with a `Truncated at <n> bytes` marker and `metadata.truncated: true`. Images are copied into `media/` and the text is a single `![filename](media/filename)` reference. Exports `passthroughSupports(filename)` for the dispatcher.

**Multer configuration:** The `POST /kb/raw` route uses `multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024, files: 1 } }).single('file')`. The 200 MB cap is generous enough for real-world PPTX decks and media-heavy PDFs; the separate conversation-attachment endpoint keeps its smaller limit. Memory storage is required because the orchestrator needs to hash the buffer before touching disk (so dedup works and we never write a file the user already has). Multer errors (file-too-large, etc.) are wrapped in a JSON-returning middleware shim so the KB Browser surfaces a useful message instead of an HTML 500 — `LIMIT_FILE_SIZE` becomes `400 { error: "File exceeds the 200 MB upload limit." }`.

#### Migration

On first startup after upgrade, `initialize()` detects legacy `conversations/` directory:
1. Reads all conversation JSON files, groups by workspace
2. Writes workspace index + session files to `workspaces/{hash}/`
3. Renames old dirs to `*_backup/`

### 4.2 Backend Adapter System

The CLI backend layer uses a **pluggable adapter pattern**. New CLI tools can be added without modifying routes, chat service, or frontend.

#### BaseBackendAdapter (`src/services/backends/base.ts`)

Abstract base class. Every backend must implement:
- **`get metadata`** — returns `{ id, label, icon, capabilities, models? }` where capabilities: `{ thinking, planMode, agents, toolActivity, userQuestions, stdinInput }` (all booleans). `models` is an optional array of `{ id, label, family, description?, costTier?, default?, supportedEffortLevels? }` for backends that support model selection. `supportedEffortLevels` is an optional `('low' | 'medium' | 'high' | 'max')[]`; omit it when the model does not support adaptive reasoning effort.
- **`sendMessage(message, options)`** — returns `{ stream, abort, sendInput }` where `stream` is an async generator yielding events matching the stream event contract in Section 3. `options` includes `{ sessionId, conversationId, isNewSession, workingDir, systemPrompt, externalSessionId, model?, effort? }`. `conversationId` is the stable conversation ID (does not change on session reset) — used by backends like Kiro that key long-lived processes by conversation. `model` is the model alias or ID to use for this invocation (backends that don't support model selection ignore it). `effort` is the adaptive reasoning level for this turn; backends ignore it when the selected model doesn't declare the requested level in `supportedEffortLevels`.
- **`generateSummary(messages, fallback)`** — returns a one-line summary string
- **`generateTitle(userMessage, fallback)`** — returns a short conversation title. Base class provides a default that truncates the user message to 80 chars.
- **`shutdown()`** — called during server shutdown. Override to kill long-lived processes. No-op by default.
- **`onSessionReset(conversationId)`** — called when user resets a session. Override to clean up per-conversation state. No-op by default.
- **`extractMemory(workspacePath)`** — returns a `MemorySnapshot` for the backend's native memory system, or `null` if unsupported / no memory exists. Called by `ChatService.captureWorkspaceMemory` on session reset. Base class returns `null`.
- **`getMemoryDir(workspacePath)`** — resolves the absolute path to the backend's native memory directory for a workspace, without reading contents. Returns `null` when the backend has no memory system or no memory directory exists yet. Used by the real-time `MemoryWatcher` to know which directory to watch. Subclasses that implement `extractMemory` should also implement this. Base class returns `null`.

#### Shared Tool Utilities (`src/services/backends/toolUtils.ts`)

Shared helpers used by all backend adapters. Extracted for cross-adapter reuse — adapters import from here, never from each other.

- `sanitizeSystemPrompt(prompt)` — strips control characters, truncates to 50K max
- `isApiError(text)` — detects `API Error: NNN` patterns
- `shortenPath(filePath)` — truncates long paths to `.../{last}/{two}`
- `extractToolOutcome(toolName, content)` — classifies tool results as success/error/warning
- `extractToolDetails(block)` — converts Claude Code tool_use blocks into ToolDetail objects
- `extractUsage(event)` — normalizes usage/cost data into UsageEvent

#### BackendRegistry (`src/services/backends/registry.ts`)

- `register(adapter)` — stores by `metadata.id`. First registered becomes default. Validates `instanceof BaseBackendAdapter`.
- `get(id)` — returns adapter or `null`
- `list()` — returns metadata array
- `getDefault()` — returns first registered or `null`
- `shutdownAll()` — calls `shutdown()` on all registered adapters (used in graceful server shutdown)

#### ClaudeCodeAdapter (`src/services/backends/claudeCode.ts`)

**Metadata:** `id: 'claude-code'`, all capabilities enabled. Exposes `models` array with `opus`, `sonnet` (default), `haiku`, `opus[1m]`, and `sonnet[1m]` options using aliases so they auto-resolve to the latest version. Adaptive reasoning effort support (`supportedEffortLevels`):
- `opus`, `opus[1m]`: `['low', 'medium', 'high', 'max']` — the `max` level is Opus-only
- `sonnet`, `sonnet[1m]`: `['low', 'medium', 'high']`
- `haiku`: field omitted (no effort support)

**`sendMessage(message, options)`:**
- `options`: `{ sessionId, isNewSession, workingDir, systemPrompt, model?, effort? }`
- Returns `{ stream, abort, sendInput }`
- `abort()` sends SIGTERM to CLI process
- `sendInput(text)` writes to stdin (safe after abort)
- Per-request state: each call creates its own `state` object (no shared mutable state)
- Guards the `--effort` flag: only forwards it when the model declares the requested level in `supportedEffortLevels`. This protects against stale conversation state after a model swap.

**CLI invocation:**
```bash
claude --print \
  --permission-mode bypassPermissions \
  --output-format stream-json \
  --verbose \
  [--model <alias|id>]              # if model specified (e.g. opus, sonnet, haiku)
  [--effort <level>]                # if effort specified AND model supports that level
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

#### KiroAdapter (`src/services/backends/kiro.ts`)

**Metadata:** `id: 'kiro'`, capabilities: `thinking: true, planMode: false, agents: true, toolActivity: true, userQuestions: false, stdinInput: false`. Exposes dynamic `models` array populated from `session/new` response (undefined until first session). Deprecated (`[Deprecated]`) and internal (`[Internal]`) models are filtered out.

**Integration protocol:** ACP (Agent Client Protocol) — JSON-RPC 2.0 over stdin/stdout via `kiro-cli acp`.

**Model selection:** After session setup (`session/new` or `session/load`), calls `session/set_model({ sessionId, modelId })` if `options.model` is set. Non-fatal — continues with default model on failure. Model can be changed mid-session without process restart (unlike Claude Code).

**ACP process lifecycle:** Lazy spawn + idle timeout + transparent recovery.
- First message → spawn `kiro-cli acp` → `initialize` handshake → `session/new(cwd)` → `[session/set_model]` → `session/prompt`
- Subsequent messages → reuse process → `[session/set_model]` → `session/prompt`
- Idle timeout (configurable via `KIRO_ACP_IDLE_TIMEOUT_MS` env var, default 10 min) → kill process
- Next message after timeout → respawn → `initialize` → `session/load(sessionId, cwd)` → `session/prompt`

**Session mapping:** Agent Cockpit session IDs map to Kiro ACP session IDs via in-memory `sessionMap`. Persisted via `externalSessionId` on `SessionEntry` for server restart resilience.

**Tool name normalization:** Kiro uses lowercase tool names (`read`, `shell`, `delegate`, etc.). The adapter normalizes to Agent Cockpit display names (Read, Bash, Agent, etc.) via `extractKiroToolDetails()`.

**Thinking tool:** Kiro's `thinking` tool is special-cased — output is emitted as `ThinkingEvent` (displayed in thinking UI) rather than `ToolActivityEvent`.

**Permission handling:** All `session/request_permission` messages are auto-approved with `allow_always`.

**Usage tracking:** Kiro's `_kiro.dev/metadata` notifications are parsed for `credits` (accumulated) and `contextUsagePercentage` (snapshot, overwritten each update). These are persisted on the conversation and session `Usage` objects but **excluded from the daily usage ledger** — Kiro's credit-based billing is not comparable with token-based backends. The frontend header displays credits and context % instead of tokens when the conversation backend is `kiro`.

**`generateSummary` / `generateTitle` / `runOneShot`:** Uses `kiro-cli chat --no-interactive --trust-all-tools` for one-shot LLM calls with 30s/60s timeout. Falls back gracefully if kiro-cli is not installed or not authenticated. kiro-cli always emits ANSI colour codes plus a fixed "trust all tools" warning header, a `> ` prompt prefix, and a `▸ Credits: X • Time: Ys` footer — it ignores `NO_COLOR` and `TERM=dumb`. Raw output is therefore routed through `parseKiroChatOutput()` which strips the ANSI escape sequences, the header (via the stable URL-fragment marker), the single leading `> ` prefix, and the credits footer, returning only the answer body. This prevents garbage like `[38;5;141m> [0mAsking about a number` from leaking into conversation titles or Memory MCP note parsing.

#### Adding a New Backend

1. Create `src/services/backends/myBackend.ts` extending `BaseBackendAdapter`
2. Implement `metadata`, `sendMessage()`, `generateSummary()`, and optionally `generateTitle()`, `shutdown()`, `onSessionReset()`
3. Import shared helpers from `toolUtils.ts` (never import from another adapter)
4. Register in `server.ts` — no other changes needed
5. Use the generic `externalSessionId` field on `SessionEntry`/`SendMessageOptions` if the backend manages its own session IDs

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
  8. Delegates to `_launchRestartScript()` (shared with `restart()` below)
- `restart({ hasActiveStreams })` — plain server restart (no git pull / npm install / interpreter verification). Applies the same concurrent + active-streams guards as `triggerUpdate()`, then calls `_launchRestartScript()`. Used by the Server tab in Global Settings so users can re-trigger startup-time detection (e.g. pandoc) after installing external binaries.
- `_launchRestartScript()` (private) — writes `data/restart.sh` (sets PATH to `node_modules/.bin`, sleeps 2s, `pm2 delete` + `pm2 start` against `ecosystem.config.js`), then launches it via double-fork (`nohup ... &` in subshell) to survive PM2 treekill. Output logged to `data/update-restart.log`. Shared by `triggerUpdate()` and `restart()`.

Both `triggerUpdate()` and `restart()` return `{ success, steps: [{ name, success, output }] }`. On failure, includes `error` field.

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
| `KIRO_ACP_IDLE_TIMEOUT_MS` | No | `600000` | Idle timeout (ms) before killing the Kiro ACP process |
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

**`requireAuth` middleware:** Localhost passes through without auth. Otherwise requires `req.isAuthenticated()`. For unauthenticated requests to `/api/*` paths, responds with `401 { error: "Not authenticated" }` as JSON (so client `fetch` callers can handle it without trying to parse an HTML login page). All other unauthenticated requests are redirected to `/auth/login`.

**Frontend session-expired handling:** When any API request returns `401`, `chatFetch` / `fetchCsrfToken` / the streaming send path each call `chatShowSessionExpired()` (in `public/js/state.js`), which renders a modal overlay (`#chat-session-expired-overlay`) with a "Sign in again" button pointing at `./auth/login`. The overlay is idempotent — calling it repeatedly does not stack overlays. Drafts are preserved by existing `draftState.js` localStorage persistence and survive the sign-in redirect.

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

**Files:** `public/index.html`, `public/js/*.js` (11 ES modules), `public/styles.css`

Vanilla JavaScript SPA — no framework, no bundler, no build step. Frontend is split into native ES modules (`<script type="module">`) loaded from `public/js/main.js`. Uses marked (CDN) for Markdown and highlight.js (CDN) for syntax highlighting. Shared mutable state lives in a single `state` object exported from `state.js`. Circular dependencies between modules are avoided via late-binding callback patterns (e.g. `setStreamEventHandler()` in `websocket.js`). Functions called from inline `onclick` in dynamically generated HTML are assigned to `window` in `main.js`. (Backend is TypeScript; frontend remains vanilla JS.)

### Layout

- Flexbox: sidebar (fixed 280px) + main area (flex: 1)
- Sidebar: new chat button, search, conversation list grouped by workspace, settings, sign out, version label
- Main area: header with title + usage indicator + action buttons, messages container, input area with backend selector + model selector + effort selector + file chips + textarea
- Responsive: below ~768px sidebar overlays content

### Conversation Management

- **New conversation:** folder picker modal (via `/browse` API) → user selects directory → POST creates conversation with the user's `defaultBackend` and `defaultModel` from settings
- **Sidebar list:** grouped by workspace (last 2 path segments of `workingDir`), sorted by `updatedAt` desc. Groups are collapsible (state in localStorage). Each group header has a pencil icon for workspace instructions.
- **Context menu:** right-click on conversation items for rename/archive/delete (active view) or restore/delete (archive view)
- **Archive:** conversations can be archived via context menu. Archived conversations are hidden from the main sidebar but all files (sessions, artifacts) remain on disk. A toggle at the bottom of the sidebar switches between active and archived views. Archived conversations can be browsed, searched, restored, or permanently deleted.
- **Search:** debounced, case-insensitive search across titles, last messages, and full content. Respects active/archive view filter.

### Messaging & Streaming

- `chatSendMessage()` gathers completed file paths from pending uploads, appends `[Uploaded files: ...]` to content, opens WebSocket, POSTs message (with `backend`, `model`, and `effort`), receives stream events via WS. When the selected backend, model, or effort differs from the stored defaults, it auto-saves the new choice via `PUT /settings` (fire-and-forget) so future new conversations use it. `defaultEffort` only persists to settings when the chosen model matches the stored `defaultModel`, preventing a mid-flight model swap from clobbering the settings-level default.
- Streaming uses `fetch` with manual ReadableStream parsing (not EventSource API)
- **Streaming state persistence:** `chatStreamingState` Map stores per-conversation state (accumulated text, thinking, tools, agents, tool/agent history, pending interactions). State survives conversation switches — on return, the streaming bubble is recreated and restored.
- **WebSocket auto-reconnect:** On unexpected WS close during streaming, the client automatically attempts reconnection with exponential backoff (1s base, up to 5 attempts). On reconnect, the server replays buffered events wrapped in `replay_start`/`replay_end`. The client resets streaming state on `replay_start` (clears accumulated text/thinking/tools) and reprocesses replayed events from scratch. `assistant_message` events are deduplicated by message ID. `done` events during replay are ignored to prevent stale streams from destroying the current streaming state. After max attempts exhausted, `_doneResolve` is called to clean up. `chatDisconnectWs()` clears reconnect attempts to prevent auto-reconnect on deliberate close. Session reset clears the server-side event buffer to prevent stale events from replaying into the new session.
- **Streaming avatar:** The streaming message bubble reads the backend from the `chat-backend-select` dropdown (not from `state.chatActiveConv.backend`) to ensure the correct icon is shown immediately when the user switches backends, even before the conversation object is updated.
- **Elapsed timer:** live timer in streaming bubble header, self-cleans on DOM disconnect and nulls out the interval reference so it can restart on conversation switch-back
- **Unified streaming content:** A single `chatUpdateStreamingContent()` function renders all streaming state (thinking, text, tool history, active tools, agents, plan mode) together in one stacked view. Text content and tool activity accumulate and remain visible simultaneously — new progress updates stack below previous content rather than replacing it. Items are grouped by agent via `chatGroupItemsByAgent()`: standalone tools render flat, while each agent card is followed by a scrollable sub-activity panel showing its child tools. Completed items show checkmarks and elapsed durations; running agents show animated spinners with live timers that count up in real-time.
- **Tool activity on completed messages:** When a message has a `toolActivity` array, `chatRenderToolActivityBlock()` renders a collapsible `<details>/<summary>` block (same pattern as thinking blocks) with a summary line (e.g. "15 ops · 2 agents · 5 read, 2 edited") generated by `chatBuildActivitySummary()`. Collapsed by default; expands to show the full chronological tool/agent list. Agent entries render as agent cards, tool entries as history items.
- **Tool outcome indicators:** Each tool/agent in the activity log shows a colored outcome badge when outcome data is available. `chatRenderStatusCheck()` renders status-colored checkmarks (green ✓ for success, red ✗ for error, amber ✓ for warning). `chatRenderOutcomeBadge()` renders a small colored badge with the outcome text (e.g. "exit 0", "4 matches", "not found"). Outcomes are extracted from CLI `tool_result` blocks by `extractToolOutcome()` in the backend, correlated by `tool_use_id`, and persisted on the `toolActivity` entries.
- **Sticky active section:** During streaming, when both completed and running tools exist, a `chat-activity-panel` container wraps them: completed items scroll in a bounded area while running items with spinners stay pinned at the bottom, always visible.
- **Parallel group indicator:** `chatGroupParallelItems()` detects consecutive agent entries whose `startTime` values are within 500ms (`PARALLEL_THRESHOLD_MS`) and wraps them in a `chat-parallel-group` container with a "parallel" label and a left accent border. Works in both persisted activity blocks and streaming display.
- **Agent detail expansion:** Agent cards with long descriptions or outcome data render as expandable `<details>` elements (`chatRenderAgentCard()`). Summary shows agent type, description, outcome badge, and elapsed time; expanding reveals full outcome details.
- **Turn boundaries:** intermediate assistant messages saved, content reset. `turn_complete` event archives active tools/agents to history so spinners stop. On `assistant_message`, tool/agent history is cleared after archiving — the saved message's `toolActivity` now owns those entries, preventing duplicates when the next turn adds new agents to the streaming bubble. Agents are only archived when they have received their `tool_outcomes` (outcome/status set) — sub-tool `turn_complete` events within an agent do NOT prematurely archive the parent agent. This ensures agents show spinners and live timers throughout their full execution.
- **Post-completion processing indicator:** When all tools/agents have completed but the model is still working (no text content yet), a "Processing..." indicator with typing dots is shown below the completed activity log. This fills the gap between agent completion and text output, so users always see ongoing work.
- **Thinking events:** do NOT archive active tool/agent state — `turn_complete` handles archiving. This prevents premature archiving that would kill agent spinners and timers.
- **Plan approval:** renders plan as markdown with approve/reject buttons → sends `{ type: 'input', text: 'yes'|'no' }` via WebSocket
- **User questions:** renders question text + option buttons → sends answer via WebSocket `input` frame
- **Auto title update:** handles `title_updated` event by updating the active conversation title, the header, and the sidebar list in-place (no full reload needed).
- **Usage display:** a small indicator in the conversation header shows **session-level** token count and USD cost. Updated in real-time when `usage` events arrive during streaming. Displays on hover a tooltip with session input/output/cache token breakdown and cost, plus conversation-level totals. Hidden when no usage data exists (e.g. new conversation). For **Kiro** conversations, shows credits consumed and context usage percentage instead of tokens/cost.
- **Stream cleanup:** `chatCleanupStreamState()` accepts `{ force }` option. The `finally` block uses `force: true` to ensure cleanup even when a pending interaction was never resolved. Interaction response handlers also use forced cleanup when the stream has already ended.
- **Send button state:** shows stop (■) when streaming with no text input, send (↑) when idle or when streaming with text input (to queue). Disabled during uploads or session resets.
- **Message queue:** Users can compose and submit messages while the CLI is actively responding. Queued messages are stored client-side in `chatMessageQueue` (Map of convId → array of `{ id, content, inFlight }`) and **persisted server-side** as `messageQueue` (array of content strings) on the conversation entry. On every queue mutation (add, edit, delete, shift, clear), a sequential coalescing PUT syncs the current state to the server — at most one PUT in flight at a time, with a follow-up if mutations occur during the request. Queued messages appear inline in the chat after the streaming bubble, styled as user messages with reduced opacity and an accent left border. Each shows a "Queued" badge and has Edit and Delete buttons. In-flight messages show "Sending..." and cannot be edited or deleted. When a response completes successfully, the next queued message is automatically sent (FIFO). Queue has three states: **Active** (streaming, auto-execute on completion), **Paused** (error, banner with Resume/Clear), and **Suspended** (restored from server after page load). The `chatQueuePaused` Set tracks paused conversations; `chatQueueSuspended` tracks restored conversations. On loading a conversation with a non-empty persisted queue and no active stream, the queue is restored into client state and marked suspended. A banner reads "N queued messages from a previous session" with Resume and Clear buttons. Suspended queues do not auto-execute — the user must explicitly resume. Queue is automatically cleared on session reset and archive.

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

- **Reset:** archives active session with LLM summary, creates new session, resets conversation title to "New Chat" in both header and sidebar. Shows an "Archiving session..." indicator bubble branded with the Agent Cockpit logo and name (not the CLI backend icon, since archival is a cockpit-level action). Blocked during streaming. Double-click prevented via `chatResettingConvs` set. Header title is also synced from server data whenever the conversation list reloads (via `chatLoadConversations`), ensuring the header stays consistent even if the inline update is missed. `chatLoadConversations` uses a generation counter to discard stale responses, preventing race conditions where an older response overwrites a title that was already updated by a `title_updated` event. A final `chatLoadConversations()` call in the streaming `finally` block ensures the sidebar and header reflect the latest server state after streaming ends.
- **History modal:** lists sessions with summaries, view and download buttons
- **View session:** fetches archived messages from API

### Settings Modal

Tabbed layout with five tabs:

**General tab:**
- Theme: System / Light / Dark
- Send behavior: Enter or Shift+Enter
- System prompt textarea (global)
- Default backend selector (also auto-updated when user sends a message with a different backend)
- Default model selector (shown only when the selected backend has models; auto-updated with backend changes)
- **Default Effort selector** (shown only when the default model declares `supportedEffortLevels`; options are dynamically built from the model's supported list — e.g. Opus shows `low/medium/high/max`, Sonnet shows `low/medium/high`, Haiku hides the row entirely). Changing the default model to one without effort support drops `defaultEffort` on save.
- Working directory

**Usage Stats tab:**
- Time range filter: Today / This Week / This Month / All Time
- Per-backend usage table: input, output, cache read, cache write, total tokens, and cost
- Daily breakdown table (when multiple days selected): date, backend, tokens, cost
- "Clear All Data" button: clears the usage ledger (requires confirmation)
- Data loaded from `GET /usage-stats` endpoint

**Server tab:**
- **Restart Server** button: calls `POST /server/restart` which delegates to `UpdateService.restart()`. Same pm2 double-fork mechanism as self-update, without the git pull / npm install steps. Used to re-trigger startup-time binary detection (e.g. pandoc) after installing external tools. Confirms before firing; shows the existing restart overlay on success and reloads the page when the new pm2 process is back. `TypeError` / "Failed to fetch" during the in-flight POST is treated as success (the process died before the response flushed).

### Workspace Settings Modal

Triggered by the pencil icon on workspace group headers. Multi-tab modal:

- **Instructions tab:** per-workspace instructions textarea; fetches/saves via the workspace instructions API.
- **Memory tab:** enable/disable toggle (persists immediately to `WorkspaceIndex.memoryEnabled`), plus a read-only browser of the workspace memory snapshot grouped by type (User / Feedback / Project / Reference / Other). Each entry has an inline delete icon that calls `DELETE /workspaces/:hash/memory/entries/:relpath`. Below the browser is a **Clear all memory** button that calls `DELETE /workspaces/:hash/memory/entries` (bulk) after a confirmation dialog — wipes every entry for the workspace but leaves the enabled flag untouched.
- **Knowledge Base tab:** enable/disable toggle (persists immediately to `WorkspaceIndex.kbEnabled`). When enabled, the workspace-group header in the sidebar shows a dedicated **KB** button (next to the existing pencil icon) that opens the full-screen KB Browser — the browser replaces the chat message area rather than living inside the modal.

### Knowledge Base Browser

The **KB Browser** is a full-screen panel that swaps into the main chat area (hiding the active conversation) when the user clicks the **KB** icon on a workspace-group header in the sidebar. It is implemented inline in `public/js/main.js` — look for the `chatKbBrowser*` functions.

- **Entry point:** `chatKbBrowser.chat-conv-group-kb-btn` click handler (wired in `chatWireEvents`) reads `data-kb-hash` and `data-kb-label` off the button and calls `chatOpenKbBrowser(hash, label)`. The button is only rendered for workspace groups that have a real hash **and** whose `workspaceKbEnabled` flag is `true` (so the "ungrouped" placeholder never gets one, and workspaces with KB disabled in settings don't advertise an entry point). The flag is sourced from `ConversationListItem.workspaceKbEnabled` in the sidebar payload; toggling KB on/off via the settings modal calls `chatLoadConversations()` so the sidebar button appears/disappears without a page reload.
- **Layout:** A `<div class="chat-kb-browser">` sibling of `#chat-messages` with a header (workspace label + close button), a tab row (**Raw** / Entries / Synthesis — only Raw is wired in PR 2), an upload drop zone, and a list body. Opening the browser hides `#chat-messages` and the input area; closing restores them.
- **Polling:** While the browser is mounted, `chatKbBrowserState.intervalId` runs `chatKbBrowserRefetch()` every **1500 ms** against `GET /workspaces/:hash/kb`. Polling is required because WS frames are conversation-scoped — the browser can be open for a workspace that has no active CLI stream. On close, the interval is cleared.
- **WS frame reactivity:** `streaming.js` dispatches `kb_state_update` frames to `window.chatHandleKbStateUpdate(convId, event)`. The handler checks whether the browser is open for the same workspace hash and, if so, triggers an immediate refetch (in addition to the polling cadence) so changes during active CLI streams render without waiting for the next poll tick.
- **Raw tab:** Lists every `state.raw` entry sorted by `addedAt` desc. Each row shows filename, size (pretty-printed), relative "added at" ("just now" / "5 min ago" / "2 h ago" / absolute date), a colored status badge (`ingesting | ingested | digesting | digested | failed`), a **Download** link (anchor pointing at `GET /workspaces/:hash/kb/raw/:rawId`), and a **Delete** button. Failed rows expand to show the error message from the state entry. An upload dropzone at the top accepts drag-and-drop or click-to-browse and POSTs the file via `chatKbUploadFile()` (multipart form-data with CSRF header); the row appears on the next refetch in `ingesting` state and flips to `ingested` once the background conversion finishes.
- **Delete:** Clicking a row's Delete button confirms and then sends `DELETE /workspaces/:hash/kb/raw/:rawId`. On success the row disappears on the next refetch.
- **Download:** The Download link is a plain `<a href="/api/chat/workspaces/:hash/kb/raw/:rawId" target="_blank">` — the server sets `Content-Disposition: inline` so the browser either previews or downloads based on MIME type.

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

**Framework:** Jest 30.x — run with `npm test`. The script is `node --experimental-vm-modules node_modules/.bin/jest` because the KB handler tests import `unpdf` (ESM-only, wraps `pdfjs-dist`) and Jest's VM needs the flag to allow runtime `import()` calls.

| File | Focus |
|------|-------|
| `test/toolUtils.test.ts` | Shared backend helpers: extractToolDetails, extractToolOutcome, extractUsage, shortenPath, sanitizeSystemPrompt, isApiError |
| `test/backends.test.ts` | BaseBackendAdapter (including generateTitle, getMemoryDir + extractMemory default null), BackendRegistry (including shutdownAll), ClaudeCodeAdapter (metadata models including `supportedEffortLevels` per model, --model flag passthrough, --effort flag passthrough with silent drop when the selected model does not support the requested level, Opus-only `max` enforcement, Haiku effort drop, --mcp-config passthrough from `mcpServers` option and omission when absent, extractMemory with frontmatter parsing and `~/.claude/projects` path resolution, git worktree canonicalization to main repo memory, getMemoryDir path resolution including empty/missing/sanitized/worktree-canonical cases), parseFrontmatter helper, resolveCanonicalWorkspacePath helper, mcpServersToClaudeConfigJson (ACP env-array to Claude Code env-object shape transform, omitted env key, multiple servers, missing args coercion) |
| `test/kiroBackend.test.ts` | KiroAdapter metadata (including dynamic models, deprecated/internal filtering, model family detection), lifecycle (shutdown, onSessionReset), extractKiroToolDetails tool name normalization, generateSummary/generateTitle fallbacks, parseKiroChatOutput (ANSI stripping, header/footer/prompt-prefix removal, markdown blockquote preservation, format-drift safety) |
| `test/chat.test.ts` | Chat routes: WebSocket streaming (text, tool_activity, stdin input, abort, assistant_message), WebSocket reconnection (replay buffered events, CLI survives disconnect, CLI crash buffers error, abort clears buffer, session reset clears buffer), turn boundaries, turn_complete event forwarding, tool activity persistence, parallel agent persistence, session overview aggregation, auto title update on session reset, usage event forwarding and persistence (including sessionUsage), usage stats endpoints (GET/DELETE), file upload/serve, workspace instructions, workspace context injection (discussion history pointer on new sessions, memory pointer on new sessions when memory is enabled, no memory pointer when memory is disabled, neither pointer on resumed sessions, memory content never leaks into the system prompt), workspace memory GET endpoint (empty returns `{enabled:false, snapshot:null}`, unknown workspace returns same empty shape, saved snapshot returned with `claude/` filenames), PUT `/memory/enabled` toggle round-trip and non-boolean rejection, DELETE `/memory/entries/:relpath` including path-traversal rejection, DELETE `/memory/entries` bulk clear (returns deleted count and empty snapshot, no-op returns 200 with `deleted: 0`), `memory_update` WS frame (first capture lists all files, second capture only diffs, no frame when adapter has no memory dir — gated on `setWorkspaceMemoryEnabled`), workspace knowledge base GET endpoint (returns `{enabled:false, state:<empty scaffold>}` when KB disabled, `{enabled:true, state:<persisted scaffold>}` when enabled, 404 for unknown workspace), PUT `/kb/enabled` toggle round-trip, non-boolean rejection, 404 for unknown workspace, Memory independence (toggling KB does not touch `memoryEnabled` and vice versa), `POST /workspaces/:hash/kb/raw` multipart upload (202 happy path staging an `ingesting` entry then reaching `ingested` after `waitForIdle`, 400 `KB disabled` when toggle is off, unsupported file extensions surface as `failed` with error on the state entry, 400 pre-flight rejection of legacy `.doc` with a "resave as .docx" message and no raw entry created, 400 pre-flight rejection of `.docx` uploads when pandoc is unavailable — verified hermetically by pointing PATH at an empty dir and resetting the pandoc detection cache — with an install hint that includes the pandoc.org URL), `DELETE /workspaces/:hash/kb/raw/:rawId` (cascade removal of raw file + converted dir + state entry, 404 for unknown rawId), `GET /workspaces/:hash/kb/raw/:rawId` (streams bytes with the stored mimeType, 400 for malformed rawIds, 404 for unknown rawIds), `GET /kb/libreoffice-status` shape (boolean `available`, nullable `binaryPath`, string `checkedAt`, availability/binaryPath consistency), archive/restore endpoints, message queue persistence (GET/PUT/DELETE, included in conversation response, cleared on reset/archive), model passthrough (explicit model, stored model, model update), effort passthrough (explicit effort on send, silent downgrade when model switch drops `max`, stored effort reused on subsequent sends) |
| `test/knowledgeBase.handlers.test.ts` | Per-format KB handlers: **pdfHandler** (real fixture in `test/fixtures/kb/sample.pdf` — rasterizes each page to `pages/page-NNNN.png`, asserts the PNG magic bytes on disk, the `## Page N`/`![Page N](…)` sections in the thin markdown index, the absence of any extracted prose, `handler='pdf/rasterized'`, and `pageCount`/`renderedPageCount`/`rasterDpi:150` metadata; the `wordCount` key is asserted undefined because we no longer extract text), **docxHandler** (stubs `runPandoc` via `jest.spyOn` on the pandoc module — happy path with simulated `--extract-media` output verifies flattened media layout, collision-safe rename, GFM table preservation, `media/media/...` reference rewriting, `docx/pandoc` handler tag, and argument shape; no-media branch; and a rejection branch verifying pandoc errors propagate so the orchestrator can mark the entry failed), **pptxHandler** (slide text, speaker notes, embedded media, `slideCount`/`slidesToImagesRequested` metadata; a hermetic hidden-slide test that synthesizes a 3-slide in-memory pptx with `show="0"` on slide 2 and asserts that only 2 slides are emitted, renumbered 1..2, with `slideCount=2`, `totalSlideCount=3`, `hiddenSlideCount=1`, and a `"1 of 3 slides … hidden"` note in the markdown; plus a hermetic "LibreOffice missing" test that sets PATH to an empty dir and resets the detection cache to force the fallback warning path), **passthroughHandler** (markdown inlined, non-markdown text wrapped in a code fence, >200 KB truncation marker, image files copied into `media/` with an inline reference, `passthroughSupports` extension matrix), **dispatch** (`pickHandler` extension-first + MIME-fallback, `ingestFile` routes real fixtures through the right handler and returns the new rasterized PDF shape, `UnsupportedFileTypeError` for unknown extensions). |
| `test/knowledgeBase.ingestion.test.ts` | `KbIngestionService` end-to-end against a real `ChatService`: `enqueueUpload` rejects with `KbDisabledError` when KB is off, stages a text file (raw on disk, `ingesting` entry, `kb_state_update` frame emitted) and transitions to `ingested` after `waitForIdle` with `text.md`/`meta.json` written under `converted/<rawId>/`, dedupes identical content across two different filenames (second upload returns `deduped: true` and no second entry), marks unsupported file types as `failed` with a clear error message. `deleteRaw` cascades (raw file + converted dir + state entry all removed, single `kb_state_update` frame emitted), returns `false` for unknown rawIds, and raises `KbDisabledError` when KB is off. |
| `test/chatService.test.ts` | ChatService CRUD, messages (including toolActivity persistence), sessions, generateAndUpdateTitle, archive/restore (flag set/remove, file preservation, list filtering, search filtering, delete-after-archive), usage tracking (addUsage with conversationUsage/sessionUsage, usageByBackend, daily ledger with backend+model dimensions, model separation, getUsage, getUsageStats, clearUsageStats, Kiro credits accumulation, contextUsagePercentage snapshot, skipLedger option), model selection (create with model, updateConversationModel, listConversations model), effort selection (create with effort, silent downgrade when requested level is unsupported, fallback to highest supported level, updateConversationModel downgrades stored effort, updateConversationEffort set/clear, listConversations includes effort), workspace storage, workspace memory (save under `files/claude/`, re-capture replaces only the `claude/` subtree while preserving `notes/`, `addMemoryNoteEntry` writes to `notes/` and refreshes snapshot, `deleteMemoryEntry` removes files and rejects path traversal, `clearWorkspaceMemory` wipes both `claude/` and `notes/` and is a no-op when empty and preserves `memoryEnabled`, `getWorkspaceMemoryEnabled` defaults to false and persists after `setWorkspaceMemoryEnabled`, `getWorkspaceMemoryPointer` returns null when memory disabled or hash empty, returns bracketed block with absolute `memory/files/` path when enabled, creates the files dir on first access, get/captureWorkspaceMemory including adapter stub happy path, no-memory fallback, and extraction errors), workspace knowledge base (`getWorkspaceKbEnabled` defaults to false and persists after `setWorkspaceKbEnabled`, KB toggle is independent of Memory toggle, `getOrInitKbState` returns in-memory empty scaffold when KB disabled (not persisted), persisted empty scaffold on first call when KB enabled, returns null for unknown workspace, `saveKbState`/`getKbState` round-trip with `updatedAt` bump, `getWorkspaceKbPointer` returns null when KB disabled or hash empty, returns bracketed block with absolute `knowledge/` path when enabled, creates the `entries/` dir on first access), migration, markdown export |
| `test/memoryWatcher.test.ts` | MemoryWatcher: watch/unwatch/unwatchAll lifecycle, idempotence, rejects missing dirs and file paths, detects .md create/update, ignores non-.md files, debounces rapid bursts into a single callback, re-fires after debounce window closes, cancels fire when unwatched mid-debounce, multi-key independence, swallows sync + async onChange errors without crashing |
| `test/memoryMcp.test.ts` | Memory MCP server factory: `issueMemoryMcpSession` mints unique tokens with an `mcpServers` array pointing at the stub (correct command/args/env including `MEMORY_TOKEN` and `MEMORY_ENDPOINT`), reissuing a session for the same conversation revokes the previous token; `extractMemoryFromSession` returns 0 when memory is disabled (no CLI call), returns 0 when CLI returns `NONE`, parses a single frontmatter entry and saves it under `source: session-extraction`, parses a multi-entry `===`-delimited response and saves all entries, swallows runOneShot errors/empty responses and returns 0 |
| `test/draftState.test.ts` | Draft save/restore, key migration, cleanup, round-trip |
| `test/messageQueue.test.ts` | Message queue: adding, deleting, rendering, in-flight protection, pause/resume, per-conversation isolation, send button state, suspended (restored) state |
| `test/graceful-shutdown.test.ts` | Server shutdown on SIGINT/SIGTERM |
| `test/sessionStore.test.ts` | Session file-store persistence |
| `test/updateService.test.ts` | Version comparison, status, trigger guards, interval management, interpreter verification, PATH setup for restart, plus standalone `restart()` method (in-progress/active-streams guards, script + double-fork shape, does not call git/npm) |
| `test/auth.test.ts` | `requireAuth` middleware: unauthenticated `/api/*` returns JSON 401, unauthenticated non-API paths redirect to `/auth/login`, authenticated passthrough, localhost bypass for both API and non-API paths |

### CI/CD

**Test workflow** (`.github/workflows/test.yml`): Runs on PRs to `main`. Steps: checkout, Node.js 18 setup, `npm ci`, `npm test`.

**Version bump** (`.github/workflows/version-bump.yml`): Runs on push to `main`. Skips `chore: bump version` commits. Steps: `npm version patch --no-git-tag-version`, commit, tag, push.
