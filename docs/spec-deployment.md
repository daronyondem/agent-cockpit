# 9. Export, Limitations & Deployment

[← Back to index](SPEC.md)

---

## Markdown Export Format

**Entire conversation:**
```markdown
# {title}

**Created:** {createdAt}
**Backend:** {backend}

---

### User — {timestamp}
*Backend: {backend}*

{content}

### Assistant — {timestamp}
*Backend: {backend}*

{content}

---
*Session reset — {timestamp}*
---
```

**Single session:**
```markdown
# {title}

**Session {number}** | Started: {startedAt}
**Conversation ID:** {id}

---

### User — {timestamp}
*Backend: {backend}*

{content}
```

## Known Limitations

1. **Input validation** — no validation library, minimal file upload name sanitization, no request body type/length validation
2. **Linting & formatting** — no ESLint or Prettier
3. **Conversation pagination** — `listConversations()` loads all into memory
4. **Conversation attachment MIME validation** — Multer accepts any file type for chat attachments; Knowledge Base ingestion has separate format handlers and pre-flight guards
5. **Structured logging coverage** — `src/utils/logger.ts` exists and the WebSocket server uses it for the first operational slice, but many older backend modules still write directly to `console`
6. **Multi-user support** — settings are global, not per-user

## Deployment

**Local development:**
```bash
cp .env.example .env   # Fill in values
npm install
npm start              # Listens on PORT (default 3334)
```

### Installation and Release Channels

[ADR-0054](adr/0054-adopt-mac-installer-and-release-channels.md) defines the
Mac-first packaging direction, and
[ADR-0063](adr/0063-adopt-per-user-windows-installer.md) adds the supported
Windows path. Production installs are local server-agent installs: Agent Cockpit
runs locally under PM2 and opens the browser for first-run setup. Electron/Tauri
wrappers, Homebrew formulae, code signing, notarization, automatic Cloudflare
tunnel provisioning, multi-user hosting, hosted SaaS, and unattended Windows
service/no-login operation are outside the supported installer scope.

Agent Cockpit has two release/update channels:

- **Production** uses GitHub Releases as the public source of truth. The accepted
  release workflow packages a selected source ref, publishes checksums, includes
  prebuilt `public/v2-built/` and `public/mobile-built/` assets, and lets the
  installer/updater verify artifacts before running them.
- **Dev** tracks `main`. Dev installs keep the current git pull, dependency
  install, web/mobile build, and PM2 restart behavior.

Runtime self-update is channel-aware. Production installs read `install.json`,
check the latest GitHub Release manifest, verify release checksums, stage the
next release under the platform install root, activate it, and restart through
PM2 with health-check rollback. macOS activates releases by switching the
`current` symlink. Windows activates releases by writing the active versioned
`appDir` to `install.json` and restarting from that directory. Dev installs keep
the git/main update behavior described below.

## Production Release Packaging

Production releases are created by `.github/workflows/release.yml`, a manual
`workflow_dispatch` workflow with inputs:

- `version`: required semantic version, with or without a leading `v`
- `source_ref`: branch, tag, or commit to package, defaulting to `main`
- `prerelease`: boolean flag passed through to the GitHub Release
- `smoke_only`: boolean flag that runs pre-publish validation and skips GitHub
  Release creation, defaulting to `false`

The workflow checks out `source_ref`, normalizes the version, records the
checked-out commit, and runs `npm version <version> --no-git-tag-version` only
when the checked-out package version differs from the requested release version.
Before the publish job can create the GitHub Release, a `windows-smoke` job runs
on `windows-latest`. That job checks out `source_ref` with full history, installs
root and mobile dependencies, runs the root/web/mobile TypeScript checks, builds
the web and mobile assets required by the release package, checks the web bundle
budget, runs the Windows-focused installer/doctor/install-state Jest tests plus
the Windows-named update-service Jest tests, parses `scripts/install-windows.ps1`
with PowerShell's parser API, runs `npm run release:package` on Windows, and
verifies the manifest includes the macOS tarball, Windows ZIP, and Windows
installer artifacts. It then creates a temporary Git origin whose `main` branch
points at the selected `source_ref`, runs `scripts/install-windows.ps1 -Channel
dev` against a temporary checkout with `-InstallNode`, an install path containing
spaces, `-SkipOpen`, and a fixed high port, verifies the `AgentCockpit` ONLOGON
scheduled task is queryable, probes `/auth/setup`, verifies `/api/chat/install/doctor`
reports `node`, `npm`, and `pm2` as `ok`, and runs the generated stop script
before the publish job starts.

