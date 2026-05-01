// ─── PPTX handler (hybrid: XML text + AI conversion per slide) ──────────────
// PPTX is a zip containing `ppt/slides/slide1.xml`, `ppt/notesSlides/*`, and
// `ppt/media/*`. Each visible slide goes through:
//
//   1. Extract body + speaker notes from the slide XML (always — text is
//      cheap and we want it available for the safe-text path AND as a fallback
//      when no image is available).
//   2. Compute signals (`figureCount`, `tableLikely`) from the raw XML via
//      `pptxSignals.extractSlideSignals`. Charts and tables specifically
//      flatten poorly under XML extraction — that's what the signals catch.
//   3. Optionally rasterize the deck to PNGs via LibreOffice when
//      `convertSlidesToImages` is on. See `pptxSlideRender`.
//   4. Classify per-slide:
//        figureCount === 0 && !tableLikely → xml-extract (use XML body)
//        otherwise (needs-ai):
//          rasterized image + adapter → AI conversion. On success,
//                                       source = artificial-intelligence
//                                       and body = AI markdown. On failure,
//                                       source = image-only and body is
//                                       empty (we don't fall back to XML
//                                       text we already declared insufficient).
//          rasterized image, no adapter → image-only (empty body, image link)
//          no image                     → xml-extract as last resort
//
// Speaker notes are kept regardless of source — they're a separate text
// stream from the slide body, and the chart/table that triggered needs-ai is
// in the slide content, not the author-written notes.
//
// Hidden slides (`<p:sld show="0">`) are filtered before numbering so the
// 1..N display index lines up with `slides/slide-NNN.png` from LibreOffice's
// PDF export (it also skips hidden slides).
//
// See `docs/design-kb-ingestion-hybrid.md` §4-5 for the full design.

import path from 'path';
import { promises as fsp } from 'fs';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import type { Handler, HandlerResult } from './types';
import * as pptxSignalsModule from '../ingestion/pptxSignals';
import * as pptxSlideRenderModule from '../ingestion/pptxSlideRender';
import {
  convertImageToMarkdown,
  ensureAiReadyImage,
} from '../ingestion/pageConversion';

/**
 * Resolve the path/rel a vision-capable consumer (the Ingestion AI call,
 * the digestion-time CLI read) should use for each image. Oversized images
 * get a `.ai.png` sibling on disk; small ones pass through. Originals are
 * always preserved.
 */
interface DownscaledImage {
  /** On-disk file written from the source pipeline (e.g. `media/foo.png`). */
  storeRel: string;
  /** Rel the markdown link should point at (sibling if downscaled). */
  linkRel: string;
  /** Absolute path that should be passed to `convertImageToMarkdown`. */
  absLinkPath: string;
}

async function downscaleAll(rels: string[], outDir: string): Promise<DownscaledImage[]> {
  return Promise.all(
    rels.map(async (rel) => {
      const abs = path.join(outDir, rel);
      const sidecarAbs = abs + '.ai.png';
      const sidecarRel = rel + '.ai.png';
      const resolved = await ensureAiReadyImage(abs, sidecarAbs);
      return resolved === abs
        ? { storeRel: rel, linkRel: rel, absLinkPath: abs }
        : { storeRel: rel, linkRel: sidecarRel, absLinkPath: sidecarAbs };
    }),
  );
}

interface ExtractedSlide {
  /**
   * 1-indexed sequential number among *visible* slides, so it lines up
   * with `slides/slide-NNN.png` from the LibreOffice rasterization path.
   * This is NOT the original `slide<N>.xml` file number — hidden slides
   * are filtered before numbering, see `extractPptxSlides`.
   */
  slideNumber: number;
  /** Slide body paragraphs joined with `\n\n` so bullets/lines survive markdown rendering. */
  body: string;
  /** Speaker-note paragraphs joined with `\n\n`, empty string if none. */
  notes: string;
  /** Raw slide XML (with namespace prefixes intact) for signal detection. */
  rawXml: string;
}

interface ExtractSlidesResult {
  /** Visible slides only, numbered 1..N sequentially. */
  slides: ExtractedSlide[];
  /** How many slide XMLs were marked `show="0"` and skipped. */
  hiddenCount: number;
  /** Total slide XMLs in the zip (visible + hidden). */
  totalCount: number;
}

type SlideSource = 'xml-extract' | 'artificial-intelligence' | 'image-only';

