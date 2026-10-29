# Testing

Tests use Jest for the main suite and separate commands for web, mobile, and
real-CLI compatibility checks.

## Common Checks

```bash
npm run typecheck
npm run lint
npm test
npm run maintainability:check
npm run spec:drift
```

## Web And Mobile

```bash
npm run web:typecheck
npm run web:build
npm run web:budget
npm run mobile:typecheck
npm run mobile:build
```

## Installation

```bash
npm run test:install
npm run web:build
npm run mobile:build
npm run e2e:install -- --ui
npm run e2e:install -- --private-node
```

`test:install` runs executable fixture tests and existing installer, doctor,
state, packaging, and release-workflow guards. PowerShell function tests run
when PowerShell is available; native Windows launch behavior is covered in CI,
not inferred from running PowerShell on macOS/Linux.

Fixture commands and package preparation have 60-second deadlines. Executable
fixture tests allow four minutes for sequential commands and rollback, so the
outer test timeout does not remove a fixture before its command deadline.
Spawn failures, signals, and timeouts fail the test rather than counting as
expected nonzero installer exits.

The native runner packages the current built checkout, installs it under a
temporary path containing spaces, uses isolated data/auth/PM2 state, checks
readiness and required doctor checks, repairs the same version, and exercises
generated stop/start helpers. `--private-node` hides system Node from POSIX
installer detection or passes Windows `-InstallNode`; Node is downloaded from
the official site. `--ui` runs owner/welcome and post-repair mobile Playwright
checks with synthetic credentials. No authenticated backend account is needed.
Install Playwright's browser dependencies first when unavailable.

The temporary home/cache root has no added spaces while the installation path
still contains spaces. This keeps node-gyp's header cache usable on Linux without
dropping install-path coverage. Commands capture stdout/stderr through private
regular files rather than pipes, so detached PM2/terminal descendants cannot
keep a completed installer command waiting for EOF.

The runner verifies the app's PID, cwd, port, and `PM2_HOME` in its isolated
daemon, requires a new PID after repair, and also repairs an intentionally
corrupt manifest while checking preserved config/secrets/data. Stopping must
release the HTTP port. Restart uses a helper with inherited `PM2_HOME` removed,
then verifies the new process belongs to the same isolated daemon. These checks
prevent a second daemon from satisfying readiness for the wrong instance.

Use `--release-dir <directory>` to test an existing candidate and
`--report-dir <directory>` to retain JSON results, stage diagnostics, and browser
failure artifacts. Reports distinguish OS/architecture and runtime source and
record the initial, repaired, recovered, and restarted process PIDs.
The runner stops its isolated PM2 daemon and removes temporary install files.
Windows cleanup removes only the temporary install's `cli-tools` entry from the
current user PATH; it does not restore an old snapshot or discard entries added
by other work during the test. Cleanup errors retain the report and install root.
It does not register startup locally. `--auto-start` is allowed only with
`CI=true` on disposable native runners; registration is not a real reboot test.

## Claude Code Interactive Compatibility

These suites require an authenticated real `claude` CLI and are intentionally
not part of normal CI:

```bash
npm run e2e:claude-interactive:report
npm run e2e:claude-interactive-ui:report
```

Review the Claude Code Interactive compatibility guidance in [AGENTS.md](../../AGENTS.md)
before changing that backend path.

## Grok Build Compatibility

These suites require an authenticated real `grok` CLI, send real requests
through that account, and are intentionally not part of normal CI. Native runs
can take several minutes:

```bash
npm run e2e:grok-build
npm run e2e:grok-build-ui
```

The first runs the native Jest compatibility and workflow suites. The second
builds the desktop and mobile apps, starts an isolated PM2-managed fixture
server with temporary data, and removes only that PM2 app when it finishes.
Both forward extra arguments to Jest or Playwright and print the temporary
folder that holds their compatibility report.

Review the Grok Build compatibility guidance in [AGENTS.md](../../AGENTS.md)
and [spec-grok-build.md](../spec-grok-build.md) before changing that backend
path.
