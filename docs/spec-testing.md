# 10. Testing & CI/CD

[← Back to index](SPEC.md)

---

## Test Suite

**Framework:** Jest 30.x — run with `npm test`. The script is `node --experimental-vm-modules node_modules/.bin/jest` because the KB handler tests import `unpdf` (ESM-only, wraps `pdfjs-dist`) and Jest's VM needs the flag to allow runtime `import()` calls. `jest.config.js` uses `ts-jest` for TypeScript and also transforms JS/JSX with `allowJs: true`, `module: CommonJS`, and `jsx: react-jsx` so tests can import the V2 frontend ES modules directly instead of evaluating browser globals. Default Jest execution is capped at `maxWorkers: '50%'` so process-spawning suites still run in parallel without stampeding local or CI machines, and the global per-test timeout is 30 seconds so widened harness-specific timeouts can surface their route/process-specific errors before Jest's generic timeout.

**Coverage gate:** Run `npm run test:coverage` for backend coverage. The script keeps plain `npm test` unchanged for fast local iteration and runs Jest with `--coverage --runInBand`; serial execution keeps the full-suite coverage gate stable on local machines where parallel workers can exceed short route-test timeouts. `jest.config.js` collects coverage from `src/**/*.ts` and `server.ts`, excludes declaration-only `src/types/**` and `*.d.ts` files, writes reports under `coverage/`, and uses V8 coverage with `text-summary` plus `lcov` reporters. Global floors are statements/lines 89.45%, branches 79.45%, and functions 94.10%. The November 2, 2026 macOS cleanup coverage baseline at `84de7f4` measured statements/lines 88.28%, branches 74.99%, and functions 93.63% (139 passing suites, 2,720 passing tests; four opt-in suites and 24 tests skipped). The native orphan-cleanup fixture also passed separately with Copilot 1.0.105 on macOS arm64. New process/ownership/platform regressions provide coverage headroom without lowering the CI floor. When meaningful tests land, raise thresholds toward a stable cross-platform baseline; do not lower them merely to merge a regression.

The November 9, 2026 combined CoCo/Copilot macOS arm64 / Node 26.0.0 baseline
passes 224 suites / 3,581 tests, with seven opt-in/platform suites / 72 tests
skipped. V8 measures statements/lines 89.68% (60,172/67,091), branches 79.65%
(15,987/20,070), and functions 94.31% (3,086/3,272). Source/test/config files
were frozen during collection. This includes shared auth shutdown failure/drain
and closed-admission regressions, distinct native input identities, and retained
mobile drafts/uploads. Floors rise without reducing either branch's prior gate.
Native/UI evidence and its scope are recorded in the integration checkpoint below.

