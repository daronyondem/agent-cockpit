---
id: 0050
title: Serve mobile PWA from ignored build output
status: Accepted
date: 2026-05-11
supersedes: []
superseded-by: null
tags:
  - mobile
  - build
  - deployment
affects:
  - .gitignore
  - server.ts
  - src/services/mobileBuildService.ts
  - mobile/AgentCockpitPWA/vite.config.ts
  - test/frontendRoutes.test.ts
  - test/mobileBuildService.test.ts
  - docs/spec-mobile-pwa.md
  - docs/spec-deployment.md
  - docs/spec-server-security.md
  - docs/spec-backend-services.md
  - docs/spec-coverage.md
---

## Context

ADR-0025 chose the browser PWA as the sole supported mobile client and emitted
its Vite build into `public/mobile/`. ADR-0049 added startup and self-update
build preflight for the mobile app so source changes are rebuilt before the
server starts or restarts.

That still left generated mobile files in a tracked source tree. The current
build is deterministic, but future Vite/plugin/icon changes could still create
tracked-output diffs during normal startup, self-update, or local verification.
The desktop V2 build already avoids this by serving ignored output from
`public/v2-built/`.

## Decision

Emit the mobile PWA build to ignored `public/mobile-built/` instead of
tracked `public/mobile/`.

`MobileBuildService` uses `public/mobile-built/` as its build directory and
marker location. `mobile/AgentCockpitPWA/vite.config.ts` writes production
assets there by default. `server.ts` explicitly mounts that build directory at
`/mobile` before the general `public/` static mount, so the public URL remains
`/mobile/` while generated files stay out of source control.

The tracked install metadata and icon sources remain in
`mobile/AgentCockpitPWA/public/`; Vite copies them into the ignored output
during each mobile build.

## Alternatives Considered

- **Keep generated assets in `public/mobile/`**: rejected because it preserves
  the risk that normal build-tool changes create tracked generated diffs.
- **Serve the PWA directly from `mobile/AgentCockpitPWA/dist/`**: rejected
  because it puts runtime artifacts inside the source package and diverges from
  the existing top-level server-owned asset layout.
- **Move all static assets under `public/mobile-built/` source files**:
  rejected because install metadata and icons are source inputs, not generated
  output, and should remain near the mobile package that owns them.

## Consequences

- + Startup, self-update, and local `npm run mobile:build` no longer modify
  tracked generated PWA files.
- + Desktop V2 and mobile PWA builds now follow the same source-versus-output
  convention: source packages are tracked, served build directories are ignored.
- ~ `/mobile/` remains the public route, but it is now served by an explicit
  mount from `public/mobile-built/` instead of falling through the shared
  `public/` static directory.
- - Deployments that previously inspected `public/mobile/` directly must inspect
  `public/mobile-built/` for generated mobile output.

## References

- [ADR-0025: Use mobile PWA as sole mobile client](0025-use-mobile-pwa-as-sole-mobile-client.md)
- [ADR-0049: Retire V2 globals and build mobile assets during updates](0049-retire-v2-globals-and-build-mobile-assets-during-updates.md)
- [Mobile PWA Client](../spec-mobile-pwa.md)
- [Deployment and Operations](../spec-deployment.md)
