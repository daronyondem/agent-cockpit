// ─── Passthrough handler ────────────────────────────────────────────────────
// For file types where the original bytes ARE the usable content — plain
// text, Markdown, source code, and raw images. The handler copies the
// file into the output directory verbatim and either embeds its contents
// (text) or references it as media (images).

import path from 'path';
import { promises as fsp } from 'fs';
import type { Handler, HandlerResult } from './types';

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

/** True iff the extension belongs to a format this handler can handle. */
export function passthroughSupports(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return TEXT_EXTS.has(ext) || IMAGE_EXTS.has(ext);
}

export const passthroughHandler: Handler = async ({
  buffer,
  filename,
  outDir,
}): Promise<HandlerResult> => {
  const ext = path.extname(filename).toLowerCase();

  // Text-like formats: decode as UTF-8 and inline into `text.md`.
  // Oversized files are truncated with a marker so the digestion prompt
  // never explodes — 200 KB is generous for any reasonable source or
  // markdown doc.
  if (TEXT_EXTS.has(ext)) {
    const MAX_BYTES = 200 * 1024;
    let text: string;
    let truncated = false;
    if (buffer.byteLength > MAX_BYTES) {
      text = buffer.subarray(0, MAX_BYTES).toString('utf8');
      truncated = true;
    } else {
      text = buffer.toString('utf8');
    }
    // Wrap non-markdown text in a code fence for readability in the
    // digestion prompt. Markdown is passed through as-is so existing
    // headings survive.
    const body =
      ext === '.md' || ext === '.markdown'
        ? text
        : '```' + ext.slice(1) + '\n' + text + '\n```';
    const header = `# ${filename}\n\n`;
    const footer = truncated ? `\n\n_[Truncated at ${MAX_BYTES} bytes.]_\n` : '';
    return {
      text: header + body + footer,
      mediaFiles: [],
      handler: 'passthrough/text',
      metadata: {
        byteLength: buffer.byteLength,
        truncated,
      },
    };
  }

  // Image formats: copy to `media/` and embed a Markdown image reference.
  // The Digestion CLI can read the file via its own file tools if needed.
  if (IMAGE_EXTS.has(ext)) {
    const mediaDir = path.join(outDir, 'media');
    await fsp.mkdir(mediaDir, { recursive: true });
    const safeName = filename.replace(/[\/\\]/g, '_');
    const mediaPath = path.join(mediaDir, safeName);
    await fsp.writeFile(mediaPath, buffer);
    const relMedia = path.join('media', safeName);
    return {
      text: `# ${filename}\n\n![${filename}](${relMedia})\n`,
      mediaFiles: [relMedia],
      handler: 'passthrough/image',
      metadata: {
        byteLength: buffer.byteLength,
      },
    };
  }

  throw new Error(`passthrough handler: unsupported extension ${ext}`);
};
