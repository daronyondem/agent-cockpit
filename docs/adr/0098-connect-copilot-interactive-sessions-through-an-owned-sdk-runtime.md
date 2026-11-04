---
id: 0098
title: Connect Copilot interactive sessions through an owned SDK runtime
status: Proposed
date: 2026-11-03
supersedes: []
superseded-by: null
tags: [backends, copilot, lifecycle, protocol, testing]
affects:
  - src/services/backends/copilotSdkRuntime.ts
  - src/services/backends/copilotJsonRpc.ts
  - test/copilotJsonRpc.test.ts
  - src/services/backends/copilotRuntime.ts
  - src/services/backends/copilotProfileStatus.ts
  - src/services/backends/copilotConversations.ts
  - src/services/backends/copilot.ts
  - src/services/backends/copilotUsage.ts
  - src/services/backends/copilotLiveUsage.ts
  - src/services/backends/copilotQuota.ts
  - src/contracts/copilotUsage.ts
  - src/services/chat/conversationUsageStore.ts
  - src/services/chat/usageLedgerStore.ts
  - test/copilotLiveUsage.test.ts
  - test/copilotQuota.test.ts
  - test/copilotUsageRoutes.test.ts
  - test/copilotUsageUi.test.ts
  - src/services/backends/copilotSdkEvents.ts
  - src/services/backends/copilotSessionConfig.ts
  - src/services/backends/copilotGoals.ts
  - src/services/chat/goalEventPersistence.ts
  - test/goalEventPersistence.test.ts
  - src/contracts/goals.ts
  - src/routes/chat/goalRoutes.ts
  - test/copilotGoals.test.ts
  - test/copilotGoalRoutes.test.ts
  - src/services/backends/copilotInputs.ts
  - src/services/backends/copilotAgents.ts
  - src/services/backends/copilotMedia.ts
  - src/services/backends/copilotArtifacts.ts
  - test/copilotMedia.test.ts
  - test/copilotArtifacts.test.ts
  - test/chat.copilotArtifacts.test.ts
  - mobile/AgentCockpitPWA/src/liveArtifacts.ts
  - src/services/backends/copilotModels.ts
  - src/services/backends/copilotCatalog.ts
  - src/contracts/responses.ts
  - src/contracts/streams.ts
  - src/contracts/streamFrames.ts
  - src/types/tools.ts
  - src/routes/chat.ts
  - web/AgentCockpitWeb/src/chat/toolRuns.jsx
  - web/AgentCockpitWeb/src/stream/streamFrameReducer.ts
  - web/AgentCockpitWeb/src/streamStore.js
  - mobile/AgentCockpitPWA/src/agentTools.tsx
  - mobile/AgentCockpitPWA/src/liveToolActivities.ts
  - src/services/backends/copilotTools.ts
  - src/services/backends/copilotProcess.ts
  - src/services/cliProfileAuthService.ts
  - src/services/nodeRuntimeRequirement.ts
  - src/services/updateService.ts
  - src/services/installDoctorService.ts
  - test/copilotSdkRuntime.test.ts
  - test/copilotProfileStatus.test.ts
  - test/copilotConversations.test.ts
  - test/copilotAdapterRuntime.test.ts
  - test/copilotSdkEvents.test.ts
  - test/copilotAgents.test.ts
  - test/agentTools.test.ts
  - test/copilotSessionConfig.test.ts
  - docs/research/copilot-sdk-parity-evaluation.md
  - docs/spec-backend-services.md
  - package.json
---

## Context

The existing per-turn Copilot JSONL integration cannot answer native questions
or steer a running turn. Copilot 1.0.105 supports protocol v3 and the official
TypeScript SDK 1.0.28, including session resume, input callbacks, live steering,
child events, and usage/context APIs. Native probes exercise those paths with
isolated auth and fixed local model responses.

The SDK's stdio mode spawns its own child and does not accept an existing
owned pipe transport. That bypasses the Windows Job Object boundary added in
ADR-0097. The SDK also bundles an optional native runtime; silently selecting
that runtime would separate execution from Cockpit's configured CLI and updater.

## Decision

Keep a focused compatibility shim for the pinned vscode-jsonrpc 8.2.1 reader:
its partial-message diagnostic timer can recur after a truncated connection is
disposed. The SDK does not consume those diagnostics and does not expose its
reader. Wrap the public listen method with an AsyncLocalStorage scope around
our SDK start, and set only those readers' public partialMessageTimeout to zero.
Other readers retain their defaults; Cockpit's real request/startup deadlines
remain active. This avoids private SDK fields, dependency forks, or merely
unrefing a leaked timer. Reevaluate the shim when upgrading the SDK/dependency.

