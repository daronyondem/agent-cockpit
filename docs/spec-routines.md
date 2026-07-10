# 6. Workspace Routines

[<- Back to index](SPEC.md)

---

Workspace Routines are workspace-owned markdown workflows that Agent Cockpit can
run manually or on a schedule through the selected CLI harness. Agent Cockpit
owns only infrastructure: proposal discovery, persistence, schedule checks,
per-run folders, status/history, and notification delivery. The harness owns the
task intelligence by reading and following the routine markdown file.

This design is recorded in [ADR-0084](adr/0084-represent-workspace-routines-as-markdown-workflows.md).

## Storage

Per-workspace data lives under:

```text
data/chat/workspaces/{storageKey}/routines/
  ROUTINE_AUTHORING.md
  index.json
  settings.json
  items/
    {routineId}/
      manifest.json
      routine.md
      state.json
      persistent-state/
      runs/
        {runId}/
          input.md
          output/
          tmp/
          final.md
          notify.md
```

Workspace Routines are opt-in per workspace through
`WorkspaceIndex.routinesEnabled`. The flag defaults to `false`; opening the
Routines tab while disabled reads settings paths, does not create the
`routines/` folder, write `ROUTINE_AUTHORING.md`, or write `index.json`, and
removes any stale managed routines block from workspace `AGENTS.md` while
preserving all content outside the marked block. Enabling the feature calls
`RoutinesService.ensureWorkspace()`, which creates `ROUTINE_AUTHORING.md`,
`items/`, and the generated `index.json`, then installs the managed
instructions. Disabling the feature removes only the managed instructions block
from `AGENTS.md`; existing routine folders, runs, outputs, settings, and
`persistent-state/` data remain on disk and reappear when the workspace is
enabled again.

`ROUTINE_AUTHORING.md` is the prompt contract a chat harness reads before
creating or editing a routine. `index.json` is a generated list view for humans
and tooling. `settings.json` currently stores workspace outreach configuration.
Each routine folder name must match the normalized `manifest.id`.
`persistent-state/` is the routine's cross-run state directory under Agent
Cockpit data. It is not pruned with per-run output retention.

When routines are enabled or repaired for a workspace, Agent Cockpit installs a
managed `AGENTS.md` block in the workspace root:

```md
<!-- AGENT_COCKPIT_ROUTINES_START -->
## Agent Cockpit Routines

This workspace can define Agent Cockpit Routines...
Routine authoring contract: `.../ROUTINE_AUTHORING.md`
Routine index: `.../index.json`
Routine items folder: `.../items`
...
<!-- AGENT_COCKPIT_ROUTINES_END -->
```

Content outside the markers is preserved. Repairing routine instructions
requires the workspace feature to be enabled, then rewrites the authoring
contract and reinstalls the managed block. Disabling routines removes only this
managed block and preserves any other `AGENTS.md` content.

## Manifest

`src/contracts/routines.ts` defines the browser-safe wire contract and runtime
validators. The manifest schema is:

```ts
{
  schemaVersion: 1;
  kind: 'agent-cockpit.routine';
  id: string;
  title: string;
  description?: string;
  routineFile: string;          // relative markdown path, normally routine.md
  state: 'proposed' | 'enabled' | 'disabled';
  trigger:
    | { type: 'manual' }
    | {
        type: 'schedule';
        intervalMinutes: number; // clamped 1..1440
        timezone?: string;       // valid IANA timezone
        weekdaysOnly?: boolean;
        windowStart?: string;    // HH:mm, requires windowEnd
        windowEnd?: string;      // HH:mm, requires windowStart
      };
  harness?: {
    cliProfileId?: string;
    model?: string;
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  };
  notification?: { mode: 'off' | 'workspaceDefault' };
  outputRetentionDays?: number;  // clamped 1..3650
  timeoutMinutes?: number;       // clamped 1..1440
}
```

States are intentionally minimal:

- `proposed`: created by a harness and visible in Workspace Settings, but not
  scheduled and not manually runnable from the UI.
