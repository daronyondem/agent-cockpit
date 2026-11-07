---
id: 0093
title: Integrate Cortex Code through its native ACP interface
status: Proposed
date: 2026-11-05
supersedes: []
superseded-by: null
tags: [backends, profiles, protocol, authentication]
affects:
  - docs/design/cortex-code-implementation-plan.md
  - docs/research/cortex-code-acp-evaluation.md
  - scripts/probe-cortex-phase0.ts
  - test/fixtures/cortex/1.2.35
  - src/contracts/cliProfiles.ts
  - src/contracts/backendCapabilities.ts
  - src/types/cliProfiles.ts
  - src/types/backends.ts
  - src/services/cliProfiles.ts
  - src/services/settingsService.ts
  - src/services/chat/workspaceFeatureSettingsStore.ts
  - src/services/workspaceContext/service.ts
  - src/services/routines/service.ts
  - src/services/memoryMcp/index.ts
  - src/services/knowledgeBase/ingestion.ts
  - src/services/knowledgeBase/digest.ts
  - src/routes/chat/uploadRoutes.ts
  - src/types/http.ts
  - src/services/backends/mediaCapabilities.ts
  - src/types/cortex.ts
  - src/services/backends/cortexProtocol.ts
  - src/services/backends/cortexRuntime.ts
  - src/services/backends/cortexSessions.ts
  - src/services/backends/cortexProcess.ts
  - scripts/probe-cortex-runtime.ts
  - src/services/backends/cortexTurn.ts
  - src/services/backends/cortexEvents.ts
  - src/services/backends/cortexInteractions.ts
  - src/services/backends/cortexModels.ts
  - src/services/backends/cortexErrors.ts
  - src/services/backends/cortexUsage.ts
  - src/services/backends/cortexAttachments.ts
  - src/services/backends/cortexArtifacts.ts
  - scripts/probe-cortex-events.ts
  - src/services/chat/workspaceInstructionStore.ts
  - src/contracts/cortexAuth.ts
  - src/types/cliAuth.ts
  - src/services/cortexConnections.ts
  - src/services/cortexOAuth.ts
  - src/services/cortexLogin.ts
  - src/services/cortexAuth.ts
  - src/services/cortexAuthVerification.ts
  - src/services/cliProfileAuthService.ts
  - src/routes/chat/cliProfileRoutes.ts
  - web/AgentCockpitWeb/src/cortexSetup.jsx
  - web/AgentCockpitWeb/src/screens/settingsScreen.jsx
  - web/AgentCockpitWeb/src/chat/composerPicks.jsx
  - web/AgentCockpitWeb/src/profileCatalog.js
  - web/AgentCockpitWeb/src/useProfileBackends.js
  - web/AgentCockpitWeb/src/api.js
  - scripts/probe-cortex-auth.ts
  - scripts/probe-cortex-interactions.ts
  - web/AgentCockpitWeb/src/chat/chatStatusCards.jsx
  - web/AgentCockpitWeb/src/streamStore.js
  - mobile/AgentCockpitPWA/src/interactionCard.tsx
  - mobile/AgentCockpitPWA/src/useSendPipeline.ts
  - src/services/backends/cortex.ts
  - src/services/backends/cortexPlugin.ts
  - src/services/backends/cortexShots.ts
  - scripts/probe-cortex-processors.ts
  - scripts/probe-cortex-kb.ts
  - src/services/backends/base.ts
  - src/services/knowledgeBase/ingestion/pageConversion.ts
  - src/services/knowledgeBase/handlers/pdf.ts
  - src/services/knowledgeBase/handlers/docx.ts
  - src/services/knowledgeBase/handlers/pptx.ts
  - src/services/knowledgeBase/handlers/passthrough.ts
  - src/services/knowledgeBase/dream.ts
  - web/AgentCockpitWeb/src/screens/processorProfiles.ts
  - web/AgentCockpitWeb/src/screens/memoryProcessorSelect.jsx
  - src/contracts/streams.ts
  - src/routes/chat/streamRoutes.ts
  - scripts/probe-cortex-chat.ts
  - docs/spec-cortex-code.md
