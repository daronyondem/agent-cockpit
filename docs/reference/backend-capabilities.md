# Backend Capabilities

Agent Cockpit supports Claude Code, OpenAI Codex, Kiro, OpenCode, Grok Build, and GitHub Copilot. The exact
feature surface differs because each CLI harness exposes different protocols and
metadata.

The detailed comparison table lives in [BACKENDS.md](../../BACKENDS.md). This
page summarizes the user-facing shape.

## Claude Code

- direct CLI spawn per message;
- plan mode support;
- Ultracode runtime mode for xhigh-capable Claude models in both standard and
  interactive profiles;
- token and cost reporting when exposed by the CLI;
- subagent and tool visualization;
- mid-turn user input;
- one-shot image tasks through the native Claude Code file/image tool path;
- workspace instruction compatibility checks.

## OpenAI Codex

- Codex App Server JSON-RPC transport;
- per-conversation persistent process with idle timeout;
- thread creation and resume;
- goal mode controls;
- subagent demultiplexing;
- token usage tracking;
- MCP injection through spawn-time config overrides;
- one-shot image tasks through Codex's native file/image tool path;
- full local execution defaults through Codex approval/sandbox environment
  values.

## Kiro

- ACP JSON-RPC transport;
- lazy process spawn with idle timeout;
- session creation, loading, and resume across restarts;
- subagent tracking with grouped tool visualization;
- explicit one-shot image attachments over ACP content blocks for image-capable
  Kiro models;
- credits/context reporting rather than token/cost reporting.

## OpenCode

- direct `opencode run --format json` CLI spawn per message;
- self-configured provider credentials and model routing owned by OpenCode;
- model discovery through `opencode models [provider] --verbose` with a plain
  command fallback for older CLIs;
- provider effort variants through `opencode run --variant <effort>` when the
  selected model advertises the requested variant;
- model media capability discovery from verbose `capabilities.input.*` flags;
  media tasks fail closed when a model does not report the required input
  modality;
- one-shot image/PDF attachments through `opencode run --file` when the model
  supports the input modality;
- visible thinking through `opencode run --thinking`, mapped from JSON
  `reasoning` parts into Cockpit thinking blocks;
- session continuity through persisted OpenCode session IDs;
- tool activity visualization for built-in OpenCode tools and MCP tools emitted
  as JSON `tool_use` parts;
- Memory and Knowledge Base MCP injection through per-process
  `OPENCODE_CONFIG_CONTENT`;
- no goal mode, plan approval, grouped subagents, native questions or mid-turn input;
- no confirmed native durable-memory directory for Agent Cockpit to import or
  watch. OpenCode memory integration uses Agent Cockpit's Memory MCP tools
  instead of backend-native memory capture.

## Grok Build

- persistent ACP with native xAI extensions and session history recovery;
- shared terminal auth or explicit isolated account profiles;
- thinking, tools, grouped foreground/background subagents, native questions,
  plan approval and mid-turn input;
- native goal set/clear/pause/resume with a soft token budget;
- per-model input/output/cache usage and reported model cost when complete;
- optional profile-specific account tier, quota, balances, and reset date;
- Memory/KB MCP injection and restricted sequential text processor calls;
- verified grok-4.7 image input/output and native PDF input;
- active-turn reattachment, native memory import, audio/video, and unverified
  model modalities remain unsupported.

Native compatibility is verified on Grok Build 1.0.52, macOS arm64. See the
[Grok implementation specification](../spec-grok-build.md) for platform limits.

## GitHub Copilot

- owned SDK/headless chat with one process per active turn and native cold resume;
  opaque custom commands and one-shots retain JSONL;
- self-configured authentication that reuses the `copilot` CLI login under
  the native terminal credential store (sign in through **Authenticate** or
  `copilot login`); guided device login supports Cancel/timeout, awaited process
  cleanup and fresh credential/catalog verification. The profile check verifies
  installation, native credential status and enabled-model catalog access
  separately. Named profiles share auth; independent accounts are unsupported;
- profile/runtime-scoped model discovery with a clearly labeled curated fallback;
- default `auto` routing plus explicit account-dependent model selections;
- reasoning effort through `copilot --reasoning-effort <low|medium|high|xhigh>`
  for explicit reasoning models, not automatic routing or Haiku;
- visible thinking mapped from `assistant.reasoning_delta` events;
- streaming assistant text mapped from `assistant.message_delta` events;
- tool activity and outcomes mapped from `tool.execution_start` and
  `tool.execution_complete` events;
- session continuity through persisted Copilot session IDs, resumed through SDK
  or `copilot --resume <sessionId>` on the compatibility path;
