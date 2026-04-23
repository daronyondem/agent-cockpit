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
| GET | `/conversations/:id` | — | Full conversation object. `404` if not found. Includes `archived: true` when the conversation has been archived (field is absent for active convs) so the frontend topbar can swap Archive → Unarchive + Delete without a separate list round-trip. When KB is enabled for the conversation's workspace, the response is augmented with a `kb` block: `{ enabled, dreamingNeeded, pendingEntries, dreamingStatus, failedItems }` — used by the frontend dream banner to show synthesis status without a separate round-trip. |
| POST | `/conversations` | Yes | `{ title?, workingDir?, backend? }` → creates conversation with initial session. `backend` defaults to the server's default backend. |
| PUT | `/conversations/:id` | Yes | `{ title }` → rename. `404` if not found. |
| DELETE | `/conversations/:id` | Yes | Aborts active stream, removes from workspace index, deletes session folder + artifacts. Works on both active and archived conversations. |
| PATCH | `/conversations/:id/archive` | Yes | Sets `archived: true` on the conversation. Aborts active stream. Files remain on disk. `404` if not found. |
| PATCH | `/conversations/:id/restore` | Yes | Removes `archived` flag, restoring the conversation to the active list. `404` if not found. |
| PATCH | `/conversations/:id/unread` | Yes | `{ unread: boolean }` → sets or clears the conversation's unread flag in the workspace index. `unread: true` writes `unread: true` onto the entry; `unread: false` (or anything non-true) deletes the field to keep the index file lean. Returns `{ ok: true, unread }`. `404` if conversation not found. Idempotent. The frontend calls this on every stream `done` frame for non-active conversations (auto-mark) and from manual dot-click in the sidebar. |
| GET | `/active-streams` | — | Returns `{ ids: string[] }` — conversation IDs whose CLI stream is currently running on the server (or paused awaiting user input). Drawn from the in-memory `activeStreams` map in the chat router; no disk state. Used by the v2 frontend on app load to re-seed sidebar "streaming" dots after a page refresh (the per-conversation `ConvState` in `StreamStore` is wiped by the refresh, but the server-side stream and its WS event buffer survive). |

