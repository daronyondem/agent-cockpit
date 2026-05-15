---
id: 0063
title: Adopt per-user Windows installer
status: Proposed
date: 2026-05-15
supersedes: []
superseded-by: null
tags: [deployment, installer, update, windows]
affects:
  - .github/workflows/release.yml
  - README.md
  - scripts/install-windows.ps1
  - scripts/package-release.js
  - src/services/updateService.ts
  - src/services/installDoctorService.ts
  - src/services/installStateService.ts
  - src/types/index.ts
  - docs/spec-deployment.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-api-endpoints.md
  - docs/spec-testing.md
  - docs/spec-coverage.md
  - test/windowsInstallerScript.test.ts
  - test/releasePackage.test.ts
  - test/updateService.test.ts
  - test/installDoctorService.test.ts
---

## Context

Agent Cockpit already has a macOS production installer and release-channel model.
That path depends on macOS shell tooling, a `current` symlink, macOS Node.js
tarballs, and a POSIX restart script. Those choices work for Mac users but are
not the right Windows user experience.

The Windows install goal is a normal-user local server agent: install under the
current Windows user, start Agent Cockpit, open the browser setup flow, and start
again when that same user logs in. Running before login or under a Windows
Service account would make that service account the real runtime identity,
which complicates CLI auth, `%APPDATA%`, Credential Manager, workspace
permissions, mapped drives, browser setup, and support.

## Decision

Agent Cockpit adopts a per-user Windows installer. The installer is a
PowerShell script distributed beside production GitHub Release assets. It
installs under `%LOCALAPPDATA%\Agent Cockpit`, uses system Node.js 22+/npm when
available, otherwise installs a checksum-verified private Node.js Windows ZIP
under the install root, installs dependencies, writes runtime config and
install metadata, starts Agent Cockpit through local PM2, and opens the browser
setup flow.

Windows release packaging adds a ZIP app archive and `install-windows.ps1`
artifact while preserving the existing macOS tarball and shell installer
artifacts. Windows production updates activate the versioned release directory
recorded in `install.json` rather than using a `current` symlink. Restart and
rollback use a generated PowerShell script, install-local `PM2_HOME`, and the
same health-check rollback semantics as macOS.

Windows startup uses a current-user ONLOGON Scheduled Task that runs the
installer-generated start helper. The supported Windows path does not install a
Windows Service, does not require admin rights, does not mutate global PATH, and
does not promise no-login/unattended service operation.

## Alternatives Considered

- **Port the macOS shell installer to Windows through Git Bash or WSL**:
  rejected because it would make normal Windows users install another Unix
  compatibility layer and would preserve symlink/shell assumptions that are not
  native to Windows.
- **Use a Windows Service for the first installer**: rejected because the service
  account becomes the runtime user for CLI credentials, workspace access, PM2
  state, and app data. That is much harder for normal users to reason about than
  per-user logon startup.
- **Use global Node.js and global PM2**: rejected because fresh Windows machines
  should not require separate runtime setup and Agent Cockpit should not mutate
  user-wide tooling to run.
- **Use a native Electron/Tauri/MSI first**: rejected because it adds shell,
  signing, updater, and installer infrastructure before the server-agent
  Windows path is proven.
- **Use junctions or symlinks for the active Windows release**: rejected because
  symlink permissions and junction semantics are less predictable for normal
  users than recording the active versioned `appDir` in `install.json`.

## Consequences

- + Fresh Windows installs can be per-user, no-admin, and independent of global
  Node/PM2 setup.
- + Windows release artifacts use native ZIP extraction and PowerShell hashing.
- + Production updates can keep rollback semantics without Windows symlink
  dependencies.
- + Current-user logon startup matches the product model where local CLI auth and
  workspaces belong to the interactive user.
- - Windows now has a separate installer/update branch that must be kept aligned
  with release packaging and specs.
- - No-login operation remains unsupported until a service-account product model
  is explicitly designed.
- ~ PM2 remains the runtime supervisor, but Windows uses install-local `PM2_HOME`
  and helper scripts so Agent Cockpit state does not collide with other PM2 apps.

## References

- [ADR-0054: Adopt Mac installer and release channels](0054-adopt-mac-installer-and-release-channels.md)
- [ADR-0059: Install private Node runtime on macOS](0059-install-private-node-runtime-on-macos.md)
- [Deployment and Operations](../spec-deployment.md)
- [Backend Services](../spec-backend-services.md)
- [Data Models](../spec-data-models.md)
- [Testing and CI/CD](../spec-testing.md)
