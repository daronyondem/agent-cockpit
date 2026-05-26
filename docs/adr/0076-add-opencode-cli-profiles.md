---
id: 0076
title: Add OpenCode CLI profiles
status: Proposed
date: 2026-05-24
supersedes: []
superseded-by: null
tags: [cli-profiles, backends, opencode]
affects:
  - src/types/index.ts
  - src/contracts/chat.ts
  - src/contracts/responses.ts
  - src/services/cliProfiles.ts
  - src/services/backends/base.ts
  - src/services/backends/claudeCode.ts
  - src/services/backends/codex.ts
  - src/services/backends/kiro.ts
  - src/services/backends/mediaCapabilities.ts
  - src/services/backends/opencode.ts
  - src/services/cliCommandResolver.ts
  - src/services/cliProfileAuthService.ts
  - src/services/settingsService.ts
  - src/services/cliUpdateService.ts
  - src/services/chat/workspaceInstructionStore.ts
  - src/services/knowledgeBase/ingestion.ts
  - src/services/knowledgeBase/ingestion/pageConversion.ts
  - src/routes/chat/cliProfileRoutes.ts
  - src/routes/chat/uploadRoutes.ts
  - server.ts
  - web/AgentCockpitWeb/src/api.js
  - web/AgentCockpitWeb/src/app.css
  - web/AgentCockpitWeb/src/screens/settingsScreen.jsx
  - web/AgentCockpitWeb/src/shell.jsx
  - web/AgentCockpitWeb/src/shellState.jsx
  - mobile/AgentCockpitPWA/src/App.tsx
  - mobile/AgentCockpitPWA/src/styles.css
  - mobile/AgentCockpitPWA/src/types.ts
  - public/icons/deepseek-logo.svg
  - public/icons/opencode-logo-dark.svg
  - public/icons/opencode-logo-light.svg
  - test/backends.test.ts
  - test/chat.cliProfileAuth.test.ts
  - test/chat.rest.test.ts
  - test/cliUpdateService.test.ts
  - test/codexBackend.test.ts
  - test/settingsService.test.ts
  - test/frontendRoutes.test.ts
  - test/helpers/mockBackendAdapter.ts
  - test/kiroBackend.test.ts
  - test/knowledgeBase.handlers.test.ts
  - test/knowledgeBase.pageConversion.test.ts
  - test/mediaCapabilities.test.ts
  - test/opencodeBackend.test.ts
  - docs/spec-api-endpoints.md
  - docs/spec-data-models.md
  - docs/spec-backend-services.md
  - docs/spec-server-security.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
  - docs/spec-testing.md
  - docs/spec-coverage.md
  - BACKENDS.md
  - CLI_PROFILES_MULTI_ACCOUNT_PLAN.md
---

## Context

Agent Cockpit's CLI profile model treats a local harness as the runnable CLI.
Before this decision, the supported harnesses were Codex, Claude Code, and Kiro.
Users also want to use DeepSeek, Groq, xAI/Grok, Gemini, OpenRouter, and other
model APIs through OpenCode without turning each API provider into a separate
Cockpit CLI harness.

OpenCode already owns provider authentication and model routing. Its CLI exposes
`opencode models <provider> --verbose` for discovery with provider effort
variants, `opencode run --format json` for machine-readable non-interactive
turns, `--model provider/model` for explicit model selection, `--variant` for
supported effort variants, `--session` for later-turn continuity, and JSON
config/MCP overrides via `OPENCODE_CONFIG_CONTENT`.

## Decision

Agent Cockpit adds `opencode` as a physical `CliHarness` and backend adapter.
DeepSeek, Groq, xAI/Grok, Gemini, and similar APIs remain OpenCode
provider/model choices. The CLI profile stores the provider as optional
`opencode.provider`; model selection stays in the chat composer or
feature-specific processor model selectors. Providers do not become top-level
Cockpit CLI harnesses.

The first implementation supports self-configured OpenCode profiles. Cockpit
launches the selected OpenCode CLI, discovers providers/models through OpenCode,
passes the selected composer/processor model and supported effort variant to
`opencode run`, requests visible thinking with `--thinking`, maps OpenCode JSON
`reasoning` and `tool_use` parts into Cockpit thinking and tool
activity/outcome events, and persists OpenCode session ids through the existing
`external_session` mechanism. Provider credentials remain managed by OpenCode's
own auth/config stores. Settings can run draft OpenCode metadata/status checks
without saving the draft profile first.

Cockpit injects conversation-scoped MCP servers through per-process
`OPENCODE_CONFIG_CONTENT` instead of writing Memory or KB tokens into OpenCode's
global config files.

OpenCode does not currently expose a confirmed native durable-memory directory
that maps to Cockpit's `extractMemory()` / `getMemoryDir()` adapter API. Memory
for OpenCode conversations is provided through Cockpit's Memory MCP tools rather
than backend-native memory import/watch.

## Alternatives Considered

- **Model DeepSeek/Groq/Gemini as Cockpit CLI harnesses**: Rejected because these
  are API providers, not local harnesses. Adding them to `CliHarness` would blur
  the boundary between Cockpit-owned process adapters and OpenCode-owned provider
  routing.
- **Require Cockpit-managed OpenCode provider credentials immediately**:
  Rejected for the first pass because OpenCode stores provider credentials in
  its own data directory, and fully isolated multi-account auth needs separate
  verification. Self-configured profiles provide a safe incremental step.
- **Use a long-lived shared `opencode serve` process first**: Rejected for the
  first pass because per-conversation MCP token scoping is clearer with
  per-invocation inline config. A server-backed adapter can be evaluated later.

## Consequences

- + One Cockpit adapter opens access to many OpenCode-supported model providers.
- + Multiple Cockpit profiles can point at different OpenCode providers while
  sharing the same self-configured OpenCode installation; model choice remains a
  normal per-conversation or processor setting.
- + Memory MCP and KB MCP tokens remain scoped to the invocation that needs them.
- + OpenCode built-in and MCP tool calls surface through Cockpit's existing tool
  activity and outcome UI.
- - Cockpit-assisted OpenCode provider login is not part of the first pass.
- - OpenCode native memory import/watch is not implemented because there is no
  confirmed OpenCode native durable-memory directory to mirror.
- - OpenCode usage and tool-event parsing still depends on the JSON events
  currently consumed by the adapter and may need expansion as richer events are
  mapped.
- ~ OpenCode profiles use `AGENTS.md` as their instruction compatibility source,
  matching harness-neutral CLI guidance.

## References

- [docs/spec-data-models.md](../spec-data-models.md)
- [docs/spec-backend-services.md](../spec-backend-services.md)
- [docs/spec-frontend.md](../spec-frontend.md)
