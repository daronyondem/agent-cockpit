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
│   │   ├── dataMigration.ts           # Browser-safe data export/import contracts and validators
│   │   ├── usagePricing.ts            # Browser-safe usage pricing catalog/override contracts
│   │   ├── conversations.ts           # Browser-safe conversation mutation contracts
│   │   ├── streams.ts                 # Browser-safe message/input mutation contracts
│   │   ├── explorer.ts                # Workspace file explorer mutation contracts
│   │   ├── gitChanges.ts              # Workspace Git status/diff response contracts
│   │   ├── uploads.ts                 # Attachment/OCR mutation contracts
│   │   ├── memory.ts                  # Workspace memory enablement and consolidation mutation contracts
│   │   ├── worktreeIsolation.ts       # Workspace worktree-isolation status/toggle contracts
│   │   ├── workspaceContext.ts        # Workspace Context settings mutation contracts
│   │   ├── routines.ts                # Workspace Routines manifests, settings, run records, and validators
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
│   │   └── chat/                       # Focused chat route modules: status, CLI profile, conversation, stream, goal, upload, filesystem, workspace archive/location, instructions, explorer, Git changes, worktree isolation, memory, Workspace Context, KB, data migration, shared helpers
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
│       │       ├── index.ts            # lazy pickHandler dispatch + ingestFile + UnsupportedFileTypeError
│       │       ├── passthroughSupport.ts # lightweight passthrough extension matrix for dispatch without native imports
│       │       ├── pdf.ts              # PDF page-by-page 150 DPI rasterization + hybrid pdfjs/AI per-page
│       │       ├── docx.ts             # DOCX → GFM markdown via pandoc + per-image AI description (hybrid)
│       │       ├── pptx.ts             # PPTX per-slide hybrid: XML extract / AI / image-only via signals + LO rasterization
│       │       └── passthrough.ts      # Text (md/txt/json/...) + hybrid image passthrough (per-image AI description, SVG bypass)
│       ├── cliProfiles.ts              # CLI profile helpers: server-configured profile IDs/defaults and runtime resolver
│       ├── cliUpdateService.ts         # In-memory local CLI version checks and supported CLI update commands
│       ├── dataMigrationService.ts      # Full data-root export/import bundle staging, verification, startup apply, and post-import checks
│       ├── chat/
│       │   ├── attachments.ts          # Attachment/artifact metadata helpers used by ChatService
│       │   ├── messageQueueStore.ts    # Private ChatService queue store + legacy queue normalization
│       │   ├── workspaceArchiveStore.ts # Private ChatService workspace archive lifecycle/summary store
│       │   ├── workspaceSnapshotService.ts # Verified ZIP snapshots, restore, and archive-owned file cleanup
│       │   ├── worktreeIsolationService.ts # Private ChatService Git worktree lifecycle helper
│       │   └── workspaceInstructionStore.ts # Private ChatService workspace instruction compatibility/pointer store
│       ├── usagePricing/               # Built-in pricing JSON, validator, estimator, and override store
│       ├── chatService.ts              # Conversation CRUD, messages, sessions
│       ├── settingsService.ts          # Settings I/O: read, write, legacy migration
    │       └── updateService.ts            # Self-update: dev git/main path and production GitHub Release path
