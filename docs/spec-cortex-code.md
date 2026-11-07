# Cortex Code chat, runtime and authentication setup

[← Back to index](SPEC.md)

**Implemented scope:** P1 profiles, P2 transport/runtime, and P3 internal
events/interactions/models/usage/attachments/artifacts, P4 connection/auth
setup, P5 durable chat/managed MCP, and P6 C33/C34/C36–C40 background/KB/Context/Routine execution,
November 7, 2026.
Native acceptance baseline is CoCo 1.2.35, macOS arm64.
**Runtime status:** `CortexCodeAdapter` is registered in `server.ts` for chat.
CoCo setup/authentication, durable chat, tool-enabled ephemeral execution and
verified PNG OCR, native KB conversion/digestion/dreaming, Workspace Context
and Routine workflows are available. Remaining processor selection boundaries, full desktop/mobile acceptance
and CLI installation/update support remain pending.
The actual remote-browser setup
through Cockpit is still an open acceptance gate (C26).
See [the implementation tracker](design/cortex-code-implementation-plan.md),
[native evaluation](research/cortex-code-acp-evaluation.md), and
[Proposed ADR-0093](adr/0093-integrate-cortex-code-through-its-native-acp-interface.md).

## Background execution and OCR (P6 C33/C34/C36)

The public adapter delegates `runOneShot(prompt, options)` and
`runSessionShot(prompts, options)` to `cortexShots.ts`. The former returns the
first string from a one-prompt sequence; the latter returns one trimmed final
answer per prompt. `allowTools` must be exactly `true`. Omitted/false values
reject before session acquisition, plugin generation, version detection or
native startup, including empty sequences and calls supplying MCP. G1 remains
open: permission denial and native allowlists do not remove tool declarations.
Memory governance/extraction/consolidation therefore cannot use CoCo. Existing
deterministic title/summary fallbacks do not start inference.

Each call requires an explicit profile and gets an unguessable processor lease
and workspace identity, independent from durable chat and every concurrent job.
The cwd is options.workingDir, adapter workingDir, then process.cwd. Selected
profile/connection/model/effort and explicit MCP configuration use the existing
native runtime/plugin boundaries. A sequence acquires one session and submits
each new prompt once, without replaying earlier prompts or answers. It does not
load a durable chat session, retry a prompt, or retain a runtime after returning.
Native history retention remains CLI-owned.
An empty tool-enabled sequence returns an empty array without spawning.

A finite positive timeout (default 60 seconds) covers version detection,
initialization, session creation, configuration, attachments and all prompts
together. The native prompt receives only the remaining time. A pre-aborted
signal rejects without startup. Deadline, caller abort and adapter shutdown
stop the active turn/startup and await pool reset, including descendant and
private MCP cleanup. Signal listeners/timers are removed on every path;
cleanup is awaited before the job leaves the active set. Shutdown is reusable
after CLI updates and cannot revive a late startup. Native diagnostics and
cleanup failures are surfaced only as locally authored errors.

Headless turns retain the observed ordinary allow/deny tool approval policy.
Human questions, plan approval/revision and unrecognized/malformed permission
requests receive native cancellation, cancel the current prompt and fail with
`Cortex background work requires a human decision. Run this task in chat.`
No question answer or plan approval is invented. Terminal failure ends the
sequence before its next prompt. Ordinary chat continues using interactive
decision cards and opaque generations. Token events still pass through
`CortexTurn`; the existing string-only one-shot API does not return a usage
ledger or fabricate Snowflake pricing.

`RunOneShotAttachment` is declared in `src/types/backends.ts` and re-exported
from the base adapter for compatibility. `CortexTurnOptions` additionally
supports `headless` and `processorAttachments`. Processor attachments are
explicit server-owned absolute paths (never parsed from prompt text), and may
live outside execution cwd, such as conversation uploads or rendered KB pages.
Only text and image modalities are accepted. Each path is checked against its
real parent; a symlink escaping that parent rejects. Text uses the same extension/
regular-file gate as chat. Images reuse bounded no-follow reads, PNG validation,
5 MiB/file, 10 MiB/turn, ten attachments, 20-million-pixel and native-image gates.
The verified model/version remains exactly `claude-sonnet-4-6` on 1.2.35 (including
build suffixes); Auto and unsupported models fail before submitting a prompt.
No PDF/audio/video attachment transport or JPEG support is claimed.

Metadata now advertises `oneShot:{restrictedText:false,toolEnabled:true,sequential:true}`
and `oneShotMediaInput.image:['explicit-attachment']`. Profile-local model metadata
retains its independent verified image gate. The existing authenticated
`POST /conversations/:id/attachments/ocr` path sends the trusted image through
this transport and returns Markdown. Its existing image/model/path checks and
90-second inference deadline remain in force. It has no new browser abort API;
the processor accepts caller-owned AbortSignal independently.

Settings → Memory uses the shared browser-safe role policy through the pure
`processorProfileChoices` projection in a focused lazy `memoryProcessorSelect.jsx`
control (6 KiB budget, keeping Settings at 80 KiB). Unsupported profiles are excluded from
new choices. An existing unsupported selection stays visible and disabled,
with an error and an instruction to select another profile; it is never silently
replaced. Restored/programmatic CoCo Memory selections are still rejected by the
adapter before spawn, and the actual Memory notes route reports that the note
was not saved. The remaining global/workspace/import selection boundaries are
C41; individual KB, Workspace Context and Routine service certification is complete.

Focused normal tests: `test/cortexShots.test.ts`, `test/processorProfiles.test.ts`,
`test/memoryProcessorSelect.test.ts` (rendered choices, disabled saved selection,
explicit user change and empty eligible catalog),
the CoCo restored-selection case in `test/memoryMcp.test.ts`, and the existing
backend/turn/interaction/attachment/runtime/protocol/process suites. The opt-in
`scripts/probe-cortex-processors.ts` records native sequential continuity,
headless question failure, actual OCR HTTP output, unsupported model rejection,
cancellation after a native image prompt and fresh execution afterward. This
is an isolated HTTP fixture, not full native browser/PM2/Windows/Linux acceptance.

## Knowledge Base workflows (P6 C37/C38)

`BaseBackendAdapter` exposes two server-only execution policies. The getter
`allowAutomaticOneShotRetry:boolean` defaults to true for existing harnesses;
CoCo overrides it to false. `oneShotImageFormat:'png'|undefined` defaults to
undefined; CoCo requires PNG. These are runtime policies, not settings,
browser metadata or persisted credentials. They do not change the independent
role/model/version media gates. The public facade delegates native work to the
existing CoCo session/turn modules; KB code imports no CoCo/Grok/Kiro adapters.

All four visual ingestion handlers pass the selected adapter's required format
to `ensureAiReadyImage(srcPath,destPath,format?)`. A decoded non-PNG source is
written as a `.ai.png` sibling when PNG is required, including when its long
edge is already at or below 2576 pixels. Scaling is capped at 1, so small images
are not enlarged. Large inputs still scale proportionally to the existing cap.
The returned file is used for both the explicit native attachment and Markdown
media link. Originals remain byte-preserved and both files are recorded in
`mediaFiles`. Decode failure returns the original path; the adapter's byte/model/
version gates still reject unsupported input. No new native JPEG support is
advertised for chat or direct one-shot attachments.

PDF pages and rasterized PPTX slides retain the existing unpdf/LibreOffice PNG
pipeline and text/layout classification. DOCX retains Pandoc extraction and the
100-pixel decorative-image filter, then prepares eligible figures. Standalone
JPEG uploads and embedded Office JPEGs can therefore use CoCo's verified PNG
transport. Existing harnesses keep their original format/downscaling behavior.
The standalone-image metadata field `aiImagePrepared:true` marks a prepared
CoCo sibling (format normalization and/or scaling); legacy preparation retains
`downscaled:true`. No DB migration or conversion-record rewrite is performed.
Deduplication still returns the original raw ID, preserves converted timestamps/
bytes and adds locations without starting another conversion.

