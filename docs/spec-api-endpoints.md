# 3. API Endpoints

[← Back to index](SPEC.md)

---

All chat endpoints are mounted under `/api/chat`. All require authentication via `requireAuth`. State-changing operations (POST, PUT, DELETE) additionally require `csrfGuard`.

## 3.1 Directory Browsing

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

## 3.2 Conversations

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/conversations?q=<search>&archived=true` | — | List all, sorted by `updatedAt` desc. Each summary includes `workspaceHash` and `workspaceKbEnabled` (mirrors the workspace-level KB toggle so the sidebar can gate the KB button). Pass `archived=true` to list only archived conversations (default: active only). |
| GET | `/conversations/:id` | — | Full conversation object. `404` if not found. When KB is enabled for the conversation's workspace, the response is augmented with a `kb` block: `{ enabled, dreamingNeeded, pendingEntries, dreamingStatus, failedItems }` — used by the frontend dream banner to show synthesis status without a separate round-trip. |
| POST | `/conversations` | Yes | `{ title?, workingDir?, backend? }` → creates conversation with initial session. `backend` defaults to the server's default backend. |
| PUT | `/conversations/:id` | Yes | `{ title }` → rename. `404` if not found. |
| DELETE | `/conversations/:id` | Yes | Aborts active stream, removes from workspace index, deletes session folder + artifacts. Works on both active and archived conversations. |
| PATCH | `/conversations/:id/archive` | Yes | Sets `archived: true` on the conversation. Aborts active stream. Files remain on disk. `404` if not found. |
| PATCH | `/conversations/:id/restore` | Yes | Removes `archived` flag, restoring the conversation to the active list. `404` if not found. |

## 3.3 Message Queue

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/conversations/:id/queue` | — | Returns `{ queue: string[] }`. Empty array if none persisted. |
| PUT | `/conversations/:id/queue` | Yes | `{ queue: string[] }` → replaces the full queue. `400` if body is invalid. `404` if conversation not found. |
| DELETE | `/conversations/:id/queue` | Yes | Clears the queue. `404` if conversation not found. |

The queue is also included in the `GET /conversations/:id` response as `messageQueue` (omitted when empty). Queue is automatically cleared on session reset and archive.

## 3.4 Download

| Method | Path | Description |
|--------|------|-------------|
| GET | `/conversations/:id/download` | Full conversation as `.md` attachment. |
| GET | `/conversations/:id/sessions/:num/download` | Single session as `.md` attachment. |