When `smoke_only` is false, the Ubuntu publish job then runs the release gate in
this order:

```bash
npm ci
npm --prefix mobile/AgentCockpitPWA ci
npm run typecheck
npm run web:typecheck
npm run web:build
npm run web:budget
npm run mobile:typecheck
npm run maintainability:check
npm run spec:drift
npm run mobile:build
npm test
npm run adr:lint
npm run release:package -- --version <version> --source-ref <source_ref> --commit <commit> --out-dir dist/release
npm run release:notes -- --version <version> --repo <owner/repo> --out dist/release/github-release-notes.md
```

The final step creates GitHub Release `v<version>` with title
`Agent Cockpit v<version>`, uses
`dist/release/github-release-notes.md` as the release description, and uploads:

- `agent-cockpit-v<version>.tar.gz`
- `agent-cockpit-v<version>.zip`
- `release-manifest.json`
- `SHA256SUMS`
- `install-macos.sh`
- `install-windows.ps1`

`npm run release:notes` executes `scripts/render-release-notes.js`. The script
requires `docs/releases/v<version>.md` to exist in the checked-out source ref.
That source-controlled release document is produced during release preparation
using `docs/release-notes-prompt.md` and reviewed before the manual workflow is
triggered. The renderer validates that the document has non-empty
`## Shipped For Users` and `## Developer Details` sections, rejects TODO/TBD
placeholder text, requires at least one shipped-user bullet, and writes a GitHub
Release body that includes the user-facing shipped list plus a link to
`docs/releases/v<version>.md` at the release tag.

`npm run release:package` executes `scripts/package-release.js`. The script
requires `public/v2-built/index.html` and `public/mobile-built/index.html`, so a
production artifact cannot be created without prebuilt desktop V2 and mobile PWA
shells. It packages the runtime source tree under a versioned top-level
directory named `agent-cockpit-v<version>` and includes root lock/config/docs
files plus `docs/`, `mobile/`, `public/`, `scripts/`, `src/`, and `web/`.

The package script excludes mutable or local-only state from the artifact:
`node_modules/`, `data/`, `.env`, `ecosystem.config.js`, `coverage/`, `plans/`,
`plan.md`, release `dist/` output, PM2/local logs, and generated build staging
directories such as `public/.v2-built-*` and `public/.mobile-built-*`.

`release-manifest.json` is an external installer/updater manifest with
`schemaVersion: 1`, `channel: "production"`, `source: "github-release"`,
`version`, `sourceRef`, `sourceCommit`, `packageRoot`, required runtime metadata
from root `package.json` `engines.node`, required build paths, app archive
artifact names/sizes/SHA256 hashes, installer artifact names/sizes/SHA256
hashes, and per-file paths, sizes, and SHA256 hashes for the packaged tree. The
macOS archive remains `role: "app-tarball", platform: "darwin",
format: "tar.gz"` for compatibility. The Windows archive is
`role: "app-zip", platform: "win32", format: "zip"`. `SHA256SUMS` contains
checksums for both app archives, the release manifest, `install-macos.sh`, and
`install-windows.ps1`. The manifest is not embedded in either app archive, so
archive hashes can be verified before extraction.

The automatic `.github/workflows/version-bump.yml` workflow remains a dev/main
version bookkeeping workflow. It bumps the patch version on pushes to `main`,
commits the package files, and pushes `main`; it does not create or force-push
`v*` tags. GitHub Releases are the only production release signal.

## macOS Installer

The first supported installer is `scripts/install-macos.sh`. It is included in
the release tarball and uploaded as a separate GitHub Release asset so a Mac user
can run one script without cloning the repository. Defaults:

```bash
scripts/install-macos.sh --channel production
scripts/install-macos.sh --channel dev
```

