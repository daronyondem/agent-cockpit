# 2. Data Models & File Structure

[← Back to index](SPEC.md)

---

## File Structure

Runtime mutable data lives under the Agent Cockpit data root. The default data
root is `<repo>/data`, preserving existing development installs. Setting
`AGENT_COCKPIT_DATA_DIR` moves the data root outside the app/source directory;
`AUTH_DATA_DIR` can still override only the auth subdirectory. In the tree below,
`data/` means the configured data root.

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
│   ├── contracts/
│   │   ├── chat.ts                    # Chat API request/response contracts and runtime validators
│   │   ├── conversations.ts           # Browser-safe conversation mutation contracts
│   │   ├── streams.ts                 # Browser-safe message/input mutation contracts
│   │   ├── explorer.ts                # Workspace file explorer mutation contracts
│   │   ├── gitChanges.ts              # Workspace Git status/diff response contracts
│   │   ├── uploads.ts                 # Attachment/OCR mutation contracts
│   │   ├── memory.ts                  # Workspace memory enablement/review mutation contracts
│   │   ├── contextMap.ts              # Context Map settings/candidate mutation contracts
│   │   ├── knowledgeBase.ts           # KB enablement/folder/glossary/embedding mutation contracts
│   │   ├── settings.ts                # Global settings mutation contract helpers
│   │   ├── serviceTier.ts             # Browser-safe service-tier input normalization
│   │   └── validation.ts              # Shared object/string/boolean/number/array validation helpers
│   ├── types/
│   │   └── index.ts                    # Shared type definitions (models, events, adapters)
│   ├── config/index.ts                 # Loads env vars with defaults
│   ├── middleware/
│   │   ├── auth.ts                     # Passport strategies, login page, routes
│   │   ├── csrf.ts                     # CSRF token generation and validation
│   │   └── security.ts                 # Helmet CSP configuration
│   ├── routes/
│   │   ├── chat.ts                     # Chat API composition root and stream orchestration
│   │   └── chat/                       # Focused chat route modules: status, CLI profile, conversation, stream, goal, upload, filesystem, instructions, explorer, Git changes, memory, Context Map, KB, shared helpers
│   ├── utils/
│   │   ├── atomicWrite.ts              # Atomic JSON/file write helper
│   │   ├── keyedMutex.ts               # FIFO per-key async mutex
│   │   └── logger.ts                   # Structured logger with level filtering, redaction, and cycle-safe metadata serialization
│   └── services/
│       ├── backends/
│       │   ├── base.ts                 # BaseBackendAdapter interface
│       │   ├── claudeCode.ts           # Claude Code adapter — headless CLI spawning and stream-json parsing
│       │   ├── claudeCodeInteractive.ts # Claude Code Interactive adapter — hidden PTY control plus transcript-derived events
│       │   ├── claudeInteractiveHooks.ts # Claude Code Interactive SessionStart/PreToolUse/Stop hook harness
│       │   ├── claudeInteractivePty.ts # node-pty controller for interactive Claude Code prompts/input/abort/exit
│       │   ├── claudeInteractiveSessionManager.ts # Process-local hidden PTY controller registry
│       │   ├── claudeInteractiveTerminal.ts # DEC/XTerm terminal query responder for hidden PTY startup
│       │   ├── claudeTranscriptEvents.ts # Claude transcript JSONL to backend StreamEvent mapping
│       │   ├── claudeTranscriptTailer.ts # Claude transcript file discovery/tailing/deduplication
│       │   ├── claudeInteractiveCompatibility.ts # Tested Claude CLI version and compatibility warnings
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
│       │       └── passthrough.ts      # Text (md/txt/json/...) + hybrid image passthrough (per-image AI description, SVG bypass)
│       ├── cliProfiles.ts              # CLI profile helpers: server-configured profile IDs/defaults and runtime resolver
│       ├── cliUpdateService.ts         # In-memory local CLI version checks and supported CLI update commands
│       ├── chat/
│       │   ├── attachments.ts          # Attachment/artifact metadata helpers used by ChatService
│       │   ├── messageQueueStore.ts    # Private ChatService queue store + legacy queue normalization
│       │   └── workspaceInstructionStore.ts # Private ChatService workspace instruction compatibility/pointer store
│       ├── chatService.ts              # Conversation CRUD, messages, sessions
│       ├── settingsService.ts          # Settings I/O: read, write, legacy migration
    │       └── updateService.ts            # Self-update: dev git/main path and production GitHub Release path
