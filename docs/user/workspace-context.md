# Workspace Context

Workspace Context is markdown-first operating memory for a workspace. When you
enable it, Agent Cockpit creates a `workspace-context/` folder in its own data
directory and adds a managed pointer to the workspace `AGENTS.md` file. The CLI
then reads and updates those markdown files directly as it learns durable
context.

Use it for long-lived knowledge that should survive individual chats:

- people and how to engage with them;
- projects, goals, open threads, and risks;
- decisions, commitments, and status changes;
- notes learned from meetings, Slack exports, mail threads, documents, and
  conversations;
- cross-references between personal, project, and workspace context.

## How It Works

Workspace Context does not maintain a hidden graph database. The markdown folder
is the source of truth.

When enabled, Agent Cockpit:

1. creates `workspaces/{hash}/workspace-context/WORKSPACE_CONTEXT.md`;
2. creates `workspaces/{hash}/workspace-context/context/overview.md`;
3. adds a managed Workspace Context block to the workspace `AGENTS.md`;
4. runs the configured Workspace Context processor to scan recent
   conversation/session files;
5. repeats scans on the configured interval, after session reset/archive, and
   runs maintenance over existing context files on the maintenance interval.

The generated instructions tell the CLI to update the markdown directly without
asking for approval. You can inspect the files from Workspace Settings, but the
preview is read-only. To correct or change learning, say what should change in
chat so the CLI can update Workspace Context through normal workspace tools.

## Settings

Global Settings → Workspace Context configures the default processor profile,
model, effort, scan interval, maintenance interval, concurrent workspace scan
cap, and concurrent workspace maintenance cap.

Workspace Settings → Workspace Context lets you:

- enable or disable Workspace Context for that workspace;
- choose global processor defaults or a workspace-specific override;
- run a scan now;
- run maintenance now;
- repair the `AGENTS.md` instruction pointer;
- preview the markdown files;
- inspect recent run summaries;
- clear the Workspace Context folder while keeping enablement/settings.

Run summaries are short-term operational logs. Maintenance removes Workspace
Context run logs older than one week; durable learned context stays in the
markdown files.

## Data Location

Workspace Context data lives under Agent Cockpit's data root, not inside the
user workspace:

```
data/chat/workspaces/{hash}/workspace-context/
```

The workspace itself only receives a managed `AGENTS.md` block that points the
CLI to the generated instructions and markdown folder.

For implementation details, see
[spec-workspace-context.md](../spec-workspace-context.md).