Translate the existing upload tag into explicit SDK file attachments. Require
provider/model evidence for document bytes independently of vision and the
legacy CLI attachment flag. Unknown SDK PDF transport remains gated; Anthropic
Sonnet 4.6 has native fixed-provider image/PDF evidence. Custom OpenAI-compatible
PDF path references are insufficient, including when no tools are available.
Keep parsing/gates in `copilotMedia.ts` and native tool output extraction in
`copilotArtifacts.ts`. Preserve existing artifact storage and browser frames;
deduplicate explicit bytes within each owned tool and never fetch an output URI
or scrape prose for a file. Native image generation remains unsupported.

Introduce a focused SDK runtime foundation while retaining the existing chat
and restricted one-shot behavior until their individual migrations are tested.
Keep CopilotAdapter's public runtime resolver re-exports stable; implementation
lives in copilotRuntime.ts.

Use a temporary owned runtime for profile credential/catalog verification first.
Installation, authenticated credentials and enabled-model access are independent
results: a static fallback model list cannot certify account access. Keep login
in the terminal and shared auth unchanged until separate account-isolation work
proves the native behavior. Abort and await active checks during server shutdown.

Cockpit launches the selected CLI with `--headless --no-auto-update --log-level
none` through spawnCopilotProcess. The process owns an ephemeral loopback
listener. Generate a fresh COPILOT_CONNECTION_TOKEN for each launch and pass it
to the SDK through RuntimeConnection.forUri. Never let the SDK launch, download,
or choose a second runtime. Pin the SDK version and use Node >=22.12.0, matching
its supported Node 22 range.

The SDK's minimum also applies to installation and self-update. Keep download
selection on the latest supported Node 22 line, but reject existing 22.x
runtimes below 22.12.0 on macOS/Linux/Windows. Compare full release engine floors
in the updater and current app requirements in Install Doctor; preserve legacy
major-only manifests and the existing install-state format.

Bound port discovery and the SDK handshake, race startup against process exit
and cancellation, and await idempotent owned-process cleanup on every failure.
SDK disconnect is bounded separately from process-tree termination. Keep the
existing POSIX marker/identity tracking and Windows Job wrapper unchanged. Do
not retain environments or CLI stderr in this connection layer.

Keep individual feature capabilities disabled until their native semantics,
server handling, and desktop/mobile behavior are verified. Native autopilot
does not imply Codex-equivalent goal controls: the tested CLI removes clear,
and toggling autopilot on does not resume a paused objective.

Stage conversation ownership and event projection separately from switching
production chat. Use one owned process per active conversation turn, cold-resume
the persisted native ID, and close the process after session-wide idle. This
retains fresh per-turn MCP configuration and avoids idle runtime accumulation.
Wait for late startup/cleanup before replacement, including cancellation before
iterator consumption. Separate pure event projection from process/session effects.
Recover missing history only on resume failure before prompt submission or
observable work; never replay an interrupted tool loop.

Route normal chat through this owner. Keep explicit custom command overrides
on JSONL unless their provider base URL is visible in the runtime environment:
native headless sessions do not inherit BYOK configuration privately installed
by a wrapper. Choose the transport before execution, with no fallback after an
SDK failure. Keep one facade admission/cleanup boundary across both paths, so a
profile change after Stop cannot overlap native workers. Preserve Settings'
self-configured profile normalization and server-level environment configuration.

Read the native reconciled usage API before prompt submission and after idle,
instead of reconstructing a newer ledger from disk. Native 1.0.105 local-provider
records differ from the older checkpoint schema. Prefer authoritative disjoint
token details, otherwise normalize cache-inclusive model aggregates, and count
children once without adding overlapping provider/model/agent maps. Preserve
native premium-request counters separately from nano-AIU. Unknown units and
unavailable metrics are not zero charges or USD estimates.

Discover models through the effective profile's owned SDK connection and cache
only by runtime/auth identity, with bounded expiry and explicit refresh after
account checks or CLI shutdown. Preserve a clearly marked curated fallback for
discovery failures and opaque/custom-provider compatibility. Runtime efforts are
authoritative; media still requires Cockpit selection/transport evidence. Keep
saved unavailable IDs visible and reject them before execution, rather than
silently selecting a replacement. Add an explicit nullable effort clear to the
message boundary so changing to a model without effort cannot retain a stale
stored selection in either client. This closes static-catalog UI drift without
claiming successful hosted account or media certification.

