# Agent Instructions

This file is the canonical project guidance for coding agents working in this repository. Keep it vendor-neutral when possible; use tool-specific files such as `CLAUDE.md` only as compatibility shims or for genuinely tool-specific notes.

Project memory that should persist across agents is mirrored in
[`docs/agent-project-memory.md`](docs/agent-project-memory.md). Read it when
work touches installer/updater/release behavior, CLI profiles, mobile PWA,
Workspace Context, Memory, KB, or cross-agent workflow. When durable memory records a
recurring project rule, update that document and this file if the rule changes
agent workflow.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" -> "Write tests for invalid inputs, then make them pass"
- "Fix the bug" -> "Write a test that reproduces it, then make it pass"
- "Refactor X" -> "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
3. [Step] -> verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

# Maintainability Boundaries

Follow ADR-0051 for shared contracts, logging, and ownership boundaries.

- Keep public facades stable. `ChatService` and `WorkspaceContextService` should remain orchestration/facade entrypoints; new persistence, parsing, normalization, scoring, source-planning, or policy logic should live in focused modules under the owning domain directory.
- For ChatService work, prefer focused modules under `src/services/chat/` for artifacts, usage ledgers, workspace feature settings, message queues, workspace instructions, and similar private stores. Preserve existing storage formats and migrations unless the task explicitly changes them.
- Workspace identity is canonicalized by immutable `workspaceId`; absolute workspace paths are mutable metadata in the workspace identity registry. Treat `workspaceHash` and storage keys as legacy/storage details, and have current web/mobile callers use `workspaceId` when referencing a workspace.
- CLI profile runtime identity is canonicalized as `harness`, not `vendor`. Persist `CliProfile.harness`; accept legacy `vendor` only at compatibility/migration boundaries. Settings labels this field **Harness**, while composer selectors should remain **Profile** / **CLI Profile**.
- Claude Code provider routing belongs to `CliProfile.claudeCode.provider`. Keep Bedrock AWS runtime values in profile `env`, keep Bedrock inference profiles in structured `claudeCode.bedrock.inferenceProfiles`, and use `baseModelId` only for Agent Cockpit metadata/effort/pricing mapping rather than as the runtime model sent to Claude Code.
- Data migration treats `AGENT_COCKPIT_DATA_DIR` as the package unit. Export/import changes must preserve the full-bundle contract, destructive replace-after-backup semantics, exact `REPLACE` confirmation, manifest checksum verification, runtime-file exclusions, and post-import checks for workspace paths, Memory, KB SQLite/PGLite, Ollama embeddings, CLI auth, Pandoc, and LibreOffice.
- For usage-pricing work, keep provider-specific rules in focused calculators under `src/services/usagePricing/`. Do not collapse Codex/OpenAI service tiers, Claude token/cache pricing, Kiro credits, or future CLI pricing into one generic formula when provider behavior differs.
- For Workspace Context work, keep `src/services/workspaceContext/service.ts` as the coordinator. Keep markdown storage, instruction management, source planning, processor prompting, run state, and scheduling inside focused modules under `src/services/workspaceContext/` as the feature grows; do not reintroduce graph, candidate-review, MCP subsystems, or the old Memory Review scheduler/UI workflow unless a new ADR supersedes the markdown-first design. Workspace Context maintenance is the automatic path that consumes accepted active Memory inbox entries and deletes them after folding them into context markdown.
- For Workspace Routines work, keep Agent Cockpit as the infrastructure layer under `src/services/routines/`: authoring contracts, proposal validation, scheduling, run folders/history, and outreach. Keep task-specific intelligence in routine markdown executed by the selected harness, and keep shared route/client validators in `src/contracts/routines.ts`. Routines are opt-in per workspace through `WorkspaceIndex.routinesEnabled`; disabled workspaces must not install managed `AGENTS.md` instructions, create routine scaffolding from passive reads, or run scheduled routines.
- Put shared request/response shapes and runtime validators in `src/contracts/` whenever routes, clients, tests, or specs need the same boundary. Contract files imported by web or mobile must stay browser-safe and must not import server-only modules.
- Server type definitions live in declaration-only domain modules under `src/types/` and are re-exported through `src/types/index.ts`; contracts keep importing exactly `../types`, and new server-only types should go in the matching domain file rather than the barrel.
- Keep browser-visible stream frames in `src/contracts/streamFrames.ts`. Backend adapters may use broader server-only `StreamEvent` shapes, but web/mobile clients should consume only the browser-safe frame union. Desktop stream-frame state changes belong in the pure reducer under `web/AgentCockpitWeb/src/stream/`; keep `streamStore.js` as the socket/API/timer effect adapter.
- Web and mobile clients should import shared types only from browser-safe contracts. Do not reach into backend services, route modules, filesystem helpers, or server-only types from frontend code.
- Keep large UI entrypoints as composition layers. Move pure projection, parsing, state-provider, viewport, and formatting behavior into focused modules or hooks with direct tests.
- Prefer behavior-oriented frontend tests for parsing, projection, state updates, and user-visible outcomes. Use source-string/static tests only for route registration, build guards, or import-boundary checks where runtime coverage is impractical.
- Keep Jest coverage thresholds in `jest.config.js` aligned with the measured backend baseline. When meaningful coverage is added, raise thresholds in the same PR; do not lower thresholds just to merge a regression.
- Use `src/utils/logger.ts` for backend logging in touched code. Do not add new backend `console.*` calls unless the file is an intentional CLI/test/build script or already documented as an allowed exception.
- When adding or changing an ownership boundary, update the relevant spec docs and add focused tests for the new module instead of only testing through the largest facade.
- Before opening a PR, run `npm run lint`, `npm run maintainability:check`, and `npm run spec:drift` in addition to the existing required verification commands.
- Treat `npm run lint` as a zero-warning gate. Do not leave new warnings behind; every intentional `react-hooks/exhaustive-deps` inline disable must include a written reason.

# Claude Code Interactive Compatibility

Claude Code Interactive depends on private Claude CLI terminal and transcript behavior. Any change to its protocol implementation must evaluate and update the real-Claude compatibility suites:

- Review `test/claudeCodeInteractive.e2e.test.ts` whenever touching `src/services/backends/claudeCodeInteractive.ts`, `claudeInteractivePty.ts`, `claudeInteractiveTerminal.ts`, `claudeInteractiveHooks.ts`, `claudeTranscriptEvents.ts`, `claudeTranscriptTailer.ts`, Claude Code profile protocol resolution, or Claude CLI update/compatibility warnings.
- Review `test/e2e/claudeCodeInteractive.ui.pw.ts` whenever touching the Claude Code Interactive composer/profile UI, reset/abort flow, or browser stream rendering. Keep this Playwright suite aligned with user-visible protocol behavior.
- Keep the suites aligned with the behavior being changed. Add or adjust real-CLI scenarios when changing prompt submission, PTY lifecycle, hook handling, transcript parsing, tool mapping, goal handling, abort cleanup, browser composer/profile selection, reset, or version compatibility.
- For Claude CLI version compatibility checks on a dev machine, run `npm run e2e:claude-interactive:report` and `npm run e2e:claude-interactive-ui:report` with an authenticated real `claude` CLI. These suites are intentionally not part of normal CI and should not be replaced with mocks for version-drift validation.