- explicit SDK image attachments and provider/model-specific PDF transport;
  one-shots retain `copilot --attachment <path>`. Hosted SDK PDF is gated
  separately from legacy CLI evidence. Verified custom selections are OpenAI
  `gpt-6.1-sol` images and Anthropic `claude-sonnet-4.6` images/PDFs; unverified
  selections fail closed;
- native tool image/embedded-file bytes persist as artifact cards on desktop
  and mobile, including after Stop/reload; normal file delivery remains available.
  This does not enable native image generation;
- Memory and Knowledge Base MCP injection through SDK session config or JSONL
  `copilot --additional-mcp-config <json>`;
- per-turn input/output/cache tokens and premium-request credits, derived by
  subtracting native metrics before/after a turn (saved checkpoints for JSONL)
  and separating cache-inclusive input; explicit native AI credits and premium requests remain distinct, with no USD estimate;
- restricted text-only one-shots explicitly expose zero tools using
  `--available-tools none`;
- grouped SDK child tools and final summaries, including nested/background work,
  isolated from the root answer; opaque JSONL profiles retain root-only activity;
- exact native question callbacks and explicit active-turn steering on SDK
  profiles; plan mode remains unavailable;
- native SDK goal set/status/pause/resume, with an explicit fresh AI-credit limit on resume and persisted lifecycle cards; Clear is unavailable in CLI 1.0.105;
- no confirmed native durable-memory directory for Agent Cockpit to import or
  watch. Copilot memory integration uses Agent Cockpit's Memory MCP tools.

### Copilot known capability gaps

The supported scope below applies to CLI **1.0.105** and SDK **1.0.28**. These
limitations define the current integration; complete Codex parity is not claimed.

| Area | Current boundary | Available behavior |
| --- | --- | --- |
| Independent accounts | Copilot profiles share the native terminal credential store. A different name or config folder does not establish isolated accounts. | Guided shared device login, Cancel/timeout, fresh credential/catalog checks and cache invalidation. |
| Plan approval | No native plan-mode/approval integration. | Normal chat, questions and explicit steering remain available through SDK profiles. |
| Goal Clear | Removed in the tested CLI; pausing or deleting private objective files is not an equivalent Clear action. | Native set/status/pause/resume, with a fresh positive AI-credit limit on resume. |
| Media input | Hosted SDK PDFs, custom OpenAI PDFs, Azure/unknown providers and unverified model/media combinations are not enabled. Auto routing does not inherit media support. | Exact verified custom OpenAI `gpt-6.1-sol` images and Anthropic `claude-sonnet-4.6` images/PDFs; independently verified CLI one-shots. |
| Native image generation | Not exposed as a Copilot generation capability. | Successful native image/file bytes and ordinary requested file delivery produce persistent artifact cards. |
| USD pricing | No authoritative conversion from Copilot premium requests/AI credits to per-turn USD; no guessed estimate. | Disjoint tokens, context snapshots, distinct premium requests/AI credits, and available/partial/unavailable quota with freshness. |
| Active-turn reattachment | A lost stream after server restart is not reattached or automatically replayed. | Later prompts cold-resume persisted native history; interrupted work is not retried automatically. |
| Native memory import | No confirmed native durable-memory directory to import/watch. | Cockpit Memory MCP, Workspace Context, KB MCP and explicitly enabled Routines. |
| Opaque command overrides | JSONL compatibility does not expose SDK questions, steering, grouped delegated cards or goals. | Root text/thinking/tools, later-session resume, one-shots and MCP continue through JSONL. |
| Sequential processors | No native persistent `runSessionShot()` implementation. | Base transcript replay supports KB gleaning through JSONL one-shots; native application coverage verifies carryover. |
| Non-npm updates | Native installs have no background latest-version discovery. | Settings offers **Run updater**; npm installs retain managed discovery. |
| Mobile administration | The PWA has no CLI-profile auth/account-management screen or Memory panels/live Memory bubbles. | PWA chat/questions/steering, grouped tools, goals, usage/quota and artifacts; use full web Settings for CLI authentication and full web Memory administration. |

Model effort and media options follow the effective runtime catalog and verified
selection. Unverified effort options, including unverified Anthropic `max`, are
not advertised merely because a model name suggests support.

### Copilot qualification scope

Local macOS arm64 evidence uses the real CLI and fixed local model replies with
isolated temporary auth/data. It proves protocol, native tools, persistence and
cleanup; it does not prove hosted entitlement, model judgment or embedding
search quality. Retained qualification covers:

- 35 native SDK cases on Node 22.23.4: session/ownership/resume, questions,
  steering, foreground/background/nested delegation, goals, usage/context,
  provider-specific media, artifacts and cleanup;
- 12 application cases on Node 26.0.0: six Memory/Context and six KB/Routine
  workflows, including native source reads/output writes, actual SDK KB MCP
  recall and cancellation draining workers plus detached children before retry;
- two native auth cases: logged-out status and device-code cancellation/retry,
  without completing browser authorization;
- 42 desktop/PWA/narrow-settings Chromium cases, including four injected
  catalog/quota and two injected auth-state cases; those six cases do not prove
  hosted account access.

The [owner's hosted report from 2026-11-05](https://github.com/daronyondem/agent-cockpit/pull/571#issuecomment-6658673116)
adds scoped evidence at clean head `9cb25d6`: one existing shared terminal login,
20 enabled models, actual hosted replies and access after restart. On macOS
26.7.1 arm64 / Node 25.9.0 / CLI 1.0.105 / SDK 1.0.28, the report passes web
and narrow-browser PWA chat, native questions, tools/files/reload, Stop followed
by a new send, model/effort persistence, Memory-to-Context recall, KB keyword
retrieval, a manual Routine, and explicit `gpt-6.1-sol` image input. Web steering
passed a retest; delegated summaries and native goal completion also passed.
These are owner-reported manual observations, separate from fixed-model CI.
The earlier HTTP 403 belongs to a different shared-account probe and does not
describe this successful hosted run.

**Open correctness finding:** steering during a running command in an existing
hosted conversation ended with `No response was returned` in the narrow PWA.
The input HTTP status and native delivery trace were not captured; the origin is
unclassified, and the successful web retest does not establish a PWA-only bug.
Local steering coverage must not be presented as resolution of this finding.

Full browser/device OAuth authorization completion, hosted goal Pause → reload
→ fresh-limit Resume, physical-device PWA behavior, live PWA delegation, expired
or denied real credentials, and genuine independent accounts remain unconfirmed
or not run. Reported usage deltas/unknown quota units/no USD are observation
consistency, not a hosted billing audit; KB keyword retrieval does not qualify
embedding quality, and manual Routines do not qualify scheduled notifications.
Account plan/organization policy and Chrome version were not supplied. Hosted
SDK PDF remains gated independently of older CLI PDF evidence.

The [published-head CI run](https://github.com/daronyondem/agent-cockpit/actions/runs/41954476405)
for PR head `9fb54f7` additionally passes **34 real-CLI SDK cases on Ubuntu 24.04
x64**, **34 on macOS 15 arm64**, and **40 Ubuntu desktop/PWA browser cases**.
The retained reports identify clean GitHub PR merge revision `88fd464`, CLI
1.0.105 / SDK 1.0.28 / Node 22.23.4. Ubuntu browser evidence records 68 SDK
runtime launches; this supersedes the earlier Ubuntu JSONL-only browser scope.
Windows Job Object/stdio process fixtures also pass. The initial Windows SDK
job failed at startup because the fixture removed OS initialization environment
variables along with authentication settings. Preserving those variables while
isolating credentials restores startup. After cleanup was also changed to await
wrapper closure, [run 41959562270](https://github.com/daronyondem/agent-cockpit/actions/runs/41959562270/job/127022547483)
passes **33 Windows x64 SDK cases**, with the POSIX command-wrapper case skipped.
Report `copilot-sdk-compat-UBnntO` identifies CLI 1.0.105 / protocol 3 / SDK
1.0.28 / Node 22.23.4 at clean PR merge `a722ecc7` (source head `f5dbe5e`).

Passing SDK/browser cases use fixed local model responses, not hosted accounts.
They do not certify platform keychain/auth, successful OAuth/entitlement or the
full Memory/Context/KB/Routine application suite on Windows/Linux. Configured or
running jobs alone are not certification. See the testing spec for report names
and precise job links; Windows Node fixtures remain separate from native CLI
results.

The initial published run passed all 3,052 normal tests but missed the Ubuntu
coverage floor at 88.81% statements/lines against 88.85%. Additional regression
cases cover goal/profile admission and repair, native-history recovery,
quota/catalog errors, and Windows cleanup completion. Coverage floors remain
unchanged. Current quality-gate status is tracked by the
[PR checks](https://github.com/daronyondem/agent-cockpit/pull/571/checks), separately
from the capability limits above.

The versioned [SDK evaluation](../research/copilot-sdk-parity-evaluation.md) and
[testing specification](../spec-testing.md#copilot-native-kb-and-routine-qualification)
retain the actual report versions, revisions/dirty flags and evidence limits.
