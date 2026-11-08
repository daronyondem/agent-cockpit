# Cortex Code (CoCo) harness implementation plan

**Status:** P0–P3, P5 and P7 complete. P4 C21–C25 setup implemented; C26 actual remote-browser acceptance remains pending. P6 C33/C34/C36–C41 complete; C35 remains conditional on G1. P8 C48/C49 optional installation/doctor and native update management are complete; C50 migration verification is next.
**Created:** 2026-11-05.
**Planning baseline:** Agent Cockpit `0.4.166`, revision `11d14825e955f6c83364c3917558b4d3068a4bac`, plus the uncommitted CoCo research/guidance documents.
**Native compatibility baseline:** Cortex Code `1.2.35`, distribution `1.2.35+191333.f82de3d91715`, macOS arm64.
**Harness/backend ID:** `cortex-code`. **Display name:** Cortex Code (CoCo). **Executable:** `cortex`.
**Evidence:** [Authenticated ACP evaluation](../research/cortex-code-acp-evaluation.md).

This is an implementation proposal and progress tracker, not a description of
shipped support. Current behavior remains in the canonical `docs/spec-*.md`
documents. Update those specifications as each implementation slice lands.

## 1. Outcome, assumptions, and completion rules

Add CoCo as a selectable CLI Harness using its native `cortex acp serve`
protocol. Reuse Agent Cockpit profiles, conversation storage, streams, tools,
artifacts, Memory/KB services, Workspace Context, Routines, and clients. Keep
Snowflake connection/authentication ownership in the native CLI.

Planning assumptions:

- Implement a dedicated adapter; do not refactor Kiro or Grok into a generic
  ACP framework as a prerequisite. Their native extensions differ materially.
- Add `CliProfile.harness = 'cortex-code'`; retain **Harness** in Settings and
  **Profile / CLI Profile** in composers. CoCo can serve models from several
  vendors; the model vendor does not change the harness identity.
- Reuse normal terminal Snowflake auth for server-configured and Welcome setup
  profiles. Named connections select an account; they do not prove credential
  isolation. Explicit isolated profiles require separate verification.
- Use macOS arm64 for the initial native acceptance baseline. Include Windows
  and Ubuntu 24.04 x64 work in this plan, but certify each platform only after
  its real tests pass. Upstream platform support is not Cockpit certification.
- Deliver core chat before optional parity work. Unverified features remain
  explicitly unavailable; do not emulate native goals or silently reroute work
  to a different profile to make a selector appear functional.
- C01–C25, C27–C34 and C36–C47 are implemented as recorded below. C26, conditional
  C35 and C48–C59 remain open and do not describe shipped support.

Track work as follows:

1. Check a task only after its implementation and acceptance checks pass.
2. Record the commit/PR, CLI version, platform, and test/report evidence in the
   completion log. Research results do not complete adapter tasks.
3. Mark unresolved items in the gate register with the observed failure and
   next experiment. Leave blocked tasks unchecked.
4. Record an explicit scope decision for a deferred feature. Core release
   completion does not mean every parity feature is supported.

### Release levels

| Level | Required result | Items that may remain unavailable |
|---|---|---|
| Core harness | Profiles, shared auth/setup, real text inference, streaming/thinking/tools, questions and revised plans, safe cancellation/reset/shutdown, persisted-session recovery, MCP-backed chat Memory/KB, honest usage/errors, desktop/mobile chat, pinned native suites | Strict tool-free processors, isolated accounts, additional media, native goals, subagents, mid-turn steering, native memory import, billing/quota panels |
| Background workflow support | Independently certify tool-enabled one-shots, sequential calls, Workspace Context, Routines, KB ingestion/digestion/dreaming, and role-specific selection gates | Strict tool-free work remains unavailable until G1 passes; image ingestion/OCR also needs model and media evidence |
| Additional parity | Resolve each applicable gate for restricted processors, platform support, isolation, media, goals, subagents, steering, and billing | Any remaining limitation must be documented and reflected in UI/API capabilities |

Core release must not regress an existing default processor: users can chat
with CoCo while continuing to use another explicitly selected Memory processor.

## 2. Evidence ledger

### Completed research, not completed implementation

- [x] R01 — Remote-browser OAuth using `CORTEX_OAUTH_MANUAL=1`: the user opened
  the native URL elsewhere and returned the complete loopback redirect.
- [x] R02 — Fresh-process saved credential reuse and authenticated inference.
  On 2026-11-05, a fresh ACP process using `claude-sonnet-4-6` returned the exact
  marker `COCO_AUTH_OK_20261105`; no reauthentication was needed.
- [x] R03 — Native text/thinking/file/shell events, sequential questions,
  free-text answers, plan approval and revision, image input on the tested
  model, saved-history reload, cancellation, and `AGENTS.md` context discovery.
- [x] R04 — Actual Cockpit Memory/KB stdio shims through a temporary native
  plugin and authenticated synthetic HTTP fixtures, including token rotation
  and a fresh-process session reload.
- [x] R05 — Negative evidence: ACP `mcpServers` ignored; empty auth home can
  create a session; terminal errors can look like successful `end_turn`;
  `--disallowed-tools '*'` is insufficient; root-only kill leaves shell work.

These probes did not exercise actual Cockpit browser workflows or production
Memory governance, KB databases/processors, Workspace Context maintenance, or
Routines. The Nov 5 result confirms credential reuse across days; it does not
prove expiry/refresh or two-account separation.

### Native behavior that the adapter must preserve

| Concern | Observed behavior | Required implementation consequence |
|---|---|---|
| Launch | `cortex acp serve -c <connection> -w <cwd>` produces clean ACP; putting global `--no-auto-update` before the subcommand selected the TUI in 1.2.35 | Version-test exact argv; stdout must contain only JSON-RPC. Find a compatible update-suppression mechanism rather than copying other harness flags. |
| Version | `agentInfo.version` reports `1.0.0`, unlike the binary version | Detect compatibility through `cortex --version` and distribution metadata. |
| Configuration | Sessions return `configOptions` for `model`, `mode`, `thought_level`, and restricted SQL scope | Use `session/set_config_option`; do not copy Kiro `session/set_model` or Grok model discovery. |
| Models | Account-specific catalog, including Auto choices | Cache by effective profile/connection, not globally; do not publish the research account's catalog as a fixed list. |
| Interactions | Reverse `session/request_permission`, including request ID `0`; question/plan IDs differ from native tool IDs | Preserve RPC identity and interaction ownership independently of tool activity IDs. |
| Session reload | `session/load` replays history before the next prompt | Suppress native replay into an existing Cockpit transcript; history recovery is not active-turn reattachment. |
| MCP | `session/new/load.mcpServers` accepted but ignored; explicit native plugin works | Build a private per-runtime plugin and respawn/reload to replace MCP credentials. |
| Errors | API 408/auth connection errors arrive as assistant text plus `end_turn`, sometimes without usage | Add a version-tested failure policy; `end_turn` alone must not certify success. |
| Usage | Final result has input/output/cache read/cache write; `usage_update` is a context snapshot | Separate billing counters from context occupancy; deduplicate final results/replay. |
| Lifecycle | Healthy cancel worked; abrupt root exit left a shell child alive | Track owned descendants and clean them after root exit; never retry interrupted tool work automatically. |
| Restrictions | An unmatched explicit allowlist blocked tested reads/writes but tool declarations/calls remained | Strict zero-tool work stays disabled until a complete native restriction is demonstrated. |

## 3. Feature coverage map

**Evidence labels:** **V** = native behavior verified; **P** = partial evidence;
**U** = unverified; **C** = existing Cockpit service retained. No row labeled V
means that feature is already integrated into Cockpit. Phase IDs refer to §9.

### 3.1 Profiles, setup, and operation

| Cockpit functionality | CoCo implementation | Evidence / release gate | Work |
|---|---|---|---|
| Harness registration and defaults | Register `CortexCodeAdapter` with ID `cortex-code`; add supported harness labels, server-configured profile generation, resolution, disabled-profile checks, and selection persistence | C; preserve existing profile IDs/defaults | P1, P2 |
| Multiple logical CLI profiles | Structured `cortexCode.connection` selects a named Snowflake connection; retain command override and profile env | P; never infer isolated auth from a different profile name | P1, P4 |
| Existing terminal authentication | Use normal Snowflake config and credential store; no setup-created isolated home | V for tested shared OAuth connection | P4 |
| Welcome and Settings authentication | Native manual OAuth job, copyable login URL, complete redirect submission, cancel/retry, fresh-process verification | P4 setup implemented; saved-auth UI and actual remote handoff tracked separately | P4, P7 |
| New Snowflake connection | Select existing names; optionally create a dedicated OAuth connection from account/user fields without modifying unrelated connections | Implemented create-only TOML append with focused safety tests; native onboarding baseline checked | P4 |
| Explicit isolated account profiles | Map explicit `configDir` to tested `SNOWFLAKE_HOME` semantics; verify credential cache/Keychain scope with two real accounts | U; G5, no isolation claim before evidence | P4, P8 |
| Executable/version detection | Shared runtime resolver, absolute override/PATH/native install discovery, bounded version probe | V macOS install only; native Windows/Linux pending | P2, P8 |
| Install Doctor and Welcome install actions | Detect fresh installs without restart; install the official distribution through reviewed platform actions | C + upstream installer docs; G8 | P8 |
| CLI updates and compatibility | Resolve shared executable independently of auth homes; track actual version, coordinate runtime shutdown, recheck after update | P; G8/G9, unsupported updater path stays unavailable | P8 |
| App install, self-update, release packages | Include new source/assets/dependencies in normal build; preserve existing platform startup/update behavior | C; no independent app supervisor | P8, P9 |
| Export/import and relocated installs | Preserve profile metadata in data-root bundle; exclude runtime plugin/auth-job material; check external CLI/auth/path dependencies after import | C; native shared credentials are not magically migrated | P8 |

### 3.2 Conversations, tools, and execution

| Cockpit functionality | CoCo implementation | Evidence / release gate | Work |
|---|---|---|---|
| New chats and streaming responses | `initialize` → `session/new` → configuration → `session/prompt`; map message chunks to text frames | V; P5 adapter/route and native app probe pass | P2, P3, P5 |
| Visible thinking | Map `agent_thought_chunk` to existing thinking blocks, without merging replay/other-session output | V | P3, P7 |
| Model picker | Translate current `configOptions` model catalog into `ModelOption`; preserve opaque native IDs and Auto choices | V tested account; profile-specific caching | P1, P3 |
| Effort picker | Use `thought_level`; observed `minimal/low/medium/high/xhigh/max`, native `auto` represented by no explicit override | V low only; verify reset-to-auto after explicit effort | P3 |
| Runtime modes | Map native `standard/plan` where needed; do not expose Claude Ultracode or Codex Fast settings for CoCo | P; no automatic `bypass` or SQL privilege changes | P3, P7 |
| Native file/shell tools | Normalize `tool_call/tool_call_update`, input, progress, outcomes, paths, and edit/diff content | V basic operations; edits/renames/deletes need fixtures | P3 |
| Ordinary native permissions | Apply the existing Cockpit execution policy to native allow-once requests; preserve cancellation and denials; distinguish questions/plans from ordinary approvals | P; never treat unknown request types as approval | P3 |
| Clarifying questions | Project native question text/options to existing cards; retain request ID, selected option, and `_meta.freeFormText`; sequential questions remain separate decisions | V single/sequential/free text; multi-select not certified | P3, P7 |
| Plan approval and revision | Pair preceding plan document with `switch_mode` permission; map approve to `proceed`, reject/revise to `keep_planning` plus feedback | V; enable revision UI beyond current Grok-only checks | P3, P7 |
| Mid-turn input | `sendInput` answers a pending interaction; otherwise leave steering unsupported and preserve user text through explicit queue/new-turn UX | U steering; `stdinInput:false` initially | P3, P7 |
| Message queue/edit/reorder | Use existing persisted queue; drain after a verified terminal boundary; do not send a second concurrent ACP prompt | C; reject stale interaction replies rather than treating them as a new prompt | P2, P5, P7 |
| Abort/stop | `session/cancel`, bounded grace period, owned descendant termination if necessary; mark interruption truthfully | V healthy cancel; G2 crash cleanup | P2, P5 |
| Reset/archive/delete/idle eviction | Close runtime and pending interactions, reject late startups/notifications, persist history via existing stores | C; reusable shutdown required | P2, P5 |
| Resume after idle/restart | Persist `external_session`; `session/load` with replay suppression before new prompt | V native nonce recall; G3 recovery | P2, P5 |
| Missing native session | Use existing lazy recovery snapshot only after a classified missing-session failure; show recovery message and persist replacement ID | C; never recover on arbitrary auth/network errors | P5 |
| Active-turn server restart | Preserve durable job interruption semantics; do not resend the original request or claim in-flight reattachment | U native reattach; explicitly unsupported | P2, P5 |
| Reconnect/replay/unread/notifications | Use existing WebSocket stream supervisor, browser replay, finalizers, unread state, and pending interaction projection | C; distinguish browser replay from native load replay | P5, P7 |
| Concurrent chats/workspaces | Runtime ownership includes conversation, profile, canonical workspace identity, and effective cwd; serialize preparation/turns per runtime | C; independent conversations may run concurrently | P2, P5 |
| Worktree isolation/workspace relocation | Run in resolved worktree cwd; invalidate stale runtime on move/profile/cwd change; test native reload assumptions across paths | C/P; preserve canonical `workspaceId` | P2, P5 |
| Export/share/search/pins/session history/manual titles | Existing Cockpit message/session services consume normalized events unchanged | C; regression checks, no native transcript scraping | P5, P7 |
| Auto titles and session summaries | Use restricted text execution only after G1; until then return existing deterministic fallback without starting a tool-enabled request | U safe restricted path; fallback is required for core | P6 |
| Goals and autonomous goal controls | Keep capability false and endpoints unavailable; investigate native set/status/pause/resume/clear and budget semantics separately | U; G6, no Cockpit-synthesized goal loop | P9 |
| Subagent cards/background work | Keep `agents:false`; ordinary tool rendering may remain, but do not invent child IDs or ownership | U; G7 including late completion/usage/cancellation | P9 |

### 3.3 Files, media, artifacts, and usage

