// ─── PDF handler (rasterization only) ──────────────────────────────────────
// PDFs are converted page-by-page into high-resolution PNGs via unpdf's
// `renderPageAsImage` + `@napi-rs/canvas`. We deliberately do NOT run the
// pdfjs text extractor here:
//
//   - The previous text-only path fed flattened text into Digestion,
//     which meant tables, multi-column layouts, equations, and anything
//     relying on visual structure got mangled — same failure mode we
//     just fixed for DOCX.
//   - The Digestion CLI is multimodal; it can read the page images
//     directly and reason about layout, tables, and diagrams.
//
// `text.md` is still produced but is a thin index of page image
// references (Option B from the design doc): one `## Page N` section per
// page with a relative image link. The CLI follows the links to look at
// each page as an image. PDFs with zero-page or malformed output still
// get a useful error because we propagate unpdf failures to the
// orchestrator.

import path from 'path';
import { promises as fsp } from 'fs';
import { renderPageAsImage, getDocumentProxy } from 'unpdf';
import * as napiCanvas from '@napi-rs/canvas';
import type { Handler, HandlerResult } from './types';

/** Target DPI for rasterized pages. 150 DPI is the sweet spot for OCR and
 * vision-model readability without blowing up file sizes on big decks —
 * unpdf's `scale` is applied on top of the PDF's native 72 DPI, so a
 * scale of 150/72 ≈ 2.0833 gives us the desired output density. */
const TARGET_SCALE = 150 / 72;

export const pdfHandler: Handler = async ({
  buffer,
  filename,
  outDir,
}): Promise<HandlerResult> => {
  // unpdf wants a Uint8Array, not a Buffer. Buffer IS a Uint8Array but
  // pdfjs sometimes chokes on shared ArrayBuffer views, so we slice to
  // own the memory.
  const data = new Uint8Array(buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ));

  const pdf = await getDocumentProxy(data);
  const totalPages = pdf.numPages;

  // Stage output under `<outDir>/pages/`. Using a dedicated subdir keeps
  // the `media/` namespace free for passthrough/image content the
  // Digestion CLI may mix in during PR 3.
  const pagesDir = path.join(outDir, 'pages');
  await fsp.mkdir(pagesDir, { recursive: true });

  const mediaFiles: string[] = [];
  const rendered: number[] = [];
  const failed: number[] = [];

  for (let page = 1; page <= totalPages; page += 1) {
    try {
      const pngBuffer = await renderPageAsImage(pdf, page, {
        canvasImport: async () => napiCanvas,
        scale: TARGET_SCALE,
      });
      const rel = path.join('pages', `page-${String(page).padStart(4, '0')}.png`);
      await fsp.writeFile(path.join(outDir, rel), Buffer.from(pngBuffer));
      mediaFiles.push(rel);
      rendered.push(page);
    } catch {
      // A single bad page shouldn't fail the whole doc. We still record
      // the page number so the index reflects reality.
      failed.push(page);
    }
  }

  // Build a thin markdown index: one section per page with an embedded
  // image reference. The Digestion CLI follows the links to analyze
  // each page as an image. No extracted text — that's the whole point.
  const pageSections: string[] = [];
  for (let page = 1; page <= totalPages; page += 1) {
    if (rendered.includes(page)) {
      const rel = path.join('pages', `page-${String(page).padStart(4, '0')}.png`);
      pageSections.push(`## Page ${page}\n\n![Page ${page}](${rel})`);
    } else {
      pageSections.push(`## Page ${page}\n\n_[Failed to rasterize this page.]_`);
    }
  }

  const body = `# ${filename}\n\n${pageSections.join('\n\n')}`;

  const metadata: Record<string, string | number | boolean> = {
    pageCount: totalPages,
    renderedPageCount: rendered.length,
    rasterDpi: 150,
  };
  if (failed.length > 0) {
    metadata.failedPages = failed.join(',');
  }

  return {
    text: body,
    mediaFiles,
    handler: 'pdf/rasterized',
    metadata,
  };
};
