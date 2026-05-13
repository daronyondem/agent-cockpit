# Backend-Neutral Goal Mode Implementation Plan

## Scope

Implement a shared Agent Cockpit goal experience for Codex and Claude Code while preserving each backend's real capabilities.

The user-facing concept is one **Goal** mode: a verifiable condition the selected agent keeps working toward. The implementation must not pretend the CLIs expose the same protocol. Codex uses native thread-goal RPCs. Claude Code uses its `/goal` slash command, which is backed by session-scoped goal/status behavior in the CLI.

Claude Code does not currently expose native pause/resume goal controls. Agent Cockpit must not emulate those controls in v1. Claude goals should expose only supported controls such as **Clear** and **Stop Turn**.

## Assumptions

- Goal controls remain composer-adjacent, not in the chat topbar.
- Codex goal behavior remains the compatibility baseline and must not regress.
- Claude Code goal status is best-effort and transcript-derived unless the CLI later exposes a cleaner protocol.
- The desktop web UI is the target for this implementation. Mobile/PWA impact must still be evaluated and documented.
- Token budget UI remains out of scope for this goal-mode iteration.
- Backend-specific limitations should be reflected in capabilities and UI affordances, not hidden behind brittle workarounds.

## Success Criteria

- Codex goals still support set, pause, resume, clear, status strip, elapsed time, and sidebar active state.
- Claude Code conversations can set a goal from the same Goal composer mode.
- Claude Code goal UI does not show Pause or Resume.
- Claude Code goal UI shows Clear when supported and Stop Turn while a CLI turn is active.
- Claude Code `/goal` command scaffolding is not rendered as normal user-visible chat content.
- Claude Code goal status can show active, achieved, cleared, or unknown when available from transcript state.
- Route guards reject unsupported actions with clear errors.
- Specs, ADRs, and tests describe backend-specific goal capabilities.

## Product Behavior

### Shared User Flow

1. User selects backend/model/profile as usual.
2. User toggles **Goal** in the composer or types `/goal <condition>`.
3. Composer placeholder changes to `Set a goal...`.
4. Submit starts the goal immediately and creates only an assistant streaming placeholder.
5. A compact GoalStrip appears above the composer.
6. The sidebar keeps the conversation visibly active while the goal is active.
7. User can leave the conversation and return without losing visible goal state.

### Shared Transcript Events

The transcript should hide backend plumbing and surface lifecycle rows or compact status updates:

- `Goal set`
- `Checking goal...`
- `Not met: <reason>`
- `Continuing`
- `Goal achieved: <reason>`
- `Goal cleared`
- `Goal paused` for Codex only
- `Goal budget limited` for Codex only

Normal assistant output, tool activity, usage, artifacts, errors, and approvals still render through the existing stream pipeline.

### Controls by Backend

Codex:

- Pause
- Resume
- Clear
- Stop Turn while a turn is active

Claude Code:

- Clear
- Stop Turn while a turn is active
- No Pause
- No Resume

If the UI includes a details drawer, Claude Code can show a passive note: `Pause/resume is not supported by Claude Code.`

## Architecture Decision Record

Create a new ADR before implementation.

Suggested title:

```bash
npm run adr:new -- "Represent goal mode as backend-capability driven"
```

Decision points:

- Agent Cockpit exposes one Goal UX backed by backend-specific capabilities.
- Codex remains native RPC-backed through `codex app-server --enable goals`.
- Claude Code goal mode is slash-command/transcript-backed.
- Pause/resume is capability-driven and omitted for Claude Code.
- The shared UI must not emulate backend behavior that is not native or reliable.

Alternatives to record:

- Emulate Claude pause/resume inside Agent Cockpit by clearing and later recreating `/goal`.
- Keep the current Codex-only UI and add a separate Claude-specific goal flow.
- Build a fully vendor-neutral persisted goal store before adding Claude support.

Likely affected docs:

- `docs/adr/*`
- `docs/spec-api-endpoints.md`
- `docs/spec-backend-services.md`
- `docs/spec-frontend.md`
- `docs/spec-mobile-pwa.md`
- `docs/parity-decisions.md`

