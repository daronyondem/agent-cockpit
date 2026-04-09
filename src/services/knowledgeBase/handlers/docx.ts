// ─── DOCX handler (pandoc-backed) ───────────────────────────────────────────
// Converts `.docx` to GitHub-Flavored Markdown via a `pandoc` subprocess.
// We previously used `mammoth` here, but it collapses tables to flat prose —
// that's fine for text extraction but loses structure the Digestion CLI
// needs. Pandoc is the only thing in our stack that round-trips OOXML tables
// into semantic markdown, so we pay the "external binary" cost to use it.
//
// Contract with callers:
//   - `detectPandoc()` MUST have been run at least once before this handler
//     fires — `runPandoc()` will throw "Pandoc not available" otherwise, and
//     the route layer is responsible for rejecting uploads early with a
//     user-friendly install message when pandoc is missing.
//   - `.doc` (legacy binary format) is explicitly unsupported — the route
//     layer returns a clear "resave as .docx" error before we ever see the
//     file, so this handler only has to cope with `.docx`.

import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { promises as fsp } from 'fs';
import { runPandoc } from '../pandoc';
import type { Handler, HandlerResult } from './types';

/** Recursively walk a directory and return absolute file paths. */
async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await recurse(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await recurse(root);
  return out;
}

export const docxHandler: Handler = async ({
  buffer,
  filename,
  outDir,
}): Promise<HandlerResult> => {
  // Pandoc reads docx from disk (it needs to unzip the OOXML package), so
  // we stage the upload in a temp file. We use a scrambled name to avoid
  // any path-escape weirdness if the original filename contains shell
  // metacharacters — `execFile` already isolates us from the shell, but
  // belt-and-braces is cheap here.
  const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-docx-'));
  const tmpDocxPath = path.join(tmpBase, `${crypto.randomBytes(6).toString('hex')}.docx`);
  const mediaDir = path.join(outDir, 'media');

  try {
    await fsp.writeFile(tmpDocxPath, buffer);
    // Ensure the media dir exists before pandoc writes into it. Pandoc will
    // happily create intermediate dirs, but if the docx has no media at all
    // our later `walkFiles` call would fail on a missing directory, so we
    // pre-create it unconditionally.
    await fsp.mkdir(mediaDir, { recursive: true });

    // `--from=docx` explicit input format (don't rely on extension sniffing).
    // `--to=gfm` GitHub-Flavored Markdown — tables as `| a | b |`, no raw HTML.
    // `--extract-media=<mediaDir>` drops embedded images into our output dir.
    //   Pandoc emits them under `<mediaDir>/media/` (it always appends a
    //   `media/` subdir). We flatten that one level after the call.
    // `--wrap=none` keeps paragraphs on a single line — avoids diff churn
    //   and makes downstream regex searches in digestion prompts easier.
    const { stdout } = await runPandoc(
      [
        '--from=docx',
        '--to=gfm',
        `--extract-media=${mediaDir}`,
        '--wrap=none',
        tmpDocxPath,
      ],
      { timeoutMs: 120_000 },
    );

    // Pandoc nests extracted media under `<mediaDir>/media/<original path>`.
    // Flatten everything into `<mediaDir>/` with basenames so the handler
    // contract (`mediaFiles: relative paths under outDir`) stays consistent
    // with docx/pptx handlers.
    const pandocMediaSubdir = path.join(mediaDir, 'media');
    const mediaFiles: string[] = [];
    const usedNames = new Set<string>();
    try {
      const all = await walkFiles(pandocMediaSubdir);
      for (const abs of all) {
        const originalBase = path.basename(abs).replace(/[\/\\]/g, '_');
        // Handle collisions when two embedded images share a basename.
        let target = originalBase;
        let collisionCounter = 1;
        while (usedNames.has(target)) {
          const ext = path.extname(originalBase);
          const stem = path.basename(originalBase, ext);
          target = `${stem}-${collisionCounter}${ext}`;
          collisionCounter += 1;
        }
        usedNames.add(target);
        const dest = path.join(mediaDir, target);
        await fsp.rename(abs, dest).catch(async () => {
          // Cross-device `rename` can fail (EXDEV) — fall back to copy+unlink.
          const data = await fsp.readFile(abs);
          await fsp.writeFile(dest, data);
          await fsp.unlink(abs).catch(() => undefined);
        });
        mediaFiles.push(path.join('media', target));
      }
    } catch {
      // Pandoc didn't create a media subdir (no embedded images in this docx).
    } finally {
      // Clean up pandoc's nested `media/` subdir whether or not we found files.
      await fsp.rm(pandocMediaSubdir, { recursive: true, force: true }).catch(() => undefined);
    }

    // Rewrite any `media/media/foo.png` references pandoc inserted into the
    // markdown to point at the flattened `media/foo.png` layout. We keep the
    // rename map per target so collision-suffixed files still resolve.
    let markdown = stdout;
    if (mediaFiles.length > 0) {
      markdown = markdown.replace(
        /(!\[[^\]]*\]\()(?:\.\/)?media\/media\/([^)\s]+)(\))/g,
        (match, open: string, rel: string, close: string) => {
          const flatBase = path.basename(rel).replace(/[\/\\]/g, '_');
          // Find the post-collision name for this original basename.
          const hit = mediaFiles.find((m) => {
            const mBase = path.basename(m);
            return mBase === flatBase || mBase.startsWith(flatBase.replace(/\.[^.]+$/, '') + '-');
          });
          return `${open}${hit || path.join('media', flatBase)}${close}`;
        },
      );
    }

    // Prepend a title line so the converted markdown is self-identifying and
    // the Digestion CLI can cite the source filename without reaching into
    // meta.json. Matches the pdf/pptx handlers.
    const body = `# ${filename}\n\n${markdown.trim() || '_[empty document]_'}`;
    const wordCount = markdown.split(/\s+/).filter(Boolean).length;

    return {
      text: body,
      mediaFiles,
      handler: 'docx/pandoc',
      metadata: {
        wordCount,
        mediaCount: mediaFiles.length,
      },
    };
  } finally {
    await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => undefined);
  }
};
