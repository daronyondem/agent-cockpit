---
id: 0093
title: Add GitHub Copilot CLI backend
status: Superseded
date: 2026-06-17
supersedes: []
superseded-by: 0094
tags: [cli-profiles, backends, copilot]
affects:
  - src/types/cliProfiles.ts
  - src/contracts/responses.ts
  - src/services/cliProfiles.ts
  - src/services/cliCommandResolver.ts
  - src/services/cliProfileAuthService.ts
  - src/services/settingsService.ts
  - src/services/cliUpdateService.ts
  - src/services/chat/workspaceInstructionStore.ts
  - src/services/backends/copilot.ts
  - server.ts
  - web/AgentCockpitWeb/src/screens/settingsScreen.jsx
  - test/copilotBackend.test.ts
  - test/cliUpdateService.test.ts
  - test/settingsService.test.ts
  - test/mobileAppModel.test.ts
  - README.md
  - BACKENDS.md
  - docs/user/backends.md
  - docs/reference/backend-capabilities.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
---

## Context

GitHub shipped an agentic GitHub Copilot CLI (`copilot`, npm `@github/copilot`)
that edits files, runs shell commands, and searches a codebase. It is a
command-line AI agent in the same class Agent Cockpit already wraps, and users
with a Copilot subscription want to drive it from the cockpit the same way they
drive Claude Code, Codex, Kiro, and OpenCode.

The Copilot CLI exposes a non-interactive scripting mode
(`copilot -p <prompt> --output-format json`) that emits newline-delimited JSON
lifecycle events (`assistant.message_delta`, `assistant.reasoning_delta`,
`tool.execution_start`, `tool.execution_complete`, and a terminal `result` event
carrying the session id and usage). It also supports `--resume <sessionId>`,
`--model`, `--reasoning-effort`, `--attachment`, and `--additional-mcp-config`.
This shape matches the existing OpenCode integration (CLI spawned per message
with JSON output and session resume) far more closely than the persistent
JSON-RPC servers used by Kiro and Codex.

Copilot authentication is an interactive device/browser login stored under
`~/.copilot`, and the CLI has no machine-readable model listing. Its usage
reporting is credits-style: a terminal `premiumRequests` count plus per-message
output tokens, with no input-token count and no per-turn USD cost.

## Decision

Add `copilot` as a new `CliHarness` and register a `CopilotAdapter`
(`src/services/backends/copilot.ts`) modeled on `OpenCodeAdapter`:

- **Transport:** spawn `copilot -p <prompt> --output-format json --no-ask-user`
  per message and translate the JSON event stream into cockpit stream frames.
  Use `--allow-all` for the chat/tool path (matching the cockpit's local
  full-execution model) and `--allow-all-tools` for the no-tool one-shot path.
- **Auth:** self-configured/server-configured only. Agent Cockpit reuses the
  shared `copilot` login under `~/.copilot`, checks availability with
  `copilot --version`, and never isolates `configDir`/`env` — the same posture
  as OpenCode and Kiro.
- **Models:** ship a curated catalog of Copilot's published Claude and GPT model
  identifiers, each advertising effort levels `low|medium|high|xhigh` and
  text+image input, because the CLI exposes no listing.
- **Sessions:** persist Copilot session ids through `external_session` and resume
  later turns with `--resume`, including the standard missing-native-session
  recovery flow.
- **Usage:** report assistant output tokens plus premium-request credits with
  `costSource: 'none'`; `providerForBackend` returns `null` for `copilot`, so the
  pricing estimator reports no USD cost.
- **UI:** present Copilot as a server-configured harness in the Settings CLI
  Profiles tab (like Kiro/OpenCode) with a **Check GitHub Copilot** button; the
  mobile PWA renders it through backend metadata with no Copilot-specific code.

## Alternatives Considered

- **Use Copilot's ACP server mode (`copilot --acp`) like Kiro.** Rejected for the
  first implementation because the non-interactive JSON path is stateless per
  turn (matching OpenCode), avoids owning a persistent JSON-RPC process
  lifecycle, and is sufficient for streaming text, thinking, tool activity, and
  session resume. ACP can be revisited if subagents or active-turn resume are
  required.
- **Drive Copilot login from the Welcome/account setup flow (like Claude/Codex
  account profiles).** Rejected because Copilot login is an interactive
  device/browser flow best completed by the user in a terminal, and reusing the
  shared `~/.copilot` login keeps terminal and cockpit in sync with no extra
  isolation surface.
- **Discover models dynamically.** Rejected because the CLI has no
  machine-readable model listing; a curated catalog keyed to `copilot help
  config` is the only reliable source today.
- **Surface premium requests as priced credits like Kiro.** Rejected because
  Copilot publishes no public usd-per-credit rate; reporting `costSource: 'none'`
  is the honest representation.

## Consequences

- + GitHub Copilot becomes a first-class backend with streaming text, visible
  thinking, tool activity/outcomes, image/PDF attachments, MCP injection, and
  session resume, selectable per conversation like every other harness.
- + The adapter reuses the OpenCode-shaped pattern (runtime resolver, curated
  metadata, JSONL translation, session recovery), so it slots into existing
  auth/update/settings/web/mobile wiring with minimal new surface.
- - No per-turn USD cost and only partial token usage (output tokens) are
    available, so cost dashboards stay empty for Copilot turns.
- - The curated model catalog must be updated by hand as Copilot adds or retires
    models.
- ~ Subagents, plan mode, goal mode, mid-turn input, and interactive user
    questions are not exposed in this pass; `--no-ask-user` keeps non-interactive
    turns from blocking, and `--allow-all` grants full local execution consistent
    with the cockpit's local-first model.

## References

- [ADR-0076](0076-add-opencode-cli-profiles.md) — the OpenCode CLI-profile
  pattern this backend follows.
- [ADR-0079](0079-use-harness-for-cli-profile-runtime-identity.md) — `harness` as
  the canonical CLI profile runtime identity.
- `docs/spec-backend-services.md` — CopilotAdapter specification and resume
  matrix.
- `BACKENDS.md`, `docs/reference/backend-capabilities.md`, `docs/user/backends.md`
  — user-facing capability documentation.
