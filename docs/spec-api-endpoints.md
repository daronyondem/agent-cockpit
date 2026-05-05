# 3. API Endpoints

[← Back to index](SPEC.md)

---

All chat endpoints are mounted under `/api/chat`. All require authentication via `requireAuth`. State-changing operations (POST, PUT, DELETE) additionally require `csrfGuard`.

## 3.0 Auth Support

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/auth/status` | Public | Returns `{ setupRequired, providers: { password: true, passkey, legacyOAuth }, passkeys: { registered }, policy, recovery }` so web clients can tell whether the backend needs first-run owner setup and which auth methods are active. `policy` is `{ passkeyRequired }`; `recovery` is `{ configured, total, remaining, createdAt }`. |
| GET | `/api/me` | Yes, except localhost bypass | Returns `{ displayName, email, provider }` for the current server session. The default first-party owner uses `provider: "local"`. Localhost bypass returns null fields when no session user exists. |
| GET | `/api/csrf-token` | Yes, except localhost bypass | Returns `{ csrfToken }` for the current session. Web clients cache this value and send it as `x-csrf-token` for state-changing requests. |
| GET | `/api/auth/passkeys` | Yes | Lists passkeys as `{ passkeys: [{ id, name, transports?, createdAt, lastUsedAt? }] }`; public credential material and counters are not returned. |
| POST | `/api/auth/passkeys/register/options` | Yes + CSRF | Body `{ name? }`. Generates WebAuthn registration options for the current origin/RP ID, stores the challenge in session, and excludes already-registered credentials. |
| POST | `/api/auth/passkeys/register/verify` | Yes + CSRF | Body `{ name?, response }`, where `response` is the JSON-encoded credential from `navigator.credentials.create`. Verifies the WebAuthn response and stores credential id, public key, counter, transports, and timestamps. Returns `{ passkey, passkeys }`. |
| POST | `/api/auth/passkeys/login/options` | Public | Body `{ popup? }`. Generates WebAuthn assertion options for registered credentials and stores challenge/mode in the anonymous session. Returns 409 when no passkeys exist. |
| POST | `/api/auth/passkeys/login/verify` | Public | Body `{ response }`, where `response` is the JSON-encoded credential from `navigator.credentials.get`. Verifies the assertion, updates passkey counter/last-used metadata, creates the normal server session, and returns `{ redirectTo, user }`. |
| PATCH | `/api/auth/passkeys/:id` | Yes + CSRF | Body `{ name }`. Renames a passkey and returns `{ passkey, passkeys }`. |
| DELETE | `/api/auth/passkeys/:id` | Yes + CSRF | Deletes a passkey and returns `{ passkeys }`. Returns 409 if deleting the last passkey while passkey-required mode is enabled. |
| POST | `/api/auth/recovery/regenerate` | Yes + CSRF | Regenerates the owner's recovery codes. Returns `{ recoveryCodes, recovery }`; `recoveryCodes` are plaintext one-time codes and are shown only in this response. Stored recovery codes are scrypt-hashed. |
| PATCH | `/api/auth/policy` | Yes + CSRF | Body `{ passkeyRequired: boolean }`. Updates auth policy. Enabling passkey-required mode returns 409 unless at least one passkey and at least one unused recovery code exist. |

Non-API first-party auth pages:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/setup` | First-run local owner setup page. |
| POST | `/auth/setup` | Creates owner from `{ email, displayName, password, setupToken? }` and signs in. |
| GET | `/auth/login` | First-party password/passkey login page. Redirects to setup when no owner exists. |
| POST | `/auth/login/password` | Password login; blocks with 403 when `policy.passkeyRequired` is true. |
| GET | `/auth/recovery` | Recovery-code login page. |
| POST | `/auth/recovery/login` | Consumes one recovery code, signs in, and disables `passkeyRequired`. |

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
| POST | `/conversations` | Yes | `{ title?, workingDir?, backend?, cliProfileId?, model?, effort? }` → creates conversation with initial session. When `cliProfileId` is omitted and `backend` is omitted, the service uses `settings.defaultCliProfileId` when present, otherwise the server's default backend. When `cliProfileId` is supplied, the profile's vendor becomes the stored backend; missing/disabled profiles return `400`, and an explicit `backend` that does not match the profile vendor returns `400`. |
| PUT | `/conversations/:id` | Yes | `{ title }` → rename. `404` if not found. |
| DELETE | `/conversations/:id` | Yes | Routes cleanup through `StreamJobSupervisor`: aborts any active runtime stream, detaches it from `activeStreams`, removes durable active jobs for the conversation, removes from workspace index, and deletes session folder + artifacts. Works on both active and archived conversations. Returns `409` if a just-accepted send is still in the pre-stream setup window, before an abort handle exists. |
| PATCH | `/conversations/:id/archive` | Yes | Sets `archived: true` on the conversation. Routes cleanup through `StreamJobSupervisor`: aborts any active runtime stream, detaches it from `activeStreams`, removes durable active jobs for the conversation, and clears any stale WebSocket replay buffer. Files remain on disk. Returns `409` if a just-accepted send is still in the pre-stream setup window, before an abort handle exists. `404` if not found. |
| PATCH | `/conversations/:id/restore` | Yes | Removes `archived` flag, restoring the conversation to the active list. `404` if not found. |
| PATCH | `/conversations/:id/unread` | Yes | `{ unread: boolean }` → sets or clears the conversation's unread flag in the workspace index. `unread: true` writes `unread: true` onto the entry; `unread: false` (or anything non-true) deletes the field to keep the index file lean. Returns `{ ok: true, unread }`. `404` if conversation not found. Idempotent. The frontend calls this on every stream `done` frame for non-active conversations (auto-mark) and from manual dot-click in the sidebar. |
| POST | `/conversations/:id/abort` | Yes | Transport-independent stop for the active or pending CLI turn. If the conversation exists and is streaming, marks the active entry as abort-requested, calls `abort()`, clears stale replay frames, persists any accumulated partial assistant output when `processStream` has started, persists a durable assistant `streamError` message (`source:'abort'`), emits that assistant message plus terminal `{ type:'error', error:'Aborted by user', source:'abort' }` + `done` frames for connected/reconnecting clients, and removes the entry from `activeStreams`. If a send is accepted but still preparing before `activeStreams.set()`, marks the pending send as abort-requested; after the user message is persisted, the route writes the durable abort `streamError`, emits terminal abort frames, revokes any issued Memory/KB MCP tokens, and returns without calling the backend adapter. Concurrent abort requests for the same active stream share one finalization promise, so backend `abort()`, terminal frame emission, and durable `streamError` persistence are each performed at most once. If a backend/server terminal error is already being finalized, abort waits for that terminal finalization and does not replace the durable error with `source:'abort'`. Returns `{ ok: true, aborted: true }`. If the conversation exists but no stream is active or pending, returns `{ ok: true, aborted: false }` so Stop is idempotent across natural-completion races. `404` if the conversation does not exist. |
| GET | `/active-streams` | — | Returns `{ ids: string[], streams: ActiveStreamSummary[] }` for accepted CLI turns that are active, preparing, finalizing, or paused awaiting user input. `ids` is kept for compatibility and hydration; `streams[]` includes `{ id, jobId, state, backend, startedAt, lastEventAt, connected, runtimeAttached, pending, runtime }` for operational visibility and admin tooling. `runtimeAttached` means this process currently has a backend iterator for the job; `pending` means the message request is still in the accepted/preparing window before an iterator exists; `runtime` carries backend runtime identifiers such as `externalSessionId`, `activeTurnId`, and `processId` when the adapter has emitted them. The route merges the supervisor's in-memory `activeStreams` map with the durable `data/chat/stream-jobs.json` registry, so a just-accepted/preparing send is visible before the backend stream object exists. Used by the v2 frontend on app load to re-seed sidebar "streaming" dots after a page refresh. After a full server restart, startup reconciliation removes stale durable jobs and persists a terminal `streamError` instead of retrying or reattaching to the lost backend iterator. |

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
| POST | `/conversations/:id/reset` | Yes | Archives active session (generates LLM summary), creates new empty session, clears message queue, clears `lastMessage`, clears `unread`, and bumps `lastActivity` so conversation-list summaries reflect the active session rather than the archived one. Resets title to "New Chat" only when the title is auto-managed; manually renamed conversations keep their title. `409` if a stream is active or a just-accepted send is still preparing. The ending backend is resolved through `cliProfileId` when present; missing/disabled profiles return `400`. Clears any stale WebSocket event buffer for the conversation. After archiving, invokes `captureWorkspaceMemory(convId, endingBackend)` so the ending backend's native memory is mirrored to `workspaces/{hash}/memory/`, then runs post-session extraction via `memoryMcp.extractMemoryFromSession` for every backend (including Claude Code) — the Memory CLI scans the just-ended transcript and writes any new memory notes into `memory/files/notes/`. Both steps are best-effort — failures do not block the reset. Also calls `memoryMcp.revokeMemoryMcpSession(convId)` and `kbSearchMcp.revokeKbSearchSession(convId)` to rotate the MCP tokens for the next session. Returns `{ conversation, newSessionNumber, archivedSession }`. |

