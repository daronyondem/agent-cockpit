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
- native SDK goal set/status/pause/resume, with an explicit fresh AI-credit limit on resume and persisted lifecycle cards; Clear is unavailable in CLI 1.0.105;
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

The earlier JSONL integration has native image/PDF/MCP/text/stream/resume/usage
evidence with CLI 1.0.103-0 and 1.0.105 on macOS arm64 through
`npm run e2e:copilot`. The updated hosted SDK stream check has not been rerun
with entitled credentials; local SDK evidence is recorded separately below.
Six production Memory/Context workflows pass through SDK chat on macOS with
fixed local replies. Eight SDK desktop/mobile Chromium cases pass on macOS
with eight observed headless launches; the earlier Ubuntu 24.04 browser evidence
covers JSONL.
KB/Routine workflow coverage uses executable fixtures. Windows Job ownership has
native process-fixture evidence, not real Windows Copilot certification.
Hosted account/model behavior remains separate from local-model integration.

SDK chat uses pinned SDK 1.0.28 and an authenticated
Cockpit-owned headless runtime. Nine opt-in native cases through
`npm run e2e:copilot-sdk` cover session resume/context, JSONL-session migration,
questions, steering, child identity, conversation ownership/cold resume, and real tool-worker Stop-to-send on macOS arm64 with CLI 1.0.105 and fixed
local replies, including Node 22.23.4. They also verify cache-disjoint accounting
after cold resume, aggregate delegated usage once, managed instructions and opaque
wrapper compatibility. These probes do not expose question/steering/child controls. Native goal clear is removed
in that CLI, and switching autopilot on does not resume a paused objective.
See the [SDK evaluation](../research/copilot-sdk-parity-evaluation.md).
Named profiles share terminal authentication and do not isolate accounts.
Anthropic `max` effort is not advertised until selection-specific verification.
Native installations have a manual updater but no background update discovery.

Copilot also displays measured context snapshots and profile-scoped account
quota on desktop/mobile. Live/final usage reconciliation preserves complete,
partial and unavailable coverage. Unknown balances/units remain unknown; stale
readings retain their original timestamps. Quota reads create no session or
inference. Hosted billing/account qualification remains separate.
