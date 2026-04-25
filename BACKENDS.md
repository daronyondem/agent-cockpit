# Backend Comparison

Agent Cockpit supports multiple CLI backends. Not all backends expose the same metadata, so some features behave differently depending on which backend you use.

| Feature | Claude Code | Kiro | Codex | Notes |
|---------|------------|------|-------|-------|
| Token usage tracking | Yes | No | Yes | Claude Code reports input/output/cache tokens. Codex reports per-turn token usage via `thread/tokenUsage/updated`. Kiro reports credits + context % instead. |
| Cost (USD) | Yes | No | No | Claude Code provides per-message USD cost. Codex uses ChatGPT subscription credits or API-key billing — neither is exposed as USD per turn. Kiro uses a proprietary credits system. |
| Integration protocol | Direct CLI spawn | ACP (JSON-RPC 2.0) | Codex App Server (JSON-RPC 2.0) | Claude Code spawns the CLI per message. Kiro and Codex both run a persistent JSON-RPC server (`kiro-cli acp` / `codex app-server`) with bidirectional streaming. |
| Plan mode | Yes | No | No | Claude Code's special plan-only mode is unique to it. |
| Subagents | Yes | Yes | Yes | Claude Code, Kiro, and Codex all fully demultiplex parent + child threads. Codex emits `collabAgentToolCall` items on the parent connection (with `tool`: `spawnAgent` / `sendInput` / `resumeAgent` / `wait` / `closeAgent`). Each completed `spawnAgent` carries `receiverThreadIds[]`; subsequent `item/*` notifications carry `threadId` at the params envelope (not in the README — verified via raw JSON-RPC capture), which the cockpit uses to attribute child tool activity back to its originating Agent card via `parentAgentId`. Grand-children (children of children) flatten to the same top-level card since the cockpit UI nests one level deep. Child-thread `agentMessage`/`reasoning` deltas are dropped (no per-child message stream in the UI); the child's final summary surfaces via `agentsStates[childTid].message` on the closing wait/closeAgent call. |
| MCP injection | `--mcp-config` flag | `mcpServers` in `session/new`/`session/load` | `-c mcp_servers.<name>.{command,args,env}=…` flags | Codex configures MCP via `[mcp_servers.<name>]` TOML sections. Cockpit injects them per-spawn via repeated `-c` overrides on `codex app-server`, so the user's real `~/.codex/` is used unchanged for auth, sessions, and config. Collisions with names already defined in the user's `config.toml` log a warning and keep the user's. |
| Mid-turn user input (stdin) | Yes | No | Yes (`turn/steer`) | Claude Code writes additional lines to the CLI's stdin. Codex appends text to the in-flight turn via the JSON-RPC `turn/steer` request (no-op when no turn is active). |
| Interactive user questions | Yes (`AskUserQuestion`) | No | Yes (`item/tool/requestUserInput`) | Codex's user-question request is EXPERIMENTAL and v2-only. The cockpit surfaces only the first question (matching Claude Code's UI), and the user's answer is sent back via the request's JSON-RPC response (`{answers: {<questionId>: {answers: [text]}}}`) rather than as new turn input. |

## Codex: feature-flag and deferred-work tracker

`codex features list` exposes feature flags that gate certain capabilities. Some of those flags affect cockpit features; this table records the cockpit's stance on each so we can revisit when Codex's defaults change.

| Codex feature | State in Codex | Cockpit stance |
|---|---|---|
| `default_mode_request_user_input` | experimental, off by default | **Wired, dormant.** The cockpit's `item/tool/requestUserInput` handler is fully implemented, but won't fire until Codex flips the flag (or a user opts in via `codex features enable default_mode_request_user_input`). |
| `memories` | experimental, off by default | **Not surfaced.** When on, Codex writes summaries to `~/.codex/memories/MEMORY.md` (global path, workspace-scoped via `applies_to: cwd=...` headers in the file). Doesn't fit the cockpit's per-workspace `getMemoryDir(workspacePath)` API; reconsider when the feature stabilizes. |
| Plan mode | stable in TUI; v2 plan delta protocol marked experimental | **Deliberately skipped.** Entry is strictly user-initiated (Shift+Tab keybind or `/plan` slash command); the model never auto-enters plan mode and there is no accept/reject gate after a normal turn — so it doesn't match the cockpit's "agent-decides, user-approves" UX. |