## 3.3 Message Queue

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/conversations/:id/queue` | — | Returns `{ queue: QueuedMessage[] }` (see `spec-data-models.md → QueuedMessage`). Empty array if none persisted. Legacy `string[]` entries stored on disk are auto-migrated to `QueuedMessage` on read via `ChatService.normalizeMessageQueue()` — any trailing `[Uploaded files: …]` tag is parsed into typed `AttachmentMeta[]`. |
| PUT | `/conversations/:id/queue` | Yes | `{ queue: QueuedMessage[] }` → replaces the full queue. **Strict validation** — every entry must be an object with a `string` `content` field; raw string entries are rejected (`400`). Each `attachments[]` entry must be an object with at minimum a non-empty `path` string. Invalid/missing `path` → `400`. Clients are expected to send the typed shape; there is no server-side upgrade from legacy strings on PUT. `404` if conversation not found. |
| DELETE | `/conversations/:id/queue` | Yes | Clears the queue. `404` if conversation not found. |

The queue is also included in the `GET /conversations/:id` response as `messageQueue` (same typed shape; omitted when empty). Queue is automatically cleared on session reset and archive.

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
| `tool_activity` | `tool`, `description`, `id`, + enriched fields | Tool use notification (see enriched fields below). Events are accumulated per-turn and persisted as `toolActivity` on the saved assistant message (excluding `isPlanMode` and `isQuestion` meta-events). Each persisted activity carries a `batchIndex: number` tag — see *Batch-index tagging* below for how the frontend uses it to group parallel tool runs. |
| `tool_outcomes` | `outcomes` | Array of tool result outcomes extracted from CLI `user` events. Each outcome: `{ toolUseId, isError, outcome, status }`. Merged into `toolActivity` accumulator for persistence and forwarded to frontend for live display. |
| `turn_boundary` | — | Marks boundary between assistant turns (internal — not forwarded to client). Triggers persistence of accumulated `toolActivity` and `contentBlocks` on the intermediate message **only when text was streamed since the last save**. If the boundary has no new text (e.g. a tool-only result), the accumulator is kept intact and the tools ride along with the next segment that does have text — this prevents the Claude Code CLI's sequential processing of parallel tool_uses from dropping tools 2+. The persisted message carries `turn: 'progress'`. |
| `turn_complete` | — | Notifies client that tools finished and a new turn is starting |
| `result` | `content` | Final result text from CLI |
| `assistant_message` | `message` | Saved assistant message (intermediate or final). `message.turn === 'progress'` for intermediate segments saved at a `turn_boundary`; `message.turn === 'final'` for the last segment saved at `done`. |
| `title_updated` | `title` | Conversation title was auto-updated (sent after first assistant message in a reset session) |
| `usage` | `usage`, `sessionUsage` | Cumulative token/cost totals for conversation (`usage`) and active session (`sessionUsage`), sent after each CLI result event |
| `memory_update` | `capturedAt`, `fileCount`, `changedFiles` | Real-time `MemoryWatcher` re-captured workspace memory during this stream. Lightweight payload (no full snapshot) — frontend injects a synthetic system message (`kind: 'memory_update'`) into the conversation's in-memory messages array, which renders as an inline chat bubble with the Agent Cockpit logo as the avatar. Clicking the bubble refetches the snapshot from `GET /workspaces/:hash/memory` and opens the memory panel. |
| `kb_state_update` | `updatedAt`, `changed` | Workspace Knowledge Base state changed. `changed` has optional `raw`/`entries`/`synthesis` string arrays listing the rawIds / entryIds / synthesis artifact ids that were mutated in this frame. Additional optional fields: `digestProgress: { done, total, avgMsPerItem, etaMs? } \| null` (aggregate per-workspace digestion-queue progress spanning batch, single-file manual, and auto-digest runs — the server opens a session on the first enqueue into an idle queue, emits an updated snapshot on every enqueue and every task settle, and emits a **final `digestProgress: null`** signal when the queue drains so the UI can clear the "N / M items — ~E min remaining" indicator; `etaMs` is withheld until `done >= 2` to avoid first-sample noise; the session is persisted to `digest_session` in the KB DB so a mid-flight page reload rehydrates via `GET /workspaces/:hash/kb`), `digestion: { active, entriesCreated }` (per-workspace digestion-session counter — fires `active: true` with a cumulative `entriesCreated` after every entry-creating settle across both single and batch digestion, then fires exactly once with `active: false` when the digestion queue drains so the frontend can flip from a live count-up to a dismissable "Digestion complete — N entities created" banner; the session resets on the next enqueue so a second run starts from zero), `dreamProgress: { phase: 'routing' \| 'verification' \| 'synthesis' \| 'discovery' \| 'reflection', done, total }` (emitted during dreaming runs), `stopping: true` (emitted immediately on `POST /kb/dream/stop` so the UI can show "Stopping…" state before the current batch finishes), `substep: { rawId, text }` (per-raw processing substep text, e.g. "Running CLI analysis…" or "Converting…", used by the frontend to show live progress beneath the status badge). The frame carries no full state — the frontend reacts by refetching `GET /workspaces/:hash/kb`. Fan-out is workspace-scoped: the chat router iterates `activeStreams` and sends the frame to every conversation whose workspace hash matches. See **KB Ingestion** under ChatService / Workspace Knowledge Base for the pipeline. |
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

**Batch-index tagging:** Alongside the flat accumulator, `processStream` keeps a monotonic `batchIndex` counter and a `pendingNewBatch` flag. Every `turn_boundary` sets `pendingNewBatch = true`; the next `tool_activity` bumps `batchIndex` by one and clears the flag. The current `batchIndex` is stamped onto each activity as it lands in the accumulator (and mirrored onto its `contentBlocks` tool block). The counter is monotonic across the entire stream — it does **not** reset when the accumulator does — so tools persisted on different messages keep distinct `batchIndex` values. Because the CLI fires a `user` event (→ `turn_boundary`) exactly once per returned `tool_result`, activities emitted back-to-back without an intervening `turn_boundary` are the parallel tool_uses of a single LLM assistant turn: they share a `batchIndex`. The frontend uses this tag to group parallel tool runs correctly regardless of how slow the per-tool execution is (e.g. `Bash` shell-spawn latency can push a parallel tool's `startTime` far beyond a simple time-window threshold). Legacy `toolActivity` entries saved before this field existed have no `batchIndex` — the renderer falls back to the 500ms `startTime` proximity heuristic for those.

**Ordered `contentBlocks` accumulation:** Alongside the flat `fullResponse` / `thinkingText` / `toolActivityAccumulator` buckets, `processStream` maintains an ordered `blocks: ContentBlock[]` array that preserves the **source order** in which text / thinking / tool events arrive from the backend adapter. Both the Claude Code stream-json adapter and the Kiro ACP adapter yield their events in native backend order, so this array captures the real interleaving: e.g. `text → tool_use → text → tool_use → text`. Adjacent `text` deltas are merged into the tail `text` block (same for `thinking`); each non-plan-mode, non-question `tool_activity` event pushes a fresh `tool` block; `tool_outcomes` patches the matching tool block in place by `activity.id`. At persistence time (on `turn_boundary` and `done`), durations computed from the flat accumulator are merged back into the ordered tool blocks, and the resulting `ContentBlock[]` is saved as `Message.contentBlocks`. The flat `content` string and `toolActivity[]` array continue to be saved alongside for back-compat. Messages written before this feature land carry no `contentBlocks` field — the frontend renderer detects absence and falls back to the legacy tools-then-text layout.

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
Destination: `data/chat/artifacts/{conversationId}/`. Returns `{ files: AttachmentMeta[] }` — see `spec-data-models.md → AttachmentMeta`. Each entry carries `name`, `path`, `size`, a server-inferred `kind` (`image | pdf | md | text | code | file`), and an optional `meta` sublabel computed on upload: page count for PDFs (`"12 pages"`), line count for code/markdown/text files (`"142 lines"`). `meta` is omitted for images and unknown file types. The v2 composer reads these fields to render typed attachment chips without a follow-up fetch.

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
| GET | `/workspaces/:hash/kb` | — | Returns `{ enabled: boolean, state: KbState }` for the workspace. `KbState` carries `{ version, entrySchemaVersion, autoDigest, counters, folders[], raw[], digestProgress, updatedAt }` — `counters` is the aggregate `{ rawTotal, rawByStatus, entryCount, pendingCount, folderCount }` used by the KB Browser header badges, `folders` is the full virtual folder tree (flat, sorted by path), and `raw` is a **single page of the currently-focused folder** (not the whole workspace). Each `raw[]` row also carries `entryCount: number` — `COUNT(entries.entry_id)` for that `rawId`, computed via a `LEFT JOIN entries ON entries.raw_id = raw.raw_id` + `GROUP BY raw_id`. Used by the KB Browser Raw tab to render an "N entries" pill on rows where `status === 'digested'`. Always `0` on rows that haven't been digested yet. `digestProgress` is a `{ done, total, avgMsPerItem, etaMs? } \| null` snapshot sourced from the persisted `digest_session` row, so a mid-flight page reload rehydrates the KB Browser toolbar's "N / M items — ~E min remaining" indicator without losing ETA accuracy; `null` when the digestion queue is idle. Query params `folder` (defaults to root `''`), `limit` (default 500), and `offset` page the raw listing. Always 200 for an existing workspace — an enabled workspace with no files yet returns an empty scaffold (`raw: []`, `folders: [{ folderPath: '', … }]`, zero counters, `digestProgress: null`). `404` if the workspace doesn't exist. Disabled workspaces return an in-memory empty scaffold without touching `state.db` so the KB Browser can still render its disabled state. |
| PUT | `/workspaces/:hash/kb/enabled` | Yes | `{ enabled: boolean }`. Toggles the per-workspace Knowledge Base switch (stored on `WorkspaceIndex.kbEnabled`). `400` if not boolean. `404` if workspace not found. Independent of the Memory toggle — enabling KB does not touch `memoryEnabled`. |
| PUT | `/workspaces/:hash/kb/auto-digest` | Yes | `{ autoDigest: boolean }`. Toggles the per-workspace auto-digest flag (stored on `WorkspaceIndex.kbAutoDigest`). When `true`, the ingestion orchestrator chains a digest run onto the queue as soon as conversion completes. When `false`, ingested files sit in `status='ingested'` until the user hits "Digest All Pending". Deleting the last location of a raw always fully purges it regardless of this flag. `400` if not boolean. `404` if workspace not found. |
| GET | `/workspaces/:hash/kb/embedding-config` | — | Returns `{ embeddingConfig: { model?, ollamaHost?, dimensions? } \| null }`. The per-workspace embedding configuration for the PGLite vector search layer. Returns `null` when no config has been set yet (embedding is disabled). |
| PUT | `/workspaces/:hash/kb/embedding-config` | Yes | `{ model?: string, ollamaHost?: string, dimensions?: number }`. Saves the per-workspace embedding configuration. `model` must be a string (Ollama model name), `ollamaHost` a string (URL), `dimensions` a positive integer. `400` on type validation failure. `404` if workspace not found. When model or dimensions change from a previously saved value, the cached vector store is closed and evicted so the next access rebuilds the PGLite schema with the new dimensions (wiping existing embeddings). |
| POST | `/workspaces/:hash/kb/embedding-health` | Yes | Tests Ollama connectivity and model availability using the workspace's embedding config (or defaults). Returns `{ ok: boolean, error?: string }`. `ok: true` means Ollama is reachable and the configured model returns a non-empty embedding. |
| POST | `/workspaces/:hash/kb/raw` | Yes | `multipart/form-data` with a single `file` field (max 200 MB) and an optional `folder` text field (defaults to root `''`). Hashes the buffer to derive `rawId = sha256[:16]`, stages `raw/<rawId>.<ext>`, and inserts the `raw` row + a `raw_locations` row (one per `(rawId, folder, filename)` tuple) inside a transaction before returning. A background conversion job is scheduled on the workspace's FIFO queue; `_scheduleConversion` also chains a digest run when `kbAutoDigest` is true. Returns **202** with `{ entry: KbRawEntry, deduped: boolean, addedLocation: boolean }`. `deduped: true` means the same `sha256` already exists in the workspace — the orchestrator only inserts a new `raw_locations` row for the new `(folder, filename)` tuple and reuses the raw bytes + conversion output (Option B multi-location). `400 { error: "KB disabled" }` if KB is off, `400` if no file field, `409 KbLocationConflictError` if a different file already occupies `(folder, filename)`, `400 KbValidationError` for invalid filenames/folder segments, `400 { error: "File exceeds the 200 MB upload limit." }` for `LIMIT_FILE_SIZE`. **Pre-flight format guards** still apply: `400` for `.doc` and `400` for `.docx` when pandoc is unavailable — both checks run before any DB rows are created. Emits `kb_state_update` frames on every state mutation (stage, conversion complete, digest complete) with `changed: { raw: [rawId], folders: true }`. **Multi-file client behavior:** The frontend supports multi-file and folder selection, building a client-side queue of `{ file, folderPath }` items and draining it with bounded concurrency (3 parallel XHR uploads) against this same single-file endpoint. Browser `File` objects are lightweight handles — holding tens of thousands is cheap. Error handling is per-item: 400/409 are non-retryable, 401 pauses the entire queue, 500/network errors auto-retry up to 2 times with backoff. Deduped responses (`deduped: true, addedLocation: false`) are surfaced as "Already in KB" in the batch progress UI. No backend changes were required. |
| DELETE | `/workspaces/:hash/kb/raw/:rawId` | Yes | Two modes: (1) **Per-location delete** — when the query string carries both `?folder=…&filename=…`, removes only that single `raw_locations` row. If other locations still reference the rawId the raw row stays; if this was the last location the raw is fully purged (bytes + converted + entries + DB row). (2) **Full purge** — when called without query params, cascade-deletes every `raw_locations` row, the `raw` row, the raw bytes, the `converted/<rawId>/` directory, any digested entries (and `entries/<entryId>/` dirs) — bypassing ref-counting. Returns `{ ok: true }` on success, `404 { error: "Location not found." }` for an unknown `(rawId, folder, filename)` tuple, `404 { error: "Raw file not found." }` for an unknown rawId during full purge, `400` if KB is disabled. The `rawId` must match `^[a-f0-9]{1,64}$` or the route returns `400`. Emits a `kb_state_update` frame on success. |
| POST | `/workspaces/:hash/kb/raw/:rawId/digest` | Yes | Manually trigger digestion for a single raw file (the Raw tab's per-row **Digest now** button). **Fire-and-forget:** returns `202 { accepted: true }` immediately and enqueues a digest job on the workspace FIFO queue (shared with ingestion). The background job flips the raw row to `digesting`, runs the Digestion CLI, parses entries, writes them under `entries/<entryId>/entry.md`, inserts rows in the `entries` + `entry_tags` tables, then flips the raw row to `digested` (or `failed` with an `errorClass` of `timeout \| cli_error \| malformed_output \| schema_rejection \| unknown`). Failures are logged server-side via `.catch()` and surfaced to the UI through `kb_state_update` WS frames + 1500ms polling — the frontend does **not** alert on HTTP errors from this route. Non-eligible statuses (`ingesting`, `digesting`, already `digested`, `failed`) resolve without mutating state. Contributes to the aggregate `digestProgress` session (see `POST /kb/digest-all`) — a single-file trigger either opens a new session with `total=1` or bumps the `total` of an in-flight session. `400` when KB is disabled. |
| POST | `/workspaces/:hash/kb/digest-all` | Yes | Batch-digest every eligible raw file in the workspace (`status='ingested'`; any lingering `pending-delete` rows are purged without digestion). **Fire-and-forget:** returns `202 { accepted: true }` immediately and enqueues the batch on the workspace FIFO queue. Progress is reported via the **aggregate per-workspace digestion session**: the first enqueue into an idle queue opens a session (persisted to `digest_session`), and `kb_state_update` frames carry `changed.digestProgress: { done, total, avgMsPerItem, etaMs? }` on every enqueue and every task settle; a final `digestProgress: null` signal fires when the queue drains so the toolbar indicator clears. The same session spans batch, single-file manual (`/digest`), and auto-digest runs — so a single-file upload that lands mid-batch bumps `total` instead of opening a parallel counter. `etaMs` is withheld until `done >= 2` to avoid first-sample noise. Failures are logged server-side and surfaced per-row via `errorClass`/`errorMessage` in the KB state. `400` when KB is disabled. |
| GET | `/workspaces/:hash/kb/entries` | — | Returns `{ entries: KbEntry[], total: number }` — a paginated, filtered list of digested entries ordered by `title`. `total` is the pre-pagination match count used by the UI to render the pagination bar. Query params: `folder` (filters via `raw_locations` join), `tag` (single-tag filter via `entry_tags` join, legacy), `tags` (comma-separated multi-tag list — **AND semantics**, an entry must carry every tag; merges with `tag` when both are supplied), `rawId` (direct filter), `search` (case-insensitive substring match on entry title; `%` and `_` are escaped so they match literally), `uploadedFrom` / `uploadedTo` (ISO-8601 inclusive bounds on `raw.uploaded_at`, joins the `raw` table), `digestedFrom` / `digestedTo` (ISO-8601 inclusive bounds on `entries.digested_at`), `limit` (default 500), `offset`. All filters combine with AND semantics; empty-string values are treated as "no filter." Each `KbEntry` is the metadata row (`entryId`, `rawId`, `title`, `slug`, `summary`, `schemaVersion`, `staleSchema`, `digestedAt`, `tags[]`) — the full markdown body is served by the per-entry endpoint below. Returns `{ entries: [], total: 0 }` when KB is disabled or the DB hasn't been opened yet (no 404). |
| GET | `/workspaces/:hash/kb/tags` | — | Returns `{ tags: Array<{ tag: string, count: number }> }` — every distinct tag across the workspace's KB entries with its usage count, ordered by `count DESC, tag ASC` so the most common tags surface first. Feeds the Entries-tab tag picker so the UI can render a full list without enumerating every entry. Returns `{ tags: [] }` when KB is disabled. No CSRF — safe read. |
| GET | `/workspaces/:hash/kb/entries/:entryId` | — | Returns `{ entry: KbEntry, body: string, locations: Location[] }` where `body` is the full rendered `entries/<entryId>/entry.md` (YAML frontmatter + markdown) read from disk, and `locations` is the array of source file records from `raw_locations` for the parent raw file, each with shape `{ rawId, folderPath, filename, uploadedAt }`. The UI strips the frontmatter for the preview pane and uses `locations` to render source provenance (folder + filename monospace pills) in the entry popup. `400` for an `entryId` that doesn't match `^[a-zA-Z0-9_.-]+$`, `404` when KB is disabled (`KB not enabled`) or the entry row is missing. On disk read failure `body` falls back to an empty string. No CSRF — safe read. |
| POST | `/workspaces/:hash/kb/folders` | Yes | `{ folderPath: string }`. Creates `folderPath` and any missing ancestors inside the workspace's `folders` table (virtual only — no on-disk directories). Idempotent: creating an existing folder is a no-op but still emits a `folders: true` frame. Returns `{ folderPath: <normalized> }`. `400` for empty/missing `folderPath`, `400 KbValidationError` for invalid segments (`..`, control chars, >128 chars, >4096 total), `400` when KB is disabled. |
| PUT | `/workspaces/:hash/kb/folders` | Yes | `{ fromPath: string, toPath: string }`. Renames a folder subtree: every `raw_locations` row in the subtree is rewritten in a single SQLite transaction (no disk moves since folders are virtual), ancestors of `toPath` are auto-created, and collisions against any existing descendant path cause the whole tx to roll back. Returns `{ ok: true }`. `400` if either field missing, `400 KbValidationError` for invalid segments, `400` for root rename attempts, `400` when KB is disabled. Emits `folders: true`. |
| DELETE | `/workspaces/:hash/kb/folders` | Yes | Delete a folder subtree. `?folder=` is required (query param, not body). `?cascade=true` (or `1`) removes every `raw_locations` row under the subtree following the same ref-counted purge rules as `deleteLocation` (always full purge on last location), then removes the now-empty folder rows deepest-first; without `cascade`, the call errors if the subtree still contains any locations. Returns `{ ok: true }`. `400` for missing `folder`, `400` for root delete attempts, `400 KbValidationError` for unknown folder, `400` when KB is disabled. Emits `folders: true`. |
| GET | `/workspaces/:hash/kb/raw/:rawId` | — | Streams the raw file bytes with `Content-Type` set from the stored `mimeType` (defaults to `application/octet-stream`) and `Content-Disposition: inline; filename="<original>"`. Used by the KB Browser raw list "download" action. `400` if `rawId` fails hex validation, `404` for unknown workspace/rawId. Also path-resolves the computed file path and verifies it stays inside `knowledge/raw/` (traversal guard). No CSRF — safe read. |
| GET | `/workspaces/:hash/kb/raw/:rawId/media/*` | — | Streams a media file produced by ingestion under `knowledge/converted/<rawId>/`. Used by the V2 KB Browser entry modal to render embedded images / extracted slides / rasterized pages: entry bodies reference these with relative paths like `media/Slide123.jpg`, `slides/slide-001.png`, or `pages/page-0001.png`, and the frontend rewrites them into URLs that hit this endpoint. The `*` segment is the relative path under `converted/<rawId>/` (any extension allowed — this is not restricted to images so DOCX/PPTX-extracted media of any type works). `Content-Type` is inferred by `res.sendFile` from the extension. Validations: `rawId` must match `^[a-f0-9]{1,64}$` (else `400`), the media path must be non-empty (else `400`), no `..` segment in the path (else `400`), and the `path.resolve`d disk path must stay inside `converted/<rawId>/` (else `400`). `404` when the file is not present on disk. No CSRF — safe read. |
| GET | `/kb/libreoffice-status` | — | Returns the cached `LibreOfficeStatus` (`{ available, binaryPath, checkedAt }`). Used by the global Settings → Knowledge Base "Convert PPTX slides to images" checkbox to validate on-click: if `available` is `false`, the frontend auto-unchecks the box and shows a warning underneath. Safe to call on every check because `detectLibreOffice()` is cached at module level after the first invocation (server startup). |
| GET | `/kb/pandoc-status` | — | Returns the cached `PandocStatus` (`{ available, binaryPath, version, checkedAt }`). Unlike LibreOffice, pandoc is **required** (not optional) for DOCX ingestion — the route layer rejects `.docx` uploads with a 400 when this endpoint reports `available: false`. The KB Browser Raw tab and global Settings → Knowledge Base tab both fetch this endpoint to surface a persistent install banner. Cached at module level after `detectPandoc()` runs at server startup. |
| POST | `/mcp/kb-search/call` | No CSRF (bearer) | Internal endpoint called by `stub.cjs` during dreaming. Auth via `X-KB-Search-Token` header (per-dream-run token minted by `kbSearchMcp.issueKbSearchSession`). Body: `{ tool: string, arguments: object }`. Dispatches to one of 5 tool handlers: `search_topics`, `get_topic`, `find_similar_topics`, `find_unconnected_similar`, `search_entries`. Returns tool-specific JSON result. `401` for invalid/missing token. `400` for unknown tool. `500` for handler errors. |
| POST | `/workspaces/:hash/kb/dream` | Yes | Incremental dream run — processes only entries with `needs_synthesis = 1`. **Fire-and-forget:** returns `202 { ok: true, mode: 'incremental' }` immediately. The background job runs the five-phase Routing→Verification→Synthesis→Discovery→Reflection pipeline (or cold start when no topics exist), applies operations transactionally, regenerates `synthesis/` markdown, and emits `kb_state_update` frames with `dreamProgress: { phase: 'routing' | 'verification' | 'synthesis' | 'discovery' | 'reflection', done, total }`. `400` if no entries pending synthesis (`countNeedsSynthesis() === 0`), `400` if KB disabled, `409` if a dream is already running for this workspace. |
| POST | `/workspaces/:hash/kb/redream` | Yes | Full rebuild — wipes all synthesis data (topics, connections, reflections, meta) and reprocesses every entry. Returns `202 { ok: true, mode: 'full-rebuild' }`. Same fire-and-forget pattern as `dream`. `400` if no entries exist (`entryCount === 0`), `400` if KB disabled, `409` if already running. |
| POST | `/workspaces/:hash/kb/dream/stop` | Yes | Cooperatively stops an in-progress dream run. Honored at the next batch / phase boundary; already-committed work is preserved. Returns `200 { ok: true, stopping: true }` immediately. A `kb_state_update` WS frame with `changed.stopping: true` is emitted right away so the UI can show "Stopping…" without waiting for the current batch to finish. On exit the normal `status: idle` frame follows. `last_run_at` is **not** updated on a stop (it is not a natural completion); a `stopped_at` meta entry is written instead. Returns `404 { ok: false }` if no run is in progress. |
| GET | `/workspaces/:hash/kb/synthesis` | — | Returns `{ status, stopping, lastRunAt, lastRunError, topicCount, connectionCount, needsSynthesisCount, reflectionCount, staleReflectionCount, godNodes[], dreamProgress, topics[], connections[] }`. `stopping` is `true` when a cooperative stop has been requested for an in-progress run (reflects `isStopRequested(hash)`). `dreamProgress` is `{ phase, done, total } | null` — non-null when a dream is in progress. `reflectionCount` is the total number of reflections; `staleReflectionCount` is the count of reflections with stale citations (a reflection is stale if any cited entry was re-digested, deleted, or lost citations via cascade since the reflection was created). Topics carry `{ topicId, title, summary, entryCount, connectionCount, isGodNode }`. Connections carry `{ sourceTopic, targetTopic, relationship, confidence }`. `404` if KB DB not found. |
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

## 3.12 Workspace File Explorer

Full-screen split-pane UI for browsing, previewing, and managing files in a workspace's working directory. All routes are mounted under `/api/chat/workspaces/:hash/explorer/…`. `:hash` is the SHA-256 workspace hash derived by `chatService.getWorkspacePath(hash)`. Every route resolves the incoming `path` parameter through `resolveExplorerPath(hash, relPath)`:

- Workspace is looked up by hash; `404 { error: "Workspace not found" }` if unknown.
- Leading `/` and `\` are stripped so absolute-looking input is always treated as relative to the workspace root (safe-by-default — the UI only ever builds relative paths, so this avoids "absolute path confused the server" footguns).
- The resolved absolute path must equal the workspace root or live under `root + path.sep`. Any attempt to escape (e.g. `..`) returns `403 { error: "Access denied: path is outside workspace" }`.

Constants (defined in `src/routes/chat.ts`):
- `EXPLORER_TEXT_VIEW_LIMIT = 5 * 1024 * 1024` — max bytes returned by `mode=view` before `413`.
- `EXPLORER_UPLOAD_LIMIT = 500 * 1024 * 1024` — multer per-file cap.

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/workspaces/:hash/explorer/tree?path=<rel>` | — | Lists the immediate children of the given directory. `path` defaults to root (`''`). Returns `{ path, entries: [{ name, type: 'dir' \| 'file', size, mtime }] }` sorted dirs-first then alphabetically. Hidden files (names starting with `.`) are **always included** — the file explorer's UX requirement. `403` on traversal, `404` on missing dir, `400` if the path resolves to a file. Safe read (no CSRF). |
| GET | `/workspaces/:hash/explorer/preview?path=<rel>&mode=view\|raw\|download` | — | Serves a file three different ways. `mode=view` (default) returns `{ content, filename, language, size, mtime }` JSON for the preview pane with UTF-8 text capped at `EXPLORER_TEXT_VIEW_LIMIT`; returns `413 { error: "File too large to preview" }` for larger text files. `mode=raw` streams the file with `Content-Type` inferred from extension — used by `<img>` tags and the markdown renderer for embedded images. `mode=download` streams with `Content-Disposition: attachment; filename="<basename>"` for the download button. `403` on traversal, `404` on missing file, `400` if the path is a directory. No CSRF — safe read (used directly by `<img>` elements and download links). |
| POST | `/workspaces/:hash/explorer/upload?path=<rel>&overwrite=true\|false` | Yes | Single-file multipart upload. Query `path` is the destination **folder** (defaults to root). Multer disk-storage writes bytes to a temp name `.ac-upload-<timestamp>-<nonce>-<safeName>` in the destination folder, then the handler checks for a collision against the real target filename. On conflict without `overwrite=true`, the temp file is unlinked and the route returns `409 { error: "File exists", name }`. With `overwrite=true` (or no existing file), the temp file is renamed into place and the response is `{ ok: true, entry: { name, type: 'file', size, mtime } }`. `413` when the upload exceeds `EXPLORER_UPLOAD_LIMIT`. `403` on traversal, `404` if the destination folder does not exist, `400` if `path` resolves to a file instead of a directory. The frontend drives multi-file uploads by issuing parallel XHR requests against this single-file endpoint with concurrency 3 (mirrors the KB upload pattern); each XHR's `upload.onprogress` drives a dedicated progress bar in the tree pane's upload panel. |
| POST | `/workspaces/:hash/explorer/mkdir` | Yes | Body: `{ parent?: string, name: string }`. Creates a new empty directory named `name` inside `parent` (defaults to workspace root). `name` is trimmed and rejected with `400 { error: "Invalid folder name" }` when it is empty, contains `/` or `\`, or equals `.`/`..`. `parent` is resolved through `resolveExplorerPath`; non-directory or missing parents return `404 { error: "Parent folder not found" }` or `400` respectively. A collision against any existing file or folder in the parent returns `409 { error: "A file or folder with this name already exists" }`. `403` on traversal. On success returns `{ ok: true, path: <relative path of new folder>, name }`. |
| POST | `/workspaces/:hash/explorer/file` | Yes | Body: `{ parent?: string, name: string, content?: string }`. Creates a new file `name` inside `parent` (defaults to workspace root). `name` is trimmed and rejected with `400 { error: "Invalid file name" }` when it is empty, contains `/` or `\`, or equals `.`/`..`. Optional `content` (UTF-8 string) is written as the initial body — omit for an empty file. The byte length of `content` must stay under `EXPLORER_TEXT_VIEW_LIMIT` or the route returns `413 { error: "Content exceeds the 5 MB edit limit." }` and no file is created. Non-directory or missing parents return `400`/`404 { error: "Parent folder not found" }`. A collision against any existing file or folder returns `409 { error: "A file or folder with this name already exists" }` (no overwrite — existing bytes are preserved). `403` on traversal. On success returns `{ ok: true, path: <relative path>, name, size }`. Used by the toolbar's **New File** button; complements the upload route for the "create from keyboard" flow. |
| PUT | `/workspaces/:hash/explorer/file` | Yes | Body: `{ path: string, content: string }`. Overwrites an **existing** text file with the UTF-8 encoded `content`. The target is resolved through `resolveExplorerPath` — workspace root is refused (`400 { error: "Path must be a file" }`), missing files return `404`, and directories return `400 { error: "Path is not a file" }`. `content` must be a string; non-string bodies return `400`. The byte length of `content` must stay under the 5 MB view/edit cap (`EXPLORER_TEXT_VIEW_LIMIT`) — over-limit payloads return `413 { error: "Content exceeds the 5 MB edit limit." }` and the file is not modified. On success the route writes with `utf8` encoding and returns `{ ok: true, size, mtime }` (post-write stat). `403` on traversal. Used by the preview pane's Edit → Save flow; the endpoint intentionally does not create new files — creation is handled by `POST /explorer/file` or the upload route. |
| PATCH | `/workspaces/:hash/explorer/rename` | Yes | Body: `{ from: string, to: string, overwrite?: boolean }`. Renames/moves a file or directory. Both `from` and `to` resolve through `resolveExplorerPath`; workspace root is refused for either side (`400 { error: "Cannot rename workspace root" }` / `"Cannot overwrite workspace root"`). `from` must exist (`404 { error: "Source not found" }`). When the resolved `to` equals `from` the route no-ops with `{ ok: true, unchanged: true }`. If `to` already exists and `overwrite` is falsy, returns `409 { error: "Destination already exists", conflict: true }`; with `overwrite: true` the existing target is removed recursively before the rename. Ancestors of `to` are auto-created (`fs.mkdir recursive`). Returns `{ ok: true }` on success. `403` on traversal. Used by the preview pane's rename row action. |
| DELETE | `/workspaces/:hash/explorer/entry?path=<rel>` | Yes | **Hard delete** of a file or directory. `path` is required. Refuses workspace root (`400 { error: "Cannot delete workspace root" }`). Calls `fs.rm(abs, { recursive: true, force: false })` — directories are removed with their contents, but the `force: false` keeps the ENOENT branch so missing targets surface as `404`. Returns `{ ok: true }`. `403` on traversal, `404` when the entry does not exist. |

**Frontend integration (`public/js/fileExplorer.js`):** the Explorer state is a single module-level object `feState = { hash, label, currentFolder, entries, selected, preview, expanded: Set, children: Map, uploads: [] }`. The tree pane lazy-loads directories by issuing a `tree` request on expand and caching rows in `children`. Preview rendering branches on kind: `text` and `markdown` use `mode=view` JSON; `image` uses `mode=raw` with a client-side 25 MB size guard (from the tree entry's `size` field) before the `<img>` is attached; oversize or unsupported files show a download-only stub. Upload progress items live in `uploads[]` and are rendered in a bottom-of-tree panel; drag-and-drop onto the tree pane picks up `DataTransfer.items`, and dropping onto a directory row sets that row as the destination folder. The explorer is opened by the hover-visible folder button on each workspace group header (rendered only when `group.hash` is present) and closes via `chatCloseFileExplorer()` which re-shows the chat panes.

**V2 frontend integration (`public/v2/src/screens/filesBrowser.jsx`):** a React port of the same model. The same endpoints back a `<FilesBrowser hash label onClose>` component swapped into the main pane (sibling to the v2 KB Browser) when the Sidebar's per-workspace Files button fires `onOpenFiles(hash, label)`. All fetches go through `AgentApi.explorer` (see `spec-frontend.md`); the upload path uses XHR so per-file progress bars can render in the bottom-of-tree `<FxUploadPanel>`. 409 conflicts on upload or rename prompt a `window.confirm` to retry with `overwrite: true`.

## 3.13 Version & Self-Update

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/version` | — | `{ version, remoteVersion, updateAvailable }` |
| GET | `/update-status` | — | Cached status: `{ localVersion, remoteVersion, updateAvailable, lastCheckAt, lastError, updateInProgress }` |
| POST | `/check-version` | Yes | Triggers immediate remote check, returns status. |
| POST | `/update-trigger` | Yes | Full update sequence (see Section 4, UpdateService). |
| POST | `/server/restart` | Yes | Plain pm2 restart (no git pull / npm install) via `UpdateService.restart()`. Returns `409` if an update is in progress or active conversation streams exist. Used by the Server tab in Global Settings so users can re-trigger startup-time detection (e.g. pandoc) after installing external binaries. |

## 3.14 Claude Code Plan Usage

Account-wide Claude Code plan usage snapshot (5-hour session %, weekly %, per-model breakdown, reset times, plan tier, optional extra-credit balance). Surfaced in the ContextChip tooltip on Claude Code conversations.

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/plan-usage` | — | Returns the last cached snapshot. **Does not trigger a refresh.** Response: `{ fetchedAt: string \| null, planTier: string \| null, subscriptionType: string \| null, rateLimits: RateLimits \| null, lastError: string \| null, stale: boolean }`. `fetchedAt` is ISO-8601 of the last successful fetch (`null` before the first ever fetch). `planTier` mirrors the OAuth credential's `rateLimitTier` (e.g. `default_claude_max_20x`). `subscriptionType` mirrors the credential's `subscriptionType` (e.g. `max`). `lastError` is the last fetch failure message (`token-expired`, HTTP 4xx/5xx, or network error) — cleared on success. `stale: true` when `Date.now() - fetchedAt > 15 min` or no fetch has landed yet. |

**`RateLimits` shape** — every field optional and nullable; the `/api/oauth/usage` upstream ships new buckets under codenames (`seven_day_omelette`, `seven_day_cowork`, `iguana_necktie`, `omelette_promotional`) before they land with stable names, so the response is stored verbatim and the client derives labels for unknown keys.

```ts
{
  five_hour?:            { utilization: number, resets_at: string } | null,
  seven_day?:            { utilization: number, resets_at: string } | null,
  seven_day_opus?:       { utilization: number, resets_at: string } | null,
  seven_day_sonnet?:     { utilization: number, resets_at: string } | null,
  seven_day_oauth_apps?: { utilization: number, resets_at: string } | null,
  extra_usage?: {
    is_enabled:     boolean,
    monthly_limit:  number | null,  // integer cents (50000 → $500.00)
    used_credits:   number | null,  // integer cents (18734 → $187.34)
    utilization:    number | null,
    currency?:      string | null,
  } | null,
  // …any additional codename keys are preserved verbatim.
}
```

**Refresh trigger policy:** The service behind this endpoint refreshes opportunistically from two triggers — server startup (once, via `init()` + `maybeRefresh('server-start')`) and after each Claude Code assistant turn (`onDone` callback in the chat router calls `maybeRefresh('turn-done')`). A floor of 10 minutes between attempts (tracked by last attempt time, not last success) protects against rate-limit retry storms. The HTTP route itself never forces a fetch — it only reads the cache. Other backends (Kiro, etc.) do not trigger refreshes.

See Section 4 (`ClaudePlanUsageService`) for the caching, credential resolution, and HTTP semantics.

## 3.15 Kiro Plan Usage

Account-wide Kiro (Amazon Q) plan usage snapshot (subscription tier, monthly credits used / cap, overage status + dollar charges, bonus credits, reset date). Surfaced in the ContextChip tooltip on Kiro conversations. The service fetches this directly from Amazon — it does **not** piggyback on the ACP stream (an earlier ACP-based attempt caused cross-conversation message leakage and was abandoned in favor of this direct path).

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/kiro-plan-usage` | — | Returns the last cached snapshot. **Does not trigger a refresh.** Response: `{ fetchedAt: string \| null, usage: KiroUsageData \| null, lastError: string \| null, stale: boolean }`. `fetchedAt` is ISO-8601 of the last successful fetch (`null` before the first ever fetch). `lastError` is the last fetch failure message (`token-expired`, `kiro-cli DB unavailable`, `missing access token`, `missing profile`, HTTP 4xx/5xx, or network error verbatim) — cleared on success. `stale: true` when `Date.now() - fetchedAt > 15 min` or no successful fetch has landed yet. |

**`KiroUsageData` shape** — normalized from the Amazon Q `GetUsageLimits` response body (`subscriptionInfo`, `overageConfiguration.overageStatus`, `nextDateReset`, `usageBreakdownList[0]`) with each field coerced to `string | null` / `number | null` so missing or unexpected upstream fields never crash the frontend; `bonuses` is passed through as an opaque array.

```ts
{
  subscription: {
    subscriptionTitle:            string | null,  // "Free" / "Pro" / etc.
    type:                         string | null,
    overageCapability:            string | null,
    upgradeCapability:            string | null,
    subscriptionManagementTarget: string | null,
  } | null,
  overageStatus: string | null,                   // "ENABLED" / "DISABLED" / other
  nextDateReset: number | null,                   // epoch seconds (not ms)
  breakdown: {
    currency:                     string | null,
    currentUsage:                 number | null,  // credits used this cycle
    currentUsageWithPrecision:    number | null,  // higher-precision variant — preferred by the renderer
    currentOverages:              number | null,  // extra credits beyond the cap
    currentOveragesWithPrecision: number | null,
    overageCap:                   number | null,
    overageCapWithPrecision:      number | null,
    overageCharges:               number | null,  // dollar charges accrued from overage
    overageRate:                  number | null,  // $ per credit rate
    usageLimit:                   number | null,  // cycle cap
    usageLimitWithPrecision:      number | null,
    displayName:                  string | null,  // singular unit label ("Credit")
    displayNamePlural:            string | null,  // plural unit label ("Credits")
    resourceType:                 string | null,
    unit:                         string | null,
    nextDateReset:                number | null,  // per-breakdown reset (epoch seconds)
    bonuses:                      unknown[],      // opaque — frontend shows the count, not the contents
  } | null,
}
```

**Refresh trigger policy:** The service refreshes opportunistically from two triggers — server startup (once, via `init()` + `maybeRefresh('server-start')`) and after each Kiro assistant turn (`onDone` callback in the chat router calls `maybeRefresh('turn-done')`). A floor of 10 minutes between attempts (tracked by last attempt time, not last success) protects against rate-limit retry storms. The HTTP route itself never forces a fetch — it only reads the cache. Other backends (Claude Code, etc.) do not trigger this service's refreshes.

See Section 4 (`KiroPlanUsageService`) for the caching, SQLite credential resolution, and HTTP semantics.

## 3.16 Error Response Patterns

| Status | Meaning | Body |
|--------|---------|------|
| `400` | Bad input | `{ error: "message" }` |
| `401` | Session expired / not authenticated (API routes only) | `{ error: "Not authenticated" }` |
| `403` | CSRF failure or access denied | `{ error: "Invalid CSRF token" }` |
| `404` | Not found | `{ error: "Conversation not found" }` etc. |
| `409` | Conflict | `{ error: "Cannot reset session while streaming" }` |
| `500` | Server error | `{ error: err.message }` |

Unauthenticated requests to `/api/*` return `401 { error: "Not authenticated" }` as JSON so the client can react without trying to parse an HTML login page. All other unauthenticated requests redirect to `/auth/login`.