## 3.5 Sessions

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/conversations/:id/sessions` | — | Session list with `isCurrent` flag and `summary`. |
| GET | `/conversations/:id/sessions/:num/messages` | — | Messages for a specific session. `400`/`404` on error. |
| POST | `/conversations/:id/reset` | Yes | Archives active session (generates LLM summary), creates new session, resets title to "New Chat", clears message queue. `409` if streaming. Clears any stale WebSocket event buffer for the conversation. After archiving, invokes `captureWorkspaceMemory(convId, endingBackend)` so the ending backend's native memory is mirrored to `workspaces/{hash}/memory/`, then runs post-session extraction via `memoryMcp.extractMemoryFromSession` for every backend (including Claude Code) — the Memory CLI scans the just-ended transcript and writes any new memory notes into `memory/files/notes/`. Both steps are best-effort — failures do not block the reset. Also calls `memoryMcp.revokeMemoryMcpSession(convId)` and `kbSearchMcp.revokeKbSearchSession(convId)` to rotate the MCP tokens for the next session. Returns `{ conversation, newSessionNumber, archivedSession }`. |

## 3.6 Backends

```
GET /backends
```
Returns `{ backends: [{ id, label, icon, capabilities, models? }] }` — metadata for every registered adapter. The optional `models` array lists available models: `[{ id, label, family, description?, costTier?, default?, supportedEffortLevels? }]`. `supportedEffortLevels` is an optional array of `'low' | 'medium' | 'high' | 'xhigh' | 'max'` indicating which adaptive reasoning levels the model accepts; the UI uses its presence to decide whether to show the effort dropdown. The `xhigh` level is currently Opus 4.7-only; `max` is Opus 4.6+ only. Backends without model selection (e.g. Kiro) omit the `models` field entirely.

## 3.7 Messaging and Streaming

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
| `text` | `content`, `streaming?` | Text from assistant. The optional `streaming` flag (set by the backend) indicates a CLI delta vs a whole-block segment, but the chat router treats both identically: every `text` event is forwarded to the client and accumulated into the in-flight assistant message. |
| `thinking` | `content`, `streaming?` | Extended thinking from assistant. Handled the same as `text`: the `streaming` flag is informational only — every `thinking` event is forwarded and accumulated regardless of the flag. |
| `tool_activity` | `tool`, `description`, `id`, + enriched fields | Tool use notification (see enriched fields below). Events are accumulated per-turn and persisted as `toolActivity` on the saved assistant message (excluding `isPlanMode` and `isQuestion` meta-events). |
| `tool_outcomes` | `outcomes` | Array of tool result outcomes extracted from CLI `user` events. Each outcome: `{ toolUseId, isError, outcome, status }`. Merged into `toolActivity` accumulator for persistence and forwarded to frontend for live display. |
| `turn_boundary` | — | Marks boundary between assistant turns (internal — not forwarded to client). Triggers persistence of accumulated `toolActivity` on the intermediate message. |
| `turn_complete` | — | Notifies client that tools finished and a new turn is starting |
| `result` | `content` | Final result text from CLI |
| `assistant_message` | `message` | Saved assistant message (intermediate or final) |
| `title_updated` | `title` | Conversation title was auto-updated (sent after first assistant message in a reset session) |
| `usage` | `usage`, `sessionUsage` | Cumulative token/cost totals for conversation (`usage`) and active session (`sessionUsage`), sent after each CLI result event |
| `memory_update` | `capturedAt`, `fileCount`, `changedFiles` | Real-time `MemoryWatcher` re-captured workspace memory during this stream. Lightweight payload (no full snapshot) — frontend injects a synthetic system message (`kind: 'memory_update'`) into the conversation's in-memory messages array, which renders as an inline chat bubble with the Agent Cockpit logo as the avatar. Clicking the bubble refetches the snapshot from `GET /workspaces/:hash/memory` and opens the memory panel. |
| `kb_state_update` | `updatedAt`, `changed` | Workspace Knowledge Base state changed. `changed` has optional `raw`/`entries`/`synthesis` string arrays listing the rawIds / entryIds / synthesis artifact ids that were mutated in this frame. Additional optional fields: `batchProgress: { done, total }` (emitted during "Digest All Pending"), `dreamProgress: { phase: 'routing' | 'verification' | 'synthesis' | 'discovery' | 'reflection', done, total }` (emitted during dreaming runs), `substep: { rawId, text }` (per-raw processing substep text, e.g. "Running CLI analysis…" or "Converting…", used by the frontend to show live progress beneath the status badge). The frame carries no full state — the frontend reacts by refetching `GET /workspaces/:hash/kb`. Fan-out is workspace-scoped: the chat router iterates `activeStreams` and sends the frame to every conversation whose workspace hash matches. See **KB Ingestion** under ChatService / Workspace Knowledge Base for the pipeline. |
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

**Turn boundary behavior:** On `turn_boundary`, the accumulated `fullResponse` (text) is persisted as an intermediate assistant message whenever it is non-empty — regardless of whether any delta events carried `streaming: true`. This is load-bearing: the Claude Code adapter emits text via whole-block `assistant` events without the `streaming` flag (it never passes `--include-partial-messages`), so gating the save on delta-style streaming would silently drop every pre-tool-call segment. Any accumulated `thinking` and per-turn `toolActivity` are persisted on the same intermediate message. A `turn_complete` event is always sent to the client (even when there is no text to save), so the frontend can clear stale tool activity spinners when tools finish executing. On stream completion (`done`), if `fullResponse` is non-empty it is saved as the final assistant message; otherwise the optional `result` event content is used as the fallback body. In both cases `assistant_message` + `done` events are sent.

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

## 3.8 File Upload

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
GET /conversations/:id/files/:filename[?mode=view|download]
```
Path traversal guard. No CSRF (used by `<img>` tags and file badge cards).
- **No mode (default):** Serves file directly via `res.sendFile()` (legacy, used by inline images).
- **`?mode=view`:** Returns `{ content, filename, language }` JSON for the viewer panel. Capped at 2 MB.
- **`?mode=download`:** Streams file with `Content-Disposition: attachment` header for browser download.

