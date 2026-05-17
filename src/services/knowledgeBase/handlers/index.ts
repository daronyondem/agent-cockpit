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
import { passthroughSupports } from './passthroughSupport';
import type { Handler, HandlerInput, HandlerResult } from './types';

const PDF_HANDLER_MODULE = './pdf';
const DOCX_HANDLER_MODULE = './docx';
const PPTX_HANDLER_MODULE = './pptx';
const PASSTHROUGH_HANDLER_MODULE = './passthrough';

const lazyPdfHandler: Handler = async (input) => {
  const { pdfHandler } = await import(PDF_HANDLER_MODULE) as typeof import('./pdf');
  return pdfHandler(input);
};

const lazyDocxHandler: Handler = async (input) => {
  const { docxHandler } = await import(DOCX_HANDLER_MODULE) as typeof import('./docx');
  return docxHandler(input);
};

const lazyPptxHandler: Handler = async (input) => {
  const { pptxHandler } = await import(PPTX_HANDLER_MODULE) as typeof import('./pptx');
  return pptxHandler(input);
};

const lazyPassthroughHandler: Handler = async (input) => {
  const { passthroughHandler } = await import(PASSTHROUGH_HANDLER_MODULE) as typeof import('./passthrough');
  return passthroughHandler(input);
};

/** Map well-known MIME types to handlers for the extension-less case. */
const MIME_TO_HANDLER: Record<string, Handler> = {
  'application/pdf': lazyPdfHandler,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': lazyDocxHandler,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': lazyPptxHandler,
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
      return lazyPdfHandler;
    case '.docx':
      return lazyDocxHandler;
    case '.pptx':
      return lazyPptxHandler;
    default:
      break;
  }
  if (passthroughSupports(filename)) return lazyPassthroughHandler;
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
export { passthroughSupports } from './passthroughSupport';
