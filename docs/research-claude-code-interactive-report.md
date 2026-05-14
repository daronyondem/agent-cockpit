# Claude Code Interactive Research Report

Date: 2026-05-14

## Verdict

`claude-code-interactive` is **viable only with an unacceptable or at least high-risk constraint**: Agent Cockpit would need to drive a hidden backend PTY and reconstruct structured events from Claude Code's private JSONL transcript files.

This spike followed the constraints in `docs/research-claude-code-interactive.md`: it did not use Claude Remote Control, did not build a user-facing embedded terminal, and did not change production backend code.

Without a PTY, `claude` without explicit `-p` is not a true interactive transport when stdout/stdin are pipes. It behaves as an implicit headless invocation. With `--output-format stream-json --verbose`, it emits the same useful stream shape as `claude -p --output-format stream-json`, but transcript entries use `entrypoint: "sdk-cli"`, not `entrypoint: "cli"`. This path is therefore not the intended `Claude Code Interactive` path.

With a real TTY, interactive Claude Code writes rich transcript JSONL with `entrypoint: "cli"`. The transcript contains enough data to reconstruct most Agent Cockpit events. The blocker is the input/control channel: sending prompts, answering `AskUserQuestion`, handling trust/permission screens, and stopping turns all require terminal UI automation.

## Support Page Context

Anthropic's support article, updated on 2026-05-14, says the monthly Agent SDK credit covers Claude Agent SDK usage, `claude -p`, Claude Code GitHub Actions, and third-party apps built on the Agent SDK. It explicitly excludes interactive Claude Code in the terminal or IDE. It also says that starting 2026-06-15, Agent SDK and `claude -p` usage no longer counts toward Claude plan usage limits, while interactive Claude Code continues to use subscription usage limits.

Source: <https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan>

## Experiments Run

All experiments used a disposable workspace under `/tmp` or `/var/folders/.../T`. Live model calls used `claude-haiku-4-5` to minimize cost. Most authenticated experiments used the existing default Claude Code config because a fresh `CLAUDE_CONFIG_DIR` would require an interactive login before the test could start.

### 1. Non-`-p`, No PTY, Stdin Pipe

Command shape:

```bash
claude --session-id <uuid> --model claude-haiku-4-5 --permission-mode bypassPermissions
```

Input was written through stdin. Result:

- Process exited `0`.
- Stdout was plain text (`READY.`).
- Transcript was written under `~/.claude/projects/.../<session>.jsonl`.
- Transcript entries used `entrypoint: "sdk-cli"`.
- Transcript included queue operations, user message, attachment, assistant thinking, assistant text, usage, `last-prompt`, and `ai-title`.

Conclusion: this is controllable without PTY, but it is still headless/SDK-style execution, not true interactive CLI execution.

### 2. Non-`-p`, No PTY, `--output-format stream-json`

Command shape:

```bash
claude --output-format stream-json --verbose --session-id <uuid> --model claude-haiku-4-5
```

Input was written through stdin. Result:

- Process exited `0`.
- Stdout emitted `stream-json`.
- Event sequence matched the current `claude -p --output-format stream-json --verbose` path, aside from ordering differences such as `rate_limit_event`.
- Init tools included the normal Claude Code tool set.

Conclusion: explicit `-p` is not required when stdio is non-TTY, but this does not solve the interactive backend goal. It gives a cosmetic no-`-p` variant of the current headless adapter.

### 3. True TTY Interactive Session

Command shape:

```bash
claude --session-id <uuid> --model claude-haiku-4-5
```

Prompt sent through a TTY:

```text
Say TTYREADY.
```

Result:

- Claude Code started the full terminal UI.
- The disposable workspace first triggered a trust prompt.
- The transcript used `entrypoint: "cli"`.
- Transcript included assistant thinking, assistant text, usage, and a `system` event with `subtype: "turn_duration"`.

Conclusion: true interactive mode is identifiable by `entrypoint: "cli"` and has useful transcript structure, but it requires terminal UI automation for input.

### 4. True TTY Tool Use

Prompt:

```text
Read sample.txt and reply only with the file content.
```

Result:

- Transcript contained `assistant` content `tool_use:Read`.
- Transcript contained a matching `user` `tool_result`.
- `toolUseResult.file` included file path, content, line counts, and source metadata.
- Final assistant text was recorded separately.
- `system subtype: "turn_duration"` appeared after the turn.

Conclusion: transcript watching can reconstruct tool activity and tool outcomes for normal file/tool use.

### 5. True TTY `AskUserQuestion`

Prompt:

```text
Use AskUserQuestion to ask me to choose Alpha or Beta. Do not answer yourself.
```

Result:

- Transcript contained `assistant` content `tool_use:AskUserQuestion`.
- The TTY rendered an interactive choice UI.
- Sending Enter selected the default `Alpha`.
- Transcript contained `user` `tool_result` with `toolUseResult.questions` and `toolUseResult.answers`.
- Final assistant text was recorded separately.

