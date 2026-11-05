# Backend Comparison

Agent Cockpit supports multiple CLI backends. Not all backends expose the same metadata, so some features behave differently depending on which backend you use.

| Feature | Claude Code | Kiro | Codex | OpenCode | Grok Build | GitHub Copilot | Notes |
|---------|------------|------|-------|----------|------------|----------------|-------|
| Token usage tracking | Yes | No | Yes | Yes | Yes | Yes, with live native totals/context | Claude Code reports input/output/cache tokens. Codex reports per-turn token usage via `thread/tokenUsage/updated`. OpenCode reports JSON `step_finish.tokens`. Kiro reports credits + context % instead. Grok Build reports per-prompt `_meta.usage`, split into disjoint input/cache buckets and per-model rows. GitHub Copilot subtracts native before/after metrics (saved checkpoints on its JSONL compatibility path), splits cache-inclusive input into disjoint buckets, and reports premium requests separately from USD and nano-AIU. |
| Cost (USD) | Yes | No | No | Reported when OpenCode reports it | Reported model cost when complete | No | Claude Code provides per-message USD cost. Codex uses ChatGPT subscription credits or API-key billing — neither is exposed as USD per turn. OpenCode provider cost is passed through when present in JSON events. Kiro uses a proprietary credits system. Grok Build shows reported model cost only when the CLI reports it as complete; optional account balances are shown separately. GitHub Copilot does not expose per-turn USD cost. |
| Integration protocol | Direct CLI spawn | ACP (JSON-RPC 2.0) | Codex App Server (JSON-RPC 2.0) | `opencode run --format json` | ACP + native xAI extensions | Owned SDK/headless; JSONL compatibility | Claude Code and OpenCode spawn a CLI process per message. Kiro, Codex, and Grok Build run persistent JSON-RPC servers (`kiro-cli acp` / `codex app-server` / `grok agent stdio`) with bidirectional streaming. GitHub Copilot owns one headless runtime per active turn, cold-resumes native history, and retains JSONL for opaque custom commands and one-shots. |
| Visible thinking | Yes | Yes | Yes | Yes | Yes | Yes | Claude Code, Kiro, Codex, OpenCode, and Grok Build can all emit dedicated thinking frames. OpenCode streams `reasoning` JSON parts when Cockpit passes `--thinking`. GitHub Copilot maps assistant.reasoning_delta events. |
| Plan mode | Yes | No | No | No | Yes | No | Claude Code and Grok Build expose plan approval flows. Grok Build plans also accept revision feedback. |
| Provider runtime mode | Ultracode on xhigh-capable Claude models | No | Fast speed tier | No | No | No | Ultracode is a Claude Code session setting, not a shared effort level or synthetic model. The composer shows a Claude-only Mode picker for xhigh-capable models and sends `--settings {"ultracode":true}` to standard or interactive Claude Code. |
| Goal mode | Set/clear/status; no pause/resume | No | Set/clear/pause/resume/status | No | Set/clear/pause/resume/status; soft budget | SDK set/status/pause/resume; no Clear | Codex uses native thread-goal RPCs through `codex app-server --enable goals`. Claude Code uses its `/goal` slash command and transcript `goal_status` attachments, so Agent Cockpit hides pause/resume for Claude Code instead of emulating them. Grok Build sends native `/goal` commands over ACP; its token budgets are soft checkpoints that execution can exceed. Copilot invokes native autopilot effects and reads canonical objective state; resume requires an explicit fresh AI-credit limit, independently of token budgets. CLI 1.0.105 removes Clear. |
| Tool activity visualization | Yes | Yes | Yes | Yes | Yes | Yes | Claude Code, Kiro, Codex, and Grok Build expose tool activity through their native stream protocols. OpenCode maps JSON `tool_use` parts, including built-in tools and MCP tools, into Cockpit tool activity and outcome events. GitHub Copilot maps tool.execution_start and tool.execution_complete events. |
| Model input capability metadata | Text + image | Per model; `auto`/Claude image-capable, open-weight entries text-only unless confirmed | Text + image | Parsed from `opencode models --verbose` | Text; verified image/PDF on grok-4.7 | Text; exact provider/model image/PDF gates | Media tasks fail closed when the selected/default model does not report the required input modality. OpenCode currently surfaces DeepSeek V4 Pro as `capabilities.input.image:false`, so that model is not available for KB image conversion or attachment OCR through OpenCode. Copilot auto and unverified explicit models are excluded from media processors; the static catalog is not live account discovery. |
| One-shot image transport | Native file/image tool | Explicit ACP image content blocks | Native file/image tool | `opencode run --file` for image/PDF-capable models | Explicit ACP images; native PDF file tool | `copilot --attachment` | KB image ingestion and chat attachment OCR require both this backend transport and model `input.image:true`. Memory, Workspace Context, KB digestion, and KB dreaming are text/tool workflows and are not image-gated. |
| Subagents | Yes | Yes | Yes | No | Yes, including background continuation | Yes, SDK grouped cards/summaries | Copilot SDK chat scopes child tools and nested ancestry, renders final summaries on agent cards, waits for background completion, and cancels owned workers; opaque JSONL retains root-only presentation. Claude Code, Kiro, Codex, and Grok Build also demultiplex parent + child threads. Codex emits `collabAgentToolCall` items on the parent connection (with `tool`: `spawnAgent` / `sendInput` / `resumeAgent` / `wait` / `closeAgent`). Each completed `spawnAgent` carries `receiverThreadIds[]`; subsequent `item/*` notifications carry `threadId` at the params envelope (not in the README — verified via raw JSON-RPC capture), which the cockpit uses to attribute child tool activity back to its originating Agent card via `parentAgentId`. Grand-children (children of children) flatten to the same top-level card since the cockpit UI nests one level deep. Child-thread `agentMessage`/`reasoning` deltas are dropped (no per-child message stream in the UI); the child's final summary surfaces via `agentsStates[childTid].message` on the closing wait/closeAgent call. |
| MCP injection | `--mcp-config` flag | `mcpServers` in `session/new`/`session/load` | `-c mcp_servers.<name>.{command,args,env}=…` flags | `OPENCODE_CONFIG_CONTENT` | session/new and session/resume/load | SDK session config; `--additional-mcp-config` for JSONL | Codex configures MCP via `[mcp_servers.<name>]` TOML sections. Cockpit injects them per-spawn via repeated `-c` overrides on `codex app-server`, so the user's real `~/.codex/` is used unchanged for auth, sessions, and config. OpenCode receives per-process local MCP entries in inline JSON config, so Memory/KB tokens are not written to OpenCode's global config. GitHub Copilot receives local MCP entries in SDK session config or JSONL --additional-mcp-config without writing credentials into global config. |
| Native memory import/watch | Yes | No | No | No confirmed native memory system | No; native memory disabled | No confirmed native memory system | Claude Code exposes workspace memory files that Agent Cockpit can import and watch through `extractMemory()` / `getMemoryDir()`. Kiro and OpenCode do not currently expose a documented native durable-memory directory for Cockpit to import or watch. Codex has an experimental global `memories` feature, tracked below, but it does not fit Cockpit's per-workspace native-memory API. For OpenCode, use Agent Cockpit Memory through the Memory MCP tools. Grok Build's native memory is turned off (`GROK_MEMORY=0`) in Cockpit sessions; use Agent Cockpit Memory instead. GitHub Copilot uses Agent Cockpit Memory MCP tools rather than native memory import. |
| Mid-turn user input (stdin) | Yes | No | Yes (`turn/steer`) | No | Yes, native interject | Yes, explicit SDK steering | Claude Code writes additional lines to the CLI's stdin. Codex appends text to the in-flight turn via the JSON-RPC `turn/steer` request (no-op when no turn is active). Grok Build sends input through the native `_x.ai/interject` extension when no question or plan is pending. Copilot accepts only native steering consumption; unconsumed input is withdrawn under a transaction pause before safely releasing native background notifications. Enter retains Cockpit queue behavior. |
| Interactive user questions | Yes (`AskUserQuestion`) | No | Yes (`item/tool/requestUserInput`) | No | Yes, native reverse RPC | Yes, SDK callback | Codex's user-question request is EXPERIMENTAL and v2-only. The cockpit surfaces only the first question (matching Claude Code's UI), and the user's answer is sent back via the request's JSON-RPC response (`{answers: {<questionId>: {answers: [text]}}}`) rather than as new turn input. Grok Build presents multiple native questions one at a time and returns all answers in one reverse-RPC response. Copilot SDK chat resolves exact UUID question callbacks once, supports choices/freeform and active-stream replay, and rejects stale input rather than sending a new message. JSONL retains --no-ask-user. |

