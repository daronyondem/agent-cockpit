# Backend Capabilities

Agent Cockpit supports Claude Code, OpenAI Codex, Kiro, and OpenCode. The exact
feature surface differs because each CLI harness exposes different protocols and
metadata.

The detailed comparison table lives in [BACKENDS.md](../../BACKENDS.md). This
page summarizes the user-facing shape.

## Claude Code

- direct CLI spawn per message;
- plan mode support;
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