Keep questions and steering in a focused input owner. Give each question a
unique request ID, resolve it once through its native callback, and never turn
a stale answer into a new message. Expose steering as an explicit action while
retaining Enter's existing Cockpit queue behavior. Probe queue control only
after initial send acknowledgement and root turn start; pausing earlier can
stall that first prompt. Release the probe pause and hold a pause only around
pending steering. Native background-completion notifications use the same lane,
so pausing the whole turn prevents delegation from finishing. Accept steering
only when its native message ID is delivered as steering. Poll pending items
and withdraw the exact unconsumed correction before releasing the pause,
including promotion before idle, then retain the user's draft/files.
Reject uncertain delivery and stop without replay. Close the SDK input channel
before rejecting question callbacks during Stop to prevent a native error
response from releasing another iteration. Reconstruct exact pending questions
from stream replay on desktop/mobile, preserving newer questions/answers during
late HTTP acknowledgements. These semantics are verified against the selected
CLI, rather than inferred from SDK send acceptance.

Keep delegated ownership in a separate pure reducer. Scope tool identity by a
fresh turn namespace, native owner agent ID and raw tool ID. Use native
parent ancestry to flatten nested work into the top-level Agent card, without
allowing unknown children to become root output. Lifecycle notifications own
card completion; background task acknowledgement does not. Persist bounded
plain-text final summaries on tool outcomes and render them in desktop/mobile
cards, preserving the parent answer and restricted one-shot output. Stop and
terminal errors settle unfinished work before persistence. Native session-wide
metrics already include children and must not add their overlapping counters.

Native goals use public command effects plus SDK send, with canonical runtime
state owning status. Copilot polling and stream completion share atomic terminal-card
persistence to prevent duplicate writes. Route capability checks are pure and profile-scoped, avoiding
expensive catalog discovery on polls. Control reads share active ownership or
reserve an idle attach to existing history; lifecycle cancellation drains both.
An explicit fresh native AI-credit window is required for resume. Preserve native
units and omit unknown token/time fields. Clear stays unavailable because removal
of an objective file does not clear runtime state. Do not use private invocation
finalizers or recreate missing history to simulate goal controls.

Extend the same owned runtime boundary to quota reads, with no native session or
inference. Cache only whitelisted measurements by the existing runtime/auth digest,
retain stale last-good data only for that identity, and drain late startups during
shutdown/profile refresh. Keep live/final reconciliation in a focused checkpoint
tracker. Persist context as replaceable snapshots that skip the daily ledger.
AI-credit availability and premium requests remain distinct; an unavailable zero
cannot become known free usage, and unknown account quota units cannot be guessed.
This extends the proposed transport decision without changing accepted ADRs.

## Alternatives Considered

- **SDK-owned stdio process:** direct and port-free, but bypasses existing
  Windows containment and offers no public callback to supply our owned pipes.
- **Hand-type the headless JSON-RPC protocol:** keeps dependencies smaller, but
  duplicates SDK framing, reverse-request dispatch, session ownership, protocol
  negotiation, and generated experimental surfaces.
- **Use ACP:** native initialization, session creation, and text work, but the
  SDK exposes the richer input, account, model, and context APIs needed for the
  planned parity work. Retain ACP findings for future reevaluation.
- **Use the SDK's bundled/in-process runtime:** bypasses the configured CLI and
  updater; in-process execution also loses per-runtime environment/process
  isolation. Explicit external connection avoids both paths.
- **Force every command wrapper onto SDK:** breaks wrappers whose provider
  environment is private. Extracting process environments would add sensitive,
  platform-dependent inspection. Preserve their existing JSONL path instead.
- **Let native steering auto-enqueue or change Enter to steer:** native
  unconsumed messages can start an unexpected second execution and compete with
  Cockpit's persisted queue. Explicit steering plus paused withdrawal preserves
  the existing queue semantics and leaves rejected input reviewable.
- **Pause the native queue for the entire turn:** prevents an accidental
  correction from executing, but also stalls native background completions.
  Transaction-scoped pause and exact withdrawal preserve both behaviors.

## Consequences

- + Public SDK types and session APIs avoid another handwritten protocol client.
- + Existing process ownership and CLI/profile selection remain authoritative.
- + Native wrong-token rejection and loopback binding are verified on macOS.
- - A local authenticated TCP connection replaces direct stdio for SDK access.
- - The SDK adds native optional packages even though Cockpit does not select
  their bundled runtime; dependency size and Node requirements increase.
- ~ Windows process fixtures are not real Windows CLI evidence. Hosted account,
  live catalog access, and all goal actions require separate verification.

## References

- [ADR-0097](0097-contain-windows-copilot-descendants-in-a-per-run-job.md).
- [Native evaluation](../research/copilot-sdk-parity-evaluation.md).
- [Backend specification](../spec-backend-services.md#copilot-sdk-runtime-foundation).
- [Official SDK](https://github.com/github/copilot-sdk).
- [ACP reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server).
