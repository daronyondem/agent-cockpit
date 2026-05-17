# Context Map

Context Map is the workspace-level graph feature. It tracks important entities,
relationships, facts, and evidence for a workspace so AI backends can retrieve
compact context instead of rereading everything.

## What It Tracks

Context Map can represent:

- people;
- projects;
- services;
- documents;
- decisions;
- implementation areas;
- dependencies and ownership relationships.

Each conclusion is evidence-backed so users can review where it came from.

## How It Works

When enabled, Context Map scans high-signal workspace files and conversation
history in the background. It proposes graph updates, applies safe updates when
policy allows, and surfaces review items for user attention.

The active CLI can read the map through read-only MCP tools. It receives compact
context packs, not the entire graph.

## When To Use It

Use Context Map when a workspace has enough long-lived structure that a normal
chat history or short memory note is not enough:

- larger software repositories;
- research or planning folders;
- client/account workspaces;
- projects with many decisions and dependencies.

For implementation details, see [spec-context-map.md](../spec-context-map.md).