interface SlideRecord {
  slideNumber: number;
  source: SlideSource;
  figureCount: number;
  tableLikely: boolean;
  extractedChars: number;
  hasImage: boolean;
  aiCallDurationMs: number | null;
  aiRetries: number;
  /** Free-form note for fallback reasons (no adapter, AI failed, no image). */
  note?: string;
}

/** Walk an arbitrary parsed XML tree and collect every `a:t` text run. */
function collectTextRuns(node: unknown, bucket: string[]): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'string' || typeof node === 'number') {
    bucket.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectTextRuns(item, bucket);
    return;
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    // fast-xml-parser with `removeNSPrefix:true` turns `<a:t>foo</a:t>`
    // into `{ t: 'foo' }` or `{ t: ['foo', 'bar'] }`. We treat any `t`
    // node as a text run because that's how PPTX stores text across all
    // elements we care about.
    if ('t' in obj) collectTextRuns(obj.t, bucket);
    for (const [key, value] of Object.entries(obj)) {
      if (key === 't') continue;
      collectTextRuns(value, bucket);
    }
  }
}

/**
 * Walk a parsed PPTX slide/notes tree and emit one string per `<a:p>`
 * paragraph. PPTX text always lives inside `<a:p>` (titles, bullets, body
 * paragraphs are all `<a:p>`), so paragraph boundaries are the natural
 * place to insert line breaks. Without this, bulleted slides flatten into
 * a single space-joined run and lose their structure entirely.
 */
function extractParagraphs(node: unknown): string[] {
  const out: string[] = [];
  visit(node, out);
  return out;
}

function visit(node: unknown, out: string[]): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) visit(item, out);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  if ('p' in obj) {
    // `<a:p>` paragraphs — could be one (object) or many (array).
    const list = Array.isArray(obj.p) ? obj.p : [obj.p];
    for (const p of list) {
      const runs: string[] = [];
      collectTextRuns(p, runs);
      const text = runs.join(' ').replace(/\s+/g, ' ').trim();
      if (text) out.push(text);
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'p') continue;
    visit(value, out);
  }
}

/** Pull slide number out of an entry name like `ppt/slides/slide12.xml`. */
function slideNumberFromEntry(name: string): number | null {
  const match = /slide(\d+)\.xml$/.exec(name);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Core text-and-notes extractor. Returns one record per visible slide with
 * the body, notes, and raw XML for signal detection.
 *
 * Hidden slides (those with `show="0"` on the `<p:sld>` root element) are
 * skipped and the survivors are renumbered 1..N. We have to do this because
 * LibreOffice's PDF export *also* skips hidden slides — if we kept them in
 * the text with their original numbers, "Slide 37" in the markdown would
 * drift from `slides/slide-037.png` and the body would attach to the wrong
 * image.
 */
async function extractPptxSlides(buffer: Buffer): Promise<ExtractSlidesResult> {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const parser = new XMLParser({
    ignoreAttributes: true,
    removeNSPrefix: true,
    trimValues: true,
  });

  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName) && !e.isDirectory)
    .map((e) => ({ num: slideNumberFromEntry(e.entryName)!, entry: e }))
    .sort((a, b) => a.num - b.num);

  const notesEntries = new Map<number, AdmZip.IZipEntry>();
  for (const e of entries) {
    if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(e.entryName) && !e.isDirectory) {
      const match = /notesSlide(\d+)\.xml$/.exec(e.entryName);
      if (match) notesEntries.set(parseInt(match[1], 10), e);
    }
  }

  const slides: ExtractedSlide[] = [];
  let hiddenCount = 0;
  let displayNumber = 0;
  for (const { num, entry } of slideEntries) {
    const rawXml = entry.getData().toString('utf8');
    if (/<p:sld\b[^>]*\sshow="0"/.test(rawXml)) {
      hiddenCount += 1;
      continue;
    }
    displayNumber += 1;

    let bodyParagraphs: string[] = [];
    try {
      const parsed = parser.parse(rawXml);
      bodyParagraphs = extractParagraphs(parsed);
    } catch {
      // Malformed XML on a single slide shouldn't kill the whole file.
    }
    let notesParagraphs: string[] = [];
    const notesEntry = notesEntries.get(num);
    if (notesEntry) {
      try {
        const parsed = parser.parse(notesEntry.getData().toString('utf8'));
        notesParagraphs = extractParagraphs(parsed);
      } catch {
        // Best-effort — bad notes shouldn't drop the slide.
      }
    }
    slides.push({
      slideNumber: displayNumber,
      body: bodyParagraphs.join('\n\n'),
      notes: notesParagraphs.join('\n\n'),
      rawXml,
    });
  }
  return { slides, hiddenCount, totalCount: slideEntries.length };
}

