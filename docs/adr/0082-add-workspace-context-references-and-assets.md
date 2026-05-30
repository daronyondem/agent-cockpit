---
id: 0082
title: Add Workspace Context References And Assets
status: Accepted
date: 2026-05-30
supersedes: []
superseded-by: null
tags: [workspace-context, memory, assets]
affects:
  - docs/spec-workspace-context.md
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-frontend.md
  - docs/spec-testing.md
  - docs/spec-coverage.md
  - src/services/workspaceContext/service.ts
  - src/services/workspaceContext/materials.ts
  - src/routes/chat/workspaceContextRoutes.ts
  - src/contracts/workspaceContext.ts
  - web/AgentCockpitWeb/src/api.js
  - web/AgentCockpitWeb/src/fileLinks.ts
  - web/AgentCockpitWeb/src/chat/messageContent.jsx
  - web/AgentCockpitWeb/src/workspaceSettings.jsx
  - mobile/AgentCockpitPWA/src/appModel.ts
---

## Context

Workspace Context started as a markdown-first replacement for the old Context
Map graph. Its canonical durable data was `workspace-context/context/*.md`,
which works well for synthesized operating memory: current reads, people,
projects, decisions, open threads, and cross-references.

Real workspace usage also needs exact reusable materials. Users ask the CLI to
"save this prompt", "use this style guide later", or "keep this image as the
reference". Those are not the same as synthesized memory. Prompt/style guidance
should often remain exact, and images or other binary source files cannot live
inside markdown. The previous workaround was to keep workspace-local folders
such as `context/assets/` and point agents at them, which leaves Workspace
Context with two active memory homes and makes migration from older workflows
lossy.

## Decision

Workspace Context owns three durable material classes under the existing
`workspace-context/` directory:

- `context/`: synthesized operating-memory markdown maintained by the processor.
- `references/`: exact reusable markdown/text guidance, prompts, templates, and
  style rules the user wants future agents to read directly.
- `assets/`: durable non-executable reference files such as images, PDFs, CSVs,
  JSON, and text files that context or reference markdown can link to.

The generated `WORKSPACE_CONTEXT.md` tells CLIs how to classify durable material.
When a user provides durable insight, the processor updates `context/`. When the
user asks to preserve exact reusable instructions, it writes or updates
`references/`. When the user asks to preserve a file for future use, it stores or
links it under `assets/` and adds a markdown pointer from the relevant context or
reference file.

Maintenance remains centered on `context/`. It may read references as stable
supporting material and use the asset inventory for cross-links, but it should
not rewrite exact references or binary assets merely to tidy the workspace.
Migration of existing workspace-local folders into these destinations is a
separate, explicit operation.

## Alternatives Considered

- **Put everything in `context/`**: rejected because exact prompt/style files
  and binary assets have different semantics from synthesized operating memory.
  Mixing them makes context less scannable and encourages lossy rewrites.
- **Keep workspace-local `context/` folders as active references**: rejected
  because it preserves two active memory homes and leaves future agents uncertain
  which folder to update.
- **Use Knowledge Base for references and assets**: rejected because KB is an
  ingestion/digestion/search feature, while these materials are agent operating
  instructions and direct reusable files. Workspace Context is the correct
  surface for "read this before acting" guidance.

## Consequences

- + Users can continue asking CLIs to store future-use prompts, style guides,
  templates, and visual/source references without relying on ad hoc folders.
- + Workspace Context remains scannable because synthesized memory, exact
  references, and assets have distinct destinations and UI surfaces.
- + Future migration from older `context/` folders can be non-lossy: operating
  memory goes to `context/`, exact guidance to `references/`, and files to
  `assets/`.
- - The Workspace Context API, UI, and processor prompts become larger.
- - Asset handling needs explicit allowlists and traversal/symlink checks.
- ~ Maintenance must treat references and assets more conservatively than normal
  context markdown.

## References

- [ADR-0068](0068-replace-context-map-with-workspace-context-markdown.md)
- [ADR-0081](0081-make-workspace-context-consume-memory-inbox.md)
- [Workspace Context spec](../spec-workspace-context.md)