├── public/
│   ├── favicon.svg
│   ├── logo-*.svg                      # Brand assets used by login, sidebar, and assistant avatars
│   ├── icons/*.svg                     # Source/reference icon assets
│   ├── v2/                             # Retired Browser-Babel placeholders kept for ADR path stability
│   ├── v2-built/                       # Ignored generated Vite output served at `/v2/`
│   └── mobile-built/                   # Ignored generated mobile PWA output served at `/mobile/`
├── web/
│   └── AgentCockpitWeb/
│       ├── index.html                  # Vite V2 app entry
│       └── src/
│           ├── api.js                  # CSRF-aware REST/WebSocket client helpers
│           ├── chat/attachments.jsx    # Composer attachment tray/chip subtree
│           ├── chat/messageParsing.ts  # Pure chat-message marker parsing helpers
│           ├── chat/queue.jsx          # Queued-message stack/editor subtree
│           ├── cliUpdateStore.js       # Web-only cached CLI update status/action store
│           ├── streamStore.js          # Per-conversation streaming, queue, draft, and WebSocket state
│           ├── shell.jsx               # Root app shell, sidebar wiring, chat surface
│           ├── screens/                # Real V2 screens: KB, files, settings, Memory Review
│           └── *.css / *.jsx / *.js    # Shared primitives, dialogs, tooltips, plan usage stores, modals
├── test/                               # Jest test suite (TypeScript via ts-jest)
└── data/                               # Runtime data root, default `<repo>/data` and movable with AGENT_COCKPIT_DATA_DIR
    ├── chat/
    │   ├── stream-jobs.json            # Durable active CLI turn registry for server-restart reconciliation
    │   ├── workspaces/{hash}/          # Workspace-based storage (see below)
    │   │   ├── index.json              # Source of truth: conversations + session metadata (includes `memoryEnabled`, `kbEnabled`, and `contextMapEnabled` flags)
    │   │   ├── session-finalizers.json # Persisted background jobs for reset/archive finalizers
    │   │   ├── memory/                 # Per-workspace memory store (opt-in per workspace)
    │   │   │   ├── snapshot.json       # Merged snapshot: claude captures + notes (parsed metadata + content)
    │   │   │   ├── state.json          # Agent Cockpit sidecar lifecycle metadata keyed by memory filename
    │   │   │   ├── audits/             # Manual consolidation audit JSON files
    │   │   │   ├── reviews/            # Durable Memory Review run JSON files
    │   │   │   └── files/              # Raw .md entries, split by source
    │   │   │       ├── claude/         # Claude Code native captures; wiped and rewritten on each capture
    │   │   │       │   ├── MEMORY.md   # Source index from Claude Code (if present)
    │   │   │       │   └── *.md        # Per-topic memory files with YAML frontmatter
    │   │   │       └── notes/          # `memory_note` MCP writes + post-session extractions; preserved across captures
    │   │   │           └── *.md        # Per-note memory files with YAML frontmatter
    │   │   ├── context-map/            # Per-workspace Context Map store (created lazily by Context Map services)
    │   │   │   └── state.db            # SQLite database (better-sqlite3, WAL mode, foreign_keys ON)
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
    │   ├── artifacts/{convId}/         # Per-conversation uploaded files and generated assistant artifacts
    │   ├── settings.json               # User settings, including CLI profile definitions
    │   └── usage-ledger.json           # Daily per-backend token usage ledger
    ├── sessions/                       # Express session JSON files (24h TTL)
    ├── auth/                           # First-party owner auth state unless AUTH_DATA_DIR overrides it
    ├── claude-plan-usage.json          # Default Claude account usage cache
    ├── claude-plan-usage/              # Profile-specific Claude account usage caches
    ├── codex-plan-usage.json           # Default Codex account usage cache
    ├── codex-plan-usage/               # Profile-specific Codex account usage caches
    ├── kiro-plan-usage.json            # Kiro account usage cache
    ├── install.json                    # Install channel/source manifest, created by installers or install-state writes
    ├── restart.sh                      # POSIX PM2 restart script written by UpdateService when restart/update is requested
    ├── restart.ps1                     # Windows PM2 restart script written by UpdateService when restart/update is requested
    └── update-restart.log              # Restart script output
```

## Workspace Hash

All workspace hashes throughout the system use: `SHA-256(workspacePath).substring(0, 16)` — a deterministic mapping from absolute workspace path to storage folder name.

## Install Manifest (`install.json`)

`InstallStateService` reads and writes `<AGENT_COCKPIT_DATA_DIR>/install.json`.
Missing manifests are treated as inferred dev installs that track `main`, so
existing checkouts do not need a migration. Corrupt manifests also fall back to
the inferred dev/main status but report `stateSource: "corrupt"` and a
`stateError` string. Legacy manifests without `schemaVersion: 1` are normalized
at read time and reported with `stateSource: "legacy"`.

Current schema:

```json
{
  "schemaVersion": 1,
  "channel": "production",
  "source": "github-release",
  "repo": "daronyondem/agent-cockpit",
  "version": "1.0.0",
  "branch": null,
  "installDir": "/Users/<user>/Library/Application Support/Agent Cockpit",
  "appDir": "/Users/<user>/Library/Application Support/Agent Cockpit/current",
  "dataDir": "/Users/<user>/Library/Application Support/Agent Cockpit/data",
  "installedAt": "2026-05-11T00:00:00.000Z",
  "welcomeCompletedAt": null,
  "nodeRuntime": {
    "source": "private",
    "version": "22.22.3",
    "npmVersion": "10.9.8",
    "binDir": "/Users/<user>/Library/Application Support/Agent Cockpit/runtime/node/bin",
    "runtimeDir": "/Users/<user>/Library/Application Support/Agent Cockpit/runtime/node",
    "requiredMajor": 22,
    "updatedAt": "2026-05-11T00:00:00.000Z"
  },
  "startup": null
}
```

Read responses add operational metadata that is not persisted:

- `stateSource`: `"stored"`, `"inferred"`, `"legacy"`, or `"corrupt"`
- `stateError`: `null` or a read/parse error string for corrupt manifests

`startup` is optional. Windows installer manifests write
`{ "kind": "scheduled-task", "name": "AgentCockpit", "scope": "current-user" }`
when logon startup is registered, or `{ "kind": "manual", ... }` when the user
supplied `-NoAutoStart`. Older manifests omit it and readers normalize that as
`null`.

`nodeRuntime` is `null` for older/inferred manifests. New macOS and Windows
installer manifests record whether Agent Cockpit is using a host-managed
`system` Node runtime or an installer-managed `private` runtime under the install root.
`version` is the Node.js version without a leading `v`; `npmVersion` is the npm
version observed by the installer when available. For private runtimes,
On macOS private runtimes, `runtimeDir` is the stable symlink and `binDir` is the
`bin` directory prepended to `PATH`. On Windows private runtimes, `runtimeDir`
and `binDir` both point at the versioned Node ZIP extraction directory that
contains `node.exe`, `npm.cmd`, and `npx.cmd`; no symlink or junction is used.
Production self-update rewrites this object when it upgrades the private runtime
to satisfy a newer release's required Node major.

## Release Manifest (`release-manifest.json`)

Production GitHub Releases upload `release-manifest.json` beside the release app
archives and `SHA256SUMS`. The manifest is generated by
`scripts/package-release.js` and is intentionally outside the archives so the
installer/updater can verify archive hashes before extraction.

Current schema:

```json
{
  "schemaVersion": 1,
  "name": "agent-cockpit",
  "version": "1.0.0",
  "channel": "production",
  "source": "github-release",
  "sourceRef": "main",
  "sourceCommit": "0123456789abcdef",
  "generatedAt": "2026-05-11T00:00:00.000Z",
  "packageRoot": "agent-cockpit-v1.0.0",
  "requiredRuntime": {
    "node": {
      "engine": ">=22",
      "minimumMajor": 22
    }
  },
  "requiredBuilds": {
    "web": "public/v2-built/index.html",
    "mobile": "public/mobile-built/index.html"
  },
  "artifacts": [
    {
      "name": "agent-cockpit-v1.0.0.tar.gz",
      "role": "app-tarball",
      "platform": "darwin",
      "format": "tar.gz",
      "size": 123456,
      "sha256": "<64 lowercase hex chars>"
    },
    {
      "name": "agent-cockpit-v1.0.0.zip",
      "role": "app-zip",
      "platform": "win32",
      "format": "zip",
      "size": 123456,
      "sha256": "<64 lowercase hex chars>"
    },
    {
      "name": "install-macos.sh",
      "role": "macos-installer",
      "platform": "darwin",
      "size": 12345,
      "sha256": "<64 lowercase hex chars>"
    },
    {
      "name": "install-windows.ps1",
      "role": "windows-installer",
      "platform": "win32",
      "size": 12345,
      "sha256": "<64 lowercase hex chars>"
    }
  ],
  "files": [
    {
      "path": "public/v2-built/index.html",
      "size": 1234,
      "sha256": "<64 lowercase hex chars>"
    }
  ]
}
```

`artifacts[]` includes the macOS app tarball, Windows app ZIP, and external
installer assets uploaded beside the app archives. `files[]` contains every
regular file copied into the app archives, with paths relative to the package root.
It excludes mutable/local-only state such as `node_modules/`, `data/`, `.env`,
`ecosystem.config.js`, `coverage/`, `plans/`, `plan.md`, release `dist/` output,
and generated build staging directories. `SHA256SUMS` currently contains
checksums for the tarball, ZIP, this external manifest, `install-macos.sh`, and
`install-windows.ps1`.
`requiredRuntime.node` is derived from root `package.json` `engines.node`.
Current packaging extracts simple lower-bound engines such as `>=22` into
`minimumMajor`; production self-update uses that value to decide whether a
private installer-managed Node runtime must be installed or refreshed before
running `npm ci`.

## Persistence Durability

All mutable JSON files under `data/` are written with two primitives to survive concurrent access without corruption:

- **Atomic writes** — `src/utils/atomicWrite.ts` exports `atomicWriteFile(filePath, data, encoding='utf8')`. It writes to a sibling `.{base}.tmp.{pid}.{random}` file then calls `fs.rename` (POSIX-atomic), so readers always observe either the previous complete file or the new complete file — never a torn byte-interleaved mix. On rename failure the tmp file is removed. Used by `ChatService` (workspace `index.json`, session files, usage ledger, memory `snapshot.json`, memory `state.json`), `SessionFinalizerQueue` (`session-finalizers.json`), `SettingsService`, `ClaudePlanUsageService`, `CodexPlanUsageService`, and `KiroPlanUsageService`.
- **Per-key mutex** — `src/utils/keyedMutex.ts` exports `KeyedMutex.run<T>(key, fn)`. Callers sharing a key are serialized FIFO; different keys run concurrently. `ChatService` holds one `_indexLock` keyed by workspace hash (every read-modify-write on a workspace `index.json` runs inside `_indexLock.run(hash, ...)`) and one `_ledgerLock` keyed by the constant `'__usage_ledger__'` (wrapping ledger record/clear). Not reentrant — locked regions must not recursively acquire the same key.

Together these guarantee that a workspace index always parses on disk and that concurrent mutators do not clobber each other's updates. `ChatService._buildLookupMap` also catches per-workspace `JSON.parse` failures at startup, logs them, and continues, so a single corrupt file cannot crash the server into a restart loop.

## Workspace Index (`workspaces/{hash}/index.json`)

```javascript
{
  workspacePath: string,        // Absolute path to the workspace directory
  instructions: string,         // Per-workspace instructions (appended to system prompt on new sessions)
  instructionCompatibilityDismissedFingerprint: string|undefined, // Last dismissed CLI instruction compatibility warning. Fingerprint changes when detected instruction sources or missing vendor entrypoints change.
  memoryEnabled: boolean|undefined, // Opt-in per-workspace Memory feature. Defaults to false.
  memoryReviewSchedule: {            // Per-workspace Memory Review schedule. Defaults to { mode: 'off' }.
    mode: 'off' | 'window',
    days?: 'daily' | 'weekdays' | 'custom',
    customDays?: number[],           // 0=Sunday through 6=Saturday, used when days='custom'.
    windowStart?: string,            // HH:mm in timezone/server-local time for window mode.
    windowEnd?: string,              // HH:mm in timezone/server-local time for window mode.
    timezone?: string,               // Optional IANA timezone.
  } | undefined,
  memoryReviewScheduleUpdatedAt: string|undefined, // Last schedule change; scheduled-run guards ignore older runs.
  kbEnabled: boolean|undefined,     // Opt-in per-workspace Knowledge Base feature. Defaults to false.
  kbAutoDigest: boolean|undefined,  // Auto-digest new files after ingestion. Defaults to false.
  kbAutoDream: {                    // Per-workspace automatic dreaming schedule. Defaults to { mode: 'off' }.
    mode: 'off' | 'interval' | 'window',
    intervalHours?: number,         // Positive integer hours for interval mode.
    windowStart?: string,           // HH:mm local server time for window mode.
    windowEnd?: string,             // HH:mm local server time for window mode.
  } | undefined,
  kbEmbedding: {                    // Per-workspace embedding config (optional, Ollama-only)
    model?: string,                 // Ollama model name. Default 'nomic-embed-text'.
    ollamaHost?: string,            // Ollama server URL. Default 'http://localhost:11434'.
    dimensions?: number,            // Embedding dimensions (must match model). Default 768.
  } | undefined,
  contextMapEnabled: boolean|undefined, // Opt-in per-workspace Context Map feature. Defaults to false.
  contextMap: {                     // Per-workspace Context Map processor settings. Defaults to { processorMode: 'global' }.
    processorMode?: 'global' | 'override', // 'global' uses Settings.contextMap processor defaults; 'override' stores workspace CLI overrides.
    cliProfileId?: string,          // Optional workspace processor profile when processorMode='override'.
    cliBackend?: string,            // Deprecated legacy fallback/mirror of the selected profile's protocol-derived backend.
    cliModel?: string,              // Optional workspace processor model when processorMode='override'.
    cliEffort?: string,             // Optional adaptive effort when processorMode='override'.
    scanIntervalMinutes?: number,   // Optional workspace cadence override, clamped to 1..1440.
  } | undefined,
  conversations: [{
    id: string,                 // UUIDv4
    title: string,              // Auto-set from first user message (max 80 chars)
    titleManuallySet?: boolean, // true once `renameConversation()` has run. Locks the title against all automatic mutations (resetSession, addMessage's first-message snapshot, generateAndUpdateTitle). Absent when the title is still auto-managed.
    backend: string,            // Internal backend id: 'claude-code' | 'claude-code-interactive' | 'kiro' | 'codex'. Kept for back-compat and transcript rendering. Some backends share a physical CLI vendor/profile.
    cliProfileId?: string,      // Runtime CLI profile selected for this conversation. When present, runtime adapter selection is derived from Settings.cliProfiles[id].vendor plus Claude Code's optional protocol while command/auth/config still come from the physical profile.
    model?: string,             // Full model ID (e.g. 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'); absent = backend default
    effort?: string,            // Adaptive reasoning effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; absent = model default. Supported values are backend/model-specific. Stale unsupported values are reconciled to `high` when available, then the first supported level, or removed when the model has no effort support.
    serviceTier?: string,       // Codex-only service tier override. Current value: 'fast'. Absent = use the selected Codex profile/config default.
    currentSessionId: string,   // UUID of the active CLI session
    lastActivity: string,       // ISO 8601, updated on every message and on session reset
    lastMessage: string|null,   // First 100 chars of last active-session message content; reset to null when a new session starts
    usage: {                     // Cumulative token/cost tracking (null until first result)
      inputTokens: number,
      outputTokens: number,
      cacheReadTokens: number,
      cacheWriteTokens: number,
      costUsd: number,
      credits?: number,                // Kiro only: accumulated credits consumed (fractional)
      contextUsagePercentage?: number  // Kiro/Codex: context window usage snapshot (0–100)
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
      summary: string|null,     // Fallback summary immediately on reset, later patched by the summary finalizer; null for active session.
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

## Session Finalizer Store (`workspaces/{hash}/session-finalizers.json`)

Persisted queue for post-reset/archive work that must survive process restarts but must not block the reset/archive HTTP response.

```typescript
{
  version: 1,
  jobs: Array<{
    id: string,
    identity: string,          // type + payload.source + conversationId + sessionNumber
    workspaceHash: string,
    conversationId: string,
    sessionNumber: number,
    type: 'session_summary' | 'memory_extraction' | 'context_map_conversation_final_pass',
    status: 'pending' | 'running' | 'retrying' | 'completed' | 'failed',
    attempts: number,
    maxAttempts: number,
    createdAt: string,
    updatedAt: string,
    startedAt?: string,
    completedAt?: string,
    nextAttemptAt?: string,
    errorMessage?: string,
    payload?: {
      backendId?: string,
      cliProfileId?: string,
      source?: 'session_reset' | 'archive'
    }
  }>
}
```

`SessionFinalizerQueue.start()` converts leftover `running` jobs back to `pending` after restart. `enqueue()` de-duplicates by `identity`, persists the job, and schedules asynchronous processing. The reset route enqueues `session_summary`, `memory_extraction`, and a `context_map_conversation_final_pass` with source `session_reset`; archive enqueues only the Context Map finalizer with source `archive` when Context Map is enabled.

## Workspace Memory Store (`workspaces/{hash}/memory/`)

`snapshot.json` remains the merged content snapshot consumed by existing callers:

```typescript
{
  capturedAt: string,
  sourceBackend: string,
  sourcePath: string | null,
  index: string,
  files: Array<{
    filename: string,
    name: string | null,
    description: string | null,
    type: 'user' | 'feedback' | 'project' | 'reference' | 'unknown',
    content: string,
    source?: 'cli-capture' | 'memory-note' | 'session-extraction',
    metadata?: MemoryEntryMetadata
  }>
}
```

`state.json` is the Agent Cockpit-owned lifecycle sidecar. It is keyed by the same workspace-relative filenames used in `snapshot.files[].filename`:

```typescript
{
  version: 1,
  updatedAt: string,
  entries: {
    [filename: string]: {
      entryId: string,          // stable `mem_<sha256(filename)[:16]>` unless migrated later
      filename: string,         // e.g. `claude/foo.md` or `notes/note_...md`
      status: 'active' | 'superseded' | 'redacted' | 'deleted',
      scope: 'workspace' | 'user',
      source: 'cli-capture' | 'memory-note' | 'session-extraction',
      createdAt: string,
      updatedAt: string,
      sourceConversationId?: string,
      supersedes?: string[],
      supersededBy?: string,
      confidence?: number,
      redaction?: { kind: string, reason: string }[]
    }
  }
}
```

Current write paths store records only for files that exist. `deleteMemoryEntry()` and `clearWorkspaceMemory()` prune sidecar records for removed files; the `deleted` lifecycle state is reserved for a future audited-forget workflow. Older workspaces without `state.json` still load: `ChatService.getWorkspaceMemory()` synthesizes active workspace metadata in returned `MemoryFile.metadata`, and the next memory write materializes `state.json`.

Governed memory writes surface their decision through `MemoryWriteOutcome`:

```typescript
{
  action: 'saved' | 'skipped_duplicate' | 'skipped_ephemeral' | 'redacted_saved' | 'superseded_saved',
  reason: string,
  filename?: string,          // new file for saved/redacted/superseded writes
  skipped?: string | boolean, // duplicate filename or true for ephemeral skips
  duplicateOf?: string,
  superseded?: string[],      // filenames marked superseded by this write
  redaction?: { kind: string, reason: string }[]
}
```

`MemoryUpdateEvent` frames may include `writeOutcomes?: MemoryWriteOutcome[]` in addition to `capturedAt`, `fileCount`, `changedFiles`, `sourceConversationId`, and `displayInChat`. `memory_note` skip decisions can emit a frame with empty `changedFiles` and a populated `writeOutcomes` list so the source conversation can explain why no file changed.

`ChatService.searchWorkspaceMemory(hash, { query, limit?, types?, statuses? })` returns lexical memory matches shaped as:

```typescript
{
  filename: string,
  entryId: string,
  name: string | null,
  description: string | null,
  type: 'user' | 'feedback' | 'project' | 'reference' | 'unknown',
  source: 'cli-capture' | 'memory-note' | 'session-extraction',
  status: 'active' | 'superseded' | 'redacted' | 'deleted',
  score: number,        // rounded BM25-style lexical score plus exact/type boosts
  snippet: string,      // compact text around the first matching term
  content: string,
  metadata: MemoryEntryMetadata
}
```

The default search status filter is `active + redacted`; superseded and deleted entries are excluded unless a caller explicitly opts into those lifecycle states. The MCP `memory_search` tool exposes that as `status:'active' | 'all'`, while the REST/UI search route exposes detailed lifecycle values. This first search layer is local and lexical only: it uses tokenized name/description/type/filename/content with BM25-style scoring, repeated name/description field weighting, explicit exact-match and type boosts, and recency as the tie-breaker before filename. It does not require the KB's Ollama embedding configuration.

Manual consolidation proposals and audits use the following action shape:

```typescript
{
  action: 'mark_superseded' | 'merge_candidates' | 'split_candidate' | 'normalize_candidate' | 'keep',
  reason: string,
  filename?: string,
  supersededBy?: string,
  filenames?: string[],
  title?: string
}
```

`mark_superseded` is the only action applied automatically by `/memory/consolidate/apply`. It updates sidecar metadata only: the stale entry gets `status:'superseded'` and `supersededBy:<replacement entryId>`, and the replacement entry's `supersedes[]` includes the stale entry ID.

Merge/split/normalize actions can be turned into exact, reviewed drafts through `/memory/consolidate/draft`. Draft operations are:

```typescript
{
  operation: 'create' | 'replace',
  reason: string,
  content: string,      // complete markdown memory file after deterministic redaction
  filename?: string,    // replace target, or created filename after apply
  filenameHint?: string,
  supersedes?: string[] // source filenames for create operations
}
```

Drafts have `{ id, createdAt, action, summary, operations }`. `create` writes a new `notes/` file and marks selected source entries superseded in sidecar metadata. `replace` rewrites only selected `notes/*` entries in place; `claude/*` entries are never replaced because they are mirrored native CLI captures. Redacted, deleted, and already-superseded sources are rejected for draft generation and skipped during draft apply. Memory Review draft apply may receive an edited draft payload, but the persisted generated operation metadata remains authoritative; only `operations[].content` is accepted from the reviewed payload before the same Markdown validation and redaction pipeline runs.

Memory Review runs persist scheduled/manual proposal + draft state under `memory/reviews/<runId>.json`:

```typescript
{
  version: 1,
  id: string,                         // `memreview_<hex>`
  workspaceHash: string,
  status: 'running' | 'pending_review' | 'completed' | 'partially_applied' | 'dismissed' | 'failed',
  source: 'manual' | 'scheduled',
  createdAt: string,
  updatedAt: string,
  completedAt?: string,
  summary: string,
  sourceSnapshotFingerprint: string,  // sha256 over current memory filenames + content/lifecycle fingerprints
  proposal?: {
    id: string,
    createdAt: string,
    summary: string,
    actions: MemoryConsolidationAction[]
  },
  safeActions: Array<{
    id: string,
    status: 'pending' | 'applied' | 'discarded' | 'stale' | 'failed',
    action: MemoryConsolidationAction, // currently only mark_superseded is created here
    sourceFingerprints: Record<string, string>,
    createdAt: string,
    updatedAt: string,
    appliedAt?: string,
    discardedAt?: string,
    failure?: string,
    result?: MemoryConsolidationApplyResult
  }>,
  drafts: Array<{
    id: string,
    status: 'pending' | 'applied' | 'discarded' | 'stale' | 'failed',
    action: MemoryConsolidationAction, // merge/split/normalize source action
    sourceFingerprints: Record<string, string>,
    createdAt: string,
    updatedAt: string,
    draft?: MemoryConsolidationDraft,
    appliedAt?: string,
    discardedAt?: string,
    regeneratedAt?: string,
    failure?: string,
    result?: MemoryConsolidationDraftApplyResult
  }>,
  failures: Array<{ action?: MemoryConsolidationAction, message: string }>
}
```

## Context Map Store (`workspaces/{hash}/context-map/`)

Context Map is a workspace-level feature tracked by issue #281, ADR-0044, and `docs/design-context-map.md`. Its canonical store is `context-map/state.db`, opened through `src/services/contextMap/db.ts`. The database is better-sqlite3-backed, runs in WAL mode with `foreign_keys = ON`, and is the single source of truth for Context Map state. The UI renders readable entity/candidate cards and editable forms from this data, but editable Markdown files are not a second source of truth.

`CONTEXT_MAP_DB_SCHEMA_VERSION = 2`. Fresh databases create the following tables:

| Table | Purpose |
|-------|---------|
| `meta` | Stores `schema_version`. |
| `entity_types` | Flexible type catalog. Fresh DBs seed system types: `person`, `organization`, `project`, `workflow`, `document`, `feature`, `concept`, `decision`, `tool`, and `asset`. Processor/user-suggested workspace-specific types are stored here with `origin` and lifecycle `status`. |
| `entities` | Durable named things with `type_slug`, `name`, lifecycle `status`, readable `summary_markdown` / `notes_markdown` fields, `sensitivity`, `confidence`, and timestamps. |
| `entity_aliases` | De-duplicated aliases per entity. Indexed case-insensitively for later search. |
| `entity_facts` | Reviewable durable fact statements for an entity, stored as Markdown field values plus lifecycle status/confidence. |
| `relationships` | Typed edges between two entities: `subject_entity_id`, `predicate`, `object_entity_id`, lifecycle status, confidence, and stable JSON qualifiers. A unique constraint prevents duplicate subject/predicate/object/qualifier edges. |
| `evidence_refs` | Source pointers backing entities, facts, relationships, or candidates. Supports source types such as conversation messages/summaries, memory entries, KB entries/topics, files, workspace instructions, git/GitHub references, and external connectors. Source + locator is unique. |
| `evidence_links` | Junction table linking one evidence ref to an `entity`, `fact`, `relationship`, or `candidate` target. |
| `context_runs` | Background processor runs with source (`initial_scan`, `scheduled`, `session_reset`, `archive`, `manual_rebuild`), status (`running`, `completed`, `failed`, or `stopped`), timestamps, errors, and metadata JSON. |
| `source_spans` | Idempotency records for incremental processing: run id, conversation id, session epoch, start/end message ids, source hash, and processed timestamp. Conversation/session/message span + hash is unique so reprocessing the same source span is skipped. |
| `conversation_cursors` | Durable per-conversation incremental cursors (`last_processed_message_id`, `last_processed_at`, `last_processed_source_hash`, `session_epoch`). |
| `source_cursors` | Durable per-workspace-source incremental cursors keyed by `source_type` + `source_id`, with `last_processed_source_hash`, `last_processed_at`, `last_seen_at`, `last_run_id`, lifecycle status (`active` or `missing`), and optional error text. Used for workspace instructions, Markdown source files, and code-outline packets. |
| `context_candidates` | Processor candidate/change records, including candidate type, lifecycle status, payload JSON, confidence, timestamps, applied time, and error message. Pending rows drive Needs Attention; active rows record applied changes. |
| `audit_events` | Append-only audit history for candidate/entity/relationship actions. |

`ContextMapDatabase` exposes CRUD helpers for schema bootstrap, entity type upsert/list, entity insert/update/list, entity sensitivity updates, aliases, facts, relationship insert/update/list, evidence refs/links, runs, source spans, conversation cursors, source cursors, candidates, audit events, and full workspace clear/reset. Workspace enablement/configuration is stored on `WorkspaceIndex.contextMapEnabled` and `WorkspaceIndex.contextMap` through ChatService route helpers. `ContextMapService` writes `context_runs`, `source_spans`, `conversation_cursors`, `source_cursors`, and pending `context_candidates` for incremental conversation and workspace-source processing, then auto-applies safe high-confidence candidates where possible. The candidate apply path can turn processor candidates into active or lifecycle-updated `entity_types`, `entities`, `entity_facts`, `relationships`, `evidence_refs`, and `evidence_links`. Active Map, entity detail/edit, Needs Attention, and read-only Context Map MCP tools all read from this same canonical store.

For each newly processed conversation span, `ContextMapService` resolves the Context Map processor CLI from workspace override settings or global `Settings.contextMap`, calls the backend adapter's `runOneShot()` with a strict JSON extraction prompt and the active run's `AbortSignal`, and persists candidate rows only after parsing succeeds. The prompt tells the processor to use the built-in type catalog (`person`, `organization`, `project`, `workflow`, `document`, `feature`, `concept`, `decision`, `tool`, `asset`) for entity candidates unless it is explicitly proposing a `new_entity_type`, to use `feature` for user-facing capabilities/behavior areas/proposals, to avoid routine GitHub issue/PR entities, to avoid duplicate project-prefixed/unprefixed names for the same concept, to classify maintained specs/ADR collections/roadmaps/plans as `document` entities instead of workflows, to emit relationship payloads as `subjectName`/`predicate`/`objectName` with `evidenceMarkdown`, to reserve `implements` / `implemented_by` for concrete implementation ownership/component evidence rather than UI placement, navigation, or access details, and to use `part_of` project/root relationships only with explicit high-confidence evidence. Source-packet prompts add source-local judgment: the processor should first decide whether the source deserves candidates at all, prefer empty output over weak extraction, usually extract at most one durable document/concept from blog posts or essays, extract people plus only the most durable related items from contact/profile files, and extract one workflow plus critical durable rules/tools from workflow files. Before persistence, the service normalizes common type aliases such as `product`, `feature_proposal`, `capability`, `subsystem`, `backend`, `issue`, `pull_request`, `architecture`, `security_policy`, and `principle` into built-in types, normalizes aliases to plain strings, normalizes fact arrays to readable strings even when the processor emits object-shaped facts such as `{ markdown }` or `{ text }`, and merges alternate fact fields (`factsMarkdown`, `factMarkdown`, `keyFacts`, `durableFacts`, `factStatements`) into canonical `payload.facts` before dropping the alternate keys. It drops redundant `new_entity_type` candidates for built-in or aliased built-in types, preserves a custom entity type slug only when the same processor output includes a `new_entity_type` candidate for that slug, corrects source-path sensitivity mismatches where obvious work-source paths should be `work-sensitive` or personal-source paths should be `personal-sensitive` while keeping `secret-pointer` sticky, normalizes legacy relationship keys such as `sourceName`/`targetName`/`relationshipType`, normalizes common predicates such as `supports_backend` -> `supports` and `is specified by` -> `specified_by`, drops relationship candidates with non-governed comparative/ad-hoc predicates such as `extends` or `preserves_data_unlike`, drops self-relationships after raw extraction and again after endpoint resolution, filters evidence-link candidates that cannot identify an existing target, folds same-output `sensitivity_classification` candidates into matching `new_entity.sensitivity`, drops orphan sensitivity classifications that do not target an active or proposed entity, de-duplicates/canonicalizes equivalent entity candidates within the same run, converts new-entity proposals that match active entities into `entity_update` candidates, drops model-emitted update candidates that do not resolve to active entities, drops no-op update candidates when source rescans only repeat information already present on the active entity, resolves relationship endpoints against active, existing pending, or same-run entity suggestions, scores resolved relationships by governed predicate, endpoint type compatibility, confidence, and evidence, rejects `implements` / `implemented_by` edges whose implementation endpoint is only another `feature`, rejects `part_of` edges into a project/root entity below `0.8` confidence, and folds rejected relationship evidence into same-run subject entity `facts` when that evidence is useful but not strong enough to justify an edge. If deterministic cleanup leaves at least eight candidate drafts, or at least three candidate drafts for a scheduled run, the same processor receives bounded synthesis/ranking prompts (`timeoutMs: 180000`, `allowTools:false`) that cite stable input `sourceRef` ids and active entity context. Up to 36 candidates use one `single` synthesis pass; larger sets are bucketed by source shape and chunked into at most 36 candidates per `chunk` pass, each targeting at most 10 full candidate outputs. The reduced chunk outputs are cleaned again, ranked, capped to 50 compact summaries for the `final` arbiter prompt, and the final arbiter returns decisions rather than full candidate rewrites: `keepRefs`, `dropRefs`, `mergeGroups`, `typeCorrections`, and `relationshipToFactRefs`. The backend applies those decisions to the normalized candidates, targets 34 or fewer final candidates while keeping a hard cap of 45, folds weak relationship refs into facts on kept subject entities, folds weak same-source local entities into facts on a stronger parent, and can recover up to 12 strict relationship candidates from original extraction when both endpoints survived synthesis. Invalid synthesis JSON gets one bounded repair pass through the same processor (`timeoutMs: 90000`, `allowTools:false`) with instructions to return valid JSON without inventing new refs/candidates/facts; successful repairs proceed without fallback, and failed repairs use the normal bounded fallback path. Invalid chunk synthesis falls back to ranked bounded subsets for the chunk; invalid final arbiter output falls back to the ranked reduced set capped at 40 candidates before final deterministic cleanup, so synthesis failure cannot flood Needs Attention. `context_runs.metadata.candidateSynthesis` records attempted/input/output/dropped counts, target/hard-cap counts, open questions, per-stage metadata, fallback state, sampled errors, repair attempted/succeeded/error metadata, and the fallback bound. Candidate payloads include the processor-provided fields plus a `sourceSpan` object (`spanId`, `runId`, `sourceType:'conversation_message'`, `conversationId`, `sessionEpoch`, `startMessageId`, `endMessageId`, `sourceHash`); merged synthesized candidates can also carry `relatedSourceSpans` for additional cited evidence units. Extraction and parsing failures are isolated per span/source packet. Successful units still commit their source spans, conversation/source cursors, and candidates; failed units are listed in `context_runs.metadata.extractionFailures`, counted by `extractionUnitsFailed`, and left retryable. A partially successful run finishes `completed` with a warning in `error_message`; a run where every extraction unit fails finishes `failed`. If the user stops the run, it is marked `stopped`; stopped units do not commit cursors/source spans/candidates so the same range can be retried without duplicate outputs.

`context_runs.metadata.timings` records scan phase durations for `totalMs`, `planningMs`, `sourceDiscoveryMs`, `extractionMs`, `synthesisMs`, `persistenceMs`, and `autoApplyMs`, plus extraction-unit counts with the 20 slowest units (`sourceType`, `sourceId`, `durationMs`, `status`, candidate count, and repair flag) and synthesis stage timings that mirror `candidateSynthesis.stages[]`.

Extraction and synthesis use separate process-wide concurrency limiters in the server process. `Settings.contextMap.extractionConcurrency` (default 3, clamped 1..6) controls extraction spans/source packets and extraction JSON repair calls; `Settings.contextMap.synthesisConcurrency` (default 3, clamped 1..6) controls chunk synthesis, final arbiter, and synthesis/arbiter JSON repair calls. Parallel extraction and chunk synthesis results are merged back in deterministic source/chunk order before candidate IDs, source spans, candidate synthesis metadata, or run timing metadata are persisted.

Initial scans and manual rebuild scans also process product-owned workspace source packets ([ADR-0045](adr/0045-scan-workspace-markdown-recursively-for-context-map.md)); scheduled scans discover the same source set but only extract packets whose `source_cursors` row is missing, has a different `last_processed_source_hash`, or is currently `missing` ([ADR-0046](adr/0046-track-context-map-workspace-source-cursors.md)). Manual rebuild is deliberately a full re-evaluation path for the currently selected source set and does not skip unchanged source packets. Reset/archive finalizer scans are conversation-scoped and skip workspace source packets entirely. Currently supported source packets are `workspace_instruction` (`sourceId:'workspace-instructions'`), `file`, and `code_outline`: known high-signal Markdown files are loaded first, then up to 120 additional `.md` files are discovered recursively under the workspace root using deterministic path scoring/order, and selected software-workspace files are summarized into bounded code-outline packets. The recursive scan skips hard infrastructure/generated-state directories (`.git`, `node_modules`, and `data/chat`), ignores files over 1 MB, and truncates each source body to the Context Map source character limit. Thin compatibility shims are skipped when the canonical source exists: a short `CLAUDE.md` that defers to `AGENTS.md` is not scanned separately, and a root `SPEC.md` redirect/index is not scanned separately when `docs/SPEC.md` exists. Selected Markdown files that become empty, unreadable, oversized, or shim-skipped are treated as unprocessable and can mark an existing source cursor `missing`; lower-ranked recursive Markdown files outside the 120-file cap remain discovered/deferred so their existing cursors are not marked missing only because of the cap. Source-packet prompts tell the processor not to expand README/spec feature lists into every listed feature. The service enforces a smaller deterministic budget before synthesis: four candidates for workspace instructions, three for `AGENTS.md`/`CLAUDE.md`, five for `README.md`/`SPEC.md`/`docs/SPEC.md`, four for `workflows/*` and `context/contact-*`, three for `drafts/*`, two for blog/theme content under `repos/*`, five for other Markdown source packets, and eight for code-outline packets. Source packet candidate payloads include `sourceSpan: { sourceType, sourceId, runId, sourceHash, locator }`, and source evidence refs can point at these non-conversation sources. Candidate ids for source packets are stable across `(sourceType, sourceId, sourceHash, candidateType, payload with runId provenance stripped recursively)`, so repeated manual scans skip exact duplicate candidates instead of duplicating pending work even though each run gets a new run id; semantic run-level de-duplication also prevents repeated entity/type/relationship suggestions from different source packets in the same run. If source discovery no longer sees a previously active source cursor, or a selected source is discovered but cannot be packetized, the service marks that cursor `missing`, records `sourceCursorsMarkedMissing` and sampled `staleSources` in run metadata, and leaves existing graph/candidate/evidence data untouched.

After persistence, `ContextMapService` auto-applies safe additive candidates and leaves the rest pending as Needs Attention. Auto-apply always requires a pending candidate with `payload.sourceSpan`; `new_entity` and durable non-generic `new_relationship` candidates use a `0.80` confidence threshold, additive `entity_update` candidates use `0.90`, `alias_addition` uses `0.94`, and `sensitivity_classification` / `evidence_link` use `0.96`. `new_entity` auto-apply also requires a known built-in/existing entity type, a non-secret sensitivity, and a durable body (`summaryMarkdown`, `notesMarkdown`, or facts). `new_relationship` auto-apply also requires evidence, a predicate other than `relates_to`, non-identical subject/object endpoints, and no pending endpoint dependencies. `entity_update` auto-apply is deliberately narrower than manual apply: it can add facts, aliases, evidence, or fill an empty summary/notes field, but cannot rename an entity, change its type/status/sensitivity, or overwrite an existing summary/notes field. `sensitivity_classification` auto-apply only permits moves to a more restrictive sensitivity class; downgrades, no-ops, and work-vs-personal lateral changes remain pending for review. Processor auto-apply records `appliedBy:'processor'` in the candidate audit event. Each completed run re-evaluates existing pending candidates as well as newly inserted candidates, so candidates created under an older policy can be applied later if they satisfy the current safe rules. Run metadata records `candidatesInserted`, `candidatesAutoApplied`, `existingCandidatesAutoApplied`, `candidatesNeedingAttention`, and sampled `autoApplyFailures`.

The Needs Attention surface reads `context_candidates` through `GET /context-map/review` and supports edit/apply/dismiss/restore decisions for pending exceptions. The normal queue requests `status=pending`; dismissed history requests `status=discarded`, while the backend can still return `status=all` for full audit views. Editing is allowed only while a candidate is `pending`; it rewrites `payload_json` and `confidence`, preserves the existing `payload.sourceSpan` when the edit omits it, and writes an `audit_events` row with `eventType:'edited'` plus previous payload/confidence in `details`. Applying candidates sets `status:'active'`, stores `appliedAt`, creates or reuses active graph rows, updates entity/relationship fields for update candidates, marks merged source entities `superseded`, marks removed relationships `superseded` by default, links explicit or source-span evidence to the candidate and active/lifecycle target, and writes an `audit_events` row with `eventType:'applied'` plus applied target details and `appliedBy:'user'` for manual applies. Discarding a candidate sets `status:'discarded'`; restoring sets `status:'pending'`. Each state-changing candidate decision writes an `audit_events` row targeting the candidate with the previous status in `details`.

Context Map MCP access is read-only and uses bearer-token sessions scoped to the conversation/workspace. MCP responses are generated directly from active `entities`, `entity_aliases`, `entity_facts`, `relationships`, and `evidence_refs` rows. `secret-pointer` entities expose only identity/sensitivity metadata through MCP, withholding summary, notes, facts, and evidence content; MCP search also excludes hidden summary, notes, and facts for those entities so secret text cannot be inferred by probing query matches.

The Workspace Settings Active Map view uses `GET /context-map/graph` for the compact browse snapshot and `GET /context-map/entities/:entityId` for selected entity detail. The graph projection supports query, entity type, lifecycle status, sensitivity, and limit filters. Entity rows include lifecycle `status`; `all` status filtering exposes inactive states such as `discarded`, `superseded`, `stale`, and `conflict` for review/cleanup. The detail panel can edit `name`, `typeSlug`, `status`, `sensitivity`, `confidence`, `summaryMarkdown`, and `notesMarkdown` through `PUT /context-map/entities/:entityId`; each edit writes an entity-target `audit_events` row. Graph/detail views read directly from canonical `entities`, `entity_aliases`, `entity_facts`, `relationships`, `evidence_refs`, `evidence_links`, and `audit_events` rows. They are projections rather than second stores: no graph/UI-specific files are generated, and no editable projection exists.

`Conversation.contextMap` carries the compact composer/settings summary `{ enabled, pending, pendingCandidates, staleCandidates, conflictCandidates, failedCandidates, runningRuns, failedRuns, latestRunId?, latestRunStatus?, latestRunCreatedAt?, latestRunUpdatedAt?, latestRunSource?, lastRunId?, lastRunStatus?, lastRunCreatedAt?, lastRunUpdatedAt?, lastRunSource? }`. `GET /conversations/:id` hydrates it when Context Map is enabled for the workspace. Workspace-scoped `context_map_update` frames carry the same shape after processing, candidate decisions, entity edits, clear/reset, or enablement changes.

`sourceFingerprints` guard apply/regenerate paths against stale memory: when a source file's content, type, name/description, or lifecycle metadata changes after review generation, the item is marked `stale` instead of being applied. Item status `discarded` means the user dismissed that item from the current review run; it is retained in the persisted run as a review decision/audit record, does not apply memory changes, and does not suppress future review generation. Regenerating a discarded draft clears `discardedAt` and moves the item back to `pending` with a fresh draft. `Conversation.memoryReview` carries the compact composer/settings summary `{ enabled, pending, pendingRuns, pendingDrafts, pendingSafeActions, failedItems, latestRunId?, latestRunStatus?, latestRunCreatedAt?, latestRunUpdatedAt?, latestRunSource?, lastRunId?, lastRunStatus?, lastRunCreatedAt?, lastRunUpdatedAt?, lastRunSource? }`. `latestRun*` points at the actionable run the composer should open when one exists; `lastRun*` always points at the newest persisted run so Workspace Settings can show when the most recent review ran and whether it was manual or scheduled.

Every apply call that has applied or skipped actions writes `memory/audits/consolidation_<timestamp>.json`:

```typescript
{
  version: 1,
  createdAt: string,
  summary: string,
  applied: MemoryConsolidationAction[],
  skipped: Array<{ action: MemoryConsolidationAction, reason: string }>,
  appliedDraftOperations?: MemoryConsolidationDraftOperation[],
  skippedDraftOperations?: Array<{ operation: MemoryConsolidationDraftOperation, reason: string }>
}
```

Audits are append-only review records. They do not change `snapshot.json` directly and never contain full redacted memory content.

## CLI Instruction Compatibility Status

`GET /workspaces/:hash/instruction-compatibility` returns a computed, non-persisted status object:

```javascript
{
  workspaceHash: string,
  workspacePath: string,
  sources: [{
    id: 'agents' | 'claude' | 'kiro',
    vendor: 'codex' | 'claude-code' | 'kiro',
    label: string,
    expectedPath: string,
    present: boolean,
    paths: string[]        // workspace-relative files detected for that source
  }],
  vendors: [{
    vendor: 'codex' | 'claude-code' | 'kiro',
    label: string,
    sourceId: 'agents' | 'claude' | 'kiro',
    expectedPath: string,
    covered: boolean
  }],
  missingVendors: vendors[],
  hasAnyInstructions: boolean,
  compatible: boolean,
  canCreatePointers: boolean,
  fingerprint: string,     // sha256-derived 16-char fingerprint of present sources + missing vendors
  dismissed: boolean,      // true when fingerprint matches WorkspaceIndex.instructionCompatibilityDismissedFingerprint
  shouldNotify: boolean,   // true when action is needed and not dismissed
  primarySourceId: 'agents' | 'claude' | 'kiro' | null
}
```

Detection is filesystem-based and read-only: `AGENTS.md` covers Codex/vendor-neutral agents, `CLAUDE.md` covers Claude Code, and any `*.md` under `.kiro/steering/` covers Kiro. Pointer creation writes only missing files with exclusive-create semantics and never overwrites existing instruction files.

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
    planFilePath?: string,      // Claude plan file path when a plan Write/ExitPlanMode event exposes it
    duration: number|null,      // Estimated duration in milliseconds
    startTime: number,          // Unix timestamp ms when event was received
    outcome?: string,           // Short outcome summary (e.g. 'exit 0', '4 matches', 'not found')
    status?: string             // 'success' | 'error' | 'warning' (derived from tool result)
  }],
  contentBlocks?: ContentBlock[] // Assistant only. Ordered interleaving of text, thinking,
                                //   tool, and generated-artifact blocks as the CLI emitted
                                //   them, so the renderer can display "text → tool → image"
                                //   in source order
                                //   instead of grouping all tools before all text. When
                                //   present this field is authoritative; `content`,
                                //   `thinking`, and `toolActivity` are derived views kept
                                //   for back-compat. Absent on legacy messages written
                                //   before this field existed (the renderer falls back to
                                //   the legacy fields in that case). See ContentBlock below.
  streamError?: {               // Assistant only. Marks a durable terminal stream failure.
    message: string,            // Raw terminal backend/server error message.
    source?: 'backend'|'transport'|'abort'|'server'
                                // Error source. Terminal backend/server failures are
                                // persisted; non-terminal warning frames are not.
  },
  goalEvent?: GoalEvent,        // System only. Marks a durable goal lifecycle event
                                //   (`set`, `resumed`, `paused`, `achieved`,
                                //   `budget_limited`, `cleared`, etc.) rendered by
                                //   desktop and mobile as a goal timeline card rather
                                //   than ordinary assistant/user dialogue.
  pinned?: boolean              // User-controlled pin marker. `true` marks the
                                //   active-session message for the pinned strip
                                //   and inline pinned styling. Omitted/absent is
                                //   equivalent to unpinned.
}
```

### GoalEvent

```ts
type GoalEventKind =
  | 'set'
  | 'resumed'
  | 'paused'
  | 'achieved'
  | 'budget_limited'
  | 'cleared'
  | 'updated'
  | 'unknown';

interface GoalEvent {
  kind: GoalEventKind;
  backend?: 'codex' | 'claude-code' | 'claude-code-interactive' | string;
  objective?: string;
  status?: 'active' | 'paused' | 'budgetLimited' | 'complete' | 'cleared' | 'unknown';
  reason?: string | null;
  goal?: ThreadGoal | null;
}
```

Goal lifecycle messages use `role: 'system'` and ordinary `Message.content`
for export/search previews, but `goalEvent` is the authoritative structured
payload for rendering. The route layer persists a `set` event for every
accepted goal objective, route-level `paused`/`resumed`/`cleared` events for
idle controls, and terminal stream-derived events such as `achieved` or
`budget_limited` when a backend reports those statuses. Goal objectives stored
on both `goalEvent.objective` and embedded `goalEvent.goal.objective` are
normalized by the route layer to remove accidental copied lifecycle-card or
goal-strip prefixes such as `Goal setcodex...`.

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

// A generated assistant artifact, persisted under
// data/chat/artifacts/{conversationId}/ and served through
// GET /conversations/:id/files/:filename. Used for backend-produced images
// and files that arrive outside normal assistant text.
{ type: 'artifact', artifact: ConversationArtifact }
```

Ordering rules:

- Blocks are appended in the order the backend emits events. The Claude Code
  stream-json adapter, Claude Code Interactive transcript mapper, and Kiro
  adapter yield `text` / `thinking` / `tool_activity` / `tool_outcomes`
  stream events in native source order.
- Consecutive `text` events collapse into one `text` block (same for
  `thinking`). This keeps the block list compact while preserving the
  interleaving relative to tools.
- `tool_activity` events for plan-mode enter/exit and user-question
  prompts are **not** persisted as tool blocks (matching the existing
  `toolActivity[]` filtering behavior).
- `tool_outcomes` patches the matching tool block in place by
  `activity.id`, updating `outcome` and `status`.

### Stream Error Events

Backend adapters may emit WebSocket stream errors with terminal metadata:

```javascript
{
  type: 'error',
  error: string,
  terminal?: boolean, // omitted/true = ends the CLI turn; false = warning
  source?: 'backend'|'transport'|'abort'|'server'
}
```

Terminal errors are persisted as assistant messages with `streamError` and
`turn: 'final'`. Non-terminal warnings, such as Kiro model-switch fallback
warnings, are forwarded to the client but do not create `Message.streamError`,
do not end the stream, and do not unblock the queue.

Explicit aborts persist the same shape with `source: 'abort'`. When the
streaming loop has already accumulated assistant output, that partial assistant
message is saved before the abort `streamError` message. If a backend/server
terminal error is already being finalized when an abort request arrives, the
original backend/server `streamError` remains authoritative.

### ActiveStreamSummary

Returned by `GET /api/chat/active-streams` for server-owned CLI turns:

```typescript
interface ActiveStreamSummary {
  id: string;                 // Conversation ID
  jobId?: string | null;      // Durable stream job ID when known
  state?: StreamJobState;     // Durable lifecycle state (`running` for runtime-only test entries)
  backend: string;            // Runtime backend handling the active turn
  startedAt: string | null;   // ISO timestamp when the server accepted the turn
  lastEventAt: string | null; // ISO timestamp of the latest backend stream event
  connected: boolean;         // true when a browser WebSocket is currently open
  runtimeAttached: boolean;   // true when this process owns a backend iterator
  pending: boolean;           // true during accepted/preparing before an iterator exists
  runtime: StreamJobRuntimeInfo | null; // Backend runtime IDs recorded for this active job
}
```

`ids: string[]` remains in the same response for hydration compatibility; it is
the projection of `streams[].id`.

### Durable Stream Jobs

`data/chat/stream-jobs.json` is an operational registry of active accepted CLI
turns. It is written atomically and contains only non-terminal jobs; completion,
explicit abort finalization, delete/archive cleanup, and startup reconciliation
remove jobs once the transcript is the durable source of truth.

```typescript
type StreamJobState =
  | 'accepted'        // POST /message accepted; user message may not exist yet
  | 'preparing'       // request is resolving profile/context/MCP setup
  | 'running'         // backend stream object is attached in activeStreams
  | 'abort_requested' // Stop was requested before terminal finalization
  | 'finalizing';     // terminal error/abort/restart marker is being persisted

interface StreamJobTerminalInfo {
  message: string;
  source: 'backend'|'transport'|'abort'|'server';
  at: string;
}

interface StreamJobRuntimeInfo {
  externalSessionId?: string|null; // Backend-managed session/thread id
  activeTurnId?: string|null;      // Backend-managed active turn id, when exposed
  processId?: number|null;         // Local child process id, diagnostic only
}

interface DurableStreamJob {
  id: string;
  state: StreamJobState;
  conversationId: string;
  sessionId: string;
  userMessageId?: string|null;
  backend: string;
  cliProfileId?: string|null;
  model?: string|null;
  effort?: string|null;
  serviceTier?: string|null;
  workingDir?: string|null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string|null;
  lastEventAt?: string|null;
  runtime?: StreamJobRuntimeInfo|null;
  abortRequested?: StreamJobTerminalInfo|null;
  terminalError?: StreamJobTerminalInfo|null;
}

interface StreamJobFile {
  version: 1;
  jobs: DurableStreamJob[];
}
```

On startup, any job left in `accepted`, `preparing`, `running`,
`abort_requested`, or `finalizing` is reconciled before the server listens. If
the recorded `userMessageId` still exists, the server appends one terminal
assistant `streamError`; otherwise it removes the job without transcript noise.
Plain active jobs use `message: "Interrupted by server restart"` and
`source: "server"`. Jobs that already carry `abortRequested` or
`terminalError` persist that recorded terminal reason instead. Reconciliation is
idempotent: if the matching terminal `streamError` is already the final
message, no duplicate is appended.

During a graceful `SIGTERM`/`SIGINT`, `StreamJobSupervisor` marks all pending
and runtime-attached jobs `finalizing` with
`message: "Interrupted by server shutdown"` and `source: "server"` before
aborting process-local backend handles. Those jobs remain in the file so the
next startup reconciliation pass uses the same durable terminal path.

`runtime` is operational metadata, not an audit log. `processStream` writes
`runtime.externalSessionId` when it consumes an adapter's `external_session`
event, and merges `backend_runtime` events carrying process IDs and backend
active-turn IDs. Claude Code, Claude Code Interactive, Kiro, and Codex emit
`processId` when their local child process is available; Codex records the app-server turn id from the
`turn/start` response path, emits it as `backend_runtime.activeTurnId` from
that path, and dedupes `turn/started` if the notification is also emitted.
Today those identifiers support diagnostics and
next-turn rehydration only; startup reconciliation still does not re-send
prompts or reattach to an in-flight turn unless a backend explicitly advertises
active-turn resume support.

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
`src/services/chat/attachments.ts` (re-exported by `chatService.ts` for
legacy imports and mirrored on the client by `StreamStore.attachmentKindFromPath`).
Legacy entries migrated from the pre-typed `[Uploaded files: …]` tag carry
only `name`, `path`, and `kind` — `size` and `meta` are unavailable for those.

### ConversationArtifact

Typed generated artifact metadata persisted on assistant `contentBlocks`.
Unlike `AttachmentMeta`, which describes user uploads and queued attachment
chips, `ConversationArtifact` describes files produced by a backend/tool during
assistant generation. The server copies source bytes into the same per-
conversation artifact directory used by uploads so desktop and mobile clients
can use the existing conversation-file endpoint.

```typescript
interface ConversationArtifact {
  filename: string;       // Stored basename under data/chat/artifacts/{convId}/
  path: string;           // Absolute server path to the stored artifact
  kind: AttachmentKind;   // Server-inferred category; images render inline
  size?: number;          // Bytes after persistence
  mimeType?: string;      // Backend-provided or inferred MIME type
  title?: string;         // Optional display label, e.g. "Generated image"
  sourceToolId?: string|null; // Backend tool/item id that produced it
}
```

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
Queue PUT validation requires every attachment to include at least string
`name` and non-empty string `path`; `kind`, `size`, and `meta` are tolerated
metadata but are not required at that boundary.

**Legacy migration:** `MessageQueueStore` runs `normalizeMessageQueue()` on
every read of `messageQueue` behind the `ChatService` facade and handles three
cases:
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
  effort?: string,              // Adaptive reasoning effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  serviceTier?: string,         // Codex-only service tier override; currently 'fast'
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

## CLI Update Status (API-only)

CLI update state is process-local and in-memory. No CLI update cache is written to disk; the service rebuilds it from settings and subprocess probes after startup.

```ts
type CliInstallMethod = 'npm-global' | 'self-update' | 'unknown' | 'missing';

interface CliUpdateStatus {
  id: string;
  vendor: 'claude-code' | 'codex' | 'kiro';
  label: string;
  command: string;
  resolvedPath: string | null;
  profileIds: string[];
  profileNames: string[];
  installMethod: CliInstallMethod;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  updateSupported: boolean;
  updateInProgress: boolean;
  lastCheckAt: string | null;
  lastError: string | null;
  updateCommand: string[] | null;
  interactiveCompatibility?: CliCompatibilityStatus[];
  blocksAutoUpdate?: boolean;
  updateCaution?: string | null;
}

interface CliCompatibilityStatus {
  providerId: 'claude-code-interactive';
  command: string;
  currentVersion: string | null;
  testedVersion: string;
  status: 'supported' | 'newer' | 'older' | 'unknown' | 'missing';
  severity: 'none' | 'warning' | 'error';
  message: string | null;
}

interface CliUpdatesResponse {
  items: CliUpdateStatus[];
  lastCheckAt: string | null;
  updateInProgress: boolean;
}
```

## Settings (`data/chat/settings.json`)

```json
{
  "theme": "system",
  "sendBehavior": "enter",
  "systemPrompt": "",
  "defaultBackend": "claude-code",
  "defaultCliProfileId": "server-configured-claude-code",
  "cliProfiles": [
    {
      "id": "server-configured-claude-code",
      "name": "Claude Code (Server Configured)",
      "vendor": "claude-code",
      "protocol": "standard",
      "authMode": "server-configured",
      "createdAt": "2026-04-29T00:00:00.000Z",
      "updatedAt": "2026-04-29T00:00:00.000Z"
    }
  ],
  "defaultModel": "claude-sonnet-4-6",
  "defaultEffort": "high",
  "workingDirectory": "",
  "memory": {
    "cliProfileId": "server-configured-claude-code",
    "cliBackend": "claude-code",
    "cliModel": "claude-sonnet-4-6",
    "cliEffort": "high"
  },
  "knowledgeBase": {
    "ingestionCliProfileId": "server-configured-claude-code",
    "ingestionCliBackend": "claude-code",
    "ingestionCliModel": "claude-sonnet-4-6",
    "ingestionCliEffort": "high",
    "digestionCliProfileId": "server-configured-claude-code",
    "digestionCliBackend": "claude-code",
    "digestionCliModel": "claude-sonnet-4-6",
    "digestionCliEffort": "high",
    "dreamingCliProfileId": "server-configured-claude-code",
    "dreamingCliBackend": "claude-code",
    "dreamingCliModel": "claude-opus-4-7",
    "dreamingCliEffort": "high",
    "cliConcurrency": 2,
    "dreamingStrongMatchThreshold": 0.75,
    "dreamingBorderlineThreshold": 0.45,
    "convertSlidesToImages": false,
    "kbGleaningEnabled": false
  },
  "contextMap": {
    "cliProfileId": "server-configured-claude-code",
    "cliBackend": "claude-code",
    "cliModel": "claude-sonnet-4-6",
    "cliEffort": "high",
    "scanIntervalMinutes": 5,
    "cliConcurrency": 1,
    "extractionConcurrency": 3,
    "synthesisConcurrency": 3
  }
}
```

`cliProfiles` is the global list of runnable CLI identities. Fresh settings start with an empty `cliProfiles` array and no provider default; the app does not create a Claude Code profile until a user configures Claude Code, selects a Claude backend explicitly, or a legacy settings/conversation migration requires it ([ADR-0061](adr/0061-use-configured-cli-profiles-as-default-runtime.md)). The current implementation supports server-configured and account/custom profiles for Codex and Claude Code, and resolves `cliProfileId → CliProfile` for command/auth/config plus the runtime communication path. Claude Code profiles also carry `protocol: "standard" | "interactive"`: `standard` maps to internal backend `claude-code`, while `interactive` maps to internal backend `claude-code-interactive`. `claude-code-interactive` is therefore not a separate profile vendor; it shares `vendor: "claude-code"` for `command`, `env`, `CLAUDE_CONFIG_DIR`, auth, plan usage, and CLI update targets. Server-configured profiles preserve existing behavior where each adapter uses the server user's already-configured CLI state. Codex profiles apply `command`, merged `env`, and `configDir → CODEX_HOME` for `codex app-server`, `codex exec`, MCP config collision reads, Codex plan usage, and remote auth jobs. Claude Code profiles apply `command`, merged `env`, and `configDir → CLAUDE_CONFIG_DIR` for both standard streaming and interactive hidden PTY sessions, one-shots, native memory path resolution/capture, Claude plan usage, and remote auth jobs. For both implemented vendors, `configDir` takes precedence over the matching env key when both are present. If an explicit Codex or Claude Code account profile starts a remote auth check/job without a `configDir`, the server persists a deterministic default under `data/cli-profiles/<slug>-<sha1>/` so authentication and later runtime spawns use the same isolated config/auth home. Welcome setup auth can create first-run account profiles named `setup-codex-account` and `setup-claude-code-account` ([ADR-0060](adr/0060-use-cli-profile-auth-for-setup-login.md), [ADR-0064](adr/0064-use-system-cli-auth-for-welcome-setup.md)); those setup profiles intentionally omit `configDir` so Agent Cockpit and terminal `codex` / `claude` commands share the user's normal vendor CLI auth home. Legacy setup profiles that have a generated `configDir` or auth-home env key (`CODEX_HOME` / `CLAUDE_CONFIG_DIR`) are migrated at the settings/profile-auth boundary by removing those fields, so both setup-auth routes and direct profile checks use system auth. When no default exists, or when a setup profile replaces that vendor's server-configured default, it becomes `defaultCliProfileId` so the completed login is used by new conversations. Kiro profiles are self-configured only: `SettingsService.saveSettings()` forces `authMode: "server-configured"` and strips `command`, `configDir`, `env`, and `protocol` because `kiro-cli` has no dedicated documented profile directory override and isolating via `HOME` changes unrelated process behavior. Deterministic server-configured IDs are `server-configured-claude-code`, `server-configured-kiro`, and `server-configured-codex`. `SettingsService.getSettings()` only creates a server-configured physical profile for persisted legacy `defaultBackend` values and otherwise promotes the first enabled existing profile when no default is selected.

`defaultCliProfileId` points at the CLI profile used by the V2 UI for new conversations. New conversations still accept/return `backend` for compatibility, but new profile-based selection derives `backend` from `CliProfile.vendor + CliProfile.protocol` instead of exposing a separate backend/provider picker. `ChatService.createConversation()` accepts an optional `cliProfileId`; when supplied without an explicit backend, the profile's protocol-derived backend is stored. A conflicting explicit `backend` is rejected. When neither profile nor backend is supplied, the service uses `settings.defaultCliProfileId` when valid and derives the backend from that profile; otherwise it falls back only to legacy `settings.defaultBackend` when present. If neither is configured, creation fails with a CLI-profile-required error. When only a backend is supplied, the service derives `cliProfileId` from the selected backend's physical server-configured profile.

`memory.cliProfileId` selects the profile used by the Memory CLI for `memory_note` formatting/deduping and post-session extraction. `memory.cliBackend` is retained as a legacy fallback and is kept aligned to the selected profile's protocol-derived backend on settings save. Runtime resolution uses `memory.cliProfileId` first, then legacy `memory.cliBackend`, then `defaultCliProfileId`, then legacy `defaultBackend`; if none exists, Memory processor actions record a graceful unavailable failure instead of assuming a provider.

`memory.lastProcessorStatus` stores the last redacted Memory processor status known to Agent Cockpit ([ADR-0053](adr/0053-persist-memory-processor-status.md)). Shape: `{ status, updatedAt, backendId?, profileId?, profileName?, chatBackendId?, chatProfileId?, chatProfileName?, differsFromChatProfile?, error? }`. `status` is one of `last_succeeded`, `authentication_failed`, `unavailable`, `runtime_failed`, or `bad_output`. Successful `memory_note` write/skip decisions store `last_succeeded`; processor profile resolution, adapter availability, `runOneShot`, and bad-output failures store the corresponding failure class. `error` is bounded and redacted before persistence, including credential-looking paths and token values. Chat profile fields are present only when the active conversation runtime supplied them while issuing the Memory MCP session.

`defaultEffort` is the default adaptive reasoning level for new conversations. It only applies when the chosen model matches `defaultModel` AND the model supports that effort level; otherwise the per-conversation selection falls back to `high` (or, defensively, the first supported level of the chosen model). The settings modal only renders the **Default Effort** field when `defaultBackend`/`defaultModel` resolve to a model that declares `supportedEffortLevels`; changing the default model to one without effort support drops `defaultEffort` on save.

`defaultServiceTier` is the Codex-only default speed tier for new conversations. The only stored value is `"fast"`; absence means the selected Codex profile/config decides the tier. The settings modal only renders **Default Speed** when the selected default profile/backend resolves to Codex. `SettingsService.saveSettings()` drops `defaultServiceTier` when the default runtime is not Codex or the value is unsupported. A conversation-level `serviceTier: "fast"` forces Codex Fast mode; explicit request values `null`, `""`, or `"default"` clear the override so the selected Codex profile/config applies.

The `systemPrompt` is passed to the CLI via `--append-system-prompt` at the start of each new session. It is additive — Claude Code's built-in system prompt is preserved. Legacy `customInstructions` objects in the JSON file are auto-migrated to `systemPrompt` on first read by `SettingsService`; the `customInstructions` field no longer exists in the `Settings` type.

The `memory` block configures the globally-shared **Memory CLI profile** used for `memory_note` MCP processing and post-session extraction (see [Backend Services — Workspace Memory](spec-backend-services.md#workspace-memory)).

The `knowledgeBase` block configures the globally-shared **Ingestion CLI profile**, **Digestion CLI profile**, and **Dreaming CLI profile** for the per-workspace Knowledge Base feature (see **Workspace Knowledge Base** subsection under `ChatService` below). The matching legacy `*CliBackend` fields are retained as fallbacks and are aligned to the selected profile's protocol-derived backend on save. Ingestion is opt-in (must be vision-capable, currently used for AI-assisted page/slide/image conversion at ingest time); leaving it unset falls back to image-only references for visual content. Digestion and Dreaming require a configured profile/backend before they run. `cliConcurrency` (default 2) caps how many documents are processed in parallel by ingestion, digestion, and dreaming pipelines per workspace; within a single document, work stays sequential. `kbGleaningEnabled` (default `false`) opts digestion into a second per-chunk pass that asks for missed entries after the first extraction. `convertSlidesToImages` opts into the LibreOffice-backed PPTX slide rasterization path; when enabled but LibreOffice is absent on `PATH`, ingestion logs a warning and falls back to text + speaker notes + embedded media only. LibreOffice presence is detected at server startup (`which soffice` / `where soffice`) and cached for the process lifetime. `dreamingStrongMatchThreshold` (default 0.75) and `dreamingBorderlineThreshold` (default 0.45) control the retrieval-based routing score thresholds: entries with a top hybrid-search score ≥ strong go directly to synthesis, ≥ borderline go to LLM verification, and below borderline create new topics.

The `contextMap` block configures globally-shared Context Map processor defaults for workspaces that opt into Context Map and keep `WorkspaceIndex.contextMap.processorMode` at `global`. `cliProfileId` selects the processor CLI profile; `cliBackend` is retained as a deprecated fallback/mirror and is aligned to the selected profile's protocol-derived backend on settings save. `cliModel` and `cliEffort` are optional processor overrides. `scanIntervalMinutes` defaults to `5` and is normalized to an integer from 1 to 1440. `cliConcurrency` defaults to `1` and is normalized to an integer from 1 to 10; it controls how many workspace scans the scheduler can start at once. `extractionConcurrency` and `synthesisConcurrency` both default to `3` and are normalized to integers from 1 to 6; they control process-wide extraction and synthesis one-shot CLI queues across all active Context Map scans. Source selection is not stored in settings: conversation spans are always processed, initial/manual scans process every discovered workspace instruction/Markdown/code-outline packet, and scheduled scans process only changed, new, or previously missing workspace source packets.

**Migration:** `dreamingConcurrency` was renamed to `cliConcurrency` in the hybrid-ingestion design (PR 1). On read, `SettingsService.getSettings()` copies `dreamingConcurrency` forward to `cliConcurrency` when the new key is missing — disk state is left untouched until the next save. Existing settings files load without warnings; the deprecated `dreamingConcurrency` field stays on the `Settings` type for one release cycle, then is removed.

**CLI profile migration:** On startup, `ChatService.initialize()` scans every workspace index and assigns `cliProfileId` to existing conversations that only have a `backend`. It creates matching server-configured profile records in settings for every vendor seen in existing conversations. The migration does not change `backend`, model, effort, sessions, or any runtime CLI behavior.

## KB SQLite Schema (Complete)

Each workspace owns one `knowledge/state.db` (better-sqlite3, WAL mode, `foreign_keys = ON`). Schema version is tracked in the `meta` table and bumped on migrations. Current version: **8** (`KB_DB_SCHEMA_VERSION`).

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

-- Per-raw document structure root metadata
CREATE TABLE IF NOT EXISTS kb_documents (
  raw_id           TEXT PRIMARY KEY REFERENCES raw(raw_id) ON DELETE CASCADE,
  doc_name         TEXT NOT NULL,
  doc_description  TEXT,
  unit_type        TEXT NOT NULL,      -- 'page'|'slide'|'line'|'section'|'unknown'
  unit_count       INTEGER NOT NULL DEFAULT 0,
  structure_status TEXT NOT NULL DEFAULT 'ready', -- 'ready'|'failed'
  structure_error  TEXT,
  created_at       TEXT NOT NULL,      -- ISO 8601
  updated_at       TEXT NOT NULL       -- ISO 8601
);

-- Deterministic or AI-assisted range nodes inside a document
CREATE TABLE IF NOT EXISTS kb_document_nodes (
  node_id        TEXT NOT NULL,
  raw_id         TEXT NOT NULL REFERENCES kb_documents(raw_id) ON DELETE CASCADE,
  parent_node_id TEXT,
  title          TEXT NOT NULL,
  summary        TEXT,
  start_unit     INTEGER NOT NULL,
  end_unit       INTEGER NOT NULL,
  sort_order     INTEGER NOT NULL,
  source         TEXT NOT NULL,        -- 'deterministic'|'ai'|'fallback'
  metadata_json  TEXT,
  PRIMARY KEY (raw_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_kb_doc_nodes_raw_order ON kb_document_nodes(raw_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_kb_doc_nodes_parent ON kb_document_nodes(raw_id, parent_node_id);

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

-- Source ranges that contributed to each digested entry
CREATE TABLE IF NOT EXISTS kb_entry_sources (
  entry_id   TEXT NOT NULL REFERENCES entries(entry_id) ON DELETE CASCADE,
  raw_id     TEXT NOT NULL REFERENCES raw(raw_id) ON DELETE CASCADE,
  node_id    TEXT,                     -- representative node only for single-node chunks; NULL for merged ranges
  chunk_id   TEXT NOT NULL,            -- deterministic chunk id from planDigestChunks()
  start_unit INTEGER NOT NULL,
  end_unit   INTEGER NOT NULL,
  PRIMARY KEY (entry_id, raw_id, chunk_id, start_unit, end_unit)
);
CREATE INDEX IF NOT EXISTS idx_kb_entry_sources_raw ON kb_entry_sources(raw_id);
CREATE INDEX IF NOT EXISTS idx_kb_entry_sources_entry ON kb_entry_sources(entry_id);

-- Workspace glossary for query expansion in KB search tools
CREATE TABLE IF NOT EXISTS kb_glossary (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  term       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  expansion  TEXT NOT NULL,
  created_at TEXT NOT NULL,            -- ISO 8601
  updated_at TEXT NOT NULL             -- ISO 8601
);

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

-- One row per Dream/Re-Dream run for auditable lifecycle status
CREATE TABLE IF NOT EXISTS synthesis_runs (
  run_id        TEXT PRIMARY KEY,
  mode          TEXT NOT NULL,         -- 'incremental'|'redream'
  status        TEXT NOT NULL,         -- 'running'|'completed'|'failed'|'stopped'
  started_at    TEXT NOT NULL,         -- ISO 8601
  completed_at  TEXT,                  -- ISO 8601, null while running
  error_message TEXT                   -- fatal error or nonfatal warnings summary
);

-- Topic evolution history written by mutating topic operations
CREATE TABLE IF NOT EXISTS synthesis_topic_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id    TEXT NOT NULL,
  change_type TEXT NOT NULL,           -- 'created'|'updated'|'merged_into'|'split_from'|'deleted'
  old_content TEXT,
  new_content TEXT,
  entry_ids   TEXT,                    -- JSON array of entry IDs assigned at change time
  run_id      TEXT REFERENCES synthesis_runs(run_id),
  changed_at  TEXT NOT NULL            -- ISO 8601
);
CREATE INDEX IF NOT EXISTS idx_topic_history_topic ON synthesis_topic_history(topic_id);
CREATE INDEX IF NOT EXISTS idx_topic_history_run ON synthesis_topic_history(run_id);

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
  started_at        TEXT NOT NULL,
  chunk_progress_json TEXT              -- optional KbDigestChunkProgress JSON for live chunk planning/digestion status
);
```

### Cascade Behavior

| Parent | Child | ON DELETE | Effect |
|--------|-------|-----------|--------|
| `raw` | `raw_locations` | CASCADE | Deleting raw removes all location rows |
| `raw` | `kb_documents` | CASCADE | Deleting raw removes its document-structure root |
| `kb_documents` | `kb_document_nodes` | CASCADE | Deleting document structure removes all range nodes |
| `raw` | `entries` | CASCADE | Deleting raw removes all derived entries |
| `raw` | `kb_entry_sources` | CASCADE | Deleting raw removes all entry source ranges |
| `folders` | `raw_locations` | RESTRICT | Cannot delete folder with locations (must empty first) |
| `entries` | `entry_tags` | CASCADE | Deleting entry removes its tags |
| `entries` | `kb_entry_sources` | CASCADE | Deleting or redigesting entries removes old lineage |
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
- **V2 → V3** (`_migrateV3`): Adds `original_citation_count INTEGER NOT NULL DEFAULT 0` to `synthesis_reflections` table. Backfills existing reflections by counting their current citation rows and updates `meta.schema_version` to `3` even when the column already exists.
- **V3 → V4** (`_migrateV4`): Adds `kb_documents` and `kb_document_nodes` through the idempotent schema DDL and updates `meta.schema_version` to `4`.
- **V4 → V5** (`_migrateV5`): Adds `kb_entry_sources` through the idempotent schema DDL and updates `meta.schema_version` to `5`.
- **V5 → V6** (`_migrateV6`): Adds `kb_glossary` through the idempotent schema DDL and updates `meta.schema_version` to `6`.
- **V6 → V7** (`_migrateV7`): Adds `synthesis_runs` and `synthesis_topic_history` through the idempotent schema DDL and updates `meta.schema_version` to `7`.
- **V7 → V8** (`_migrateV8`): Adds nullable `digest_session.chunk_progress_json` so live chunk planning/digestion progress can be persisted while a digest session is active, then updates `meta.schema_version` to `KB_DB_SCHEMA_VERSION`.
- **V1 → V8**: Runs V2, V3, V4, V5, V6, V7, then V8 sequentially.

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
  failedByStage: {
    conversion: number; // failed before any document structure row exists
    digestion: number;  // failed after conversion wrote kb_documents
    unknown: number;    // defensive remainder if status data cannot be classified
  };
  entryCount: number;
  pendingCount: number;   // internal digest queue aggregate: ingested + pending-delete
  folderCount: number;
  documentCount: number;
  documentNodeCount: number;
  entrySourceCount: number;
  topicCount: number;
  connectionCount: number;
  reflectionCount: number;
  staleReflectionCount: number;
  embeddingConfigured?: boolean;      // true when the workspace has KB embedding config
  entryEmbeddedCount?: number | null; // current DB entries that also exist in the PGLite vector store
  topicEmbeddedCount?: number | null; // current DB topics that also exist in the PGLite vector store
  embeddingIndexError?: string | null; // non-fatal vector-store read error, if coverage could not be checked
}

type KbAutoDreamMode = 'off' | 'interval' | 'window';

interface KbAutoDreamConfig {
  mode: KbAutoDreamMode;
  intervalHours?: number; // positive integer hours for interval mode
  windowStart?: string;   // HH:mm local server time for window mode
  windowEnd?: string;     // HH:mm local server time for window mode
}

interface KbAutoDreamState extends KbAutoDreamConfig {
  nextRunAt: string | null;       // next eligible scheduler start, or null when off
  windowActive?: boolean;         // true while local server time is inside the configured window
  windowEndAt?: string | null;    // current/next window end when mode is window
}

/** Full KB state snapshot returned by GET /workspaces/:hash/kb */
interface KbState {
  version: number;              // DB schema version
  entrySchemaVersion: number;   // KB_ENTRY_SCHEMA_VERSION (currently 1)
  autoDigest: boolean;
  autoDream: KbAutoDreamConfig;  // mirrors WorkspaceIndex.kbAutoDream, normalized to { mode: 'off' } when absent
  dreamingStatus: KbSynthesisStatus; // persisted synthesis status, overlaid to running by GET /kb while the in-memory dream lock is active
  dreamProgress: {
    phase: 'routing' | 'verification' | 'synthesis' | 'discovery' | 'reflection';
    done: number;
    total: number;
    startedAt?: number;
    phaseStartedAt?: number;
  } | null;
  needsSynthesisCount: number;  // digested entries still awaiting Dream/Synthesis
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
  autoDream?: KbAutoDreamState;
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
  /** Live aggregate chunk planning/extraction status for the active session. */
  chunks?: KbDigestChunkProgress;
}