# Codex Protocol Compatibility

Codex App Server behavior is split across `src/services/backends/codex.ts`, `codexRuntime.ts`, `codexProtocol.ts`, `codexEvents.ts`, `codexStreamDispatch.ts`, `codexArtifacts.ts`, `codexUsage.ts`, `codexModels.ts`, `codexExec.ts`, and `codexProcess.ts`. `codex.ts` remains the public facade and compatibility re-export surface.

- Review and extend `test/codexBackend.test.ts` whenever touching those Codex modules, especially protocol shapes, notification dispatch, turn ownership, subagent demux, usage accounting, process lifecycle, or `codex exec` invocation behavior.
- When changing hand-typed Codex app-server protocol shapes, run or document the `codex app-server --enable goals generate-ts --out <DIR>` drift-diff procedure from `docs/spec-backend-services.md` and inspect `codexProtocol.ts`, `codexEvents.ts`, `codexModels.ts`, and `codexStreamDispatch.ts`.
- No real-CLI Codex e2e suite exists today. Do not imply one is part of normal drift validation; creating one is separate scope unless a future issue or ADR adds that requirement.

# GitHub Copilot Protocol Compatibility

Review `test/copilotBackend.test.ts` and `test/copilotUsage.test.ts` when changing
Copilot JSONL parsing, tool restrictions, native session recovery, runtime
resolution, or usage. Run `npm run e2e:copilot` with an authenticated real
`copilot` for native text/stream/resume/usage validation; the opt-in suite uses
temporary synthetic workspaces and does not update the CLI. Keep restricted
one-shots on `--available-tools none` (an empty value exposes tools), preserve
UTF-8 stream decoding, and subtract the saved native usage checkpoint before
charging resumed-session totals. Keep usage parsing under
`src/services/backends/copilotUsage.ts`. See ADR-0094.
Keep process-tree containment in `copilotProcess.ts`, test real npm launcher
topologies in `test/copilotProcess.test.ts`, and preserve root/child ownership
in both streaming and one-shot responses. Hidden child tools must still block
prompt replay; usage remains session-wide. Auto/unverified media must fail
closed. See ADR-0095 for the smaller initial scope and evidence boundaries.
Adapter shutdown/reset may return promises. Await `BackendRegistry.shutdownAll()`
before server exit or post-update reuse, and await reset cleanup before replacing
a native session. Keep descendant discovery rooted in every live tracked
PID/start identity, including after its launcher exits.
Preserve the owned detached group after leader exit to catch between-scan
children. Server exit uses permanent shutdown and blocks request admission;
CLI updates use reusable shutdown, which blocks starts only while draining.
Retain verified child-led groups after leader exit as well, and cancel one-shot
controllers before termination so a clean launcher close cannot accept partial
output as success.
Keep a fresh inherited `AGENT_COCKPIT_COPILOT_SCOPE` marker per chat/one-shot
spawn so cleanup can recover orphans whose detached leader was never observed.
Environment snapshots are bounded, current-user-only, used only during cleanup,
and must never be logged. Keep PID/start and verified-group checks as well.
Reserve the conversation/workspace before asynchronous reset cleanup, drain all
ending backends before changing any session or Git checkout, and release the
reservation on every exit path. See ADR-0096.
Archive/delete share that reservation and await backend cleanup before changing
archive state or deleting a checkout. A Copilot turn sent immediately after Stop
must await aborted scopes for its conversation before resuming native work.
Send/goal admission blocked by a reset uses temporary `503` with `Retry-After`,
while active-stream conflicts retain `409`; clients interpret `409` as an
existing stream and must not attach to a reset reservation.
For Copilot Memory/Workspace Context/KB/Routine changes, run the normal-CI
application suites in `test/copilotMemoryContext.test.ts` and
`test/copilotKbRoutines.test.ts`, then native `npm run e2e:copilot-workflows`.
Optionally select the CLI with `COPILOT_WORKFLOW_CLI`. The POSIX native suite
uses isolated temporary auth and fixed local model replies to test production
MCP, governance, persistence, managed Context files, JSONL KB processors and
Routine output/history. Native tools must read the actual processor sources;
cancelled workers and detached children must exit before retry. The runner saves
CLI/SDK/OS/revision, test results, file-access receipts and recorded PID cleanup
under a temporary `copilot-workflows-compat-*` report directory. Keep this
evidence separate from hosted-model reasoning, account auth, embedding quality,
browser UX and native Windows/Linux certification.
Windows Copilot spawns use `copilotWindowsProcess.ts` to assign a hidden wrapper
to an unnamed kill-on-close Job Object before launching native work. Preserve
its sole non-inheritable job handle, fail startup if containment cannot be
established, and pass raw standard handles with `CreateProcessW`; no-console
`ProcessStartInfo` launches lose the inherited JSONL pipes. Keep
`test/copilotWindowsProcess.test.ts` passing on native Windows CI. Those Node
process fixtures do not certify the real Windows Copilot CLI. See ADR-0097.
Run `test/copilotContextTriggers.test.ts` and `test/copilotKbRoutines.test.ts`
for automatic Context and processor workflow changes. Run
`npm run e2e:copilot-ui` for desktop/mobile lifecycle changes; it uses real
Copilot with fixed local model replies, isolated auth/data, and its own PM2
home. Keep full Jest asset-build fixtures separate from browser runs and rebuild
production assets after the full suite before checking the bundle budget.

