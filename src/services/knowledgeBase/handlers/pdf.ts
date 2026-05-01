// ─── PDF handler (hybrid: pdfjs text + AI conversion per page) ──────────────
// Each PDF page goes through three steps:
//   1. Render the page to a 150 DPI PNG (always — the image is preserved
//      as a backup reference regardless of which text path runs).
//   2. Extract per-page signals via pdfjs: figureCount, tableLikely,
//      extractedText. See `../ingestion/pdfSignals.ts` for the algorithm.
//   3. Classify the page:
//        figureCount === 0 && !tableLikely → safe-text  (use pdfjs text)
//        otherwise                         → needs-ai
//      `needs-ai` pages call `convertImageToMarkdown` against the
//      configured Ingestion CLI; on failure (or when no Ingestion CLI is
//      configured) the page falls back to `image-only` — the markdown
//      contains just the image link with no body text.
//
// `text.md` is structured as one `## Page N` block per page. Each block
// carries a `> source: ... | figures: N | table-likely: T/F` annotation
// so the Digestion CLI knows where the body text came from. The image
// link is **always** present, regardless of source.
//
// See `docs/design-kb-ingestion-hybrid.md` §4 for the full design.

import path from 'path';
import { promises as fsp } from 'fs';
import {
  renderPageAsImage,
  getDocumentProxy,
  createIsomorphicCanvasFactory,
  getResolvedPDFJS,
} from 'unpdf';
import * as napiCanvas from '@napi-rs/canvas';
import type { Handler, HandlerResult } from './types';
import {
  extractPageSignals,
  type OpsEnum,
  type PageSignals,
  type PdfPageProxyLike,
} from '../ingestion/pdfSignals';
import {
  convertImageToMarkdown,
  ensureAiReadyImage,
} from '../ingestion/pageConversion';

const TARGET_SCALE = 150 / 72;

type PageSource = 'pdfjs' | 'artificial-intelligence' | 'image-only';

interface PageRecord {
  pageNumber: number;
  source: PageSource;
  figureCount: number;
  tableLikely: boolean;
  extractedChars: number;
  aiCallDurationMs: number | null;
  aiRetries: number;
  /** When the page failed to rasterize. */
  renderError?: string;
}

