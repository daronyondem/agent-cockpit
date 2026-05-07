---
id: 0033
title: Adopt structure-guided knowledge base digestion and retrieval
status: Proposed
date: 2026-05-05
supersedes: []
superseded-by: null
tags:
  - knowledge-base
  - retrieval
  - ingestion
  - synthesis
affects:
  - docs/design-kb-vnext-implementation-plan.md
  - docs/design-kb-ingestion-hybrid.md
  - docs/spec-data-models.md
  - docs/spec-backend-services.md
  - docs/spec-api-endpoints.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
  - docs/spec-testing.md
  - src/services/knowledgeBase/db.ts
  - src/services/knowledgeBase/digest.ts
  - src/services/knowledgeBase/ingestion.ts
  - src/services/kbSearchMcp/index.ts
  - src/services/kbSearchMcp/stub.cjs
  - src/routes/chat.ts
  - public/v2/src/screens/kbBrowser.jsx
---

## Context

The Knowledge Base already has content-addressed raw uploads, hybrid conversion into `text.md` plus extracted media, per-raw digestion into entries, PGLite vector/BM25 indexing, dreaming into topics/connections/reflections, and MCP tools for retrieval.

That foundation is strong enough to process large files, including scanned PDFs, but the final extraction step still digests the whole converted document through one model response. For a 500-page PDF the converter can render and classify every page, and the digestion timeout can stretch to many hours, but coverage is still bounded by one prompt and one output budget.

Issues #123, #137, #138, and #244 describe related KB improvements: synthesis evidence history, glossary-assisted recall, multi-pass gleaning, and graph-neighborhood retrieval. VectifyAI/PageIndex points at a compatible architecture pattern: preserve document structure, summarize ranges, and let retrieval fetch tight source ranges instead of relying only on flat chunks.

## Decision

Agent Cockpit adopts a structure-guided Knowledge Base pipeline.

The system keeps the current hybrid converter as the source of converted Markdown, media, and metadata. After conversion, KB vNext adds a document structure/range layer, a deterministic chunk planner, chunked digestion, optional gleaning, entry source lineage, glossary-expanded search, graph-neighborhood retrieval, synthesis evidence history, and visual pipeline/query traces.

The implementation lands incrementally using [the KB vNext plan](../design-kb-vnext-implementation-plan.md) as the operational roadmap. Each phase must preserve existing raw upload, conversion, entry storage, vector/BM25 search, dreaming, and MCP behavior unless that phase explicitly changes the contract and updates the specs.

Agent Cockpit does not vendor PageIndex or add a Python/LiteLLM runtime dependency for this work. PageIndex is an architectural reference for structure/range retrieval, not a package dependency.

## Alternatives Considered

- **Keep single-call digestion and increase timeouts**: rejected because it improves process survival but does not solve output-budget collapse or extraction coverage for long documents.
- **Vendor PageIndex directly**: rejected because it would introduce a second language/runtime and overlapping model orchestration stack for a pattern Agent Cockpit can implement inside its existing TypeScript KB services.
- **Only improve vector/BM25 retrieval**: rejected because search recall does not address large-document digestion coverage, source-range inspection, or synthesis provenance.
- **Split only by fixed page counts**: rejected as the complete design because fixed ranges are useful as a fallback but do not preserve headings, sections, slide boundaries, or other document-native structure.

## Consequences

- + Large documents can be digested in bounded chunks while keeping entries traceable to raw source ranges.
- + Agents can inspect document structure and fetch exact source ranges before answering or synthesizing.
- + Glossary expansion, graph traversal, and synthesis history become complementary retrieval layers instead of isolated features.
- - The KB pipeline becomes more complex across storage, queues, adapter calls, MCP tools, and UI.
- - Migrations need tighter discipline because document structure, lineage, and synthesis history add durable tables.
- ~ Mobile PWA support is evaluated for each phase, but the first visualization work is web-only unless a phase explicitly changes mobile behavior.

## References

- [KB vNext implementation plan](../design-kb-vnext-implementation-plan.md)
- [Hybrid KB ingestion design](../design-kb-ingestion-hybrid.md)
- [Data model spec](../spec-data-models.md#knowledge-base-sqlite-schema)
- [Backend services spec](../spec-backend-services.md#knowledge-base-services-srcservicesknowledgebase)
- [API endpoints spec](../spec-api-endpoints.md)
- [Frontend spec](../spec-frontend.md)
- [Mobile PWA spec](../spec-mobile-pwa.md)
- [GitHub issue #123](https://github.com/daronyondem/agent-cockpit/issues/123)
- [GitHub issue #137](https://github.com/daronyondem/agent-cockpit/issues/137)
- [GitHub issue #138](https://github.com/daronyondem/agent-cockpit/issues/138)
- [GitHub issue #244](https://github.com/daronyondem/agent-cockpit/issues/244)
- [VectifyAI/PageIndex](https://github.com/VectifyAI/PageIndex)