For the SDK runtime foundation, review `test/copilotSdkRuntime.test.ts` and run
`npm run e2e:copilot-sdk` with the selected real CLI (optionally set
`COPILOT_SDK_CLI_PATH`). Keep SDK connections attached to a Cockpit-owned
headless process with a fresh loopback connection token; never select the SDK's
bundled/in-process runtime or bypass the existing process/Windows Job boundary.
The native suite isolates auth and uses fixed local replies, so it is not
hosted-account or model-judgment evidence. Record actual CLI/SDK/OS/revision.
Keep the pinned `vscode-jsonrpc` compatibility shim in `copilotJsonRpc.ts`:
disable recurring partial-message diagnostics through the public reader option
only within our SDK connection's async scope. Preserve other readers' defaults
and Cockpit's actual request/startup deadlines. Review `test/copilotJsonRpc.test.ts`
and the partial-frame exit case before removing this workaround after upgrades.
SDK conversation ownership lives in `copilotConversations.ts`; keep native event
projection pure in `copilotSdkEvents.ts` and shared model/tool/config helpers in
their focused Copilot modules. Review `test/copilotConversations.test.ts`,
`test/copilotInputs.test.ts` and `test/chat.inputs.test.ts` for correlated input
changes. Keep native callbacks and steering ownership in `copilotInputs.ts`.
Probe queue controls only after initial prompt acknowledgement and root turn
start; a send acknowledgement does not prove execution has started. Release
the probe pause, then hold a pause only around a pending steering transaction.
Native background-completion notifications also need that queued lane. Accept
steering only on its native delivery event; poll pending items to withdraw an
exact promoted correction before releasing the pause, including before idle.
Never replay an input or turn a stale
question into a new message. Stop force-closes the SDK connection before
rejecting callbacks so native question errors cannot continue work. Run both
native SDK and desktop/mobile browser suites for these changes.
Keep SDK delegated ownership in the pure `copilotAgents.ts` reducer, with direct
`test/copilotAgents.test.ts` coverage. Native envelope `agentId` identifies the
child, `data.parentId` its parent, and `toolCallId` belongs to the parent's
scope. Namespace tools by turn/owner/raw ID, flatten descendants to the top card,
and retain child summaries without leaking child prose into root answers.
Background task acknowledgement is not completion; native child lifecycle owns
outcomes and session idle owns turn completion. Stop/error must settle pending
cards as cancelled/interrupted. Keep session-wide usage counting children once.
Review `test/copilotSdkEvents.test.ts` and `test/copilotSessionConfig.test.ts` before
switching chat dispatch. Session idle drains attached background work; model
replies, loop ends and child idle do not. Drain late startups and failed cleanup
before admitting replacements. Resume must not continue interrupted tool work;
recovery is permitted only before sending a prompt and before observable work.
Normal chat dispatch uses the SDK owner; opaque explicit command overrides stay
on JSONL unless their provider configuration is visible in the merged runtime
environment. Never retry an SDK failure through JSONL. Review
`test/copilotAdapterRuntime.test.ts` for shared admission and Stop/reset/shutdown
across transports. SDK usage reads native metrics before submission and after
root idle; model input includes both cache buckets, and provider/model/agent
maps overlap. Keep parsing in `copilotUsage.ts`, subtract the native baseline,
and never convert nano-AIU to premium-request credits or USD. Keep live checkpoint
reconciliation in `copilotLiveUsage.ts` and profile/runtime/auth-scoped quota reads
in `copilotQuota.ts`; review their focused tests plus `copilotUsageRoutes.test.ts`
and `copilotUsageUi.test.ts`. Preserve native complete/partial/unavailable billing
coverage, separate Copilot premium requests from other harness credits, and skip
the ledger for replaceable context-only snapshots. Unknown quota units/balances
must stay unknown; quota reads create no session or model work and adapter
shutdown/profile refresh must drain their owned processes. Native workflow
and browser fixtures must configure the server environment and assert SDK
dispatch: Settings intentionally strips Copilot profile-local env values.
Keep profile/runtime model discovery and its bounded cache in `copilotCatalog.ts`;
map native model capabilities in `copilotModels.ts`. Review
`test/copilotCatalog.test.ts`, `test/copilotCatalog.integration.test.ts`, and
`test/chat.copilotCatalog.test.ts` when changing catalog scope or validation.
Preserve missing saved model IDs in both clients, expose fallback provenance,
and never infer new media support from a native vision flag alone.
Keep upload parsing and transport gates in `copilotMedia.ts` and explicit native
tool-byte projection in `copilotArtifacts.ts`. SDK PDF transport needs its own
provider/model evidence; a CLI attachment flag or vision capability is insufficient.
Deduplicate overlapping native output views per owned tool, preserve scoped
`sourceToolId`, and send bytes through the shared artifact store. Never scrape
tool text or fetch resource links to invent an artifact. Review
`test/copilotMedia.test.ts`, `test/copilotArtifacts.test.ts`,
`test/chat.copilotArtifacts.test.ts`, and native SDK/browser media cases.
Review `test/copilotProfileStatus.test.ts`, `test/cliProfileAuthService.test.ts`
and the profile-auth route tests for credential/catalog checks. Preserve the
distinction between installed CLI, authenticated credentials and enabled-model
access; static fallback metadata must not overwrite native access failures.
Await auth-service shutdown so pending SDK probes cannot outlive server cleanup.
Keep guided shared-terminal device login in `copilotDeviceAuth.ts`. Serialize
login across all Copilot profiles and drain cancelled login/probe trees before
replacement or shutdown; unproved cleanup must retain its admission barrier.
Invalidate owned catalog/quota caches after every auth outcome. Auth cleanup
failures must not prevent the chat router/server from draining other owners. Never claim
account isolation from a config home or automatically approve native plaintext
credential storage. Review `test/copilotDeviceAuth.test.ts` and
`test/chat.copilotAuth.test.ts`; run `npm run e2e:copilot-auth` for native
logged-out/device-code/cancellation checks. That opt-in suite uses temporary
auth and never authorizes the code, so it does not certify hosted entitlement,
successful OAuth completion or two-account isolation.
Goal routing uses pure `getGoalCapability({cliProfile})`, not model discovery on
polls. Keep Copilot native projection/commands in `copilotGoals.ts` and controls
inside the conversation owner. Polling and streams must share the atomic
terminal-card boundary in `src/services/chat/goalEventPersistence.ts`; review its
focused regressions when changing goal persistence. Review `test/copilotGoals.test.ts`,
`test/copilotGoalRoutes.test.ts`, native SDK goal cases and desktop/mobile goal
browser cases when changing them. Native autopilot mode alone is not goal-action
parity: 1.0.105 removes Clear, and switching autopilot on does not resume a paused
objective. Resume requires an explicit fresh AI-credit window; never translate
credits to token budgets, invent elapsed time, edit objective storage to fake
Clear, or create/recover history on status/pause/resume. See ADR-0098.
SDK dependency upgrades must keep the app Node engine, all platform installer
eligibility checks, Install Doctor and self-update engine-floor validation
aligned. Preserve major-only legacy manifests and test macOS activation when
changing runtime requirements.

# Grok Build Protocol Compatibility

Grok Build uses ACP plus native extensions through the focused
`src/services/backends/grok*.ts` modules. Review and extend the focused Grok
transport/event/backend/integration/process tests when changing protocol shapes,
session ownership, questions/plans, goals, usage, or process lifecycle. Run
`npm run e2e:grok-build` with an authenticated real `grok` for version-drift
validation; it is opt-in and uses temporary fixture workspaces. Current native
compatibility evidence is Grok Build 1.0.52 on macOS arm64. Windows resolver and
wrapper tests do not replace native Windows/Linux runs.

`BackendRegistry.shutdownAll()` also runs after CLI updates and is awaited by
both callers. Keep adapter shutdown reusable for later runtimes, return a
Promise when cleanup is asynchronous, and close startups that complete after
their conversation was reset. The native Grok suite verifies goal controls,
full autonomous completion, and real Memory/KB/Workspace Context/Routine paths.
Run `npm run e2e:grok-build-ui` for native desktop/mobile compatibility; its
fixture server is PM2-managed and isolated from normal server data. Both runners
emit temporary reports with CLI/OS/revision evidence. Small native goals can take
several minutes; retain the external completion deadline and drain updates after
the complete notification. Configured API keys require headless `xai.api_key`
authentication even when 1.0.52 omits that method from its advertised list; cached
terminal credentials take precedence. Real valid-key/two-account runs remain
separate from missing-auth/invalid-key fixtures.

Preserve the zero-tool preflight and text wrapping for restricted one-shots,
so native slash commands cannot bypass tool restrictions. Native shell groups
may detach: root-group termination alone is insufficient. Keep descendant
identity tracking and background-child/parent completion draining, and never
automatically retry interrupted tool work. Keep auth isolation separate from
the shared CLI executable/update location. See `docs/spec-grok-build.md` and
ADR-0092.

# Cortex Code (CoCo) Compatibility