Conclusion: `AskUserQuestion` parity is possible from the transcript, but answering the question requires driving Claude Code's terminal choice UI. There is no stable non-terminal response channel in interactive mode.

### 6. Stop / Interrupt

Prompt:

```text
Write the numbers 1 through 1000, one per line. Do not use tools.
```

While the turn was active, Esc was sent through the TTY.

Result:

- The TTY reported interruption.
- Transcript recorded a synthetic assistant text message containing the partial output.
- Transcript then recorded a `user` message containing `[Request interrupted by user]`.
- No explicit structured "turn aborted" event was observed beyond that transcript marker.

Conclusion: stop-turn can probably be implemented by sending Esc, but the reliable completion/abort signal must be inferred from transcript content and/or terminal state.

### 7. Session Resume

Command shape:

```bash
claude --resume <session-id> --model claude-haiku-4-5
```

Follow-up prompt:

```text
What exact text did you output last turn?
```

Result:

- Claude Code resumed the prior interactive transcript.
- The answer correctly referenced the prior turn's output.
- New transcript entries appended to the same session JSONL.

Conclusion: later-session resume works in true interactive mode.

### 8. MCP Injection

Command shape:

```bash
claude --output-format stream-json --verbose --session-id <uuid> --model claude-haiku-4-5 --mcp-config '<json>'
```

The JSON configured `src/services/memoryMcp/stub.cjs` as `agent-cockpit-memory`.

Result:

- Init event reported the MCP server as connected.
- Init tools included:
  - `mcp__agent-cockpit-memory__memory_note`
  - `mcp__agent-cockpit-memory__memory_search`

A second true-TTY test injected the same memory MCP stub and prompted Claude Code to call `memory_search`. The dummy endpoint intentionally failed, but the transcript contained:

- `assistant` `tool_use:mcp__agent-cockpit-memory__memory_search`
- `user` `tool_result` with `is_error: true`
- `toolUseResult: "Error: Memory search failed: connect ECONNREFUSED 127.0.0.1:9"`
- final assistant text and `system subtype: "turn_duration"`

Conclusion: the existing `--mcp-config` shape is accepted in both the headless/no-PTY path and true interactive TTY mode. Production still needs endpoint/token wiring, but the CLI integration itself worked.

### 9. True TTY Bash, Edit, And Agent Tool Use

Prompt:

```text
Use Bash to run pwd. Use Edit to replace BEFORE with AFTER in sample-edit.txt. If a Task or Agent tool is available, use it once to ask a subagent to return exactly SUBAGENT_OK. Then reply TOOL_SAMPLE_DONE.
```

Result:

- Transcript contained `assistant` `tool_use:Bash`.
- Transcript contained matching `user` `tool_result` with `stdout`, `stderr`, `interrupted`, `isImage`, and `noOutputExpected`.
- Transcript contained `assistant` `tool_use:Read` followed by `tool_result` with `type` and `file`.
- Transcript contained `assistant` `tool_use:Edit`.
- Transcript contained matching `toolUseResult` fields: `filePath`, `oldString`, `newString`, `originalFile`, `structuredPatch`, `userModified`, and `replaceAll`.
- Transcript contained `assistant` `tool_use:Agent`.
- Transcript contained matching `toolUseResult` fields: `status`, `prompt`, `agentId`, `agentType`, `content`, `totalDurationMs`, `totalTokens`, `totalToolUseCount`, and `usage`.
- Final assistant text was `TOOL_SAMPLE_DONE`.

Conclusion: normal shell, file edit, and current subagent tool events are reconstructable from the interactive transcript. This materially improves the parity outlook for tool cards and Agent progress, but it still depends on private transcript shape.

### 10. True TTY Goal Mode

Prompt:

```text
/goal Answer with GOAL_DONE and consider the goal met after doing so.
```

Follow-up command:

```text
/goal clear
```

Result:

- The TTY entered goal mode and reported the goal as achieved after the assistant replied `GOAL_DONE`.
- Transcript contained `attachment.type: "goal_status"` with `met: false` at goal start.
- Transcript contained a later `attachment.type: "goal_status"` with `met: true`, reason, iterations, duration, and token metadata.
- Transcript contained `system subtype: "stop_hook_summary"` and `system subtype: "turn_duration"`.
- `/goal clear` was recorded as `system subtype: "local_command"` and returned `No goal set`, because the goal had already auto-cleared after completion.

Conclusion: goal mode is visible in the interactive transcript and likely supportable. The implementation risk is command/control reliability for slash commands and exact parser compatibility with current Agent Cockpit goal state.

### 11. Task List / Todo Behavior

Prompt:

```text
Use TodoWrite to create one todo named Research and mark it completed, then reply TODODONE.
```

