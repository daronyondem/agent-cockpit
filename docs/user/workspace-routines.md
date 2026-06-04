# Workspace Routines

Workspace Routines are repeatable workspace workflows that Agent Cockpit can run
manually or on a schedule through one of your configured CLI profiles. The
routine itself is a markdown prompt workflow. Agent Cockpit provides the
infrastructure around it: proposal cards, schedule checks, run folders, status
history, output browsing, persistent state, and notification delivery.

Use routines for recurring work such as checking a website for changes,
summarizing a source on a schedule, preparing a daily brief, or running a
workspace-specific maintenance workflow.

## Create A Routine

Create routines from any conversation in the workspace. Ask the harness to
create or update an Agent Cockpit routine, for example:

```text
Create this as an Agent Cockpit routine that runs every morning and notifies me
if there is a change.
```

Agent Cockpit installs a managed `AGENTS.md` pointer for the workspace that
tells the harness where the routine authoring contract lives. The harness reads
that contract, writes a `manifest.json` plus `routine.md` under Agent Cockpit's
workspace data directory, and returns a proposal marker in its final message.

The chat message shows a routine proposal card:

- **Install** enables the routine immediately.
- **Install disabled** saves it without scheduling it.

If you close the card or ignore it, the routine remains proposed. Proposed
routines can still be reviewed or deleted later from Workspace Settings.

## Manage Routines

Open Workspace Settings -> Routines to see the workspace's routine list. The
routine detail view lets you edit:

- title and description;
- trigger type, schedule interval, weekdays, time window, and timezone;
- CLI profile, model, and effort overrides;
- notification mode;
- the markdown workflow in `routine.md`.

Changing the title does not rename the routine id or move local folders. The
stable id is chosen when the routine is created so existing runs, output links,
and persistent state keep working.

Enabled scheduled routines run automatically when due. Disabled routines do not
run on a schedule, but can still be tested with **Run now**. Proposed routines
cannot be run until installed.

## Runs And Files

Each execution gets its own run folder with:

- `input.md`: the complete prompt Agent Cockpit gave the CLI;
- `output/`: durable artifacts from that run;
- `tmp/`: scratch space for that run;
- `final.md`: optional final run output;
- `notify.md`: optional user notification text.

The routine also has a `persistent-state/` folder for cross-run state such as
cursors, previous values, or comparison baselines.

From the routine detail page:

- **Run now** starts a manual run and stays disabled while the run is active.
- **Outputs** opens all run folders for that routine in the Files Browser.
- **Persistent State** opens the routine's cross-run state folder.
- **Browse Output Folder** on a run opens that run's `output/` folder.

Routine file browser views are read-only. Closing them returns to the same
routine detail page.

## Telegram Notifications

Telegram setup has two parts:

1. Global Settings -> Integrations stores the Telegram bot token once.
2. Each workspace chooses its own Telegram destination chat.

To configure the global token, create or reuse a Telegram bot and paste its bot
token into Global Settings -> Integrations -> Telegram. Agent Cockpit stores the
token locally and never sends it back to the browser after save.

To connect a workspace destination, open Workspace Settings -> Routines and use
**Connect Destination**. Agent Cockpit shows a short command such as:

```text
/connect AC-123456
```

Send that command to the bot from the Telegram chat that should receive routine
notifications. For groups, add the bot to the group first and send the command
inside the group. Agent Cockpit detects the chat through Telegram updates,
stores that workspace's chat id/title/type, and enables Telegram outreach for
the workspace.

The **Chat ID (advanced)** field remains available when you already know the
destination chat id or when Telegram update polling is not available for the
bot.

Routines send a Telegram message only when the routine has
`notification.mode: "workspaceDefault"` and the run writes non-empty text to
`notify.md`. Notification delivery errors are recorded on the run log but do not
turn an otherwise successful run into a failed run.

## Data Location

Routine data lives under Agent Cockpit's data root, not inside the workspace
project folder:

```text
data/chat/workspaces/{storageKey}/routines/
```

The workspace itself only receives a managed `AGENTS.md` block that points the
CLI to the routine authoring contract and routine data folder.

For implementation details, see [spec-routines.md](../spec-routines.md).