CoCo is registered for durable chat. Setup work must preserve the
verified `CORTEX_OAUTH_MANUAL=1` flow: show the native login URL, accept the full
loopback redirect from another machine, retain shared terminal auth, and verify
the result from a fresh process. ACP initialization/session creation alone is
not authentication evidence. Handle native login timeouts and retain the active
job's callback ownership. See `docs/research/cortex-code-acp-evaluation.md` for
the 1.2.35 protocol findings and implementation gates.

Phase 0 evidence is retained under `test/fixtures/cortex/1.2.35`. Run the
opt-in `scripts/probe-cortex-phase0.ts` as documented in the research report
for native startup/cancel/root-exit/restriction checks. This is research
scaffolding, not a registered adapter or full compatibility suite. Keep strict
tool-free processors gated until zero-tool execution is demonstrated; an
allowlist or denied approval alone does not establish that boundary. See
Proposed ADR-0099 and `docs/design/cortex-code-implementation-plan.md`.

P1 profile/capability, P2 transport/runtime and P3 internal turn mapping are specified in
`docs/spec-cortex-code.md`; P5 now registers the chat adapter. CoCo owns its
dedicated `cortexProtocol.ts`, `cortexRuntime.ts`, `cortexSessions.ts` and
`cortexProcess.ts` modules; production code must not import Grok/Kiro adapters.
Review the focused `test/cortexProtocol.test.ts`, `test/cortexRuntime.test.ts`
and `test/cortexProcess.test.ts` when changing those boundaries. Run the opt-in
`scripts/probe-cortex-runtime.ts` for native runtime drift, as documented in
`docs/spec-testing.md`; it is not yet a full Cockpit adapter/UI suite. Retain
generation-safe reusable shutdown and identity-checked descendant cleanup.
Keep descendant scans at the normal 250 ms POSIX / 1 s Windows cadence until
runtime close, including cached idle sessions. Prompt completion does not prove
background tools finished; slowing scans can lose a detached child's ancestry.
CoCo event, interaction, model, error, usage, attachment and artifact ownership
lives in the focused `cortex*.ts` modules. Review the corresponding focused
tests and run opt-in `scripts/probe-cortex-events.ts` for native mapping drift.
Keep decision generation separate from native RPC/tool IDs, use native auto for
override reset, hold terminal error text until classified, and retain unknown
Snowflake pricing. Artifacts require explicit delivery markers/resource links;
ordinary code diffs remain tool outcomes. Model catalog discovery is not auth
evidence; an empty auth home can omit the model option before inference.
Shared role/media selection policy belongs
in browser-safe `src/contracts/backendCapabilities.ts`, with the backend media
module kept as a compatibility facade. Configuration completeness is distinct
from registered runtime availability and successful authentication.

P4 setup/auth is implemented behind `CliProfileAuthService` through dedicated
`cortexConnections.ts`, `cortexOAuth.ts`, `cortexLogin.ts`, `cortexAuth.ts` and
`cortexAuthVerification.ts` modules, with browser-safe contracts in
`src/contracts/cortexAuth.ts`. Keep native connections create-only and preserve
existing TOML bytes/comments. Keep login URLs/state/codes in the active job
only, bind redirect submissions to its generation/callback/state/issuer, and
retain the shared-home reservation until native descendants drain. Server
shutdown must await auth/check draining, including abortable version
detection and late startups. Native
first-run login needs a PTY; its parser is version-gated to 1.2.35. Saved login
must pass one exact-response fresh inference check, never model discovery alone.
Review the focused connection/OAuth/PTY/auth/verification/route/React suites and
run opt-in `scripts/probe-cortex-auth.ts` for native saved-auth/UI drift. It uses
an isolated PM2 fixture and normal terminal credentials, without forcing logout.
The actual human remote-browser handoff through Cockpit remains C26 pending;
fixture ownership checks and the earlier research handoff do not close that gate.
Unconfigured profiles must not become defaults. Processor execution, native
goals, agents and steering remain gated independently of chat registration.

P5 chat orchestration belongs to `cortex.ts`; private native MCP manifest/env
generation and conservative abandoned-owner cleanup belong to `cortexPlugin.ts`.
Keep secrets in child env placeholders, use Cockpit's actual Node executable
for the Memory/KB shims, dispose descendants before deleting plugin directories,
and refresh changed tokens/endpoints/instructions/profile/cwd only at a safe
turn boundary. Load failures recover only on the version-tested missing-session
signature; auth/transport failures must never cause prompt resend. Chat prompts
have no fixed deadline (Stop/reset own cancellation) but stop after an hour
without native activity; pending decisions never count as inactivity. A failed
native config change retires that runtime so the next turn reloads its saved
session. Preserve
opaque decision generations through REST/WS and both clients; native RPC/tool
IDs are separate. Review `test/cortexBackend.test.ts`, `test/cortexPlugin.test.ts`
and `test/cortexIntegration.test.ts`, and run opt-in
`scripts/probe-cortex-chat.ts` for native app/MCP/resume/artifact compatibility.
This isolated HTTP/WS fixture is not full native browser/process-manager or
Windows/Linux acceptance. See `docs/spec-testing.md` for exact limits.

P6 ephemeral processor ownership belongs to `cortexShots.ts`. Require explicit
`allowTools:true`, preserve a single deadline across startup and sequential
prompts, never replay/retry interrupted work, and await cancellation/shutdown
cleanup before releasing the job. Headless questions/plans must fail rather
than invent a human response. Processor image paths are server-owned and reuse
the version/model/PNG byte gates in `cortexAttachments.ts`; chat keeps its upload
root boundary. Review `test/cortexShots.test.ts`, `test/processorProfiles.test.ts`,
`test/memoryProcessorSelect.test.ts` and the restored CoCo Memory case in
`test/memoryMcp.test.ts`. Run opt-in
`scripts/probe-cortex-processors.ts` for native sequential/headless/OCR/cancel
drift. Full client/platform acceptance remains separate; a successful primitive
or OCR run does not close that gate.

P6 C37/C38 certifies native KB workflows through `scripts/probe-cortex-kb.ts`
(opt-in, isolated SQLite/PGLite/HTTP fixture, real Ollama/Pandoc/LibreOffice,
shared terminal auth). `BaseBackendAdapter.allowAutomaticOneShotRetry` defaults
to true; CoCo overrides false. KB conversion/dreaming wrappers must honor it for
execution errors and unusable output (empty, unparseable, wrong shape or no valid
items); never mark such CoCo batches processed or automatically resend
interrupted tool work. Partially valid output applies once like other adapters. Processor image format
policy is `oneShotImageFormat` (CoCo: png); prepare `.ai.png` siblings in the KB
image helper while preserving original bytes/media records and native image
gates. Review `test/cortexKbIntegration.test.ts`, the page-conversion/handler/
dreaming suites and CoCo backend tests. Native workflow success does not certify
Windows/Linux, full browser/PM2 acceptance, C26, or strict Memory execution.

P6 C39 certifies Workspace Context through the actual service/scheduler and
`scripts/probe-cortex-context.ts` (opt-in, isolated HTTP/data/workspace fixture,
shared terminal auth). Review `test/cortexContextIntegration.test.ts` and the
Workspace Context service/route suites when changing profile/model/effort
resolution, direct markdown updates, eligible Memory action validation/deletion,
cancellation, scheduler cadence, zero-source runs, disabled passivity or run
retention. Stopped/invalid runs must retain unaccepted Memory and must not resend
tool work. Direct context edits before failure are not rolled back. This
tool-enabled workflow does not enable strict CoCo Memory processors or close
the full client/PM2/platform gates.

