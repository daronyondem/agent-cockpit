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

# Grok Build Protocol Compatibility

Grok Build uses ACP plus native extensions through the focused
`src/services/backends/grok*.ts` modules. Review and extend the focused Grok
transport/event/backend/integration/process tests when changing protocol shapes,
session ownership, questions/plans, goals, usage, or process lifecycle. Run
`npm run e2e:grok-build` with an authenticated real `grok` for version-drift
validation; it is opt-in and uses temporary fixture workspaces. Current native
compatibility evidence is Grok Build 1.0.52 on macOS arm64. Windows resolver and
wrapper tests do not replace native Windows/Linux runs.

`BackendRegistry.shutdownAll()` also runs after CLI updates. Keep adapter
shutdown reusable for later runtimes, and close startups that complete after
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
Proposed ADR-0093 and `docs/design/cortex-code-implementation-plan.md`.

P1 profile/capability, P2 transport/runtime and P3 internal turn mapping are specified in
`docs/spec-cortex-code.md`; P5 now registers the chat adapter. CoCo owns its
dedicated `cortexProtocol.ts`, `cortexRuntime.ts`, `cortexSessions.ts` and
`cortexProcess.ts` modules; production code must not import Grok/Kiro adapters.
Review the focused `test/cortexProtocol.test.ts`, `test/cortexRuntime.test.ts`
and `test/cortexProcess.test.ts` when changing those boundaries. Run the opt-in
`scripts/probe-cortex-runtime.ts` for native runtime drift, as documented in
`docs/spec-testing.md`; it is not yet a full Cockpit adapter/UI suite. Retain
generation-safe reusable shutdown and identity-checked descendant cleanup.
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
signature; auth/transport failures must never cause prompt resend. Preserve
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
execution errors and malformed output; never mark invalid CoCo synthesis batches
processed or automatically resend interrupted tool work. Processor image format
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
interrupted work. Matching CoCo completion IDs resolve only their card; mobile
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
