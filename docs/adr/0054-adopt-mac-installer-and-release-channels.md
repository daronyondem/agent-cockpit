---
id: 0054
title: Adopt Mac installer and release channels
status: Accepted
date: 2026-05-11
supersedes: []
superseded-by: null
tags:
  - deployment
  - installer
  - update
  - macos
affects:
  - plan.md
  - package.json
  - .github/workflows/release.yml
  - .github/workflows/version-bump.yml
  - server.ts
  - scripts/auth-reset.ts
  - scripts/context-map-report.ts
  - scripts/install-macos.sh
  - scripts/package-release.js
  - src/config/index.ts
  - src/types/index.ts
  - src/contracts/install.ts
  - src/middleware/auth.ts
  - src/services/chatService.ts
  - src/services/installDoctorService.ts
  - src/services/installStateService.ts
  - src/services/claudePlanUsageService.ts
  - src/services/codexPlanUsageService.ts
  - src/services/kiroPlanUsageService.ts
  - src/services/updateService.ts
  - src/services/webBuildService.ts
  - src/services/mobileBuildService.ts
  - test/config.test.ts
  - test/auth.test.ts
  - test/chatService.conversations.test.ts
  - test/chat.rest.test.ts
  - test/frontendRoutes.test.ts
  - test/installDoctorService.test.ts
  - test/installStateService.test.ts
  - test/macosInstallerScript.test.ts
  - test/releasePackage.test.ts
  - test/updateService.test.ts
  - test/claudePlanUsage.test.ts
  - test/codexPlanUsage.test.ts
  - test/kiroPlanUsage.test.ts
  - docs/spec-data-models.md
  - docs/spec-api-endpoints.md
  - docs/spec-deployment.md
  - docs/spec-backend-services.md
  - docs/spec-server-security.md
  - docs/spec-frontend.md
  - docs/spec-testing.md
  - docs/spec-coverage.md
  - web/AgentCockpitWeb/src/api.js
  - web/AgentCockpitWeb/src/app.css
  - web/AgentCockpitWeb/src/shell.jsx
---

## Context

Agent Cockpit is currently easiest to run as a developer checkout: install
dependencies, run the server under PM2, and let the existing self-update path pull
`main`, install dependencies, rebuild V2/mobile assets, and restart. That works
for maintainers but is too much terminal work for normal Mac users.

The app also now has two generated browser surfaces: the Vite V2 web app served
from `public/v2-built/` and the mobile PWA served from `public/mobile-built/`.
Both can be rebuilt at startup or during self-update, but production users should
not have to compile normal release assets on every install when the release
workflow can publish those assets.

The product needs a first supported install story before broader packaging work.
The immediate audience is Mac users who can run a local server agent and open a
browser. Windows, desktop wrappers, Homebrew formulae, code signing,
notarization, automatic Cloudflare tunnel setup, multi-user hosting, and hosted
SaaS remain separate decisions.

## Decision

Agent Cockpit adopts a Mac-first server-agent installer and a two-channel release
model:

- **Production channel**: normal users install from GitHub Releases. A manual
  release workflow packages a selected source ref, includes prebuilt
  `public/v2-built/` and `public/mobile-built/` assets, publishes checksums, and
  creates the GitHub Release. Production app updates check GitHub Releases
  instead of tags or `main`.
- **Dev channel**: maintainers and testers track `main`. Dev installs keep the
  current git pull, dependency install, forced web/mobile build, and PM2 restart
  update behavior.

The first installer target is macOS. The installer runs Agent Cockpit locally as
a PM2-managed server process, uses `npx pm2` from project dependencies rather
than requiring a global PM2 install, writes install/channel metadata for later
update routing, and opens the browser into first-run setup. PM2 remains the
supported process manager for this install model.

Production release artifacts include the generated V2 and mobile PWA asset
directories. Startup build preflight remains as a safety net for missing or
stale assets and for dev/main installs, but production releases should normally
serve the packaged builds.

The automatic version bump workflow may continue for dev/main version movement,
but it is not the public production release signal. Public production releases
are GitHub Releases created by an explicit manual promotion workflow.

## Alternatives Considered

- **Electron or Tauri desktop app first**: rejected for the first release because
  it adds signing, updater, native shell, and packaging work before the local
  server/browser model is proven for normal users.
- **Homebrew formula first**: rejected because it still leaves first-run owner
  setup and local CLI readiness mostly as terminal work, and it introduces a
  package-distribution path before a stable release artifact exists.
- **One channel that always tracks `main`**: rejected because normal users need a
  stable public release channel and maintainers still need a fast dev channel.
- **Use automatic version-bump tags as releases**: rejected because version bumps
  are useful for dev/main traceability but should not automatically promote a
  build to public production.
- **Build all frontend assets on the user's machine for production installs**:
  rejected because the release workflow can produce deterministic assets once,
  while startup preflight can remain the fallback.
- **Windows installer in the same first slice**: rejected because Windows needs a
  separate PowerShell/service/process-manager path and would slow down the Mac
  release path.

## Consequences

- + Normal Mac users get one install path that starts the local app and moves
  most setup into browser UI.
- + Production and dev update semantics are explicit instead of overloading
  `main` for everyone.
- + GitHub Releases become the stable public release boundary, with artifacts and
  checksums that can be verified by the installer and updater.
- + Prebuilt V2 and mobile assets reduce production install/update work while
  retaining startup/self-update build preflight as a recovery path.
- - Release-aware updates require new install metadata, artifact verification,
  staging, and rollback logic before production updates are complete.
- - macOS is the only installer target for the first supported release.
- ~ PM2 remains an operational dependency, but it is consumed through local
  project dependencies via `npx pm2` rather than as a required global install.

## References

- [Issue #108](https://github.com/daronyondem/agent-cockpit/issues/108)
- [ADR-0010: PM2 as the only supported process manager](0010-pm2-as-the-only-supported-process-manager.md)
- [ADR-0049: Retire V2 globals and build mobile assets during updates](0049-retire-v2-globals-and-build-mobile-assets-during-updates.md)
- [ADR-0050: Serve mobile PWA from ignored build output](0050-serve-mobile-pwa-from-ignored-build-output.md)
- [Deployment and Operations](../spec-deployment.md)
- [Backend Services](../spec-backend-services.md)
- [Server Initialization and Security](../spec-server-security.md)
- [Testing and CI/CD](../spec-testing.md)