Copilot profile checks use the official SDK through a Cockpit-owned headless
process to distinguish installation, authenticated credentials and enabled-model
catalog access. A denied catalog remains an error even when credentials are
recognized. Profile-scoped discovery also populates the chat picker, with an explicit
fallback on failure. Checks do not perform inference. **Authenticate** runs the
native device-code login with cancellation, awaited cleanup and fresh
credential/catalog verification; named profiles still share terminal auth.
Normal chat uses the owned SDK
conversation layer; opaque custom command overrides and restricted one-shots
retain JSONL. SDK questions, explicit steering and grouped delegated work are
integrated in desktop/mobile. Native goals support set/status/pause/resume with explicit fresh AI-credit limits on resume; Clear and plan mode remain unavailable. Resume, per-turn disjoint accounting and delegated usage
are verified with fixed local replies; hosted billing remains separate. See the
[versioned evaluation](docs/research/copilot-sdk-parity-evaluation.md).

Copilot's supported scope includes SDK questions/steering, grouped delegated
work, native goal set/status/pause/resume, context/quota visibility, verified
media/artifacts and production Memory/Context/KB/Routine integration. It does
not imply full Codex parity. Independent accounts, plan approval, goal Clear,
native image generation, hosted SDK PDFs, USD pricing, native-memory import and
active-turn reattachment remain unavailable or gated. Opaque JSONL commands
retain a smaller control surface. Mobile CLI-auth/Memory administration and
non-npm background update discovery are also limited. See the
[known capability gaps and qualification scope](docs/reference/backend-capabilities.md#copilot-known-capability-gaps)
for the exact boundaries; hosted account and platform evidence is separate from
local fixed-model integration.

## Codex: feature-flag and deferred-work tracker

`codex features list` exposes feature flags that gate certain capabilities. Some of those flags affect cockpit features; this table records the cockpit's stance on each so we can revisit when Codex's defaults change.

| Codex feature | State in Codex | Cockpit stance |
|---|---|---|
| `default_mode_request_user_input` | experimental, off by default | **Wired, dormant.** The cockpit's `item/tool/requestUserInput` handler is fully implemented, but won't fire until Codex flips the flag (or a user opts in via `codex features enable default_mode_request_user_input`). |
| `memories` | experimental, off by default | **Not surfaced.** When on, Codex writes summaries to `~/.codex/memories/MEMORY.md` (global path, workspace-scoped via `applies_to: cwd=...` headers in the file). Doesn't fit the cockpit's per-workspace `getMemoryDir(workspacePath)` API; reconsider when the feature stabilizes. |
| Plan mode | stable in TUI; v2 plan delta protocol marked experimental | **Deliberately skipped.** Entry is strictly user-initiated (Shift+Tab keybind or `/plan` slash command); the model never auto-enters plan mode and there is no accept/reject gate after a normal turn — so it doesn't match the cockpit's "agent-decides, user-approves" UX. |

Grok implementation, native extensions, cost completeness, background work, and
platform verification are detailed in [spec-grok-build.md](docs/spec-grok-build.md).

Copilot SDK usage includes live/final checkpoint reconciliation, measured context
counts/limits, separate AI credits and premium requests, and profile-scoped quota
on desktop/mobile. Partial credit amounts are reported subtotals; unavailable
amounts and unknown account units are explicit. No USD estimate is inferred.
Quota reads are bounded and create no session or model work. Successful hosted
billing, genuine two-account access and native Windows/Linux qualification remain
pending. See [the backend contract](docs/spec-backend-services.md#copilot-context-snapshots-and-account-quota).

Copilot SDK chat now passes explicit uploads, with exact provider/model media
gates. Custom OpenAI gpt-6.1-sol images and Anthropic claude-sonnet-4.6
images/PDFs have native byte-transport evidence; hosted SDK PDF stays gated.
Native tool image/file bytes use persistent artifact cards on both clients,
including Stop/reload, while FILE_DELIVERY stays supported. Native image
generation is still unavailable. See the
[media contract](docs/spec-backend-services.md#copilot-media-input-and-tool-artifacts).
