---
id: 0093
title: Make installer activation transactional and test production artifacts
status: Accepted
date: 2026-10-27
supersedes: []
superseded-by: null
tags: [installation, releases, testing]
affects:
  - scripts/install-macos.sh
  - scripts/install-linux.sh
  - scripts/install-windows.ps1
  - scripts/run-install-smoke.js
  - .github/workflows/release.yml
  - .github/workflows/install-smoke.yml
  - .github/workflows/install.yml
  - test/installerBehavior.test.ts
  - test/e2e/install.ui.pw.ts
  - docs/spec-deployment.md
  - docs/spec-testing.md
---

## Context

Repair reruns could replace active release files before dependencies were ready.
POSIX installers also replaced secrets and onboarding timestamps. Release smoke
coverage exercised dev checkouts on Windows/Linux, rather than the production
archives, and omitted native macOS installation.

## Decision

Keep standalone platform-native installers and current-user PM2 supervision.
Prepare production releases in unique sibling directories without modifying the
active release. Preserve custom config, secrets, data, and onboarding. Snapshot
activation metadata, helpers, and startup registration before switching. Require
the expected `/api/chat/version` before accepting startup; restore prior
activation on failure. Mutable user data is not reverted by binary rollback.

Use executable Jest tests for installer behavior and isolated native smoke for
real runtime/PM2/package compatibility. Build one candidate, run its bundled
installers and archives on native runners, and publish those same artifacts.
Test system and private runtimes before release; use a smaller PR matrix.
Browser checks use synthetic owner credentials and no upstream account.

## Alternatives Considered

- **Keep source-string tests and dev smoke**: does not prove production package
  extraction, native dependencies, repairs, or first-run readiness.
- **Unify installers in a Node application**: adds a bootstrap dependency before
  Node is available and changes the existing platform-specific installation model.
- **Replace active files in place**: makes preparation failures destructive,
  especially for same-version repairs and locked Windows runtime files.

## Consequences

- Repairs preserve the working release through preparation and can restore it
  after failed activation without changing persisted user data formats.
- Native CI costs more than source-only tests. Same-version repairs retain
  previous release directories instead of deleting potentially active files.
- The test fixture transport bypasses GitHub release downloads only for explicit
  test invocations. Node runtime downloads still use the official source.
- Startup registration checks do not prove a real login/reboot. That validation
  remains a disposable-machine release checklist.

## References

- [Deployment specification](../spec-deployment.md)
- [Testing specification](../spec-testing.md)
- [Release procedure](../release-workflow.md)
- ADR-0054, ADR-0063, ADR-0071, and ADR-0075 retain platform and startup ownership.
