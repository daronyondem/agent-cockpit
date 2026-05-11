# Post-Issue 290 Improvement Plan

## Goal

Move the V2 web app from "Vite-built but still global-compatible" to a proper module-based frontend, reduce bundle size, remove archived runtime confusion, address dependency security, and decide whether self-update should also build mobile assets.

## Recommended Order

1. Convert `window.*` globals to imports/exports.
2. Introduce code splitting after module dependencies are explicit.
3. Clean up `public/v2/` once no active behavior depends on it.
4. Address npm audit findings.
5. Decide and implement mobile build behavior in self-update.

This order matters because bundle splitting and old-tree removal are both safer once the dependency graph is explicit.

## Phase 1: Module Graph Conversion

Objective: replace temporary `window.*` compatibility in `web/AgentCockpitWeb/src/main.jsx` with real ES module imports/exports.

Work plan:

1. Inventory current globals:
   - `AgentApi`
   - `StreamStore`
   - `PlanUsageStore`
   - `KiroPlanUsageStore`
   - `CodexPlanUsageStore`
   - `CliUpdateStore`
   - `FileLinkUtils`
   - `UsageProjection`
   - `SynthesisAtlas`
   - UI globals like `Ico`, `Tip`, `useDialog`, `useToasts`, screens, and modals.

2. Convert in dependency order:
   - Pure helpers first: `fileLinks`, `usageProjection`, `synthesisAtlas`.
   - Stores next: plan usage stores, CLI update store, API client, stream store.
   - UI primitives next: icons, dialog, toast, tooltip, chip renderers.
   - Leaf screens next: KB browser, Files browser, Settings, Memory Review.
   - Shell last.

3. For each module:
   - Add named exports.
   - Replace downstream `window.X` usage with imports.
   - Keep a temporary `window.X = X` only if tests or untouched modules still need it.
   - Remove the temporary assignment once no references remain.

4. Add an enforcement test:
   - `main.jsx` should not assign frontend app modules to `window` except for a short allowlist, if any.
   - `rg "window\\." web/AgentCockpitWeb/src` should trend downward and eventually only contain legitimate browser APIs.

Acceptance criteria:

- `main.jsx` imports the app graph directly.
- No app-local module dependency relies on script order.
- `window.*` compatibility is removed or reduced to an explicitly documented allowlist.
- Existing V2 visual behavior remains unchanged.

Verification:

- `npm run web:typecheck`
- `npm run web:build`
- `npm test -- --runTestsByPath test/frontendRoutes.test.ts test/streamStore.test.ts test/planUsageStores.test.ts test/fileLinks.test.ts test/synthesisAtlas.test.ts test/usageProjection.test.ts`
- Full `npm test` before merge.

## Phase 2: Code Splitting

Objective: remove or materially reduce the large Vite entry chunk warning.

Work plan:

1. Inspect build output:
   - Run `npm run web:build`.
   - Identify heavy chunks and entry dependencies.
   - Confirm whether markdown/highlight/sanitization or large screens dominate.

2. Split by app surfaces:
   - Lazy-load `KbBrowser`.
   - Lazy-load `FilesBrowser`.
   - Lazy-load `SettingsScreen`.
   - Lazy-load `WorkspaceSettingsPage`.
   - Lazy-load `MemoryReviewPage`.
   - Keep chat shell, sidebar, API client, and stream store in the initial bundle.

3. Add loading states that match the existing utilitarian UI:
   - No marketing/loading splash.
   - Small inline busy states inside the main pane.

4. Consider vendor chunking only after route/screen splitting:
   - Avoid premature manual chunk config if dynamic imports solve the warning.
   - Add manual chunking only for stable heavy dependencies if needed.

Acceptance criteria:

- Vite build no longer warns about the main entry chunk, or the main chunk is meaningfully smaller with a documented reason if warning remains.
- Navigating to lazy-loaded surfaces works after refresh.
- No user-visible redesign.

Verification:

- `npm run web:build`
- Browser smoke test for `/v2/`.
- Existing frontend route/static tests.
- Add a test/static check that major screens are dynamically imported if we want a regression guard.

## Phase 3: Remove Archived `public/v2/` Tree

Objective: remove old Browser-Babel source without breaking ADR lint or historical documentation.

Work plan:

1. Audit ADR lint behavior:
   - Confirm how historical ADRs can retain removed paths.
   - Identify ADRs that reference `public/v2/src/*`.

2. Mark old ADRs appropriately:
   - Do not rewrite accepted ADR content.
   - Use the repo's supported historical tagging mechanism if existing lint rules allow it.
   - If the current lint model does not support this cleanly, first add a small ADR-lint enhancement to distinguish historical archived paths.

3. Remove old runtime tree:
   - Delete `public/v2/index.html`.
   - Delete `public/v2/src/**`.
   - Keep or remove `public/v2/README.md` depending on whether an empty marker is useful.
   - Confirm `/v2/src/*` remains 404.

4. Update docs:
   - Specs should say the Browser-Babel tree was removed.
   - Coverage docs should point only to `web/AgentCockpitWeb` and `public/v2-built`.

Acceptance criteria:

- `public/v2/src` no longer exists.
- ADR lint still passes.
- `/v2/` still serves built assets.
- `/v2/src/shell.jsx` returns 404.

Verification:

- `npm run adr:lint`
- `npm test -- --runTestsByPath test/frontendRoutes.test.ts`
- `npm run web:build`
- Full `npm test`.

## Phase 4: Npm Audit Remediation

Objective: resolve or explicitly document dependency vulnerabilities.

Work plan:

1. Run current audit:
   - `npm audit`
   - `npm audit --prefix mobile/AgentCockpitPWA`

2. Classify findings:
   - Runtime dependency vs dev-only.
   - Exploitable in this app vs theoretical.
   - Direct dependency vs transitive dependency.
   - Requires patch/minor/major upgrade.

3. Remediate low-risk updates first:
   - Patch/minor bumps.
   - Lockfile-only transitive updates if safe.
   - Avoid `npm audit fix --force` unless reviewed because it may introduce breaking major upgrades.

4. For unresolved findings:
   - Document package, severity, exposure, why not fixed now, and follow-up.

Acceptance criteria:

- `npm audit` has zero high vulnerabilities, or remaining high items have a documented non-exploitable rationale.
- Lockfiles are updated intentionally.
- Web/mobile builds still pass.

Verification:

- `npm audit`
- `npm audit --prefix mobile/AgentCockpitPWA`
- `npm run typecheck`
- `npm run web:build`
- `npm run mobile:build`
- `npm test`

## Phase 5: Mobile Build In Self-Update

Objective: decide whether self-update should run `npm run mobile:build` in addition to `npm run web:build`.

Recommended decision: yes, if production serves generated `public/mobile/` and updates can change mobile source. CI coverage catches breakage before merge, but self-update should produce the served assets after pulling new code.

Work plan:

1. Add `MobileBuildService` or generalize `WebBuildService`.
   - Prefer a generic build service only if it stays simple.
   - Otherwise add a focused `MobileBuildService` with the same marker/freshness pattern.

2. Hash inputs:
   - `mobile/AgentCockpitPWA/**`
   - `mobile/AgentCockpitPWA/package.json`
   - `mobile/AgentCockpitPWA/package-lock.json`

3. Startup behavior:
   - Option A: build mobile at startup too.
   - Option B: only build mobile during self-update and keep startup web-only.
   - Recommended: Option A for consistency, behind the same kind of skip mode to avoid test overhead.

4. Self-update sequence:
   - `git checkout main`
   - `git pull origin main`
   - root `npm install`
   - mobile `npm --prefix mobile/AgentCockpitPWA ci` or `install`
   - `npm run web:build`
   - `npm run mobile:build`
   - verify interpreter
   - PM2 restart

Acceptance criteria:

- Mobile generated assets are refreshed after self-update.
- Build failures stop restart.
- `/mobile/` behavior remains unchanged.

Verification:

- Add mobile build service tests.
- Update `test/updateService.test.ts`.
- `npm run mobile:typecheck`
- `npm run mobile:build`
- `npm test -- --runTestsByPath test/frontendRoutes.test.ts test/updateService.test.ts`

## Final Rollout

After all phases:

- Run full verification:
  - `npm run typecheck`
  - `npm run web:typecheck`
  - `npm run web:build`
  - `npm run mobile:typecheck`
  - `npm run mobile:build`
  - `npm test`
  - `npm run adr:lint`
  - `npm audit`
- Update specs and ADRs.
- Create a final migration report.