`convertImageToMarkdown` makes one attempt for a no-retry adapter and at most two
for existing retry-enabled adapters. Both thrown failures and empty output obey
this policy. Successful first attempts record `aiRetries:0`. A failed CoCo
conversion falls back through the existing handler behavior with `aiRetries:0`,
an image link/original media retained, and `without retry` notes where that
handler emits notes. Existing retry-enabled failures continue recording 1 and
`after retry`. Touched handler failure logs use the backend logger.

Digestion uses its existing selected profile/model/effort, chunk planning and
frontmatter/Markdown parser. Gleaning calls native `runSessionShot` for the
initial extraction and follow-up in one ephemeral session. Entries, provenance,
SQLite state and PGLite embeddings are committed through the existing services.
Interrupted native digestion records the raw as failed, creates no entries for
the interrupted initial chunk and never automatically resends it. Explicit
future user retries retain the existing service behavior.

Dreaming and re-dreaming keep their existing operations validators, transactional
application, topic Markdown materialization, run history, retrieval and KB MCP
session lifetimes. For no-retry adapters, thrown execution errors are rethrown
after the first call. Empty/whitespace output or any parser validation warning
fails the batch before operations are applied or `needs_synthesis` is cleared.
Validation failures retain one raw-response debug record under `_dream_debug`;
empty/execution failures are reported without a second call. Pending entries
remain available for a later explicit run. Other adapters keep the previous
throw/JSON parse retry behavior and structural-warning behavior. Dream stop
controls remain cooperative at existing batch/phase boundaries; no new stop API
or automatic restart is introduced.

Glossary authoring remains deterministic CRUD/query expansion, not automatic
CoCo extraction. The existing glossary expansion and token-scoped search MCP
operate over the same SQLite/PGLite data. Native acceptance used real local
Ollama `nomic-embed-text` embeddings (768 dimensions), verified vector search,
glossary-expanded entry search, and observed native `search_entries`,
`search_topics` and `get_topic` calls. Successful native prompts reported complete
token counters; intentionally interrupted prompts are excluded from that
assertion. The string-only processor API still adds no billing ledger or
invented Snowflake price.

`scripts/probe-cortex-kb.ts` is opt-in and uses a private temporary HTTP/KB
fixture with a ten-minute external completion deadline. It generates JPEG,
PDF, DOCX and PPTX inputs with native Pandoc/LibreOffice, verifies conversion/
records/reuse/original preservation, digests with gleaning, materializes topics,
checks glossary and real embeddings/search/MCP, re-dreams, interrupts an actual
digest after prompt submission and verifies fresh inference afterward. The
managed MCP plugin uses a fixture-only loopback endpoint and bearer token.
Teardown drains native jobs and closes PGLite/SQLite before removing fixtures.
Normal terminal auth and shared Office profiles/installations remain intact.
This certifies macOS arm64 on CoCo 1.2.35, Pandoc 3.9.0.2 and LibreOffice 26.2.3.2;
it is not full native browser/PM2/Windows/Linux acceptance. C26, conditional C35,
C41 and later client/install/platform gates remain open.

## Workspace Context workflows (P6 C39)

The existing `WorkspaceContextService` and `WorkspaceContextScheduler` use CoCo
without a harness-specific service branch. Scans and maintenance select the
global `Settings.workspaceContext` profile/model/effort or the explicit workspace
override and call `runOneShot` with `allowTools:true`, workspace cwd, the run's
AbortSignal and a ten-minute timeout. Native config selection is confirmed by
the same version-tested CoCo runtime path used by other processors. No service
retry or automatic fallback is introduced.

Catch-up scans pass actual conversation/session export paths and promote
uploaded-file paths to first-class sources. CoCo reads the generated
`WORKSPACE_CONTEXT.md` directive and writes canonical context markdown directly.
Maintenance reads current context, exact references, asset inventory and only
eligible active Memory inbox files when Memory is enabled. It returns the normal
single fenced `workspace-context-memory-actions` block; Cockpit validates the
complete block before deleting accepted planned files and emits the existing
silent `memory_update` with `displayInChat:false`. Superseded/disabled Memory is
excluded. Missing, duplicate or unknown-file action blocks fail visibly without
deletion or a second native prompt. Strict tool-free Memory governance/extraction
remains separately gated.

Headless native questions fail and leave the inbox intact. Stop uses the existing
Workspace Context AbortSignal, waits for CoCo runtime/descendant cleanup through
the processor promise, records `stopped` and releases the workspace reservation
only when that call settles. Overlapping work is rejected while the owner is
active. A stop endpoint acknowledges the request before cleanup finishes; callers
can observe the active state until draining completes. Existing direct markdown
edits before any failed/stopped run remain on disk; no filesystem rollback is
claimed. Memory deletion is performed only after successful processor completion,
the abort check and valid action parsing.

Zero-source scans record a completed run/cadence without native startup. Disabled
workspaces are skipped by processing/scheduling; the process call does not create
context scaffolding or alter instructions when disabled. This is distinct from
explicit enablement/repair APIs. Scan and maintenance intervals remain independent
and use the existing concurrency/active-owner checks. Maintenance prunes report
files and state-history rows older than seven days, retains recent records and
`latest.md`, and preserves scheduler timestamps.

`test/cortexContextIntegration.test.ts` exercises the actual process adapter with
a deterministic native-protocol executable. `scripts/probe-cortex-context.ts`
certifies real service/scheduler operations on CoCo 1.2.35/macOS arm64/Node 26.0.0:
conversation/upload scans, native context writes, selected global/override config,
accepted Memory folding/deletion and silent events, exact reference/asset bytes,
retention, zero-source/disabled behavior, scheduled scans/maintenance, native
cancellation without resend/deletion and fresh exact-response inference. Six
native prompts comprise five successful complete-usage responses and one
intentional interruption. Shared terminal auth remains intact. No new endpoint,
persisted schema, MCP service, client flow or pricing ledger is added. Full
browser/PM2/Windows/Linux, C26, conditional C35, C41 and later acceptance
remain separate.

## Routine workflows (P6 C40)

CoCo uses the existing `RoutinesService`/`RoutinesScheduler`, authoring contract,
proposal marker validation, explicit installation and manual/scheduled run
paths. No harness-specific service branch is required. Actual HTTP/WS chat can
read the installed authoring contract, write a valid proposed manifest/routine
markdown and return `AGENT_COCKPIT_ROUTINE_PROPOSAL:v1`. The existing route
validates its workspace-owned path and current state; proposed routines cannot
execute before explicit installation. Disabled workspaces retain existing
passive reads, no scaffolding/native work and stale managed-block removal.
Enabling installs instructions; disabling removes only those instructions and
preserves routine data. A disabled individual routine remains manually runnable
but is excluded from schedules.

Each run passes manifest CLI profile/model/effort, workspace cwd,
`allowTools:true` and the manifest deadline to CoCo's ephemeral one-shot path.
Native output/final/input/tmp/history and persistent state keep the standard
Routine layout and explorer scopes. Persistent cursor continuity is verified
through files across separate native sessions. Output retention uses run-folder
mtime and preserves persistent state; run history retains the existing 50-record
cap. Schedule intervals, timezone windows/weekdays and workspace/routine opt-in
remain Cockpit infrastructure rather than native CoCo schedules/goals.

Headless decisions, unavailable model selection, timeout and adapter shutdown
fail visibly without a resend or silent harness/model fallback. Timeout/shutdown
cleanup settles before releasing run ownership. Runs that fail during native
execution retain partial output/state, have no completed `final.md`, and never
deliver `notify.md`.
There is no new stop API or filesystem rollback. Completed runs route notify
files through Cockpit's existing notifier after checking mode/settings;
notification failures are recorded separately without rerunning tool work.
Credentials/destinations remain outside the native run envelope. Native usage
remains final-response evidence, not a new processor cost ledger.

