// ─── Per-image AI conversion ─────────────────────────────────────────────────
// Wraps a single Ingestion-CLI `runOneShot` call that converts one image
// (PDF page render, slide render, embedded DOCX figure, or standalone uploaded
// image) into clean Markdown.
//
// Used by all four hybrid handlers (PDF, DOCX, PPTX, passthrough image). The
// caller supplies the absolute image path and a configured Ingestion adapter;
// this function builds the unified prompt, runs the CLI, and retries once if
// the call throws or returns empty/whitespace output.
//
// The CLI reads the image via its filesystem `Read` tool (we set `workingDir`
// to the image's parent directory and `allowTools: true`). The prompt
// references the image by basename so it works regardless of absolute path.

import path from 'path';
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
