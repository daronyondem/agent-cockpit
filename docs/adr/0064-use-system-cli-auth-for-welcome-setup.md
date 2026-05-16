---
id: 0064
title: Use system CLI auth for welcome setup
status: Accepted
date: 2026-05-16
supersedes: []
superseded-by: null
tags: [auth, cli-profiles, install, windows]
affects:
  - src/routes/chat/cliProfileRoutes.ts
  - src/services/cliProfileAuthService.ts
  - src/services/windowsUserPath.ts
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-testing.md
  - docs/agent-project-memory.md
  - test/chat.cliProfileAuth.test.ts
---

## Context

ADR-0060 made Welcome setup reuse CLI profile authentication jobs and persisted
deterministic profile config directories for the first-run `setup-codex-account`
and `setup-claude-code-account` profiles. That isolation is useful for explicit
account profiles, but it is surprising in first-run setup: users install and log
in through Agent Cockpit, then expect the same `claude` or `codex` command to be
available and authenticated in a normal terminal.

On Windows this became visible because Agent Cockpit installs the CLI binaries
into a per-user `cli-tools` prefix and exposes them on the user's `Path`. If the
Welcome auth flow writes credentials into Agent Cockpit's private profile
directory, terminal `claude`/`codex` commands still use the vendor default home
and appear logged out.

## Decision

Welcome setup auth for Codex and Claude Code uses the user's normal vendor CLI
auth home. The setup-auth routes still create or reuse real account profiles and
can promote those profiles as the default, but those first-run setup profiles do
not get a generated `configDir`.

Explicit account profiles created outside the Welcome setup route keep the
existing behavior from ADR-0060: when a profile starts remote auth without a
`configDir`, `CliProfileAuthService.profileWithAuthDefaults()` persists a
deterministic profile directory so that profile is isolated and repeatable.

Existing first-run setup profiles from earlier releases are migrated when the
setup-auth route sees them: if `setup-codex-account` or
`setup-claude-code-account` has a generated `configDir`, the route removes that
field before running status checks or login jobs. This keeps new terminal CLI
sessions and Agent Cockpit chats aligned with the same vendor auth state.

## Alternatives Considered

- **Keep Welcome setup isolated**: Rejected because it makes Agent Cockpit report
  a setup login as verified while the same CLI command remains logged out in a
  user's terminal.
- **Make every account profile system-wide by default**: Rejected because
  explicit multi-account profiles still need isolated config/auth directories.
- **Copy credentials from the setup profile directory to the vendor default
  home**: Rejected because each vendor owns token storage details and copying
  credentials risks stale or incompatible auth state.

## Consequences

- + First-run setup behaves like a normal CLI installation: Agent Cockpit and
  terminal sessions use the same login.
- + Users who install Claude Code or Codex through Agent Cockpit can reuse the
  authenticated CLI outside Agent Cockpit without understanding profile homes.
- - Welcome setup is less isolated than explicit account profiles; logging out in
  a terminal can affect the first-run setup profile.
- ~ Explicit account profiles remain available for users who need isolation.

## References

- [ADR-0060: Use CLI profile auth for setup login](0060-use-cli-profile-auth-for-setup-login.md)
- [API endpoints](../spec-api-endpoints.md#39-settings)
- [Backend services](../spec-backend-services.md)
- [Data models](../spec-data-models.md)
- [Testing](../spec-testing.md)