`test/cortexRoutinesIntegration.test.ts` exercises the real process adapter with
a deterministic ACP executable, including chat proposals, configuration,
files/history/explorer, schedules, headless/model failures, overlap/shutdown,
timer-driven deadline, output retention and stub-only outreach. The opt-in
`scripts/probe-cortex-routines.ts` passed on CoCo 1.2.35/macOS arm64/Node 26.0.0
through actual HTTP/WS chat and service/scheduler routes, native manual/scheduled
files/cursor/notifications, and a real one-minute foreground shell/Python timeout
in 60.247 seconds. Five native prompts include four successful complete-usage
responses and one intentionally timed-out run; fresh exact-response inference
succeeded afterward. All notification delivery was replaced by an injected stub
on fixture-owned routes with synthetic credentials; no real message was sent.
Shared terminal auth remained intact. Full browser/PM2/Windows/Linux acceptance,
C26, G1/conditional C35, C41 and later gates remain independent.

## Durable chat and managed MCP (P5)

`src/services/backends/cortex.ts` is the registered public adapter facade.
Its static metadata has ID `cortex-code`, label `Cortex Code (CoCo)`, null icon,
and an empty model list. `getMetadata({cliProfile})` discovers this profile's
live catalog through an ephemeral `CortexSessions` lease. Discovery failure
returns an empty catalog, never another profile's models or raw native errors.
Discovery is still not authentication evidence. Chat advertises thinking,
tools, questions, plans and plan revision. Steering, agents, goals and restricted
one-shot work are false; tool-enabled/sequential roles are true under P6 above.
Active-turn resume is unsupported; saved-session
resume is supported. Titles use the inherited deterministic fallback; summaries
return the supplied fallback without inference.

### Chat ownership and instructions

`SendMessageOptions` now optionally carries immutable `workspaceId`, structured
server-validated `attachments` and a conversation-specific `attachmentRoot`.
CoCo requires profile, workspaceId and workingDir before starting a chat.
The ordinary chat route supplies canonical workspaceId and effective execution
cwd (`executionDir`, then workingDir), plus the existing native session ID,
recovery hook and enabled Memory/KB configurations. CoCo builds current global,
workspace, Memory/KB and file-delivery instructions on every request; other
harnesses retain the existing first-message behavior. The instruction text's
SHA-256 participates in runtime ownership. A fresh runtime prepends current
instructions to its first submitted native user message, including after load.
A configuration/attachment validation failure does not consume that prefix.
The normal first-session discussion/Memory/KB pointers remain in the user
message. Native project AGENTS.md/managed Workspace Context loading stays native.
No new instruction file or competing conversation store is created.

Each adapter conversation has one active owner, reserved synchronously when
`sendMessage` returns its stream/abort/input handles. Pool leases serialize
native work; every exit releases the matching lease. `CortexTurn` alone owns
the terminal `done` after delegation. Startup failures produce one sanitized
error and one done; a cancelled owner cannot proceed to a prompt or recovery.
The adapter emits `external_session` and `backend_runtime` with native session
ID and process PID before prompting. Existing ChatService/session persistence,
StreamJobSupervisor, usage ledger, finalizers, queues, WebSocket replay, reset,
archive/delete and artifact stores consume these events unchanged. Final
answers are distinct from allowed `turn:'progress'` messages between tools.
No native replay is stored as a new answer. Ten-minute idle eviction skips
active leases; its unref'ed timer is cleared at shutdown and recreated on a
later send, preserving CLI-update reuse. Reset/shutdown invalidate active
adapter owners and pool generations before asynchronous process disposal.

The structured upload bridge is an adapter option at this phase. Browser
upload/tag-to-structured-input wiring and full native desktop/mobile acceptance
are P7 work; do not claim arbitrary upload formats are certified by P5.

### Private native plugin resources

`cortexPlugin.ts` converts current `McpServerConfig[]` to a native manifest:
`{name:'agent-cockpit',version:'1.0.0',mcpServers:{[name]:{type:'stdio',command,args,env}}}`.
Duplicate names reject. A literal `node` command becomes `process.execPath`,
so shims use Cockpit's actual Node runtime. Each original environment value
gets a distinct child-only name `COCKPIT_CORTEX_MCP_<server-index>_<env-index>`;
the manifest maps the original variable name to `${COCKPIT_CORTEX_MCP_…}`.
Memory and KB tokens remain separate. Endpoints use placeholders too. Their
actual values enter only the child environment, never settings, argv, logs or
manifest bytes. A SHA-256 of manifest plus environment participates in the
pool fingerprint. Profile environment cannot override the managed values.

On a new/replaced pool entry, create a private random directory under the OS
temp root named `agent-cockpit-cortex-plugin-*`, mode 0700; create
`.cortex-plugin/` mode 0700 and `plugin.json` mode 0600. Append its absolute path
with `--plugin-dir`. An empty server list creates no directory/argument.
Temporary random paths do not themselves invalidate reuse. Token/endpoint,
feature-list, instruction, profile/env/executable, workspace identity or cwd
changes force disposal and respawn on the next turn boundary, followed by
session/load when an external ID exists. No prompt/tool operation is retried.
Native session/new/load still receives `mcpServers:[]`: 1.2.35 ignores those
fields; only explicit plugins supply MCP. Ambient plugins/skills/MCP and native
memory stay disabled by the existing runtime switches.

The lease writes secret-free `owner.json` mode 0600 with version 1, server PID
and native child PID, recording the child before initialization. Reset, idle,
startup failure and shutdown close native descendants before removing the
lease directory. Startup pruning examines only same-user ordinary directories
with the managed prefix and valid positive integer server/child PID records;
both must be proven absent (`ESRCH`). Live/reused PIDs, EPERM, unknown owners,
malformed files and incomplete startup records are conservatively retained.
No directory is deleted based on age or a guessed PID identity. This can leave
an incomplete crash record for manual cleanup. Runtime files stay outside
the data bundle and shared Snowflake/plugin configuration is never modified.
Cockpit's current MCP tokens have no expiry TTL; expiry is not invented here.
Revocation/auth rejection is owned by existing Memory/KB services. Changed
tokens refresh at the next boundary; a tool failure is not automatically retried.

### Missing sessions and interaction generations

After load failure the pool closes its transport/plugin. Only the retained
1.2.35 (including build suffixes) signature is classified as missing: native
`CortexRpcError` code -32603, message `Internal error`, and data.details exactly
`Failed to load session <requested-id>: Session '<requested-id>' not found`.
Different IDs, versions, auth/network errors and other diagnostics do not
trigger recovery. `CortexMissingSessionError` carries a local value-free message.
The adapter lazily creates the existing snapshot (excluding the current user
request), rechecks ownership, creates a fresh session, emits the existing
recovery event and replacement identities, and sends the recovery pointer plus
current request exactly once. Missing snapshots use the existing incomplete
context warning. Interrupted active work is never reattached or resent.

REST `/conversations/:id/input` now accepts optional `decisionId`; WS input
frames accept the same field. Desktop/mobile pending-interaction projections
retain the tool activity's opaque ID and echo it in replies. CoCo requires an
exact current `cortex-decision:<generation>:<ordinal>` owned by that live turn.
`sendInput(text,decisionId)` returns false for absent, stale, duplicate, invalid
or cancelled replies. REST returns 409 without creating a new user message;
a stale CoCo decision after stream teardown also returns 409. Other harnesses
can ignore the optional second argument and preserve existing behavior. Native
RPC IDs and tool IDs never substitute for a decision generation. Late HTTP
acknowledgement still clears only the submitted interaction object.

P5 fixtures cover real process/router/persistence behavior, worktree cwd,
relocation with canonical workspace identity, instruction refresh, queue,
reset/abort/archive/delete/profile locks, questions through REST/WS and
reconnect, native-load replay suppression, classified recovery and artifacts.
`scripts/probe-cortex-chat.ts` is opt-in real inference: native plugin discovery,
actual stdio shims and separate Claude Memory governance, Memory search,
PGLite keyword search, SQLite topic read, nonce after idle/adapter restart, one
final answer/usage per turn, native delivered-file persistence and native
session relocation with subsequent read/write in the new cwd. It uses an
isolated in-process HTTP/WS test fixture, never the production data directory.
The KB fixture deliberately makes embeddings unavailable: Ollama semantic
search is not certified. Full process-manager restart, UI and platform release
acceptance remain later gates; fixture evidence is not a substitute.

## Shared connection and authentication setup (P4)

