# Claude Code Interactive Implementation Plan

Status: Proposed
Date: 2026-05-14

## Goal-System Objective

Use this short objective when handing the work to the goal system:

```text
Implement the separate `claude-code-interactive` backend/provider end to end according to `docs/design-claude-code-interactive-implementation-plan.md`. Preserve the existing `claude-code` backend. Do not use Claude Remote Control and do not expose a user-facing terminal. Implement hidden backend PTY control, transcript-derived streaming events, CLI compatibility warnings, tests, specs, and any required ADR. Verify with the required commands listed in the plan.
```

## Executive Summary

Add a new backend/provider named **Claude Code Interactive** with backend id `claude-code-interactive`. It should use true interactive Claude Code, not `claude -p`, while preserving the Agent Cockpit chat UI and event model.

The implementation is intentionally separate from the existing `claude-code` adapter. The existing adapter remains the reliable headless `claude --print/-p --output-format stream-json` integration and continues serving one-shot work by default.

The interactive adapter must:

- spawn `claude` in a hidden backend pseudo-terminal (PTY),
- use the PTY only for input/control,
- ignore terminal screen output as a structured stream source,
- watch Claude Code JSONL transcript files for output events,
- map transcript entries into existing `StreamEvent` frames,
- support the same conversation/session/profile/model/effort/MCP/memory/goal surfaces as `claude-code`,
- surface provider-specific CLI compatibility warnings when the installed Claude Code CLI version differs from the version Agent Cockpit has tested.

This is a high-risk adapter because it depends on private Claude Code transcript fields and terminal UI behavior. The implementation should ship with strong version gating, focused unit tests, and a documented compatibility contract.

## Product And UX Decisions

- Backend id: `claude-code-interactive`
- Display label: `Claude Code Interactive`
- This is a separate provider, not a mode flag inside `claude-code`.
- It shares Claude Code CLI profiles and auth/config with `claude-code`.
- It must not replace, degrade, or refactor the existing `claude-code` headless behavior.
- It must not auto-update the shared `claude` CLI for the interactive adapter.
- It may allow users to run with a newer CLI version, but must warn clearly that Agent Cockpit has not validated that version.
- It should remain opt-in by provider selection.
- One-shot background work should initially stay on the existing `claude-code` adapter unless the user explicitly configures `claude-code-interactive` and accepts the extra risk. Title generation, summaries, OCR, Memory processing, KB digestion/dreaming, and Context Map should not be forced through hidden PTY in the first production slice.

## Research Inputs

Use these documents as source material:

- `docs/research-claude-code-interactive.md`
- `docs/research-claude-code-interactive-report.md`

Key research findings to preserve:

- Non-PTY `claude` without `-p` behaves like headless SDK-style execution and writes transcript entries with `entrypoint: "sdk-cli"`.
- True interactive `claude` requires a real TTY and writes transcript entries with `entrypoint: "cli"`.
- True-TTY transcripts captured assistant text, thinking, `Read`, `Bash`, `Edit`, `Agent`, MCP tool calls, `AskUserQuestion`, usage, stop markers, session resume, and goal status.
- The blocker is not output reconstruction. The blocker is the lack of a stable input/control API.
- Prompt entry, trust prompts, permission warnings, slash commands, AskUserQuestion menus, stop behavior, and ready-state detection require terminal UI automation.
- The tested Claude Code CLI version during research was `2.1.141`.

## Architecture Overview

The data flow should be:

```text
Agent Cockpit UI
  -> REST/WS chat routes
  -> ClaudeCodeInteractiveAdapter
  -> hidden PTY running `claude`
  -> Claude Code transcript JSONL
  -> ClaudeTranscriptTailer
  -> ClaudeTranscriptEvents mapper
  -> existing StreamEvent pipeline
  -> Agent Cockpit UI
```

The PTY is the write/control channel. The transcript tailer is the read/event channel.

Do not parse terminal escape output into chat events except for coarse state-machine readiness and prompt/menu detection. Terminal output is too unstable to be the durable stream source.

## Compatibility Contract

### Tested Version Constant

Create a single source of truth for the interactive adapter's tested CLI version:

```ts
export const CLAUDE_CODE_INTERACTIVE_TESTED_CLI_VERSION = '2.1.142';
```

Place it near the adapter implementation, likely in `src/services/backends/claudeCodeInteractive.ts` or a focused `src/services/backends/claudeInteractiveCompatibility.ts`.

### Version Status

Represent at least these states:

- `supported`: installed version exactly matches a known tested version.
- `newer`: installed version is newer than the tested version; allow with warning.
- `older`: installed version is older than the tested version; warn or block depending on missing features.
- `unknown`: version could not be parsed; warn and allow only with clear degraded-support copy.
- `missing`: CLI is missing; block.

Suggested server-side shape:

```ts
interface CliCompatibilityStatus {
  providerId: 'claude-code-interactive';
  command: string;
  currentVersion: string | null;
  testedVersion: string;
  status: 'supported' | 'newer' | 'older' | 'unknown' | 'missing';
  severity: 'none' | 'warning' | 'error';
  message: string | null;
}
```

### Warning Copy

Use direct copy like:

> Your installed Claude Code CLI is newer than the version Agent Cockpit currently supports for Claude Code Interactive. Interactive mode may still work, but you could run into compatibility issues. Standard mode is fully supported and ready to use. Standard mode uses your monthly credits, while Interactive mode uses your Claude usage limits. Agent Cockpit will add support for newer Claude Code CLI versions as soon as possible. Learn more: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan

### Update Behavior

The existing CLI update service groups targets by physical CLI command. Because `claude-code` and `claude-code-interactive` share the same binary, the update UI must make the interactive risk visible.

Implement these rules:

1. Keep the normal update mechanism available for `claude-code`.
2. Do not present auto-update as a compatibility fix for `claude-code-interactive`.
3. If any enabled profile or active conversation uses `claude-code-interactive`, the Claude CLI update row should show an additional caution that updating may make the interactive provider incompatible.
4. After update, recompute compatibility status and show the newer-than-tested warning when applicable.
5. The composer/provider UI should warn at send time if the selected provider is interactive and the installed version is not `supported`.

## Backend Identity And Profile Model

The current `CliVendor` union is:

```ts
export type CliVendor = 'codex' | 'claude-code' | 'kiro';
```

Do not blindly add `claude-code-interactive` as a physical vendor if that causes profile duplication. The better model is:

- `CliVendor` remains the physical CLI/auth/config vendor where possible.
- A new backend id `claude-code-interactive` maps to Claude Code runtime profiles.
- Conversation `backend` can be `claude-code-interactive`.
- Conversation `cliProfileId` can point at a profile whose `vendor` is `claude-code`.
- Runtime resolution must support a backend id that is not identical to profile vendor when the backend is a mode/provider built on the same CLI.

Implementation options:

1. Introduce an explicit backend-to-profile-vendor mapping:

```ts
export function cliVendorForBackend(backendId: string): CliVendor | undefined {
  if (backendId === 'claude-code-interactive') return 'claude-code';
  if (isCliVendor(backendId)) return backendId;
  return undefined;
}
```

2. Update `cliProfileIdForBackend(backend)` to use this mapping.
3. Update `resolveCliProfileRuntime()` so fallback backend `claude-code-interactive` returns `backendId: 'claude-code-interactive'` while using the `server-configured-claude-code` profile/runtime when no explicit profile is selected.
4. Update route checks that currently require `profile.vendor === backend` so they allow `profile.vendor === cliVendorForBackend(backend)`.

Avoid duplicating Claude profiles as separate `claude-code-interactive` profiles. Users should not need to authenticate twice just because two providers share the same CLI.

## New And Changed Modules

### Backend Adapter

Create:

- `src/services/backends/claudeCodeInteractive.ts`

Responsibilities:

- Extend `BaseBackendAdapter`.
- Metadata:
  - `id: 'claude-code-interactive'`
  - `label: 'Claude Code Interactive'`
  - reuse Claude Code icon and model list.
  - capabilities should match Claude Code where implemented: thinking, plan mode, agents, tool activity, user questions, stdin input, goals.
  - resume capabilities should describe session resume support and active-turn reattach limitations honestly.
- `sendMessage()` starts or reuses an interactive hidden PTY session.
- `sendInput()` routes user answers into the PTY state machine, not stdin pipes.
- `abort()` sends Esc first, escalates to process termination only after timeout.
- `getGoal()`, `setGoalObjective()`, `clearGoal()` use transcript parsing plus slash-command injection.
- `extractMemory()` and `getMemoryDir()` delegate to Claude Code helpers with `sourceBackend: 'claude-code-interactive'` only if the data model should distinguish source backend; otherwise preserve the existing Claude memory source semantics.
- `runOneShot()` should initially delegate to `ClaudeCodeAdapter.runOneShot()` or throw with a clear unsupported message depending on the selected product decision. Prefer delegation for background reliability.