Supported options are `--channel production|dev`, `--version <version>`,
`--repo <owner/name>`, `--install-dir <path>`, `--dev-dir <path>`,
`--port <port>`, `--install-node`, `--no-install-node`, and `--skip-open`. The
default install root is `~/Library/Application Support/Agent Cockpit`;
production releases are extracted under `releases/agent-cockpit-v<version>`,
and `current` is a symlink to the active release. Mutable runtime data lives
under `<install-root>/data`.

The installer exits unless `uname -s` is `Darwin`, the CPU is `arm64` or
`x86_64`, and `curl`, `tar`, and `shasum` are available. When Node.js 22+ and
npm are already available on `PATH`, the installer uses them. Otherwise it
downloads the latest official Node.js 22 macOS tarball for the detected
architecture from `https://nodejs.org/dist/latest-v22.x/`, downloads
`SHASUMS256.txt`, verifies the tarball with `shasum -a 256`, extracts it under
`<install-root>/runtime/node-v<version>`, and points
`<install-root>/runtime/node` at that runtime. It prepends the private
`runtime/node/bin` directory for install-time `node`, `npm`, and `npx` commands
and persists that `PATH` in generated `.env` and `ecosystem.config.js` so the
PM2-managed server and restart/update scripts continue to use the private
runtime. The installer records `nodeRuntime` ownership/version metadata in
`install.json` so later production updates know whether Agent Cockpit may update
that runtime. `--install-node` keeps this default behavior explicit;
`--no-install-node` makes missing/old Node.js a hard error for users who want to
manage Node themselves. [ADR-0059](adr/0059-install-private-node-runtime-on-macos.md)
captures the private-runtime and update decision.

Production installs download `release-manifest.json`, `SHA256SUMS`, and the
manifest-designated `app-tarball` from
`https://github.com/<repo>/releases/latest/download/` by default, or from
`/releases/download/v<version>/` when `--version` is supplied. The script
verifies SHA256 for both the manifest and tarball before extraction. After
extraction it exports `NPM_CONFIG_AUDIT=false`, `NPM_CONFIG_FUND=false`,
`NPM_CONFIG_LOGLEVEL=error`, and `NPM_CONFIG_UPDATE_NOTIFIER=false`, runs root
`npm ci --no-audit --no-fund --loglevel=error`, runs
`npm --prefix mobile/AgentCockpitPWA ci --no-audit --no-fund --loglevel=error`, verifies
that `public/v2-built/index.html` and `public/mobile-built/index.html` exist,
and runs the corresponding build command only if an expected prebuilt shell is
missing. These npm settings keep install-time audit/funding/update-notifier
prompts, dependency deprecation warnings, and package-count chatter out of the
fresh-Mac user path while the repository lockfile and release gate remain
responsible for dependency hygiene.

Dev installs clone `https://github.com/<repo>.git` into `--dev-dir` when missing
or update an existing checkout with `fetch origin main`, `checkout main`, and
`pull --ff-only origin main`. They run the same dependency install path and force
both web/mobile builds so the dev checkout is immediately runnable.

Both channels generate `.env`, `ecosystem.config.js`, and
`<AGENT_COCKPIT_DATA_DIR>/install.json`. Generated runtime config sets `PORT`,
secure random `SESSION_SECRET`, secure random `AUTH_SETUP_TOKEN`,
`AGENT_COCKPIT_DATA_DIR`, `WEB_BUILD_MODE=auto`, and
`AUTH_ENABLE_LEGACY_OAUTH=false`. When the installer had to install the private
Node.js runtime, generated config also persists `PATH` with that runtime's
`bin` directory first. The PM2 ecosystem file uses the local
`./node_modules/.bin/tsx` interpreter, `cwd` set to the selected app directory,
and app name `agent-cockpit`. The install manifest records production as
`channel: "production", source: "github-release"` and dev as
`channel: "dev", source: "git-main", branch: "main"`.

The installer starts the app with local PM2 through:

```bash
npx pm2 startOrRestart ecosystem.config.js --update-env
npx pm2 save
```

