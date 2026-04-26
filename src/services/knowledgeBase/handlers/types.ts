// ─── Knowledge Base format handlers — shared types ──────────────────────────
// A "handler" takes a raw file (as a buffer + its original filename) and
// writes extracted text + any media to a caller-provided output directory.
// The caller (`ingestion.ts`) picks the right handler by MIME type /
// extension, creates `converted/<rawId>/` and passes it in.
//
// Handlers are deliberately pure w.r.t. `KbState` — they only touch the
// filesystem. The orchestrator is responsible for updating `state.json`
// and emitting WS frames.

import type { BaseBackendAdapter } from '../../backends/base';
import type { EffortLevel } from '../../../types';

/** Result of converting a raw file into a digestible form. */
export interface HandlerResult {
  /**
   * Primary text content of the file, in Markdown. This is what the
   * Digestion CLI will read in PR 3. Never null — if the file genuinely
   * has no text (e.g. a binary image), the handler returns a short
   * placeholder (`# image.png\n\n_Binary image file._`) so downstream
   * code always has something to work with.
   */
  text: string;
  /**
   * Paths to media files that were extracted into the output directory,
   * relative to that directory (e.g. `media/image1.png`). The orchestrator
   * lists these in `meta.json` so the UI and the Digestion CLI can find
   * them without scanning the directory.
   */
  mediaFiles: string[];
  /**
   * Handler name that produced this result — exposed in `meta.json` for
   * debugging and to let the Raw tab show which pipeline path ran.
   */
  handler: string;
  /**
   * Handler-specific metadata (page count, slide count, word count, etc.).
   * Free-form on purpose — the UI renders a few common keys opportunistically
   * and leaves the rest for debugging.
   */
  metadata?: Record<string, string | number | boolean>;
}

/** Input passed to every handler. */
export interface HandlerInput {
  /** The raw file contents. */
  buffer: Buffer;
  /** Original filename (used to pick a sensible title / extension). */
  filename: string;
  /** Detected MIME type (may be `application/octet-stream` on unknown). */
  mimeType: string;
  /**
   * Absolute path to the directory the handler should write output into.
   * The orchestrator has already `mkdir -p`'d it. Handlers may freely
   * create subdirectories (e.g. `media/`).
   */
  outDir: string;
  /**
   * Opt-in flag for LibreOffice-backed PPTX slide rasterization. Only
   * read by `pptx.ts`. Pulled from `Settings.knowledgeBase.convertSlidesToImages`
   * at the top of `ingest()`.
   */
  convertSlidesToImages?: boolean;
  /**
   * Configured Ingestion CLI adapter, used by hybrid handlers (PDF, DOCX,
   * PPTX, passthrough image) to convert page/slide/embedded images to
   * Markdown via `convertImageToMarkdown`. Undefined when the user has not
   * configured an Ingestion CLI — handlers fall back to image-link-only
   * output for visual content in that case.
   */
  ingestionAdapter?: BaseBackendAdapter;
  /** Optional Ingestion CLI model override (must be vision-capable). */
  ingestionModel?: string;
  /** Optional Ingestion CLI reasoning effort. */
  ingestionEffort?: EffortLevel;
}

/** Shape of a handler function — pure async, throws on fatal errors. */
export type Handler = (input: HandlerInput) => Promise<HandlerResult>;
