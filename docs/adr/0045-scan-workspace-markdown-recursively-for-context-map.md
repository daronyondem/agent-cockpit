---
id: 0045
title: Scan workspace Markdown recursively for Context Map
status: Accepted
date: 2026-05-08
supersedes: []
superseded-by: null
tags: [context-map, processing, source-selection]
affects:
  - src/services/contextMap/service.ts
  - test/contextMap.service.test.ts
  - docs/design-context-map.md
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-testing.md
---

## Context

Context Map originally processed conversations plus a small product-owned set of high-signal root/spec files during initial and manual scans. That worked for software repositories with good specifications, but it missed the main durable context in prose-heavy workspaces where important plans, contacts, projects, workflows, and decisions live in Markdown files across nested folders.

The feature should not require workspace-type configuration or a special folder name before it can discover durable Markdown context. At the same time, a literal filesystem walk over all Markdown-like content can pull in dependency package READMEs or generated application state, making scans expensive and review queues noisy.

## Decision

Context Map initial and manual scans process workspace instructions, then known high-signal Markdown files, then up to 120 additional `.md` files discovered recursively under the workspace root.

The scanner keeps source selection product-owned rather than user-configurable. It applies hard infrastructure/generated-state exclusions for `.git`, `node_modules`, and `data/chat`, ignores files over 1 MB, scores/sorts recursive Markdown files deterministically before applying the 120-file cap, truncates source bodies to the existing source character limit, and keeps per-source candidate budgets before persistence. High-signal files are loaded first so they win deterministic de-duplication ties when the same concept is also emitted from another Markdown source.

## Alternatives Considered

- **Keep only root/spec high-signal files**: Simple and cheap, but misses the primary durable material in prose-heavy workspaces.
- **Add workspace-type-specific source policies**: Could tune behavior by workspace class, but adds product complexity and forces users to classify a workspace before Context Map is useful.
- **Scan literally every Markdown file including dependencies and generated app state**: Maximizes coverage, but common workspaces contain thousands of package or generated Markdown files that are not user-authored context.
- **Expose source selection toggles immediately**: Gives control, but adds UI and mental overhead before the extraction quality and review workflow have stabilized.

## Consequences

- + Prose-heavy workspaces can produce useful Context Map suggestions from their actual working files, not only from conversations and root instructions.
- + Software workspaces still prioritize root/spec sources while gaining coverage for nested docs, plans, ADRs, and design notes.
- + Source selection stays reusable across workspace scenarios without a workspace-type switch.
- Initial and manual scans can become longer because each selected Markdown file becomes a source packet.
- Very large Markdown workspaces process the top-scored recursive set first; lower-scored files are intentionally deferred until a future source-selection expansion rather than making scans unbounded.
- - Review queues may become noisier until extraction, de-duplication, and review UX improve further.
- ~ Generated/dependency exclusions are intentionally conservative infrastructure safety rules, not user-facing source controls.

## References

- [ADR-0044: Add Context Map as governed workspace graph](0044-add-context-map-as-governed-workspace-graph.md)
- [Context Map design](../design-context-map.md)
- [Backend services specification](../spec-backend-services.md)
- [Data models specification](../spec-data-models.md)
- [API endpoints specification](../spec-api-endpoints.md)
- [Testing specification](../spec-testing.md)