P6 C40 certifies Routine proposal/chat/install and manual/scheduled execution
through `scripts/probe-cortex-routines.ts` (opt-in, isolated HTTP/data/workspace,
shared terminal auth, injected outreach stub). Review
`test/cortexRoutinesIntegration.test.ts` and the Routine service/route suites
when changing authoring, opt-in instructions, manifest configuration, runtime
folders/history/persistent state, schedules, timeout or notifications. Preserve
one native attempt on failure, drain timeout/shutdown before releasing ownership,
retain partial files without delivering failed-run notify.md, and keep actual
outreach disabled in compatibility probes. The native probe exercises the real
one-minute manifest deadline; deterministic tests fire the registered timer.
This does not certify a new stop API, full browser/PM2/platform acceptance,
C26, or strict CoCo Memory processing.

P6 C41 processor selection policy is shared in
`src/contracts/backendCapabilities.ts`. Preserve explicit processor profile IDs
through global/workspace normalization, restore and import even when missing,
disabled or incomplete; never erase them into a backend/default fallback.
Preflight registered static roles before discovery/invocation (restricted Memory,
tool-enabled workflows and sequential gleaning), while retaining native adapter
guards. Resolve/validate re-dream processors before wiping synthesis, and record
Context resolution failures as failed runs. Frontend projections/controls in
`screens/processorProfiles.ts` and `memoryProcessorSelect.jsx` retain unavailable
saved choices and require explicit changes. Review
`test/cortexProcessorSelection.test.ts`, the projection/rendered selector tests,
Memory/dreaming suites and full-bundle import coverage when changing these rules.
Unset defaults/legacy migrations and strict zero-tool Memory gates remain intact.

P7 C42 desktop profile/catalog projection lives in `profileCatalog.js`, catalog
ownership in `useProfileBackends.js`, and lazy composer controls in
`chat/composerPicks.jsx`. Settings/auth saves invalidate catalogs; retain pending
request generation checks in both the hook and API cache. Same-ID connection
changes and late/unmounted completions must not restore another catalog. Preserve
saved CoCo model/effort through unavailable discovery; discovery is not auth proof.
Keep CoCo remote OAuth in the dedicated setup panel rather than the generic
account log box. Review `test/cortexDesktopSelection.test.ts`,
`test/cortexProfileEditor.test.ts`, `test/profileMetadataCache.test.ts` and the
expanded `scripts/probe-cortex-auth.ts` for native responsive
profile/catalog/fresh-chat drift. This scoped desktop probe does not certify the
broader P7 decisions/queues/usage/mobile cases or C26's human handoff.

P7 C43 decision controls use shared `planRevision` role eligibility on conversation
metadata in both clients. Preserve rendered decision IDs, synchronous duplicate
exclusion and newer interaction/draft ownership across delayed replies/errors.
The verified native 1.2.35 planning-entry approve/decline schema may enter planning
in tool-enabled chat; it never grants finished-plan execution. Headless/restricted
or unknown entry stays denied. Rejection can end in text or another native gate;
never synthesize a permission card or resend a prompt. Review
`test/cortexInteractionUi.test.ts`, the interaction/store/mobile pipeline suites,
and `plan-entry.json`; run opt-in `scripts/probe-cortex-interactions.ts` for native
desktop/mobile questions/revision/rejection/approval drift. Its isolated PM2
fixture uses production assets and shared terminal auth. Do not run asset-mutating
full Jest concurrently with native browser checks. C26, C44 queue/reconnect,
usage/full mobile and platform acceptance remain independent.

P7 C44 pauses queues synchronously when Stop begins, before cancellation can
emit terminal frames or an older refresh can appear idle. Keep desktop Stop
available with drafts; mobile queue save/drain ownership belongs to
`useSendPipeline.ts` with current options and per-conversation suspension.
Preserve newer drafts/uploads and recheck pending/conversation/Stop state after
queue persistence. Explicit Resume sends queued follow-ups without replaying
interrupted work. Matching completion IDs resolve only `decisionBound` cards;
clients key off that frame flag and the input route off the adapter's
`decisionsRequireActiveTurn` policy, never the decision ID text; mobile
socket callbacks must retain current socket/conversation ownership. Review
`test/cortexQueueUi.test.ts`, `test/mobileStreamOwnership.test.ts`, the desktop
store/reducer and CoCo integration suites. Run opt-in
`scripts/probe-cortex-queue.ts` for native desktop/mobile question/queue/reconnect/
abort/resume drift, and the interaction probe when plan completion changes.
Persisted queues survive reload; mobile drafts retain their existing in-memory
scope. C26, strict Memory, C46/C47 and platform gates remain separate.

P7 C45 usage display policy lives in browser-safe
`src/contracts/usagePresentation.ts`; calculators remain provider-specific.
Keep CoCo Snowflake pricing unknown, cache buckets in total tokens, context
snapshots distinct from accumulated usage, and mixed ledger totals explicitly
incomplete. Desktop CoCo cards, Settings projection and mobile usage composition
belong to `chat/cortexUsage.jsx`, `screens/usageStats.js` and `usageBar.tsx`.
Review `test/cortexUsageUi.test.ts`, the CoCo integration/usage suites and run
opt-in `scripts/probe-cortex-usage.ts` for native client/reload/isolated PM2
restart evidence. Run browser probes separately from asset-mutating full Jest;
this scoped acceptance does not close C26, strict Memory, C46/C47 or platforms.

P7 C46 mobile attachment ownership belongs to `usePendingAttachments.ts`.
Chat uploads travel as explicit filename references in `contracts/streams.ts`;
resolve server-owned metadata under the conversation upload root in
`chat/attachments.ts` before accepting a turn. Never derive native media from
paths in prose, trust client paths/kinds, or admit symlink/cross-conversation files.
Both clients must retain these references for queued as well as immediate sends.
Keep selected OCR model/effort invocation-only in `contracts/uploads.ts` and the
upload route; preserve the stored chat selection and native media gates. Bind
late OCR to job/conversation/session/attachment identity and preserve current
drafts/selections; require explicit retry after failure. CoCo named-model effort
storage belongs to `chat/conversationPolicy.ts`: retain valid explicit values
without inventing a static catalog or loading native metadata under index locks;
native configuration validates profile-local support. Review the focused mobile
attachment/selection, contract/route/store/policy and CoCo integration tests.
Keep `test/chatAttachmentResolution.test.ts` aligned with the upload boundary.
Run opt-in `scripts/probe-cortex-mobile.ts` for native media/history/recovery and
the interaction probe for decision regressions. This browser/macOS evidence does
not certify physical mobile platforms, C26, strict Memory or Windows/Linux.
Dismiss the Conversation actions sheet when opening session history and keep
the read-only viewer below preview modals; retain real pointer checks in the probe.

P7 C47 extends `scripts/probe-cortex-auth.ts` with synthetic clipboard/lifecycle
checks on responsive Welcome/Settings. Keep synthetic callbacks browser-local,
report them separately from native fresh inference, and retain C26 as the human
handoff gate. Check complete URL/redirect transfer, terminal/reload clearing and
no persistent browser storage/history; active UI memory and clipboard are
transient transfer state. Run full Jest before rebuilding assets/browser probes.
Use the native URL's textbox role/accessible name in browser checks; exact HTML
label text can include the textarea value and falsely report absence.