---

## Context

Cortex Code exposes native ACP chat, persisted sessions, tool events, questions,
revised plans and images. Authenticated tests on 1.2.35 verified these behaviors
and remote-browser Snowflake OAuth. It differs from existing ACP harnesses:
session configuration uses `configOptions`; session `mcpServers` is ignored;
terminal errors can arrive as ordinary assistant text; root-only termination
leaves tool descendants running. A restrictive allowlist does not establish a
zero-tool execution boundary.

## Decision

Propose `cortex-code` as the harness/backend identity and `cortex` as its shared
executable. Use a dedicated adapter facade with focused native protocol,
runtime/process, event, interaction, model, usage and plugin modules. Preserve
existing ChatService, stream, artifact, storage and service ownership boundaries;
do not make other harnesses depend on a new generic ACP framework.

Persist named connection selection as `CliProfile.cortexCode.connection`.
An omitted `cortexCode` object represents a retained setup draft; exclude it
from automatic defaults and refuse runtime resolution until a valid named
connection is supplied. Validate supplied configuration at request and
persistence boundaries with the same browser-safe parser; reject unknown
credential fields rather than preserving them in settings/draft responses.
Server-configured and Welcome setup profiles reuse terminal Snowflake config
and auth. Explicit `SNOWFLAKE_HOME`/configDir account isolation remains gated
until real two-account/cache tests pass. Keep executable/update location separate
from auth scope. Never store account credentials in the profile connection field.

Delegate OAuth/PKCE and the local callback to a live native manual-login job.
Display its authorization URL and accept its complete loopback redirect from a
browser on another machine. Bind redirect port/state/issuer to that exact job;
discard transient codes/URLs at completion. Verify actual inference in a fresh
process, not ACP initialization, the no-op authenticate handler, or session
creation. Preserve the native effective timeout and shared terminal login.

Inject existing Memory and KB stdio shims through a private explicit native
plugin, with separate secret values in child env and placeholders in manifests.
Refresh by safe-boundary respawn and saved-session load; never edit user-global
plugins/config or replay tool work. Initial managed startup uses `acp serve`
first, explicit plugin/skill/MCP discovery switches and native-memory suppression.
The switches intentionally omit ambient plugins/global skills/user MCP from
managed sessions, while retaining the selected Snowflake connection and native
coding tools. Project/bundled skills still exist; these flags are not a sandbox.
Revalidate clean stdout, update dispatch and discovery policy for each supported
CLI version instead of prepending unsupported global flags.

For P1, use optional `BackendCapabilities.oneShot` fields `restrictedText`,
`toolEnabled` and `sequential`, and optional `planRevision` for interaction UI.
Preserve legacy behavior for existing adapters without these fields; require
CoCo's explicit eligibility at client and service boundaries. Default one-shot
`allowTools:false` must fail before native execution until a complete zero-tool
path is proven. Titles/summaries use deterministic fallback meanwhile. Chat
Memory tools can still use a separately configured supported governance processor.
Tool-enabled processors and media are independently certified before selection.

P6 places ephemeral one-shot/sequential ownership in `cortexShots.ts`, sharing
the native session/runtime and turn modules without durable chat state. One
deadline covers startup and all prompts. Each call gets its own session, sends
new prompts once, and drains on cancellation/shutdown; it never replays tool
work. Headless questions/plans fail rather than invent human decisions. Explicit
server image paths reuse the same version/model/byte validation as chat uploads.
Keep Memory unavailable while G1 remains open and preserve unsupported saved
selections visibly instead of silently replacing their harness.

