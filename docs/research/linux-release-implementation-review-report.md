# Linux Release Implementation Review Report

Date: 2026-05-20

This report records the review cycles requested for the Linux release support
implementation. The implementation target is Ubuntu 24.04 LTS x64/glibc first.
Alpine/musl, NixOS, WSL, Linux arm64, and 32-bit Linux remain unsupported until
a later tested decision changes the support matrix.

Phase 0 was repository/release architecture discovery only. No code or docs were
changed in that phase, but it is included here so every named phase has 10
recorded review cycles.

## Phase 0 - Release Architecture Discovery

| Cycle | Items found | Items implemented |
|---|---|---|
| 1 | No implementation item. Reviewed existing macOS and Windows release paths, installer scripts, package manifest generation, update service activation, and release workflow shape. | No code change. Discovery established the Linux work needed installer, package, updater, CI, docs, and ADR coverage. |
| 2 | No implementation item. Confirmed the existing package tarball source is platform-neutral because runtime source and prebuilt web/mobile assets are not OS-specific. | No code change. This informed the decision to add a distinct Linux manifest artifact entry using the same tarball bytes. |
| 3 | No implementation item. Confirmed Windows uses versioned `appDir` activation while macOS uses POSIX `current` symlink activation. | No code change. This informed the Linux choice to reuse the macOS symlink activation model. |
| 4 | No implementation item. Confirmed release packaging already emits installer assets and SHA256 sums. | No code change. This informed the Linux installer asset addition. |
| 5 | No implementation item. Confirmed updater private runtime support was platform-specific and needed Linux archive selection. | No code change. This informed the Linux Node.js `tar.xz` runtime implementation. |
| 6 | No implementation item. Confirmed Linux support needed an explicit platform matrix because glibc and musl are materially different runtime targets. | No code change. This informed the Ubuntu 24.04 LTS x64/glibc target and unsupported-platform list. |
| 7 | No implementation item. Confirmed release smoke coverage existed for Windows but not Linux. | No code change. This informed the `linux-smoke` workflow job. |
| 8 | No implementation item. Confirmed specs and deploy docs are the source of truth for release behavior. | No code change. This informed the Phase 4 docs scope. |
| 9 | No implementation item. Confirmed mobile PWA impact was release-packaging verification rather than mobile app behavior. | No code change. This informed the mobile spec wording. |
| 10 | No implementation item. Confirmed an ADR was warranted because the change crosses installer, updater, package, CI, and docs boundaries and defines a support matrix. | No code change. This informed ADR-0071. |

## Phase 1 - Linux Installer And Package Artifacts

| Cycle | Items found | Items implemented |
|---|---|---|
| 1 | Medium impact: the Linux installer could fall back to a generic `app-tarball` if the manifest did not contain a Linux artifact, which could accept a stale or non-Linux manifest. | Added strict Linux release artifact selection in `scripts/install-linux.sh`: `platform: "linux"` and `format: "tar.gz"` are required. |
| 2 | Medium impact: Alpine/musl systems would fail late when using the official glibc-linked Node.js runtime. | Added early musl detection through `ldd --version` and a clear unsupported-platform error. |
| 3 | Medium impact: a manifest with no Linux tarball would fail through a raw Node expression error. | Added `json_read_required` and a user-facing "Release manifest does not include a Linux app tarball artifact." error. |
| 4 | No medium/high-impact items in shell syntax review. | No implementation needed. Verified `bash -n scripts/install-linux.sh`. |
| 5 | No medium/high-impact items in release-package manifest review after Linux artifact additions. | No implementation needed. Verified package tests cover Linux tarball and installer artifacts. |
| 6 | No medium/high-impact items in static Linux installer coverage review. | No implementation needed. Verified `test/linuxInstallerScript.test.ts`. |
| 7 | No medium/high-impact items in macOS/Windows artifact preservation review. | No implementation needed. Existing macOS tarball and Windows ZIP/installer artifacts remain covered. |
| 8 | No medium/high-impact items in prerequisite and runtime download review. | No implementation needed. Linux prerequisites and Node.js `tar.xz` checksum flow are documented and statically covered. |
| 9 | No medium/high-impact items in production/dev channel parity review. | No implementation needed. Both channels write `.env`, PM2 config, install metadata, and wait for setup. |
| 10 | No medium/high-impact items in checksum and package-smoke review. | No implementation needed. Focused release package smoke passed. |