type KbDigestChunkPhase = 'planning' | 'digesting' | 'parsing' | 'committing';

interface KbDigestChunkProgress {
  /** Chunks parsed successfully since the session opened. */
  done: number;
  /** Chunks planned so far; grows as queued raws reach the planner. */
  total: number;
  /** Chunks currently inside CLI extraction or parse handling. */
  active: number;
  /** Coarse phase for the most recently updated chunk/write step. */
  phase: KbDigestChunkPhase;
  /** Most recently updated raw/chunk; aggregate sessions may have more than one active chunk. */
  current?: {
    rawId: string;
    chunkId?: string;
    index?: number;
    total?: number;
    startUnit?: number;
    endUnit?: number;
    unitType?: string;
  };
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
    autoDream?: boolean;
    /**
     * Aggregate digestion progress. Emitted on every enqueue and every
     * task settle and on chunk planning/extraction phase changes; a final
     * `null` signal fires when the queue drains so the UI can clear the
     * indicator. Persisted to `digest_session` so `GET /kb` can rehydrate
     * after a browser reload.
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

interface BackendRuntimeEvent {
  type: 'backend_runtime';
  externalSessionId?: string|null;
  activeTurnId?: string|null;
  processId?: number|null;
}
```

## KB Constants

| Constant | Value | File | Purpose |
|----------|-------|------|---------|
| `KB_DB_SCHEMA_VERSION` | 8 | db.ts | Current SQLite schema version |
| `KB_ENTRY_SCHEMA_VERSION` | 1 | digest.ts | Entry markdown format version |
| `SYNTHESIS_BATCH_SIZE` | 10 | dream.ts | Entries per synthesis CLI batch |
| `EMBED_BATCH_SIZE` | 50 | dream.ts | Texts per Ollama embedding call |
| `DREAM_TIMEOUT_MS` | 1,200,000 (20 min) | dream.ts | Per-CLI-call timeout |
| `DEFAULT_MAX_ESTIMATED_TOKENS_PER_CHUNK` | 3,000 | chunkPlanner.ts | Soft converted-text budget for structure-aware digestion chunks when per-unit text lengths are available |
| `digestTimeoutMs` | adaptive per chunk: `max(30 min, chunkUnitCount × 10 min)` | digest.ts | Per-digestion CLI call timeout; chunked documents use the planned chunk unit count, whole-document fallback uses handler `pageCount`/`slideCount` |
| `DEFAULT_TIMEOUT_MS` | 600,000 (10 min) | ingestion/pageConversion.ts | Per-image AI conversion timeout (one CLI call per page/slide/embedded image) |
| `MAX_LONG_EDGE_PX` | 2576 | ingestion/pageConversion.ts | Long-edge cap (px) for images sent to vision models. Sources above this get a `.ai.png` downscaled sibling that handlers link to in `text.md` so digestion-time CLI reads also stay under the cap. |
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
| Upload size limit | 1 GB | kbRoutes.ts (multer) | Per-file KB raw upload cap |
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