- `enabled`: scheduled when the trigger is `schedule`; manually runnable.
- `disabled`: not scheduled; manually runnable for testing or one-off use.

Deleting a routine removes its folder and run history. A starting or running
routine cannot be deleted.

## Proposal Flow

When the user asks a harness to create a routine, the harness reads
`ROUTINE_AUTHORING.md`, creates `items/{routineId}/manifest.json` and
`items/{routineId}/routine.md`, leaves the manifest in `state:"proposed"`, and
ends its final assistant message with:

```md
<!-- AGENT_COCKPIT_ROUTINE_PROPOSAL:v1:/absolute/path/to/items/{routineId}/manifest.json -->
```

The desktop chat renderer strips this marker from Markdown and renders a
routine proposal card. The card calls
`POST /workspaces/:workspaceId/routines/proposals/validate` before installing.
Validation accepts only absolute `manifest.json` paths under a real routine
directory in that workspace's `routines/items/` folder, requires the routine
markdown file to exist, and rejects markers that point outside the workspace
routines folder. It returns the current manifest state as well as the routine
id, so old chat proposal cards can render `Installed` after a proposal has
already moved to `enabled` or `disabled`.

The proposal card offers:

- `Install`: sets state to `enabled` and opens Workspace Settings -> Routines.
- `Install disabled`: sets state to `disabled` and opens Workspace Settings ->
  Routines.

After either install action succeeds, the card records the proposal as installed
in browser local storage and replaces both buttons with a single `Installed`
state immediately. The card also revalidates the marker against the server when
it mounts; if the manifest is already `enabled` or `disabled`, it records the
same installed marker and hides the install buttons, so the same chat message
does not continue to look actionable after the chat view remounts or another UI
path installs the routine.

There is no dismissed state. If the user closes the card or navigates away, the
routine remains `proposed` and can be reviewed or deleted later from the
workspace routines list.

The authoring contract tells harnesses not to create `.agent-cockpit`,
`.routine-state`, or similar hidden metadata folders inside the workspace root
unless the user explicitly asks for workspace-visible files. Routine markdown
should refer to runtime-provided output, temporary, persistent state, and
notification paths by purpose instead of hardcoding workspace metadata paths.

## Execution

`RoutinesService.runRoutine()` creates a run folder, writes `input.md`, resolves
the configured CLI profile runtime, and calls the backend adapter's
`runOneShot(input, options)` with:

- `allowTools: true`;
- `workingDir` set to the workspace path;
- optional manifest `model`, `effort`, `timeoutMinutes`, and `cliProfile`.

The generated `input.md` includes:

- routine title/id/path;
- workspace path;
- run folder, output folder, temporary folder, previous-runs folder;
- persistent state folder;
- `notify.md` path;
- Workspace Context pointer when enabled;
- Knowledge Base folder pointer when enabled;
- the routine markdown content.

The harness must read the routine markdown before doing work, use `output/` for
durable artifacts from the current run, use `tmp/` for scratch files, use
`persistent-state/` for cross-run state, write a concise user message to
`notify.md` only when the user should be notified, avoid hidden Agent Cockpit
metadata folders in the workspace root unless explicitly requested, and avoid
changing routine state/schedule/deletion from inside a run.

Run state is stored in `state.json`:

```ts
{
  version: 1;
  lastRun?: RoutineRunRecord;
  runs: RoutineRunRecord[];
}
```

`RoutineRunRecord` includes `runId`, `routineId`, `source` (`manual` or
`scheduled`), `status` (`running`, `completed`, `failed`, `stopped`),
timestamps, `inputPath`, `outputDir`, `tmpDir`, optional `finalPath`,
`notifyPath`, `errorMessage`, `notificationSentAt`, and `notificationError`.
The service keeps at most 50 run records and prunes run folders older than
`outputRetentionDays` (default 14).

