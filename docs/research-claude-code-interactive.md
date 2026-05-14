# Claude Code Interactive Research Brief

Research whether Agent Cockpit can add a new backend named **Claude Code Interactive** with full parity to the existing Claude Code backend.

Do not implement production changes yet. This is a research and spike task.

## Context

Agent Cockpit currently supports:

- `claude-code`: Claude Code headless mode using `claude --print/-p --output-format stream-json`
- `codex`
- `kiro`

The proposed new backend is:

- backend id: `claude-code-interactive`
- display name: `Claude Code Interactive`

Goal: determine whether it can reach full parity with current `claude-code`, while using true interactive Claude Code instead of `claude -p`.

Billing and credit behavior are not the focus of this research.

## Constraints

- Do not replace the existing Claude Code backend.
- Do not use Claude Remote Control.
- Do not build a user-facing embedded terminal.
- Treat transcript watching as uncertain/private API until proven.
- Full parity is required; do not scope this as a reduced terminal mode.
- Keep `claude-code-interactive` as a separate backend/provider, not a mode flag hidden inside `claude-code`.

## Existing Claude Code Parity Surface

Research whether Claude Code Interactive can support all of this:

1. Streaming assistant text into Agent Cockpit messages.
2. Thinking output.
3. Tool activity cards.
4. Tool result/outcome cards.
5. Subagent/Agent tool progress.
6. AskUserQuestion cards and user response flow.
7. Plan mode events/cards if emitted.
8. Usage events: input/output/cache tokens and cost if available.
9. Turn completion / turn boundary detection.
10. Error detection and terminal failure reporting.
11. Stop Turn / abort.
12. Session creation with stable session id.
13. Session resume across turns.
14. Active-turn process supervision.
15. Model selection.
16. Effort selection.
17. Permission behavior equivalent to current `bypassPermissions` behavior where possible.
18. MCP server injection, especially Agent Cockpit Memory MCP.
19. Native Claude memory capture from Claude project memory files.
20. Real-time memory watching.
21. Goal mode: `/goal`, `/goal clear`, transcript-derived status, supported action parity.
22. One-shot equivalent for title generation, summaries, OCR, Memory MCP, KB digestion/dreaming, and Context Map.
23. CLI profile support: command override, env override, `CLAUDE_CONFIG_DIR`, profile-specific auth/config/session isolation.
24. Plan usage tooltip impact, only as a note; do not make billing the focus.

## Research Questions

1. Can an interactive `claude` process be controlled programmatically without `-p` and without Remote Control?
2. If input requires a PTY, can we run a hidden backend PTY while still preserving structured events, or is that effectively disallowed terminal embedding?
3. Does interactive Claude write enough structured JSONL transcript data in real time to reconstruct assistant text, thinking, tool calls, tool results, user questions, plan mode, usage, errors, and turn completion?
4. How quickly and reliably are transcript files flushed during an active turn?
5. Can transcript watching distinguish current-turn events from prior session history?
6. Can we detect completion without scraping terminal UI?
7. Can we safely stop an active turn?
8. Can we send follow-up user input after a turn completes?
9. Can we send input while Claude is waiting for AskUserQuestion or permission-like interaction?
10. Can MCP config be injected into interactive sessions with the same config JSON we pass today?
11. Can current `--session-id`, `--resume`, `--model`, `--effort`, `--permission-mode`, `--append-system-prompt`, and `--mcp-config` flags be used without `-p`?
12. Are usage/cost fields available anywhere outside `-p --output-format stream-json`?
13. Can one-shot workloads be served by Claude Code Interactive, or should they continue using `claude-code`/SDK/headless paths?

## Experiments To Run

Use a disposable workspace and dedicated `CLAUDE_CONFIG_DIR`.

1. Start `claude --session-id <uuid>` without `-p`; inspect process behavior.
2. Try feeding stdin without a PTY; record whether Claude accepts prompts.
3. Try a hidden PTY prototype if needed; record whether it violates the no-terminal-embedding constraint.
4. Run a prompt that produces plain text only; inspect transcript writes.
5. Run a prompt that uses `Read`, `Edit`, `Bash`, `TodoWrite`, `Agent`, and `AskUserQuestion`; inspect transcript detail.
6. Run with `--mcp-config` pointing at the Agent Cockpit Memory MCP stub; verify `memory_search` and `memory_note`.
7. Run with `--model` and `--effort`; verify model selection is reflected.
8. Run `/goal <objective>` and `/goal clear`; verify transcript status.
9. Kill/stop the process mid-turn; inspect transcript and process cleanup behavior.
10. Resume the same session with `--resume <session-id>`; verify continuity.
11. Compare transcript output against current `claude -p --output-format stream-json` for the same prompts.
12. Record all gaps that prevent full parity.

## Deliverables

Produce a research report with:

1. Verdict: viable / not viable / viable only with unacceptable constraints.
2. Recommended architecture if viable.
3. Event mapping from interactive transcript/process behavior to Agent Cockpit `StreamEvent`.
4. Parity matrix against current `claude-code`.
5. Risks and private API dependencies.
6. Required code modules and test files if implementation proceeds.
7. Specific blockers that must be resolved before building.
8. Recommendation on whether `claude-code-interactive` should proceed to implementation.

## Success Criteria

Research is complete only when we can answer:

Can `claude-code-interactive` reach full parity with `claude-code` without Remote Control and without a user-facing embedded terminal?

If yes, provide a concrete implementation plan. If no, identify the exact blocker.
