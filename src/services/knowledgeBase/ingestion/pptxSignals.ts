// ─── PPTX per-slide signals ─────────────────────────────────────────────────
// Used by the hybrid PPTX handler to decide whether each slide can be served
// from deterministic OOXML text extraction (`xml-extract`) or whether the
// rasterized slide image needs to go through the Ingestion CLI for AI
// conversion (`needs-ai`).
//
// Two signals drive the decision — same shape as the PDF classifier so the
// handler logic stays parallel:
//
//   - `figureCount`  Bumped by every embedded picture (`<p:pic>`) and every
//                    chart (`<c:chart>`) reference. Charts are particularly
//                    important — XML extraction loses chart data entirely
//                    because the data lives in a separate chart part, not
//                    in the slide's `<a:t>` runs.
//
//   - `tableLikely`  True when the slide contains an `<a:tbl>` table. Tables
//                    in PPTX flatten to a sequence of disconnected text runs
//                    when extracted without geometry, which the digestion
//                    CLI then can't reconstruct into a Markdown table.
//
// We regex over the raw slide XML *before* `removeNSPrefix` strips the
// namespaces. The XML is well-formed enough that anchored tag patterns are
// reliable here — these tag names are stable across the PPTX spec and don't
// appear inside `<a:t>` text runs (PPTX escapes `<` to `&lt;`).
//
// Errors are caller-handled: if signal detection throws (it shouldn't —
// regex over a string can't), the handler falls back to conservative
// needs-ai signals analogous to the PDF behavior.

export interface SlideSignals {
  /** Count of embedded picture + chart references in the slide. */
  figureCount: number;
  /** True when the slide contains a table element. */
  tableLikely: boolean;
}

/**
 * Detect picture/chart/table signals in a single slide's raw XML.
 *
 * Operates on the unparsed string so the namespaced tag names (`<a:tbl>`,
 * `<p:pic>`, `<c:chart>`) remain visible — `fast-xml-parser` strips those
 * prefixes when configured with `removeNSPrefix: true`.
 */
export function extractSlideSignals(rawXml: string): SlideSignals {
  const tableLikely = /<a:tbl\b/.test(rawXml);
  const picCount = (rawXml.match(/<p:pic\b/g) ?? []).length;
  const chartCount = (rawXml.match(/<c:chart\b/g) ?? []).length;
  return {
    figureCount: picCount + chartCount,
    tableLikely,
  };
}