Do not copy the entire `ClaudeCodeAdapter`. Extract shared helpers only where duplication becomes material.

### PTY Controller

Create:

- `src/services/backends/claudeInteractivePty.ts`

Responsibilities:

- Own PTY process lifecycle.
- Spawn `claude` without `--print` and without `-p`.
- Use the selected Claude runtime command/env/config dir.
- Use `--session-id` for new sessions and `--resume` for existing sessions.
- Forward supported flags:
  - `--model`
  - `--effort` only when selected model supports it
  - `--permission-mode bypassPermissions`
  - `--append-system-prompt` on new sessions when non-empty
  - `--mcp-config` when MCP servers are present
- Emit process id via `backend_runtime`.
- Maintain coarse terminal states:
  - `starting`
  - `trust_prompt`
  - `permission_warning`
  - `ready`
  - `submitting`
  - `running`
  - `awaiting_question`
  - `stopping`
  - `exited`
  - `failed`
- Provide methods:
  - `start()`
  - `sendPrompt(text)`
  - `sendSlashCommand(command)`
  - `answerQuestion(answerTextOrOptionIndex)`
  - `stopTurn()`
  - `exit()`
  - `kill()`
- Normalize line endings; prefer `\r` for Enter in the PTY.
- Handle prompt readiness by combining terminal-output heuristics with transcript tailer state.
- Handle trust prompt by selecting the safe "Yes, I trust this folder" path only for the selected workspace.
- Handle bypass-permissions warning if Claude Code renders one.
- Never expose raw terminal contents to users by default.
- Redact terminal snippets before logging.

Dependency note: the repo does not currently include `node-pty`. The implementation should evaluate adding it as a production dependency. If native install friction is unacceptable, use a small adapter interface around the PTY dependency so tests can mock it and a future implementation can swap the backend.

### PTY Session Manager

Create:

- `src/services/backends/claudeInteractiveSessionManager.ts`

Responsibilities:

- Keep one live interactive PTY session per conversation/profile/session tuple.
- Key sessions by:
  - conversation id,
  - session id,
  - profile key,
  - working directory.
- Reuse the same PTY between turns when possible.
- Start a new PTY when the previous process exited.
- Clean up on:
  - adapter `shutdown()`,
  - `onSessionReset(conversationId)`,
  - abort escalation,
  - conversation archive/delete through existing adapter lifecycle hooks if available.
- Prevent concurrent prompt writes to the same session.
- Expose active process details to stream job supervision.

### Transcript Tailer

Create:

- `src/services/backends/claudeTranscriptTailer.ts`

Responsibilities:

- Resolve transcript paths from:
  - working directory,
  - session id,
  - `CLAUDE_CONFIG_DIR`/profile config dir.
- Reuse `resolveClaudeProjectDirCandidates()` from `claudeCode.ts`; export it if needed.
- Tail append-only JSONL safely:
  - track byte offsets,
  - buffer partial lines,
  - tolerate malformed lines by surfacing non-terminal warnings only in debug/test mode,
  - filter by `sessionId`,
  - filter by `entrypoint: "cli"`,
  - avoid replaying stale history from prior turns.
- Expose an async iterator of parsed transcript entries.
- Provide explicit `waitForTranscriptPath()` because Claude may create the file after process start.
- Provide timeouts for:
  - file creation,
  - first current-turn user entry,
  - turn completion.
- End current turn on `system.subtype === "turn_duration"` unless a more reliable marker is discovered.

### Transcript Event Mapper

Create:

- `src/services/backends/claudeTranscriptEvents.ts`

Responsibilities:

- Pure conversion from parsed transcript entries to `StreamEvent[]`.
- No file IO.
- No process control.
- Maintain `toolNameById` and any active parent-agent context.
- Map:
  - assistant text -> `text`
  - thinking -> `thinking`
  - tool_use -> `tool_activity`
  - tool_result -> `tool_outcomes`
  - `AskUserQuestion` tool_use -> `tool_activity` with `isQuestion`
  - `goal_status` attachments -> `goal_updated`
  - `stop_hook_summary` -> goal/diagnostic metadata where applicable
  - assistant usage -> `usage`
  - `turn_duration` -> `done`
  - `[Request interrupted by user]` -> abort marker/error with source `abort`
  - MCP tool errors -> `tool_outcomes` with `isError`
