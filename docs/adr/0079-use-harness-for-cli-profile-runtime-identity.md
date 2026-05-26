---
id: 0079
title: Use harness for CLI profile runtime identity
status: Proposed
date: 2026-05-26
supersedes: []
superseded-by: null
tags: [cli-profiles, backends, terminology, migration]
affects:
  - src/types/index.ts
  - src/contracts/chat.ts
  - src/contracts/responses.ts
  - src/services/cliProfiles.ts
  - src/services/settingsService.ts
  - src/services/chatService.ts
  - src/services/cliProfileAuthService.ts
  - src/services/cliUpdateService.ts
  - src/routes/chat/cliProfileRoutes.ts
  - web/AgentCockpitWeb/src/api.js
  - web/AgentCockpitWeb/src/chat/chatHelpers.js
  - web/AgentCockpitWeb/src/chat/composer.jsx
  - web/AgentCockpitWeb/src/screens/settingsScreen.jsx
  - mobile/AgentCockpitPWA/src/App.tsx
  - mobile/AgentCockpitPWA/src/appModel.ts
  - mobile/AgentCockpitPWA/src/types.ts
  - test/settingsService.test.ts
  - test/chat.cliProfileAuth.test.ts
  - test/chatService.conversations.test.ts
  - test/chat.conversations.test.ts
  - test/frontendRoutes.test.ts
  - test/mobileAppModel.test.ts
  - docs/spec-data-models.md
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-frontend.md
  - docs/spec-testing.md
  - docs/spec-coverage.md
  - docs/agent-project-memory.md
  - CLI_PROFILES_MULTI_ACCOUNT_PLAN.md
  - AGENTS.md
---

## Context

ADR-0015 introduced CLI profiles with a `vendor` field because the first
supported runtimes were one local CLI per vendor: Claude Code, Codex, and Kiro.
OpenCode changes that language. OpenCode is the local CLI process Agent
Cockpit launches, but the actual model/API providers behind it can be
DeepSeek, Groq, OpenRouter, Gemini, or others. Calling the local process a
vendor blurs the boundary between Cockpit-owned runtime selection and
provider/model routing owned by a harness such as OpenCode.

The product also has two user-facing selectors with different jobs. Settings
chooses the local CLI runtime type for a profile; the composer chooses a named
profile. Using "CLI Vendor" for both makes profile selection look like vendor
selection and makes OpenCode provider support harder to explain.

## Decision

Agent Cockpit uses **harness** for the physical local CLI runtime identity on a
CLI profile. The canonical stored field is `CliProfile.harness`, with values
`codex`, `claude-code`, `kiro`, and `opencode`. `CliProfile.vendor` is accepted
only as legacy input at compatibility and migration boundaries and is
normalized to `harness` before settings are emitted or persisted.

Settings labels the runtime-type field **Harness**. Composer and conversation
surfaces keep using **Profile** / **CLI Profile** because users are choosing a
named account/runtime profile, not a raw harness. Backend ids remain internal
adapter identifiers and are still mirrored on conversations for compatibility.
Claude Code Interactive remains an internal backend/protocol selected through a
Claude Code profile's `protocol` field, not a separate harness.

OpenCode remains one Cockpit harness. DeepSeek, Groq, OpenRouter, Gemini, and
similar systems remain OpenCode provider/model choices rather than top-level
Cockpit harnesses.

## Alternatives Considered

- **Keep `vendor` as the canonical field**: Rejected because OpenCode is a
  runnable local CLI wrapper over multiple providers. The word would keep
  implying that DeepSeek/Groq/OpenRouter should become top-level profile
  values.
- **Use `backend` for the profile field**: Rejected because backend ids are
  internal adapter/protocol ids and conversations still mirror them for
  compatibility. Profiles need a stable physical runtime field above the
  backend registry.
- **Use `provider` for the profile field**: Rejected because provider already
  describes model/API routing inside OpenCode and similar harnesses.

## Consequences

- + The data model distinguishes local CLI harnesses from model/API providers.
- + OpenCode can support multiple provider/model choices without creating new
  top-level Cockpit runtime identities.
- + User-facing Settings copy matches what the field controls, while composer
  copy remains profile-oriented.
- - Existing settings and API clients that still send `vendor` require a
  compatibility path until the migration window can close.
- ~ Accepted ADRs and historical release notes may still use the older term as
  historical context; current code, specs, and UI use `harness`.

## References

- ADR-0015 — Separate CLI profiles from backend vendors
- ADR-0076 — Add OpenCode CLI profiles
- `docs/spec-data-models.md`
- `docs/spec-api-endpoints.md`
- `docs/spec-backend-services.md`
- `docs/spec-frontend.md`
- `docs/spec-testing.md`