Run concurrency is routine-scoped. A routine can have at most one starting or
running run. Duplicate manual starts return `409`; duplicate scheduled starts
are logged and skipped by the scheduler.

Manual `Run now` starts return a snapshot of the run once the initial
`running` record has been written. The Workspace Settings Routines tab merges
that snapshot immediately, disables `Run now` while the routine is running,
polls the selected routine and list state once per second, treats either the
list `running` flag or `lastRun.status:"running"` as active, and fetches the
selected detail before committing terminal list state that stops the poll. The
button is re-enabled only after the run becomes `completed` or `failed` and the
run log reflects the terminal record.

## Scheduling

`RoutinesScheduler` ticks every 60 seconds. It lists active workspaces through
`ChatService.listWorkspaces({ includeArchived:false })` when available, then
checks enabled scheduled routines. A routine is due when:

- current local time in the trigger timezone is inside the optional window;
- `weekdaysOnly` does not exclude the day;
- no prior run exists, or the prior run started at least `intervalMinutes` ago.

Scheduled runs start in the background. The scheduler records a started count
for the tick and logs failures without blocking other workspaces.

## Outreach

Workspace outreach settings currently support Telegram destinations:

```ts
{
  telegram?: {
    enabled?: boolean;
    // Legacy compatibility only; new UI stores the bot token globally in
    // Settings.integrations.telegram.botToken.
    botToken?: string;
    chatId?: string;
    chatTitle?: string;
    chatType?: string;
  }
}
```

API responses never echo bot tokens. They return:

```ts
{
  telegram: {
    enabled: boolean;
    configured: boolean;
    botConfigured: boolean;
    destinationConfigured: boolean;
    chatId?: string;
    chatTitle?: string;
    chatType?: string;
  }
}
```

`configured` is true only when both halves are present: a Telegram bot token from
Global Settings Integrations or a legacy workspace token, plus a workspace
destination `chatId`. `botConfigured` and `destinationConfigured` expose those
halves separately so the Workspace Routines outreach panel can point users to
Global Settings when the shared bot is missing.

Telegram setup is split intentionally:

- Global Settings -> Integrations stores the bot token once. Browser-facing
  settings responses only report `integrations.telegram.configured`; they never
  echo the token.
- Each workspace stores its own destination chat. The Routines Outreach panel
  keeps a manual **Chat ID (advanced)** input, but the primary flow is
  **Connect Destination**.
- **Connect Destination** calls
  `POST /workspaces/:workspaceId/routines/telegram-destination/start`. The
  service requires an available bot token, preferring a legacy workspace-level
  token when one exists and otherwise using the global token, creates one
  short-lived workspace pairing session, and returns a code such as `AC-123456`,
  an expiry timestamp, and an instruction string like `/connect AC-123456`.
- The user sends that instruction to the bot from the target Telegram chat. For
  groups, the bot must be added to the group first and the command must be sent
  in the group.
- The panel polls
  `POST /workspaces/:workspaceId/routines/telegram-destination/poll` while the
  code is visible. Polling calls Telegram `getUpdates`, looks for a recent
  message or channel post containing the active code, extracts the sending chat
  id/type/title, writes it into workspace routine settings, enables Telegram
  outreach for the workspace, and returns the updated redacted settings envelope.
- If the code expires, the panel stops and asks the user to start again. If no
  global or legacy workspace bot token is available while pairing, polling
  returns `missing_bot`.

The pairing session is process-local and replaces any prior pending code for the
same workspace. The durable state remains only the resulting workspace settings;
no connect codes are written to disk. If a Telegram bot has a webhook configured
elsewhere, Telegram may reject `getUpdates`; that upstream error is surfaced to
the Outreach panel and the manual Chat ID field remains available as a fallback.

When a routine uses `notification.mode:"workspaceDefault"`, and the run writes a
non-empty `notify.md`, Agent Cockpit sends that content to the configured
Telegram chat. Telegram sends are plain text, omit parse mode, cap text at 3900
characters, and use a 10-second abort timeout. Runtime delivery prefers a legacy
workspace-level token when present, otherwise it uses
`settings.integrations.telegram.botToken`. Notification failure does not fail the
run; it records `notificationError` on the run record.