- Reuse `extractToolDetails()`, `extractToolOutcome()`, and `extractUsage()` from `toolUtils`.
- Add specific mapping coverage for observed true-TTY tool result shapes:
  - `Read`
  - `Bash`
  - `Edit`
  - `Agent`
  - `TaskCreate`
  - `TaskUpdate`
  - `AskUserQuestion`
  - `mcp__agent-cockpit-memory__memory_search`
  - `mcp__agent-cockpit-memory__memory_note`

### Compatibility Service

Create:

- `src/services/backends/claudeInteractiveCompatibility.ts`

Responsibilities:

- Run `claude --version` through the selected runtime command/env.
- Parse versions using the existing `parseVersion()` helper from `cliUpdateService.ts` or move semver helpers to a small shared module to avoid circular coupling.
- Compare current version to `CLAUDE_CODE_INTERACTIVE_TESTED_CLI_VERSION`.
- Return provider-specific compatibility status.
- Keep this independent from update availability. Compatibility is about support, not whether a newer package exists.

### CLI Update Service Changes

Modify:

- `src/services/cliUpdateService.ts`
- `src/types/index.ts`
- `src/contracts/responses.ts`
- `web/AgentCockpitWeb/src/cliUpdateStore.js`
- `web/AgentCockpitWeb/src/screens/settingsScreen.jsx`
- `web/AgentCockpitWeb/src/shell.jsx`

Plan:

- Extend `CliUpdateStatus` with optional interactive compatibility warnings, for example:

```ts
interactiveCompatibility?: CliCompatibilityStatus[];
blocksAutoUpdate?: boolean;
updateCaution?: string | null;
```

- When a target is `vendor: 'claude-code'`, inspect settings/conversations or configured profiles enough to determine whether `claude-code-interactive` is relevant.
- Add compatibility details for `claude-code-interactive` without turning the shared physical target into a separate CLI install.
- Keep `triggerUpdate()` behavior unchanged for plain Claude Code, but show stronger UI caution if interactive provider is in use.
- After update, refresh compatibility.
- In composer update popover, show compatibility warning when the current selected backend is `claude-code-interactive`.
- In Settings CLI updates panel, show a warning row under the Claude CLI target when the installed version is newer/older/unknown for interactive support.

### Server Registration

Modify:

- `server.ts`

Register the adapter after the existing `claude-code` adapter:

```ts
backendRegistry.register(new ClaudeCodeInteractiveAdapter({ workingDir: config.DEFAULT_WORKSPACE }));
```

Keep `claude-code` registered first so default behavior does not change.

### Profile And Settings Resolution

Modify:

- `src/services/cliProfiles.ts`
- `src/services/settingsService.ts`
- `src/services/chatService.ts`
- `src/routes/chat/streamRoutes.ts`
- `src/routes/chat/goalRoutes.ts`
- `src/routes/chat/statusRoutes.ts`
- `src/contracts/chat.ts`
- `src/contracts/responses.ts`
- frontend provider/profile selection code in `web/AgentCockpitWeb/src/`

Plan:

- Add backend-to-CLI-vendor mapping as described above.
- Keep server-configured Claude profile id as `server-configured-claude-code`.
- Allow a conversation backend of `claude-code-interactive` to use a Claude Code profile.
- Update validation that currently compares `backend === profile.vendor`.
- Ensure new conversations can be created with:
  - `{ backend: 'claude-code-interactive' }`
  - `{ backend: 'claude-code-interactive', cliProfileId: 'server-configured-claude-code' }`
  - a custom Claude Code profile selected while backend is interactive.
- Ensure existing Claude Code profiles appear as selectable for both Claude providers without duplicating auth setup.
- Decide whether `Settings.defaultBackend` can be `claude-code-interactive`; if yes, `defaultCliProfileId` should still point to a Claude Code profile.
- Ensure settings save normalization does not discard `claude-code-interactive` as an unknown backend.

### Stream Routes And Active Stream Supervision

The existing `sendMessage()` adapter contract should remain unchanged:

```ts
{
  stream: AsyncGenerator<StreamEvent>;
  abort: () => void;
  sendInput: (text: string) => void;
}
```

The interactive adapter should use this contract as follows:

- `stream` yields transcript-derived events.
- `abort` calls PTY `stopTurn()`, then escalates to process kill if no turn completion marker arrives.
- `sendInput` answers AskUserQuestion or any future terminal waiting state.

Existing `StreamJobSupervisor`, `activeStreams`, REST abort, and WebSocket replay should continue to work without route-level special cases.

Add special handling only if necessary for readiness delays. If route changes are needed, keep them in `streamRoutes.ts` and avoid pushing PTY-specific logic into `ChatService`.