| Cockpit functionality | CoCo implementation | Evidence / release gate | Work |
|---|---|---|---|
| File uploads and queued attachments | Retain existing upload storage/markers; attach verified image bytes through ACP where needed; retain text/path handling for other files | P; chat options currently lack structured attachments, so add a narrow bridge from validated upload metadata | P3, P5 |
| Image understanding | ACP image content blocks using verified MIME/bytes; capability enabled only for verified model IDs or trustworthy native modality metadata | V PNG on `claude-sonnet-4-6`; do not assume all Auto/vendor models support images | P3, P6 |
| Attachment OCR | Existing OCR endpoint calls image-capable one-shot path with selected profile/model and cancellation | P native media only; requires both media and tool-enabled one-shot gates | P6, P7 |
| KB PDF/DOCX/PPTX/image conversion | Keep Pandoc/LibreOffice/page rendering; send rendered page images to verified CoCo image transport, preserve existing conversion manifests and retries | C/P; no need to claim native PDF input to process rendered PDFs | P6 |
| Native PDF/audio/video input | Fail closed through existing modality checks; investigate per model and transport independently | U; G4 | P9 |
| Generated downloadable files | Decode native resource/file content or known successful tool output into existing artifact events; let `artifactStore` persist and authorize downloads | P; generated office/PDF/code files require actual fixtures | P3, P5 |
| Image/audio/video generation | Show generated files through ordinary artifact path if actually emitted; no generation capability based solely on model family | U; G4 | P9 |
| File explorer/previews/Git Changes/downloads | Existing Cockpit filesystem/Git endpoints; resolve references against effective workspace and preserve access checks | C; regression checks after native edits | P5, P7 |
| Input/output/cache token accounting | Final prompt usage maps to existing four counters and ledger; test sequential-turn semantics to avoid cumulative/delta duplication | V fields; reconciliation pending | P3, P5 |
| Context meter | Map `usage_update.used/size` to bounded snapshot percentage, separate from token totals | V snapshot structure | P3, P7 |
| USD cost, estimated cost, quota/credits | Show unavailable cost with `costSource:'none'`; do not apply direct vendor rates to Snowflake-routed models or display missing data as free | U billing; G10, existing estimator/UI need CoCo exclusions | P3, P7, P9 |
| Usage dashboard/export/history | Existing conversation/session/backend/model aggregates; preserve unknown pricing and incomplete interrupted-turn usage | C; no historical pricing fabrication | P5, P7 |

### 3.4 Memory, knowledge, context, and scheduled work

| Cockpit functionality | CoCo implementation | Evidence / release gate | Work |
|---|---|---|---|
| Workspace instructions/status/repair | Add CoCo to `AGENTS.md` instruction mapping and compatibility status; preserve user-authored files and managed blocks | V native pointer read; C repair/store | P1, P5 |
| Cockpit Memory note/search in chat | Native plugin runs existing `memoryMcp/stub.cjs`; preserve workspace/conversation token scope and server-side governance | V shim + HTTP fixture, not production governance | P5 |
| Memory extraction/write governance/consolidation | Existing Memory service selects a strict tool-free processor; CoCo unavailable for this role until G1 passes | U strict processor; Memory tools can still work through another configured processor | P6 |
| Memory search/browser/edit/notifications | Existing server stores and UI; test actual accepted/rejected/redacted outcomes and exact-file notifications | C; never bypass governance with direct writes | P5, P7 |
| Native CLI memory import/watch | Disable native CoCo memory in managed runtimes with verified `CORTEX_ENABLE_MEMORY=0`; keep `extractMemory/getMemoryDir` null | P disabled in probes; verify suppression, no native import claim | P2, P5 |
| KB chat search | Native plugin runs `kbSearchMcp/stub.cjs` with its separate token; normalize prefixed/deferred/wrapped tool activity | V fixture search result reached assistant | P5 |
| KB ingestion and attachment conversion | Existing ingestion pipeline and media gate; select CoCo only for proven model/transport combinations | P; G4 image subset | P6 |
| KB digestion, chunking, gleaning/glossary | Tool-enabled `runOneShot/runSessionShot`, same ephemeral native session for sequential prompts, selected profile/model/effort | P protocol feasibility; actual database/materialized output tests required | P6 |
| KB dreaming/re-dream/synthesis | Tool-enabled one-shot plus temporary KB MCP plugin; preserve service orchestration, operation parsing, retries, and cancellation policy | P; actual synthesis/search/glossary tests required | P6 |
| Embeddings/vector rebuild/KB browser | Retain SQLite/PGLite/Ollama and existing deterministic services; CoCo is not an embedding replacement | C; verify no regression or forced re-digestion | P6 |
| Workspace Context in active chats | Existing managed `AGENTS.md` block points to markdown operating memory; native filesystem tools follow it | V synthetic pointer; full service path pending | P5 |
| Context scan/maintenance/schedules | Tool-enabled one-shot with existing source planning, markdown stores, active inbox consumption, run history and retention | P; no Workspace Context MCP or retired review workflow | P6 |
| Routine proposals and authoring | Existing contracts and opt-in instructions; CoCo edits routine markdown and submits proposals through current workflow | C/P; preserve disabled-workspace behavior | P6 |
| Routine manual/scheduled execution | Tool-enabled one-shot, per-run working folder, selected profile/model/effort, timeout/abort, run history | P; successful completion requires persisted outputs, not `end_turn` alone | P6 |
| Routine Telegram outreach | Existing Cockpit transport/destination pairing; routine requests use established contracts | C; test with a local stub, no real recipient needed | P6 |
| Global/workspace processor overrides | Resolve existing role settings to CoCo profile, then enforce that role's execution/media capabilities on client and server | C + new gate needed; no implicit fallback to a different harness | P1, P6, P7 |

### 3.5 Client and infrastructure boundaries

| Cockpit functionality | CoCo implementation | Evidence / release gate | Work |
|---|---|---|---|
| Desktop composer/settings/chat cards | Use shared metadata/events; add connection fields, OAuth controls, identity/icon, plan feedback, honest usage and unsupported-role messaging | C; browser tests required | P7 |
| Mobile PWA | Support current mobile chat surface: profile/model/effort, questions/plans/revision, upload/OCR where enabled, abort/reconnect/history/artifacts/usage | C; administrative setup/install remains desktop as today | P7 |
| PWA packaging/metadata | Build normal mobile assets; no new manifest permissions, service-worker auth storage, icon set, or native app needed | C; evaluate but do not regenerate unrelated branding assets | P7, P8 |
| Web auth/CSRF/TLS/remote access | Existing authenticated API; OAuth redirect is supplied to Cockpit by authenticated POST, not an unauthenticated public callback | C; native loopback listener remains local | P4 |
| Logging/diagnostics | Use backend logger; bounded redacted protocol diagnostics, no codes/state/tokens/connection files in reports | C; secret-redaction fixtures required | P2, P4, P9 |
| Other harnesses | Existing APIs, protocol implementations, runtime modes, credentials, pricing, and defaults retained | C; shared-contract/selection regression coverage | P1–P9 |

## 4. Proposed architecture and file ownership

Use `BaseBackendAdapter` as the public contract. Keep `ChatService`, existing
service facades, and browser APIs as orchestration boundaries. Proposed new
filenames below are implementation targets, not claims that those files exist.

| Module / existing integration point | Responsibility |
|---|---|
| `src/services/backends/cortex.ts` | `CortexCodeAdapter` facade, metadata, chat/one-shot orchestration, reset/shutdown and deterministic title/summary fallback |
| `cortexProtocol.ts` | JSONL framing, typed version-scoped ACP shapes, RPC IDs/timeouts/errors, reverse requests, stream queue |
| `cortexRuntime.ts` | Effective profile/env/connection resolution, runtime preparation serialization, native session lifecycle, fingerprints and idle eviction |
| `cortexProcess.ts` | Executable launch, stdout/stderr discipline, process/descendant identity and termination across normal/root-exit paths |
| `cortexEvents.ts` | Native update → Cockpit event mapping, replay suppression, tool/outcome normalization, resource/artifact extraction |
| `cortexInteractions.ts` | Pending permission/question/plan ownership, answer validation, cancellation and exactly-once reverse responses |
| `cortexModels.ts` | `configOptions` model/effort/mode discovery, profile-scoped model metadata and modality evidence |
| `cortexUsage.ts` | Turn usage and context snapshots, deduplication, unknown pricing and incomplete-turn handling |
| `cortexPlugin.ts` | Private native plugin manifest, existing MCP shim translation, env references, refresh fingerprint and cleanup |
| `src/services/cortexAuth.ts` | Native manual OAuth launch/output parsing/redirect validation/fresh-process verification; called by auth facade |
| `src/services/cortexConnections.ts` | Focused Snowflake connection-name enumeration and safe selected-connection creation/update, if needed for setup |
| `src/types/cliProfiles.ts`, `src/types/backends.ts`, `src/types/index.ts` | Server declarations and exports; no implementation inside type modules |
| `src/contracts/chat.ts`, `responses.ts`, `streamFrames.ts`; proposed `cliAuth.ts` | Browser-safe profile validation/projection, optional capabilities and auth handoff DTOs; never expose native process/credential state |
| `server.ts`, `src/services/cliProfiles.ts`, `settingsService.ts` | Registration, harness normalization/defaults, connection config validation/persistence |
| `src/services/cliProfileAuthService.ts`, `src/routes/chat/cliProfileRoutes.ts` | Existing auth job facade/routes; delegate CoCo native auth logic instead of growing another monolithic protocol branch |
| Existing stream/recovery/artifact/usage stores | Consume normalized CoCo events and persist canonical Cockpit state; no new competing transcript/ledger store |
| Existing desktop/mobile focused modules | Render shared contracts; keep runtime/native ACP details server-side |

Do not copy Grok goal, billing, or subagent modules into CoCo without native
evidence. Extract a shared transport/process helper only if implementation
demonstrates a small reusable boundary and adds direct regression tests.

### 4.1 Profile contract

Proposed persisted shape, extending the existing profile contract:

```ts
{
  id: 'my-coco-profile',
  name: 'CoCo',
  harness: 'cortex-code',
  authMode: 'server-configured', // or existing setup/account mode
  cortexCode: { connection: '<named Snowflake connection>' },
  // command?: '<explicit executable>',
  // configDir?: '<explicit isolated Snowflake home; gated until verified>',
  // env?: { ...existing supported runtime overrides... },
  createdAt: '<timestamp>',
  updatedAt: '<timestamp>'
}
```

Require a nonempty named connection for a configured CoCo profile so ACP cannot
drop into connection-selection UI. Welcome may hold incomplete connection input
in a draft; do not mark that draft ready for chat. Preserve harmless connection
names verbatim as argument-array values, reject NUL/control characters, and
never interpolate profile data into a shell command.

Normal setup profile IDs follow existing `setup-<harness>-account` conventions.
Extend shared-auth normalization to CoCo: remove setup-owned `configDir` and
`SNOWFLAKE_HOME` overrides, preserve ordinary connection selection and unrelated
environment values, and do not edit other harness profiles. An explicit
server-wide Snowflake environment remains part of runtime resolution.

Persist connection selection, not copied connection credentials. Public profile
responses expose only fields needed by clients; do not return Snowflake account,
username, secrets, full connection contents, or effective environment by default.
Connection creation/account input belongs to authenticated setup endpoints.

### 4.2 Capability contract and initial values

Initial metadata target after adapter verification:

```ts
capabilities: {
  thinking: true,
  planMode: true,
  agents: false,
  toolActivity: true,
  userQuestions: true,
  stdinInput: false, // unsolicited mid-turn steering; pending replies still work
  goals: false
}
resumeCapabilities: {
  activeTurnResume: 'unsupported',
  sessionResume: 'supported' // only once adapter reload/recovery tests pass
}
```

Image one-shot transport is added only after the actual one-shot path passes;
model `input.image:true` is independently required. Do not mark every returned
model image-capable because the ACP server advertises image content support.

Proposed ADR-0093 records optional `BackendCapabilities.oneShot` role support
(`restrictedText`, `toolEnabled`, `sequential`) and `planRevision`, with steering
distinguished from pending replies. Add these fields in P1 with shared contracts.
Existing adapters retain existing
behavior when optional metadata is absent; CoCo explicitly advertises false
until each execution path passes. A shared eligibility helper must enforce
CoCo's explicit limits at every processor selector and server call boundary.

Current `stdinInput` alone cannot describe both interaction replies and
steering. Keep it false for CoCo unsolicited input, route pending replies through
`sendInput`, and test that normal input is queued or rejected clearly instead
of being acknowledged and dropped. If the shared input route needs an accepted/
unsupported result to guarantee this, add it compatibly for all adapters.

## 5. Runtime, protocol, and lifecycle design

### 5.1 Launch and runtime ownership

Baseline command shape:

```text
cortex acp serve -c <connection> -w <effective-cwd> --plugin-dir <private-plugin>
```

Phase 0 selected `--only-explicit-plugins`, `--only-explicit-skills`, and
`--only-explicit-mcp-servers` for initial managed startup as well as compatibility
fixtures. This intentionally skips ambient plugins/global skills/user MCP and
plugin auto-update without modifying user config. Project/bundled skills remain;
ordinary tools and selected Snowflake auth are retained. Verify effective hooks,
delegation and discovery behavior in adapter acceptance; these switches do not
establish restricted processor isolation. See Proposed ADR-0093 and the research
follow-up for installed-source evidence that direct ACP dispatch bypasses the
main binary updater. Do not prepend unsupported global update flags.

Set verified native memory suppression in managed children. Keep manual OAuth
UI in an auth job; ordinary ACP runtime launch should surface auth-required
instead of leaving an invisible login wizard waiting indefinitely. Prove that
behavior with expired/missing credentials before release.

Runtime cache/fingerprint inputs: conversation ID, profile ID and effective
configuration, canonical workspace identity/effective cwd, executable/version,
connection/auth home, sanitized instructions, and MCP token/config generation.
Never use raw tokens as logged fingerprint material. Serialize preparation and
reserve a runtime before awaits so concurrent metadata, turns, reset, auth,
or token refresh cannot create cross-owned sessions.

Idle eviction closes only that runtime. `shutdownAll()` must close current
children but allow subsequent fresh ones after CLI updates. A startup completing
after reset/shutdown-generation change must immediately close itself. Every turn
announces existing `external_session` and `backend_runtime` persistence signals.

### 5.2 Turn lifecycle

1. Resolve runtime/profile/cwd and enforce role capabilities before launching.
2. Prepare private plugin/env; initialize ACP with only client methods actually
   implemented. Do not claim client filesystem/terminal capabilities by default.
3. Create native session or load the persisted ID. Suppress replay updates and
   pending interactions during loading; bound the restore operation.
4. Read current `configOptions`; apply model/effort/mode through native config
   methods, including explicit reset-to-auto when changing from an override.
5. Attach event/interaction handlers before prompting; send instructions through
   a tested native mechanism or a clearly separated sanitized prompt envelope.
   Do not assume ACP has a system-message field. Test instructions on load as
   well as new sessions, without duplicating them on every turn.
6. Stream only owned updates; classify native errors; reconcile final usage and
   terminal state; clear pending interactions exactly once.
7. Release runtime reservation, arm idle cleanup, and let existing stream jobs/
   finalizers persist messages and process the queue.

Use native session load only within the same effective profile/connection
scope. Test `session/fork/list` separately if ever needed; advertised methods
do not require adding a new Cockpit feature in this integration.

