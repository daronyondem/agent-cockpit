---
id: 0071
title: Support Linux production installs
status: Proposed
date: 2026-05-20
supersedes: []
superseded-by: null
tags: [deployment, installer, update, linux]
affects:
  - .github/workflows/release.yml
  - AGENTS.md
  - scripts/install-linux.sh
  - scripts/package-release.js
  - src/services/updateService.ts
  - docs/agent-project-memory.md
  - docs/deploy/README.md
  - docs/deploy/linux.md
  - docs/spec-deployment.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-testing.md
  - docs/spec-coverage.md
  - test/linuxInstallerScript.test.ts
  - test/releasePackage.test.ts
  - test/releaseWorkflow.test.ts
  - test/updateService.test.ts
---

## Context

Agent Cockpit already has production install paths for macOS and Windows. Linux
users should be able to install the same local server-agent product without
cloning the repository or manually preparing Node.js, while keeping the existing
GitHub Release channel, checksum verification, PM2 supervision, and first-run
browser setup model.

"Linux" is not one runtime target. Mainstream distributions such as Ubuntu,
Debian, Fedora, and RHEL-family systems use glibc, while Alpine uses musl libc.
Official Node.js Linux binaries target glibc Linux; Alpine/musl support would
require a separate support decision, separate validation, and likely a separate
runtime source. The first Linux path should therefore be explicit about what is
validated instead of claiming all Linux distributions.

## Decision

Agent Cockpit supports a first production Linux installer for Ubuntu 24.04 LTS
x64/glibc. The installer is `scripts/install-linux.sh`, distributed beside
GitHub Release assets. It installs under
`${XDG_DATA_HOME:-$HOME/.local/share}/agent-cockpit`, uses system Node.js 22+/npm
when available, otherwise installs a checksum-verified official Node.js Linux
x64 `tar.xz` runtime under the install root, installs dependencies, writes
runtime config and install metadata, starts Agent Cockpit through local PM2, and
opens or prints the browser setup URL.

Linux production releases use the same physical source tarball as macOS because
the packaged runtime source and prebuilt web/mobile assets are platform-neutral.
The release manifest still contains a distinct Linux artifact entry with
`platform: "linux"` and `format: "tar.gz"` so Linux installers and updaters can
select their platform explicitly. `install-linux.sh` is uploaded as a separate
GitHub Release asset and included in `SHA256SUMS`.

Linux production self-update follows the macOS activation model: extract the
release under `<install-root>/releases`, copy runtime config, switch the
`current` symlink, write `install.json`, and restart through the POSIX PM2
restart script with rollback. Linux private Node runtime updates use official
Linux x64 `tar.xz` archives and repoint `<install-root>/runtime/node`.

The first Linux support matrix is intentionally narrow: Ubuntu 24.04 LTS x64 is
the manual test target; other glibc x64 distributions may work but are not
validated. Alpine/musl, NixOS, WSL, Linux arm64, and 32-bit Linux are not
supported until explicitly designed and tested.

## Alternatives Considered

- **Publish `.deb`/`.rpm` packages first**: rejected because distro packaging
  adds repository signing, package manager integration, service lifecycle, and
  upgrade semantics before the shell installer path is validated.
- **Use Docker as the Linux release**: rejected because Agent Cockpit must run
  on the same machine and user context as local CLI tools and workspaces; a
  container would complicate filesystem access and CLI auth.
- **Claim all Linux distributions**: rejected because glibc and musl runtime
  compatibility differ, and unsupported distro-specific service/package
  behavior would create a misleading support promise.
- **Support Alpine/musl initially**: rejected because official Node.js release
  assets do not provide the same support guarantees for musl, and Alpine is more
  common as a container base than as the local desktop/server target for this
  installer.
- **Require system Node.js only**: rejected because macOS and Windows installers
  already support fresh machines with private Node runtimes, and Linux should
  preserve that first-run experience for the validated path.
- **Add Linux autostart through systemd user units immediately**: rejected for
  the first implementation because PM2 startup matches the existing local server
  model and user-level autostart behavior varies across Linux desktop/server
  environments.

## Consequences

- + Linux users on the validated Ubuntu x64/glibc path can install from GitHub
  Releases without a repository checkout or preinstalled Node.js.
- + Production self-update stays aligned with the existing macOS symlink
  activation model while Windows keeps its versioned `appDir` activation model.
- + Release manifests can distinguish Linux from macOS even when both entries
  refer to the same physical app tarball.
- + CI now exercises Linux packaging and dev installer smoke behavior on
  `ubuntu-latest` before publishing.
- - The Linux support matrix is intentionally narrower than "all Linux", so docs
  and installer errors must stay explicit.
- - Future Linux arm64, Alpine/musl, WSL, systemd user autostart, `.deb`, `.rpm`,
  Snap, Flatpak, AppImage, or Docker support require separate tested decisions.
- ~ Linux and macOS share POSIX restart/symlink behavior, but private Node
  archive selection differs (`darwin-*.tar.gz` vs `linux-x64.tar.xz`).

## References

- [ADR-0054: Adopt Mac installer and release channels](0054-adopt-mac-installer-and-release-channels.md)
- [ADR-0059: Install private Node runtime on macOS](0059-install-private-node-runtime-on-macos.md)
- [ADR-0063: Adopt per-user Windows installer](0063-adopt-per-user-windows-installer.md)
- [Deployment and Operations](../spec-deployment.md)
- [Backend Services](../spec-backend-services.md)
- [Data Models](../spec-data-models.md)
- [Testing and CI/CD](../spec-testing.md)
