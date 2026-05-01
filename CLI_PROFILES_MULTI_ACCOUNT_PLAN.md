# CLI Profiles Multi-Account Plan

Tracking issue: https://github.com/daronyondem/agent-cockpit/issues/243

Status: Final implementation pass complete locally; not committed or pushed.

## Goal

Add a global CLI Config settings section where users can create named CLI profiles for Codex, Claude Code, and Kiro. A profile represents the actual runnable CLI identity behind Agent Cockpit: vendor, executable, account/config home, runtime environment, auth state, and display name.

The conversation picker should list CLI profiles, not raw backend vendors. Profiles use the vendor icon, but the visible name comes from the user.

## Key Decisions

- Profile selection is per conversation.
- Existing conversations cannot switch profiles mid-session. Switching is allowed only before the first message or after session reset/new session.
- The first migration creates server-configured profiles for every vendor already used by existing conversations.
- Account-based authentication should be launched from Agent Cockpit where possible.
- Users can also choose Server Configured / I will configure it myself, where Cockpit assumes the server-side CLI is already configured.
- Initial auth setup supports account-based auth and server-configured mode. API-key profile setup is not in the first scope.
- Support all current vendors eventually: Codex, Claude Code, and Kiro.
- Kiro needs a research step because its multiple-account isolation mechanism is not yet confirmed.

## Proposed Data Model

```ts
type CliVendor = 'codex' | 'claude-code' | 'kiro';
type CliAuthMode = 'server-configured' | 'account';

interface CliProfile {
  id: string;
  name: string;
  vendor: CliVendor;
  command?: string;
  authMode: CliAuthMode;
  configDir?: string;
  env?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  disabled?: boolean;
}

interface ConversationEntry {
  cliProfileId?: string;
}
```

Keep `backend` during migration for compatibility, but new runtime resolution should go through `cliProfileId`.

## Vendor Notes

### Codex

- Account/config isolation: `CODEX_HOME`.
- Remote auth: `codex login --device-auth`.
- Status check: `codex login status`.
- Apply profile env to `codex app-server`, `codex exec`, model discovery, MCP collision reads, and Codex plan usage.
- Profile-specific plan usage is implemented because accounts may differ.
- Profile-specific model discovery is implemented through `GET /api/chat/cli-profiles/:profileId/metadata`; Codex runs `model/list` under the selected profile runtime and caches the catalog by profile runtime key.

### Claude Code

- Account/config isolation: `CLAUDE_CONFIG_DIR`.
- Official behavior: overrides the default `~/.claude` directory and stores settings, credentials, sessions, plugins, and related state there.
- Remote auth: `claude auth login`.
- Status check: `claude auth status --json`.
- Apply profile env to streaming, one-shot calls, memory extraction/path resolution, and plan usage where applicable.

### Kiro

- Remote auth appears available: `kiro-cli login --use-device-flow`.
- Status check appears available: `kiro-cli whoami --format json`.
- Research required: confirm whether Kiro has a supported env var or setting to isolate auth/config/session state per profile.
- If not supported, expose Kiro as server-configured only and explain the limitation in the UI.

## Migration Plan

On first run after this feature lands:

1. Read all existing workspace conversation indexes.
2. Collect backend vendors used by conversations.
3. Create one server-configured CLI profile per vendor in use:
   - `Claude Code (Server Configured)`
   - `Codex (Server Configured)`
   - `Kiro (Server Configured)`
4. Attach `cliProfileId` to each existing conversation based on existing `backend`.
5. Preserve existing `backend`, `model`, and `effort`.
6. Do not create profile-specific config directories for server-configured profiles.

## Remote Auth Flow

1. User starts auth from Settings -> CLI Config.
2. Server creates or verifies the profile config directory.
3. Server spawns the vendor login command with profile env.
4. Frontend streams sanitized stdout/stderr/status.
5. UI displays login URLs and device codes when emitted by the CLI.
6. Server polls the vendor status command until authenticated, failed, canceled, or timed out.
7. Profile status updates in Settings.

Required details:

- One auth job per profile at a time.
- Auth jobs are cancelable.
- Logs are redacted before browser delivery.
- Errors must be vendor-specific and actionable.

## UI Plan

Global Settings gets a new CLI Config section.

Profile list:

- Vendor icon.
- Profile name.
- Vendor name.
- Auth/status summary.
- Command path/status.
- Actions: Test, Authenticate, Edit, Disable/Delete.

Create profile flow:

1. Choose vendor.
2. Enter profile name.
3. Select executable: default command or custom path.
4. Select setup mode: account auth or server-configured.
5. For account mode, create Cockpit-managed config directory.
6. Run availability check.
7. Run auth flow or save server-configured profile.
8. Show final status.

Conversation composer:

- Replace raw backend picker with profile picker.
- Show profile names and vendor icons.
- Disable profile switching once the active session has messages or vendor session state.

Memory and KB settings:

- Move from selecting backend ids to selecting CLI profile ids.

## Backend Plan

- Add profile persistence and validation.
- Add migration for existing settings and conversations.
- Add a profile resolver: `cliProfileId -> profile -> vendor adapter + runtime env`.
- Extend stream and one-shot options with profile runtime context.
- Make adapters apply profile command/env consistently.
- Make model discovery cache profile-aware.
- Make plan usage cache profile-aware.
- Make availability/auth check services vendor-specific but behind one profile API.

Potential endpoints:

- `GET /api/chat/cli-profiles`
- `POST /api/chat/cli-profiles`
- `PUT /api/chat/cli-profiles/:id`
- `DELETE /api/chat/cli-profiles/:id`
- `POST /api/chat/cli-profiles/:id/test`
- `POST /api/chat/cli-profiles/:id/auth/start`
- `GET /api/chat/cli-profiles/auth-jobs/:jobId`
- `POST /api/chat/cli-profiles/auth-jobs/:jobId/cancel`
- Auth event delivery through WebSocket or an event endpoint. **Current implementation uses polling against the auth-job endpoint.**

## Docs and ADR

This needs an ADR because it changes a core architecture assumption: backend vendor and runnable CLI account/profile become separate concepts.

Update:

- `docs/spec-data-models.md`
- `docs/spec-backend-services.md`
- `docs/spec-api-endpoints.md`
- `docs/spec-frontend.md`
- `docs/spec-testing.md`
- `docs/adr/`

## Testing Plan

- Settings/profile persistence and validation.
- Migration from vendor-only conversations to server-configured profiles.
- Conversation creation stores `cliProfileId`.
- Message send resolves profile to vendor adapter and runtime env.
- Profile switching blocked for active sessions with messages/vendor ids.
- Profile switching allowed before first message and after reset/new session.
- Codex receives profile env for app-server, exec, model discovery, MCP collision reads, and plan usage.
- Claude Code receives profile env for streaming, one-shots, memory paths, and plan usage.
- Kiro behavior covered based on research outcome.
- Auth job lifecycle: start, output events, polling, cancellation, timeout, redaction.
- Frontend profile picker renders names and vendor icons.

## Phased Work

1. ADR, data model, migration, specs. **Implemented locally on `feat/cli-profiles-foundation`.**
2. Profile-aware runtime resolution with existing server-configured behavior preserved. **Implemented locally on `feat/cli-profiles-foundation`.**
3. Codex profile support. **Implemented locally on `feat/cli-profiles-foundation`.**
4. Claude Code profile support. **Implemented locally on `feat/cli-profiles-foundation`.**
5. Kiro research and implementation or documented limitation. **Documented limitation locally: Kiro stays self-configured only.**
6. Settings UI and profile picker. **Implemented locally on `feat/cli-profiles-foundation`.**
7. Remote authentication jobs. **Implemented locally for Codex and Claude Code account profiles; Kiro remains blocked by the self-configured-only decision.**

## Current State

- GitHub issue #243 created.
- Branch: `feat/cli-profiles-foundation`.
- Added `src/services/cliProfiles.ts` with server-configured profile helpers.
- Added `CliProfile`, `CliVendor`, `CliAuthMode`, `Settings.cliProfiles`, `Settings.defaultCliProfileId`, and optional conversation `cliProfileId` types.
- `SettingsService.getSettings()` now synthesizes a server-configured CLI profile for the selected default backend.
- `ChatService.initialize()` migrates vendor-only workspace indexes by adding deterministic `cliProfileId` values and ensuring matching server-configured profiles in settings.
- New conversations and backend changes now assign `cliProfileId` from the selected backend.
- `SendMessageOptions` carries `cliProfileId` and the resolved `cliProfile` into adapters.
- Phase 2 adds `resolveCliProfileRuntime()`, resolving `cliProfileId -> CliProfile.vendor -> backend adapter`.
- New conversations can be created with `cliProfileId`; the profile vendor becomes the stored `backend`, and explicit backend/profile mismatches are rejected.
- Message send, reset memory capture/adapter cleanup, auto-title generation, session summary generation, and OCR now resolve the runtime backend from `cliProfileId` when present.
- Profile switching through `POST /conversations/:id/message` is allowed only before the active session has messages; mid-session profile switches return `409`. Switching after reset remains possible because the new active session is empty.
- Codex now applies profile runtime fields:
  - `command` overrides the executable for `codex app-server` and `codex exec`.
  - `env` is merged into spawned child process environments.
  - `configDir` maps to `CODEX_HOME`, taking precedence over `env.CODEX_HOME`.
  - MCP config collision reads use `<configDir>/config.toml` when present, otherwise `~/.codex/config.toml`.
  - Long-lived app-server reuse is keyed by conversation, MCP hash, and profile runtime key.
  - Codex plan usage caches are profile-aware and stored separately from the default server-configured cache.