`CliProfileAuthService` remains the public facade. Its CoCo operations delegate
to `src/services/cortexAuth.ts`; other harness transports/status interpretation
are unchanged. Auth declarations live in `src/types/cliAuth.ts` and remain
compatibility re-exports of the facade. The browser-safe CoCo summaries,
handoff shape and exact-body validators live in `src/contracts/cortexAuth.ts`.

### Native connections

`cortexConnections.ts` resolves the server's `SNOWFLAKE_HOME` (expanding `~/`)
or `os.homedir()/.snowflake`. Setup enumerates **connections.toml only**; it
does not run a CLI wizard, switch the terminal's default connection or expose
config paths supplied by browsers. A missing file is an empty list. Files
must be ordinary non-symlink files, at most 1 MiB of UTF-8, valid TOML; parsing
errors never expose source lines. Top-level tables with a string `account`
become sorted summaries `{name,manualOAuth,browserTimeoutMs}`. `manualOAuth`
means the case-insensitive authenticator is `OAUTH_AUTHORIZATION_CODE`.
Timeout reads `browserActionTimeout`, then `browser_action_timeout`; a positive
safe integer is milliseconds, otherwise the native default is 120000.
`config.toml` fallback connections and organization-specific OAuth domains
outside the validated Snowflake domains are not certified by this phase.

Create requests accept exactly `{name,account,user}`. Name is nonblank and at
most 128 UTF-16 code units; account/user at most 256. All reject Unicode
controls and unpaired surrogate code units. Account is a bare Snowflake
identifier matching alphanumeric/underscore/hyphen groups separated by dots;
it cannot be a URL, host/path override or credential. User and name retain
their literal valid text, including quotes/Unicode. Setup/check selects a
nonblank name of at most 1024 units and accepts no additional fields.

Creation adds only a new quoted top-level table with `account`, `user`,
`authenticator="OAUTH_AUTHORIZATION_CODE"`,
`client_store_temporary_credential=true`, `browserActionTimeout=600000`.
`smol-toml` 1.9.1+ parses/serializes TOML syntax. Original bytes, comments and
all other connections remain unchanged; the combined document is validated
before writing. An exclusive `.cockpit-connections.lock` serializes Cockpit
writers, in addition to the instance's in-flight guard. Existing locks are
reported, never deleted as stale guesses. The new home is created with `0700`;
an exclusive same-directory random temporary file is `0600` from creation,
written and fsynced before atomic rename. Existing native file content is read
again before rename and any observed external edit aborts creation. This is
best-effort detection of external writers that ignore Cockpit's lock, not an
OS compare-and-swap guarantee. All paths clean up their own temp/lock handles;
the final native file is `0600`. Creation never edits existing timeouts,
credentials or the CLI's selected default.

### Job ownership and transport

`CortexAuth.start()` requires an enabled account profile, reserves its
effective shared Snowflake home **before any await**, creates a random job ID
and handoff generation, and returns a clone of the in-memory job. A different
profile cannot start/check the same home while its job/check owns it. Completed
history is bounded to 40 jobs. Terminal snapshots contain only sanitized status
events; raw terminal output, URL, state, PKCE material and redirect codes never
enter those events, settings, conversation history or logs in Cockpit.

The job first makes one fresh verification request. Valid shared credentials
finish successfully without starting another login or fabricating a URL.
Otherwise manual login requires an OAuth authorization-code connection.
`cortexVersion()` checks the executable; native terminal parsing is gated to
1.2.35 (including build suffixes). Other versions can still use terminal login
plus Check login but cannot use this unverified terminal parser. Windows
runtime launch remains unsupported by the dedicated runtime resolver.

`cortexLogin.ts` loads the native `node-pty` addon only when starting a login,
so an unused CoCo setup path does not add an eager native-addon requirement to
server startup. It launches the pinned native binary through the PTY, never
a shell, with an empty private temporary cwd and:

```
--no-auto-update --private -c <connection> -w <temporary-cwd>
--only-explicit-plugins --only-explicit-skills --only-explicit-mcp-servers
```

Runtime resolution forces `CORTEX_OAUTH_MANUAL=1`, native memory/test mode off,
and shared setup auth rules. A pipe is insufficient for fresh onboarding
(native 1.2.35 explicitly requires a TTY). The PTY uses xterm-256color,
1024 columns and 40 rows to retain a complete native URL. The parser holds a
bounded 128 KiB private tail, strips terminal escapes and handles split output.
Known first-run prompts skip importing Claude settings, confirm the default
theme, acknowledge native security notes, and select the **exact named** agent
account from the native table; it does not blindly choose the first account.
An ambiguous/unrecognized account table fails closed. It never answers
arbitrary connection, SQL-account, workspace-trust or tool-permission prompts.
Native first-run preferences outside these known states may still require
terminal setup. Vendor onboarding itself can perform native account tests and
default skill-repository setup; Cockpit sends no task/tool prompt in this PTY.

The starting deadline is 90 seconds. On the validated native URL, the browser
deadline is conservatively native-spawn time plus the selected effective
browser timeout (so initial onboarding can shorten the remaining window).
`cortex` is the sole OAuth client: it owns the callback listener, PKCE exchange,
cache and its own stale account-lock recovery. Cockpit never deletes native
`oac_login_*.lock` files or shared credentials. A URL appears only in a running
handoff with `{phase,generation,connection,version?,authorizationUrl?,expiresAt?}`.
Phases are `starting`, `waiting-for-browser`, `verifying`; timestamps advance
monotonically so browser polling cannot restore older URLs/status.

### Redirect boundary and verification

The native authorization URL must be HTTPS on a single Snowflake account host
under `snowflakecomputing.com` or `.cn`, `/oauth/authorize`, with no port,
userinfo or fragment; exactly one nonempty state/redirect URI/challenge,
`response_type=code`, `code_challenge_method=S256` are required. The callback
must be `http://127.0.0.1:<explicit-port>/` with no query or fragment. Expected
issuer is the authorization origin plus `/oauth`.

Redirect POST accepts exactly `{generation,redirectUrl}` with nonblank strings
(generation <=128, URL <=16384 units, no controls/surrogates). It requires the
active waiting job, unexpired deadline and exact generation, callback origin/
path, state and issuer. Exactly one nonempty `code`, `state`, `iss` is allowed;
code <=4096 units. Duplicate/extra parameters, credentials in the authority,
fragments and other targets are rejected without echoing values. A valid
redirect is consumed **before** writing it plus Enter to native stdin. The
service does not fetch it or build an independent OAuth exchange. A rejected
validation can be corrected on the same active job; a consumed/write-failed
redirect requires a new job. URL/state ownership are cleared at consumption.

Callback receipt only changes phase; it does not prove cache completion or
start a racing verification request. Known native onboarding completion
(`All tests passed!`) or main prompt readiness (`? for shortcuts`), or native
exit, releases the waiting step. The exchange/verification completion deadline
is 90 seconds after redirect submission/receipt. The native job retains its
process/listener until fresh verification finishes or cancellation/timeout
starts bounded cleanup.

`cortexAuthVerification.ts` uses a **new** ACP runtime in a private empty
synthetic workspace and an independently generated random `COCKPIT_AUTH_…`
nonce. It sends exactly one bounded prompt requesting that exact text, no
tools/files/agents/web/SQL. Success requires `end_turn`, the exact stripped
response, complete final native token counters and no observed tool activity or
reverse interaction. Any tool update/interaction closes the client; no approval
is granted. This is evidence for the minimal auth request, not certification of
a zero-tool processor boundary. Initialization, model discovery, connection
tests, callback receipt, arbitrary assistant text and missing usage cannot pass.
The overall verification deadline is 90 seconds, with abort wired into the
native client's startup and process teardown. No paid inference polling/retry
loop exists. Normal model-catalog validation for chat is unchanged; the auth
probe uses raw native default selection so an empty-home missing model option
does not accidentally count as login evidence.

