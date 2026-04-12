# 6. Frontend Behavior

[← Back to index](SPEC.md)

---

**Files:** `public/index.html`, `public/js/*.js` (11 ES modules), `public/styles.css`

Vanilla JavaScript SPA — no framework, no bundler, no build step. Frontend is split into native ES modules (`<script type="module">`) loaded from `public/js/main.js`. Uses marked (CDN) for Markdown and highlight.js (CDN) for syntax highlighting. Shared mutable state lives in a single `state` object exported from `state.js`. Circular dependencies between modules are avoided via late-binding callback patterns (e.g. `setStreamEventHandler()` in `websocket.js`). Functions called from inline `onclick` in dynamically generated HTML are assigned to `window` in `main.js`. (Backend is TypeScript; frontend remains vanilla JS.)

## Layout

- Flexbox: sidebar (fixed 280px) + main area (flex: 1)
- Sidebar: new chat button, search, conversation list grouped by workspace, settings, sign out, version label
- Main area: header with title + usage indicator + action buttons, messages container, input area with backend selector + model selector + effort selector + file chips + textarea
- Responsive: below ~768px sidebar overlays content

## Conversation Management

- **New conversation:** folder picker modal (via `/browse` API) → user selects directory → POST creates conversation with the user's `defaultBackend` and `defaultModel` from settings
- **Sidebar list:** grouped by workspace (last 2 path segments of `workingDir`), sorted by `updatedAt` desc. Groups are collapsible (state in localStorage). Each group header has a pencil icon for workspace instructions.
- **Context menu:** right-click on conversation items for rename/archive/delete (active view) or restore/delete (archive view)
- **Archive:** conversations can be archived via context menu. Archived conversations are hidden from the main sidebar but all files (sessions, artifacts) remain on disk. A toggle at the bottom of the sidebar switches between active and archived views. Archived conversations can be browsed, searched, restored, or permanently deleted.
- **Search:** debounced, case-insensitive search across titles, last messages, and full content. Respects active/archive view filter.

## Messaging & Streaming

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

## File Handling