### Goal Mode

Observed true-TTY goal transcript entries include:

- `attachment.type: "goal_status"` with `met: false`
- later `attachment.type: "goal_status"` with `met: true`
- `system.subtype: "stop_hook_summary"`
- `system.subtype: "local_command"` for slash command output

Implementation plan:

- Reuse or generalize `parseClaudeGoalFromJsonl()` from `claudeCode.ts`.
- Set backend on parsed goal snapshots to `claude-code-interactive`.
- `setGoalObjective(objective)` sends `/goal ${objective}` through the PTY.
- `clearGoal()` sends `/goal clear` through the PTY and waits for transcript/local-command evidence.
- Keep `pause` and `resume` unsupported unless verified.
- Add tests for active, complete, cleared, and auto-cleared goal states.

### Memory And MCP

Implementation plan:

- For memory-enabled chat sessions, continue passing `mcpServers` from routes to the adapter.
- Convert ACP-shaped MCP config with existing `mcpServersToClaudeConfigJson()`.
- Pass `--mcp-config` to interactive Claude.
- Keep Memory MCP token idempotency behavior unchanged.
- Reuse Claude Code native memory path resolution.
- Ensure `sourceBackend` handling is intentional:
  - If preserving current semantics matters, store native Claude memory as `sourceBackend: 'claude-code'`.
  - If distinguishing providers matters, store `sourceBackend: 'claude-code-interactive'` and update specs/tests accordingly.
- Real-time memory watcher should work because `getMemoryDir()` points to the same Claude project memory directory.

### One-Shot Workloads

Default plan:

- `ClaudeCodeInteractiveAdapter.runOneShot()` delegates to `ClaudeCodeAdapter.runOneShot()` using the same profile/runtime.
- This preserves reliability for:
  - title generation,
  - session summaries,
  - OCR,
  - Memory MCP processor work,
  - KB digestion/dreaming,
  - Context Map extraction/synthesis.
- Document that "Claude Code Interactive" streaming sessions use subscription interactive behavior, while one-shot background jobs still use headless Claude Code unless a future release explicitly implements hidden-PTY one-shot parity.

Reasoning:

- One-shot jobs do not need interactive terminal quota behavior as much as chat sessions.
- Hidden PTY one-shot would be slower and significantly harder to make deterministic.
- This keeps the first implementation bounded while preserving user-facing chat provider parity.

If product decides one-shot must also use true interactive Claude, implement it only after the streaming adapter is stable:

1. start hidden PTY,
2. send prompt,
3. collect transcript text until `turn_duration`,
4. send `/exit`,
5. return text,
6. enforce timeout and cleanup.

## Transcript Mapping Details

Map transcript entries to Agent Cockpit events as follows:

| Transcript entry | StreamEvent |
|---|---|
| `assistant.message.content[].type === "text"` | `{ type: "text", content }` |
| `assistant.message.content[].type === "thinking"` | `{ type: "thinking", content }` |
| `assistant.message.content[].type === "tool_use"` | `{ type: "tool_activity", ...extractToolDetails(block) }` |
| `user.message.content[].type === "tool_result"` | `{ type: "tool_outcomes", outcomes: [...] }` |
| `toolUseResult.questions/answers` | question outcome update |
| `attachment.type === "goal_status"` | `{ type: "goal_updated", goal }` |
| `assistant.message.usage` | `{ type: "usage", ... }` |
| `system.subtype === "turn_duration"` | `{ type: "done" }` |
| `user` text includes `[Request interrupted by user]` | abort marker; likely terminal error with `source: "abort"` only if no final `done` follows |
| `system.subtype === "local_command"` | slash command output; use for goal clear diagnostics |
| `permission-mode`, `file-history-snapshot`, `last-prompt`, `ai-title` | ignore |

Open questions to resolve during implementation:

- Does transcript flush fast enough for acceptable real-time UI? If not, add small polling intervals and latency metrics.
- Are text/thinking entries emitted only as whole blocks in interactive mode? If yes, mark them non-streaming or chunk them into smaller artificial frames only if the UI needs progressive rendering.
- Does Claude Code ever emit duplicate transcript lines after resume? Tailer must dedupe by entry UUID.
- Does `turn_duration` always appear after interrupted and failed turns? If not, add terminal-state timeout fallback.

## PTY State Machine Details

The PTY controller should be deliberately conservative.

### Startup

1. Spawn interactive `claude`.
2. Start transcript tailer immediately.
3. Wait for one of:
   - ready prompt,
   - trust prompt,
   - permission warning,
   - process exit,
   - startup timeout.
