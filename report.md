# Follow-Up Maintainability Implementation Report

## Summary

Implemented the four requested follow-up improvements:

- Generated mobile PWA assets now build into ignored `public/mobile-built/` instead of tracked `public/mobile/`.
- Chat-route test teardown now waits for durable stream-job cleanup writes, removing the unrelated late-console cleanup warning.
- The V2 `fileLinks` helper is now TypeScript with explicit link-resolution contracts.
- CI now enforces a V2 web bundle-size budget after `npm run web:build`.

All verification passed after the 10 review cycles.

## 1. Mobile Generated Assets

Changed the mobile production build output from tracked `public/mobile/` to ignored `public/mobile-built/`.

Implemented:

- `mobile/AgentCockpitPWA/vite.config.ts` now emits to `../../public/mobile-built`.
- `src/services/mobileBuildService.ts` now uses `public/mobile-built/` and its marker as the default mobile build directory.
- `server.ts` explicitly mounts `mobileBuildService.getBuildDir()` at `/mobile` before the generic `public/` static mount.
- `.gitignore` ignores generated `public/mobile/*`, `public/mobile-built/`, and mobile staging directories while allowing `public/mobile/.adr-placeholder`.
- Removed the tracked generated `public/mobile` HTML, manifest, icons, CSS, and JS.
- Added `public/mobile/.adr-placeholder` only so historical ADR affected paths continue to validate.
- Added ADR-0050 documenting the ignored mobile output decision.
- Updated README and specs for the new output path and serving model.

Tests:

- `test/mobileBuildService.test.ts` now checks the ignored output path.
- `test/frontendRoutes.test.ts` now builds/mounts `public/mobile-built/` and verifies `/mobile/.adr-placeholder` is not served.

## 2. Chat Test-Harness Cleanup

Fixed the late Jest console warning by tightening test teardown rather than changing product runtime behavior.

Implemented:

- `test/helpers/chatEnv.ts` now waits for the stream-job registry lock by reading through `env.streamJobs.listActive()` before removing the scratch data directory.
- This serializes teardown behind any in-flight route-finally durable-job cleanup write.
- `docs/spec-testing.md` now documents that chat route teardown waits for active streams, session finalizers, and durable stream-job registry mutations.

Result:

- Focused chat route suites passed without the previous late cleanup warning.
- Full Jest suite passed with only Node's expected VM Modules experimental warning from the Jest launcher.

## 3. V2 TypeScript Migration Slice

Migrated the low-risk `fileLinks` frontend helper from JavaScript to TypeScript.

Implemented:

- Replaced `web/AgentCockpitWeb/src/fileLinks.js` with `web/AgentCockpitWeb/src/fileLinks.ts`.
- Added explicit `ResolvedLocalFileHref` and `ResolvedConversationArtifactHref` interfaces.
- Kept the existing runtime behavior for workspace paths, conversation artifacts, line/column suffix stripping, URL decoding, and traversal rejection.
- Updated `web/AgentCockpitWeb/src/shell.jsx` to import the typed helper.
- Updated `test/fileLinks.test.ts` and specs to reference `fileLinks.ts`.

Verification:

- `test/fileLinks.test.ts` passed.
- `npm run web:typecheck` passed.
- `npm run web:build` passed.

## 4. V2 Bundle Budget

Added a CI-enforced V2 bundle-size budget.

Implemented:

- Added `scripts/check-web-bundle-size.js`.
- Added `npm run web:budget`.
- Added the budget check to `.github/workflows/test.yml` immediately after `npm run web:build`.
- Added `test/webBundleBudget.test.ts` for hashed filename normalization, named/total budget violations, empty build-output rejection, and temp-dir cleanup.
- Updated specs and README to document the budget check.

Current budget result:

- JS total: `763.9 KiB / 850.0 KiB`.
- CSS total: `186.4 KiB / 230.0 KiB`.

The checker also enforces named chunk budgets for the main entry, vendor chunks, lazy route chunks, runtime, tooltip, and CSS.

## Review Cycles

Completed 10 review + fix cycles after the initial implementation:

1. Found and fixed temp directory cleanup in `test/webBundleBudget.test.ts`.
2. Reviewed mobile output path references; no code changes needed.
3. Added a static route assertion proving `public/mobile/.adr-placeholder` is not served.
4. Reviewed CI/script wiring; no code changes needed.
5. Reviewed TypeScript helper imports and Jest/Vite resolution; no code changes needed.
6. Hardened `web:budget` so empty JS/CSS asset directories fail instead of passing with zero totals.
7. Reviewed chat teardown behavior; no additional changes needed.
8. Swept for stale generated-output assumptions; only immutable historical ADR text remains.
9. Verified `.gitignore` behavior with `git check-ignore --no-index`; no code changes needed.
10. Final static sweep found no remaining medium/high impact fixes.

## Final Verification

Commands run after all implementation and review-cycle fixes:

- `npm run typecheck`: passed.
- `npm run web:typecheck`: passed.
- `npm run mobile:typecheck`: passed.
- `npm run web:build`: passed.
- `npm run web:budget`: passed.
- `npm run mobile:build`: passed.
- `npm test`: passed, 71 suites / 1915 tests.
- `npm run adr:lint`: passed, all 49 ADRs valid.
- `npm audit`: passed, 0 vulnerabilities.
- `npm audit --prefix mobile/AgentCockpitPWA`: passed, 0 vulnerabilities.

## Notes

- `docs/adr/0049-retire-v2-globals-and-build-mobile-assets-during-updates.md` still contains historical `public/mobile/` text. It is an accepted ADR, so the content was left immutable. ADR-0050 records the new decision.
- `public/mobile/` now contains only `.adr-placeholder`; generated mobile assets are in ignored `public/mobile-built/`.
- No medium/high impact follow-up fixes remained after the 10 review cycles.