## API

Routes are mounted under `/api/chat` in `src/routes/chat/routineRoutes.ts`.
State-changing routes require CSRF.

| Method | Path | CSRF | Description |
|---|---|---:|---|
| `GET` | `/workspaces/:workspaceId/routines` | No | Returns `{ enabled, routines, settings }`. Disabled workspaces return `enabled:false`, an empty routine list, and settings paths without creating files or installing instructions; stale managed routines blocks in workspace `AGENTS.md` are removed while unrelated content is preserved. Enabled workspaces ensure authoring files/instructions exist and return the routine list. |
| `PUT` | `/workspaces/:workspaceId/routines/enabled` | Yes | Body `{ enabled:boolean }`. Persists `WorkspaceIndex.routinesEnabled`. Enabling ensures authoring files/instructions and returns `{ enabled:true, routines, settings }`; disabling removes the managed `AGENTS.md` block, preserves routine data, and returns `{ enabled:false, routines:[], settings }`. |
| `GET` | `/workspaces/:workspaceId/routines/settings` | No | Returns `{ enabled, routinesDir, authoringPath, notification }`. |
| `PUT` | `/workspaces/:workspaceId/routines/settings` | Yes | Body `{ settings }` or direct settings object. Saves workspace outreach settings and returns the same shape as GET. Empty `botToken` clears a legacy workspace-level token; new bot tokens are configured globally. |
| `POST` | `/workspaces/:workspaceId/routines/telegram-destination/start` | Yes | Starts a short-lived Telegram destination pairing session. Returns `missing_bot` when no global or legacy workspace bot token is available; otherwise returns a pending code, expiry, and `/connect ...` instruction. |
| `POST` | `/workspaces/:workspaceId/routines/telegram-destination/poll` | Yes | Polls Telegram `getUpdates` for the active workspace pairing code. When a matching message or channel post is found, stores the chat id/title/type as the workspace destination, enables Telegram outreach, and returns the redacted settings envelope. |
| `POST` | `/workspaces/:workspaceId/routines/proposals/validate` | Yes | Body `{ marker }` or `{ content }`. Returns `{ proposals }` for valid routine proposal markers, including the current manifest state so clients can detect already-installed proposals. |
| `POST` | `/workspaces/:workspaceId/routines/repair-instructions` | Yes | Requires workspace Routines enabled. Rewrites the authoring contract and `AGENTS.md` managed block. |
| `GET` | `/workspaces/:workspaceId/routines/:routineId` | No | Returns `{ routine }` with manifest, content, paths, last run, runs, and running flag. |
| `PUT` | `/workspaces/:workspaceId/routines/:routineId` | Yes | Body `{ manifest?, routineContent? }`. Revalidates the merged manifest, preserves id/kind/schema/routineFile, and returns `{ routine }`. |
| `POST` | `/workspaces/:workspaceId/routines/:routineId/install` | Yes | Body `{ state:'enabled'|'disabled' }`. Installs or disables a proposed/existing routine and returns `{ routine }`. |
| `POST` | `/workspaces/:workspaceId/routines/:routineId/run` | Yes | Starts a background manual run. Proposed routines return `409`; already-running routines return `409`; success returns `{ ok:true, started:true, routine?, run? }`, where `routine`/`run` are included when the initial run snapshot is available before the response deadline. |
| `DELETE` | `/workspaces/:workspaceId/routines/:routineId` | Yes | Deletes a non-starting/non-running routine folder and returns `{ ok:true }`. |

Unknown workspaces and routines return `404`. Contract validation failures
return `400`. Action routes, proposal validation, Telegram destination pairing,
repair, detail, mutation, run, delete, and routine explorer scopes return `403`
while the workspace Routines toggle is disabled.

