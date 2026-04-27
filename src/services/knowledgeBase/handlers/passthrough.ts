// ─── Passthrough handler ────────────────────────────────────────────────────
// For file types where the original bytes ARE the usable content — plain
// text, Markdown, source code, and raw images. The handler copies the
// file into the output directory verbatim and either embeds its contents
// (text) or references it as media (images).
//
// Image uploads run through the same hybrid path as PDF pages / PPTX
// slides / DOCX figures: when an Ingestion CLI is configured, the on-disk
// image is sent to `convertImageToMarkdown` and the AI's Markdown is
// inlined above the image reference in `text.md`. Without an adapter, or
// on AI failure after retry, the body falls back to `source: image-only`
// and just references the image. SVG is always skipped — it's text-based
// and vision conversion adds no value over reading the SVG directly.

import path from 'path';
import { promises as fsp } from 'fs';
import type { Handler, HandlerResult } from './types';
import { convertImageToMarkdown } from '../ingestion/pageConversion';

const TEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.rst',
  '.log',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.html',
  '.htm',
]);

const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
]);

/** Extensions the AI image-to-markdown call is appropriate for. SVG is
 *  excluded — vision models don't benefit from rasterizing what's already
 *  text-based, and the digester can read the SVG file directly via tools. */
const AI_ELIGIBLE_IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
]);

type ImageSource = 'artificial-intelligence' | 'image-only';

/** True iff the extension belongs to a format this handler can handle. */
export function passthroughSupports(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return TEXT_EXTS.has(ext) || IMAGE_EXTS.has(ext);
}

export const passthroughHandler: Handler = async ({
  buffer,
  filename,
  outDir,
  ingestionAdapter,
  ingestionModel,
  ingestionEffort,
}): Promise<HandlerResult> => {
  const ext = path.extname(filename).toLowerCase();

  // Text-like formats: decode as UTF-8 and inline into `text.md`.
  // The full content is preserved — the Digestion CLI runs with
  // allowTools and can read the file on disk if the prompt is too long.
  if (TEXT_EXTS.has(ext)) {
    const text = buffer.toString('utf8');
    // Wrap non-markdown text in a code fence for readability in the
    // digestion prompt. Markdown is passed through as-is so existing
    // headings survive.
    const body =
      ext === '.md' || ext === '.markdown'
        ? text
        : '```' + ext.slice(1) + '\n' + text + '\n```';
    const header = `# ${filename}\n\n`;
    return {
      text: header + body,
      mediaFiles: [],
      handler: 'passthrough/text',
      metadata: {
        byteLength: buffer.byteLength,
      },
    };
  }

  if (IMAGE_EXTS.has(ext)) {
    const mediaDir = path.join(outDir, 'media');
    await fsp.mkdir(mediaDir, { recursive: true });
    const safeName = filename.replace(/[\/\\]/g, '_');
    const mediaPath = path.join(mediaDir, safeName);
    await fsp.writeFile(mediaPath, buffer);
    const relMedia = path.join('media', safeName);

    const aiEligible = AI_ELIGIBLE_IMAGE_EXTS.has(ext);
    let source: ImageSource = 'image-only';
    let aiMarkdown: string | null = null;
    let aiCallDurationMs: number | null = null;
    let aiRetries = 0;
    let note: string | undefined;

    if (!ingestionAdapter) {
      note = 'no Ingestion CLI configured';
    } else if (!aiEligible) {
      note = 'SVG not eligible for AI conversion';
    } else {
      const startedAt = Date.now();
      try {
        const result = await convertImageToMarkdown(mediaPath, {
          adapter: ingestionAdapter,
          model: ingestionModel,
          effort: ingestionEffort,
        });
        aiMarkdown = result.markdown;
        source = 'artificial-intelligence';
        aiRetries = result.retried ? 1 : 0;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[kb/passthrough] AI conversion failed for "${filename}": ${message}`);
        note = 'AI conversion failed after retry';
        aiRetries = 1;
      }
      aiCallDurationMs = Date.now() - startedAt;
    }

    const annotation = `> source: ${source}` + (note ? ` | note: ${note}` : '');
    const lines: string[] = [`# ${filename}`, '', annotation, ''];
    if (aiMarkdown) {
      lines.push(aiMarkdown.trim(), '');
    }
    lines.push(`![${filename}](${relMedia})`);
    const text = lines.join('\n') + '\n';

    const sourceCounts: Record<string, number> = { [source]: 1 };

    return {
      text,
      mediaFiles: [relMedia],
      handler: 'passthrough/image',
      metadata: {
        byteLength: buffer.byteLength,
        source,
        sourceCounts,
        aiCallDurationMs,
        aiRetries,
        ...(note ? { note } : {}),
      },
    };
  }

  throw new Error(`passthrough handler: unsupported extension ${ext}`);
};
