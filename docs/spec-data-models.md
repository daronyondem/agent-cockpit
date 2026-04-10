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
│       │   └── handlers/
│       │       ├── index.ts            # pickHandler dispatch + ingestFile + UnsupportedFileTypeError
│       │       ├── pdf.ts              # PDF page-by-page 150 DPI rasterization via unpdf + @napi-rs/canvas
│       │       ├── docx.ts             # DOCX → GFM markdown via pandoc subprocess + flattened embedded media
│       │       ├── pptx.ts             # PPTX text/notes/media via adm-zip + fast-xml-parser, optional LO rasterization
│       │       └── passthrough.ts      # Text (md/txt/json/...) + image passthrough with media copy
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
    │   │   │   ├── state.db            # SQLite database (better-sqlite3, WAL mode, foreign_keys ON)
    │   │   │   ├── raw/<rawId>.<ext>   # Uploaded files, stored verbatim (rawId = sha256[:16])
    │   │   │   ├── converted/<rawId>/  # Ingestion output: text.md + meta.json + optional media/ (populated by PR 2 on upload)
    │   │   │   ├── entries/<entryId>/  # Digestion output directory (one dir per entry)
    │   │   │   │   └── entry.md        # YAML frontmatter + markdown body
    │   │   │   ├── digest-debug/       # Failed digestion debug dumps: <rawId>-<iso>.txt
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

## Workspace Hash

All workspace hashes throughout the system use: `SHA-256(workspacePath).substring(0, 16)` — a deterministic mapping from absolute workspace path to storage folder name.

## Workspace Index (`workspaces/{hash}/index.json`)

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

## API Response: getConversation

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
