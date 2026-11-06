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
  - src/services/backends/mediaCapabilities.ts
  - src/types/cortex.ts
  - src/services/backends/cortexProtocol.ts
  - src/services/backends/cortexRuntime.ts
  - src/services/backends/cortexSessions.ts
  - src/services/backends/cortexProcess.ts
  - scripts/probe-cortex-runtime.ts
  - src/services/chat/workspaceInstructionStore.ts
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

Pending question/plan replies use `sendInput` and exact reverse RPC ownership,
including ID 0. `stdinInput:false` denotes unsupported unsolicited steering;
clients preserve normal text through the message queue instead of dropping it.
Expose plan revision through capability metadata, not harness-name checks.

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

Preserve native token/cache categories and context snapshots separately. Use
`costSource:'none'` until Snowflake billing evidence exists; never infer direct
Anthropic/OpenAI prices from a CoCo model ID. Classify version-tested native
terminal error signatures without treating every failed tool or quoted `Error:`
string as a failed turn. Unknown failures remain visible.

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