Result:

- Claude Code v2.1.141 did not expose the old `TodoWrite` name in this run.
- It used `TaskCreate` and `TaskUpdate` instead.
- Transcript still captured both as normal `tool_use` / `tool_result` entries.
- Final assistant text was `TODODONE`.

Conclusion: todo/task-list parity appears structurally supportable, but implementation should not hard-code the old `TodoWrite` name as the only task-list tool.

### 12. Effort Flag

Command shape:

```bash
claude --output-format stream-json --verbose --session-id <uuid> --model claude-haiku-4-5 --effort high
```

Result:

- The CLI accepted `--effort high` without `-p`.
- The test used `claude-haiku-4-5`, so it only verifies flag acceptance, not model-specific reasoning-effort behavior.

Conclusion: effort selection is likely compatible at the CLI flag layer, but a production prototype should verify the flag against the exact models where Agent Cockpit exposes effort controls.

## Event Mapping

If implementation proceeds, the likely transcript mapping is:

| Transcript entry | Agent Cockpit event |
|---|---|
| `assistant.message.content[].type === "text"` | `text` |
| `assistant.message.content[].type === "thinking"` | `thinking` |
| `assistant.message.content[].type === "tool_use"` | `tool_activity` via existing `extractToolDetails()` |
| `user.message.content[].type === "tool_result"` | `tool_outcomes` via existing `extractToolOutcome()` |
| `user.toolUseResult.questions/answers` | `tool_outcomes` plus `AskUserQuestion` answer handling |
| `attachment.type === "goal_status"` | goal status update |
| `system.subtype === "stop_hook_summary"` | goal/stop-hook metadata |
| `assistant.message.usage` | `usage` |
| `system.subtype === "turn_duration"` | `done` / turn completion |
| `user` text `[Request interrupted by user]` | stopped/aborted turn marker |
| `system.subtype === "local_command"` | slash command result, normally ignored except goal/debug flows |
| `last-prompt`, `ai-title`, `file-history-snapshot`, `permission-mode` | ignore for chat stream |

The TTY stdout should not be the primary structured event source. It is terminal escape output and is too unstable for Agent Cockpit's rich chat model.

## Parity Matrix

| Capability | Evidence | Parity outlook |
|---|---|---|
| Assistant text | TTY transcript `assistant text` | Likely |
| Thinking | TTY transcript `assistant thinking` | Likely |
| Tool activity | TTY `Read`, `Bash`, `Edit`, `Agent`, MCP tests | Likely |
| Tool outcomes | TTY tool_result entries for `Read`, `Bash`, `Edit`, `Agent`, MCP error | Likely |
| Agent/subagent progress | TTY `Agent` test with `agentId`, `agentType`, content, duration, tokens, usage | Likely |
| AskUserQuestion | TTY `AskUserQuestion` test | Structurally likely, but answer input is brittle |
| Plan mode cards | Not directly tested | Unknown |
| Usage | TTY transcript `message.usage` | Likely |
| Turn completion | TTY `system turn_duration` | Likely, but private API |
| Errors | TTY MCP failure produced `tool_result is_error` | Tool errors likely; process/terminal errors still unknown |
| Stop turn | TTY Esc test | Possible, but inferred |
| Stable session id | `--session-id` TTY test | Likely |
| Session resume | `--resume` TTY test | Likely |
| Active-turn supervision | TTY process is observable | Possible |
| Model selection | `--model claude-haiku-4-5` reflected in transcript/UI | Likely |
| Effort selection | `--effort high` accepted without `-p`; not model-behavior verified | Likely, needs supported-model test |
| Permission mode parity | `bypassPermissions` triggers interactive warning UI | Risky |
| MCP injection | Non-PTY init and true-TTY MCP tool call verified existing config | Likely |
| Native memory capture | Same Claude project directory layout | Likely |
| Real-time memory watching | Same memory path layout | Likely |
| Goal mode | TTY `/goal` produced `goal_status`, `stop_hook_summary`, and local-command entries | Likely |
| One-shot workloads | Could be simulated with hidden TTY + transcript | Possible but slower and brittle |
| CLI profiles | Same `command/env/CLAUDE_CONFIG_DIR` should apply | Likely, auth setup not tested |
| Plan usage tooltip | Not a focus | Unchanged/open |

## Architecture If We Proceed

Recommended prototype architecture:

1. Add a separate backend id `claude-code-interactive`.
2. Keep the existing `claude-code` backend unchanged.
3. Use a hidden backend PTY only as the input/control channel.
4. Use transcript JSONL as the structured event source.
5. Add a transcript tailer that:
   - resolves the Claude project directory for the selected workspace/profile,
   - tracks JSONL offsets,
   - filters to the active session and active turn,
   - maps transcript entries to `StreamEvent`.