Preserve explicit processor profile IDs across normalization, restore and import,
including missing/disabled/incomplete selections. Reject the alternative of
dropping an invalid ID and allowing a backend mirror/default to select another
account or harness. Keep defaults only for unset or backend-only legacy choices.
Use the shared browser-safe capability policy at UI and registered-service
boundaries, with cheap static role preflights before discovery or invocation;
keep adapter-native guards as a second boundary. Failed profile resolution must
leave operational state useful and must precede destructive synthesis rebuild.
Do not rewrite import bundles or erase credentials/configuration to implement
eligibility. Preserve unavailable UI selections as disabled rows requiring an
explicit user choice, with shared projection outside large screen entrypoints.

Keep profile-specific browser catalogs owned by request generation and persisted
profile identity, with shared projection outside Settings and composer entrypoints.
Invalidate on profile/auth saves; a late response must not reinstate a previous
connection's model list. Configuration, catalog discovery and authenticated
inference are separate evidence. Keep shared remote OAuth in its dedicated panel
instead of the generic account log box, and keep isolated/custom terminal auth
explicit. Lazy-load the focused composer selectors to preserve initial-load size.

Service wrappers must also honor native execution ownership. Add server-only
adapter policies for automatic one-shot retry and required processor image
format, retaining legacy defaults. CoCo opts out of retrying thrown, empty or
invalid results because the native process may already have performed tool work;
classifying an error as transport/auth does not prove that a retry is safe.
Preserve pending synthesis work on invalid output. Prepare PNG siblings in the
existing ingestion helper so common Office/JPEG inputs use verified native PNG
transport while originals and conversion records remain intact. Avoid harness
checks or CoCo protocol imports in KB services and avoid changing shared user
Office installations/profiles or Snowflake auth to make tests pass.

Pending question/plan replies use `sendInput` and exact reverse RPC ownership,
including ID 0. Carry a fresh opaque decision generation through REST/WS and
both clients so a delayed reply cannot resolve a newer question; keep the field
optional for existing harnesses. Native RPC/tool IDs are not that generation.
`stdinInput:false` denotes unsupported unsolicited steering;
clients preserve normal text through the message queue instead of dropping it.
Expose plan revision through capability metadata, not harness-name checks.

Both clients use the shared plan-revision role check on conversation metadata;
rendered callbacks carry their decision generation and reply ownership survives
delayed HTTP acknowledgements/errors without clearing a newer decision or
resending an old answer. Reset drafts for new decisions and exclude duplicate
submissions synchronously. In tool-enabled chat, automatically accept only the
verified 1.2.35 planning-entry approve/decline schema to enter planning; it grants
no finished-plan execution. Keep proceed/keep_planning approval independent and
explicit. Headless/restricted entry remains denied. A native rejection may end
with explanatory text or request a new decision; never synthesize a new card or
resend the prompt to force a preferred outcome.

Advertise native history recovery only after adapter reload tests pass; leave
active-turn reattachment, goals and subagents unavailable until verified. Never
retry an interrupted tool request automatically. Track owned descendants with
PID/start identity, including after root exit. The Phase 0 probe evaluates the
existing Grok ownership pattern without introducing a production CoCo-to-Grok
dependency. Finalization must also resolve default native delegation/background
work before release, even when Agent cards are not advertised.

P2 implements those boundaries in dedicated CoCo modules, with conversation
leases and generation invalidation, strict transport failure cleanup and
profile-scoped uncached discovery. Keep runtime foundations internal until the
adapter implements its advertised event/interaction surface. A timeout kills
the runtime rather than leaving possibly side-effectful requests executing.
Shutdown remains reusable after registry-driven CLI updates. POSIX ownership
sampling is best-effort userspace cleanup, not a sandbox or atomic containment;
retain that limitation even after the native smoke passes.

