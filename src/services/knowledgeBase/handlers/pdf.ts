// ─── PDF handler ────────────────────────────────────────────────────────────
// Uses `unpdf` (pdfjs-dist wrapper compiled for serverless Node). Extracts
// per-page text and joins it as Markdown with H2 page markers so the
// digestion prompt can cite pages.
//
// Image extraction is intentionally NOT done here — unpdf returns raw RGBA
// pixel data which would require `sharp` or `pngjs` to encode as PNG, and
// neither dep carries its weight for PR 2. Text is the primary signal the
// Digestion CLI needs; PDF image support can be added as a follow-up without
// touching the handler contract.

import { extractText, getDocumentProxy } from 'unpdf';
import type { Handler, HandlerResult } from './types';

export const pdfHandler: Handler = async ({
  buffer,
  filename,
}): Promise<HandlerResult> => {
  // unpdf wants a Uint8Array, not a Buffer. Buffer IS a Uint8Array but
  // pdfjs sometimes chokes on shared ArrayBuffer views, so we slice to
  // own the memory.
  const data = new Uint8Array(buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ));

  const pdf = await getDocumentProxy(data);
  const { totalPages, text } = await extractText(pdf, { mergePages: false });

  // `text` is a string[] — one entry per page. Join with page headings so
  // the Digestion CLI can refer to "Page 3" in its summaries.
  const pageMarkdown = text
    .map((pageText, idx) => {
      const trimmed = (pageText || '').trim();
      if (!trimmed) return `## Page ${idx + 1}\n\n_[empty page]_`;
      return `## Page ${idx + 1}\n\n${trimmed}`;
    })
    .join('\n\n');

  const body = `# ${filename}\n\n${pageMarkdown}`;
  const wordCount = pageMarkdown.split(/\s+/).filter(Boolean).length;

  return {
    text: body,
    mediaFiles: [],
    handler: 'pdf',
    metadata: {
      pageCount: totalPages,
      wordCount,
    },
  };
};