Routine output and persistent-state browsing uses the shared explorer routes
instead of routine-specific file routes. `scope=routine-output` opens one run's
`output/` folder, `scope=routine-outputs` opens the routine's `runs/` folder,
and `scope=routine-state` opens the routine's `persistent-state/` folder. These
scopes are read-only: explorer tree, preview, raw file, and download routes are
available, while create/upload/edit/rename/delete routes reject routine scopes
with `403`.

## Frontend

`web/AgentCockpitWeb/src/api.js` exposes routines helpers under
`AgentApi.workspace`: list, enable/disable, detail/update/install/run/delete,
repair instructions, proposal validation, and save settings.

Workspace Settings has a **Routines** tab. When disabled, it uses the same
narrow settings layout as Memory and Knowledge Base: explanatory copy, the
workspace-level enable toggle, and a muted disabled status line. It does not
show the routine list, outreach controls, editor, run actions, or repair
control. When enabled, it reuses the Workspace Context rail/content shell and
general Agent Cockpit controls, with the workspace toggle in the left rail:

- left rail: routine list, refresh, repair instructions, Telegram enablement
  and workspace destination settings, plus an **Open Integrations** shortcut
  when the shared Telegram bot is not configured globally;
- detail editor: title, trigger, harness profile, notification, and editable
  routine markdown. Scheduled triggers use an IANA timezone `<select>` populated
  from `Intl.supportedValuesOf('timeZone')` when available, always include
  `UTC`, preserve any saved timezone not present in the browser list, and offer
  `Browser default ({resolved timezone})` as the blank/default value;
- actions: proposed routines show install enabled, install disabled, outputs,
  persistent state, save routine, refresh, and delete; enabled/disabled routines
  order the row as run now, outputs, persistent state, save routine, refresh,
  enable/disable, and delete, with the management actions visually pushed to the
  right on wide screens;
- runs: latest run records first with status/time, notification/failure
  details, and a **Browse Output Folder** action for runs with `outputDir`.
  The action opens the shared Files Browser in read-only `routine-output` scope
  for the run's `routineId` and `runId`, so users inspect/download artifacts
  without seeing the full data-root path in the card. The top-level
  **Outputs** action opens the same Files Browser in read-only
  `routine-outputs` scope rooted at the routine's `runs/` folder, so users can
  browse all run folders and their `output/` children. The top-level
  **Persistent State** action opens the same Files Browser in read-only
  `routine-state` scope rooted at the routine's `persistent-state/` folder so
  users can inspect cross-run files such as cursors or comparison baselines.
  Closing any routine-scoped Files Browser view restores Workspace Settings to
  the Routines tab with the same routine selected.

Chat assistant messages use `messageParsing.extractRoutineProposals()` to hide
proposal markers and render `RoutineProposalCard` under the text. The card uses
the current `FileViewerContext` workspace reference and opens Workspace Settings
on the Routines tab after install.

## Tests

Focused coverage:

- `test/routines.service.test.ts`: disabled workspace no-scaffolding listing,
  authoring files and AGENTS block, proposal validation, manifest schedule
  validation, install/edit/delete, run execution and notification routing,
  process-local Telegram destination pairing, scheduler due checks, Telegram
  request shape.
- `test/chat.routines.test.ts`: HTTP default-disabled listing, stale managed
  `AGENTS.md` block cleanup while disabled, enable/disable route behavior,
  proposal validation before and after install,
  install/edit/background run/delete, token redaction and clearing, Telegram
  destination pairing routes, and routine output/persistent-state explorer
  scopes.
- `test/frontendRoutes.test.ts`: static route/UI coverage for routines API
  helpers, Workspace Settings tab, proposal parsing/card, output and persistent
  state browser scopes, Telegram destination pairing UI, polling behavior, and
  style imports.

Verification commands for this feature include:

```bash
npm test -- --runInBand test/routines.service.test.ts test/chat.routines.test.ts
npm run web:typecheck
npm run web:build
npm run typecheck
npm run spec:drift
```
