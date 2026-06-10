---
id: 0086
title: Remove the archived public v2 placeholder tree
status: Accepted
date: 2026-06-10
supersedes: []
superseded-by: null
tags: [adr, frontend, testing]
affects:
  - scripts/adr-lint.js
  - test/adrLint.test.ts
  - test/frontendRoutes.test.ts
  - docs/spec-frontend.md
  - docs/spec-testing.md
  - AGENTS.md
  - docs/agent-project-memory.md
  - improvements.md
---

## Context

ADR-0049 retired the old Browser-Babel `public/v2/` source tree after the web
app moved to the Vite source under `web/AgentCockpitWeb/` and the generated
runtime build under `public/v2-built/`. The remaining tracked files under
`public/v2/` were placeholders kept only because older ADR `affects:` entries
still name those paths.

ADR lint validates every non-historical `affects:` path with `fs.existsSync`.
Tagging every ADR that mentions `public/v2/` as `historical` would edit
accepted records and would skip validation for unrelated live paths in the same
ADRs. Keeping placeholder files preserves lint compatibility, but it leaves a
retired source tree in the working tree and in release packages even though
runtime serving always resolves `/v2/` from `public/v2-built/`.

## Decision

Delete the archived `public/v2/` placeholder tree entirely.

Teach `scripts/adr-lint.js` an explicit per-path retired-prefix allowance for
historical references under `public/v2/`. The allowance applies only to
`affects:` entries that start with the trailing-slash prefix `public/v2/`, so
live paths such as `public/v2-built/` keep validating. The existing
`historical` tag behavior remains unchanged for ADRs that are archival
snapshots as a whole.

ADR-0049 stays accepted and unchanged. This ADR completes its retirement path by
replacing placeholder files with lint-level support for immutable historical
path references.

## Alternatives Considered

- **Tag all `public/v2/`-referencing ADRs as `historical`**. Rejected because
  it would edit accepted ADR content and because the tag exempts every
  `affects:` path in an ADR, including paths that are still live and should keep
  validating.
- **Keep the placeholder tree**. Rejected because it preserves dead Browser-Babel
  paths in source control and release packages solely to satisfy a tooling
  limitation.
- **Remove `affects:` existence validation**. Rejected because the check still
  catches real drift for current contracts, specs, scripts, and source files.

## Consequences

- + The repository no longer carries the archived `public/v2/` source or
  placeholder files.
- + Immutable older ADRs can keep precise historical `affects:` entries without
  weakening validation for other live paths in those ADRs.
- - New ADRs could accidentally reference a path under the retired `public/v2/`
  prefix and pass existence validation, so the prefix list must stay small and
  review-visible.
- ~ `/v2/src/*` remains guarded as 404 in the server route order for cached or
  stale client URLs.

## References

- [Issue #420](https://github.com/daronyondem/agent-cockpit/issues/420)
- [ADR-0048: Serve the V2 web app from a Vite build](0048-serve-the-v2-web-app-from-a-vite-build.md)
- [ADR-0049: Retire v2 globals and build mobile assets during updates](0049-retire-v2-globals-and-build-mobile-assets-during-updates.md)
- [spec-frontend.md](../spec-frontend.md)
- [spec-testing.md](../spec-testing.md)
