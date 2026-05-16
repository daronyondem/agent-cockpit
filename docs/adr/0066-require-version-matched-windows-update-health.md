---
id: 0066
title: Require version matched Windows update health
status: Accepted
date: 2026-05-16
supersedes: []
superseded-by: null
tags: [deployment, update, windows]
affects:
  - AGENTS.md
  - docs/agent-project-memory.md
  - docs/spec-backend-services.md
  - docs/spec-deployment.md
  - docs/spec-testing.md
  - src/services/updateService.ts
  - test/updateService.test.ts
---

## Context

Windows production updates activate a versioned release directory by writing the
new `appDir` to `install.json`, then launching a detached PowerShell restart
script to replace the running PM2 process. A failed handoff can leave an older
Agent Cockpit process still listening on the configured port while the install
manifest already points at the newer release.

The previous Windows restart health check treated any successful HTTP response
from `/api/chat/version` as healthy. That allowed a stale old process to satisfy
the health probe even though it had not restarted into the release that the
installer had just activated. In that state, migrations and setup-profile auth
normalization from the new release never run, while update status can look
current because the old process initiated the update.

## Decision

Windows production self-update restart scripts must use the target release's
app-local `node_modules\.bin\pm2.cmd` instead of `npx pm2`, and the health check
must parse `/api/chat/version` and require its `version` field to equal the
target release version. If the target PM2 restart fails or the health endpoint
keeps returning a different version, the generated PowerShell script restores
the previous `install.json`, restarts the previous release with that release's
app-local PM2 command, saves PM2 state, and exits with failure.

The already-running Windows process does not update its in-memory local version
before the restart handoff succeeds, so a failed handoff continues to report the
old running version rather than hiding the available update.

The macOS restart path remains unchanged: it still uses the POSIX script and
symlink rollback behavior established by ADR-0054 and ADR-0063.

## Alternatives Considered

- **Keep HTTP liveness as the Windows health check**: rejected because an old
  process on the same port can be live while the new release is not running.
- **Use `npx pm2` for Windows restart and rollback**: rejected because `npx`
  can prompt, fail package resolution, or target npm shim behavior instead of
  the app-local PM2 installation that the Windows installer already owns.
- **Kill any process listening on the port**: rejected because it is broader and
  riskier than managing the install-local PM2 app entry and validating the
  versioned health response.

## Consequences

- + Windows updates cannot be marked healthy by a stale old server process.
- + Rollback uses the same app-local PM2 ownership model as installer repair and
  startup helpers.
- + A failed Windows restart no longer makes the running process claim the new
  version before that version is actually serving requests.
- - The Windows restart script is slightly more specific to the release version
  it is activating.
- ~ macOS update behavior is intentionally unchanged.

## References

- [ADR-0054: Adopt Mac installer and release channels](0054-adopt-mac-installer-and-release-channels.md)
- [ADR-0063: Adopt per-user Windows installer](0063-adopt-per-user-windows-installer.md)
- [Deployment and Operations](../spec-deployment.md)
- [Backend Services](../spec-backend-services.md)
- [Testing and CI/CD](../spec-testing.md)
