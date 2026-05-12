# Mac Installer and Release Channel Implementation Plan

## Scope

This plan replaces the earlier issue #108 scope. The first install/release target is a Mac-first server agent that runs Agent Cockpit locally under PM2 and opens the browser for first-run setup. Production installs update from GitHub Releases. Dev installs track `main`.

## Current Architecture Notes

- The default V2 UI is now a Vite app under `web/AgentCockpitWeb/`, built to ignored `public/v2-built/` and served by Express at `/v2/`.
- The mobile PWA is built to ignored `public/mobile-built/` and served by Express at `/mobile/`.
- Startup preflight rebuilds missing or stale V2 and mobile assets through `WebBuildService` and `MobileBuildService` unless `WEB_BUILD_MODE=skip`.
- Self-update currently assumes the dev channel: pull `main`, install root/mobile dependencies, force web/mobile builds, verify PM2 interpreter, restart.
- Mutable data still lives under the app root `data/`, which is acceptable for dev installs but should be separated before production release artifact updates.

## Channel Model

### Production

- Source of truth: latest GitHub Release.
- Audience: normal end users.
- Installer downloads a release artifact and checksum.
- App updates check GitHub Releases, not tags and not `main`.
- Release artifacts include prebuilt `public/v2-built/` and `public/mobile-built/`.
- Startup build preflight remains a safety net, not the normal production path.

### Dev

- Source of truth: `main`.
- Audience: maintainers, testers, and contributors.
- Installer clones the repo and tracks `main`.
- App update can keep the existing git pull path.
- Startup and self-update builds stay active.

## Phase 0: Architecture Decision Record

Create an ADR for Mac installation and release channels.

Decision points:

- Mac is first supported installer target.
- PM2 remains the supported process manager.
- Production channel follows GitHub Releases.
- Dev channel follows `main`.
- Production release artifacts include built V2/mobile assets.
- Startup build preflight remains as fallback.
- Windows installer is intentionally out of scope for this phase.

Files likely affected:

- `docs/adr/*`
- `docs/spec-deployment.md`
- `docs/spec-backend-services.md`
- `docs/spec-server-security.md`
- `docs/spec-testing.md`

Verification:

```bash
npm run adr:new -- "Adopt Mac installer and release channels"
npm run adr:lint
```

## Phase 1: Data Directory Separation

Goal: make app code replaceable without moving or risking user data.

Add an app data root configuration, for example `AGENT_COCKPIT_DATA_DIR`, with current `data/` behavior preserved as the fallback for compatibility.

Mac production default:

- App root: `~/Library/Application Support/Agent Cockpit/current`
- Version roots: `~/Library/Application Support/Agent Cockpit/versions/<version>`
- Data root: `~/Library/Application Support/Agent Cockpit/data`

Move these mutable paths behind the data root:

- chat data (`data/chat`)
- Express sessions (`data/sessions`)
- auth owner/passkey/recovery state (`data/auth`)
- plan usage caches
- update restart script/logs
- install manifest

Implementation tasks:

1. Add config field for data root.
2. Pass data root into `ChatService`, auth setup, session store, plan usage services, and update restart log/script paths.
3. Keep existing defaults for dev and existing installs.
4. Add tests proving custom data root writes data outside app root.
5. Update specs and docs.

Verification:

```bash
npm run typecheck
npm test -- --runTestsByPath test/auth.test.ts test/chatService.conversations.test.ts test/updateService.test.ts
npm test
```

## Phase 2: Install Manifest

Goal: persist install channel/source metadata so `UpdateService` can choose the right path.

Add `InstallStateService` with a JSON file under the data root, for example `install.json`.

Production example:

```json
{
  "schemaVersion": 1,
  "channel": "production",
  "source": "github-release",
  "repo": "daronyondem/agent-cockpit",
  "version": "1.0.0",
  "installDir": "/Users/<user>/Library/Application Support/Agent Cockpit",
  "appDir": "/Users/<user>/Library/Application Support/Agent Cockpit/current",
  "dataDir": "/Users/<user>/Library/Application Support/Agent Cockpit/data",
  "installedAt": "2026-05-11T00:00:00.000Z",
  "welcomeCompletedAt": null
}
```

