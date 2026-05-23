---
id: 0075
title: Register user-session autostart for POSIX installers
status: Accepted
date: 2026-05-23
supersedes: []
superseded-by: null
tags: [deployment, installer, process-management, macos, linux]
affects:
  - .github/workflows/release.yml
  - AGENTS.md
  - docs/agent-project-memory.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-deployment.md
  - docs/spec-testing.md
  - scripts/install-macos.sh
  - scripts/install-linux.sh
  - src/services/installDoctorService.ts
  - src/services/installStateService.ts
  - src/types/index.ts
  - test/installDoctorService.test.ts
  - test/installStateService.test.ts
  - test/linuxInstallerScript.test.ts
  - test/macosInstallerScript.test.ts
  - test/releaseWorkflow.test.ts
---

## Context

The macOS and Linux installers already start Agent Cockpit under PM2 and call
`pm2 save`, which gives process supervision while the PM2 daemon is running. It
does not by itself guarantee that PM2 is relaunched after the host is shut down
or restarted.

Windows already has a current-user `ONLOGON` scheduled task. The POSIX
installers need the same user-session guarantee without changing the product
model into a privileged service. Agent Cockpit must continue to run as the
installing user so local CLI auth, workspace paths, private Node runtimes, and
PM2 state stay owned by that user.

## Decision

macOS and Linux installers register user-session autostart by default, with
`--no-auto-start` as the explicit opt-out.

The macOS installer writes `<install-root>/bin/start-agent-cockpit.sh` and
`stop-agent-cockpit.sh`, then writes and loads
`~/Library/LaunchAgents/com.agent-cockpit.server.plist`. The LaunchAgent runs the
start helper at user login. The helper uses the installer-persisted runtime
`PATH`, changes into the active app directory, runs
`npx pm2 startOrRestart ecosystem.config.js --update-env`, and saves PM2 state.

The Linux installer writes the same start/stop helper pair and writes
`~/.config/systemd/user/agent-cockpit.service` (or the `XDG_CONFIG_HOME`
equivalent). The user unit is `Type=oneshot` with `RemainAfterExit=yes`, runs the
start helper for `default.target`, and uses the stop helper for `ExecStop`.
When `systemctl --user` is available, the installer reloads and enables the unit.
If the user systemd manager is unavailable in the install environment, the unit
file is still written and the installer logs a warning instead of failing the
whole install.

Install manifests record startup ownership:

- macOS default: `{ "kind": "launch-agent", "name": "com.agent-cockpit.server",
  "scope": "current-user" }`
- Linux default: `{ "kind": "systemd-user", "name": "agent-cockpit.service",
  "scope": "current-user" }`
- opt-out: `{ "kind": "manual", "name": null, "scope": "current-user" }`

Install Doctor checks the platform-specific startup registration: `launchctl` on
macOS, `systemctl --user is-enabled` on Linux, and the existing `schtasks.exe`
check on Windows.

## Alternatives Considered

- **Rely on `pm2 save` only**: rejected because saved PM2 process metadata does
  not launch PM2 after a host restart.
- **Use root/system services**: rejected because Agent Cockpit is a local
  user-owned server agent. Root services would run in the wrong auth and
  workspace context, or require extra privilege prompts and service-management
  decisions.
- **Run `pm2 startup` from the installers**: rejected because it prints
  platform-specific privileged commands and often expects sudo/global PM2
  assumptions, while the installers intentionally use project-local PM2 and
  private Node runtimes.
- **Use Linux desktop autostart files first**: rejected because the validated
  Linux target includes server/headless Ubuntu use where a graphical desktop
  autostart entry may never run. A systemd user unit is the narrower fit for the
  current Linux support matrix.

## Consequences

- + Fresh macOS and Linux installs come back when the current user session starts
  after logout, shutdown, or restart.
- + PM2 remains the only process manager for Agent Cockpit itself; OS startup
  entries only invoke the same PM2 start helper.
- + Users can opt out explicitly with `--no-auto-start`, and Install Doctor can
  report disabled or missing startup registration.
- - Linux user autostart depends on the systemd user manager. In environments
  where `systemctl --user` cannot enable the unit during install, the installer
  logs a warning and the doctor reports the missing registration.
- ~ User-session startup is not no-login service operation. Starting Agent
  Cockpit without the installing user session remains outside scope.

## References

- [ADR-0010: PM2 as the only supported process manager](0010-pm2-as-the-only-supported-process-manager.md)
- [ADR-0054: Adopt Mac installer and release channels](0054-adopt-mac-installer-and-release-channels.md)
- [ADR-0063: Adopt per-user Windows installer](0063-adopt-per-user-windows-installer.md)
- [ADR-0071: Support Linux production installs](0071-support-linux-production-installs.md)
- [Deployment and Operations](../spec-deployment.md)
- [Backend Services](../spec-backend-services.md)
- [Data Models](../spec-data-models.md)
- [Testing and CI/CD](../spec-testing.md)
