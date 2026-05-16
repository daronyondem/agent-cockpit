---
id: 0065
title: Normalize setup profile auth homes at settings boundary
status: Accepted
date: 2026-05-16
supersedes: []
superseded-by: null
tags: [auth, cli-profiles, windows, settings]
affects:
  - src/services/cliProfiles.ts
  - src/services/settingsService.ts
  - src/services/cliProfileAuthService.ts
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-testing.md
  - docs/agent-project-memory.md
  - test/chat.cliProfileAuth.test.ts
  - test/settingsService.test.ts
---

## Context

ADR-0064 moved Welcome setup auth for Claude Code and Codex to the user's normal
vendor CLI auth home instead of a generated Agent Cockpit profile directory.
That direction is required on Windows because Agent Cockpit installs `claude` and
`codex` into a per-user `cli-tools` prefix that users can also run from a normal
terminal.

The first implementation stripped `configDir` only when the Welcome setup-auth
route saw an old setup profile. A persisted profile such as
`setup-claude-code-account` could still retain `configDir` and
`CLAUDE_CONFIG_DIR` if another route loaded it directly. That creates a false
verified state: the welcome/account page checks the isolated private directory,
while terminal `claude` and server-configured chat use the user's normal
`~/.claude` home and remain logged out.

## Decision

Setup account profiles are system-auth profiles by invariant, not only by route
convention. `SettingsService` strips `configDir` and vendor auth-home env keys
from `setup-codex-account*` and `setup-claude-code-account*` profiles when
settings are saved or read from disk. When a stale persisted value is removed on
read, the normalized settings are written back so future calls see the same
state.

`CliProfileAuthService.profileWithAuthDefaults()` also treats setup account
profiles specially: it removes stale auth-home fields and never assigns a
deterministic private config directory to them. Explicit non-setup account
profiles keep the existing isolated default-config behavior.

## Alternatives Considered

- **Keep stripping only in setup-auth routes**: Rejected because direct account
  checks and future profile-auth entrypoints can still verify stale isolated
  credentials.
- **Copy old setup credentials into the system vendor home**: Rejected because
  token storage is vendor-owned and copying credentials can create stale or
  incompatible auth state.
- **Disable explicit account-profile isolation entirely**: Rejected because
  multi-account users still need named isolated profiles.

## Consequences

- + Welcome setup checks, account-page checks, terminal commands, and default
  chats all use the same system vendor auth state.
- + Older Windows installs repair themselves when settings are next read or a
  setup profile is checked.
- - A user who only had credentials in the old private setup directory must log
  in again so the vendor writes credentials to the normal system home.
- ~ Explicit account profiles remain isolated; only setup account IDs are
  normalized this way.

## References

- [ADR-0064: Use system CLI auth for welcome setup](0064-use-system-cli-auth-for-welcome-setup.md)
- [API endpoints](../spec-api-endpoints.md#39-settings)
- [Backend services](../spec-backend-services.md)
- [Data models](../spec-data-models.md)
- [Testing](../spec-testing.md)