Dev example:

```json
{
  "schemaVersion": 1,
  "channel": "dev",
  "source": "git-main",
  "repo": "daronyondem/agent-cockpit",
  "branch": "main",
  "installedAt": "2026-05-11T00:00:00.000Z",
  "welcomeCompletedAt": null
}
```

Implementation tasks:

1. Add read/write service with default inference for existing installs.
2. Surface install channel in update status responses.
3. Add authenticated install/status endpoint.
4. Add tests for missing/corrupt/legacy install state.
5. Update contracts and specs.

## Phase 3: Manual GitHub Release Workflow

Goal: manually promote selected `main` state into production release artifacts.

Add `.github/workflows/release.yml` with `workflow_dispatch`.

Inputs:

- `version`
- `source_ref`, default `main`
- `prerelease`, default `false`

Workflow steps:

1. Checkout source ref.
2. Setup Node 22.
3. Set package version if needed.
4. `npm ci`
5. `npm --prefix mobile/AgentCockpitPWA ci`
6. `npm run typecheck`
7. `npm run web:typecheck`
8. `npm run web:build`
9. `npm run web:budget`
10. `npm run mobile:typecheck`
11. `npm run maintainability:check`
12. `npm run spec:drift`
13. `npm run mobile:build`
14. `npm test`
15. `npm run adr:lint`
16. Package release tarball with source, lockfiles, `web/`, `mobile/`, `public/` static assets, prebuilt `public/v2-built/`, prebuilt `public/mobile-built/`, scripts, docs, and server source.
17. Exclude `node_modules`, `data`, `.env`, PM2 local config, coverage, and local plans.
18. Generate `release-manifest.json`.
19. Generate `SHA256SUMS`.
20. Upload release assets and create GitHub Release.

Also update `version-bump.yml` to stop force-pushing tags. Production should use GitHub Releases as the public signal.

## Phase 4: Mac Installer Script

Goal: one command gets Agent Cockpit running and opens the browser.

Add `scripts/install-macos.sh`, also uploaded as a release asset.

Default:

```bash
install-macos.sh --channel production
```

Dev:

```bash
install-macos.sh --channel dev
```

Production flow:

1. Verify macOS.
2. Check CPU/OS basics.
3. Check Node 22+ and npm.
4. If missing, provide Homebrew install guidance or optionally run Homebrew install only with explicit consent.
5. Resolve latest GitHub Release.
6. Download release manifest, tarball, and checksum.
7. Verify SHA256.
8. Extract into versioned app dir.
9. Run root `npm ci`.
10. Run mobile `npm --prefix mobile/AgentCockpitPWA ci`.
11. Ensure prebuilt assets exist; optionally run web/mobile builds if missing.
12. Generate `.env` with secure `SESSION_SECRET`, `AUTH_SETUP_TOKEN`, `AGENT_COCKPIT_DATA_DIR`, default `PORT`, and `WEB_BUILD_MODE=auto`.
13. Generate `ecosystem.config.js` with `cwd` pointing at current app dir and env pointing at the data dir.
14. Write install manifest.
15. Start app with `npx pm2 start ecosystem.config.js`.
16. Save PM2 process list when appropriate.
17. Open browser to `http://localhost:3334/auth/setup` or `/welcome`.

Dev flow:

1. Clone repo to chosen dir if missing.
2. Checkout/pull `main`.
3. Run the same dependency/build/start path.
4. Write install manifest with `channel: "dev"`.

Do not require global PM2. The repo already includes PM2 as a dependency, so use `npx pm2`.

## Phase 5: Welcome UI

Goal: after the installer starts the server, the browser handles user-facing setup.

Recommended flow:

1. First owner account setup.
2. Recovery code prompt.
3. Optional passkey registration.
4. Default workspace selection.
5. CLI backend checks for Claude, Codex, and Kiro.
6. Guided install/login instructions for missing backends.
7. Optional tool checks for pandoc, LibreOffice, and cloudflared.
8. Mobile PWA instructions.
9. Finish writes `welcomeCompletedAt`.

Implementation notes:

