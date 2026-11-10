# Cortex Code Ubuntu acceptance preparation

C52 is **pending native execution**. The preparation host is macOS arm64, with
no Linux VM/container command or configured SSH host. Local checks of the
runner's guards, types and generated installer helpers are not Ubuntu evidence.
Agent Cockpit's existing Ubuntu installer support is separate from CoCo support.

## Required environment

- Ubuntu 24.04 LTS x64/glibc, a regular logged-in user and a responding
  `systemctl --user` manager. Containers, WSL, root, Linux arm64 and other
  distributions are rejected. An x64 VM is acceptable; record its hypervisor
  and whether CPU emulation is involved with the final evidence.
- Node.js 22+ with npm, Git, Bash, tar, sha256sum, procps, getconf and systemd
  client utilities. `busctl` is optional; unavailable Secret Service observation
  is reported as unknown. Install the checkout's locked dependencies and the
  Playwright Chromium browser/dependencies using the normal project setup.
- A retained official native CoCo 1.2.35 distribution under its versioned
  directory, authenticated normally as the same Ubuntu user. Do not copy this
  Mac's tokens/caches or log out existing accounts for the fixture.
- A built checkout. Run full Jest before rebuilding both client bundles; do not
  run asset-mutating tests alongside the browser probe. No public release,
  private Node bootstrap, remote OAuth handoff or system service is implied.

The runner has no privilege escalation, keyring unlock, D-Bus environment
import or linger configuration. An SSH session is sufficient only if the actual
user manager and the intended credential store are available. A shell that can
run CoCo does not establish that its systemd service can reuse credentials.

## Prepared runner

From the checkout on Ubuntu:

```sh
CORTEX_LINUX_PROBE=1 npx tsx scripts/probe-cortex-linux.ts --preflight
npm run web:build
npm run mobile:build
CORTEX_LINUX_PROBE=1 npx tsx scripts/probe-cortex-linux.ts
```

`--preflight` is read-only: it checks the target OS/architecture, glibc,
container/WSL exclusion, regular user and user manager. It does not check the CLI
or authentication and creates no native fixture. The full run selects the first
saved connection privately; `CORTEX_TEST_CONNECTION` selects another saved name.
Optional `CORTEX_TEST_COMMAND` selects the retained native executable. The
runner captures its realpath, requires the tested version and never changes
native settings, logs out, updates the normal CLI or replays a failed prompt.
Native code may maintain its own caches during inference.

The full runner has an 18-minute work deadline and bounded cleanup. It:

1. Packages the local build, verifies release checksums, selects the Linux
   tarball and extracts it into a disposable path with spaces and a `current`
   symlink. Real installer helpers install root/mobile dependencies and create
   `.env`, ecosystem, install manifest, PM2 scripts and a systemd user unit.
2. Materializes the unit under a private configuration directory. Installer
   systemctl calls are stubbed only during generation. Actual `systemctl --user`
   link/enable/start/restart/disable then operate on a unique fixture name.
   Its only added unit environment is `PM2_HOME`; no terminal HOME,
   SNOWFLAKE_HOME, D-Bus, API key or credential environment is injected.
3. Requires exact HTTP package-version health, matching service HOME/Snowflake
   home, and fresh exact-response service inference through Check login.
   It records only the presence of selected manager environment variables and
   whether `org.freedesktop.secrets` is listed. Neither observation identifies
   the credential storage implementation or proves successful authentication.
4. Exercises desktop native file writing/usage, observes `/proc/<pid>/exe`
   against the pinned binary, restarts private PM2, verifies saved native session
   continuity, then restarts the user unit and performs fresh auth again.
5. Stops an observed native shell before its delayed write, verifies its PID
   exits and no late file or prompt replay occurs, then removes the fixture
   registration, kills private PM2 and verifies observed process identities
   have exited. Successful runs remove their app/dependencies and PM2 state.

The private temporary report includes OS/glibc/Node/CLI/revision/dirty-state,
completed checks and explicit omissions. The report omits connection/account/
OAuth/credential values. Dependency output and failure details remain private.
Failed runs are evidence of failure; inspect their report and owned cleanup
before retrying explicitly. Normal `agent-cockpit.service`, data and PM2 state
must remain unchanged. Explicit `enable --now` is not proof of a new login.
The captured normal CLI activation must also remain unchanged; activation drift
fails the run and is never silently restored or certified as a new version.

## Gates still required to close C52

- [ ] Run the prepared runner on the actual Ubuntu target, fix native failures,
  and retain CLI/OS/Node/revision and cleanup evidence.
- [ ] Exercise the official standalone CoCo installer in a disposable Linux
  home, including discovery, spaced paths and shell-completion effects.
  The existing install probe is macOS-only; do not bypass its platform guard.
- [ ] Investigate native Linux update packaging/activation and failure/recovery
  in a disposable installation. The existing updater policy/probe is certified
  only for macOS. Linux remains a manual-update path until reviewed evidence
  supports a deliberate policy change and regression tests.
- [ ] Identify the actual native credential/cache backend without retaining
  credential values. Check reuse after a fresh user login and document behavior
  when its credential store is unavailable or locked. Do not silently import
  terminal environment, unlock stores or change no-login operation to get a pass.
- [ ] Verify normal startup registration, data, native activation and other CLI
  auth remain intact; preserve macOS installer/release/update regressions.

C26's human remote OAuth handoff, Windows, strict zero-tool Memory, complete
processor acceptance and physical mobile acceptance remain independent.

## Local preparation checks

`test/cortexLinuxProbe.test.ts` runs the real entrypoint in child processes and
checks missing opt-in and non-Linux rejection before native invocation or fixture
creation. `test/linuxInstallerScript.test.ts` materializes actual helper/unit
bytes under a temporary configuration root and executes start/stop against a
recording npx shim, including spaces and a quote in paths. These tests do not
run systemd or establish any native Linux/auth behavior. No product API, client
storage, PWA metadata, capability or updater eligibility changes are introduced.

The POSIX installation suite also executes a recording executable through
Install Doctor's real command runner: only `--no-auto-update --version` is sent,
successful discovery says login is unchecked, and nonzero exit produces a
warning. Its mocked Linux platform and local shell executable are policy/process
checks, not native Ubuntu evidence.
