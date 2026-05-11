---
id: 0049
title: Retire V2 globals and build mobile assets during updates
status: Accepted
date: 2026-05-11
supersedes: []
superseded-by: null
tags: [frontend, build, update]
affects:
  - web/AgentCockpitWeb/src/main.jsx
  - web/AgentCockpitWeb/src/shell.jsx
  - web/AgentCockpitWeb/src/syntaxHighlight.js
  - web/AgentCockpitWeb/vite.config.ts
  - public/v2/README.md
  - public/v2/src/shell.jsx
  - src/services/webBuildService.ts
  - src/services/mobileBuildService.ts
  - src/services/updateService.ts
  - server.ts
  - test/frontendRoutes.test.ts
  - test/mobileBuildService.test.ts
  - docs/spec-frontend.md
  - docs/spec-deployment.md
  - docs/spec-backend-services.md
---

## Context

ADR-0048 moved the V2 browser UI behind a Vite build, but the first migration kept
the old script-order contract alive by publishing React, stores, screens, helpers,
and app services on `window.*`. That compatibility layer made the bundle hard to
split safely because dependency edges were implicit. It also left the old
`public/v2/` Browser-Babel implementation in the repository, which kept historical
ADR paths valid but made it easy to confuse archived source with active source.

The self-update path also rebuilt the desktop V2 assets only. `/mobile/` is served
from generated `public/mobile/` assets, so pulling mobile source changes without
rebuilding those assets can leave production serving stale mobile code until a
manual build runs.

## Decision

The V2 frontend uses ES module imports/exports for app-local dependencies. The
Vite entry imports CSS, initializes the tab indicator, and imports the shell; it
does not publish app modules or bundled third-party libraries on `window`. Heavy
screens are loaded through `React.lazy`, and Vite uses explicit code-splitting
groups for React and markdown/highlight dependencies.

The old `public/v2/` Browser-Babel source tree is retired. Only small placeholder
files remain for paths referenced by immutable historical ADR `affects`
frontmatter. Runtime source lives under `web/AgentCockpitWeb/`; runtime output is
`public/v2-built/`.

The build preflight pattern now covers the mobile PWA as well as the desktop V2
web app. `MobileBuildService` reuses the same marker/freshness semantics as
`WebBuildService`, writes its marker to `public/mobile/.agent-cockpit-build.json`,
and stages mobile builds before replacing `public/mobile/`. Startup checks both
desktop and mobile assets unless `WEB_BUILD_MODE=skip`. Self-update installs
mobile dependencies, rebuilds desktop V2 assets, rebuilds mobile assets, and only
then verifies the PM2 interpreter and restarts.

## Alternatives Considered

- **Keep `window.*` compatibility until every V2 file is rewritten in TypeScript**:
  rejected because the compatibility layer was already the main blocker for
  reliable bundle splitting, and a full TypeScript rewrite is a separate product
  risk.
- **Keep the archived Browser-Babel files as full source snapshots**: rejected
  because they are no longer executable runtime source and duplicate active files.
  Placeholder paths preserve ADR lint without keeping stale implementation code.
- **Build mobile assets only in CI or only during self-update**: rejected because
  the same one-server startup guarantee should apply to both served web surfaces.
  Startup preflight also covers manual git operations and interrupted updates.
- **Run `npm audit fix --force` for audit findings**: rejected because direct
  patch/minor dependency bumps fixed the current audit without major-version churn.

## Consequences

- + The frontend dependency graph is explicit and can be reasoned about by Vite,
  tests, and future maintainers.
- + The V2 build no longer emits the large entry chunk warning after screen/vendor
  splitting and scoped highlight.js language registration.
- + Self-update and cold start now refresh every generated asset tree served by
  the backend.
- + `npm audit` is clean after patch/minor dependency updates.
- - Startup can spend additional time building `public/mobile/` when mobile source
  changes or assets are missing.
- - The old `public/v2/` implementation is no longer available as an in-repo code
  snapshot; historical context must come from Git history and ADRs.
- ~ `WEB_BUILD_MODE=skip` remains the escape hatch for tests and special
  deployments that intentionally bypass asset preflight.

## References

- ADR-0048: Serve the V2 web app from a Vite build.
- GitHub issue #290.
- `docs/spec-frontend.md`
- `docs/spec-deployment.md`
- `docs/spec-backend-services.md`
