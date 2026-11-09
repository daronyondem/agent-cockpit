# Backend Capabilities

Agent Cockpit supports Claude Code, OpenAI Codex, Kiro, OpenCode, Grok Build, and Cortex Code. The exact
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

## Cortex Code (CoCo)

- dedicated ACP sessions, thinking/tools, questions and revised plan approval;
- named Snowflake connection with shared terminal auth and manual remote OAuth;
- saved-session load, queues, safe Stop/reset/reconnect and explicit file delivery;
- private native plugins for Cockpit Memory/KB MCP, with no global plugin edits;
- tool-enabled sequential processors, KB ingestion/digestion/dreaming, Workspace
  Context, Routines and PNG OCR;
- PNG image input only on the tested claude-sonnet-4-6 / CoCo 1.2.35 combination;
- input/output/cache tokens and separate context snapshots; USD cost unavailable;
- strict Memory processors, native goals, subagent cards, unsolicited steering,
  additional native media, billing and account isolation remain gated/deferred.

Compatibility evidence is macOS arm64/1.2.35; native Ubuntu/Windows and physical
mobile platforms remain separate. See [setup](../user/cortex-code.md),
[capability decisions](../research/cortex-code-capability-decisions.md) and
[the implemented contract](../spec-cortex-code.md).
