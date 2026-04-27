# 2. Data Models & File Structure

[← Back to index](SPEC.md)

---

## File Structure

```
agent-cockpit/
├── server.ts                           # Express server entry point (TypeScript, run via tsx)
├── tsconfig.json                       # TypeScript configuration (strict mode, noEmit)
├── docs/                               # Specification wiki (split from root SPEC.md)
│   ├── SPEC.md                         # Index + overview
│   ├── spec-data-models.md             # This file
│   ├── spec-api-endpoints.md           # REST + WebSocket API surface
│   ├── spec-backend-services.md        # ChatService, adapter system, KB pipeline, update service
│   ├── spec-server-security.md         # Config, startup order, auth, CSRF, CSP
│   ├── spec-frontend.md               # SPA architecture, streaming, KB browser, settings
│   ├── spec-deployment.md             # Markdown export, known limitations, deployment
│   └── spec-testing.md                # Test suite, test files, CI workflows
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
│       │   ├── kiro.ts                 # Kiro adapter — ACP (Agent Client Protocol) over kiro-cli
│       │   ├── toolUtils.ts            # Shared tool helpers (extractToolDetails, extractUsage, etc.)
│       │   └── registry.ts             # BackendRegistry — maps IDs to adapter instances
│       ├── knowledgeBase/
│       │   ├── libreOffice.ts          # LibreOffice (soffice) detection cache
│       │   ├── pandoc.ts               # Pandoc detection + `runPandoc` subprocess helper
│       │   ├── ingestion.ts            # KbIngestionService: per-workspace FIFO queue, enqueueUpload, deleteRaw, waitForIdle
│       │   ├── db.ts                   # KbDatabase: per-workspace SQLite layer (better-sqlite3, WAL mode)
│       │   ├── digest.ts              # KbDigestionService: per-raw CLI digestion, entry parsing, stringifyEntry
│       │   ├── ingestion/
│       │   │   ├── pageConversion.ts   # convertImageToMarkdown: shared per-image AI helper (PDF, DOCX, PPTX, passthrough)
│       │   │   ├── pdfSignals.ts       # PDF per-page figure/table/text-extract signals for hybrid classification
│       │   │   ├── pptxSignals.ts      # PPTX per-slide figure/chart/table signals (regex over raw namespaced XML)
│       │   │   └── pptxSlideRender.ts  # LibreOffice + unpdf slide rasterization (extracted for jest.spyOn-based tests)
│       │   └── handlers/
│       │       ├── index.ts            # pickHandler dispatch + ingestFile + UnsupportedFileTypeError
│       │       ├── pdf.ts              # PDF page-by-page 150 DPI rasterization + hybrid pdfjs/AI per-page
│       │       ├── docx.ts             # DOCX → GFM markdown via pandoc + per-image AI description (hybrid)
│       │       ├── pptx.ts             # PPTX per-slide hybrid: XML extract / AI / image-only via signals + LO rasterization
│       │       └── passthrough.ts      # Text (md/txt/json/...) + image passthrough with media copy
│       ├── chatService.ts              # Conversation CRUD, messages, sessions
│       ├── settingsService.ts          # Settings I/O: read, write, legacy migration
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
    │   │   │   ├── state.db            # SQLite database (better-sqlite3, WAL mode, foreign_keys ON)
    │   │   │   ├── raw/<rawId>.<ext>   # Uploaded files, stored verbatim (rawId = sha256[:16])
    │   │   │   ├── converted/<rawId>/  # Ingestion output: text.md + meta.json + optional media/ (populated by PR 2 on upload)
    │   │   │   ├── entries/<entryId>/  # Digestion output directory (one dir per entry)
    │   │   │   │   └── entry.md        # YAML frontmatter + markdown body
    │   │   │   ├── digest-debug/       # Failed digestion debug dumps: <rawId>-<iso>.txt
    │   │   │   ├── synthesis/          # Dreaming output — materialized views from SQLite (regenerated after each dream run)
    │   │   │   │   ├── index.md        # Topic index table with entry/connection counts
    │   │   │   │   ├── connections.md  # Full connection graph table
    │   │   │   │   ├── topics/<id>.md  # Per-topic prose, related topics, entry list
    │   │   │   │   └── reflections/<reflection-id>.md  # Per-reflection markdown with YAML frontmatter + body
    │   │   │   ├── vectors/            # PGLite database directory (pgvector embeddings for entries + topics)
    │   │   │   ├── _dream_debug/       # Raw CLI outputs from persistent parse failures: parse-failure-<phase>-<iso>.txt
    │   │   │   └── _dream_tmp/         # Ephemeral staging files for dream prompts (auto-cleaned after run)
    │   │   └── {convId}/
    │   │       ├── session-1.json      # Archived session
    │   │       └── session-N.json      # Active session (updated every message)
    │   ├── artifacts/{convId}/         # Per-conversation uploaded files
    │   ├── settings.json               # User settings
    │   └── usage-ledger.json           # Daily per-backend token usage ledger
    └── sessions/                       # Express session JSON files (24h TTL)
```

## Workspace Hash

All workspace hashes throughout the system use: `SHA-256(workspacePath).substring(0, 16)` — a deterministic mapping from absolute workspace path to storage folder name.

## Persistence Durability

All mutable JSON files under `data/` are written with two primitives to survive concurrent access without corruption:

- **Atomic writes** — `src/utils/atomicWrite.ts` exports `atomicWriteFile(filePath, data, encoding='utf8')`. It writes to a sibling `.{base}.tmp.{pid}.{random}` file then calls `fs.rename` (POSIX-atomic), so readers always observe either the previous complete file or the new complete file — never a torn byte-interleaved mix. On rename failure the tmp file is removed. Used by `ChatService` (workspace `index.json`, session files, usage ledger, memory `snapshot.json`), `SettingsService`, `ClaudePlanUsageService`, and `KiroPlanUsageService`.
- **Per-key mutex** — `src/utils/keyedMutex.ts` exports `KeyedMutex.run<T>(key, fn)`. Callers sharing a key are serialized FIFO; different keys run concurrently. `ChatService` holds one `_indexLock` keyed by workspace hash (every read-modify-write on a workspace `index.json` runs inside `_indexLock.run(hash, ...)`) and one `_ledgerLock` keyed by the constant `'__usage_ledger__'` (wrapping ledger record/clear). Not reentrant — locked regions must not recursively acquire the same key.

Together these guarantee that a workspace index always parses on disk and that concurrent mutators do not clobber each other's updates. `ChatService._buildLookupMap` also catches per-workspace `JSON.parse` failures at startup, logs them, and continues, so a single corrupt file cannot crash the server into a restart loop.

## Workspace Index (`workspaces/{hash}/index.json`)

```javascript
{
  workspacePath: string,        // Absolute path to the workspace directory
  instructions: string,         // Per-workspace instructions (appended to system prompt on new sessions)
  memoryEnabled: boolean|undefined, // Opt-in per-workspace Memory feature. Defaults to false.
  kbEnabled: boolean|undefined,     // Opt-in per-workspace Knowledge Base feature. Defaults to false.
  kbAutoDigest: boolean|undefined,  // Auto-digest new files after ingestion. Defaults to false.
  kbEmbedding: {                    // Per-workspace embedding config (optional, Ollama-only)
    model?: string,                 // Ollama model name. Default 'nomic-embed-text'.
    ollamaHost?: string,            // Ollama server URL. Default 'http://localhost:11434'.
    dimensions?: number,            // Embedding dimensions (must match model). Default 768.
  } | undefined,
  conversations: [{
    id: string,                 // UUIDv4
    title: string,              // Auto-set from first user message (max 80 chars)
    backend: string,            // 'claude-code'
    model?: string,             // Full model ID (e.g. 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'); absent = backend default
    effort?: string,            // Adaptive reasoning effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; absent = model default. `xhigh` is Opus 4.7-only; `max` is Opus 4.6+ only. Silently downgraded when the current model doesn't support the stored level.
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
    unread: boolean|undefined,   // true when a response completed on this conversation while the user was viewing a different one. Cleared when the user selects the conversation. Toggled via PATCH /chat/conversations/:id/unread; absent for read conversations to keep the file lean.
    messageQueue: QueuedMessage[]|undefined, // Persisted follow-up message queue (typed — see below); absent when empty. Legacy `string[]` entries are auto-migrated on read.
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

## Session File (`workspaces/{hash}/{convId}/session-N.json`)

```javascript
{
  sessionNumber: number,
  sessionId: string,
  startedAt: string,
  endedAt: string|null,
  messages: Message[]
}
```

## Message

```javascript
{
  id: string,                   // UUIDv4
  role: string,                 // 'user' | 'assistant' | 'system'
  content: string,              // Message text
  backend: string,              // Backend that generated the response
  timestamp: string,            // ISO 8601
  thinking?: string,            // Extended thinking (assistant only, omitted if empty)
  turn?: string,                // Assistant only. 'progress' for intermediate segments saved
                                //   at a stream `turn_boundary` (agent still has more tool
                                //   work to do); 'final' for the last segment saved at
                                //   `done`. Absent on user/system messages and on legacy
                                //   assistant messages written before this field existed —
                                //   frontend treats absent as 'final' for back-compat.
                                //   Consumed by the chat renderer to collapse consecutive
                                //   progress messages into a single timeline card.
  toolActivity?: [{             // Tool/agent activity log (assistant only, omitted if empty).
                                //   Derived view of the tool blocks in `contentBlocks` when
                                //   that field is present; retained at top-level for
                                //   back-compat with session overview aggregation, search,
                                //   exports, and legacy messages written before
                                //   `contentBlocks` existed.
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
  }],
  contentBlocks?: ContentBlock[] // Assistant only. Ordered interleaving of text, thinking,
                                //   and tool blocks as the CLI emitted them, so the renderer
                                //   can display "text → tool → text → tool" in source order
                                //   instead of grouping all tools before all text. When
                                //   present this field is authoritative; `content`,
                                //   `thinking`, and `toolActivity` are derived views kept
                                //   for back-compat. Absent on legacy messages written
                                //   before this field existed (the renderer falls back to
                                //   the legacy fields in that case). See ContentBlock below.
}
```

### ContentBlock

Discriminated union representing a single ordered block in an assistant
message. Each streaming event from the backend produces (or merges into)
one block:

```javascript
// Text deltas — adjacent text events are merged into the tail text block.
{ type: 'text',     content: string }

// Extended thinking deltas — adjacent thinking events merge similarly.
{ type: 'thinking', content: string }

