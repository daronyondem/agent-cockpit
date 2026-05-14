# Claude Code Interactive Hardening Plan

Status: Proposed
Date: 2026-05-14

## Objective

Harden the existing Claude Code Interactive implementation by borrowing the parts of `smithersai/claude-p` that fit Agent Cockpit's architecture:

- terminal capability query responses,
- hook-driven readiness/completion,
- hook-derived transcript path handling,
- transcript finalization retry/backoff,
- safer prompt submission timing,
- stronger trust/question terminal detection,
- optional real-Claude integration coverage.

Do not replace the current adapter with `claude-p`, do not introduce a user-facing terminal, do not use Claude Remote Control, and do not migrate background one-shot jobs away from the existing Claude Code headless path.

## Current Baseline

The current branch already contains the first Claude Code Interactive slice:

- `src/services/backends/claudeCodeInteractive.ts`
  - registers backend id `claude-code-interactive`;
  - starts a hidden `node-pty` process;
  - sends prompts through the PTY;
  - tails transcript JSONL files;
  - maps transcript entries into existing `StreamEvent` frames;
  - delegates one-shot/title/summary/memory work to `ClaudeCodeAdapter`.
- `src/services/backends/claudeInteractivePty.ts`
  - owns the PTY process;
  - uses bracketed paste for prompt submission;
  - auto-confirms workspace trust prompts;
  - repairs `node-pty` `spawn-helper` executable bits on Unix-like platforms.
- `src/services/backends/claudeTranscriptTailer.ts`
  - resolves likely transcript paths from workspace + Claude config dir + session id;
  - tails JSONL incrementally;
  - dedupes UUIDs.
- `src/services/backends/claudeTranscriptEvents.ts`
  - maps assistant/user/system transcript rows to text, thinking, tool, usage, turn boundary, done, and goal events.
- `src/services/backends/claudeInteractiveCompatibility.ts`
  - tracks the tested Claude Code CLI version and returns compatibility warnings.

The hardening work below assumes that baseline remains intact.

## Lessons Worth Applying From `claude-p`

`claude-p` is useful as a reference implementation, not as a direct dependency. Its strongest lessons are:

1. Interactive Claude Code can hang at startup unless the PTY answers common DEC/XTerm capability queries.
2. Claude Code hooks provide a better lifecycle signal than screen scraping.
3. `SessionStart` is a better prompt-submission readiness signal than "PTY process spawned".
4. `Stop` is a better turn-completion signal than "process exited" or "terminal went quiet".
5. `Stop` can fire before the transcript has fully flushed, so final transcript reads need retry/backoff.
6. `Stop` payloads can carry `transcript_path` and sometimes `last_assistant_message`, which are useful fallback data.
7. Trust prompt detection should use a rolling stripped-terminal buffer because prompts can be split across PTY chunks.
8. Prompt text and Enter should be separated when the terminal UI is still settling.

The parts that should not be copied for now:

- using the `claude-p` binary as an Agent Cockpit backend;
- replacing `node-pty` with Zig/`zmux`;
- shell-command composition for Claude invocation;
- transcript replay after Stop as the only stream source;
- single-turn teardown semantics.

Agent Cockpit needs long-running conversation parity and live-ish transcript-derived events, so the current Node adapter remains the right foundation.

## Implementation Phases

### Phase 1: Terminal Query Responder

Goal: make interactive Claude startup less fragile by answering the same class of terminal queries that `claude-p` handles.

Create:

- `src/services/backends/claudeInteractiveTerminal.ts`

Responsibilities:

- Export a pure scanner:

```ts
export interface ClaudeTerminalQueryOptions {
  rows?: number;
  cols?: number;
  terminalName?: string;
}

export function collectClaudeTerminalResponses(
  data: string | Buffer,
  options?: ClaudeTerminalQueryOptions,
): string[];
```

- Recognize CSI terminal queries inside arbitrary PTY chunks.
- Return zero or more response strings that the PTY controller can write back.
- Do not mutate controller state in the parser.
- Do not log raw terminal data.

Initial supported queries:

| Query | Meaning | Response |
|-------|---------|----------|
| `ESC [ c` / `ESC [ 0 c` | DA1 primary device attributes | `ESC [ ? 1 ; 2 c` |
| `ESC [ > c` / `ESC [ > 0 c` | DA2 secondary device attributes | `ESC [ > 0 ; 0 ; 0 c` |
| `ESC [ 6 n` | DSR cursor position | `ESC [ 1 ; 1 R` |
| `ESC [ > q` / `ESC [ > 0 q` | XTVERSION | `ESC P > \| AgentCockpit ST` |
| `ESC [ 18 t` | text-area window size | `ESC [ 8 ; <rows> ; <cols> t` |