## Contract Changes

### Goal Type

Move the public goal shape away from Codex-only naming. Prefer a browser-safe contract under `src/contracts/`.

Target shape:

```ts
export type ThreadGoalBackend = 'codex' | 'claude-code';

export type ThreadGoalStatus =
  | 'active'
  | 'paused'
  | 'complete'
  | 'budgetLimited'
  | 'cleared'
  | 'unknown';

export interface ThreadGoalSupportedActions {
  clear: boolean;
  stopTurn: boolean;
  pause: boolean;
  resume: boolean;
}

export interface ThreadGoal {
  backend: ThreadGoalBackend;
  threadId?: string | null;
  sessionId?: string | null;
  objective: string;
  status: ThreadGoalStatus;
  supportedActions: ThreadGoalSupportedActions;
  tokenBudget?: number | null;
  tokensUsed?: number | null;
  timeUsedSeconds?: number | null;
  turns?: number | null;
  iterations?: number | null;
  lastReason?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  source?: 'native' | 'transcript' | 'runtime' | 'unknown';
}
```

Compatibility requirements:

- Existing Codex clients should keep receiving fields they already rely on.
- If renaming exported TypeScript symbols is too invasive, add aliases first:
  - `CodexThreadGoal` -> `ThreadGoal`
  - `CodexThreadGoalStatus` -> `ThreadGoalStatus`
- Avoid importing backend service types into frontend code.

### Backend Metadata

Replace or augment boolean `capabilities.goals` with a structured capability.

Target shape:

```ts
export interface GoalCapability {
  set: boolean;
  clear: boolean;
  pause: boolean;
  resume: boolean;
  status: 'native' | 'transcript' | 'none';
}
```

Backend values:

```ts
// Codex
goals: {
  set: true,
  clear: true,
  pause: true,
  resume: true,
  status: 'native',
}

// Claude Code
goals: {
  set: true,
  clear: true,
  pause: false,
  resume: false,
  status: 'transcript',
}

// Kiro and unsupported backends
goals: {
  set: false,
  clear: false,
  pause: false,
  resume: false,
  status: 'none',
}
```

If the metadata contract cannot safely change in one step, support both shapes temporarily:

```ts
goals: true
```

and

```ts
goals: GoalCapability
```

Then normalize with a helper before UI/route use.

## Backend Implementation

### Base Adapter

Update `src/services/backends/base.ts` to expose goal methods in backend-neutral terms:

- `getGoal(options)`
- `setGoalObjective(objective, options)`
- `resumeGoal(options)`
- `pauseGoal(options)`
- `clearGoal(options)`

The methods may already exist for Codex. Keep method names if changing them would create churn. Unsupported default implementations should continue throwing explicit errors.

Add a helper for unsupported actions:

```ts
function goalActionUnsupported(backendLabel: string, action: string): Error
```

Use it so route errors are consistent.

### Codex Adapter

Keep the current Codex flow stable:

- Spawn `codex app-server --enable goals`.
- Initialize with experimental API capability.
- `thread/goal/get`
- `thread/goal/set`
- `thread/goal/clear`
- Forward `thread/goal/updated` as goal updates.
- Forward `thread/goal/cleared` as goal cleared.
- Use `thread/goal/updated.turnId` or `thread/goal/updated.turn.id` for goal turn ownership.

Required changes:

- Map Codex goal objects to the new `ThreadGoal` shape.
- Include `backend: 'codex'`.
- Include supported actions with pause/resume enabled.
- Preserve existing counters and timestamps.
- Keep `budgetLimited` display-only.

Codex should remain the regression-sensitive path. Avoid unrelated refactors in `codex.ts`.

### Claude Code Adapter

Add Claude Code goal support in `src/services/backends/claudeCode.ts`.

#### Set Goal

`setGoalObjective(objective, options)` should start a normal Claude Code stream using:

```text
/goal <objective>
```

This should reuse existing Claude stream supervision:

- same session id handling
- same `--session-id` for new sessions
- same `--resume` for existing sessions
- same model/effort/profile handling
- same MCP config handling
- same `processStream` path