The pre-CoCo Copilot qualification uses CLI 1.0.105 / SDK 1.0.28. That historical
full run passes 172 suites / 3,052 tests (70 opt-in/platform skips), with 88.96%
statements/lines, 77.31% branches and 93.83% functions. Separate retained native
runs pass 34 SDK cases, 12 Memory/Context/KB/Routine application cases, two
device-code/status cases without browser authorization and 40 desktop/PWA/narrow-settings
browser cases. These runs use isolated local fixtures; successful hosted
accounts are not established. See the detailed qualification sections below and
[known capability/evidence limits](reference/backend-capabilities.md#copilot-known-capability-gaps).
The chronological checkpoints below retain earlier measurements and superseded
coverage floors; they do not override `jest.config.js` or this current baseline.

The November 3 Copilot Memory/Context integration run passed 140 suites and 2,737 tests (five opt-in suites/28 tests skipped), measuring statements/lines 88.31%, branches 75.25%, and functions 93.64%. Memory MCP branch coverage increased from 61.34% to 63.65%, and Workspace Context from 73.63% to 74.23% in the same local V8 environment; the branch floor rises from 74.5% to 74.6%. The four real-Copilot application workflow cases passed separately on 1.0.105/macOS arm64 with isolated auth and fixed local model responses. No desktop/mobile bundle or API contract changes are involved; API/WebSocket assertions cover shared server behavior rather than browser interaction.

The subsequent November 3 workflow/lifecycle run passed 143 suites and 2,750 tests (five opt-in suites and 34 tests skipped), measuring statements/lines 88.52%, branches 75.53%, and functions 93.78% locally. The floors rise to 88.2% statements/lines, 75.0% branches, and 93.5% functions. Six real-Copilot Memory/Context workflows and eight desktop/mobile Chromium cases pass separately on Copilot 1.0.105/macOS arm64 with fixed local model replies. Native Windows/Node 22 CI passes five process/stdio fixtures at `d02ffe2`; these do not claim actual Copilot Windows compatibility.

The Copilot SDK foundation/access-check checkpoint passes 147 suites and 2,793 tests (six opt-in/platform suites and 39 tests skipped) on macOS arm64/Node 26.0.0. V8 coverage measures statements/lines 88.56%, branches 75.64%, and functions 93.80%; the floors rise to 88.4%, 75.3%, and 93.6% respectively. Five native SDK cases also pass separately on Node 22.23.4 with SDK 1.0.28/CLI 1.0.105. New Windows/Linux SDK matrix jobs remain pending until run; local account checks recognize credentials but receive catalog HTTP 403, so hosted access is not verified.

The staged Copilot SDK conversation checkpoint passes 150 suites and 2,835 tests (six opt-in/platform suites and 41 skipped tests) on macOS arm64/Node 26.0.0. V8 measures statements/lines 88.61%, branches 75.88%, and functions 93.76%; the branch floor rises to 75.5% while other floors remain unchanged. This adds 42 normal-CI cases and two native cases. All seven native SDK cases pass on Node 22.23.4/CLI 1.0.105, including actual history across owned cold resumes and real tool-worker cancellation before same-ID resumption without replay. At that checkpoint, production dispatch and native ledger reconciliation remained pending.

The production SDK dispatch checkpoint passes 151 suites and 2,857 tests (six opt-in/platform suites and 43 skipped tests) on macOS arm64/Node 26.0.0. V8 measures statements/lines 88.62%, branches 75.97%, and functions 93.68%; the branch floor rises to 75.7%, with other floors unchanged. This adds 22 normal-CI cases and two native cases. Nine native SDK cases pass on Node 22.23.4/CLI 1.0.105, and six production Memory/Context workflows pass through SDK chat with fixed local replies. The facade retains opaque custom command compatibility without SDK-error fallback. Native reconciliation verifies disjoint cache accounting and delegated usage once. Eight desktop/mobile browser cases pass on macOS, with eight headless launches recorded and production clients rebuilt after full Jest fixtures; hosted billing and Windows/Linux SDK qualification remain separate.

The runtime catalog checkpoint passes 155 suites and 2,886 tests (six opt-in/platform suites and 43 skipped tests) on macOS arm64/Node 26.0.0. V8 measures statements/lines 88.66%, branches 76.17%, and functions 93.71%. The floors rise to 88.5% statements/lines and 75.9% branches; functions remain 93.6%. This adds 29 normal-CI cases. All nine native SDK cases and six native application workflows pass. Ten desktop/mobile browser cases pass after production rebuilds: the prior eight native SDK/local-provider workflows plus two injected-catalog selection/fallback/effort-clear cases. Native catalog tests verify unauthenticated and actual terminal-account HTTP 403 fallback; successful hosted catalogs, genuine two-account access and native Windows/Linux remain separate qualifications. The browser API cache's final private-counter rename is rechecked by 51 frontend cases. Retained coverage is explicitly compared with the raised floors; budgets remain unchanged.

The structured-input checkpoint passes 157 suites / 2,915 tests (six opt-in/platform suites and 48 skipped tests), with statements/lines 88.71%, branches 76.32% and functions 93.68%. It adds 29 normal-CI cases and raises floors to 88.6% statements/lines and 76.1% branches, retaining 93.6% functions. Retained measurements explicitly clear the raised floors. Fourteen native SDK cases and six native application workflows pass on CLI 1.0.105/macOS arm64 (SDK checks use Node 22.23.4). Eighteen rebuilt desktop/mobile browser cases pass: sixteen real SDK/local-provider workflows and two injected-catalog cases. The new cases exercise repeated question IDs across active reload, stale-answer refusal, freeform answers, Stop with a pending question and retained draft/files, consumed steering and late steering with draft/files preserved. Browser assertions were corrected to target the composer independently of idle/running/question placeholder text. Backend and client tests separately cover choices-only enforcement, unsafe withdrawal, duplicate submissions and delayed acknowledgements. No hosted account or native Windows/Linux result is implied. Production desktop JS is approximately 900.9 KiB; measured feature budgets rise to 903 KiB total and 263 KiB entry while CSS and other limits remain unchanged.

The delegated-work checkpoint passes 159 suites / 2,937 tests (six opt-in/platform suites and 54 skipped tests), measuring statements/lines 88.74%, branches 76.49% and functions 93.70%. Twenty-two new normal-CI cases cover ownership, nested/background lifecycle, escaped desktop/mobile summaries, immutable live state and terminal persistence. The branch floor rises to 76.3%; statements/lines retain 88.6% and functions 93.6%. Retained V8 measurements are explicitly checked against these floors. Twenty native SDK cases and six application workflows pass on CLI 1.0.105/macOS arm64; SDK checks use Node 22.23.4 and SDK 1.0.28. The combined background/steering test also passes after requiring readiness before submitting its correction. All twenty-two rebuilt Chromium cases pass (twenty native SDK/local-provider workflows plus two injected-catalog cases), with twenty-two headless launches recorded. Browser qualification remains separate from hosted-account or native Windows/Linux evidence. Desktop JS totals 901.6 KiB / 903 and CSS 201.7 / 230, with all existing asset budgets retained. Final focused client checks pass 123 cases. Fixture PM2/worker cleanup and all 29 recorded native SDK runtime PIDs are verified stopped.

If a local `safe.bareRepository=explicit` Git setting blocks temporary bare-repository fixtures, use the test-process-only override `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all npm run test:coverage`; do not change the developer's global Git configuration.

Shared chat route tests use `test/helpers/chatEnv.ts` for isolated Express/WebSocket servers and scratch data directories. Teardown waits for active streams, the session finalizer queue, and any in-flight durable stream-job registry mutation to become idle before closing the server and removing the scratch directory, so background finalizer/job writes cannot race temp-directory cleanup.

Test HTTP servers that are contacted through `127.0.0.1` bind explicitly to `127.0.0.1` instead of relying on `listen(0)`'s platform default. This avoids macOS/Node combinations that bind a listener to IPv6 `::` while the test client opens an IPv4 loopback connection, which otherwise leaves `HTTPCLIENTREQUEST` handles in `SYN_SENT` until Jest's per-test timeout fires. Test HTTP helper clients use a 15-second request timeout and destroy the request with a route-specific error so local listener failures fail as harness errors instead of hanging indefinitely, while still allowing process-spawning route tests to survive normal parallel-worker contention. Process-heavy suites may define larger per-test timeouts for child-process startup/shutdown or npm build subprocesses when they otherwise race the global Jest timeout under parallel load.

| File | Focus |
|------|-------|
| `test/cortexInteractionUi.test.ts` | Actual desktop/mobile cards use shared capability metadata, preserve Claude/Codex/Grok controls, respect explicit denial, reset identical-text drafts on fresh CoCo generations, bind callbacks to rendered IDs and disable every mobile reply input/action in flight. Expanded stream-store/mobile-pipeline suites cover duplicate/stale callbacks, newer interactions/drafts and delayed success/error/fallback responses. |
| `test/cortexDesktopSelection.test.ts` | Rendered desktop model/effort/mode/tier/profile controls, incomplete profile retention, same-ID connection changes, late/failing catalog responses, unavailable model replacements, shared catalog projections and saved-profile invalidation. Existing Claude Standard/Interactive, Codex and Grok controls retain coverage. |
| `test/cortexProfileEditor.test.ts` | Actual Settings profile fields, name/connection save, enable/delete, Harness transitions/auth-home cleanup, connection config removal and incomplete default/model retention. Setup lazy loader is stubbed; its auth UI has separate rendered/native coverage. |
| `test/profileMetadataCache.test.ts` | Actual browser API cache with deferred HTTP responses: settings invalidation prevents old successes caching and old failures deleting newer pending requests; in-flight and completed requests stay deduplicated. |
| `test/cortexProcessorSelection.test.ts` | Actual persistence/service/HTTP boundaries: preserve missing/disabled/incomplete global and workspace overrides, failed Context state/ownership, raw restored JSON, tool-role rejection before ingestion/OCR discovery, image-only recovery, digestion/gleaning role gates, Routine/Context rejection, no fallback invocation, and ingestion catalog reuse across raws (non-empty discovered once, empty rediscovered). |
| `test/cortexRoutinesIntegration.test.ts` | Actual CoCo process fixture through chat proposals and Routines: opt-in instructions, disabled passivity, proposal validation/install, manual manifest config, output/history/explorer/state, scheduler cadence/windows/weekdays, notification off/failure through an injected stub, headless/model errors, overlap/shutdown/deadline without resend/outreach, output retention and 50-record history. |
| `test/cortexContextIntegration.test.ts` | Actual CoCo process fixture through Workspace Context: global/override profile/model/effort, uploaded sources, direct markdown/state/reports, eligible Memory action/deletion and silent update, disabled Memory exclusion, invalid action blocks/headless questions without retry, stop/overlap/drain/fresh run, disabled/zero-source passivity, scan/maintenance scheduler and seven-day retention. |
| `test/cortexKbIntegration.test.ts` | Real CoCo process fixture through KB ingestion: JPEG-to-PNG preparation, original bytes, profile/model/effort, conversion records/dedup/location reuse, unsupported Auto refusal, headless failure and shutdown without resend or fabricated retry. |
| `test/cortexShots.test.ts` | Tool-enabled isolated/native sequential lease ownership, no replay/concurrent reuse, restricted rejection before startup, deadlines, AbortSignal, shutdown draining/reuse, sanitized failures and verified explicit image transport. |
| `test/processorProfiles.test.ts` | Browser-safe Memory processor choice projection: eligible choices, excluded unverified/missing profiles and disabled saved selections without replacement. |
| `test/memoryProcessorSelect.test.ts` | Rendered lazy Memory control: disabled saved CoCo selection, no automatic change, explicit eligible selection, unsupported choice exclusion and empty catalog. |
| `test/cortexProfiles.test.ts` | CoCo config validation, literal names, credential-field rejection, identity/resolution/default completeness, settings round-trip/edit/atomic rejection, read-time repair of malformed stored config and setup-home migration. No native execution. |
| `test/cortexProtocol.test.ts` | Dedicated strict CoCo JSONL framing/IDs/reverse ownership, limits, failures, deadlines (including zero = no deadline) and private diagnostics. |
| `test/cortexRuntime.test.ts` | Deterministic executable fixture: exact argv/env/version, realpath pinning across activation changes, profile fingerprints, session replay, cancellation, catalog scope, startup/reset/idle/reusable registry lifecycle, and cleanup of a detached child spawned after prompt completion whose parent exits before runtime shutdown. |
| `test/cortexProcess.test.ts` | POSIX detached-child cleanup after root exit, unrelated process preservation, identity reuse, bounded stop, enumeration failure and continuous 250 ms POSIX scanning until stop, with idempotent watcher registration. |
| `test/cortexMobileAttachments.test.ts` | Selected OCR model/effort, synchronous duplicate exclusion, deferred ownership across navigation/reset/removal/clear/model/unmount, cached insertion, failure and explicit retry. |
| `test/cortexMobileSelection.test.ts` | Saved CoCo model/effort through pending/failed profile discovery, locked profile, unsupported goal capability, and dismissal of the Conversation actions sheet before opening session history. |
| `test/chatAttachmentResolution.test.ts` | Explicit upload references derive real server metadata; missing, nested, traversal, non-file and symlink references are rejected. CoCo HTTP integration verifies actual PNG blocks and prose-only paths staying text; desktop and mobile tests cover immediate and queued references. |
| `test/cortexUsageUi.test.ts` | Rendered CoCo desktop/mobile context, token/cache and unknown-cost display; existing harness price regression; shared projection and mixed ledger aggregation. |
| `test/cortexEvents.test.ts` | Native text/thinking/tool/diff/resource mapping, ownership, fragmented errors/delivery markers, failure classification and token/context counters. |
| `test/cortexModels.test.ts` | Dynamic configOptions, model/effort/mode selection, auto reset, invalid selections, stale catalogs, profile separation and pinned image evidence. |
| `test/cortexInteractions.test.ts` | RPC ID 0, exact option/free-form/sequential replies, decision generations with `decisionBound` question/plan cards, stale/double responses, permissions, plan revision and exit cancellation. |
| `test/cortexTurn.test.ts` | Internal bridge sequencing, retained native excerpt transport, repeated turns, known/unknown/quoted errors, incomplete usage, abort/runtime drain before adapter done, process death, explicit delivery and an inactivity watchdog that waits through pending decisions. |
| `test/cortexAttachments.test.ts` | Upload-root validation, PNG signatures/decoding, model/version/MIME gates, file/pixel/aggregate limits and traversal/symlink rejection. |
| `test/cortexArtifacts.test.ts` | Real upload/queue, explicit artifact/storage/download/text-preview and ledger integration; text/code/Office/PDF bytes, deduplication and ownership. |
| `test/backendCapabilities.test.ts` | Browser-safe role/interaction policy, CoCo fail-closed one-shot metadata, legacy compatibility, sequential and model/media eligibility. Existing `test/mediaCapabilities.test.ts` covers the backend facade. |
| `test/nodeRuntimeRequirement.test.ts` | Full Node >= engine-floor comparisons, legacy major-only targets and patch floors, plus executable macOS/Linux installer eligibility cases around Node 22.12.0 using fixture Node/npm commands. The updater suite also exercises a same-major minor upgrade through macOS private-runtime activation. Windows version gates retain source guards; native Windows installer execution remains separate evidence. |
| `test/grokProtocol.test.ts` | ACP framing across split UTF-8/large chunks, bounds, reverse ID zero, malformed frames, error metadata, EOF/exit and pending request timeout cleanup. |
| `test/grokEvents.test.ts` | Root/child ownership, tools/artifacts/narration, native goals and effort/media catalog, disjoint token buckets, complete/partial costs, per-model rows, resident usage deltas. |
| `test/grokBackend.test.ts` | Conversation leases and overlap isolation, reusable adapter cleanup after CLI updates, terminal-failure runtime discard, recovery/status reads, serialized session preparation (a racing status read cannot suppress a turn's recovery; status/control never create sessions; controls reserve the runtime; every turn announces its session), sequential restricted calls, zero-tool preflight and slash protection including after recovery, deadlines/cancel including native child IDs, questions/plans, interjection steering, goals, negotiated MCP refresh, background completion and reconciled cost. |
| `test/grokInteractions.test.ts` | Reverse-request handling without a runtime: permission `allow_once` selection or cancellation, restricted-call rejection, unsupported requests, sequential multi-question answers, exact plan approval/abandon/revision-feedback semantics, skip/turn-end cancellation, and native resolution presenting the next request. |
| `test/grokIntegration.test.ts` | Local process fixtures for profile metadata and native effort persistence, cached auth precedence, API-key method negotiation including an unadvertised method, access gates/API-key ambiguity, billing route/cache identity/sparse balances, setup auth-home migration, device jobs, incompatible ACP initialization cleanup, and two successive plan approvals through the real WebSocket/input route after revision feedback without repeated native mode entry. |
| `test/grokProcess.test.ts` | Process ancestry and real POSIX detached descendants: cleanup after root death with TERM/KILL escalation while an unrelated process survives. Mocked process tables and signals cover start-identity PID-reuse exclusion, explicit SIGTERM-then-SIGKILL escalation, the process-group fallback when `ps` fails, and Windows `taskkill` with direct-kill fallback. |
| `test/grokWindows.test.ts` | Windows native executable preference, managed package/private Node fallback, terminal wrapper repair and missing targets. Native Windows execution still requires a platform run. |
| `test/grokUi.test.ts` | Rendered desktop sparse/zero billing, advertised plan revision feedback, mobile explicit plan decisions, and mobile profile switching with late-response isolation. Uses the frontend module loader with React dependencies supplied explicitly. |
| `test/planUsageStores.test.ts` Grok coverage | Per-profile cache/request coalescing, subscription notifications, and clearing unavailable billing without affecting another profile. |
| `test/grokBuild.e2e.test.ts` | Eight opt-in authenticated real-CLI checks through `npm run e2e:grok-build`: terminal auth/catalog, restricted sequential calls/slash protection, empty auth-home isolation and invalid-key failure, real isolated device-login cancellation, hard-exit descendant cleanup/recovery, background children/settled usage, questions/revised plans, goal controls, and full autonomous goal completion. Completion has an external 360-second cancellation deadline. Uses temporary workspaces/native sessions; verified on Grok Build 1.0.52 macOS arm64. |
| `test/grokWorkflows.e2e.test.ts` | Three native application checks included in `npm run e2e:grok-build`: real KB ingestion/digestion and Memory/KB token-scoped MCP tools/governance, Workspace Context maintenance from a reference, and an opt-in manual Routine with notifications off. Uses isolated HTTP/WS services and temporary data. |
| `test/e2e/grokBuild.ui.pw.ts` | Opt-in desktop/mobile browser checks through `npm run e2e:grok-build-ui`: native profile/model/effort persistence, sequential questions surviving a deliberately delayed input acknowledgement on desktop and mobile, revised plans, real downloads/mobile previews, reload/abort recovery, usage, and cross-client goal controls. `scripts/run-grok-build-ui-e2e.ts` builds production assets, manages only its isolated fixture server through PM2, and writes temporary compatibility metadata. `scripts/run-grok-build-e2e.ts` runs both native Jest suites and records CLI/OS/Node/git revision/dirty state without POSIX-only env assignment. Neither native command runs in normal CI. |
| `test/workspaceContext.service.test.ts` | Workspace Context service coverage: enabling creates `workspace-context/WORKSPACE_CONTEXT.md`, `context/overview.md`, `references/`, `assets/`, `runs/`, and `state.json`; installs and removes the managed `AGENTS.md` block without overwriting unrelated instructions; resolves global vs workspace processor settings; runs autonomous scan prompts with tool access in the real workspace; runs maintenance over existing context markdown, reference files, asset inventory, and accepted Memory inbox entries; consumes accepted active Memory inbox entries and deletes them; fails visibly when required Memory action output is missing; records run state for initial, scheduled, manual, reset, archive, maintenance, and skipped sources; verifies frequent scans do not starve maintenance; supports stop/clear/repair behavior; lists and reads only markdown files under `workspace-context/context/`; lists/reads/writes/deletes markdown/text references under `workspace-context/references/`; lists/stores/serves/deletes allowlisted non-executable assets under `workspace-context/assets/`; and never creates graph, candidate, MCP, or review artifacts. |
| `test/chat.workspaceContext.test.ts` | Workspace Context REST coverage for settings, enablement, manual scan, maintenance, stop, clear, instruction repair, context file listing/reads, reference listing/reads/writes/deletes, asset listing/upload/preview/download/delete, conversation-scoped Workspace Context context/reference/asset previews/download validation, disabled/unknown workspace responses, conversation `workspaceContext` hydration, and workspace-scoped `workspace_context_update` emissions. |
| `test/chat.memory.test.ts` Memory v2 REST coverage | Workspace memory route coverage: `GET /workspaces/:workspaceId/memory/search` rejects empty queries, returns `{ enabled:false, query, results: [] }` while memory is disabled, searches enabled workspace memory, defaults to active/redacted entries, and honors type/status filters including explicit superseded recall; consolidation propose/apply and draft/apply-draft routes cover safe supersession and reviewed rewrites; deleted CLI-capture entries stay hidden after future native captures; removed Memory Review routes return `410`; and conversation responses no longer expose `memoryReview`. |
| `test/chat.memorySearch.test.ts` | Direct Workspace Memory lexical-search coverage for tokenization, lifecycle/type filters, exact-match and type-aware ranking boosts, BM25-style ordering, recency tie-breaks, and snippet extraction. |
| `test/chat.extractedModules.test.ts` | Direct coverage for ChatService extraction modules: memory metadata normalization, conversation policy defaults, transcript markdown rendering, session transition persistence, Workspace Context status normalization, KB state snapshot counters, workspace memory lifecycle delegation, legacy migrations, and worktree-isolation bulk toggle orchestration. |
| `test/frontendRoutes.test.ts` Memory v2 static coverage | Workspace Memory panel static guards assert the frontend exposes search, restore, delete, clear, the search input, type/lifecycle filter controls, global Settings Memory processor status/profile copy, and CSS hooks for search controls, lifecycle status pills, and Memory processor status. The same guards assert Memory Review API helpers, schedule/run UI, dedicated page, composer notification, and dead consolidation review UI are absent. |
| `test/frontendRoutes.test.ts` Workspace Context static coverage | Static guards assert `AgentApi.workspace` exposes Workspace Context settings, enablement, manual scan, maintenance, stop, clear, repair, context file list/read helpers, reference list/read/save/delete helpers, and asset list/upload/view/download/delete helpers; global Settings exposes the Workspace Context tab with processor defaults, scan/maintenance intervals, and scan/maintenance concurrency; Workspace Settings exposes Overview, Processor, Context, References, Assets, Runs, and Danger Zone sections; run state polling keeps the on-screen Workspace Context tab current, renders runs latest-first by start time, renders run summaries as Markdown, and exposes older/newer run-log paging; context previews are read-only markdown; references and assets share the same two-pane file-browser design as context while keeping reference edit controls and asset upload controls in the preview pane; asset previews handle safe text/markdown/image files; desktop chat resolves Workspace Context context/reference/asset links into file-preview descriptors; old graph/entity/candidate/review endpoints and UI hooks are absent; the composer exposes a Workspace Context notification for running/failed runs; and Workspace Context CSS contains the shared browser plus markdown/reference/asset/run controls without old graph or review classes. |
| `test/routines.service.test.ts` | Workspace Routines service coverage: disabled workspace no-side-effect list/run behavior, generated authoring files and managed `AGENTS.md` block, proposal marker validation inside the workspace routines folder, schedule validation, install/edit/disable/delete lifecycle, one-shot run folder/input/final output handling, `notify.md` notification routing including global Telegram bot token fallback with workspace chat destinations, process-local Telegram destination pairing through `getUpdates`, scheduler due checks over routines-enabled workspaces, and Telegram request shape. |
| `test/chat.routines.test.ts` | Workspace Routines REST coverage for default-disabled list behavior, stale managed `AGENTS.md` block cleanup while disabled, enable/disable toggle behavior, proposal validation before and after install, disabled-route rejection, proposed-run rejection, install/edit/background manual run start snapshots, per-run and aggregate routine output explorer scopes, routine persistent-state explorer scope, delete, workspace Telegram settings token redaction/clearing with separate bot/destination configured flags, and Telegram destination pairing route polling that stores chat id/title/type without echoing the token. |
| `test/frontendRoutes.test.ts` Workspace Routines static coverage | Static guards assert `AgentApi.workspace` exposes routines list/enable/detail/install/update/run/delete/settings helpers plus Telegram destination start/poll helpers, Workspace Settings exposes the Routines enable toggle, muted disabled state, tab/editor/settings/actions with general workspace settings styles, including the action-row spacer that separates immediate actions from management actions, uses a real timezone selector for scheduled routines, opens per-run, aggregate output, and persistent-state routine scopes with return-to-routine navigation, links missing Telegram bot setup to Global Settings Integrations instead of rendering a workspace bot-token field, exposes **Connect Destination**, the pending `/connect` instruction panel, **Check now**, and **Chat ID (advanced)** for workspace Telegram destinations, merges run-start snapshots and keeps polling active while a routine is running, desktop chat strips routine proposal markers and renders proposal install actions with persistent/server-backed `Installed` state, `ChatLive` passes workspace settings navigation into `FileViewerContext`, and routines/chat CSS modules are imported. |
| `test/frontendRoutes.test.ts` workspace archive static coverage | Static guards assert `AgentApi.workspace` exposes workspace listing, archive metadata, backup estimate, archive, restore, and archived-data delete helpers; global Settings exposes the Archived Workspaces left-rail section and lazy-loads `ArchivedWorkspacesPanel`; the sidebar does not expose a separate Archived workspaces command; Workspace Settings exposes the Archive tab with backup estimate/archive controls and the user-facing archive-type labels; the archived-workspace panel exposes remap, restore, backup restore, and destructive delete controls; CLI Profile Settings exposes Claude Code Anthropic/AWS Bedrock provider options plus Bedrock inference-profile add/remove/default controls; and archive/Bedrock CSS hooks exist. |
| `test/frontendRoutes.test.ts` usage pricing static coverage | Static guards assert the desktop Usage tab exposes **Cost** and **Estimated Cost** separately, loads/saves/clears usage pricing overrides through `AgentApi.settings`, includes pricing override CSS hooks, the desktop context chip can render `estimatedCostUsd` as **Estimated Cost**, and the mobile PWA usage bar renders a separate **Estimated Cost** cell. |
| `test/usagePricing.test.ts` | Built-in usage-pricing catalog validation and estimator coverage: provider mapping, provider-reported nonzero cost precedence, OpenAI token rates including cached input/cache writes, GPT-6 Astra standard and Codex Fast/Priority pricing with short- vs long-context rate selection, GPT-6.1 Sol, legacy GPT-6 Sol, GPT-6 Luna Fast/Priority, current GPT-5.6 family, and Daybreak Blue alias pricing, rejection of incomplete long-context token pricing, tier-specific pattern precedence, no-estimate behavior for Codex Spark research-preview usage, Anthropic cache read/write rates, current-vs-deprecated Claude Opus pattern separation including Opus 5's Claude Code `[1m]` id and Opus 4.8, introductory Sonnet 5 pricing, Opus 5.5/Sonnet 5.5/Fable 5.1 family pricing ordered ahead of the broader Opus 5/Sonnet 5/Fable 5 globs, current Fable 5 pricing, Bedrock inference profile IDs/ARNs matching known embedded Claude Fable/Opus model ids while preserving the invoked model string, current Haiku 4.5 pricing, Kiro credit overage pricing, no-estimate behavior for unmatched models, user override precedence through explicit entries/catalog version, and preservation of already-persisted estimates. |
| `test/usagePricingStore.test.ts` | UsagePricingStore coverage: missing override file returns the built-in effective catalog, override saves persist and precede built-ins, long-context token override fields round-trip through persisted JSON, clearing writes an empty override catalog, malformed override entries are rejected, and corrupt override files are logged/ignored without overwriting the user's file. |
| `test/toolUtils.test.ts` | Shared backend helpers: extractToolDetails, extractToolOutcome, extractUsage, shortenPath, sanitizeSystemPrompt, isApiError |
| `test/claudeCodeInteractive.test.ts` | Claude Code Interactive backend coverage: metadata/capability shape, hidden PTY stream integration with a transcript file created after startup, `SessionStart` prompt-readiness gating, separated prompt body/Enter writes, `PreToolUse` hook fallback for live `AskUserQuestion` cards before transcript flush, production versus diagnostic hook settings/payload parsing, merging Claude Code Ultracode into the interactive hook `--settings` payload for xhigh-capable models, `Stop` hook transcript path finalization and retry/backoff, `last_assistant_message` fallback without duplication, transcript tailing/deduplication for new files, synthetic Claude local-command `No response requested.` transcript filtering, synthetic/zero-value usage filtering so `<synthetic>` ledger rows are not created, `/goal clear` local-command completion mapping, DEC/XTerm terminal query responses, rolling split trust-prompt confirmation, bypass-permissions warning acceptance, AskUserQuestion option-to-number input mapping, `node-pty` spawn-helper permission repair, Claude CLI compatibility warning severity, runtime resolution that preserves `backend: 'claude-code-interactive'` while using the shared Claude Code CLI profile, and ChatService conversation creation that stores the interactive provider on the shared Claude profile. |
| `test/claudeCodeInteractive.e2e.test.ts` | Optional real-Claude drift coverage gated by `CLAUDE_INTERACTIVE_E2E=1`: launches the real `claude` CLI through the Claude Code Interactive adapter in temp workspaces, optionally using `CLAUDE_INTERACTIVE_E2E_CONFIG_DIR`, and validates real hidden-PTY/transcript behavior for smoke streaming, immediate `--resume` follow-up without synthetic `/exit` leakage, filesystem tool read/write side effects, Bash tool reconstruction, diagnostic current-CLI plan hook payloads with optional `planFilePath`, diagnostic EnterPlanMode hook visibility through either `PreToolUse` or `PostToolUse`, diagnostic subagent lifecycle hooks including `agent_transcript_path`, hookless transcript polling fallback, `/goal` transcript parsing, and abort/timeout cleanup that leaves no turn-owned Claude child process alive. When `CLAUDE_INTERACTIVE_E2E_ARTIFACT_DIR` is set, each scenario writes event JSON, diagnostic hook JSON when enabled, workspace file listings, goal snapshots where relevant, run metadata, and copied Claude transcript JSONL files for drift diagnosis. Skipped by default and not required for normal CI. `npm run e2e:claude-interactive` runs the gated test directly, while `npm run e2e:claude-interactive:report` wraps it and stores a Markdown/JSON report under `data/chat/claude-interactive-compat/<timestamp>/` by default so generated reports stay inside ignored chat runtime state. |
| `test/e2e/claudeCodeInteractive.ui.pw.ts` | Optional real-Claude browser drift coverage gated by `CLAUDE_INTERACTIVE_UI_E2E=1`: runs Playwright against the built `/v2` UI with an isolated Agent Cockpit server, scratch `Desktop/test-workspace`, and seeded `CC-Int` Claude Code profile using `protocol: "interactive"`. The suite verifies workspace filtering and conversation selection, composer CLI profile selection, session reset before and after work, real interactive smoke and follow-up turns, browser reload while a turn is active, server-restart interruption recovery, real filesystem Write/Edit side effects from the browser, Stop/abort UI rendering for active turns and pending plan/question cards, reset disabling while a plan/question is waiting, multi-workspace conversation isolation, Bash tool rendering/outcomes, Agent/subagent plus multi-tool rendering, attachment upload/readback, Claude Code Interactive goal set/display/clear, plan approval/resume plus a post-approval follow-up, and browser-driven `AskUserQuestion` answering through both option buttons and typed option-label input plus a post-question follow-up. Current real Claude Code question menus are option-driven, so the typed-input scenario validates option-label-to-menu-index mapping rather than arbitrary free-text question payloads. The file is named `.pw.ts` so Jest does not run it during normal `npm test`. `npm run e2e:claude-interactive-ui` runs against an already available server/base URL, while `npm run e2e:claude-interactive-ui:report` builds the V2 web bundle, starts an isolated server on a random local port, runs the suite with an authenticated real `claude` CLI, stops the server, and stores a Markdown/JSON report under `data/chat/claude-interactive-ui-e2e/<timestamp>/` by default. Arguments after `--` are forwarded to Playwright, so targeted checks such as `npm run e2e:claude-interactive-ui:report -- --grep "clarifying question"` can reuse the same isolated harness. Skipped by default, not part of CI, and intentionally not mocked because it is used to detect future Claude CLI version drift in browser-visible behavior. |
| `test/fileLinks.test.ts` | V2 frontend file-link helper: resolves Codex-style absolute Markdown hrefs under the active workspace, resolves active-conversation `data/chat/artifacts/{convId}/{filename}` links to uploaded-file metadata, strips optional `:line` / `:line:column` suffixes, decodes URL-encoded paths, accepts `file://` URLs, and rejects web links, relative links, wrong-conversation artifact paths, nested artifact paths, outside-workspace paths, and traversal-looking paths. |
| `test/filePreviewKinds.test.js` | Desktop Files Browser preview classifier: verifies Astro files are treated as editable text previews rather than unsupported files. |
| `test/cliProfileConfigDir.test.ts` | Settings account-profile **Config directory** copy: for Claude Code, Codex, Grok Build and Cortex Code, the hint names the variable that harness's real runtime resolver sets from `configDir` (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `SNOWFLAKE_HOME`), and Grok Build no longer falls back to the Claude Code hint or placeholder. CoCo uses the current Node executable as a passive executable fixture; the test never launches it and requires no installed CLI or credentials. |
| `test/dngPreview.test.ts` | Conversation-upload DNG preview parser: extracts embedded JPEG previews from synthetic little-endian and big-endian baseline TIFF/DNG wrappers, parses JPEG SOF dimensions, trims extracted bytes at JPEG EOI even when `StripByteCounts` includes trailing data, rejects non-TIFF bytes, rejects DNGs without a readable JPEG preview, and skips linear raw subimages (`PhotometricInterpretation=34892`) so chat upload support stays preview-extraction-only rather than full RAW demosaic. |
| `test/frontendMessageIdentity.test.ts` | V2 frontend message identity helpers: system-owned messages such as native-session recovery notices render as Agent Cockpit for author labels, avatars, and pin sources while assistant messages keep harness identity and goal lifecycle system messages keep the Goal identity. |
| `test/frontendMessageParsing.test.ts` | V2 frontend chat-message parsing helpers: extracts file-delivery comment markers, strips those markers from visible message content, parses uploaded-file tags, and guards hidden stream-error marker ids. |
| `test/synthesisAtlas.test.ts` | V2 Synthesis Browse grouping helpers (`web/AgentCockpitWeb/src/synthesisAtlas.js`): topic/connection normalization filters invalid graph edges, de-duplicates reverse undirected pairs, detects hub/god topics, separates bridge-like edges into cross-area bridges, groups god-node star data into a bridge-topic area plus one `Uncategorized / Review` area instead of a single star, and keeps area/bridge summaries deterministic. The helper supports the Browse list's area-first presentation; the visible Atlas mode has been removed. |
| `test/settingsService.test.ts` | Settings defaults and read-time migrations, including fresh installs with no default CLI profile/backend, legacy persisted `defaultBackend` migration to server-configured profiles, first-enabled-profile default promotion, Workspace Context scan/concurrency defaults, legacy `contextMap` migration into `workspaceContext`, global Telegram integration token redaction/preservation/clearing for whole-settings saves, save-time `defaultCliProfileId` → `defaultBackend` synchronization, Codex-only `defaultServiceTier` retention, Kiro profile normalization back to self-configured mode with runtime overrides stripped, Claude Code provider normalization including Anthropic defaults, Bedrock inference-profile trimming/default-row handling, stripping `claudeCode` from non-Claude profiles, OpenCode profile normalization back to self-configured mode with provider metadata preserved while profile-level model/config/env fields are stripped, OpenCode metadata stripping on non-OpenCode profiles, GitHub Copilot profile normalization that forces self-configured auth mode and drops isolated config while preserving the command override, and Welcome setup account profile normalization that strips stale private auth homes from saved or persisted settings. |
| `test/settingsService.test.ts` CLI profile settings coverage | Save-time normalization keeps Memory, Knowledge Base, and Workspace Context profile selections (`memory.cliProfileId`, `ingestionCliProfileId`, `digestionCliProfileId`, `dreamingCliProfileId`, `workspaceContext.cliProfileId`) aligned with legacy `*CliBackend` mirrors, migrates legacy `cliProfiles[].vendor` into canonical `cliProfiles[].harness`, clamps Workspace Context scan and maintenance intervals/concurrency, and strips removed Workspace Context graph/extraction/synthesis/source fields. |
| `test/chat.cliProfileAuth.test.ts` | CLI profile remote-auth routes/service: explicit non-setup account-profile status checks create/persist the default config directory and run with `CLAUDE_CONFIG_DIR`; Claude status checks parse `claude auth status --json` and reject exit-0 `loggedIn:false` responses; saved OpenCode self-configured checks run `opencode --version` without creating an auth config directory, hydrate model metadata through `opencode models <provider> --verbose` with a plain-command fallback, and report failed version checks as `error` rather than authenticated; unsaved OpenCode draft metadata/check routes run without saving settings, accept legacy `vendor` input while returning canonical `harness`, normalize drafts to provider-only self-configured profiles, and populate model metadata from the draft command/provider; Windows account-profile checks use the installer-managed Codex package script through `node.exe` instead of relying on npm `.cmd` shim spawning; Windows Claude Code setup-auth verification marks the user's global `.claude.json` onboarding flag after credentials verify so plain terminal `claude` does not remain stuck at first-run login selection; auth start creates a pollable job and exposes redacted device-flow/login text for Codex; Welcome setup-auth routes create or reuse Codex/Claude account profiles without `configDir`, use the system CLI auth home instead of `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, migrate old setup profiles off generated config directories and auth-home env variables, and direct setup-profile checks also strip stale `configDir`/auth-home env values before checking status; setup auth promotes a created account profile when no default exists or when it replaces that harness's server-configured default, and keeps Kiro explicitly self-configured; duplicate running jobs for one profile are rejected; auth jobs can be cancelled; successful login-process exit is followed by status verification; Claude login jobs fail when final status JSON remains `loggedIn:false`; status verification timeout fails the job with the last redacted output; long-running login jobs fail after timeout; token/API-key-like auth output is redacted. |
| `test/cliProfileAuthService.test.ts` | Direct `CliProfileAuthService` unit coverage with injected fake child processes and no real CLI spawns: deterministic default config-dir slug/hash generation; `profileWithAuthDefaults()` unknown/disabled/non-account/OpenCode/Kiro errors, account-profile config-dir assignment, and Welcome setup-profile `configDir`/`CLAUDE_CONFIG_DIR`/`CODEX_HOME` stripping; `checkProfile()` parsing for noisy Claude `loggedIn:true`, Claude logged-out/missing JSON, Codex exit-code semantics, spawn `ENOENT`, and Kiro unsupported status; `startAuth()` success, login nonzero exit, child error, status-verification timeout, auth timeout/`SIGTERM`, duplicate-running rejection, redacted/truncated/ring-buffered events; `getJob()` clone isolation, `cancelJob()`, `shutdown()`, recent-job eviction, and `redactCliAuthText()` ANSI/token scrubbing. |
| `test/opencodeBackend.test.ts` | OpenCode adapter helpers: runtime resolution finds `~/.opencode/bin/opencode` when PATH lacks the command, metadata advertises one-shot image/PDF explicit attachment transport, missing working directories surface as OpenCode stream errors before spawn, run arguments include provider model/session/variant/thinking/permission flags only when supported or requested, image/PDF `RunOneShotOptions.attachments` are forwarded as repeated `opencode run --file` flags while unsupported audio attachments are ignored, ACP-shaped MCP server entries become OpenCode local MCP config, model discovery parses ANSI-stripped `provider/model` output plus verbose variant and nested `capabilities.*` media metadata (including DeepSeek-style `capabilities.input.image:false` and OpenRouter vision-model `capabilities.input.image:true`/`capabilities.input.pdf:true` with a display label that hides the leading `openrouter/` prefix), newline JSON text/session/thinking/usage events translate to Cockpit stream events, missing resumed `--session` targets create a recovery snapshot, emit the friendly recovery event, and retry once without `--session` with a mandatory snapshot-read prompt, assistant message metadata is extracted from step events, exported OpenCode sessions recover assistant text when the latest assistant message omits stdout text, exported assistant message `info.tokens` / `info.cost` or `step-finish` part data recovers provider-reported usage when live usage is missing without duplicating live usage, text without message ids is attributed to the current assistant message, one-shot collection replaces pre-tool narration with exported final text when needed, and built-in/MCP `tool_use` parts map to `tool_activity` / `tool_outcomes` while preserving MCP tool suffixes and suppressing outcomes for non-terminal or missing-id tool frames. |
| `test/mediaCapabilities.test.ts` | Shared one-shot media gate helper coverage: accepts only when backend metadata exposes a transport for the requested modality and the selected/default model reports that input modality as `true`, uses the default model when no explicit model is selected, fails when backend transport is absent, fails when the selected model reports no image input, and fails closed for stale explicit model ids instead of falling back to the default model. |
| `test/chatContracts.test.ts` | Chat contract helper coverage: browser-safe service-tier input normalization, Claude Code mode input normalization for create/send payloads including clear and invalid values, conversation/stream mutation payload normalization including message-pin payload validation, queue update runtime validation, attachment payload validation, OCR attachment payload validation including optional profile/backend runtime hints, settings payload object validation, explorer save payloads, KB enablement/auto-digest/glossary/embedding/folder payloads, memory enabled payloads, Workspace Context enablement/settings payloads, shared object/array/clamped-number validation helpers, and shared `ContractValidationError` detection. |
| `test/processStream.golden.test.ts` | Direct `processStream` golden traces that bypass the Express/WebSocket test harness: ordered mixed text/thinking/tool/outcome/artifact streams emit the expected browser frame sequence and persist ordered `contentBlocks`; result-only streams synthesize a final text block; and successful plan-file tool outcomes withhold `planContent` from the Write frame while emitting a synthetic `ExitPlanMode` approval frame with the stored plan content. |
| `test/cortexMigration.test.ts` | CoCo passive destination dependencies, no imported command execution, effective shared/custom Snowflake home, missing/incomplete configuration, sanitized malformed/missing/symlink TOML, Windows runtime policy and reserved native temp paths. |
| `test/cortexDataMigration.test.ts` | Full-root CoCo profile/settings/chat/queue/media/usage/Memory/Context/Routine preservation, default and unavailable processor IDs, byte integrity and normalized reads, replacement backup, external-home preservation, stale absolute-home warning, native runtime path/empty-directory rejection and tampered CoCo settings rejection. |
| `test/dataMigrationService.test.ts` | DataMigrationService coverage: export bundle manifest/checksum generation including Memory/KB/Workspace Context/Workspace Routines feature metadata, runtime-file exclusions, PGLite empty runtime directory preservation/repair, checksum mismatch rejection during staged import verification, undeclared data-entry rejection before activation, uncompressed bundle limit rejection, staging cleanup on failure, pending import application with active data-root replacement plus backup preservation and upload cleanup, double-pending import rejection, failed startup import marker handling so retries do not loop forever, and post-import checks for workspace storage/current paths, Memory, KB SQLite `schema_version`, PGLite vectors, embedding warnings, Workspace Context, and Workspace Routines data presence. |
| `test/chat.dataMigration.test.ts` | Data migration route coverage: export job start/status/download flow, chunked import upload start/chunk/finish preview flow, legacy multipart preview upload and destructive `REPLACE` confirmation flow with CoCo dependency warnings and unchanged staged profile bytes, pending marker creation on successful restart scheduling, missing-upload client error behavior, status/checks response shapes, active-turn/restart failure behavior, and restart-failure cancellation so a later unrelated restart does not apply a stale import. |
| `test/chat.worktreeIsolation.test.ts` | Workspace worktree-isolation coverage: non-Git/unconfirmed/dirty-base/missing-origin enablement blockers; workspace-scoped active-stream toggle blocking; migration of existing conversations, including archived conversations, to dedicated worktrees; bulk-toggle session reset side effects including backend `onSessionReset` cleanup; deferred cleanup holds the original Git branch/session/mode for both enable/disable and individual reset, blocks sends/goal starts/resume with temporary `503` plus `Retry-After: 1` and repeat resets/mode changes with busy `409`, and releases reservations on cleanup, runtime-preparation, and request-validation failures without mutating checkouts; new-conversation worktree creation after enablement; stream sends, OCR, goals, memory capture, delivered workspace-file previews, and conversation Git status/diff running from the conversation execution directory; session reset fetching latest `origin/main` and moving to a fresh session branch; dirty reset/delete blockers; nested workspace subdirectory mapping into worktrees; disablement dirty-blocker aggregation; and clean disablement removing worktrees while returning conversations to shared-folder execution. |
| `test/config.test.ts` | Config data-root coverage: default `AGENT_COCKPIT_DATA_DIR` stays at `<cwd>/data`, `AUTH_DATA_DIR` derives from `<data-root>/auth`, and explicit `AUTH_DATA_DIR` overrides only auth storage. |
| `test/installStateService.test.ts` | Install manifest coverage: missing manifest infers dev/main, corrupt manifests fall back with `stateSource: "corrupt"`, legacy manifests normalize to schema version 1, writes persist normalized `install.json` including Node runtime and startup metadata, preserves POSIX startup kinds, and `markWelcomeCompleted()` stamps `welcomeCompletedAt`. |
| `test/libreOfficeDetection.test.ts` | LibreOffice detection coverage: standard macOS `LibreOffice.app` installs under `/Applications` are detected even when `soffice` is not on PATH. |
| `test/installDoctorService.test.ts` | Install doctor coverage: required checks report Node/npm/local PM2/data-dir/web-build status, optional checks cover app-dir/mobile-build/platform user-session startup/Claude/Codex/Kiro/Pandoc/LibreOffice/update-channel, injected command and optional-tool detectors avoid shelling to real CLIs, external tunnel checks are omitted, required failures produce `overallStatus: "error"`, optional missing tools produce warnings with Claude/Codex/Kiro install commands plus Pandoc/LibreOffice non-Homebrew fallback URLs, refresh Pandoc/LibreOffice detectors on each doctor status request so newly installed optional tools are detected without restart, macOS LaunchAgent and Linux systemd user startup checks report repair remediation or intentional manual opt-out, detected LibreOffice installs outside PATH expose a `libreoffice:add-to-path` action that updates the live process PATH plus `.env`/`ecosystem.config.js`, Windows npm probes use `npm.cmd` when no installer runtime is recorded, Windows Claude/Codex npm install actions target `<installDir>\cli-tools` with `--prefix`, Windows PM2 probes use `node.exe node_modules/pm2/bin/pm2 --version` from the active app instead of `npx`, installer-recorded Windows runtime `binDir` paths use `node.exe` plus npm CLI JavaScript entrypoints for npm checks and npm-backed actions, Windows Claude/Codex detection prefers npm-installed package entrypoints under `<installDir>\cli-tools` (`claude.exe` directly, `codex.js` through `node.exe`), falls back to `claude.cmd`/`codex.cmd` shims in installer/user prefixes, and recognizes self-installed `claude.exe`/`claude.cmd` plus `codex.exe`/`codex.cmd` commands from the user's PATH, refreshed doctor results detect Claude/Codex after welcome-screen private-runtime npm installs, prepend `<installDir>\cli-tools` to the live server PATH, persist it to the current user's Windows `Path` through a PowerShell script with the path embedded rather than passed through `$args`, continue wrapper repair and refreshed detection when that PATH persistence step fails after npm succeeds, and repair Agent Cockpit-managed `codex.ps1`/`codex.cmd` wrappers so terminal Codex calls the private `node.exe` explicitly, Windows remediation avoids Homebrew/POSIX installer commands and reports missing ONLOGON scheduled tasks, Homebrew command actions are exposed only when brew is detected, allowlisted install actions execute through the injected runner and refresh optional detection, link actions are rejected by the server runner, active conversations block installs, and corrupt install manifests surface as update-channel warnings. |
| `test/windowsUserPath.test.ts` | Windows user PATH helper coverage: generated PowerShell embeds the target path safely, normalizes path entries with a regex instead of multi-character `TrimEnd` arguments, prepends the path to the live process environment before invoking PowerShell, and avoids the Windows PowerShell `TrimEnd('\\', '/')` conversion failure. |
| `test/macosInstallerScript.test.ts` | macOS installer static coverage: `scripts/install-macos.sh` exposes help including `--no-auto-start`, guards Darwin plus `arm64`/`x86_64`, accepts existing Node.js 22+/npm, installs a private verified Node.js 22 runtime from Node.org when Node/npm are missing unless `--no-install-node` is set, persists the private runtime plus common user CLI bin directories (`~/.local/bin`, npm/bun/yarn user bins, `/opt/homebrew/bin`) into generated config, records Node runtime and LaunchAgent startup metadata in `install.json`, downloads production GitHub Release assets (`release-manifest.json`, `SHA256SUMS`, app tarball), verifies SHA256 with `shasum`, extracts the tarball, supports dev installs from `main`, writes `.env`/`ecosystem.config.js`/`install.json`, writes install-root start/stop helper scripts, registers a current-user LaunchAgent unless auto-start is disabled, repairs stale `<dataRoot>/restart.sh` permissions before PM2 startup, runs npm dependency installs with audit/fund/update-notifier prompts and non-actionable warning chatter disabled, uses local `./node_modules/.bin/tsx`, starts with local `npx pm2 startOrRestart`, saves PM2 state, waits for `/auth/setup` to answer before opening the browser, and prints a private-runtime-aware PM2 logs command when readiness fails. |
| `test/linuxInstallerScript.test.ts` | Linux installer static coverage: `scripts/install-linux.sh` exposes help including `--no-auto-start`, guards Linux x64, rejects musl/Alpine, accepts existing Node.js 22+/npm, installs a private verified Node.js 22 Linux x64 `tar.xz` runtime from Node.org when Node/npm are missing unless `--no-install-node` is set, persists the private runtime plus common user CLI bin directories (`~/.local/bin`, npm/bun/yarn user bins) into generated config, records Node runtime and systemd user startup metadata in `install.json`, downloads production GitHub Release assets (`release-manifest.json`, `SHA256SUMS`, Linux app tarball), verifies SHA256 with `sha256sum`, extracts app tarballs with `tar -xzf`, extracts private Node with `tar -xJf`, supports dev installs from `main`, writes `.env`/`ecosystem.config.js`/`install.json`, writes install-root start/stop helper scripts, writes/enables a systemd user unit unless auto-start is disabled, repairs stale `<dataRoot>/restart.sh` permissions before PM2 startup, runs npm dependency installs with audit/fund/update-notifier prompts and non-actionable warning chatter disabled, uses local `./node_modules/.bin/tsx`, starts with local `npx pm2 startOrRestart`, saves PM2 state, waits for `/auth/setup`, uses `xdg-open` when available, and prints the setup URL when no opener is available. |
| `test/windowsInstallerScript.test.ts` | Windows installer static coverage: `scripts/install-windows.ps1` exposes production/dev options, uses strict PowerShell settings, guards Windows x64, uses `Invoke-WebRequest`, `Get-FileHash`, and a non-interactive `System.IO.Compression.ZipFile` extraction helper instead of `Expand-Archive`, installs private verified Node.js Windows ZIP runtimes from Node.org when Node/npm are missing or `-InstallNode` is set, reuses an existing verified private runtime during repair/reinstall only after npm JavaScript entrypoints are present and native command exit codes are checked, installs a sibling replacement runtime when the target runtime directory is not reusable, fails instead when `-NoInstallNode` is set and Node/npm are unsuitable, downloads production GitHub Release assets (`release-manifest.json`, `SHA256SUMS`, app ZIP), verifies SHA256, supports dev installs from `main`, preserves existing `.env` secrets plus `installedAt`/`welcomeCompletedAt` on repair/reinstall, deletes the existing PM2 app on a best-effort basis before replacing active app files only when app-local `pm2.cmd` is already installed, writes `.env`/`ecosystem.config.js`/`install.json`, writes `PATH` with `<installDir>\cli-tools`, private runtime, `%APPDATA%\npm`, and inherited PATH entries, persists `<installDir>\cli-tools` to the current user's Windows `Path` and broadcasts an environment change, repairs existing Agent Cockpit-managed Claude/Codex/Grok Build terminal wrappers under `<installDir>\cli-tools` during installer repair/reinstall so stale npm shims are replaced, writes `bin/run-agent-cockpit.vbs` so PM2 starts `node --import tsx server.ts` hidden through `wscript.exe` rather than a visible `node.exe` console, writes install-local `PM2_HOME`, generates start/stop/log helper scripts with checked app-local PM2 native-command execution, emits PM2 and runner-log diagnostics when readiness times out, registers a current-user ONLOGON scheduled task with an interactive limited principal and a current-user limited `schtasks.exe` fallback, starts with local `<appDir>\node_modules\.bin\pm2.cmd startOrRestart`, waits for `/auth/setup` through a raw `.NET` HTTP readiness probe instead of `Invoke-WebRequest` page parsing, and opens the browser with `Start-Process`. |
| `test/releasePackage.test.ts` | Production release packaging coverage: `scripts/package-release.js` normalizes semver inputs, excludes mutable/local-only paths (`data/`, `.env`, nested `node_modules/`, and generated build staging directories), requires and packages prebuilt `public/v2-built/` and `public/mobile-built/` assets, writes `release-manifest.json` with production channel metadata, required Node runtime metadata, macOS and Linux app tarball entries, Windows app ZIP, `install-macos.sh`, `install-linux.sh`, and `install-windows.ps1` SHA256s, writes `SHA256SUMS`, emits all platform installer scripts as external release assets, and produces tarball/ZIP archives that include source/build files while excluding local state and plans. |
| `test/releaseWorkflow.test.ts` | Release workflow static coverage: `.github/workflows/release.yml` defines `windows-smoke` and `linux-smoke` jobs, makes the publish job depend on both, parses `install-windows.ps1` and `install-linux.sh`, runs platform smoke package steps that verify macOS/Linux/Windows app and installer manifest entries, builds web/mobile assets before platform smoke packaging and rebuilds/rechecks production assets after full tests before the publish package step, runs the Windows installer in dev mode with a private-runtime-capable path, an install path containing spaces, ONLOGON scheduled-task query, `/auth/setup` probing, and Install Doctor `node`/`npm`/`pm2` readiness checks, and runs the Linux installer in dev mode with a temporary install root, systemd user unit file verification and cleanup, `/auth/setup` probing, and Install Doctor readiness checks. |
| `test/releaseNotes.test.ts` | Production release notes renderer coverage: `scripts/render-release-notes.js` extracts second-level Markdown sections from `docs/releases/v<version>.md`, requires non-empty `## Shipped For Users` and `## Developer Details` sections, rejects TODO/TBD placeholders, requires at least one user-facing shipped bullet, and renders a GitHub Release body containing the shipped-user list plus a link to the full source-controlled developer detail document at the release tag. |
| `test/security.test.ts` | Helmet security-header coverage: `applySecurity()` keeps the local HTTP CSP usable by omitting `upgrade-insecure-requests` while preserving `form-action 'self'`. |
| `test/planUsageStores.test.ts` | V2 account plan-usage frontend stores: Claude Code-family and Codex plan usage cache/fetch/subscribers are keyed by `cliProfileId` so two profiles for the same harness do not share stale account limit snapshots in the topbar tooltip. |
| `test/usageProjection.test.ts` | V2 account quota projection helper: projects end-of-cycle usage from actual percent, reset time, fetched observation time, and cycle duration; separates on-track/watch/over status thresholds; suppresses noisy first-5%-of-cycle projections; marks stale snapshots without math; rejects observations outside the current cycle; and derives Claude Code bucket durations for 5-hour, weekly, and generic daily keys. |
| `test/webBuildService.test.ts` | V2 web build preflight service: missing build triggers `npm run web:build` via the injected runner and writes `.agent-cockpit-build.json`; fresh marker skips; source and `package-lock.json` hash changes rebuild; build failure without previous assets rejects startup; build failure with previous assets preserves the previous build and reports stale status; skip mode bypasses startup preflight while force builds still run for self-update; concurrent calls coalesce into one build; Windows default commands use `npm.cmd`; default runner builds into staging and swaps only after success. |
| `test/webBundleBudget.test.ts` | V2 bundle-budget helper: normalizes Vite hashed asset filenames, rejects empty generated asset directories, sums JS/CSS totals, applies named chunk budgets, and reports named plus total violations for `npm run web:budget`. |
| `test/mobileBuildService.test.ts` | Mobile PWA build preflight wrapper: missing mobile assets trigger build and write `public/mobile-built/.agent-cockpit-build.json`; mobile source/package-lock changes rebuild; skip mode bypasses mobile startup preflight while reporting stale state, force builds still run for self-update, static guard verifies the default command uses the shared npm command helper, targets `mobile/AgentCockpitPWA`, the ignored `public/mobile-built/` output path, and the mobile staging prefix. |
| `test/backends.test.ts` | BaseBackendAdapter (including generateTitle, getMemoryDir + extractMemory default null), BackendRegistry (including shutdownAll), ClaudeCodeAdapter (metadata one-shot image transport plus models including Opus 5.5/Opus 5 `[1m]`, Fable 5.1/Fable 5, and Sonnet 5.5/Sonnet 5; `supportedEffortLevels` per model; Sonnet 5.5 default selection; image input capability; structured goal capability with set/clear/status but no pause/resume; Bedrock profile metadata projection from inference-profile rows including known-base inheritance and unknown-base text-only fallback; --model flag passthrough including Bedrock inference profile IDs; --effort flag passthrough with silent drop when the selected model does not support the requested level; `max` and `xhigh` support for Claude 5 models and Bedrock base models; Claude Code Ultracode `--settings` passthrough for xhigh-capable models and Bedrock base models and omission for unsupported models; Haiku effort drop; --mcp-config passthrough from `mcpServers` option and omission when absent; `runOneShot` --mcp-config passthrough when mcpServers are provided and omission when absent; Windows runtime resolution that prefers the installer-managed `@anthropic-ai/claude-code\bin\claude.exe`, prefers a PATH npm package entrypoint over the PATH `claude.cmd` shim, and also recognizes self-installed `claude.exe` from the user's PATH; missing `--resume` targets create a recovery snapshot, emit the friendly recovery event, and retry once as a new session with a mandatory snapshot-read prompt; extractMemory with frontmatter parsing and `~/.claude/projects` path resolution; git worktree canonicalization to main repo memory; getMemoryDir/project path resolution including empty/missing/sanitized/worktree-canonical cases; and Claude goal parsing from transcript `goal_status` attachments including active, complete, and cleared states), parseFrontmatter helper, resolveCanonicalWorkspacePath helper, mcpServersToClaudeConfigJson (ACP env-array to Claude Code env-object shape transform, omitted env key, multiple servers, missing args coercion). **ClaudeCodeAdapter runOneShot:** stdout success returns trimmed output, empty stdout returns empty string, stderr logged as errors, non-zero exit code throws, killed/signal throws with timeout message, stderr filtering (strips `Update available` lines), `--model` flag passthrough, `--effort` flag passthrough with silent drop for unsupported combinations, timeout passthrough, `--permission-mode` flag, workingDir as cwd, `--print -p` flags always present, maxBuffer 4 MB |
| `test/kiroBackend.test.ts` | KiroAdapter metadata (including dynamic models, deprecated/internal filtering, model family detection, one-shot explicit image transport, image-capable `auto`/Claude models, and explicit `image:false` for text-only open-weight models), lifecycle (shutdown, onSessionReset), streaming send lifecycle (backend runtime event and process id emission; `session/prompt` JSON-RPC rejections surface as backend stream errors instead of ending with an empty assistant turn; abort kills the active ACP process, the next message respawns ACP, reloads the persisted Kiro session with `session/load`, and streams text; missing `session/load` targets create a recovery snapshot, emit the friendly recovery event, create a new ACP session, and send a mandatory snapshot-read prompt), extractKiroToolDetails tool name normalization, generateSummary/generateTitle fallbacks. **One-shot ACP path (`_acpOneShot`, exercised through `runOneShot`)** via a mocked `kiro-cli acp` simulator that drives the JSON-RPC exchange: returns only the post-tool agent text (filters out pre-tool reasoning by clearing the buffer on each `tool_call`), returns concatenated `agent_message_chunk` text when no tools are called, forwards `mcpServers` into the `session/new` request, issues `session/set_model` when `model` option is set, auto-approves `session/request_permission` notifications with `allow_always`, rejects with a friendly install-instruction error on spawn ENOENT, rejects on `timeoutMs`. **Image content-block auto-attach** (`collectImageContentBlocks` helper + `runOneShot` integration via the simulator) — helper returns empty when `workingDir` is undefined / missing / has no basename match in the prompt; attaches matching image as a base64-encoded `{type:"image"}` block; maps `.png/.jpg/.jpeg/.gif/.webp` (case-insensitive) to correct MIME types; ignores unsupported extensions (`.pdf`, `.txt`); caps attachments at 5. **Token-boundary matching:** does not attach a basename that is only a prefix (`foo.png` mentioned alongside `foo.png.ai.png` only attaches the `.ai.png` sibling — regression test for the KB downscale path) or only a suffix (`page.png` mentioned alongside `cover-page.png` only attaches the suffix-named one) of the referenced filename. **Bedrock-safe re-encode on attach:** two integration tests seed real images via `napiCanvas.createCanvas(...).toBuffer(...)` and assert the attachment is re-encoded to JPEG: (a) a small RGBA PNG (IHDR color-type byte verified `=== 6`) with no resize triggers the alpha-flatten path and the resulting content block has `mimeType: 'image/jpeg'` with the decoded base64 starting with the JPEG SOI marker (`0xff 0xd8`); (b) a 2000×1000 no-alpha JPEG triggers the dimension-only re-encode path, decoded back through `napiCanvas.loadImage` to assert `Math.max(width, height) === KIRO_MAX_LONG_EDGE_PX`. **`pngHasAlpha` helper:** returns true for color type 6 (real RGBA PNG via canvas) and 4 (synthesized buffer with byte 25 = 4); returns false for color type 2 (RGB), non-PNG signatures (JPEG header), and short buffers (`< 26` bytes). **`reencodeForKiro` helper:** produces a JPEG buffer for a small RGBA PNG (alpha-flatten path, dimensions preserved at 4×4); downscales a 2000×1000 input to 1568×784 (aspect ratio preserved, long edge `=== KIRO_MAX_LONG_EDGE_PX`); returns `null` for an in-range non-alpha image so the caller keeps the original bytes; returns `null` for an undecodable buffer. **JSON-RPC error diagnostics:** when the simulator emits an error response with `{code, message, data}`, the rejected `runOneShot` promise's error message contains `[code=<n>]` and a stringified `data: ...` suffix so upstream-model rejection reasons (e.g. "Prompt is too long") survive the bare `error.message`. Three integration tests assert that `session/prompt`'s `prompt` array carries the appended image block when `workingDir` contains a referenced image, carries the appended image block from explicit `RunOneShotOptions.attachments` even when the prompt omits the basename, and carries only the text block otherwise. Tests use real temp directories (`fs.mkdtempSync`) rather than mocking `fs`. |
| `test/codexBackend.test.ts` | CodexAdapter metadata (id/label/icon/capabilities — `thinking: true, planMode: false, agents: true, toolActivity: true, userQuestions: true, stdinInput: true, one-shot image transport, goals: { set: true, clear: true, pause: true, resume: true, status: 'native' }`; fallback `models` list populated immediately with the current Codex CLI lineup, including GPT-6 Astra as the static default fallback, Codex effort levels including `max` / `ultra`, text+image input capability for multimodal models, and text-only capability for Spark while background `model/list` refresh is gated behind `JEST_WORKER_ID` so no real codex processes spawn during tests; `normalizeCodexModelOption` (`codexModels.ts`, facade-re-exported) maps app-server `supportedReasoningEfforts[].reasoningEffort` and debug-style `supported_reasoning_levels[].effort` into `supportedEffortLevels`, including `none` / `minimal` / `ultra`, while retaining text+image capability metadata; `buildCodexTurnStartParams` forwards supported `effort` and omits unsupported effort; `buildCodexServiceTierArgs` emits the Codex Fast `service_tier` / `features.fast_mode` config overrides only for `fast`; default working dir under `.codex`; custom workingDir override; extends BaseBackendAdapter; can be registered in BackendRegistry alongside ClaudeCodeAdapter and KiroAdapter; sendMessage returns `{stream, abort, sendInput}` with sendInput as a no-op no-throw; `buildCodexThreadSecurityParams` defaults to full access (`approvalPolicy: 'never'` / `sandbox: 'danger-full-access'`) and preserves restricted `on-request` / `workspace-write` overrides). Lifecycle (`shutdown` and `onSessionReset` no-throw with no live processes; registry `shutdownAll` invokes adapter shutdown). **`extractCodexToolDetails` (`codexEvents.ts`, facade-re-exported)** (item-type-based dispatch — `commandExecution` → Bash with command preview and truncation past 60 chars, generic label without command; `fileChange` → Edit with first changed path, generic label without changes; `mcpToolCall` preserves underlying tool name with `server.tool` description; `dynamicToolCall` preserves `namespace.tool`; `webSearch` → WebSearch with query preview; `imageView` → Read with path; `imageGeneration` → ImageGen plus artifact extraction helpers that emit an `artifact` event from base64 image data and find profile-scoped `generated_images/**/{itemId}.png` fallbacks; `collabAgentToolCall(spawnAgent)` → Agent with `Spawning subagent: <prompt preview>`, `isAgent: true`, `subagentType: 'spawnAgent'`, prompt truncation past 80 chars; `collabAgentToolCall(sendInput)` → Agent with `Subagent input: <preview>`; `collabAgentToolCall(closeAgent)` → Agent with `Closing subagent`; `collabAgentToolCall` without `tool` falls back to generic subagent label; unknown item types like `agentMessage` return null). **Turn ownership and subagent helpers (`codexEvents.ts`, facade-re-exported)** (`extractCodexThreadId` and `extractCodexTurnId` defensively read envelope ownership; `eventBelongsToActiveParentTurn` requires matching parent thread and turn; `recordSpawnAgentReceivers` populates the `Map<childThreadId, topLevelCallId>` from a current completed `spawnAgent` item with `receiverThreadIds[]`, no-ops on non-collab items, no-ops on non-`spawnAgent` collab tools (`sendInput`/`resumeAgent`/`wait`/`closeAgent`), no-ops when `receiverThreadIds` is missing or empty, flattens grand-children to the original top-level call id when the sender is already in the map, falls back to the call id when `senderThreadId` is missing; `lookupParentAgentId` returns the mapped value for known children, undefined for parent or missing threadIds; `eventIsFromChildThread` returns true for known children and false otherwise — including empty maps; `isParentTurnCompleted` returns true only when the parent thread matches and, when an active turn id is supplied, the completion turn matches). **Turn-owned stream regressions** verify the shared `codexStreamDispatch.ts` path keeps stale previous-turn text ignored, stale previous-turn `turn/completed` from closing the current stream, stale token usage ignored, stale command approvals canceled instead of auto-approved, stale permissions and `item/tool/requestUserInput` requests rejected without mutating pending user input, current-turn text/usage/tool activity/completion flowing normally, goal streams starting an owned `turn/start` after `thread/goal/set`, stale prior goal output ignored before that owned turn, terminal goal status ending the stream without a matching `turn/completed`, `thread/goal/get` polling detecting terminal native goal state when Codex omits stream notifications, a follow-up report turn running when terminal status arrived before any assistant text, and current child-thread tool attribution still working while stale child events are dropped. **generateSummary / generateTitle fallbacks** (empty messages, empty userMessage). **`resolveCodexCliRuntime`** maps Codex profile `command`, merged `env`, and `configDir → CODEX_HOME`, gives `configDir` precedence over `env.CODEX_HOME`, rejects non-Codex profiles, on Windows prefers the installer-managed `@openai/codex\bin\codex.js` script through `node.exe`, prefers a PATH npm package entrypoint over the PATH `codex.cmd` shim, and recognizes self-installed `codex.cmd` from the user's PATH. **`runOneShot` (`codexExec.ts` codex exec via execFile mock)** — prefers the `--output-last-message` temp file over noisy transcript stdout and falls back to trimmed stdout, ENOENT mapped to "Codex CLI is not installed" friendly error, rejects timeout even when the child exits cleanly after `SIGTERM`, uses `--dangerously-bypass-approvals-and-sandbox` by default, uses explicit `--ask-for-approval` and `--sandbox` flags when the adapter is configured with restricted access, `model` option forwarded as `-m` flag to `codex exec`, supported `effort` option forwarded as `-c model_reasoning_effort="<level>"`, `serviceTier: 'fast'` forwarded as `-c service_tier="fast"` and `-c features.fast_mode=true`, `mcpServers` option injected via repeated `-c` flags (`mcp_servers.<name>.command="…"`, `mcp_servers.<name>.args=[…]`, `mcp_servers.<name>.env={ KEY = "…" }`) so the selected config dir is never written directly, no `-c` flags emitted when `mcpServers` is absent, and profile command/env/CODEX_HOME are passed to `execFile`. **Thread goals:** `setGoalObjective` spawns `codex app-server --enable goals`, includes Fast config overrides when requested, initializes with `capabilities.experimentalApi: true`, creates or resumes the thread, sends `thread/goal/set({ status: 'active', objective })`, starts a goal-owned `turn/start` with a chat-result instruction plus the objective, normalizes returned goals with `backend: 'codex'` and native supported actions, and streams backend-neutral `goal_updated` frames alongside owned text and runtime frames. **`deriveCodexUsage` (`codexUsage.ts`, facade-re-exported)** (maps Codex's `thread/tokenUsage/updated` notification to a cockpit `Usage` event using only the `last` per-turn counters): `inputTokens = max(0, last.inputTokens − last.cachedInputTokens)` so cumulative session input doesn't double-count cached prior context (verified across three simulated turns); `outputTokens` and `cacheReadTokens` mirror `last.outputTokens` and `last.cachedInputTokens`; `contextUsagePercentage` is `round(last.totalTokens / modelContextWindow × 100)` — a snapshot of *this turn's* window utilization that stays in 0–100 even on long sessions where the cumulative would exceed 1000% (regression test for the 1063% bug); `contextUsagePercentage` is `undefined` when `modelContextWindow` is `null` or `0`; defensively clamps `inputTokens` to `0` if `cachedInputTokens > inputTokens`. |
| `test/codexBackend.test.ts` session recovery coverage | A failed `thread/resume` with Codex's missing-rollout/session error writes a recovery snapshot through `SendMessageOptions.sessionRecovery`, emits the friendly `session_recovery` event before the new `external_session`, starts a fresh Codex thread, and sends the current prompt with mandatory snapshot-read instructions that include the snapshot path. |
| `test/codexBackend.test.ts` profile metadata coverage | `getMetadata({ cliProfile })` runs Codex `model/list` under the selected profile runtime, normalizes the returned model catalog, caches it by profile runtime key, and keeps server-configured metadata separate from account-profile metadata. |
| `test/codexBackend.test.ts` normal-stream goal forwarding | A normal Codex `sendMessage()` stream forwards current-thread native `thread/goal/updated` and `thread/goal/cleared` notifications as backend-neutral `goal_updated` / `goal_cleared` events, ignores goal notifications for other threads, keeps assistant text flowing from the active chat turn, and does not treat the goal notification's `turnId` as the active runtime turn. |
| `test/frontendProfileMetadataCache.test.ts` | Executable browser API tests verify profile isolation, coalescing, expiry, retry after failure, explicit account-test invalidation without settings changes, terminal Copilot auth polling/cancel invalidation (success, failure and cancellation), preservation during running/other-harness jobs, and rejection of stale in-flight cache writes across auth completion. |
| `test/copilotLiveUsage.test.ts` | Live/final checkpoint reconciliation, coalesced reads, failed/missing baselines, fractional and partial AI credits, unknown zero, replaceable context snapshots and separate harness billing units. |
| `test/copilotQuota.test.ts` | Native quota whitelist, real zero/unlimited/missing data, unknown token-billing units, profile/auth-key isolation, copies/coalescing, stale last-good reads, custom-provider gating, timeout/shutdown, missing CLI, older auth metadata, failed-cleanup barriers, cache bounds and late startup cleanup. |
| `test/copilotUsageRoutes.test.ts` | Production HTTP/WebSocket SDK context and billing persistence, context-only ledger exclusion, live/final charging once, profile-scoped quota route and harness/invalid-profile validation. Native quota exceptions return 503, permit a later retry and preserve saved profile configuration. |
| `test/copilotUsageUi.test.ts` | Desktop/mobile billing units, partial/unavailable values and no guessed USD, stale/unknown quota, escaped labels, late profile responses and failure clearing. |
| `test/copilotGoals.test.ts` | Native projection/credit validation, SDK command effects and literal objectives, executable-peer cold controls/resume, active pause, missing-history refusal, failed work, idle/control replacement, normal-close status race and late reset/shutdown cleanup. |
| `test/copilotGoalRoutes.test.ts` | Actual Copilot facade through HTTP/WebSocket goal set/status/pause/resume, explicit decimal credit validation before admission, no fabricated Clear, profile-scoped capability gating and persisted achievement cards. Invalid controls/empty objectives launch no native work; rejected profile changes release durable admission without changing a locked session. Deleted profiles can be repaired while retaining history and forwarding selected model/effort. A replacement goal with missing native history creates one recovery snapshot and submits once with its path. |
| `test/goalEventPersistence.test.ts` | Shared atomic poll/stream card check-and-append, single writer/emitter, native session/objective identity, write failure retry and no deleted-conversation recreation. |
| `test/copilotCatalog.test.ts` | Pure account-model projection, exact SDK effort intersections, policy/duplicate filtering, conservative media, effective selection validation, cache TTL/bounds/copies/profile/env/executable/auth scope, failure provenance/redaction, timeout/late-start/shutdown cleanup and failed-cleanup admission barriers. |
| `test/copilotCatalog.integration.test.ts` | Official SDK plus strict executable RPC peer: new account IDs/max effort reach native session config and restricted JSONL argv; cached discovery reuse/refresh; invalid IDs/efforts rejected before session/prompt creation; direct media gates; Stop/update drains during discovery. |
| `test/chat.copilotCatalog.test.ts` | HTTP 400 for unavailable IDs/efforts before user-message/tool creation, saved selection preservation, exact effort persistence for newly discovered models, explicit effort clears and automatic-selection effort rejection. Metadata failures return an error without replacing saved profiles; a later refresh can recover. |
| `test/copilotMedia.test.ts`, `test/copilotArtifacts.test.ts`, `test/chat.copilotArtifacts.test.ts` | Exact upload parsing and effective model/provider gates; conservative SDK PDF versus legacy CLI transport; canonical native bytes and overlapping-view deduplication; scoped delegated/root output, duplicate/late completion rejection; real SDK peer through production chat storage, cancellation and reload. Companion conversation/facade tests cover send attachments, recovery, JSONL flags, and configured-model one-shots. Mobile event tests cover live descriptor dedupe and saved/replay replacement. |
| `test/copilotBackend.test.ts` | Metadata and current curated model catalog with default `auto`, no effort for auto/Haiku, image/PDF transport, resume capabilities, runtime command/env and Windows npm-loader resolution. Argument construction explicitly enables streaming, disables implicit updates, restricts no-tool calls with `--available-tools none`, and passes model/effort/media/MCP/resume flags. JSONL translation covers text/thinking/tools/outcomes, retained tool names when native completions omit them, Memory MCP names, and structured failures. Final-message reconstruction prefers complete text without duplication. Lifecycle regressions cover pre-start/in-flight cancellation, iterator cleanup, timeout/abort with clean child exit, structured failures on zero/nonzero process exits, split UTF-8 decoding, one missing-session recovery retry with a snapshot, and saved-checkpoint usage subtraction after adapter restarts. |
| `test/copilotAdapterRuntime.test.ts` | Facade dispatch uses owned SDK for the normal CLI/visible providers and JSONL for opaque custom commands; restricted one-shots remain JSONL. Tests prevent fallback/replay after SDK errors, reject overlap across transports, await Stop before switching profile/transport, drain reset and reusable shutdown, release unstarted iterator admission, and block both paths after permanent shutdown. |
| `test/copilotSdkRuntime.test.ts` | Official SDK connects to a real fixture JSON-RPC server owned by the existing process scope: split port announcement, invocation/cwd/UTF-8 env preservation, token handshake, idempotent cleanup, pre-start/live abort, port and handshake deadlines, invalid port, protocol mismatch, launcher exit and missing executable. Unexpected process exit and requested abort force-close the SDK connection before process cleanup rather than writing graceful detach requests to an ended socket; a live SDK spy verifies no graceful teardown is attempted. |
| `test/copilotInputs.test.ts` | Native question FIFO and UUID ownership, choices/freeform, duplicate/stale answers, exact native steering consumption before/after admission, transaction-scoped queue probing/pause/release, pending-item detection of promotion before idle, paused exact withdrawal and unsafe-withdrawal/inspection failure, no replay, unsupported queue controls, and cancellation/late readiness. |
| `test/chat.inputs.test.ts` | Production message-route handler attachment and input frame forwarding; awaited correlated HTTP acknowledgement after reload, stale/finalizing owner refusal, 400/409/503 propagation, no legacy stdin/message fallback or new transcript message. |
| `test/copilotSdkRuntime.e2e.test.ts` | Twenty opt-in real-CLI cases through `npm run e2e:copilot-sdk`: protocol/auth status, same-ID session resume and context API, legacy JSONL-to-SDK resume retaining prior history, structured question callback, in-flight steering with exactly one native correction event, native child IDs with separate root output, cold conversation resume through the Cockpit owner retaining actual native history, and native tool-worker cancellation followed by immediate same-ID resume without replay; production facade cold-resume with measured disjoint token usage and delegated aggregate accounting exactly once; opaque-wrapper private provider compatibility (POSIX). Five additional cases cover production repeated question IDs/duplicate rejection/freeform, consumed steering, boundary-promoted steering withdrawal without a second execution or cold-resume replay, and Stop with a pending question or steering followed by cold resume. The boundary case deliberately asserts one initial model call because it produces a final response without background tool work. Steering may background shell work and generate further model calls before idle; do not assert a fixed model-request count. Six delegated-work cases additionally verify parallel/nested/background scoped tools and bounded summaries, a queued correction while background work is held, native child failure without parent failure, child-inclusive disjoint usage once, Stop reaping a delegated worker, and cold resume without replay. A failed HTTP model request is not counted as a successful measured usage response. Uses fixed local replies and isolated auth/keychain settings; direct SDK probes disable native memory, while conversation-owner cases retain native defaults in their disposable home. `scripts/run-copilot-sdk-compat.ts` writes temporary CLI/SDK/OS/Node/revision/dirty evidence and per-case records. `COPILOT_SDK_CLI_PATH` selects an executable. This is connection/session evidence, not browser or hosted-account certification. |
| `test/copilotConversations.test.ts` | Official SDK against an executable JSON-RPC peer inside real process containment: session/config/MCP forwarding; native ID resume and native metrics baseline subtraction; query ordering before submission/after idle; historical startup checkpoints excluded from current-turn usage; unavailable, failed and timed-out metrics; terminal baseline-query errors preventing late submission; root idle after background work; acknowledgement ordering and a delayed initial turn-start proving queue pause cannot block initial execution; pre-start abort and iterator return/throw; immediate Stop-to-send; concurrent conversation isolation and overlap rejection; targeted reset; late factory success after reset/shutdown; iterator-boundary cancellation; closure; all-settled cleanup failures blocking replacement; request timeouts; launcher/orphan exit and socket disposal before send acknowledgement, with transport classification, one submission and descendant cleanup; missing-session recovery with fresh accounting; no replay after child work, submission or authorization failure; permanent shutdown. |
| `test/copilotAgents.test.ts` | Pure delegated reducer: immutable maps, tuple/turn/owner IDs, sibling collisions, native and unambiguous legacy ancestry, nested flattening, unknown-child suppression (including mismatched lifecycle IDs), bounded final-only summaries, background acknowledgement versus lifecycle completion, failed/cancelled children, failed spawn, late events and terminal work settlement once. |
| `test/agentTools.test.ts` | Executable desktop/mobile React rendering: cross-message/nested children render once, outcomes are visible, final summaries are escaped text; pure mobile live reducer deduplicates replay, preserves earlier arrays and applies duration/summary/outcomes without affecting questions. `test/streamStore.test.ts` also verifies immutable delegated summary/outcome updates and late initial HTTP history preserving replayed running/final rows; direct pure-merge tests retain newer matching IDs in saved positions without duplicates. `test/chat.streaming.test.ts` verifies both persisted tool projections across success, abort and error, retaining completed summaries and warning outcomes for unfinished children. |
| `test/copilotSdkEvents.test.ts` | Pure event projection with prior-state immutability, text/reasoning delta/final fallback and deduplication, remembered tool names, root/child and deprecated parent-tool identity separation, loop-end/idle boundaries, native abort/errors, late-frame suppression, and accounting checkpoint events left to the native metrics owner. |
| `test/copilotSessionConfig.test.ts` | SDK model/effort/directory/streaming configuration, automatic model environment fallback, managed instruction discovery/coauthor policy, permission policy, excluded questions, explicit custom-provider environment mapping, unchanged MCP argv/env/all-tools selection, and first-versus-resumed prompt composition. Existing backend tests import shared model/tool/config helpers directly while retaining the facade compatibility exports. |
| `test/copilotProfileStatus.test.ts` | Native auth/catalog projection through a mocked owned runtime: unauthenticated checks skip model discovery, disabled models are excluded, denied/empty catalogs preserve authenticated credentials, native HTTP diagnostics omit headers, plain failures survive, and every outcome awaits cleanup. |
| `test/copilotDeviceAuth.test.ts` | Nineteen direct cases cover shared-home defaults, rejection of unproved account/env isolation, native command/output, UTF-8 and split-token redaction, oversized-line suppression, fresh verification after cleanup, missing/expired/denied access, failed/missing executable, shared cross-profile admission, Cancel-to-replacement drain, timeout/late-exit, shutdown during login/verification, cleanup barriers and custom-provider refusal. Mocked owned process scopes isolate lifecycle assertions. |
| `test/chat.copilotAuth.test.ts` | Five HTTP/shutdown cases cover shared-profile persistence, successful fresh verification, expired/denied access without inference, native descendant cancellation, immediate retry, owned runtime exit and catalog/quota invalidation callback. A rejected auth-service shutdown must still allow other backends to drain. No real accounts are used. |
| `test/copilotAuth.e2e.test.ts` | Two opt-in native checks through `npm run e2e:copilot-auth`: fresh logged-out status and two real device-code/cancel cycles followed by another logged-out check. Uses a temporary HOME/COPILOT_HOME/GH_CONFIG_DIR, records process IDs and confirms exit, never authorizes the code, and restores the parent environment. No successful OAuth, hosted entitlement, real expiration or two-account evidence. `COPILOT_AUTH_CLI` selects a pinned CLI; the runner writes CLI/SDK/OS/Node/revision/dirty evidence to a temporary report. |

| `test/cliProfileAuthState.test.ts` | Pure Settings label projection, including authenticated credentials with unavailable catalog access and existing checking/login/error/unknown states. |
| `test/copilotUsage.test.ts` | Native reconciled metrics and JSONL checkpoint token/credit parsing; cache-inclusive input normalization; provider/model/agent overlap and repeated-model provider contributions; missing/invalid metrics without invented zeroes or nano-AIU conversions; malformed/negative counters, disjoint per-turn subtraction, reset-counter clamping, repeated baseline reads without an in-memory cache, incomplete trailing JSON, bounded reads of large transcripts, missing native sessions, and unsafe session-ID rejection. |
| `test/copilotProcess.test.ts` | Real npm-shaped wrapper/native child regressions for chat abort, iterator closure, one-shot timeout/signal, reset and shutdown; TERM-resistant and separately detached children; unrelated process survival; PID-reuse rejection; ps-failure containment; bounded Windows taskkill success/failure and idempotent pipe cleanup. An inherited-token regression starts discovery only after the launcher and detached shell leader exit, then verifies orphan termination and unrelated-run survival. Worker PID readiness is published by atomic rename so a concurrent reader cannot consume an empty PID file, and failure cleanup still owns the fixture before readiness completes. Exact-token tests cover a pending ancestry poll, different-run/key-prefix rejection, and environment-snapshot failure with numeric fallback. Native process fixtures are POSIX-only and do not establish Windows certification. |
| `test/streamJobSupervisor.test.ts` | Conversation/workspace reset reservations reject duplicate admission, block preparing sends, contribute to the global CLI-update busy guard, and release cleanly. Failed durable acceptance releases pending admission; abort errors do not block conversation cleanup or shutdown of other runtimes, and shutdown preserves durable interruption markers. |
| `test/backends.test.ts` shutdown ordering | Registry shutdown awaits pending adapter promises even when another adapter throws synchronously; Copilot real-process tests exercise registry shutdown and reset cleanup. Descendant tests include new detached grandchildren discovered from still-live tracked children after launcher exit. |
| Copilot review regressions | Process tests retain orphan jobs in observed child-led groups and original-group children missed between scans. Adapter tests reject starts during drains/permanent shutdown, reject cancelled one-shot partial text even on clean close, preserve summary fallbacks, and keep read/spawn/recovery failures terminal. Further lifecycle checks cancel a resumed turn during asynchronous baseline loading before spawn, flush an unterminated final JSONL message, report checkpoint usage without a result frame, terminate on stdout read failure, and reject a working directory beneath a regular file. The shared recovery-stream test clears the completed first turn's replay buffer before opening its second-turn socket, so stale `done` cannot finish the recovery assertion early. |
| `test/copilotOwnership.test.ts` | Root/child/grandchild delta/final/reasoning/tool isolation using native JSONL envelope shapes; late child work cannot clear a root structured response; cumulative usage remains independent of presentation filtering. The adapter lifecycle suite also tests suppressed-child no-replay guards, child final-message fallback, and reusable shutdown. |
| `test/adrWorkflow.test.ts` | Source guards verify fork head repository/SHA checkout, disabled credential persistence on forks, index-freshness checks without fork writes, same-repository-only index commits, quoted branch pushes, and no privileged `pull_request_target` execution. |
| `test/copilotWindowsProcess.test.ts` | Normal-CI invocation/quoting, startup-pipe regression and delayed wrapper-close checks after taskkill/direct KILL (including cleanup timeout rejection), plus native Windows Job Object process fixtures: detached grandchildren after launcher normal exit or abort, unrelated-process survival, idempotent stop after close, raw UTF-8 stdout/stderr, quotes/backslashes/newlines/Unicode in argv, cwd/env and nonzero exit preservation, and missing-executable failure. A dedicated `copilot-windows` job runs this suite on `windows-latest` with Node 22; no installed Copilot or account is needed. This validates the Windows containment boundary, not real Copilot Windows compatibility. |
| `test/copilotMemoryContext.test.ts` | Nine normal-CI integration cases use production ChatService/Memory MCP shim+HTTP/CopilotAdapter/WorkspaceContextService with a spawned JSONL fixture: governed save/metadata/search/reload/duplicate handling; workspace isolation, disabled writes and reset-token revocation; bad output/runtime failure without fallback files; tool-enabled Context ingestion of references and accepted Memory only; persisted markdown/run reports/instructions; invalid actions/process failure/cancellation preserving the inbox and allowing retry. |
| `test/copilotContextTriggers.test.ts` | Five normal-CI cases exercise the production scheduler, HTTP enable/disable/reset routes, finalizer queue, and Copilot process fixture: initial enable scan; due maintenance and overlapping tick exclusion; failed maintenance preserving the inbox until the next scheduled retry; disabling active work without late note consumption or scheduled restart; reset finalization over the ended session rather than its replacement; and an overlapping finalizer retrying after maintenance. |
| `test/copilotKbRoutines.test.ts` | Six normal-CI integration cases use real ingestion, converted files, SQLite entry/topic stores, CopilotAdapter with a spawned JSONL fixture, dreaming parsers, and Routine storage. Covers digest/glean transcript carryover and entries, malformed digest and corrected retry, shutdown cancellation without source loss, malformed dreaming leaving synthesis pending followed by valid topic/markdown persistence, disabled Routine passivity, proposal-path containment, authorized output/final/history, disabled notifications, overlap rejection, cancellation and later reuse. These tests require no installed CLI or embedding service. With `COPILOT_WORKFLOWS_E2E=1`, the same six cases use the real CLI and native tools instead of the JSONL executable fixture; the dreaming case additionally verifies SDK chat retrieval through production KB MCP. |
| `test/e2e/copilot.ui.pw.ts` | Forty Chromium cases in an isolated PM2-managed server. Thirty-four real-CLI/local-provider SDK cases exercise desktop/mobile Memory, profile selection, cold resume, Stop/immediate replacement, rejected-send drafts/attachments, reset/archive/restore/delete, repeated/reloaded questions, steering boundaries, nested/background delegated tools and summaries, goal set/pause/resume/completion, measured context and persistent media/artifacts. Four injected catalog/quota cases cover unavailable models, exact effort choices, fallback provenance, stale/unavailable balances and unit labels. Two injected auth-job cases at desktop/narrow widths verify native URL/code display, duplicate-start disabling, Cancel, denied-access failure, success/retry and shared-account messaging. Background delegation checks wait for the persisted summary before reloading, since the live child-completion event precedes the root transcript write. Stop/resume holds the abort request and verifies Send stays unavailable until it completes before submitting the immediate replacement on both clients. Goal commands wait for the profile-specific Goal control to appear after asynchronous capability discovery. Screenshots/traces retain visual evidence. Native login, hosted accounts and Windows/Linux qualification are separate. |
| `test/copilotWorkflows.e2e.test.ts` | Six opt-in POSIX application workflows (`npm run e2e:copilot-workflows`) run real Copilot with fixed local model responses and isolated auth: actual SDK chat Memory note/search (headless dispatch asserted), governance/persistence/live frames and fresh-chat recall; actual native Context source reads/writes, accepted-note deletion and a new chat reading the AGENTS.md pointer; failed Memory governance with no fallback files; malformed Context actions preserving the inbox until retry; scheduler-triggered maintenance consuming the real inbox; and automatic reset finalization reading only the ended Cockpit session. `scripts/run-copilot-workflows.ts` runs these six cases and the six native KB/Routine cases, optionally selecting `COPILOT_WORKFLOW_CLI`, and retains CLI/SDK/OS/arch/Node/revision/dirty metadata, Jest JSON and per-case PID cleanup in a temporary report. No hosted model/account/CLI update. Verified Copilot 1.0.105/macOS arm64. Separate browser/process suites supply their own evidence; these API/WebSocket cases do not certify native Windows/Linux CLI behavior. |
| `test/copilotBackend.e2e.test.ts` | An opt-in POSIX local-model fixture deterministically invokes native `bash`, backgrounds a TERM-resistant worker, and verifies scope cleanup reaps the orphan; it uses an isolated auth home/environment and no hosted model or account. Run only this scenario with `COPILOT_E2E=1 npm test -- --runInBand test/copilotBackend.e2e.test.ts --testNamePattern="reaps orphaned native bash"`. Verified with Copilot 1.0.105 on macOS arm64. Three additional opt-in authenticated native checks through `npm run e2e:copilot`: explicit PNG image and PDF attachment transport without file tools; injected local Memory-shaped MCP discovery/calls verified through a fixture call log; restricted text one-shots with explicit `auto`, streamed text, preserved native session context, and reconciled native metrics equaling the sum of two per-turn usage frames. Uses temporary synthetic workspaces, a 60-second cancellation deadline per stream, bounded one-shots, no CLI update, and no normal-CI invocation. Historical JSONL evidence was recorded with Copilot 1.0.103-0 on macOS arm64. The updated hosted SDK stream/metrics check remains pending entitled credentials; native Windows/Linux runs remain separate. |
| Copilot compatibility provenance | The opt-in suite prints the actual CLI version, OS/architecture, Git revision, and dirty state before execution. Media fixtures explicitly select verified `gpt-6.1-sol`; text routing remains `auto`. Review validation also covers Copilot 1.0.105 on macOS arm64; direct adapter fixtures alone do not establish full application parity; the production Memory/Context, KB/Routine fixture, browser, and Windows-process suites record distinct evidence boundaries. |
| `test/cliProfileAuthService.test.ts` Copilot coverage | Injected version processes and native-probe doubles distinguish installation, missing credentials, verified catalog access, HTTP 403, and SDK failure without changing the shared login. Errors are redacted. Shutdown aborts and awaits active checks, rejects new work, and prevents a late version result from launching a runtime. Guided shared login is covered separately below. The route suite additionally proves a static Copilot fallback catalog cannot overwrite a denied native result. |
| `test/chat.rest.test.ts` goal endpoint coverage | `POST /conversations/:id/goal` starts a Codex or Claude Code goal stream through the router without saving a user message, normalizes accidental copied goal-card objective text before calling the backend, returns an optimistic runtime goal plus a persisted system `goalEvent` set message, forwards `goal_updated` over WebSocket, persists the assistant response when one exists, persists terminal goal events such as `achieved`, persists a single deduped terminal event when `GET /goal` polling discovers completion without a stream frame, and passes first-session goal options to the adapter; Claude Code goal streams use `/goal <objective>` and unsupported pause/resume calls return `400`; `POST /goal/pause` and `DELETE /goal` mutate idle Codex goal state, persist `paused`/`cleared` goal-event messages, and return the adapter result without using abort semantics; idle Claude Code clear succeeds through `/goal clear`. Codex service-tier request coverage verifies message sends persist Fast, `"default"` clears it, backend options receive the effective service tier, and invalid create values return `400`. |
| `test/chat.rest.test.ts` usage pricing endpoint coverage | `GET /usage-pricing` returns built-in, override, and effective catalogs; `PUT /usage-pricing/overrides` replaces durable user overrides; `DELETE /usage-pricing/overrides` clears them; malformed and duplicate override entries return `400`. |
| `test/chat.websocket.test.ts`, `test/chat.streaming.test.ts`, `test/chat.rest.test.ts`, `test/chat.messageQueue.test.ts`, `test/chat.conversations.test.ts` | Chat routes: WebSocket streaming (text, tool_activity, stdin input, abort, assistant_message, multi-client broadcast to every open WebSocket for the same conversation), WebSocket reconnection (replay buffered events, CLI survives disconnect, CLI crash buffers error, abort clears buffer, session reset clears buffer), turn boundaries, turn_complete event forwarding, tool activity persistence, **ordered contentBlocks persistence** (interleaved text/tool ordering, adjacent text chunks merged into one block, thinking included as an ordered block with legacy `thinking` field still populated, `tool_outcomes` patches the corresponding tool block, artifact-only turns persist a generated-artifact block and copy decoded bytes into the conversation artifacts dir, intermediate messages at `turn_boundary` carry their own `contentBlocks`, omitted when the message has no persisted blocks), parallel agent persistence, session overview aggregation, auto title update on new sessions including first sessions and reset sessions, usage event forwarding and persistence (including sessionUsage), usage stats endpoints (GET/DELETE), file upload/serve including the 100 MB conversation upload limit, DNG upload normalization to a capped `.dng.preview.jpg` JPEG attachment plus malformed-DNG `400` handling and generated-preview delete cleanup, and attachment OCR (including one-shot media capability gating for stale selected models, missing stored CLI profile repair with returned Agent Cockpit recovery message, locked valid-profile switch rejection, and `attachments: [{ kind:'image' }]` propagation), workspace instructions, workspace context injection (discussion history pointer on new sessions, memory pointer on new sessions when memory is enabled, no memory pointer when memory is disabled, resumed memory-enabled messages repeat only the `memory_note` failure/no-local-fallback write rule, memory content never leaks into the system prompt), workspace memory GET endpoint (empty returns `{enabled:false, snapshot:null}`, unknown workspace returns same empty shape, saved snapshot returned with `claude/` filenames and optional per-file lifecycle metadata), PUT `/memory/enabled` toggle round-trip and non-boolean rejection, DELETE `/memory/entries/:relpath` including path-traversal rejection, DELETE `/memory/entries` bulk clear (returns deleted count and empty snapshot, no-op returns 200 with `deleted: 0`), `memory_update` WS frame (first capture lists all files, second capture only diffs, source conversation gets `displayInChat:true`, idle same-workspace conversations get refresh-only `displayInChat:false`, memory delete sends refresh-only frames, no frame when adapter has no memory dir — gated on `setWorkspaceMemoryEnabled`), workspace knowledge base GET endpoint (returns `{enabled:false, state:<empty scaffold>}` when KB disabled, `{enabled:true, state:<persisted scaffold>}` when enabled, 404 for unknown workspace), PUT `/kb/enabled` toggle round-trip, non-boolean rejection, 404 for unknown workspace, Memory independence (toggling KB does not touch `memoryEnabled` and vice versa), `POST /workspaces/:workspaceId/kb/raw` multipart upload (202 happy path staging an `ingesting` entry then reaching `ingested` after `waitForIdle`, 400 `KB disabled` when toggle is off, unsupported file extensions surface as `failed` with error on the state entry, 400 pre-flight rejection of legacy `.doc` with a "resave as .docx" message and no raw entry created, 400 pre-flight rejection of `.docx` uploads when pandoc is unavailable — verified hermetically by pointing PATH at an empty dir and resetting the pandoc detection cache — with an install hint that includes the pandoc.org URL), `DELETE /workspaces/:workspaceId/kb/raw/:rawId` (cascade removal of raw file + converted dir + state entry, 404 for unknown rawId), `GET /workspaces/:workspaceId/kb/raw/:rawId` (streams bytes with the stored mimeType, 400 for malformed rawIds, 404 for unknown rawIds), `GET /workspaces/:workspaceId/kb/raw/:rawId/media/:mediapath(*)` (streams a seeded media file from `converted/<rawId>/media/Slide123.jpg`, serves nested `slides/slide-001.png`, 404 for missing files, 400 for non-hex rawIds, 400 on `..%2F..%2F` path traversal), `GET /kb/libreoffice-status` shape (boolean `available`, nullable `binaryPath`, string `checkedAt`, availability/binaryPath consistency), archive/restore endpoints, **GET `/active-streams`** (returns `{ ids: [] }` when no streams/jobs are active, merges runtime `activeStreams` entries with durable accepted/preparing jobs, returns stream details including `jobId` and `state`, and excludes idle conversations), **PATCH `/conversations/:id/unread`** (sets the `unread` flag and surfaces it on the next `GET /conversations` summary, clears it back out so it's omitted from the summary, treats an empty body as `unread: false`, returns 404 for an unknown conversation), **PATCH `/conversations/:id/messages/:messageId/pin`** (pins/unpins the active-session message, persists the updated message, rejects missing/non-boolean payloads with 400, and returns 404 for missing conversations/messages), message queue persistence (GET/PUT/DELETE against the typed `QueuedMessage` shape, persists attachments on queued messages, included in conversation response, cleared on reset/archive, PUT rejects legacy `string` entries with 400, PUT rejects attachment entries missing or blank `path`), model passthrough (explicit model, stored model, model update), effort passthrough (explicit effort on send, silent downgrade when model switch drops `max`, stored effort reused on subsequent sends), **`external_session` stream event** (the adapter-emitted `{ type: 'external_session', sessionId }` frame is consumed by `processStream`, persisted onto the active `SessionEntry.externalSessionId` on disk, **not forwarded to the frontend WebSocket**, and the persisted value flows back to the adapter via `SendMessageOptions.externalSessionId` on the next send — the full round-trip that makes server-restart resume work). **REST endpoints:** POST `/conversations` (creates conversation, creates with workspace, creates with model, returns 400 for empty title), PUT `/conversations/:id` (updates title, returns 404 for unknown id), DELETE `/conversations/:id` (deletes conversation, returns 404 for unknown id, concurrent delete returns 404), GET `/conversations/:id` (returns conversation with messages, returns 404 for unknown conversation, returns empty messages for new conversation), GET `/sessions` (lists active sessions, returns empty array when none), GET `/download` (returns 400 without conversationId, returns 404 for unknown conversation, returns markdown for valid conversation), GET `/settings` (returns current settings, returns default settings on fresh service), PUT `/settings` (updates and returns settings, returns 400 for invalid payload), GET `/backends` (returns registered backends, includes metadata), POST `/reset` (resets active session, returns 404 for unknown conversation, returns 409 when stream is active, succeeds when no active session). **Workspace file explorer:** `GET /workspaces/:workspaceId/explorer/tree` (lists root + nested folders, hidden files are always included, dirs before files then alphabetical, traversal `..` rejected with 403, leading slash on `/etc` is stripped so absolute-looking paths are treated as relative, 404 for unknown workspace, 400 when path resolves to a file), `GET /workspaces/:workspaceId/explorer/preview` (`mode=view` returns text JSON, 413 when the file exceeds 5 MB, `mode=download` sets `Content-Disposition: attachment`, `mode=raw` sets the inferred MIME type, traversal rejected with 403, 404 for missing file, 400 when the path is a directory), `POST /workspaces/:workspaceId/explorer/upload` (single-file happy path returns entry metadata, upload into nested folder auto-targets the folder, 409 on filename conflict without `overwrite=true`, `overwrite=true` replaces the existing file, 413 on over-limit payloads, traversal in destination `path` rejected with 403, 400 when destination resolves to a file), `POST /workspaces/:workspaceId/explorer/mkdir` (creates a folder at root, creates a folder nested inside an existing parent, 409 on name collision with an existing file or folder, 400 on slashes/backslashes in the name, 400 on empty or whitespace-only names, 403 on parent-path traversal, 404 for missing parent), `POST /workspaces/:workspaceId/explorer/file` (creates an empty file at root, creates inside a nested parent, accepts optional seed `content` body, 409 on collision with an existing file, 409 on collision with an existing folder of the same name, 400 on slashes in the name, 400 on empty names, 403 on parent-path traversal, 404 for missing parent, 413 when seed content exceeds the 5 MB edit limit and no file is created), `PUT /workspaces/:workspaceId/explorer/file` (overwrites an existing text file with the `content` body and returns the post-write size, saves into nested paths, accepts an empty string to truncate, 400 on non-string content, 413 when byte length exceeds the 5 MB edit limit and leaves the file untouched, 404 for missing files, 400 when the path is a directory, 400 when the path resolves to the workspace root via a stripped leading slash, 403 on traversal), `PATCH /workspaces/:workspaceId/explorer/rename` (file rename, directory rename, 409 on target collision without overwrite, `overwrite: true` replaces the target, 400 on root rename, 403 on traversal of either field, 404 for missing source), `DELETE /workspaces/:workspaceId/explorer/entry` (file delete, recursive directory delete, 400 on root delete attempt, 404 for missing entry, 403 on traversal). |
| `test/chat.conversations.test.ts` settings integration route coverage | `GET /api/chat/settings` and `PUT /api/chat/settings` redact global Telegram bot tokens from responses, preserve the stored token when the browser saves a redacted settings object, and clear it only when `integrations.telegram.clearBotToken` is posted. |
| `test/chat.rest.test.ts` message-window coverage | `GET /conversations/:id?messageWindow=tail&limit=N` returns only the requested tail page while preserving `messageWindow` indexes and all pinned-message summaries, `GET /conversations/:id/messages?before=<id>&limit=N` returns older active-session rows before the anchor with `hasOlder`/`hasNewer`, `GET /conversations/:id/messages?around=<id>&beforeCount=N&afterCount=N` returns a pinned-jump neighborhood including the anchor, and missing anchors return 404. |
| `test/chat.rest.test.ts` backend resume metadata coverage | `GET /active-streams` includes durable job `runtime` identifiers recorded from `external_session` and internal `backend_runtime` stream events; `GET /backends` exposes `resumeCapabilities` so the route contract distinguishes active-turn resume from later-session resume. |
| `test/chat.explorer.test.ts` | Focused workspace file explorer REST coverage for tree, preview, upload, create folder/file, save file, rename/move, delete, conflict, overwrite, size-limit, and traversal/root-delete guard behavior, including Astro preview MIME/language and save coverage. This keeps the file-management API covered independently from the broader `chat.rest` suite. |
| `test/chat.git.test.ts` | Focused read-only workspace Git route coverage: status returns modified/deleted/renamed/untracked files for a repo-root workspace, supports a workspace nested inside a larger repo while filtering out sibling changes, plain directories return `{ isGitRepo:false, files:[] }`, unknown workspace returns 404, diff returns old/new content for modified files, empty old side for untracked files, empty new side for deleted files, nested-workspace diffs use workspace-relative paths, and traversal is rejected before any diff content is read. |
| `test/gitDiffRows.test.ts` | Desktop Files Browser Git diff projection helpers: aligned old/new rows preserve clean diffs as line rows, replacement lines are paired into changed side-by-side rows, granular inline diff parts mark inserted and replaced text spans, separated changes are grouped into hunks with context, long unchanged spans are hidden behind hunk separator metadata, hunk labels carry unified-diff ranges, hidden rows are retained so the UI can expand separators inline, and hidden middle context is omitted from the rendered row list until expanded. |
| `test/backends.test.ts`, `test/kiroBackend.test.ts`, `test/codexBackend.test.ts` backend runtime metadata coverage | Claude Code, Kiro, and Codex streaming adapters emit `backend_runtime` process identifiers when their local child process is available; Codex records the app-server turn id from the `turn/start` response path, emits `backend_runtime.activeTurnId` from that path, and dedupes `turn/started` if the notification is also emitted. |
| `test/knowledgeBase.handlers.test.ts` | Per-format KB handlers: **pdfHandler** (real fixture in `test/fixtures/kb/sample.pdf` — rasterizes each page to `pages/page-NNNN.png`, asserts the PNG magic bytes and 1666x2156 dimensions on disk, the `## Page N` block carries the `> source: pdfjs \| figures: 0 \| table-likely: false` annotation followed by extracted body text and the `![Page N](pages/page-NNNN.png)` image link, `handler='pdf/rasterized-hybrid'`, `pageCount`/`renderedPageCount`/`rasterDpi:196` plus the `sourceCounts` aggregate and the per-page `pages` array (with `source`, `figureCount`, `tableLikely`, `extractedChars`); **forced needs-ai paths** stub `extractPageSignals` via `jest.spyOn` on the imported `pdfSignalsModule` to drive the classifier into needs-ai and assert: `image-only` fallback when `ingestionAdapter` is omitted, `source: artificial-intelligence` annotation + image link still appended when a stub adapter returns AI markdown (validates the prompt references `page-0001.png`, `opts.model` plumbs through, and `opts.allowTools=true`), and `> source: image-only \| note: AI conversion failed after retry` when the adapter throws), **docxHandler** (stubs `runPandoc` via `jest.spyOn` on the pandoc module and uses `napiCanvas.createCanvas(w,h).toBuffer('image/png')` to seed real PNGs of varying widths into the simulated `--extract-media` directory: happy path with a 300px image and **no** ingestion adapter verifies flattened media layout, collision-safe rename, GFM table preservation, `media/media/...` reference rewriting, `docx/pandoc-hybrid` handler tag, `sourceCounts.no-adapter === 1`, and bare image link preserved; **too-small filter** with an 80px image plus a stub adapter verifies the adapter is **not** called and `source: 'too-small'`; **AI happy path** with a 400px image plus a working stub adapter verifies the adapter is called once, a multi-line `> Image description (source: artificial-intelligence): …` block is appended right after the image link with `> ` quoting on every line, `source: 'artificial-intelligence'`, and `aiRetries === 0`; **AI failure** with a throwing stub adapter verifies the bare image link survives and `source: 'ai-failed'` with `aiRetries === 1`; **HTML `<img>` form** with a 400px image emitted as `<img src="<absolute-path>" style="…" />` (mirroring pandoc's fallback when the source DOCX has inline width/height styling) verifies the absolute path is rewritten to `media/image1.png`, the inline `style` attribute survives the rewrite, the AI description is appended right after the `<img>` tag, and `sourceCounts.artificial-intelligence === 1`; **oversized image (downscale sibling)** seeds a real `3000x2000` PNG into the simulated extract-media dir and stubs pandoc to emit **both** reference forms (markdown `![](./media/media/image1.png)` and HTML `<img src="<absolute-path>" style="…" />`), then asserts: a `media/image1.png.ai.png` sibling is written next to the original with the long edge clamped to `MAX_LONG_EDGE_PX`, the original at `media/image1.png` is preserved at full resolution, **both** the rewritten markdown link and the rewritten `<img src=>` point at the sibling rel (`media/image1.png.ai.png`), the inline `style` attribute on the `<img>` survives the rewrite, the AI description is appended to the rewritten reference, the AI prompt references the sibling basename, `mediaFiles` contains both originals + siblings, and `images[0].mediaPath === 'media/image1.png.ai.png'`; no-media branch (empty `sourceCounts` and `images` arrays); and a rejection branch verifying pandoc errors propagate so the orchestrator can mark the entry failed), **pptxHandler** (pins `PPTX_SLIDE_RASTER_SCALE = 7 / 3` to render 960x540-point 16:9 slides as 2240x1260 px with both edges divisible by 28, uses the real `sample.pptx` fixture for safe-text coverage and `jest.spyOn` on the imported `pptxSignalsModule`/`pptxSlideRenderModule` to drive needs-ai paths without launching LibreOffice; a `stubRasterizer(n)` helper writes real `makePng(160,120)` bytes into `slides/slide-NNN.png` so the handler can reference them in `text.md`): **safe-text happy path** asserts `handler='pptx/hybrid'`, `## Slide 1`/`## Slide 2` blocks, the `> source: xml-extract \| figures: 0 \| table-likely: false` annotation, the `### Speaker Notes` block, single embedded `media/...` file, `slideCount=2`, `slidesToImagesRequested=false`, `renderedSlideCount=0`, `sourceCounts['xml-extract']=2` (no AI/image-only counts), and per-slide `metadata.slides[]` carrying `source`/`hasImage=false`; **hidden-slide hermetic test** synthesizes a 3-slide in-memory pptx with `show="0"` on slide 2 and asserts only 2 slides are emitted, renumbered 1..2, with `slideCount=2`, `totalSlideCount=3`, `hiddenSlideCount=1`, and a `"1 of 3 slides … hidden"` note in the markdown; **LibreOffice-missing hermetic test** points PATH at an empty dir and resets the detection cache to force the fallback warning path (`slidesToImagesRequested=true`, `slideImagesWarning` matches `/LibreOffice/i`, `renderedSlideCount=0`, `"Slide rasterization note"` in the markdown, the plain-text fixture still classifies as xml-extract); **xml-extract fallback when needs-ai but no rasterized image** — `jest.spyOn(pptxSignalsModule,'extractSlideSignals')` forces `{figureCount:1,tableLikely:true}` with `convertSlidesToImages` OFF, asserts the `> source: xml-extract \| figures: 1 \| table-likely: true \| note: no slide image available; using XML extraction` annotation, that the XML body still surfaces, that speaker notes still surface, and `sourceCounts['xml-extract']=2`; **image-only fallback when needs-ai with rasterized image but no Ingestion CLI** — signals stubbed `{figureCount:1,tableLikely:false}` + `stubRasterizer(2)` + `ingestionAdapter` intentionally omitted, asserts the `\| note: no Ingestion CLI configured` annotation, the XML body is **dropped** (we don't fall back to text we just routed to AI), speaker notes are still **preserved** (separate text stream from slide content), the `![Slide N](slides/slide-NNN.png)` image link is present for both slides, `sourceCounts['image-only']=2`, and `renderedSlideCount=2`; **AI happy path** — signals stubbed `{figureCount:0,tableLikely:true}` + `stubRasterizer(2)` + stub adapter whose `runOneShot` returns AI markdown, asserts the adapter is called once per slide with a prompt that references `slide-001.png` by basename (not absolute path) and that `opts.model='claude-sonnet-4-6'`/`opts.allowTools=true` plumb through, the `> source: artificial-intelligence \| figures: 0 \| table-likely: true` annotation, the AI markdown becomes the slide body, the image link is preserved alongside the AI body, speaker notes are preserved, the original XML body is **not** included (replaced, not appended), `sourceCounts['artificial-intelligence']=2`, and per-slide `aiCallDurationMs >= 0`/`aiRetries=0`/`hasImage=true`; **AI failure → image-only with notes preserved** — signals stubbed `{figureCount:1,tableLikely:false}` + `stubRasterizer(2)` + stub adapter whose `runOneShot` always throws, asserts the `\| note: AI conversion failed after retry` annotation, the image link survives, speaker notes survive, no fallback to XML body, `sourceCounts['image-only']=2`, and `slides[0].aiRetries=1`; **oversized slide (downscale sibling)** uses a custom rasterizer that writes a real `3000x2000` PNG to `slides/slide-001.png` plus signals stubbed needs-ai and a stub AI adapter, asserts: a `slides/slide-001.png.ai.png` sibling is written with the long edge clamped to `MAX_LONG_EDGE_PX`, the original full-resolution slide image is preserved on disk, the per-slide markdown link points at the sibling (`![Slide 1](slides/slide-001.png.ai.png)`), the AI call reads the sibling absolute path, and `mediaFiles` includes both the original and the sibling), **passthroughHandler** (markdown inlined, non-markdown text wrapped in a code fence, preserves full content of large text files without truncation, image files copied into `media/` with the `> source: image-only \| note: no Ingestion CLI configured` annotation when no adapter, **AI happy path** with a stub adapter inlines the AI Markdown above the image link with `source: 'artificial-intelligence'` and `sourceCounts['artificial-intelligence']=1`, **AI failure** with a throwing stub adapter falls back to `> source: image-only \| note: AI conversion failed after retry` and `aiRetries=1`, **SVG bypass** uses the `> note: SVG not eligible for AI conversion` annotation and the adapter is **not** called, **oversized image (downscale sibling)** seeds a real `3000x2000` PNG via `makePng` plus a stub adapter and asserts: a `media/huge.png.ai.png` sibling is written with the long edge clamped to `MAX_LONG_EDGE_PX`, the original at `media/huge.png` survives at full resolution, the inline markdown link is rewritten to point at the sibling (so the digestion CLI reads the downscaled copy), the AI call's prompt references the sibling basename, `mediaFiles` contains both `['media/huge.png','media/huge.png.ai.png']`, and `metadata.downscaled === true`, `passthroughSupports` extension matrix), **dispatch** (`pickHandler` extension-first + MIME-fallback, `ingestFile` routes real fixtures through the right handler and returns the hybrid rasterized PDF shape with `handler='pdf/rasterized-hybrid'` and the `> source: pdfjs` annotation, `UnsupportedFileTypeError` for unknown extensions). |
| `test/knowledgeBase.ingestion.test.ts` | `KbIngestionService` end-to-end against a real `ChatService` with a fresh `state.db`: `enqueueUpload` rejects with `KbDisabledError` when KB is off, stages a text file (raw on disk, `ingesting` row in the DB, `kb_state_update` frame emitted) and transitions to `ingested` after `waitForIdle` with `text.md`/`meta.json` written under `converted/<rawId>/` plus deterministic document-structure rows in `kb_documents`/`kb_document_nodes`, dedupes identical content across two different filenames (second upload returns `deduped: true` and no second raw row but still adds a new location), marks unsupported file types as `failed` with `errorClass='unknown'` and the error message stored on the raw row. `deleteRaw`/`purgeRaw` cascades (raw file + converted dir + raw row + raw_locations + entries + entry dirs all removed, stale entry embeddings deleted when a vector store is configured, single `kb_state_update` frame emitted), returns `false` for unknown rawIds, and raises `KbDisabledError` when KB is off. **Substep emissions** — emits `substep` frames for converting and storing phases during ingestion so the UI can show live progress. |
| `test/knowledgeBase.documentStructure.test.ts` | Pure deterministic structure generation: PDF-style `## Page N` blocks produce page nodes and page unit counts, PPTX-style `## Slide N` blocks produce slide nodes, markdown headings produce hierarchical section nodes with parent IDs, and documents without recognizable structure get one fallback root node covering the whole document. |
| `test/knowledgeBase.chunkPlanner.test.ts` | Pure deterministic digest chunk planning: small documents stay one chunk, large page ranges split by unit budget, natural structure nodes are preserved when they fit, uncovered unit gaps become fallback chunks, adjacent small nodes merge up to the budget, oversized nodes split deterministically, and fallback planning covers all units in order for large documents such as 500-page PDFs. |
| `test/knowledgeBase.db.test.ts` | `KbDatabase` unit tests against a temp-dir-backed SQLite file: schema bootstrap (`KB_DB_SCHEMA_VERSION`, root folder auto-insert, all counters zero on empty DB), `normalizeFolderPath` (accepts valid paths, rejects `..`/control chars/over-long segments), raw CRUD (`insertRaw`/`getRawById`/`getRawBySha` round-trip, `updateRawStatus` persists error class + message, `setRawHandler`/`setRawMetadata`/`setRawDigestedAt` update in place, `deleteRaw` cascades to `entries`/`entry_tags`/`raw_locations`), document structure (`upsertDocumentStructure`, `getDocument`, `listDocumentNodes`, replace-on-upsert, raw-delete cascade), `raw_locations` multi-location (`addLocation` auto-creates folders, same rawId across folders listed independently, `removeLocation` + `countLocations` drive ref counting, `listLocations` sorted), folder operations (`createFolder` ancestor-chain idempotent, `renameFolder` moves subtree + rewrites `raw_locations`, rejects target collisions, refuses to drop root, `listFolderSubtree` returns deepest first), `getCounters` status bucket aggregation + pending = ingested + pending-delete, entry CRUD + tag filtering (`insertEntry`/`getEntry` returns tags sorted, `listEntries` filters by rawId/tag/folder, title substring search is case-insensitive and escapes `%`/`_` so LIKE wildcards match literally, multi-tag filter uses AND semantics (must carry every requested tag; dedupes duplicates, ignores empty strings, merges legacy single-tag param), uploaded (`raw.uploaded_at`) and digested (`entries.digested_at`) ISO date ranges filter inclusively and compose with AND, `countEntries` mirrors list filter results ignoring `limit`/`offset` pagination, limit+offset slice the ordered-by-title result set, `listAllTags` returns distinct tags with usage counts ordered by count desc then name asc, `deleteEntriesByRawId` cascades to `entry_tags`, `deleteEntriesByRawId`/`deleteRaw` mark surviving co-topic entries `needs_synthesis` before cascade, `entryIdTaken` detects slug collisions), `listIngestedRawIds`/`listPendingDeleteRaw` status scoping, `openKbDatabase` migration (fresh DB no-op, legacy `state.json` → raw + raw_locations with re-hashed sha256 + JSON renamed to `.migrated`, mid-flight `ingesting`/`digesting` statuses snapped to `failed`, V1→V2 `needs_synthesis` migration ordering, V2→V3 `original_citation_count` backfill, V4 document-structure table availability, and schema-version bump), **synthesis meta** (`get`/`set` round-trips, returns null for missing keys, overwrite existing key), **synthesis runs + topic history** (run lifecycle states, listing order, history row content + entry IDs, preserved across `wipeSynthesis`), **synthesis topics CRUD** (`upsertTopic`/`getTopic`, upsert updates existing, `deleteTopic`, `listTopics`, `listTopicSummaries`), **entry-topic assignments** (`assignEntries`/`listTopicEntryIds`, `unassignEntries`, `listEntryTopicIds`, duplicate assignment idempotent, `entryCount` computed), **connections** (`upsertConnection`/`listConnectionsForTopic`, `removeConnection`, `listAllConnections`, `connectionCount` computed, topic delete cascades connections), **needs_synthesis column** (default 1 on new entries, `clearNeedsSynthesis`, `markAllNeedsSynthesis`, `markCoTopicEntriesStale`), **god-node detection** (empty when no outliers, flags high-entry-count topics), **wipeSynthesis** (removes topics + connections + resets meta), **getSynthesisSnapshot** (topic/connection counts, status, lastRunAt), **connection discovery queries** (`listTopicPairsBySharedEntries` — returns empty when no shared entries, finds pairs sharing entries, excludes already-connected pairs in both directions, orders by shared count descending; `listTransitiveCandidates` — returns empty when no 2-hop paths, finds A→B→C candidates, excludes pairs with direct connections, returns relationship labels for the path), **synthesis reflections** (`insertReflection` + `listReflections` returns inserted reflection, `getReflection` returns full detail with `citedEntryIds`, `getReflection` returns null for missing id, `wipeReflections` removes all reflections and citations, `listStaleReflectionIds` detects stale reflections when entry is re-digested and `getCounters().staleReflectionCount` mirrors that stale count, `deleteReflections` removes specific reflections, synthesis snapshot includes reflection counts, `wipeSynthesis` also wipes reflections). |
| `test/knowledgeBase.dreamOps.test.ts` | `parseDreamOutput` (clean JSON, markdown fences, preamble text, non-JSON warning, invalid JSON warning, missing operations array, unknown op types, field validation for create/update/merge/split/delete/assign/unassign/add_connection/remove_connection, confidence value validation, **string-aware brace scanner** — handles braces inside string values, escaped quotes inside string values, and does not cut mid-string on trailing unmatched braces), `applyOperations` (create_topic, update_topic with missing-topic warning, delete_topic, assign_entries, unassign_entries, merge_topics combines sources + reassigns entries, split_topic distributes entries + rewires connections, add_connection, add/update connection endpoint pre-checks with explicit skipped warnings before SQLite foreign-key constraints, remove_connection, multi-op transaction, run-id-backed history rows for create/update/merge/split/delete topic ops). |
| `test/knowledgeBase.dreamMarkdown.test.ts` | `regenerateSynthesisMarkdown` (index.md with topic table, per-topic markdown files with content + entries + connections, connections.md, wipes stale files on regenerate, handles empty DB). |
| `test/knowledgeBase.dream.test.ts` | `extractAffectedTopicIds` (empty operations, create/update/delete/merge/split topic ID extraction, deduplication, skips non-topic operations, mixed operations), `parseVerificationOutput` (valid JSON, markdown-fenced JSON, no-JSON warning, malformed JSON warning, missing verified array, invalid entry shape skipping, preamble text handling, **string-aware brace scanner handles braces inside string values**), `parseDiscoveryOutput` (valid accepted results with filtering rejected, no-JSON warning, missing results array warning, defaults confidence to inferred, skips entries with missing required fields, markdown-fenced JSON, all-rejected returns empty, **string-aware brace scanner handles braces inside string values**), **parseReflectionOutput** (parses valid reflections, returns warning when no JSON found, returns warning for missing reflections array, defaults invalid type to insight, skips reflections without `cited_entry_ids`, skips items missing title or content, handles markdown fenced JSON, returns empty reflections for empty array, **string-aware brace scanner handles braces inside string values**), **identifyTopicClusters** (returns empty for empty input, returns empty when all topics are singletons, identifies a single connected component, identifies two separate clusters, excludes singletons from clusters), **buildReflectionPrompt** (renders topics with summaries, renders connections with labels, renders entries with titles and body text, handles null/missing summaries gracefully, handles null/missing connection labels, handles null/missing entry body, renders mixed complete and incomplete data, handles empty arrays for each section), **KbDreamService** (isRunning returns false initially, dream sets isRunning true during execution then false after, dream calls backend with correct prompt pipeline, dream emits progress via onEmit callback, redream calls wipeSynthesis before running and starts a `redream` synthesis run, redream clears topic embeddings without deleting entry embeddings, redream refreshes entry embeddings during cold start, dream starts an `incremental` run and finishes run rows as completed/failed/stopped, dream returns error result on failure, dream cleans up isRunning on error, dream resolves settings and backend from registry, dream rejects when backend not found, dream rejects when dreaming CLI backend not configured, dream revokes KB search MCP session on completion, dream revokes KB search MCP session on error, concurrent dream calls for same workspace rejected while running, **parse-failure retry** — retries the CLI once when the parser reports a JSON-parse/extraction failure and processes the entry on the second attempt, writes raw attempt outputs to `_dream_debug/parse-failure-<phase>-<iso>.txt` when both attempts fail to parse, does **not** retry when the first attempt parses cleanly, does **not** retry when the CLI returned `null` on the first attempt and preserves the existing skip behavior; no-retry harnesses preserve pending entries after execution/empty/unusable output, including all-invalid items, and apply partially valid output once with its item warnings recorded), **hasParseFailure** (empty warnings → false, "JSON parse error" → true, "no JSON found"/"no JSON object found" → true, case-insensitive, structural/schema warnings like missing arrays or unknown op types → false, mixed warnings containing any parse failure → true) |
| `test/knowledgeBase.autoDream.test.ts` | Auto-Dream scheduling helpers and scheduler: normalizes invalid persisted configs to off, validates interval/window config payloads, computes same-day and overnight window state, reports next run timing for interval/window modes, starts interval runs only when due and pending synthesis exists, skips when no work is pending or a dream is already running, starts window runs only inside the configured local-time window, requests cooperative stop for scheduler-owned window runs after the window closes, and does not stop manual dream runs at window end. |
| `test/knowledgeBase.dream.test.ts` Auto-Dream lock coverage | `KbDreamService.dream()` marks a workspace running before the first async pre-flight yield, preventing a manual and scheduled start from racing through the running check together. |
| `test/chatService.workspace.test.ts` Auto-Dream coverage | Per-workspace KB Auto-Dream config defaults to `{ mode: 'off' }`, persists on `WorkspaceIndex.kbAutoDream`, round-trips through `getWorkspaceKbAutoDream`, and `listKbEnabledWorkspaceHashes()` returns only workspaces with `kbEnabled: true` for scheduler scans. |
| `test/chat.workspaceIdentityStore.test.ts` | Stable workspace identity store coverage: initializes a missing registry from existing workspace folders, assigns missing `WorkspaceIndex.workspaceId` values, preserves legacy hash storage keys, rebuilds corrupt/missing registry data from indexes, drops stale registry records, resolves by canonical `workspaceId` and legacy storage keys, creates one identity for concurrent requests for the same new path, creates new identities for new paths, rejects path collisions on location remap, and tracks previous paths without renaming workspace data folders. |
| `test/workspaceSessionStore.test.ts` | Workspace session storage coverage: resolves canonical workspace IDs through legacy storage keys for `index.json` writes/reads, stamps the canonical `workspaceId` before persisting, writes and reads conversation `session-N.json` files below the workspace directory, rebuilds the convId→workspaceId lookup map from workspace indexes, falls back to identity-store resolution when an index has no `workspaceId`, clears stale map entries when the workspaces directory is absent, looks up conversation entries through that map, and skips/logs corrupt workspace indexes without aborting the rebuild. |
| `test/chat.conversationLifecycleStore.test.ts` | Conversation lifecycle store coverage: sidebar list projection filters active versus archived conversations, sorts by `lastActivity`, includes workspace identity/hash/KB and worktree checkout metadata, falls back to identity-store resolution when a listed index has no `workspaceId`, returns an empty list when the workspaces directory is absent, persists manual rename/archive/restore/unread mutations through the shared index boundary, avoids redundant unread writes, returns false for missing conversations, and records backend external session IDs only when the active session changes. |
| `test/chat.conversationMessageStore.test.ts` | Conversation message store coverage: pinned-message collection preserves source indexes; tail/before/around message-window projection clamps and slices the active message list; append creates missing session files, stores backend/message metadata, first-user auto-title updates, and session message counts; edit truncates from the edited message before appending replacement user input; pin toggles mutate only the session file; and session history/message readers return active and archived session metadata. |
| `test/chat.conversationUsageStore.test.ts` | Conversation usage store coverage: usage events accumulate into conversation totals, active-session totals, and per-backend usage buckets; explicit backend/model overrides are honored; Codex Fast conversations map to the priority pricing tier while explicit usage-event pricing tiers win; repeated usage adds token and credit values; conversations without an active session return an empty session total; and missing conversations return `null`. |
| `test/chat.workspaceMemoryStore.test.ts` | Workspace Memory storage coverage: resolves the per-workspace memory directory layout, creates `memory/files/` for pointer reads, atomically writes/reads `snapshot.json` and `state.json`, preserves fail-fast corrupt JSON reads, and writes consolidation audit JSON under `memory/audits/`. |
| `test/chat.workspaceKnowledgeStore.test.ts` | Workspace Knowledge storage coverage: resolves the per-workspace KB directory layout, canonicalizes legacy storage refs when opening cached SQLite DB handles, creates the `knowledge/raw/` directory on first DB open, reuses cached DB handles until close, reopens after cache close, returns null for empty refs, tolerates closing a missing vector-store cache entry, and resets only the derived `knowledge/vectors/` directory while preserving raw KB source files. |
| `test/chatService.workspace.test.ts` workspace identity/location coverage | ChatService returns canonical `workspaceId` plus legacy `workspaceHash` on creates, lists, and full conversation reads; resolves workspace-scoped stores by `workspaceId`; exposes `getWorkspaceLocation`/`updateWorkspaceLocation`; updates `WorkspaceIndex.workspacePath` and the identity registry when a workspace is moved; rejects duplicate target paths; returns canonical workspace IDs for memory-enabled scheduler discovery; and leaves the storage folder name stable. |
| `test/chatService.workspace.test.ts` workspace archive coverage | Covers history-only archive/restore, active-list hiding, `workspace_archived` create blocking, Memory finalizer discovery plus KB/Workspace Context scheduled discovery skipping archived workspaces while preserving feature flags, snapshot estimates, verified ZIP snapshot creation, restore into a new mapped folder, common generated-folder exclusion, original-folder delete cleanup, product-trash cleanup, and destructive archived-data deletion only after archival. |
| `test/chatService.workspace.test.ts` Workspace Context/Routines workspace coverage | Per-workspace Workspace Context enablement defaults to false, persists on `WorkspaceIndex.workspaceContextEnabled`, remains independent of Memory/KB toggles, `listWorkspaceContextEnabledWorkspaceHashes()` returns canonical workspace IDs for enabled workspaces, per-workspace Routines enablement defaults to false, persists on `WorkspaceIndex.routinesEnabled`, remains independent of Memory/KB/Workspace Context toggles, `listRoutinesEnabledWorkspaceHashes()` returns canonical workspace IDs for enabled workspaces, and workspace settings default to `{ processorMode:'global' }` while normalized overrides keep valid CLI profiles, clamp scan and maintenance intervals, and migrate legacy `contextMapEnabled/contextMap` fields. |
| `test/chat.workspaceContext.test.ts` | Workspace Context REST coverage for `GET /workspaces/:workspaceId/workspace-context/settings`, `PUT /workspace-context/enabled`, `PUT /workspace-context/settings`, `POST /workspace-context/scan`, `POST /workspace-context/maintenance`, `POST /workspace-context/scan/stop`, `POST /workspace-context/repair-instructions`, `GET /workspace-context/files`, `GET /workspace-context/files/*`, `GET/PUT/DELETE /workspace-context/references/*`, `GET/POST/DELETE /workspace-context/assets/*`, `GET /conversations/:id/workspace-context-file`, and `DELETE /workspace-context`: default global-mode response, unknown workspace 404s, boolean validation, enablement round-trip plus asynchronous initial scan start on first enable, disabling stops active runs and removes the managed `AGENTS.md` block, Memory/KB independence, wrapped/direct settings bodies, override normalization, global-mode CLI field dropping, removed source/extraction/synthesis field stripping, non-object settings rejection, manual scan start, maintenance start, already-running scan rejection, disabled/unknown scan rejection, destructive clear preserving workspace enablement, conversation `workspaceContext` status hydration, workspace-scoped `workspace_context_update` emissions, read-only context markdown listing/preview, reference write/read/delete validation, asset upload/preview/download/delete validation, conversation-scoped context/reference/asset preview with other-workspace rejection, traversal rejection, and asynchronous conversation-only `session_reset`/`archive` finalizer passes. |
| `test/chatService.workspace.test.ts` KB state progress coverage | `getKbStateSnapshot()` returns idle `dreamingStatus`/`dreamProgress: null` for disabled and freshly enabled workspaces, and mirrors persisted synthesis `status` + `dream_progress` so the Pipeline tab can hydrate live Dream/Synthesis progress from `GET /kb`. |
| `test/chatService.workspace.test.ts` instruction compatibility coverage | Workspace instruction compatibility detection: no notification when no native instruction files exist, notification when only one harness source exists, pointer creation from `AGENTS.md` without overwriting existing files, creating `AGENTS.md` first when only `CLAUDE.md` exists, and dismissal fingerprint invalidation when file coverage changes. |
| `test/chat.rest.test.ts` instruction compatibility routes | `GET /workspaces/:workspaceId/instruction-compatibility`, `POST /workspaces/:workspaceId/instruction-compatibility/pointers`, and `PUT /workspaces/:workspaceId/instruction-compatibility/dismissal`, including 404 for unknown workspaces. |
| `test/chatService.helpers.test.ts` | Focused ChatService helper coverage for workspace references, default workspace handling, message/session helper behavior, and defensive normalization paths that are easier to verify without the full route stack. |
| `test/chatService.migration.test.ts` | ChatService migration coverage for legacy workspace/session/index shapes so old on-disk data is normalized into the current `WorkspaceIndex`, conversation, session, and queue formats without losing messages. |
| `test/chatService.usage.test.ts` | ChatService usage-ledger coverage for per-conversation, per-session, per-backend, per-model, Codex Fast priority pricing, daily aggregate usage accounting, and automatic external Claude transcript usage import that excludes Agent Cockpit-owned session IDs. |
| `test/chat.kb.test.ts` Auto-Dream routes | `PUT /workspaces/:workspaceId/kb/auto-dream` persists interval config, rejects invalid window times, returns `404` for unknown workspaces, and `GET /workspaces/:workspaceId/kb/synthesis` includes computed Auto-Dream timing/status for the frontend. |
| `test/chat.kb.test.ts` raw trace route | `GET /workspaces/:workspaceId/kb/raw/:rawId/trace` returns raw metadata, converted file/media summaries, document structure, planned chunks annotated with used source ranges, entries with source lineage, and synthesis topics using those entries; disabled-workspace trace/glossary reads return before opening or creating KB state. |
| `test/kbSearchMcp.test.ts` | KB Search MCP server factory: session lifecycle (`issueKbSearchSession` token + mcpServers config, token reuse for same session key, different tokens for different session keys, independent tokens for same workspace with different session keys, `revokeKbSearchSession` invalidates token + no-op for unknown), auth (rejects missing/invalid token), tool dispatch (rejects unknown/missing tool), document tools (`list_documents` returns document summaries and clamps limits, `get_document_structure` returns metadata + paginated nodes with truncation metadata, `get_source_range` extracts bounded page ranges and relative media refs), `get_topic` handler (returns topic with connections + entries, error for missing topic_id, error when topic not found, error when DB unavailable), `search_topics` handler (empty for empty query, warning when no embedding config), `search_entries` handler (empty for empty query, warning when no embedding config), `find_similar_topics` handler (error for missing topic_id, warning when no embedding config), `find_unconnected_similar` handler (error for missing topic_id, warning when no embedding config, filters out already-connected topics, respects limit parameter), `kb_ingest` handler (error for missing file_path, error when file not found, error when ingestion service not provided, error when path is a directory, ingests real file via enqueueUpload with conversation-documents folder), Ollama fallback (search_topics falls back to keyword search when embedding fails, search_entries falls back to keyword search when embedding fails, find_similar_topics returns empty when embeddings unavailable). |
| `test/knowledgeBase.multiLocation.test.ts` | `KbIngestionService` multi-location (Option B) end-to-end: same bytes uploaded in two folders reuse a single raw row + single on-disk file but insert two `raw_locations` rows, same bytes at same folder with two different filenames add two locations, uploading **different** bytes into an already-occupied `(folder, filename)` slot throws `KbLocationConflictError` (→ 409), `deleteLocation` removes only the targeted slot and leaves other locations live on the same rawId, deleting the **last** location always fully purges raw + bytes + converted dir (both auto-digest ON and OFF), deleting the last location with auto-digest OFF also cleans up existing entries, `purgeRaw` unconditionally wipes every location + downstream artifacts regardless of auto-digest, `deleteLocation` returns `false` for an unknown slot so the route can 404, re-uploading same bytes after full purge creates a fresh raw. |
| `test/knowledgeBase.folders.test.ts` | Virtual folder CRUD via `KbIngestionService`: `createFolder` creates nested paths idempotently and emits a `folders: true` frame, rejects root creation, rejects path-traversal segments (`..`), rejects when KB disabled. `renameFolder` moves a subtree + rewrites every `raw_locations` row under the old prefix in one transaction (verified by listing the raw in the new folder after rename), rejects rename of or to root, rejects when KB disabled. `deleteFolder` refuses to drop a non-empty folder without `cascade: true`, cascading delete always fully purges the raw + bytes + converted dir regardless of auto-digest setting, rejects root delete, rejects nonexistent folders, rejects when KB disabled. |
| `test/knowledgeBase.concurrency.test.ts` | `WorkspaceTaskQueue` + `WorkspaceTaskQueueRegistry` unit tests against deferred-promise gates so the suite is deterministic — no setTimeout-based races. **Queue:** runs tasks in FIFO order at concurrency=1; runs up to N in parallel at higher budgets and slots back-fill on settle (3 of 5 in flight, next two pick up as predecessors finish); drain-barrier waits for in-flight to settle, runs alone (`barrierRunning=true`, `inFlight=0`), then resumes downstream dispatch — and queued post-barrier tasks do NOT start until the barrier resolves; concurrency budget is read fresh on every dispatch so runtime changes propagate to the next pump (budget bumped from 1 to 3 → next settle dispatches the rest); `waitForIdle` resolves immediately on an already-idle queue and after every in-flight task settles otherwise; a failing task does not poison the queue (next task still runs, `inFlight` returns to zero); synchronous throws inside `task()` surface as rejected promises (async IIFE wrapper); concurrency < 1 is clamped to a single slot. **Registry:** `get(hash)` returns the same instance for the same hash and isolates queues across hashes (independent budgets); `setConcurrency` clamps to `>= 1` and floors fractional values; `waitForIdle` resolves immediately for unknown hashes; the shared-budget property is exercised directly — two "ingestion" + two "digestion" tasks on the same hash with `cliConcurrency=2` have only 2 in flight at any time, regardless of which "service" enqueued them. |
| `test/knowledgeBase.embeddings.test.ts` | Embedding service unit tests: `resolveConfig` applies all defaults when no config given, applies defaults for missing fields, uses all provided values; `EMBEDDING_DEFAULTS` has expected values; `embedText` calls Ollama and returns embedding (mocked fetch), throws on non-OK response, throws on unexpected response shape, strips trailing slashes from ollamaHost; `embedBatch` returns empty array for empty input, delegates to embedText for single item, sends multiple texts in one request, throws on count mismatch; `checkOllamaHealth` returns ok:true on success, ok:false on network error, ok:false on API error. |
| `test/knowledgeBase.vectorStore.test.ts` | PGLite vector store unit tests against a temp-dir-backed PGLite DB (3-dimensional for simplicity): `upsertEntry` stores and counts entries, updates on conflict; `upsertTopic` stores and counts topics; `deleteEntry`/`deleteTopic` removes entries/topics; `vectorSearchEntries`/`Topics` returns results sorted by cosine similarity; `keywordSearchEntries`/`Topics` matches on title and summary via tsvector; `hybridSearchEntries` combines vector and keyword results (e1 ranks highest matching both); `hybridSearch` searches both entries and topics; `findSimilarTopics` excludes the query topic itself; `embeddedEntryIds`/`topicIds` returns correct ID sets; `wipeAllEmbeddings` clears data but tables remain; `wipeTopicEmbeddings` clears topic vectors while preserving entry vectors; `setModel`/`getMeta` persist model info; reopening with different dimensions wipes existing data; vector search respects topK limit. |
| `test/knowledgeBase.vectorMaintenance.test.ts` | Focused tests for `rebuildKbVectorIndex()`: verifies the maintenance path embeds current SQLite entries/topics into the vector store, removes stale vector rows, reports counts, rejects rebuild attempts when the workspace has no saved embedding configuration, and resets/recreates the derived PGLite vector store when opening existing vector state fails. |
| `test/knowledgeBase.pageConversion.test.ts` | Two units: `convertImageToMarkdown` (per-image AI conversion wrapper) and `ensureAiReadyImage` (downscaling helper). **`convertImageToMarkdown`**: happy path returns adapter output verbatim; retry-once on `runOneShot` throw and second call succeeds; retry-once on empty/whitespace output and second call succeeds; throws the last error after two consecutive throws; throws `empty output` after two consecutive empty results; prompt references the image by basename (not absolute path); prompt template matches design §8 (covers tables, figures/charts, transcription, headings, output-Markdown-only); `workingDir` is the image's parent directory, `allowTools=true`, and `attachments: [{ path, kind:'image', name:<basename> }]` is passed to `runOneShot`; `model`/`effort`/`timeoutMs` plumb through to `runOneShot`; default timeout is 10 minutes when not specified. **`ensureAiReadyImage`**: a `3000x2000` PNG is downscaled to `2576 x round(2000 * 2576/3000)` and written to the supplied `destPath`, the function returns `destPath`, and the original at `srcPath` is left untouched at full resolution; an `800x600` PNG (under the cap) returns `srcPath` unchanged with no write to `destPath`; an image whose long edge is **exactly** `MAX_LONG_EDGE_PX` returns `srcPath` (boundary — `<=` not `<`); a nonexistent `srcPath` (loadImage decode failure) falls through and returns `srcPath` with no write; missing parent directories on `destPath` are created on demand before the write. |
| `test/knowledgeBase.pdfSignals.test.ts` | Pure-helper unit tests for the PDF hybrid handler's classifier (`src/services/knowledgeBase/ingestion/pdfSignals.ts`) — every test constructs synthetic `TextItem`/`OperatorList` shapes so the real pdfjs runtime is never loaded. **`countFigures`** returns 0 with no image-paint operators, counts every `paintImageXObject`, counts inline + grouped + repeat variants, and tolerates an `OpsEnum` missing the optional variants. **`detectTableLikely`** false on empty, false on single-column prose, true on a 3×3 grid, tolerates small X jitter within `xTolerance=5.0`, rejects when columns are misaligned beyond tolerance, false when fewer than `minTableRows=3` rows, groups items into the same row within `rowTolerance=2.0`. **`flattenTextContent`** skips marked-content items lacking `str`, inserts `\n` on `hasEOL`, trims surrounding whitespace. **`extractPageSignals`** wraps a `PdfPageProxyLike` mock — safe-text page (prose, no figures, no table) returns `figureCount=0`, `tableLikely=false`, and the joined text; `figureCount=1` when a paint op appears; `tableLikely=true` for a 3×3 grid; `getTextContent` throwing yields conservative needs-ai signals (`figureCount>=1`, `tableLikely=false`, empty text); `getOperatorList` throwing yields the same conservative shape; blank page returns safe-text empty. |
| `test/chat.kb.test.ts` KB vNext route coverage | Per-document trace route (`GET /workspaces/:workspaceId/kb/raw/:rawId/trace`) returns converted artifact status, structure, planned/used chunks, entry source lineage, embeddings, related topics, and debug dump names; structure maintenance routes (`POST /workspaces/:workspaceId/kb/structure/backfill`, `POST /workspaces/:workspaceId/kb/raw/:rawId/structure`) build or rebuild `kb_documents` / `kb_document_nodes` from existing converted artifacts without requiring a re-upload. |
| `test/knowledgeBase.digest.test.ts` | `KbDigestionService` parser + end-to-end: `parseEntries` (empty output → `[]`, single entry with inline tag array, single entry with YAML list tags, multiple entries separated by `---`, auto-derives slug from title when missing, `DigestParseError` on unterminated frontmatter, `DigestSchemaError` on missing required fields + empty body, `---` horizontal rules within body text are preserved and not treated as entry boundaries, horizontal rules in body do not break multi-entry parsing, strips leading/trailing triple-backtick code fences, skips preamble prose, lowercases frontmatter keys, tag normalization + dedup), `stringifyEntry` (deterministic frontmatter order + `schemaVersion`, quotes YAML specials, optional `uploadedAt`/`digestedAt` timestamps in frontmatter), `slugify` (url-safe lowercase), `buildDigestPrompt` (output-format rules, source context, converted-text inclusion, explicit "Root folder" label, source-aware image-consultation rule keyed on the `> source: <label>` blockquote — `pdfjs`/`xml-extract` consult image only when text is incomplete, `artificial-intelligence` markdown is primary with image for verification, `image-only` MUST open the image — replacing the blunt PR #207 "Read every image" rule), `buildGleaningPrompt` (asks only for missed additional entries), `BaseBackendAdapter.runSessionShot` transcript replay fallback, `enqueueDigest` end-to-end against a stubbed backend adapter (writes `entry.md` with `uploadedAt`/`digestedAt` timestamps + DB rows + transitions raw status to `digested`, redigest replaces stale entries for the same raw without manually resetting the raw status, redigest staging failure preserves prior entries/files and commits no replacement rows, redigest deletes stale entry embeddings before replacement embedding upserts, `-2` suffix on slug collisions within one run, chunked documents run one CLI call per planned chunk before writing entries, chunk failure preserves prior entries in strict mode, duplicate merges preserve body content from later chunks, gleaning disabled uses `runOneShot`, gleaning enabled uses `runSessionShot` and merges additional entries, `malformed_output` on parse error, `cli_error` when `runOneShot` throws, `timeout` class when the error mentions timeout, `KbDigestDisabledError` when KB is off, unconfigured Digestion CLI surfaces as a `DigestResult.error`), `enqueueBatchDigest` (digests every ingested raw and emits `digestProgress` frames ending with a `null` drain signal, returns empty array when nothing is eligible). **digestProgress aggregate progress** — single `enqueueDigest` bumps `total` and emits a progress frame; `etaMs` is absent while `done < 2` and present once `done >= 2` (with `avgMsPerItem > 0`); a mid-session enqueue into an in-flight session bumps `total` without resetting `avgMsPerItem`; `GET /kb` returns `digestProgress` mid-session and `null` after drain; live `digestProgress.chunks` reports planning/digesting/parsing/committing phases plus done/total chunks; crash recovery clears persisted `digest_session` rows on new `KbDatabase` construction; crash recovery flips stuck `status='digesting'` raws back to `ingested`. **Digestion session counter** — single digest emits `digestion: { active: true, entriesCreated }` then exactly one `active: false` frame with the final count; batch digest accumulates the counter across raws and closes once; counter resets after completion so a second run starts at zero; failed digests still emit a closing `active: false` frame with zero entries. **Substep emissions** — emits `substep` frames for CLI analysis and parsing phases during digestion. **Adaptive digest timeout** — `digestTimeoutMs = max(30 min, chunkUnitCount × 10 min)`: falls back to the 30-minute floor when no structure/page/slide count is present, large PDFs and PPTX decks run in multiple bounded chunk calls, and each chunk timeout scales to its unit count instead of the whole document. |
| `test/chatService.test.ts` | ChatService CRUD, messages (including toolActivity persistence), sessions, `generateAndUpdateTitle`, asynchronous archived-session summary patching through `generateAndStoreSessionSummary`, archive/restore (flag set/remove, file preservation, list filtering, search filtering, delete-after-archive), **`setConversationUnread`** (sets and clears the unread flag on the workspace-index entry — verifies the field is *deleted* (not set to false) when cleared so the on-disk file stays lean, idempotent for repeat-true and clear-already-clear, returns false for unknown id, and `listConversations()` surfaces `unread: true` on the summary row), usage tracking (addUsage with conversationUsage/sessionUsage, usageByBackend, daily ledger with backend+model dimensions, model separation, getUsage, getUsageStats, clearUsageStats, Kiro credits accumulation, contextUsagePercentage snapshot, skipLedger option, contextUsagePercentage cleared on backend change via `updateConversationBackend`, preserved when backend is unchanged, and cleared on `resetSession`), model selection (create with model, updateConversationModel, listConversations model), effort selection (create with effort, unsupported effort falls back to `high` when supported and then the first supported level, updateConversationModel reconciles stored effort, updateConversationEffort set/clear, listConversations includes effort), service-tier selection (Codex Fast persistence, defaultServiceTier application, explicit default clearing, update/clear, and drop-on-backend-switch), workspace storage, workspace memory, workspace knowledge base, migration, markdown export, and attachment/queue helper behavior. |
| `test/chat.usageLedgerStore.test.ts` | Focused `UsageLedgerStore` coverage: accumulates token/cost/context usage by date/backend/model/pricing tier, records explicit historical ledger dates, keeps tiered rows separate, lazily enriches zero-cost rows without repricing stored estimates, and migrates legacy day-level backend buckets into the current ledger shape. |
| `test/claudeTranscriptUsageImportService.test.ts` | Focused external Claude transcript usage import coverage: scans profile Claude project transcripts, imports only session IDs not owned by Agent Cockpit, checkpoints imported transcript UUIDs, and proves reruns do not double-count. |
| `test/chat.artifactStore.test.ts` | Focused generated-artifact storage coverage: decodes base64/data-URL artifacts, infers metadata, and collision-suffixes copied source-path artifacts while preserving conversation ownership checks. |
| `test/chat.workspaceFeatureSettingsStore.test.ts` | Focused workspace feature settings coverage: normalizes Workspace Context workspace override settings, including Claude Code Interactive protocol-derived backend mirrors, migrates legacy Context Map keys, removes old `context-map/` folders during migration, and persists KB/Workspace Context/Routines enablement and scheduling flags through the workspace index facade. |
| `test/chatService.workspaceMemory.test.ts` | Focused workspace-memory storage coverage, including `memory/state.json` lifecycle metadata, metadata patching, note replacement for cockpit-owned `notes/*` entries, restoring superseded entries, note preservation across recaptures, delete/clear pruning, legacy metadata synthesis, `searchWorkspaceMemory` lexical matching that excludes superseded entries by default, exact/type ranking boosts, recency tie-breaking, and `saveMemoryConsolidationAudit` audit-file persistence. |
| `test/chatService.messages.test.ts` | Focused ChatService message/session coverage, including message append/edit behavior, active-session message pin/unpin persistence, reset fallback summaries, session history summary visibility, and asynchronous archived-session summary replacement through `generateAndStoreSessionSummary()`. |
| `test/chatService.conversations.test.ts` | Conversation CRUD route/service behavior split out of the larger chat-service suite, including `cliProfileId` derivation for new conversations, honoring `settings.defaultCliProfileId` when no explicit backend/profile is supplied, rejecting new conversations when no CLI profile/default backend exists, Codex service-tier persistence/default/clear behavior, Claude Code Ultracode persistence/reconciliation for xhigh-capable models, custom `dataRoot` chat persistence outside app root, startup migration from backend-only workspace indexes to server-configured CLI profiles, no startup recreation of a deleted server-configured profile for already-migrated conversations, explicit profile-based conversation creation, profile/backend mismatch rejection, `updateConversationCliProfile()` backend/usage updates, reset reassignment from a deleted stored profile to the only enabled profile, clear reset failure when no enabled profiles remain, reset-list metadata cleanup (`messageCount: 0`, `lastMessage: null`, reset-time `updatedAt`) after a session reset, and reset route enqueue/completion of the asynchronous `session_summary` finalizer. |
| `test/chat.conversations.test.ts` reset route coverage | `POST /api/chat/conversations/:id/reset` returns `409` while a stream is active, returns `400` when a deleted stored profile cannot be recovered because no enabled profiles remain, keeps reset ambiguous when multiple profiles remain and no replacement is supplied, uses the only enabled profile when a deleted stored profile has exactly one configured replacement, accepts an explicit replacement profile when a deleted-profile conversation has multiple configured profiles, validates the requested replacement backend, and rejects reset-time replacement when the stored profile is still valid. |
| `test/chat.conversations.test.ts` session download route coverage | `GET /api/chat/conversations/:id/sessions/:num/download` streams a single-session Markdown attachment with `Content-Disposition` and returns 404 for missing sessions. |
| `test/chat.conversations.test.ts` CLI profile metadata route coverage | `GET /api/chat/cli-profiles/:profileId/metadata` resolves an enabled profile to its harness adapter and returns profile-specific backend metadata; missing or disabled profiles return a 400 profile-resolution error. |
| `test/chat.streaming.test.ts` | Focused streaming-route coverage, including profile-aware runtime selection: creating a conversation with `cliProfileId`, sending through the selected profile-derived backend adapter, using Claude Code Interactive when the Claude profile protocol is interactive, unknown profile `400`, backend/profile mismatch `400`, blocking normal profile switches after the active session has messages, and allowing an explicit replacement profile when the conversation's stored profile was deleted after messages already exist. |
| `test/backends.test.ts` CLI profile coverage | Claude Code profile runtime resolution: `resolveClaudeCliRuntime` maps profile `command`, merged `env`, and `configDir -> CLAUDE_CONFIG_DIR`, gives `configDir` precedence over `env.CLAUDE_CONFIG_DIR`, discovers default macOS/Linux user-local installs such as `~/.local/bin/claude` when PATH lacks `claude`, and rejects non-Claude profiles; streaming and one-shot calls use the profile command/env/config dir; native Claude memory extraction and `getMemoryDir()` resolve under the profile config directory when supplied. |
| `test/memoryWatcher.test.ts` | MemoryWatcher: watch/unwatch/unwatchAll lifecycle, idempotence, rejects missing dirs and file paths, detects .md create/update, ignores non-.md files, debounces rapid bursts into a single callback, re-fires after debounce window closes, cancels fire when unwatched mid-debounce, multi-key independence, and swallows sync + async onChange errors while logging through the structured logger path. |
| `test/memoryMcp.test.ts` | Memory MCP server factory: `issueMemoryMcpSession` mints unique tokens with an `mcpServers` array pointing at the stub (correct command/args/env including `MEMORY_TOKEN`, `MEMORY_ENDPOINT`, and `MEMORY_SEARCH_ENDPOINT`), the stub schema exposes `memory_search.status` as `active | all`, the stub preserves server-provided readable failure text for `memory_note`, reissuing a session for the same conversation+workspace returns the same token (idempotent), reissuing with a different workspace reference rotates the token, reissuing after explicit revoke mints fresh token; `extractMemoryFromSession` returns 0 when memory is disabled (no CLI call), returns 0 when CLI returns `NONE`, passes the conversation workspace as the Memory CLI `workingDir`, parses a single frontmatter entry and saves it under `source: session-extraction`, redacts sensitive values from extracted entries before saving and marks metadata `redacted`, parses a multi-entry `===`-delimited response and saves all entries, swallows runOneShot errors/empty responses and returns 0, emits refresh-only workspace `memory_update` with `sourceConversationId:null` and `displayInChat:false` after saving extraction entries. **Manual consolidation helpers:** proposal generation with redacted body withholding, safe `mark_superseded` apply, audit persistence, skipped advisory actions, draft generation for merge candidates, redacted-source draft rejection, create draft apply with supersession metadata, replace draft apply for selected notes, and refresh-only `memory_update`; **POST /mcp/memory/search HTTP handler:** 401 for missing token, 400 for missing query, 403 when memory disabled, returns local lexical results, honors `status:'all'` for superseded/deleted recall, and omits content when `include_content:false`. **POST /mcp/memory/notes HTTP handler:** 401 for missing token, 401 for invalid token, 400 for missing/empty content, 403 when memory disabled for workspace, 200 with filename when CLI formats a legacy note and persists `last_succeeded`, passes the conversation workspace as the Memory CLI `workingDir`, 200 with skipped field plus `outcome` when CLI says legacy SKIP, JSON `skipped_ephemeral` decisions write no file and emit `writeOutcomes`, deterministic redaction removes API tokens before the Memory CLI prompt and marks saved metadata `redacted`, JSON `superseded_saved` decisions save a new note and mark older sidecar entries `superseded`, 502 bad-output classification when CLI returns empty output, 502 auth classification with Memory/chat profile names and redacted credential paths when processor auth fails, passes type hint and tags to CLI prompt, prompt includes existing memory list when workspace has entries, prompt says "(none yet)" when workspace has no existing entries. **nameFromFrontmatter:** extracts unquoted name, extracts double-quoted name, falls back to typeHint when no name field, falls back to "note" when no name and no typeHint. **Edge cases:** 502 runtime classification when Memory CLI throws, saves note even without frontmatter delimiters, emits workspace `memory_update` with `sourceConversationId`/`displayInChat:true` and `writeOutcomes` after memory_note writes |
| `test/streamJobRegistry.test.ts` | Direct durable stream-job registry coverage: constructor directory creation and `stream-jobs.json` path ownership; version-1 persistence readable after restart; generated/default and explicit job metadata; id upsert behavior; missing/unknown reads; active-state filtering through `ACTIVE_STREAM_JOB_STATES`; invalid version/non-array store recovery to empty; malformed entry filtering; corrupt JSON propagation; update patching with `updatedAt` refresh; unknown-update null behavior; delete idempotence; conversation-scoped active deletion that leaves legacy terminal rows; and mutex-protected concurrent create/update/delete consistency. |
| `test/sessionFinalizerQueue.test.ts` | Session finalizer queue coverage: persisted enqueue/completion, job identity de-duplication by type/source/conversation/session, retry after transient handler failure, permanent failure after `maxAttempts` with terminal observer notification and warning logs, retry due-time gating via `nextAttemptAt`, observer-error swallowing, configured/default/clamped concurrency, oldest-pending selection across workspace stores, `stop()` persistence-without-drain behavior, `waitForIdle()` timeout, malformed store-record filtering, handler payload clone isolation, recovery of `running` jobs to executable work after restart, and `workspaceId` job records resolving to legacy storage keys when older on-disk queue filenames still live under the original workspace folder. |
| `test/tabIndicator.test.ts` | Browser tab status state machine (mirrors `web/AgentCockpitWeb/src/tabIndicator.js`): idle default, `running` on stream start, returns to idle when last stream ends with tab visible, transitions to `done`/`error` only when tab is hidden, multi-conversation aggregation (stays running while any stream active), error flag sticky across concurrent streams and consumed on transition, `visibilitychange` clears `done`/`error` back to idle, running state unaffected by visibility change |
| `test/messageQueue.test.ts` | Message queue: adding, deleting, rendering, in-flight protection, pause/resume, per-conversation isolation, send button state, suspended (restored) state |
| `test/streamFrameReducer.test.ts` | Pure desktop stream-frame reducer coverage with deterministic state/context inputs: placeholder creation and ordered content-block mutation for text/thinking/tool/artifact frames, plan and question pending interactions, `tool_outcomes` patching, replay start/end cleanup, final assistant message placeholder replacement/deduplication, terminal/non-terminal errors, unread/queue effects on `done`, goal snapshot freshness, goal-clear timestamps, live-only Memory/Workspace Context/KB update projections and browser-event effects, assistant reconciliation delay, plan-usage refresh effects, browser-safe `src/contracts/responses.StreamEvent` alias coverage for representative stream frames, and matching outcomes resolving only `decisionBound` cards. |
| `test/streamStore.test.ts` | v2 `StreamStore` (`web/AgentCockpitWeb/src/streamStore.js`) module-loaded into jsdom with mocked `AgentApi` and a fake WebSocket: reducer adapter wiring, `lastFrameAt` updates, plan/question interaction state, stale replayed plan interaction clearing when a final assistant message arrives, artifact frames appended as generated-artifact content blocks, terminal stream-error source preservation (`streamErrorSource` from WS frames and persisted durable messages), ordered replay rebuilds, `respond()` stdin-vs-message behavior, preservation and subsequent answering of questions (including reused tool IDs) and revised plans received before a delayed input acknowledgement, composer profile posting, reset refresh replacing stale composer picker values with the server-returned reset conversation values, reset posting an explicit replacement profile when supplied by the UI, attachment and typed queue helpers, queue auto-drain and 409 rollback including live-tail server PUT payloads after success, 409 rollback, and WebSocket-open failure, per-conversation queue PUT coalescing, stream-error clearing and queue resume, REST-backed `stopStream()` that works with a closed WS and locally unsticks the UI with `source:'abort'` if post-abort refetch fails, failed WebSocket-open cleanup for retry, draft restore on POST failure, unread state, active-goal sidebar state after turn completion, stale goal snapshot rejection, immediate optimistic goal-strip state plus returned goal-event message upsert on `setGoal`, `refreshGoal()` preserving the local active runtime goal when backend status temporarily returns `null`, goal-event messages not replacing streaming placeholders, goal-only stream placeholder cleanup, `load()` hydration of active Codex/Claude Code-family goals, refresh-only `memory_update` frames dispatching `ac:memory-update` without chat bubbles while preserving `writeOutcomes`, displayable `memory_update` frames appending one Memory bubble with `writeOutcomes`, `workspace_context_update` frames patching `conv.workspaceContext` and dispatching `ac:workspace-context-update`, and `subscribeGlobal` first-touch behavior. |
| `test/streamStore.test.ts` | Also covers `refreshLoadedConversations()` so workspace-level session resets, including Worktrees enable/disable, refetch already-loaded conversation state and clear stale in-memory messages. |
| `test/goalState.test.ts` | Browser-safe goal helpers: normalizes second-vs-millisecond goal timestamps, identifies active goals, locally ticks active elapsed time from backend snapshots, leaves paused goals at the upstream elapsed snapshot, maps complete goals to the achieved label, checks action support from backend-neutral `supportedActions`, and strips accidental copied goal-card/strip prefixes without stripping ordinary objectives that begin with "Codex". |
| `test/frontendRoutes.test.ts` | Frontend entrypoint smoke coverage: asserts `server.ts` keeps `/` redirecting to `/v2/` and has no `/legacy` redirect, statically checks the V2 frontend uses ES module imports/lazy screens/code-splitting instead of app-local `window.*` globals, checks the retired `public/v2/` tree stays removed, statically checks the extracted mobile viewport hook is imported by `App.tsx` and owns iOS visual-viewport pinning/idempotent metric writes, checks horizontal overflow containment, Run Settings sheet scroll region, mobile hook ownership/wiring for reconnectable stream socket loss (`useChatStreamConnection.ts`), normal-send active-stream collision recovery/send-in-flight guards/queue-send rollback (`useSendPipeline.ts`), backend-neutral goal API/composer/strip behavior (`useGoalState.ts`, `useSendPipeline.ts`, `chatStreamEvents.ts`, and `useListStreamMonitor.ts`), reset-profile repair (`appModel.ts` plus `App.tsx` consumption), mobile thinking Markdown block layout, and welcome flow wiring (`AgentApi.getInstallDoctor`, `AgentApi.runInstallAction`, `AgentApi.settings.testSetupCliAuth`, `AgentApi.settings.startSetupCliAuth`, `AgentApi.completeWelcome`, `WelcomeScreen`, sidebar Welcome action, completion-state removal, Security/CLI actions, CLI-profile-required Settings shortcut, preferred-backend CLI guidance, inline install action/result UI, setup CLI auth UI, optional tool filtering, mobile PWA copy, and CSS hooks), statically checks CLI update Settings/composer wiring (`CliUpdateStore.ensureFresh()` on mount/focus and in `useCliUpdates()`, no-update footer copy, and disabled button CSS), statically checks global Settings uses the full-viewport no-sidebar shell with left-rail section navigation plus one blue top-bar Save action while Workspace Settings keeps its horizontal tab strip, statically checks OpenCode Settings uses draft metadata/check endpoints, provider-header icons including OpenRouter, and provider options from discovered models without rendering model selection in CLI Profile config, statically checks OpenCode provider-profile assistant avatars use the DeepSeek, Ollama, and OpenRouter logos plus theme-aware OpenCode light/dark logos, statically checks the instruction compatibility composer popover separates found sources, covered harnesses, and harnesses needing pointers, statically checks the composer profile picker recovers stale deleted profile ids after reset and keeps missing-profile repair selectable for locked sessions while rendering a placeholder instead of raw missing ids, statically checks pending CLI-profile metadata cannot reconcile the composer model/effort/Claude Code mode against the static backend fallback, statically checks Bedrock Claude Code profiles do not subscribe to or render Claude subscription plan usage in the topbar tooltip, statically checks the memory-update notification wiring opens `MemoryUpdateModal` before the full Memory tab, statically checks the desktop and mobile chat download choosers expose all-session and current-session Markdown export URLs, statically checks KB raw-row redigest, trace, delete, and download wiring plus the Workspace Context/Migration UI wiring described above, then mounts the same static route order as `server.ts` to verify `/v2/`, `/mobile/`, and removed V1 asset behavior. |
| `test/cliUpdateStore.test.ts` | Web CLI update store coverage: `ensureFresh()` reads the cached `/cli-updates` snapshot and automatically calls `/cli-updates/check` when a target row is newly created and unprobed (`lastCheckAt:null`, unknown install method, no version/error), then publishes the fresh versions to subscribers; already-probed missing/error rows do not force another check. |
| `test/frontendRoutes.test.ts` transcript paging static coverage | Asserts desktop transcript paging uses `AgentApi.conv.getConversation`, `AgentApi.conv.getMessageWindow`, `StreamStore.loadOlderMessages`, `loadAroundMessage`, and `loadTailMessages`; verifies `ChatLive` preserves scroll offset after prepending older messages, saves/restores per-conversation feed anchors while switching chats, uses pinned-jump around-message loading, exposes older-page and pinned-window loading status UI, restores the tail before Back to end, and does not add `react-virtuoso`, `@tanstack/react-virtual`, or `react-window` dependencies. |
| `test/mobileAppModel.test.ts` | Mobile PWA app-model helper coverage: file-delivery/upload marker parsing and previews, reset-session list normalization with explicit null contract fields, conversation-list item projection for empty conversations, optimistic-message replacement/removal and recovered-send reconciliation, live active-conversation ref resolution for queued sends after attaching to an already-running stream, runtime metadata projection including Claude Code Ultracode mode set/clear behavior, OpenCode provider/model display normalization including OpenRouter prefix hiding, reset-profile repair selection, backend-id resolution and profile lookup for GitHub Copilot profiles, stream reconnect delay backoff/cap, backend-neutral goal slash-command parsing, and backend-neutral goal timestamp/elapsed/status/action/stale-snapshot/local-runtime-preservation plus accidental copied goal-card objective cleanup helpers. |
| `test/mobileSendPipeline.test.ts` | React-mounted mobile send hook coverage: delayed input acknowledgements preserve and allow answering a subsequent question or replacement plan; successful answers clear the submitted interaction; `mode:'message'` answers are sent before the cleared card re-renders, while a newer card still blocks them; input delivery failures retain it for retry. |
| `test/mobileChatStreamEvents.test.ts` | Pure Mobile PWA stream-event projection coverage: open-chat action lists for text/thinking placeholders, assistant-message upsert and stream-text reset, plan/question pending interactions and notifications, title/usage/goal/error/done/replay handling, conversation-list action projection for assistant/title/goal/error/done/tool frames, conversation-list patching from assistant messages, and the `decisionBound` card flag plus outcome completion candidates. |
| `test/adrLint.test.ts` | ADR lint smoke coverage: runs `scripts/adr-lint.js` against the repository ADR set so current ADRs keep valid frontmatter/sections/live `affects` paths, historical-tagged ADRs can retain archived references to files that were removed later, and retired path prefixes such as `public/v2/` remain individually exempt without disabling validation for other paths in the same ADR. |
| `mobile/AgentCockpitPWA` | Mobile PWA type/build coverage, run with `npm run mobile:typecheck && npm run mobile:build` from the repository root: validates the Vite React client, same-origin API client, CSRF-backed REST calls, WebSocket URL construction, extracted stream/list monitor hooks and automatic replay reconnect after transient mobile socket loss, extracted send pipeline and queue-drain wiring, sanitized assistant Markdown/GFM rendering dependencies including wrapped code-block copy controls, extracted browser file upload progress/cancel/OCR wiring, queue edit/reorder state, file delivery and generated-artifact preview/share wiring, sessions, session-reset state replacement/list refresh, extracted run-selection state, Claude Code Mode, Codex speed, and backend-neutral goal selection/action payloads, workspace explorer mutation calls, visual-viewport shell code including iOS keyboard focus pinning and idempotent viewport metric updates, and generated `/mobile/` static shell. |
| `test/graceful-shutdown.test.ts` | Server shutdown on SIGINT/SIGTERM. Spawns `server.ts` through Node with tsx's loader, `NODE_ENV=test`, and an isolated `PORT` so the developer `.env` cannot clobber the child process onto a PM2-owned port; asserts that the server logs signal receipt and HTTP close, and tolerates a matching signal-style exit code if the runtime reports one. |
| `test/logger.test.ts` | Structured logger coverage: level filtering, child logger bindings, recursive metadata redaction for credential-like keys, cycle-safe metadata emission, rich value serialization (`Error`, `bigint`, functions, symbols), bounded strings/arrays/objects, and console method routing for error/warn/info/debug. |
| `test/sessionStore.test.ts` | Session file-store persistence |
| `test/updateService.test.ts` | Version comparison, status, trigger guards, interval management, dev self-update sequencing for root install, mobile install, V2 web build, mobile PWA build, interpreter verification, and PM2 restart; production GitHub Release version checks, checksum verification, macOS/Linux tarball extraction, strict Linux artifact selection with missing Linux tarball rejection, Windows ZIP extraction, required Node runtime verification, macOS private Node runtime upgrade before `npm ci`, Linux private Node x64 `tar.xz` runtime installation before `npm ci`, Windows private Node ZIP runtime installation, incomplete recorded Windows private-runtime repair before `npm ci`, Windows private-runtime npm execution through `node.exe node_modules/npm/bin/npm-cli.js`, Windows `npm.cmd` dependency/build command resolution through quote-protected `cmd.exe` for non-private runtimes, migration of system-Node installs to a private runtime when the required major increases, root/mobile `npm ci`, release build preflight, macOS/Linux `current` symlink switch, Windows versioned `appDir` activation, parseable Windows PM2 config with paths containing spaces, hidden Windows PM2 runner generation, dotenv-safe Windows private-runtime `PATH` persistence with `<installDir>\cli-tools` before the private runtime, Windows production self-update repair of the current user's `Path` for `<installDir>\cli-tools` and existing Agent Cockpit-managed CLI wrappers when package entrypoints are present, install-manifest update, POSIX and PowerShell health-check rollback scripts with checked PM2 native-command execution, POSIX startup repair of stale non-executable restart scripts, Windows update restart health parsing that requires `/api/chat/version.version` to match the target release, Windows app-local `pm2.cmd` use for both target and rollback releases instead of `npx pm2`, Windows rollback reuse of the previous recorded runtime, and checksum-failure no-switch behavior; web/mobile install or build failure returns a failed update without restart; PATH setup for restart, configured data-root restart script/log placement, plus standalone `restart()` method (in-progress/active-streams guards, script + double-fork/detached launch shape, does not call git/npm). |
| `test/cliUpdateService.test.ts` | Local CLI update service: semver parsing/comparison, npm-global Codex detection via resolved command path under `npm root -g/@openai/codex`, OpenCode profile target inclusion with `opencode upgrade` self-update support, GitHub Copilot profile target inclusion that exposes its self-updater, native Grok version/update JSON checks with isolated account homes excluded from shared executable updates, Windows installer-managed Codex detection through `<installDir>\cli-tools\node_modules\@openai\codex\bin\codex.js` plus `node.exe`, Windows npm update commands that keep `--prefix <installDir>\cli-tools`, Windows post-update repair of Agent Cockpit-managed Codex terminal wrappers so npm updates do not reintroduce `node.exe` PATH dependency, update-available status, supported update command execution (`npm i -g @openai/codex@latest`), post-update re-probe, active-stream guard, and shared Claude Code CLI rows carrying Claude Code Interactive compatibility/update-caution metadata without creating a duplicate physical update target. |
| `test/claudeInteractiveReleaseCheck.test.ts` | Scheduled Claude Code Interactive release monitor coverage: reads the tested Interactive version from `CLAUDE_CODE_INTERACTIVE_TESTED_CLI_VERSION`, compares it with `npm view @anthropic-ai/claude-code version`, skips GitHub when current, creates a support-validation issue when npm has a newer version, embeds a hidden per-version marker, and dedupes against an existing open issue before creating another one. |
| `test/auth.test.ts` | `requireAuth` middleware: unauthenticated `/api/*` returns JSON 401, unauthenticated non-API paths redirect to `/auth/login?next=<original path>`, authenticated passthrough, localhost bypass for both API and non-API paths. **setupAuth routes:** `/auth/login` redirects to `/auth/setup` before a local owner exists, renders the first-party password/passkey login after setup, omits third-party provider buttons by default, carries `?popup=1` as a hidden first-party login mode field, preserves safe same-origin relative `next` paths through password/recovery forms, and ignores unsafe absolute `next` values; `/auth/setup` renders first-run setup, allows localhost owner creation without token, requires `AUTH_SETUP_TOKEN` for remote setup, signs the owner in after creation, immediately accepts the redirected session cookie on authenticated API routes, and redirects to `/v2/?welcome=1`; `/auth/login/password` rejects bad credentials, logs valid owner credentials in with `provider: 'local'`, redirects to safe `next` paths for mobile PWA return, falls back to `/` for unsafe `next`, and blocks password-only login when `passkeyRequired` is true; passkey store/API coverage lists, renames, guards unsafe deletion, generates registration options, and rejects login options when no passkeys exist; `/auth/recovery/login` consumes a recovery code once and honors safe `next` redirects; `/api/auth/recovery/regenerate` returns plaintext one-time recovery codes and status; `/api/auth/policy` rejects unsafe passkey-required enablement; `LocalAuthStore.resetOwnerAccess` updates password and regenerates recovery codes; `/api/auth/status` reports setup-required, provider capability, passkey count, policy, and recovery state; `/auth/denied` renders denied page with email and allowed-email info, 200 HTML, passes basePath; `/auth/logout` destroys session and redirects to `/auth/login`, handles session destroy errors gracefully, redirects to basePath-prefixed login; legacy OAuth routes are absent by default and register only when `AUTH_ENABLE_LEGACY_OAUTH=true`; **`/auth/popup-done`** returns 200 HTML that posts `{ type: 'ac-reauth-ok' }` to `window.opener` via `postMessage` with `window.location.origin` as the target origin, then calls `window.close()` so the popup self-destructs after the parent tab clears its stale session banner. **`meHandler` (`GET /api/me`)** — unauthenticated non-local request returns JSON 401, authenticated request returns `{ displayName, email, provider }` for local/Google/GitHub users, localhost-bypass request with no user object returns `200` with all three fields set to `null` so the v2 sidebar footer can render a neutral placeholder. |
| `test/localAuthStore.test.ts` | Direct first-party `LocalAuthStore` coverage with real temp `owner.json` files and real scrypt: owner creation identity normalization, password hashing, duplicate-owner and invalid-input `LocalAuthError.code` checks, POSIX auth-dir/file modes, missing-owner errors, normalized password verification, unsupported hash handling, corrupt/invalid state-file behavior, optional policy/passkey/recovery-array normalization, recovery-code count validation, plaintext recovery-code generation with hashed persistence, normalized single-use recovery login that disables passkey-required policy, passkey creation/name/transport validation and normalization, newest-first listing, lookup/rename/usage/delete null paths, unsafe passkey-required policy guards, blocked last-passkey deletion, and `resetOwnerAccess()` credential/policy/recovery-code replacement. |
| `test/claudePlanUsage.test.ts` | `ClaudePlanUsageService` (cached Claude Code chip tooltip snapshot): credential resolution (default file, macOS Keychain fallback, profile `configDir` isolation), OAuth fetch headers (`Authorization`, `anthropic-beta`, `Accept`, Claude Code `User-Agent`), snapshot provenance (`source`, `identity`, bounded `attempts`), unknown/null rate-limit bucket preservation including `extra_usage.currency`, refresh throttle/in-flight coalescing for both default and per-profile caches, profile-cache hydration from `data/claude-plan-usage/*.json`, empty stale snapshots for unknown profile caches, disk persistence and corrupt-cache recovery, default-cache behavior for plain server-configured Claude profiles, profile-specific cache isolation, per-profile throttle independence, token-expired retry-throttle behavior and attempt-history capping, composed OAuth+CLI failure diagnostics, CLI fallback success when OAuth credentials/scopes are unavailable, and `parseClaudeCliUsageOutput` coverage for `/usage` session/weekly/model windows including Sonnet, remaining-vs-used percentages and clamping, relative/month/day/time-only/unparseable reset strings, null usage/identity output, and `/status` identity. |
| `test/codexPlanUsage.test.ts` | `CodexPlanUsageService` (cached OpenAI Codex account usage snapshot for the Codex chip tooltip): `init` loads the empty shape when no cache file exists, restores a previously-persisted snapshot on boot, and tolerates a corrupt cache file without throwing; `getCached` returns the in-memory snapshot with `stale` derived from `Date.now() - fetchedAt > STALE_AFTER_MS` (true when `fetchedAt` is older than 15 min, false when recent); `maybeRefresh` prefers direct OAuth usage from an isolated test `CODEX_HOME/auth.json`, sends bearer + `ChatGPT-Account-Id` headers to `/backend-api/wham/usage`, refreshes stale OAuth token bundles through `auth.openai.com/oauth/token`, writes refreshed tokens back to `auth.json`, and normalizes the OAuth response into `{ account, rateLimits }` without spawning; app-server fallback uses a fake `codex -s read-only -a untrusted app-server` proc whose stdin/stdout speak newline-delimited JSON-RPC, drives `initialize` → `account/read` + `account/rateLimits/read`, normalizes both into `{ account, rateLimits }`, writes the snapshot to `<data-root>/codex-plan-usage.json` via `atomicWriteFile`, and kills the proc when finished; plain server-configured profiles share the default cache instead of creating a separate `server-configured-codex.json`; profile refreshes spawn the profile command with merged env and `CODEX_HOME`, keep the default cache untouched, and persist under `<data-root>/codex-plan-usage/<profile-id>.json`; custom data-root path ownership is covered; respects the `REFRESH_MIN_INTERVAL_MS` 10-min floor (second call within the window is a no-op); coalesces concurrent calls via a shared in-flight promise (three parallel `maybeRefresh` calls only spawn once); records `lastError: 'codex app-server unavailable: …'` when the spawn fires `ENOENT` (no `codex` on `PATH`); records the verbatim RPC error message and preserves the prior snapshot when `account/rateLimits/read` returns an unrecoverable RPC error; recovers usage/credits/account identity from RPC errors containing a `body={...}` ChatGPT usage payload; normalizes weekly-only windows into the secondary slot and reversed weekly/session windows back into session-primary/weekly-secondary order; per-RPC timeouts kill the app-server and surface `codex RPC timed out waiting for <method>`; normalizes a missing `account` key as `null` without crashing; normalizes a missing `rateLimits` key as `null` without crashing. |
| `test/kiroPlanUsage.test.ts` | `KiroPlanUsageService` (cached `AmazonCodeWhispererService.GetUsageLimits` snapshot for the Kiro chip tooltip, built against a real SQLite auth DB seeded by the `createKiroDb(dbPath, opts)` helper): `init` loads the empty shape when no cache file exists and restores a previously-persisted snapshot on boot; `getCached` returns the in-memory snapshot with `stale` derived from `Date.now() - fetchedAt > STALE_AFTER_MS`; `_refresh` happy path opens the DB read-only (`kirocli:odic:token` + `api.codewhisperer.profile` rows), POSTs to `https://q.us-east-1.amazonaws.com/?profileArn=…&origin=KIRO_CLI` with JSON-1.0 headers + bearer token, normalizes the response into `KiroUsageData`, writes it to `<data-root>/kiro-plan-usage.json`, and flips `stale` false; custom data-root path ownership is covered; `maybeRefresh` respects the `REFRESH_MIN_INTERVAL_MS` 10-min floor (tracked on *attempt*, not success); in-flight coalescing (concurrent `maybeRefresh` calls share the same promise); token-expired guard (refuses to fetch when `expiresAt - now < EXPIRY_BUFFER_MS = 30s`, sets `lastError: 'token-expired'` without hitting the network); token-expired skip does not burn the 10-min throttle (a follow-up `maybeRefresh` after kiro-cli rotates its token issues a fresh fetch immediately); DB-missing error path (`{fileMustExist:true}` + empty temp dir surfaces `kiro-cli DB unavailable at <path>: …` while preserving any prior snapshot); missing `auth_kv` token row → `kiro-cli auth_kv missing access token`; missing `state` profile row → `kiro-cli state missing profile`; HTTP 401 preserves prior `fetchedAt`/`usage` and sets `lastError` to `GetUsageLimits 401: …`; network error preserves prior snapshot with verbatim error message in `lastError`. |
| `test/utils.atomicWrite.test.ts` | `atomicWriteFile` (`src/utils/atomicWrite.ts`): writes a new file; replaces an existing file in full; 20 concurrent writers converge to one parseable JSON payload (no torn byte-interleaving); cleans up the sibling `.tmp.` file when `rename` fails (e.g. missing parent dir); 50 parallel reads concurrent with an atomic write only ever observe one of the two valid payloads, never a partial mix. |
| `test/utils.keyedMutex.test.ts` | `KeyedMutex` (`src/utils/keyedMutex.ts`): same-key operations run sequentially in FIFO order (proven by interleaving deferreds and flushing microtasks via `setImmediate`); different keys run concurrently; `run` returns the value produced by `fn`; a thrown error in one call does not block subsequent calls on the same key; a synchronous throw inside `fn` still rejects `run()` and releases the lock; the internal `_tails` map entry is removed once the chain drains and remains present while work is pending; serialized read-modify-write on a shared counter across 50 concurrent `run` calls reaches the exact expected total (no lost updates). |
| `test/chatService.concurrency.test.ts` | Regression guard for the Apr 2026 workspace `index.json` corruption bug (concurrent `fsp.writeFile` → byte-interleaved file → JSON.parse crash loop). Against a real `ChatService`: 30 concurrent `createConversation` calls on one workspace all persist, the final index parses cleanly, and every returned id is present; 20 concurrent `renameConversation` calls across distinct conversations in one workspace all retain their new titles; interleaved creates + renames on the same workspace converge with the correct conversation count and the seed entry's title matching one of the issued values (proves no torn mix); two different workspaces run concurrent writes without cross-contamination (per-hash `_indexLock`, not a global lock); 100 parallel readers against the live `index.json` during 20 concurrent writes never observe a torn file. |

KB vNext entry-lineage coverage includes `test/knowledgeBase.db.test.ts` assertions for `kb_entry_sources` insert/list joins, raw-delete cascade, entry-delete/redigest cascade, and migrated DB availability. `test/knowledgeBase.digest.test.ts` covers exact-slug duplicate merge, normalized-title duplicate merge, non-duplicates remaining separate, merged entries retaining multiple source ranges and combined body content, merged multi-node chunks storing `nodeId: null`, redigest clearing old lineage, redigest interrupted-file-replacement recovery, and gleaning duplicate suppression.

KB glossary coverage includes `test/knowledgeBase.glossary.test.ts` for whole-word/case-insensitive expansion and longest non-overlapping overlap resolution, `test/knowledgeBase.db.test.ts` for `kb_glossary` CRUD and case-insensitive uniqueness, `test/chat.kb.test.ts` for glossary REST create/list/update/delete plus validation/duplicate errors and disabled/unknown workspace gating before DB open, and `test/kbSearchMcp.test.ts` for applying expanded queries to `search_entries` and `search_topics` with `expanded_query` trace output.

KB counter coverage in `test/knowledgeBase.db.test.ts` includes `failedByStage`: failed raws without `kb_documents` count as conversion failures, failed raws with `kb_documents` count as digestion failures, and the defensive unknown bucket stays zero for classified rows.

KB digestion coverage in `test/knowledgeBase.digest.test.ts` includes text-budget-aware chunking for large structured Markdown/DOCX-style sources and timeout classification for Kiro/Bedrock `TimedOut` stream errors.

KB graph-neighborhood coverage includes `test/kbSearchMcp.test.ts` for `get_topic_neighborhood`: bounded undirected BFS with directed path output, default speculative-edge exclusion, opt-in speculative confidence, optional assigned entries, god-node score penalty, cycle de-duplication, and clear missing-topic errors.

Workspace Context no longer has a diagnostic graph-report command. Run history is stored in `workspaces/{storageKey}/workspace-context/state.json` and human-readable CLI run reports are written under `workspaces/{storageKey}/workspace-context/runs/`.

Current stream recovery coverage includes:

- `test/chat.websocket.test.ts`: decision answers without a live stream fall back to message mode unless the conversation's adapter reports `decisionsRequireActiveTurn` (then `409`), active CLI streams survive longer than the old disconnect grace period, reconnect replay still works, explicit `{ type: 'reconnect' }` replays buffers created after the WebSocket connection opened, live-only `kb_state_update` frames are not replay-buffered, memory delete fan-out reaches idle connected conversations in the same workspace, completed replay buffers use the configured cleanup timeout after replay, legacy WS abort clears stale buffered frames and persists a durable abort `streamError`, connected-at-done replay buffers self-clean, and disconnected terminal errors replay as `assistant_message` + `error` + `done`.
- `test/chat.rest.test.ts`: `/active-streams` returns both compatibility `ids` and operational `streams[]` details from runtime streams and durable accepted/preparing jobs, including `runtimeAttached`, `pending`, and recorded backend `runtime` identifiers; `GET /backends` exposes backend `resumeCapabilities`; `GET /install/status` returns install manifest status from `InstallStateService`; `GET /install/doctor` returns install doctor status; `POST /install/welcome-complete` delegates to `InstallStateService.markWelcomeCompleted`; `POST /install/actions/:id/run` delegates to `InstallDoctorService.runInstallAction` with the active-stream guard; `GET /cli-updates` returns the cached CLI update snapshot and `POST /cli-updates/:id/update` delegates with the active-stream guard; `POST /conversations/:id/abort` cancels active streams without requiring an open WS, cancels pending sends before the backend adapter starts, persists a durable abort `streamError` for the accepted user message, remains idempotent after natural completion, coalesces concurrent abort requests without duplicate backend abort calls or duplicate durable `streamError` messages, and does not replace an already-finalizing backend terminal error with a late abort; durable jobs are created during the pre-stream setup window and removed after completion/abort; stream supervisor cleanup aborts and detaches active runtime streams for archive/delete while clearing durable jobs; graceful shutdown marks active jobs finalizing with `Interrupted by server shutdown` for startup reconciliation; startup reconciliation marks unrecoverable active jobs interrupted without re-sending prompts and is idempotent when the interruption marker already exists; reset/archive/delete reject while a send is still pending; update/restart guards include pending sends; `POST /message` returns `409` while a stream is active or another send is still preparing, does not persist a duplicate user message, does not mutate backend/model/effort state on duplicate sends, and concurrent POSTs start only one stream.
- `test/chat.streaming.test.ts`: terminal stream errors persist durable `Message.streamError` records, preserve partial assistant output first, synthesize `done` when the backend exits without one, run stream cleanup before emitting client-visible `done`, break out of the stream loop even when the backend iterator would otherwise hang, ignore non-terminal warning frames for durable error persistence, and convert internal `session_recovery` events into friendly persisted system messages with diagnostic metadata and a refreshed recovery snapshot that excludes the current failed turn.
- `test/processStream.golden.test.ts`: direct `processStream` traces guard the ordered browser frame contract and persisted assistant `contentBlocks` without the Express/WebSocket harness, including result-only persistence and synthetic plan approval from plan-file writes.
- `test/streamFrameReducer.test.ts`: pure reducer traces cover desktop browser state transitions and declarative effects for replay, placeholders, interactions, assistant replacement, goals, live-only workspace updates, unread marking, and queue draining without timers, sockets, browser APIs, or `AgentApi`.
- `test/streamStore.test.ts`: active stream hydration sets `streaming: true`, active goals keep the sidebar row in the streaming/blue state after the current backend turn's `done`, paused goals remove that goal-derived streaming state, stale replayed `goal_updated` frames cannot overwrite newer goal state, final assistant messages clear stale replayed plan approval state, `setGoal` shows an immediate optimistic goal strip and upserts the returned server goal-event message, `refreshGoal` preserves the local active runtime goal when backend status temporarily returns `null`, goal-event messages do not replace assistant streaming placeholders, goal-only streams remove empty placeholders on done, `load()` and stale-stream refetch rehydrate active `streamError` from the final persisted assistant `streamError` message, older historical `streamError` messages followed by normal conversation activity stay historical, durable stream-error refetch pauses queue draining, non-terminal warnings do not flip `uiState` to `error`, failed WS opens clear stale socket state for retry, unexpected active WS close reconnects, `stopStream` uses REST abort even with a closed WS and refetches durable abort messages so optimistic placeholders are removed, normal-send `409` rolls back optimistic placeholders into active-stream state, and queued-send `409` restores the original queued item with attachments intact while preserving edits made to later queued items during the in-flight send.

## CoCo Phase 0 Native Research

CoCo is not yet a registered harness. `scripts/probe-cortex-phase0.ts` is an
opt-in research runner, separate from normal Jest/CI and from the planned
production adapter compatibility suites. It requires macOS, Cortex Code 1.2.35,
`CORTEX_PHASE0=1`, and `CORTEX_TEST_CONNECTION` naming an authenticated shared
Snowflake connection. Run it through `./node_modules/.bin/tsx`; optional
`CORTEX_TEST_COMMAND` and `CORTEX_TEST_MODEL` select command/model. Native
`CORTEX_ACP_TEST_MODE=1` is rejected because it cannot establish real inference.

The runner uses real inference and synthetic temporary workspaces to verify
clean ACP startup/instruction delivery, cancel/session reuse, cleanup after root
death without killing an unrelated process, denied read/write with an unmatched
allowlist, and inference failure from an empty Snowflake home. Expected lack of
strict zero-tool support is reported as a capability gate, not a successful
restricted processor. A private temporary summary records CLI/OS/Node/revision/
dirty state without connection names, raw stderr, OAuth data or credentials.
Existing Grok transport/process helpers are research scaffolding only and are
not production CoCo dependencies. This probe does not test Cockpit routes/UI,
actual Memory/KB/Context/Routine services or native Windows/Linux behavior.

Seven sanitized ordered native wire excerpts live in
`test/fixtures/cortex/1.2.35/`, with provenance and scope in their README. They
preserve protocol shapes for future adapter tests; they are not runnable mocks
or current application acceptance. Results and the exact invocation are in
[the research report](research/cortex-code-acp-evaluation.md#phase-0-follow-up--2026-11-05).
See [Proposed ADR-0099](adr/0099-integrate-cortex-code-through-its-native-acp-interface.md)
and [the implementation tracker](design/cortex-code-implementation-plan.md).

## CoCo P2 Native Runtime Smoke

`scripts/probe-cortex-runtime.ts` uses CoCo's dedicated runtime/session/transport/
process modules. It is opt-in and separate from normal Jest/CI, browser checks
and the future complete adapter compatibility suite. Run:

```sh
CORTEX_RUNTIME_PROBE=1 CORTEX_TEST_CONNECTION='<existing authenticated connection>' \
  ./node_modules/.bin/tsx scripts/probe-cortex-runtime.ts
```

Requires macOS, Cortex Code 1.2.35 and real saved authentication. Optional
`CORTEX_TEST_COMMAND` and `CORTEX_TEST_MODEL` override the native command/model;
default model is `claude-sonnet-4-6`. Reject pre-enabled ACP fake-agent test mode.
Production runtime resolution also forces fake mode off. All file/shell work
uses private temporary fixture workspaces; the tested profile deliberately
reuses the intended shared terminal authentication. No application server is
started and no production Memory/KB/outreach is exercised.

The smoke asserts exact inference markers plus usage, native cancellation and
subsequent turn, saved session load in a fresh process, child cleanup after root
SIGKILL while unrelated work survives, no delayed sleeper write, empty-home
inference failure despite successful session creation, no waiting browser wizard,
and a fresh runtime after reusable shutdown. Reverse tool permissions are
explicitly approved only inside this opt-in fixture runner. Normal foundations
deny unowned reverse requests.

The private 0700 temporary root retains a 0600 report with CLI/OS/Node/revision/
dirty evidence and assertion booleans, without raw protocol, connection/account,
stderr or OAuth values. Failures print only error type. On November 6, 2026,
CoCo 1.2.35 / macOS arm64 / Node 26.0.0 passed every scenario against revision
869ee8a plus the P2 working tree. A compact result is also recorded in the
implementation tracker. This certifies the tested runtime paths, not adapter
event correctness, durable Cockpit chats, browser/mobile behavior, native Linux/
Windows, full isolation, strict zero-tool execution or delegation finalization.

## CoCo P3 Native Event Acceptance

Run the internal bridge against the real authenticated CLI:

```sh
CORTEX_EVENTS_PROBE=1 CORTEX_TEST_CONNECTION='<existing authenticated connection>' \
  ./node_modules/.bin/tsx scripts/probe-cortex-events.ts
```

`scripts/probe-cortex-events.ts` requires macOS and CoCo 1.2.35; optional
`CORTEX_TEST_COMMAND` selects its executable. It refuses fake-agent mode. The
probe uses claude-sonnet-4-6 in private temporary workspaces and exercises the
actual CortexTurn/decoder/interactions/configuration/attachment/artifact modules.
It verifies catalog discovery and low-to-auto reset; write/read plus explicit
FILE_DELIVERY and byte-preserving ArtifactStore persistence; two sequential
questions including typed free form and rejected duplicate responses; plan
revision then approval, with the output file absent at both gates; and explicit
PNG input whose blue square/green circle are identified by actual inference.
Every successful turn reports final usage once. The fixture permits a final
newline in generated text and verifies persisted bytes against the actual file.
It never retries interrupted tool work.

The empty-home case separately checks missing-catalog rejection of configured
chat and actual unconfigured native inference failure. The latter exercises the
retained connection-error classifier with no model override and no tool approval;
it is an explicit probe, not a fallback execution path in CortexTurn. API 408 is
tested from the sanitized native fixture, not induced against a live service.
RPC failures, timeouts, missing/partial counters, arbitrary paths, unknown
models/formats and duplicate callbacks are deterministic tests.

On November 6, 2026 all native scenarios passed on CoCo 1.2.35 / macOS arm64 /
Node 26.0.0, revision 549f111 plus the P3 working tree. A private 0700 temporary
root retains a 0600 summary with platform/version/revision/dirty state and
assertion booleans. It excludes raw account/connection data, protocol, stderr,
OAuth values and transcript text. No production Cockpit server, real Memory/KB
services or outreach is used. This is not yet an adapter/desktop/mobile/native
Windows/Linux compatibility suite; durable chat and UI remain P5/P7.

The six P3 Jest suites contain 30 tests. They include existing conversation
upload/queue/artifact/preview/download and ledger storage without registering a
CortexCodeAdapter. Whole app/native UI acceptance is separate; normalization
fixtures do not certify a processor role or native image generation.

## Cortex mobile media/history acceptance (P7 C46)

Run after building web/mobile, separately from asset-mutating full Jest:

```sh
CORTEX_MOBILE_PROBE=1 CORTEX_TEST_CONNECTION=<saved-connection> \
  npx tsx scripts/probe-cortex-mobile.ts
```

The opt-in macOS/CoCo 1.2.35 runner starts only an isolated PM2/data/workspace
fixture, uses shared terminal auth and production Chromium assets at 390×844.
It selects a different configured profile, Sonnet 4.6/medium, checks hidden
Goal/Fast/Ultracode and rejects a valid unsupported Goal request. It uploads real
PNG/text files, rejects Auto image OCR before inference, runs native OCR with
selected model/effort (while stored chat still says Auto), and verifies cache
reuse without another native request. A dedicated native chat turn reads the
image/text before the CSV fixture exists. A second turn reviews and runs a
syntax-checked bounded Python gate, renders thinking/tools, survives
socket replay, and delivers an explicit artifact. Changing the source CSV must
not change the preview or actual downloaded bytes. The runner reloads, checks
profile locking, resets and reads old session/artifact history (including actual
preview-dialog Close clicks above the read-only screen), then Stops a
bounded descendant and verifies its final file is absent and only one attempt
ran. A fresh reply proves recovery without prompt/tool replay. The ten-minute
external deadline closes Chromium; PM2 allows twenty seconds for cleanup.
Reports contain CLI/OS/Node/revision/dirty and sanitized flags; failure text and
screenshots remain in private temp directories. Model refusal ends a fixture
gate check promptly rather than being retried by the application.

C46's matrix also uses the real C43 interaction probe for questions, free text,
revision/rejection/approval and stale IDs, C44 for queue semantics, and C45 for
usage/restart/ledger. None certifies physical iOS/Android/Safari, native Web Share,
Windows/Linux, C26's human setup handoff, or strict Memory. New deterministic
attachment/selection suites and extended contract/route/store/policy/CoCo
integration tests cover the associated selection and late-response fixes. The
integration trace requires low then medium native effort configuration and fresh
storage restoration; other harness effort normalization remains covered.

## Cortex usage display and persistence (P7 C45)

`test/cortexUsageUi.test.ts` renders desktop CoCo cards and mobile `usageBar.tsx`,
checks missing/zero context, all four token buckets (including zero caches),
unknown-vs-reported-zero cost and existing Claude/Interactive/Codex/Kiro/Grok
reported/estimated formatting. It tests shared browser-safe usage projection
and pure period/model/service-tier aggregation, including mixed priced/unpriced
ledgers. This replaces the mobile source-string usage test. The profile-editor fixture
loads the new projection dependencies and renders standalone/mixed Usage
settings, retaining unknown CoCo prices, known estimates and cached-token chart totals. CoCo HTTP/WS
integration adds nonzero cache/context fixture counters, two-turn event totals,
fresh ChatService restoration, daily ledger agreement and replay without another
native prompt or duplicate accounting. Existing pricing/usage ledger suites
remain the calculator/storage regression checks.

Run the native probe separately from asset-mutating full Jest, after building
both clients:

```sh
CORTEX_USAGE_PROBE=1 CORTEX_TEST_CONNECTION=<saved-connection> \
  npx tsx scripts/probe-cortex-usage.ts
```

This opt-in macOS/1.2.35 probe uses shared terminal credentials and isolated
PM2/data/workspace fixtures. It selects Sonnet 4.6/low through each client,
asserts outgoing model/effort, makes two native prompts per client and compares
live usage, tooltip/breakdown, fresh-page values, exact cache totals and unknown
prices with REST. Replay events are excluded from live-event counts; persisted
usage must remain unchanged. It restarts only its fixture PM2 app and verifies
both clients and daily ledger totals again. Desktop Usage settings must show
unpriced totals/table prices and an honest empty cost-chart explanation.
Conversation auto-title changes are resolved before selecting a reloaded row.
The six-minute external deadline closes Chromium; PM2 permits twenty seconds
for owned shutdown. Temporary reports include CLI/OS/Node/revision/dirty state,
numeric usage and success flags; screenshots, failure details and fixture
configuration remain in private temp directories. Never print/share auth config.
This certifies C45 scope only; C26, strict Memory, C46/C47 and platform gates
remain independent. Mobile PWA manifests/service worker/auth policy do not change.

Native acceptance on November 7 local / November 8 UTC passed in
`cockpit-cortex-usage-xaTzNR/report.json` under system temp: four native prompts,
exact both-client totals after reload/PM2 restart, n/a Snowflake costs and a
reconciled ledger (20 input, 573 output, 187806 cache read, 14426 cache write).
Desktop/mobile/Usage settings screenshots were inspected; shared auth was
retained and the fixture PM2 app removed. Earlier failed runner expectations
were a stale auto-renamed title and mobile's sub-10-percent precision, recorded
in the tracker; they are not product compatibility passes.

C45's shared summary markup preserves the 80 KiB Settings chunk limit. Total
JS allowance increases from 913 to 914 KiB; CSS/index/other chunk limits remain.

## Cortex queued input, abort and reconnect (P7 C44)

Normal coverage adds `test/cortexQueueUi.test.ts` for the actual mobile send
pipeline: duplicate enqueue exclusion, save-failure/new draft/upload retention,
latest-render draining, intervention by question/conversation change, explicit
resume after interruption and synchronous Stop suspension. New
`test/mobileStreamOwnership.test.ts` exercises the actual mobile connection hook
with controlled sockets/timers: reconnect ownership, matching versus stale CoCo
outcomes, superseded socket rejection and terminal cleanup without a new prompt;
unflagged cards survive matching outcomes and stream end. Desktop store tests
cover replayed decision completion (decision-bound cards only), pending-question send
protection, queue preservation after abort, scheduled-send races and suspension
before cancellation finishes. `test/cortexIntegration.test.ts` checks actual
HTTP/WS input rejection during native work/after cancellation, persisted queues,
exactly one native prompt and one original user message. Existing C43/reducer/
mobile projection/pipeline tests remain aligned. The Claude Interactive browser
abort case now checks Stop with a nonempty retained draft; its known native
startup limit and Grok's model/auth limit from C43 remain unverified here.

Build both clients before this opt-in paid native check:

```sh
CORTEX_QUEUE_PROBE=1 CORTEX_TEST_CONNECTION='<saved-name>' npx tsx scripts/probe-cortex-queue.ts
```

The runner requires macOS and CoCo 1.2.35, seeds isolated data/workspace/profile,
serves production assets with PM2, selects Sonnet 4.6/low through each client and
asserts the outgoing selection. Native Python fixtures are bounded by two-minute
file gates. Each client exercises one question/queue flow and one abort/resume
flow: retained draft through a disabled question and socket reconnect, held input
HTTP acknowledgement after native completion, rejection of the closed decision,
matching completion replay, persisted queue, one native script attempt, one
queued prompt and preserved newer unsent draft. Stop must drain the owned Python
descendant, leave its final file absent, pause the queue, retain it across a fresh
page and resume only on explicit user action. Real native inference after abort
must not rerun interrupted tools. Reports retain only sanitized flags/stages and
CLI/OS/Node/revision/dirty evidence, with private failure diagnostics; the external
eight-minute deadline closes the browser and PM2 allows twenty seconds to drain.
Shared terminal auth stays intact. Run asset-mutating full Jest separately, then
rebuild desktop/mobile assets. This certifies C44 scope, not C26, native steering,
mobile full-reload draft persistence, C45–C47/P9 or Windows/Linux acceptance.

The November 7 local / November 8 UTC native C44 report
`cockpit-cortex-queue-NIIXq0/report.json` under system temp passed all four flows.
The first run passed desktop queueing but exposed the older-refresh/abort race;
its automatic queued send is retained as failed evidence. The corrected run
paused before cancellation and drained native descendants. The existing C43
interaction probe also passed (`cockpit-cortex-interactions-wwZkRe/report.json`)
with revised plans and approvals on both clients. An earlier interaction recheck
stopped at a missing Model selector before inference; no result is inferred from
that attempt. Failure artifacts now include private UI text as well as the stack,
while summary reports remain sanitized. All owned PM2 fixtures were deleted.

C44 adds approximately 0.5 KiB of desktop JS for role guidance, Stop availability,
decision completion and queue guards; the aggregate budget moves from 912 to
913 KiB. Per-screen/index/CSS limits stay unchanged; verify actual production
output with `npm run web:budget`.

## Cortex desktop/mobile interaction controls (P7 C43)

The normal rendered tests listed above exercise the cards and actual reply
orchestrators with deferred HTTP responses; deterministic native interaction and
HTTP/WS integration suites continue to cover generation IDs and exact
approve/revise/reject/option/free-form outcomes. A new sanitized `plan-entry.json`
captures the separate native approve/decline entry schema; interaction tests
verify chat entry without execution and restricted/headless/unknown rejection.
The Claude Interactive native UI suite adds an assertion that revision
controls remain absent; it is reviewed/aligned here, not a new real-Claude CLI
version compatibility claim.

Build both clients, then opt in with:

```sh
CORTEX_INTERACTION_PROBE=1 CORTEX_TEST_CONNECTION=<saved-name> npx tsx scripts/probe-cortex-interactions.ts
```

This macOS/CoCo 1.2.35 probe serves real production assets from an isolated
PM2/data/workspace fixture and retains shared terminal credentials. It selects
the verified Sonnet 4.6/low pair through both clients (asserted in outgoing message
requests), answers sequential questions
with custom text and an option, requests a revised plan, checks fresh decisions,
rejects old/duplicate REST replies and verifies no file exists before approval.
Separate rejection conversations verify nonexecution whether native planning
finishes in text or returns to another approval gate; any remaining live turn is
explicitly stopped and drained. Each conversation has one original user prompt,
so replies cannot silently become prompt resends. The external eight-minute
deadline closes the owned browser; PM2 allows twenty seconds for native shutdown.
Only sanitized stages/booleans/version/revision/platform evidence go into the
private temp report; failures keep a private diagnostic file. This is interaction
acceptance only, not C26's human OAuth, full C44–C47/P9 or Windows/Linux evidence.

The November 7 native run passed, with private evidence under system temp at
`cockpit-cortex-interactions-MVtAcg/report.json`. The PM2 fixture was deleted and
shared credentials were retained. Scoped existing-harness UI attempts do not
count as passes: Claude 2.1.318 exited code 1 before SessionStart/plan handling
(the serial question case did not run). Grok 1.0.52 could not select the suite's
4.7 model from the available fallback catalog; a temporary 4.6-scoped copy then
reported Authentication required before questions. The temporary test copy was
removed. Native compatibility for these environments remains unverified;
rendered policy/ownership regression coverage passed. No Claude/Grok protocol,
credentials or production model policy was changed to obtain a pass.

## Cortex desktop profile controls (P7 C42)

The rendered selection/editor and browser API cache suites listed above replace
the former source-string composer metadata assertions. They exercise the actual
lazy control implementation and shared hook with deferred responses, exact
model/effort retention, missing model replacement, incomplete configuration,
profile saves and cross-harness controls. Shared profile lookup tests cover
Claude Interactive identity and reject scoped metadata for a different backend.
The existing Claude Interactive UI suite was reviewed for profile selection and
reset/composer assumptions; C42 does not alter its private CLI protocol or claim
new real-Claude version compatibility.

The opt-in `CORTEX_AUTH_PROBE=1 CORTEX_TEST_CONNECTION=<saved-name> npx tsx
scripts/probe-cortex-auth.ts` retains isolated PM2/data/workspace ownership and
saved terminal auth. In addition to the auth cases, it exercises actual profile
editing/save, responsive editor layout, default selection, native model/effort
discovery, icon rendering, hidden CoCo mode/tier/goal controls, and a browser-sent
exact-response inference. Failures retain a private `failure.txt`; the shared
JSON report contains stages/booleans without native auth URLs or response bodies.
This is scoped macOS/CoCo 1.2.35 evidence, not full P7/P9 mobile/interaction or
platform acceptance. C26's human remote-browser OAuth remains independent.
The November 7, 2026 successful private report is
`cockpit-cortex-auth-ui-TBZF6r/report.json` under system temp. Its PM2 fixture
allows twenty seconds for native shutdown draining. Earlier fixture label/
workspace locators were corrected; one independent fresh-auth check remained
inconclusive rather than bypassing the exact-response gate.

The selectors now lazy-load outside the main composer. Shared catalog helpers
replace duplicated Settings/workspace/shell projection. The aggregate JS budget
increases by 2 KiB to 912 KiB for the C42 fields/request ownership; existing
per-screen/index/CSS caps remain unchanged. Rebuild both clients after the full
Jest run, then check the actual production output with `npm run web:budget`.

## Cortex processor selection boundaries (P6 C41)

`test/cortexProcessorSelection.test.ts` exercises normalized global/workspace
selections and actual service/HTTP boundaries using registered policy fixtures.
The expanded `test/processorProfiles.test.ts` verifies exact saved identity,
unset defaults, configuration/disablement/availability/metadata identity and
sequential eligibility; rendered `test/memoryProcessorSelect.test.ts` covers the
shared tool controls, missing-ID placeholders, disabled selections, explicit
changes and synthetic-event rejection. Existing Memory tests verify note,
extraction, consolidation proposal and rewrite rejection before CoCo invocation;
dream tests verify role rejection precedes destructive rebuild. The added
`test/dataMigrationService.test.ts` round trip uses actual export/checksum/stage/
replace/import and normalized reads, preserving unavailable selections without
altering the full-bundle contract. Backend/web/mobile typechecks cover the
browser-safe shared contract; the declaration-only HTTP augmentation explicitly
imports express-session's types to make its module visible from browser builds.

No new native protocol probe is required for this settings/service policy.
The existing `CORTEX_PROCESSOR_PROBE=1 CORTEX_TEST_CONNECTION=<saved-name> npx tsx
scripts/probe-cortex-processors.ts` passed on CoCo 1.2.35/macOS arm64/Node 26.0.0,
with private evidence `cockpit-cortex-processors-YeAnIZ/report.json` under system
temp. It confirms restricted rejection, sequential continuity, actual headless
question, HTTP OCR/model gate, cancellation and fresh authenticated inference
after these service guards. Native client/PM2/Windows/Linux acceptance and strict
zero-tool Memory remain separate. Rebuild desktop/mobile assets after the full
Jest suite, then run the desktop bundle budget; the shared lazy selector retains
the existing Settings/selector limits.

## Cortex native Routines (P6 C40)

Normal coverage uses `test/cortexRoutinesIntegration.test.ts` with the real
CoCo adapter/processor and deterministic `test/fixtures/cortex/chat-acp.cjs`.
The fixture's explicit `CORTEX_FIXTURE_ROUTINE_ITEMS` branch authors a synthetic
proposal or writes run output/tmp/notify/cursor files; the hold case leaves the
native prompt pending after partial file writes. The deadline test fires the
actual registered one-minute processor timer after prompt submission; it does
not claim one minute of wall-clock waiting. Actual timing is checked separately:

```sh
CORTEX_ROUTINES_PROBE=1 CORTEX_TEST_CONNECTION=<saved-connection-name> \
  npx tsx scripts/probe-cortex-routines.ts
```

Optional `CORTEX_TEST_COMMAND` selects the executable; test mode/non-macOS are
rejected. The probe creates isolated HTTP/data/workspace files, private 0700
evidence/0600 reports, a ten-minute external completion deadline and tracked
run promises that drain before cleanup. Shared terminal auth is retained.
Actual HTTP/WS CoCo chat authors a routine from the installed authoring contract,
leaves it proposed, and emits the normal marker. Validation/install and run
routes use a fixture-mounted `createRoutineRouter` with an injected notifier
stub. Fake destination/token settings never reach a real delivery transport;
no external messages are sent. The default app fixture's execution routes are
not used for these notification-configured runs.

Native acceptance checks explicit installation, manual files/final/history,
selected profile/model/effort/timeout, output explorer, persistent cursor
continuity across a scheduled run, interval checks, mtime-based output pruning,
disabled no-scaffolding/no-run behavior and instruction removal with data
preserved. A real one-minute manifest deadline interrupts a foreground native
shell/Python task sleeping 120 seconds after writing a marker/notify file;
the run must fail in 55–100 seconds, make one native prompt, drain, retain its
partial output/state, omit a completed final and send no stub notification.
Fresh exact-response inference then verifies reusable authenticated execution.
Successful prompts require complete native usage; interrupted counters remain
unknown. Reports include only stages, assertion/execution category/source line,
versions/platform/revision and result flags/timing, not prompts, credentials,
notification contents or native diagnostics. Full browser/PM2/Windows/Linux,
C26, strict tool-free Memory and C41 selection acceptance remain independent.

CoCo 1.2.35/macOS arm64/Node 26.0.0 passed with exit 0 on November 7, 2026;
private report `cockpit-cortex-routines-SC2AiJ/report.json` under system temp.
Five native prompts covered four successful complete-usage responses and one
intentional timeout. The actual one-minute run failed after 60,247 ms, retained
its partial marker/state, made no resend or notification delivery, and fresh
exact-response inference succeeded. Nine deterministic process tests plus the
full 160-suite/2,833-test coverage run passed. Full browser/PM2 acceptance and
real Telegram delivery are not claimed by this stub-only compatibility probe.

## Cortex native Workspace Context (P6 C39)

`test/cortexContextIntegration.test.ts` uses the real adapter and ephemeral
processor transport with the deterministic `test/fixtures/cortex/chat-acp.cjs`
executable. Its explicit `CORTEX_FIXTURE_CONTEXT_MODE` branch writes only the
synthetic prompt's context directory and generates valid or deliberately invalid
Memory action blocks; other CoCo fixture behavior is unchanged. Native behavior
is verified separately using saved terminal credentials:

```sh
CORTEX_CONTEXT_PROBE=1 CORTEX_TEST_CONNECTION=<saved-connection-name> \
  npx tsx scripts/probe-cortex-context.ts
```

Optional `CORTEX_TEST_COMMAND` selects the binary. The probe rejects test mode
and non-macOS platforms, creates an isolated HTTP/data/workspace fixture and
private 0700 report directory/0600 report, and applies a ten-minute external
deadline. It invokes actual Workspace Context service/scheduler paths, with
synthetic session exports/uploads, references, an asset, active and superseded
Memory inbox notes and expiring run records. It checks direct native markdown
updates, selected global/override profile/model/effort, accepted inbox folding
and server-owned deletion, silent Memory events, reference/asset preservation,
seven-day report/history pruning, zero-source scans without startup, disabled
passivity, scan/maintenance cadence using an injected clock, cancellation after
native prompt submission without resend/deletion, and fresh exact-response
inference. Teardown stops/drains service and native jobs before deleting files.
No real external messages, credential reset, production restart or shared
Snowflake profile changes are involved. Usage assertions cover successful native
prompts; interrupted counters remain unknown and no processor billing ledger is
invented. Failure reports include only stage, assertion/execution category and
probe source line when available, not native error text. This fixture does not certify full browser/PM2, Windows/Linux, C26 or
strict tool-free Memory processing.

CoCo 1.2.35/macOS arm64/Node 26.0.0 passed with exit 0 on November 7, 2026;
private reports `cockpit-cortex-context-n84NPH/report.json` and
`cockpit-cortex-context-8fvaS7/report.json` under system temp.
Each successful run's six native prompts covered five complete-usage responses and one
intentional interruption. The first `41FmBi` attempt failed during `native-scan`
without retaining the cause; it remains failed evidence. Two explicit separate
runs passed the entire workflow without runtime retry or auth reset. Normal
coverage passed 159 suites/2,824 tests; actual browser/PM2 acceptance is separate.

## Cortex native KB workflows (P6 C37/C38)

Normal coverage adds `test/cortexKbIntegration.test.ts` using the deterministic
CoCo executable and actual ingestion/database/media paths. Page-conversion and
handler tests cover required PNG normalization without upscaling, original-byte
preservation, retries for existing harnesses, and zero-retry failure provenance
for all four format handlers. Dream tests verify CoCo-style execution errors,
empty output, JSON parse warnings and schema warnings run once and retain pending
entries; existing retry-enabled behavior stays covered. CoCo backend tests pin
the two server-only policy getters.

Opt-in native macOS acceptance, using saved terminal auth and installed
Pandoc/LibreOffice plus local Ollama `nomic-embed-text` (768 dimensions):

```sh
CORTEX_KB_PROBE=1 CORTEX_TEST_CONNECTION=<saved-connection-name> \
  npx tsx scripts/probe-cortex-kb.ts
```

Optional `CORTEX_TEST_COMMAND` selects the binary; test mode and other platforms
are rejected. `test/helpers/cortexKbFixtures.ts` generates a synthetic JPEG,
embedded-image DOCX/PPTX through Pandoc, and PDF through a private LibreOffice
profile. No installation or shared Office/Snowflake profile is modified.
`scripts/probe-cortex-kb.ts` creates an isolated HTTP/data/SQLite/PGLite fixture
and private 0700 report directory/0600 report. An external ten-minute completion
deadline shuts down active native work and rejects subsequent calls. It verifies
real visual conversion/records/reuse, one-session digestion/gleaning, persisted
topics/Markdown/history, glossary expansion, real embeddings and vector search,
native KB MCP search/read, re-dreaming, interrupted digestion without resend and
fresh exact-response inference afterward. It records native complete usage only
for successful calls, without synthesizing counters for the cancelled call.
The MCP endpoint is a fixture-only loopback route and token. Teardown drains
native jobs and closes PGLite/SQLite before removing data; reports omit raw
prompts, OAuth material, accounts, native diagnostics and MCP tokens.

CoCo 1.2.35/macOS arm64/Node 26.0.0, Pandoc 3.9.0.2 and LibreOffice 26.2.3.2
passed with exit 0: private `cockpit-cortex-kb-XyBPEJ/report.json` under system
temp. Eleven prompts covered ten successful calls with complete usage and one
intentional interruption. Native `search_entries`, `search_topics`, `get_topic`
were observed. `simoDC` is earlier successful conversion/digestion/cold-start
evidence without native search acceptance. C26, conditional C35, C39–C41,
full browser/PM2 and native Windows/Linux acceptance remain independent.

## Cortex background processors and OCR (P6 C33/C34/C36)

Normal coverage includes the processor/selector suites listed above, the
headless ordinary/question/plan/malformed-permission/cancellation-failure cases
in the CoCo turn/interaction suites, and the restored CoCo selection case in
`test/memoryMcp.test.ts`. The latter exercises the real Memory notes HTTP route,
verifies no runtime startup or fallback note, and retains the selected profile.

Opt-in native primitive/OCR probe (paid inference, macOS, shared saved auth):

```sh
CORTEX_PROCESSOR_PROBE=1 CORTEX_TEST_CONNECTION=<saved-connection-name> \
  npx tsx scripts/probe-cortex-processors.ts
```

Optional `CORTEX_TEST_COMMAND` selects the executable. Test mode is rejected.
The probe creates an isolated HTTP fixture/data root and writes a private
0700 report directory/0600 JSON report, without recording credentials or native
RPC diagnostics. It records CLI/OS/Node/revision/dirty status, exact sequential
nonce recall, headless native question failure, actual OCR endpoint output for
a synthetic PNG, unsupported Auto image rejection, caller cancellation after
native image submission and exact fresh-process output afterward. The OCR
HTTP call uses a 150-second client deadline rather than the ordinary test
helper's 15-second request deadline. Teardown awaits adapter draining and
database closure before deleting fixtures. It preserves shared login and
does not add automatic retries.

Native CoCo 1.2.35/macOS arm64/Node 26.0.0 passed with exit 0, private report
`cockpit-cortex-processors-8Vg2wG/report.json` in the system temp directory,
repeated after the shutdown-draining refinement; `lD74CG` also passed.
Earlier reports failed an acknowledgment punctuation assertion, then the short
HTTP helper deadline; neither is treated as successful evidence. Full native
browser/PM2/platform acceptance, C26 human auth handoff, strict zero-tool work
and individual C37–C41 workflow/selection certification remain separate gates.

## Cortex durable chat and managed MCP (P5)

Normal Jest coverage adds `test/cortexBackend.test.ts` (registered adapter,
profile-local catalog/roles, instructions, session IDs, usage/terminal ownership,
idle/restart load, MCP config refresh, classified recovery and cancellation,
no fixed chat deadline with a one-hour inactivity stop and recovery, and runtime
retirement after a failed native config change),
`test/cortexPlugin.test.ts` (private modes, child env placeholders, actual Node,
independent tokens, cleanup and conservative dead-owner pruning), and
`test/cortexIntegration.test.ts` (real process fixture through HTTP/WS and stores:
metadata, multi-turn persistence, idle/restart load/replay suppression, questions
through REST/WS/reconnect/stale rejection, recovery snapshot, queue/abort/reset/
archive/delete/profile lock, worktree/Git/download artifacts and canonical
workspace relocation/Workspace Context/instruction refresh). Its deterministic
executable is `test/fixtures/cortex/chat-acp.cjs`, separate from the P2 fixture.
`load-missing.json` retains the actual synthetic missing-session error signature.
Desktop reducer/store and mobile projection/send-pipeline suites verify opaque
decision IDs and preservation of newer interactions during HTTP acknowledgement.
The runtime registry test now uses the real CortexCodeAdapter.

Opt-in native app probe (paid inference through CoCo plus a separate authenticated
Claude Memory processor; no shared credential changes):

```sh
CORTEX_CHAT_PROBE=1 CORTEX_TEST_CONNECTION='<authenticated native connection>' \
  npx tsx scripts/probe-cortex-chat.ts
```

Optional command overrides are `CORTEX_TEST_COMMAND` and
`CORTEX_TEST_MEMORY_COMMAND`. This probe certifies CoCo 1.2.35 on macOS only.
It creates isolated real ChatService/HTTP/WS data through the existing test
fixture, selects shared setup-account profiles and real Claude `haiku` as the
Memory processor. Native Memory/KB discovery and actual stdio shims must execute
memory_note, memory_search, search_topics and get_topic; governed Memory state
and separate processor invocation are checked. Actual SQLite/PGLite stores are
seeded with synthetic knowledge. Embeddings intentionally point at an unavailable
loopback endpoint; actual PGLite keyword fallback and SQLite topic read are
tested, not Ollama/semantic embedding availability.

The same conversation must recall its nonce after idle process eviction and
adapter shutdown/reuse, retain its native ID, persist exactly one **final** answer
and usage per turn (progress messages are allowed), and deliver a verified native
write/read file as an artifact in existing conversation storage. It then moves
the workspace and requires the loaded native session to retain canonical
workspace/native IDs and nonce while reading/writing in the new cwd. The websocket
fixture clears a completed replay buffer before a deliberately new send; the
dedicated reconnect test retains buffers while the current decision is pending.
Reports are private 0700/0600 temporary summary artifacts with version/platform/
Node/revision/dirty state and assertion booleans, without native credentials,
OAuth values, raw protocol or transcript content. Native turns have an external
180-second completion deadline; adapter shutdown drains owned processes in finally.
Full OS-process restart/browser UI/other platform acceptance remains P7/P9.

On November 6, 2026 the native app assertions passed on CoCo 1.2.35,
macOS arm64, Node 26.0.0, revision 5679917 plus P5 work. An earlier assertion
incorrectly included intermediate progress messages in the final-answer count;
it was corrected before the complete assertion run. A later native run issued
no required MCP calls and remains failed; its cause was not established. The
final complete run passed all checks, including native relocation, and exited
zero. The standalone fixture explicitly closes its PGLite/vector and SQLite
stores before deleting data; unclosed PGLite initialization leaves a process
exit code of 99 even when application assertions pass. No automatic prompt/tool
retry was added. The unchanged native
runtime probe also passed all startup/cancel/load/root-exit/missing-auth/reusable
shutdown scenarios with the P5 pool. Current service tokens have no TTL; token,
endpoint and feature refresh are deterministic pool tests, and invalid/revoked
token authorization remains the real Memory/KB service suites. No token-expiry
policy is claimed. C26 human remote-browser setup stays open; strict processor
capabilities and one-shot execution remain unavailable.

## CI/CD

**Lint gate** (`npm run lint`): Runs `eslint . --max-warnings=0` from the repository root using the flat config in `eslint.config.mjs`. The config uses root-installed `eslint`, `@eslint/js`, `typescript-eslint`, and `eslint-plugin-react-hooks`; no Prettier or formatting rules are part of the gate. Type-aware linting covers the root server compile unit (`src/**/*.ts`, `server.ts`), desktop web TypeScript/TSX, mobile PWA TypeScript/TSX, and Jest tests. Root TypeScript tooling files outside `tsconfig.json` (`scripts/*.ts`, `playwright.config.ts`) use non-type-aware TypeScript recommended parsing. Plain JS/CJS/MJS tooling and desktop web JS/JSX use `eslint:recommended` as warnings, with cheap mechanical JS correctness rules promoted to errors: `no-undef`, `no-unused-vars`, `no-empty` with `allowEmptyCatch: true`, and `no-useless-assignment`. `react-hooks/rules-of-hooks` is an error for web/mobile sources and `react-hooks/exhaustive-deps` remains a warning, but the committed baseline is zero warnings; intentional dependency exceptions must use targeted inline disables with written reasons. The type-aware correctness rules `@typescript-eslint/no-floating-promises`, `@typescript-eslint/no-misused-promises`, `@typescript-eslint/await-thenable`, and `@typescript-eslint/no-unnecessary-type-assertion` are errors. Other TypeScript recommended rules are disabled for the initial gate because the existing dynamic JSON and CLI protocol surfaces produce high-volume legacy findings outside the promise-correctness scope. `npm run lint` fails on lint errors or warnings.

**Test workflow** (`.github/workflows/test.yml`): Runs on PRs to `main` and manual dispatch. The `copilot-sdk` matrix installs pinned Copilot 1.0.105 in a temporary prefix on Ubuntu 24.04, macOS 15 and Windows, runs the twenty local-model native SDK cases with Node 22, and uploads separate compatibility reports and records for each platform. These jobs require no hosted credentials; their actual results, rather than their configuration, establish native compatibility. The `test` job steps are checkout, Node.js 22 setup, root `npm ci`, mobile PWA `npm --prefix mobile/AgentCockpitPWA ci`, `npm run typecheck`, `npm run web:typecheck`, `npm run web:build`, `npm run web:budget`, `npm run mobile:typecheck`, `npm run lint`, `npm run maintainability:check`, `npm run spec:drift`, `npm run mobile:build`, `npm test`, and `npm run adr:lint`. The separate `coverage` job runs in parallel with checkout, Node.js 22 setup, root `npm ci`, mobile PWA `npm --prefix mobile/AgentCockpitPWA ci`, and `npm run test:coverage`, so the global Jest coverage thresholds fail PRs without slowing the main build/test gate. The `copilot-windows` job installs root dependencies on Windows/Node 22 and runs native Job Object fixtures without an installed CLI. The independent `copilot-browser` job pins Ubuntu 24.04 (supported by Playwright 1.60 rather than a moving runner image), installs Copilot 1.0.105 in a temporary prefix plus Chromium, runs `npm run e2e:copilot-ui` against a local model without credentials, and uploads browser traces/screenshots plus isolated server logs and CLI/OS/revision evidence. Its client builds do not race the main Jest asset-build fixtures.

**ADR workflow** (`.github/workflows/adr.yml`): Runs on PRs to `main` when ADR docs or ADR scripts change. Checkout uses the PR head repository and immutable head SHA, so fork branch names are not fetched from the upstream repository. Forks do not persist checkout credentials; they regenerate and require a clean ADR-index diff without attempting to push. Same-repository PRs can auto-commit a stale index and push to the quoted `PR_BRANCH` environment variable. Both paths run `node scripts/adr-lint.js`; this remains an unprivileged `pull_request` workflow, not `pull_request_target`. The linter requires current ADR `affects` paths to exist. Historical/retired-prefix exceptions remain unchanged.

The native SDK fixture preserves operating-system initialization variables (including Windows PowerShell's environment) while removing inherited Copilot, GitHub and provider configuration and `NODE_OPTIONS`. Temporary home/config directories and empty token overrides isolate terminal authentication. After the first native startup failure, subsequent cases fail with that same error instead of spending another startup deadline. On Windows, the first failure also records bounded stdout/stderr and the exit code in `startup-failure.json` using a separate isolated launch through the same Job Object boundary; production runtime stderr remains discarded.

Copilot updater regressions cover full semver precedence: stable after prerelease, numeric vs textual prerelease identifiers, successive numeric prereleases, equal/older versions, build metadata ignored, invalid inputs, and npm Copilot status rows reporting actual `updateAvailable` values. No new release channel or prerelease opt-in is introduced.

**Claude Interactive Version workflow** (`.github/workflows/claude-interactive-version.yml`): Runs every 12 hours and by manual `workflow_dispatch`. It checks out the repository, sets up Node.js 22, and runs `node scripts/check-claude-interactive-release.js` with `GITHUB_REPOSITORY` and `GH_TOKEN` from the `GH_ISSUE_TOKEN` repository secret. The secret must be a GitHub token for the configured repository account with issue-write access. The script reads `CLAUDE_CODE_INTERACTIVE_TESTED_CLI_VERSION` from `src/services/backends/claudeInteractiveCompatibility.ts`, reads the latest published Claude Code CLI version with `npm view @anthropic-ai/claude-code version`, and exits without GitHub writes when the latest version is less than or equal to the tested version. When npm has a newer version, it searches open issues whose title includes `Support Claude Code Interactive`, requests issue state from GitHub, locally ignores closed or unrecognized issues, dedupes by exact title or hidden body marker `agent-cockpit:claude-code-interactive-version:<version>`, and ensures one support-validation issue exists for that version. After the latest-version issue exists, the script closes lower-version open support-validation issues with a comment referencing the current issue. The issue asks for the real-Claude compatibility reports (`npm run e2e:claude-interactive:report` and `npm run e2e:claude-interactive-ui:report`) before moving the tested-version constant.

**Version bump** (`.github/workflows/version-bump.yml`): Runs on push to `main`. Skips `chore: bump version` commits. Steps: `npm version patch --no-git-tag-version`, commit the package files, and push `main`. It does not create or force-push `v*` tags; public production releases are explicit GitHub Releases.

**Production release workflow** (`.github/workflows/release.yml`): Manual `workflow_dispatch` promotion to a GitHub Release. Inputs are `version`, `source_ref` (default `main`), `prerelease` (default `false`), and `smoke_only` (default `false`). The `windows-smoke` job runs on `windows-latest`: it checks out the selected ref with `fetch-depth: 0`, sets up Node.js 22, runs root/mobile `npm ci`, root/web/mobile TypeScript checks, web/mobile production builds, the web bundle budget check, `npm run lint`, Windows-focused installer/doctor/install-state Jest tests plus the Windows-named update-service Jest tests, parses `scripts/install-windows.ps1` with PowerShell's parser API, runs `npm run release:package`, verifies the release manifest has macOS/Linux/Windows app and installer artifacts, then runs `scripts/install-windows.ps1 -Channel dev` against a temporary checkout with forced private Node, an install path containing spaces, `-SkipOpen`, and a fixed high port. The Windows installer smoke step verifies the `AgentCockpit` ONLOGON scheduled task, probes `/auth/setup`, checks Install Doctor `node`/`npm`/`pm2`, and runs the generated stop script. The `linux-smoke` job runs on `ubuntu-latest`: it performs the same root/mobile install, typecheck, build, web-budget checks, and lint gate, runs Linux installer static coverage plus install doctor/install-state tests and the Linux-named update-service tests, parses `scripts/install-linux.sh` with `bash -n`, runs `npm run release:package`, verifies the release manifest has macOS/Linux/Windows app and installer artifacts, then runs `scripts/install-linux.sh --channel dev` against a temporary checkout and install root, verifies the systemd user unit file exists, probes `/auth/setup`, checks Install Doctor `node`/`npm`/`pm2`, disables/removes the test user unit, and deletes the PM2 process. When `smoke_only` is false, the publish job depends on both smoke jobs, checks out the selected ref on Ubuntu, normalizes the version, updates package files in the runner when needed, runs `npm ci`, `npm --prefix mobile/AgentCockpitPWA ci`, `npm run typecheck`, `npm run web:typecheck`, `npm run web:build`, `npm run web:budget`, `npm run mobile:typecheck`, `npm run lint`, `npm run maintainability:check`, `npm run spec:drift`, `npm run mobile:build`, `npm test`, and `npm run adr:lint`, then runs `npm run release:package` and `npm run release:notes`. It creates GitHub Release `v<version>` with the rendered release-notes file as `--notes-file`, and uploads `agent-cockpit-v<version>.tar.gz`, `agent-cockpit-v<version>.zip`, `release-manifest.json`, `SHA256SUMS`, `install-macos.sh`, `install-linux.sh`, and `install-windows.ps1`.

## Cortex shared authentication setup (P4)

Focused suites:

- `test/cortexConnections.test.ts`: safe summaries, TOML quoting/Unicode,
  byte-preserved original content, duplicate/create-only behavior, private
  permissions, file bounds/symlinks/malformed input, write locks/concurrency,
  observed external edit rejection, exact-body input validation.
- `test/cortexOAuth.test.ts`: PKCE URL ownership, strict loopback/state/issuer,
  malicious/duplicate/foreign/expired-target inputs, split terminal output,
  known first-run prompts and exact native account selection.
- `test/cortexLogin.test.ts`: pinned no-shell PTY argv, process-scope ownership,
  idempotent teardown and late terminal suppression.
- `test/cortexAuthVerification.test.ts`: independent private workspaces, exact
  nonce/usage success, initialization-only failure, missing connection, grant/
  credential/API errors, tool/reverse-request rejection, cancellation/deadline,
  sanitized failures and cleanup without a paid retry loop.
- `test/cortexAuth.test.ts`: shared facade defaults, explicit-isolation gate,
  reserved auth-home exclusion across profiles/checks, one-time generation-bound
  handoff, native-completion-before-verification, timeout/cancel/retry, shutdown
  generation and late callbacks, abortable version detection, direct-check drain,
  version/authenticator gates and secret removal.
- `test/chat.cortexAuth.test.ts`: real route registration, exact bodies, CSRF,
  no-store headers, safe summaries, profile persistence/default preservation,
  explicit profile retention, redirect delegation/error behavior and awaited
  server shutdown draining.
- `test/cortexSetupUi.test.ts`: rendered React controls for create/check,
  transient redirect submission, polling/completion/cancel and reload recovery
  without persisting secrets, full native-URL focus selection, exact untruncated
  redirect submission, immediate input clearing while a request is pending, and
  removal on failed/cancelled polls. The test module loader accepts optional globals
  to exercise browser timers directly.

Existing CLI auth/service/profile suites remain regression gates. POSIX
shebang auth/runtime fixtures skip Windows; the separate C53 simulated-platform
suites cover Windows runtime behavior. TOML
symlink checks are POSIX-only because Windows symlink privileges are optional.
These guards do not establish native Windows support. For native
saved-login/browser compatibility after building web/mobile assets:

```sh
CORTEX_AUTH_PROBE=1 CORTEX_TEST_CONNECTION='<authenticated-name>' \
  npx tsx scripts/probe-cortex-auth.ts
```

This opt-in runner uses a PM2-managed isolated server/data/workspace and normal
shared terminal auth. It makes several tiny real inference requests, checks
remote API authentication rejection, Welcome setup login, cached-auth jobs,
cancellation/retry, narrow viewport fit and absence of handoff material in
settings. It stops its PM2 fixture and writes a private sanitized report with
CLI/OS/Node/revision evidence. It does not clear saved credentials or force a
new OAuth login. **It is not C26's actual human remote-browser handoff** and
is not a full CoCo chat/processor suite. Do not run browser checks alongside
full Jest suites that replace ignored production assets; rebuild those assets
first. Native first-run PTY onboarding was separately exercised with temporary
connection metadata and existing credentials; this does not certify isolated
OS-keychain auth or a new remote-browser callback.

P7 C47 extends this runner with a separate synthetic browser-handoff matrix on
Welcome and Settings at 1280, 390 and 320 px widths. Only that browser context
intercepts auth endpoints; synthetic codes never reach native auth or Snowflake.
Real native saved-auth inference and the synthetic matrix have separate report
fields. The matrix uses Chromium clipboard copy/paste to preserve the complete
long native URL and encoded loopback redirect. It checks live form/control fit,
immediate clearing during a held submission, success/cancel/rejection and
terminal failed/expiry snapshots,
recovery of a server-owned URL after reload with an empty unsent redirect, and
absence of handoff values in local/session storage, cookies or history. Isolated
desktop contexts must create no IndexedDB or Cache Storage. Clipboard contents
are intentionally transient transfer state and are cleared during fixture cleanup;
no claim is made that plaintext never exists in active UI/React memory. Reports
contain only synthetic flags, viewport sizes and counts; screenshots/errors remain
private. Backend expiry timers remain covered by the focused auth suites. Use
the textbox role/accessible name for the native URL: exact HTML label text can
include the textarea value. A ten-minute external deadline closes Chromium and PM2 gets twenty
seconds to drain, with a thirty-second command bound. Native C26 human handoff,
physical browsers, native platform certification and C54 suite packaging remain
independent. Run full Jest first, rebuild both production clients, then run the
browser probe; do not let asset-mutating tests run concurrently.


### CoCo optional standalone installation (P8 C48)

`test/cortexInstallation.test.ts` verifies optional detection, refresh without
PATH changes, official standalone/platform action policy, successful/failing
install/postcheck paths, download failure/temp cleanup, active/concurrent
exclusion, spaced paths/explicit commands and executable/auth-home separation.
`test/cortexWelcomeInstallation.test.ts` renders official actions, refreshed
status and failure recovery while retaining dedicated CoCo authentication.
Existing doctor/macOS installer/release-package/update suites remain regression
gates. No new endpoint/body or PWA setup surface is introduced.

Run `CORTEX_INSTALL_PROBE=1 npx tsx scripts/probe-cortex-install.ts` on macOS for
a real official installation in a disposable child-process HOME/app/command path
with spaces. It strips user-local PATH entries, invokes the production doctor
action, requires 1.2.35 native version detection and automatic/explicit runtime
launch, checks auth-home separation and absence of credentials, and removes its
installed distribution. Native logs/completions are permitted; existing shell
profile bytes must remain a prefix and no installer PATH line may be added.
Reports stay in the private temporary fixture. This uses an injected install
state and optional-tool detectors; it is not a full package install, auth/chat
or PM2 acceptance and does not certify Linux/Windows. The saved-auth PM2 browser
probe now also waits for Welcome's separate executable-only status. C49 update
management, C51–C53 platform acceptance and C26 remain independent.


C48 measured V8 coverage: 173 suites / 2,941 tests passed; 88.62% statements/lines,
76.69% branches and 93.82% functions. Floors rise to 88.62 statements/lines and
76.65 branches, retaining 93.8 functions. Existing macOS installer/release/update
regressions pass; rebuilt desktop/mobile assets retain the 914 KiB JS budget.


### CoCo native CLI updates (P8 C49)

`test/cortexUpdates.test.ts` covers shared executable grouping and profile env
exclusion, canonical native layout/metadata/native-version agreement, full build lookup,
pinned updater invocation, reserved preflight/duplicate and newly active chat,
network/metadata failure recovery, awaited invalidation, one failed native
attempt with explicit retry, changed activation, exit-zero postcheck failure and
future patch/minor/major eligibility, successive new-version updates despite
runtime cautions, and unsupported platforms. Future-version fixtures prove
policy, not native compatibility. `test/cortexUpdateRoutes.test.ts` holds real HTTP
responses until CoCo draining finishes on success/failure. The existing CLI update
foundation case now expects a visible non-actionable CoCo target rather than
excluding the harness. Existing runtime/backend and macOS installer/release/
updater suites remain required regressions.

Run `CORTEX_UPDATE_PROBE=1 npx tsx scripts/probe-cortex-updates.ts` on macOS for
a real official install and native updater in a disposable home/app path with
spaces. Genuine 1.2.35/1.2.37 with synthetic older build metadata forces actual stable
package download/checksum/extraction/activation; this is not old-release evidence.
A one-time injected missing stable target exercises real native failure,
activation preservation, cache invalidation and explicit retry. Registry shutdown
is awaited; idle native ACP runtimes close and fresh native runtimes start after
success/failure/retry. ACP creation is not authentication. Reports/logs remain
private in the fixture, the installed distribution is removed, and normal CLI/
terminal credentials are untouched. Full package/PM2/platform acceptance remains
C51–C53; C26 remains human OAuth. The saved-auth PM2 browser runner additionally
checks CoCo's normal desktop update row without executing its updater. Run full
Jest first, rebuild both clients, then run browser checks separately.

`CORTEX_UPDATE_TEST_COMMAND=/absolute/path/to/<distribution>/cortex` optionally
selects a retained distribution to copy into the disposable installation, with
both HOME and SNOWFLAKE_HOME isolated. Native macOS arm64/Node 26 runs passed
for retained `1.2.35+191333.f82de3d91715` and `1.2.37+221950.87518d294789`, each
targeting stable `1.2.37+221950.87518d294789`: download/activation, passive-query
preservation, runtime draining/reuse, missing-target failure and explicit retry.
Managed updates stay enabled after upgrade; already-current installs have no
update caution. Focused regressions cover later builds and future versions,
distinct platform/layout errors and the separate chat/login/media caution.
The update and update-row-only probes have no CLI-version allowlist and record
the actual release used. The full auth probe still
requires 1.2.35, so updater evidence does not broaden authentication claims.
The 1.2.37 update-row-only run passed at 1280/390/320 px with an enabled Run
updater button and no error/caution text, without updating or authenticating.


C49 full V8 baseline: 175 suites / 2,956 tests passed; 88.66% statements/lines,
76.83% branches and 93.86% functions. Coverage floors rise to 88.65 statements/
lines, 76.8 branches and 93.85 functions. Focused native-update, route/runtime/
backend and macOS installer/release/updater regression suites pass.


For independent update-status acceptance, run
`CORTEX_UPDATE_UI_PROBE=1 npx tsx scripts/probe-cortex-auth.ts`. This explicit
scope uses a fixture connection name, makes no login/inference/update request,
and checks the normal native installation's Update row/controls and fit at
1280/390/320 px. Its report says `scope: updates-ui-only`; it must not be reported
as an auth-suite pass. The ordinary `CORTEX_AUTH_PROBE=1` path retains every
cached-login, cancellation, chat and responsive handoff assertion.

During C49, the first full auth repeat failed native verification; the second
passed fresh inference but timed out at the cached-login job. A separate exact
fresh-process verification also passed. Both failed reports are retained;
no auth code/retry policy or credentials were changed. This is an outstanding
native auth compatibility observation for C26/C54, independently of C49 update
execution/status evidence; do not count either full repeat as passed.


### CoCo full data-root migration (P8 C50)

Focused verification:

```sh
npm test -- test/cortexMigration.test.ts test/cortexDataMigration.test.ts test/dataMigrationService.test.ts test/chat.dataMigration.test.ts test/cortexAuth.test.ts test/cortexPlugin.test.ts --runInBand
```

The 46 focused tests cover passive destination checks, runtime exclusions and
import rejection (including manifest-only and empty-directory entries), settings
integrity, CoCo shared/custom/disabled profiles, defaults and unavailable
processor IDs, durable data, backup replacement, unchanged external native files,
stale absolute homes, checksum tampering and the existing REPLACE route guard.
The executable fixture would write a sentinel if run; migration checks leave it
absent. No normal data root, native connection, credential store or installation
is modified. Existing Memory/KB/PGLite/Ollama/Pandoc/LibreOffice coverage remains
in the full suite. No CoCo native inference/browser probe is required for this
passive policy; cross-machine credential validity, C26 human OAuth and full
macOS/Linux/Windows acceptance remain independent gates. The C49 cached-login
repeat observation remains open.

Mobile impact: unchanged storage/contracts preserve profile/model/effort,
queue/media/usage data. Mobile has no migration administration UI. Both client
types/builds and the existing desktop migration projections remain applicable;
there is no new PWA metadata, asset-source or native mobile behavior.

C50 full V8 baseline: 177 suites / 2,973 tests passed (three suites / 20 native
opt-in tests skipped), 88.67% statements/lines (55,980/63,128), 76.90% branches
(13,280/17,269), 93.87% functions (2,850/3,036). Floors raised to 88.66%
statements/lines, 76.85% branches and 93.86% functions. Backend/web/mobile types,
zero-warning lint, maintainability, 189-route spec drift and 92-ADR validation
pass. Rebuild both client assets after the full suite, before any browser probe.


### CoCo macOS acceptance (P8 C51)

Run native checks only after full Jest and rebuilding both clients:

```sh
CORTEX_INSTALL_PROBE=1 npx tsx scripts/probe-cortex-install.ts
CORTEX_UPDATE_PROBE=1 npx tsx scripts/probe-cortex-updates.ts
CORTEX_AUTH_PROBE=1 CORTEX_TEST_CONNECTION=<saved-name> npx tsx scripts/probe-cortex-auth.ts
CORTEX_MACOS_PROBE=1 CORTEX_TEST_CONNECTION=<saved-name> npx tsx scripts/probe-cortex-macos.ts
```

The saved connection may also be selected privately by the macOS probe from the
native connection reader. Reports omit its value. Optional CORTEX_TEST_COMMAND
pins a retained executable; require the version-tested 1.2.35 binary rather than
silently certifying a new auto-downloaded version. Root passive version queries
use `--no-auto-update --version`; ACP and explicit updates keep their native
prefixes. The deterministic ACP executable enforces both query and dispatch
rules. Runtime tests change activation after resolution and verify version
detection/startup retain the original distribution while a fresh resolution sees
the new version/fingerprint. Review `test/cortexRuntime.test.ts`, `test/cortexInstallation.test.ts`,
`test/cortexUpdates.test.ts`, `test/cortexUpdateRoutes.test.ts` and the existing
CLI update/auth/backend/process/macOS installer/release/update suites.

The update probe now retains `autoUpdate:true`, asserts passive activation and
settings preservation, then executes the explicit target update and native
failure/retry. Synthetic older build metadata remains separate from older
release evidence. The macOS probe uses a checksummed local release package, real
root/mobile npm ci and installer helper functions, spaced paths, production
current symlink/install manifest, fixture RunAtLoad plist, unique LaunchAgent
and private PM2. The profile uses a retained pinned binary and both shared terminal
homes; one isolated-HOME/shared-Snowflake run failed fresh verification and
does not certify that auth configuration. It explicitly kickstarts its registered current-user job because
this host can hold the GUI domain in on-demand-only mode. It checks exact
HTTP package version, shared fresh service inference, packaged mobile assets,
desktop file write/usage, PM2 restart/native session resume, Stop of an observed
shell, no late write/replay and identity-based process cleanup. Only the fixture
label/daemon/plist are removed. Normal executable activation is snapshotted;
native settings/credentials and normal services remain intact. The source
executable is checked and successful fixtures remove their app/dependencies,
private PM2 state and fixture runtime state.

This is macOS arm64/current Node evidence, not native macOS x64, public release
download, private Node bootstrap, an actual logout/login event, C26 human OAuth,
strict Memory, Windows/Linux or physical mobile certification. Initial C51
saved-auth/browser checks passed, including the previously timed-out cached-job
path; C49 failed reports remain historical observations without a claimed root
cause. A first macOS fixture failed health because launchd left RunAtLoad pending
in on-demand-only mode and detected automatic native activation drift; retain
that failed report alongside corrected acceptance evidence. No failed report
counts as a pass and no auth retry policy is weakened.

Runtime version/launch consistency is independent of native automatic activation:
C51 also observed activation drift after adding query flags, with the originating
process unproven. Pin the retained distribution; never infer global upgrade
containment from one argv flag. Preserve the failed isolated-HOME auth report
and the stale-title selector failure (the corrected probe selects the immutable conversation ID).

C51 aborted-turn regression: acknowledged native cancel alone allowed the
background Bash fixture to write its late file. `CortexTurn` now awaits native
close before done; next explicit turns use fresh-process saved-session load.
Backend/turn tests cover close-before-done, no prompt replay and a retained
completed handle attempting to cancel a newer active prompt. The existing
native queue runner now selects desktop conversations by immutable ID and reads
current titles for mobile, avoiding asynchronous title changes. Native macOS
and all four desktop/mobile queue/abort cases passed with the close policy.

Passed native C51 reports (private temporary artifacts, revision 4c05a35 plus
C51 working tree; all dirty states are explicit):

- `cockpit cortex install aADkrK/report.json`: disposable official install,
  physical executable pinning and spaced alias/auth-home checks.
- `cockpit cortex updates VebO4v/report.json`: autoUpdate:true passive activation
  preservation, genuine native explicit download/activation, cleanup and retry.
- `cockpit cortex macos qvQpiE/report.json`: macOS 26.5 / Darwin 25.5.0 arm64,
  Node 26.0.0, CoCo 1.2.35+191333.f82de3d91715; local release/dependencies,
  fixture LaunchAgent/private PM2, source-binary observation, shared fresh auth,
  desktop write/usage, restart/resume, Stop and removal of fixture installation.
- `cockpit-cortex-queue-6gCILM/report.json`: all four desktop/mobile queue/abort
  cases with close-before-done, owned descendants gone and explicit resume once.
- `cockpit-cortex-auth-ui-tt3HA4/report.json`: full native saved auth/cached jobs,
  cancel/retry, responsive setup/profile/catalog/fresh chat and synthetic handoff
  checks. Uses the retained command; this run does not check its update row.

These are temporary folder basenames under the probe's printed report path.
The normal activation was restored to original 1.2.35 after all native jobs
closed; native settings/credentials were not edited and downloaded 1.2.37 was
retained. C51 also retains failed on-demand startup, stale-title, isolated-HOME
null-auth and background-shell late-write reports. Only the last two native
Stop/queue reports establish the corrected cancellation behavior. C26 remains
pending human handoff. Root causes of C49 auth repeats and later native activation
drift are not inferred from clean reruns.

Final C51 full V8: 177 suites / 2,975 tests passed; three native opt-in suites /
20 tests skipped. Statements/lines 88.67% (55,989/63,137), branches 76.93%
(13,294/17,279), functions 93.87% (2,850/3,036). Floors rise to 88.67%
statements/lines and 76.90% branches; functions remain 93.86%. Focused cancellation
coverage passes 52 tests; the earlier macOS/CLI regressions pass 122 tests.
Backend/web/mobile/probe types, zero-warning lint, maintainability, 189-route
spec drift, 92-ADR checks, client builds and existing bundle budgets pass. Client
assets are rebuilt after final Jest; no browser suite runs concurrently with it.


### CoCo Ubuntu acceptance preparation (P8 C52, native pending)

See [the pending Ubuntu runbook](research/cortex-code-linux-acceptance.md).
The prepared opt-in entrypoint is:

```sh
CORTEX_LINUX_PROBE=1 npx tsx scripts/probe-cortex-linux.ts --preflight
CORTEX_LINUX_PROBE=1 npx tsx scripts/probe-cortex-linux.ts
```

The read-only preflight rejects unsupported hosts before credentials/fixtures.
Full execution requires an authenticated retained native 1.2.35 distribution,
Ubuntu 24.04 x64/glibc, regular user, actual systemd user manager, locked project
dependencies, rebuilt client bundles and Playwright Chromium. It uses actual
release packaging/Linux installer helpers, a unique user unit and private PM2.
It tests service-side fresh auth without terminal environment injection,
chat/file/usage, /proc native identity, PM2 resume, user-unit restart/fresh auth,
Stop/no replay and owned cleanup. Reports state which checks ran and omit auth
values. Work deadline is 18 minutes; cleanup commands are separately bounded.
Do not run full Jest concurrently with the native browser probe.

`test/cortexLinuxProbe.test.ts` executes the real probe in child processes for
missing opt-in and non-Linux rejection before native invocation/fixture creation.
`test/linuxInstallerScript.test.ts` executes actual generated start/stop helpers
against a recording npx shim and materializes the real unit under a private
configuration path containing spaces and a quote. This is not native systemd,
Linux/auth or installer-download evidence. Existing macOS installer/package and
update regressions remain required if shared production behavior changes.

Native execution is pending an Ubuntu environment. Separate official CoCo
install/update and credential-store/new-login tests must also pass to close C52;
macOS-only install/update probes must not have their guards bypassed. Mobile
impact is limited to served packaged assets, with no source or contract changes.

Local preparation regression: 178 suites / 2,979 tests pass (3 native opt-in
suites / 20 tests skipped). V8 measures 88.72% statements/lines (56,017/63,137),
76.93% branches (13,304/17,292), 93.93% functions (2,852/3,036). Floors raised to
88.70% statements/lines and 93.90% functions; branches retain 76.90%. The
additional POSIX doctor test executes a recording shell executable through the
actual default command runner, asserting passive argv, no login claim and
nonzero-exit warning. The platform is mocked; no native Linux execution occurred.


### CoCo consolidated compatibility runners (P9 C54)

The opt-in commands wrap existing probes without turning their evidence into a
claim about a broader platform, a human OAuth handoff or unsupported roles:

```sh
npm run e2e:cortex-code -- --list
npm run e2e:cortex-code-ui -- --list
CORTEX_CODE_E2E=1 npm run e2e:cortex-code
CORTEX_CODE_E2E=1 npm run e2e:cortex-code-ui
CORTEX_CODE_E2E=1 npm run e2e:cortex-code-ui -- --probe auth
```

`--help`/`--list` are read-only and require no native CLI or credentials. Other
arguments are repeated `--probe <id>` pairs; unknown/missing/duplicate names are
rejected. Selections run in catalog order. An explicit subset is reported as
selected catalog probes, including omitted IDs; it never counts as a full
catalog pass. Native runs require CORTEX_CODE_E2E=1, macOS, a regular user and
non-fake native mode. CORTEX_TEST_CONNECTION optionally chooses a saved name;
otherwise the connection reader selects its first entry privately. Optional
CORTEX_TEST_COMMAND chooses the retained executable. The runner requires the
versioned official 1.2.35 distribution, resolves its realpath before the passive
version query, and passes that same file to every probe. The model is fixed to
claude-sonnet-4-6. Inherited update-UI-only mode is removed, so it cannot turn
full auth into a synthetic/passive check. Native root/ACP argument boundaries
remain unchanged.

| Command | Default catalog, in order | External per-probe deadlines |
|---|---|---|
| e2e:cortex-code | runtime, events, processors | 8, 15, 12 minutes |
| e2e:cortex-code-ui | auth, interactions, queue, usage, mobile | 12, 12, 10, 12, 15 minutes |
| e2e:cortex-code-workflows | chat, kb, context, routines, mobile | 12, 12, 12, 12, 15 minutes |
| e2e:cortex-code-auth-control | missing-auth | 3 minutes |

Backend, UI, workflow and auth-control wrapper deadlines are 40, 70, 70 and
5 minutes. The UI and workflow runners first
builds production web/mobile assets (two-minute deadline each). It does not run
Jest: finish asset-mutating full Jest before starting it. The default catalog
excludes installer/updater downloads, packaged platform installation, the
research phase-0 restriction probe. Full workflows have their own C55 command
described below. Those dedicated probes remain independently opt-in. Processor primitives are
not complete KB/Context/Routine or strict Memory acceptance.

Ownership/report logic lives in scripts/run-cortex-code-compat.ts, report
validation/catalogs in scripts/cortexCompatReports.ts, and process supervision
in scripts/cortexCompatProcess.ts. The two npm entrypoints remain thin. Both
commands reserve the same agent-cockpit-cortex-e2e.lock in the user's temporary
directory before native work/builds. It records PID and an opaque owner nonce;
competing runs fail without removing another lock. Normal completion removes
only its exact lock value. A crash can leave it behind: inspect the recorded
owner and fixture/native/PM2 cleanup before manually removing it. Never infer
permission to resend interrupted work from lock age or a missing PID alone.

Each run creates a mode-0700 root directly under /tmp, private PM2 home and per-job TMPDIR.
The short root is required for macOS tsx/PM2 Unix socket path limits; the
user-temporary lock location remains shared by both commands.
HOME/SNOWFLAKE_HOME remain the normal terminal values for shared credentials;
no logout or account-isolation certification is attempted. Browser fixture
servers remain PM2-managed. Each probe runs as a detached owned process with
an external deadline, cancellation handler and eight-MiB private output limit.
The supervisor uses CortexProcessScope plus captured PID/birth identities,
and separately discovers the private PM2 daemon by its PID file and matching
God Daemon command/home so a detached or reused daemon is not lost from ownership,
awaits shutdown, verifies observed descendants have gone, and identity-checks
any additional cleanup. SIGINT/SIGTERM abort the active work; failure, timeout,
invalid evidence or failed cleanup stops the sequence without automatic retry.
Cleanup remains outside the cancelled work signal and PM2 kill has a separate
30-second bound. Each job drains private PM2 before verifying observed
processes. A dead/reused private PID file is removed without spawning a daemon
or signalling unrelated work; an unobservable/invalid owner cannot pass.
The normal activation and retained executable snapshot must
remain unchanged; drift fails the run without silently restoring/certifying a
new native version.

Shareable compatibility-report.json includes start/end, suite, selected/omitted
IDs, scope, CLI version/full distribution, OS/kernel/architecture/Node,
revision/dirty state, each job's exit/deadline/cancellation/log-limit/observed
process cleanup outcomes and validated native pass metadata. A report file
must be a regular non-symlink file of at most one MiB in exactly one expected
probe directory. Native version/OS/architecture/Node/revision must match;
missing/false pass or deadlineExceeded:true fails. Processor version metadata
may live under results.cliVersion. Only the fixed projected metadata/outcomes
enter the wrapper report; raw native keys, text, diagnostic errors, credentials,
connection/account/OAuth values and arbitrary result payloads are not copied.
Raw stdout/stderr, failure detail and native fixture directories are private
and must not be shared as an artifact bundle. Share only the wrapper JSON.

The report retains three historical observations independently of a later pass:
C49 saved-auth verification failure/cached-job timeout; C51 native activation
drift to 1.2.37 with unproven originating process; and isolated HOME with shared
SNOWFLAKE_HOME returning null auth. A clean rerun establishes neither root
cause nor supported isolation. C26, conditional C35, native Ubuntu/Windows and
physical mobile devices remain pending gates in every report. Complete workflows
remain outside the scope of backend/UI/auth-control and selected workflow reports.
C49's independent update-row-only mode remains outside the auth catalog.

Focused tests: test/cortexCompatRunner.test.ts covers catalog/argument scope,
metadata validation, absent/duplicate/symlink/oversize/malformed reports,
secret-bearing report projection, read-only listing, opt-in and competing lock.
test/cortexCompatProcess.test.ts exercises real POSIX child processes for private
output, timeout with detached SIGTERM-resistant descendants, unrelated process
preservation, no replay, cancellation, spawn failure, bounded output, stale/reused
PM2 PID files and an independently detached private daemon. The lock fixture
also opens a real Unix socket at the nested tsx-shaped path to catch path-limit
regressions. These
supervision fixtures are not authenticated native evidence; run the commands
with the actual retained CLI for that evidence. Mobile client source/contracts remain unchanged; CoCo server admission after
Stop now waits safely for the native drain, verified by the existing mobile probe.

C54 runner development retained an initial UI failure at PM2 fixture startup:
the former nested system-temp path exceeded the macOS tsx socket limit (EINVAL).
No auth check ran. The root moved to /tmp, and cleanup stopped invoking PM2 for
already-dead/stale daemon PID files. This diagnosed runner path failure does not
explain the distinct historical C49 authentication failures. The failed report
remains failed; corrected native evidence must be recorded separately. Run
from a developer checkout with locked root/mobile dependencies and Playwright
Chromium, since processor probes use test/helpers; these are not production
setup commands.


C54 also retained a native mobile abort-recovery failure after successful auth,
interactions, queues, usage, media, history and descendant cleanup: the next
explicit HTTP message hit the still-active CoCo owner and its response timed
out. The dedicated backend regression suspends the old stream consumer and
blocks native close to reproduce it. CoCo admission now waits for the aborted
owner's reset/drain before executing the explicit follow-up, retains that fence
through another Stop and rejects starting work after cleanup failure. Old
iterator cleanup cannot delete a newer owner. See test/cortexBackend.test.ts;
rerun native queue/mobile and interaction probes when this behavior changes.
No native prompt is retried and the shared HTTP terminal finalizer is unchanged.


The follow-up lifecycle regression holds an old native close while its session
entry has already been removed: both reset and shutdown must remain pending and
cancel the waiting successor. The adapter tracks direct reset promises outside
the session map and includes them/previous stopping in lifecycle completion.
Tests assert no extra native client/prompt, not merely the returned error text.


C54 acceptance: macOS 26.5 / Darwin 25.5.0 arm64, Node 26.0.0 and retained
CoCo 1.2.35+191333.f82de3d91715. Backend catalog 3/3 passed in
cockpit-cortex-backend-compat-P5CRXI; full UI catalog 5/5 passed in
cockpit-cortex-ui-compat-0UtAeo, including the previously failing explicit
post-Stop send. After final detached-drain lifecycle tracking, the affected
queue/mobile subset passed 2/2 (selected 2/5, with auth/interactions/usage omitted)
in cockpit-cortex-ui-compat-9uvXrT. Each directory retains its private
compatibility-report.json. Reports record revision 0cb97bb with dirty state;
these are working-tree validation, not a public release artifact or a new OS
login. They confirm observed process cleanup, private PM2 drain and unchanged
normal activation/retained executable. No failed report counts toward a pass.

Final frozen full V8: 180 suites / 3,002 tests pass; 3 opt-in native suites /
20 tests skipped. Statements/lines 88.72% (56,033/63,153), branches 76.95%
(13,319/17,307), functions 93.94% (2,853/3,037). Branch floor raised from 76.90%
to 76.92%; statements/lines retain 88.70% and functions 93.90%. The 74-test
focused backend/turn/runtime/shots/integration/queue set also passed. Finish
full Jest with frozen source before rebuilding clients/browser checks; mixed
source versions previously inflated V8 mappings and are not acceptance data.
Backend/web/mobile/tool types, zero-warning lint, maintainability, API spec
and ADR checks pass. Both client assets and bundle budget remain verified.

### CoCo complete workflow fixtures (P9 C55)

```sh
npm run e2e:cortex-code-workflows -- --list
npm run e2e:cortex-code-auth-control -- --list
CORTEX_CODE_E2E=1 npm run e2e:cortex-code-auth-control
CORTEX_CODE_E2E=1 npm run e2e:cortex-code-workflows
CORTEX_CODE_E2E=1 npm run e2e:cortex-code-workflows -- --probe kb
```

These catalogs use the same retained executable, serialization lock, bounded
process supervision, private temporary folders, validated metadata projection
and activation checks as C54. The workflow command builds both production clients
before native work. Finish full Jest first. Its real-account catalog uses shared
terminal auth; it never logs out or copies credentials. Test data, workspace files,
SQLite/PGLite and app settings are temporary. The browser fixture server is
PM2-managed with an isolated data root and private PM2 home. The service fixtures
use the existing in-process HTTP/WS test helper with the real CoCo adapter; its
registered mock adapter is never the selected profile. They do not claim that
every workflow was driven through a browser or a production process manager.

| Fixture | Actual workflow boundary and required results |
|---|---|
| chat | Real Cockpit HTTP/WS durable chat, native plugin/stdio MCP discovery, governed Memory note/search, SQLite topic reads/PGLite keyword search, usage once per turn, idle and adapter restart resume, delivered artifact, immutable workspace identity through relocation and native read/write in its new cwd. Memory governance runs through a separate authenticated Claude CLI; this does not enable strict CoCo Memory processors. |
| kb | Real ingestion/digestion/dream services and isolated stores; JPEG/PDF/DOCX/PPTX native AI conversion and duplicate reuse, PNG media preparation without changing original bytes, sequential digestion/gleaning, glossary expansion, real Ollama embeddings/vector search, native KB MCP, dreaming/re-dreaming/materialized topics, interrupted digestion with one attempt and fresh later inference. |
| context | Actual Workspace Context service and scheduler: disabled passivity, zero sources without inference, scan/uploaded sources, global/workspace profile/model/effort selection, direct markdown maintenance, eligible Memory consumption while retaining inactive entries/references/assets, run retention, scheduled scan/maintenance, Stop retaining pending Memory, and fresh inference afterward. Scheduler clock advancement is a fixture control. |
| routines | Actual chat proposal/validation/install plus Routine service/routes/scheduler: opt-in instructions, manual/scheduled runs, persistent state, output/temp/history/retention, explorer access, duplicate exclusion, real one-minute native deadline with no retry or failed-run notification, and disabled passivity. Outreach is an injected stub; no external message is sent. |
| mobile | Production Chromium mobile viewport and isolated PM2 app: profile/model/effort, real upload/image/text/OCR, cached OCR and model denial, invocation-only OCR choices, thinking/tools, socket replay, delivered artifact/preview/download, read-only history/reset, Stop/descendant drain and a fresh explicit turn with one interrupted tool attempt. This is browser evidence, not physical iOS/Android acceptance. |

Prerequisites beyond locked root/mobile dependencies and Playwright Chromium:
authenticated CoCo 1.2.35 with the selected connection and claude-sonnet-4-6;
authenticated `claude` (or CORTEX_TEST_MEMORY_COMMAND) for chat's separate Memory
governance; real Pandoc, LibreOffice and a running local Ollama containing
nomic-embed-text for KB. No fallback installs, mocked AI, skipped prerequisite
or automatic native retry can turn a missing dependency into a pass. Native
Routine timeout takes at least a minute. Strict Memory consolidation requires
restrictedText and now has its separate C35 catalog fixture on the exact retained
macOS arm64 build; KB dreaming remains tool-enabled. Titles/summaries retain
their existing fallback behavior. Unsupported native goals/agents/steering/media
and unknown Snowflake pricing retain their independent gates.

`CORTEX_WORKFLOW_CHECKS` in cortexCompatReports.ts lists fixed nested boolean
outcomes for each workflow. Full/selected workflow reports validate all required
checks in addition to native pass/version/revision/platform metadata. Missing
outcomes and truthy strings fail; the shareable report includes only the fixed
check labels and `evidenceComplete`, never raw native values. A full workflow
catalog pass removes the outside-workflow scope marker only for that catalog;
backend/UI/auth-control and selected workflow runs retain it. Other platform,
human OAuth and physical-device gates remain independent. A selected run without
restricted retains an explicit C35-outside-this-run marker.

The separate auth-control command does not select/read a saved connection or
pass CORTEX_TEST_CONNECTION into its probe. It still validates the real retained
executable using a synthetic name, then runs probe-cortex-missing-auth.ts with an
empty custom SNOWFLAKE_HOME. Its profile's custom home overrides only its child
environment; the parent's normal terminal credential home is unchanged. First,
the actual Cockpit HTTP/WS path must fail model selection before prompting,
because native empty auth omits its model catalog: one terminal frame, no tools
or usage, one saved user message. Then a separate low-level native prompt must
produce the version-tested no-connection error without complete usage, tool work
or a waiting login wizard. ACP/session creation never proves login. This is
expected failure evidence only, with an explicit authScope; it does not certify
account isolation, a real invalid account/key, token expiry or successful auth.
The fixture does not relax production configuration guards to reach inference.

Focused deterministic coverage lives in test/cortexCompatRunner.test.ts and
test/cortexCompatProcess.test.ts, alongside existing CoCo chat/KB/Context/Routine/
processor/mobile regression suites. There is no product UI, route, contract,
installer, capability or mobile source change in C55. Raw native reports/logs,
fixture settings and screenshots are private; share only compatibility-report.json.

C55 acceptance: all five workflow probes passed (62 required individual checks)
in /tmp/cockpit-cortex-workflows-compat-nlmgTo/compatibility-report.json;
the separate missing-auth catalog passed all eight required checks in
/tmp/cockpit-cortex-auth-control-compat-C2s9H4/compatibility-report.json.
Both record macOS/Darwin 25.5.0 arm64, Node 26.0.0,
CoCo 1.2.35+191333.f82de3d91715, revision ad0c55e and dirty working-tree state.
All observed processes and private PM2 drained, and native activation/retained
executable snapshots stayed unchanged. These are developer-checkout acceptance
reports, not public release or account-isolation evidence. Earlier auth-control
fixture expectations were corrected to retain the unavailable-model guard and
trim native error whitespace; their failed reports remain failed. Production
configuration/auth guards were unchanged.

Frozen full Jest: 180 suites / 3,003 tests pass; three opt-in suites / 20 tests
skipped. Statements/lines 88.71% (56,028/63,153), branches 76.94%
(13,320/17,310), functions 93.94% (2,853/3,037); existing floors remain intact.
Root/web/mobile/strict tooling types, zero-warning lint, maintainability,
189-route spec drift and 92 ADR checks pass. Both clients were rebuilt after
Jest by the workflow runner; desktop bundle budget passes. C26, conditional C35,
native Ubuntu/Windows, physical devices and C56–C59 remain separate.


### CoCo final scope and guard review (C56–C59)

`test/cortexIntegration.test.ts` adds behavior checks for all five native-goal
HTTP actions: 400 unsupported responses, no adapter goal invocation, no native
startup and no persisted prompt. Valid uploaded PDF/audio/video references emit
an unsupported-format terminal error/done without a native `session/prompt`,
tool activity or usage; request validation is distinct from native media admission. Existing
interaction/queue suites retain supported questions/plans and reject unsolicited
steering. Model/attachment/processor/usage suites preserve the versioned PNG,
strict Memory and unknown Snowflake cost gates. The 6-suite/53-test focused set
passed before frozen full coverage.

C56 decisions are [recorded separately](research/cortex-code-capability-decisions.md).
C57 public/reference docs describe the implemented scope without new runtime
switches or schemas. C59 [review preparation](design/cortex-code-review.md)
records ADR/mobile impact, residual gates and local PR text. Full C58 commands
run before browser probes; the final review records exact results and selected
native catalogs. Existing C55 workflow evidence remains applicable only while
production runtime/client/scripts/config match the tested tree. A fresh UI pass
does not replace workflow/platform/human OAuth evidence.


C58 final acceptance: raised-floor frozen full V8 passed 180 suites/3,005 tests
(20 opt-in tests skipped), 88.75% statements/lines, 77.04% branches and 93.94%
functions. Floors are 88.72/77.00/93.90 respectively. Fresh full native backend
3/3, UI 5/5 and separate missing-auth 1/1 passed on retained 1.2.35/macOS arm64,
with no omitted probes, observed process/private PM2 drain and unchanged native
activation/executable. Both UI assets were rebuilt after full Jest. Exact report
roots, metadata, retained C55 workflow scope, type/lint/spec/ADR/budget checks
and residual gates are recorded in [the final review](design/cortex-code-review.md#final-c58-validation).
This review does not certify C26, C35, native Ubuntu/Windows, physical devices,
new CLI versions or the deferred C56 feature set.

## CoCo Windows runtime preparation (C53)

Native Windows acceptance remains open. The implementation and native checklist
are in [Windows acceptance preparation](research/cortex-code-windows-acceptance.md).

- `test/cortexWindows.test.ts`: simulated Windows x64 standalone/explicit/PATH
  discovery, literal argv, environment casing and forced controls, shared/custom
  auth homes, synthetic OAuth with post-login verification, passive import,
  responding Install Doctor and manual install/update policy.
- `test/cortexWindowsLaunch.test.ts`: pinned executable/version/ACP ownership,
  hidden non-detached piped startup, abort and failed-negotiation draining.
- `test/cortexWindowsProcess.test.ts`: identity-only snapshot parsing, held-handle
  script construction, detached/reused/older/unrelated identity handling,
  enumeration/helper failures, surviving owners and idempotent stop. PowerShell
  is mocked; script assertions do not prove actual Windows execution.
- Existing runtime/process/login/auth/connection/migration/update/doctor and
  Windows/macOS installer/release/private-Node wrapper tests remain regressions.
  Invalid migrated Windows CoCo commands become per-target errors before any
  version command, rather than aborting the whole CLI Update check.

No web/mobile source, API, persisted schema or PWA metadata changes. Full Jest
must finish before rebuilding assets or running native browser checks. The
existing native CoCo catalogs remain macOS-scoped; no Windows pass is implied.

C53's final frozen full V8 passes 183 suites / 3,028 tests (20 opt-in tests
skipped): 88.75% statements/lines, 77.21% branches, 93.94% functions. Floors are
88.74/77.12/93.90. Focused Windows/macOS regressions pass 20 suites / 219 tests;
the final three Windows-specific suites pass 21 cases. The follow-up in
[the implementation review](design/cortex-code-review.md#c53-autonomous-follow-up-2026-11-09)
records exact native subset scope and remaining gates.


## CoCo restricted Memory (C35)

`test/cortexRestricted.test.ts` runs an actual JSONL process fixture through the
adapter. It covers private home/cwd and forced env, exact deny argv, wrapped
slash input, sequential continuity, build/platform guards, zero-catalog startup,
timeout/abort/shutdown/reuse and fail-closed native output with no retry.
`test/cortexRestrictedStream.test.ts` covers catalog/session/result ownership,
UTF-8 fragmentation, tool/control frames, incomplete usage, oversized/malformed
output, exit and cleanup errors. Existing processor, Memory and rendered selector
suites verify role eligibility and retained unavailable choices. Migration suites
exclude/reject transient restricted homes, including empty directories.

Run native proof only with authenticated shared terminal credentials and the
exact macOS arm64 distribution:

```sh
CORTEX_RESTRICTED_PROBE=1 npx tsx scripts/probe-cortex-restricted.ts
CORTEX_CODE_E2E=1 npm run e2e:cortex-code-workflows -- --probe restricted
```

The workflow catalog now includes six probes: chat, restricted, kb, context,
routines and mobile; its outer deadline is 85 minutes. The restricted probe is
an isolated HTTP/service fixture, with working hook/MCP positive controls,
private-config hostile-input/sequential checks and real Memory governance,
extraction, proposal, rewrite/apply. Native debug capture projects actual request
schema/resource counts before production temp cleanup; it never publishes raw
prompts/account fields. Abort waits for an observed active request, then verifies
cleanup and fresh inference. Runner validation requires every outcome, not just
exit success. Full Jest must finish before catalog builds/browser checks.

The retained report and failed first harness attempt are documented in
[the C35 evidence](research/cortex-code-restricted-processors.md). Nine actual
requests in eight inference jobs passed with zero tools/resources; a ninth job
rejected empty connection configuration before inference. The final selected
catalog validates 14 outcomes, including actual MCP initialize/tools-list. This certifies strict
Memory only on that distribution/platform; prior strict-Memory deferrals in
historical checkpoint sections are superseded for this scope. C26, C52/C53,
physical devices, new releases and account isolation remain independent.


### Post-review descendant and mobile draft regressions (2026-11-09)

The ACP executable fixture starts a short-lived parent during a prompt and
returns the prompt result before that parent forks a detached child. The real
runtime test waits for the parent to exit, then closes the runtime and requires
the detached child to be gone. It failed with prompt-dependent scan pacing and
passes with continuous runtime-lifetime scans. Process tests also verify one
watcher, normal cadence through idle time and no scans after stop.

The rendered mobile pipeline tests hold a message-mode answer request pending
while keeping a separate composer draft/uploads. They verify no initial clearing,
no unrelated uploads in the answer request, and preservation of newer draft/
upload edits after both success and failure. The cases failed before the fix.

Final frozen full V8 run: 185 suites / 3,084 tests passed, with the existing
three opt-in suites / 20 tests skipped. Statements/lines: 88.81%
(56,463/63,572), branches: 77.36% (13,677/17,678), functions: 94.02%
(2,882/3,065). Floors raised to 88.80/77.34/93.98 and verified against the same
LCOV collection; unchanged tests were not recollected solely for that config edit.
Backend/web/mobile types, zero-warning lint, maintainability, spec/ADR checks,
production client builds and web bundle budget passed.

Native CoCo 1.2.35/macOS arm64 selected runtime probe passed 1/1 (selected 1/3)
at `/tmp/cockpit-cortex-backend-compat-GZ0xmU/compatibility-report.json`; selected
production desktop/mobile queue probe passed 1/1 (selected 1/5) at
`/tmp/cockpit-cortex-ui-compat-vyRYFi/compatibility-report.json`. These retain
shared terminal auth and prove their scoped cancellation/root-exit/resume and
question/draft/reconnect/Stop/queue paths. The delayed post-prompt fork and
message-mode composer preservation are the dedicated deterministic regressions;
no new native platform, human OAuth, full-catalog or physical-device claim.

Reset admission client regressions in `test/streamStore.test.ts` distinguish active-stream `409` from temporary reset `503` for direct and queued sends: both retain drafts/attachments or queue entries, but only `409` enters streaming state. `test/mobileSendPipeline.test.ts` exercises a real send through the hook with a reset `503`, verifies only-if-active recovery, restores the draft/attachments, removes optimistic text, and finishes local streaming.

`test/chat.worktreeIsolation.test.ts` also verifies reset/mode-change versus
archive/delete exclusion in both request orders, checkout preservation during
cleanup, and admission release/retry when archive/delete cleanup fails.
`test/streamJobSupervisor.test.ts` covers cleanup admission for an active runtime
and rejection of an existing conversation/workspace reservation.
`test/copilotProcess.test.ts` starts a second turn immediately after abort and
requires the TERM-resistant old worker to be dead before the new native spawn.
All process readiness PID files publish by rename so readers cannot see an empty
file between creation and writing.

## Native Copilot goal qualification

The goal suites extend `test/copilotSdkRuntime.e2e.test.ts` with real set,
completion/replacement, removed-Clear refusal, idle-state semantics, worker
pause/Stop/reset followed by explicit credit resume, subsequent normal questions,
and background-delegate drain. Use `npm run e2e:copilot-sdk -- --testNamePattern 'goal|objective'` for that subset. Idle-state tests use public send plus observed
session.idle instead of SDK sendAndWait, which may keep waiting for an active
objective. Bound model requests and external cancellation in background fixtures.

Steering fixtures prove exactly one persisted `user.message` correction with
delivery:steering rather than an exact model reply count: native shell background
completion can append another valid root response. Final-boundary refusal still
requires one response and no replay on cold resume. Executable-peer tests also
prove a terminal event during goal RPC admission cannot submit a later prompt,
and that a recovered goal retains its mandatory snapshot-read instructions.

Four added desktop/mobile browser cases cover completion/reload, pause/worker
termination without a false failure, no Clear, explicit decimal credit windows
and no interrupted worker replay. All 26 cases include the previous catalog,
Memory, delegation, questions, steering and lifecycle checks. Entry JS budget is
264 KiB from the measured 263.4 KiB result; total JS stays 903 KiB and other limits
stay unchanged. Rebuild clients after Jest asset fixtures before browser/budget
validation. The measured production bundle is 902.7 KiB JS and 201.8 KiB CSS.

All 26 native SDK cases pass on CLI 1.0.105 / SDK 1.0.28 / Node 22.23.4 / macOS
arm64. Report `copilot-sdk-compat-uIwMvj` retains the pre-commit revision f0b2188
and dirty:true. All 39 recorded owned runtime PIDs are stopped. Six real-CLI
Memory/Context workflow cases pass. These are fixed local-model checks, separate
from hosted billing/access and native Windows/Linux certification.

Atomic stream/poll terminal-card persistence is Copilot-specific. Existing Codex
stream-card behavior is preserved, including separate achievements when starting
the exact same objective twice; `test/chat.rest.test.ts` reproduces that boundary.
The focused regression fails with whole-history stream dedupe and passes after
scoping the new path. Other backends retain their previous per-stream persistence
and pause-card behavior. The goal-status route keeps its existing historical
poll dedupe. Final coverage and browser reports are recorded with the checkpoint.

Final coverage passes **162 suites / 2,967 tests** (six opt-in/platform suites and
60 tests skipped), with **88.86% statements/lines, 76.85% branches and 93.76%
functions**. Raised floors remain 88.7% statements/lines, 76.6% branches and 93.6%
functions. This checkpoint adds 30 normal-CI cases, including the Codex compatibility
regression, six native SDK cases, and four desktop/mobile browser cases.

All 26 final rebuilt Chromium desktop/mobile cases pass; report
`cockpit-copilot-ui-jDQhgU` records 46 SDK runtime launches with CLI 1.0.105 on
macOS arm64/Node 26.0.0. Fixture PM2 and all three recorded tool workers are
stopped. Backend/web/mobile typechecks, zero-warning lint, maintainability, spec
drift, ADR lint, production builds and the 902.7/903 KiB JS plus 201.8/230 KiB CSS
budget all pass. Report revisions/dirty flags are retained, never relabeled after
the local commit. Hosted accounts, billing judgment and native Windows/Linux
remain separate qualification.

### Copilot usage qualification checkpoint

Phase 8 passes 166 suites / 2,995 normal-CI cases (28 added), with 62
opt-in/platform cases skipped and a clean Jest exit. Final coverage measures
88.90% statements/lines, 77.01% branches and 93.81% functions; raised floors
are 88.8% / 76.8% / 93.7%. Retained measurements explicitly clear those floors.
Twenty-eight native SDK cases pass on CLI 1.0.105 / SDK 1.0.28 / Node 22.23.4 /
macOS arm64, including root context, unknown-zero AI credits and an owned no-auth
quota read that creates no session/inference and closes its process. All 39
recorded conversation runtime PIDs are stopped. Six native Memory/Context
workflows pass after the historical-coverage guard. No hosted-billing, genuine
two-account or native Windows/Linux evidence is implied.

All 30 rebuilt Chromium desktop/mobile cases pass, with 57 observed headless
SDK launches. New cases check two-turn disjoint usage (160 fresh input, 60 output,
80 cache read), persistent root context/credit availability after reload, and
stale/unavailable quota. Four browser cases inject catalog or quota data while
the remaining checks exercise native fixed-provider paths; quota injection is
not hosted entitlement evidence. The first two new reload failures were fixture
title races from normal auto-titling; explicit human titles stabilize those
fixtures. Their original screenshots/traces are retained. Desktop/mobile usage
and quota screenshots are reviewed; the fixture PM2 daemon and all three recorded
tool workers are stopped.

Open-handle diagnosis found native canvas CustomGC from a top-level import in
the skipped hosted media suite. Canvas now loads only inside its opt-in image/PDF
test; focused diagnostics and the complete final coverage command exit cleanly.
A direct deferred import/PNG smoke check also passes, without hosted inference.
Production assets are rebuilt after full Jest fixtures; bundle checks pass at
906.1 KiB JS / 907, 201.8 KiB CSS / 230 and 266.9 KiB entry / 267. CSS/vendor/other
chunk caps are retained. Backend/web/mobile types, zero-warning lint,
maintainability, 187-route spec drift and 97-ADR lint pass.

Reports: native `copilot-sdk-compat-xj8cgU`, browser `cockpit-copilot-ui-A1P284`
under the system temp directory. Reports preserve actual pre-commit revision
`cb7d250` plus dirty state; they are not relabeled after committing.

### Copilot media and artifact qualification

Normal-CI tests now cover `copilotMedia.ts`, `copilotArtifacts.ts`, production
chat artifact storage through an executable SDK peer, and mobile live artifact
state/actions. Admission tests verify refusals before user-message persistence
or tools. Facade/conversation tests verify explicit attachments, configured-model
one-shots, missing-session recovery, conservative SDK PDF qualification, and
JSONL compatibility flags. Repeated completions and overlapping native output
views cannot duplicate a tool's bytes; late/unknown children cannot deliver them.

The native SDK suite adds six fixed-provider cases: image-only input with no
tools; MCP image/PDF bytes using normal native config discovery; Anthropic PDF
and image byte transport without tools; image chat across cold resume plus PDF
refusal; Anthropic chat PDF; and a restricted PDF one-shot with zero tools.
Evidence uses selected CLI 1.0.105/SDK 1.0.28/Node 22.23.4/macOS arm64. Both raw
model requests and projected bytes are checked, not just fixed reply text.

The browser suite adds eight desktop/mobile cases: repeated image uploads and
reload; a refused OpenAI-provider PDF with retained draft/files; native output
plus FILE_DELIVERY; and output surviving Stop/reload. Downloads are byte-equal
to original PNG/PDF fixtures and saved descriptors retain scoped tool IDs.
Stopped desktop turns are expanded through their existing progress breadcrumb.
Initial fixture-home and locator errors remain in their reports; the final
qualification below identifies successful evidence separately. Hosted SDK PDF,
real account/model judgment and native Windows/Linux SDK media remain unverified.

Final review adds a completion-only artifact replay regression: a missing-session
error after output must not snapshot/recover or submit another prompt. Both the
pure projection and executable SDK peer regressions fail before the fix and pass
after it. Open-handle diagnosis identified unused top-level native canvas import
through chat upload normalization. Canvas now loads only for DNG previews that
actually need resizing; focused DNG/parser/upload checks preserve existing behavior.

`test/copilotJsonRpc.test.ts` also classifies reserved transport error codes and closed/disposed connections without relabeling application or already-listening errors. It covers the scoped public reader workaround for
vscode-jsonrpc 8.2.1's recurring partial-message timer after disposal. Other
readers retain their defaults; complete fragmented messages still decode. A
separate actual SDK subprocess receives a deliberately truncated frame and must
exit naturally within 10 seconds, making dependency drift fail promptly. The
conversation suite also verifies terminal transport frames and process cleanup.
The native image GC diagnostic was removed by lazy DNG-only canvas initialization;
subsequent inspector diagnosis identified the recurring JSON-RPC timer as the
remaining process-exit blocker. No forced-exit test setting is used.

Phase 9 final evidence: full coverage exits 0 with 170 suites / 3,018 tests (68
skipped), 88.92% statements/lines, 77.19% branches and 93.82% functions. Floors
are 88.85% statements/lines, 76.95% branches and 93.75% functions. All 34 native
SDK cases pass (`copilot-sdk-compat-HVrO0s`); all 44 recorded runtime PIDs are
gone. Six native Memory/Context workflows pass. All 38 rebuilt Chromium
desktop/mobile cases pass (`cockpit-copilot-ui-lecidK`, 71 SDK launches); fixture
PM2 and its three recorded tool workers are stopped. Reports retain their actual
f6c694e revision plus dirty state. Desktop budget is 906.1/907 KiB JS and
201.8/230 KiB CSS, with other caps unchanged. Typechecks, zero-warning lint,
maintainability, spec drift and ADR lint pass. Hosted account/SDK PDF and native
Windows/Linux SDK qualification remain outstanding.

### Copilot shared authentication qualification

The 2026-11-04 checkpoint adds guided shared-terminal device login, fresh
credential/catalog verification, cross-profile login admission and awaited
cleanup, terminal browser-cache invalidation, and desktop/narrow auth controls.
A rejected auth-service shutdown is logged by the chat router so independent
backend/updater cleanup can continue. The direct failure-path regressions must
remain alongside the successful native cases.

Final normal CI: 172 suites / 3,052 passing tests (70 opt-in skips), with
88.95% statements/lines, 77.32% branches and 93.83% functions. The branch floor
rises from 76.95% to 77.10%; the other floors stay at 88.85% statements/lines
and 93.75% functions. All 63 focused auth/runtime/shutdown regressions and 13
final browser API/status regressions pass.

Native CLI 1.0.105 / SDK 1.0.28 / Node 22.23.4 / macOS arm64 evidence:

- `copilot-sdk-compat-DX4F2G`: all 34 SDK cases pass; all 44 recorded runtime
  PIDs exited.
- `copilot-auth-compat-A0bPMd`: both auth cases pass, including two device-code
  cancellation cycles; all eight recorded processes exited. The runner resolves
  version launches through the same CLI resolver/invocation builder as auth,
  including managed Windows entrypoints; this macOS result does not qualify
  native Windows behavior.
- All six Memory/Context native application workflows pass. Native KB/Routine
  application qualification remains a phase 10 item; their existing normal-CI
  integration cases pass.

`cockpit-copilot-ui-Ijs6Wz` passes all 40 Chromium cases with 71 SDK runtime
launches on Node 26.0.0/macOS arm64. Four catalog/quota and two auth-state cases
use injected account responses; the latter do not perform OAuth. Desktop/narrow
screenshots were reviewed. Fixture PM2 and recorded tool/delegate/goal workers
are gone. Final post-coverage web/mobile builds and unchanged bundle caps pass:
906.4 KiB JS / 907, 201.8 KiB CSS / 230. The preceding full browser report
`cockpit-copilot-ui-fjGS0Z` also passed 40 cases but exposed entry/settings chunks
17/36 bytes over their caps; shorter auth copy and a simpler trusted job-status
guard resolve this without increasing budgets.

Backend/web/mobile types, zero-warning lint, maintainability, 187-route spec
checks and all 97 ADR validations pass. Reports retain revision `15e7afd` plus
a dirty flag rather than claiming a later committed SHA. A fresh normal-account
check still returns authenticated credentials with model catalog HTTP 403.
Successful OAuth/entitlement, real expired credentials, genuine independent
accounts and native Linux/Windows auth remain unverified. No normal server,
shared CLI installation or terminal login was replaced by these checks.

### Copilot native KB and Routine qualification

`npm run e2e:copilot-workflows` runs twelve POSIX application cases: the six
Memory/Context cases and the six shared cases in `copilotKbRoutines.test.ts`.
Ordinary CI retains the executable JSONL fixture; the opt-in runner sets
`COPILOT_WORKFLOWS_E2E=1` and uses the real CLI. `COPILOT_WORKFLOW_CLI` can select
a CLI executable without replacing the installed command. The runner reads the
installed SDK version and records CLI path/version, SDK, OS/architecture, Node,
revision/dirty state, Jest JSON results, and per-case process/file receipts in
a temporary `copilot-workflows-compat-*` folder. Native Windows is rejected
explicitly rather than reporting a skipped suite as successful qualification.

The KB/Routine model fixture chooses fixed tool calls and structured responses;
production services and native tools still perform the work:

- Digestion reads `knowledge/converted/<rawId>/text.md` with a real native tool,
  then persists digest and glean entries. Gleaning requires the replayed first
  response in its actual request. Invalid digestion creates no partial entries
  and succeeds after a corrected retry.
- Dreaming reads persisted entry markdown, exhausts the documented two-attempt
  malformed-output parse path without consuming pending synthesis, then applies
  corrected topic/assignment operations and writes synthesis markdown. A new
  SDK chat calls production KB `get_topic` through the real stdio/HTTP MCP path
  and retrieves both the durable marker and assigned entry IDs. This retrieval
  does not exercise embedding search or ranking.
- Disabled Routines create no scaffold or process. An enabled Routine validates
  proposal-path containment, reads the actual routine markdown with a native
  tool, writes `fixture.txt` in the authorized run output folder, persists final
  output/history, and leaves notifications disabled. Overlapping runs fail.
- Digestion and Routine shutdown each stop a native bash worker and its detached
  child before the test retries. Interrupted digestion keeps raw data without
  entries; interrupted Routines persist failed history. Both later retries
  complete. Per-case teardown also rejects surviving recorded CLI/launcher PIDs.

Final native evidence is `copilot-workflows-compat-Gll9d6`: twelve passing
cases, CLI 1.0.105 / SDK 1.0.28 / Node 26.0.0 / macOS arm64, revision `88f3d5b`
plus dirty state. All 72 recorded PIDs exited; the report records 29 processor
calls, five SDK launches and two detached-worker cases. The earlier complete
run `copilot-workflows-compat-nou39F` also passes all twelve cases (70 recorded
PIDs exited). The first processor-only report
`copilot-workflows-compat-2BGjDO` retains two corrected test-expectation failures
(converted source path and documented dreaming retry count); no application
behavior was changed to make those assertions pass.

No production route, contract, runtime or client behavior changes at this
checkpoint. Mobile PWA assets, metadata, service worker and UX require no change.
The prior forty-case browser result remains separate evidence; this command is
an application/native-tool qualification. No hosted account, model judgment,
embedding quality, independent-account isolation or native Windows/Linux
certification is implied. Existing normal server and shared CLI/auth remain
untouched. Test/evidence changes follow the existing runtime decision; no new
ADR is required.

Final normal-CI verification for this checkpoint passes 172 suites / 3,052
tests (70 opt-in skips), with 88.96% statements/lines, 77.31% branches and
93.83% functions. Existing floors remain 88.85% statements/lines, 77.10%
branches and 93.75% functions; no production coverage policy changed. Twenty
focused application regressions pass. Backend/web/mobile typechecks,
zero-warning lint, maintainability, 187-route spec drift and all 97 ADR checks
pass. After the full Jest asset fixtures exited, both clients were rebuilt;
unchanged budgets pass at 906.4/907 KiB JS and 201.8/230 KiB CSS. Retained logs
are `phase10-coverage.log`, `phase10-final-native-workflows.log` and
`phase10-post-coverage-*` under the temporary parity-plan folder.

### Copilot published CI evidence

The native SDK qualification fixture allows up to 60 seconds per startup phase
on Windows (port announcement and SDK handshake), retaining 15 seconds on
macOS/Linux. Its setup-hook limit covers both phases and bounded diagnostic/
cleanup work. This is fixture setup headroom for cold wrapper/CLI initialization,
not a change to production's 15-second phase deadlines or an automatic retry.
`startup-timings.jsonl` records the synthetic case name, elapsed startup/status
time and phase limit; it contains no credentials or environment snapshots.
Startup failure still fails every dependent case and requires owned cleanup.
The native Windows Job Object fixtures similarly allow 60 seconds for the
first worker to start, within a 75-second case deadline covering cleanup. The
argv/UTF-8 and missing-executable cases use the same case bound. Their orphan
termination/unrelated-process assertions and production cleanup deadlines stay
unchanged; these cases test containment, not cold-start performance.

[Run 41954476405](https://github.com/daronyondem/agent-cockpit/actions/runs/41954476405)
builds PR head `9fb54f7` using clean GitHub PR merge revision
`88fd464eea529f45ef426e3bd440a21fa4c6a050`. The retained artifacts and completed
job logs establish the following results on Node 22.23.4 / SDK 1.0.28:

| Job | Result | Retained evidence and boundary |
| --- | --- | --- |
| SDK / Ubuntu 24.04 x64 | 34 passed | `copilot-sdk-compat-t2gCB7`, native CLI 1.0.105 / protocol 3, clean revision, exit 0. |
| SDK / macOS 15 arm64 | 34 passed | `copilot-sdk-compat-T3gQum`, native CLI 1.0.105 / protocol 3, clean revision, exit 0. |
| Ubuntu desktop/PWA Chromium | 40 passed | `cockpit-copilot-ui-VzWe3e`, native CLI 1.0.105, 68 SDK launches, clean revision, exit 0. Includes injected account/catalog states as in local browser qualification. |
| Windows Job Object/stdio | Passed | Node process fixtures; no native Copilot session claim. |
| Ubuntu coverage | Tests pass; gate fails | 172 suites / 3,052 tests pass (70 skips). Statements/lines 88.81%, branches 77.38%, functions 94.00%; statements/lines miss the unchanged 88.85% floor. Exit 1. |
| SDK / Windows x64 | 33 failed, one skipped | `copilot-sdk-compat-ir6kD8`, exit 1, `cli:null`. Every executed case times out waiting for headless port announcement; the error is `Copilot runtime did not announce a port`. This is an observed startup failure, not successful Windows qualification. |

The main tests/builds/quality job and separate ADR workflow pass on that initial
source head. Its Windows startup and coverage failures are historical CI
failures, separate from accepted capability limits.

[Run 41959562270](https://github.com/daronyondem/agent-cockpit/actions/runs/41959562270)
checks source `f5dbe5e` at clean PR merge `a722ecc7f0a9ce99aba86f8a03a7f51b4671f11f`.
All three SDK jobs pass: **34 on Ubuntu/macOS and 33 on Windows**, with one
Windows skip for the POSIX-only command-wrapper scenario. Windows report
`copilot-sdk-compat-UBnntO` records CLI 1.0.105 / protocol 3 / SDK 1.0.28 /
Node 22.23.4 / exit 0. The fixture now preserves OS initialization variables
while isolating auth, and production cleanup awaits Windows wrapper closure.
This supersedes the initial startup failure for these fixed-model SDK paths.

Subsequent test alignment makes older Windows process mocks emit close, waits
for profile goal capability discovery before submitting a browser goal, and
waits for persisted delegated summaries before reload. Mobile Stop retains its
streaming state until abort and refreshes complete. The browser test deliberately
holds abort to verify immediate replacement cannot be submitted early. All 40
browser cases pass locally at source `f5dbe5e`; the four goal browser cases also
pass after adding the capability-readiness wait. Six HTTP regressions cover
profile locking/repair, invalid admission, missing goal history and quota/catalog
failure retries; three unit cases cover Windows close/fallback/timeout. Coverage
floors remain 88.85% statements/lines, 77.10% branches and 93.75% functions;
[current PR checks](https://github.com/daronyondem/agent-cockpit/pull/571/checks)
report the latest full quality-gate result.

These results extend the earlier Ubuntu JSONL-only evidence to SDK sessions and
SDK browser workflows. They do not establish hosted OAuth/entitlement/billing,
expired credentials, two independent accounts, platform keychain behavior or
the full native application suite on Linux/Windows. The accepted documentation
scope keeps those limits explicit alongside the
[known capability gaps](reference/backend-capabilities.md#copilot-known-capability-gaps).

### Copilot hosted manual evidence and steering follow-up

The [owner's 2026-11-05 report](https://github.com/daronyondem/agent-cockpit/pull/571#issuecomment-6658673116)
uses clean `9cb25d6`, Agent Cockpit 0.4.166, CLI 1.0.105 / SDK 1.0.28 /
Node 25.9.0 / macOS 26.7.1 arm64, normal hosted inference and existing shared
terminal login. It reports 20 enabled models and successful hosted access after
restart, terminal continuity, web/narrow-PWA core chat/native questions/tools/
files/resume/Stop, model selection and invalid admission, web steering on retest,
delegated summaries, native goal completion, separate usage/quota units,
Memory-to-Context recall, KB keyword retrieval, a manual Routine and explicit
`gpt-6.1-sol` image input. These are manual owner observations, not reproduced CI
results. Chrome version/account policy are absent; no physical phone was used.
The [research record](research/copilot-sdk-parity-evaluation.md#owner-reported-hosted-validation--2026-11-05)
retains the scenario results and measured usage, including their limits.

One hosted failure remains open: Steer during a 60-second foreground command in
a conversation with prior chat/tools ended with `No response was returned` in
the narrow PWA. The error persisted with source `backend`; that fallback label
does not identify its origin. No active stream/queue remained, no resend was
performed, and `/input` status/native delivery evidence was not captured. Web
retest success does not establish PWA-only scope. Full OAuth challenge
completion, hosted goal pause/reload/fresh-limit resume, live PWA delegation,
physical-device behavior, real expired/denied credentials and two accounts stay
unconfirmed/not run. Usage observation consistency is not a billing audit.

`test/copilotSdkRuntime.e2e.test.ts` now adds production-adapter cases that warm
a native session with an actual shell tool, resume it, start a real
release-file worker, deliver a correlated correction while that worker is
running, and cold-resume afterward. Completion delays of 300 ms and 61 seconds
cover both prompt delivery and a long-running tool. They check one native
steering delivery, the corrected response, exactly two shell executions across
all turns, no errors and no replay. Native automatic background read/completion may add a
root response without another correction or shell execution.
`test/e2e/copilot.ui.pw.ts` adds the same sequence on desktop and PWA: reload the
warmed conversation, submit Steer with current turn/input IDs, require HTTP 200,
check worker completion and corrected output, an empty queue/cleared draft, and
a successful follow-up after reload with unchanged execution receipts. These
fixed-model regressions improve timing/lifecycle coverage; they do not qualify
hosted model behavior or close the manual finding.

The local follow-up passes **36 native SDK cases** (CLI 1.0.105 / SDK 1.0.28 /
protocol 3 / Node 22.23.4) in `copilot-sdk-compat-c6QMWO`, **42 Chromium cases**
on Node 26.0.0 in `cockpit-copilot-ui-TJqljW`, and 65 focused input/conversation/
HTTP/mobile-pipeline tests. Both reports identify macOS arm64 with uncommitted
follow-up changes: native source `d1d4675`, browser source `9cb25d6`. They are not
clean-head CI evidence. Browser evidence records 83 SDK launches. The fixture's
final response waits for the running worker to finish, matching the correction's
requested ordering; both the short and 61-second native cases pass.
Backend/web/mobile typechecks, zero-warning lint, maintainability, spec drift,
ADR lint and the unchanged client bundle budget pass. No production behavior,
coverage floor or platform authentication claim changes in this follow-up.

The desktop/mobile goal pause/resume browser case waits for HTTP 200 with the
completed native goal snapshot before checking its objective, fresh AI-credit
limit and absent token budget. A terminal goal frame and visible Send control
can precede the native owner's reset-cleanup drain; an immediate status read can
return the temporary `Copilot is shutting down or resetting.` error. Use bounded
`expect.poll` for the status response and snapshot together, preserving all
final-state assertions rather than adding sleeps, retries of goal execution or
changes to production cleanup/admission. A persistent status error still fails.

A fresh local read-only shared-auth/catalog probe on 2026-11-05 at 16:16 UTC
reports authenticated credentials but zero available models and HTTP 403. It
creates no inference session and changes no login. This limits hosted testing
in this environment; it does not override the owner's reported successful
20-model catalog on the same CLI version or establish that both probes used
the same account/policy. Account identity was not recorded in the owner report.


### CoCo/Copilot main integration (2026-11-09)

The CoCo branch incorporates `main` at `6cbbb3b`, including Copilot SDK support
and the current release dependency/security updates. Shared harness registration,
profile/auth routes, input contracts, reducers, desktop/mobile controls and docs
retain both integrations. CoCo's Proposed ADR is renumbered 0099 because main's
Copilot ADR already owns 0093; Accepted Copilot records are unchanged.

The extracted composer picker retains Copilot profile-local goal/steering
metadata, timer/focus discovery, missing-model preservation and fallback labels.
The mobile composer uses the current owned input token for its steering hint;
static Copilot metadata intentionally leaves SDK controls disabled. The existing
native mobile steering cases reproduced the incorrect hint and pass after the
fix. CoCo decision generations remain separate from Copilot request/turn/input
IDs. Both retain exact question ownership, duplicate exclusion and newer drafts.

Shared auth shutdown closes admission before CoCo checks are delegated, aborts
both owners and waits for every drain before propagating a cleanup error. The
new `copilotDeviceAuth.test.ts` regression reproduced early completion when a
Copilot cleanup error raced a pending CoCo drain; it also checks late CoCo status
and login admission without invoking native work. Focused auth tests pass 64
cases. The final frozen full run passes 224 suites / 3,581 tests (seven suites /
72 tests skipped); statements/lines 89.68%, branches 79.65%, functions 94.31%.
Floors are raised to 89.45/79.45/94.10. The subsequent mobile hint-only correction
is outside backend coverage and has fresh mobile types/lint/native UI evidence.

Native macOS arm64 evidence:

- CoCo 1.2.35 selected runtime passes 1/1 (selected 1/3), including cancellation,
  root-exit/descendant cleanup and session reuse. Report:
  `/tmp/cockpit-cortex-backend-compat-ndyBG2/compatibility-report.json`.
- CoCo selected production desktop/mobile interaction and queue probes pass 2/2
  (selected 2/5), with owned cleanup. Report:
  `/tmp/cockpit-cortex-ui-compat-O75DxQ/compatibility-report.json`.
- CoCo saved-auth/setup/catalog/responsive handoff probe passes 1/1 (selected
  1/5), including real fresh-process inference and separately labeled synthetic
  handoff/clipboard lifecycle cases. Report:
  `/tmp/cockpit-cortex-ui-compat-WbTkZd/compatibility-report.json`. This is not C26.
- Copilot CLI 1.0.105 / SDK 1.0.28 passes 36 native SDK cases and two isolated
  logged-out/device-code cancellation cases. Reports are
  `copilot-sdk-compat-SzfIjw/compatibility-report.json` and
  `copilot-auth-compat-3VWjnV/compatibility-report.json` under the system temp root.
- Copilot production desktop/mobile Chromium passes all 42 cases, with 84 SDK
  launches and exit 0. This includes actual steering during running tools,
  questions, Stop/resume, goals, media/artifacts and auth/catalog projections.
  Report: `cockpit-copilot-ui-1RYKCM/compatibility-report.json` under the system
  temp root. Replies/auth are isolated fixtures; hosted entitlement is not proved.

Backend/web/mobile types, zero-warning lint, maintainability, spec drift and ADR
lint pass. Both clients rebuild after full Jest; combined desktop JS measures
923.2 KiB against 924 KiB and CSS 202.5 KiB against 230 KiB. The combined Settings
chunk measures 80.8 KiB against 81 KiB. Keep full Jest separate from native UI.
These results do not close human CoCo OAuth C26, native Ubuntu C52, native Windows
C53, physical-device or hosted-account qualification.