Use the PTY controller's configured rows/cols for `18t`; default remains `40 x 120`.

Update:

- `src/services/backends/claudeInteractivePty.ts`

Changes:

- In `_handleData`, call `collectClaudeTerminalResponses(data, { rows, cols })`.
- Queue the response writes, then flush them outside the scanner path.
- Keep trust prompt detection separate from query response detection.
- Add a small write guard so terminal responses are not attempted after exit/kill.

Recommended controller shape:

```ts
private _pendingControlWrites: Array<string | Buffer> = [];

private _queueControlWrite(data: string | Buffer): void {
  this._pendingControlWrites.push(data);
  queueMicrotask(() => this._flushControlWrites());
}
```

Why queue writes: the current Node implementation can probably write from `onData`, but queueing keeps PTY control output separated from data parsing and avoids reentrancy problems if `node-pty` behavior changes.

Tests:

- Unit-test the parser directly:
  - each supported query returns the expected response;
  - multiple queries in one chunk return multiple responses in order;
  - normal text returns no responses;
  - partial/incomplete escape sequences return no response and do not throw.
- Controller test:
  - fake PTY emits `ESC [ c`;
  - controller writes `ESC [ ? 1 ; 2 c`;
  - trust prompt auto-confirm still writes Enter and is not confused with terminal responses.

### Phase 2: Hook Harness

Goal: use Claude Code hooks for lifecycle events while preserving the hidden PTY + transcript streaming architecture.

Create:

- `src/services/backends/claudeInteractiveHooks.ts`

Responsibilities:

- Create a per-turn temp directory under `os.tmpdir()`.
- Create a relay script that Claude hook commands execute.
- Create a hook event sink readable by the Node process.
- Build inline Claude settings JSON for `--settings`.
- Parse hook event lines.
- Expose cleanup.

Proposed API:

```ts
export type ClaudeInteractiveHookEventName = 'SessionStart' | 'Stop' | 'unknown';

export interface ClaudeInteractiveHookEvent {
  event: ClaudeInteractiveHookEventName;
  payload: Record<string, unknown>;
  rawPayload: string;
}

export interface ClaudeInteractiveHookHarness {
  settingsJson: string;
  env: NodeJS.ProcessEnv;
  events: AsyncIterable<ClaudeInteractiveHookEvent>;
  waitForSessionStart(timeoutMs: number): Promise<ClaudeInteractiveHookEvent>;
  waitForStop(timeoutMs: number): Promise<ClaudeInteractiveHookEvent>;
  close(): Promise<void>;
}

export async function createClaudeInteractiveHookHarness(): Promise<ClaudeInteractiveHookHarness>;
```

Unix implementation:

- Use `mkfifo` where available, or use a temp file append loop if a FIFO is too fragile in packaged Electron/server environments.
- If using a FIFO, open the read side before spawning Claude so hook writes cannot block forever.
- Relay script:
  - executable `0700`;
  - reads hook JSON payload from stdin;
  - appends one line as `<event>\t<payload-json>`;
  - uses an Agent Cockpit-specific env var, for example `AGENT_COCKPIT_CLAUDE_HOOK_SINK`.

Cross-platform note:

- This repo primarily targets local macOS/Linux usage, but the implementation should not silently break Windows.
- If FIFO creation is Unix-only, gate hook harness support by platform and provide a fallback path that keeps the existing transcript-polling behavior.
- Surface a compatibility warning in logs, not the UI, when hooks are disabled by platform.

