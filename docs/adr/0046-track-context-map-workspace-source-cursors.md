---
id: 0046
title: Track Context Map workspace source cursors
status: Proposed
date: 2026-05-10
supersedes: []
superseded-by: null
tags: [context-map, data-model, scheduler]
affects:
  - src/services/contextMap/db.ts
  - src/services/contextMap/service.ts
  - scripts/context-map-report.ts
  - docs/spec-data-models.md
  - docs/spec-backend-services.md
  - docs/spec-testing.md
---

## Context

Context Map initial and manual rebuild scans process workspace-owned sources such as workspace instructions, Markdown files, and code-outline packets. Scheduled scans previously processed only conversation deltas. That made initial scans expensive and useful, but long-running workspaces could drift after a README, spec, workflow note, or selected code-outline source changed.

Conversation deltas already have durable `conversation_cursors`, but workspace sources did not have an equivalent cursor. Re-running every source packet on every scheduled interval would be simpler, but it would waste processor calls and increase review noise. We also need a conservative way to notice when a previously processed source disappears without deleting graph data that may still be useful.

## Decision

Context Map stores durable workspace source cursors in `source_cursors`, keyed by `(source_type, source_id)`. A source cursor records the last processed source hash, last processed time, last seen time, the last run id, lifecycle status (`active` or `missing`), and an optional error message.

Initial scans and manual rebuild scans process all selected workspace source packets and update source cursors for successfully parsed packets. Scheduled scans still discover the selected source set, but they only extract packets with no cursor, a changed source hash, or a previously `missing` cursor. Unchanged packets are skipped and counted in run metadata. If a previously active cursor is not discovered during a workspace source discovery pass, or a selected source is discovered but can no longer be packetized because it is empty, unreadable, oversized, or shim-skipped, the service marks the cursor `missing` and records sampled stale-source metadata on the run; it does not delete entities, candidates, facts, relationships, or evidence. Lower-ranked recursive Markdown files outside the scan cap remain discovered/deferred so existing cursors are not marked missing only because the cap excluded them from the current selected packet set.

Scheduled runs use a lower candidate-synthesis threshold than initial/manual scans. Initial/manual scans keep the normal threshold because they are broad scans with larger batches. Scheduled runs synthesize at three or more candidates so smaller incremental source/conversation batches still get model judgment before persistence.

## Alternatives Considered

- **Reprocess all workspace source packets on every scheduled scan**. Rejected because unchanged Markdown/code-outline packets would consume CLI calls every interval and could recreate avoidable duplicate/no-op suggestions.
- **Wait for manual rebuilds to refresh workspace sources**. Rejected because workspaces can run for days between resets, and durable source changes should help the user transparently without requiring manual rebuilds.
- **Delete evidence or graph rows when a source disappears**. Rejected because source disappearance is not proof that the durable context is false; it is safer to track the source cursor as missing and let the user inspect/fix the map.
- **Use the same synthesis threshold for all run sources**. Rejected because scheduled runs are intentionally smaller; waiting for eight candidates would skip synthesis on many meaningful incremental batches.

## Consequences

- + Scheduled Context Map scans now react to changed workspace instructions, Markdown files, and selected code-outline packets without reprocessing unchanged sources.
- + Missing source state is visible in run/report metadata while preserving existing graph data.
- + Manual rebuild remains a full source re-evaluation path and does not honor unchanged-source skipping.
- + Smaller scheduled batches receive synthesis cleanup earlier, improving incremental output quality.
- - The Context Map schema gains another cursor table and service planning step.
- ~ Source disappearance is metadata only; pruning stale graph data remains a separate governed workflow if it is introduced later.

## References

- [Context Map design](../design-context-map.md)
- [Data model spec](../spec-data-models.md#context-map-store-workspaceshashcontext-map)
- [Backend services spec](../spec-backend-services.md#context-map-processor-service)