├── public/
│   ├── favicon.svg
│   ├── logo-*.svg                      # Brand assets used by login, sidebar, and assistant avatars
│   ├── icons/*.svg                     # Source/reference icon assets, including provider avatars such as DeepSeek, Ollama, and OpenCode
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
│           ├── screens/                # Real V2 screens: KB, files, and settings
│           └── *.css / *.jsx / *.js    # Shared primitives, dialogs, tooltips, plan usage stores, modals
├── test/                               # Jest test suite (TypeScript via ts-jest)
└── data/                               # Runtime data root, default `<repo>/data` and movable with AGENT_COCKPIT_DATA_DIR
    ├── chat/
    │   ├── stream-jobs.json            # Durable active CLI turn registry for server-restart reconciliation
    │   ├── workspaces.json             # Workspace identity registry: stable workspaceId -> storage key/current path
    │   ├── workspaces/{storageKey}/    # Workspace-based storage; storageKey is usually the original path hash
    │   │   ├── index.json              # Source of truth: conversations + session metadata (includes `memoryEnabled`, `kbEnabled`, `workspaceContextEnabled`, `routinesEnabled`, and optional `worktreeIsolation`)
    │   │   ├── session-finalizers.json # Persisted background jobs for reset/archive finalizers
    │   │   ├── archive/                # Workspace archive summaries, including final learning pass output
    │   │   ├── memory/                 # Per-workspace memory store (opt-in per workspace)
    │   │   │   ├── snapshot.json       # Merged snapshot: claude captures + notes (parsed metadata + content)
    │   │   │   ├── state.json          # Agent Cockpit sidecar lifecycle metadata keyed by memory filename
    │   │   │   ├── audits/             # Manual consolidation audit JSON files
    │   │   │   └── files/              # Raw .md entries, split by source
    │   │   │       ├── claude/         # Claude Code native captures; wiped and rewritten on each capture
    │   │   │       │   ├── MEMORY.md   # Source index from Claude Code (if present)
    │   │   │       │   └── *.md        # Per-topic memory files with YAML frontmatter
    │   │   │       └── notes/          # `memory_note` MCP writes + post-session extractions; preserved across captures
    │   │   │           └── *.md        # Per-note memory files with YAML frontmatter
    │   │   ├── workspace-context/      # Per-workspace Workspace Context markdown operating memory
    │   │   │   ├── WORKSPACE_CONTEXT.md
    │   │   │   ├── context/*.md        # CLI-maintained synthesized operating-memory markdown
    │   │   │   ├── references/*.md     # User-directed exact reusable guidance, prompts, templates, and style notes
    │   │   │   ├── assets/*            # Allowlisted non-executable reference files linked from context/references
    │   │   │   ├── runs/*.md           # Run summaries, including latest.md
    │   │   │   └── state.json          # Small operational run-state sidecar
    │   │   ├── routines/               # Per-workspace Routine authoring, manifests, run folders, and outreach settings; created only after Routines are enabled or repaired
    │   │   │   ├── ROUTINE_AUTHORING.md # Harness-readable routine proposal/edit contract
    │   │   │   ├── index.json          # Generated routine list with paths and latest run summaries
    │   │   │   ├── settings.json       # Workspace outreach settings such as Telegram destination configuration
    │   │   │   └── items/<routineId>/  # One routine per normalized id
    │   │   │       ├── manifest.json   # Schema v1 `agent-cockpit.routine` manifest
    │   │   │       ├── routine.md      # Harness-authored workflow intelligence
    │   │   │       ├── state.json      # Latest run and bounded run history
    │   │   │       ├── persistent-state/ # Cross-run routine state under Agent Cockpit data
    │   │   │       └── runs/<runId>/   # Per-execution input/output/tmp/final/notify files
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
    │   │       ├── session-N.json      # Active session (updated every message)
    │   │       └── session-recovery/   # Latest recovery snapshot per source session when a native CLI resume fails
    │   │           └── session-N-latest.json
    │   ├── workspace-snapshots/{workspaceId}/ # Optional verified ZIP snapshots for archived workspaces
    │   ├── workspace-trash/            # Product-owned moved originals from snapshot archive cleanup
    │   ├── restored-workspaces/        # Default extraction root for snapshot restores
    │   ├── artifacts/{convId}/         # Per-conversation uploaded files and generated assistant artifacts
    │   ├── settings.json               # User settings, including CLI profile definitions
    │   ├── usage-ledger.json           # Daily per-backend token usage ledger
    │   ├── claude-transcript-usage-import.json # Checkpoint for external Claude transcript usage imports
    │   └── usage-pricing-overrides.json # User-owned pricing overrides, never replaced by releases
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

## Data Migration Bundles

Agent Cockpit exports and imports complete data roots. The export file extension
is `.acexport`; the file is a ZIP with this top-level shape:

```text
manifest.json
data/
  ...files copied from AGENT_COCKPIT_DATA_DIR...
```

`manifest.json` uses schema version `1` and is described by
`DataExportManifest` in `src/contracts/dataMigration.ts`:

```typescript
{
  schemaVersion: 1;
  appVersion: string;
  exportedAt: string;
  sourcePlatform: NodeJS.Platform;
  dataRootName: string;
  includedRoot: 'AGENT_COCKPIT_DATA_DIR';
  auth: {
    included: boolean;
    path: string | null;
    warning?: string;
  };
  counts: {
    workspaces: number;
    files: number;
    bytes: number;
  };
  files: [{
    path: string;      // POSIX-style relative path under data/
    bytes: number;
    sha256: string;
  }];
  workspaces: [{
    workspaceId: string;
    storageKey: string;
    currentPath: string | null;
    previousPaths: string[];
    memory: { present: boolean; enabled?: boolean | null };
    knowledge: {
      present: boolean;
      enabled?: boolean | null;
      stateDb: boolean;
      vectors: boolean;
      embeddingConfig?: {
        model?: string;
        ollamaHost?: string;
        dimensions?: number;
      } | null;
    };
    workspaceContext: { present: boolean; enabled?: boolean | null };
    routines: { present: boolean; enabled?: boolean | null };
  }];
  excluded: string[];
  warnings: string[];
}
```

The bundle is meant to preserve everything user-owned under the data root:
settings, workspace identity registry, conversations and sessions, uploaded and
generated artifacts, Memory files and sidecars, Workspace Context markdown,
Workspace Routines data, Knowledge Base SQLite metadata and PGLite vectors,
plan-usage caches, install metadata, and first-party auth when `AUTH_DATA_DIR`
stays under the data root.

The preferred browser export path uses `DataExportJobStatusResponse` while the
server prepares the bundle:

```typescript
{
  jobId: string;
  status: 'running' | 'ready' | 'failed';
  phase: string;
  progress: number; // integer percent, 1-99 while running, 100 when ready/failed
  createdAt: string;
  updatedAt: string;
  filename?: string;              // ready jobs only
  manifest?: DataExportManifest;  // ready jobs only
  error?: string;                 // failed jobs only
}
```

Exports intentionally exclude transient process state that should not survive a
migration: Express `sessions/`, `chat/stream-jobs.json`, temporary/staging
files, `.DS_Store`, symlinks, and stale Postgres/PGLite runtime files such as
`postmaster.pid` and `pg_stat_tmp`. Export still emits required empty PGLite
directory entries such as `pg_notify/`, `pg_logical/snapshots/`, and
`pg_wal/summaries/`, and import staging recreates those runtime directories
from any manifest that includes a `knowledge/vectors/PG_VERSION` file so vector
stores restored from older bundles can boot. Imported data starts without
browser sessions or abandoned active CLI turns.

Archive I/O is streaming. Export streams source files into the `.acexport` ZIP
instead of buffering the data root in memory, then verifies the finished ZIP
back against the manifest before returning it for download. Import reads entries
lazily, caps `manifest.json` at 10 MB, rejects unsafe, duplicate, encrypted, or
undeclared data entries, and then verifies staged file size plus SHA-256 before
writing a pending import marker. Both export and import limit included
uncompressed data bytes to 20 GB.

Import confirmation responses are represented by
`DataImportConfirmResponse = DataImportConfirmSuccessResponse |
DataImportConfirmFailureResponse`. Success is
`{ ok:true, pending:true, restart, backupPath, importId, message }`. The
structured restart-failure response is
`{ ok:false, pending:false, error, restart?, backupPath?, importId? }`; ordinary
validation failures still use the route's standard `{ error }` response body.

`DataMigrationService.controlDirForDataRoot(dataRoot)` returns a sibling control
directory named `<dataRoot>.migration`. For the default `data` root this is
`data.migration/`, not `data/.migration/`. Its layout is:

```text
<dataRoot>.migration/
├── exports/                # Temporary export bundles removed after download
├── uploads/                # Uploaded .acexport files plus chunk metadata awaiting preview/confirm; successful imports remove their upload best-effort
├── staging/<importId>/data # Verified replacement data root before restart
├── backups/<importId>-...  # Previous active data root after import apply
├── pending-import.json     # Startup apply marker
├── last-import.json        # Best-effort metadata for last successful import
└── failed-import.json      # Last failed startup apply metadata, when any
```

Import works on any installation, not only a fresh install. It never merges.
`POST /api/chat/migration/import/confirm` requires the exact confirmation text
`REPLACE`, stages and verifies the bundle, writes `pending-import.json`, and
requests a server restart. On the next startup, before Express sessions,
`ChatService`, KB databases, or plan-usage services open files,
`DataMigrationService.applyPendingImport(dataRoot)` renames the current data
root to the recorded backup path and renames the staged `data/` directory into
the active `dataRoot` path. Successful metadata cleanup is best effort after the
swap. If startup apply fails before a swap, the pending marker is moved aside or
removed so the server does not retry the same failed import forever.

After import, the server can run post-import checks that verify workspace
storage directories, missing absolute workspace paths, Memory directories, KB
SQLite `state.db` schema metadata, PGLite vector directories including required
empty runtime subdirectories, stale `postmaster.pid`, CLI profile auth/config
hints, Pandoc, LibreOffice, and optionally Ollama embedding availability.

## Workspace Identity

Workspaces have a stable internal `workspaceId` UUID. The absolute workspace
path is mutable metadata, not identity. See
[ADR-0073](adr/0073-use-stable-workspace-identities.md).

`data/chat/workspaces.json` is the registry that maps `workspaceId` to:

```typescript
{
  schemaVersion: 1,
  workspaces: [{
    workspaceId: string,    // stable UUID used by current clients and runtime maps
    storageKey: string,     // folder under data/chat/workspaces/
    currentPath: string,    // current absolute workspace path
    legacyHash: string,     // original path hash, retained for compatibility/debugging
    previousPaths: string[],
    createdAt: string,
    updatedAt: string
  }]
}
```

Existing workspace folders keep their legacy path-hash folder name. New
workspaces also use the initial path hash as `storageKey` to avoid unnecessary
folder churn, but current clients use `workspaceId` for workspace-scoped API
calls. The server still accepts legacy hashes and storage keys as workspace
references by resolving them through the registry.

Legacy workspace hashes use `SHA-256(workspacePath).substring(0, 16)`. They are
now storage/compatibility identifiers only.
Registry mutations are serialized inside `WorkspaceIdentityStore` so concurrent
workspace creation or location-remap requests cannot register the same
`currentPath` to multiple `workspaceId` values.

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
  "startup": {
    "kind": "launch-agent",
    "name": "com.agent-cockpit.server",
    "scope": "current-user"
  }
}
```

Read responses add operational metadata that is not persisted:

- `stateSource`: `"stored"`, `"inferred"`, `"legacy"`, or `"corrupt"`
- `stateError`: `null` or a read/parse error string for corrupt manifests

`startup` is optional. macOS installer manifests write
`{ "kind": "launch-agent", "name": "com.agent-cockpit.server", "scope": "current-user" }`
when the LaunchAgent is registered. Linux installer manifests write
`{ "kind": "systemd-user", "name": "agent-cockpit.service", "scope": "current-user" }`
when the systemd user unit is written. Windows installer manifests write
`{ "kind": "scheduled-task", "name": "AgentCockpit", "scope": "current-user" }`
when logon startup is registered. Installers write `{ "kind": "manual", ... }`
when the user supplied the platform opt-out (`--no-auto-start` on POSIX,
`-NoAutoStart` on Windows). Older manifests omit `startup` and readers normalize
that as `null`.

`nodeRuntime` is `null` for older/inferred manifests. New macOS, Linux, and Windows
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
      "name": "agent-cockpit-v1.0.0.tar.gz",
      "role": "app-tarball",
      "platform": "linux",
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
      "name": "install-linux.sh",
      "role": "linux-installer",
      "platform": "linux",
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

`artifacts[]` includes macOS and Linux app tarball entries, the Windows app ZIP,
and external installer assets uploaded beside the app archives. The macOS and
Linux tarball entries currently refer to the same physical tarball bytes because
the packaged source and built web/mobile assets are platform-neutral. `files[]`
contains every regular file copied into the app archives, with paths relative to the package root.
It excludes mutable/local-only state such as `node_modules/`, `data/`, `.env`,
`ecosystem.config.js`, `coverage/`, `plans/`, `plan.md`, release `dist/` output,
and generated build staging directories. `SHA256SUMS` currently contains
checksums for the tarball, ZIP, this external manifest, `install-macos.sh`,
`install-linux.sh`, and `install-windows.ps1`.
`requiredRuntime.node` is derived from root `package.json` `engines.node`.
Current packaging extracts simple lower-bound engines such as `>=22` into
`minimumMajor`; production self-update uses that value to decide whether a
private installer-managed Node runtime must be installed or refreshed before
running `npm ci`.

## Persistence Durability

All mutable JSON files under `data/` are written with two primitives to survive concurrent access without corruption:

- **Atomic writes** — `src/utils/atomicWrite.ts` exports `atomicWriteFile(filePath, data, encoding='utf8')`. It writes to a sibling `.{base}.tmp.{pid}.{random}` file then calls `fs.rename` (POSIX-atomic), so readers always observe either the previous complete file or the new complete file — never a torn byte-interleaved mix. On rename failure the tmp file is removed. Used by `ChatService` (workspace `index.json`, session files, session-recovery snapshots, usage ledger, memory `snapshot.json`, memory `state.json`), `UsagePricingStore` (`usage-pricing-overrides.json`), `SessionFinalizerQueue` (`session-finalizers.json`), `SettingsService`, `ClaudePlanUsageService`, `CodexPlanUsageService`, and `KiroPlanUsageService`.
- **Per-key mutex** — `src/utils/keyedMutex.ts` exports `KeyedMutex.run<T>(key, fn)`. Callers sharing a key are serialized FIFO; different keys run concurrently. `ChatService` holds one `_indexLock` keyed by canonical `workspaceId` for workspace index read-modify-write operations and one `_ledgerLock` keyed by the constant `'__usage_ledger__'` (wrapping ledger record/clear). Not reentrant — locked regions must not recursively acquire the same key.

Together these guarantee that a workspace index always parses on disk and that concurrent mutators do not clobber each other's updates. `ChatService._buildLookupMap` also catches per-workspace `JSON.parse` failures at startup, logs them, and continues, so a single corrupt file cannot crash the server into a restart loop.

## Workspace Index (`workspaces/{storageKey}/index.json`)

```javascript
{
  workspaceId: string,         // Stable workspace UUID; generated once and preserved across path moves
  workspacePath: string,        // Absolute path to the workspace directory
  instructions: string,         // Per-workspace instructions (appended to system prompt on new sessions)
  instructionCompatibilityDismissedFingerprint: string|undefined, // Last dismissed CLI instruction compatibility warning. Fingerprint changes when detected instruction sources or missing harness entrypoints change.
  memoryEnabled: boolean|undefined, // Opt-in per-workspace Memory feature. Defaults to false.
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
  workspaceContextEnabled: boolean|undefined, // Opt-in per-workspace Workspace Context feature. Defaults to false.
  routinesEnabled: boolean|undefined, // Opt-in per-workspace Workspace Routines feature. Defaults to false. Disabled workspaces keep routine data but do not install AGENTS instructions or run scheduled routines.
  workspaceContext: {                // Per-workspace Workspace Context processor settings. Defaults to { processorMode: 'global' }.
    processorMode?: 'global' | 'override', // 'global' uses Settings.workspaceContext processor defaults; 'override' stores workspace CLI overrides.
    cliProfileId?: string,          // Optional workspace processor profile when processorMode='override'.
    cliBackend?: string,            // Deprecated legacy fallback/mirror of the selected profile's protocol-derived backend.
    cliModel?: string,              // Optional workspace processor model when processorMode='override'.
    cliEffort?: string,             // Optional adaptive effort when processorMode='override'.
    scanIntervalMinutes?: number,   // Optional workspace scan cadence override, clamped to 1..1440 minutes.
    maintenanceIntervalHours?: number, // Optional workspace maintenance cadence override, clamped to 1..8760 hours.
  } | undefined,
  worktreeIsolation: {               // Optional per-workspace Git worktree isolation. Absent/disabled for non-Git/shared-folder workspaces.
    enabled: boolean,                // true means each conversation has a dedicated checkout worktree.
    repoRoot: string,                // Canonical base checkout Git repository root.
    workspaceRelPath: string,        // Workspace path relative to repoRoot; empty string for repo-root workspaces.
    worktreeBaseDir: string,         // Parent directory for Agent Cockpit-created conversation worktrees.
    remoteName: string,              // Currently "origin".
    baseBranch: string,              // Currently "main".
    remoteBaseRef: string,           // Currently "origin/main"; fetched on enable and reset.
    enabledAt: string                // ISO 8601 timestamp.
  } | undefined,
  archive: {                         // Present only while the workspace is archived.
    archivedAt: string,              // ISO 8601 archive timestamp.
    mode: 'history_only' | 'file_snapshot',
    note?: string,                   // Optional user note shown in archive management UI.
    finalLearningPass?: {
      status: 'queued' | 'running' | 'completed' | 'failed',
      startedAt?: string,
      completedAt?: string,
      error?: string,
      summaryPath?: string           // Absolute path to archive/summary.md under workspace data.
    },
    snapshot?: {
      id: string,
      status: 'verified' | 'failed',
      archivePath?: string,          // ZIP under data/chat/workspace-snapshots/{workspaceId}/
      manifestPath?: string,         // JSON manifest beside the ZIP.
      sizeBytes?: number,
      fileCount?: number,
      checksum?: string,             // SHA-256 of the ZIP.
      inclusionPolicy?: 'exclude_common' | 'include_all',
      createdAt?: string,
      verifiedAt?: string,
      error?: string
    },
    originalCleanup?: {
      mode: 'keep' | 'move_to_trash' | 'delete_permanently',
      movedTo?: string,              // Product-owned workspace-trash path when moved.
      error?: string
    }
  } | undefined,
  conversations: [{
    id: string,                 // UUIDv4
    title: string,              // Auto-set from first user message (max 80 chars)
    titleManuallySet?: boolean, // true once `renameConversation()` has run. Locks the title against all automatic mutations (resetSession, addMessage's first-message snapshot, generateAndUpdateTitle). Absent when the title is still auto-managed.
    backend: string,            // Internal backend id: 'claude-code' | 'claude-code-interactive' | 'kiro' | 'codex' | 'opencode'. Kept for back-compat and transcript rendering. Some backends share a physical CLI harness/profile.
    cliProfileId?: string,      // Runtime CLI profile selected for this conversation. When present, runtime adapter selection is derived from Settings.cliProfiles[id].harness plus Claude Code's optional protocol while command/auth/config still come from the physical profile.
    model?: string,             // Full model ID (e.g. 'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'); absent = backend default
    effort?: string,            // Adaptive reasoning effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; absent = model default. Supported values are backend/model-specific. Stale unsupported values are reconciled to `high` when available, then the first supported level, or removed when the model has no effort support.
    claudeCodeMode?: string,    // Claude Code-only session mode. Current value: 'ultracode'. Stored only for claude-code/claude-code-interactive when the selected model supports xhigh; absent = normal Claude Code mode.
    serviceTier?: string,       // Codex-only service tier override. Current value: 'fast'. Absent = use the selected Codex profile/config default.
    currentSessionId: string,   // UUID of the active CLI session
    checkout: {                 // Present when a conversation has explicit checkout metadata.
      mode: 'shared' | 'worktree',
      repoRoot?: string,        // Git top-level inside the worktree.
      worktreeRoot?: string,    // Root of the Git worktree checkout.
      executionDir?: string,    // Directory used as cwd for this conversation's CLI turns and one-shot work.
      workspaceRelPath?: string,// Workspace subdirectory inside the repo/worktree.
      currentBranch?: string,   // Current session branch checked out in this worktree.
      remoteBaseRef?: string,   // Remote base ref used to create/reset the current session branch.
      updatedAt?: string
    } | undefined,
    lastActivity: string,       // ISO 8601, updated on every message and on session reset
    lastMessage: string|null,   // First 100 chars of last active-session message content; reset to null when a new session starts
    usage: {                     // Cumulative token/cost tracking (null until first result)
      inputTokens: number,
      outputTokens: number,
      cacheReadTokens: number,
      cacheWriteTokens: number,
      costUsd: number,                  // Provider-reported nonzero spend. Display label: Cost.
      costSource?: 'reported'|'estimated'|'none',
      estimatedCostUsd?: number,        // Persisted API-equivalent fallback. Display label: Estimated Cost.
      costSnapshot?: {                  // Pricing provenance for a persisted estimate.
        catalogVersion: string,
        pricedAt: string,
        provider: 'openai'|'anthropic'|'kiro',
        model: string,
        pricingTier?: string,             // Provider pricing tier used for the estimate, e.g. OpenAI priority.
        pricingEntryId: string,
        sourceUrl: string,
        verifiedAt: string,
        effectiveDate: string,
        currency: 'USD',
        unit: 'tokens'|'credits',
        ratesPerMillion?: {
          input: number,
          output: number,
          cachedInput?: number,
          cacheWrite?: number
        },
        usdPerCredit?: number
      },
      credits?: number,                // Kiro only: accumulated credits consumed (fractional)
      pricingTier?: string,            // Raw event pricing tier before aggregation; not meaningful on cumulative totals.
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
      externalSessionId: string|null, // Backend-managed session ID (e.g. Kiro ACP session ID); null for backends that don't need it
      branchName: string|undefined,   // Worktree isolation branch for this session, e.g. ac/<conversation>/session-3.
      baseRef: string|undefined       // Remote base ref used when this session branch was created.
    }]
  }]
}
```

When `worktreeIsolation.enabled` is true, `workspaceId` remains the canonical
workspace identity and every conversation still lives in the same
`workspaces/{storageKey}/index.json`. `workspacePath` is the shared base
checkout path and can change through the workspace location endpoint when
worktree isolation is disabled. `checkout.executionDir` is the runtime cwd for
that conversation; response contracts expose it as `executionDir` while keeping
`workingDir` set to the canonical workspace path. Current clients group by
`workspaceId`; legacy clients/diagnostics may still read `workspaceHash`.

When `archive` is present on the workspace index, the workspace is retired from
active use but its Agent Cockpit-owned data remains in place. Normal
conversation listing skips archived workspaces unless the caller explicitly
opts into archived-workspace inclusion; creating new conversations in that
workspace returns `workspace_archived`. Knowledge Base auto-dream and Workspace
Context scheduled processing skip
archived workspaces without clearing their enabled flags. Restoring a
`history_only` archive requires `workspacePath` to exist; if the user deleted
the folder, they must remap the archived workspace to an existing folder first.

`file_snapshot` archives store a ZIP and manifest under
`data/chat/workspace-snapshots/{workspaceId}/`. The manifest schema version is
1 and records `workspaceId`, `originalPath`, `createdAt`, `inclusionPolicy`,
one entry per included file/directory/symlink, and ZIP `{ path, sha256,
sizeBytes }`. File entries include `sizeBytes`, `sha256`, mode, and mtime.
Symlink entries record `linkTarget`; restore recreates only relative symlinks
whose resolved target remains under the restore destination. ZIP extraction
rejects empty, absolute, backslash-containing, null-byte, and traversal paths,
requires an empty destination, extracts into a sibling staging directory,
verifies the ZIP checksum against both manifest and workspace metadata, and
hashes restored files before renaming the staging directory into place. Failed
restores remove staging output instead of leaving partial files in the target.
`exclude_common` skips dependency/build/cache segments such as
`node_modules`, `dist`, `.next`, `.venv`, `coverage`, and `target`; `include_all`
captures every regular file the server can read.

Snapshot archive cleanup can leave the original folder in place, move it into
`data/chat/workspace-trash/`, or delete it permanently. Permanent deletion
requires the exact confirmation string `DELETE ORIGINAL`. Cleanup refuses to
operate when the source path overlaps Agent Cockpit's snapshot/trash/restored
storage roots, whether it is inside one of those roots, equal to one, or contains
one. Deleting an archived workspace record removes the workspace data
directory, snapshots, matching product-trash copies, conversation artifacts, and
the identity-registry entry; it does not touch arbitrary external folders.

## Session Finalizer Store (`workspaces/{storageKey}/session-finalizers.json`)

Persisted queue for post-reset/archive work that must survive process restarts but must not block the reset/archive HTTP response.

```typescript
{
  version: 1,
  jobs: Array<{
    id: string,
    identity: string,          // type + payload.source + payload.identityKey + conversationId + sessionNumber
    workspaceHash: string,      // Legacy field name; current jobs store workspaceId here
    conversationId: string,
    sessionNumber: number,
    type: 'session_summary' | 'memory_extraction' | 'workspace_context_conversation_final_pass',
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
      source?: 'session_reset' | 'archive',
      identityKey?: string,    // Optional lifecycle pass discriminator, e.g. archive:<archivedAt>
      archiveFinalLearningWorkspaceId?: string
    }
  }>
}
```

`SessionFinalizerQueue.start()` converts leftover `running` jobs back to `pending` after restart. `enqueue()` de-duplicates by `identity`, persists the job, and schedules asynchronous processing. The reset route enqueues `session_summary`, `memory_extraction`, and a `workspace_context_conversation_final_pass` with source `session_reset`; workspace archive enqueues `memory_extraction` and `workspace_context_conversation_final_pass` jobs for each active-session target during the final learning pass when the corresponding workspace features are enabled. Archive final-learning jobs include an `identityKey` derived from the archive timestamp so a restored-and-rearchived workspace can run a fresh final-learning pass for the same conversation/session. When archive-tagged jobs reach terminal status, the route layer marks `archive.finalLearningPass.status` as `completed` after every job succeeds or `failed` after any terminal job fails; when no Memory or Workspace Context jobs are enabled, the pass completes immediately.

## Workspace Memory Store (`workspaces/{storageKey}/memory/`)

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

Current write paths store records for files that exist. Deleting Agent Cockpit-owned `notes/*` entries prunes their sidecar records; deleting mirrored `claude/*` entries leaves a hidden `status:'deleted'` tombstone so future native CLI captures do not resurrect a user-deleted capture. `clearWorkspaceMemory()` is a full reset and drops every sidecar record, including tombstones. Older workspaces without `state.json` still load: `ChatService.getWorkspaceMemory()` synthesizes active workspace metadata in returned `MemoryFile.metadata`, and the next memory write materializes `state.json`.

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

Drafts have `{ id, createdAt, action, summary, operations }`. `create` writes a new `notes/` file and marks selected source entries superseded in sidecar metadata. `replace` rewrites only selected `notes/*` entries in place; `claude/*` entries are never replaced because they are mirrored native CLI captures. Redacted, deleted, and already-superseded sources are rejected for draft generation and skipped during draft apply. Draft apply may receive an edited draft payload, but the generated operation metadata remains authoritative; only `operations[].content` is accepted from the reviewed payload before the same Markdown validation and redaction pipeline runs.

## Workspace Context Store (`workspaces/{storageKey}/workspace-context/`)

Workspace Context is markdown-first operating memory plus exact reusable
reference material. Its canonical synthesized-memory store is the
`workspace-context/context/` markdown folder, not a SQLite graph database.

```
workspace-context/
├── WORKSPACE_CONTEXT.md
├── context/
│   └── overview.md
├── references/
│   └── *.md
├── assets/
│   └── {durable reference files}
├── runs/
│   ├── latest.md
│   └── {timestamp}-{source}.md
└── state.json
```

`WORKSPACE_CONTEXT.md` is generated by `WorkspaceContextService` and tells the
CLI how to maintain synthesized context, reusable reference files, and durable
non-executable assets. The service also installs a managed
Workspace Context block into the workspace root `AGENTS.md` pointing at that
instruction file, context folder, references folder, and assets folder.

`context/*.md` files are the source of truth for synthesized operating memory.
The configured processor and normal active chat CLIs may update them directly.
The UI previews them read-only.

`references/*` files are user-directed exact reusable markdown/text guidance.
The UI exposes explicit create/update/delete controls for these files because
they represent preserved prompts, templates, style guidance, and similar
reference material.

`assets/*` files are allowlisted non-executable reference files that context or
reference markdown can link to. Asset metadata includes relative path, display
name, size, updated time, MIME type, and whether the UI can preview the file.

`state.json` is a small operational sidecar:

```typescript
{
  version: 1,
  contextDir: string,
  lastRun?: WorkspaceContextRunRecord,
  lastCompletedAt?: string,
  lastScanCompletedAt?: string,
  lastMaintenanceCompletedAt?: string,
  runs: WorkspaceContextRunRecord[]
}
```

`WorkspaceContextRunRecord` has `{ runId, source, status, startedAt,
completedAt?, filesConsidered, summary, errorMessage? }`, where source is one of
`initial_scan`, `scheduled`, `session_reset`, `archive`, `manual_catchup`, or
`maintenance`. Status is `running`, `completed`, `failed`, `stopped`, or
`skipped`; skipped scheduler records can include `skippedReason:
"scan-running" | "maintenance-running" | "already-running"`.
The sidecar drives badges, scheduler cadence, and run history only; it is not a
structured representation of learned context.

`runs/*.md` files are human-readable processor run reports. `latest.md` mirrors
the newest completed run report. Workspace Context maintenance prunes run report
files and `state.json.runs` entries older than 7 days while retaining
`latest.md` and scheduler cadence timestamps.

`Conversation.workspaceContext` carries the compact composer/settings summary
`{ enabled, pending, runningRuns, failedRuns, contextDir?, fileCount?,
latestRunId?, latestRunStatus?, latestRunSource?, latestRunCreatedAt?,
latestRunCompletedAt?, lastRunId?, lastRunStatus?, lastRunSource?,
lastRunCreatedAt?, lastRunCompletedAt? }`. `GET /conversations/:id` hydrates it
when Workspace Context is enabled for the workspace. Workspace-scoped
`workspace_context_update` frames carry the same shape after run starts,
completion/failure, clear, or enablement changes.

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

`GET /workspaces/:workspaceId/instruction-compatibility` returns a computed, non-persisted status object:

```javascript
{
  workspaceId: string,
  workspaceHash: string,
  workspacePath: string,
  sources: [{
    id: 'agents' | 'claude' | 'kiro',
    harness: 'codex' | 'claude-code' | 'kiro' | 'opencode',
    label: string,
    expectedPath: string,
    present: boolean,
    paths: string[]        // workspace-relative files detected for that source
  }],
  harnesses: [{
    harness: 'codex' | 'claude-code' | 'kiro' | 'opencode',
    label: string,
    sourceId: 'agents' | 'claude' | 'kiro',
    expectedPath: string,
    covered: boolean
  }],
  missingHarnesses: harnesses[],
  hasAnyInstructions: boolean,
  compatible: boolean,
  canCreatePointers: boolean,
  fingerprint: string,     // sha256-derived 16-char fingerprint of present sources + missing harnesses
  dismissed: boolean,      // true when fingerprint matches WorkspaceIndex.instructionCompatibilityDismissedFingerprint
  shouldNotify: boolean,   // true when action is needed and not dismissed
  primarySourceId: 'agents' | 'claude' | 'kiro' | null
}
```

Detection is filesystem-based and read-only: `AGENTS.md` covers Codex, OpenCode, and other harness-neutral agents; `CLAUDE.md` covers Claude Code; and any `*.md` under `.kiro/steering/` covers Kiro. Pointer creation writes only missing files with exclusive-create semantics and never overwrites existing instruction files.

## Session File (`workspaces/{storageKey}/{convId}/session-N.json`)

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
  backend: string,              // Backend that generated the response. Frontends may project this with cliProfileId/settings metadata for display (for example OpenCode provider labels) without changing the persisted transcript value.
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
  sessionRecovery?: SessionRecoveryMetadata,
                                // System only. Marks Agent Cockpit's friendly
                                //   native-session recovery notice. The visible
                                //   `content` is deliberately end-user friendly;
                                //   this metadata carries debug details such as
                                //   backend, previous/new native session ids, the
                                //   snapshot path, reason, and recovery count.
  pinned?: boolean              // User-controlled pin marker. `true` marks the
                                //   active-session message for the pinned strip
                                //   and inline pinned styling. Omitted/absent is
                                //   equivalent to unpinned.
}
```

## Session Recovery Snapshot (`workspaces/{storageKey}/{convId}/session-recovery/session-N-latest.json`)

When a backend reports that its native resumed session cannot be found, Agent Cockpit writes a refreshed snapshot of the prior Agent Cockpit transcript before starting a new native CLI session ([ADR-0078](adr/0078-recover-missing-native-sessions-from-snapshots.md)). The file is stable per source session (`session-N-latest.json`), so repeated recovery failures replace it with the latest complete prior discussion instead of creating unbounded historical copies.

```javascript
{
  schemaVersion: 1,
  type: 'agent-cockpit-session-recovery-snapshot',
  capturedAt: string,
  conversationId: string,
  conversationTitle: string,
  workspaceId: string,
  workspacePath: string,
  backend: string,                  // codex, claude-code, kiro, opencode, etc.
  previousNativeSessionId: string,
  reason: string,                   // Raw backend/CLI resume failure text
  sourceSessionId: string,
  sourceSessionNumber: number,
  sourceSessionPath: string,
  recoveryCount: number,            // Counts visible recovery notices in this Agent Cockpit session, plus this recovery
  messageCount: number,
  messages: Message[]               // Transcript prefix captured before the current failed turn is appended
}
```

`processStream` persists the accompanying visible notice as a system `Message` with `sessionRecovery` metadata. The browser does not receive the internal `session_recovery` frame directly; it sees the persisted friendly system message through the normal `assistant_message` stream frame. Desktop and mobile render this system-owned notice with the Agent Cockpit logo and name; the metadata still records the backend that triggered recovery. The backend retry prompt contains a definitive instruction that the harness MUST read the snapshot path before answering the current user request.

### SessionRecoveryMetadata

```ts
interface SessionRecoveryMetadata {
  backend: string;
  reason: string;
  previousNativeSessionId?: string | null;
  newNativeSessionId?: string | null;
  snapshotPath?: string | null;
  sourceSessionPath?: string | null;
  sourceSessionNumber?: number | null;
  snapshotMessageCount?: number | null;
  recoveryCount: number;
  occurredAt: string;
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
  claudeCodeMode?: string|null;
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
For conversation `.dng` uploads, the returned `AttachmentMeta` describes the
generated JPEG preview sidecar (`<original>.dng.preview.jpg`) rather than the
preserved original DNG. That sidecar is capped to a 2576 px long edge and is
typed as `kind: 'image'`, so queued messages and uploaded-file markers hand the
harness a normal JPEG path. The original DNG remains in the same conversation
artifact directory for traceability until the preview attachment is deleted.

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
  model?: string,               // Full model ID (e.g. 'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5')
  effort?: string,              // Adaptive reasoning effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  claudeCodeMode?: string,      // Claude Code-only session mode. Current value: 'ultracode'
  serviceTier?: string,         // Codex-only service tier override; currently 'fast'
  workingDir: string,           // The workspace path
  currentSessionId: string,
  sessionNumber: number,        // Active session number
  messages: Message[],          // Active session messages
  messageWindow?: {             // Present when GET /conversations/:id is called with messageWindow=tail, or on GET /conversations/:id/messages
    messages: Message[],        // Same page as the top-level messages field
    total: number,              // Full active-session message count
    startIndex: number,         // Inclusive zero-based index in the active session
    endIndex: number,           // Exclusive zero-based index in the active session
    hasOlder: boolean,          // true when messages before startIndex exist
    hasNewer: boolean           // true when messages at/after endIndex exist
  },
  pinnedMessages?: Array<{      // Present with message windows; includes all pinned active-session messages, even outside the returned page
    index: number,
    message: Message
  }>,
  usage: Usage,                 // Cumulative token/cost totals (zeroed if no usage yet)
  sessionUsage: Usage,          // Active session token/cost totals (zeroed if no usage yet)
  externalSessionId: string|null, // Backend-managed session ID (for resume after server restart)
  archived?: boolean,           // true when the conversation is archived; absent/false otherwise. The v2 topbar swaps Archive → Unarchive + Delete when set.
  unread?: boolean              // Mirror of `ConversationEntry.unread`. Lets the v2 sidebar render an unread dot on initial paint without a second round-trip per conversation.
}
```

`GET /conversations/:id/messages` returns the message-window subset directly as
`{ messages, messageWindow, pinnedMessages }`. Window indexes are always
relative to the active session, not the currently mounted client page. The
default `GET /conversations/:id` response remains full-transcript for
backwards compatibility unless `messageWindow=tail` is requested.

## Usage Ledger (`data/chat/usage-ledger.json`)

Daily per-backend/model token usage records for global statistics:

```javascript
{
  days: [{
    date: string,               // YYYY-MM-DD
    records: [{
      backend: string,          // Backend ID (e.g. 'claude-code')
      model: string,            // Model ID (e.g. 'claude-sonnet-4-20250514') or 'unknown'
      pricingTier?: string,     // Optional provider pricing tier when rates differ by service tier.
      usage: Usage              // Accumulated usage for this backend+model+tier on this day
    }]
  }]
}
```

`usage.costUsd` is reserved for provider-reported nonzero dollars. For
subscription CLI usage where the provider reports tokens/credits but no spend,
the server estimates an API-equivalent fallback into `usage.estimatedCostUsd`
and marks `usage.costSource = "estimated"`. Once `estimatedCostUsd` is written,
the ledger treats it as historical data and does not recalculate it from future
catalog changes. `costSnapshot` records the pricing entry, rates, catalog
version, provider pricing tier when present, and source metadata used for that
stored estimate. Ledger rows are grouped by backend, model, and optional
`pricingTier`, so Codex default and Fast/Priority usage are not merged into one
average. Historical legacy day buckets shaped as `{ backends: { [backendId]:
Usage } }` are normalized into `records[]` on write or lazy usage-stat
enrichment without inferring a tier.

Built-in pricing defaults are release-owned JSON at
`src/services/usagePricing/catalog.default.json`. They are validated at server
startup and stamped into every estimate through `costSnapshot`, so a later
release changing token/credit prices does not alter historical rows.

## Claude Transcript Usage Import Checkpoint (`data/chat/claude-transcript-usage-import.json`)

Usage Stats imports Claude Code transcript usage from Claude session IDs that
Agent Cockpit did not create or persist. The checkpoint file prevents repeated
Stats refreshes from double-counting the same outside Claude transcript entry:

```javascript
{
  imported: {
    "<claudeSessionId>:<transcriptEntryUuidOrLineHash>": "2026-06-02T03:04:05.000Z"
  },
  updatedAt: string
}
```

The import reads Claude transcript JSONL files under `~/.claude/projects/*/*.jsonl`
and under enabled Claude Code CLI profile `configDir` / `CLAUDE_CONFIG_DIR`
roots. A transcript file is skipped completely when its basename session ID is
present in any workspace `ConversationEntry.sessions[].sessionId` or
`sessions[].externalSessionId`; those sessions are Agent Cockpit-owned and are
already counted through live backend `usage` events. Imported outside sessions
write only to the global usage ledger with backend `claude-code`, transcript
date, transcript model, and normalized input/output/cache/cost usage. They do
not mutate conversation or active-session usage totals. Clearing Usage Stats
clears `usage-ledger.json` but does not clear this checkpoint, so already
imported outside Claude sessions do not immediately reappear after a clear.

## Usage Pricing Overrides (`data/chat/usage-pricing-overrides.json`)

Mutable user pricing overrides are stored separately from release-owned defaults:

```javascript
{
  schemaVersion: 1,
  version: "user-overrides:<ISO timestamp>" | "user-overrides:empty",
  currency: "USD",
  entries: [{
    id: string,
    provider: "openai" | "anthropic" | "kiro",
    modelPattern: string,          // Exact model id or wildcard pattern with *
    pricingTier?: string,          // Optional provider pricing tier, such as "priority".
    unit: "tokens" | "credits",
    sourceUrl: string,
    verifiedAt: string,            // YYYY-MM-DD or ISO date string entered by server/UI
    effectiveDate: string,
    ratesPerMillion?: {
      input: number,
      output: number,
      cachedInput?: number,
      cacheWrite?: number
    },
    usdPerCredit?: number
}]
}
```

Override entries are validated through the browser-safe
`src/contracts/usagePricing.ts` contract and replace the complete override
catalog on save. The effective catalog is `overrides.entries` followed by
built-in entries, so a user override can intentionally shadow a built-in model
pattern. Release updates only change `src/services/usagePricing/catalog.default.json`;
they never rewrite this override file unless the user clears or saves overrides
from the Usage settings UI.

Built-in defaults live in `src/services/usagePricing/catalog.default.json` and
are validated on import. Effective pricing is `overrides.entries` first,
followed by built-in entries, so user overrides take precedence and releases can
refresh defaults without replacing user configuration. A corrupt override file
is logged and ignored for startup/read purposes but is not overwritten until the
user explicitly saves or resets overrides.

## CLI Update Status (API-only)

CLI update state is process-local and in-memory. No CLI update cache is written to disk; the service rebuilds it from settings and subprocess probes after startup.

```ts
type CliInstallMethod = 'npm-global' | 'self-update' | 'unknown' | 'missing';

