# Memory

Memory stores durable workspace notes for future conversations. It is separate
from a single vendor's memory feature and is scoped to the Agent Cockpit
workspace.

## What Memory Is For

Use Memory for recurring facts, preferences, decisions, and project context that
should survive conversation resets and backend switches.

Examples:

- project conventions;
- user preferences;
- recurring workflow rules;
- durable decisions from prior conversations;
- important external references.

## How It Works

Agent Cockpit stores memory files under the workspace data directory. Supported
backends can read relevant memory through the local context mechanisms Agent
Cockpit provides, and memory review workflows help keep persistent notes useful
instead of letting them grow unchecked.

## Relationship To Knowledge Base And Workspace Context

- **Memory** is for concise durable notes.
- **Knowledge Base** is for source documents and extracted entries.
- **Workspace Context** is for CLI-maintained operating context in markdown.

Use the smallest feature that matches the job. A short preference belongs in
Memory; a PDF belongs in the Knowledge Base; an evidence-backed relationship
between projects belongs in Workspace Context when it should guide future CLI
work.
