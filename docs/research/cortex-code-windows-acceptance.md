# Cortex Code Windows runtime preparation

C53 has **implemented runtime code and simulated-platform tests; native
acceptance is pending**. Development/verification was performed on macOS arm64.
No Windows executable, PowerShell process controller, ConPTY, credential store,
installer or update was executed on Windows for this batch. C53 stays unchecked.

## Implemented behavior

- Windows x64 resolves the official standalone `cortex.exe`, first under
  `%LOCALAPPDATA%\cortex`, then on PATH. Explicit executable paths and custom
  executable names are preserved. A missing explicit command never falls back
  to another installation. Directories and script/Node/npm/PowerShell shims
  cannot start CoCo. Windows arm64/32-bit remains unsupported.
- The shared CLI resolver supplies chat, setup/auth, Install Doctor, CLI Update
  and passive migration checks. The runtime captures the executable's realpath,
  size and modification time; the version query and ACP launch use that path.
  It does not change native activation or promise immutable Windows packaging.
- Version detection uses `--no-auto-update --version`. ACP starts with exactly
  `acp serve`, literal argv and piped stdio, without a command shell, detached
  Windows console or visible console window. Existing macOS launch behavior
  remains covered separately.
- Windows child environment names are normalized case-insensitively, layer by
  layer. Profile `Path` works; lowercase managed controls cannot bypass native
  Memory/test-mode suppression or manual OAuth. Normal setup retains shared
  terminal credentials; explicit custom homes remain experimental. Auth-home
  reservation and migration inspection use the same Windows casing semantics.
- Login retains the existing node-pty native terminal, version-gated 1.2.35
  parser, active callback generation/state/issuer checks and fresh exact-response
  inference requirement. A simulated handoff does not prove native login or C26.
- `cortexWindowsProcess.ts` invokes system Windows PowerShell noninteractively
  with an encoded script and hidden window. CIM provides parent relationships;
  CIM also provides UTC creation identities at microsecond precision, without
  opening handles or dropping access-denied processes. Missing/invalid identity
  data fails the snapshot. Snapshots include only PID, parent and creation time, never
  command lines, credentials or environment.
- The shared scope remembers descendants across root exit, checks parent birth
  ordering, excludes replaced PIDs and opens/rechecks each handle before killing
  it, comparing its native start time at the same precision. It does not use POSIX group signals, `taskkill /T` or unconditional tree
  termination. Enumeration/helper failures or surviving known identities reject
  cleanup; an enumeration failure can terminate only the still-live ChildProcess
  root through its existing handle. Stop never retries interrupted native work.
  Periodic snapshots are observation, not OS containment; native race/timing and
  ConPTY cleanup require real Windows evidence.
- Install Doctor detects an installed responding executable without claiming
  login. Windows installation remains an official documentation link. Managed
  CoCo updates remain macOS-only; passive Windows discovery never queries a
  release channel or runs an updater. Invalid imported Windows commands become
  individual update errors before execution.
- Existing appDir activation, PM2/user startup and other harnesses' private-Node
  wrappers are unchanged. No mobile PWA, REST/WS, storage or profile schema change.

The install location is documented by
[Snowflake](https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-cli).
The cleanup implementation uses Microsoft's
[process handle](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.handle)
and [Kill](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.kill)
APIs. These references guide implementation; they are not native compatibility
evidence for CoCo 1.2.35.

## Local verification

`test/cortexWindows.test.ts` covers standalone discovery, missing/explicit paths,
literal connection/plugin/cwd arguments, profile environment/auth scope,
synthetic OAuth followed by verification, manual update/install policy, passive
import and fresh Install Doctor detection. `test/cortexWindowsLaunch.test.ts`
checks version/ACP executable ownership, hidden non-detached launch, abort and
negotiation cleanup. `test/cortexWindowsProcess.test.ts` exercises mocked Windows
snapshots, malformed identities, detached/reused/older/unrelated PIDs, helper
failure, surviving processes and idempotent cleanup. Its PowerShell script
assertions cannot establish executable PowerShell behavior. The native POSIX
runtime/process tests remain separate.

## Native completion checklist

Use a regular logged-in Windows x64 user and a retained official standalone
1.2.35 distribution. Record Windows build, CLI full version/physical path, Node
version, source revision and dirty state. Install normally on Windows; do not
copy this Mac's credentials or log out existing accounts. Build both clients
after full Jest, and use a unique fixture app/data/workspace/private PM2 with
the existing current-user startup conventions. Do not restart the normal app.

1. Check the official install layout, paths containing spaces, PATH refresh,
   explicit overrides and native binary version. Current vendor documentation
   does not prove the retained distribution's layout or availability.
2. Run focused Windows resolver/launch/process/auth/doctor/migration/update tests
   plus existing Windows installer, private-Node wrapper and appDir update tests.
3. Exercise actual PowerShell snapshots and handle termination against owned
   foreground/background children, detached tools, forced root exit, a resistant
   child and unrelated siblings. Test restricted PowerShell/CIM or access failures;
   cleanup must fail visibly without signaling unverified processes.
4. Verify saved terminal credentials with one fresh exact-response inference
   through Cockpit. Exercise actual node-pty/ConPTY login, cancellation, timeout,
   retry and shutdown, preserving callback ownership and shared-home draining.
   Record cache/store behavior without copying secrets. Human remote-browser
   handoff remains the separate C26 gate.
5. Verify desktop/mobile chat, MCP Node entrypoints, artifact delivery, usage,
   question/plan decisions, native session continuity through isolated PM2
   restart, Stop/descendant drain and a fresh explicit turn without replay.
6. Verify fresh login and saved auth under the actual current-user startup task,
   not merely an inherited interactive terminal environment. Account isolation,
   token expiry and another account require their own evidence.
7. Exercise the official native Windows update in a disposable installation:
   successful activation, failure/recovery, executable replacement while idle,
   active-runtime ownership and fresh auth afterward. Managed Windows updates
   remain disabled until their exact layout/version is certified.
8. Retain metadata-only results separately from private logs/screenshots/native
   files, and prove owned processes/private PM2 and fixture startup tasks drain.
   Never turn mocks, a partial pass or a successful version query into full C53
   acceptance. Existing consolidated CoCo runners are macOS-scoped and are not
   Windows acceptance runners.