### 5.3 Interactions and failure policy

Questions carry `_meta.questionIndex/totalQuestions`. Free-form options carry
`_meta.freeForm`; return typed text as `outcome._meta.freeFormText`. Preserve
labels and native IDs separately. Plans use `switch_mode` with
`proceed/keep_planning`, and a preceding `plan` update contains
`_meta.planDocument`. Reject blank/duplicate/stale responses; request ID `0`
must work. Abort/reset/process exit settle every outstanding reverse RPC.

Do not classify every failed tool as a failed turn: rejected plans can produce
failed tool updates before a successful revision. Conversely, do not count
`end_turn` as proof of success. Define narrow version-tested signatures for
native auth/connection/API errors, preserving useful diagnostics as errors.
Missing usage is a signal to inspect, not a standalone failure rule. Test
legitimate answers quoting `Error:` to avoid broad text false positives.
Unknown terminal conditions must remain visible, not silently reported as a
successful processor output. Structured-output callers still validate their
schemas; never automatically retry a turn that may have performed tool work.

### 5.4 Process cleanup

Request native cancellation first, then enforce an external deadline. Track
owned descendant PID plus start identity while the root is alive, including
separately detached shell groups; retain ownership after root death. Reuse the
smallest appropriate tested pattern from Grok without changing its behavior.
Document observation-race limitations: userspace polling is not OS containment.
Add native tests for sleepers, child detachment, forced root death, cancellation
during setup/permission/tool execution, and post-timeout file absence.

Windows needs real child-tree termination evidence, not just POSIX tests or a
mocked `taskkill`. Do not kill by broad executable name or stale PID alone.
Clean owned plugin files/listeners/timers on every completion path.

## 6. Remote OAuth setup design

### 6.1 User flow

1. Select Cortex Code in Welcome/Settings; detect the executable and select an
   existing named connection or create a dedicated OAuth connection using account
   and user input. Explain login access separately from model availability.
2. Reuse existing saved terminal auth when a fresh-process check passes.
3. Otherwise start a native manual OAuth job. Show **Open login page**, **Copy
   login URL**, expiry/countdown, and a field for the **complete redirect URL**.
   The browser can be on another machine. The native listener stays on the
   Agent Cockpit machine; no public listener/proxy is required.
4. Accept the full `http://127.0.0.1:<port>/?code=...&state=...&iss=...`
   returned after login. Validate it against this active job, then deliver it
   through the waiting CLI's stdin/manual flow, retaining native exchange logic.
5. Verify connection and a minimal real request in a fresh process; report
   authenticated/inference-ready only on positive evidence. Distinguish missing
   model grant, networking, auth expiry, and CLI unavailability.
6. On timeout/cancel, stop the owned login/listener, discard transient state and
   allow a new attempt. Never apply an old redirect to the new attempt.

The tested interactive login command was
`CORTEX_OAUTH_MANUAL=1 cortex --no-auto-update -c <connection>`; this is separate
from ACP launch argument ordering. Confirm pipe-versus-PTY behavior for native
prompts/onboarding before selecting the smallest reliable job transport.

### 6.2 API and contract changes

Reuse existing `/api/chat/cli-profiles` test/start/setup-auth/job/cancel routes.
Propose only these narrow additions, with browser-safe runtime validators:

| Proposed boundary | Purpose |
|---|---|
| `GET /api/chat/cli-profiles/cortex-code/connections` | Safe connection names/availability for the server's normal Snowflake home; no raw TOML or credentials |
| `POST /api/chat/cli-profiles/cortex-code/connections` | Optional create-only OAuth connection from validated name/account/user; selected conflict returns a reviewable error, never overwrites another connection |
| `POST /api/chat/cli-profiles/auth-jobs/:jobId/redirect` with `{redirectUrl}` | Submit only the active job's native manual redirect |
| Extended auth job snapshot | Add typed handoff state, copyable authorization URL and expiry while active; native callback ownership/state remains server-private |

Check route order so `cortex-code/connections` is not captured by generic `:id`
handlers. Use existing authenticated access, CSRF checks for mutation, body limits,
rate/deadline controls, and bounded sanitized errors. Add routes to canonical
specs only when implemented. Connection discovery/create for explicitly isolated
profiles is gated until isolation semantics pass; do not let a browser choose
arbitrary filesystem locations through these endpoints.

Validate scheme/loopback host, exact issued port and callback path, expected
state and issuer, single code/state/issuer parameters, and active attempt
generation. Reject userinfo, fragments, duplicates, malformed/oversized URLs,
non-loopback targets, completed jobs, and stale redirects. Delegate token
exchange/PKCE to the native CLI. If future native jobs cannot expose enough
ownership information, block handoff rather than forward arbitrary URLs.

Do not save redirect URLs, authorization codes, PKCE secrets, tokens, raw native
connection output, or complete authorization URLs into job history, logs,
transcripts, analytics, exports, or browser persistent storage. The active UI
may display its login URL; strip transient handoff data at terminal job states.

### 6.3 Timing, connection files, and verification

The native default wait was 120000 ms; a selected OAuth connection with
`browserActionTimeout = 600000` succeeded. Align Cockpit job expiry with the
actual native deadline; the existing outer auth timeout alone does not extend
the SDK wait. Preserve comments/unrelated TOML entries with a reviewed parser/
writer or narrowly tested edit strategy. Use atomic writes, preserve/restrict
file permissions, and avoid placing credentials in profile env or argv.
If updating an existing connection's timeout is needed, make the specific change
visible in setup and preserve the rest of the connection; creating a new
dedicated connection is safer than overwriting existing connection fields.

One login job owns a selected connection/auth scope at a time. Never remove a
native auth lock with a live owner. For stale locks, verify native ownership
format and exited PID/start identity before any recovery; prefer native recovery
where practical. Do not delete unrelated credential caches.

ACP initialize/authenticate/session creation is not verification: 1.2.35's
`authenticate` is a no-op. A version-tested fresh-process inference check should
be minimal, bounded, disclose that it makes a real request, use no approval of
tool work, validate its exact marker, and avoid repeated polling that bills
requests. Reuse its verified result within the active setup attempt; a catalog
request alone does not upgrade an unknown auth state to authenticated.

## 7. Memory/KB plugin and processor execution design

### 7.1 Managed MCP plugin

Generate a private runtime directory containing `.cortex-plugin/plugin.json`
with a fixed Cockpit plugin identity and inline `mcpServers`. Translate existing
`McpServerConfig` command/args/env into the native plugin schema. Use the actual
Node executable and existing stdio shims, with distinct Memory and KB token/env
names. Put secret values in child environment, reference placeholders from the
manifest, and keep runtime directories out of migration bundles/source control.

Do not modify global CoCo settings or user plugin files. Include only services
enabled for that workspace and execution role; no Memory/KB tool leakage across
conversations or disabled features. Treat deferred `tool_search` and
`direct_tool_calling` wrappers as native activities without double-counting the
same operation or exposing bearer credentials.

When endpoint/token/instructions/profile change, wait for a safe boundary,
close the old runtime, create fresh plugin/env, and `session/load` the saved ID.
Test expiry, revocation, disabled Memory/KB, service restart/port change, pending
interactions and aborted refresh. Never refresh by replaying user tool work.
Remove abandoned private directories only after proving no owned runtime uses
them; cleanup must also cover abrupt server restart.

### 7.2 Execution classes and eligibility

| Execution class | Existing callers | CoCo behavior |
|---|---|---|
| Interactive tool-enabled chat | Normal conversations, Memory/KB tools | Native persistent session; user-facing questions/plans; managed MCP |
| Tool-enabled ephemeral work | KB conversion/digestion/dreaming, Workspace Context, Routines, attachment OCR where requested | Implement `runOneShot` with `allowTools:true`, owned temporary session/plugin, caller timeout/abort, tested headless permission policy |
| Sequential ephemeral work | KB gleaning via `runSessionShot` | Preserve one native session across prompts with per-prompt output, common overall deadline, same tools/model/effort and complete cleanup |
| Strict tool-free text | Memory write governance/extraction/consolidation and any title/summary or other caller using default `allowTools:false` | Reject before native prompt while G1 is open; title/summary return deterministic fallback; Memory selection unavailable |

Keep default `allowTools:false`. Never upgrade a restricted caller to unrestricted
execution or claim that rejecting reverse permission requests removes tool
definitions, hooks, commands, or all side effects. A strict path needs evidence
for native/deferred tools, MCP, hooks, skills, slash commands, sequential prompts,
session reload, and missing-auth behavior. If no complete native restriction
exists, retain another explicit Memory processor rather than implement a separate
LLM API behind the CoCo label.

One-shot headless work must not hang on human questions/plans; define a fail-fast
interaction policy consistent with each service's contract and native permission
mode. Honor caller abort/deadline across setup, prompts and cleanup. Validate
structured outputs through existing services; do not edit their schemas merely
to accept a CoCo error message. Audit existing KB retry logic so a reported
connection/API failure cannot automatically duplicate side-effectful native work.

## 8. Client behavior and unsupported features

Desktop settings adds a CoCo option, connection selector/input, shared-auth
explanation, executable override, and auth state/actions. Keep isolated-home
controls unavailable or explicitly experimental until G5. Welcome offers CoCo
as optional; it must not become a new global prerequisite for existing users.

Composer/model/effort selectors consume shared metadata. Clear unsupported
Claude mode/Codex tier/goal settings when switching profiles. Preserve selected
connection/model per profile and ignore late model metadata from another
profile. The account-specific catalog can change after authentication.

Replace current Grok-only plan feedback checks in desktop `chatLive.jsx` and
mobile `mobileChatScreen.tsx` with the narrow shared plan-revision capability.
Reuse existing interaction cards; do not expose native JSON-RPC fields to users.
Show one pending question at a time, preserve free text, prevent double-submit,
and keep controls correct through reconnect/abort/reset.

Mobile uses the existing PWA chat scope. Administrative OAuth setup remains in
the desktop/responsive setup page unless a later product request adds mobile
administration. A phone browser can still open the native login URL and return
its redirect through the supported setup page. Test copy/paste on narrow screens.

Unavailable features must be consistent across UI, metadata and API: goals,
subagent grouping, unsolicited steering, strict processors, unverified media,
native memory import and account billing. Do not create empty Agent cards,
show unsupported goal controls, or display unavailable Snowflake cost as `$0`.
Existing file/Git/KB/Memory/workspace screens remain Cockpit-owned features.

## 9. Implementation phases and task tracker

Phase 0 preparation tasks are complete. Production implementation tasks remain
unchecked. Suggested PR boundaries follow the phases; combine small adjacent
phases when that reduces temporary broken paths.
Do not publish a half-registered harness as usable before core gates pass.

| Phase | Dependencies | Exit evidence |
|---|---|---|
| P0 — Baseline and decisions | This plan | Sanitized fixtures, gate experiments and Proposed ADR ready |
| P1 — Contracts and profiles | P0 | Profile round-trip and capability/eligibility tests pass |
| P2 — Transport/runtime/process | P1 | Fixture protocol/session/lifecycle tests and real smoke pass |
| P3 — Events/interactions/models/usage/media | P2 | Native event and interaction acceptance with correct usage/errors |
| P4 — Connection/auth setup | P1, P2 error/verification primitives | Native remote OAuth through Cockpit and fresh-process verification |
| P5 — Durable chat and MCP | P2, P3; authenticated P4/profile | Real Cockpit conversation/Memory/KB/recovery/cleanup scenarios pass |
| P6 — Background processors | P3, P5; G1 only for strict paths | Each selected workflow has independent real service evidence |
| P7 — Desktop/mobile parity | P1, P3–P6 capability contracts | Browser suites and builds/typechecks pass for supported scope |
| P8 — Install/update/migration/platforms | P2, P4 | Reviewed native/platform paths and dependency checks pass |
| P9 — Compatibility/release and parity research | Core phases; platform-specific P8 | Recorded compatibility reports, canonical specs and release checklist |

### P0 — Baseline and decisions

- [x] C01 — Capture sanitized 1.2.35 initialize/new/load/config/update/result and
  reverse-RPC fixtures from the retained research; exclude account IDs/secrets.
  Verify fixtures include error-as-text, request ID 0 and replay ordering.
- [x] C02 — Run focused experiments for G1/G2/G9 before promising processor or
  platform parity; record exact argv, version, evidence and unresolved gaps.
- [x] C03 — Scaffold a Proposed ADR with `npm run adr:new -- "Integrate Cortex
  Code through its native ACP interface"` when implementation begins. Cover
  dedicated adapter, native auth/plugin ownership, execution gating and rejected
  retry/goal emulation/generic-ACP alternatives. Populate only existing affects
  paths as they land; do not edit Accepted ADR text or generated ADR index.

