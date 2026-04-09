// ─── Handler dispatch ───────────────────────────────────────────────────────
// Chooses the right handler based on file extension (primary) and MIME type
// (fallback). Extension is the primary signal because browsers frequently
// mis-label uploads as `application/octet-stream` and because our test
// fixtures come straight off disk without MIME metadata. MIME type is only
// consulted when the extension is missing or unrecognized.
//
// This file is the single entry point the orchestrator uses — it calls
// `ingestFile(input)` and gets back a `HandlerResult` without caring which
// specific handler ran. That keeps the orchestrator free of per-format
// knowledge and makes it trivial to add a new format later (add a case
// here, export its handler, done).

import path from 'path';
import { pdfHandler } from './pdf';
import { docxHandler } from './docx';
import { pptxHandler } from './pptx';
import { passthroughHandler, passthroughSupports } from './passthrough';
import type { Handler, HandlerInput, HandlerResult } from './types';

/** Map well-known MIME types to handlers for the extension-less case. */
const MIME_TO_HANDLER: Record<string, Handler> = {
  'application/pdf': pdfHandler,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': docxHandler,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': pptxHandler,
};

/** Error thrown when no handler can process the given file. */
export class UnsupportedFileTypeError extends Error {
  constructor(filename: string, mimeType: string) {
    super(
      `Unsupported file type for Knowledge Base ingestion: ${filename} (${mimeType || 'unknown MIME'}). ` +
        'Supported formats: PDF, DOCX, PPTX, and text/image files.',
    );
    this.name = 'UnsupportedFileTypeError';
  }
}

/** Pick a handler by extension first, then MIME type. Returns null if none. */
export function pickHandler(filename: string, mimeType: string): Handler | null {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.pdf':
      return pdfHandler;
    case '.docx':
      return docxHandler;
    case '.pptx':
      return pptxHandler;
    default:
      break;
  }
  if (passthroughSupports(filename)) return passthroughHandler;
  // MIME fallback — only reached when the filename has no extension or an
  // extension we don't recognize. Browsers sometimes upload with names like
  // `paste-2024-04-08` and rely on the MIME type for format detection.
  if (mimeType && MIME_TO_HANDLER[mimeType]) return MIME_TO_HANDLER[mimeType];
  return null;
}

/**
 * Main entry point used by the ingestion orchestrator. Picks a handler and
 * runs it, or throws `UnsupportedFileTypeError` so the caller can mark the
 * raw entry as `failed` with a clear message.
 */
export async function ingestFile(input: HandlerInput): Promise<HandlerResult> {
  const handler = pickHandler(input.filename, input.mimeType);
  if (!handler) {
    throw new UnsupportedFileTypeError(input.filename, input.mimeType);
  }
  return handler(input);
}

export type { Handler, HandlerInput, HandlerResult } from './types';
export { pdfHandler } from './pdf';
export { docxHandler } from './docx';
export { pptxHandler } from './pptx';
export { passthroughHandler, passthroughSupports } from './passthrough';