Inline settings JSON:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "<script> SessionStart" }]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "<script> Stop" }]
      }
    ]
  }
}
```

Update:

- `src/services/backends/claudeCodeInteractive.ts`
- `buildInteractiveClaudeArgs(...)`

Changes:

- Create a hook harness before spawning the PTY.
- Append `--settings <settingsJson>` to Claude args.
- Merge hook harness env vars into the PTY env.
- Ensure hook cleanup runs in `finally`.
- Preserve existing behavior if hook harness creation fails only when explicitly configured as optional.

Tests:

- Settings JSON contains `SessionStart` and `Stop`.
- Relay script path is shell-quoted or otherwise safe for spaces.
- Hook parser accepts valid `<event>\t<json>` lines.
- Hook parser ignores malformed lines without throwing.
- Cleanup removes temp files.
- Adapter args include `--settings` when hooks are enabled.

### Phase 3: Readiness-Gated Prompt Submission

Goal: stop sending prompt text immediately after PTY spawn.

Current behavior:

```ts
controller.start();
controller.sendPrompt(message);
```

New behavior:

1. Start PTY.
2. Wait for `SessionStart` hook up to a short timeout.
3. If `SessionStart` fires, submit the prompt.
4. If it times out, fall back to current behavior but emit a diagnostic log.

Recommended defaults:

- `sessionStartTimeoutMs`: `10_000`
- `promptEnterDelayMs`: `100` to `150`
- `hookOptional`: true for the first hardening slice, so unsupported hook behavior does not completely block the provider.

Update:

- `src/services/backends/claudeInteractivePty.ts`

Change `sendPrompt(prompt)` to submit in two writes:

```ts
sendPrompt(prompt: string, options?: { enterDelayMs?: number }): void {
  this.write(formatBracketedPaste(prompt));
  setTimeout(() => this.write('\r'), options?.enterDelayMs ?? 120);
}
```

Preserve bracketed paste unless real-Claude testing proves it harms interactive Claude. The delayed Enter is the important part.

Adapter behavior:

- Do not yield `done` while waiting for SessionStart.
- If abort is requested before prompt submission, send Esc after controller starts and skip prompt submission.
- Flush queued user inputs only after the prompt has been submitted.

Tests:

- Prompt is not written before a fake `SessionStart`.
- Prompt body and Enter are separate writes.
- Timeout fallback submits the prompt once.
- Abort before readiness does not submit prompt text.

### Phase 4: Stop-Hook Completion And Transcript Path

Goal: use `Stop` as a completion signal without losing live transcript streaming.

Current behavior:

- Poll transcript until a mapped transcript entry emits `done`.
- If the PTY exits, flush the tailer.
- Then request `/exit` or kill.

New behavior:

- Continue live transcript polling during the turn.
- In parallel, listen for `Stop`.
- Treat `Stop` as "Claude says the turn ended".
- Use `Stop.payload.transcript_path` to pin the tailer to the exact transcript when present.
- After `Stop`, run a finalization loop before yielding `done`.

Update:

- `src/services/backends/claudeTranscriptTailer.ts`

Add:

```ts
setTranscriptPath(path: string): void;
readUntilQuiet(options: {
  maxAttempts: number;
  intervalMs: number;
}): Promise<ClaudeTranscriptEntry[]>;
```

Behavior:

- `setTranscriptPath` switches `_activePath` if no active path exists.
- If an active inferred path exists and the hook path differs, prefer the hook path only if the inferred path has not emitted entries yet; otherwise log a warning and keep the active path.
- `readUntilQuiet` repeatedly calls `readAvailable()` until one or more reads return no entries after at least one retry, or the attempt limit is reached.

Update:

- `src/services/backends/claudeCodeInteractive.ts`

Finalization loop:

1. On `Stop`, read `transcript_path`.
2. Pin/update the tailer path.
3. Flush buffered line.
4. Retry `readAvailable()` for up to `40` attempts with `50ms` interval, or use a smaller default such as `20 x 50ms` if UI latency is a concern.
5. Map any final entries.
6. If no transcript `done` was emitted, yield a single `done`.
7. If transcript parsing yields no assistant text and `last_assistant_message` exists, emit a final text event only if no assistant text was emitted for the turn.

Fallback rules:

- Do not duplicate assistant text if transcript events already emitted text.
- Do not emit `last_assistant_message` if it conflicts with already emitted transcript text.
- Do not treat missing `last_assistant_message` as an error.
- If Stop never fires, current transcript `turn_duration` behavior remains a fallback.

Tests:

- Stop hook with `transcript_path` switches a tailer that has not found a file yet.
- Stop hook firing before final transcript line still emits the final text after retry.
- Stop hook with `last_assistant_message` emits fallback text when transcript stays empty.
- Stop hook fallback does not duplicate text already emitted from transcript.
- Transcript `turn_duration` still completes when hooks are disabled.

### Phase 5: Rolling Terminal Buffer For Trust And Menus

Goal: make terminal-output control detection robust without making terminal output a user-visible stream source.

Update:

- `src/services/backends/claudeInteractivePty.ts`

Add:

- rolling stripped-terminal buffer, max about `8_000` chars;
- helper:

```ts
private _appendTerminalText(data: string): string;
```

Behavior:

- Strip ANSI before appending.
- Collapse excessive whitespace.
- Keep only the trailing max length.
- Use this buffer for trust prompt detection.
- Keep the current rate limit for auto-confirm Enter.

Improve trust detection:

- Match split prompts such as:
  - `Do you trust the files in this folder?`
  - `Yes, I trust this folder`
  - `Trust the files in this folder`
- Only auto-confirm when the working directory equals the conversation workspace.
- Do not auto-confirm arbitrary permission prompts.

AskUserQuestion/menu note:

- Continue using transcript-derived `tool_activity.isQuestion` to know what options exist.
- Continue sending arrow-down + Enter for numbered/label answers.
- Do not parse arbitrary terminal menu text into question options unless transcript data is missing in real testing.

Tests:

- Split trust prompt across chunks still auto-confirms once.
- Repeated trust prompt chunks respect rate limit.
- Permission warning text that lacks workspace trust markers is not auto-confirmed.
- Question option answer still sends expected arrow sequence.

### Phase 6: Optional Real-Claude E2E Harness

Goal: catch integration drift that mocks cannot catch.

Add an opt-in test path:

- `test/claudeCodeInteractive.e2e.test.ts`

Run only when:

```bash
CLAUDE_INTERACTIVE_E2E=1 npm test -- test/claudeCodeInteractive.e2e.test.ts
```

Test setup:

- Require `claude` on `PATH`.
- Require existing Claude Code authentication in a temp or explicitly configured `CLAUDE_CONFIG_DIR`.
- Create a temp workspace.
- Create a temp Claude config dir unless using `CLAUDE_INTERACTIVE_E2E_CONFIG_DIR`.
- Start `ClaudeCodeInteractiveAdapter`.
- Send a tiny prompt such as `Reply with exactly: AC_INTERACTIVE_OK`.
- Assert:
  - backend runtime process id is emitted;
  - prompt is submitted after SessionStart when hooks are available;
  - transcript path is discovered;
  - text event contains `AC_INTERACTIVE_OK`;
  - done is emitted once;
  - no raw terminal frames are emitted.

Safety:

- Skip by default.
- Use a timeout around the whole test.
- Clean temp directories.
- Never run from CI unless a dedicated authenticated runner exists.

### Phase 7: Docs And Compatibility Notes

Update these docs after implementation:

- `docs/spec-backend-services.md`
  - Add terminal query responder behavior.
  - Add hook lifecycle behavior.
  - Explain Stop finalization and fallback.
- `docs/spec-testing.md`
  - Add the new unit tests and optional E2E test.
- `docs/adr/0058-support-claude-code-interactive-through-transcript-watched-pty.md`
  - Add references to hook lifecycle and terminal query responder if the implementation lands in the same PR.

No new ADR is required if this is shipped as a hardening of ADR-0058's chosen architecture. Write a new ADR only if the implementation:

- replaces `node-pty`,
- introduces a packaged helper binary,
- changes the public profile/protocol model,
- changes stream-resume guarantees,
- or makes hooks mandatory with no polling fallback.

## Acceptance Criteria

The implementation is complete when:

1. Claude Code Interactive still launches Claude through a hidden PTY without `-p`.
2. Terminal DA1, DA2, DSR cursor position, XTVERSION, and `18t` queries receive deterministic responses.
3. Prompt submission waits for `SessionStart` when hooks are available.
4. Prompt body and Enter are separate PTY writes.
5. `Stop` is consumed as the preferred completion signal.
6. Hook `transcript_path` is used when available.
7. Final transcript reads retry briefly after Stop.
8. `last_assistant_message` is only used as a non-duplicating fallback.
9. Trust prompt auto-confirmation survives split PTY chunks.
10. Existing transcript-derived streaming still emits text, thinking, tools, tool outcomes, usage, questions, goals, and done.
11. Standard Claude Code behavior is unchanged.
12. Claude Code Interactive one-shot/title/summary/memory/background jobs still delegate to standard Claude Code.
13. Unit tests cover terminal responses, hook parsing, prompt gating, Stop finalization, and trust buffering.
14. Optional real-Claude E2E test exists and is documented.
15. Specs are updated.

## Verification Commands

Run the focused tests first:

```bash
npm test -- test/claudeCodeInteractive.test.ts
```

Then run the broader required checks:

```bash
npm run typecheck
npm test
npm run web:typecheck
npm run web:build
npm run mobile:typecheck
npm run mobile:build
npm run maintainability:check
npm run spec:drift
npm run adr:lint
```

Optional real-Claude drift check:

```bash
CLAUDE_INTERACTIVE_E2E=1 npm test -- test/claudeCodeInteractive.e2e.test.ts
```

## Suggested Goal-System Prompt

```text
Implement the Claude Code Interactive hardening work described in docs/design-claude-code-interactive-hardening-plan.md. Keep the existing Claude Code Interactive architecture intact: hidden node-pty control channel, transcript-derived stream events, Claude profile protocol selection, and standard Claude Code delegation for one-shot/background work. Add terminal query responses, hook-driven SessionStart/Stop lifecycle support, hook-derived transcript path finalization, transcript flush retry/backoff, delayed Enter prompt submission, rolling trust-prompt detection, focused unit tests, optional real-Claude E2E coverage, and spec updates. Do not introduce a user-facing terminal, Remote Control, claude-p as a runtime dependency, Zig/zmux packaging, or composer backend/protocol pickers. After implementation, review the work for high/medium impact issues, fix them, and repeat that review/fix loop ten times or until no high/medium issues remain. Run the verification commands listed in the plan and report any command that cannot be run.
```