/** Copy `ppt/media/*` into `outDir/media/` and return the relative paths. */
async function extractPptxMedia(buffer: Buffer, outDir: string): Promise<string[]> {
  const zip = new AdmZip(buffer);
  const mediaEntries = zip
    .getEntries()
    .filter((e) => e.entryName.startsWith('ppt/media/') && !e.isDirectory);
  if (mediaEntries.length === 0) return [];
  const mediaDir = path.join(outDir, 'media');
  await fsp.mkdir(mediaDir, { recursive: true });
  const relPaths: string[] = [];
  for (const entry of mediaEntries) {
    const base = path.basename(entry.entryName).replace(/[\/\\]/g, '_');
    const diskPath = path.join(mediaDir, base);
    await fsp.writeFile(diskPath, entry.getData());
    relPaths.push(path.join('media', base));
  }
  return relPaths;
}

/** Build the per-slide markdown section from the classification result. */
function buildSlideSection(
  record: SlideRecord,
  body: string,
  notes: string,
  imageRel: string | null,
): string {
  const annotation =
    `> source: ${record.source} | figures: ${record.figureCount} | ` +
    `table-likely: ${record.tableLikely}` +
    (record.note ? ` | note: ${record.note}` : '');

  const lines: string[] = [`## Slide ${record.slideNumber}`, annotation, ''];
  const trimmedBody = body.trim();
  if (trimmedBody.length > 0) {
    lines.push(trimmedBody);
    lines.push('');
  }
  if (notes.trim().length > 0) {
    lines.push('### Speaker Notes');
    lines.push('');
    lines.push(notes.trim());
    lines.push('');
  }
  if (imageRel) {
    lines.push(`![Slide ${record.slideNumber}](${imageRel})`);
  }
  // Drop trailing empty line(s) — section join handles spacing.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

export const pptxHandler: Handler = async ({
  buffer,
  filename,
  outDir,
  convertSlidesToImages,
  ingestionAdapter,
  ingestionCliProfile,
  ingestionModel,
  ingestionEffort,
}): Promise<HandlerResult> => {
  const { slides, hiddenCount, totalCount } = await extractPptxSlides(buffer);
  const embeddedMediaRels = await extractPptxMedia(buffer, outDir);

  let slideImageRels: string[] = [];
  let slideImagesWarning: string | undefined;
  if (convertSlidesToImages) {
    const result = await pptxSlideRenderModule.rasterizeSlidesViaLibreOffice(
      buffer,
      filename,
      outDir,
    );
    slideImageRels = result.images;
    slideImagesWarning = result.warning;
  }

  // Downscale any oversized images so both the AI call here and the
  // digestion-time CLI read stay under the vision-token cap. The
  // originals on disk are preserved; only the markdown link target
  // changes when a `.ai.png` sibling is written.
  const embeddedItems = await downscaleAll(embeddedMediaRels, outDir);
  const slideItems = await downscaleAll(slideImageRels, outDir);

  const mediaFiles: string[] = [];
  for (const item of [...embeddedItems, ...slideItems]) {
    mediaFiles.push(item.storeRel);
    if (item.linkRel !== item.storeRel) mediaFiles.push(item.linkRel);
  }

  const slideRecords: SlideRecord[] = [];
  const slideBlocks: string[] = [];

  for (const slide of slides) {
    const signals = pptxSignalsModule.extractSlideSignals(slide.rawXml);
    const safeText = signals.figureCount === 0 && !signals.tableLikely;
    // slideItems is 1-indexed by visible-slide number. LibreOffice's PDF
    // export skips hidden slides too, so the indexing matches displayNumber
    // unless rasterization stopped partway (then later slides have no image).
    const slideItem = slideItems[slide.slideNumber - 1] ?? null;
    const imageRel: string | null = slideItem ? slideItem.linkRel : null;

    if (safeText) {
      const record: SlideRecord = {
        slideNumber: slide.slideNumber,
        source: 'xml-extract',
        figureCount: signals.figureCount,
        tableLikely: signals.tableLikely,
        extractedChars: slide.body.length,
        hasImage: imageRel !== null,
        aiCallDurationMs: null,
        aiRetries: 0,
      };
      slideRecords.push(record);
      slideBlocks.push(buildSlideSection(record, slide.body, slide.notes, imageRel));
      continue;
    }

    // needs-ai branch
    if (imageRel === null) {
      // No image at all (rasterization off or this slide failed to render).
      // We have no AI option, so XML text is the only thing we can offer.
      const record: SlideRecord = {
        slideNumber: slide.slideNumber,
        source: 'xml-extract',
        figureCount: signals.figureCount,
        tableLikely: signals.tableLikely,
        extractedChars: slide.body.length,
        hasImage: false,
        aiCallDurationMs: null,
        aiRetries: 0,
        note: 'no slide image available; using XML extraction',
      };
      slideRecords.push(record);
      slideBlocks.push(buildSlideSection(record, slide.body, slide.notes, null));
      continue;
    }

    if (!ingestionAdapter) {
      const record: SlideRecord = {
        slideNumber: slide.slideNumber,
        source: 'image-only',
        figureCount: signals.figureCount,
        tableLikely: signals.tableLikely,
        extractedChars: slide.body.length,
        hasImage: true,
        aiCallDurationMs: null,
        aiRetries: 0,
        note: 'no Ingestion CLI configured',
      };
      slideRecords.push(record);
      slideBlocks.push(buildSlideSection(record, '', slide.notes, imageRel));
      continue;
    }

    // slideItem is non-null here because imageRel was non-null above.
    const absImagePath = slideItem!.absLinkPath;
    const startedAt = Date.now();
    let aiMarkdown: string | null = null;
    let aiRetried = false;
    let aiError: string | null = null;
    try {
      const result = await convertImageToMarkdown(absImagePath, {
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
      const record: SlideRecord = {
        slideNumber: slide.slideNumber,
        source: 'artificial-intelligence',
        figureCount: signals.figureCount,
        tableLikely: signals.tableLikely,
        extractedChars: slide.body.length,
        hasImage: true,
        aiCallDurationMs,
        aiRetries: aiRetried ? 1 : 0,
      };
      slideRecords.push(record);
      slideBlocks.push(buildSlideSection(record, aiMarkdown, slide.notes, imageRel));
    } else {
      console.warn(`[kb/pptx] AI conversion failed for slide ${slide.slideNumber} of "${filename}": ${aiError}`);
      const record: SlideRecord = {
        slideNumber: slide.slideNumber,
        source: 'image-only',
        figureCount: signals.figureCount,
        tableLikely: signals.tableLikely,
        extractedChars: slide.body.length,
        hasImage: true,
        aiCallDurationMs,
        aiRetries: 1,
        note: 'AI conversion failed after retry',
      };
      slideRecords.push(record);
      slideBlocks.push(buildSlideSection(record, '', slide.notes, imageRel));
    }
  }

  let text = `# ${filename}\n\n${slideBlocks.join('\n\n')}`;
  if (hiddenCount > 0) {
    text += `\n\n> **Note:** ${hiddenCount} of ${totalCount} slides in this deck are marked hidden and were skipped during ingestion to stay in sync with the rasterized slide images.\n`;
  }
  if (embeddedItems.length > 0) {
    text += `\n\n## Embedded Media\n\n${embeddedItems
      .map((it) => `![${path.basename(it.storeRel)}](${it.linkRel})`)
      .join('\n')}\n`;
  }
  if (convertSlidesToImages && slideImagesWarning) {
    text += `\n\n> **Slide rasterization note:** ${slideImagesWarning}\n`;
  }

  const sourceCounts = slideRecords.reduce(
    (acc, s) => {
      acc[s.source] = (acc[s.source] ?? 0) + 1;
      return acc;
    },
    {} as Record<SlideSource, number>,
  );

  const metadata: Record<string, unknown> = {
    slideCount: slides.length,
    totalSlideCount: totalCount,
    hiddenSlideCount: hiddenCount,
    embeddedMediaCount: embeddedItems.length,
    slidesToImagesRequested: Boolean(convertSlidesToImages),
    renderedSlideCount: slideItems.length,
    sourceCounts,
  };
  if (slideImagesWarning) metadata.slideImagesWarning = slideImagesWarning;
  metadata.slides = slideRecords.map((s) => ({
    slideNumber: s.slideNumber,
    source: s.source,
    figureCount: s.figureCount,
    tableLikely: s.tableLikely,
    extractedChars: s.extractedChars,
    hasImage: s.hasImage,
    aiCallDurationMs: s.aiCallDurationMs,
    aiRetries: s.aiRetries,
    ...(s.note ? { note: s.note } : {}),
  }));

  return {
    text,
    mediaFiles,
    handler: 'pptx/hybrid',
    metadata,
  };
};