It does not require global PM2. After PM2 starts, the installer polls
`http://127.0.0.1:<port>/auth/setup` for up to 90 seconds before opening the
browser. If the server does not answer, the installer fails with a local
PM2 logs command. When the installer is using a private Node.js runtime, that
printed command prepends the private runtime `bin` directory and calls the
private runtime's `npx` so it still works from a fresh user shell that has no
global Node.js on `PATH`. Once the setup endpoint is ready, it prints the
first-run setup token and opens
`http://localhost:<port>/auth/setup` unless `--skip-open` is set.
Successful owner creation redirects to `/v2/?welcome=1`, where the authenticated
welcome flow reads install/doctor status, links to Security and CLI Settings,
offers workspace selection, and calls `POST /api/chat/install/welcome-complete`
to persist `welcomeCompletedAt`.

## Windows Installer

The supported Windows installer is `scripts/install-windows.ps1`. It is uploaded
as a separate GitHub Release asset so a Windows user can run one PowerShell
bootstrap command without cloning the repository. Defaults:

```powershell
powershell -ExecutionPolicy Bypass -NoProfile -Command "iwr https://github.com/daronyondem/agent-cockpit/releases/latest/download/install-windows.ps1 -OutFile $env:TEMP\install-agent-cockpit.ps1; & $env:TEMP\install-agent-cockpit.ps1 -Channel production"
```

Supported options are `-Channel production|dev`, `-Version <version>`,
`-Repo <owner/name>`, `-InstallDir <path>`, `-DevDir <path>`, `-Port <port>`,
`-InstallNode`, `-NoInstallNode`, `-SkipOpen`, `-NoAutoStart`, and `-Repair`.
The default install root is `%LOCALAPPDATA%\Agent Cockpit`; production releases
are extracted under `releases\agent-cockpit-v<version>`, mutable runtime data
lives under `data\`, install-local PM2 state lives under `pm2\`, and private
Node.js runtimes live under `runtime\node-v<version>-win-x64`.

The Windows installer exits unless it is running on Windows x64. Windows arm64
is rejected until runtime dependencies and backend CLIs are validated there.
When Node.js 22+ and npm are already available on `PATH`, the installer uses
them unless `-InstallNode` is supplied. Otherwise it downloads the latest
official Node.js 22 Windows ZIP from `https://nodejs.org/dist/latest-v22.x/`,
downloads `SHASUMS256.txt`, verifies the ZIP with `Get-FileHash -Algorithm
SHA256`, expands it under the install root, and records private runtime metadata
in `install.json`. Repair or reinstall runs first reuse an existing private
runtime at the target version only after verifying `node.exe`, `npm.cmd`,
`npx.cmd`, and npm's `npm-cli.js`, `npx-cli.js`, and `npm-prefix.js` entrypoints,
and after checking native command exit codes explicitly. This prevents a
partially deleted runtime from being treated as healthy. The installer does not
delete the target runtime directory because the currently running Agent Cockpit
or PM2 daemon may still have `node.exe` open. If the target runtime directory
exists but cannot be verified, the installer extracts a fresh sibling runtime
directory and records that path in `install.json`; it does not remove the
possibly locked runtime. It does not modify the user's global PATH.

Production installs download `release-manifest.json`, `SHA256SUMS`, and the
manifest-designated Windows `app-zip` from GitHub Releases. They verify SHA256,
expand the ZIP with `Expand-Archive`, install root and mobile dependencies with
quiet npm settings, verify the prebuilt `public/v2-built/` and
`public/mobile-built/` shells, and build only if an expected shell is missing.
Dev installs clone or update `main` under `-DevDir`, install dependencies, and
force both builds.