## 3.6 Backends

```
GET /backends
```
Returns `{ backends: [{ id, label, icon, capabilities, resumeCapabilities, models? }] }` — metadata for every registered adapter. `resumeCapabilities` is `{ activeTurnResume, activeTurnResumeReason, sessionResume, sessionResumeReason }`; current built-in backends all report `activeTurnResume: 'unsupported'` and `sessionResume: 'supported'`, meaning they can continue later turns from backend session/thread history but cannot reattach to the exact in-flight turn after the cockpit server loses its iterator. The optional `models` array lists available models: `[{ id, label, family, description?, costTier?, default?, supportedEffortLevels? }]`. `supportedEffortLevels` is an optional array of `'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'` indicating which adaptive reasoning levels the model accepts; the UI uses its presence to decide whether to show the effort dropdown. Values are backend/model-specific: Codex may expose protocol-only `none` / `minimal`, while Claude Code exposes `max` on supported Opus models. Backends without model selection omit the `models` field entirely.

```
GET /cli-profiles/:profileId/metadata
```
Resolves the CLI profile through settings, then calls the vendor adapter's async `getMetadata({ cliProfile })`. Returns `{ profileId, backend }` where `backend` has the same shape as one entry from `/backends`, but its `models` can be profile-specific. Missing/disabled profiles return `400`. An unregistered profile vendor returns `500`. Codex uses this route to run `model/list` under the selected profile's `command`/`env`/`CODEX_HOME` and cache that catalog by profile runtime.

## 3.7 Messaging and Streaming

**Send message:**
```
POST /conversations/:id/message  [CSRF]
Body: { content: string, backend?: string, cliProfileId?: string, model?: string, effort?: string }
```
- Saves user message, updates backend/profile and/or model if changed
- Returns `409 { error: "Conversation is already streaming" }` when the conversation already has an active server-owned CLI stream or another accepted send is still preparing that stream. A per-conversation pending-send record is installed before backend/profile/model/effort mutation and user-message persistence, so concurrent POSTs cannot append duplicate user messages or start duplicate CLI processes.
- Resolves `cliProfileId` through settings and uses the profile vendor as the runtime adapter. Missing/disabled profiles return `400`. If both `cliProfileId` and `backend` are supplied, the backend must match the profile vendor or the route returns `400`.
- Profile switching is allowed only before the active session has messages. A different `cliProfileId` after messages exist returns `409`; switching after reset is allowed because the new active session is empty.
- If `effort` differs from the stored value, updates it. Unsupported requests fall back to `high` when the current model supports it, then the model's first supported effort level.
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
- **Multiple clients per conversation:** The WebSocket layer keeps a set of open transports for each conversation and broadcasts every live stream frame to all of them. Opening a second browser tab, desktop chat, mobile chat, or passive mobile list monitor for the same conversation does not close or replace the existing transport. `isConnected(conversationId)` is true when at least one transport is open, and the stream is marked disconnected/buffering only after the last open transport for that conversation closes. See [ADR-0028](adr/0028-allow-multiple-websocket-clients-per-conversation.md).
- **Reconnection with state recovery:** On client disconnect, the CLI process is NOT killed. Active stream lifetime is owned by the chat router's `activeStreams` entry, not by browser WebSocket state. Replayable stream frames continue to be buffered server-side (ring buffer, max 5000 events). Workspace side-channel triggers such as `kb_state_update` and `memory_update` are live-only and are not stored in the replay buffer; their persisted workspace state is the source of truth after reconnect. When the client reconnects, the server replays buffered events wrapped in `replay_start`/`replay_end`, then resumes live streaming. An explicit client `{ type: 'reconnect' }` frame looks up the current replay buffer at frame time, so buffers created after the WebSocket connection was first established can still be replayed. When the CLI completes, terminal frames are buffered and replayed until the configured buffer cleanup timeout drops the buffer (60s by default, overridable in tests), regardless of whether a browser WebSocket was connected at completion time. Replaying an already-completed buffer restarts cleanup with the same configured timeout rather than a separate hard-coded delay. If the replay buffer has already been cleaned by the time the client returns, persisted conversation messages and `/active-streams` reconciliation are authoritative.
- **POST without an open WebSocket (network-change recovery):** `POST /conversations/:id/message` always spawns the CLI and runs `processStream`, regardless of whether a WebSocket is currently connected for the conversation. If no WS is open at submission time, the chat router marks the conversation as disconnected/buffering so frames accumulate for later replay. Browser reconnect timing does not affect the accepted CLI turn.
- **Terminal stream errors:** Backend `error` frames are terminal by default. Terminal errors are persisted as assistant messages with `streamError`, emitted as `assistant_message` plus `error`, and followed by `done` if the backend exits without producing one. Partial assistant output accumulated before the terminal error is persisted first. `error` frames with `terminal: false` are non-fatal warnings; they are forwarded but do not create `streamError`, do not end the stream, and do not unblock queue draining.
- Client-to-server frames (JSON): `{ type: 'input', text }` (stdin), `{ type: 'abort' }` (legacy transport-level abort delegated to the same server-owned abort path as REST), `{ type: 'reconnect' }` (explicit replay request)
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
| `artifact` | `artifact` or source fields | Generated assistant artifact. Backend adapters may yield source fields (`sourcePath` or `dataBase64`, plus optional `filename`, `mimeType`, `title`, `sourceToolId`); `processStream` copies/decodes the bytes into `data/chat/artifacts/{conversationId}/`, appends `{ type: 'artifact', artifact: ConversationArtifact }` to `contentBlocks`, and forwards `{ type: 'artifact', artifact }` to clients. Artifact-only turns are saved as assistant messages even when no final text is emitted. |
| `turn_boundary` | — | Marks boundary between assistant turns (internal — not forwarded to client). Triggers persistence of accumulated `toolActivity` and `contentBlocks` on the intermediate message **only when text was streamed since the last save**. If the boundary has no new text (e.g. a tool-only result), the accumulator is kept intact and the tools ride along with the next segment that does have text — this prevents the Claude Code CLI's sequential processing of parallel tool_uses from dropping tools 2+. The persisted message carries `turn: 'progress'`. |
| `turn_complete` | — | Notifies client that tools finished and a new turn is starting |
| `result` | `content` | Final result text from CLI |
| `assistant_message` | `message` | Saved assistant message (intermediate or final). `message.turn === 'progress'` for intermediate segments saved at a `turn_boundary`; `message.turn === 'final'` for the last segment saved at `done`. |
| `title_updated` | `title` | Conversation title was auto-updated (sent after first assistant message in a reset session) |
| `usage` | `usage`, `sessionUsage` | Cumulative token/cost totals for conversation (`usage`) and active session (`sessionUsage`), sent after each CLI result event |
| `memory_update` | `capturedAt`, `fileCount`, `changedFiles`, `sourceConversationId?`, `displayInChat?` | Workspace memory changed. Real-time `MemoryWatcher` emits it when it re-captures workspace memory during an active stream; memory delete/clear routes also emit it after rewriting `snapshot.json`. The frame is lightweight (no full snapshot) and live-only: route-level fan-out is workspace-scoped to currently connected conversations whether or not they have active streams, and the replay buffer does not store it. Frames caused by a specific conversation carry `sourceConversationId`; the router sets `displayInChat: true` only on the frame sent to that source conversation and `false` for other same-workspace recipients. Manual delete/clear frames are refresh-only (`displayInChat: false`). The frontend dispatches an `ac:memory-update` browser event for matching workspace surfaces to refresh silently, and injects a synthetic Memory message into a conversation's in-memory messages array only when `displayInChat` is true. Clicking the bubble opens a focused Memory Update modal that refetches the current snapshot from `GET /workspaces/:hash/memory`, filters it by `changedFiles`, and shows only the updated memory entries first; the modal's **View all memory items** action then opens the full workspace Memory panel. |
| `kb_state_update` | `updatedAt`, `changed` | Workspace Knowledge Base state changed. `changed` has optional `raw`/`entries`/`synthesis` string arrays listing the rawIds / entryIds / synthesis artifact ids that were mutated in this frame. Additional optional fields: `autoDream: true` (per-workspace Auto-Dream schedule changed, so the frontend refetches synthesis timing/status), `digestProgress: { done, total, avgMsPerItem, etaMs? } \| null` (aggregate per-workspace digestion-queue progress spanning batch, single-file manual, and auto-digest runs — the server opens a session on the first enqueue into an idle queue, emits an updated snapshot on every enqueue and every task settle, and emits a **final `digestProgress: null`** signal when the queue drains so the UI can clear the "N / M items — ~E min remaining" indicator; `etaMs` is withheld until `done >= 2` to avoid first-sample noise; the session is persisted to `digest_session` in the KB DB so a mid-flight page reload rehydrates via `GET /workspaces/:hash/kb`), `digestion: { active, entriesCreated }` (per-workspace digestion-session counter — fires `active: true` with a cumulative `entriesCreated` after every entry-creating settle across both single and batch digestion, then fires exactly once with `active: false` when the digestion queue drains so the frontend can flip from a live count-up to a dismissable "Digestion complete — N entities created" banner; the session resets on the next enqueue so a second run starts from zero), `dreamProgress: { phase: 'routing' \| 'verification' \| 'synthesis' \| 'discovery' \| 'reflection', done, total }` (emitted during dreaming runs), `stopping: true` (emitted immediately on `POST /kb/dream/stop` so the UI can show "Stopping…" state before the current batch finishes), `substep: { rawId, text }` (per-raw processing substep text, e.g. "Running CLI analysis…" or "Converting…", used by the frontend to show live progress beneath the status badge). The frame carries no full state — the frontend reacts by refetching `GET /workspaces/:hash/kb`. Fan-out is workspace-scoped and live-only: the chat router sends the frame to currently connected conversations whose workspace hash matches, and the WebSocket replay buffer does not store it. `GET /workspaces/:hash/kb` remains the source of truth after reconnect. See **KB Ingestion** under ChatService / Workspace Knowledge Base for the pipeline. |
| `error` | `error`, `terminal?`, `source?` | Error or warning. `terminal` omitted/`true` ends the current CLI turn; `terminal: false` is a non-fatal adapter warning. `source` is one of `backend`, `transport`, `abort`, or `server`. |
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

