---
id: 0048
title: Serve the V2 web app from a Vite build
status: Accepted
date: 2026-05-11
supersedes: []
superseded-by: null
tags: []
affects:
  - .env.example
  - .github/workflows/test.yml
  - .gitignore
  - package.json
  - package-lock.json
  - server.ts
  - src/config/index.ts
  - src/middleware/security.ts
  - src/services/updateService.ts
  - src/services/webBuildService.ts
  - src/types/index.ts
  - test/frontendRoutes.test.ts
  - test/updateService.test.ts
  - test/webBuildService.test.ts
  - web/AgentCockpitWeb/index.html
  - web/AgentCockpitWeb/vite.config.ts
  - web/AgentCockpitWeb/tsconfig.json
  - web/AgentCockpitWeb/src/main.jsx
  - web/AgentCockpitWeb/src/usageProjection.ts
  - public/v2/index.html
  - public/v2/README.md
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-coverage.md
  - docs/spec-frontend.md
  - docs/spec-server-security.md
  - docs/spec-deployment.md
  - docs/spec-testing.md
---

## Context

The V2 web UI is the default Agent Cockpit browser interface. Before this decision it is served directly from `public/v2/` as browser-loaded scripts: React, ReactDOM, `@babel/standalone`, markdown parsing, and sanitization are loaded from CDNs, JSX files are transpiled in the browser, and application modules communicate through `window.*` globals plus script order in `public/v2/index.html`.

That arrangement keeps static serving simple, but it leaves the largest UI surface mostly outside the compiler and build graph. Runtime-only failures can come from script order drift, missing globals, JSX syntax errors, dependency changes on CDNs, and API or stream-event shape changes that root TypeScript cannot see.

Daron's current development model uses two Agent Cockpit environments: a stable `agent-cockpit` instance edits source files behind `agent-cockpit-dev`, and the developer restarts `agent-cockpit-dev` when code changes need to be picked up. The new build architecture must preserve that operational shape. A required separate Vite development server would add moving parts that do not fit the normal workflow for this repository.

## Decision

The V2 web UI is built with Vite and served as static assets by the same Express server that owns the API, auth routes, WebSocket streaming, and mobile PWA static files.

Development and production use the same serving architecture:

```text
Browser -> Express server
  /v2/     -> built V2 web UI static assets
  /mobile/ -> built mobile PWA static assets
  /api/    -> backend API
  /auth/   -> auth routes
  WS       -> backend WebSocket streaming
```

The normal development workflow does not require a separate Vite dev server. Instead, server startup runs a web-build preflight before binding the HTTP port. The preflight detects a missing or stale V2 build, runs `npm run web:build`, writes a build marker, and then lets Express serve the generated `/v2/` assets. If the build is already fresh, startup skips the build.

Self-update also runs the V2 web build explicitly after dependency installation and before the PM2 restart. Startup preflight remains a safety net for manual git operations, interrupted updates, and missing generated assets.

Generated V2 build artifacts are not committed by default. The source of truth for the V2 web app moves to a Vite source tree, while Express serves the generated output.

## Alternatives Considered

- **Keep browser Babel and globals**: Rejected because it leaves the main UI outside the build graph and keeps module dependencies implicit.
- **Require a separate Vite dev server for development**: Rejected for the normal workflow because `agent-cockpit-dev` should use the same one-server architecture as production. A dev server can still be added later as an optional convenience, but it is not the baseline.
- **Commit generated Vite assets**: Rejected because generated files would add noisy diffs and merge friction. Startup preflight and self-update builds provide a better fit for this private deployable app.
- **Split production frontend hosting into a separate service or CDN**: Rejected because Agent Cockpit's deployment model is intentionally local and tunnel-friendly. One Express server remains simpler to operate.

## Consequences

- + V2 gets a real dependency graph, bundling, and typecheck/build gates.
- + Development and production keep one Express-served frontend/backend architecture.
- + Browser startup no longer depends on CDN React or browser-side Babel compilation.
- + Self-update can fail before restart when the web build is broken, making update failures clearer.
- - Cold start can take longer when the web build is missing or stale.
- - Startup now depends on a local Node build toolchain, so build failures must be surfaced clearly.
- ~ Optional hot reload would require an additional dev-server path later, but it is intentionally outside this baseline.

## References

- GitHub issue #290
- `docs/spec-frontend.md`
- `docs/spec-server-security.md`
- `docs/spec-deployment.md`
- `docs/spec-testing.md`