Phase 0 evidence: seven versioned excerpts in `test/fixtures/cortex/1.2.35`,
the real `scripts/probe-cortex-phase0.ts` run on 2026-11-05, and
[Proposed ADR-0093](../adr/0093-integrate-cortex-code-through-its-native-acp-interface.md).
Read the [research follow-up](../research/cortex-code-acp-evaluation.md#phase-0-follow-up--2026-11-05)
for results and limitations. C02 completion records experiments and scope
decisions; it does not close the production release gates below.

### P1 — Contracts and profiles

- [x] C04 — Add harness/backend identity/label plumbing, including
  server-configured IDs and setup-profile recognition. Verify existing defaults
  and legacy `vendor` migration remain stable. Register the actual adapter in
  after event/interaction mapping and the advertised adapter surface exist;
  P1/P2 foundations do not expose a runnable backend.
- [x] C05 — Add validated `cortexCode.connection` to server profile types,
  normalization and browser-safe draft/settings contracts. Verify create/edit/
  load/save, unknown/wrong-type fields, disabled/missing profiles and env/command
  handling without credential disclosure.
- [x] C06 — Add explicit execution/interaction capability metadata and one
  shared role-eligibility helper. Verify chat, restricted Memory, tool-enabled
  processors, image tasks, replies and steering are distinguished correctly.
- [x] C07 — Add CoCo to instruction harness labels/source mapping using
  `AGENTS.md`. Verify status/repair preserves user content and existing harnesses.

P1 evidence: `test/cortexProfiles.test.ts`, `test/backendCapabilities.test.ts`,
existing media/settings/auth/instruction/update coverage and backend/web/mobile
typechecks. [Current CoCo foundations](../spec-cortex-code.md) define persisted
drafts versus configured profiles and the shared policy. Role enforcement in
every processor/client remains P6/P7 work; P5 now registers the native chat adapter.

### P2 — Transport, runtime, and lifecycle

- [x] C08 — Implement typed JSONL ACP client with split/multiple frames,
  malformed/oversized stdout, stderr diagnostics, numeric/string/zero RPC IDs,
  reverse requests, timeout and EOF/error propagation tests.
- [x] C09 — Implement executable/env/cwd/connection resolution and exact ACP
  argv. Verify no shell interpolation, no terminal stdout, no config wizard,
  correct version detection and compatible automatic-update control. Register
  the dedicated adapter only once the runtime implements its advertised surface.
- [x] C10 — Implement serialized per-conversation runtime/session preparation,
  fingerprints and profile-scoped metadata discovery. Verify concurrent startup,
  model catalog failure, profile/cwd changes and session close.
- [x] C11 — Implement native cancel with bounded fallback and owned descendant
  cleanup. Verify live sleeper stops, root-exit descendants stop, unrelated PIDs
  survive and no interrupted command is retried.
- [x] C12 — Implement idle/reset/shutdown generation handling. Verify late
  startups close, pending RPCs/interactions terminate and a new runtime works
  after `BackendRegistry.shutdownAll()`.

P2 evidence (November 6): dedicated transport/runtime/session/process modules,
47 focused tests, and `scripts/probe-cortex-runtime.ts` using the actual new
modules on CoCo 1.2.35 / macOS arm64. Real authenticated inference, native
cancel/session reuse, saved-session load, forced-root descendant cleanup,
empty-auth inference failure and reusable shutdown passed. The registry boundary
is tested through a lifecycle-only test adapter. Server registration waits for
P3/P5's advertised adapter/event/chat surface; no runnable capabilities are
published by P2. See [the current runtime spec](../spec-cortex-code.md).
The private report includes revision 869ee8a plus the P2 dirty working tree and
no account/connection/OAuth data. Discovery is intentionally uncached until
model mapping needs a profile-scoped cache. Native Windows is explicitly gated;
Linux certification and full app compatibility remain pending.

### P3 — Events, interactions, models, usage, and attachments

- [x] C13 — Map text/thinking/tools/outcomes and edit/diff/resource content to
  normalized events. Verify fragmented updates, unknown variants, duplicated IDs,
  nonfatal failed tools and session ownership.
- [x] C14 — Implement `configOptions` parsing, dynamic model catalogs and
  `session/set_config_option`. Verify model/effort changes, native auto reset,
  invalid selections, stale catalogs and profile separation.
- [x] C15 — Implement question/free-text/sequential-question replies and
  ordinary permissions. Verify request ID 0, option identity, no double response,
  stale replies, denied/unknown requests and process exit.
- [x] C16 — Implement plan approval/reject/revise with prior plan document.
  Verify fixture output appears only after approval, revision produces a new
  gate and rejected tools do not end a valid revision turn.
- [x] C17 — Implement version-tested error classification and result handling.
  Verify missing auth, service/API failure, timeouts, legitimate quoted errors,
  absent usage and unknown failures without success fabrication or retries.
- [x] C18 — Implement token/cache/context normalization, ledger deduplication
  and unknown pricing. Verify two turns, cache hits, replay, abort/incomplete
  usage and estimator exclusion from direct Anthropic/OpenAI prices.
- [x] C19 — Implement validated attachment bridge and explicit ACP image
  content for verified models. Verify queued uploads, unsupported formats/models,
  image limits/MIME and no accidental file-content exfiltration via arbitrary paths.
- [x] C20 — Implement artifact extraction through existing storage. Verify
  generated text/code/office/PDF files, filenames, ownership, download/preview,
  duplicate events and non-file resources; defer native image generation claims.

P3 evidence (November 6): 30 focused tests and `scripts/probe-cortex-events.ts`
using the dedicated turn bridge on real CoCo 1.2.35 / macOS arm64. Native dynamic
model configuration, low-to-auto effort reset, explicit file delivery/storage,
sequential/free-form questions, stale duplicate rejection, revised plan approval
and PNG recognition passed. Plan fixture writes were absent at both gates and
appeared after approval. An empty auth home omitted the model catalog, blocking
configured chat before prompting; an independent raw native request verified
the retained connection-error classification. API 408 behavior is retained
native fixture evidence, not a newly forced live outage. Tests also exercise
real queue/upload, artifact download/text preview and ledger storage boundaries.
PNG is limited to the verified model/version; other input formats, strict
processors, native image generation and full app/client execution remain gated.
Artifact events follow explicit delivery markers/resources, not every code edit.
No adapter or new routes are registered by this phase. See the current spec for
the ownership/limits and testing doc for the opt-in runner and evidence scope.

### P4 — Shared connection and remote authentication setup

- [x] C21 — Implement safe connection enumeration and dedicated OAuth connection
  creation. Verify TOML quoting, comments/other connections, duplicate names,
  file permissions, atomic writes and setup input validation.
- [x] C22 — Implement native auth job transport/state parsing with manual OAuth
  and the selected connection's effective browser timeout. Verify no competing
  job, first-run prompts, pipe/PTY choice, timeout/cancel/retry and stale locks.
- [x] C23 — Add handoff contracts and redirect submission route. Verify exact
  job generation/loopback/state/issuer matching, malicious targets, duplicate
  params, expired jobs, authorization/CSRF and one-time submission.
- [x] C24 — Implement fresh-process auth/request verification with bounded
  synthetic prompt and no tool approval. Verify saved auth reuse, empty home,
  invalid/expired credentials, account/model grant failure and sanitized output.
- [x] C25 — Extend setup shared-auth normalization and add Welcome/Settings
  controls. Verify terminal and Cockpit use the same normal auth, existing
  explicit isolated profiles are untouched, and codes/state/tokens never persist.
- [ ] C26 — Run actual remote-browser setup through Cockpit. Record native
  version/platform/deadline, successful redirect ownership, fresh-process exact
  response, cancellation and retry; do not record the real URL/code/account.

P4 implementation evidence (2026-11-06): C21–C25 code and focused tests are
implemented. Native CoCo 1.2.35 / macOS arm64 passed
`scripts/probe-cortex-auth.ts` through a PM2-isolated real Cockpit server and
headless browser: shared saved login, exact fresh-process inference, cached
login jobs, cancellation/retry, unauthenticated remote rejection and 390px
viewport fit. The native job reused terminal credentials; no browser URL was
fabricated. A separate temporary native-home/connection metadata probe reached
first-run onboarding/account-test completion through the actual PTY controller.
The pipe experiment exited with the native interactive-terminal requirement.
Fixture suites cover URL/issuer/state/generation, one-time submission, foreign
and duplicate redirects, deadlines, shutdown races, TOML safety and sanitized
failures. Invalid/grant/expired-response cases are deterministic fixtures;
we did not force a live account outage or revoke shared credentials.

Validation: 151 passing suites / 2,759 passing tests, with three opt-in suites
and 20 tests skipped. V8 statements/lines 88.33%, branches 75.56%, functions
93.69%; floors raised to 88.2% / 75.3% / 93.5%. Backend/desktop/mobile typechecks,
zero-warning lint, maintainability, API drift, ADR lint and both production
builds pass. The lazy setup chunk is 5.2 KiB; index stays below 260 KiB. The
aggregate JS budget is intentionally 910 KiB (actual 903.3 KiB), with a separate
8 KiB setup chunk guard. Existing CSS aggregate limit remains unchanged.

**C26 remains open.** Earlier successful research OAuth and the new ownership
fixtures are not an actual human remote-browser handoff through these routes.
The current shared login is valid; do not delete/revoke it merely to fabricate
a challenge. Re-run actual setup when a native login challenge is needed and
record its selected deadline plus the new redirect's ownership/fresh inference.
P5 now adds adapter registration and chat; processors and updates remain pending. Current
behavior and exact limits: [CoCo specification](../spec-cortex-code.md).

### P5 — Durable chat, recovery, and managed MCP

- [x] C27 — Implement private plugin generation from existing Memory/KB MCP
  configs. Verify native discovery and real stdio shims, env placeholders,
  separate tokens, feature disablement and manifest cleanup.
- [x] C28 — Implement refresh by safe-boundary respawn/session load. Verify
  rotated/expired/revoked tokens, new endpoint, no stale permissions, no leaked
  runtime files and context retained without transcript duplication.
- [x] C29 — Wire `external_session/backend_runtime` and saved-session reload.
  Verify nonce continuity after idle/server restart, replay suppression, missing
  native session recovery and no active-turn prompt resend.
- [x] C30 — Exercise existing stream jobs, finalizers, queue, abort/reset,
  archive/delete, profile switching and reconnect. Verify exactly one persisted
  answer, terminal boundary and usage application per turn.
- [x] C31 — Exercise real Memory governance/search and KB database search with
  isolated Cockpit data. Verify scopes and write outcomes with a separately
  supported Memory processor while CoCo strict execution remains gated.
- [x] C32 — Exercise managed instructions/Workspace Context pointer, worktree
  cwd, workspace relocation, file explorer/Git changes and artifact persistence.
  Verify canonical workspace identity and no cross-workspace runtime reuse.

**P5 evidence, November 6, 2026:** `CortexCodeAdapter` is registered for durable
chat. Complete enabled CoCo setup profiles can become the first default while
existing explicit defaults and incomplete-draft gates are preserved.
`cortexPlugin.ts` owns private native manifests/child env and conservative
orphan cleanup; `CortexSessions` owns their runtime lifetime. Focused backend,
plugin and actual process/router suites exercise token/endpoint/feature/context
refresh, idle/load/recovery, abort/reset/archive/delete, queue/profile locks,
question generation through REST/WS/reconnect, instructions/Workspace Context,
worktree writes/Git/downloads and workspace relocation. Current MCP tokens do
not have expiry TTLs; invalid/revoked-token behavior remains the existing MCP
services' focused tests. No new token-expiry policy was added.

The opt-in `scripts/probe-cortex-chat.ts` passed with authenticated CoCo 1.2.35
on macOS arm64, using isolated Cockpit data, real Memory/KB stdio shims, a real
separate Claude Memory processor, governed note persistence/search, SQLite
topic reads and PGLite keyword search. It verified nonce continuity after idle
eviction and adapter restart, one final answer/usage per turn and native file
delivery/storage, plus a relocated native session reading/writing in its new
cwd while retaining canonical workspace/native IDs and nonce. The fixture deliberately disables embedding access; Ollama
semantic search is not certified. An initial probe assertion incorrectly counted
intermediate progress messages as final answers; after correcting the assertion
the complete probe passed. A later run issued no required MCP calls and remains
failed; its cause was not established. The final complete run passed all checks
and exited zero after explicitly closing the fixture's PGLite/SQLite stores
(unclosed PGLite otherwise leaves exit code 99). No production prompt/tool retry
was added. Fresh native runtime drift also passed startup,
cancel/subsequent turn, load, root-exit descendant cleanup, missing auth and
reusable shutdown. Reports remain private temporary artifacts, with no native
account/connection/OAuth values or protocol transcripts committed.

C26 stays open. Full OS-process restart/native browser/desktop/mobile/platform
acceptance remains in P7/P9. Upload options are structured at the adapter
boundary; browser upload/tag bridging remains client work. CoCo one-shot roles,
native goals, agents and unsolicited steering remain unavailable. See
[the current P5 contract](../spec-cortex-code.md#durable-chat-and-managed-mcp-p5).

P5 verification: 154 suites / 2,783 tests pass, with three opt-in suites and
20 tests skipped. V8 statements/lines 88.37%, branches 75.75%, functions 93.77%;
floors raised to 88.3/75.7/93.7. Backend/web/mobile typechecks, zero-warning lint,
maintainability, API drift, ADR lint, both production builds and web budget pass
(JS 903.4/910 KiB, CSS 202.3/230 KiB). Builds were restored after the full suite.
Desktop/mobile changes retain decision generations; PWA metadata is unchanged.

### P6 — Background workflows and processor eligibility

- [x] C33 — Implement tool-enabled `runOneShot` and native `runSessionShot`
  with per-call/session cleanup, deadline/abort and headless interaction policy.
  Verify sequential nonce/gleaning continuity and no concurrent-session reuse.
- [x] C34 — Enforce restricted-path rejection before spawn/prompt while G1 is
  open, deterministic title/summary fallback and Memory selector exclusion.
  Verify programmatic callers cannot bypass the UI gate.
- [ ] C35 — If G1 passes, implement restricted execution and enable only the
  verified roles. Verify zero definitions/operations across native/deferred MCP,
  hooks/skills/commands/slashes and sequential prompts; run actual governance,
  extraction and consolidation before selecting CoCo for Memory.
- [x] C36 — Certify image one-shot transport/model gates and attachment OCR.
  Verify a real image answer/OCR, cancellation and unsupported-model rejection.
- [x] C37 — Certify KB image/PDF/DOCX/PPTX conversion via existing pipelines.
  Verify rendered-page transport, conversion records, retries, reuse and no
  Pandoc/LibreOffice installation regression.
- [x] C38 — Certify actual KB digestion/gleaning/glossary and dreaming/search/
  synthesis operations with isolated databases. Verify structured output parsing,
  cancellation, usage and safe behavior of existing retry policies.
- [x] C39 — Certify Workspace Context scan/maintenance and active Memory inbox
  folding/deletion. Verify schedules, selected profile/model/effort, markdown
  updates, cancellation, zero-source behavior, run retention and disabled state.
- [x] C40 — Certify Routine proposals, manual/scheduled runs, output/history,
  timeout and opt-in instructions. Verify disabled workspaces remain passive and
  outreach contract through a stub without sending a real message.
- [x] C41 — Apply eligibility at all global/workspace processor overrides and
  restore/import boundaries. Verify unsupported saved selections produce useful
  errors and never silently switch harness or enable unsafe tools.

P6 C33/C34/C36 evidence (November 6, 2026; changes following `478d80b`):

- `cortexShots.ts` owns unique tool-enabled ephemeral sessions, native sequential
  continuity, one overall startup/turn deadline, AbortSignal and reusable
  shutdown draining. Questions/plans fail headlessly; interrupted work is never
  replayed or retried by the adapter. Processor files reuse the existing PNG
  byte/model/version limits through trusted server paths outside cwd.
- Focused tests cover concurrent isolation, sequential prompts without replay,
  startup/active cancellation/deadline/shutdown, fresh post-update jobs, private
  error withholding, native question/plan decisions, unsupported media and
  model rejection before prompt. The actual Memory notes route rejects a saved
  CoCo processor without startup or fallback note. The pure Memory-selector
  projection excludes unsupported choices and preserves a disabled saved one.
- Opt-in `CORTEX_PROCESSOR_PROBE=1 CORTEX_TEST_CONNECTION=<saved-name> npx tsx
  scripts/probe-cortex-processors.ts` passed with native 1.2.35/macOS arm64/Node
  26.0.0, exit 0. Private evidence directory:
  `cockpit-cortex-processors-8Vg2wG` under the system temp directory (final repeat
  after shutdown-error draining coverage; the earlier `lD74CG` report also passed). Exact nonce
  recall, actual native headless question, HTTP OCR of a synthetic PNG,
  Auto-image rejection, cancellation after native image submission and a fresh
  exact-response process all passed. Shared terminal auth was retained.
- Earlier probe runs remain failures in their private reports: the first
  sequential stage failed; a diagnostic repeat confirmed exact nonce recall but
  a strict acknowledgment mismatch. A subsequent run reached OCR but exceeded the HTTP
  test helper's 15-second timeout. The native probe now permits acknowledgment
  punctuation and uses an explicit 150-second HTTP deadline for the existing
  90-second OCR inference. No adapter retry or auth reset was added.
- At this initial processor checkpoint C35 remained gated and C37–C40 needed
  actual individual service/database/materialized-output certification; C41
  still needs the other global/workspace/import selection boundaries. Primitive
  and OCR success does not mark those tasks complete. C26 and full native
  browser/PM2/Windows/Linux acceptance remain open.
- Final checks passed: full 156-suite/2,797-test coverage run, focused new
  rendered selector and budget tests, backend/web/mobile typechecks, zero-warning
  lint, maintainability, 189-route spec drift and 92-ADR lint. Desktop/mobile
  builds passed after the suite; desktop JS is 906.2 KiB/910 KiB. The Memory
  control is lazy-loaded under its own 6 KiB limit, preserving Settings at 80 KiB.

P6 C37/C38 evidence (November 6, 2026; changes following `f7d6d07`):

- Added server-only adapter policies for service-owned automatic retry and
  required processor image format, retaining legacy defaults. CoCo disables
  automatic retries. KB conversion wrappers run once on failed/empty CoCo
  output; handlers preserve image-only/original recovery with accurate zero
  retries. Dreaming rejects empty/invalid results before applying operations or
  clearing pending entries. Other harnesses retain their existing retry behavior.
- All visual handlers prepare PNG siblings for CoCo, including small JPEGs and
  embedded Office images, with no upscaling or original-byte replacement.
  Native model/version/PNG limits remain enforced. Tests cover conversion
  records/reuse, original bytes, Auto model refusal without a model fallback,
  headless interaction/shutdown failure without resend, legacy retries, all
  four handlers' actual retry counts and pending synthesis retention.
- `CORTEX_KB_PROBE=1 CORTEX_TEST_CONNECTION=<saved-name> npx tsx
  scripts/probe-cortex-kb.ts` passed with exit 0 on CoCo 1.2.35/macOS arm64/
  Node 26.0.0, Pandoc 3.9.0.2 and LibreOffice 26.2.3.2. Private report:
  `cockpit-cortex-kb-XyBPEJ/report.json` under system temp. Each JPEG/PDF/DOCX/
  PPTX used one native image prompt and preserved/reused conversion records.
  The earlier `simoDC` probe also passed conversion/digestion/cold-start synthesis
  but did not exercise native search; it is not evidence for that later gate.
- Real digestion/gleaning shared one native session. Real dreaming/re-dreaming
  persisted SQLite topics, run history and Markdown; glossary CRUD/expansion,
  real local Ollama nomic-embed-text vectors (768 dimensions), PGLite vector
  search and native `search_entries`, `search_topics`, `get_topic` calls passed.
  The run made eleven native prompts: ten successful calls with complete final
  counters and one intentionally interrupted digest. The interrupted raw stayed
  failed with no entries or resend, and fresh exact-response inference succeeded.
  Shared Snowflake auth and existing Office installations were retained.
- The probe has a ten-minute external completion deadline and closes native
  runtimes and PGLite/SQLite before deleting fixture data. Normal tests use a
  deterministic CoCo process fixture; no native browser, PM2 restart, Windows
  or Linux claim is made. C26, G1/conditional C35 and C39–C59 remain open.

P6 C39 evidence (November 7, 2026; changes following `c76bb63`):

- Existing Workspace Context orchestration already passes tool-enabled one-shot
  work, selected global/workspace profile/model/effort, workspace cwd, timeout
  and AbortSignal through CoCo. No production runtime/service change was needed.
  Added deterministic process/service coverage and a repeatable native probe.
- `test/cortexContextIntegration.test.ts` covers native-protocol configuration,
  uploaded source planning, direct markdown/state/reports, eligible active Memory
  action/deletion and silent events, superseded/disabled Memory exclusion,
  missing/duplicate/unknown actions without deletion/retry, headless question
  failure, cancellation/overlap/drain/fresh execution, disabled/zero-source
  passivity, scheduling and seven-day report/history pruning. Direct native
  edits before failed output are retained rather than falsely rolled back.
- `CORTEX_CONTEXT_PROBE=1 CORTEX_TEST_CONNECTION=<saved-name> npx tsx
  scripts/probe-cortex-context.ts` passed exit 0 on CoCo 1.2.35/macOS arm64/
  Node 26.0.0. Private evidence: `cockpit-cortex-context-n84NPH/report.json`
  and final repeat `cockpit-cortex-context-8fvaS7/report.json` under system temp.
  Actual conversation/upload scan, direct context writes,
  global/override settings and native thought-level selection, active Memory
  folding/server deletion, exact reference/asset bytes, silent updates,
  retention, scheduled scans/maintenance, zero-source/disabled state,
  interruption with retained inbox/no resend and fresh exact-response inference
  all passed twice. Each run's six prompts include five successful complete-usage
  responses and one intentional interruption; shared auth was preserved.
- The first native report `41FmBi` failed during the scan without preserving the
  cause. Both separate explicit native runs above passed without a production
  retry or auth reset. Evidence is version/platform-scoped, not a reliability
  guarantee. The probe owns a ten-minute external deadline and drains actual
  service/native work before fixture cleanup; reports omit native diagnostics.
- Full 159-suite/2,824-test coverage passed: 88.49% statements/lines, 76.13%
  branches, 93.8% functions; branch/function floors raised to 76.1/93.8.
  Backend/web/mobile and explicit probe typechecks, zero-warning lint,
  maintainability, 189-route drift, 92-ADR lint, rebuilt web/mobile assets and
  desktop bundle budget passed. No UI/API/schema change or new architectural
  decision was required. C26, G1/conditional C35, C40–C59 and full client/PM2/
  platform acceptance remain open; C40 Routine certification is next.

P6 C40 evidence (November 7, 2026; changes following `17071bf`):

- Existing Routine infrastructure already resolves selected manifest profile/
  model/effort and invokes tool-enabled CoCo ephemeral execution with the
  workspace cwd and manifest deadline. No production runtime/service/schema/API
  change or new architecture decision was needed.
- `test/cortexRoutinesIntegration.test.ts` adds nine deterministic process cases:
  HTTP/WS proposal/validation/install, opt-in instructions/disabled passivity,
  manual config/files/history/explorer/persistent state, schedule intervals/
  windows/weekdays, notification off/failure through an injected stub, headless/
  model failures, overlap/shutdown/deadline cleanup without resend/outreach,
  old output pruning and 50-record history. The deadline test fires the actual
  registered timer after partial native-fixture output exists; it does not
  claim a minute of wall time. The final focused repeat passed after tightening
  those partial-output/deadline preconditions and enabling stub delivery settings.
- `CORTEX_ROUTINES_PROBE=1 CORTEX_TEST_CONNECTION=<saved-name> npx tsx
  scripts/probe-cortex-routines.ts` passed exit 0 on CoCo 1.2.35/macOS arm64/
  Node 26.0.0. Private report: `cockpit-cortex-routines-SC2AiJ/report.json`
  under system temp. Actual HTTP/WS chat authored a valid proposed routine;
  Cockpit validated/installed it before manual and scheduled native runs.
  Artifacts, final/input/tmp/history, selected harness config, output explorer,
  persistent cursor counts 1/2, mtime retention and stub notifications passed.
- An actual foreground native shell/Python task sleeping 120 seconds hit the
  unmodified one-minute manifest deadline after 60.247 seconds. The failed run
  kept its partial output/state, had no completed final, sent no notification
  and made one native prompt. Disabled instructions/runs/data preservation and
  a fresh exact-response process passed afterward; shared terminal auth remained
  intact. Five prompts comprise four complete-usage successes and one intentional
  timeout. All outreach routes were fixture-owned with an injected stub and
  synthetic destination/token; no real message was sent.
- Full coverage passed 160 suites/2,833 tests: 88.54% statements/lines, 76.34%
  branches, 93.8% functions. Statement/line floors raised to 88.5 and branches
  to 76.3; functions stay 93.8. Backend/web/mobile and explicit probe typechecks,
  zero-warning lint, maintainability, 189-route drift, 92-ADR lint and rebuilt
  web/mobile assets/budget passed. C26, G1/conditional C35, C41–C59 and full
  browser/PM2/platform acceptance remain open. C41 selection boundaries are next.

P6 C41 evidence (November 7, 2026; changes following `be4bbed`):

- Fixed normalization that discarded missing/disabled processor IDs and could
  thereby resolve a legacy backend/default instead. Global Memory/KB/Context and
  workspace Context overrides now retain explicit missing/disabled/incomplete
  IDs through reads, saves, restored JSON and real full-bundle export/import.
  Existing unset/default-chat/backend-only legacy behavior remains intact.
- Shared browser-safe role policy now checks disabled/configuration/metadata
  identity for UI choices and preflights static registered roles in Memory's
  note/extraction/consolidation/draft paths, KB conversion/digestion/dreaming,
  attachment OCR, Context and Routines. Gleaning additionally checks sequential
  support; image/model gates stay independent. No native tool restriction is
  relaxed and no alternate adapter is selected. Context persists profile
  resolution failures correctly; re-dream validates before wiping synthesis.
- Shared pure profile projection and lazy controls replace fallback-prone
  selectors across global/workspace roles. Saved unavailable profiles and missing
  IDs stay visible/disabled; stale metadata is rejected, restored text models
  retain disabled rows, override activation preserves unresolved global identity,
  and only explicit eligible user changes emit settings patches. The shared
  projection keeps large screen modules within their existing bundle limits.
- Focused tests exercise actual service/HTTP/persistence/import boundaries,
  failed state and no fallback/invocation, all restricted Memory paths,
  destructive re-dream preservation, rendered selection behavior and direct
  configuration/identity/role contract cases. The initial coverage run passed
  all 2,850 tests but missed the unchanged function floor (93.79% vs 93.8%);
  direct contract coverage was added rather than lowering the gate.
- Final frozen-source coverage passed 161 suites/2,851 tests: 88.58%
  statements/lines, 76.48% branches and 93.81% functions. The branch floor rises
  to 76.4%; other floors stay unchanged. An intermediate run while source imports
  changed passed its tests but produced inconsistent V8 counts; only the final
  frozen-source result is used. Backend/web/mobile typechecks, zero-warning lint,
  maintainability, spec drift, ADR lint and rebuilt web/mobile assets passed.
  Sharing the Settings loading wrapper resolved a small bundle overrun without
  changing limits; final total JS is 909.1 KiB / 910 KiB.
- Existing `CORTEX_PROCESSOR_PROBE=1 CORTEX_TEST_CONNECTION=<saved-name> npx tsx
  scripts/probe-cortex-processors.ts` passed exit 0 on CoCo 1.2.35/macOS arm64/
  Node 26.0.0: native sequential continuity, headless question, HTTP OCR/model
  rejection, image cancellation and fresh exact inference. Private report:
  `cockpit-cortex-processors-YeAnIZ/report.json` under system temp. Shared auth
  remains intact. This policy work does not create a new native protocol suite
  or close C26/G1/conditional C35/full browser/PM2/platform gates. P7 C42–C46
  desktop/mobile acceptance is next.

### P7 — Desktop and mobile

- [x] C42 — Wire desktop Harness/Profile/model/effort/connection fields, icon,
  setup/doctor hints and metadata state. Verify stale request handling and all
  unsupported mode/tier/goal/processor controls.
- [x] C43 — Replace Grok-only plan revision checks with shared capability,
  keeping Claude/Grok behavior stable. Verify CoCo approval/revision/rejection,
  sequential/free-text questions and duplicate/stale response prevention.
- [x] C44 — Make unsupported mid-turn steering explicit while pending replies
  work. Verify typed input is retained/queued, not lost; test queue/abort/reconnect
  and input arriving as an interaction closes.
- [x] C45 — Wire honest context/token/cache/cost display on both clients.
  Verify unavailable Snowflake pricing is `n/a`/unknown, supported existing
  harness pricing stays correct and usage reloads consistently.
- [x] C46 — Verify current mobile chat scope with real CoCo: selection,
  thinking/tools/questions/revised plans, uploads/OCR where enabled, artifacts,
  abort/history/reconnect and unsupported goals. Evaluate PWA metadata/build
  impact; no new mobile administration is required for parity with current scope.
- [x] C47 — Run desktop/mobile behavior tests, typechecks, production builds
  and web bundle budget. Check auth URL/redirect copy-paste on narrow screens
  through the responsive setup page without storing secrets in browser state.

P7 C42 evidence (November 7, 2026; changes following `c6707f2`):

- Standard Settings now exposes CoCo Harness/profile cards, name/enable/delete,
  executable, named connection and account home/env. Harness transitions clear
  incompatible auth-home/config fields. Generic auth logs stay hidden for CoCo;
  shared remote OAuth stays in its existing panel and isolated/custom commands
  use terminal authentication. Setup explains manual installation and unsupported
  features. Incomplete profiles are excluded from new default/composer choices
  while saved incomplete selections remain visible/disabled. Metadata supplies
  the icon to both clients.
- Shared `profileCatalog.js` projection replaces duplicate profile/model/effort
  lookups. `useProfileBackends.js` owns deduplicated catalogs and generation-safe
  invalidation for Settings/workspace/composer; API promise identity additionally
  rejects invalidated responses. Composer keys include profile configuration,
  preserving model/effort through late/empty/failed discovery. Missing saved
  models retain disabled rows with available replacements. Focused rendered
  editor/selector/API tests replace the obsolete source-string metadata checks
  and cover existing Claude Standard/Interactive, Codex and Grok controls.
- The expanded opt-in `scripts/probe-cortex-auth.ts` passed on CoCo 1.2.35/macOS
  arm64/Node 26.0.0: existing saved-auth, protected remote access, cancel/retry,
  responsive setup, actual editor/save/default selection, model/effort discovery,
  icon, hidden mode/tier/goal controls and browser-sent fresh exact inference.
  Private report `cockpit-cortex-auth-ui-TBZF6r/report.json` under system temp.
  Earlier attempts exposed two fixture locator assumptions (exact form labels
  and workspace display name), which were corrected; one auth check returned an
  inconclusive result and was left failed without weakening verification.
  No shared credentials were cleared. PM2 fixture shutdown allows twenty seconds
  for native draining.
- Composer selectors now lazy-load, with shared projections outside large
  entrypoints. Measured JS is approximately 911.3 KiB; the aggregate budget
  increases from 910 to 912 KiB for the new fields/ownership while Settings,
  workspace, index and CSS caps stay unchanged. The Claude Interactive UI suite
  was reviewed; no private protocol/version compatibility change is claimed.
  No mobile administrative screen, manifest/service-worker or protocol changes
  are added. C26, conditional C35 and C43–C59 remain independent.
- Final coverage passed 164 suites/2,866 tests: 88.57% statements/lines, 76.49%
  branches and 93.81% functions, above the unchanged floors. Backend/web/mobile
  typechecks, zero-warning lint, maintainability, API spec drift, ADR lint and
  rebuilt desktop/mobile production assets passed. Final desktop JS/CSS budget
  measured 911.3/912 KiB and 202.3/230 KiB. C43 interaction controls are next;
  19 implementation tasks remain unchecked.

P7 C43 evidence (November 7, 2026; changes following `fa17897`):

- Desktop/mobile interaction cards now consume the shared plan-revision role
  policy on conversation metadata. CoCo feedback is enabled, Grok retains its
  absent-flag fallback and honors explicit false, and Claude approval/rejection
  stays unchanged. Rendered desktop callbacks carry exact decision generations;
  both reply orchestrators exclude duplicates synchronously and preserve newer
  interactions/drafts across delayed acknowledgements, failures and legacy
  message fallbacks. Fresh question/plan generations start with empty drafts.
- A native standard-chat probe exposed a distinct entry permission, absent from
  the earlier explicit-plan-mode fixture: approve/decline with title `Create a
  plan before executing?`. The interaction module can accept only that verified
  schema to enter planning in tool-enabled chat. It grants no execution; the
  owned finished-plan document still needs proceed/keep_planning approval.
  Restricted/headless/unknown entry remains denied. Sanitized native evidence
  lives in `plan-entry.json`, with focused positive/negative tests.
- The opt-in `scripts/probe-cortex-interactions.ts` passed on CoCo 1.2.35/macOS
  arm64/Node 26.0.0 with real production desktop/mobile assets and an isolated
  PM2/data/workspace fixture. It verified sequential questions, custom/option
  answers, empty next drafts, revision/new gate, rejection without writes,
  approval-controlled exact file writes, opaque generations, stale/duplicate
  rejection and one original prompt per conversation. Outgoing requests assert
  verified Sonnet 4.6/low. Private report
  `cockpit-cortex-interactions-MVtAcg/report.json` under system temp. Shared
  credentials stayed intact. Earlier attempts exposed default assertion timing,
  unpinned model selection, native entry cancellation, ambiguous revision text
  that changed the file payload, and the invalid assumption that Reject always
  returns a new gate. These remain failed evidence; no automatic prompt replay
  or relaxed execution gate was added to obtain a pass.
- The rendered capability matrix and deferred-response/store/pipeline tests
  cover existing harness behavior. The native Claude UI plan/question cases
  were attempted with 2.1.318: startup exited code 1 before SessionStart/plan
  interaction (the serial question case did not run). Native Grok 1.0.52 UI cases
  could not select the suite's 4.7 from the available fallback catalog; a scoped
  4.6 attempt then reported Authentication required before any question. These
  are explicit compatibility limitations, not native regression passes. The
  aligned Claude/Grok UI suites retain approval and fresh-draft expectations.
- Mobile uses its existing chat scope; no administration, PWA manifest/service
  worker, persistence schema or REST/WS frame changes are introduced. C26,
  C44–C47, conditional strict Memory and full platform acceptance remain separate.
  The durable interaction/verification workflow note was saved through Memory.
- Final verification passed 165 suites/2,882 tests, including 144 focused tests.
  V8 measured 88.57% statements/lines, 76.50% branches and 93.81% functions;
  existing floors stay unchanged for this small backend increment. Backend/web/
  mobile typechecks, zero-warning lint, maintainability, API drift, ADR lint and
  rebuilt production assets passed. Desktop JS/CSS measured 911.8/912 KiB and
  202.3/230 KiB. Eighteen implementation tasks remain unchecked; C44 is next.

P7 C44 evidence (November 7 local / November 8 UTC, 2026; following `fa75997`):

- Both clients use shared steering eligibility to explain CoCo's queue-only
  mid-turn behavior while preserving native decision replies. Desktop Stop stays
  available with a draft, including while questions disable queue submission.
  Matching CoCo decision outcomes resolve cards across clients/replay, without
  clearing newer or legacy decisions. Mobile ignores superseded socket frames
  and clears remaining CoCo decisions at terminal completion.
- Mobile serializes queue saves/draining, reads current options and conversation
  ownership, preserves newer draft/uploads, and restores persisted heads if a
  question, switch or Stop intervenes. Queue editing/sending disables during
  persistence. Stop sets a per-conversation pause before cancellation; idle
  queues expose explicit Resume queue. Durable terminal errors prevent automatic
  drain, with no native work retry. Queued text persists through reload; mobile
  drafts retain their existing in-memory scope.
- The first native C44 run passed desktop questions/queueing, then reproduced an
  actual abort race: an older transcript refresh looked idle during cancellation
  and started the queued follow-up. This remains failed evidence. Stop now
  suspends desktop/mobile queues synchronously before awaiting teardown.
  Desktop scheduled sends recheck interactions/errors/pauses and explicit Resume
  clears pause/error state. Focused deferred-cancel tests cover this timing.
- The corrected `scripts/probe-cortex-queue.ts` passed all four native production
  desktop/mobile question/queue and abort/resume flows on CoCo 1.2.35/macOS
  arm64/Node 26.0.0. Private system-temp report
  `cockpit-cortex-queue-NIIXq0/report.json`: decision input ownership, retained
  drafts, held input HTTP acknowledgement, same-decision reconnect, completed-card
  replay, rejection of closed input, one native script attempt, one queued prompt,
  child exit, absent interrupted output, paused queue reload and explicit resume.
  The PM2 fixture and native descendants drained; shared terminal auth stayed
  intact. C26, strict Memory, C45–C47/P9 and Windows/Linux remain separate.
- The existing Claude Interactive abort case now checks Stop with a retained
  draft. C43's native Claude startup and Grok model/auth limitations remain
  recorded; no native pass for those environments is claimed here. The native
  interaction probe was rerun because matching completion affects question and
  plan cards: all desktop/mobile sequential/custom questions, revision/rejection,
  approval-controlled writes and exact ownership passed in private report
  `cockpit-cortex-interactions-wwZkRe/report.json`. An earlier recheck stopped at
  a missing Model selector before sending any prompt; it is not a pass. Private
  UI diagnostics were added before the fresh-built fixture passed. The durable
  C44 workflow note was saved through Memory.
- Desktop JS grows approximately 0.5 KiB to 912.3 KiB; the aggregate cap moves
  from 912 to 913 KiB for role guidance, Stop availability and ownership guards.
  Individual Settings/workspace/index/setup and CSS limits stay unchanged.
- Final full coverage passed 167 suites/2,896 tests (three opt-in suites/20 tests
  skipped), with 88.58% statements/lines, 76.51% branches and 93.81% functions.
  Backend floors stay unchanged for this frontend-focused increment. All 139
  focused tests, backend/web/mobile typechecks, zero-warning lint, maintainability,
  API drift and ADR lint passed. Production web/mobile assets were rebuilt after
  full Jest; JS/CSS budget passed at 912.3/913 KiB and 202.3/230 KiB. Seventeen
  implementation tasks remain unchecked; C45 is next.

P7 C45 evidence (November 7 local / November 8 UTC, 2026; following `8c59b14`):

- Shared browser-safe usage display policy preserves unknown cost versus reported
  zero and includes input/output/cache read/cache write in totals. Desktop CoCo
  has a dedicated context/token/cost card; mobile has a compact expandable
  four-counter breakdown. Unknown Snowflake Cost and Estimated Cost are n/a.
  Missing context remains distinct from zero. Existing harness costs/rounding
  stay unchanged; no direct-vendor rate is inferred from the CoCo model name.
- Pure Usage settings projections retain tokens and model/service-tier grouping,
  mark unpriced period/model rows n/a and mixed totals incomplete. Token chart
  and daily totals include caches. CoCo-only cost charts explain unavailable
  prices rather than reporting no usage. Shared summary markup keeps Settings
  within its 80 KiB chunk cap; total JS allowance is 914 KiB, with measured
  production output 913.6 KiB after the final rebuild (CSS 202.3 / 230 KiB).
- Nine focused suites / 166 tests passed, including rendered both-client usage,
  existing harness prices, mixed aggregation, exact cache/context HTTP/WS totals,
  a fresh storage instance and replay without double accounting. The existing
  profile-editor fixture also gained standalone/mixed Usage rendering checks
  after its new import dependencies were registered. Backend/web/
  mobile typechecks and probe typecheck passed. Full V8 coverage passed 168
  suites / 2907 tests (3 suites / 20 tests skipped): statements/lines 88.57%,
  branches 76.53%, functions 93.82%. Existing floors remain unchanged for this
  frontend-focused increment. After that run, only two erased test type
  assertions were removed for lint; the 14 affected UI tests were rerun.
  Final zero-warning lint, backend/web/mobile typechecks, maintainability,
  189-route spec drift, 92-ADR lint, both production builds and bundle budget
  passed. The private-identifier scan is clean and no usage PM2 fixture remains.
- Native `scripts/probe-cortex-usage.ts` passed on CoCo 1.2.35, macOS arm64,
  Node 26.0.0 using production assets and shared terminal auth. Private report:
  `cockpit-cortex-usage-xaTzNR/report.json` under system temp. Two prompts per
  client matched live, reloaded and isolated PM2-restart usage; the daily ledger
  reconciled input 20, output 573, cache read 187806 and cache write 14426.
  All prices remained unknown. Usage settings showed n/a totals/table prices and
  the unavailable-price chart message. Private screenshots were visually checked.
- Earlier native probes stopped at scaffolding expectations: a stale original
  title after automatic conversation rename (`cockpit-cortex-usage-xuuFbH`) and
  expected integer context where mobile uses one decimal below 10 percent
  (`cockpit-cortex-usage-MBX3uo`). Both were corrected in the runner; no product
  regression or successful acceptance is inferred from those failed runs.
  Fixture PM2 apps were removed; no production restart or logout occurred.
- Memory note saved successfully; no local fallback was used. PWA assets need
  rebuild only; manifest, identity, service-worker/auth/offline policy unchanged.
  C26, conditional C35 and C46–C59 remain open (16 tasks); C46 is next.

P7 C46 evidence (November 7 local / November 8 UTC, 2026; changes following
`6f937af`):

- Current mobile acceptance passes real CoCo 1.2.35/macOS arm64/Node 26 through
  production Chromium assets at 390×844 and an isolated PM2/data/workspace fixture.
  `scripts/probe-cortex-mobile.ts` report `cockpit-cortex-mobile-VaqNDi/report.json`
  remains private under system temp. It selects another configured profile with
  the same shared terminal connection, Sonnet 4.6/medium, checks hidden unsupported
  controls and valid Goal API rejection, uploads PNG/text, runs native OCR with
  composer selection while stored chat still says Auto, and reuses cached OCR.
  A dedicated image/text turn confirms both contents before the CSV fixture exists.
  A separate reviewed Python gate verifies thinking/tools/socket replay, explicit
  delivery, durable preview and downloaded bytes after source mutation. Reset,
  read-only history preview/Close pointer interaction, descendant Stop cleanup,
  one interrupted tool attempt and a fresh reply all pass. The final screenshot
  was visually checked. Physical iOS/Android/Safari/Web Share remain untested.
- Chat now carries optional explicit upload filename references through the
  shared stream contract and both clients' immediate/queued sends. The focused
  chat attachment module resolves real metadata directly under the conversation
  upload root; bad references fail before accepting a turn. Client paths/kinds,
  symlinks and cross-conversation files cannot create native media. Prose paths
  stay text. Native CoCo retains its PNG/model/version/byte gates. HTTP integration
  checks actual ACP PNG base64 blocks and no inference/persistence for bad refs.
- OCR passes invocation-only composer model/effort and retains stored chat
  selection. Mobile jobs exclude synchronous duplicates, preserve newer drafts
  and selections, ignore stale navigation/reset/removal/clear/unmount completions,
  cache successful results, and allow explicit retry. CoCo named-model effort is
  retained by the pure conversation policy despite an empty static catalog;
  native profile configuration validates support. Low then medium config RPCs
  and fresh storage restoration are tested. Read-only history now sits below
  preview modals; selecting Sessions dismisses the Conversation actions sheet.
- Full V8 coverage passed 171 suites / 2,924 tests (3 suites / 20 tests skipped):
  statements/lines 88.60%, branches 76.60%, functions 93.82%. Statement/line and
  branch floors rose to 88.6/76.6; functions remain 93.8. After that run, the
  one-line frontend actions-sheet dismissal and its new rendered regression
  passed all 29 focused mobile tests, mobile typecheck/build and final native
  acceptance. Backend source was unchanged. Backend/web/mobile typechecks,
  zero-warning lint, maintainability, 189-route spec drift, 92-ADR lint, rebuilt
  production assets and the unchanged bundle budget pass.
- Native C43 interactions were rechecked (`cockpit-cortex-interactions-muBkHT`):
  questions/custom text/revised plans/rejection/approval and stale/duplicate IDs.
  Native C44 desktop/mobile queues/reconnect/abort/resume were rechecked after
  explicit attachment wiring (`cockpit-cortex-queue-CynE1d`). C45's usage/restart/
  ledger report remains the separate usage portion of this matrix.
- Earlier reports are retained as failures: `yMXKXS` had a malformed Python
  fixture; `EEzWlH` declined an unreviewed script; `AAdbKA` exposed an early-idle
  probe race, corrected by waiting for send acceptance. `wz5bsE`, `yS3TtL`,
  `zXIAK2` and `oe0HFO` exposed the saved-effort, missing native image wiring,
  preview stacking and stale actions-sheet bugs corrected above. `1r8FhD` saw
  an empty model catalog; fresh and three concurrent native discoveries returned
  33 models, as did final browser discovery. `cjnNqm` omitted its PNG transcript
  from a combined tool/media request; the final runner verifies those results
  in separate dedicated turns. Failed runs do not establish acceptance, and no
  application retry or weaker media/ownership gate was added.
- Durable Memory saved successfully; no local fallback was used. Fixture PM2
  apps are removed, normal terminal auth is retained, and no production restart
  or logout occurred. No PWA manifest, identity, service-worker/offline/auth policy
  or mobile administration change is required. C26, conditional C35 and
  C47–C59 remain open (15 tasks); C47 is next.

P7 C47 evidence (November 7 local / November 8 UTC, 2026; changes following
`e601749`):

- All desktop/mobile behavior tests pass in the full 171-suite / 2,928-test V8
  run (3 suites / 20 tests skipped). Coverage is 88.60% statements/lines, 76.61%
  branches and 93.82% functions; existing 88.6/76.6/93.8 floors remain appropriate
  for this frontend/test-only increment. Backend/web/mobile and probe typechecks,
  zero-warning lint, maintainability, 189-route spec drift and 92-ADR lint pass.
  Web/mobile production assets were rebuilt after full Jest; budget is unchanged
  at JS 913.8/914 KiB and CSS 202.3/230 KiB. Browser checks ran separately from
  asset-mutating tests.
- Expanded `scripts/probe-cortex-auth.ts` passes real CoCo 1.2.35/macOS arm64/
  Node 26 in an isolated PM2/data/workspace fixture with normal terminal auth.
  Private report: `cockpit-cortex-auth-ui-OEUzaR/report.json` under system temp.
  Actual remote API access is rejected with 401. Native saved-auth fresh inference,
  cached auth jobs, cancel/drain/retry, profile/default/model/effort controls and
  a fresh desktop browser reply pass. Shared login is retained; no logout or
  production restart occurred.
- Separate browser-local synthetic callbacks pass on Welcome and Settings at
  1280, 390 and 320 px widths. The production component copies the entire long
  native URL using the clipboard and pastes/posts the exact encoded loopback URL.
  Live forms and controls fit. Held submissions clear input immediately; success,
  cancellation, rejected redirects and terminal failed/expiry snapshots clear the
  appropriate handoff state. Reload recovers only the active server-owned URL,
  never an unsent redirect. No handoff strings enter local/session storage,
  cookies, history or settings; isolated desktop contexts create no IndexedDB or
  Cache Storage. Fixture clipboard contents are cleared. Narrow screenshots were
  visually checked. Active UI/React memory and user clipboard remain necessary
  transient transfer state. Synthetic values never reach native auth/Snowflake;
  backend timeout/ownership behavior remains covered by the actual auth suites.
- New rendered component cases verify full URL focus selection, exact untruncated
  generation-bound submission, pending input clearing and failed/cancelled poll
  cleanup. The earlier `cockpit-cortex-auth-ui-c1CXNx` run passed native checks
  but failed an exact HTML-label query: the textarea value is included in label
  text. The corrected textbox-role/accessible-name query passes all six cases
  and fixes the older absence check's potential false negative. That failed run
  is not acceptance evidence. No application runtime/API/persistence change was
  needed; the standard responsive panel remains the mobile setup path.
- C43–C46 retain their separate native decisions, queue/reconnect/abort, usage/
  restart/ledger and mobile media/history evidence for unchanged production
  source. C47 does not package the C54 suite, certify physical iOS/Android/Safari,
  establish account isolation, or close C26's human handoff, strict Memory or
  Windows/Linux/platform gates. No PWA administration, manifest, identity,
  service-worker/offline or public asset-source change is required.
- Durable Memory saved successfully and its project mirror is updated; no local
  fallback was used. Temporary PM2 fixtures are removed. C26, conditional C35
  and C48–C59 remain open (14 tasks); C48 is next.

### P8 — Installation, updates, migration, and platforms

- [x] C48 — Add optional CoCo Install Doctor/Welcome detection/actions using
  reviewed official distributions. Verify runtime discovery immediately after
  install, paths with spaces and command overrides; do not assume an npm package.
  Completed: reviewed Snowflake standalone POSIX installer and Windows packaging;
  optional shared-runtime discovery/Welcome action with fresh version postcheck.
  Real macOS 1.2.35 disposable installation passed with spaced home/app/explicit
  command paths, auth-home independence and distribution removal. Installer PATH
  prompts are disabled; native logs/completion setup is disclosed and preserves
  existing shell content. Focused doctor/Welcome and macOS installer/release/update
  regressions pass. Native Windows/Linux, updates and C26 stay separate.
- [x] C49 — Verify actual native update/version commands and noninteractive
  behavior; add CLI Update support only for proven installation methods. Verify
  reusable runtime shutdown, executable/auth-home separation and error recovery.
  Completed: focused CoCo updater policy, full stable metadata/target pinning and
  official macOS 1.2.35 activation gates. Profile auth/channel/secrets are excluded
  from updater env; duplicate/preflight/new-chat guards, awaited runtime draining,
  failed-attempt invalidation/no retry and fresh version postcheck are covered.
  Real disposable native download/checksum/activation/reuse/failure/explicit retry
  passed. Synthetic older-build/missing-target controls are separate from old-CLI
  or authentication evidence. Other layouts/versions and Windows/Linux remain
  manual; C50 migration and C51–C53 full platform acceptance stay independent.
- [x] C50 — Preserve full data-root migration semantics; exclude runtime
  plugins/auth jobs and check restored connection/auth/executable dependencies.
  Verify checksum/backup/exact `REPLACE` behavior remains unchanged.
  Completed: focused passive CoCo dependency checks and manifest/preview warning;
  reserved native plugin/login/verification folders excluded on export and
  rejected in archive/manifest imports, including empty directories. Full-root
  profile/default/processor/chat/media/usage/data round trips, external-home
  preservation, stale absolute-home warnings, backup, checksum tampering and
  REPLACE route behavior pass. Imported commands are never executed by checks;
  auth jobs stay memory-only and login requires dedicated fresh verification.
  Full V8: 177 suites / 2,973 tests; no normal data/auth/installation mutation.
  C26, strict Memory, C49 auth-repeat observation and native platforms remain
  separate. C51 is next; 11 unchecked tasks remain including conditional C35.
- [x] C51 — Run macOS native install/update/auth/chat/cleanup evidence;
  preserve symlink activation, PM2/current-user startup and existing installer/
  updater compatibility tests.
  Completed on macOS 26.5 arm64, Node 26 and CoCo 1.2.35: real optional install
  and native update/recovery, full saved-auth/responsive UI, checksummed local
  release with real npm ci/installer helpers/current symlink, registered fixture
  LaunchAgent/private PM2, fresh service auth, desktop file/usage, PM2 native
  session continuity, Stop/descendant cleanup, and desktop/mobile queue/resume.
  Runtime realpath pinning prevents version/startup alias swaps. Aborted turns
  now close before terminal done; explicit next turns reload saved sessions,
  and old abort handles cannot cancel new owners. The background-shell late-write
  regression and exact native Stop scenario pass without replay. Query flags
  request update suppression; they are not global installation containment.
  Native 1.2.37 activation drift was observed and the original 1.2.35 activation
  restored without editing native settings/credentials. Failed HOME-isolation,
  stale-title and on-demand startup reports remain separate from passed evidence.
  Explicit kickstart is not a new login event; macOS x64, public release download,
  private Node bootstrap, C26, strict Memory and other platforms are unverified.
  C54 retains the drift/isolation observations. Final V8: 177 suites / 2,975
  tests pass; coverage floors raised. C52 is next; 10 tasks remain.
- [ ] C52 — Implement and run Ubuntu 24.04 x64 native launch/install/auth/cache/
  credential-store/update/cleanup tests. Verify headless credential reuse under
  the actual user-session service environment before claiming support.
- [ ] C53 — Implement and run native Windows x64 executable discovery/auth/
  process tree/update tests. Respect official standalone packaging and existing
  private-Node wrappers for other harnesses; preserve appDir activation and
  current-user PM2 behavior. Mock resolver tests alone do not certify Windows.

### P9 — Compatibility suites, parity research, and release

- [ ] C54 — Add opt-in native runner(s), proposed `npm run e2e:cortex-code`
  and `npm run e2e:cortex-code-ui`, with CLI/OS/Node/revision/dirty-state reports,
  bounded external deadlines, sanitized artifacts and owned fixture cleanup.
  Retain C49 auth failures and C51 native activation drift/isolated-HOME null
  verification observations; clean later repeats do not establish their cause.
  Bind CLI version checks and startup to the same retained executable.
- [ ] C55 — Add real Cockpit workflow fixtures for core and each enabled
  processor. Browser fixture server must be isolated and PM2-managed; preserve
  normal server data/auth. Separate missing-auth fixtures from real-account runs.
- [ ] C56 — Resolve or explicitly defer native goals (G6), subagents (G7),
  steering, additional media (G4), billing (G10), and account isolation (G5).
  Update capabilities/tests/specs only for positively verified behavior.
- [ ] C57 — Update canonical specs, backend comparison/public setup docs,
  reference env/data docs and test inventory for implemented scope. Update
  `AGENTS.md` and project memory only when actual recurring workflow changes;
  save durable notes through Memory, never local fallback on tool failure.
- [ ] C58 — Run required checks/regression suites, review residual gates and
  capture compatibility evidence. Raise Jest thresholds if meaningful added
  coverage raises the baseline; never lower them to accommodate regressions.
- [ ] C59 — Evaluate ADR completeness/mobile impact and prepare a ready-for-
  review PR when requested. Use non-closing issue references unless explicitly
  authorized; follow normal release notes/release workflow separately.

## 10. Verification plan

### 10.1 Proposed focused tests

| Proposed tests | Behavior to prove |
|---|---|
| `test/cortexProtocol.test.ts`, `test/fixtures/cortex-acp.cjs` | Framing, RPC IDs including 0, reverse requests, malformed stdout/EOF/timeouts, versioned fixtures |
| `test/cortexRuntime.test.ts`, `test/cortexProcess.test.ts` | Resolution, env/cwd/argv, serialization, runtime generations, idle/reset/shutdown, descendant ownership |
| `test/cortexEvents.test.ts`, `test/cortexInteractions.test.ts` | Text/thinking/tools/artifacts, replay suppression, questions/free text/plans/revision and exact reverse ownership |
| `test/cortexModels.test.ts`, `test/cortexUsage.test.ts` | Config options, auto/effort reset, model evidence, counters/context, missing cost, errors-as-text fixtures |
| `test/cortexPlugin.test.ts`, `test/cortexAuth.test.ts` | MCP manifest/env/scopes/refresh/cleanup; TOML/auth jobs/redirect validation/redaction/timeouts |
| `test/cortexBackend.test.ts`, `test/cortexIntegration.test.ts` | Facade methods, two-turn continuity, persistence/recovery/queue, eligibility and unsupported operations |
| `test/cortexBuild.e2e.test.ts`, `test/cortexWorkflows.e2e.test.ts` | Opt-in authenticated native adapter and real isolated Memory/KB/Context/Routine service paths |
| `test/e2e/cortexCode.ui.pw.ts` | Opt-in real desktop/mobile conversations, questions/revised plans, auth setup where practical, reload/abort/artifacts/usage |

Extend existing relevant tests instead of replacing them: `backends`,
`cliProfileAuthService`, `chat.cliProfileAuth`, `cliProfileConfigDir`, settings/
instruction stores, `mediaCapabilities`, upload/OCR, `usagePricing`, stream jobs/
finalizers/recovery, `streamFrameReducer`, `streamStore`, mobile app model/send
pipeline, Install Doctor/CLI update/migration, installer and release-package
coverage. Add browser-safe contract/import-boundary tests for new shared shapes.

### 10.2 Native acceptance scenarios

| ID | Scenario | Observable pass condition |
|---|---|---|
| N01 | Saved-auth fresh process | Exact synthetic answer with successful native request; catalog/session creation alone fails the check |
| N02 | Manual auth on another machine | UI job receives its own redirect, fresh process succeeds, terminal login is reused; no secret retained |
| N03 | Multi-turn and restart | Hidden nonce recalled after process/server restart; no duplicate transcript, prompt side effects or usage |
| N04 | Native tools and files | Random fixture read/write/shell/edit verified on disk; generated file downloadable through Cockpit |
| N05 | Questions and plans | Sequential/free-text answers reach native tool; revision produces a new gate; side effect absent until approval |
| N06 | Cancel/crash/reset/timeout | Sleeper/descendants stop, delayed file absent, no unrelated process killed, next turn works or reports recoverable interruption |
| N07 | Real Memory/KB chat integration | Isolated real services authorize correct scopes; governed note/search and KB query produce expected persisted records/results |
| N08 | MCP refresh | New token/endpoint used after respawn/load; revoked credentials fail, old transcript/session context retained |
| N09 | Tool-enabled processors | Isolated conversion/digestion/gleaning/dream/context/routine outputs persisted and validated by owning services |
| N10 | Restricted processor, conditional G1 | No tool definitions/operations/hooks/commands/MCP, including hostile slash/sequential fixtures; actual Memory governance passes |
| N11 | Failure classification | Missing/expired auth, denied model, service error and unexpected exit fail truthfully; quoted error text remains a legitimate answer |
| N12 | Desktop/mobile | Shared capabilities and interactions work through real sockets, reconnect/history and clean unsupported-feature states |
| N13 | Pricing/usage | Native counters/context reconcile once; unavailable Snowflake price/quota never represented as reported zero spend |
| N14 | Platform/account certification | Real OS and separate-account evidence recorded; no inheritance or cross-profile native-session load in isolated fixtures |

Use disposable workspaces and isolated Cockpit data, with explicit shared-auth
use only for the intended credential check. Tests must never modify production
Memory/KB or send real outreach. Do not run asset-mutating full Jest fixtures
concurrently with browser checks. Run existing real Claude/Grok suites if shared
changes affect their protocols/UI; this plan does not invent an existing Codex
native suite.

### 10.3 Required commands at implementation time

```sh
npm run typecheck
npm run lint
npm run maintainability:check
npm run spec:drift
npm run adr:lint
npm test -- --runInBand
npm run test:coverage
npm run web:typecheck
npm run mobile:typecheck
npm run web:build
npm run mobile:build
npm run web:budget
```

Run focused tests during each phase, full checks before the implementation PR,
and the proposed opt-in CoCo native suites once added. These commands are not a
claim that any future tests exist or have already passed. No production restart
or release is required to validate this planning document.

## 11. Gate and decision register

| Gate | Current status | Required experiment / resolution | Release effect |
|---|---|---|---|
| G1 — Strict tool-free execution | Gated after Phase 0: three native calls still emitted with unmatched allowlist; source confirms allowlist does not remove declarations | Demonstrate native zero-tool boundary across every invocation path, including default/deferred/MCP tools, hooks, skills, slash commands and sequential calls | Blocks CoCo Memory processor and restricted titles/summaries; deterministic fallbacks permit core chat |
| G2 — Root-exit/descendant cleanup | Dedicated P2 macOS runtime passed native sleeper cancel/root death/unrelated preservation; timeout fallback and identity races covered by focused tests | Retain userspace sampling limitation; verify full adapter/background finalization and each additional OS | Blocks core release on that OS until full adapter cleanup policy is tested |
| G3 — Recovery and terminal errors | Native evidence partial; no adapter | Test saved-session load/replay, missing-session-only fallback, error-as-text classification, abort and durable job recovery through Cockpit | Blocks reliable core chat/restart claims |
| G4 — Media and artifacts | PNG input verified on one model; broader formats/output unverified | Model-specific image/OCR/KB pipeline evidence first; separate native PDF/audio/video/generation experiments | Only verified modality/model/transport combinations enabled |
| G5 — Account isolation and refresh | Shared auth works across days; expiry/two accounts unverified | Real two-account auth home/cache/Keychain tests and expiry refresh under the actual server user | Blocks isolation claim/automatic isolated profile setup; shared-auth core remains possible |
| G6 — Native goals | Unverified | Discover actual API/notifications and test set/status/clear/pause/resume, budgets and autonomous completion/cancel; decide support explicitly | Goals false until certified; no synthesized control loop |
| G7 — Subagents/late work | Unverified | Verify child identity/demux, foreground/background completion, cancellation and usage attribution/draining | Agents false; if native delegation occurs by default, finalization/cleanup must still be proven or delegation disabled for core |
| G8 — Install/update/platform support | macOS install known; managed paths/other OS not certified | Review official packaging/update commands, native OS launch/auth/install/update/cleanup and existing platform compatibility regressions | Doctor/update action and OS support limited to tested paths |
| G9 — Managed runtime policy | Phase 0 selected direct ACP plus explicit-discovery flags/native memory off; clean startup/instructions/empty-home error passed; source shows separate update dispatch | Verify actual adapter system-prompt delivery, expired-token behavior, hooks/skills/delegation, and version-specific update/discovery policy | Remaining acceptance required before supervised core runtime support |
| G10 — Snowflake billing | Tokens known; account cost/quota not reconciled | Obtain a documented/native Snowflake usage source and reconcile unit/cache/Auto model semantics; use focused pricing calculator if added | No cost estimate/account panel until evidence; tokens/context still supported |

Proposed ADR-0093 now records profile/capability names, managed discovery/update
policy and pending-interaction behavior. Remaining implementation decisions:
ordinary native approval details; auth transport and connection TOML strategy;
model-media evidence source; platform release scope. Proposed choices require
their adapter acceptance checks before being advertised as implemented behavior.

## 12. Documentation and change inventory

At implementation time update only the relevant current specifications:

- New `docs/spec-cortex-code.md`: module ownership, exact argv/env/protocol,
  profile/connection/auth states, capability matrix, event mapping, MCP lifecycle,
  error/usage semantics, platform/version evidence and supported workflows.
- `docs/spec-backend-services.md`: adapter methods, processor eligibility and
  resume matrix; `docs/spec-data-models.md`: persisted CoCo profile fields and
  runtime exclusions; `docs/spec-api-endpoints.md`: actual new/extended routes.
- `docs/spec-server-security.md`: auth handoff validation, redaction and runtime
  env policy; `docs/spec-frontend.md` and `docs/spec-mobile-pwa.md`: setup scope,
  selectors, interaction/usage states, unsupported features and asset behavior.
- `docs/spec-workspace-context.md` and `docs/spec-routines.md`: verified processor
  support/eligibility; `docs/spec-deployment.md`: actual install/update/platform
  behavior; `docs/spec-testing.md`: added tests and opt-in native commands.
- `BACKENDS.md`, `docs/reference/backend-capabilities.md`, user backend/setup
  guides, deploy guides and environment/data reference: supported scope and
  native Snowflake auth reuse; do not imply direct vendor pricing or universal
  media support.
- `docs/SPEC.md`, `docs/spec-coverage.md`, new implementation ADR and applicable
  `AGENTS.md` compatibility workflow. Keep this plan as the progress tracker and
  the research report as historical empirical evidence.

### Completion log

| Date | Tasks / scope | Commit or PR | CLI / platform | Verification / remaining gates |
|---|---|---|---|---|
| 2026-11-05 | Planning baseline; all tasks initially unchecked | Checkpoint `083d4e3` | CoCo 1.2.35 / macOS arm64 | Prior research plus fresh saved-auth real inference; G1–G10 tracked above |
| 2026-11-05 | P0 C01–C03 complete; 56 production tasks remain unchecked | Planning checkpoint `083d4e3`; preflight work in this change | CoCo 1.2.35 / macOS arm64 / Node 26.0.0 | Seven sanitized excerpts; real startup/inference/cancel/root-exit/restriction/missing-auth probe; production gates retained |
| 2026-11-06 | P1 C04–C07 complete; 52 tasks remain unchecked | Profile/capability foundation change | No new native CLI claims | 135 suites / 2,604 tests passed; backend/web/mobile typechecks; no runtime/UI execution registration |
| 2026-11-06 | P2 C08–C12 complete; 47 tasks remain unchecked | Dedicated native runtime foundation change, following `869ee8a` | CoCo 1.2.35 / macOS arm64 / Node 26.0.0 | 138 suites / 2,651 tests passed, including 47 P2 tests; real runtime smoke passed all scenarios; no adapter/UI registration; P3 event mapping next |
| 2026-11-06 | P3 C13–C20 complete; 39 tasks remain unchecked | Internal turn mapping change, following `549f111` | CoCo 1.2.35 / macOS arm64 / Node 26.0.0 | 144 suites / 2,681 tests passed, including 30 P3 tests; real event/config/question/revised-plan/PNG/delivery/missing-auth probe passed; generic upload/queue/ledger/artifact route integration; P4 auth setup next |
| 2026-11-06 | P6 C33/C34/C36 complete; 25 tasks remain unchecked | Ephemeral processor/OCR change following `478d80b` | CoCo 1.2.35 / macOS arm64 / Node 26.0.0 | 156 suites / 2,797 tests passed; final V8 88.41% lines, 75.92% branches, 93.76% functions; native sequential/headless/OCR/model-gate/image-cancel/fresh-process probe passed; C26, conditional C35 and C37–C59 remain open |
| 2026-11-06 | P6 C37/C38 complete; 23 tasks remain unchecked | KB workflow certification change following `f7d6d07` | CoCo 1.2.35 / macOS arm64 / Node 26.0.0 / Pandoc 3.9.0.2 / LibreOffice 26.2.3.2 | 158 suites / 2,814 tests passed; V8 88.46% lines, 76.01% branches, 93.74% functions; backend/web/mobile typechecks, lint, maintainability, spec drift, ADR lint, web/mobile builds and budget passed. Native conversion/reuse, digestion/gleaning, synthesis/re-dream, glossary/real embeddings/KB MCP and interrupt/fresh-process checks passed. Shared auth retained; C26, conditional C35 and C39–C59 remain open |
| 2026-11-07 | P6 C39 complete; 22 tasks remain unchecked | Context workflow certification change following `c76bb63` | CoCo 1.2.35 / macOS arm64 / Node 26.0.0 | 159 suites / 2,824 tests passed; V8 88.49% lines, 76.13% branches, 93.8% functions; native scan/upload/config/maintenance/Memory/retention/schedules/stop/fresh inference passed. Required checks and rebuilt web/mobile assets/budget passed; shared auth retained. C26, conditional C35 and C40–C59 remain open |
| 2026-11-07 | P6 C40 complete; 21 tasks remain unchecked | Routine workflow certification change following `17071bf` | CoCo 1.2.35 / macOS arm64 / Node 26.0.0 | 160 suites / 2,833 tests passed; V8 88.54% lines, 76.34% branches, 93.8% functions; native chat/proposal/install/manual/scheduled files/state/stub outreach/retention/real minute-timeout/fresh inference passed. Required checks and rebuilt web/mobile assets/budget passed; shared auth retained. C26, conditional C35 and C41–C59 remain open |
| 2026-11-07 | P6 C41 complete; 20 tasks remain unchecked | Processor-selection boundaries change following `be4bbed` | CoCo 1.2.35 / macOS arm64 / Node 26.0.0 | 161 suites / 2,851 tests passed; V8 88.58% lines, 76.48% branches, 93.81% functions; exact selection persistence/import, role preflights, failed-state ownership and rendered controls passed. Native sequential/headless/OCR/cancel/fresh-inference probe passed with shared auth. Required checks and rebuilt web/mobile assets/budget passed; C26, conditional C35 and C42–C59 remain open; P7 desktop/mobile acceptance next |
| 2026-11-07 | P7 C42 complete; 19 tasks remain unchecked | Desktop profile/catalog integration following `c6707f2` | CoCo 1.2.35 / macOS arm64 / Node 26.0.0 | 164 suites / 2,866 tests passed; V8 88.57% lines, 76.49% branches, 93.81% functions. Native PM2 auth/editor/responsive/save/default/catalog/effort/icon/hidden controls/browser inference passed. All required checks and rebuilt web/mobile assets/budget passed; shared auth retained. C26, conditional C35 and C43–C59 remain open; C43 interactions next |
| 2026-11-07 | P7 C43 complete; 18 tasks remain unchecked | Desktop/mobile decision controls following `fa17897` | CoCo 1.2.35 / macOS arm64 / Node 26.0.0 | 165 suites / 2,882 tests passed; V8 88.57% lines, 76.50% branches, 93.81% functions. Native production desktop/mobile questions, revision, rejection, approval-controlled writes and decision ownership passed; shared auth retained. Native Claude startup and Grok model/auth limitations are recorded above; no pass is claimed for them. Standard checks, rebuilt assets/budget and saved Memory passed. C26, conditional C35 and C44–C59 remain open |
| 2026-11-07 | P7 C44 complete; 17 tasks remain unchecked | Queued input/abort/reconnect ownership following `fa75997` | CoCo 1.2.35 / macOS arm64 / Node 26.0.0 | 167 suites / 2,896 tests passed; V8 88.58% lines, 76.51% branches, 93.81% functions. Native production desktop/mobile questions/queue/reconnect/abort/descendant drain/persisted queue resume and existing plan interactions passed. Stop pauses before cancellation; queued work and drafts/uploads retain ownership without prompt replay. Standard checks and rebuilt assets/budget passed; Memory saved. C26, conditional C35 and C46–C59 remain open |
| 2026-11-07 | P7 C45 complete; 16 tasks remain unchecked | Usage display and persistence following `8c59b14` | CoCo 1.2.35 / macOS arm64 / Node 26.0.0 | 168 suites / 2907 tests passed; V8 88.57% lines, 76.53% branches, 93.82% functions. Native production desktop/mobile context/token/cache/n/a costs, reload, isolated PM2 restart and exact daily ledger reconciliation passed. Existing harness price rendering and mixed Usage totals covered. Memory saved. C26, conditional C35 and C46–C59 remain open; C46 next. |
| 2026-11-07 | P7 C46 complete; 15 tasks remain unchecked | Native mobile media/history/recovery following `6f937af` | CoCo 1.2.35 / macOS arm64 / Node 26.0.0 | Native profile/model/effort, PNG/text/OCR/cache, thinking/tools/replay, explicit immutable artifact preview/download, reset/read-only history and Stop/fresh inference passed; C43/C44 rechecks passed. Full V8 171 suites / 2,924 tests and 29 focused mobile tests after the final frontend fix. Floors 88.6/76.6/93.8; standard checks/builds/budget pass; Memory saved. C26, conditional C35 and C47–C59 remain open. |
| 2026-11-07 | P7 C47 complete; 14 tasks remain unchecked | Consolidated client/responsive-auth checks following `e601749` | CoCo 1.2.35 / macOS arm64 / Node 26.0.0 | Full V8 171 suites / 2,928 tests; native saved-auth and fresh desktop inference plus six separate synthetic Welcome/Settings clipboard/lifecycle/storage cases at 1280/390/320 px passed. Typechecks, zero-warning lint, architecture/spec/ADR checks, rebuilt assets and unchanged budget pass; Memory saved. C26, conditional C35 and C48–C59 remain open. |

| 2026-11-07 | P8 C48 complete; 13 tasks remain unchecked | Optional standalone installation/doctor/Welcome support following `20620d8` | CoCo 1.2.35 / macOS arm64 / Node 26.0.0 | Real disposable official installation, immediate discovery without PATH changes, spaced home/app/command override and auth-home separation passed (`cockpit cortex install V2PgNg`). Native saved-auth/Welcome detection/fresh desktop inference and six responsive synthetic handoff cases passed (`cockpit-cortex-auth-ui-9RMnWK`). Full V8 173 suites / 2,941 tests; 88.62% lines, 76.69% branches, 93.82% functions. Floors raised to 88.62/76.65/93.8. macOS installer/release/update regressions, types/lint/architecture/spec/ADR, rebuilt assets and unchanged bundle limits pass; Memory saved. C26, conditional C35 and C49–C59 remain open; C49 is next. |

| 2026-11-08 | P8 C49 complete; 12 tasks remain unchecked | Version-gated native updates following `327de77` | CoCo 1.2.35 / macOS arm64 / Node 26.0.0 | Full V8 175 suites / 2,956 tests; 88.66% lines, 76.83% branches, 93.86% functions; floors raised to 88.65/76.8/93.85. Disposable native download/checksum/activation/draining/reuse/failure/explicit retry passed (`cockpit cortex updates x0xwAe`), with synthetic build/target controls disclosed. Independent PM2 update-row acceptance passed at 1280/390/320 px (`cockpit-cortex-auth-ui-M6gFEs`), without mutation/auth. Required types/lint/architecture/spec/ADR/build/budget and macOS regressions pass; Memory saved. Full auth repeats failed generic verification (`zVw71N`) and cached-login waiting after successful fresh inference (`mdl3Fa`); standalone fresh verification passed. Failed evidence is retained, not counted as full auth recertification. C26/C54 retain that observation. C26, conditional C35 and C50–C59 remain open; C50 is next. |

## 13. References

Local implementation/research sources are authoritative for this version:

- [Native CoCo evaluation](../research/cortex-code-acp-evaluation.md)
- [Current adapter system](../spec-backend-services.md#42-backend-adapter-system)
- [Current backend comparison](../../BACKENDS.md)
- [Current Grok implementation](../spec-grok-build.md) and
  [ADR-0092](../adr/0092-integrate-grok-build-through-acp-and-native-extensions.md)
  for comparable ownership/lifecycle constraints, not interchangeable protocol
- [Shared contracts/logging ADR](../adr/0051-adopt-shared-contracts-and-logging-foundations.md),
  [goal capability ADR](../adr/0057-represent-goal-mode-as-backend-capability-driven.md),
  [harness identity ADR](../adr/0079-use-harness-for-cli-profile-runtime-identity.md)
- [Mobile PWA scope](../spec-mobile-pwa.md),
  [Workspace Context](../spec-workspace-context.md), [Routines](../spec-routines.md)

Official upstream reference pages, checked during planning where accessible:

- [ACP support](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-acp)
- [CLI reference](https://docs.snowflake.com/en/user-guide/cortex-code/cli-reference)
- [Installation and connections](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli)
- [Native plugin layout](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-plugins)
- [MCP support](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-mcp)

The retrieved installation documentation describes macOS/Linux and native
Windows distributions and shared named Snowflake connections; the plugin
documentation corroborates explicit plugin manifests with inline MCP entries.
Those references do not certify our installed version or Cockpit integration.
Recheck current official commands when implementing installers/updates, and
prefer recorded native behavior over assumptions from newer documentation.
