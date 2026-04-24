# 4. Backend Services

[← Back to index](SPEC.md)

---

## 4.1 ChatService

**File:** `src/services/chatService.ts`

**Constructor:** `new ChatService(appRoot, options)` — sets `baseDir` to `<appRoot>/data/chat`, creates `workspaces/` and `artifacts/` dirs synchronously at startup, initializes in-memory `Map<convId, workspaceHash>` for fast lookup.

### Methods

| Method | Description |
|--------|-------------|
| `initialize()` | Runs migration if legacy `conversations/` dir exists, builds convId→workspace lookup map. |
| `createConversation(title, workingDir, backend, model?, effort?)` | Creates entry in workspace index + empty session-1.json. Falls back to `_defaultWorkspace`. `backend` defaults to the registry's first registered adapter. `model` is the optional model alias to persist. `effort` is the optional adaptive reasoning level; silently downgraded (or dropped) if the chosen model doesn't support it. |
| `getConversation(id)` | Returns API-compatible object with messages, or `null`. |
| `listConversations(opts?)` | Scans all workspace indexes. Returns summaries sorted by `lastActivity` desc, each with `workspaceHash` and `workspaceKbEnabled` (defaults to `false` for legacy workspaces). Pass `{ archived: true }` to list only archived; default returns active only. |
| `renameConversation(id, newTitle)` | Updates title in workspace index. Returns full conversation or `null`. |
| `archiveConversation(id)` | Sets `archived: true` on conversation entry in workspace index. Returns `true` or `false` if not found. Files remain on disk. |
| `restoreConversation(id)` | Removes `archived` flag from conversation entry. Returns `true` or `false` if not found. |
| `setConversationUnread(id, unread)` | Toggles the `unread` flag on the conversation's index entry. `unread:true` writes `unread: true`; `unread:false` deletes the field (so the on-disk file stays lean for the common read state). No-op (returns `true`) when the entry already matches the requested state. Returns `false` when the conversation isn't found. The `unread` field is also surfaced in `listConversations()` summaries so the v2 sidebar can render the unread dot on first paint. |
| `deleteConversation(id)` | Removes from index, deletes session folder + artifacts, removes from lookup map. Works on both active and archived conversations. |
| `updateConversationBackend(convId, backend)` | Updates backend field in workspace index. When the backend actually changes, clears `conversation.usage.contextUsagePercentage` and the active session's `usage.contextUsagePercentage` before persisting so a prior backend's context-window snapshot (e.g. Kiro's `14.45%`) can't leak into the new backend's top-bar chip. |
| `updateConversationModel(convId, model)` | Updates model field in workspace index. Pass `null` to clear. Silently downgrades the stored `effort` when the new model doesn't support the current level, or clears it if the new model has no effort support at all. |
| `updateConversationEffort(convId, effort)` | Updates effort field in workspace index. Pass `null` to clear. Silently downgrades the requested level to what the conversation's current model supports. |
| `addMessage(convId, role, content, backend, thinking, toolActivity, turn, contentBlocks)` | Appends to active session + updates index metadata. Auto-titles on first user message (session 1 only; post-reset sessions rely on LLM title generation). `thinking` omitted if falsy. `toolActivity` omitted if falsy or empty array. `turn` ('progress'/'final') and `contentBlocks` (ordered interleaving of text/thinking/tool blocks — see Data Models → ContentBlock) are assistant-only; both are omitted for user/system messages. `contentBlocks` is the authoritative representation when present; `content`, `thinking`, and `toolActivity` are derived views kept for back-compat. |
| `updateMessageContent(convId, messageId, newContent)` | Truncates after target message, adds edited content as new message. |
| `generateAndUpdateTitle(convId, userMessage)` | Generates a new title via the backend adapter's `generateTitle()`, hard-cuts it to max 8 whitespace-separated words, and persists it. The clamp runs after the adapter (and after the fallback path) so every backend is bounded uniformly. Returns the new title or `null`. |
| `resetSession(convId)` | Archives active session (summary, endedAt), creates new session, resets title to "New Chat". Also clears `conversation.usage.contextUsagePercentage` at the top of the reset so the old session's context-window snapshot can't persist onto the new (empty) session's chip. Returns `{ conversation, newSessionNumber, archivedSession }`. |
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

### Durability primitives

Every JSON file ChatService writes (`workspaces/{hash}/index.json`, session files, the usage ledger, memory `snapshot.json`) goes through `atomicWriteFile` from `src/utils/atomicWrite.ts` — a sibling-tmp + `rename(2)` helper so readers never observe a torn file. Read-modify-write methods that mutate a workspace index are wrapped in `_indexLock.run(hash, ...)` (a `KeyedMutex` from `src/utils/keyedMutex.ts`) so concurrent mutators on the same workspace serialize FIFO and never lose updates; different workspaces run in parallel. `_recordToLedger` and `clearUsageStats` use `_ledgerLock` with the constant key `'__usage_ledger__'` for the same reason on the shared ledger. `generateAndUpdateTitle` keeps the slow backend adapter call **outside** the lock (only the persist step acquires it) so a hung backend can't stall other writes on the workspace. `initialize()`'s `_buildLookupMap` catches `JSON.parse` failures per workspace, logs a warning, and keeps building — a single corrupt `index.json` degrades access to that workspace but cannot crash the server into a restart loop.

### Workspace Context Injection

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

### Workspace Memory

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

### Memory MCP Server

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

4. **Wiring into backends** — When a message is sent for a memory-enabled workspace, the chat route (`src/routes/chat.ts`) calls `memoryMcp.issueMemoryMcpSession` and passes the resulting array as `mcpServers` on `SendMessageOptions`. When KB is also enabled, `kbSearchMcp.issueKbSearchSession(convId, wsHash)` is called and the resulting `mcpServers` config is merged into the same array — the CLI receives both MCP servers simultaneously. `KiroAdapter` forwards the merged array to ACP's `session/new` and `session/load` (env as an array of `{name, value}` pairs per the ACP spec). `ClaudeCodeAdapter` transforms the array into Claude Code's `--mcp-config` JSON shape via `mcpServersToClaudeConfigJson` (env as a plain `Record<string, string>`, keyed by server name) and passes it as a JSON string argument. Both paths spawn the respective `stub.cjs` processes with the correct env vars. KB Search tokens are revoked alongside Memory tokens on session reset and conversation delete.

5. **Memory CLI helper** — `BaseBackendAdapter.runOneShot(prompt, options?)` is the cross-backend primitive used by the MCP handler and the post-session extraction path. The default base class implementation throws; `ClaudeCodeAdapter` overrides it with `execFile('claude', ['--print', '-p', prompt, '--model', ...])` and `KiroAdapter` with `execFile('kiro-cli', ['chat', '--no-interactive', '--trust-all-tools', prompt])`. Both respect a 60-90s hard timeout and throw a typed error on non-zero exit. **Important:** all `execFile` calls close stdin immediately via `child.stdin?.end()` to prevent the Claude CLI from emitting a "no stdin data received" warning that pollutes stderr.

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

### Workspace Knowledge Base

Per-workspace **Knowledge Base** gives each workspace a curated store of documents the CLI can consult on demand. The feature is **opt-in per workspace** via `WorkspaceIndex.kbEnabled` (defaults to `false`) and is independent of the Memory toggle — enabling one does not enable the other. When the toggle is off, every KB code path (pointer injection, pipeline, UI browser) short-circuits and the `knowledge/` directory is never created on disk.

The feature is delivered across five sequential PRs. **PR 1** landed the storage layer, types, settings plumbing, feature toggles, and system-prompt pointer. **PR 2** added the ingestion stage: per-format handlers, background conversion, the upload endpoint, and the KB Browser UI for uploading/listing/deleting raw files. **PR 3** rewrites the metadata layer as SQLite (`knowledge/state.db`), introduces virtual folders with multi-location (Option B) ref-counted deletes, adds the per-raw digestion pipeline with its own CLI, an auto-digest toggle, a pending-delete state, a batch "Digest All Pending" runner, and the Entries tab in the KB Browser. **PR 4** adds the Dreaming pipeline — cross-entry synthesis that builds a knowledge graph of topics and connections, the Synthesis tab in the KB Browser, and the dream banner in the chat input area. **PR 5** (current) adds the Reflection layer — a 5th dreaming phase that identifies clusters of connected topics and generates cross-cluster reflections (patterns, contradictions, gaps, trends, insights) with entry citations, plus the `knowledge_search` MCP tool.

**Pipeline stages:**
1. **Ingestion** — Our code. Accepts a raw upload, stores it under `knowledge/raw/<rawId>.<ext>`, extracts text + media into `knowledge/converted/<rawId>/` via format-specific handlers. LibreOffice is used as an opt-in helper for PPTX slide rasterization when `Settings.knowledgeBase.convertSlidesToImages` is true.
2. **Digestion** (PR 3 — active) — Per-raw. Spawns the Digestion CLI (`Settings.knowledgeBase.digestionCliBackend`) one-shot against each converted raw file with a prompt that pastes in `text.md` + the converted-file path so the multimodal CLI can follow links into `converted/<rawId>/pages/page-NNNN.png` etc. Produces one or more entry documents (YAML frontmatter + markdown body) which are parsed, slug-deduped, written to `knowledge/entries/<entryId>/entry.md`, and indexed in the `entries` + `entry_tags` SQLite tables.
3. **Dreaming** (PR 4+5 — active) — Cross-entry synthesis, manual trigger. Spawns the Dreaming CLI (`Settings.knowledgeBase.dreamingCliBackend`) in a five-phase pipeline: Routing → Verification → Synthesis → Discovery → Reflection. Produces a knowledge graph stored in SQLite (`synthesis_topics`, `synthesis_topic_entries`, `synthesis_connections`, `synthesis_reflections`, `synthesis_reflection_citations`) and materialized as markdown files under `knowledge/synthesis/` and `knowledge/synthesis/reflections/`. Entry→topic assignments are many-to-many. Topic→topic connections carry a relationship label and confidence level (`extracted | inferred | speculative`). Reflections are cross-cluster insights citing specific entries. See the **Dreaming pipeline** section below for full details.

Both active stages run **serialized per workspace** — the KB pipeline holds at most one in-flight CLI invocation per workspace hash on a shared FIFO queue (`Map<hash, Promise<unknown>>`). Ingestion and digestion share the same queue, so a background digest cannot overlap with a fresh upload's conversion handler on the same store.

**SQLite layer** (`src/services/knowledgeBase/db.ts`): Each workspace owns one `knowledge/state.db` (better-sqlite3, WAL mode, `foreign_keys = ON`). The `KbDatabase` class is the only code allowed to talk to the DB — everything else goes through it. Schema:
- **`meta`** — `{ schema_version, created_at }` key/value store. Schema is versioned via `KB_DB_SCHEMA_VERSION` and bumped on destructive migrations.
- **`raw`** — one row per content-addressed raw file: `{ raw_id, sha256, status, byte_length, mime_type, handler, uploaded_at, digested_at, error_class, error_message, metadata_json }`. Indexed on `status` and `sha256` (the dedupe lookup key).
- **`folders`** — virtual folder tree keyed on `folder_path` (root is the empty string `''`, always present after `_ensureRootFolder`). Folders are purely a metadata construct — no on-disk directories are created.
- **`raw_locations`** — `(raw_id, folder_path, filename)` junction table. Same `raw_id` can live in multiple folders (Option B multi-location) so uploading the same bytes under a different name or in a different folder doesn't duplicate the raw file; it just adds a location row. `ON DELETE CASCADE` from `raw` and `ON DELETE RESTRICT` from `folders` so the orchestrator has to explicitly empty a folder before dropping it.
- **`entries`** — digested entry metadata: `{ entry_id, raw_id, title, slug, summary, schema_version, stale_schema, digested_at, needs_synthesis }`. `entry_id` is stable across redigests (format: `<rawId>-<slug>[-<n>]`). Cascades on raw delete. `stale_schema` is set when the current `entrySchemaVersion` is newer than the row's. `needs_synthesis` (INTEGER DEFAULT 1) is set on new digestion, re-digestion, or when a co-topic entry is deleted — tracks which entries the next dream run should process. Partial index on `(entry_id) WHERE needs_synthesis = 1`.
- **`entry_tags`** — `(entry_id, tag)` many-to-many, cascades on entry delete.
- **`synthesis_meta`** — `(key, value)` key/value store for dream run metadata (`status`, `last_run_at`, `last_run_error`, `god_nodes`).
- **`synthesis_topics`** — `{ topic_id, title, summary, content, updated_at }`. One row per discovered topic.
- **`synthesis_topic_entries`** — `(topic_id, entry_id)` many-to-many junction. Cascades from both `synthesis_topics` and `entries`. Entry→topic membership IS the lineage — no separate manifest needed.
- **`synthesis_connections`** — `{ source_topic, target_topic, relationship, confidence, evidence }`. `UNIQUE(source_topic, target_topic)`. Cascades from `synthesis_topics` on either FK.
- **`synthesis_reflections`** — `{ reflection_id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, summary TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL, original_citation_count INTEGER NOT NULL DEFAULT 0 }`. One row per reflection. `type` is one of `pattern | contradiction | gap | trend | insight`. `original_citation_count` stores the number of cited entries at insertion time — used by `listStaleReflectionIds()` to detect when cascade-deletes silently remove citation rows.
- **`synthesis_reflection_citations`** — `(reflection_id TEXT NOT NULL, entry_id TEXT NOT NULL)` many-to-many junction. `REFERENCES synthesis_reflections(reflection_id) ON DELETE CASCADE`, `REFERENCES entries(entry_id) ON DELETE CASCADE`. `PRIMARY KEY (reflection_id, entry_id)`. Index on `entry_id` for reverse lookups (finding all reflections that cite a given entry).

All writes go through prepared statements. Folder ops use `transaction()` wrappers so rename/cascade delete roll back atomically. Entry inserts also run in a transaction so the row and its tags land together. `normalizeFolderPath` strips leading/trailing slashes, collapses repeated slashes, rejects `..` / control chars / empty segments / segments longer than 128 chars / total paths longer than 4096 chars, and returns `''` for root — called from every DB method that touches a folder path so the rules live in one place.

**Migration from Phase 1/2 state.json**: `openKbDatabase({ dbPath, legacyJsonPath, rawDir })` handles the one-shot migration:
1. If `state.db` already exists → open and return (idempotent).
2. Else if `state.json` exists → open a fresh DB, read the legacy JSON, **re-hash every raw file from disk** (the legacy format only kept the 16-char `rawId`; the DB needs the full `sha256` to dedupe), insert `raw` + `raw_locations` rows in one transaction, snap any `ingesting`/`digesting` row to `failed` (those states mean the server died mid-run), and rename the old JSON to `state.json.migrated` as a one-release safety copy.
3. Else → open a fresh DB with the empty schema + root folder only.

Files missing on disk during migration are still inserted with `sha256 = rawId` and a warning log — we'd rather surface the broken row in the UI than silently drop it.

**`KbState` shape** surfaced by `GET /kb` (snapshot assembled on every read from the DB, not persisted separately):
```typescript
{
  version: number,              // DB schema version from meta
  entrySchemaVersion: number,   // KB_ENTRY_SCHEMA_VERSION from digest.ts
  autoDigest: boolean,          // mirrors WorkspaceIndex.kbAutoDigest
  counters: {                   // workspace totals for header badges
    rawTotal: number,
    rawByStatus: Record<KbRawStatus, number>,
    entryCount: number,
    pendingCount: number,       // ingested + pending-delete
    folderCount: number,
    topicCount: number,
    connectionCount: number,
    reflectionCount: number,
  },
  folders: KbFolder[],          // full flat folder tree sorted by folderPath
  raw: KbRawEntry[],            // ONE PAGE of the focused folder (not workspace-wide)
  updatedAt: string,
}
```
`KbRawStatus` is `'ingesting' | 'ingested' | 'digesting' | 'digested' | 'failed' | 'pending-delete'`. `pending-delete` is set when the last location of a raw file is removed while auto-digest is off — the raw row survives until "Digest All Pending" runs and decides whether to digest-then-purge or just purge. `KbErrorClass` is `'timeout' | 'cli_error' | 'malformed_output' | 'schema_rejection' | 'unknown'`, stored on the raw row alongside the full `errorMessage` so the UI can surface what actually went wrong.

**Feature gating:** `getOrInitKbDb(hash)` on `ChatService` is the single entry point — it opens `state.db` (and runs migration) on first access for enabled workspaces, and returns `null` for disabled workspaces so nothing touches disk. `getKbStateSnapshot(hash, { folderPath, limit, offset })` assembles the `KbState` object from the DB for `GET /kb`; it returns an in-memory empty scaffold when KB is disabled. `getWorkspaceKbPointer(hash)` returns `null` when disabled, otherwise `mkdir -p`s `knowledge/entries/` so the CLI can read the directory without hitting ENOENT on a brand-new workspace, and returns a bracketed text block naming the absolute path.

**Pointer injection:** On new sessions, the chat route prepends three bracketed blocks to the outgoing user message — discussion history (always), memory (when enabled), knowledge base (when enabled) — see **Workspace Context Injection** above. KB content itself is never serialized into the system prompt; the CLI reads `state.db` / `entries/<entryId>/entry.md` on demand via its own file tools, so resumed sessions keep access and mid-session additions are visible on the next turn. Additionally, when KB is enabled, the system prompt receives a KB Tools addendum that teaches the CLI about the 6 MCP search/ingestion tools and the filesystem layout for direct reads — including `synthesis/reflections/*.md` for cross-cluster reflection files generated by the Dreaming pipeline's Reflection phase. The CLI uses search tools (Layer 1 — hybrid retrieval) to narrow relevant knowledge, then reads files directly (Layer 2 — agentic orchestration) for full content.

**LibreOffice detection** (`src/services/knowledgeBase/libreOffice.ts`): `detectLibreOffice()` runs once at server startup (fire-and-forget, so it never blocks port binding) and caches the result at module level. It uses `which soffice` on POSIX and `where soffice` on Windows — not `soffice --version`, because launching the full binary would spawn a user profile at startup. The cached `LibreOfficeStatus` (`{ available, binaryPath, checkedAt }`) is consulted by the ingestion stage (PR 2) when `Settings.knowledgeBase.convertSlidesToImages` is true; if LibreOffice is unavailable, ingestion logs a warning and falls back to extracting text + speaker notes + embedded media only. The cached status is also exposed via `GET /kb/libreoffice-status` so the global Settings modal can validate the checkbox on click: when the user turns the "Convert PPTX slides to images" box on, the frontend fetches the endpoint, and if `available` is `false` the box auto-reverts to unchecked and a warning appears underneath telling the user to install LibreOffice and restart the cockpit. Detection is cached for the process lifetime, so installing LibreOffice while the server is running requires a restart to pick up.

**Pandoc detection** (`src/services/knowledgeBase/pandoc.ts`): Mirror of the LibreOffice module, with one key difference — pandoc is **required**, not optional, for DOCX ingestion. `detectPandoc()` runs once at server startup, uses `which pandoc` / `where pandoc` to locate the binary, then probes `pandoc --version` (cheap and side-effect-free) to surface the version string in the Settings UI. Result is cached as `PandocStatus` (`{ available, binaryPath, version, checkedAt }`) at module level. The shared `runPandoc(args, { timeoutMs, maxBuffer })` helper throws immediately when the cached status reports unavailable, so callers don't have to re-check. When pandoc is missing, the route layer rejects `.docx` uploads pre-flight with a `400` containing an install hint (`brew`/`apt`/`choco` one-liners and `https://pandoc.org/installing.html`). The frontend surfaces the same state in two places: the KB Browser Raw tab renders a persistent warning banner (`chat-kb-banner-warn`) above the upload zone when `GET /kb/pandoc-status` returns `available: false`, and the global Settings → Knowledge Base tab shows a "Pandoc (required for DOCX ingestion)" status row — green "Detected vX.Y.Z at /path" or red "Not found on PATH" — refreshed on tab open.

**Global settings:** `Settings.knowledgeBase` configures the Digestion and Dreaming CLIs separately (each with its own `cliBackend`, `cliModel`, `cliEffort`), the `dreamingConcurrency` (1–10, default 2) for parallel CLI calls during dreaming, and the `convertSlidesToImages` opt-in. Both CLI roles fall back to `Settings.defaultBackend` when unset. The settings modal exposes cascading backend → model → effort pickers per role, mirroring the existing Memory CLI picker pattern, plus a numeric input for dreaming concurrency.

**Workspace settings:** The workspace Settings modal has a Knowledge Base tab with a single checkbox (`kbEnabled`). Once enabled, the full-screen **KB Browser** (see Section 6) becomes the upload UI and entry list. Saving the toggle hits `PUT /workspaces/:hash/kb/enabled` and does not touch `memoryEnabled`. A second per-workspace flag — `kbAutoDigest` — is surfaced as a toolbar switch in the KB Browser (not in the settings modal) because it's a day-to-day operational choice, not a setup step.

**Ingestion pipeline:** `KbIngestionService` (`src/services/knowledgeBase/ingestion.ts`) is the single entry point the chat route calls for uploads, folder CRUD, and raw deletion. It is constructed with `{ chatService, emit, digestTrigger? }` where `emit(hash, frame)` is a workspace-scoped WS fan-out callback and `digestTrigger` is a late-bound reference to `KbDigestionService.enqueueDigest` — the circular dependency between the two services is broken via `setDigestTrigger()` after both are constructed.

- **Content addressing** — `sha256 = sha256(buffer)` is the full hash, `rawId = sha256.slice(0, 16)` is the stable URL/filename prefix. Dedupe looks up the **full sha256** in the `raw` table via `getRawBySha`, so renames don't break dedupe and collisions on the short prefix would still be caught (extremely unlikely in practice).
- **Multi-location (Option B)** — `enqueueUpload(hash, { buffer, filename, mimeType, folderPath })`:
  - If the sha256 already exists and the same `(folderPath, filename)` tuple is already a location for that raw → no-op, returns `{ deduped: true, addedLocation: false }`.
  - If the sha256 already exists but `(folderPath, filename)` is new → insert a single `raw_locations` row, re-stage the raw bytes on disk if they're missing (edge case), return `{ deduped: true, addedLocation: true }`. No reconversion.
  - If the sha256 is new but `(folderPath, filename)` is already taken by a different sha256 → throw `KbLocationConflictError`, which the route maps to `409`. The UI surfaces "a different file already exists at this path — rename and retry".
  - If both are new → write `raw/<rawId>.<ext>`, insert `raw` + `raw_locations` rows in a single transaction (status `ingesting`), and schedule background conversion.
- **Per-workspace FIFO queue** — A `Map<hash, Promise<unknown>>` chains every mutation (ingestion, conversion handler, delete, folder rename, digestion) so a single workspace can only have one in-flight operation at a time. Different workspaces run in parallel. The queue is shared with `KbDigestionService` via constructor injection — batch digests and uploads can't interleave. `waitForIdle(hash)` returns when the chain is empty (used by tests and by the delete path to avoid TOCTOU against a still-running handler).
- **Filename + folder validation** — Filenames can't contain path separators or be empty. Folder segments are validated through `normalizeFolderPath` in `db.ts` — reject `..`, control chars, `>128 chars` per segment, `>4096 chars` total. Validation failures surface as `KbValidationError` → `400`.
- **Handler dispatch** — `pickHandler(filename, mimeType)` matches on extension first (`.pdf`→pdfHandler, `.docx`→docxHandler, `.pptx`→pptxHandler, passthrough-supported text/image extensions→passthroughHandler), then falls back to a MIME-type map. Unknown files throw `UnsupportedFileTypeError`, caught by the background handler which lands the raw row in `status='failed'` with the error message stored on `raw.error_message` and `errorClass='unknown'`.
- **Conversion output** — Each handler writes into `converted/<rawId>/`:
  - `text.md` — extracted text (or image index) with an `# <filename>` header. PDF is a **thin index** of `## Page N` sections each containing a single `![Page N](pages/page-NNNN.png)` link — no extracted prose — because the pipeline now rasterizes pages at 150 DPI and lets the multimodal Digestion CLI read the images directly. DOCX is GFM-flavored markdown from pandoc (tables preserved) with a `## Embedded Media` block when media is present. PPTX has `## Slide N` sections with optional `### Speaker Notes` plus a `## Embedded Media` block. Passthrough preserves markdown as-is or wraps other text in a code fence tagged with the file extension; full content is preserved regardless of file size.
  - `meta.json` — `{ rawId, handler, extractedAt, metadata }` where `metadata` is handler-specific (`pageCount`, `wordCount`, `slideCount`, `totalSlideCount`, `hiddenSlideCount`, `slidesToImagesRequested`, `slideImagesWarning`, `mediaCount`, …).
  - `media/` — copied embedded media (DOCX `word/media/`, PPTX `ppt/media/`, passthrough images). Text handlers that find no media omit the directory.
- **Progress substeps** — The ingestion pipeline emits `substep: { rawId, text }` frames at each stage so the UI can show live progress beneath the status badge: `"Converting…"` before `ingestFile()` runs, and `"Storing…"` after the handler returns while writing output files. The frontend also starts an elapsed-time ticker when a raw enters the `ingesting` state.
- **Completion** — On success the orchestrator updates the `raw` row to `status='ingested'`, writes the handler tag to `raw.handler`, stores handler metadata on `raw.metadata_json`, and emits a `kb_state_update` frame. If `kbAutoDigest` is true, the orchestrator fires `digestTrigger(hash, rawId)` to chain a digest job onto the same queue before returning. On failure it sets `status='failed'` with the error class and message, emits the frame, and does not trigger digestion.
- **Ref-counted delete** — `deleteLocation(hash, rawId, folder, filename)` removes a single `raw_locations` row. If `countLocations(rawId) > 0` after the delete, the raw row stays (another location still references it). If this was the last location, the raw is fully purged via `_purgeRawInternal` (removes raw bytes, converted dir, `entries/<entryId>/` dirs, DB rows) regardless of auto-digest setting. After purge, `_deleteOrphanTopics()` is called inside the transaction to remove any synthesis topics that lost all their entries due to the cascade delete.
- **Full purge** — `purgeRaw(hash, rawId)` (also aliased as the legacy `deleteRaw` for test compatibility) unconditionally drops every `raw_locations` row, the `raw` row, the raw bytes, `converted/<rawId>/`, every entry's `entries/<entryId>/` dir, and the DB rows for the entries + `entry_tags` (cascade). After purge, orphan topic cleanup runs. Used by the "full purge" mode of `DELETE /kb/raw/:rawId` (no query string).
- **Folder CRUD** — `createFolder`, `renameFolder`, `deleteFolder({ cascade })` all run on the same queue and emit `folders: true` frames. `renameFolder` rewrites every `raw_locations` row under the subtree in a single SQLite transaction — no on-disk renames happen because folders are purely virtual. `deleteFolder` with `cascade: true` walks the subtree and removes every location following the same ref-counted purge rules as `deleteLocation` (always full purge on last location), then drops the folder rows deepest-first; without `cascade` it throws if the subtree still contains any locations.
- **WS fan-out** — The chat router instantiates `KbIngestionService` with an `emit` callback that walks `activeStreams` and, for every conversation whose workspace hash matches the frame, calls the WS module's `send`. The KB Browser is conversation-agnostic though, so it also polls `GET /workspaces/:hash/kb` every 1.5s while open to pick up changes even when no CLI stream is active in the target workspace.

**Digestion pipeline:** `KbDigestionService` (`src/services/knowledgeBase/digest.ts`) handles the `ingested → digested` transition. It is constructed with `{ chatService, backendRegistry, emit }` and shares the per-workspace FIFO queue with the ingestion service so a user upload can't race with a batch digest.

- **Prompt construction** — `buildDigestPrompt` renders a markdown prompt that names the filename + folder context, the handler tag, the MIME type, and the **relative path** to `converted/<rawId>/text.md` (so the CLI can read additional artifacts — slide PNGs, media, etc. — via its own file tools rather than having everything pasted into the prompt). Handler metadata is stringified into the prompt so the CLI knows up front how many pages/slides to expect.
- **CLI invocation** — The Digestion CLI is resolved from `Settings.knowledgeBase.digestionCliBackend`/`digestionCliModel`/`digestionCliEffort` via `BackendRegistry.get(cliBackend)`. The call uses `runOneShot(prompt, { allowTools: true, cwd: knowledgeDir, timeoutMs: 15 * 60_000 })` so the CLI can follow relative paths inside `knowledge/`. The 15-minute timeout accommodates large documents (e.g. 80+ page rasterized PDFs processed with Opus). Missing/unregistered CLI lands as `errorClass='unknown'`.
- **Progress substeps** — The digestion pipeline emits `substep: { rawId, text }` frames at two points: `"Running CLI analysis…"` before `runOneShot()` and `"Parsing entries…"` after the CLI returns. Combined with the frontend's elapsed-time ticker (started when a raw enters `digesting`), this gives the user a sense of progress during long digestion runs (which can exceed 10–20 minutes for large slide decks).
- **Error classification** — Each failure mode lands a specific `KbErrorClass` on the raw row so the UI can render actionable copy:
  - **`timeout`** — `runOneShot` exceeded its 15-minute timeout.
  - **`cli_error`** — CLI exited non-zero or threw an adapter error.
  - **`malformed_output`** — stdout couldn't be parsed into entry-delimited frontmatter + body (also used for a missing `text.md`).
  - **`schema_rejection`** — parsed entries exist but failed field validation (missing title/slug/summary/tags).
  - **`unknown`** — catch-all (including "KB disabled mid-run" and config errors).
- **Entry parsing** — Output is split on `---`-separated entry boundaries. Each chunk is parsed as YAML frontmatter + markdown body and validated against `ParsedEntry` (`title`, `slug`, `summary`, `tags[]`, `body`). The body accumulation loop distinguishes entry-boundary `---` lines from markdown horizontal rules within the body by peeking ahead: when `---` is encountered, the parser scans forward past blank lines and checks whether the next non-blank line matches `title:` (the required first frontmatter field). If it does, the `---` is treated as a new entry boundary; otherwise it is included in the current entry's body as a horizontal rule. The parser is lenient about common CLI output quirks: leading/trailing triple-backtick code fences (e.g. `` ```yaml ... ``` ``) are stripped, preamble prose before the first `---` fence is skipped, and frontmatter keys are lowercased before lookup so `Title:` and `TITLE:` both resolve to `title`. Malformed chunks raise `DigestParseError`, schema violations raise `DigestSchemaError` — both are caught internally and classified. On `malformed_output` or `schema_rejection` failures, the raw CLI output is dumped to `knowledge/digest-debug/<rawId>-<iso>.txt` and the debug path is appended to the error message so the user can inspect exactly what the CLI returned.
- **Entry serialization** — `stringifyEntry(entry, opts?)` converts a `ParsedEntry` back to YAML frontmatter + markdown body. The frontmatter always includes `title`, `slug`, `summary`, `tags[]`, and `schemaVersion` in a deterministic order. Optional temporal metadata — `uploadedAt` (ISO 8601 from the raw row's `uploaded_at`) and `digestedAt` (ISO 8601 timestamp of the digestion run) — is appended to the frontmatter when provided via `StringifyEntryOptions`. Values containing YAML-special characters (colons, quotes) are auto-quoted.
- **Entry frontmatter format** — Each `entry.md` on disk has the following YAML frontmatter fields:
  ```yaml
  ---
  title: "Entry Title"
  slug: entry-title
  summary: "One-line summary"
  tags: [tag1, tag2]
  schemaVersion: 1
  uploadedAt: "2026-04-10T08:30:00.000Z"
  digestedAt: "2026-04-10T09:15:00.000Z"
  ---
  ```
  `uploadedAt` records when the raw file was first uploaded; `digestedAt` records when this entry was produced by the Digestion CLI. Both are ISO 8601 strings. These timestamps are informational — they help users and downstream tooling understand the freshness of each entry.
- **Slug collision handling** — `entryId = <rawId>-<slug>`. If that already exists in the DB (within the same run or from a previous digest of a different raw), the writer appends `-2`, `-3`, … until `entryIdTaken` returns false. Old entries for the same `rawId` are cleared first (`deleteEntriesByRawId`) so redigests replace, not accumulate.
- **Entry writing** — Each entry is written to `entries/<entryId>/entry.md` (one dir per entry, because later PRs will park supporting files like vector chunks alongside the markdown). The `entries` + `entry_tags` rows are inserted in a single transaction. On any write failure the raw row lands in `failed` and nothing partial is committed.
- **Completion** — On success the raw row moves to `status='digested'`, `digestedAt` is stamped, `errorClass/errorMessage` are cleared, and a `kb_state_update` frame is emitted with `raw: [rawId]` and `entries: [entryId, …]`.
- **Pending-delete handling** — When `_runDigest` encounters a `pending-delete` raw it skips the entire CLI pipeline and purges the raw immediately (raw bytes, converted dir, leftover entries, DB rows). The user already deleted the last location — there's nothing to digest. The result carries `purged: true`.
- **Top-level safety net** — The digest pipeline is wrapped in a top-level try/catch so unexpected errors land as `status='failed'` with `errorClass='unknown'` instead of leaving the raw stuck in `digesting` forever.
- **Batch mode** — `enqueueBatchDigest(hash)` lists every `ingested` + `pending-delete` raw (`pending-delete` first so purges happen before digestions) and chains each one onto the shared queue. Failures inside the batch don't stop the run — they land on their raw row and the loop continues. Progress is reported through the unified **digestion session counter** (see below) rather than a batch-specific frame.
- **Digestion session counter** — The service holds a per-workspace `sessions` map keyed by hash with shape `{ entriesCreated, pending, total, done, totalElapsedMs, startedAt }`, created lazily when any digest task enqueues (single via `enqueueDigest`, batch via `enqueueBatchDigest`, or an auto-digest chained by the ingestion orchestrator). One session covers all three paths so concurrent single digests interleaving with a batch or auto-digest run share a single count-up.
  - `_trackPending(hash, +n)` opens the session on the first positive delta into an idle workspace, bumps `total` by the delta, and emits a `kb_state_update { digestProgress }` frame so the KB Browser toolbar can show the new totals immediately.
  - After each task settles, `_recordTaskDone(hash, elapsedMs)` bumps `done`, accumulates `totalElapsedMs`, persists the session row to `digest_session` in the KB DB (cheap — sqlite, sub-ms), and emits an updated `digestProgress` snapshot.
  - `_recordEntriesCreated(hash, n)` runs in parallel to bump `entriesCreated` and emit the existing `digestion: { active: true, entriesCreated }` frame.
  - When `pending` drops to zero the service emits a final `digestion: { active: false, entriesCreated }` frame **and** a `digestProgress: null` signal (so the frontend can clear the toolbar indicator without a truthy-check ambiguity), then deletes both the in-memory session and the persisted `digest_session` row.
- **Progress snapshot shape** — `computeDigestProgress({ total, done, totalElapsedMs })` is the single source of truth for the frame shape. It computes `avgMsPerItem = round(totalElapsedMs / done)` (0 until the first settle) and, once `done >= 2` and the average is non-zero, appends `etaMs = (total - done) * avgMsPerItem`. Withholding ETA until the second sample lands avoids a wildly fluctuating estimate caused by the first task's CLI warm-up + filesystem cache cost. The same helper runs in `chatService.getKbStateSnapshot` so `GET /workspaces/:hash/kb` can return `digestProgress` consistent with the live WS frames (the snapshot path reads the persisted row and runs it through `computeDigestProgress`).
- **Crash recovery** — On `KbDatabase` construction, `_recoverFromCrash()` flips any stuck `status='digesting'` raws back to `ingested` (nothing can actually be digesting in a freshly-opened DB) and `DELETE FROM digest_session`. A server crash mid-session therefore can't leave the toolbar indicator stuck forever; the next enqueue opens a fresh session.

**Dreaming pipeline:** `KbDreamService` (`src/services/knowledgeBase/dream.ts`) handles the cross-entry synthesis phase that turns digested entries into a knowledge graph of topics and connections. It is constructed with `{ chatService, backendRegistry, emit, kbSearchMcp }` and holds a per-workspace lock (`running` Set) to prevent concurrent dream runs.

- **Two modes:** Incremental (`dream(hash)`) processes only entries with `needs_synthesis = 1`. Full Rebuild (`redream(hash)`) wipes all synthesis data (`wipeSynthesis()` — which also wipes reflections and reflection citations) and vector store embeddings, then reprocesses every entry. Both are fire-and-forget — the endpoint returns 202 immediately.
- **Retrieval-based pipeline (Phase B):** Replaced the flat-file Discovery→Synthesis two-phase approach with a three-phase retrieval pipeline. No more `_dream_tmp/` directory or `all-topics.txt` dumps — topic discovery is now server-side via embeddings + hybrid search.
  1. **Routing** — Embeds all pending entries (`title — summary`) in batches (50/batch) via the embedding service. For each entry, performs `hybridSearchTopics(text, embedding, 10)` against the PGLite vector store. Classifies each entry by top match score:
     - **Strong match** (score ≥ `dreamingStrongMatchThreshold`, default 0.75): routed directly to synthesis with all topics above the borderline threshold.
     - **Borderline** (score ≥ `dreamingBorderlineThreshold`, default 0.45): queued for LLM verification.
     - **No match** (score < borderline or no results): queued for new topic creation.
  2. **Verification** — Lightweight LLM call (no MCP tools, `baseRunOptions`) for borderline entries. Batched at 10 entries. Prompt asks yes/no per entry-topic pair. `parseVerificationOutput()` extracts `{ verified: [...], rejected: [...] }` from the CLI response. Verified entries join synthesis groups; rejected entries join the unmatched pool.
  3. **Synthesis** — CLI calls with MCP search tools (`runOptionsWithMcp`) for topic updates. `buildRetrievalSynthesisPrompt()` lists pre-matched topic IDs (CLI uses `get_topic` MCP tool to fetch content) and instructs the CLI to use `search_topics`/`find_similar_topics` for connection discovery. All 10 operations are available. Unmatched entries go through `buildNewTopicCreationPrompt()` with MCP tools enabled.
- **Cold start path** — When no topics exist or no embedding config is available, all entries go through `_runColdStart()`: entries sorted by tags, batched at 10. First batch uses `buildNewTopicCreationPrompt()` without MCP tools (nothing to search). Topics from batch 1 are embedded immediately, so subsequent batches get MCP tools and can search existing topics.
- **Per-batch topic embedding** — After each synthesis batch's `applyOperations()`, `_embedBatchTopics()` embeds only the affected topics (extracted by `extractAffectedTopicIds()` from create/update/delete/merge/split operations). Makes new/updated topics immediately searchable by subsequent batches. A final `_embedTopics()` sweep at run end cleans up stale embeddings.
- **KB Search MCP session** — At dream start, `kbSearchMcp.issueKbSearchSession(hash, hash)` mints a bearer token scoped to the dream run (session key = workspace hash). The token is passed to CLI calls via `mcpServers` in `RunOneShotOptions`. Revoked in the `finally` block after the run. For conversation sessions, the session key is the `convId` — see KB Search MCP server section below.
- **File-reference prompts** — All prompts are lightweight instruction sheets that point the CLI to files on disk. Prompts stay small regardless of KB scale; the CLI reads files using its own tools (`allowTools: true`). Each prompt includes an `EXECUTION_STRATEGY` block instructing multi-agent parallelism when supported.
- **Concurrency** — `Settings.knowledgeBase.dreamingConcurrency` (default 2, max 10) controls parallel CLI calls within each batch. Batches within a phase are sequential; CLI calls within a batch are parallel.
- **Operation types** — The CLI returns `{ "operations": [...] }` JSON with 10 supported ops: `create_topic`, `update_topic`, `merge_topics`, `split_topic`, `delete_topic`, `assign_entries`, `unassign_entries`, `add_connection`, `update_connection`, `remove_connection`. All ops are parsed and validated by `parseDreamOutput()` then applied transactionally by `applyOperations()` (`src/services/knowledgeBase/dreamOps.ts`).
- **Error handling** — Each batch is retried once on thrown failure (`_runCliWithRetry`). Every parse call site additionally goes through `_runCliAndParseWithRetry<T>(adapter, prompt, options, parse, hash, phase)`, which also retries once when the parser reports a JSON-extraction or JSON-parse failure (detected by `hasParseFailure(warnings)`, which matches `/json parse error|no json (object )?found/i`). Structural/schema warnings (e.g. "missing X array", unknown op types) are **not** retried — a retry would not meaningfully change them. When both attempts return a parse-failure result, the raw outputs are written to `<kb-knowledge-dir>/_dream_debug/parse-failure-<phase>-<ISO-timestamp>.txt` (best-effort; never throws). `<phase>` is one of `verification`, `synthesis`, `new-topics`, `cold-start`, `discovery`, `reflection`. If the first CLI attempt returns no output at all, the wrapper returns `null` — callers preserve their existing empty-output skip behavior (entries stay `needs_synthesis = 1`). Failed batches are skipped; their entries keep `needs_synthesis = 1` for the next run. Dream timeout: 1 200 000 ms (20 minutes per CLI call).
- **Pre-flight check** — At run start, `checkOllamaHealth(cfg)` is called. If Ollama is unreachable, a warning is logged and retrieval routing is skipped (falls through to cold start).
- **God-node detection** — After each dream run, `detectGodNodes()` identifies topics with entry count or connection count > 3× the average (minimum 10). Flagged topic IDs are stored in `synthesis_meta.god_nodes` and surfaced in the Synthesis tab UI with a star badge.
- **Stale cascade** — When entries are deleted (re-digestion, raw purge), `markCoTopicEntriesStale(deletedEntryIds)` marks all entries sharing a topic with the deleted ones as `needs_synthesis = 1`, ensuring the next dream run updates affected topics.
- **Materialized views** — After each dream run, `regenerateSynthesisMarkdown()` (`src/services/knowledgeBase/dreamMarkdown.ts`) wipes and recreates `knowledge/synthesis/` with `index.md` (topic table), `topics/<id>.md` (per-topic prose + related + entries), and `connections.md` (full connection graph). The `reflections/` subdirectory is **preserved** during the wipe — reflection markdown is generated separately by `regenerateReflectionMarkdown()`, which writes individual files at `synthesis/reflections/<id>.md`.
- **Connection Discovery (Phase C):** A 4th phase that runs after synthesis and topic embedding, before god-node detection. `_runConnectionDiscovery()` sweeps for missing connections using three strategies:
  1. **Embedding-based sweep** — For each topic, `findSimilarTopics(topicId, 10)` returns similar topics; pairs that already have a connection are filtered out.
  2. **Entry-driven propagation** — `db.listTopicPairsBySharedEntries()` finds topic pairs sharing assigned entries but no existing connection. SQL joins `synthesis_topic_entries` on `entry_id`, groups by topic pair, excludes already-connected pairs (both directions).
  3. **Transitive discovery (2-hop)** — `db.listTransitiveCandidates()` finds pairs (A, C) where A→B and B→C exist but A↔C doesn't. Uses a CTE that unions both directions of connections, joins 2 hops, and returns the intermediate topic + both relationship labels. Constrained to `topicA < topicC` to avoid duplicate pairs.
  - **Deduplication:** Candidates from all three strategies are merged into a `Map<normalizedKey, DiscoveryCandidate>` keyed by sorted topic ID pair. Each candidate accumulates: `embeddingSimilarity`, `sharedEntryCount`, `transitiveSignal` (boolean), `transitivePath` (string description).
  - **Ranking:** Candidates are scored: `embeddingSimilarity * 0.5 + (sharedEntryCount / maxEntryCount) * 0.3 + (transitiveSignal ? 0.2 : 0)`. Top 50 candidates are selected (`DISCOVERY_CANDIDATE_CAP = 50`).
  - **LLM verification:** Candidates are batched at 5 (`DISCOVERY_BATCH_SIZE = 5`). Each batch sends a `buildConnectionDiscoveryPrompt()` with rich context per candidate pair: both topic titles + summaries + full content, existing connections for both topics, assigned entry titles + summaries, shared entries, and the discovery signal description. The LLM returns `{ results: [{ topic_a, topic_b, accept, source_topic, target_topic, relationship, confidence, evidence }] }` — the LLM decides directionality. `parseDiscoveryOutput()` extracts accepted connections. Accepted connections are persisted via `db.upsertConnection()`.
  - **Post-discovery:** Markdown is regenerated a second time (connections may have been added). God-node detection runs after discovery.
  - **Constants:** `DISCOVERY_CANDIDATE_CAP = 50`, `DISCOVERY_BATCH_SIZE = 5`, `DISCOVERY_EMBEDDING_TOP_K = 10`.
- **Reflection (Phase E):** A 5th phase that runs after discovery as the final stage before god-node detection. `_runReflection()` generates cross-cluster insights by examining groups of connected topics.
  - **Deterministic checks** — Before LLM calls, three cleanup passes run: (0) **Orphan topic cleanup** — `_deleteOrphanTopics()` removes topics with zero entry assignments (may have been orphaned by cascade-deletes since the last run). (1) **Stale topic detection** — identifies topics whose prose (`content`) is older than the newest assigned entry's `digested_at`, marking them for re-synthesis in a future run. (2) **Delete stale reflections** — any existing reflection whose cited entries have been changed, deleted, or lost via cascade since the reflection was created is removed via `db.deleteReflections(staleIds)` (using `db.listStaleReflectionIds()`, which checks three conditions: orphaned entries via LEFT JOIN, re-digested entries via timestamp comparison, and lost citations via `COUNT(c.entry_id) < r.original_citation_count`).
  - **Cluster identification** — `identifyTopicClusters()` uses BFS on the `synthesis_connections` graph to find connected components containing 2+ topics. Each cluster is a set of topic IDs that are transitively connected. Capped at 20 clusters per run (`REFLECTION_CLUSTER_CAP = 20`) to bound LLM cost.
  - **LLM reflection** — For each cluster, `buildReflectionPrompt()` assembles a prompt containing the cluster's topic summaries, inter-topic connections, and summaries of assigned entries. The CLI returns reflections with inline `[Entry: title](entry-id)` citations. Each reflection has a `type` field: `pattern` (recurring theme), `contradiction` (conflicting information), `gap` (missing coverage), `trend` (directional change), or `insight` (general observation). `parseReflectionOutput()` extracts the structured reflections and their citations from the CLI response.
  - **Storage** — Existing reflections are wiped before regenerating (`db.wipeReflections()`). New reflections are stored in the `synthesis_reflections` table (with `original_citation_count` set to the number of cited entries at insertion time) and their citations in `synthesis_reflection_citations`. Markdown files are written at `synthesis/reflections/<id>.md` via `regenerateReflectionMarkdown()`.
  - **Progress** — Emitted via `_emitDreamProgress('reflection', done, total, hash)` so the frontend dream banner and Synthesis tab can track reflection progress.
  - **Exported functions** — `dream.ts` exports three reflection helpers for testability: `parseReflectionOutput()` (extracts structured reflections + citations from CLI output), `identifyTopicClusters()` (BFS connected-component finder), and `buildReflectionPrompt()` (assembles per-cluster LLM prompt).
  - **KbDatabase methods** — `insertReflection()` writes a reflection + its citations in a single transaction, storing `citedEntryIds.length` as `original_citation_count`. `listReflections()` returns all reflections with citation counts and stale flags. `getReflection(id)` returns a single reflection with its `citedEntryIds` array. `wipeReflections()` drops all rows from `synthesis_reflections` and `synthesis_reflection_citations`. `listStaleReflectionIds()` returns reflection IDs where: cited entries were deleted (LEFT JOIN NULL), re-digested after the reflection's `created_at`, or lost via cascade (`COUNT < original_citation_count`). `_countStaleReflections()` returns the stale count for the synthesis snapshot. `deleteReflections(ids)` removes specific reflections by ID. `_deleteOrphanTopics()` removes topics with zero entry assignments (called inside `deleteRaw()` and at dream pipeline start).
- **WS events** — `_emitSynthesisChange(hash)` emits `kb_state_update { changed: { synthesis: true } }` on run start/end. `_emitDreamProgress(phase, done, total, hash)` emits progress frames with `dreamProgress: { phase: 'routing' | 'verification' | 'synthesis' | 'discovery' | 'reflection', done, total }` for the frontend dream banner and Synthesis tab. An initial `done: 0` frame is emitted immediately before the first CLI call so the frontend exits the "Starting…" state within seconds. `requestStop(hash)` emits a frame with `changed: { synthesis: true, stopping: true }` immediately so the UI can render the "Stopping…" state before the in-flight batch finishes.
- **Cooperative stop** — `requestStop(hash)`, `isStopRequested(hash)` public methods. Backed by a private `stopRequested: Set<string>` alongside `running`. `_checkStop(hash, result)` is called between top-level phases in `_run` (after synthesis, after topic embedding, after discovery, before reflection) and between batches in every phase loop: retrieval synthesis batch groups, unmatched new-topic batches, cold-start batches, discovery batches, and reflection clusters. When a stop is honored it sets `result.stopped = true`, writes `synthesis_meta.status = 'idle'` and `synthesis_meta.stopped_at = <now>`, and returns early — the `finally` block then clears `running` and `stopRequested`, revokes the MCP session, and emits the final `synthesis: true` frame. **`last_run_at` is deliberately not updated on a stop** (it's not a natural completion). Already-committed per-batch work (`applyOperations` + `clearNeedsSynthesis`) persists, so the next `dream()` call is incremental and picks up any entries still flagged `needs_synthesis = 1`. `DreamResult.stopped: boolean` lets callers distinguish stop from normal completion or error. Stop latency is bounded by `DREAM_TIMEOUT_MS` (20 min) in the worst case — the current CLI call runs to completion before the next boundary check. Not a pause/resume: next Dream/Re-Dream click is the resume mechanism.
- **Stale status recovery** — On DB construction, any `synthesis_meta.status = 'running'` is reset to `'idle'`. This prevents the UI from showing a stale "Dreaming in progress" state after a server restart that killed a mid-dream process.

**KB Search MCP server** (`src/services/kbSearchMcp/index.ts`, `src/services/kbSearchMcp/stub.cjs`): Exposes knowledge base search and ingestion tools to CLIs during both dreaming and conversation sessions via the MCP stdio protocol. Follows the same two-process pattern as the Memory MCP server.

- **Stub** (`stub.cjs`) — Dependency-free CommonJS process spawned by CLIs as an MCP server. Env vars: `KB_SEARCH_TOKEN`, `KB_SEARCH_ENDPOINT`. Server name: `agent-cockpit-kb-search`. Implements minimal MCP protocol (`initialize`, `tools/list`, `tools/call`). Forwards tool calls as `POST { tool, arguments }` to the HTTP endpoint with `X-KB-Search-Token` header.
- **6 tools:**
  - `search_topics({ query, limit? })` — Hybrid search (semantic + keyword) over all topics. Handler: embed query → `store.hybridSearchTopics()`. Falls back to `store.keywordSearchTopics()` silently when Ollama is unavailable. Returns `{ topics: [{ topic_id, title, summary, score }] }`.
  - `get_topic({ topic_id })` — Full topic content + connections + entries. Handler: `db.getTopic()` + `db.listConnectionsForTopic()` + `db.listTopicEntryIds()`. Returns `{ topic_id, title, summary, content, connections[], entries[] }`.
  - `find_similar_topics({ topic_id, limit? })` — Embedding-based similarity. Handler: `store.findSimilarTopics()`. Returns empty results silently when embeddings are unavailable (pure embedding-based, no keyword fallback). Returns `{ topics: [{ topic_id, title, summary, score }] }`.
  - `find_unconnected_similar({ topic_id, limit? })` — Similar topics that have NO existing connection to the given topic. Handler: `store.findSimilarTopics()` filtered against `db.listConnectionsForTopic()`. Over-fetches by `limit + 20` from the vector store to compensate for filtered-out connected topics. Returns empty results silently when embeddings are unavailable. Returns `{ topics: [{ topic_id, title, summary, score }] }`.
  - `search_entries({ query, limit? })` — Hybrid search over entries. Handler: embed query → `store.hybridSearchEntries()`. Falls back to `store.keywordSearchEntries()` silently when Ollama is unavailable. Returns `{ entries: [{ entry_id, title, summary, score }] }`.
  - `kb_ingest({ file_path })` — Ingest a local file into the workspace knowledge base. Handler: reads the file from disk, copies it to `knowledge/raw/` under a `conversation-documents` folder, and calls `kbIngestion.enqueueUpload()`. Respects the workspace's `kbAutoDigest` toggle (auto-digest triggers if enabled). Returns `{ ok, raw_id, filename, deduped }` on success, `{ error }` on failure. Requires `KbIngestionService` to be passed to the MCP factory.
- **Session registry** — `Map<token, { workspaceHash }>` keyed by bearer token, with a reverse `Map<sessionKey, token>` for revocation. `issueKbSearchSession(sessionKey, hash)` mints a token and returns `{ token, mcpServers: McpServerConfig[] }`. `revokeKbSearchSession(sessionKey)` removes the token. Reuses existing tokens for the same session key. For dreaming, `sessionKey` = workspace hash. For conversations, `sessionKey` = `convId` — tokens are issued alongside Memory MCP on message send, and revoked on session reset or conversation delete.
- **Ollama fallback** — When `embedText()` throws (Ollama down, model not found, etc.), `search_topics` and `search_entries` silently degrade to keyword-only search via `keywordSearchTopics`/`keywordSearchEntries`. `find_similar_topics` and `find_unconnected_similar` return empty results since they are purely embedding-based. Fallbacks are logged at `console.warn` level.
- **Router** — `POST /kb-search/call` (mounted at `/mcp/kb-search/call` via `router.use('/mcp', ...)`). Auth via `x-kb-search-token` header. Dispatches by `tool` field to handler functions. 401 for invalid/missing token, 400 for unknown tool, 500 for handler errors.

**Embedding infrastructure** (`src/services/knowledgeBase/embeddings.ts`, `src/services/knowledgeBase/vectorStore.ts`): Phase A of the three-layer retrieval architecture (#126). Provides per-workspace vector + full-text search over entries and topics using PGLite (embedded WASM PostgreSQL) with pgvector and Ollama for embeddings.

- **Embedding service** (`embeddings.ts`) — Stateless Ollama client wrapping the `/api/embed` endpoint. `embedText(text, cfg?)` embeds a single string; `embedBatch(texts, cfg?)` embeds multiple in one HTTP call (Ollama accepts `input: string[]`). `checkOllamaHealth(cfg?)` performs a quick connectivity + model probe. `resolveConfig(cfg?)` applies defaults: model `nomic-embed-text`, host `http://localhost:11434`, dimensions `768`.
- **PGLite vector store** (`vectorStore.ts`) — `KbVectorStore` class, one instance per workspace cached on `ChatService._kbVectorStores`. Database directory: `knowledge/vectors/` (PGLite uses a directory, not a single file). Schema:
  - **`store_meta`** — `(key, value)` key/value table tracking `model` and `dimensions` for mismatch detection.
  - **`entry_embeddings`** — `(entry_id PK, title, summary, embedding vector(N), tsv tsvector GENERATED)`. tsvector is weighted: title=A, summary=B. HNSW index on `embedding vector_cosine_ops`. GIN index on `tsv`.
  - **`topic_embeddings`** — Same schema shape as entries, keyed on `topic_id`.
- **Search operations:**
  - `vectorSearchEntries/Topics(queryEmbedding, topK)` — cosine-distance nearest neighbours via `<=>` operator.
  - `keywordSearchEntries/Topics(query, topK)` — `plainto_tsquery` + `ts_rank` BM25-style full-text search.
  - `hybridSearchEntries/Topics(query, queryEmbedding, topK)` — reciprocal rank fusion (RRF, k=60) of vector + keyword results. Fetches 2×topK from each, merges by RRF score.
  - `hybridSearch(query, queryEmbedding, topK)` — searches both entries and topics, interleaved by score.
  - `findSimilarTopics(topicId, topK)` — topic-to-topic similarity by embedding distance.
- **Lifecycle hooks:**
  - **After digestion** — `_embedEntries()` in `KbDigestionService` embeds each new entry's `title — summary` text via `embedBatch()` and upserts into the vector store. Best-effort: failures are logged but don't fail the digestion.
  - **During dreaming (per-batch)** — `_embedBatchTopics()` embeds only the topics affected by each synthesis batch's operations, making them immediately searchable by subsequent batches.
  - **After dreaming (final sweep)** — `_embedTopics()` in `KbDreamService` re-embeds all topics (topics may be created/updated/merged/split), removes stale topic embeddings for deleted topics. Best-effort.
  - **Dreaming routing** — `_runWithRetrieval()` embeds pending entries and uses `hybridSearchTopics()` to classify matches by score threshold (strong/borderline/none) for retrieval-based topic routing.
- **Dimension change handling** — `KbVectorStore._initSchema()` reads the stored `dimensions` from `store_meta` on construction. If it differs from the requested dimensions, both `entry_embeddings` and `topic_embeddings` tables are dropped and recreated with the new vector size. `ChatService.setWorkspaceKbEmbeddingConfig()` detects model/dimension changes and closes + evicts the cached vector store so the next access rebuilds with the new schema.
- **Per-workspace config** — `WorkspaceIndex.kbEmbedding` stores `{ model?, ollamaHost?, dimensions? }`. Defaults: `nomic-embed-text`, `http://localhost:11434`, `768`. Config is read by the digest and dream services via `chatService.getWorkspaceKbEmbeddingConfig(hash)`. When no config is set, embedding is skipped (entries/topics are still created in SQLite, just not embedded).

**Format handlers (`src/services/knowledgeBase/handlers/`):**
- **`pdf.ts`** — Rasterizes each PDF page to a 150 DPI PNG using `unpdf`'s `renderPageAsImage` backed by a statically-imported `@napi-rs/canvas`. Files land under `converted/<rawId>/pages/page-NNNN.png` (zero-padded, 1-indexed). `text.md` is a **thin markdown index** — `# <filename>` plus one `## Page N\n\n![Page N](pages/page-NNNN.png)` section per page — deliberately stripped of any extracted text, because the previous pdfjs text path mangled tables and multi-column layouts in the same way mammoth mangled DOCX. The Digestion CLI (multimodal) is expected to follow the image links and reason about layout + tables visually. Per-page render failures are isolated (a single bad page doesn't kill the whole doc) and surfaced as a `_[Failed to rasterize this page.]_` placeholder in the index plus a `failedPages` metadata key. Metadata: `pageCount`, `renderedPageCount`, `rasterDpi` (always 150). Handler tag: `pdf/rasterized`. Media files are the list of rendered page images.
- **`docx.ts`** — Shells out to `pandoc` via the shared `runPandoc` helper (`--from=docx --to=gfm --extract-media=<outDir>/media --wrap=none <tempDocx>`). Pandoc is the only tool in the stack that preserves semantic tables from OOXML; the previous `mammoth`-based path collapsed tables into flat prose and broke downstream digestion quality. Handler buffers the upload to a temp `.docx`, runs pandoc, flattens pandoc's nested `media/media/` output into a single `media/` dir (rewriting markdown references with collision-safe basenames), and prepends `# <filename>`. Returns `handler: 'docx/pandoc'`. **Pandoc is required** — the route layer rejects `.docx` uploads pre-flight when `detectPandoc()` reports missing. Legacy `.doc` (OLE binary format) is unsupported end-to-end: the route returns a `400` with the message `Legacy .doc format is not supported. Please resave the document as .docx…`.
- **`pptx.ts`** — Uses `adm-zip` + `fast-xml-parser` (`removeNSPrefix: true`) to walk `ppt/slides/slide*.xml`, `ppt/notesSlides/notesSlide*.xml`, and `ppt/media/`. Writes `## Slide N` blocks with extracted text and optional `### Speaker Notes`. **Hidden slides** (those with `show="0"` on the `<p:sld>` root element) are filtered out during text extraction and the survivors are renumbered 1..N — this is required because LibreOffice's PDF export *also* skips hidden slides when rasterizing, so keeping them in the markdown with their original numbers would drift "Slide N" out of sync with `slides/slide-NNN.png` and attach notes/body to the wrong image. The metadata carries `slideCount` (visible), `totalSlideCount` (visible + hidden), and `hiddenSlideCount`, and a short `> **Note:** X of Y slides in this deck are marked hidden…` line is injected near the top of `text.md` whenever `hiddenSlideCount > 0` so downstream digestion sees the skip. When `convertSlidesToImages` is requested at ingestion time, the handler checks the cached `LibreOfficeStatus`; if unavailable, it records `slideImagesWarning` in metadata and injects a "Slide rasterization note" into `text.md` explaining LibreOffice is missing. When available, it shells out to `soffice --headless --convert-to pdf --outdir <tmp>` and then uses `unpdf`'s `renderPageAsImage` backed by a statically-imported `@napi-rs/canvas` (with a pre-built `CanvasFactory` passed to `getDocumentProxy` so pdfjs's internal auxiliary canvases also go through the native backend) to rasterize each slide into `slides/slide-NNN.png`. Canvas is a regular dependency (not an optional peer) since the same backend powers the new PDF rasterization path — no dynamic-import probe, no "install the optional peer dep" warning branch.
- **`passthrough.ts`** — Handles text types (`txt, md, json, yaml, csv, tsv, log, xml, html, rst, markdown, htm, yml`) and image types (`png, jpg, jpeg, gif, webp, svg, bmp`). Markdown is inlined verbatim under the filename header; other text gets wrapped in a code fence tagged with the file extension. Full content is preserved regardless of file size — no truncation. Images are copied into `media/` and the text is a single `![filename](media/filename)` reference. Exports `passthroughSupports(filename)` for the dispatcher.

**Multer configuration:** The `POST /kb/raw` route uses `multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024, files: 1 } }).single('file')`. The 200 MB cap is generous enough for real-world PPTX decks and media-heavy PDFs; the separate conversation-attachment endpoint keeps its smaller limit. Memory storage is required because the orchestrator needs to hash the buffer before touching disk (so dedup works and we never write a file the user already has). Multer errors (file-too-large, etc.) are wrapped in a JSON-returning middleware shim so the KB Browser surfaces a useful message instead of an HTML 500 — `LIMIT_FILE_SIZE` becomes `400 { error: "File exceeds the 200 MB upload limit." }`.

### Migration

On first startup after upgrade, `initialize()` detects legacy `conversations/` directory:
1. Reads all conversation JSON files, groups by workspace
2. Writes workspace index + session files to `workspaces/{hash}/`
3. Renames old dirs to `*_backup/`

## 4.2 Backend Adapter System

The CLI backend layer uses a **pluggable adapter pattern**. New CLI tools can be added without modifying routes, chat service, or frontend.

### BaseBackendAdapter (`src/services/backends/base.ts`)

Abstract base class. Every backend must implement:
- **`get metadata`** — returns `{ id, label, icon, capabilities, models? }` where capabilities: `{ thinking, planMode, agents, toolActivity, userQuestions, stdinInput }` (all booleans). `models` is an optional array of `{ id, label, family, description?, costTier?, default?, supportedEffortLevels? }` for backends that support model selection. `supportedEffortLevels` is an optional `('low' | 'medium' | 'high' | 'xhigh' | 'max')[]`; omit it when the model does not support adaptive reasoning effort. The `xhigh` level is currently Opus 4.7 only; `max` is Opus 4.6+ only.
- **`sendMessage(message, options)`** — returns `{ stream, abort, sendInput }` where `stream` is an async generator yielding events matching the stream event contract in Section 3. `options` includes `{ sessionId, conversationId, isNewSession, workingDir, systemPrompt, externalSessionId, model?, effort? }`. `conversationId` is the stable conversation ID (does not change on session reset) — used by backends like Kiro that key long-lived processes by conversation. `model` is the full model ID to use for this invocation (e.g. `claude-opus-4-7`); backends that don't support model selection ignore it. `effort` is the adaptive reasoning level for this turn; backends ignore it when the selected model doesn't declare the requested level in `supportedEffortLevels`.
- **`generateSummary(messages, fallback)`** — returns a one-line summary string
- **`generateTitle(userMessage, fallback)`** — returns a short conversation title. Base class provides a default that truncates the user message to 80 chars. `chatService.generateAndUpdateTitle()` applies an additional 8-word hard-cut on the adapter's return value before persisting, so adapters don't need to enforce a word count themselves.
- **`shutdown()`** — called during server shutdown. Override to kill long-lived processes. No-op by default.
- **`onSessionReset(conversationId)`** — called when user resets a session. Override to clean up per-conversation state. No-op by default.
- **`extractMemory(workspacePath)`** — returns a `MemorySnapshot` for the backend's native memory system, or `null` if unsupported / no memory exists. Called by `ChatService.captureWorkspaceMemory` on session reset. Base class returns `null`.
- **`getMemoryDir(workspacePath)`** — resolves the absolute path to the backend's native memory directory for a workspace, without reading contents. Returns `null` when the backend has no memory system or no memory directory exists yet. Used by the real-time `MemoryWatcher` to know which directory to watch. Subclasses that implement `extractMemory` should also implement this. Base class returns `null`.
- **`runOneShot(prompt, options?)`** — executes a one-shot LLM call without streaming. Used by the Memory MCP handler, post-session extraction, and the Digestion CLI. Options: `{ model?, effort?, timeoutMs?, allowTools?, cwd? }`. Returns the trimmed stdout. Default base class throws `Error('runOneShot not implemented')`.

### Shared Tool Utilities (`src/services/backends/toolUtils.ts`)

Shared helpers used by all backend adapters. Extracted for cross-adapter reuse — adapters import from here, never from each other.

- `sanitizeSystemPrompt(prompt)` — strips control characters, truncates to 50K max
- `isApiError(text)` — detects `API Error: NNN` patterns
- `shortenPath(filePath)` — truncates long paths to `.../{last}/{two}`
- `extractToolOutcome(toolName, content)` — classifies tool results as success/error/warning
- `extractToolDetails(block)` — converts Claude Code tool_use blocks into ToolDetail objects
- `extractUsage(event)` — normalizes usage/cost data into UsageEvent

### BackendRegistry (`src/services/backends/registry.ts`)

- `register(adapter)` — stores by `metadata.id`. First registered becomes default. Validates `instanceof BaseBackendAdapter`.
- `get(id)` — returns adapter or `null`
- `list()` — returns metadata array
- `getDefault()` — returns first registered or `null`
- `shutdownAll()` — calls `shutdown()` on all registered adapters (used in graceful server shutdown)

### ClaudeCodeAdapter (`src/services/backends/claudeCode.ts`)

**Metadata:** `id: 'claude-code'`, all capabilities enabled. Exposes `models` array with full model IDs (no aliases — IDs pin a specific version so the dropdown is stable across CLI updates):

| `id` | `label` | `family` | `costTier` | `default` |
|---|---|---|---|---|
| `claude-opus-4-7` | Opus 4.7 | opus | high | — |
| `claude-opus-4-6` | Opus 4.6 | opus | high | — |
| `claude-sonnet-4-6` | Sonnet 4.6 | sonnet | medium | ✓ |
| `claude-haiku-4-5` | Haiku 4.5 | haiku | low | — |

Adaptive reasoning effort support (`supportedEffortLevels`):
- `claude-opus-4-7`: `['low', 'medium', 'high', 'xhigh', 'max']` — the `xhigh` level is Opus 4.7-only
- `claude-opus-4-6`: `['low', 'medium', 'high', 'max']` — the `max` level is Opus-only
- `claude-sonnet-4-6`: `['low', 'medium', 'high']`
- `claude-haiku-4-5`: field omitted (no effort support)

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
  [--model <id>]                     # if model specified (e.g. claude-opus-4-7, claude-sonnet-4-6)
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

**`generateSummary(messages, fallback)`** — spawns `claude --print -p <prompt>` with 30s timeout. Falls back gracefully. Closes stdin immediately via `child.stdin?.end()`.

**`generateTitle(userMessage, fallback)`** — spawns `claude --print -p <prompt>` with 30s timeout to generate a short title (prompt asks for max 8 words) from the user's first message. Falls back to truncated user message. Closes stdin immediately via `child.stdin?.end()`. The returned title is further bounded to 8 words by `chatService.generateAndUpdateTitle()`.

**`runOneShot(prompt, options?)`** — spawns `claude --print` with the given prompt and options. Builds args: `['--print', '-p', prompt, '--model', model]`, plus `--allowedTools '*'` and `--cwd` when `allowTools`/`cwd` are set. Uses `execFile` with `{ timeout: timeoutMs, maxBuffer: 4MB }`. Closes stdin immediately via `child.stdin?.end()` to prevent the CLI's "no stdin data received" warning. Error handling filters the stdin warning from stderr and classifies errors: killed processes report timeout, non-empty stderr is preferred over generic exit codes. Default timeout: 15 minutes for digestion calls.

**Text / thinking event emission:** The adapter parses the CLI's `stream-json` output and yields `{ type: 'text', content }` / `{ type: 'thinking', content }` events for each `text` / `thinking` content block inside an `assistant` event. These whole-block events are emitted **without** a `streaming: true` flag. Delta-level events (`content_block_delta`) are only produced when the CLI is invoked with `--include-partial-messages`, which this adapter does not pass, so in practice the delta branch is dead code and every live text segment arrives as a whole block. The chat router (`processStream` in `src/routes/chat.ts`) treats both shapes identically: every text/thinking event is forwarded to the client and accumulated into the in-flight assistant message, and the accumulator is persisted at `turn_boundary` or `done` whenever it is non-empty — the `streaming` flag is not consulted. This matters because turns frequently interleave pre-tool-call text → tool use → post-tool-call text, and gating the save on delta-style streaming would silently drop the pre-tool-call text (the original intermediate-save bug).

### KiroAdapter (`src/services/backends/kiro.ts`)

**Metadata:** `id: 'kiro'`, capabilities: `thinking: true, planMode: false, agents: true, toolActivity: true, userQuestions: false, stdinInput: false`. Exposes a hardcoded `models` array so the selector renders immediately on page load (Kiro's ACP `session/new` response also carries a model list, but that's only available after the first message — reading it lazily caused the dropdown to appear empty and then pop in "after the fact"). The hardcoded list mirrors [kiro.dev/docs/cli/models](https://kiro.dev/docs/cli/models/):

| ID | Family | Cost Tier | Default |
|---|---|---|---|
| `auto` | router | medium | ✓ |
| `claude-opus-4.7` | opus | high | — |
| `claude-opus-4.6` | opus | high | — |
| `claude-opus-4.5` | opus | high | — |
| `claude-sonnet-4.6` | sonnet | medium | — |
| `claude-sonnet-4.5` | sonnet | medium | — |
| `claude-sonnet-4.0` | sonnet | medium | — |
| `claude-haiku-4.5` | haiku | low | — |
| `deepseek-3.2` | other | low | — |
| `minimax-m2.5` | other | low | — |
| `minimax-m2.1` | other | low | — |
| `glm-5` | other | low | — |
| `qwen3-coder-next` | other | low | — |

No `supportedEffortLevels` — Kiro does not expose effort tuning. When Kiro adds or removes models upstream, update this list manually.

**Integration protocol:** ACP (Agent Client Protocol) — JSON-RPC 2.0 over stdin/stdout via `kiro-cli acp`.

**Model selection:** After session setup (`session/new` or `session/load`), calls `session/set_model({ sessionId, modelId })` if `options.model` is set. Non-fatal — continues with default model on failure. Model can be changed mid-session without process restart (unlike Claude Code).

**ACP process lifecycle:** Lazy spawn + idle timeout + transparent recovery.
- First message → spawn `kiro-cli acp` → `initialize` handshake → `session/new(cwd)` → **yield `external_session` stream event** → `[session/set_model]` → `session/prompt`
- Subsequent messages → reuse process → `[session/set_model]` → `session/prompt`
- Idle timeout (configurable via `KIRO_ACP_IDLE_TIMEOUT_MS` env var, default 1 hour) → kill process
- Next message after timeout → respawn → `initialize` → `session/load(sessionId, cwd)` → **drain replayed notifications** → `session/prompt`

**Stream termination:** Empirically, Kiro holds the `session/prompt` JSON-RPC response until the turn is fully done — after all subagents, tool calls, permission requests, and streaming chunks complete. The response body's `stopReason` (`end_turn` | `cancelled` | `refusal` | `max_tokens`) IS the end-of-turn signal; Kiro does **not** emit a `session/update` with `sessionUpdate: 'turn_end'` on the ACP channel. The adapter calls `AcpClient.stopNotifications()` immediately when the `session/prompt` response resolves (same on `.catch()`), which ends the notification iterator and the stream loop exits with a `done` event. The `turn_end` branch in the notification handler is kept as defensive handling in case Kiro ever starts emitting it.

**`session/load` replay handling:** Per the ACP spec, `session/load` streams the full prior session history as `session/update` notifications before returning. The adapter's `AcpClient.notificationQueue` buffers these alongside any future notifications, and the notification consumer loop doesn't start until after `session/prompt` is sent. To prevent the replayed `agent_message_chunk` frames from being consumed as text for the current turn (which would concatenate every prior assistant response into the new reply), `AcpClient.drainNotifications()` is called immediately after the `session/load` promise resolves. The drain count is logged.

**Session mapping:** Agent Cockpit session IDs map to Kiro ACP session IDs via in-memory `sessionMap`. Immediately after `session/new` returns, the adapter also yields an `external_session` `StreamEvent` carrying the Kiro session ID. `processStream` consumes that event and calls `chatService.setExternalSessionId(convId, id)`, which writes it to the active `SessionEntry.externalSessionId` on disk. On the next turn after a cockpit server restart, `SendMessageOptions.externalSessionId` carries the persisted ID back into the adapter; the rehydrate branch puts it into the fresh in-memory `sessionMap` and uses it for `session/load`. Without this, the in-memory map would be empty on restart and the adapter would reject the next turn with `"No Kiro session ID available for this conversation"`.

**Tool name normalization:** Kiro uses lowercase tool names (`read`, `shell`, `delegate`, etc.). The adapter normalizes to Agent Cockpit display names (Read, Bash, Agent, etc.) via `extractKiroToolDetails()`.

**Thinking tool:** Kiro's `thinking` tool is special-cased — output is emitted as `ThinkingEvent` (displayed in thinking UI) rather than `ToolActivityEvent`.

**Permission handling:** All `session/request_permission` messages are auto-approved with `allow_always`.

**Usage tracking:** Kiro's `_kiro.dev/metadata` notifications are parsed for `credits` (accumulated) and `contextUsagePercentage` (snapshot, overwritten each update). These are persisted on the conversation and session `Usage` objects but **excluded from the daily usage ledger** — Kiro's credit-based billing is not comparable with token-based backends. The frontend header's per-CLI chip surfaces the context percentage for `kiro` (see `chip-renderers.jsx` in spec-frontend). Because `contextUsagePercentage` is a Kiro-only snapshot and `chatService._addToUsage` only overwrites the field when the incoming source includes it, both `updateConversationBackend` and `resetSession` explicitly clear the field on the conversation entry (and `updateConversationBackend` also clears it on the active session) so a stale Kiro value cannot leak into a subsequent Claude Code / generic-backend chip.

**`generateSummary` / `generateTitle` / `runOneShot`:** Uses `kiro-cli chat --no-interactive --trust-all-tools` for one-shot LLM calls with 30s/60s timeout. Falls back gracefully if kiro-cli is not installed or not authenticated. kiro-cli always emits ANSI colour codes plus a fixed "trust all tools" warning header, a `> ` prompt prefix, and a `▸ Credits: X • Time: Ys` footer — it ignores `NO_COLOR` and `TERM=dumb`. Raw output is therefore routed through `parseKiroChatOutput()` which strips the ANSI escape sequences, the header (via the stable URL-fragment marker), the single leading `> ` prefix, and the credits footer, returning only the answer body. This prevents garbage like `[38;5;141m> [0mAsking about a number` from leaking into conversation titles or Memory MCP note parsing.

### Adding a New Backend

1. Create `src/services/backends/myBackend.ts` extending `BaseBackendAdapter`
2. Implement `metadata`, `sendMessage()`, `generateSummary()`, and optionally `generateTitle()`, `shutdown()`, `onSessionReset()`
3. Import shared helpers from `toolUtils.ts` (never import from another adapter)
4. Register in `server.ts` — no other changes needed
5. Use the generic `externalSessionId` field on `SessionEntry`/`SendMessageOptions` if the backend manages its own session IDs

## 4.3 UpdateService

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

## 4.4 ClaudePlanUsageService

**File:** `src/services/claudePlanUsageService.ts`

Fetches and caches the Claude Code account-wide plan usage snapshot (5-hour session %, weekly %, per-model breakdown, extra credits) from Anthropic's undocumented `/api/oauth/usage` endpoint using the OAuth access token that Claude Code writes to the user's machine. Read-only — the service never refreshes the token or writes back to the credentials store. Surfaces in the V2 ContextChip tooltip for Claude Code conversations only.

**Constants:**
- `BASE_API_URL = 'https://api.anthropic.com'`
- `ANTHROPIC_BETA = 'oauth-2025-04-20'` (required `anthropic-beta` header)
- `CREDENTIALS_PATH = ~/.claude/.credentials.json`
- `KEYCHAIN_SERVICE = 'Claude Code-credentials'` (macOS only)
- `REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000` — minimum gap between fetch **attempts** (not successes) so transient failures back off cleanly instead of hammering
- `STALE_AFTER_MS = 15 * 60 * 1000` — client-visible stale threshold (slightly above the refresh floor)
- `EXPIRY_BUFFER_MS = 5 * 60 * 1000` — token is treated as expired when `Date.now() + buffer >= expiresAt`

**Constructor:** `new ClaudePlanUsageService(appRoot: string)` — stores the cache at `<appRoot>/data/claude-plan-usage.json`.

**Methods:**
- `init()` — loads the persisted snapshot off disk on server startup. Silently ignores `ENOENT`; logs any other read/parse failure and keeps the in-memory snapshot as its initial empty shape.
- `getCached()` — returns `{ fetchedAt, planTier, subscriptionType, rateLimits, lastError, stale }`. Does not trigger a refresh. `stale` is computed as `now - fetchedAt > STALE_AFTER_MS` (or `true` when `fetchedAt` is null). This is the exact shape returned by `GET /api/chat/plan-usage`.
- `maybeRefresh(reason: string)` — triggers a refresh if all of: no in-flight refresh, and at least `REFRESH_MIN_INTERVAL_MS` have passed since the last attempt. Returns the shared in-flight promise when a fetch is already running, or an immediately-resolved promise when the throttle is active. The `reason` string is logged alongside success/failure (`server-start`, `turn-done`).
- `_refresh(reason)` (private) — reads credentials, short-circuits with `lastError: 'token-expired'` if the token is within the 5-minute buffer, otherwise calls `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20` and a 10-second abort signal. On success stores `{ fetchedAt: now, planTier: creds.rateLimitTier, subscriptionType: creds.subscriptionType, rateLimits: <body>, lastError: null }`. On non-2xx or network failure preserves the prior `fetchedAt`/`planTier`/`subscriptionType`/`rateLimits` values and only overwrites `lastError` with the failure message — the UI can still render the last-known snapshot.
- `_persist()` (private) — `mkdir -p data/` then writes the snapshot to `data/claude-plan-usage.json`. Failures are logged and swallowed.

**Credential resolution (`readStoredCredentials`):** The OAuth tokens Claude Code writes have two storage backends, tried in order:
1. `~/.claude/.credentials.json` — JSON file, preferred when present (works on Linux and any Mac where Claude Code fell back from the Keychain).
2. macOS Keychain (service name `Claude Code-credentials`) — fallback, read via `/usr/bin/security find-generic-password -s "Claude Code-credentials" -w` with a 10-second timeout. Only attempted on `process.platform === 'darwin'`. No Keychain permission prompt: the `security` CLI reuses the same ACL that Claude Code itself installed, so the user sees no OS-level dialog.

Parsed shape (`parseCredsBlob`):
```ts
{ claudeAiOauth: {
    accessToken: string,
    expiresAt?: number,        // epoch ms; null ⇒ treat as non-expiring
    subscriptionType?: string,  // e.g. "max"
    rateLimitTier?: string,     // e.g. "default_claude_max_20x"
} }
```
Missing `accessToken` throws `credentials missing claudeAiOauth.accessToken`, surfaced as `lastError`.

**Integration points:**
- `server.ts` — instantiated with `__dirname`, `init()` on startup then immediate `maybeRefresh('server-start')`. Passed into `createChatRouter` via the `claudePlanUsageService` dependency.
- `src/routes/chat.ts`:
  - `GET /plan-usage` route returns `getCached()` verbatim.
  - `onDone` stream callback calls `maybeRefresh('turn-done')` when `backendId === 'claude-code'`. No other backend triggers a refresh.

**Error taxonomy (`lastError` values):**
- `'token-expired'` — access token at/within the 5-minute expiry buffer.
- `'credentials missing claudeAiOauth.accessToken'` — creds blob parsed but missing field.
- `'no credentials found at <path>'` — file not found on non-darwin and thus nothing to fall back to.
- `'keychain read failed: <msg>'` — `security` CLI returned non-zero.
- `'usage API <status>: <body>'` — upstream HTTP 4xx/5xx (body truncated to 200 chars).
- Any network error message verbatim (timeout, DNS, TLS).

## 4.5 KiroPlanUsageService

**File:** `src/services/kiroPlanUsageService.ts`

Fetches and caches the Kiro (Amazon Q Developer) account-wide plan usage snapshot (subscription tier, monthly credits used / cap, overage status + dollar charges, bonus credits, reset date) by reading the kiro-cli's SQLite auth store read-only and calling `AmazonCodeWhispererService.GetUsageLimits` directly. Read-only — the service never writes to the SQLite DB, never refreshes the token, and never mutates the active CodeWhisperer profile. Surfaces in the V2 ContextChip tooltip for Kiro conversations only.

**Why direct-call instead of an ACP piggyback:** an earlier attempt to fetch this via the ACP `initialize` / `authenticate` stream on a background worker conversation caused cross-conversation message leakage (the ACP client routed frames to whichever conversation happened to be streaming at the time). The direct REST path against the Amazon Q endpoint avoids the ACP transport entirely — the cadence gained from this approach is what makes the server-startup refresh viable without disturbing any live conversation.

**Constants:**
- `Q_API_URL = 'https://q.us-east-1.amazonaws.com/'`
- `Q_TARGET = 'AmazonCodeWhispererService.GetUsageLimits'` (`X-Amz-Target` header)
- `Q_ORIGIN = 'KIRO_CLI'` (query param + body field — identifies this as a kiro-cli caller)
- `REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000` — minimum gap between fetch **attempts** (not successes) so transient failures back off cleanly instead of hammering
- `STALE_AFTER_MS = 15 * 60 * 1000` — client-visible stale threshold (slightly above the refresh floor)
- `EXPIRY_BUFFER_MS = 30 * 1000` — AWS IdC tokens rotate every ~8 min, so the buffer here is much tighter than Claude's 5 min; if <30s remain the service skips and waits for the CLI to refresh on its next real invocation

**Constructor:** `new KiroPlanUsageService(appRoot: string, options?: { dbPath?: string })` — stores the on-disk cache at `<appRoot>/data/kiro-plan-usage.json`; `options.dbPath` is test-only (defaults to the platform-specific kiro-cli data file — see below).

**Methods:**
- `init()` — loads the persisted snapshot off disk on server startup. Silently ignores `ENOENT`; logs any other read/parse failure and keeps the in-memory snapshot as its initial empty shape.
- `getCached()` — returns `{ fetchedAt, usage, lastError, stale }`. Does not trigger a refresh. `stale` is computed as `now - fetchedAt > STALE_AFTER_MS` (or `true` when `fetchedAt` is null). This is the exact shape returned by `GET /api/chat/kiro-plan-usage`.
- `maybeRefresh(reason: string)` — triggers a refresh if all of: no in-flight refresh, and at least `REFRESH_MIN_INTERVAL_MS` have passed since the last attempt. Returns the shared in-flight promise when a fetch is already running, or an immediately-resolved promise when the throttle is active. The `reason` string is logged alongside success/failure (`server-start`, `turn-done`).
- `_refresh(reason)` (private) — opens the kiro-cli SQLite DB read-only via `readKiroAuth(dbPath)`, short-circuits with `lastError: 'token-expired'` if the access token is within the 30-second expiry buffer, otherwise `POST`s `https://q.us-east-1.amazonaws.com/?profileArn=<enc>&origin=KIRO_CLI` with headers `Content-Type: application/x-amz-json-1.0`, `X-Amz-Target: AmazonCodeWhispererService.GetUsageLimits`, `Authorization: Bearer <accessToken>`, `X-Amzn-Codewhisperer-Optout: false`, `Accept: */*` and body `{"profileArn":"<arn>","origin":"KIRO_CLI"}`, with a 10-second abort signal. On success stores `{ fetchedAt: now, usage: normalizeUsage(body), lastError: null }`. On non-2xx or network failure preserves the prior `fetchedAt` / `usage` values and only overwrites `lastError` — the UI still renders the last-known snapshot.
- `_persist()` (private) — `mkdir -p data/` then writes the snapshot to `data/kiro-plan-usage.json`. Failures are logged and swallowed.

**SQLite credential resolution (`readKiroAuth`):** opens the kiro-cli data file with `better-sqlite3` using `{ readonly: true, fileMustExist: true }`, then reads two rows with prepared statements and closes the DB in a `finally`:
- `SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'` — JSON blob with `{ access_token, expires_at }` (`expires_at` is ISO-8601, parsed to epoch ms; treated as non-expiring when absent or unparseable).
- `SELECT value FROM state WHERE key = 'api.codewhisperer.profile'` — JSON blob with `{ arn }` (the active CodeWhisperer profile ARN, threaded into both the query string and the JSON body as required by the Q endpoint).

**Default DB path (`defaultKiroDbPath`):** platform-specific — `~/Library/Application Support/kiro-cli/data.sqlite3` on darwin, `%APPDATA%/kiro-cli/data.sqlite3` on win32 (falls back to `~/AppData/Roaming/…` when `APPDATA` is unset), and `$XDG_DATA_HOME/kiro-cli/data.sqlite3` on Linux (falls back to `~/.local/share/…`).

**Response normalization (`normalizeUsage`):** pulls `subscriptionInfo`, `overageConfiguration.overageStatus`, `nextDateReset`, and `usageBreakdownList[0]` from the raw body, coercing every field through `strOrNull` / `numOrNull` so missing or non-primitive values become `null` rather than crashing the renderer. `bonuses` passes through as an opaque array (`unknown[]`) — the frontend surfaces the count rather than the contents. See [spec-api-endpoints.md § 3.15](spec-api-endpoints.md#315-kiro-plan-usage) for the full `KiroUsageData` shape.

**Integration points:**
- `server.ts` — instantiated with `__dirname`, `init()` on startup then immediate `maybeRefresh('server-start')`. Passed into `createChatRouter` via the `kiroPlanUsageService` dependency.
- `src/routes/chat.ts`:
  - `GET /kiro-plan-usage` route returns `getCached()` verbatim.
  - `onDone` stream callback calls `maybeRefresh('turn-done')` when `backendId === 'kiro'`. No other backend triggers a refresh for this service.

**Error taxonomy (`lastError` values):**
- `'token-expired'` — access token at/within the 30-second expiry buffer.
- `'kiro-cli DB unavailable at <path>: <msg>'` — SQLite open failed (file missing when `fileMustExist: true`, permission error, corruption). Typical when the user has never run kiro-cli auth on this machine.
- `'kiro-cli auth_kv missing access token'` — DB opens but the `kirocli:odic:token` row is absent or has an empty `value`.
- `'kiro-cli state missing profile'` — DB opens but the `api.codewhisperer.profile` row is absent or has an empty `value`.
- `'kiro-cli token blob missing access_token'` — token row present but the parsed JSON has no `access_token` string.
- `'kiro-cli profile blob missing arn'` — profile row present but the parsed JSON has no `arn` string.
- `'GetUsageLimits <status>: <body>'` — upstream HTTP 4xx/5xx (body truncated to 200 chars).
- Any network error message verbatim (timeout, DNS, TLS).