- Claude Code now applies profile runtime fields:
  - `command` overrides the executable for streaming and one-shot calls.
  - `env` is merged into spawned child process environments.
  - `configDir` maps to `CLAUDE_CONFIG_DIR`, taking precedence over `env.CLAUDE_CONFIG_DIR`.
  - Native Claude memory extraction and real-time memory watching resolve paths under `<configDir>/projects/...` when supplied.
  - Claude plan usage caches are profile-aware and stored separately from the default server-configured cache.
- Kiro research result: `kiro-cli` currently has device-flow login and account status commands, but no documented profile/config directory override. Empirical testing shows account isolation is possible only by changing `HOME`, which also changes unrelated filesystem behavior. We are not doing that. Kiro profiles are self-configured only for now, and Settings normalization strips Kiro `command`, `configDir`, and `env`.
- The V2 Settings screen now has a CLI Config tab for adding/editing profiles. It follows the Agent Cockpit v2 design handoff: header copy with enabled/total counter, accordion profile cards, enabled toggle/delete icon in each card header, account-only config/env fields in the expanded body, self-configured explanatory note, and a dashed bottom add row. It exposes profile name, vendor, setup mode, optional command/config directory/environment overrides for Codex and Claude Code, and locks Kiro to self-configured mode.
- CLI profile cards and the composer profile chip use the selected vendor's existing backend icon alongside the user-provided profile name.
- Phase 7 adds `CliProfileAuthService` and chat routes for remote account auth:
  - `POST /api/chat/cli-profiles/:id/test`
  - `POST /api/chat/cli-profiles/:id/auth/start`
  - `GET /api/chat/cli-profiles/auth-jobs/:jobId`
  - `POST /api/chat/cli-profiles/auth-jobs/:jobId/cancel`
  Codex account profiles run `codex login --device-auth` with `CODEX_HOME`; Claude Code account profiles run `claude auth login --claudeai` with `CLAUDE_CONFIG_DIR`. Missing account-profile `configDir` values are filled with deterministic directories under `data/cli-profiles/`. Check CLI runs the vendor status command and warms/reads profile-specific backend metadata when the adapter is registered, so model discovery is exercised during the check. Job stdout/stderr is redacted before being exposed to the browser. Auth jobs enforce a 15-minute timeout, reject duplicate running jobs for the same profile, and verify the vendor status command before marking a login-process exit as successful.