P8 C48 optional install policy belongs to `src/services/cortexInstallation.ts`;
Install Doctor/Welcome use fresh shared-runtime discovery and require a responding
Cortex version after official standalone installation. Never treat it as login
proof or assume an npm package. Keep stable/noninteractive/skip-PATH invocation,
download-before-execute/temp cleanup, and disclose native shell-completion setup.
Review `test/cortexInstallation.test.ts` and
`test/cortexWelcomeInstallation.test.ts`; run opt-in
`scripts/probe-cortex-install.ts` for disposable macOS installation with spaced
home/app/override paths. Preserve existing macOS installer/release/update suites.
Windows stays documentation-only; Linux action policy is not native acceptance.
C49 update management and C51–C53 platform evidence remain separate.

P8 C49 updater policy/discovery/version projection belongs to
`src/services/cortexUpdates.ts`. Enable only the proven macOS native 1.2.35
activation at `~/.local/bin/cortex`, with matching versioned distribution metadata.
Keep profile auth homes/secrets/channel out of the updater env, group the pinned
shared executable, and pass the checked full stable distribution to native
`update <target>`; passive checks must never run an updater. Revalidate before
mutation, reserve during preflight, recheck active chat, and await CoCo runtime
draining after successful or failed attempts. Verify fresh activation/version;
never automatically retry failures. Review `test/cortexUpdates.test.ts`,
`test/cortexUpdateRoutes.test.ts` and existing CLI/runtime/macOS regressions; run
opt-in `scripts/probe-cortex-updates.ts` for disposable native download/activation/
shutdown/failure/retry evidence. Its older build metadata and missing target are
synthetic controls, not old-release or authentication evidence. Other layouts,
versions and native Windows/Linux remain manual until certified. Use
`CORTEX_UPDATE_UI_PROBE=1 npx tsx scripts/probe-cortex-auth.ts` for independent
update-row acceptance; its explicit scope is never a full auth-suite pass.

P8 C50 CoCo migration policy belongs to `src/services/cortexMigration.ts`.
Keep full-root bundles/checksums/backup/REPLACE unchanged. Exclude reserved native
plugin/login/verification temp folders on export and reject them on import,
including empty directories. OAuth jobs remain memory-only. Post-import checks
must be passive: resolve the runtime and safely inspect the selected connection,
never execute imported commands or start login/inference. Present files are not
auth proof; direct users to Check login. Keep shared/custom home semantics and
stale absolute paths explicit; never rewrite profile/processor choices during
import. Review `test/cortexMigration.test.ts`, `test/cortexDataMigration.test.ts`
and existing migration/route suites. Native cross-machine credentials, C26 and
C51–C55 acceptance remain separate.

P8 C51 passive CoCo version detection must use `--no-auto-update --version`
in runtime, Install Doctor and CLI Update. Preserve native user settings/auth.
Pin runtime commands to the captured executable realpath so version checks and
ACP/login launch the same retained distribution despite activation changes.
Keep profile command storage and updater activation discovery unchanged.
Keep `acp serve` and explicit `update <target>` prefixes exact: 1.2.35 sends a
prefixed root flag into terminal onboarding and rejects it on ACP. The login PTY
already disables automatic updates. Review runtime/doctor/updater/fixture tests
and rerun native install/update probes when changing this boundary.
`scripts/probe-cortex-macos.ts` exercises a local release package, real installer
helpers, a unique current-user LaunchAgent/private PM2, shared fresh auth,
desktop chat/restart/resume/Stop and owned cleanup. Its CLI is pinned;
retain both terminal HOME and SNOWFLAKE_HOME for shared credentials. A failed
isolated-HOME auth check is not evidence of a supported account-isolation flow. Its explicit kickstart does
not prove a new login event; public release/private Node bootstrap, macOS x64,
C26 and other platforms remain separate. Never run full Jest alongside browser
probes; rebuild assets afterward. Keep native activation snapshots and do not
silently certify an automatically downloaded CLI version.

C51 chat abort must await native runtime close before CortexTurn terminal done, even when
session/cancel acknowledges: native background shells can otherwise continue.
The next explicit turn reloads its saved session in a fresh process; never replay
interrupted work. Retained abort handles must match the current owner. Review
backend/turn/shots/integration/queue suites and rerun the native macOS and
queue probes when changing this boundary; keep low-level cancellation separate
from durable chat lease teardown.

C52 Ubuntu acceptance preparation is `scripts/probe-cortex-linux.ts` (opt-in).
Its preflight and generated-helper tests on macOS are not Linux evidence. Use
Ubuntu 24.04 x64/glibc as a regular logged-in user with a real systemd user
manager. The fixture uses a unique user unit/private PM2 and must not import the
terminal's HOME, D-Bus or credential environment into that manager. Fresh service
inference must prove saved credential reuse. Official Linux CoCo install/update,
credential-store behavior and new-login acceptance remain separate C52 gates;
the prepared runner alone does not certify them or enable managed Linux updates.
See `docs/research/cortex-code-linux-acceptance.md`.

C53 Windows x64 runtime preparation uses the shared CLI resolver for standalone
`%LOCALAPPDATA%\cortex\cortex.exe`, PATH and explicit `.exe` commands. Never
route CoCo through npm/Node/script shims. Normalize Windows child env and auth
scope case-insensitively; keep managed controls last and shared terminal auth.
Windows identity snapshots/handle-checked termination belong to
`cortexWindowsProcess.ts`; do not use POSIX groups or unchecked tree kills.
Cleanup failures must reject draining rather than authorize new work. Review
`test/cortexWindows.test.ts`, `test/cortexWindowsLaunch.test.ts` and
`test/cortexWindowsProcess.test.ts` alongside runtime/process/auth/doctor/update/
migration suites. Native PowerShell/ConPTY/auth/process/update acceptance is
still pending; simulated tests do not close C53. Keep Windows install/update
manual, other harness private-Node wrappers and appDir/macOS activation intact.
See `docs/research/cortex-code-windows-acceptance.md`.

C54 consolidated native commands are `CORTEX_CODE_E2E=1 npm run e2e:cortex-code`
and `CORTEX_CODE_E2E=1 npm run e2e:cortex-code-ui`. Use `-- --list` without
opt-in to inspect their catalogs; `-- --probe <id>` is a selected-scope run.
The shared runner pins retained 1.2.35, serializes ownership with a temporary
lock, isolates PM2/TMPDIR, supervises probe descendants and never retries failed
work. Keep the fixture root directly under `/tmp`: deep system-temp paths exceed
macOS tsx/PM2 socket limits. Track the private daemon separately from the probe's
ancestry and drain it without starting a replacement for stale PID files.
Share only `compatibility-report.json`; raw logs/native fixtures stay
private. Never remove an active lock or automatically clear a stale one without
checking its recorded owner and fixture cleanup. Freeze source during full V8
coverage collection; changing it can mix coverage mappings. Run full Jest before UI probes;
the UI runner rebuilds both clients. Its macOS catalog does not close C26,
strict Memory, Ubuntu/Windows, complete workflows or physical mobile gates.
Review `test/cortexCompatRunner.test.ts`, `test/cortexCompatProcess.test.ts` and
the consolidated-runner section in `docs/spec-testing.md` when changing it.

