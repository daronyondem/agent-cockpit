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
  - src/services/backends/copilotRuntime.ts
  - src/services/backends/copilotProfileStatus.ts
  - src/services/backends/copilotConversations.ts
  - src/services/backends/copilotSdkEvents.ts
  - src/services/backends/copilotSessionConfig.ts
  - src/services/backends/copilotModels.ts
  - src/services/backends/copilotTools.ts
  - src/services/backends/copilotProcess.ts
  - src/services/cliProfileAuthService.ts
  - src/services/nodeRuntimeRequirement.ts
  - src/services/updateService.ts
  - src/services/installDoctorService.ts
  - test/copilotSdkRuntime.test.ts
  - test/copilotProfileStatus.test.ts
  - test/copilotConversations.test.ts
  - test/copilotSdkEvents.test.ts
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
observable work; never replay an interrupted tool loop. Keep unknown SDK ledger
units unavailable until reconciliation with existing accounting is verified.

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
