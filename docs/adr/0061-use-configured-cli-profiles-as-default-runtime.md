---
id: 0061
title: Use configured CLI profiles as default runtime
status: Accepted
date: 2026-05-14
supersedes: []
superseded-by: null
tags:
  - cli-profiles
  - settings
  - fresh-install
affects:
  - src/services/settingsService.ts
  - src/services/cliProfiles.ts
  - src/services/chatService.ts
  - src/routes/chat/cliProfileRoutes.ts
  - src/services/cliUpdateService.ts
  - src/services/memoryMcp/index.ts
  - src/services/knowledgeBase/digest.ts
  - src/services/knowledgeBase/dream.ts
  - src/services/contextMap/service.ts
  - web/AgentCockpitWeb/src/screens/settingsScreen.jsx
  - web/AgentCockpitWeb/src/workspaceSettings.jsx
  - mobile/AgentCockpitPWA/src/App.tsx
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-frontend.md
---

## Context

Agent Cockpit originally treated Claude Code as the implicit runtime fallback. Fresh settings returned `defaultBackend: "claude-code"` and an in-memory `server-configured-claude-code` profile even when the user had not installed or configured Claude Code. That made a fresh install look like it already had a Claude Code account/profile, blocked a provider-neutral first-run experience, and made Codex-only installs confusing.

The product still needs legacy compatibility. Existing conversations and older settings files may only store `backend`, and explicit backend selection must continue to create/use the matching server-configured profile. Background processors for Memory, Knowledge Base, and Context Map also need a deterministic runtime when configured, but they must not silently choose a provider when none is configured.

## Decision

Fresh settings contain no default CLI provider: `defaultBackend` and `defaultCliProfileId` are unset and `cliProfiles` is empty. The first enabled configured CLI profile becomes `defaultCliProfileId`; the existing Global Settings default CLI profile remains the source of truth for new conversations and default background processor fallback.

Runtime resolution is explicit:

- An explicit `cliProfileId` resolves that profile.
- An explicit or legacy `backend` resolves the matching server-configured profile for compatibility.
- If neither is supplied, `settings.defaultCliProfileId` is used, then legacy `settings.defaultBackend`.
- If no runtime is configured, the server returns a clear CLI-profile-required error instead of falling back to Claude Code or the first registered backend.

Welcome setup authentication and profile creation promote the created/reused account profile when no default exists. Background processors use their feature-specific profile/backend first, then the global default CLI profile/backend. CLI update checks only inspect configured profiles or migrated legacy defaults.

## Alternatives Considered

- **Keep Claude Code as the fresh default**: Rejected because it misrepresents the user's actual install state and fails Codex-only or other-provider-only setups.
- **Add a separate default provider setting**: Rejected because Global Settings already owns `defaultCliProfileId`; a parallel setting would create conflicting sources of truth.
- **Auto-select the first backend from the registry when no profile exists**: Rejected because registry order is an implementation detail, not user configuration.

## Consequences

- + Fresh installs accurately show no CLI profile until the user installs/signs in to one.
- + Any supported CLI provider can be the only configured provider and become the default.
- + Legacy settings and conversations that store only `backend` keep working through server-configured profile migration.
- - Fresh users cannot create a conversation until at least one CLI profile/default backend is configured, so setup UI must keep guiding them to install/sign in.
- ~ Background processor failures now surface missing CLI configuration as unavailable/required instead of trying an arbitrary provider.

## References

- [ADR-0060](0060-use-cli-profile-auth-for-setup-login.md)
- [API endpoints spec](../spec-api-endpoints.md#39-settings)
- [Backend services spec](../spec-backend-services.md)
- [Data models spec](../spec-data-models.md)
