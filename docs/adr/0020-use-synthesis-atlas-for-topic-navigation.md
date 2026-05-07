---
id: 0020
title: Use synthesis atlas for topic navigation
status: Superseded
date: 2026-05-02
supersedes: []
superseded-by: 0035
tags: [frontend, knowledge-base, synthesis, graph]
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

The V2 Knowledge Base Synthesis tab already exposes synthesized topics and connections, but the default list makes it difficult to understand the overall shape of a knowledge base. A generic force-directed node map was considered during exploration, but raw topic graphs tend to produce hub-and-spoke or hairball layouts that are visually noisy and do not explain the synthesis structure.

The Synthesis tab's strongest existing workflow is the right-side reader: selecting a topic shows its prose, entries, and related topics. Any visual overview should improve navigation into that reader rather than turn Synthesis into an editable graph workspace.

## Decision

Add an optional Atlas view alongside the existing List view. List remains the default. Atlas is a read-only cluster overview rendered with local HTML/CSS and a small plain-JS helper (`synthesisAtlas.js`), not a graph-rendering dependency.

The atlas derives map-friendly structure from the existing `topics[]` and `connections[]` response: it identifies bridge/god topics, groups tightly connected topics into labeled area cards, collapses singleton leftovers into one `Uncategorized / Review` area, and summarizes cross-area connections as bridge chips. Topic clicks keep using the existing `KbTopicDetail` reader. Area and bridge clicks show lightweight overview/detail panels in the same right pane.

## Alternatives Considered

- **Generic force-directed graph with Sigma/Graphology**: Rejected because it emphasized graph physics over synthesis meaning, repeatedly produced star/hairball layouts for hub-heavy data, and needed manual layout controls to become understandable.
- **Flowsint-style graph workspace**: Rejected because it implies editable investigation-board semantics, saved node positions, and graph workspace state. Synthesis needs navigation into generated prose.
- **Backend-generated atlas schema first**: Deferred because a client-derived atlas can validate the interaction model without changing the Dream pipeline or database schema.
- **Keep list-only navigation**: Rejected because it leaves existing `synthesis_connections` data mostly invisible and provides no big-picture view.

## Consequences

- + Users can switch to a big-picture cluster overview without losing the current topic reader workflow.
- + The implementation adds no new runtime dependency and keeps graph-shaping logic testable outside the React screen.
- + Hub-heavy data is represented as bridge/topic-card structure instead of being forced into a star layout.
- - The first atlas pass infers clusters from existing topic/connection data, so area labels and grouping are useful but not as semantically rich as Dream-generated clusters would be.
- ~ A future Dream pipeline can replace the inferred atlas model with first-class `clusters[]` and `bridges[]` without changing the reader contract.

## References

- `docs/spec-frontend.md` Knowledge Base Browser section.
- `docs/spec-testing.md` `test/synthesisAtlas.test.ts`.