6. Add a TTY controller that:
   - waits for initial ready prompt,
   - handles first-run trust and bypass-permissions warning screens,
   - writes user prompts,
   - sends Esc for stop-turn,
   - answers `AskUserQuestion` choice screens.
7. Keep one-shot support out of the first production slice unless the PTY controller proves reliable. A one-shot parity helper would start a hidden TTY session, send one prompt, wait for `turn_duration`, collect assistant text, then `/exit`.

## Blockers

The exact blocker is **the lack of a stable interactive input/control protocol**.

The transcript is rich enough to reconstruct many output events. But interactive Claude Code still requires terminal UI automation for:

- prompt entry,
- trust prompts,
- bypass-permissions warning prompts,
- AskUserQuestion answer selection,
- slash command flows,
- interrupt/stop behavior,
- detecting ready/waiting states.

If hidden backend PTY automation is considered terminal embedding or otherwise unacceptable, `claude-code-interactive` is not viable. If hidden PTY automation is acceptable, the backend is technically plausible but depends on private transcript files and terminal UI behavior that may change across Claude Code releases.

## Risks And Private API Dependencies

- Claude Code JSONL transcript files are not a documented transport API.
- True interactive mode emits `entrypoint: "cli"` transcript entries, but the ordering and field names could change across Claude Code versions.
- The terminal UI is stateful. Trust prompts, bypass-permissions warnings, slash command flows, and `AskUserQuestion` menus require UI-state detection and keypress automation.
- Non-TTY no-`-p` mode is not enough. It is controllable and structured, but behaves like headless execution with `entrypoint: "sdk-cli"`.
- Stop-turn has no clean transcript event in the observed run. The transcript recorded partial synthetic output and then `[Request interrupted by user]`.
- Some parity areas were not directly exercised in this spike: plan mode cards, process-level error diagnostics, production-authenticated Memory MCP calls, and supported-model `--effort` behavior.
- The experiments used the existing authenticated Claude Code config. A production profile implementation still needs a dedicated `CLAUDE_CONFIG_DIR` authentication flow, matching existing CLI profile behavior.

## Required Modules And Tests If Implementation Proceeds

Likely implementation modules:

- `src/services/backends/claudeCodeInteractive.ts` — new backend adapter with metadata, send/resume/stop/session logic, and one-shot parity only if proven.
- `src/services/backends/claudeInteractivePty.ts` — hidden PTY lifecycle, prompt-ready detection, input writing, `/exit`, Esc stop, trust/permission/question UI handling.
- `src/services/backends/claudeTranscriptTailer.ts` — JSONL offset tracking, active-turn filtering, transcript-entry normalization, stale-history suppression.
- `src/services/backends/claudeTranscriptEvents.ts` — pure mapping from transcript entries to Agent Cockpit `StreamEvent` objects.
- Shared helpers in `src/services/backends/claudeCode.ts` should be moved only if needed, for example project directory resolution, memory directory resolution, goal parsing, and MCP config conversion.
- `src/services/cliProfiles.ts` / settings code may need to accept `claude-code-interactive` as a separate backend while sharing Claude Code profile fields.

Likely focused tests:

- `test/claudeCodeInteractiveBackend.test.ts` — metadata, profile runtime resolution, transcript mapping, active-turn filtering, stop markers, and session resume.
- `test/claudeInteractivePty.test.ts` — PTY state machine with mocked terminal output for prompt-ready, trust prompt, permission warning, question menu, `/exit`, and Esc.
- `test/claudeTranscriptTailer.test.ts` — append-only JSONL tailing, offset persistence, partial-line handling, stale-history suppression, turn completion on `system.turn_duration`.
- `test/chat.streaming.test.ts` additions — route integration for `claude-code-interactive` stream frames.
- `test/goalState.test.ts` / backend goal tests — `/goal` and `/goal clear` transcript parity if the prototype proves goal support.
- `test/planUsageStores.test.ts` only if the UI treats this backend as sharing or separating Claude plan usage display.

## Recommendation

Do not implement `claude-code-interactive` as production support yet.

Proceed only with a dedicated prototype if the product decision is that a hidden backend PTY is acceptable. The prototype should prove these before implementation:

1. TTY controller can robustly reach prompt-ready state after trust/permission screens.
2. Transcript tailer can emit current-turn events without replaying stale history.
3. AskUserQuestion can be answered reliably from Agent Cockpit UI input.
4. Stop turn reliably maps to Esc and produces a detectable terminal state.
5. `/goal` and `/goal clear` transcript behavior can be parsed into current Agent Cockpit goal state without terminal scraping.
6. MCP Memory tools work in true TTY mode with Agent Cockpit's production endpoints and token wiring.
7. One-shot workloads can complete deterministically or are explicitly left on `claude-code`.

Until those are proven, the current `claude-code` backend remains the reliable Claude integration.