- The V2 Settings CLI Config account-profile cards now have an Account authentication panel with Check CLI, Authenticate, Cancel, status text, and a redacted log area for URLs/device codes emitted by the CLI.
- The V2 topbar plan-usage tooltip now keys Claude Code and Codex account-limit snapshots by `cliProfileId`. Switching to a different Codex profile after reset clears the previous profile's account limits from the tooltip while the new profile cache loads, and Codex turn completion performs immediate plus delayed reads for the same profile key so the server-side refresh is observed after the `done` frame.
- The V2 General tab now selects the default CLI profile when profiles exist, and saving a default profile keeps `defaultBackend` synchronized to the profile vendor.
- New V2 conversations use `defaultCliProfileId` when present; the composer picker lists CLI profile names and sends `cliProfileId` with the next message. It falls back to the raw backend picker only when no profiles are available. Profile/backend switching is locked once the active session has messages; model and effort remain selectable.
- `BaseBackendAdapter.getMetadata(options?)` is now async so adapters can return profile-specific metadata while preserving the static `/backends` registry. `GET /api/chat/cli-profiles/:profileId/metadata` resolves a profile and returns the selected adapter's profile-aware metadata.
- Codex profile model catalogs are now discovered per profile runtime. Composer, General, Memory, and Knowledge Base model/effort pickers request profile metadata when a profile is selected, then fall back to vendor registry metadata until the profile catalog is available.
- Memory and Knowledge Base settings now select CLI profiles (`memory.cliProfileId`, `ingestionCliProfileId`, `digestionCliProfileId`, `dreamingCliProfileId`) while keeping legacy `*CliBackend` fields aligned to the selected profile vendor for compatibility.
- Memory MCP note formatting, post-session memory extraction, KB ingestion image conversion, KB digestion, and KB dreaming all resolve their configured CLI profile and pass `cliProfile` into one-shot backend calls, so account profiles use their isolated config/auth directories outside regular chat streams too.
- ADR written: `docs/adr/0015-separate-cli-profiles-from-backend-vendors.md`.
- Specs updated: data models, backend services, API endpoints, frontend, and testing.
- Tests updated: `test/settingsService.test.ts`, `test/chatService.conversations.test.ts`, `test/chat.streaming.test.ts`, and `test/graceful-shutdown.test.ts`.
- Phase 3 tests updated: `test/codexBackend.test.ts` and `test/codexPlanUsage.test.ts`.
- Phase 4 tests updated: `test/backends.test.ts` and `test/claudePlanUsage.test.ts`.
- Phase 6 tests updated: `test/settingsService.test.ts`, `test/chatService.conversations.test.ts`, and `test/streamStore.test.ts`.
- Verification:
  - `npm test -- test/settingsService.test.ts test/chatService.conversations.test.ts` passed.
  - `npm test -- test/chat.streaming.test.ts --runInBand` passed with 60 tests after the backend/profile mismatch guard was added. The suite emits existing verbose stream/grace-period logs and then exits 0.
  - `npm test -- test/codexBackend.test.ts test/codexPlanUsage.test.ts --runInBand` passed with 84 tests after Phase 3.
  - `npm run typecheck` passed after Phase 3.
  - `npm run adr:lint` passed after Phase 3.
  - `npm test -- test/settingsService.test.ts test/chatService.conversations.test.ts test/chat.streaming.test.ts test/graceful-shutdown.test.ts --runInBand` passed with 139 tests after Phase 3. Jest emitted the existing "did not exit one second after the test run" warning, then exited 0.
  - `git diff --check` passed after Phase 3.
  - `npm run typecheck` passed after Phase 4.
  - `npm test -- test/backends.test.ts test/claudePlanUsage.test.ts --runInBand` passed with 114 tests after Phase 4.
  - `npm test -- test/settingsService.test.ts test/chatService.conversations.test.ts test/chat.streaming.test.ts test/graceful-shutdown.test.ts --runInBand` passed with 139 tests after Phase 4. Jest emitted the existing open-handle warning, then exited 0.
  - `npm test -- test/codexBackend.test.ts test/codexPlanUsage.test.ts --runInBand` passed with 84 tests after Phase 4.
  - `npm run adr:lint` passed after Phase 4.
  - `git diff --check` passed after Phase 4.
  - `npm run typecheck` passed after Phase 6.
  - `npm test -- test/settingsService.test.ts test/chatService.conversations.test.ts test/streamStore.test.ts --runInBand` passed with 133 tests after Phase 6.
  - `npm test -- test/chat.streaming.test.ts test/backends.test.ts test/claudePlanUsage.test.ts test/codexBackend.test.ts test/codexPlanUsage.test.ts --runInBand` reported 258 passing tests after Phase 6, then hit the existing Jest open-handle hang; the completed process was killed so it would not remain running.
  - `npm test -- test/chat.streaming.test.ts --runInBand` reported 60 passing tests after Phase 6, then hit the same existing open-handle hang; the completed process was killed.
  - `npm test -- test/chat.streaming.test.ts --runInBand --forceExit` passed with 60 tests after the disabled-default profile edge case fix.
  - `npm test -- test/backends.test.ts test/claudePlanUsage.test.ts --runInBand` passed with 114 tests after Phase 6.
  - `npm test -- test/codexBackend.test.ts test/codexPlanUsage.test.ts --runInBand` passed with 84 tests after Phase 6.
  - Babel parser check passed for `public/v2/src/screens/settingsScreen.jsx` and `public/v2/src/shell.jsx` after Phase 6.
  - `npm run adr:lint` passed after Phase 6.
  - `git diff --check` passed after Phase 6.
  - Final Phase 6 pass after the composer profile-lock UI/doc update:
    - Babel parser check passed for `public/v2/src/screens/settingsScreen.jsx` and `public/v2/src/shell.jsx`.
    - `git diff --check` passed.
    - `npm run adr:lint` passed.
    - `npm run typecheck` passed.
    - `npm test -- test/settingsService.test.ts test/chatService.conversations.test.ts test/streamStore.test.ts --runInBand` passed with 133 tests.
    - `npm test -- test/chat.streaming.test.ts --runInBand --forceExit` passed with 60 tests. The suite still prints existing diagnostic stream logs and uses `--forceExit` for the known Jest open-handle behavior.
  - `npm test -- test/graceful-shutdown.test.ts --runInBand` now passes repeatedly in this checkout while PM2 `agent-cockpit-dev` remains on port 3335. The test sets `NODE_ENV=test`, uses an isolated `PORT=3399`, and spawns Node with tsx's loader directly so signals reach `server.ts`.
  - Direct `npm test` no longer fails on graceful shutdown. It still shows unrelated parallel-sensitive failures in this environment: `test/memoryWatcher.test.ts` (`fs.watch` callback timing) and, in one accidental rerun, `test/chat.rest.test.ts`'s read-only directory expectation. `npm test -- test/memoryWatcher.test.ts --runInBand` passed.
  - Agent Cockpit v2 handoff design pass for the CLI Config tab:
    - Babel parser check passed for `public/v2/src/screens/settingsScreen.jsx` and `public/v2/src/shell.jsx`.
    - `npm run typecheck` passed.
    - `git diff --check` passed.
  - Phase 7 remote auth pass:
    - `npm test -- test/chat.cliProfileAuth.test.ts --runInBand` passed with 4 tests.
    - Babel parser check passed for `public/v2/src/screens/settingsScreen.jsx` and `public/v2/src/shell.jsx`.
    - `npm run typecheck` passed.
  - Profile-keyed plan usage fix:
    - `npm test -- test/planUsageStores.test.ts test/codexPlanUsage.test.ts test/streamStore.test.ts --runInBand` passed with 68 tests.
    - Babel parser check passed for `public/v2/src/screens/settingsScreen.jsx` and `public/v2/src/shell.jsx`.
    - `npm run typecheck` passed.
    - `npm run adr:lint` passed.
    - `git diff --check` passed.
  - Final profile metadata / Memory / KB profile pass:
    - `npm run typecheck` passed.
    - `npm test -- test/settingsService.test.ts test/chat.conversations.test.ts test/codexBackend.test.ts test/memoryMcp.test.ts test/knowledgeBase.digest.test.ts test/knowledgeBase.dream.test.ts test/knowledgeBase.pageConversion.test.ts --runInBand --forceExit` passed with 277 tests.
    - `npm test -- test/settingsService.test.ts test/chatService.conversations.test.ts test/chat.streaming.test.ts test/backends.test.ts test/claudePlanUsage.test.ts test/codexBackend.test.ts test/codexPlanUsage.test.ts test/chat.cliProfileAuth.test.ts test/planUsageStores.test.ts test/streamStore.test.ts test/memoryMcp.test.ts test/knowledgeBase.digest.test.ts test/knowledgeBase.dream.test.ts test/knowledgeBase.pageConversion.test.ts --runInBand --forceExit` passed with 564 tests.
    - `npm run adr:lint` passed.
    - `git diff --check` passed.
  - Issue #243 full-coverage auth pass:
    - `npm test -- test/chat.cliProfileAuth.test.ts --runInBand --forceExit` passed with 8 tests after adding timeout, duplicate-job, status-verification, and redaction coverage.
    - Babel parser check passed for `public/v2/src/screens/settingsScreen.jsx` and `public/v2/src/shell.jsx` after adding vendor icons to profile UI.
    - `npm run typecheck` passed.
    - `npm test -- test/settingsService.test.ts test/chatService.conversations.test.ts test/chat.streaming.test.ts test/backends.test.ts test/claudePlanUsage.test.ts test/codexBackend.test.ts test/codexPlanUsage.test.ts test/chat.cliProfileAuth.test.ts test/planUsageStores.test.ts test/streamStore.test.ts test/memoryMcp.test.ts test/knowledgeBase.digest.test.ts test/knowledgeBase.dream.test.ts test/knowledgeBase.pageConversion.test.ts --runInBand --forceExit` passed with 568 tests.
    - `npm run adr:lint` passed.
    - `git diff --check` passed.
- Remaining major scope: Kiro profile/account isolation remains deferred until it exposes a safe dedicated profile directory or we explicitly accept the `HOME` isolation tradeoff.
