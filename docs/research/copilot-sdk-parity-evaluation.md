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
| Session create/resume | Same native ID resumes and answers another prompt; JSONL-created session resumes through SDK with original history; facade dispatch uses SDK | Hosted account and platform qualification |
| Conversation owner | Production facade cold-resumes ID/history across owned processes; cancellation reaps a real tool worker before immediate replacement | Windows/Linux SDK qualification |
| Questions | Production UUID-correlated callbacks handle repeated questions/freeform, stale refusal, active reload and Stop in desktop/mobile | Hosted models and Windows/Linux |
| Steering | Production consumption correlation, paused boundary withdrawal and cold resume prevent late follow-up execution; desktop/mobile draft/file preservation passes | Hosted models and Windows/Linux |
| Delegation | Native task starts/completes a child with agentId and root toolCallId; root finishes separately | Parallel/nested/background display and cleanup |
| Context | metadata.contextInfo returns token categories, totalTokens and prompt limit | Native live UI, supported versions, hosted models |
| Usage | Measured local-provider totals survive cold resume; cache-inclusive input is split into fresh/cache buckets; delegated usage is included once | Hosted billing/entitlements, nano-AIU display, quota/context UI |
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

The production `CopilotConversations` owner now has executable RPC-fixture coverage
for concurrent owners, late startup after reset/shutdown, immediate replacement,
pre-start iterator closure, admission ordering, request deadlines, process/orphan
exit, and failed cleanup as an admission barrier. Missing-session recovery is
limited to a failed resume before observable work or prompt submission. Native
checks cold-resume through this owner and retain actual history, then separately
abort a TERM-resistant native tool worker and immediately resume the same native session without starting that worker again.
Normal production chat now uses SDK; explicit opaque command overrides retain
JSONL. The subsequent structured-input checkpoint exposes questions and explicit
steering in both clients. Grouped child presentation remains pending.

The published SDK's generated checkpoint schema differs from the older JSONL
accounting shape. A measured native 1.0.105 probe supplied 120 input tokens,
30 output tokens and 40 cache-read tokens per request. The saved transcript
contained `session.usage_record` and `session.shutdown` records, without a live
usage checkpoint. `usage.getMetrics` recovered 120/30/40 after the first process
and 240/60/80 after resume. Thus SDK chat queries that API before submission and
after idle instead of guessing a native transcript path. Provider/model metrics
already include children; agent metrics overlap those totals. Model input
includes cache tokens, so Cockpit reports 80 fresh input + 40 cache-read for
this fixture. A three-call delegated turn reports 240 fresh input, 90 output
and 120 cache-read, once, after subtraction of prior turns.

Native `totalPremiumRequestCost` remains the existing premium-request counter.
Neither nano-AIU nor model API pricing is mapped to that field or to USD.
Missing counters/failed metrics remain unavailable, and historical checkpoint
notifications do not charge a new prompt. Local BYOK evidence does not establish
hosted billable units, entitlement or currency conversion.

A second native check confirms that enabling config discovery alone does not
make SDK sessions inherit a headless wrapper's private provider environment.
The facade therefore selects JSONL for opaque explicit command overrides,
unless the merged runtime environment supplies a provider base URL. Selection
precedes execution; an SDK error never retries the prompt through JSONL.
Settings still strips Copilot profile-local env/config homes. Native application
and browser fixtures set the isolated server's provider environment, preserve
the headless connection token in their wrapper, and assert SDK dispatch. Native
managed `AGENTS.md` instructions are discovered with SDK config discovery.

The shared desktop/mobile Chromium runner also passes all eight lifecycle cases
on macOS with SDK chat, recording eight headless runtime launches. Earlier
Ubuntu browser evidence covers JSONL; no new Windows/Linux SDK result or hosted
account evidence is implied.

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
chat transport, with explicit JSONL compatibility for opaque command overrides
and unchanged processor one-shots. See [ADR-0098](../adr/0098-connect-copilot-interactive-sessions-through-an-owned-sdk-runtime.md).

Keep SDK and CLI versions explicit. Current upstream main documentation is not
proof that a released version implements a feature or preserves goal semantics.
Do not claim set/clear/pause/resume parity from the presence of autopilot mode.

## Reproduction artifacts

The initial probes and temporary progress tracker are under
`/tmp/agent-cockpit-copilot-parity/`. SDK and owned-runtime evidence is written
to per-run temporary folders referenced by `sdk-evidence-path.txt` and
`owned-evidence-path.txt`; ACP evidence is referenced by
`acp-evidence-path.txt`. These temporary paths are not shipped data stores.