Known missing-connection text returns `not-authenticated`/false; other native
API, grant, expired/invalid credential, malformed or unexpected responses return
`error` with unknown authentication and locally authored guidance. Accounts,
native errors, returned nonce text, tokens and credential URLs are never echoed.
Successful output is `Cortex Code credentials and inference access verified
from a fresh process.` Each check incurs the small native inference request.

Cancel/shutdown/timeout invalidates the handoff immediately and aborts its
verification. `CortexProcessScope` accepts both child-process and PTY ownership
handles, tracks PID/start identities and drains descendants before releasing the
home reservation or allowing retry. Shutdown advances a generation so late
startups/callbacks cannot register a new handoff, and remains reusable. Server
shutdown awaits `CortexAuth.drain()` for both jobs and direct checks before
exiting; abort signals also reach native version detection, so shutdown cannot
strand a version/startup owner before ACP initialization. Process
cleanup is the existing bounded POSIX implementation, not OS containment.

### Setup/profile and client behavior

Setup test/start requires `{connection}` and creates/reuses only
`setup-cortex-code-account*`; it never edits an unrelated explicit profile.
Changing selection updates that setup profile's connection only. Setup
normalization removes configDir and case-insensitive `SNOWFLAKE_HOME`, retaining
unrelated env. Shared non-setup CoCo account profiles also avoid automatic
configDir allocation. Explicit isolation metadata remains unchanged; remote
login rejects those profiles and directs their login to their own terminal.
Their read-only checks can use their configured home without claiming safe
credential separation (native OS keychain behavior remains shared/uncertified).
With P5 chat registration, complete enabled CoCo profiles participate in the
normal first-profile default selection. Setup can promote the first configured
CoCo profile, or replace a server-configured CoCo default, using the same policy
as other harnesses. Existing explicit unrelated defaults remain intact.
Incomplete connection drafts remain ineligible; profile selection still does
not establish installation, account authentication or platform certification.

Welcome and Settings CLI Profiles compose the same focused `CortexSetup`
component. It loads only on expansion, lists/refreshes names, creates an OAuth
connection, checks saved login, starts/cancels a native job, presents a selectable
URL and deadline, and accepts the complete remote redirect. While running,
selection/creation/check/start controls are disabled. One-second polling stops
on terminal state/unmount, discards older job timestamps and clears input after
submission/cancel/completion. A reload can recover the active handoff from
connection enumeration without storing a URL or job token in localStorage.
Errors are sanitized server messages. Account/user creation fields are cleared
after success and never copied into browser settings/profile objects. Settings
merges the returned setup profile into its local draft without overwriting
unrelated unsaved edits. Generic profile-edit/chat controls for CoCo remain a
later phase; existing CoCo metadata is retained rather than mis-edited by another
harness's form. Mobile PWA remains chat-only; the desktop setup panel wraps to
narrow browser viewports, without adding a PWA admin/auth flow or changing
mobile metadata. APIs use the existing remote authentication wall and CSRF
guard; all connection/job/redirect responses carrying handoff state are no-store.

`scripts/probe-cortex-auth.ts` is opt-in native saved-auth/UI evidence through a
PM2-managed server with isolated Cockpit data and shared terminal auth. It does
not log out/delete shared credentials to force reauthorization. An actual human
remote-browser URL/redirect through these new routes remains **C26 pending**;
the earlier research handoff and fixture state/issuer tests do not close it.

## Identity and profile data

`CliHarness` recognizes `cortex-code`. Physical harness identity and the eventual
backend ID are the same. Display name is **Cortex Code (CoCo)**; the native
executable is `cortex`. A CoCo profile does not use Claude Code's protocol,
provider configuration, Ultracode mode or Codex's service tier.

The server profile type is declared in `src/types/cliProfiles.ts`, re-exported
through `src/types/index.ts`. Browser profile projection lives in
`src/contracts/responses.ts`. New profile-specific data is:

```ts
cortexCode?: {
  connection: string;
}
```

`connection` is an existing named Snowflake connection, never copied connection
contents or credentials. `cortexCode` may be omitted for an incomplete setup
draft. If present, the object must contain exactly `connection`; the name must
be a string with at least one non-whitespace character and no Unicode control
characters (Cc, U+0000–001F and U+007F–009F). Preserve the complete valid string
verbatim, including spaces and quotes, because it is a native connection name.
Runtime invocation passes it as an argument-array value, never shell text.

`src/contracts/cliProfiles.ts::parseCortexCodeProfileConfig()` owns that check
and returns only `{connection}`. Errors name fields/rules without echoing values.
Settings/draft request validation calls it for supplied CoCo configuration and
rejects `cortexCode` attached to a different harness. Legacy `vendor` is accepted
only as the existing compatibility fallback when `harness` is absent.
Unknown fields such as `account`, `user`, `password` or `token` are rejected.
No new account credentials or environment fields are added to browser responses.

`SettingsService` uses the same parser during persistence normalization, so
direct service callers cannot store unknown credential fields in this object.
A failed save leaves the existing atomic settings file unchanged. Saving a
CoCo profile preserves its existing command override and supported string env
values, strips unrelated Claude/OpenCode/protocol metadata, and retains the
connection object on edit/read/save and legacy identity migration. Existing
profile env/command behavior is unchanged; this field is not an auth store.

## Resolution, defaults and setup identities

`src/services/cliProfiles.ts` recognizes CoCo in supported-harness checks,
backend-to-harness mapping, profile backend selection and deterministic IDs:

- `server-configured-cortex-code`: generated as **Cortex Code (CoCo) (Server
  Configured)**, initially without a connection until configured.
- `setup-cortex-code-account` and `setup-cortex-code-account-*`: existing setup
  account naming convention, recognized only when `authMode === 'account'`.

`hasRequiredCliProfileConfig(profile)` is a pure completeness check: true for
existing harnesses, and true for CoCo only when the shared connection parser
succeeds. It does not check executable installation, login or adapter availability.
An unconfigured CoCo profile is retained for setup but excluded from automatic
default selection. Explicit invalid/incomplete CoCo default profile IDs are
cleared during settings normalization; other existing configured defaults and
legacy identity migration remain unchanged. A persisted legacy
`defaultBackend:'cortex-code'` can generate an incomplete server-configured
profile, but cannot promote it as `defaultCliProfileId` or execute it.

`resolveCliProfileRuntime()` rejects an incomplete or invalid CoCo selection
with **Cortex Code requires a CLI Profile with a valid named Snowflake
connection.** This applies to explicit profile selection and legacy backend-only
resolution, including absent server-configured profiles. Existing missing and
disabled profile errors take precedence. A complete profile resolves identity,
ID and profile only; the caller must still obtain a registered backend adapter.

Normal setup profiles remove `configDir` and case-insensitive `SNOWFLAKE_HOME`
env overrides in settings normalization/read migration, retaining connection
selection and unrelated env values. P4 setup uses this shared terminal authentication.
Explicit non-setup profiles retain their configured home metadata; this slice
does not certify account isolation. CoCo auth routes/jobs and
Welcome connection selection are specified in P4 above. CLI Update label/command
maps recognize the expanded type, but CoCo is excluded from update targets and
no CoCo executable is launched by CLI Update.

## Shared execution and interaction capabilities

Server and browser `BackendCapabilities` add two optional members:

```ts
planRevision?: boolean;
oneShot?: {
  restrictedText: boolean;
  toolEnabled: boolean;
  sequential: boolean;
};
```

`stdinInput` describes unsolicited steering. A harness may set it false while
supporting pending user-question and plan responses. This foundation defines
eligibility; routing and UI use of those distinctions are later implementation.

The browser-safe `src/contracts/backendCapabilities.ts` owns the pure
`checkBackendRoleEligibility(metadata, request)` function. Its metadata input
uses only `id`, `label`, `capabilities` and `models`, allowing both server and
browser DTOs without server-only imports. Request variants are:

```ts
{ role: 'chat' | 'questionReply' | 'planReply' | 'planRevision' | 'steering' }
// or:
{
  role: 'restrictedText' | 'toolEnabled';
  sequential?: boolean;
  modality?: 'text' | 'image' | 'audio' | 'pdf' | 'video';
  modelId?: string | null;
}
```

