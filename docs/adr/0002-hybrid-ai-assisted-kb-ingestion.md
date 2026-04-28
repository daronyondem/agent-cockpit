---
id: 0002
title: Hybrid AI-assisted Knowledge Base ingestion
status: Accepted
date: 2026-04-28
supersedes: []
superseded-by: null
tags: [knowledge-base, ingestion, historical]
affects:
  - docs/design-kb-ingestion-hybrid.md
  - src/services/knowledgeBase/ingestion.ts
  - src/services/knowledgeBase/handlers/pdf.ts
  - src/services/knowledgeBase/handlers/docx.ts
  - src/services/knowledgeBase/handlers/pptx.ts
  - src/services/knowledgeBase/handlers/passthrough.ts
  - src/services/knowledgeBase/handlers/types.ts
  - src/services/knowledgeBase/ingestion/pageConversion.ts
  - src/services/knowledgeBase/ingestion/pdfSignals.ts
  - src/services/knowledgeBase/ingestion/pptxSignals.ts
  - src/services/knowledgeBase/digest.ts
---

## Context

Two failure modes drove this redesign:

1. **Vision-only PDFs lose coverage at digestion.** A 185-page rasterized PDF (`Agentic Artificial Intelligence`) produced only 20 entries. The PDF handler converted every page to a 150 DPI PNG and wrote a thin `text.md` index of `![Page N](pages/page-NNNN.png)` links — no extracted text. Digestion was then asked, in a single CLI call, to read 185 page images and emit structured entries. The output token budget pushed the CLI toward "summarize and merge" rather than "one entry per concept."
2. **Per-format quality varied dramatically.** PDFs are 100% image (great fidelity, poor accessibility). PPTX text is XML-extracted (loses tables and chart content). DOCX is high-quality pandoc output but embedded images had no description. Passthrough images were stored as-is. The same digestion pass had to cope with very different input qualities.

The root cause: **the only intelligent step in ingestion was digestion**, which had to read images, recognize tables, describe figures, *and* produce structured entries — all in one shot.

## Decision

Move intelligence earlier in the pipeline. A new **Ingestion CLI** converts visual content (PDF pages, slide images, embedded DOCX figures, standalone uploaded images) into clean Markdown at ingest time, so digestion sees real text instead of image links.

Hybrid means: **deterministic extraction where it is reliable, AI conversion only where it actually adds quality.** Per-handler classification rules drive which path each unit takes:

- **PDF**: per-page signals via pdfjs (`figureCount`, `tableLikely`). Pages with no figures and no tables → `pdfjs` text. Otherwise → AI conversion.
- **DOCX**: pandoc for prose (unchanged). Embedded images ≥ 100px wide → AI description appended.
- **PPTX**: XML extraction (unchanged) for pure text/bullet slides. Slides with `<a:tbl>` / `<p:pic>` / `<a:chart>` → AI conversion of the rendered slide image (gated on `convertSlidesToImages` + LibreOffice).
- **Passthrough images**: unconditional AI description.

Every block is annotated `source: pdfjs | xml-extract | artificial-intelligence | image-only` so digestion knows where the text came from and how authoritative it is. The original page/slide/image is **always** preserved as a backup reference. One retry on AI failure; second failure → `source: image-only` (graceful degradation, never blocks ingestion).

A single unified image-to-markdown prompt is used for all four AI call sites. Concurrency is bounded per workspace (`cliConcurrency`, formerly `dreamingConcurrency`) and shared between ingestion and digestion via a single `WorkspaceTaskQueue`; folder operations act as drain barriers.

## Alternatives Considered

- **Keep the status quo (deterministic-only ingest, all intelligence at digest)**. Rejected: this is what produced the 20-entries-from-185-pages result. The output token budget on a single mega-call is fundamentally incompatible with "one entry per concept" on large vision-only documents.
- **AI-only ingestion (run every page/slide/image through the converter unconditionally)**. Rejected: wasteful and lower quality on prose-heavy PDFs/DOCX where pdfjs/pandoc already produce clean text. The hybrid rules let us pay the AI cost only where deterministic extraction loses information.
- **Add OCR as a separate ingest step**. Rejected: a multimodal converter subsumes OCR for free *and* captures table structure, figure descriptions, and chart data — all of which OCR alone would miss.
- **Apply cost caps to the AI calls (e.g. max N pages converted per document)**. Rejected: explicitly out of scope. Quality is the primary objective; a 500-page scanned PDF will issue 500 sequential calls. If a user wants to cap cost, they leave the Ingestion CLI unconfigured and accept `source: image-only` for `needs-ai` pages.
- **Use a character-count threshold to decide whether a page needs AI** (e.g. "if extracted text < 200 chars, it's probably a scanned page"). Rejected: the figure/table signals already cover the cases that matter. Scanned pages contain a full-page image XObject so `figureCount > 0` → `needs-ai` correctly. A blank page has no figures and no tables → `safe-text` → empty page block, which is also correct (no false work).
- **Auto-migrate existing `pdf/rasterized` entries to the new hybrid handler on deploy**. Rejected: too invasive. Users re-upload manually if they want the benefit. Old entries continue to digest under the source-aware rule as `image-only`, which is no worse than before.
- **One CLI call per document instead of per page**. Rejected: this is exactly what digestion does today and is the source of the coverage problem. Per-page calls keep each invocation's output budget focused on a single unit.

## Consequences

- + Vision-only PDFs become fully digestible: each page yields its own structured Markdown before digestion runs.
- + Tables and chart data, which XML/text extraction silently drops, are recovered at ingest time.
- + Digestion prompt becomes simpler (it now just synthesizes entries from real text) and more accurate (the `source:` annotations let it judge how much to trust each block).
- + Graceful degradation: if `ingestionCliBackend` is unset, the system still ingests — just at lower quality. Never blocks.
- + The `meta.json` `pages[]` / `slides[]` / `images[]` arrays with per-unit classification give us the data to tune heuristic thresholds retroactively.
- - Latency and cost grow with document size. A 500-page scanned PDF will issue 500 sequential CLI calls per document (parallelism is across documents, not within). This is the explicit tradeoff for quality.
- - Three vision-capable CLI configurations now matter (Ingestion, Digestion, Dreaming). More to misconfigure; the Settings screen surfaces the dependency on `convertSlidesToImages` + LibreOffice for PPTX.
- - The `tableLikely` heuristic and the 100px DOCX-image cutoff are tuned on a small corpus and may misclassify edge cases. Per-unit telemetry in `meta.json` gives us a recovery path.
- ~ Ingestion is no longer a "pure" deterministic step — it now has a non-deterministic AI path with retries. This pushes some failure-handling complexity earlier in the pipeline (new `ingestion_cli_error` `KbErrorClass`).
- ~ Backward-incompatible handler tag (`pdf/rasterized` → `pdf/rasterized-hybrid`) means existing entries do not silently benefit from the new flow. We chose explicitness over magic re-ingestion.

## References

- docs/design-kb-ingestion-hybrid.md — the full design doc, including unified prompt text, `meta.json` schema, signal heuristics, and PR sequencing
- Issue #211 and PRs #213–#228 — the implementation sequence (8 design PRs plus follow-ups for image downscaling #222, PPTX paragraph structure #219, adaptive CLI timeouts #228)
