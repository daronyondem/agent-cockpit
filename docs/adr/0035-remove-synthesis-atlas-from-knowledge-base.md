---
id: 0035
title: Remove visible synthesis atlas mode from knowledge base
status: Accepted
date: 2026-05-06
supersedes: [0020]
superseded-by: null
tags: [frontend, knowledge-base, synthesis]
affects:
  - public/v2/index.html
  - public/v2/src/synthesisAtlas.js
  - public/v2/src/screens/kbBrowser.jsx
  - public/v2/src/app.css
  - docs/spec-frontend.md
  - docs/spec-testing.md
  - test/synthesisAtlas.test.ts
  - test/frontendRoutes.test.ts
---

## Context

ADR-0020 added an optional Synthesis Atlas mode to the Knowledge Base Synthesis tab. The mode introduced a separate `Browse | Atlas` switch, a standalone `synthesisAtlas.js` helper, atlas-specific CSS, atlas bridge/area detail panels, and helper tests. Later KB design work reused the helper's area grouping inside the normal Browse list.

The KB pipeline and synthesis UI have since shifted toward explicit operational stages and a single topic-reader workflow. Keeping a second atlas navigation mode increases the surface area users need to understand without being required for Dream, topic browsing, topic detail reading, connections, or reflections.

## Decision

The Knowledge Base removes the visible Synthesis Atlas mode entirely.

The Synthesis tab keeps one topic browser and one topic detail reader. It no longer persists a per-workspace synthesis view mode and no longer exposes the Atlas toggle, atlas card overview, atlas bridge detail, or atlas area detail panels. The existing `synthesisAtlas.js` helper remains loaded as an internal grouping helper for the Browse list's area-first presentation. Topic search continues to filter the topic browser, and topic selection continues to open `KbTopicDetail`.

## Alternatives Considered

- **Keep Atlas as an optional advanced mode**: Rejected because the extra mode still occupies visible UI and documentation space even when most users should stay in the topic browser.
- **Hide Atlas behind a feature flag**: Rejected because this keeps the visible mode semantics alive for a feature we no longer want in the KB surface.
- **Rename Atlas to Areas**: Rejected because it preserves the same inferred area/bridge model and does not reduce conceptual load.

## Consequences

- + The KB Synthesis tab has one navigation model: search topics, select a topic, read synthesized detail.
- + The frontend no longer exposes the Atlas mode or related selection panels.
- + The normal Browse list keeps its existing area-first presentation.
- + Atlas-mode-specific UI, detail styles, and documentation can be deleted instead of maintained as dead or hidden code.
- - Users lose the inferred area/bridge overview that ADR-0020 introduced.
- ~ Existing synthesis data is unchanged; topics, connections, reflections, and Dream pipeline behavior remain server-side concepts and API fields.

## References

- Supersedes ADR-0020.
- `docs/spec-frontend.md` Knowledge Base Browser section.
- `docs/spec-testing.md` frontend route coverage.