The return is `{ok:true}` or `{ok:false, reason, message}`. Failure reasons are
`backend-unavailable`, `unsupported-role`, `unsupported-sequential`, or the
existing media reasons `missing-backend-transport`, `missing-model` and
`missing-model-modality`.

| Request | Eligibility rule |
|---|---|
| Any request without metadata | Unavailable. Callers supply metadata from a registered adapter; this helper does not discover/launch one. |
| Chat | Present adapter metadata. This does not prove authentication or installation. |
| Question reply | `userQuestions === true`, independently of `stdinInput`. |
| Plan reply | `planMode === true`, independently of `stdinInput`. |
| Plan revision | `planMode === true` and explicit `planRevision:true`; absent flag preserves current Grok-only revision support. Explicit false overrides that fallback. |
| Steering | `stdinInput === true`. |
| Restricted text/tool-enabled one-shot | With `oneShot` present, the requested field must be exactly true. CoCo fails closed when the whole object is absent. Other existing harnesses retain legacy one-shot eligibility when it is absent. |
| Sequential one-shot | The base restricted/tool-enabled role must pass and `sequential === true`; existing harnesses with absent `oneShot` retain their legacy sequential behavior. |
| Non-text one-shot media | The role must pass, then require both the backend's modality transport and the selected/default model's explicit input capability. Unknown/Auto model modalities fail closed. |

The existing pure media helpers now live in this same browser-safe module:
`checkOneShotMediaInput`, `oneShotMediaTransports`, `selectModelOption`, and
`modelSupportsInputModality`. `src/services/backends/mediaCapabilities.ts`
remains their compatibility re-export facade. Existing upload/OCR and KB
ingestion callers keep their current media checks through that path. A missing
explicit model must not silently select a different media model.

The shared policy now drives the Memory selector. Enforcement across the other
processor/UI selectors remains C41/P7; CoCo's adapter independently rejects
restricted calls before startup. The strict native zero-tool boundary is
unverified, so CoCo metadata explicitly denies `restrictedText` until certified.
Unknown Snowflake pricing and unsupported native goals/subagents remain outside
this foundation; token/media/goal capabilities are not inferred from model names.

## Workspace instructions

`WorkspaceInstructionStore` adds CoCo to harness labels and maps it to the
existing `agents` source, `AGENTS.md`. It adds no fourth instruction source,
CoCo-specific instruction file or managed block. CoCo is covered whenever
`AGENTS.md` exists; it is missing when only Claude/Kiro instruction sources exist.
Existing pointer creation first creates `AGENTS.md` and then covers CoCo,
Codex, OpenCode and Grok together. Existing files/user content are not overwritten.
Compatibility status lists CoCo without implying runtime availability.

## Native transport and runtime ownership

P2 introduces four independent CoCo modules under `src/services/backends/`:
`cortexProtocol.ts` owns JSONL RPC, `cortexProcess.ts` owns descendant cleanup,
`cortexRuntime.ts` owns executable/environment/startup and a single session,
and `cortexSessions.ts` owns conversation leases, discovery and generations.
They do not import Grok/Kiro implementations. Domain wire/config/identity shapes
live in declaration-only `src/types/cortex.ts` and the server type barrel.
These focused foundations are now owned by the P5 adapter described above.
P3's turn bridge is specified below. The native runtime API is not a tool-free
processor.

### Executable, environment and startup

`resolveCortexRuntime(options)` requires an enabled CoCo profile with the P1
validated connection, a workspace ID and cwd. It resolves cwd to an absolute
path, uses the profile command override or `cortex`, and invokes the existing
POSIX CLI command resolver (PATH and common install locations). The discovered
executable is pinned to an absolute path. Its real path, size and mtime are part
of the runtime fingerprint, so replacing the native install invalidates reuse.
An invalid/missing executable fails without echoing its path or profile values.
Windows runtime launch is explicitly refused in this phase. macOS arm64 is the
native acceptance baseline; Linux launch code remains uncertified.

The child receives the server environment plus profile overrides. Force
`CORTEX_ENABLE_MEMORY=0`, `CORTEX_ACP_TEST_MODE=0`, and `CORTEX_OAUTH_MANUAL=1`.
The first disables managed native memory; the second prevents fake-agent mode;
the third prevents unexpected browser opening. Normal terminal auth is retained.
Setup account profiles ignore configDir and profile env keys matching
`SNOWFLAKE_HOME` case-insensitively, preserving the server's shared home.
Explicit non-setup configDir expands `~` and maps to absolute `SNOWFLAKE_HOME`;
explicit env otherwise remains intact. Auth scope never selects an executable.
An empty-home negative probe is not proof of complete two-account isolation.

Launch uses `spawn` with no shell, detached POSIX process ownership and three
piped streams. Exact argv is:

```text
acp serve -c <literal connection> -w <absolute cwd>
  --only-explicit-plugins --only-explicit-skills --only-explicit-mcp-servers
  [--plugin-dir <absolute private directory>]
```

The pluginDir hook accepts the P5 runtime-owned directory. ACP initialization
sends protocolVersion 1, clientInfo
`{name:'agent-cockpit',version:'1'}`, and clientCapabilities with file read/write
and terminal all false. Reject other negotiated protocol versions. Do not call
the native no-op `authenticate` handler. Startup requests have a 45-second
deadline. Actual auth requires successful inference, not initialize/session/new.

`cortexVersion` runs the same executable with `--version`, a 20-second timeout
and 64 KiB output limit. Parse `Cortex Code v<semver>`; never use the agentInfo
version (1.0.0 in the tested binary). P2 reports the discovered version and does
not claim compatibility certification for untested versions. Do not prepend
`--no-auto-update`: in 1.2.35 that selects terminal behavior. The verified ACP
dispatcher exits before the normal updater, and explicit plugin discovery
suppresses managed plugin updates. Discovery switches omit ambient plugins,
global skills and user MCP; bundled/project skills remain. This is not a sandbox.

### JSONL and reverse requests

`CortexAcpClient` decodes split UTF-8 and multiple newline frames, ignores blank
lines, and limits each complete or buffered frame to 32 MiB. It requires a
JSON-RPC 2.0 object: method frames have object params when present and no
result/error; response frames have a valid ID and exactly one of result/error.
Errors require an integer code and string message. Malformed JSON/envelopes,
terminal output and oversized frames terminate the runtime without echoing
input. Client requests use incrementing numeric IDs; reverse requests preserve
their exact string/number IDs including 0 in a separate pending set. A response
with string ID `"1"` cannot complete client request 1. Unknown late responses are
ignored. RPC errors preserve code/message/data as server-only `CortexRpcError`
for later version-specific classification; they do not alone kill the transport.

Subscribers return true to claim a reverse request. The first owner wins;
unclaimed requests receive -32601 even when notification subscribers exist.
`respond`/`reject` accept an outstanding ID once and return false after ownership
ends. Duplicate outstanding reverse IDs or subscriber exceptions fail closed.
No permissions are implicitly approved by these foundations.

Timeout closes the whole runtime because tools may still be running. It rejects
all pending RPCs, clears reverse ownership/listeners and performs cleanup once;
there is no retry. EOF (including a truncated final frame), stdout close, pipe
errors, spawn failure and process exit do the same. Exit is observed separately
from stream close because descendants may retain stdout. `closed` resolves to
the terminal Error; `close()` returns the idempotent cleanup Promise. Diagnostics
drain stderr and expose only byte count plus a login-prompt boolean. A private
2 KiB matching tail is discarded on close. Raw stderr, malformed frames, env,
connection names, OAuth URLs and credentials are never logged by these modules.

### Sessions, cancellation and generations

`CortexSessions.acquire(conversationId, options)` reserves ownership before its
first await. A second acquire for an active conversation is rejected; independent
conversations can start concurrently. Callers must release the acquired runtime
in their turn's finally block. There is no automatic prompt queue here; existing
ChatService queuing is connected later. Reuse requires an identical SHA-256
fingerprint of executable identity, exact argv, sorted effective env, profile ID,
workspace ID and caller-supplied instruction/plugin `contextKey`. Sensitive
values occur only as inputs to an unlogged digest. Profile, connection, cwd,
workspace, env, executable or managed-context changes close the old session and
spawn another. A changed requested native session ID also invalidates reuse.

