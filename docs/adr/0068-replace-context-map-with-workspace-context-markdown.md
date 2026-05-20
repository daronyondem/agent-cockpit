---
id: 0068
title: Replace Context Map with Workspace Context markdown
status: Accepted
date: 2026-05-19
supersedes: [0044, 0045, 0046]
superseded-by: null
tags: [workspace-context, markdown, cli, memory]
affects:
  - AGENTS.md
  - src/types/index.ts
  - src/contracts/workspaceContext.ts
  - src/services/settingsService.ts
  - src/services/chatService.ts
  - src/services/chat/workspaceFeatureSettingsStore.ts
  - src/services/workspaceContext/defaults.ts
  - src/services/workspaceContext/service.ts
  - src/routes/chat.ts
  - src/routes/chat/workspaceContextRoutes.ts
  - web/AgentCockpitWeb/src/api.js
  - web/AgentCockpitWeb/src/workspaceSettings.jsx
  - web/AgentCockpitWeb/src/screens/settingsScreen.jsx
  - web/AgentCockpitWeb/src/streamStore.js
  - web/AgentCockpitWeb/src/shell.jsx
  - docs/spec-workspace-context.md
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-frontend.md
  - docs/spec-testing.md
  - docs/user/workspace-context.md
---

## Context

Agent Cockpit previously attempted to productize long-lived workspace learning as
a governed graph: entities, facts, relationships, evidence rows, candidate
review queues, scanner metadata, and an MCP server for lookup. Iteration against
real Daron-Life-General workflows showed that the graph made the product more
complex while producing less useful day-to-day CLI behavior than a much simpler
pattern: clear agent instructions plus local markdown files that the CLI reads
and edits agentically.

The successful mental model is "workspace operating memory", not a database
that the user reviews one atomic fact at a time. Users should not need to
approve learning. When a workspace is enabled, Agent Cockpit should give the CLI
durable instructions and a markdown folder; chat CLIs and background catch-up
runs should then maintain those files directly.

## Decision

Replace the Context Map graph subsystem with Workspace Context, a markdown-first
operating-memory feature.

Workspace Context stores canonical data under
`workspaces/{hash}/workspace-context/`:

- `WORKSPACE_CONTEXT.md` contains generated instructions for maintaining the
  workspace operating memory.
- `context/*.md` contains durable markdown files that the CLI can reorganize and
  update directly.
- `runs/` and `state.json` contain operational run history.

When enabled, Agent Cockpit installs a managed block in the workspace root
`AGENTS.md` pointing to the generated instructions and markdown folder. Normal
chat turns do not receive a Workspace Context MCP server. The CLI learns about
Workspace Context through ordinary instruction files and uses normal filesystem
tools to read or update markdown.

Background catch-up remains product-owned. The scheduler runs every minute,
finds enabled workspaces whose scan interval has elapsed, and asks the
configured processor CLI to read the generated instructions plus recent
conversation/session sources, then update markdown directly. Reset/archive
finalizer passes use the same processor for the archived session.

The settings UI is read-only for markdown content. Users can enable/disable the
feature, configure the processor profile/model/effort and scan interval, start
or stop catch-up, repair the managed instruction block, preview markdown files,
and clear generated Workspace Context data. There is no graph browser, candidate
queue, entity editor, or Workspace Context MCP server.

Legacy `contextMap` settings and workspace flags are migrated into
`workspaceContext`; legacy `context-map/` folders are removed during workspace
settings normalization.

## Alternatives Considered

- **Keep the governed graph**: Continue improving entity/fact/relationship
  extraction, candidate auto-apply, and MCP lookup. Rejected because it had
  become harder to reason about, required many product-specific heuristics, and
  still did not match the quality of direct CLI-maintained markdown.
- **Hybrid graph plus markdown projections**: Keep the graph as source of truth
  and generate markdown projections for the CLI. Rejected because it preserves
  the complex lifecycle/candidate layer while making markdown a derivative view;
  the field evidence showed the markdown itself should be the canonical layer.
- **MCP-only writable memory**: Give chat CLIs a small write API and ask them to
  submit learnings through the API. Rejected because low-capability models might
  call the wrong tools or produce low-quality structured deltas; the higher
  quality path is to let a configured processor CLI perform interpretation and
  edit the files directly.
- **User approval workflow**: Keep a review queue for learned context. Rejected
  because the target workflow trusts the CLI, matching the existing successful
  personal workspace pattern where the user asks for learning and does not
  approve individual changes.

## Consequences

- + The CLI sees the same kind of high-context markdown it already uses well.
- + The feature is simpler: no graph database, candidate lifecycle, JSON repair
  pipeline, or Workspace Context MCP server.
- + Workspace Context can ingest future source types by giving the processor CLI
  source files or source bundles without changing the canonical storage model.
- + Users can inspect the exact markdown operating memory in Workspace Settings.
- - There is less structured querying/reporting than the graph design provided.
- - Quality depends on the configured CLI's ability to maintain useful markdown.
- ~ Legacy installs need migration from `contextMap` keys and old folders, but
  the migration is one-way and intentionally discards graph state.

## References

- Supersedes [ADR-0044](0044-add-context-map-as-governed-workspace-graph.md),
  [ADR-0045](0045-scan-workspace-markdown-recursively-for-context-map.md), and
  [ADR-0046](0046-track-context-map-workspace-source-cursors.md).
- [Workspace Context spec](../spec-workspace-context.md)
- [API endpoints](../spec-api-endpoints.md)
- [Backend services](../spec-backend-services.md)
- [Data models](../spec-data-models.md)