The route should not save a normal user message, matching Codex goal behavior.

#### Clear Goal

`clearGoal(options)` should use Claude Code's native command:

```text
/goal clear
```

Do not call this while another stream is active unless the existing stream/input architecture can prove it is safe. Preferred v1 behavior:

- If idle: run `/goal clear` as a short stream/job or one-shot goal action.
- If active: expose **Stop Turn** separately and reject clear with a clear route error, unless testing proves Claude accepts `/goal clear` over stdin reliably during active turns.

The user-facing UI can keep Clear available only when idle for Claude, or show a guarded error if clicked while active.

#### Pause and Resume

Do not implement.

- `pauseGoal` should throw unsupported for Claude.
- `resumeGoal` should throw unsupported for Claude.
- UI should hide Pause/Resume for Claude so these route errors are only guardrails.

#### Get Goal

Implement `getGoal(options)` by reading Claude Code session transcript JSONL.

Known observed transcript entry:

```json
{
  "type": "attachment",
  "attachment": {
    "type": "goal_status",
    "met": true,
    "condition": "...",
    "reason": "...",
    "iterations": 1,
    "durationMs": 8436,
    "tokens": 317
  }
}
```

Also observed setup sentinel:

```json
{
  "type": "attachment",
  "attachment": {
    "type": "goal_status",
    "met": false,
    "sentinel": true,
    "condition": "..."
  }
}
```

Mapping rules:

- Latest `goal_status.met === true` -> `status: 'complete'`.
- Latest `goal_status.met === false` and no later clear marker -> `status: 'active'`.
- Clear command detected after latest active status -> `status: 'cleared'` or `null`, depending on which is easier to reason about in the UI.
- Missing transcript or no goal status -> `null`.
- Include `objective` from `condition`.
- Include `lastReason` from `reason`.
- Include `iterations`, `turns`, token/time fields if present.
- Include `source: 'transcript'`.
- Include supported actions: clear true, stopTurn true, pause false, resume false.

Implementation detail:

- Locate transcript using the same project/session conventions already used by Claude memory extraction.
- Keep parsing focused and tested in a helper module if `claudeCode.ts` is already large.
- Prefer a small function such as `parseClaudeGoalFromJsonl(text, sessionId)`.

#### Stream Filtering

Claude Code `/goal` emits command/meta scaffolding into the transcript. Agent Cockpit should not display those as normal chat content.

Filter or classify these patterns:

- `<command-name>/goal</command-name>`
- `<command-message>goal</command-message>`
- `<command-args>...</command-args>`
- `<local-command-stdout>Goal set: ...</local-command-stdout>`
- meta message containing `A session-scoped Stop hook is now active`
- clear command stdout, if present

Do not filter:

- Real assistant text after the goal starts.
- Tool activity.
- Tool outcomes.
- Errors.
- Usage.

If filtering at the adapter layer is risky, emit a distinct internal/lifecycle event that `processStream` can persist as a goal lifecycle row instead of a user bubble.

## Routes

Refactor `src/routes/chat/goalRoutes.ts`.

### Naming

Rename internal helper:

- from `resolveCodexGoalAdapter`
- to `resolveGoalAdapter`

The helper should:

- resolve the conversation runtime/backend/profile
- read normalized goal capabilities
- reject unsupported backend early
- return adapter, runtime, backend id, and capability object

### Endpoint Behavior

`GET /conversations/:id/goal`

- Return `{ goal: ThreadGoal | null }`.
- Works for Codex and Claude Code when status capability is not `none`.
- Returns null when no goal exists.

`POST /conversations/:id/goal`

- Requires `goals.set`.
- Body remains `{ objective, backend?, cliProfileId?, model?, effort?, serviceTier? }`.
- Applies the same picker/profile/model rules as message send.
- Creates a durable stream job.
- Does not append a user message.
- Returns `{ streamReady: true }`.

`POST /conversations/:id/goal/resume`

- Requires `goals.resume`.
- Works for Codex.
- Returns `400` for Claude Code:

```json
{ "error": "Goal resume is not supported by Claude Code" }
```

