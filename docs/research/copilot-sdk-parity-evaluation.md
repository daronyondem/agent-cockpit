# Copilot SDK parity evaluation

Observed 2026-11-03 on macOS arm64, Node 26.0.0 and 22.23.4, Copilot CLI 1.0.105 and official
TypeScript SDK 1.0.28. The npm SDK package identifies its runtime snapshot as
1.0.105 and requires Node ^20.19.0 or >=22.12.0. Evaluation starts from PR #571
commit 557ad8a. Probes isolate HOME/COPILOT_HOME and use fixed local
OpenAI-compatible model replies; they establish transport/runtime behavior,
not hosted model quality or Copilot account access.

## Native results

| Surface | Evidence | Remaining qualification |
| --- | --- | --- |
| Headless protocol | SDK getStatus reports CLI 1.0.105/protocol 3 | Real Windows/Linux CLI runs |
| Account status | Empty auth reports isAuthenticated:false; normal terminal GitHub CLI credentials report true | Successful hosted access, expired credentials and two-account cases |
| Catalog | models.list rejects unauthenticated access; normal authenticated credentials return an explicit HTTP 403 | Successful account-dependent model lists |
| Session create/resume | Same native ID resumes and answers another prompt; JSONL-created session resumes through SDK with original history | Production route dispatch and server restart migration |
| Conversation owner | New Cockpit SDK layer cold-resumes the native ID/history across owned processes; cancellation reaps a real tool worker before immediate replacement | Production dispatch migration and Windows/Linux runs |
| Questions | Native ask_user calls SDK onUserInputRequest; Beta reaches the next model request | Desktop/mobile request ownership and reload |
| Steering | An immediate message sent during an in-flight model request reaches the next tool-loop iteration | Boundary-to-enqueue behavior and both clients |
| Delegation | Native task starts/completes a child with agentId and root toolCallId; root finishes separately | Parallel/nested/background display and cleanup |
| Context | metadata.contextInfo returns token categories, totalTokens and prompt limit | Native live UI, supported versions, hosted models |
| Usage | usage.getMetrics returns session/model totals and unavailable credit status for BYOK | Real token/credit values, restart reconciliation |
| Goal set/status | commands.invoke(autopilot, objective) creates active native objective and returns an agent-prompt reservation | Sending/finalizing objective prompts, completion and background ownership |
| Goal pause | autopilot off changes native objective to paused | Pause during actual work and fresh resume |
| Goal resume | autopilot on changes mode but leaves objective paused | Credit-window resume semantics |
| Goal clear | goal clear returns a notice that clear was removed; native state remains paused | Native supported clear API or explicit product limitation |
| ACP | Initialization, session/new with local BYOK, session/prompt and end_turn succeed | SDK provides the richer planned control surface |

A separate read-only check of normal shared terminal credentials returned
isAuthenticated:true through GitHub CLI auth, while models.list returned HTTP
403 with a not-authorized response. An authenticated identity is therefore not
evidence of Copilot entitlement or catalog access. No hosted inference request
was made. The production profile-auth service reproduces this distinction:
installed and authenticated, catalog unavailable, status error with HTTP 403.
Successful access and two-account tests remain pending.

SDK custom-provider configuration must be supplied explicitly on create/resume
for these probes. Passing only COPILOT_PROVIDER environment values to the
headless process did not establish the session provider. In contrast, the ACP
probe accepted its process-level BYOK environment. This difference matters to
existing local-provider fixture wrappers during chat migration.

Native steering can move an in-flight shell into the background. Its later
completion can then generate another model call before session.idle. Assert
the correction's single user.message with delivery:steering, not a fixed count
of model requests. A first assistant reply or tool-loop turn end is not a
sufficient stream-completion boundary.

The staged `CopilotConversations` owner now has executable RPC-fixture coverage
for concurrent owners, late startup after reset/shutdown, immediate replacement,
pre-start iterator closure, admission ordering, request deadlines, process/orphan
exit, and failed cleanup as an admission barrier. Missing-session recovery is
limited to a failed resume before observable work or prompt submission. Native
checks cold-resume through this owner and retain actual history, then separately
abort a TERM-resistant native tool worker and immediately resume the same native session without starting that worker again.
Production chat remains JSONL; these tests do not expose SDK controls in either
browser client.

The published SDK's generated `UsageCheckpointData` contains `totalNanoAiu` and
optional `providerModelMetrics`; the existing CLI JSONL parser expects
`accountingSnapshot.tokenDetails` and `totalPremiumRequests`. Fixed local model
tests do not establish billable hosted counters or a conversion between these
units. The new owner preserves known legacy baseline subtraction, suppresses
unknown accounting and clears stale snapshots on unknown checkpoints. Inspect
and reconcile the actual supported native ledger before switching production
dispatch; do not interpret missing data as zero or price credits as model API
USD.

## Process ownership

The SDK's stdio mode owns its spawn and does not expose a public owned-stream
injection point. Its URI mode connects without spawning a runtime. A native
probe launched headless Copilot through spawnCopilotProcess and attached the
SDK to the announced port using a fresh COPILOT_CONNECTION_TOKEN.

- lsof confirmed 127.0.0.1-only listening on an ephemeral port.
- An SDK client with an incorrect token failed with AUTHENTICATION_FAILED.
- The correctly authenticated client created a session and received a model reply.
- SDK disconnect left the server process under Cockpit ownership.
- Awaited scope.stop terminated the owned server.

This path preserves the existing Windows wrapper's invocation-through-stdin
contract: the headless server carries RPC over TCP and requires no duplex
stdin changes. Real Windows and Linux SDK/CLI behavior remains a qualification
step, distinct from the existing native Windows process fixtures.

## Architecture outcome

Use the official SDK with a Cockpit-owned, authenticated headless runtime as a
foundation. Keep current JSONL chat/one-shot behavior until each migration has
its own acceptance coverage. See [ADR-0098](../adr/0098-connect-copilot-interactive-sessions-through-an-owned-sdk-runtime.md).

Keep SDK and CLI versions explicit. Current upstream main documentation is not
proof that a released version implements a feature or preserves goal semantics.
Do not claim set/clear/pause/resume parity from the presence of autopilot mode.

## Reproduction artifacts

The initial probes and temporary progress tracker are under
`/tmp/agent-cockpit-copilot-parity/`. SDK and owned-runtime evidence is written
to per-run temporary folders referenced by `sdk-evidence-path.txt` and
`owned-evidence-path.txt`; ACP evidence is referenced by
`acp-evidence-path.txt`. These temporary paths are not shipped data stores.

`npm run e2e:copilot-sdk` retains seven reproducible native cases and emits a
temporary compatibility report with CLI/SDK/OS/Node/revision/dirty metadata,
plus per-case local requests and native events (or explicitly labeled Cockpit
frames for the two conversation-owner cases). The seven-case run passes on
Node 22.23.4/macOS arm64. The test workflow adds a pinned 1.0.105 matrix on
macOS 15, Ubuntu 24.04 and Windows; until those jobs run, their presence is not
platform certification. Machine-local evidence does not substitute for
platform/account qualification.