**Turn boundary behavior:** On `turn_boundary`, the accumulated `fullResponse` (text) is persisted as an intermediate assistant message whenever it is non-empty — regardless of whether any delta events carried `streaming: true`. This is load-bearing: the Claude Code adapter emits text via whole-block `assistant` events without the `streaming` flag (it never passes `--include-partial-messages`), so gating the save on delta-style streaming would silently drop every pre-tool-call segment. Any accumulated `thinking` and per-turn `toolActivity` are persisted on the same intermediate message. A `turn_complete` event is always sent to the client (even when there is no text to save), so the frontend can clear stale tool activity spinners when tools finish executing. On stream completion (`done`), if `fullResponse` is non-empty it is saved as the final assistant message; otherwise the optional `result` event content is used as the fallback body. If neither text source exists but an `artifact` block was accumulated, the artifact blocks and any associated tool activity are still saved as a final assistant message with a legacy `content` fallback like `Generated file: <name>`. In all saved cases `assistant_message` + `done` events are sent.

**Batch-index tagging:** Alongside the flat accumulator, `processStream` keeps a monotonic `batchIndex` counter and a `pendingNewBatch` flag. Every `turn_boundary` sets `pendingNewBatch = true`; the next `tool_activity` bumps `batchIndex` by one and clears the flag. The current `batchIndex` is stamped onto each activity as it lands in the accumulator (and mirrored onto its `contentBlocks` tool block). The counter is monotonic across the entire stream — it does **not** reset when the accumulator does — so tools persisted on different messages keep distinct `batchIndex` values. Because the CLI fires a `user` event (→ `turn_boundary`) exactly once per returned `tool_result`, activities emitted back-to-back without an intervening `turn_boundary` are the parallel tool_uses of a single LLM assistant turn: they share a `batchIndex`. The frontend uses this tag to group parallel tool runs correctly regardless of how slow the per-tool execution is (e.g. `Bash` shell-spawn latency can push a parallel tool's `startTime` far beyond a simple time-window threshold). Legacy `toolActivity` entries saved before this field existed have no `batchIndex` — the renderer falls back to the 500ms `startTime` proximity heuristic for those.

**Ordered `contentBlocks` accumulation:** Alongside the flat `fullResponse` / `thinkingText` / `toolActivityAccumulator` buckets, `processStream` maintains an ordered `blocks: ContentBlock[]` array that preserves the **source order** in which text / thinking / tool / artifact events arrive from the backend adapter. Both the Claude Code stream-json adapter and the Kiro ACP adapter yield their events in native backend order, so this array captures the real interleaving: e.g. `text → tool_use → text → tool_use → text`. Adjacent `text` deltas are merged into the tail `text` block (same for `thinking`); each non-plan-mode, non-question `tool_activity` event pushes a fresh `tool` block; `tool_outcomes` patches the matching tool block in place by `activity.id`; each `artifact` event pushes a fresh `artifact` block after the bytes have been persisted under the conversation's artifacts dir. At persistence time (on `turn_boundary` and `done`), durations computed from the flat accumulator are merged back into the ordered tool blocks, and the resulting `ContentBlock[]` is saved as `Message.contentBlocks`. The flat `content` string and `toolActivity[]` array continue to be saved alongside for back-compat. Messages written before this feature land carry no `contentBlocks` field — the frontend renderer detects absence and falls back to the legacy tools-then-text layout.

**Auto title update:** When a new session starts after a reset (session number > 1) and the first assistant message is saved, the server asynchronously generates a new conversation title via `generateTitle()` on the backend adapter. A `title_updated` event is sent with the new title. The title update fires only once per session (on the first assistant message) and does not block the stream.

**Usage tracking:** Backend adapters can yield `{ type: 'usage', usage: {...}, model?: string }` events. The Claude Code adapter extracts usage data (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cost_usd`) from CLI `result` events and normalises the field names to camelCase. The model is captured from the CLI's `system/init` event (`model` field) and attached to usage events. The server accumulates usage on both the conversation and active session in the workspace index via `chatService.addUsage()`, tracks per-backend breakdowns in `usageByBackend`, and records daily per-backend/model totals to `usage-ledger.json`. The forwarded `usage` event contains both conversation-level `usage` and `sessionUsage` for the active session. The frontend displays the active session token footprint in the header badge; for cache-aware backends this is `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`, with the tooltip labeling `inputTokens` as `Fresh input` so Claude Code's low fresh-input count is not mistaken for total prompt traffic. A Usage Stats tab in Settings shows per-backend/model historical data with day/week/month/all-time filtering, including separate Backend and Model columns. Backends that do not emit usage events simply leave the counters at zero.

**Abort streaming:**
- WebSocket: client sends `{ type: 'abort' }` frame; this delegates to the router's durable abort path for parity with REST.
- REST: client sends `POST /conversations/:id/abort`, which is preferred by V2 because it works even when browser WebSocket transport is disconnected.

**Send interactive input:**
- WebSocket: client sends `{ type: 'input', text: string }` frame

**Active streams management:** The router maintains two layers for accepted CLI turns through `StreamJobSupervisor`. The durable layer is `data/chat/stream-jobs.json`, managed by `StreamJobRegistry`, with lifecycle states `accepted`, `preparing`, `running`, `abort_requested`, and `finalizing` for non-terminal jobs. A job is created before request preparation mutates conversation state or appends the user message. The runtime layer is the supervisor-owned in-memory `Map<conversationId, { stream, abort, sendInput, backend, jobId, startedAt, lastEventAt, abortRequested?, abortFinalizing?, terminalFinalizing?, finalizeAbort?, done? }>` that owns the live async iterator after the backend adapter returns an abort handle. The supervisor also owns an in-memory `pendingMessageSends` map for the short async preparation window before the runtime stream attaches; each pending record carries the durable `jobId` and can carry an abort request from `POST /abort`. Only one active or pending CLI process per conversation. `POST /message` rejects with `409` when either runtime structure already contains the conversation, before appending another user message or mutating picker state. Reset blocks active and pending turns with `409`; delete/archive call the supervisor cleanup path to abort active streams, detach runtime handles, and remove durable active jobs, but still return `409` while a send is pending; update/restart guards treat active and pending turns as in flight.

`GET /active-streams` merges durable active jobs with runtime `activeStreams`, so accepted/preparing jobs appear before the backend stream object exists. Each `streams[]` item includes `id`, `jobId`, `state`, `backend`, `startedAt`, `lastEventAt`, `connected`, `runtimeAttached`, `pending`, and `runtime`; `ids[]` remains the compatibility projection.

On server startup, after `ChatService.initialize()` and before listening, leftover durable active jobs are reconciled. Recovering the exact in-flight backend stream is not attempted yet. If the recorded user message exists, the server appends a durable assistant `streamError` using either the job's recorded abort/terminal reason or `Interrupted by server restart` with `source: 'server'`, then removes the job. If that matching terminal marker is already present, reconciliation only removes the stale job. This prevents the UI from staying stuck in `streaming` and avoids re-sending prompts or duplicating tool execution.

On graceful `SIGTERM`/`SIGINT`, `chatShutdown()` asks `StreamJobSupervisor` to mark pending and runtime-attached jobs `finalizing` with `Interrupted by server shutdown` (`source: 'server'`), aborts runtime backend handles, detaches in-memory maps, and leaves those durable jobs for the next startup reconciliation pass. Planned `/server/restart` and `/update-trigger` requests still refuse to run while turns are in flight, so shutdown finalization covers external process-manager stops and unexpected signals.

The WebSocket module (`src/ws.ts`) maintains a separate `Map<conversationId, WebSocket>` for active client transports and a `Map<conversationId, ConvBuffer>` for reconnection event buffers. WebSocket close/disconnect only marks the stream buffer disconnected and continues buffering replayable stream frames; it does not abort the CLI stream. `isStreamAlive()` returns `activeStreams.has(convId)` for compatibility with tests and callers. `startStreamGracePeriod(convId)` is now a compatibility-named helper that idempotently marks the buffer disconnected/active without starting an abort timer. `lastEventAt` updates on the runtime entry on every backend stream event, so `/active-streams` can show whether a long-lived server-owned stream is still producing activity while the process remains alive. Terminal finalization is single-owner: abort finalization and backend/server terminal-error finalization share promises so concurrent Stop requests coalesce and a late abort cannot overwrite an already-committing backend/server `streamError`. Once terminal finalization starts, later backend events are ignored so an abort/backend error cannot race with a trailing `done` frame and persist duplicate partial output. Buffers are cleared before each new stream, on explicit abort, on session reset, and on delete/archive cleanup; completed buffers self-clean after `done` even when the client was connected at completion time.

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
POST /conversations/:id/attachments/ocr  [CSRF]
Content-Type: application/json
Body: { path: string }
```
One-shot OCR for an image attachment. Resolves the conversation's configured CLI profile to a vendor backend (falling back to `backend` when no profile is present), then calls `adapter.runOneShot(prompt, { allowTools: true, model, effort, workingDir, timeoutMs: 90_000, cliProfile })` with a fixed prompt that asks for clean Markdown including proper Markdown tables (`| col | col |` with `|---|---|` separator) and italic placeholders (`*[diagram: …]*`) for any non-text visuals the model cannot transcribe. The throwaway invocation does not touch the active session. Returns `{ markdown: string }` on success.

Errors:
- `400` — missing/invalid `path`, path resolves outside the conversation's `data/chat/artifacts/{id}/` dir (path-confinement check), attachment kind is not `image`, or the conversation's `cliProfileId` cannot be resolved.
- `404` — file not present on disk, or conversation not found.
- `500` — backend not registered.
- `502` — `runOneShot` threw, or returned empty output (after trim).

The composer's per-attachment OCR button (`AttChip` image branch, sits in the same slot as the dissolve button — image-only and paste-text-only buttons never co-exist on the same chip) calls this through `StreamStore.ocrAttachment(convId, attachmentId)`. The result is cached on the `PendingAttachment` (`ocrMarkdown`/`ocrStatus`/`ocrError` fields) so re-clicks insert instantly without re-spawning the CLI. The cache lives only for the lifetime of the pending attachment — once the message ships, the cache is discarded with the rest of the composer state.

```
GET /conversations/:id/files/:filename[?mode=view|download]
```
Path traversal guard. No CSRF (used by `<img>` tags and file badge cards). Serves both user-uploaded attachments and generated assistant artifacts persisted under `data/chat/artifacts/{conversationId}/`.
- **No mode (default):** Serves file directly via `res.sendFile()` (legacy, used by inline images).
- **`?mode=view`:** Returns `{ content, filename, language }` JSON for the viewer panel. Capped at 2 MB.
- **`?mode=download`:** Streams file with `Content-Disposition: attachment` header for browser download.

## 3.9 Settings

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/settings` | — | Returns settings (defaults if file missing), including `cliProfiles` and `defaultCliProfileId` server-configured defaults for the selected backend. |
| PUT | `/settings` | Yes | Normalizes and writes the full body to `settings.json`. CLI profile normalization drops invalid vendors/profile IDs, strips non-string env values, synchronizes `defaultBackend` from a valid `defaultCliProfileId`, clears invalid/disabled defaults, aligns Memory/KB legacy `*CliBackend` fields to selected `*CliProfileId` vendors, and forces Kiro profiles to self-configured mode with no `command`, `configDir`, or `env`. |
| POST | `/cli-profiles/:id/test` | Yes | Runs the vendor auth/status command for an account profile and returns `{ result, profile, settings? }`. Supported for Codex and Claude Code account profiles. If the profile has no `configDir`, the server creates and persists a default profile directory under `data/cli-profiles/` before running the check. When the profile's vendor adapter is registered, the route also calls `adapter.getMetadata({ cliProfile })` to warm/read the profile-specific model catalog and adds `modelsAvailable`, `modelCount`, or `modelListError` to `result`. Kiro and self-configured profiles return `400`. |
| POST | `/cli-profiles/:id/auth/start` | Yes | Starts a short-lived remote authentication job for a Codex or Claude Code account profile and returns `{ job, profile, settings? }`. Codex runs `codex login --device-auth` with `CODEX_HOME` set from the profile; Claude Code runs `claude auth login --claudeai` with `CLAUDE_CONFIG_DIR` set from the profile. Output is redacted and stored in the in-memory job snapshot for polling. One running job per profile is allowed. Jobs time out after 15 minutes by default, matching device-code expiry expectations. When the login process exits `0`, the server polls the vendor status command (`codex login status` or `claude auth status --json`) before marking the job `succeeded`; if status never verifies, the job becomes `failed` with the last redacted status output. |
| GET | `/cli-profiles/auth-jobs/:jobId` | — | Returns `{ job }` for a recent in-memory CLI auth job. Job snapshots include `status`, timestamps, command/args, redacted stdout/stderr/info events, and exit details. Unknown jobs return `404`. |
| POST | `/cli-profiles/auth-jobs/:jobId/cancel` | Yes | Cancels a running auth job by sending `SIGTERM` to the spawned login process and returns the updated `{ job }`. Unknown jobs return `404`. |

Conversation responses from `POST /conversations`, `GET /conversations/:id`, and rows returned by `GET /conversations` include `cliProfileId` when present. When no explicit profile is supplied, the server derives it from the selected backend as `server-configured-<vendor>`. When a profile is present, runtime adapter selection resolves through that profile's vendor while the `backend` field remains synchronized for compatibility.

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
| GET | `/workspaces/:hash/instruction-compatibility` | — | Returns `{ status }`, a computed compatibility status for native CLI instruction files. It detects `AGENTS.md` for Codex/vendor-neutral agents, `CLAUDE.md` for Claude Code, and any `*.md` under `.kiro/steering/` for Kiro. `status.shouldNotify` is true only when at least one instruction source exists, at least one supported vendor entrypoint is missing, and the current fingerprint has not been dismissed. `404` if workspace not found. |
| POST | `/workspaces/:hash/instruction-compatibility/pointers` | Yes | Creates missing thin pointer files so every supported CLI can reach the same project instructions. Exclusive-create only: never overwrites existing `AGENTS.md`, `CLAUDE.md`, or Kiro steering files. Returns `{ status, created: [{ vendor, label, path }] }`. When no pointer is needed, `created` is empty and status is returned unchanged. `404` if workspace not found. |
| PUT | `/workspaces/:hash/instruction-compatibility/dismissal` | Yes | Persists the current compatibility fingerprint to `WorkspaceIndex.instructionCompatibilityDismissedFingerprint` and returns `{ status }` with `dismissed:true` / `shouldNotify:false`. If instruction files are later added or removed, the fingerprint changes and the warning can reappear. `404` if workspace not found. |
| GET | `/workspaces/:hash/memory` | — | Returns `{ enabled: boolean, snapshot: MemorySnapshot \| null }` for the workspace. Always 200 — an enabled workspace with no entries returns `snapshot: null`. Read-only viewer endpoint consumed by the frontend memory panel. |
| PUT | `/workspaces/:hash/memory/enabled` | Yes | `{ enabled: boolean }`. Toggles the per-workspace memory switch (stored on `WorkspaceIndex.memoryEnabled`). `400` if not boolean. `404` if workspace not found. |
| DELETE | `/workspaces/:hash/memory/entries/:relpath(*)` | Yes | Deletes a single memory entry by its relative path (`claude/<name>` or `notes/<name>`). Path is validated against the workspace's memory files dir to prevent traversal (`400` on attempts). `404` if the entry doesn't exist. On success, rewrites `snapshot.json` and emits a refresh-only `memory_update` WS frame (`displayInChat:false`) to every currently connected conversation in that workspace, including idle conversations without active streams. |
| DELETE | `/workspaces/:hash/memory/entries` | Yes | Bulk-clears every memory entry for the workspace — wipes both `claude/` (CLI capture) and `notes/` (memory_note + session extraction), then rewrites `snapshot.json`. Leaves the per-workspace `memoryEnabled` flag untouched. Returns `{ ok: true, deleted: number, snapshot }`. Emits a refresh-only `memory_update` WS frame (`displayInChat:false`, empty `changedFiles`) to every currently connected conversation in that workspace, including idle conversations without active streams. No-op returns 200 with `deleted: 0` when there were no entries. Powers the "Clear all memory" button in Workspace Settings → Memory. |
| POST | `/mcp/memory/notes` | No CSRF (bearer) | Internal endpoint called by `stub.cjs` on behalf of non-Claude CLIs. Auth via `X-Memory-Token` header (per-session token minted by `memoryMcp.issueMemoryMcpSession`). Body: `{ content, type?, tags? }`. Loads the workspace snapshot for dedup context, spawns the configured Memory CLI via `runOneShot`, parses the response (either `SKIP: <filename>` or a frontmatter markdown doc), and writes new entries via `addMemoryNoteEntry`. Returns `{ ok, filename }` or `{ ok, skipped }`. `403` if memory is disabled on the workspace. |
| GET | `/workspaces/:hash/kb` | — | Returns `{ enabled: boolean, state: KbState }` for the workspace. `KbState` carries `{ version, entrySchemaVersion, autoDigest, autoDream, counters, folders[], raw[], digestProgress, updatedAt }` — `autoDream` is the normalized per-workspace Auto-Dream config (`{ mode: 'off' }` when absent), `counters` is the aggregate `{ rawTotal, rawByStatus, entryCount, pendingCount, folderCount }` used by the KB Browser header badges, `folders` is the full virtual folder tree (flat, sorted by path), and `raw` is a **single page of the currently-focused folder** (not the whole workspace). Each `raw[]` row also carries `entryCount: number` — `COUNT(entries.entry_id)` for that `rawId`, computed via a `LEFT JOIN entries ON entries.raw_id = raw.raw_id` + `GROUP BY raw_id`. Used by the KB Browser Raw tab to render an "N entries" pill on rows where `status === 'digested'`. Always `0` on rows that haven't been digested yet. `digestProgress` is a `{ done, total, avgMsPerItem, etaMs? } \| null` snapshot sourced from the persisted `digest_session` row, so a mid-flight page reload rehydrates the KB Browser toolbar's "N / M items — ~E min remaining" indicator without losing ETA accuracy; `null` when the digestion queue is idle. Query params `folder` (defaults to root `''`), `limit` (default 500), and `offset` page the raw listing. Always 200 for an existing workspace — an enabled workspace with no files yet returns an empty scaffold (`raw: []`, `folders: [{ folderPath: '', … }]`, zero counters, `digestProgress: null`). `404` if the workspace doesn't exist. Disabled workspaces return an in-memory empty scaffold without touching `state.db` so the KB Browser can still render its disabled state. |
| PUT | `/workspaces/:hash/kb/enabled` | Yes | `{ enabled: boolean }`. Toggles the per-workspace Knowledge Base switch (stored on `WorkspaceIndex.kbEnabled`). `400` if not boolean. `404` if workspace not found. Independent of the Memory toggle — enabling KB does not touch `memoryEnabled`. |
| PUT | `/workspaces/:hash/kb/auto-digest` | Yes | `{ autoDigest: boolean }`. Toggles the per-workspace auto-digest flag (stored on `WorkspaceIndex.kbAutoDigest`). When `true`, the ingestion orchestrator chains a digest run onto the queue as soon as conversion completes. When `false`, ingested files sit in `status='ingested'` until the user hits "Digest All Pending". Deleting the last location of a raw always fully purges it regardless of this flag. `400` if not boolean. `404` if workspace not found. |
| PUT | `/workspaces/:hash/kb/auto-dream` | Yes | `{ autoDream: { mode: 'off' } }`, `{ autoDream: { mode: 'interval', intervalHours: number } }`, or `{ autoDream: { mode: 'window', windowStart: 'HH:mm', windowEnd: 'HH:mm' } }`. Saves the per-workspace Auto-Dream schedule on `WorkspaceIndex.kbAutoDream`; the route also accepts the config object as the direct request body. `intervalHours` must be an integer from 1 to 8760. Window times use local server time, must be valid 24-hour `HH:mm`, and start/end cannot match. Returns `{ autoDream: <normalized config> }`, emits `kb_state_update { changed: { autoDream: true, synthesis: true } }`, and does not start a dream immediately; the background scheduler evaluates the new schedule on its next tick. `400` on validation failure. `404` if workspace not found. |
| GET | `/workspaces/:hash/kb/embedding-config` | — | Returns `{ embeddingConfig: { model?, ollamaHost?, dimensions? } \| null }`. The per-workspace embedding configuration for the PGLite vector search layer. Returns `null` when no config has been set yet (embedding is disabled). |
| PUT | `/workspaces/:hash/kb/embedding-config` | Yes | `{ model?: string, ollamaHost?: string, dimensions?: number }`. Saves the per-workspace embedding configuration. `model` must be a string (Ollama model name), `ollamaHost` a string (URL), `dimensions` a positive integer. `400` on type validation failure. `404` if workspace not found. When model or dimensions change from a previously saved value, the cached vector store is closed and evicted so the next access rebuilds the PGLite schema with the new dimensions (wiping existing embeddings). |
| POST | `/workspaces/:hash/kb/embedding-health` | Yes | Tests Ollama connectivity and model availability using the workspace's embedding config (or defaults). Returns `{ ok: boolean, error?: string }`. `ok: true` means Ollama is reachable and the configured model returns a non-empty embedding. |
| POST | `/workspaces/:hash/kb/raw` | Yes | `multipart/form-data` with a single `file` field (max 1 GB) and an optional `folder` text field (defaults to root `''`). Hashes the buffer to derive `rawId = sha256[:16]`, stages `raw/<rawId>.<ext>`, and inserts the `raw` row + a `raw_locations` row (one per `(rawId, folder, filename)` tuple) inside a transaction before returning. A background conversion job is scheduled on the workspace's FIFO queue; `_scheduleConversion` also chains a digest run when `kbAutoDigest` is true. Returns **202** with `{ entry: KbRawEntry, deduped: boolean, addedLocation: boolean }`. `deduped: true` means the same `sha256` already exists in the workspace — the orchestrator only inserts a new `raw_locations` row for the new `(folder, filename)` tuple and reuses the raw bytes + conversion output (Option B multi-location). `400 { error: "KB disabled" }` if KB is off, `400` if no file field, `409 KbLocationConflictError` if a different file already occupies `(folder, filename)`, `400 KbValidationError` for invalid filenames/folder segments, `400 { error: "File exceeds the 1 GB upload limit." }` for `LIMIT_FILE_SIZE`. **Pre-flight format guards** still apply: `400` for `.doc` and `400` for `.docx` when pandoc is unavailable — both checks run before any DB rows are created. Emits `kb_state_update` frames on every state mutation (stage, conversion complete, digest complete) with `changed: { raw: [rawId], folders: true }`. **Multi-file client behavior:** The frontend supports multi-file and folder selection, building a client-side queue of `{ file, folderPath }` items and draining it with bounded concurrency (3 parallel XHR uploads) against this same single-file endpoint. Browser `File` objects are lightweight handles — holding tens of thousands is cheap. Error handling is per-item: 400/409 are non-retryable, 401 pauses the entire queue, 500/network errors auto-retry up to 2 times with backoff. Deduped responses (`deduped: true, addedLocation: false`) are surfaced as "Already in KB" in the batch progress UI. No backend changes were required. |
| DELETE | `/workspaces/:hash/kb/raw/:rawId` | Yes | Two modes: (1) **Per-location delete** — when the query string carries both `?folder=…&filename=…`, removes only that single `raw_locations` row. If other locations still reference the rawId the raw row stays; if this was the last location the raw is fully purged (bytes + converted + entries + DB row). (2) **Full purge** — when called without query params, cascade-deletes every `raw_locations` row, the `raw` row, the raw bytes, the `converted/<rawId>/` directory, any digested entries (and `entries/<entryId>/` dirs) — bypassing ref-counting. Returns `{ ok: true }` on success, `404 { error: "Location not found." }` for an unknown `(rawId, folder, filename)` tuple, `404 { error: "Raw file not found." }` for an unknown rawId during full purge, `400` if KB is disabled. The `rawId` must match `^[a-f0-9]{1,64}$` or the route returns `400`. Emits a `kb_state_update` frame on success. |
| POST | `/workspaces/:hash/kb/raw/:rawId/digest` | Yes | Manually trigger digestion for a single raw file (the Raw tab's per-row **Digest now** button). **Fire-and-forget:** returns `202 { accepted: true }` immediately and enqueues a digest job on the workspace FIFO queue (shared with ingestion). The background job flips the raw row to `digesting`, runs the Digestion CLI, parses entries, writes them under `entries/<entryId>/entry.md`, inserts rows in the `entries` + `entry_tags` tables, then flips the raw row to `digested` (or `failed` with an `errorClass` of `timeout \| cli_error \| malformed_output \| schema_rejection \| unknown`). Failures are logged server-side via `.catch()` and surfaced to the UI through `kb_state_update` WS frames + 1500ms polling — the frontend does **not** alert on HTTP errors from this route. Non-eligible statuses (`ingesting`, `digesting`, already `digested`, `failed`) resolve without mutating state. Contributes to the aggregate `digestProgress` session (see `POST /kb/digest-all`) — a single-file trigger either opens a new session with `total=1` or bumps the `total` of an in-flight session. `400` when KB is disabled. |
| POST | `/workspaces/:hash/kb/digest-all` | Yes | Batch-digest every eligible raw file in the workspace (`status='ingested'`; any lingering `pending-delete` rows are purged without digestion). **Fire-and-forget:** returns `202 { accepted: true }` immediately and enqueues the batch on the workspace FIFO queue. Progress is reported via the **aggregate per-workspace digestion session**: the first enqueue into an idle queue opens a session (persisted to `digest_session`), and `kb_state_update` frames carry `changed.digestProgress: { done, total, avgMsPerItem, etaMs? }` on every enqueue and every task settle; a final `digestProgress: null` signal fires when the queue drains so the toolbar indicator clears. The same session spans batch, single-file manual (`/digest`), and auto-digest runs — so a single-file upload that lands mid-batch bumps `total` instead of opening a parallel counter. `etaMs` is withheld until `done >= 2` to avoid first-sample noise. Failures are logged server-side and surfaced per-row via `errorClass`/`errorMessage` in the KB state. `400` when KB is disabled. |
| GET | `/workspaces/:hash/kb/entries` | — | Returns `{ entries: KbEntry[], total: number }` — a paginated, filtered list of digested entries ordered by `title`. `total` is the pre-pagination match count used by the UI to render the pagination bar. Query params: `folder` (filters via `raw_locations` join), `tag` (single-tag filter via `entry_tags` join, legacy), `tags` (comma-separated multi-tag list — **AND semantics**, an entry must carry every tag; merges with `tag` when both are supplied), `rawId` (direct filter), `search` (case-insensitive substring match on the entry title **or** any source filename in `raw_locations` for the parent raw — the SQL clause is `(e.title LIKE ? OR EXISTS (SELECT 1 FROM raw_locations rl WHERE rl.raw_id = e.raw_id AND rl.filename LIKE ?))`, both sides bind the same escaped needle; `%` and `_` are escaped so they match literally; folder path is **not** included in the match), `uploadedFrom` / `uploadedTo` (ISO-8601 inclusive bounds on `raw.uploaded_at`, joins the `raw` table), `digestedFrom` / `digestedTo` (ISO-8601 inclusive bounds on `entries.digested_at`), `limit` (default 500), `offset`. All filters combine with AND semantics; empty-string values are treated as "no filter." Each `KbEntry` is the metadata row (`entryId`, `rawId`, `title`, `slug`, `summary`, `schemaVersion`, `staleSchema`, `digestedAt`, `tags[]`) — the full markdown body is served by the per-entry endpoint below. Returns `{ entries: [], total: 0 }` when KB is disabled or the DB hasn't been opened yet (no 404). |
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
| GET | `/workspaces/:hash/kb/synthesis` | — | Returns `{ status, stopping, lastRunAt, lastRunError, topicCount, connectionCount, needsSynthesisCount, reflectionCount, staleReflectionCount, godNodes[], dreamProgress, autoDream, topics[], connections[] }`. `stopping` is `true` when a cooperative stop has been requested for an in-progress run (reflects `isStopRequested(hash)`). `dreamProgress` is `{ phase, done, total } | null` — non-null when a dream is in progress. `autoDream` mirrors the per-workspace config and adds scheduler display fields: `nextRunAt`, and for window mode `windowActive` plus `windowEndAt`. `reflectionCount` is the total number of reflections; `staleReflectionCount` is the count of reflections with stale citations (a reflection is stale if any cited entry was re-digested, deleted, or lost citations via cascade since the reflection was created). Topics carry `{ topicId, title, summary, entryCount, connectionCount, isGodNode }`. Connections carry `{ sourceTopic, targetTopic, relationship, confidence }`. `404` if KB DB not found. |
| GET | `/workspaces/:hash/kb/synthesis/:topicId` | — | Returns a single topic detail: `{ topicId, title, summary, content, updatedAt, entryCount, connectionCount, isGodNode, entries[], connections[] }`. `entries` is the full entry metadata array. `404` if topic not found or KB DB not found. |
| GET | `/workspaces/:hash/kb/reflections` | — | List all reflections. Returns `{ reflections: [{ reflectionId, title, type, summary, citationCount, createdAt, isStale }] }`. Stale detection: a reflection is stale if any cited entry was re-digested or deleted since the reflection was created. |
| GET | `/workspaces/:hash/kb/reflections/:reflectionId` | — | Single reflection detail. Returns `{ reflectionId, title, type, summary, content, createdAt, citationCount, citedEntries: KbEntry[] }`. `404` if not found. |

| GET | `/workspaces/:hash/files` | — | Serves a file from the workspace's working directory for file delivery cards and workspace-local assistant Markdown file-link previews. Required query param `path` (absolute file path without any UI-only `:line` suffix). Optional `mode`: `view` returns `{ content, filename, language }` JSON (capped at 2 MB), `download` (default) streams the file with `Content-Disposition: attachment`. Path traversal protection: resolved path must be under the workspace root. `400` if path missing or not a file. `403` if path is outside workspace. `404` if file or workspace not found. `413` if file exceeds 2 MB in view mode. |

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

**V2 frontend integration (`public/v2/src/screens/filesBrowser.jsx`):** a React port of the same model. The same endpoints back a `<FilesBrowser hash label onClose>` component swapped into the main pane (sibling to the v2 KB Browser) when the Sidebar's per-workspace Files button fires `onOpenFiles(hash, label)`. All fetches go through `AgentApi.explorer` (see `spec-frontend.md`); the upload path uses XHR so per-file progress bars can render in the bottom-of-tree `<FxUploadPanel>`. 409 conflicts on upload or rename prompt a `window.confirm` to retry with `overwrite: true`.

## 3.13 Version & Self-Update

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/version` | — | `{ version, remoteVersion, updateAvailable }` |
| GET | `/update-status` | — | Cached status: `{ localVersion, remoteVersion, updateAvailable, lastCheckAt, lastError, updateInProgress }` |
| POST | `/check-version` | Yes | Triggers immediate remote check, returns status. |
| POST | `/update-trigger` | Yes | Full update sequence (see Section 4, UpdateService). Refuses while any conversation turn is active or still in the pending-send setup window. |
| POST | `/server/restart` | Yes | Plain pm2 restart (no git pull / npm install) via `UpdateService.restart()`. Returns `409` if an update is in progress or any conversation turn is active or still in the pending-send setup window. Used by the Server tab in Global Settings so users can re-trigger startup-time detection (e.g. pandoc) after installing external binaries. |

## 3.13.1 CLI Updates

CLI update status covers the local vendor CLIs used by configured CLI profiles. The server groups profiles by `(vendor, command, PATH)` so multiple profiles that resolve to the same binary produce one status row with multiple `profileIds`/`profileNames`.

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/cli-updates` | — | Returns the cached snapshot from `CliUpdateService`: `{ items: CliUpdateStatus[], lastCheckAt: string \| null, updateInProgress: boolean }`. This route does not force a fresh subprocess/network check; it is safe for the web UI to poll. |
| POST | `/cli-updates/check` | Yes | Forces an immediate check and returns the same snapshot shape. Checks run CLI version commands, resolve the command path, detect supported install methods, and query latest npm package versions when applicable. |
| POST | `/cli-updates/:id/update` | Yes | Runs the supported updater for one status item, then re-probes the CLI. Returns `{ success, item?, steps, error? }`. Returns `409` when any conversation turn is active or still in the pending-send setup window; returns `400` for unsupported install methods, missing targets, and command failures. On success the router calls `backendRegistry.shutdownAll()` so long-lived backend processes are restarted on next use with the updated binary. |

`CliUpdateStatus`:

```ts
{
  id: string;                         // `${vendor}:${sha1(vendor, command, PATH).slice(0, 12)}`
  vendor: 'claude-code' | 'codex' | 'kiro';
  label: string;                      // "Claude Code", "Codex", or "Kiro"
  command: string;
  resolvedPath: string | null;
  profileIds: string[];
  profileNames: string[];
  installMethod: 'npm-global' | 'self-update' | 'unknown' | 'missing';
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  updateSupported: boolean;
  updateInProgress: boolean;
  lastCheckAt: string | null;
  lastError: string | null;
  updateCommand: string[] | null;
}
```

Supported update methods:

- Codex and Claude Code installed from global npm packages are updated with `npm i -g <package>@latest` after the service verifies the resolved command lives under `npm root -g/<package>`.
- Kiro exposes a self-updater command (`kiro-cli update --non-interactive`), so the service records `installMethod: 'self-update'` and `updateSupported: true`, but it currently has no latest-version source and therefore does not raise `updateAvailable` from background checks. Settings can still run the updater manually; the composer notification does not appear without `updateAvailable`.
- Unknown, missing, native, or otherwise unmanaged installs are shown in Settings with diagnostics but do not render the composer update notification or enable the update action.

## 3.14 Claude Code Plan Usage

Account-wide Claude Code plan usage snapshot (5-hour session %, weekly %, per-model breakdown, reset times, plan tier, optional extra-credit balance). Surfaced in the ContextChip tooltip on Claude Code conversations. The default route reads the server-configured Claude cache; an optional `cliProfileId` reads the selected Claude profile cache.

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/plan-usage?cliProfileId=<id>` | — | Returns the last cached snapshot. **Does not trigger a refresh.** Omitting `cliProfileId` reads the server-configured Claude Code cache from `data/claude-plan-usage.json`. Supplying `cliProfileId` resolves that profile, requires `vendor: "claude-code"` and not disabled, then reads the profile cache from `data/claude-plan-usage/<encoded-profile-id>.json`; missing/disabled/non-Claude profiles return `400 { error }`. Response: `{ fetchedAt: string \| null, planTier: string \| null, subscriptionType: string \| null, rateLimits: RateLimits \| null, lastError: string \| null, stale: boolean }`. `fetchedAt` is ISO-8601 of the last successful fetch (`null` before the first ever fetch). `planTier` mirrors the OAuth credential's `rateLimitTier` (e.g. `default_claude_max_20x`). `subscriptionType` mirrors the credential's `subscriptionType` (e.g. `max`). `lastError` is the last fetch failure message (`token-expired`, HTTP 4xx/5xx, or network error) — cleared on success. `stale: true` when `Date.now() - fetchedAt > 15 min` or no fetch has landed yet. |

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

**Refresh trigger policy:** The service behind this endpoint refreshes opportunistically from two triggers — server startup for the default server-configured runtime (once, via `init()` + `maybeRefresh('server-start')`) and after each Claude Code assistant turn (`onDone` callback in the chat router calls `maybeRefresh('turn-done', runtime.profile)`). A floor of 10 minutes between attempts is tracked per cache key/profile and by last attempt time, not last success, protecting against rate-limit retry storms. The HTTP route itself never forces a fetch — it only reads the selected cache. Plain server-configured profiles share the default cache for compatibility with the current ContextChip UI. Other backends (Kiro, etc.) do not trigger refreshes.

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

## 3.16 Codex Plan Usage

Account-wide OpenAI Codex (ChatGPT) plan-usage snapshot — plan tier (Plus / Pro / Business / Enterprise / etc.), 5-hour rate-limit window utilization, weekly rate-limit window utilization, and optional credit balance. Surfaced in the ContextChip tooltip on Codex conversations. The service spawns a one-shot Codex `app-server` using the server-configured runtime or the requested Codex CLI profile and calls its `account/read` + `account/rateLimits/read` JSON-RPC methods — it does **not** piggyback on the long-lived `app-server` instance owned by `CodexAdapter` (the latter is bound to a specific conversation thread).

| Method | Path | CSRF | Description |
|--------|------|------|-------------|
| GET | `/codex-plan-usage?cliProfileId=<id>` | — | Returns the last cached snapshot. **Does not trigger a refresh.** Omitting `cliProfileId` reads the server-configured Codex cache from `data/codex-plan-usage.json`. Supplying `cliProfileId` resolves that profile, requires `vendor: "codex"` and not disabled, then reads the profile cache from `data/codex-plan-usage/<encoded-profile-id>.json`; missing/disabled/non-Codex profiles return `400 { error }`. Response: `{ fetchedAt: string \| null, account: CodexAccount \| null, rateLimits: CodexRateLimits \| null, lastError: string \| null, stale: boolean }`. `fetchedAt` is ISO-8601 of the last successful fetch (`null` before the first ever fetch). `lastError` is the last fetch failure message (`<command> app-server unavailable: …` for missing CLI, RPC error string, or `codex app-server closed`) — cleared on success. `stale: true` when `Date.now() - fetchedAt > 15 min` or no successful fetch has landed yet. |

**`CodexAccount` shape** — normalized from the `account/read` RPC response (`raw.account`):

```ts
{
  type:     string | null,  // e.g. "chatgpt"
  email:    string | null,
  planType: string | null,  // "free" | "go" | "plus" | "pro" | "prolite" | "team" |
                            // "self_serve_business_usage_based" | "business" |
                            // "enterprise_cbp_usage_based" | "enterprise" | "edu" | "unknown"
}
```

**`CodexRateLimits` shape** — normalized from the `account/rateLimits/read` RPC response (`raw.rateLimits`):

```ts
{
  limitId:              string | null,
  limitName:            string | null,
  primary: {
    usedPercent:        number | null,  // 0..100
    windowDurationMins: number | null,  // 300 = 5h
    resetsAt:           number | null,  // epoch SECONDS (not ms, not ISO string)
  } | null,
  secondary: {
    usedPercent:        number | null,
    windowDurationMins: number | null,  // 10080 = weekly (7d)
    resetsAt:           number | null,
  } | null,
  credits: {
    hasCredits: boolean,                // strict === true after coercion
    unlimited:  boolean,                // strict === true after coercion
    balance:    string | null,          // pre-formatted by Codex (e.g. "0", "12.50")
  } | null,
  planType:             string | null,  // duplicates the account-level planType for convenience
  rateLimitReachedType: string | null,  // null when neither window is exhausted
}
```

**Window slot semantics:** The frontend keys bar labels off `windowDurationMins` (300 → "5h session", 10080 → "Weekly"), not slot order. A future Codex API change that swaps `primary` / `secondary` won't mislabel the bars.

**Refresh trigger policy:** The service refreshes opportunistically from two triggers — server startup for the default server-configured runtime (once, via `init()` + `maybeRefresh('server-start')`) and after each Codex assistant turn (`onDone` callback in the chat router calls `maybeRefresh('turn-done', runtime.profile)`). A floor of 10 minutes between attempts is tracked per cache key/profile and by last attempt time, not last success, protecting against rate-limit retry storms. The HTTP route itself never forces a fetch — it only reads the selected cache. Other backends (Claude Code, Kiro) do not trigger this service's refreshes.

See Section 4.6 (`CodexPlanUsageService`) for the spawn / RPC / kill semantics.

## 3.17 Error Response Patterns

| Status | Meaning | Body |
|--------|---------|------|
| `400` | Bad input | `{ error: "message" }` |
| `401` | Session expired / not authenticated (API routes only) | `{ error: "Not authenticated" }` |
| `403` | CSRF failure or access denied | `{ error: "Invalid CSRF token" }` |
| `404` | Not found | `{ error: "Conversation not found" }` etc. |
| `409` | Conflict | `{ error: "Cannot reset session while streaming" }`, `{ error: "Conversation is already streaming" }`, or endpoint-specific conflict errors |
| `500` | Server error | `{ error: err.message }` |

Unauthenticated requests to `/api/*` return `401 { error: "Not authenticated" }` as JSON so the client can react without trying to parse an HTML login page. All other unauthenticated requests redirect to `/auth/login`.