Both Windows channels generate `.env`, `ecosystem.config.js`, helper scripts
under `<install-root>\bin\`, and `<data-dir>\install.json`. The ecosystem config
sets PM2 `windowsHide: true` and has PM2 monitor
`bin\run-agent-cockpit.vbs` through `wscript.exe //B //NoLogo` instead of
spawning `node.exe` directly. The generated Windows Script Host runner contains
the active `appDir`, resolved `node.exe`, and runner log paths, then starts
`node --import tsx server.ts` hidden through `%ComSpec% /d /s /c` with stdout
and stderr redirected to `<install-root>\pm2\logs\agent-cockpit-runner-*.log`.
This keeps the PM2-managed server background-only, avoids an extra `tsx` CLI
process layer, and prevents a Node console window from being left on the user's
desktop. Runtime
environment includes
`PORT`, `SESSION_SECRET`, `AUTH_SETUP_TOKEN`,
`AGENT_COCKPIT_DATA_DIR`, `WEB_BUILD_MODE=auto`,
`AUTH_ENABLE_LEGACY_OAUTH=false`, `PM2_HOME=<install-root>\pm2`, and `PATH`
with `<install-root>\cli-tools` first, the private runtime directory second when
present, `%APPDATA%\npm` when available, and then the inherited user PATH. The
installer creates `<install-root>\cli-tools`, prepends it to the current user's
Windows `Path`, and broadcasts an environment change so new user terminals can
run CLIs that Agent Cockpit installs there. Welcome-screen Claude/Codex npm
actions and Windows production self-updates also persist the same user `Path`
entry after successful installs/updates. On Windows the server-side CLI resolver
prefers the package entrypoints npm puts
under that prefix (`@anthropic-ai\claude-code\bin\claude.exe` directly and
`@openai\codex\bin\codex.js` through `node.exe`) before falling back to npm
`.cmd` shims through `cmd.exe`; it also recognizes self-installed
`claude.exe`/`claude.cmd` and `codex.exe`/`codex.cmd` commands already available
on the user's PATH. Claude/Codex chat, auth, doctor, usage, and CLI update flows
use that shared resolution path. Windows
path-valued `.env` entries use backtick quoting so dotenv does not interpret
`\r` or `\n` inside paths such as `runtime\node-v...`. Fresh `SESSION_SECRET`
and `AUTH_SETUP_TOKEN` values are generated with
`RandomNumberGenerator.Create().GetBytes(...)` so the installer works in Windows
PowerShell 5.1 as well as newer PowerShell runtimes. Repair or reinstall runs
read the existing app `.env` and install manifest before replacing a same-version
release directory, stop the existing PM2 app on a best-effort basis before
deleting active app files, and keep `SESSION_SECRET`, `AUTH_SETUP_TOKEN`,
`installedAt`, and `welcomeCompletedAt` stable while mutable `data\` content is
preserved outside the app directory. The best-effort PM2 cleanup path resolves
`<appDir>\node_modules\.bin\pm2.cmd` directly and skips cleanup when that local
command is not present yet; it must not invoke `npx` in a freshly extracted or
partially repaired app directory because npm can try to resolve missing packages
interactively before dependencies are installed.

The installer starts Agent Cockpit with local PM2 and install-local `PM2_HOME`,
then saves PM2 state. Before each installer or generated start-helper launch, it
deletes any existing `agent-cockpit` PM2 entry on a best-effort basis so repair
runs replace stale process metadata with the regenerated hidden runner config.
The generated start/stop/log helpers also resolve app-local `pm2.cmd` directly
and invoke PM2 through a checked native-command wrapper so failed
`pm2 startOrRestart` and `pm2 save` commands surface through the task/script
exit status without npm package-resolution prompts. If readiness times out, the installer prints PM2
`describe` output, the last PM2 log lines, and the runner stdout/stderr logs
before failing with the generated logs helper command. Unless `-NoAutoStart` is
supplied, it registers a current-user `AgentCockpit` ONLOGON Scheduled Task
that runs `bin\start-agent-cockpit.ps1` through `powershell.exe -WindowStyle
Hidden`. The scheduled-task cmdlet path uses the current Windows identity as an
`Interactive` limited principal; the `schtasks.exe` fallback passes `/RU
<current-user>` with limited run level. This is
intentionally user-logon startup, not a Windows Service and not "run whether
user is logged on or not". If the server does not answer `/auth/setup` within
90 seconds, the installer prints the helper logs command.

`AGENT_COCKPIT_DATA_DIR` controls the mutable data root. When unset, runtime
state stays under `<repo>/data` for compatibility with existing development
installs. The Mac production installer sets this outside the replaceable app
directory, under `~/Library/Application Support/Agent Cockpit/data` by default.

`LOG_LEVEL` controls the structured logger threshold for modules that have migrated to `src/utils/logger.ts`. Supported values are `error`, `warn`, `info`, and `debug`; invalid or missing values fall back to `info`. Metadata keys that look like credentials or session material are redacted before log lines are written.

The main `/v2/` web UI is built with Vite from `web/AgentCockpitWeb/` into `public/v2-built/`. Normal development and production both use the same one-server architecture: Express serves backend routes and the built web UI. A separate Vite dev server is not required for the normal `agent-cockpit-dev` workflow. After editing V2 frontend source, restart the PM2-managed dev server; startup preflight detects missing or stale main V2 web assets, runs `npm run web:build`, writes `public/v2-built/.agent-cockpit-build.json`, then starts serving `/v2/`. The same startup preflight also detects missing or stale mobile PWA assets, runs `npm run mobile:build`, and writes `public/mobile-built/.agent-cockpit-build.json` before listen. Explicit local checks are available:

```bash
npm run web:typecheck
npm run web:build
npm run web:budget
npm run mobile:typecheck
npm run mobile:build
```

`WEB_BUILD_MODE=skip` disables both main V2 web and mobile startup preflights for tests or unusual deployments that provision assets out of band. If no previous build exists and the build fails, startup fails. If a previous build exists and a rebuild fails, the server logs the error and serves the previous build.

Dev self-update runs root `npm install`, mobile `npm --prefix mobile/AgentCockpitPWA install`, the V2 web build, and the mobile PWA build before PM2 restart. If either dependency install or either build fails, the update returns a failed result and does not restart; startup preflight remains the fallback for manual git operations or interrupted updates. This keeps every generated asset tree served by Express (`/v2/` and `/mobile/`) in sync with the pulled source. Production self-update checks the release manifest's required Node runtime before dependency installation. When a release raises the required Node major, the updater installs or refreshes a checksum-verified private Node runtime from Node.org under the Agent Cockpit install root before running `npm ci`; installs that previously used system Node migrate to this private runtime instead of mutating global Node. macOS private runtime updates use Node's Darwin tarball and stable private-runtime symlink. Windows private runtime updates use Node's Windows ZIP and a versioned runtime directory. Production then runs root/mobile `npm ci` inside the extracted release, then runs the V2/mobile build preflight there only when markers or assets require it. macOS switches the `current` symlink before PM2 restart; Windows writes the active versioned `appDir` to `install.json` and launches a PowerShell restart script with health-check rollback. See [ADR-0049](adr/0049-retire-v2-globals-and-build-mobile-assets-during-updates.md), [ADR-0050](adr/0050-serve-mobile-pwa-from-ignored-build-output.md), [ADR-0054](adr/0054-adopt-mac-installer-and-release-channels.md), [ADR-0059](adr/0059-install-private-node-runtime-on-macos.md), and [ADR-0063](adr/0063-adopt-per-user-windows-installer.md).

**Remote access via ngrok:**
```bash
ngrok http 3334
```
For a fresh exposed backend, set `AUTH_SETUP_TOKEN` before first-run setup so a remote visitor cannot claim the owner account. Legacy OAuth callback URLs are only relevant when `AUTH_ENABLE_LEGACY_OAUTH=true`.

**Local auth reset:**
```bash
npm run auth:reset -- --password "new long password" --disable-passkey-required --revoke-sessions --regenerate-recovery-codes
```
The reset command requires local filesystem access. It can reset the owner password, disable passkey-required mode, delete session files under `<AGENT_COCKPIT_DATA_DIR>/sessions`, and print replacement recovery codes.

**Mobile PWA development, build, and install:**
```bash
npm install
npm run mobile:dev
```

The mobile Vite dev server listens on port `5174` and proxies `/api`, `/auth`, and `/logo-full-no-text.svg` to the PM2-managed Agent Cockpit backend at `http://localhost:3334`. For production/static serving:

```bash
npm run mobile:build
```

The build writes to ignored `public/mobile-built/`, including the generated shell, manifest, hashed JS/CSS, SVG icon, PNG manifest icons, 180x180 `apple-touch-icon.png` for iOS home-screen installs, and `.agent-cockpit-build.json` when produced by startup/self-update preflight. Express explicitly mounts that directory at `/mobile/` after normal authentication, before the general `public/` static mount. A phone can open `https://<agent-cockpit-host>/mobile/` and use Add to Home Screen for an installable PWA. No Xcode, Expo Go, EAS, Apple signing, TestFlight, or App Store distribution is required for the supported mobile path.