`POST /conversations/:id/goal/pause`

- Requires `goals.pause`.
- Works for Codex.
- Returns `400` for Claude Code:

```json
{ "error": "Goal pause is not supported by Claude Code" }
```

`DELETE /conversations/:id/goal`

- Requires `goals.clear`.
- Codex: current `thread/goal/clear` behavior.
- Claude Code: `/goal clear` behavior, subject to idle/active safety decision.

### Active Stream Rules

Keep existing single-active-stream guard:

- `POST /message`, `POST /goal`, and `POST /goal/resume` reject while another stream is active/preparing.

For Claude Code clear:

- Prefer v1 conservative behavior: reject while active unless safe stdin behavior is explicitly tested.

For Codex clear/pause:

- Preserve current behavior: state mutation, not abort, allowed while active.

## Stream and State Events

Current goal WebSocket frames:

- `goal_updated`
- `goal_cleared`

Keep these if possible.

For Claude Code:

- Emit `goal_updated` when a parsed `goal_status` attachment appears or after stream completion refreshes the transcript status.
- Emit `goal_cleared` after successful `/goal clear`, if a clear state can be observed.
- If no clean clear marker exists, route can send `goal_cleared` after successful clear command completion.

Do not persist raw goal frames as chat messages.

Potential optional lifecycle event:

```ts
{
  type: 'goal_lifecycle',
  status: 'set' | 'checking' | 'not_met' | 'achieved' | 'cleared';
  message?: string;
}
```

Only add this if it materially simplifies frontend rendering. Avoid adding it speculatively.

## Frontend Implementation

### API Client

Update `web/AgentCockpitWeb/src/api.js` if response types or endpoint assumptions are Codex-specific.

Existing helpers can stay:

- `getGoal`
- `setGoal`
- `resumeGoal`
- `pauseGoal`
- `clearGoal`

They should become backend-neutral in naming/comments.

### Stream Store

Update `web/AgentCockpitWeb/src/streamStore.js`.

Requirements:

- `goal` stores backend-neutral goal snapshots.
- `goalMode` can be enabled for any backend with `goals.set`.
- Selecting a backend/profile without goal support disables `goalMode`.
- `setGoal` continues creating only an assistant placeholder.
- `refreshGoal` works for Codex and Claude Code.
- Sidebar active state checks backend-neutral active goal status.
- Stale snapshot rejection still uses normalized `updatedAt`.

Claude-specific caution:

- If Claude transcript-derived snapshots lack timestamps, assign route/server timestamps before sending to the frontend.
- Do not let an older transcript poll resurrect a cleared local goal.

### Goal State Helpers

Update `web/AgentCockpitWeb/src/goalState.js`.

Expected helpers:

- `goalSnapshotTimeMs(goal)`
- `isActiveGoal(goal)`
- `goalElapsedSeconds(goal)`
- `goalSupportsAction(goal, action)`
- `goalStatusLabel(goal)`

Rules:

- `active` means sidebar streaming/active visual.
- `complete`, `cleared`, and `unknown` do not keep the sidebar active.
- Claude elapsed time may be null if not available.
- Codex elapsed time keeps existing live ticking behavior.

### Composer

Update composer copy:

- `Set a Codex goal...` -> `Set a goal...`
- `Set goal` remains.
- Goal checkbox appears when current effective backend supports setting goals.

Slash commands:

- `/goal` toggles goal mode when backend supports goals.
- `/goal <objective>` starts a goal.
- `/goal clear` clears the current goal.
- `/goal pause`:
  - Codex: pause.
  - Claude: toast `Goal pause is not supported by Claude Code`.
- `/goal resume`:
  - Codex: resume.
  - Claude: toast `Goal resume is not supported by Claude Code`.

For unsupported backends:

- Keep existing rejection toast but make it backend-neutral:
  - `Goals are not supported by <backend label>.`

### GoalStrip

Render action buttons based on `goal.supportedActions`.

Codex:

- Active: Pause, Clear
- Paused: Resume, Clear
- Complete/budget-limited: Clear

Claude Code:

- Active: Clear if safe/idle, or Clear disabled while active if route cannot safely clear during active turn.
- Complete: Clear or no action, depending on whether clear is meaningful after auto-clear.
- Never show Pause.
- Never show Resume.

Stop Turn:

- Keep separate from goal clear.
- Show while `state.streaming` is true or stream supervisor marks active.
- It aborts the current CLI turn, not the goal state.

Details drawer, if touched:

- Backend
- Objective
- Status
- Supported actions
- Elapsed time
- Turns/iterations
- Token/cost fields when available
- Last evaluator reason for Claude

## Tests

### Backend Unit Tests

Add or update focused tests.

Claude goal parser:

- Parses sentinel `goal_status met:false` as active.
- Parses `goal_status met:true` as complete.
- Extracts condition, reason, iterations, duration, tokens.
- Ignores unrelated attachments.
- Handles malformed JSONL lines.
- Returns latest goal status when multiple statuses exist.

Claude adapter:

- `setGoalObjective` invokes Claude stream with `/goal <objective>`.
- `pauseGoal` rejects unsupported.
- `resumeGoal` rejects unsupported.
- `clearGoal` invokes `/goal clear` when idle.
- Goal command scaffolding is filtered or classified.

Codex adapter:

- Existing goal tests still pass.
- Codex goal mapping includes `backend: 'codex'`.
- Codex supported actions include pause/resume.

### Route Tests

Add route tests for capability behavior:

- Codex `POST /goal` accepted.
- Codex `POST /goal/pause` accepted.
- Codex `POST /goal/resume` accepted.
- Claude `POST /goal` accepted.
- Claude `POST /goal/pause` returns 400 unsupported.
- Claude `POST /goal/resume` returns 400 unsupported.
- Claude `DELETE /goal` follows chosen idle/active behavior.
- Unsupported backend returns 400 for goal set.

### Frontend Tests

Add behavior-oriented tests:

- Goal toggle appears for Codex.
- Goal toggle appears for Claude Code.
- Goal toggle does not appear for unsupported backend.
- Codex GoalStrip shows Pause/Resume according to status.
- Claude GoalStrip never shows Pause/Resume.
- Claude `/goal pause` shows unsupported toast.
- Claude active goal keeps sidebar row active.
- Complete Claude goal stops sidebar active state.
- Stale goal snapshots do not resurrect a cleared goal.

### Spec/Static Tests

If the project already has import-boundary checks, update them for new contract files.

Add tests only where runtime coverage is impractical.

## Documentation Updates

### `docs/spec-api-endpoints.md`

Update goal endpoint section:

- Goals are backend-capability driven.
- Codex uses native thread goals.
- Claude Code uses `/goal`.
- Pause/resume are not universally supported.
- Document unsupported action response.
- Document backend-neutral `ThreadGoal`.

### `docs/spec-backend-services.md`

Update backend sections:

- Codex capabilities remain native goals.
- Claude Code capabilities include set/clear/status but not pause/resume.
- Describe transcript-derived `goal_status` parsing.
- Describe goal command scaffolding filtering.
- Describe active-stream restrictions for Claude clear.

### `docs/spec-frontend.md`

Update frontend section:

- Goal mode is backend-neutral.
- Goal controls render from supported actions.
- Claude Code hides Pause/Resume.
- GoalStrip behavior by backend.
- Sidebar active behavior for active goals.

### `docs/spec-mobile-pwa.md`

Evaluate impact.

If mobile does not render goal controls, document this as deferred parity.

### `docs/parity-decisions.md`

Update if desktop-only Claude goal support creates a parity decision.

### `AGENTS.md`

Evaluate whether to update.

Only update if this change introduces a recurring architecture convention agents should follow, such as backend capability-driven UI controls for CLI features.

## Verification Commands

Run focused tests during implementation:

```bash
npm test -- --runTestsByPath test/codexBackend.test.ts
npm test -- --runTestsByPath test/claudeCodeBackend.test.ts
npm test -- --runTestsByPath test/chatGoalRoutes.test.ts
```

Run frontend tests relevant to the touched UI:

```bash
npm run web:typecheck
npm test -- --runTestsByPath test/webGoalState.test.ts
```

Before PR:

```bash
npm run typecheck
npm run web:typecheck
npm test
npm run maintainability:check
npm run spec:drift
npm run adr:lint
```

Adjust exact test paths to match existing filenames.

## Manual Smoke Tests

### Codex

1. Start a Codex conversation.
2. Enable Goal mode.
3. Set a goal.
4. Confirm sidebar row stays active.
5. Pause goal.
6. Confirm status becomes paused and elapsed time stops ticking.
7. Resume goal.
8. Confirm active state returns.
9. Clear goal.
10. Confirm strip disappears or shows cleared state according to current UI convention.

### Claude Code

1. Start a Claude Code conversation.
2. Enable Goal mode.
3. Set a simple verifiable goal.
4. Confirm Pause/Resume are not visible.
5. Confirm real assistant output is visible.
6. Confirm raw `/goal` command scaffolding is not visible.
7. Confirm transcript-derived status appears after stream completion.
8. Confirm achieved goal stops sidebar active state.
9. Clear goal when idle.
10. Confirm clear state is reflected.

### Unsupported Backend

1. Select a backend without goal support.
2. Confirm Goal toggle is hidden.
3. Try `/goal test`.
4. Confirm a clear unsupported toast/error.

## Rollout Strategy

### Phase 1: Contracts and Capability Plumbing

- Add backend-neutral goal contract.
- Add structured goal capability metadata.
- Normalize old/new capability forms if needed.
- Keep UI behavior unchanged.

Verification:

- Typecheck.
- Existing Codex goal tests.

### Phase 2: Preserve Codex on New Contract

- Map Codex native goal state to backend-neutral `ThreadGoal`.
- Update routes to use capability checks.
- Keep Codex UI unchanged except copy becoming backend-neutral.

Verification:

- Codex manual smoke.
- Codex route/backend tests.

### Phase 3: Claude Goal Start and Status

- Add Claude `setGoalObjective`.
- Add transcript parser for `goal_status`.
- Add `getGoal` for Claude.
- Add scaffolding filtering.

Verification:

- Claude parser tests.
- Claude manual set/achieve smoke.

### Phase 4: Claude Clear and Unsupported Actions

- Add Claude clear behavior.
- Add unsupported pause/resume route handling.
- Hide Pause/Resume for Claude.

Verification:

- Claude clear smoke.
- Route tests for unsupported pause/resume.
- Frontend tests for hidden controls.

### Phase 5: Docs and Hardening

- Update specs.
- Add ADR.
- Run maintainability and spec drift checks.
- Evaluate mobile/PWA parity.

## Known Risks

### Claude Transcript Status Is Not a Stable Public API

Claude Code writes `goal_status` attachments into session JSONL, but stream-json stdout does not currently expose a clean dedicated goal-update event. This could change.

Mitigation:

- Keep parser isolated and well-tested.
- Treat Claude goal status as best-effort.
- Fail soft by returning `null` or `unknown`, not by breaking chat.

### Claude Clear While Active May Be Unsafe

The normal Agent Cockpit UI queues user input while an assistant turn is streaming, so stdin-based mid-turn control is not a reliable user path.

Mitigation:

- Keep Stop Turn separate.
- Only allow Claude Clear while idle unless proven safe.
- Do not emulate pause/resume.

### UI Could Imply False Parity

If all backends show identical buttons, users will assume identical semantics.

Mitigation:

- Render controls strictly from `supportedActions`.
- Hide Pause/Resume for Claude.
- Use details text only where helpful.

### Codex Regression Risk

Codex goals already work and have nuanced turn ownership behavior.

Mitigation:

- Keep Codex adapter changes minimal.
- Add mapping helpers instead of refactoring the event loop.
- Run existing Codex goal tests and manual smoke.

## Non-Goals

- No Claude pause/resume emulation.
- No token budget editor.
- No mobile goal UI unless specifically scoped.
- No vendor-neutral persisted goal store beyond what is required for UI state.
- No broad Claude adapter rewrite.
- No changes to unrelated CLI profile behavior.
