# Backend Capabilities

Agent Cockpit supports Claude Code, OpenAI Codex, and Kiro. The exact feature
surface differs because each vendor CLI exposes different protocols and
metadata.

The detailed comparison table lives in [BACKENDS.md](../../BACKENDS.md). This
page summarizes the user-facing shape.

## Claude Code

- direct CLI spawn per message;
- plan mode support;
- token and cost reporting when exposed by the CLI;
- subagent and tool visualization;
- mid-turn user input;
- workspace instruction compatibility checks.

## OpenAI Codex

- Codex App Server JSON-RPC transport;
- per-conversation persistent process with idle timeout;
- thread creation and resume;
- goal mode controls;
- subagent demultiplexing;
- token usage tracking;
- MCP injection through spawn-time config overrides;
- full local execution defaults through Codex approval/sandbox environment
  values.

## Kiro

- ACP JSON-RPC transport;
- lazy process spawn with idle timeout;
- session creation, loading, and resume across restarts;
- subagent tracking with grouped tool visualization;
- credits/context reporting rather than token/cost reporting.