`npm run e2e:copilot-sdk` retains fourteen reproducible native cases and emits a
temporary compatibility report with CLI/SDK/OS/Node/revision/dirty metadata,
plus per-case local requests and native events (or explicitly labeled Cockpit
frames for the conversation-owner/facade cases). The fourteen-case run passes on
Node 22.23.4/macOS arm64. The test workflow adds a pinned 1.0.105 matrix on
macOS 15, Ubuntu 24.04 and Windows; until those jobs run, their presence is not
platform certification. Machine-local evidence does not substitute for
platform/account qualification.

## Runtime catalog implementation checkpoint — 2026-11-04

The selected SDK 1.0.28 exposes `ModelInfo.id/name/policy`, native vision and
reasoning-effort flags, and `supportedReasoningEfforts` including `max`. Runtime
projection and a profile/runtime/auth-scoped bounded cache now feed metadata,
SDK session configuration, restricted JSONL one-shots, HTTP admission and both
clients. Policy-disabled/unconfigured models are excluded, and new IDs do not
inherit media or effort from names. Fallback provenance is explicit; a native
vision flag is insufficient to certify a new Cockpit image/PDF selection.

Executable RPC-peer evidence verifies distinct profile catalogs, exact efforts
for new IDs, validation before session/prompt creation, direct media gates,
cache reuse/refresh, Stop during discovery, and update shutdown. It establishes
application behavior with public SDK types and transport, not real hosted
account availability. Nine native SDK cases still pass on CLI 1.0.105 / Node
22.23.4 / macOS arm64, including the isolated unauthenticated-catalog fallback.
The native wrapper case caught an over-strict fallback check: an explicitly
configured COPILOT_MODEL absent from the curated list must remain available as
a text-only compatibility entry. Authoritative account catalogs remain strict.

A fresh read-only normal-terminal account probe reports authenticated via
GitHub CLI and a catalog HTTP 403. The production catalog returns a generic,
clearly marked fallback without native response bodies/headers. No inference
was performed. Successful hosted account catalogs and a genuine two-account
comparison remain unverified. The implementation adds no new image/PDF model
qualification or Windows/Linux native certification.

Protocol references: the [official Node SDK model API](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md)
and [BYOK model listing guidance](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/byok).
Installed 1.0.28 type declarations and selected 1.0.105 runtime results, rather
than newer upstream main behavior, define this checkpoint.

Qualification for this checkpoint: 155 normal-CI suites / 2,886 tests pass;
coverage is 88.66% lines/statements, 76.17% branches and 93.71% functions. Nine
native SDK checks and six real application workflows pass. Ten rebuilt
desktop/mobile browser cases pass; the two new catalog cases inject model lists
and reject their probe sends without inference, while the existing eight retain
real SDK/local-provider behavior. Production web JS totals 898.5 KiB under the
unchanged 900 KiB total budget. Browser screenshots show the unavailable
selection/fallback status without layout overflow.

## Structured input implementation checkpoint — 2026-11-04

SDK 1.0.28 / CLI 1.0.105 confirms two queue boundaries which are not implied
by a successful send RPC. First, initial send admission can arrive before
native execution starts; pausing queue drain immediately after admission stalls
the initial prompt. Wait for root `assistant.turn_start` as well. Second,
unconsumed immediate input is promoted into the native follow-up lane at idle.
Pause that lane, correlate the correction's native steering-delivery ID, and
withdraw unconsumed input with `queue.withdrawMessage` before ending the owned
runtime. Native tests prove the final-boundary fixture performs one model call,
rejects the late input, and cold-resumes without that correction in history or
an automatic second execution. Normal steering can still produce background
shell iterations before root idle.

Production callback tests prove repeated identical prompts have distinct IDs,
old IDs resolve no later question, and choice/freeform answers reach the native
model. Stop while a question was pending initially exposed an extra model
request: graceful detach allowed the callback's cancellation error to reach the
native tool. Force-close SDK transport before rejecting callbacks. The native
regression now proves Stop plus cold resume makes only the intended initial
and replacement calls, with no cancelled input replay.

Fourteen native SDK checks, six native application workflows and eighteen
rebuilt Chromium cases pass locally. The browser cases include active reload,
repeated requests, freeform answers, Stop with a retained draft/file, consumed
steering and refused late steering on desktop/mobile. The first browser run
revealed idle-placeholder assumptions in test selectors; target the composer
independently of its current status. Choices-only enforcement and failure races
also have deterministic controller/client coverage. Full CI-style coverage
passes 2,915 tests at 88.71% statements/lines, 76.32% branches and 93.68%
functions. The feature adds about 2.4 KiB minified desktop JS; budgets become
903 KiB total / 263 KiB entry, with other limits unchanged.

The [official steering and queueing documentation](https://github.com/github/copilot-sdk/blob/main/docs/features/steering-and-queueing.md)
and installed public SDK declarations inform the integration; the selected
native runtime establishes actual queue semantics. Successful hosted accounts,
auth isolation and real Windows/Linux qualification remain outstanding.
