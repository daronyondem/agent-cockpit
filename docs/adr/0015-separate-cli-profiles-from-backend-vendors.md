---
id: 0015
title: Separate CLI profiles from backend vendors
status: Accepted
date: 2026-04-29
supersedes: []
superseded-by: null
tags: [backends, configuration, cli-profiles, migration]
affects:
  - src/types/index.ts
  - src/services/cliProfiles.ts
  - src/services/settingsService.ts
  - src/services/chatService.ts
  - docs/spec-data-models.md
  - docs/spec-backend-services.md
  - docs/spec-api-endpoints.md
  - docs/spec-frontend.md
  - docs/spec-testing.md
---

## Context

Agent Cockpit originally modeled the selectable runtime as a backend vendor ID: `claude-code`, `kiro`, or `codex`. That was enough while each vendor was effectively a singleton process using the server user's default CLI configuration. It is not enough for users who have multiple accounts with the same vendor, such as personal and work Codex accounts on one machine.

Workspace path cannot solve this. A workspace answers where the CLI should operate. A CLI profile answers which executable, account, config/auth home, and runtime environment should run the conversation.

The current backend adapters also have vendor-specific state that makes mid-session identity switching unsafe:

- Codex stores auth, config, plugins, and thread rollouts under `CODEX_HOME` / `~/.codex`; `thread/resume` depends on the same home being available later.
- Claude Code can isolate state with `CLAUDE_CONFIG_DIR`; that state includes settings, credentials, sessions, and plugins.
- Kiro supports account login and device flow, but its supported multi-account config isolation path still needs vendor-specific research.

This decision is the first foundation step for issue #243. It stores profile identity and migrates existing data without changing how adapters spawn processes yet.

## Decision

Agent Cockpit separates **CLI profiles** from **backend vendors**.

A CLI profile is a named runtime identity with:

- `id`
- `name`
- `vendor` (`codex`, `claude-code`, or `kiro`)
- optional executable override
- auth mode (`server-configured` or future account-managed auth)
- optional config directory and environment overrides
- timestamps and disabled state

Conversations store `cliProfileId` in addition to the existing `backend` field. The existing `backend` field remains during the transition for compatibility and for the current adapter lookup path. New code should treat `cliProfileId` as the durable conversation-level runtime selection.

Phase 1 creates deterministic server-configured profile IDs:

- `server-configured-claude-code`
- `server-configured-kiro`
- `server-configured-codex`

On startup, `ChatService.initialize()` migrates existing workspace indexes by assigning missing `cliProfileId` values from each conversation's existing `backend`. It also ensures matching server-configured profiles exist in `settings.json`. Creating or updating a conversation's backend during the transition similarly assigns the matching server-configured profile.

Runtime process spawning remains unchanged in this phase. Later phases will resolve `cliProfileId` to vendor-specific runtime env and command overrides.

## Alternatives Considered

- **Keep backend IDs as the only selectable runtime.** Rejected because it cannot represent two accounts for the same vendor.
- **Encode account identity into backend IDs** such as `codex-work` and `codex-personal`. Rejected because it multiplies adapter registrations and mixes vendor capability metadata with user configuration.
- **Use workspace path as the account boundary.** Rejected because workspaces control files, not CLI auth/config state.
- **Implement only Codex profiles first with a Codex-specific model.** Rejected because the product concept applies to all supported vendors. The implementation can still phase vendor-specific runtime isolation, but the stored model should not need to be replaced later.
- **Immediately switch all adapter spawning to profile-aware runtime env.** Rejected for Phase 1 because persistence migration should be small and verifiable before changing process lifecycle behavior.

## Consequences

- + Existing conversations get a forward-compatible `cliProfileId` without changing runtime behavior.
- + The settings model can represent multiple accounts for the same vendor.
- + Future UI can list named profiles while still using existing vendor icons and adapter metadata.
- + The migration is deterministic and reversible: server-configured profiles preserve today's behavior.
- - The code temporarily carries both `backend` and `cliProfileId`.
- - Runtime is not truly multi-account until later phases apply profile command/env to adapter spawning, model discovery, plan usage, memory, and KB one-shots.
- ~ Kiro remains a research item. If Kiro does not expose a supported config-home override, it may stay server-configured only.

## References

- Issue #243 — Add CLI profiles for multi-account backend configuration
- ADR-0005 — Codex backend over `codex app-server` JSON-RPC with TOML MCP injection
- ADR-0014 — Make Codex execution policy configurable
- `docs/spec-data-models.md`
- `docs/spec-backend-services.md`