Preparation sends `session/new {cwd,mcpServers:[]}` or
`session/load {sessionId,cwd,mcpServers:[]}`, retains the native ID, and stores
raw configOptions. Notification replay during load is suppressed at the runtime
subscription boundary; reverse requests still need an explicit owner. No native
missing-session recovery or interrupted-prompt replay is implemented here.
`discover` uses a unique temporary lease and closes it after returning version
and raw configOptions; each call uses its own profile. No global catalog cache,
stale-model fallback or model mapping exists in P2. Catalog/startup failures
reject. Discovery or session creation does not establish authentication.

`CortexRuntime.prompt` requires preparation and permits one pending prompt.
The default deadline is 300 seconds; callers can override it. `cancel()` sends
the `session/cancel` notification and waits up to 3 seconds for prompt settlement.
A healthy completion preserves the session; rejection or an unresponsive CLI
terminates the runtime and its owned processes. Interrupted work is never retried.
Idle close requests `session/close` with a 2-second deadline, then always tears
down the transport. Closing is idempotent and forbids new prompts. Busy close
terminates directly rather than waiting for a graceful idle response.

`reset` deletes ownership before disposal. `evictIdle(idleMs,now)` closes only
released leases; the P5 adapter installs its ten-minute idle scheduler.
`shutdown` increments the generation, clears ownership and disposes all current
entries. A late version probe/startup cannot reinsert an old entry: it closes
as soon as a client/runtime appears. Initialization/session failures also close.
Shutdown is reusable, not a permanent disabled state. The registered adapter's
`shutdown()` delegates here; the runtime suite verifies the real
`BackendRegistry.shutdownAll()` boundary with that adapter.

### Owned process cleanup

The POSIX scope samples `ps -axo pid=,ppid=,pgid=,lstart=` every 250 ms. Each
enumeration has a 750 ms deadline and 8 MiB bound. It retains PID/start identities
for the root and transitive children, including children in detached sessions,
and continues tracking children of observed owned descendants after root exit.
Only matching current identities can be signalled. A whole process group is
signalled only when its current leader is verified as owned; otherwise signal
matching members individually. Reused PIDs and unrelated siblings are excluded.
Stop is awaitable/idempotent: send TERM, poll up to 2 seconds, then KILL remaining
owned work and poll up to 1 second. Surviving counts are logged without command
or account data. Enumeration failure during stop falls back only to the live
child's root group/direct kill, never remembered descendant PIDs.

This is userspace cleanup, not OS containment. Descendants that detach and lose
all observed ancestry between snapshots can escape tracking, and lstart has the
platform's timestamp precision. Native evidence deliberately waits for ownership
observation before killing the root. Full finalization/background-delegation
policy remains a later release gate; do not infer that P2 supports subagents.

## Internal turn bridge and event mapping (P3)

`CortexTurn` in `cortexTurn.ts` expects a prepared runtime owned by a conversation
lease. It exposes a single-use async `stream()`, `pendingId`,
`input(text,decisionId):boolean`, and awaitable `abort()`. Domain selection/turn
options are declared in `src/types/cortex.ts`: text, optional model/effort,
optional standard/plan mode, trusted attachment metadata/root, permission policy
`allowTools`, and prompt timeout. It configures the runtime, validates attachments,
subscribes before prompting, routes reverse requests and owned notifications,
drains asynchronous artifact work, classifies the final result and emits one
`done`. Every terminal path unsubscribes and cancels pending decisions. Dropping
the iterator aborts unfinished work. Pre-start abort sends no prompt; abort
during setup closes the transport; active-prompt abort uses native cancellation.
The bridge does not acquire/release leases, persist external sessions, inject
system instructions/MCP, register an adapter, or own processor leases.
P5 owns chat orchestration; `cortexShots.ts` owns P6 processor leases.
`allowTools:false` only denies reverse
permissions; it does not establish a tool-free native session.

### Models, effort and modes

`cortexModels.ts` parses `select` configOptions with string IDs/current values
and flat string-valued choices. It skips malformed/duplicate IDs and choices,
preserves opaque native model IDs/names and native Auto, and returns ModelOptions
with family `cortex`. It does not publish an account's catalog as a fixed list.
Effort metadata is the advertised intersection with minimal/low/medium/high/
xhigh/max. The current native model value marks the default. No model-vendor
name infers media, pricing, or other capabilities.

`configureCortex(runtime,selection)` reads only that runtime's configOptions and
uses `session/set_config_option` sequentially for model, thought_level and mode.
Omitted model/effort explicitly select native `auto`, including after a prior
override; omitted mode selects `standard`. Validate every selection against the
latest response catalog, and re-read returned configOptions after each set.
An RPC failure, malformed response, or unconfirmed current value clears the
catalog and rejects; do not send a prompt or silently choose another model.
Only standard/plan mode is allowed even if the native catalog advertises bypass.
Never set `_restricted_session_scope` or another SQL privilege option.

P3 performs no model-cache fallback. Missing/changed catalogs cannot borrow
another profile's metadata. An empty Snowflake auth home was observed to omit
the model option altogether; configured chat then fails model validation before
inference. Auth verification must independently make a minimal native request,
rather than bypassing a missing catalog in ordinary configured chat.

### Text, tools and terminal errors

`CortexEventDecoder` accepts only `session/update` with the exact owned native
session ID. It maps text/thought chunks to streaming text/thinking, initial tool
calls to one tool activity per native tool ID, and completed/failed updates to
one outcome. A new tool after assistant text emits `turn_boundary` and resets
the final-text segment. Duplicate calls/completions do not create extra cards or
outcomes. Unknown variants are ignored; unknown tool names remain named tools
without inventing agent/subagent capabilities. In-progress updates do not create
duplicate activity cards. Native titles map read/write/edit/bash/grep/glob,
questions/plans and web tools to the existing tool vocabulary. Interactive cards
come from reverse requests, not empty question/plan tool activities.

Outcomes prefer native content, then string rawOutput, then native status.
Text resources, resource names and diff path/old/new text become outcome text,
bounded to 1,000 characters. Native `failed` marks that tool as failed; it is not
a terminal turn error. A rejected plan can fail a tool while valid revision
continues. Final assistant text becomes an existing `result` event.

`cortexErrors.ts` owns locally authored value-free input errors and sanitized
runtime/terminal failures. Candidate assistant text beginning with `Error:`
(including a fragmented prefix) is held until final classification. On tested
1.2.35/1.2.35+ distributions, an anchored native missing-connection signature or
`Error: Error: API error <4xx/5xx>:` without complete token usage becomes a
friendly terminal error. Do not stream/persist raw account paths, service URLs,
request IDs or connection diagnostics. Unknown leading errors without complete
usage remain visible as a generic terminal failure. Quoted errors with complete
usage, and normal prose mentioning an error, remain valid text. A missing usage
object by itself is not a turn failure: emit the valid answer with a nonterminal
warning and no fabricated token event. Unknown/missing stopReason and limit stops
are terminal failures; cancelled is an abort. RPC error data is never echoed to
clients. No failure path retries the original prompt or its tools.

### Question, permission and plan ownership

`cortexInteractions.ts` keeps exact native reverse RPC identity independently
from native tool IDs. Each UI decision receives a fresh
`cortex-decision:<turn UUID>:<ordinal>` activity ID; stale browser decisions cannot
address a later request even when native IDs are reused. One queued decision is
presented at a time. The future adapter/client boundary must retain that expected
decision ID when accepting an answer; P5 routes it through REST/WS and the clients.

Recognize a question by valid integer questionIndex/totalQuestions metadata and
allow-once choices. Preserve native option IDs separately from displayed names.
An exact unambiguous label/ID selects that option; otherwise a native option
marked `_meta.freeForm:true` receives the typed answer in
`outcome._meta.freeFormText`. Choosing the free-form label without typed content
does not submit an answer. Blank, oversized (>16,000 characters), duplicate,
stale, ambiguous and unsupported replies return false. One selection per native
question is supported; multi-select remains unverified and is denied. Request
ID 0 works, and sequential questions create independent decisions.

