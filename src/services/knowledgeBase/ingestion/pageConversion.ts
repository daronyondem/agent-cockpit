// ─── Per-image AI conversion + downscaling helper ──────────────────────────
// Two responsibilities:
//
//   1. `convertImageToMarkdown` — wraps a single Ingestion-CLI `runOneShot`
//      call that converts one image (PDF page render, slide render, embedded
//      DOCX figure, or standalone uploaded image) into clean Markdown. The
//      caller supplies the absolute image path; this function builds the
//      unified prompt, runs the CLI, and retries once if the call throws or
//      returns empty/whitespace output.
//
//   2. `ensureAiReadyImage` — write a downscaled PNG sibling next to an
//      oversized image and return the path the caller should use for both
//      the AI call AND the link in `text.md`. Handlers run this BEFORE
//      `convertImageToMarkdown` so the same downscaled file serves both
//      ingestion-time AI and digestion-time CLI reads. Decode failures fall
//      through to the original path — the CLI may handle formats that
//      `@napi-rs/canvas` cannot.

import path from 'path';
import { promises as fsp } from 'fs';
import * as napiCanvas from '@napi-rs/canvas';
import type {
  BaseBackendAdapter,
  RunOneShotOptions,
} from '../../backends/base';
import type { EffortLevel } from '../../../types';

/**
 * Unified prompt used by every AI conversion call site (PDF page, DOCX
 * embedded image, PPTX slide, passthrough image upload).  See
 * `docs/design-kb-ingestion-hybrid.md` §8 for the rationale — one prompt for
 * every visual input keeps quality consistent across formats.
 */
export const IMAGE_TO_MARKDOWN_PROMPT_TEMPLATE = (imageBasename: string): string =>
  `Read the image file \`${imageBasename}\` in the current working directory and convert it to clean Markdown.

- Preserve any tables as proper Markdown tables (\`| col | col |\`).
- For figures, charts, diagrams, photos, or other visual content: describe what they show in 1–3 sentences of prose. If they include data points or labels, capture those.
- Transcribe any visible text accurately.
- Preserve page-level structure: detect headings and use \`#\`, \`##\`, \`###\`. Detect lists and use \`-\` or \`1.\`.
- Include captions or labels that accompany figures/tables.
- Output Markdown only. No preamble, no explanation, no code fences around the result.`;

/** Default per-image timeout (3 min). Digestion uses 15 min for whole docs. */
const DEFAULT_TIMEOUT_MS = 3 * 60_000;

/** Cap on the long edge (px) of images sent to a CLI's vision model. Token
 *  cost scales with pixel count and providers reject inputs over ~5 MB; 2576
 *  keeps each image under ~4,800 vision tokens for typical aspect ratios.
 *  Images above this threshold get a `.ai.png` sibling that handlers link to
 *  from `text.md` (so digestion-time CLI reads also stay under the cap). */
export const MAX_LONG_EDGE_PX = 2576;

/**
 * If the source image's long edge exceeds `MAX_LONG_EDGE_PX`, write a
 * proportionally-scaled PNG to `destPath` and return `destPath`. Otherwise,
 * or if the source can't be decoded by `@napi-rs/canvas` (SVG, video,
 * unsupported codec), return `srcPath` unchanged with no write.
 *
 * The returned path is what the caller should hand to `convertImageToMarkdown`
 * AND embed as the markdown link in `text.md`. Re-encoding to PNG drops
 * EXIF/color-profile/animation metadata on the downscaled copy, but the
 * original at `srcPath` is never modified — KB Browser still serves the
 * full-fidelity file for human viewing.
 */
export async function ensureAiReadyImage(
  srcPath: string,
  destPath: string,
): Promise<string> {
  let img: Awaited<ReturnType<typeof napiCanvas.loadImage>>;
  try {
    img = await napiCanvas.loadImage(srcPath);
  } catch {
    return srcPath;
  }

  const longEdge = Math.max(img.width, img.height);
  if (longEdge <= MAX_LONG_EDGE_PX) {
    return srcPath;
  }

  const scale = MAX_LONG_EDGE_PX / longEdge;
  const newWidth = Math.max(1, Math.round(img.width * scale));
  const newHeight = Math.max(1, Math.round(img.height * scale));
  const canvas = napiCanvas.createCanvas(newWidth, newHeight);
  canvas.getContext('2d').drawImage(img, 0, 0, newWidth, newHeight);
  const buffer = canvas.toBuffer('image/png');

  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, buffer);
  return destPath;
}

export interface ConvertImageOptions {
  /** Configured Ingestion CLI adapter. Required. */
  adapter: BaseBackendAdapter;
  /** Optional model override (must be vision-capable). */
  model?: string;
  /** Optional reasoning effort. */
  effort?: EffortLevel;
  /** Per-image hard timeout. Defaults to 3 min. */
  timeoutMs?: number;
}

export interface ConvertImageResult {
  /** The Markdown returned by the Ingestion CLI. */
  markdown: string;
  /** True iff the first attempt failed and the second attempt succeeded. */
  retried: boolean;
}

/**
 * Convert a single image to Markdown via the Ingestion CLI.
 *
 * The CLI reads the image via its filesystem `Read` tool (we set `workingDir`
 * to the image's parent directory and `allowTools: true`). The prompt
 * references the image by basename so it works regardless of absolute path.
 *
 * Retries once if the adapter throws OR returns empty/whitespace output.
 * After two failed attempts, throws the last error (handlers decide whether
 * to fall back to `source: image-only`).
 */
export async function convertImageToMarkdown(
  imagePath: string,
  opts: ConvertImageOptions,
): Promise<ConvertImageResult> {
  const basename = path.basename(imagePath);
  const workingDir = path.dirname(imagePath);
  const prompt = IMAGE_TO_MARKDOWN_PROMPT_TEMPLATE(basename);
  const runOptions: RunOneShotOptions = {
    model: opts.model,
    effort: opts.effort,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    workingDir,
    allowTools: true,
  };

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const output = await opts.adapter.runOneShot(prompt, runOptions);
      if (output && output.trim().length > 0) {
        return { markdown: output, retried: attempt > 0 };
      }
      lastError = new Error('ingestion CLI returned empty output');
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError));
}
