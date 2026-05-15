---
id: 0060
title: Use CLI profile auth for setup login
status: Accepted
date: 2026-05-14
supersedes: []
superseded-by: null
tags:
  - install
  - cli-profiles
  - auth
affects:
  - src/routes/chat/cliProfileRoutes.ts
  - src/services/cliProfileAuthService.ts
  - web/AgentCockpitWeb/src/api.js
  - web/AgentCockpitWeb/src/shell.jsx
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-frontend.md
---

## Context

The first-run Welcome flow can now help users install optional CLI backends. Installing a CLI binary is not enough for Codex or Claude Code: the user must also complete the vendor login flow before the backend is usable. Agent Cockpit already has CLI profile authentication jobs for account profiles, including isolated `CODEX_HOME` / `CLAUDE_CONFIG_DIR`, redacted auth output, polling, cancellation, and status verification.

The setup flow needs to be friendly on a fresh machine while preserving the existing CLI profile model and avoiding a second authentication implementation. Kiro is different because `kiro-cli` does not currently expose a dedicated safe config-home override; existing behavior keeps Kiro self-configured.

## Decision

Welcome setup uses the existing CLI profile authentication system for CLI login. For Codex and Claude Code, setup-auth routes reuse the first enabled account profile for that vendor or create a first-run account profile (`setup-codex-account` / `setup-claude-code-account`). The routes persist the deterministic profile config directory through `CliProfileAuthService.profileWithAuthDefaults()`, then delegate to the existing auth status check or auth job start path.

When a created setup account profile replaces that vendor's server-configured default, it becomes `defaultCliProfileId` so new conversations use the login the user just completed. The browser polls the same auth-job endpoint used by Settings and displays the redacted device/login output. Kiro remains self-configured and shows a setup note rather than a remote login button.

## Alternatives Considered

- **Run raw vendor login commands directly from Welcome**: Rejected because it would duplicate auth-job lifecycle, redaction, timeout, polling, and profile-home handling already owned by `CliProfileAuthService`.
- **Only link users to CLI Profiles settings after installation**: Rejected because first-run setup should be able to move directly from installed CLI to usable authenticated profile without forcing the user to understand the profile model first.
- **Support Kiro remote login by changing `HOME`**: Rejected because changing `HOME` affects unrelated process behavior and Kiro does not currently document a dedicated account/config directory override.

## Consequences

- + Setup can install and authenticate supported CLIs in one flow while reusing the established profile/auth implementation.
- + Authenticated setup profiles are real CLI profiles, so later chat, plan usage, model metadata, and account switching paths use the same runtime contract.
- - The setup-auth wrapper adds route-level profile creation/defaulting logic that must stay aligned with CLI profile normalization.
- ~ Kiro remains a manual/self-configured login path until its CLI offers a safer profile-home mechanism.

## References

- [API endpoints](../spec-api-endpoints.md#39-settings)
- [Backend services](../spec-backend-services.md)
- [Data models](../spec-data-models.md)
- [Frontend](../spec-frontend.md)