C54's native mobile run exposed Stop finishing its HTTP finalizer before the
CoCo stream consumer released its turn. CoCo may accept a new explicit turn
behind an aborted owner, but it must await native reset/drain, retain earlier
drains across another Stop, and never start a cancelled waiting prompt or clear
a newer owner from an older iterator. Healthy overlapping turns still reject;
cleanup failures do not start work. Keep the focused backend regression tests
and native queue/mobile probes aligned with this admission rule. Track pending
reset/drain promises independently of session-map entries, and include them and
previous cleanup in reset/shutdown completion even when no consumer is active.

C55 complete native workflows use `CORTEX_CODE_E2E=1 npm run
e2e:cortex-code-workflows` (chat, KB, Context, Routines, mobile/OCR). Keep the
separate `e2e:cortex-code-auth-control` expected-failure catalog free of saved
account selection; an empty native home can omit the model catalog, so preserve
Cockpit's configuration guard and check native inference separately. Never
weaken production guards to reach a missing-auth prompt. Validate each fixed
workflow outcome in `cortexCompatReports.ts`, not just a top-level pass.
The browser fixture is isolated and PM2-managed; real-adapter service fixtures
remain in-process. Chat's governed Memory uses a separate authenticated Claude
processor; C35 separately certifies CoCo strict Memory through its native
headless path below. KB needs real Ollama/Pandoc/
LibreOffice; Routine outreach stays a stub. Missing dependencies must fail,
never silently skip, mock or retry. Preserve short temporary roots, shared auth,
private report material and full-Jest-before-browser ordering. See the C55
matrix in `docs/spec-testing.md`; no full browser coverage of every workflow,
physical mobile, human OAuth or additional platform support is implied.

C56's explicit capability deferrals and evidence needed to lift them live in
`docs/research/cortex-code-capability-decisions.md`. Keep current vendor docs,
native terminal features and Cockpit's version-tested contracts distinct. Never
enable goals/agents/steering, additional media, pricing, account isolation or
strict Memory from a documentation claim alone. Public setup is documented in
`docs/user/cortex-code.md`; C59 ADR/mobile/PR preparation and final evidence live
in `docs/design/cortex-code-review.md`. ADR-0099 remains Proposed until merge
under ADR-0001. Review preparation does not publish a PR or release.

C35 restricted text ownership lives in `cortexRestricted.ts`,
`cortexRestrictedPolicy.ts` and `cortexRestrictedStream.ts`, separate from ACP.
Default/false allowTools must use the native headless zero-tool path; never
upgrade it to ACP/tool-enabled execution. Admit only macOS arm64 and standalone
1.2.35+191333.f82de3d91715 after passive pinned version/distribution checks.
Keep the private CORTEX_HOME **and cwd**, disable hooks via private hooks.json,
MCP/skills/auto-profiles, force standard mode, retain all 48 exact deny names,
and require empty tool/skill/plugin/MCP/slash startup catalogs before prompts.
Wrap arbitrary input as literal JSON text so native slash/shell dispatch cannot
run it. Preserve terminal HOME/SNOWFLAKE_HOME auth; this is not account isolation.
Unexpected tool/control/session/result frames fail closed. One deadline covers
startup/sequences; never replay, and await owned cleanup before temp deletion.
Review the focused restricted process/stream, Memory/selector and migration tests;
run `CORTEX_RESTRICTED_PROBE=1 npx tsx scripts/probe-cortex-restricted.ts` or the
workflow catalog's `--probe restricted` for native drift. Preserve actual outgoing
zero-schema/resource capture, working hook/MCP positive controls, real governance/
extraction/consolidation and active abort/fresh inference evidence. Other builds
and platforms stay gated. Titles/summaries retain fallback. This C35 proof
supersedes earlier strict-Memory deferrals only in the exact scope documented in
[the C35 report](docs/research/cortex-code-restricted-processors.md).

# Server Management

NEVER run `node server.js` directly. This causes orphan processes and port conflicts.

Always use pm2:
- Start: `npx pm2 start ecosystem.config.js`
- Restart: `npx pm2 restart [sitename]`
- Stop: `npx pm2 stop [sitename]`
- Logs: `npx pm2 logs [sitename]`

# Commits & PRs

- Use the GitHub CLI (`gh`) for GitHub interactions: creating PRs, reading PR/issue state, commenting, requesting reviews, applying labels, and checking CI. Use local `git` for local repository operations such as status, diff, branch, add, commit, and push.
- Do not use GitHub web/API connectors for normal repository work unless `gh` cannot perform the required action or the user explicitly asks for a different tool.
- Submit normal ready-for-review pull requests. Do not create draft PRs unless the user explicitly asks for a draft.
- All commits, PRs, issue comments, and other GitHub-visible activity must be authored as Daron Yondem using the configured local git/GitHub account.
- Do NOT mention AI assistants, agents, automation, or generated output in commit messages, PR bodies, issue comments, branch names, or release notes.
- Do NOT add tool-generated co-author lines in commit messages.
- Do NOT add generated-by footers in PR bodies.
- Do NOT add `Co-Authored-By: Claude ...` lines in commit messages.
- Do NOT add "Generated with Claude Code" footers in PR bodies.
- **Never use auto-closing keywords (`Closes`, `Fixes`, `Resolves`) for an issue unless the user has explicitly said the PR fully resolves it.** Default to non-closing references (`Refs #N`, `Re #N`, or just `#N`). This repo uses merge commits, so the keyword in any individual commit message lands on `main` verbatim and closes the issue on merge - fixing only the PR body is not enough. When in doubt, ask whether the issue should close on merge.
- Before submitting a PR, always:
  1. Run existing tests and ensure they pass.
  2. Add new tests for any new functionality or endpoints.
  3. Update existing tests if behavior changed.
  4. Evaluate mobile PWA impact. For every feature or behavior change, explicitly consider whether `mobile/AgentCockpitPWA`, `public/mobile`, mobile UX, PWA metadata, tests, or specs need updates.
  5. Update the spec docs to reflect all changes (endpoints, methods, UI behavior, test file list).
  6. Evaluate whether `AGENTS.md` needs updates. If the change introduces or changes a recurring architecture convention, ownership boundary, verification command, or agent workflow, update `AGENTS.md` in the same PR.

# Releases