// A single tool invocation. `activity` is the same ToolActivity shape as
// the derived top-level `toolActivity[]` array, including duration and
// outcome patches applied from `tool_outcomes` stream events.
{ type: 'tool',     activity: ToolActivity }
```

Ordering rules:

- Blocks are appended in the order the backend emits events. Both the
  Claude Code adapter and the Kiro adapter yield `text` / `thinking` /
  `tool_activity` / `tool_outcomes` stream events in native source order.
- Consecutive `text` events collapse into one `text` block (same for
  `thinking`). This keeps the block list compact while preserving the
  interleaving relative to tools.
- `tool_activity` events for plan-mode enter/exit and user-question
  prompts are **not** persisted as tool blocks (matching the existing
  `toolActivity[]` filtering behavior).
- `tool_outcomes` patches the matching tool block in place by
  `activity.id`, updating `outcome` and `status`.

### AttachmentMeta

Typed file attachment used on both queued messages (`QueuedMessage.attachments`)
and — transiently, client-side — in the composer's pending upload tray
(`StreamStore.pendingAttachments[].result`). The fields mirror what
`POST /conversations/:id/upload` returns (`name`, `path`, `size`) plus a
server-inferred `kind` and an optional `meta` sublabel (e.g. page count for
PDFs, line count for code/text files) used by the v2 composer chip layout.

```typescript
type AttachmentKind =
  | 'image' | 'pdf' | 'text' | 'code' | 'md' | 'folder' | 'file';

