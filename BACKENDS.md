# Backend Comparison

Agent Cockpit supports multiple CLI backends. Not all backends expose the same metadata, so some features behave differently depending on which backend you use.

| Feature | Claude Code | Kiro | Codex | Notes |
|---------|------------|------|-------|-------|
| Token usage tracking | Yes | No | Yes | Claude Code reports input/output/cache tokens. Codex reports per-turn token usage via `thread/tokenUsage/updated`. Kiro reports credits + context % instead. |
| Cost (USD) | Yes | No | No | Claude Code provides per-message USD cost. Codex uses ChatGPT subscription credits or API-key billing — neither is exposed as USD per turn. Kiro uses a proprietary credits system. |
| Integration protocol | Direct CLI spawn | ACP (JSON-RPC 2.0) | Codex App Server (JSON-RPC 2.0) | Claude Code spawns the CLI per message. Kiro and Codex both run a persistent JSON-RPC server (`kiro-cli acp` / `codex app-server`) with bidirectional streaming. |
| Plan mode | Yes | No | No | Claude Code's special plan-only mode is unique to it. |
| Subagents | Yes | Yes | Opaque (`collabAgentToolCall`) | Claude Code and Kiro fully demultiplex parent + child threads in the UI. Codex emits `collabAgentToolCall` items on the parent connection (with `tool`: `spawnAgent` / `sendInput` / `resumeAgent` / `wait` / `closeAgent`); the cockpit renders each call as its own opaque Agent card. Per-child notifications (`item/started` / `item/completed`) don't carry `threadId`, so deeper demultiplexing isn't supported by the public protocol. |
| MCP injection | `--mcp-config` flag | `mcpServers` in `session/new`/`session/load` | `-c mcp_servers.<name>.{command,args,env}=…` flags | Codex configures MCP via `[mcp_servers.<name>]` TOML sections. Cockpit injects them per-spawn via repeated `-c` overrides on `codex app-server`, so the user's real `~/.codex/` is used unchanged for auth, sessions, and config. Collisions with names already defined in the user's `config.toml` log a warning and keep the user's. |
| Mid-turn user input (stdin) | Yes | No | Yes (`turn/steer`) | Claude Code writes additional lines to the CLI's stdin. Codex appends text to the in-flight turn via the JSON-RPC `turn/steer` request (no-op when no turn is active). |
| Interactive user questions | Yes (`AskUserQuestion`) | No | Yes (`item/tool/requestUserInput`) | Codex's user-question request is EXPERIMENTAL and v2-only. The cockpit surfaces only the first question (matching Claude Code's UI), and the user's answer is sent back via the request's JSON-RPC response (`{answers: {<questionId>: {answers: [text]}}}`) rather than as new turn input. |