4. If trust prompt appears, select trust only for the configured workspace path.
5. If permission warning appears, accept only if the adapter intentionally launched with `bypassPermissions`.
6. Once ready, send prompt or slash command.

### Prompt Submission

1. Write prompt text to PTY.
2. Press Enter.
3. If terminal buffer shows the prompt still editing after a short delay, press Enter once more. This was required in research for some wrapped slash commands.
4. Start current-turn tracking in the transcript tailer.
5. Mark state `running`.

### Question Handling

1. Detect `AskUserQuestion` from transcript `tool_use`.
2. Yield `tool_activity` with `isQuestion: true`.
3. Mark PTY state `awaiting_question`.
4. Existing frontend sends answer through `sendInput`.
5. Map answer to terminal menu action:
   - if answer matches an option label, move selection if needed and press Enter,
   - otherwise type free-form answer if Claude Code supports it; if not, surface a clear error.
6. Resume state `running`.

### Stop

1. `abort()` sends Esc.
2. Wait for transcript marker:
   - `[Request interrupted by user]`,
   - `turn_duration`,
   - process exit.
3. If no marker arrives by timeout, kill the PTY process.
4. Yield a durable abort/error frame consistent with existing REST abort behavior.

### Exit

Use `/exit` at graceful lifecycle boundaries. Use process kill only if `/exit` does not complete.

## Testing Plan

### Unit Tests

Add:

- `test/claudeCodeInteractiveBackend.test.ts`
- `test/claudeInteractivePty.test.ts`
- `test/claudeTranscriptTailer.test.ts`
- `test/claudeTranscriptEvents.test.ts`
- `test/claudeInteractiveCompatibility.test.ts`

Update:

- `test/backends.test.ts`
- `test/chat.streaming.test.ts`
- `test/chat.rest.test.ts`
- `test/chat.websocket.test.ts`
- `test/goalState.test.ts`
- `test/cliUpdateService.test.ts`
- `test/settingsService.test.ts`
- `test/chatService.conversations.test.ts`
- `test/chatContracts.test.ts`
- `test/frontendRoutes.test.ts`
- `test/streamStore.test.ts`
- `test/planUsageStores.test.ts` only if plan-usage store keying changes.

### Transcript Fixture Tests

Use fixture JSONL files instead of live Claude calls for normal tests.

Create fixtures under:

- `test/fixtures/claude-interactive/text-thinking.jsonl`
- `test/fixtures/claude-interactive/read-bash-edit-agent.jsonl`
- `test/fixtures/claude-interactive/ask-user-question.jsonl`
- `test/fixtures/claude-interactive/mcp-error.jsonl`
- `test/fixtures/claude-interactive/goal-complete.jsonl`
- `test/fixtures/claude-interactive/stop-interrupted.jsonl`
- `test/fixtures/claude-interactive/task-list.jsonl`

Each fixture should be reduced and sanitized, not copied wholesale from private transcripts. Preserve only fields needed for mapping.

### PTY Tests

Mock the PTY interface. Do not spawn real Claude in unit tests.

Cover:

- trust prompt selection,
- bypass-permissions warning acceptance,
- ready prompt detection,
- prompt submission,
- second-Enter fallback for wrapped slash commands,
- AskUserQuestion option selection,
- Esc stop,
- timeout escalation,
- process exit cleanup,
- redacted terminal logging.

### Compatibility Tests

Cover:

- exact version -> supported,
- newer version -> warning,
- older version -> warning/error,
- unparseable version -> warning,
- missing CLI -> error,
- shared Claude CLI update target includes interactive compatibility status,
- update row warning appears when interactive provider is configured,
- no interactive warning appears when only regular `claude-code` is configured.

### Route And Integration Tests

Cover:

- `GET /backends` includes `claude-code-interactive`.
- Creating a conversation with `backend: 'claude-code-interactive'` stores that backend and uses a Claude Code profile.
- Selecting a Claude Code profile with the interactive backend is allowed.
- Selecting a Codex/Kiro profile with the interactive backend is rejected.
- `POST /message` passes runtime profile/env/config to the interactive adapter.
- `POST /conversations/:id/abort` reaches interactive adapter `abort()`.
- `POST /conversations/:id/input` reaches interactive adapter `sendInput()`.
- Goal routes work with transcript-derived goal status.
- Active stream status includes backend id and runtime process id.

### Frontend Tests

Cover:

- Provider selector shows `Claude Code Interactive` separately.
- Claude Code profiles are selectable for both Claude Code providers.
- Composer warning appears for incompatible interactive CLI versions.
- Settings CLI update panel shows interactive compatibility warning.
- Update popover warns before updating a shared Claude CLI when interactive provider is in use.
- AskUserQuestion UI still sends input through existing flow.
- Stop button behavior remains unchanged from the user's perspective.

### Optional Manual Smoke Tests

After unit/integration tests pass, run manual smoke tests locally:

1. Start Agent Cockpit with pm2, not `node server.js`.
2. Create a new conversation with `Claude Code Interactive`.
3. Send plain text prompt.
4. Send prompt using `Read`.
5. Send prompt using `Bash`.
6. Send prompt using `Edit` in a disposable workspace.
7. Trigger `AskUserQuestion` and answer from UI.
8. Trigger `Agent` tool.
9. Trigger memory MCP `memory_search`.
10. Set `/goal`, observe goal strip, and clear/complete it.
11. Stop a long-running turn.
12. Resume conversation in a later turn.
13. Upgrade/downgrade local Claude CLI in a controlled environment and confirm warnings.

## Documentation And ADR Plan

This implementation warrants an ADR because it:

- introduces a high-risk private API dependency,
- adds a provider that shares a physical CLI with another provider,
- depends on hidden PTY automation,
- changes update/compatibility behavior for a shared CLI binary.

Create an ADR:

```bash
npm run adr:new -- "Support Claude Code Interactive through transcript-watched PTY"
```

ADR should cover:

- why Agent SDK/headless mode was not enough,
- why Remote Control was rejected,
- why user-facing embedded terminal was rejected,
- why hidden backend PTY plus transcript tailing was accepted,
- why compatibility is pinned/warned by tested CLI version,
- why one-shot workloads initially delegate to regular Claude Code.

Update specs:

- `docs/SPEC.md` design docs/notes index if needed.
- `docs/spec-backend-services.md`
  - new backend metadata,
  - profile/backend mapping,
  - transcript tailer,
  - PTY controller,
  - compatibility status,
  - one-shot delegation.
- `docs/spec-api-endpoints.md`
  - any new compatibility fields or endpoints.
- `docs/spec-frontend.md`
  - provider selector,
  - CLI update warning UI,
  - composer compatibility warning.
- `docs/spec-testing.md`
  - new test files and expanded coverage.
- `docs/spec-mobile-pwa.md`
  - explicitly state mobile impact. If mobile provider selection uses shared backend metadata, note the warning behavior or why mobile has no CLI update controls.

Evaluate whether `AGENTS.md` needs an update. It probably does not unless this introduces a recurring workflow rule for agents beyond this specific provider.

## Implementation Sequence

### Phase 0: Safety Setup

1. Confirm working tree state.
2. Add ADR scaffold if implementation will proceed.
3. Add transcript fixtures from sanitized research data.
4. Add compatibility helper tests first.

Verification:

- `npm test -- --runTestsByPath test/claudeInteractiveCompatibility.test.ts`

### Phase 1: Backend/Profile Identity

1. Add backend-to-CLI-vendor mapping helper.
2. Update settings/profile normalization to allow `claude-code-interactive`.
3. Update conversation creation/update logic.
4. Update route validation for profile/backend compatibility.
5. Register placeholder adapter metadata only, with `sendMessage()` temporarily throwing a clear unsupported error.

Verification:

- `npm test -- --runTestsByPath test/settingsService.test.ts test/chatService.conversations.test.ts test/chat.rest.test.ts test/backends.test.ts test/chatContracts.test.ts`

### Phase 2: Compatibility Status And UI Warnings

1. Add tested-version constant.
2. Add compatibility service.
3. Extend CLI update response types/contracts.
4. Add server status integration.
5. Add Settings warning UI.
6. Add composer/provider warning UI.

Verification:

- `npm test -- --runTestsByPath test/cliUpdateService.test.ts test/frontendRoutes.test.ts test/streamStore.test.ts`
- `npm run web:typecheck`

### Phase 3: Transcript Event Mapper

1. Implement pure transcript entry types.
2. Implement mapper with fixture tests.
3. Reuse existing tool helpers.
4. Add goal status parser support for interactive backend id.

Verification:

- `npm test -- --runTestsByPath test/claudeTranscriptEvents.test.ts test/goalState.test.ts test/toolUtils.test.ts`

### Phase 4: Transcript Tailer

1. Implement JSONL tailer.
2. Add path resolution and file-creation wait.
3. Add offset/partial-line/dedupe/current-turn filtering.
4. Add completion detection.