interface AttachmentMeta {
  name: string;           // Filename (after upload rename)
  path: string;           // Absolute server path under conv artifacts dir
  size?: number;          // Bytes (omitted on legacy-migrated entries)
  kind: AttachmentKind;   // Server-inferred category for chip styling
  meta?: string;          // Optional sublabel — e.g. "12 pages", "142 lines"
}
```

`kind` is inferred from the file's extension via `attachmentFromPath()` in
`chatService.ts` (mirrored on the client by `StreamStore.attachmentKindFromPath`).
Legacy entries migrated from the pre-typed `[Uploaded files: …]` tag carry
only `name`, `path`, and `kind` — `size` and `meta` are unavailable for those.

### QueuedMessage

One entry in `ConversationRecord.messageQueue`. The server persists this typed
shape; clients submit it via `PUT /conversations/:id/queue` (strings are
**rejected** — senders must upgrade to the typed form).

```typescript
interface QueuedMessage {
  content: string;                   // User-visible message text (no [Uploaded files: …] tag)
  attachments?: AttachmentMeta[];    // Optional typed attachments
}
```

When the queue drains, the client composes the outgoing wire content by
appending `[Uploaded files: <abs paths>]` back onto `content` — Claude still
reads files from disk; the typed attachments are a UI concern only.

**Legacy migration:** `ChatService.normalizeMessageQueue()` runs on every
read of `messageQueue` and handles three cases:
- `string` entries → parsed via `parseUploadedFilesTag()` so any trailing
  `[Uploaded files: …]` tag becomes typed `AttachmentMeta[]` (with
  `kind` inferred from extension; `size`/`meta` are absent).
- `QueuedMessage` entries → passed through unchanged (with `attachments`
  defaulted to `[]` when absent).
- Malformed entries → dropped silently.

## API Response: getConversation

Flat object assembled from workspace index + active session file:

```javascript
{
  id: string,
  title: string,
  backend: string,
  model?: string,               // Full model ID (e.g. 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5')
  effort?: string,              // Adaptive reasoning effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  workingDir: string,           // The workspace path
  currentSessionId: string,
  sessionNumber: number,        // Active session number
  messages: Message[],          // Active session messages
  usage: Usage,                 // Cumulative token/cost totals (zeroed if no usage yet)
  sessionUsage: Usage,          // Active session token/cost totals (zeroed if no usage yet)
  externalSessionId: string|null, // Backend-managed session ID (for resume after server restart)
  archived?: boolean,           // true when the conversation is archived; absent/false otherwise. The v2 topbar swaps Archive → Unarchive + Delete when set.
  unread?: boolean              // Mirror of `ConversationEntry.unread`. Lets the v2 sidebar render an unread dot on initial paint without a second round-trip per conversation.
}
```

## Usage Ledger (`data/chat/usage-ledger.json`)

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

## Settings (`data/chat/settings.json`)

```json
{
  "theme": "system",
  "sendBehavior": "enter",
  "systemPrompt": "",
  "defaultBackend": "claude-code",
  "defaultModel": "claude-sonnet-4-6",
  "defaultEffort": "high",
  "workingDirectory": "",
  "memory": {
    "cliBackend": "claude-code",
    "cliModel": "claude-sonnet-4-6",
    "cliEffort": "high"
  },
  "knowledgeBase": {
    "ingestionCliBackend": "claude-code",
    "ingestionCliModel": "claude-sonnet-4-6",
    "ingestionCliEffort": "high",
    "digestionCliBackend": "claude-code",
    "digestionCliModel": "claude-sonnet-4-6",
    "digestionCliEffort": "high",
    "dreamingCliBackend": "claude-code",
    "dreamingCliModel": "claude-opus-4-7",
    "dreamingCliEffort": "high",
    "cliConcurrency": 2,
    "dreamingStrongMatchThreshold": 0.75,
    "dreamingBorderlineThreshold": 0.45,
    "convertSlidesToImages": false
  }
}
```

`defaultEffort` is the default adaptive reasoning level for new conversations. It only applies when the chosen model matches `defaultModel` AND the model supports that effort level; otherwise the per-conversation selection falls back to `high` (or, defensively, the first supported level of the chosen model). The settings modal only renders the **Default Effort** field when `defaultBackend`/`defaultModel` resolve to a model that declares `supportedEffortLevels`; changing the default model to one without effort support drops `defaultEffort` on save.

The `systemPrompt` is passed to the CLI via `--append-system-prompt` at the start of each new session. It is additive — Claude Code's built-in system prompt is preserved. Legacy `customInstructions` objects in the JSON file are auto-migrated to `systemPrompt` on first read by `SettingsService`; the `customInstructions` field no longer exists in the `Settings` type.

The `memory` block configures the globally-shared **Memory CLI** used for `memory_note` MCP processing and post-session extraction (see Section 5 — Workspace Memory).

The `knowledgeBase` block configures the globally-shared **Ingestion CLI**, **Digestion CLI**, and **Dreaming CLI** for the per-workspace Knowledge Base feature (see **Workspace Knowledge Base** subsection under `ChatService` below). Digestion + Dreaming default to `defaultBackend` when unset. The Ingestion CLI is opt-in (must be vision-capable, currently used for AI-assisted page/slide/image conversion at ingest time); leaving it unset falls back to image-only references for visual content. `cliConcurrency` (default 2) caps how many documents are processed in parallel by ingestion, digestion, and dreaming pipelines per workspace; within a single document, work stays sequential. `convertSlidesToImages` opts into the LibreOffice-backed PPTX slide rasterization path; when enabled but LibreOffice is absent on `PATH`, ingestion logs a warning and falls back to text + speaker notes + embedded media only. LibreOffice presence is detected at server startup (`which soffice` / `where soffice`) and cached for the process lifetime. `dreamingStrongMatchThreshold` (default 0.75) and `dreamingBorderlineThreshold` (default 0.45) control the retrieval-based routing score thresholds: entries with a top hybrid-search score ≥ strong go directly to synthesis, ≥ borderline go to LLM verification, and below borderline create new topics.

**Migration:** `dreamingConcurrency` was renamed to `cliConcurrency` in the hybrid-ingestion design (PR 1). On read, `SettingsService.getSettings()` copies `dreamingConcurrency` forward to `cliConcurrency` when the new key is missing — disk state is left untouched until the next save. Existing settings files load without warnings; the deprecated `dreamingConcurrency` field stays on the `Settings` type for one release cycle, then is removed.

## KB SQLite Schema (Complete)

Each workspace owns one `knowledge/state.db` (better-sqlite3, WAL mode, `foreign_keys = ON`). Schema version is tracked in the `meta` table and bumped on migrations. Current version: **3** (`KB_DB_SCHEMA_VERSION`).

**Pragmas:** `journal_mode = WAL` (Write-Ahead Logging for concurrent reads), `foreign_keys = ON`.

### Tables

```sql
-- Key/value store for DB metadata (schema version, creation timestamp)
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per content-addressed raw file
CREATE TABLE IF NOT EXISTS raw (
  raw_id        TEXT PRIMARY KEY,   -- sha256[:16] of original bytes
  sha256        TEXT NOT NULL,      -- full SHA-256 hex digest for dedupe
  status        TEXT NOT NULL,      -- 'ingesting'|'ingested'|'digesting'|'digested'|'failed'|'pending-delete'
  byte_length   INTEGER NOT NULL,
  mime_type     TEXT,               -- e.g. 'application/pdf'
  handler       TEXT,               -- handler tag: 'pdf/rasterized-hybrid', 'docx/pandoc-hybrid', 'pptx/hybrid', 'passthrough/text', 'passthrough/image'
  uploaded_at   TEXT NOT NULL,      -- ISO 8601
  digested_at   TEXT,               -- ISO 8601 (NULL until digested)
  error_class   TEXT,               -- 'timeout'|'cli_error'|'malformed_output'|'schema_rejection'|'unknown'
  error_message TEXT,               -- full error text for UI
  metadata_json TEXT                -- JSON-stringified handler metadata (pageCount, slideCount, etc.)
);
CREATE INDEX IF NOT EXISTS idx_raw_status ON raw(status);
CREATE INDEX IF NOT EXISTS idx_raw_sha256 ON raw(sha256);

-- Virtual folder tree (root is empty string '')
CREATE TABLE IF NOT EXISTS folders (
  folder_path TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL         -- ISO 8601
);

-- Multi-location junction: same raw_id can appear in multiple folders
CREATE TABLE IF NOT EXISTS raw_locations (
  raw_id      TEXT NOT NULL REFERENCES raw(raw_id) ON DELETE CASCADE,
  folder_path TEXT NOT NULL REFERENCES folders(folder_path) ON DELETE RESTRICT,
  filename    TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,         -- ISO 8601, when this location was added
  PRIMARY KEY (raw_id, folder_path, filename)
);
CREATE INDEX IF NOT EXISTS idx_raw_loc_folder   ON raw_locations(folder_path);
CREATE INDEX IF NOT EXISTS idx_raw_loc_filename ON raw_locations(filename);

