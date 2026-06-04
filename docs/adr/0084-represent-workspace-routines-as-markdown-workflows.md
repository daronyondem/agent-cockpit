---
id: 0084
title: Represent workspace routines as markdown workflows
status: Accepted
date: 2026-06-03
supersedes: []
superseded-by: null
tags: [routines, workspace, scheduling, harness]
affects:
  - src/contracts/routines.ts
  - src/services/routines/service.ts
  - src/routes/chat/routineRoutes.ts
  - src/routes/chat.ts
  - server.ts
  - web/AgentCockpitWeb/src/api.js
  - web/AgentCockpitWeb/src/workspaceSettings.jsx
  - web/AgentCockpitWeb/src/chat/messageParsing.ts
  - web/AgentCockpitWeb/src/chat/messageContent.jsx
  - docs/spec-routines.md
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
  - docs/parity-decisions.md
---

## Context

Agent Cockpit users want background use cases such as periodic outreach prep,
monitoring, and reporting. The LinkedIn commenting discussion was a concrete
example, but the product need is not LinkedIn-specific. The recurring pattern is
workspace-scoped automation: a harness should use the same workspace context,
knowledge, memory, files, CLI profiles, and tools that a normal conversation
can use, while Agent Cockpit supplies scheduling, execution visibility, run
storage, and user notification delivery.

The feature also needs to preserve the existing harness model. Agent Cockpit
should not define a rigid domain workflow language or encode task-specific
logic in the scheduler. The harness is better positioned to write and revise
the prompt/workflow, while Agent Cockpit is better positioned to run it
reliably and show status.

## Decision

Represent each routine as a workspace-owned markdown workflow plus a small JSON
manifest. Agent Cockpit owns proposal discovery, install/enable/disable/delete
lifecycle, schedule evaluation, per-run folders, status/history, and outreach
delivery. The harness owns task intelligence by reading and following
`routine.md` during each run.

Routine creation is file-based. `RoutinesService.ensureWorkspace()` writes a
workspace `routines/ROUTINE_AUTHORING.md` contract and a managed `AGENTS.md`
block. When a user asks a harness to create a routine, the harness writes
`routines/items/{routineId}/manifest.json` and `routine.md` with
`state:"proposed"`, then returns an
`AGENT_COCKPIT_ROUTINE_PROPOSAL` marker. The desktop chat renderer strips that
marker, validates it with the server, and offers install actions. Dismissal is
not a separate state; proposals remain visible in the workspace routines list
until installed, disabled, edited, or deleted.

Routine execution is a one-shot CLI run. The service injects the routine
markdown, workspace path, output/tmp folders, a persistent state folder under
Agent Cockpit data, previous-runs path, optional Workspace Context and Knowledge
Base pointers, and a `notify.md` path into the run prompt. Routine prompts tell
harnesses not to create `.agent-cockpit` or similar hidden Agent Cockpit
metadata folders in the workspace unless the user requested workspace-visible
output. If the run writes `notify.md` and workspace outreach is configured,
Agent Cockpit routes that user-facing message to the configured channel. The
first outreach channel is Telegram.

The runtime lifecycle states are intentionally small:
`proposed`, `enabled`, and `disabled`.

## Alternatives Considered

- **Domain-specific products such as LinkedIn commenting**: rejected because
  the infrastructure need is broader than one channel or task type. A narrow
  product would duplicate scheduling, logs, context access, and notification
  behavior for every future use case.
- **A visual or structured workflow DSL**: rejected because it would move task
  intelligence into Agent Cockpit and require a new authoring surface before
  the pattern is proven. Markdown workflows let existing harnesses create and
  revise routines with the tools they already have.
- **Scheduled conversations only, without routine files**: rejected because
  durable files make review, editing, run-folder handoff, and proposal
  detection explicit. A hidden scheduled-chat transcript would be harder to
  inspect and harder for another conversation in the same workspace to edit.

## Consequences

- + New routine types can be added without product-specific backend code.
- + Routines inherit workspace scope and existing workspace tools by default.
- + Users can inspect and edit the actual markdown workflow from any
  conversation or Workspace Settings surface in the same workspace.
- + Scheduling and notification behavior is centralized and observable.
- - Agent Cockpit cannot fully validate whether a routine's markdown will
  produce useful task behavior; that remains harness output quality.
- - The first creation flow depends on harnesses following the generated
  authoring contract and emitting a valid proposal marker.
- ~ Desktop V2 owns routine administration initially. The mobile PWA can still
  benefit from background routine outputs sent through external channels, but
  routine management remains a desktop settings workflow until a compact mobile
  design exists.

## References

- [Workspace Routines spec](../spec-routines.md)
- [API endpoints spec](../spec-api-endpoints.md)
- [Backend services spec](../spec-backend-services.md)
- [Frontend spec](../spec-frontend.md)
- [Mobile parity decisions](../parity-decisions.md)
