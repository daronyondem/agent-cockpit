// ─── DOCX handler ───────────────────────────────────────────────────────────
// Uses `mammoth` for text extraction and `adm-zip` to pull embedded media
// out of `word/media/*`. We deliberately use `extractRawText` rather than
// `convertToHtml` because (a) raw text is what the Digestion CLI wants,
// (b) avoiding the HTML→markdown conversion keeps the handler small, and
// (c) embedded image references are appended at the end of the markdown
// so the CLI can list them without us building a full HTML parser.

import path from 'path';
import { promises as fsp } from 'fs';
import mammoth from 'mammoth';
import AdmZip from 'adm-zip';
import type { Handler, HandlerResult } from './types';

export const docxHandler: Handler = async ({
  buffer,
  filename,
  outDir,
}): Promise<HandlerResult> => {
  const rawTextResult = await mammoth.extractRawText({ buffer });
  const bodyText = (rawTextResult.value || '').trim();

  // Pull any images embedded under `word/media/` and dump them to
  // `media/`. DOCX is a zip — the same trick we use for PPTX below.
  const mediaFiles: string[] = [];
  let mediaDir = '';
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries().filter((e) =>
      e.entryName.startsWith('word/media/') && !e.isDirectory,
    );
    if (entries.length > 0) {
      mediaDir = path.join(outDir, 'media');
      await fsp.mkdir(mediaDir, { recursive: true });
      for (const entry of entries) {
        // Use the basename to avoid nested `media/` paths under our
        // `media/` dir; collisions get a numeric suffix.
        const base = path.basename(entry.entryName).replace(/[\/\\]/g, '_');
        let target = base;
        let collisionCounter = 1;
        while (mediaFiles.includes(path.join('media', target))) {
          const ext = path.extname(base);
          const stem = path.basename(base, ext);
          target = `${stem}-${collisionCounter}${ext}`;
          collisionCounter += 1;
        }
        const diskPath = path.join(mediaDir, target);
        await fsp.writeFile(diskPath, entry.getData());
        mediaFiles.push(path.join('media', target));
      }
    }
  } catch {
    // Media extraction is best-effort — if the DOCX is somehow
    // malformed-but-parseable-by-mammoth, we still ship the text.
  }

  let text = `# ${filename}\n\n${bodyText || '_[empty document]_'}`;
  if (mediaFiles.length > 0) {
    const mediaRefs = mediaFiles
      .map((rel) => `![${path.basename(rel)}](${rel})`)
      .join('\n');
    text += `\n\n## Embedded Media\n\n${mediaRefs}\n`;
  }

  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

  return {
    text,
    mediaFiles,
    handler: 'docx',
    metadata: {
      wordCount,
      mediaCount: mediaFiles.length,
    },
  };
};