- Keep unauthenticated surface minimal.
- Reuse existing `/auth/setup` for owner creation where possible.
- After successful owner setup, redirect to `/v2/?welcome=1` for authenticated wizard steps.
- Add APIs for install/doctor state rather than shelling from the frontend directly.
- Do not make Cloudflare setup required for local use.

## Phase 6: Doctor Checks

Goal: one shared diagnostic layer powers installer output, Welcome UI, and Settings.

Checks:

- Node version.
- npm version.
- PM2 through `npx pm2`.
- data dir writable.
- app dir writable or updateable.
- V2/mobile built assets present and fresh enough.
- Claude CLI installed and authenticated enough to use.
- Codex CLI installed and authenticated enough to use.
- Kiro CLI installed and authenticated enough to use.
- pandoc optional status.
- LibreOffice optional status.
- cloudflared optional status.
- update channel/status.

Suggested endpoints:

- `GET /api/chat/install/status`
- `GET /api/chat/install/doctor`
- `POST /api/chat/install/welcome-complete`

Add shared contracts under `src/contracts/`.

## Phase 7: Release-Aware UpdateService

Goal: `UpdateService` routes by install channel.

Production update flow:

1. Check latest GitHub Release.
2. Compare release version to installed version.
3. Refuse while active/pending turns exist.
4. Download manifest, tarball, checksum.
5. Verify checksum.
6. Extract into staging version dir.
7. Run root `npm ci`.
8. Run mobile `npm --prefix mobile/AgentCockpitPWA ci`.
9. Confirm prebuilt `public/v2-built` and `public/mobile-built` exist.
10. Run build preflight only if markers/assets are missing or stale.
11. Switch `current` symlink/pointer to new version.
12. Restart PM2.
13. Health check.
14. Roll back to previous version on failure.

Dev update flow:

- Keep current `git checkout main`, `git pull origin main`, dependency install, forced web/mobile build, PM2 restart behavior.

Status response should include:

- channel
- source
- local version
- remote/release version
- update availability
- last checked time
- last error
- update in progress

## Phase 8: Documentation

Update:

- `README.md`
- `ONBOARDING.md`
- `docs/spec-deployment.md`
- `docs/spec-backend-services.md`
- `docs/spec-server-security.md`
- `docs/spec-frontend.md`
- `docs/spec-mobile-pwa.md`
- `docs/spec-api-endpoints.md`
- `docs/spec-testing.md`
- `docs/spec-coverage.md`

Key doc changes:

- Mac installer is the recommended production path.
- Production updates follow GitHub Releases.
- Dev updates follow `main`.
- No global PM2 install required.
- Built V2/mobile outputs are release artifacts and startup fallbacks.
- Windows installer remains a future separate PowerShell path.

## Implementation Slices

Recommended PR order:

1. ADR and docs for channel decision.
2. Data dir separation.
3. Install manifest service and status contracts.
4. Release workflow and packaging scripts.
5. Mac installer script.
6. Welcome UI and doctor endpoints.
7. Release-aware production updates.
8. Documentation cleanup and onboarding rewrite.

## Verification Matrix

Baseline per major slice:

```bash
npm ci
npm --prefix mobile/AgentCockpitPWA ci
npm run typecheck
npm run web:typecheck
npm run web:build
npm run web:budget
npm run mobile:typecheck
npm run mobile:build
npm run maintainability:check
npm run spec:drift
npm test
npm run adr:lint
```

Installer/release manual smoke:

1. Create release artifact from workflow.
2. Run installer on clean macOS user account or VM.
3. Confirm app starts under PM2.
4. Confirm `/auth/setup` creates owner.
5. Confirm `/v2/` loads built app.
6. Confirm `/mobile/` loads built PWA.
7. Confirm default workspace can be selected.
8. Confirm at least one backend CLI can be detected and used.
9. Trigger production update from one release to a newer release.
10. Confirm data survives update.
11. Confirm rollback path with intentionally broken release in a test repo or dry-run mode.

## Out of Scope For First Release

- Windows installer.
- Electron/Tauri desktop wrapper.
- Homebrew formula.
- Code signing/notarization.
- Automatic Cloudflare tunnel provisioning.
- Multi-user hosting.
- Hosted SaaS mode.