- Files upload **immediately on attach** (not at send time) via XHR with per-file progress tracking
- Sources: drag-and-drop, clipboard paste (images + large text ≥1000 chars), file picker button
- `chatEnsureConversation()` auto-creates conversation on first file attach (promise-cached for concurrent calls)
- File chips show progress bar, checkmark on completion, error indicator on failure
- Remove button: aborts in-progress upload or DELETEs completed file
- At send time: completed file paths embedded as `[Uploaded files: /path/to/file1, ...]`
- **Inline images:** `chatRenderUploadedFiles()` replaces `[Uploaded files: ...]` with `<img>` tags for image extensions (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`). Click opens lightbox overlay.

## Draft Persistence

- `chatSaveDraft()` / `chatRestoreDraft()` — per-conversation drafts stored in `chatDraftState` Map keyed by convId (or `'__new__'` for unsaved conversations)
- Drafts include textarea text + pending files
- Saved on conversation switch/blur, restored on switch/select
- `'__new__'` key migrated to real convId on conversation creation
- Cleared on message send

## Session Management

- **Reset:** archives active session with LLM summary, creates new session, resets conversation title to "New Chat" in both header and sidebar. Shows an "Archiving session..." indicator bubble branded with the Agent Cockpit logo and name (not the CLI backend icon, since archival is a cockpit-level action). Blocked during streaming. Double-click prevented via `chatResettingConvs` set. Header title is also synced from server data whenever the conversation list reloads (via `chatLoadConversations`), ensuring the header stays consistent even if the inline update is missed. `chatLoadConversations` uses a generation counter to discard stale responses, preventing race conditions where an older response overwrites a title that was already updated by a `title_updated` event. A final `chatLoadConversations()` call in the streaming `finally` block ensures the sidebar and header reflect the latest server state after streaming ends.
- **History modal:** lists sessions with summaries, view and download buttons
- **View session:** fetches archived messages from API

## Settings Modal

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

## Workspace Settings Modal

Triggered by the pencil icon on workspace group headers. Multi-tab modal:

- **Instructions tab:** per-workspace instructions textarea; fetches/saves via the workspace instructions API.
- **Memory tab:** enable/disable toggle (persists immediately to `WorkspaceIndex.memoryEnabled`), plus a read-only browser of the workspace memory snapshot grouped by type (User / Feedback / Project / Reference / Other). Each entry has an inline delete icon that calls `DELETE /workspaces/:hash/memory/entries/:relpath`. Below the browser is a **Clear all memory** button that calls `DELETE /workspaces/:hash/memory/entries` (bulk) after a confirmation dialog — wipes every entry for the workspace but leaves the enabled flag untouched.
- **Knowledge Base tab:** enable/disable toggle (persists immediately to `WorkspaceIndex.kbEnabled`). When enabled, the workspace-group header in the sidebar shows a dedicated **KB** button (next to the existing pencil icon) that opens the full-screen KB Browser — the browser replaces the chat message area rather than living inside the modal.

## Knowledge Base Browser

The **KB Browser** is a full-screen panel that swaps into the main chat area (hiding the active conversation) when the user clicks the **KB** icon on a workspace-group header in the sidebar. It is implemented inline in `public/js/main.js` — look for the `chatKbBrowser*` functions.

- **Entry point:** `chatKbBrowser.chat-conv-group-kb-btn` click handler (wired in `chatWireEvents`) reads `data-kb-hash` and `data-kb-label` off the button and calls `chatOpenKbBrowser(hash, label)`. The button is only rendered for workspace groups that have a real hash **and** whose `workspaceKbEnabled` flag is `true` (so the "ungrouped" placeholder never gets one, and workspaces with KB disabled in settings don't advertise an entry point). The flag is sourced from `ConversationListItem.workspaceKbEnabled` in the sidebar payload; toggling KB on/off via the settings modal calls `chatLoadConversations()` so the sidebar button appears/disappears without a page reload.
- **Layout:** A `<div class="chat-kb-browser">` sibling of `#chat-messages` with a header (workspace label + KB counter pills + close button), a tab row (**Raw** / **Entries** / **Synthesis** / **Settings** — all four wired), and a tab-specific body. Opening the browser hides `#chat-messages` and the input area; closing restores them.
- **Header counters:** The header renders pills for `raw: N`, `entries: N`, and `pending: N` sourced from `state.counters` on every refetch. Counter text updates in place during polling so the user sees counts tick up as uploads/digests complete without scrolling or tab-switching.
- **Polling:** While the browser is mounted, `chatKbBrowserState.pollTimer` runs `chatKbBrowserRefetch()` every **1500 ms** against `GET /workspaces/:hash/kb?folder=<selectedFolder>` (or `GET /kb/entries?folder=…` on the Entries tab). Polling is required because WS frames are conversation-scoped — the browser can be open for a workspace that has no active CLI stream. On close, the timer is cleared.
- **WS frame reactivity:** `streaming.js` dispatches `kb_state_update` frames to `window.chatHandleKbStateUpdate(convId, event)`. The handler checks whether the browser is open for the same workspace hash and, if so, triggers an immediate refetch (in addition to the polling cadence) so changes during active CLI streams render without waiting for the next poll tick.
- **Toolbar:** A single row above the tab body carries the workspace-wide controls:
  - **Auto-digest switch** — reads `state.autoDigest`, flips via `PUT /kb/auto-digest`. Changing the switch does not kick off any work itself; it only changes how subsequent uploads and deletes behave.
  - **+ Folder** button — prompts for a folder path (accepts nested paths like `ops/weekly`), hits `POST /kb/folders`, selects the new folder in the tree on success.
  - **Digest All Pending** button — disabled when `counters.pendingCount === 0`. Label is `Digest All Pending (N)` so the badge count is always visible. Clicking fires `POST /kb/digest-all`; while the batch runs, incoming `kb_state_update` frames carry `batchProgress: { done, total }` and the button label flips to `Digesting…` with the button itself disabled. A separate **batch progress counter** (`"3 of 8 done"`) appears next to the button to show live aggregate progress.
- **Raw tab:** Two-column layout — a **folder tree sidebar** on the left and a **main content area** on the right.
  - **Folder tree** — rendered from `state.folders` as a flat list indented by `folder_path` depth. Root is the implicit top node. Each folder row has its path label + hover-revealed **Rename** / **Delete** buttons (rename prompts for a new path → `PUT /kb/folders`; delete warns about cascading children → `DELETE /kb/folders?folder=…&cascade=true`). Clicking a folder sets `chatKbBrowserState.selectedFolder` and immediately refetches the raw list scoped to that folder.
  - **Breadcrumb** — above the file list, `chatKbBrowserFormatBreadcrumb` renders the current folder path as clickable segments (each hops to that ancestor), with `Root` as the leftmost crumb.
  - **Dropzone + list** — drag-and-drop or click-to-browse uploads into the currently-selected folder. The client adds the selected folder as a `folder` multipart field so the server inserts the location under the right path. A row appears on the next refetch in `ingesting` state and flips to `ingested`/`digested` as the pipeline advances. Each row renders filename, size, relative upload time, the colored status badge (`ingesting | ingested | digesting | digested | failed | pending-delete`), a **Download** anchor (`GET /kb/raw/:rawId`), a **Digest now** button (shown only for `ingested | pending-delete | failed` rows — POSTs to `POST /kb/raw/:rawId/digest`), and a per-location **Delete** button that sends `DELETE /kb/raw/:rawId?folder=<folder>&filename=<name>`. **Status badge colors:** `ingested` = green (`#7fd4a6` on `#1f3e32`), `digested` = blue (`#82b1ff` on `#1a2f4a`), `ingesting`/`digesting` = purple pulse. **Processing progress:** when a raw item is in `ingesting` or `digesting` state, a substep line appears beneath the row showing: (1) the current substep text from `kb_state_update` `substep` frames (e.g. "Converting…", "Running CLI analysis…", "Parsing entries…") and (2) an elapsed-time counter that ticks from when the processing started (e.g. "3m 42s"). Start times are tracked in `chatKbBrowserState.processingStartTimes[rawId]` and cleared when the status changes. Failed rows expand to show the `errorClass` + `errorMessage` from the state entry. Pending-delete rows render a muted italic treatment to distinguish them from normal ingested rows. While the upload is in flight a progress bar appears below the dropzone — `chatKbUploadFile` uses `XMLHttpRequest` (not `fetch`, which cannot report upload progress) and drives `xhr.upload.onprogress` to update a determinate fill with "Uploading {name} — {pct}% ({loaded} / {total})"; when all bytes have left the client (`xhr.upload.onload`) the fill switches to an indeterminate "Processing {name}…" animation until the server responds, and the bar hides in the `finally` block. While `chatKbBrowserState.uploading` is true, `chatKbBrowserRenderTab()` returns early so the 1500ms poll timer and WS frames cannot replace innerHTML and orphan the live DOM references held by the XHR callbacks. Scroll position is preserved across re-renders by saving/restoring `scrollTop` on the `.chat-kb-browser` container (the actual overflow parent), not on `.chat-kb-raw-main`.
- **Entries tab:** Two-column layout — a list of every digested entry on the left, a detail pane on the right. Scroll position is preserved across re-renders by saving/restoring `scrollTop` on the inner scrollable elements (`.chat-kb-entries-list` and `.chat-kb-entry-detail`), not just the outer `#chat-kb-browser` container.
  - **List** — `GET /kb/entries?folder=<selectedFolder>` returns title + summary + tags + `rawId`. Rows are ordered by title. Clicking a row calls `GET /kb/entries/:entryId` to populate the detail pane.
  - **Detail pane** — renders the entry title, summary, tags, and the full `entry.md` body. YAML frontmatter is stripped client-side before rendering so the user only sees the prose. A "parent raw" link below the title jumps back to the Raw tab and scrolls to the source row.
  - **Folder filter** — the Entries tab honors the same `selectedFolder` state the Raw tab uses, so clicking a folder in the Raw tree and then switching to Entries shows only the entries whose parent raw has a location in that folder (via the `raw_locations` join inside `listEntries`).
- **Delete semantics:** Per-location deletes on the Raw tab hit `DELETE /kb/raw/:rawId?folder=<f>&filename=<n>` and respect ref-counting — deleting the last location of a raw file always fully purges it (bytes + converted + entries + DB row), regardless of auto-digest setting. Folder-cascade deletes follow the same rule.
- **Download:** The Download link is a plain `<a href="/api/chat/workspaces/:hash/kb/raw/:rawId" target="_blank">` — the server sets `Content-Disposition: inline` so the browser either previews or downloads based on MIME type.
- **Synthesis tab:** Interactive D3.js force-directed graph showing topics as nodes and topic-to-topic connections as edges. Vendored `d3.min.js` (v7, ~280KB) loaded via `<script>` tag before `main.js`. Action bar above the graph has **Dream** (incremental) and **Re-Dream (full rebuild)** buttons, a status line (last run time, pending count, last error), the dream pipeline stepper (when running), and a search input. Dream/Re-Dream buttons return a 400 error (shown via `chatShowAlert`) when there are no entries to process. Dream/Re-Dream buttons are disabled while a dream is running. The Re-Dream button shows a destructive confirmation dialog before proceeding. The tab auto-fetches synthesis data from `GET /workspaces/:hash/kb/synthesis` on activation.
  - **Graph nodes:** Each node is a circle whose radius scales by entry count (min 16, max 28). God-node topics have a warm amber tint; regular topics use a subtle slate fill. Each node displays only the entry count number — topic title is available via native `<title>` tooltip (full title + entry/connection counts) and the click popup. Colors are read from CSS custom properties at init time for theme compatibility.
  - **Graph edges:** Lines styled by confidence level — solid for `extracted`, dashed for `inferred`, dotted for `speculative`. All edges use a single muted color with varying opacity (0.45/0.30/0.15 by confidence). Arrowhead markers per confidence type. No edge labels (relationship text is shown in the node click popup).
  - **Zoom-based labels:** When zoomed past 1.5x, a short label (first 2 words of the topic title) appears beneath each node. Labels fade in/out at the threshold. At default zoom only the entry count number is visible.
  - **Interaction:** Nodes are draggable (D3 drag behavior). SVG supports zoom/pan (D3 zoom, scale 0.1–4x). Clicking a node populates the detail panel; clicking the SVG background clears it.
  - **Detail panel:** Fixed 280px right panel beside the graph (`.chat-kb-graph-panel`). Shows "Click a node to view details" when empty. On node click, displays: topic title, god-node star, entry/connection counts, then fetches topic detail from `GET /workspaces/:hash/kb/synthesis/:topicId` and renders an entry list and a connections list (with confidence badges and relationship labels). The panel is scrollable for topics with many entries.
  - **Search:** Text input filters nodes by title — matching nodes stay at full opacity, non-matching nodes and unrelated edges fade to 0.15/0.05 opacity. The view auto-zooms to the first matching node.
  - **Dream pipeline stepper:** when a dream is running, a four-step pipeline stepper appears next to the buttons showing `Routing N/M` → `Verification N/M` → `Synthesis N/M` → `Discovery N/M` with the active phase highlighted (purple background), completed phases showing a checkmark (green), and upcoming phases dimmed. The stepper dynamically renders whichever phases are emitted (some runs skip Verification if there are no borderline matches; Discovery may have 0 candidates). An elapsed timer (e.g., "— 2:34") appears next to the active step and resets each time the phase or done count changes. The backend emits an initial `done: 0` frame before the first CLI call, so "Starting..." only appears for 1-2 seconds. Progress data comes from `kb_state_update` `dreamProgress` frames with `phase: 'routing' | 'verification' | 'synthesis' | 'discovery'`. During dream polls, only the stepper and status line are patched in-place (`chatKbSynthesisInPlaceUpdate`) — the D3 graph is not re-initialized.
- **Dream banner** (chat input area): A `#chat-dream-banner` div above the model-select row in the chat input wrapper. Behavior:
  - When `conv.kb.dreamingNeeded` and `pendingEntries > 0`: shows "{icon} N entries awaiting synthesis" + a **Dream now** button.
  - When `conv.kb.dreamingStatus === 'running'`: shows "Dreaming in progress" + the same pipeline stepper used by the Synthesis tab (Routing → Verification → Synthesis → Discovery with active/done/pending states and batch counters).
  - Otherwise hidden.
  - Button click fires `POST /workspaces/:hash/kb/dream` and optimistically sets status to running. Progress updates arrive via `kb_state_update` WS frames with `dreamProgress` field. On completion, a conversation refetch updates the banner state.
  - The banner updates on: conversation selection (`chatSelectConversation`), `kb_state_update` events for the active conversation.
- **Settings tab:** Per-workspace embedding configuration for the PGLite vector search layer. Contains a form with three fields:
  - **Model** — Ollama model name (default `nomic-embed-text`). Text input.
  - **Ollama Host** — Server URL (default `http://localhost:11434`). Text input.
  - **Dimensions** — Embedding vector size (default `768`). Number input, min 1, max 4096.
  - **Test Connection** button — fires `POST /workspaces/:hash/kb/embedding-health` and shows a health indicator: green "Connected", red error message, or "Checking…" spinner.
  - **Save** button — fires `PUT /workspaces/:hash/kb/embedding-config` with the form values. Alerts on success/failure via `chatShowAlert`.
  - Config is fetched from `GET /workspaces/:hash/kb/embedding-config` on first tab activation and cached in `chatKbBrowserState.embedding`. Requires [Ollama](https://ollama.com) running locally. A description paragraph links to the Ollama website.

## Theme System

CSS custom properties on `:root` (light) and `[data-theme="dark"]`. Theme applied by setting `data-theme` on `<html>`. Persisted to `localStorage` under `agent-cockpit-theme`. Synced from server settings on init. Listens for system theme changes when set to "system".

## Keyboard Shortcuts

- **Enter** — send message (when send behavior is "enter")
- **Shift+Enter** — newline (or send, depending on setting)
- **Ctrl+Shift+D** — download conversation
- **Ctrl+Shift+R** — reset session