Ordinary permissions can auto-select only the observed allow-once `allow` plus
reject-once `deny` schema with kind other and no question metadata, when
allowTools is true. Never choose allow-always. Unknown/malformed permissions,
unsupported question shapes and denied calls return cancelled. Foreign-session
or unknown-method reverse requests are left unclaimed for transport rejection.
Native reads can exist without reverse approval; this is not a processor sandbox.

A plan decision requires kind switch_mode, proceed/keep_planning choices, and
a prior owned `plan` update with `_meta.kind:'plan_document'` and planDocument
(bounded to 50,000 characters). Emit EnterPlanMode then ExitPlanMode with that
document for each gate, including a revision, so existing stream state reopens
the approval UI. Approve/yes/continue/run selects proceed; reject/no selects
keep_planning; other nonblank feedback selects keep_planning with freeFormText.
Cancel/abandon cancels that decision; stopping the whole turn uses `abort()`.
After response ownership ends, emit a decision outcome and present the next
queued decision. Abort/completion/process exit prevent later input and clear all
outstanding reverse ownership. A failed revision tool does not end the turn.

### Token usage and pricing

`CortexTurnUsage` is per prompt. `usage_update {size,used}` is a context snapshot,
converted to a bounded 0–100 percentage, never a billable delta. Final prompt
usage requires all four finite nonnegative counters: inputTokens, outputTokens,
cachedReadTokens and cachedWriteTokens. Map them directly to Cockpit input,
output, cacheRead and cacheWrite; native uncached input already excludes cache,
so do not subtract caches again or add totalTokens as another counter.

The tracker finalizes once; duplicate terminal RPC responses are ignored by the
transport and load replay is suppressed by the runtime. Complete counters on a
cancelled turn remain billable known usage even though the turn is interrupted.
Absent/malformed/partial counters emit no invented zero usage. The last valid
context snapshot accompanies complete usage. Existing conversation/daily ledger
stores consume normal usage events; their format is unchanged. Tests reconcile
two turns and caches through the actual ledger store. Durable job/restart
ownership belongs to P5, not a new competing deduplication store.

CoCo emits costSource none and numeric costUsd 0 only as the contract's unknown
amount placeholder. No Snowflake dollar spend has been verified. Existing pricing
dispatch excludes cortex-code even when its model ID names Claude/OpenAI; no
direct-vendor estimate/costSnapshot is added. Context occupancy is not spend.

### Attachment and artifact boundaries

`cortexAttachments.ts` builds ACP prompt content from text plus trusted attachment
metadata. It never parses/open paths from `[Uploaded files: ...]` or other user
text. The server must supply the conversation's own upload directory; canonical
real paths must remain beneath that root. Queued AttachmentMeta is accepted
after the same validation. Text/code/markdown files are regular-file references
for native tools, not inline file contents. The current extension allowlist is
txt/md/markdown/csv/tsv/json/js/ts/py/html/css/sql/xml. Other non-image formats,
including direct PDF/audio/video/Office input, are rejected in this bridge.

Explicit image content is verified only for claude-sonnet-4-6 on 1.2.35/1.2.35+
and requires initialize's image prompt capability. Auto/unknown models fail
closed. Current format is PNG only: extension, PNG signature/IHDR dimensions and
actual decoding must agree. Maximums are ten attachments, 5 MiB per image,
10 MiB images per turn and 20 million pixels. Open canonical files without
following a replaced final symlink and bound the read to limit+1 bytes. Files
outside the conversation, sibling uploads, missing/invalid/oversized images and
unsupported MIME/model combinations fail before prompting. This is explicit
upload scoping, not containment of the CLI's normal authorized file tools.

`cortexArtifacts.ts` remembers completed native write/edit paths but does not
turn ordinary coding changes into downloads. Explicit file-resource links from
completed edit/execute tools, or assistant FILE_DELIVERY markers after completed
output work, can emit standard artifact source events. Markers split across
chunks are removed from normalized text and converted to delivery paths; normal
HTML comments remain text. Bound an incomplete comment buffer to 8 KiB, each
delivery path to 4,096 characters and delivery markers to ten per turn. The
collector checks canonical cwd scope, regular file, <=50 MiB, and excludes native
.cortex internals; reject remote/non-file resources, traversal/symlink escapes,
unavailable files and failed/read-only tool output. Never guess a file path from
arbitrary stdout. Deduplicate canonical path/size/mtime across source and marker
events; preserve source tool ID when a native write owns that canonical path.

The bridge drains file-resource work and explicit deliveries before its final
usage/result/done boundary. Existing processStream/ArtifactStore copies files
into the conversation artifact directory and emits/persists the existing shared
descriptor. Tests verify text/code, real Office/PDF fixture bytes, sanitized
filenames, conversation ownership, download routes and text preview. Binary
previews retain the existing client/file-type behavior; no new Office converter,
native image generation or additional input media support is claimed. Shared
file-delivery markers continue to follow Cockpit's explicit-deliverable policy.

## Verification and client impact

- `test/cortexProfiles.test.ts`: connection request validation, literal name
  preservation, credential-field rejection, profile/default/runtime resolution,
  draft persistence, direct-save atomic rejection, setup shared-home migration
  and explicit-home retention.
- `test/backendCapabilities.test.ts`: shared role/interaction eligibility,
  fail-closed CoCo processor policy, legacy behavior, sequential and model/media
  checks; existing `test/mediaCapabilities.test.ts` verifies the facade behavior.
- `test/chatService.workspace.test.ts`: CoCo coverage and shared pointer repair
  without overwriting user instructions.
- Existing settings/auth/CLI update/contract suites protect other harnesses;
  CLI update tests explicitly verify no target/command for CoCo profiles yet.
- `test/cortexProtocol.test.ts`: split/large/multiple frames, exact ID namespaces,
  reverse ownership, malformed/oversized frames, timeout, EOF/pipe/exit failures,
  RPC error metadata, listener failure and private stderr diagnostics.
- `test/cortexRuntime.test.ts`: exact invocation/version, shared auth resolution,
  fingerprint changes, load replay, prompt/cancel/close ownership, profile-scoped
  discovery, startup/reset races, idle eviction and reusable registry shutdown.
- `test/cortexProcess.test.ts`: detached resistant child cleanup after root exit,
  unrelated process survival, reused identities, enumeration failure and no-PID
  spawn failure. These process tests exercise real local Node processes on POSIX.
- `scripts/probe-cortex-runtime.ts`: opt-in real runtime acceptance described in
  [testing](spec-testing.md#coco-p2-native-runtime-smoke). CoCo 1.2.35 on macOS
  arm64 passed managed/authenticated inference, cancel/subsequent turn, saved
  session load, root-exit descendant cleanup, empty-auth inference failure and
  reusable shutdown on November 6, 2026. It uses the dedicated production
  foundations, rather than Phase 0's Grok research helpers. No browser/route or
  full ChatService integration is implied by this smoke result.
- `test/cortexEvents.test.ts`, `test/cortexModels.test.ts`,
  `test/cortexInteractions.test.ts`, `test/cortexTurn.test.ts`,
  `test/cortexAttachments.test.ts`, `test/cortexArtifacts.test.ts`: native excerpt
  mapping and focused boundary tests, plus real scoped upload/queue, artifact
  storage/download/preview and ledger integration. P5's separate adapter and
  route suites exercise registration. `test/helpers/cortexFixtures.ts` provides transport control using
  retained native excerpts; it is not a substitute for real CLI acceptance.
- `scripts/probe-cortex-events.ts`: opt-in P3 native acceptance for configuration/
  effort reset, tools and explicit delivery, sequential/free-text questions,
  duplicate answers, revised plan gates with no write before approval, explicit
  PNG recognition and missing-auth catalog/inference failure classification.

Desktop/mobile share the pure role contract; P4 adds setup controls and P5
retains opaque decision IDs in both clients. P5 changes no PWA metadata or
service-worker policy. Existing frontend typechecks must remain valid.
Native CLI compatibility suites are not replaced by these foundation tests.
