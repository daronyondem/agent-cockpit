// ─── PPTX handler ───────────────────────────────────────────────────────────
// PPTX is a zip containing `ppt/slides/slide1.xml`, `ppt/notesSlides/*`,
// and `ppt/media/*`. We:
//   1. Unzip with adm-zip, find slides and notes in order
//   2. Parse each slide XML with fast-xml-parser and pull out <a:t> text
//   3. Pull speaker notes the same way
//   4. Copy `ppt/media/*` into the output `media/` dir verbatim
//   5. Optionally render slides as PNGs via LibreOffice + unpdf when the
//      `convertSlidesToImages` flag is on and `soffice` was detected at
//      startup. Gated flags cleanly so this whole path is skipped when
//      either precondition is false.

import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { promises as fsp } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { renderPageAsImage, getDocumentProxy } from 'unpdf';
import * as napiCanvas from '@napi-rs/canvas';
import { detectLibreOffice } from '../libreOffice';
import type { Handler, HandlerResult } from './types';

const execFileAsync = promisify(execFile);

interface ExtractedText {
  /** 1-indexed slide number (matches file name `slide<N>.xml`). */
  slideNumber: number;
  /** Joined `<a:t>` runs from the slide body. */
  body: string;
  /** Joined `<a:t>` runs from the speaker notes, empty string if none. */
  notes: string;
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
      if (key === 't') continue; // already handled
      collectTextRuns(value, bucket);
    }
  }
}