## Phase 2 - Linux Updater And Runtime Support

| Cycle | Items found | Items implemented |
|---|---|---|
| 1 | Medium impact: the updater rejected missing Linux release artifacts only implicitly; there was no focused regression test. | Added `test/updateService.test.ts` coverage that rejects Linux production updates when the manifest lacks a Linux tarball artifact. |
| 2 | No medium/high-impact items in Linux artifact selection review. | No implementation needed. Linux updater selection is strict to `platform: "linux"` and `format: "tar.gz"`. |
| 3 | No medium/high-impact items in Linux private Node runtime review. | No implementation needed. Linux uses Node.org `linux-x64.tar.xz` and `tar -xJf`. |
| 4 | No medium/high-impact items in macOS fallback compatibility review. | No implementation needed. macOS still accepts the platformed Darwin tarball or legacy unplatformed app tarball. |
| 5 | No medium/high-impact items in Windows ZIP path review. | No implementation needed. Windows still selects ZIP artifacts and keeps versioned `appDir` activation. |
| 6 | No medium/high-impact items in symlink activation review. | No implementation needed. Linux uses the existing POSIX `current` symlink switch path. |
| 7 | No medium/high-impact items in unsupported Linux arch review. | No implementation needed. Linux private runtime updates reject non-x64 architectures. |
| 8 | No medium/high-impact items in checksum/download sequencing review. | No implementation needed. Manifest, archive, and private runtime checksum verification remain in place. |
| 9 | No medium/high-impact items in rollback/restart script review. | No implementation needed. Linux uses the POSIX restart/rollback script path shared with macOS. |
| 10 | No medium/high-impact items in full updater suite review. | No implementation needed. `test/updateService.test.ts` passed. |

## Phase 3 - Release Workflow And CI Smoke Coverage

| Cycle | Items found | Items implemented |
|---|---|---|
| 1 | Medium impact: the Windows packaging smoke check still asserted only the old artifact set, so Linux artifacts could be omitted without failing that smoke job. | Updated the Windows smoke manifest assertion to require macOS, Linux, and Windows app/installer artifacts. |
| 2 | No medium/high-impact items in Linux smoke job dependency review. | No implementation needed. The publish job depends on both `windows-smoke` and `linux-smoke`. |
| 3 | No medium/high-impact items in Linux package smoke ordering review. | No implementation needed. Linux builds web/mobile assets before packaging and before installer exercise. |
| 4 | No medium/high-impact items in Linux installer exercise review. | No implementation needed. The Linux smoke job runs `install-linux.sh --channel dev`, probes `/auth/setup`, and checks Install Doctor readiness. |
| 5 | No medium/high-impact items in Install Doctor coverage review. | No implementation needed. Linux smoke checks `node`, `npm`, and `pm2`. |
| 6 | No medium/high-impact items in PM2 cleanup review. | No implementation needed. Linux smoke deletes the PM2 app and kills PM2 on exit. |
| 7 | No medium/high-impact items in release asset upload review. | No implementation needed. `install-linux.sh` is included in release uploads. |
| 8 | No medium/high-impact items in workflow static-test review. | No implementation needed. `test/releaseWorkflow.test.ts` covers Linux smoke and upload behavior. |
| 9 | No medium/high-impact items in shell/YAML syntax review at this phase. | No implementation needed. `bash -n scripts/install-linux.sh` and workflow static tests passed. |
| 10 | No medium/high-impact items in package workflow parity review. | No implementation needed. Windows and Linux smoke checks both assert the full platform artifact set. |

## Phase 4 - Specs, ADR, Public Docs, And Agent Guidance

