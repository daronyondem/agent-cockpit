---
id: 0027
title: Manage CLI updates from web cockpit
status: Accepted
date: 2026-05-04
supersedes: []
superseded-by: null
tags: [frontend, backend, cli-profiles, mobile-parity]
affects:
  - src/services/cliUpdateService.ts
  - src/routes/chat.ts
  - public/v2/src/cliUpdateStore.js
  - public/v2/src/shell.jsx
  - public/v2/src/screens/settingsScreen.jsx
  - docs/parity-decisions.md
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
---

## Context

Agent Cockpit runs local CLI tools on behalf of remote browser users. When a backend CLI has a new version, users only notice if they open that CLI directly in a terminal or inspect the server. This is easy to miss for users who primarily interact through Agent Cockpit.

Agent Cockpit already has a self-update path for the app itself, but it does not manage the vendor CLIs it shells out to. CLI updates are also different from normal chat behavior: they mutate server-local binaries, can invalidate long-lived backend child processes, and should not run while conversations are active.

The mobile PWA is intentionally a chat/run-control client. It does not currently expose global server administration screens like desktop Settings, app update/restart controls, Memory/KB management, or usage management.

## Decision

Agent Cockpit manages local backend CLI update awareness from the desktop web UI only.

The server owns a `CliUpdateService` that:

- derives update targets from configured CLI profiles and groups them by vendor, command, and `PATH`;
- checks current versions using the vendor CLI version command;
- detects supported global npm installs for Codex (`@openai/codex`) and Claude Code (`@anthropic-ai/claude-code`) by verifying the resolved command path lives under `npm root -g/<package>`;
- queries latest npm versions for supported npm installs;
- records Kiro as self-updatable through `kiro-cli update --non-interactive`, while not raising composer update notifications until a reliable latest-version detector exists;
- refuses update execution while any conversation turn is active or pending;
- re-probes after a successful update and asks the backend registry to shut down long-lived child processes so future work starts with the updated binary.

The desktop web UI exposes this in two places:

- a separate terminal-shaped composer notification icon when the current conversation's selected CLI profile has an actionable update;
- Settings -> CLI Config, where every detected CLI target is visible with current/latest versions, install method, profile names, check-now, and supported update actions.

The mobile PWA intentionally does not implement CLI update notifications or update actions. The decision is recorded in `docs/parity-decisions.md` so the absence is not mistaken for missed parity.

## Alternatives Considered

- **Use only the existing app update modal**: Rejected because app updates and CLI binary updates have different targets, commands, guards, and restart behavior. Combining them would make the app-version indicator ambiguous.
- **Put CLI update state inside the existing KB notification tooltip**: Rejected because the KB notification is hover-only and informational, while CLI updates need action buttons. Separate icons keep each source independently visible and allow the CLI popover to stay open after click.
- **Expose update controls in the mobile PWA too**: Rejected because CLI binary updates are server-administration actions and the PWA is scoped to mobile chat/run workflows. This may be revisited if the PWA gains a broader admin/settings surface.
- **Run blind update commands without install-method detection**: Rejected because it could mutate a different installation than the command Agent Cockpit actually runs, or fail on native/non-npm installs in a confusing way.

## Consequences

- + Users who live in Agent Cockpit can see actionable CLI updates without opening server terminals.
- + Supported npm installs can be updated in place from the web UI with the same active-turn safety guard as app update/restart.
- + Unknown/native installs remain observable without pretending they are safely manageable.
- + Web/PWA divergence is explicitly documented.
- - The service depends on vendor CLI/package conventions and may need maintenance if package names, version output, or updater commands change.
- - Kiro update availability is not detected yet; only the self-update command is recorded.
- ~ CLI update status is in-memory. It is rechecked after startup and on explicit "Check now", not persisted across process restarts.

## References

- [API endpoints](../spec-api-endpoints.md#3131-cli-updates)
- [Backend service spec](../spec-backend-services.md#431-cliupdateservice)
- [Frontend behavior spec](../spec-frontend.md)
- [Mobile PWA spec](../spec-mobile-pwa.md#deferred-slices)
- [Parity decision register](../parity-decisions.md)
- OpenAI Codex CLI documentation: https://developers.openai.com/codex/cli
- Anthropic Claude Code setup/update documentation: https://docs.anthropic.com/en/docs/claude-code/getting-started
- Kiro CLI command reference: https://kiro.dev/docs/cli/reference/cli-commands/