## 3.9 Settings

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/settings` | — | Returns settings (defaults if file missing). |
| PUT | `/settings` | Yes | Writes full body to `settings.json`. |

## 3.10 Usage Statistics

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/usage-stats` | — | Returns the usage ledger (`{ days: [...] }`). |
| DELETE | `/usage-stats` | Yes | Clears all usage statistics (resets ledger to empty). |

## 3.11 Workspace Instructions

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
| GET | `/workspaces/:hash/kb` | — | Returns `{ enabled: boolean, state: KbState }` for the workspace. `KbState` carries `{ version, entrySchemaVersion, autoDigest, counters, folders[], raw[], updatedAt }` — `counters` is the aggregate `{ rawTotal, rawByStatus, entryCount, pendingCount, folderCount }` used by the KB Browser header badges, `folders` is the full virtual folder tree (flat, sorted by path), and `raw` is a **single page of the currently-focused folder** (not the whole workspace). Query params `folder` (defaults to root `''`), `limit` (default 500), and `offset` page the raw listing. Always 200 for an existing workspace — an enabled workspace with no files yet returns an empty scaffold (`raw: []`, `folders: [{ folderPath: '', … }]`, zero counters). `404` if the workspace doesn't exist. Disabled workspaces return an in-memory empty scaffold without touching `state.db` so the KB Browser can still render its disabled state. |
| PUT | `/workspaces/:hash/kb/enabled` | Yes | `{ enabled: boolean }`. Toggles the per-workspace Knowledge Base switch (stored on `WorkspaceIndex.kbEnabled`). `400` if not boolean. `404` if workspace not found. Independent of the Memory toggle — enabling KB does not touch `memoryEnabled`. |
| PUT | `/workspaces/:hash/kb/auto-digest` | Yes | `{ autoDigest: boolean }`. Toggles the per-workspace auto-digest flag (stored on `WorkspaceIndex.kbAutoDigest`). When `true`, the ingestion orchestrator chains a digest run onto the queue as soon as conversion completes. When `false`, ingested files sit in `status='ingested'` until the user hits "Digest All Pending". Deleting the last location of a raw always fully purges it regardless of this flag. `400` if not boolean. `404` if workspace not found. |
| GET | `/workspaces/:hash/kb/embedding-config` | — | Returns `{ embeddingConfig: { model?, ollamaHost?, dimensions? } \| null }`. The per-workspace embedding configuration for the PGLite vector search layer. Returns `null` when no config has been set yet (embedding is disabled). |
| PUT | `/workspaces/:hash/kb/embedding-config` | Yes | `{ model?: string, ollamaHost?: string, dimensions?: number }`. Saves the per-workspace embedding configuration. `model` must be a string (Ollama model name), `ollamaHost` a string (URL), `dimensions` a positive integer. `400` on type validation failure. `404` if workspace not found. When model or dimensions change from a previously saved value, the cached vector store is closed and evicted so the next access rebuilds the PGLite schema with the new dimensions (wiping existing embeddings). |
| POST | `/workspaces/:hash/kb/embedding-health` | Yes | Tests Ollama connectivity and model availability using the workspace's embedding config (or defaults). Returns `{ ok: boolean, error?: string }`. `ok: true` means Ollama is reachable and the configured model returns a non-empty embedding. |
| POST | `/workspaces/:hash/kb/raw` | Yes | `multipart/form-data` with a single `file` field (max 200 MB) and an optional `folder` text field (defaults to root `''`). Hashes the buffer to derive `rawId = sha256[:16]`, stages `raw/<rawId>.<ext>`, and inserts the `raw` row + a `raw_locations` row (one per `(rawId, folder, filename)` tuple) inside a transaction before returning. A background conversion job is scheduled on the workspace's FIFO queue; `_scheduleConversion` also chains a digest run when `kbAutoDigest` is true. Returns **202** with `{ entry: KbRawEntry, deduped: boolean, addedLocation: boolean }`. `deduped: true` means the same `sha256` already exists in the workspace — the orchestrator only inserts a new `raw_locations` row for the new `(folder, filename)` tuple and reuses the raw bytes + conversion output (Option B multi-location). `400 { error: "KB disabled" }` if KB is off, `400` if no file field, `409 KbLocationConflictError` if a different file already occupies `(folder, filename)`, `400 KbValidationError` for invalid filenames/folder segments, `400 { error: "File exceeds the 200 MB upload limit." }` for `LIMIT_FILE_SIZE`. **Pre-flight format guards** still apply: `400` for `.doc` and `400` for `.docx` when pandoc is unavailable — both checks run before any DB rows are created. Emits `kb_state_update` frames on every state mutation (stage, conversion complete, digest complete) with `changed: { raw: [rawId], folders: true }`. **Multi-file client behavior:** The frontend supports multi-file and folder selection, building a client-side queue of `{ file, folderPath }` items and draining it with bounded concurrency (3 parallel XHR uploads) against this same single-file endpoint. Browser `File` objects are lightweight handles — holding tens of thousands is cheap. Error handling is per-item: 400/409 are non-retryable, 401 pauses the entire queue, 500/network errors auto-retry up to 2 times with backoff. Deduped responses (`deduped: true, addedLocation: false`) are surfaced as "Already in KB" in the batch progress UI. No backend changes were required. |
| DELETE | `/workspaces/:hash/kb/raw/:rawId` | Yes | Two modes: (1) **Per-location delete** — when the query string carries both `?folder=…&filename=…`, removes only that single `raw_locations` row. If other locations still reference the rawId the raw row stays; if this was the last location the raw is fully purged (bytes + converted + entries + DB row). (2) **Full purge** — when called without query params, cascade-deletes every `raw_locations` row, the `raw` row, the raw bytes, the `converted/<rawId>/` directory, any digested entries (and `entries/<entryId>/` dirs) — bypassing ref-counting. Returns `{ ok: true }` on success, `404 { error: "Location not found." }` for an unknown `(rawId, folder, filename)` tuple, `404 { error: "Raw file not found." }` for an unknown rawId during full purge, `400` if KB is disabled. The `rawId` must match `^[a-f0-9]{1,64}$` or the route returns `400`. Emits a `kb_state_update` frame on success. |
| POST | `/workspaces/:hash/kb/raw/:rawId/digest` | Yes | Manually trigger digestion for a single raw file (the Raw tab's per-row **Digest now** button). **Fire-and-forget:** returns `202 { accepted: true }` immediately and enqueues a digest job on the workspace FIFO queue (shared with ingestion). The background job flips the raw row to `digesting`, runs the Digestion CLI, parses entries, writes them under `entries/<entryId>/entry.md`, inserts rows in the `entries` + `entry_tags` tables, then flips the raw row to `digested` (or `failed` with an `errorClass` of `timeout \| cli_error \| malformed_output \| schema_rejection \| unknown`). Failures are logged server-side via `.catch()` and surfaced to the UI through `kb_state_update` WS frames + 1500ms polling — the frontend does **not** alert on HTTP errors from this route. Non-eligible statuses (`ingesting`, `digesting`, already `digested`, `failed`) resolve without mutating state. `400` when KB is disabled. |
| POST | `/workspaces/:hash/kb/digest-all` | Yes | Batch-digest every eligible raw file in the workspace (`status='ingested'`; any lingering `pending-delete` rows are purged without digestion). **Fire-and-forget:** returns `202 { accepted: true }` immediately and enqueues the batch on the workspace FIFO queue. Emits a `kb_state_update` frame with `changed.batchProgress: { done, total }` after every individual digest settles so the **Digest All Pending** toolbar button can animate live progress. Failures are logged server-side and surfaced per-row via `errorClass`/`errorMessage` in the KB state. `400` when KB is disabled. |
| GET | `/workspaces/:hash/kb/entries` | — | Returns `{ entries: KbEntry[], total: number }` — a paginated, filtered list of digested entries ordered by `title`. `total` is the pre-pagination match count used by the UI to render the pagination bar. Query params: `folder` (filters via `raw_locations` join), `tag` (single-tag filter via `entry_tags` join, legacy), `tags` (comma-separated multi-tag list — **AND semantics**, an entry must carry every tag; merges with `tag` when both are supplied), `rawId` (direct filter), `search` (case-insensitive substring match on entry title; `%` and `_` are escaped so they match literally), `uploadedFrom` / `uploadedTo` (ISO-8601 inclusive bounds on `raw.uploaded_at`, joins the `raw` table), `digestedFrom` / `digestedTo` (ISO-8601 inclusive bounds on `entries.digested_at`), `limit` (default 500), `offset`. All filters combine with AND semantics; empty-string values are treated as "no filter." Each `KbEntry` is the metadata row (`entryId`, `rawId`, `title`, `slug`, `summary`, `schemaVersion`, `staleSchema`, `digestedAt`, `tags[]`) — the full markdown body is served by the per-entry endpoint below. Returns `{ entries: [], total: 0 }` when KB is disabled or the DB hasn't been opened yet (no 404). |
| GET | `/workspaces/:hash/kb/tags` | — | Returns `{ tags: Array<{ tag: string, count: number }> }` — every distinct tag across the workspace's KB entries with its usage count, ordered by `count DESC, tag ASC` so the most common tags surface first. Feeds the Entries-tab tag picker so the UI can render a full list without enumerating every entry. Returns `{ tags: [] }` when KB is disabled. No CSRF — safe read. |
| GET | `/workspaces/:hash/kb/entries/:entryId` | — | Returns `{ entry: KbEntry, body: string, locations: Location[] }` where `body` is the full rendered `entries/<entryId>/entry.md` (YAML frontmatter + markdown) read from disk, and `locations` is the array of source file records from `raw_locations` for the parent raw file, each with shape `{ rawId, folderPath, filename, uploadedAt }`. The UI strips the frontmatter for the preview pane and uses `locations` to render source provenance (folder + filename monospace pills) in the entry popup. `400` for an `entryId` that doesn't match `^[a-zA-Z0-9_.-]+$`, `404` when KB is disabled (`KB not enabled`) or the entry row is missing. On disk read failure `body` falls back to an empty string. No CSRF — safe read. |
| POST | `/workspaces/:hash/kb/folders` | Yes | `{ folderPath: string }`. Creates `folderPath` and any missing ancestors inside the workspace's `folders` table (virtual only — no on-disk directories). Idempotent: creating an existing folder is a no-op but still emits a `folders: true` frame. Returns `{ folderPath: <normalized> }`. `400` for empty/missing `folderPath`, `400 KbValidationError` for invalid segments (`..`, control chars, >128 chars, >4096 total), `400` when KB is disabled. |
| PUT | `/workspaces/:hash/kb/folders` | Yes | `{ fromPath: string, toPath: string }`. Renames a folder subtree: every `raw_locations` row in the subtree is rewritten in a single SQLite transaction (no disk moves since folders are virtual), ancestors of `toPath` are auto-created, and collisions against any existing descendant path cause the whole tx to roll back. Returns `{ ok: true }`. `400` if either field missing, `400 KbValidationError` for invalid segments, `400` for root rename attempts, `400` when KB is disabled. Emits `folders: true`. |
| DELETE | `/workspaces/:hash/kb/folders` | Yes | Delete a folder subtree. `?folder=` is required (query param, not body). `?cascade=true` (or `1`) removes every `raw_locations` row under the subtree following the same ref-counted purge rules as `deleteLocation` (always full purge on last location), then removes the now-empty folder rows deepest-first; without `cascade`, the call errors if the subtree still contains any locations. Returns `{ ok: true }`. `400` for missing `folder`, `400` for root delete attempts, `400 KbValidationError` for unknown folder, `400` when KB is disabled. Emits `folders: true`. |
| GET | `/workspaces/:hash/kb/raw/:rawId` | — | Streams the raw file bytes with `Content-Type` set from the stored `mimeType` (defaults to `application/octet-stream`) and `Content-Disposition: inline; filename="<original>"`. Used by the KB Browser raw list "download" action. `400` if `rawId` fails hex validation, `404` for unknown workspace/rawId. Also path-resolves the computed file path and verifies it stays inside `knowledge/raw/` (traversal guard). No CSRF — safe read. |
| GET | `/kb/libreoffice-status` | — | Returns the cached `LibreOfficeStatus` (`{ available, binaryPath, checkedAt }`). Used by the global Settings → Knowledge Base "Convert PPTX slides to images" checkbox to validate on-click: if `available` is `false`, the frontend auto-unchecks the box and shows a warning underneath. Safe to call on every check because `detectLibreOffice()` is cached at module level after the first invocation (server startup). |
| GET | `/kb/pandoc-status` | — | Returns the cached `PandocStatus` (`{ available, binaryPath, version, checkedAt }`). Unlike LibreOffice, pandoc is **required** (not optional) for DOCX ingestion — the route layer rejects `.docx` uploads with a 400 when this endpoint reports `available: false`. The KB Browser Raw tab and global Settings → Knowledge Base tab both fetch this endpoint to surface a persistent install banner. Cached at module level after `detectPandoc()` runs at server startup. |
| POST | `/mcp/kb-search/call` | No CSRF (bearer) | Internal endpoint called by `stub.cjs` during dreaming. Auth via `X-KB-Search-Token` header (per-dream-run token minted by `kbSearchMcp.issueKbSearchSession`). Body: `{ tool: string, arguments: object }`. Dispatches to one of 5 tool handlers: `search_topics`, `get_topic`, `find_similar_topics`, `find_unconnected_similar`, `search_entries`. Returns tool-specific JSON result. `401` for invalid/missing token. `400` for unknown tool. `500` for handler errors. |
| POST | `/workspaces/:hash/kb/dream` | Yes | Incremental dream run — processes only entries with `needs_synthesis = 1`. **Fire-and-forget:** returns `202 { ok: true, mode: 'incremental' }` immediately. The background job runs the five-phase Routing→Verification→Synthesis→Discovery→Reflection pipeline (or cold start when no topics exist), applies operations transactionally, regenerates `synthesis/` markdown, and emits `kb_state_update` frames with `dreamProgress: { phase: 'routing' | 'verification' | 'synthesis' | 'discovery' | 'reflection', done, total }`. `400` if no entries pending synthesis (`countNeedsSynthesis() === 0`), `400` if KB disabled, `409` if a dream is already running for this workspace. |
| POST | `/workspaces/:hash/kb/redream` | Yes | Full rebuild — wipes all synthesis data (topics, connections, reflections, meta) and reprocesses every entry. Returns `202 { ok: true, mode: 'full-rebuild' }`. Same fire-and-forget pattern as `dream`. `400` if no entries exist (`entryCount === 0`), `400` if KB disabled, `409` if already running. |
| GET | `/workspaces/:hash/kb/synthesis` | — | Returns `{ status, lastRunAt, lastRunError, topicCount, connectionCount, needsSynthesisCount, reflectionCount, staleReflectionCount, godNodes[], dreamProgress, topics[], connections[] }`. `dreamProgress` is `{ phase, done, total } | null` — non-null when a dream is in progress. `reflectionCount` is the total number of reflections; `staleReflectionCount` is the count of reflections with stale citations (a reflection is stale if any cited entry was re-digested, deleted, or lost citations via cascade since the reflection was created). Topics carry `{ topicId, title, summary, entryCount, connectionCount, isGodNode }`. Connections carry `{ sourceTopic, targetTopic, relationship, confidence }`. `404` if KB DB not found. |
| GET | `/workspaces/:hash/kb/synthesis/:topicId` | — | Returns a single topic detail: `{ topicId, title, summary, content, updatedAt, entryCount, connectionCount, isGodNode, entries[], connections[] }`. `entries` is the full entry metadata array. `404` if topic not found or KB DB not found. |
| GET | `/workspaces/:hash/kb/reflections` | — | List all reflections. Returns `{ reflections: [{ reflectionId, title, type, summary, citationCount, createdAt, isStale }] }`. Stale detection: a reflection is stale if any cited entry was re-digested or deleted since the reflection was created. |
| GET | `/workspaces/:hash/kb/reflections/:reflectionId` | — | Single reflection detail. Returns `{ reflectionId, title, type, summary, content, createdAt, citationCount, citedEntries: KbEntry[] }`. `404` if not found. |

| GET | `/workspaces/:hash/files` | — | Serves a file from the workspace's working directory for the file delivery feature. Required query param `path` (absolute file path). Optional `mode`: `view` returns `{ content, filename, language }` JSON (capped at 2 MB), `download` (default) streams the file with `Content-Disposition: attachment`. Path traversal protection: resolved path must be under the workspace root. `400` if path missing or not a file. `403` if path is outside workspace. `404` if file or workspace not found. `413` if file exceeds 2 MB in view mode. |

**System prompt composition on new sessions:**
1. Global system prompt (from `settings.json`)
2. Workspace instructions (from workspace `index.json`)
3. **Memory MCP addendum** — appended for every backend whenever `memoryEnabled` is true. Instructs the CLI to call `memory_note` via the `agent-cockpit-memory` MCP server for durable user/feedback/project/reference facts it encounters during the session. Claude Code gets this addendum too — its native `#` flow handles explicit saves, but `memory_note` captures incidental facts mentioned conversationally.
4. **KB Tools addendum** — appended for every backend whenever `kbEnabled` is true. Teaches the CLI that KB search tools are available via the `agent-cockpit-kb-search` MCP server: `search_topics`, `search_entries`, `get_topic`, `find_similar_topics`, `find_unconnected_similar`, and `kb_ingest`. Includes the filesystem layout for direct reads (`entries/<entryId>/entry.md`, `synthesis/*.md`, `synthesis/reflections/*.md`, `state.db`) and the intended workflow: use search tools to find relevant knowledge, then read entry files for full content. The absolute path to the workspace's `knowledge/` directory is interpolated at runtime.
5. **File delivery addendum** — always appended on new sessions. Instructs the CLI to output `<!-- FILE_DELIVERY:/absolute/path --> ` markers when the user explicitly asks for a downloadable file. The marker is stripped by the frontend and replaced with a file card (View + Download buttons). Not used for normal coding file operations.

Concatenated with `\n\n` and passed as the backend's system prompt. Not sent on session resume.

Memory content itself is **not** dumped into the system prompt. Instead, a short filesystem pointer is prepended to the user message on new sessions — see **Workspace Memory → Injection trigger** below. KB content is similarly not serialized into the system prompt — the CLI uses search tools (Layer 1) and file reads (Layer 2) for retrieval.

## 3.12 Version & Self-Update

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/version` | — | `{ version, remoteVersion, updateAvailable }` |
| GET | `/update-status` | — | Cached status: `{ localVersion, remoteVersion, updateAvailable, lastCheckAt, lastError, updateInProgress }` |
| POST | `/check-version` | Yes | Triggers immediate remote check, returns status. |
| POST | `/update-trigger` | Yes | Full update sequence (see Section 4, UpdateService). |
| POST | `/server/restart` | Yes | Plain pm2 restart (no git pull / npm install) via `UpdateService.restart()`. Returns `409` if an update is in progress or active conversation streams exist. Used by the Server tab in Global Settings so users can re-trigger startup-time detection (e.g. pandoc) after installing external binaries. |

## 3.13 Error Response Patterns

| Status | Meaning | Body |
|--------|---------|------|
| `400` | Bad input | `{ error: "message" }` |
| `401` | Session expired / not authenticated (API routes only) | `{ error: "Not authenticated" }` |
| `403` | CSRF failure or access denied | `{ error: "Invalid CSRF token" }` |
| `404` | Not found | `{ error: "Conversation not found" }` etc. |
| `409` | Conflict | `{ error: "Cannot reset session while streaming" }` |
| `500` | Server error | `{ error: err.message }` |

Unauthenticated requests to `/api/*` return `401 { error: "Not authenticated" }` as JSON so the client can react without trying to parse an HTML login page. All other unauthenticated requests redirect to `/auth/login`.