| Cycle | Items found | Items implemented |
|---|---|---|
| 1 | Medium impact: public docs initially did not give Linux users a release install entry point or support-matrix caveat. | Updated `README.md`, `ONBOARDING.md`, `docs/deploy/README.md`, and added `docs/deploy/linux.md`. |
| 2 | Medium impact: canonical docs still had macOS/Windows-only wording in several release/install areas. | Updated deployment, backend services, data models, mobile PWA, server security, product positioning, release workflow, and update docs for Linux. |
| 3 | Medium impact: `docs/spec-testing.md` described updater coverage as macOS/Windows-only and omitted Linux tarball/runtime tests. | Updated the `test/updateService.test.ts` spec row to include strict Linux tarball selection, missing-artifact rejection, Linux private Node `tar.xz`, and Linux symlink activation. |
| 4 | No medium/high-impact items in ADR frontmatter/path review. | No implementation needed. `npm run adr:lint` passed. |
| 5 | No medium/high-impact items in API spec drift review. | No implementation needed. `npm run spec:drift` passed. |
| 6 | No medium/high-impact items in stale platform-wording review. | No implementation needed. Remaining macOS/Windows matches were intentional Windows-only or historical references. |
| 7 | No medium/high-impact items in deploy-doc link review. | No implementation needed. `docs/deploy/README.md` links the Linux install guide. |
| 8 | No medium/high-impact items in mobile PWA impact review. | No implementation needed. No mobile app behavior changed; specs note installers verify the packaged mobile shell on macOS/Linux/Windows. |
| 9 | No medium/high-impact items in project guidance review. | No implementation needed. `AGENTS.md` and `docs/agent-project-memory.md` record the Linux support matrix and preservation rules. |
| 10 | No medium/high-impact items in final Phase 4 docs diff review. | No implementation needed. Docs remained consistent after the focused spec-testing patch. |

## Final Version Review

| Cycle | Items found | Items implemented |
|---|---|---|
| 1 | Medium impact: the Linux smoke workflow's Node HTTP Install Doctor check used asynchronous callbacks without a reliable failure boundary, so the step could exit before validation completed. | Replaced it with a here-doc Node script that waits for the response, checks HTTP status, validates `node`/`npm`/`pm2`, and exits nonzero on timeout or parse/assertion errors. Updated `test/releaseWorkflow.test.ts`. |
| 2 | No medium/high-impact items in workflow parser review after the smoke assertion fix. | No implementation needed. `test/releaseWorkflow.test.ts`, Ruby YAML parse, `bash -n`, and `git diff --check` passed. |
| 3 | No medium/high-impact items in focused Linux installer/package/updater review. | No implementation needed. Focused Linux installer, release package, and Linux updater tests passed. |
| 4 | No medium/high-impact items in generated release manifest smoke review. | No implementation needed. The smoke package contains Darwin tarball, Linux tarball entry, Windows ZIP, all three installer artifacts, and checksums for all installer files. |
| 5 | No medium/high-impact items in full updater, TypeScript, and maintainability review. | No implementation needed. `test/updateService.test.ts`, `npm run typecheck`, and `npm run maintainability:check` passed. |
| 6 | No medium/high-impact items in web/mobile release asset review. | No implementation needed. Web/mobile typechecks and builds passed, and the web bundle budget passed. |
| 7 | Non-Linux finding: the first full Jest run hit a transient `test/workspaceContext.service.test.ts` timing/order failure outside the Linux release surface. | No code change was made. The targeted test passed in isolation, and the full suite passed on rerun. |
| 8 | No medium/high-impact items in full Jest rerun review. | No implementation needed. The second `npm test` run passed. |
| 9 | No medium/high-impact items in working-tree artifact review. | No implementation needed. Generated web/mobile build outputs were not left as tracked changes. |
| 10 | This report and documentation-inventory update were required by the goal. | Added this report and linked it from the spec index/coverage inventory. |

## Verification Summary

Passed:

- `bash -n scripts/install-linux.sh`
- Ruby YAML parse for `.github/workflows/release.yml`
- `git diff --check`
- `npm test -- --runInBand test/linuxInstallerScript.test.ts test/releasePackage.test.ts`
- `npm test -- --runInBand test/releaseWorkflow.test.ts`
- `npm test -- --runInBand test/updateService.test.ts -t Linux`
- `npm test -- --runInBand test/updateService.test.ts`
- `npm run release:package -- --version 0.0.0-linux-final-smoke --source-ref HEAD --commit local --out-dir /tmp/agent-cockpit-linux-final-smoke`
- Generated manifest/checksum smoke check for macOS, Linux, and Windows artifacts
- `npm run adr:lint`
- `npm run spec:drift`
- `npm run typecheck`
- `npm run maintainability:check`
- `npm run web:typecheck`
- `npm run web:build`
- `npm run web:budget`
- `npm run mobile:typecheck`
- `npm run mobile:build`
- `npm test` on rerun

The first full `npm test` run failed once in an unrelated Workspace Context
timing/order assertion. The targeted test passed immediately afterward, and the
full suite passed on rerun.
