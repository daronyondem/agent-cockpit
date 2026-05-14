---
id: 0058
title: Support Claude Code Interactive through transcript watched PTY
status: Proposed
date: 2026-05-13
supersedes: []
superseded-by: null
tags:
  - claude-code
  - backend
  - streaming
  - cli-profiles
  - frontend
  - mobile-pwa
affects:
  - src/services/backends/claudeCodeInteractive.ts
  - src/services/backends/claudeInteractiveHooks.ts
  - src/services/backends/claudeInteractivePty.ts
  - src/services/backends/claudeInteractiveTerminal.ts
  - src/services/backends/claudeTranscriptTailer.ts
  - src/services/backends/claudeTranscriptEvents.ts
  - src/services/backends/claudeInteractiveCompatibility.ts
  - test/claudeCodeInteractive.e2e.test.ts
  - src/services/cliProfiles.ts
  - src/services/cliUpdateService.ts
  - web/AgentCockpitWeb/src/shell.jsx
  - web/AgentCockpitWeb/src/screens/settingsScreen.jsx
  - mobile/AgentCockpitPWA/src/App.tsx
  - package.json
  - docs/spec-backend-services.md
  - docs/spec-api-endpoints.md
  - docs/spec-data-models.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
  - docs/spec-testing.md
  - docs/design-claude-code-interactive-hardening-plan.md
---

## Context

Agent Cockpit already supports Claude Code through the `claude-code` backend, which runs `claude --print/-p --output-format stream-json` and consumes a structured stdout stream. That path is stable for automation and one-shot jobs, but it spends the CLI's non-interactive/API-style bucket rather than the user's Claude Code interactive subscription behavior.

Research showed that `claude` without `-p` is only true interactive Claude Code when attached to a PTY. Plain pipes either do not provide the interactive terminal UI or collapse back toward a headless invocation. Remote Control is not acceptable for this provider, and a user-facing embedded terminal is not part of the product surface. The remaining viable path is a hidden backend PTY controlled by Agent Cockpit, with structured events reconstructed from Claude Code's local transcript JSONL files.

The runtime must remain distinct from `claude-code` so Agent Cockpit can isolate the compatibility risk, but the user-facing choice belongs on the Claude Code CLI profile. It must reuse Claude Code CLI profiles, auth, config directories, plan usage, and update targets because both protocols share the same physical `claude` binary and credentials.

## Decision

Agent Cockpit adds `claude-code-interactive` as a separate internal backend labeled **Claude Code Interactive**.

The backend starts a hidden local PTY with `node-pty`, launches `claude` in interactive mode without `-p`, sends prompts and interaction answers through the PTY, and derives all user-visible stream events from Claude Code transcript JSONL under the selected Claude config project's `projects/<sanitized-workspace>/<sessionId>.jsonl`. Terminal escape output is control-only and is not rendered or parsed as the chat stream. The PTY controller answers common Claude/Ink terminal startup queries, uses a rolling stripped-terminal buffer for workspace trust prompts, and uses optional Claude Code `SessionStart`/`Stop` hooks to gate prompt submission, discover exact transcript paths, and finalize Stop-before-transcript-flush races. A narrow `PreToolUse` hook for `AskUserQuestion` is allowed as a live fallback when the interactive question transcript line exists only after the user-facing prompt is already waiting.

`claude-code-interactive` maps to the physical Claude Code CLI vendor for profiles. Claude Code profiles carry `protocol: "standard" | "interactive"`; `standard` resolves to `claude-code`, and `interactive` resolves to `claude-code-interactive`. Conversations still store the resolved backend id for compatibility and transcript rendering, but users choose the protocol while creating or editing the CLI profile instead of choosing a separate provider/backend in the composer. One-shot jobs, title generation, summaries, Memory, KB digestion/dreaming, and Context Map work keep using the existing Claude Code `runOneShot()` implementation when invoked through the interactive adapter.

The shared Claude CLI update status includes `interactiveCompatibility` for `claude-code-interactive`, comparing the installed CLI version to the adapter's tested version. UI update surfaces warn when the installed version, or the available update, is newer than the tested interactive version. The warning does not block standard Claude Code updates.

## Alternatives Considered

- **Use Claude Remote Control**: rejected because the provider is explicitly not allowed to depend on Remote Control.
- **Expose an embedded terminal**: rejected because Agent Cockpit should keep its chat UI and structured event model; a terminal UI would be a different product surface and would not provide parity with existing messages, tool cards, usage, goals, or mobile.
- **Run `claude` without PTY over pipes**: rejected because it is not reliable true interactive Claude Code; it can behave like headless mode and does not escape the bucket this provider is meant to use.
- **Expose a separate provider/backend picker in the composer**: rejected because it splits one runtime decision across two surfaces: CLI profile selection plus provider selection. Profile-level Protocol keeps the choice next to the shared Claude CLI auth/config state and removes the mismatch class where a Claude profile is selected with an incompatible backend.
- **Fold this into `claude-code` without a separate internal backend**: rejected because the interactive path depends on private transcript and terminal behavior with a different compatibility risk profile. Agent Cockpit needs a distinct internal backend id for compatibility warnings, persisted conversation behavior, and adapter isolation.
- **Automatically duplicate Claude profiles as interactive profiles**: rejected because both protocols share one physical CLI binary, auth state, and config directories. Users can create separate Claude profiles when they want different names or config dirs, but the system should not duplicate auth identities just to expose the protocol.

## Consequences

- + Users can explicitly choose Claude Code Interactive from the Claude profile's Protocol field while keeping all existing Claude Code behavior intact.
- + Claude Code Interactive shares Claude profiles, auth, plan usage, and server-configured defaults without requiring duplicate sign-in or a second composer picker.
- + The chat UI continues to render structured text, thinking, tools, tool outcomes, agent relationships, user questions, usage, and transcript goal state rather than terminal frames.
- + Compatibility warnings make the shared CLI update risk visible without preventing users from updating the standard Claude Code CLI.
- - The provider depends on private Claude Code transcript JSONL shape and terminal UI behavior, so it can break when the Claude CLI changes.
- - `node-pty` adds a native production dependency and may increase install/package friction.
- - Active-turn resume after server restart remains unsupported because Agent Cockpit cannot reattach to a running terminal UI it no longer owns.
- ~ Background one-shot workloads remain on the existing Claude Code headless path; this is deliberate reliability preservation rather than full interactive-bucket migration.

## References

- [Backend services spec](../spec-backend-services.md)
- [Frontend spec](../spec-frontend.md)
- [Mobile PWA spec](../spec-mobile-pwa.md)
- [Claude Code Interactive research report](../research-claude-code-interactive-report.md)
- [Claude Code Interactive implementation plan](../design-claude-code-interactive-implementation-plan.md)
- [Claude Code Interactive hardening plan](../design-claude-code-interactive-hardening-plan.md)
- ADR-0015: Separate CLI profiles from backend vendors
- ADR-0018: Route stream lifecycle through supervisor
- ADR-0019: Record backend stream resume capability matrix
- ADR-0027: Manage CLI updates from web cockpit