/** Pull slide number out of an entry name like `ppt/slides/slide12.xml`. */
function slideNumberFromEntry(name: string): number | null {
  const match = /slide(\d+)\.xml$/.exec(name);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Core text-and-media extractor. Always runs; image rasterization is an
 * optional add-on layered on top by the exported handler.
 */
async function extractPptxText(buffer: Buffer): Promise<ExtractedText[]> {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  const parser = new XMLParser({
    ignoreAttributes: true,
    removeNSPrefix: true,
    // Preserving whitespace inside `<a:t>` keeps multi-word runs together;
    // stripping whitespace between elements keeps the output tidy.
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

  const results: ExtractedText[] = [];
  for (const { num, entry } of slideEntries) {
    const bodyBucket: string[] = [];
    try {
      const parsed = parser.parse(entry.getData().toString('utf8'));
      collectTextRuns(parsed, bodyBucket);
    } catch {
      // Malformed XML on a single slide shouldn't kill the whole file.
    }
    const notesBucket: string[] = [];
    const notesEntry = notesEntries.get(num);
    if (notesEntry) {
      try {
        const parsed = parser.parse(notesEntry.getData().toString('utf8'));
        collectTextRuns(parsed, notesBucket);
      } catch {
        // Same as above — notes are best-effort.
      }
    }
    results.push({
      slideNumber: num,
      body: bodyBucket.join(' ').replace(/\s+/g, ' ').trim(),
      notes: notesBucket.join(' ').replace(/\s+/g, ' ').trim(),
    });
  }
  return results;
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

/**
 * Shell out to `soffice --headless --convert-to pdf` to produce a PDF of
 * the deck, then render each PDF page as a PNG via unpdf + an isomorphic
 * canvas factory. Returns the list of slide image paths (relative to
 * outDir), or an empty array on any failure.
 */
async function rasterizeSlidesViaLibreOffice(
  buffer: Buffer,
  filename: string,
  outDir: string,
): Promise<{ images: string[]; warning?: string }> {
  const status = await detectLibreOffice();
  if (!status.available || !status.binaryPath) {
    return {
      images: [],
      warning: 'LibreOffice not available — slide-to-image conversion skipped.',
    };
  }

  // Work inside a temp dir so `soffice --outdir` can't collide with our
  // real output directory on retries.
  const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-pptx-'));
  try {
    const safeStem = path.basename(filename, path.extname(filename)).replace(/[^a-z0-9_-]/gi, '_');
    const inputPath = path.join(tmpBase, `${safeStem}-${crypto.randomBytes(4).toString('hex')}.pptx`);
    await fsp.writeFile(inputPath, buffer);

    // `--headless` keeps soffice from drawing a tray icon; `--norestore`
    // prevents it from recovering a crashed user profile; `--nolockcheck`
    // avoids the ~/.config/libreoffice lock file that blocks concurrent
    // instances under pm2.
    await execFileAsync(
      status.binaryPath,
      [
        '--headless',
        '--norestore',
        '--nolockcheck',
        '--convert-to', 'pdf',
        '--outdir', tmpBase,
        inputPath,
      ],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );

    const pdfPath = inputPath.replace(/\.pptx$/i, '.pdf');
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await fsp.readFile(pdfPath);
    } catch {
      return {
        images: [],
        warning: 'LibreOffice did not produce a PDF for the deck.',
      };
    }

    // Render each page with unpdf's `renderPageAsImage` helper. It takes
    // a `canvasImport` factory; we hand it the statically-imported
    // `@napi-rs/canvas` namespace so there's no per-page dynamic import
    // overhead (and no optional-dep failure mode — canvas is a regular
    // dep now).
    const data = new Uint8Array(pdfBuffer.buffer.slice(
      pdfBuffer.byteOffset,
      pdfBuffer.byteOffset + pdfBuffer.byteLength,
    ));
    const pdf = await getDocumentProxy(data);
    const totalPages = pdf.numPages;
    const slidesDir = path.join(outDir, 'slides');
    await fsp.mkdir(slidesDir, { recursive: true });
    const rel: string[] = [];

    for (let page = 1; page <= totalPages; page += 1) {
      try {
        const pngBuffer = await renderPageAsImage(pdf, page, {
          canvasImport: async () => napiCanvas,
          scale: 1.5,
        });
        const pngPath = path.join(slidesDir, `slide-${String(page).padStart(3, '0')}.png`);
        await fsp.writeFile(pngPath, Buffer.from(pngBuffer));
        rel.push(path.join('slides', `slide-${String(page).padStart(3, '0')}.png`));
      } catch {
        // Skip bad pages — we still keep the ones that rendered.
      }
    }
    return { images: rel };
  } catch (err: unknown) {
    return {
      images: [],
      warning: `LibreOffice rasterization failed: ${(err as Error).message}`,
    };
  } finally {
    await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const pptxHandler: Handler = async ({
  buffer,
  filename,
  outDir,
  convertSlidesToImages,
}): Promise<HandlerResult> => {
  const slides = await extractPptxText(buffer);
  const embeddedMedia = await extractPptxMedia(buffer, outDir);

  // Body: one H2 per slide with body + optional notes block.
  const slideBlocks = slides.map((s) => {
    const lines: string[] = [`## Slide ${s.slideNumber}`];
    lines.push('');
    lines.push(s.body || '_[no text]_');
    if (s.notes) {
      lines.push('');
      lines.push('### Speaker Notes');
      lines.push('');
      lines.push(s.notes);
    }
    return lines.join('\n');
  });

  const mediaFiles = [...embeddedMedia];
  let slideImagesWarning: string | undefined;
  if (convertSlidesToImages) {
    const result = await rasterizeSlidesViaLibreOffice(buffer, filename, outDir);
    mediaFiles.push(...result.images);
    slideImagesWarning = result.warning;
  }

  let text = `# ${filename}\n\n${slideBlocks.join('\n\n')}`;
  if (embeddedMedia.length > 0) {
    text += `\n\n## Embedded Media\n\n${embeddedMedia.map((rel) => `![${path.basename(rel)}](${rel})`).join('\n')}\n`;
  }
  if (convertSlidesToImages && slideImagesWarning) {
    text += `\n\n> **Slide rasterization note:** ${slideImagesWarning}\n`;
  }

  const metadata: Record<string, string | number | boolean> = {
    slideCount: slides.length,
    embeddedMediaCount: embeddedMedia.length,
    slidesToImagesRequested: Boolean(convertSlidesToImages),
  };
  if (slideImagesWarning) metadata.slideImagesWarning = slideImagesWarning;

  return {
    text,
    mediaFiles,
    handler: 'pptx',
    metadata,
  };
};