export const pdfHandler: Handler = async ({
  buffer,
  filename,
  outDir,
  ingestionAdapter,
  ingestionCliProfile,
  ingestionModel,
  ingestionEffort,
}): Promise<HandlerResult> => {
  const data = new Uint8Array(buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ));

  const canvasImport = async () => napiCanvas;
  const CanvasFactory = await createIsomorphicCanvasFactory(canvasImport);
  const pdf = await getDocumentProxy(data, { CanvasFactory } as unknown as Parameters<typeof getDocumentProxy>[1]);
  const totalPages = pdf.numPages;
  const ops = (await getResolvedPDFJS()).OPS as unknown as OpsEnum;

  const pagesDir = path.join(outDir, 'pages');
  await fsp.mkdir(pagesDir, { recursive: true });

  const mediaFiles: string[] = [];
  const renderedPageNumbers: number[] = [];
  const pageRecords: PageRecord[] = [];
  const pageBodies: string[] = [];

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    const rel = path.join('pages', `page-${String(pageNumber).padStart(4, '0')}.png`);
    const absImagePath = path.join(outDir, rel);

    let renderError: string | null = null;
    // Path used for both the AI call and the `text.md` link. If the
    // rendered page is over the vision-token cap, `ensureAiReadyImage`
    // writes a `.ai.png` sibling and we route AI + markdown there;
    // otherwise both stay on the original PNG.
    let aiAbsPath = absImagePath;
    let aiRel = rel;
    try {
      const pngBuffer = await renderPageAsImage(pdf, pageNumber, {
        canvasImport,
        scale: TARGET_SCALE,
      });
      await fsp.writeFile(absImagePath, Buffer.from(pngBuffer));
      mediaFiles.push(rel);
      renderedPageNumbers.push(pageNumber);
      const sidecarAbs = absImagePath + '.ai.png';
      const sidecarRel = rel + '.ai.png';
      const resolved = await ensureAiReadyImage(absImagePath, sidecarAbs);
      if (resolved !== absImagePath) {
        aiAbsPath = sidecarAbs;
        aiRel = sidecarRel;
        mediaFiles.push(sidecarRel);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[kb/pdf] Failed to rasterize page ${pageNumber} of "${filename}": ${message}`);
      renderError = message;
    }

    let signals: PageSignals;
    try {
      const page = (await pdf.getPage(pageNumber)) as unknown as PdfPageProxyLike;
      signals = await extractPageSignals(page, ops);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[kb/pdf] Failed to read signals for page ${pageNumber} of "${filename}": ${message}`);
      signals = { extractedText: '', extractedChars: 0, figureCount: 1, tableLikely: false };
    }

    if (renderError !== null) {
      pageRecords.push({
        pageNumber,
        source: 'image-only',
        figureCount: signals.figureCount,
        tableLikely: signals.tableLikely,
        extractedChars: signals.extractedChars,
        aiCallDurationMs: null,
        aiRetries: 0,
        renderError,
      });
      pageBodies.push(
        `## Page ${pageNumber}\n` +
        `> source: image-only | note: failed to rasterize this page (${renderError})`,
      );
      continue;
    }

    const safeText = signals.figureCount === 0 && !signals.tableLikely;

    if (safeText) {
      pageRecords.push({
        pageNumber,
        source: 'pdfjs',
        figureCount: signals.figureCount,
        tableLikely: signals.tableLikely,
        extractedChars: signals.extractedChars,
        aiCallDurationMs: null,
        aiRetries: 0,
      });
      pageBodies.push(buildSection(pageNumber, 'pdfjs', signals, signals.extractedText, aiRel));
      continue;
    }

    if (!ingestionAdapter) {
      pageRecords.push({
        pageNumber,
        source: 'image-only',
        figureCount: signals.figureCount,
        tableLikely: signals.tableLikely,
        extractedChars: signals.extractedChars,
        aiCallDurationMs: null,
        aiRetries: 0,
      });
      pageBodies.push(buildSection(pageNumber, 'image-only', signals, '', aiRel));
      continue;
    }

    const startedAt = Date.now();
    let aiMarkdown: string | null = null;
    let aiRetried = false;
    let aiError: string | null = null;
    try {
      const result = await convertImageToMarkdown(aiAbsPath, {
        adapter: ingestionAdapter,
        cliProfile: ingestionCliProfile,
        model: ingestionModel,
        effort: ingestionEffort,
      });
      aiMarkdown = result.markdown;
      aiRetried = result.retried;
    } catch (err) {
      aiError = err instanceof Error ? err.message : String(err);
    }
    const aiCallDurationMs = Date.now() - startedAt;

    if (aiMarkdown !== null) {
      pageRecords.push({
        pageNumber,
        source: 'artificial-intelligence',
        figureCount: signals.figureCount,
        tableLikely: signals.tableLikely,
        extractedChars: signals.extractedChars,
        aiCallDurationMs,
        aiRetries: aiRetried ? 1 : 0,
      });
      pageBodies.push(buildSection(pageNumber, 'artificial-intelligence', signals, aiMarkdown, aiRel));
    } else {
      console.warn(`[kb/pdf] AI conversion failed for page ${pageNumber} of "${filename}": ${aiError}`);
      pageRecords.push({
        pageNumber,
        source: 'image-only',
        figureCount: signals.figureCount,
        tableLikely: signals.tableLikely,
        extractedChars: signals.extractedChars,
        aiCallDurationMs,
        aiRetries: 1,
      });
      pageBodies.push(
        `## Page ${pageNumber}\n` +
        `> source: image-only | note: AI conversion failed after retry\n\n` +
        `![Page ${pageNumber}](${aiRel})`,
      );
    }
  }

  const sourceCounts = pageRecords.reduce(
    (acc, p) => {
      acc[p.source] = (acc[p.source] ?? 0) + 1;
      return acc;
    },
    {} as Record<PageSource, number>,
  );

  const failedRenders = pageRecords.filter((p) => p.renderError);

  const body = `# ${filename}\n\n${pageBodies.join('\n\n')}`;

  const metadata: Record<string, unknown> = {
    pageCount: totalPages,
    renderedPageCount: renderedPageNumbers.length,
    rasterDpi: 150,
    sourceCounts,
  };
  if (failedRenders.length > 0) {
    metadata.failedPages = failedRenders.map((p) => p.pageNumber).join(',');
    metadata.firstFailureMessage = failedRenders[0].renderError ?? '';
  }
  metadata.pages = pageRecords.map((p) => ({
    pageNumber: p.pageNumber,
    source: p.source,
    figureCount: p.figureCount,
    tableLikely: p.tableLikely,
    extractedChars: p.extractedChars,
    aiCallDurationMs: p.aiCallDurationMs,
    aiRetries: p.aiRetries,
    ...(p.renderError ? { renderError: p.renderError } : {}),
  }));

  return {
    text: body,
    mediaFiles,
    handler: 'pdf/rasterized-hybrid',
    metadata,
  };
};

function buildSection(
  pageNumber: number,
  source: PageSource,
  signals: PageSignals,
  body: string,
  imageRel: string,
): string {
  const annotation =
    `> source: ${source} | figures: ${signals.figureCount} | table-likely: ${signals.tableLikely}`;
  const trimmed = body.trim();
  const bodyBlock = trimmed.length > 0 ? `${trimmed}\n\n` : '';
  return `## Page ${pageNumber}\n${annotation}\n\n${bodyBlock}![Page ${pageNumber}](${imageRel})`;
}