Verification:

- `npm test -- --runTestsByPath test/claudeTranscriptTailer.test.ts`

### Phase 5: PTY Controller

1. Add PTY abstraction and dependency.
2. Implement mocked PTY state machine.
3. Implement prompt/slash/input/stop/exit methods.
4. Add redacted logging.

Verification:

- `npm test -- --runTestsByPath test/claudeInteractivePty.test.ts`
- `npm run typecheck`

### Phase 6: Interactive Adapter

1. Wire adapter to session manager, PTY controller, tailer, and mapper.
2. Implement send/resume/new-session flows.
3. Implement abort and sendInput.
4. Implement goal methods.
5. Delegate one-shot methods.
6. Implement shutdown/session reset cleanup.

Verification:

- `npm test -- --runTestsByPath test/claudeCodeInteractiveBackend.test.ts test/chat.streaming.test.ts test/chat.websocket.test.ts test/chat.rest.test.ts`

### Phase 7: Memory, MCP, And Workspace Features

1. Verify MCP config passthrough in adapter tests.
2. Verify memory watcher path reuse.
3. Verify workspace instruction pointer behavior does not need provider-specific changes.
4. Verify KB/Context Map one-shot delegation stays on reliable path.

Verification:

- `npm test -- --runTestsByPath test/memoryMcp.test.ts test/chat.memory.test.ts test/contextMap.service.test.ts`

### Phase 8: Specs, ADR, And Full Verification

1. Complete ADR.
2. Update specs.
3. Run full checks.

Required verification:

```bash
npm run typecheck
npm run web:typecheck
npm run web:build
npm run web:budget
npm run mobile:typecheck
npm run maintainability:check
npm run spec:drift
npm run mobile:build
npm test
npm run adr:lint
```

## Acceptance Criteria

The work is complete only when all are true:

- `GET /api/chat/backends` exposes both `claude-code` and `claude-code-interactive`.
- Existing `claude-code` tests and behavior remain unchanged.
- A conversation can be created with `backend: 'claude-code-interactive'`.
- Claude Code profiles are reused by the interactive backend without duplicate auth.
- Interactive backend starts `claude` without `-p` inside a hidden PTY.
- Chat output is derived from transcript JSONL, not terminal escape output.
- Text, thinking, tools, tool outcomes, Agent, AskUserQuestion, usage, goal status, stop, and resume are mapped to existing UI events.
- Stop sends Esc and escalates only after timeout.
- AskUserQuestion can be answered through the existing Agent Cockpit UI input path.
- MCP Memory tools are injected in interactive sessions.
- Native Claude memory capture/watching works with the selected profile/config dir.
- Installed Claude CLI compatibility is checked for `claude-code-interactive`.
- Newer-than-tested CLI versions show a warning before or during use.
- CLI update UI cautions that updating the shared Claude CLI can affect the interactive provider.
- One-shot workloads remain reliable and documented.
- Specs and ADR are updated.
- Required verification commands pass.

## Rollback Plan

If the adapter is unstable:

1. Keep code paths behind provider selection. Existing `claude-code` remains default.
2. Disable `claude-code-interactive` registration or mark metadata unavailable with a compatibility error.
3. Leave transcript/PTY modules covered by tests for future work.
4. Do not remove shared profile migrations unless they break existing providers.
5. Keep the CLI update warning fields backward-compatible and optional.

## Known Risks

- Claude Code transcript JSONL is private API.
- Claude Code terminal UI can change between CLI releases.
- `node-pty` may add native dependency friction to install/release packaging.
- Interactive transcript flush latency may be worse than stream-json.
- Prompt submission may be brittle for long wrapped input.
- Slash commands may require extra Enter or screen-state heuristics.
- AskUserQuestion free-form answers may not map cleanly to terminal UI.
- Stop-turn completion may require inference when no explicit abort event is emitted.
- Shared Claude CLI updates can improve `claude-code` while breaking `claude-code-interactive`.
- Dedicated `CLAUDE_CONFIG_DIR` auth flows for account profiles need manual validation.

## Non-Goals For First Implementation

- No Claude Remote Control.
- No user-facing embedded terminal.
- No replacement of existing `claude-code`.
- No forced migration of existing conversations.
- No hidden-PTY one-shot path unless explicitly added after streaming stability.
- No automatic Claude CLI downgrade or pinning by Agent Cockpit.
- No update blocking for the shared Claude CLI unless product explicitly chooses to block.