P3 keeps mapping in an internal turn bridge until durable adapter integration.
Generate a distinct decision ID for each UI gate, preserve native IDs for RPC
responses, and require expected-decision identity on replies. Withhold possible
native terminal error text until result classification to avoid persisting raw
connection/service diagnostics. Use current per-runtime configOptions and native
auto reset rather than a copied account catalog or sticky effort override.
Require complete final token counters; context snapshots are not billing.
Scope explicit PNG inputs to trusted conversation uploads and verified native
model/version evidence. Follow Cockpit's explicit FILE_DELIVERY/resource-link
policy for downloads; a normal code diff is not a downloadable artifact.

Preserve native token/cache categories and context snapshots separately. Use
`costSource:'none'` until Snowflake billing evidence exists; never infer direct
Anthropic/OpenAI prices from a CoCo model ID. Classify version-tested native
terminal error signatures without treating every failed tool or quoted `Error:`
string as a failed turn. Unknown failures remain visible.

Keep CoCo authentication behind the existing CLI auth facade, delegated to
focused native connection, OAuth ownership, PTY and verification modules. Use
`smol-toml` for syntax/quoting and preserve the original file verbatim when
appending new connections. A hand-written TOML parser or whole-file
parse/stringify would add syntax risk or destroy comments. Keep URL/state/code
in an active in-memory handoff only; a generation-bound POST transfers the full
validated redirect to native stdin once. Do not forward arbitrary browser URLs
or create an independent OAuth client/exchange in Cockpit. Reserve the shared
Snowflake home across profiles until process cleanup completes. Verify with an
exact nonce response and complete final usage from a fresh native process;
listing models or receiving a callback is insufficient. Keep automatic CoCo
default promotion disabled until its runtime adapter is registered. Lazy-load
the setup component on Welcome/Settings; retain the 260 KiB entrypoint budget
and give the new chunk its own 8 KiB limit. Raise the aggregate JS allowance
from 900 to 910 KiB for the added setup/API functionality.

## Alternatives Considered

- **Reuse Kiro/Grok unchanged:** incompatible configuration, MCP, interaction
  and error behavior would leak into existing providers.
- **Terminal transcript automation for chat:** ACP already supplies structured
  events and native session ownership; terminal transport remains an auth detail.
- **Global MCP/plugin changes:** leaks scoped tokens and changes terminal/user
  behavior. Per-runtime plugins preserve native MCP without an aggregator.
- **Allowlist or denied approvals as zero-tool proof:** declarations and other
  invocation paths remain; strict processors require stronger native evidence.
- **Direct model API, synthesized goals or automatic tool retry:** changes the
  requested harness semantics and can repeat side effects.

## Consequences

- Core chat can ship with shared terminal auth and honest feature limits while
  existing processors remain selectable independently.
- The adapter, auth handoff and temporary plugins require native version tests;
  recorded protocol excerpts do not replace real Cockpit workflow acceptance.
- Initial evidence is macOS arm64 only. Native Windows/Linux, account isolation,
  additional media, goals/subagents and billing require separate certification.
- Userspace descendant polling has observation races; it is not OS containment.
- This ADR remains Proposed while implementation contracts and managed-runtime
  choices are reviewed. Add production modules to `affects` when they exist.

## References

- [Implementation tracker](../design/cortex-code-implementation-plan.md)
- [Authenticated native evaluation](../research/cortex-code-acp-evaluation.md)
- [Phase 0 native probe](../../scripts/probe-cortex-phase0.ts)
- [Versioned wire excerpts](../../test/fixtures/cortex/1.2.35/README.md)
- [Adapter system](../spec-backend-services.md#42-backend-adapter-system)
- [Implemented profile/capability foundations](../spec-cortex-code.md)
- [Shared ownership/contracts](0051-adopt-shared-contracts-and-logging-foundations.md)
- [Harness identity](0079-use-harness-for-cli-profile-runtime-identity.md)
- [Comparable Grok lifecycle constraints](0092-integrate-grok-build-through-acp-and-native-extensions.md)