interface CliUpdateStatus {
  id: string;
  harness: 'claude-code' | 'codex' | 'kiro' | 'opencode';
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
      "harness": "claude-code",
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
    "dreamingCliModel": "claude-opus-4-8",
    "dreamingCliEffort": "high",
    "cliConcurrency": 2,
    "dreamingStrongMatchThreshold": 0.75,
    "dreamingBorderlineThreshold": 0.45,
    "convertSlidesToImages": false,
    "kbGleaningEnabled": false
  },
  "workspaceContext": {
    "cliProfileId": "server-configured-claude-code",
    "cliBackend": "claude-code",
    "cliModel": "claude-sonnet-4-6",
    "cliEffort": "high",
    "scanIntervalMinutes": 5,
    "cliConcurrency": 1,
    "maintenanceIntervalHours": 24,
    "maintenanceCliConcurrency": 1
  }
}
```

`cliProfiles` is the global list of runnable CLI harness identities. Fresh settings start with an empty `cliProfiles` array and no provider default; the app does not create a Claude Code profile until a user configures Claude Code, selects a Claude backend explicitly, or a legacy settings/conversation migration requires it ([ADR-0061](adr/0061-use-configured-cli-profiles-as-default-runtime.md)). The current implementation supports server-configured and account/custom profiles for Codex and Claude Code, self-configured profiles for Kiro, and self-configured profiles for OpenCode ([ADR-0076](adr/0076-add-opencode-cli-profiles.md)). It resolves `cliProfileId → CliProfile` for command/auth/config plus the runtime communication path. Claude Code profiles also carry `protocol: "standard" | "interactive"`: `standard` maps to internal backend `claude-code`, while `interactive` maps to internal backend `claude-code-interactive`. `claude-code-interactive` is therefore not a separate profile harness; it shares `harness: "claude-code"` for `command`, `env`, `CLAUDE_CONFIG_DIR`, auth, plan usage, and CLI update targets.

OpenCode profiles may carry `opencode.provider`; this selects the OpenCode provider such as `deepseek`, `groq`, or `openrouter` and does not create new Cockpit CLI harnesses for those API providers. Server-configured profiles preserve existing behavior where each adapter uses the server user's already-configured CLI state. Codex profiles apply `command`, merged `env`, and `configDir → CODEX_HOME` for `codex app-server`, `codex exec`, MCP config collision reads, Codex plan usage, and remote auth jobs. Claude Code profiles apply `command`, merged `env`, and `configDir → CLAUDE_CONFIG_DIR` for both standard streaming and interactive hidden PTY sessions, one-shots, native memory path resolution/capture, Claude plan usage, and remote auth jobs. OpenCode profiles are self-configured in this pass: `SettingsService.saveSettings()` forces `authMode: "server-configured"`, strips `configDir`, `env`, and profile-level OpenCode model defaults, preserves the optional `command` override, and leaves model choice to the chat composer or feature-specific model selectors. Provider credentials remain managed by OpenCode's own configuration/auth files, and Cockpit-assisted OpenCode login is not supported yet. For implemented account harnesses, `configDir` takes precedence over the matching env key when both are present. If an explicit Codex or Claude Code account profile starts a remote auth check/job without a `configDir`, the server persists a deterministic default under `data/cli-profiles/<slug>-<sha1>/` so authentication and later runtime spawns use the same isolated config/auth home.

Welcome setup auth can create first-run account profiles named `setup-codex-account` and `setup-claude-code-account` ([ADR-0060](adr/0060-use-cli-profile-auth-for-setup-login.md), [ADR-0064](adr/0064-use-system-cli-auth-for-welcome-setup.md)); those setup profiles intentionally omit `configDir` so Agent Cockpit and terminal `codex` / `claude` commands share the user's normal CLI auth home. Legacy setup profiles that have a generated `configDir` or auth-home env key (`CODEX_HOME` / `CLAUDE_CONFIG_DIR`) are migrated at the settings/profile-auth boundary by removing those fields, so both setup-auth routes and direct profile checks use system auth. When no default exists, or when a setup profile replaces that harness's server-configured default, it becomes `defaultCliProfileId` so the completed login is used by new conversations. Kiro profiles are self-configured only: `SettingsService.saveSettings()` forces `authMode: "server-configured"` and strips `command`, `configDir`, `env`, and `protocol` because `kiro-cli` has no dedicated documented profile directory override and isolating via `HOME` changes unrelated process behavior. Deterministic server-configured IDs are `server-configured-claude-code`, `server-configured-kiro`, `server-configured-codex`, and `server-configured-opencode`. `SettingsService.getSettings()` only creates a server-configured physical profile for persisted legacy `defaultBackend` values and otherwise promotes the first enabled existing profile when no default is selected.

`defaultCliProfileId` points at the CLI profile used by the V2 UI for new conversations. New conversations still accept/return `backend` for compatibility, but new profile-based selection derives `backend` from `CliProfile.harness + CliProfile.protocol` instead of exposing a separate backend/provider picker. `ChatService.createConversation()` accepts an optional `cliProfileId`; when supplied without an explicit backend, the profile's protocol-derived backend is stored. A conflicting explicit `backend` is rejected. When neither profile nor backend is supplied, the service uses `settings.defaultCliProfileId` when valid and derives the backend from that profile; otherwise it falls back only to legacy `settings.defaultBackend` when present. If neither is configured, creation fails with a CLI-profile-required error. When only a backend is supplied, the service derives `cliProfileId` from the selected backend's physical server-configured profile. Legacy settings and request payloads that still provide `CliProfile.vendor` are accepted only as migration input, normalized to `harness` on read/write, and never emitted as the canonical saved field.

`memory.cliProfileId` selects the profile used by the Memory CLI for `memory_note` formatting/deduping and post-session extraction. `memory.cliBackend` is retained as a legacy fallback and is kept aligned to the selected profile's protocol-derived backend on settings save. Runtime resolution uses `memory.cliProfileId` first, then legacy `memory.cliBackend`, then `defaultCliProfileId`, then legacy `defaultBackend`; if none exists, Memory processor actions record a graceful unavailable failure instead of assuming a provider.

`memory.lastProcessorStatus` stores the last redacted Memory processor status known to Agent Cockpit ([ADR-0053](adr/0053-persist-memory-processor-status.md)). Shape: `{ status, updatedAt, backendId?, profileId?, profileName?, chatBackendId?, chatProfileId?, chatProfileName?, differsFromChatProfile?, error? }`. `status` is one of `last_succeeded`, `authentication_failed`, `unavailable`, `runtime_failed`, or `bad_output`. Successful `memory_note` write/skip decisions store `last_succeeded`; processor profile resolution, adapter availability, `runOneShot`, and bad-output failures store the corresponding failure class. `error` is bounded and redacted before persistence, including credential-looking paths and token values. Chat profile fields are present only when the active conversation runtime supplied them while issuing the Memory MCP session.

`defaultEffort` is the default adaptive reasoning level for new conversations. It only applies when the chosen model matches `defaultModel` AND the model supports that effort level; otherwise the per-conversation selection falls back to `high` (or, defensively, the first supported level of the chosen model). The settings modal only renders the **Default Effort** field when `defaultBackend`/`defaultModel` resolve to a model that declares `supportedEffortLevels`; changing the default model to one without effort support drops `defaultEffort` on save.

`ConversationEntry.claudeCodeMode` is a provider-specific session mode, not a shared effort level. The only current value is `"ultracode"` ([ADR-0085](adr/0085-represent-claude-code-ultracode-as-a-provider-session-mode.md)). The server accepts it on conversation create, normal message send, and goal-set requests, stores it only for Claude Code-family backends whose selected model advertises `xhigh`, and clears it when the session resets, the backend/profile changes away from Claude Code, the model no longer supports xhigh, or the request supplies `null`/`""`. Conversation and list responses include the field only while active.

`defaultServiceTier` is the Codex-only default speed tier for new conversations. The only stored value is `"fast"`; absence means the selected Codex profile/config decides the tier. The settings modal only renders **Default Speed** when the selected default profile/backend resolves to Codex. `SettingsService.saveSettings()` drops `defaultServiceTier` when the default runtime is not Codex or the value is unsupported. A conversation-level `serviceTier: "fast"` forces Codex Fast mode; explicit request values `null`, `""`, or `"default"` clear the override so the selected Codex profile/config applies.

The `systemPrompt` is passed to the CLI via `--append-system-prompt` at the start of each new session. It is additive — Claude Code's built-in system prompt is preserved. Legacy `customInstructions` objects in the JSON file are auto-migrated to `systemPrompt` on first read by `SettingsService`; the `customInstructions` field no longer exists in the `Settings` type.

The `memory` block configures the globally-shared **Memory CLI profile** used for `memory_note` MCP processing and post-session extraction (see [Backend Services — Workspace Memory](spec-backend-services.md#workspace-memory)).

The `knowledgeBase` block configures the globally-shared **Ingestion CLI profile**, **Digestion CLI profile**, and **Dreaming CLI profile** for the per-workspace Knowledge Base feature (see **Workspace Knowledge Base** subsection under `ChatService` below). The matching legacy `*CliBackend` fields are retained as fallbacks and are aligned to the selected profile's protocol-derived backend on save. Ingestion is opt-in and is used only for AI-assisted page/slide/image conversion at ingest time; leaving it unset falls back to image-only references for visual content. The Ingestion CLI must pass the backend media gate: profile-aware backend metadata must expose `capabilities.oneShotMediaInput.image`, and the selected/default model must expose `capabilities.input.image === true`. Unknown or stale model media support fails closed. Digestion and Dreaming are text/tool workflows and are not gated on image support. `cliConcurrency` (default 2) caps how many documents are processed in parallel by ingestion, digestion, and dreaming pipelines per workspace; within a single document, work stays sequential. `kbGleaningEnabled` (default `false`) opts digestion into a second per-chunk pass that asks for missed entries after the first extraction. `convertSlidesToImages` opts into the LibreOffice-backed PPTX slide rasterization path; when enabled but LibreOffice is absent from refreshed detection, ingestion logs a warning and falls back to text + speaker notes + embedded media only. LibreOffice presence is detected with `which soffice` / `where.exe soffice`, cached at module level, and refreshed by Settings, Install Doctor, and rasterization attempts so newly installed tools are picked up without restarting Agent Cockpit. `dreamingStrongMatchThreshold` (default 0.75) and `dreamingBorderlineThreshold` (default 0.45) control the retrieval-based routing score thresholds: entries with a top hybrid-search score ≥ strong go directly to synthesis, ≥ borderline go to LLM verification, and below borderline create new topics.

The `workspaceContext` block configures globally-shared Workspace Context
processor defaults for workspaces that opt into Workspace Context and keep
`WorkspaceIndex.workspaceContext.processorMode` at `global`. `cliProfileId`
selects the processor CLI profile; `cliBackend` is retained as a deprecated
fallback/mirror and is aligned to the selected profile's protocol-derived
backend on settings save. `cliModel` and `cliEffort` are optional processor
overrides. `scanIntervalMinutes` defaults to `5` and is normalized to an integer
from 1 to 1440 minutes. `cliConcurrency` defaults to `1` and is normalized to an
integer from 1 to 10; it controls how many workspace scan runs the scheduler can
start at once. `maintenanceIntervalHours` defaults to `24` and is normalized to
an integer from 1 to 8760 hours. `maintenanceCliConcurrency` defaults to `1` and
is normalized to an integer from 1 to 10; it controls how many workspace
maintenance runs the hourly maintenance check can start at once. Legacy
`contextMap` settings are migrated into this block on read/write, and removed
fields such as source toggles plus extraction/synthesis concurrency are stripped.

The `integrations` block stores globally-shared external integration
credentials. `integrations.telegram.botToken` is the single Telegram bot token
used by routines and future outbound notifications; workspaces store only their
destination chat IDs/title/type unless they still have a legacy workspace-level
bot token. Routine Telegram destination pairing creates short-lived in-memory
codes and persists only the resulting workspace destination metadata.
Browser-facing `/settings` responses never include `botToken`; they include
`integrations.telegram.configured: true` when a token exists. Whole-settings
saves preserve the existing token when the browser posts a redacted Telegram
object, replace it when a new non-empty `botToken` is supplied, and clear it
only when `integrations.telegram.clearBotToken: true` is posted.

**Migration:** `dreamingConcurrency` was renamed to `cliConcurrency` in the hybrid-ingestion design (PR 1). On read, `SettingsService.getSettings()` copies `dreamingConcurrency` forward to `cliConcurrency` when the new key is missing — disk state is left untouched until the next save. Existing settings files load without warnings; the deprecated `dreamingConcurrency` field stays on the `Settings` type for one release cycle, then is removed.

**CLI profile migration:** On startup, `ChatService.initialize()` scans every workspace index and assigns `cliProfileId` to existing conversations that only have a `backend`. It creates matching server-configured profile records in settings for every harness seen in existing conversations. The migration does not change `backend`, model, effort, sessions, or any runtime CLI behavior.

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

/** Full KB state snapshot returned by GET /workspaces/:workspaceId/kb */
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

/** Synthesis snapshot returned by GET /workspaces/:workspaceId/kb/synthesis */
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

/** Full topic detail returned by GET /workspaces/:workspaceId/kb/synthesis/:topicId */
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

/** Summary shape returned by GET /workspaces/:workspaceId/kb/reflections */
interface KbReflectionSummary {
  reflectionId: string;
  title: string;
  type: 'pattern' | 'contradiction' | 'gap' | 'trend' | 'insight';
  summary: string | null;
  citationCount: number;
  createdAt: string;
  isStale: boolean;    // true if any cited entry was re-digested, deleted, or lost via cascade
}

/** Detail shape returned by GET /workspaces/:workspaceId/kb/reflections/:reflectionId */
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
 * a backend-managed session ID that needs to be persisted. Harness-agnostic —
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

/**
 * Server-internal stream event emitted by a backend adapter after a persisted
 * native session id cannot be resumed and the adapter is about to retry in a
 * fresh native session. `processStream` consumes it, writes a friendly system
 * message with `Message.sessionRecovery` metadata, forwards that message through
 * the normal `assistant_message` browser frame, and does not forward this raw
 * internal frame.
 */
interface SessionRecoveryEvent {
  type: 'session_recovery';
  message: string;                  // Friendly user-facing recovery notice
  metadata: SessionRecoveryMetadata; // Debug details stored in session JSON
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