- Before triggering the production release workflow, follow [`docs/release-workflow.md`](docs/release-workflow.md).
- Installer, release packaging, install-state, install-doctor, and self-update changes must preserve existing macOS production behavior. When a change targets Windows or another platform, explicitly verify the macOS-compatible path with focused tests such as `test/macosInstallerScript.test.ts`, `test/releasePackage.test.ts`, and relevant `test/updateService.test.ts` coverage, or document why a macOS check was unavailable.
- Linux production release support targets Ubuntu 24.04 LTS x64/glibc first. Keep Alpine/musl, NixOS, WSL, Linux arm64, and 32-bit Linux unsupported unless a later tested decision changes the support matrix. Linux installer/updater changes must preserve the macOS symlink activation path and Windows appDir activation path.
- macOS and Linux installers must register current-user session startup by default while keeping PM2 as the app supervisor: macOS uses `~/Library/LaunchAgents/com.agent-cockpit.server.plist`, Linux uses the `agent-cockpit.service` systemd user unit, and `--no-auto-start` records intentional manual startup. Do not replace this with privileged LaunchDaemons/system services or no-login operation unless a future ADR changes the model.
- Windows Claude/Codex CLI detection and launch fixes must prefer installer-managed package entrypoints under `<installDir>\cli-tools` before npm `.cmd` shim fallbacks, persist that prefix to the current user PATH when Agent Cockpit installs CLIs or applies Windows production self-updates, prefer package entrypoints discoverable beside PATH-visible npm shims before spawning `claude.cmd`/`codex.cmd`, still detect self-installed Windows CLIs from the user's PATH, use the shared Windows runtime resolver across backend/auth/doctor/update paths, and keep the macOS direct-command path unchanged.
- Manual Windows development startup builds must invoke `npm.cmd` through the existing `.cmd` wrapper path; do not switch startup build preflight back to bare `npm` on Windows.
- Windows terminal wrappers for Agent Cockpit-managed CLIs must not require a global Node install. When Codex or Grok Build is installed under `<installDir>\cli-tools`, installer repair reruns, Install Doctor, self-update, and CLI update paths must repair `codex.ps1`/`codex.cmd` and `grok.ps1`/`grok.cmd` so they invoke the recorded private `node.exe` and package entrypoint directly; keep this Windows-only and do not add the private runtime directory to the user PATH unless a future decision explicitly changes that.
- Welcome setup-auth changes for Claude/Codex must preserve system-wide CLI auth reuse: setup profiles must not retain `configDir`, `CLAUDE_CONFIG_DIR`, or `CODEX_HOME`, so terminal `claude`/`codex` and Agent Cockpit share login state. Keep explicit non-setup account-profile isolation available for users who configure separate profiles.
- Windows Claude setup-auth verification must also complete Claude Code's terminal onboarding marker in the user's normal `%USERPROFILE%\.claude.json` after `claude auth status --json` reports `loggedIn: true`; otherwise `claude auth status` can pass while plain terminal `claude` still shows first-run login selection. Keep this Windows-only and do not write that global file for isolated profiles using `CLAUDE_CONFIG_DIR`.
- Production self-update restart health must prove the target release is actually serving `/api/chat/version` with the expected version, not merely that some process answers the port. Use app-local PM2 commands for Windows target and rollback releases; do not reintroduce `npx pm2` into Windows restart/rollback paths.
- Windows installer ZIP extraction should remain non-interactive in user-facing PowerShell. Use the installer `System.IO.Compression.ZipFile` helper instead of `Expand-Archive` when editing `scripts/install-windows.ps1`, unless a later tested implementation proves it does not reintroduce console progress stalls.
- Windows installer readiness probing should avoid `Invoke-WebRequest` against HTML pages; use a raw .NET HTTP request so PowerShell page parsing/security prompts cannot pause the install while waiting for `/auth/setup`.
- POSIX self-update restart launchers must not depend on the executable bit of
  `<dataDir>/restart.sh`: invoke through `sh`, chmod after every write, and keep
  macOS/Linux installer repair runs chmodding stale restart scripts before PM2
  starts the app.
- Release preparation is agent-owned: generate `docs/releases/v<version>.md` from commits, merged PRs, closed issues, and code changes between release versions, then share it with the human for review.
- Use [`docs/release-notes-prompt.md`](docs/release-notes-prompt.md) when generating the per-release document. Do not ask the human to draft release notes from scratch.
- Validate the GitHub Release body with `npm run release:notes -- --version <version> --out /tmp/agent-cockpit-release-notes.md` before triggering `.github/workflows/release.yml`.

# Specification Documents

The project specification lives under `docs/` as a wiki-style collection of markdown files. Start at [`docs/SPEC.md`](docs/SPEC.md) for the index and overview.

- These documents are the **single source of truth** for the project. They must contain every endpoint, data model, behavior, and implementation detail needed to rewrite the project from scratch.
- When making changes to the codebase, always update the relevant spec file(s) to reflect the new state.
- Include maximum detail - spec documents should be precise enough that a developer unfamiliar with the codebase can reimplement any feature from the spec alone.
- The root `SPEC.md` is a thin redirect; all content lives in `docs/`.
- Keep current canonical specs at the top level as `docs/spec-*.md`. Store
  supporting design plans under `docs/design/`, empirical research and findings
  under `docs/research/`, and obsolete compatibility/history notes under
  `docs/archive/`. Update `docs/SPEC.md` and `docs/spec-coverage.md` when moving
  or adding docs in these categories.

# Architecture Decision Records (ADRs)

Decisions about *why* the system is shaped the way it is live in [`docs/adr/`](docs/adr/README.md). SPEC documents describe *what is true now*; ADRs describe *why we chose this and what we rejected*. See [ADR-0001](docs/adr/0001-record-architecture-decisions.md) for the practice itself.

## When to write an ADR

Before opening any PR, evaluate whether it warrants an ADR. Write one if **at least one** of these applies:

- Hard to reverse (data model, public API, dependency choice, build system)
- Crosses multiple subsystems
- The obvious choice was rejected
- Sets a pattern future PRs will follow

**Skip otherwise**: routine bug fixes, small features inside one module, formatting changes, version bumps, dependency patch bumps, documentation-only changes, test-only changes.

When in doubt, lean toward writing one - but keep the bar honest. Over-writing produces noise.

## How to write one

1. `npm run adr:new -- "Short title in present tense"` - scaffolds the file with the next sequential ID and the standard frontmatter.
2. Fill the sections: **Context**, **Decision**, **Alternatives Considered**, **Consequences**, **References**. Keep it concise - a tight ADR is more useful than a thorough one nobody reads.
3. Set `tags` and populate `affects` with code paths and docs whose existence depends on this decision (lint validates each path exists unless the ADR is tagged `historical` or the path is under a retired prefix listed in `scripts/adr-lint.js`).
4. Update relevant SPEC sections to reflect the new state, and cross-link them to the ADR. SPEC says *what*; ADR says *why*. Do not duplicate.
5. Commit alongside the implementation in the same PR branch - the ADR is part of the PR, not a follow-up.
6. Set `status: Proposed` if you want to leave room for the maintainer to push back; default to `Accepted` once you and the maintainer agree on the direction.

## Rules

- Filename pattern: `NNNN-kebab-title.md` (zero-padded sequential ID).
- Status lifecycle: `Proposed` -> `Accepted` (on merge) -> optionally `Deprecated` or `Superseded` later.
- Once `Accepted`, content is immutable. Only `status` and `superseded-by` may change. Reversing or revising = a new ADR that supersedes the old.
- Link-only updates to Accepted ADRs are allowed when repository documentation
  is reorganized and the linked target moves. Do not use link maintenance as an
  excuse to change the recorded decision text.
- Do **not** edit `docs/adr/README.md`. CI regenerates it from frontmatter on every PR touching `docs/adr/**`.
- The lint job (`npm run adr:lint`) validates frontmatter, filename, status/superseded-by rules, required sections, and that every path in `affects:` exists unless the ADR is tagged `historical` or the path is under a retired prefix listed in `scripts/adr-lint.js`. Run it before pushing if you want fast feedback.