-- Digested entry metadata (one or more entries per raw file)
CREATE TABLE IF NOT EXISTS entries (
  entry_id        TEXT PRIMARY KEY,    -- format: <rawId>-<slug>[-<n>]
  raw_id          TEXT NOT NULL REFERENCES raw(raw_id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  slug            TEXT NOT NULL,       -- URL-safe, lowercase, max 80 chars
  summary         TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,    -- KB_ENTRY_SCHEMA_VERSION (currently 1)
  stale_schema    INTEGER NOT NULL DEFAULT 0,  -- 1 when entry schema < current version
  digested_at     TEXT NOT NULL,       -- ISO 8601
  needs_synthesis INTEGER NOT NULL DEFAULT 1   -- 1 = pending for next dream run
);
CREATE INDEX IF NOT EXISTS idx_entries_raw ON entries(raw_id);
-- Partial index for fast lookup of entries needing synthesis:
CREATE INDEX IF NOT EXISTS idx_entries_needs_synthesis ON entries(entry_id) WHERE needs_synthesis = 1;

-- Entry tags (many-to-many, cascades on entry delete)
CREATE TABLE IF NOT EXISTS entry_tags (
  entry_id TEXT NOT NULL REFERENCES entries(entry_id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,              -- lowercase, alphanumeric + hyphens, max 40 chars
  PRIMARY KEY (entry_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON entry_tags(tag);

-- Dream run metadata key/value store
CREATE TABLE IF NOT EXISTS synthesis_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Keys: 'status' ('empty'|'fresh'|'stale'|'dreaming'), 'last_run_at', 'last_run_error', 'god_nodes' (JSON array), 'dream_progress' (JSON)

-- One row per discovered topic
CREATE TABLE IF NOT EXISTS synthesis_topics (
  topic_id    TEXT PRIMARY KEY,        -- slug derived from topic title
  title       TEXT NOT NULL,
  summary     TEXT,
  content     TEXT,                    -- full markdown prose (synthesized from entries)
  updated_at  TEXT NOT NULL            -- ISO 8601
);

-- Entry-to-topic many-to-many junction
CREATE TABLE IF NOT EXISTS synthesis_topic_entries (
  topic_id TEXT NOT NULL REFERENCES synthesis_topics(topic_id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL REFERENCES entries(entry_id) ON DELETE CASCADE,
  PRIMARY KEY (topic_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_ste_entry ON synthesis_topic_entries(entry_id);

-- Topic-to-topic connections (directed graph)
CREATE TABLE IF NOT EXISTS synthesis_connections (
  source_topic TEXT NOT NULL REFERENCES synthesis_topics(topic_id) ON DELETE CASCADE,
  target_topic TEXT NOT NULL REFERENCES synthesis_topics(topic_id) ON DELETE CASCADE,
  relationship TEXT NOT NULL,          -- human-readable label (e.g. "builds on", "contradicts")
  confidence   TEXT NOT NULL DEFAULT 'inferred',  -- 'extracted'|'inferred'|'speculative'
  evidence     TEXT,                   -- optional supporting text
  PRIMARY KEY (source_topic, target_topic)
);
CREATE INDEX IF NOT EXISTS idx_conn_target ON synthesis_connections(target_topic);

-- Reflections: cross-cluster insights from the Reflection phase
CREATE TABLE IF NOT EXISTS synthesis_reflections (
  reflection_id          TEXT PRIMARY KEY,
  title                  TEXT NOT NULL,
  type                   TEXT NOT NULL,     -- 'pattern'|'contradiction'|'gap'|'trend'|'insight'
  summary                TEXT,
  content                TEXT NOT NULL,     -- full markdown prose with inline [Entry: title](entry-id) citations
  created_at             TEXT NOT NULL,     -- ISO 8601
  original_citation_count INTEGER NOT NULL DEFAULT 0  -- citation count at creation time, for stale detection
);

-- Reflection-to-entry citation junction
CREATE TABLE IF NOT EXISTS synthesis_reflection_citations (
  reflection_id TEXT NOT NULL REFERENCES synthesis_reflections(reflection_id) ON DELETE CASCADE,
  entry_id      TEXT NOT NULL REFERENCES entries(entry_id) ON DELETE CASCADE,
  PRIMARY KEY (reflection_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_src_entry ON synthesis_reflection_citations(entry_id);

-- Singleton row persisted by the digestion orchestrator so a mid-flight
-- browser reload rehydrates the KB Browser toolbar's progress + ETA
-- without losing accuracy. Upserted on every `total`/`done` change
-- (cheap — sqlite, typically sub-ms) and deleted when the queue drains.
-- Cleared on KbDatabase construction via `_recoverFromCrash()` so a
-- server restart mid-session doesn't leave a phantom indicator forever.
CREATE TABLE IF NOT EXISTS digest_session (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  total             INTEGER NOT NULL,
  done              INTEGER NOT NULL,
  total_elapsed_ms  INTEGER NOT NULL,
  started_at        TEXT NOT NULL
);
```

### Cascade Behavior

| Parent | Child | ON DELETE | Effect |
|--------|-------|-----------|--------|
| `raw` | `raw_locations` | CASCADE | Deleting raw removes all location rows |
| `raw` | `entries` | CASCADE | Deleting raw removes all derived entries |
| `folders` | `raw_locations` | RESTRICT | Cannot delete folder with locations (must empty first) |
| `entries` | `entry_tags` | CASCADE | Deleting entry removes its tags |
| `entries` | `synthesis_topic_entries` | CASCADE | Deleting entry removes its topic assignments (may orphan topics) |
| `entries` | `synthesis_reflection_citations` | CASCADE | Deleting entry removes citation rows (may make reflections stale) |
| `synthesis_topics` | `synthesis_topic_entries` | CASCADE | Deleting topic removes entry assignments |
| `synthesis_topics` | `synthesis_connections` | CASCADE | Deleting topic removes its connections (both as source and target) |
| `synthesis_reflections` | `synthesis_reflection_citations` | CASCADE | Deleting reflection removes its citations |

**Orphan topic cleanup:** After entry cascade-deletes (e.g. raw file deletion), `_deleteOrphanTopics()` removes topics with zero remaining entry assignments: `DELETE FROM synthesis_topics WHERE topic_id NOT IN (SELECT DISTINCT topic_id FROM synthesis_topic_entries)`. This is called inside `deleteRaw()` transactions and at the start of the dream pipeline.

**Stale reflection detection:** `listStaleReflectionIds()` identifies reflections that need regeneration using a GROUP BY/HAVING query that checks three conditions: (1) a cited entry was deleted (LEFT JOIN shows NULL), (2) a cited entry was re-digested after the reflection was created (`e.digested_at > r.created_at`), or (3) citations were lost via cascade (`COUNT(c.entry_id) < r.original_citation_count`). The `original_citation_count` column stores the citation count at insertion time so cascade-deleted citation rows can be detected.

### Migrations

Schema version is stored in `meta.schema_version`. Migrations are applied at DB open time by `_initSchema()`:

- **V1 → V2** (`_migrateV2`): Adds `needs_synthesis INTEGER NOT NULL DEFAULT 1` column to `entries` table. All existing entries get `needs_synthesis = 1` (pending).
- **V2 → V3** (`_migrateV3`): Adds `original_citation_count INTEGER NOT NULL DEFAULT 0` to `synthesis_reflections` table. Backfills existing reflections by counting their current citation rows.
- **V1 → V3**: Runs V2 then V3 sequentially.

### Legacy Migration (state.json → state.db)

`openKbDatabase({ dbPath, legacyJsonPath, rawDir })` handles the one-shot migration from the Phase 1/2 JSON format:
1. If `state.db` exists → open and return (idempotent).
2. If `state.json` exists → open fresh DB, read legacy JSON, **re-hash every raw file from disk** (legacy format only kept the 16-char `rawId`; the DB needs the full `sha256`), insert `raw` + `raw_locations` rows, snap any `ingesting`/`digesting` row to `failed`, rename JSON to `state.json.migrated`.
3. Otherwise → open fresh DB with empty schema + root folder.

### PGLite Vector Store Schema

Per-workspace PGLite database at `knowledge/vectors/` with pgvector extension:

```sql
-- Model/dimension tracking for mismatch detection
CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Keys: 'model', 'dimensions'

-- Entry embeddings with full-text search
CREATE TABLE IF NOT EXISTS entry_embeddings (
  entry_id  TEXT PRIMARY KEY,
  title     TEXT NOT NULL DEFAULT '',
  summary   TEXT NOT NULL DEFAULT '',
  embedding vector(N),                -- N = configured dimensions (default 768)
  tsv       tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B')
  ) STORED
);
CREATE INDEX entry_emb_idx ON entry_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX entry_tsv_idx ON entry_embeddings USING GIN (tsv);

-- Topic embeddings (same schema as entries)
CREATE TABLE IF NOT EXISTS topic_embeddings (
  topic_id  TEXT PRIMARY KEY,
  title     TEXT NOT NULL DEFAULT '',
  summary   TEXT NOT NULL DEFAULT '',
  embedding vector(N),
  tsv       tsvector GENERATED ALWAYS AS (...) STORED
);
CREATE INDEX topic_emb_idx ON topic_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX topic_tsv_idx ON topic_embeddings USING GIN (tsv);
```

Dimension mismatch handling: if configured dimensions differ from stored value, both embedding tables are dropped and recreated.

## KB TypeScript Types

Types defined in `src/types/index.ts`:

```typescript
type KbRawStatus = 'ingesting' | 'ingested' | 'digesting' | 'digested' | 'failed' | 'pending-delete';
type KbSynthesisStatus = 'empty' | 'fresh' | 'stale' | 'dreaming';
type KbErrorClass = 'timeout' | 'cli_error' | 'malformed_output' | 'schema_rejection' | 'unknown';

interface KbRawEntry {
  rawId: string;
  sha256: string;
  filename: string;
  folderPath: string;
  mimeType: string;
  sizeBytes: number;
  handler?: string;
  uploadedAt: string;
  digestedAt: string | null;
  status: KbRawStatus;
  errorClass?: KbErrorClass | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
  /** COUNT(entries.entry_id) for this rawId. 0 when not yet digested. */
  entryCount: number;
}

interface KbFolder {
  folderPath: string;
  createdAt: string;
}

interface KbEntry {
  entryId: string;
  rawId: string;
  title: string;
  slug: string;
  summary: string;
  schemaVersion: number;
  staleSchema?: boolean;
  digestedAt: string;
  tags: string[];    // denormalized from entry_tags join
}

interface KbCounters {
  rawTotal: number;
  rawByStatus: Record<KbRawStatus, number>;  // count per status
  entryCount: number;
  pendingCount: number;   // ingested + pending-delete
  folderCount: number;
  topicCount: number;
  connectionCount: number;
  reflectionCount: number;
}

/** Full KB state snapshot returned by GET /workspaces/:hash/kb */
interface KbState {
  version: number;              // DB schema version
  entrySchemaVersion: number;   // KB_ENTRY_SCHEMA_VERSION (currently 1)
  autoDigest: boolean;
  counters: KbCounters;
  folders: KbFolder[];
  raw: KbRawEntry[];            // one page of the focused folder
  /**
   * Aggregate digestion-queue progress snapshot. Sourced from the
   * persisted `digest_session` row so a mid-flight reload rehydrates
   * the KB Browser toolbar indicator; `null` when the queue is idle.
   */
  digestProgress: KbDigestProgress | null;
  updatedAt: string;
}

/** Synthesis snapshot returned by GET /workspaces/:hash/kb/synthesis */
interface KbSynthesisState {
  status: KbSynthesisStatus;
  lastRunAt: string | null;
  lastRunError: string | null;
  topicCount: number;
  connectionCount: number;
  needsSynthesisCount: number;
  godNodes: string[];
  dreamProgress: {
    phase: string;
    done: number;
    total: number;
    /** ms epoch when the dream run first entered `running` status. */
    startedAt?: number;
    /** ms epoch when the current phase began (updated on phase transition only). */
    phaseStartedAt?: number;
  } | null;
  reflectionCount: number;
  staleReflectionCount: number;
  topics: KbSynthesisTopicSummary[];
  connections: KbSynthesisConnectionSummary[];
}

interface KbSynthesisTopicSummary {
  topicId: string;
  title: string;
  summary: string | null;
  entryCount: number;
  connectionCount: number;
  isGodNode: boolean;
}

interface KbSynthesisConnectionSummary {
  sourceTopic: string;
  targetTopic: string;
  relationship: string;
  confidence: string;   // 'extracted'|'inferred'|'speculative'
}

/** Full topic detail returned by GET /workspaces/:hash/kb/synthesis/:topicId */
interface KbSynthesisTopicDetail {
  topicId: string;
  title: string;
  summary: string | null;
  content: string | null;
  updatedAt: string;
  entryCount: number;
  connectionCount: number;
  isGodNode: boolean;
  entries: KbEntry[];
  connections: KbSynthesisConnectionSummary[];
}

/** Summary shape returned by GET /workspaces/:hash/kb/reflections */
interface KbReflectionSummary {
  reflectionId: string;
  title: string;
  type: 'pattern' | 'contradiction' | 'gap' | 'trend' | 'insight';
  summary: string | null;
  citationCount: number;
  createdAt: string;
  isStale: boolean;    // true if any cited entry was re-digested, deleted, or lost via cascade
}

/** Detail shape returned by GET /workspaces/:hash/kb/reflections/:reflectionId */
interface KbReflectionDetail {
  reflectionId: string;
  title: string;
  type: 'pattern' | 'contradiction' | 'gap' | 'trend' | 'insight';
  summary: string | null;
  content: string;
  createdAt: string;
  citationCount: number;
  citedEntries: KbEntry[];
}

/**
 * Aggregate digestion-queue progress snapshot. Spans every digest path
 * (batch, single-file manual, auto-digest) so the UI can show one
 * unified "N / M items — ~E min remaining" indicator across them all.
 */
interface KbDigestProgress {
  /** Tasks completed since the session opened. */
  done: number;
  /** Tasks enqueued since the session opened (bumps when new items arrive mid-session). */
  total: number;
  /** Rolling average per-file digestion duration (ms). 0 until the first task settles. */
  avgMsPerItem: number;
  /** Estimated remaining wall-clock time (ms). Omitted until `done >= 2`. */
  etaMs?: number;
}

/** WebSocket frame emitted for KB state changes */
interface KbStateUpdateEvent {
  type: 'kb_state_update';
  updatedAt: string;
  changed: {
    raw?: string[];
    entries?: string[];
    folders?: boolean;
    synthesis?: boolean;
    /**
     * Aggregate digestion progress. Emitted on every enqueue and every
     * task settle; a final `null` signal fires when the queue drains so
     * the UI can clear the indicator. Persisted to `digest_session` so
     * `GET /kb` can rehydrate after a browser reload.
     */
    digestProgress?: KbDigestProgress | null;
    digestion?: { active: boolean; entriesCreated: number };
    dreamProgress?: { phase: 'routing' | 'verification' | 'synthesis' | 'discovery' | 'reflection'; done: number; total: number; startedAt?: number; phaseStartedAt?: number };
    stopping?: boolean;
    substep?: { rawId: string; text: string };
  };
}

/**
 * Server-internal stream event emitted by a backend adapter when it obtains
 * a backend-managed session ID that needs to be persisted. Vendor-agnostic —
 * any backend (ACP-based CLIs like Kiro, hosted API sessions, etc.) can emit
 * this when their remote-side session is first created. Consumed by
 * `processStream`, which forwards it to
 * `chatService.setExternalSessionId(convId, sessionId)` so the ID lands on
 * `SessionEntry.externalSessionId` on disk. **Not forwarded to the frontend
 * WebSocket** — it is purely a server-to-server persistence signal.
 */
interface ExternalSessionEvent {
  type: 'external_session';
  sessionId: string;  // Backend-managed session ID; opaque to the cockpit
}
```

## KB Constants

| Constant | Value | File | Purpose |
|----------|-------|------|---------|
| `KB_DB_SCHEMA_VERSION` | 3 | db.ts | Current SQLite schema version |
| `KB_ENTRY_SCHEMA_VERSION` | 1 | digest.ts | Entry markdown format version |
| `SYNTHESIS_BATCH_SIZE` | 10 | dream.ts | Entries per synthesis CLI batch |
| `EMBED_BATCH_SIZE` | 50 | dream.ts | Texts per Ollama embedding call |
| `DREAM_TIMEOUT_MS` | 1,200,000 (20 min) | dream.ts | Per-CLI-call timeout |
| `DIGEST_TIMEOUT_MS` | 900,000 (15 min) | digest.ts | Per-CLI-call timeout |
| `DISCOVERY_CANDIDATE_CAP` | 50 | dream.ts | Max connection candidates per run |
| `DISCOVERY_BATCH_SIZE` | 5 | dream.ts | Candidates per discovery CLI batch |
| `DISCOVERY_EMBEDDING_TOP_K` | 10 | dream.ts | Embedding similarity search limit |
| `REFLECTION_CLUSTER_CAP` | 20 | dream.ts | Max clusters to reflect on per run |
| `RRF_K` | 60 | vectorStore.ts | Reciprocal Rank Fusion constant |
| `DEFAULT_STRONG_THRESHOLD` | 0.75 | dream.ts | Routing: strong match score |
| `DEFAULT_BORDERLINE_THRESHOLD` | 0.45 | dream.ts | Routing: borderline match score |
| Default embedding model | `nomic-embed-text` | embeddings.ts | Ollama model name |
| Default embedding host | `http://localhost:11434` | embeddings.ts | Ollama server URL |
| Default embedding dimensions | 768 | embeddings.ts | Vector size |
| Folder path max | 4096 chars | db.ts | Total path length limit |
| Folder segment max | 128 chars | db.ts | Per-segment length limit |
| Slug max | 80 chars | digest.ts | Entry slug max length |
| Tag max | 40 chars | digest.ts | Tag max length |
| Upload size limit | 200 MB | chat.ts (multer) | Per-file upload cap |
| God node entry threshold | max(avg × 3, 10) | db.ts | Entries to flag as god node |
| God node connection threshold | max(avg × 3, 3) | db.ts | Connections to flag as god node |

## KB Materialized Markdown Files

After each dream run, `regenerateSynthesisMarkdown()` wipes and recreates `knowledge/synthesis/`:

- **`synthesis/index.md`** — Topic index table: `| Topic | Entries | Connections |` with links to per-topic files.
- **`synthesis/topics/<topicId>.md`** — Per-topic prose (`content`), `## Related Topics` with links and relationship/confidence labels, `## Entries` with links to `entries/<entryId>/entry.md`.
- **`synthesis/connections.md`** — Full connection graph: `| Source | → | Target | Relationship | Confidence |`.
- **`synthesis/reflections/<reflectionId>.md`** — Per-reflection with YAML frontmatter:
  ```yaml
  ---
  title: "Reflection Title"
  type: pattern
  created_at: "2026-04-12T14:30:00.000Z"
  cited_entries:
    - entry-id-1
    - entry-id-2
  ---
  ```
  Body contains the full reflection `content` prose. The `reflections/` subdirectory is preserved during the main `synthesis/` wipe — reflection markdown is generated separately by `regenerateReflectionMarkdown()`.

## KB Dream Operations

The dreaming CLI returns `{ "operations": [...] }` JSON. 10 supported operation types (`VALID_OPS`):

| Operation | Required Fields | Behavior |
|-----------|----------------|----------|
| `create_topic` | `topic_id`, `title`, `summary`, `content` | Upsert topic row |
| `update_topic` | `topic_id` + at least one of `title`, `summary`, `content` | Merge with existing fields |
| `merge_topics` | `source_topic_ids[]` (≥2), `into_topic_id`, `title`, `content` | Collect entries from sources, delete sources, create merged topic, reassign entries |
| `split_topic` | `source_topic_id`, `into[]` (≥2, each with `topic_id`, `title`, `content`) | Delete source, create new topics, reassign all source entries to all new topics, rewire connections |
| `delete_topic` | `topic_id` | Cascade-delete topic + entries + connections |
| `assign_entries` | `topic_id`, `entry_ids[]` (non-empty) | Insert topic-entry junction rows |
| `unassign_entries` | `topic_id`, `entry_ids[]` (non-empty) | Delete topic-entry junction rows |
| `add_connection` | `source_topic`, `target_topic`, `relationship` | Upsert connection (confidence defaults to `'inferred'`) |
| `update_connection` | `source_topic`, `target_topic` | Update relationship/confidence (defaults: `'related'`/`'inferred'`) |
| `remove_connection` | `source_topic`, `target_topic` | Delete connection row |

Connection confidence levels: `extracted` (entry explicitly states relationship), `inferred` (deduced from overlapping concepts), `speculative` (weaker thematic connection). Most connections should be `inferred`.

All operations are parsed by `parseDreamOutput()` (extracts JSON from potentially noisy CLI output via markdown-fence matching or a string-aware balanced-brace scanner that ignores braces inside JSON string literals), validated by `validateOp()`, and applied transactionally by `applyOperations()` in `dreamOps.ts`. The same string-aware scanner backs `parseVerificationOutput()`, `parseDiscoveryOutput()`, and `parseReflectionOutput()` in `dream.ts`.
