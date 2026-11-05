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

## GitHub Copilot Compatibility

Normal-CI application and process suites need no installed CLI or paid account:

```bash
npm test -- test/copilotProcess.test.ts test/copilotWindowsProcess.test.ts --runInBand
npm test -- test/copilotMemoryContext.test.ts test/copilotContextTriggers.test.ts test/copilotKbRoutines.test.ts --runInBand
npm test -- test/copilotSdkRuntime.test.ts test/copilotConversations.test.ts test/copilotDeviceAuth.test.ts --runInBand
```

The native integration commands use the real pinned Copilot CLI with isolated
temporary auth/data and fixed local model replies. They require no hosted
subscription and do not update the CLI:

```bash
npm run e2e:copilot-sdk
npm run e2e:copilot-workflows
npm run e2e:copilot-ui
```

- SDK: selects the runtime through `COPILOT_SDK_CLI_PATH` and retains CLI/SDK/
  OS/Node/revision/dirty metadata, native case records and cleanup evidence.
- Workflows: `COPILOT_WORKFLOW_CLI` selects an executable. Twelve POSIX cases
  exercise production Memory/Context/KB/Routine services, native source reads,
  durable output/MCP recall and cancellation/retry. The runner prints its
  temporary `copilot-workflows-compat-*` report directory.
- Browser: `COPILOT_UI_CLI` selects an executable. The runner builds both clients,
  creates its own PM2 home/server/data, runs desktop/PWA/narrow-settings Chromium
  cases and prints the report/log directory. Account/catalog states include
  injected fixtures and do not establish hosted access.

Device-login protocol checks have a separate command:

```bash
npm run e2e:copilot-auth
```

Select `COPILOT_AUTH_CLI` when necessary. This uses an isolated auth home,
requests real device codes and cancels without browser authorization or
replacing the user's terminal login. It does not prove successful OAuth,
entitlement, expired credentials or independent accounts. The separate
`npm run e2e:copilot` legacy suite includes hosted checks and requires the
appropriate configured account; local-model suites do not replace that evidence.

The tested baseline is CLI 1.0.105 / SDK 1.0.28; production/manual installs
require Node 22.12.0 or newer. Retained SDK/auth probes use Node 22.23.4, while
application/browser checks also run on Node 26.0.0. Keep full Jest asset-build
fixtures separate from browser runs, and rebuild both production clients after
the full suite before budget/browser checks.

CI configures pinned real-CLI SDK checks on macOS 15, Ubuntu 24.04 and Windows,
Ubuntu browser compatibility and Windows Job Object/stdio process fixtures.
Only completed passing real-CLI jobs qualify that tested surface. Node process
fixtures do not certify native Copilot, and an SDK job does not establish
platform keychain/auth or full application/browser behavior. See the
[testing specification](../spec-testing.md),
[versioned evidence](../research/copilot-sdk-parity-evaluation.md) and
[known gaps](backend-capabilities.md#copilot-known-capability-gaps) before
extending compatibility claims.
