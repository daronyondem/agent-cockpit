// ─── DOCX handler (pandoc + per-image AI description) ──────────────────────
// Converts `.docx` to GitHub-Flavored Markdown via a `pandoc` subprocess, then
// describes embedded images with the configured Ingestion CLI so digestion
// sees real text instead of bare image links.
//
// Flow:
//   1. pandoc → GFM markdown + media/ directory (unchanged from before)
//   2. For each extracted image:
//        - measure width via `@napi-rs/canvas.loadImage`
//        - skip when `width < 100` (icons, logos, decorative dividers)
//        - skip when no Ingestion CLI is configured
//        - otherwise call `convertImageToMarkdown` and append a
//          `> Image description (source: artificial-intelligence): …`
//          quoted block right after every reference to that image.
//      Per-image failures fall back to the bare link with no description.
//
// Pandoc is the only tool in our stack that round-trips OOXML tables into
// semantic markdown, so we pay the "external binary" cost to use it.
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
import * as napiCanvas from '@napi-rs/canvas';
import { runPandoc } from '../pandoc';
import type { Handler, HandlerResult } from './types';
import {
  convertImageToMarkdown,
  ensureAiReadyImage,
} from '../ingestion/pageConversion';

/** Below this pixel width an image is treated as decorative and not described. */
const MIN_DESCRIBABLE_WIDTH = 100;

type ImageSource =
  | 'artificial-intelligence'
  | 'too-small'
  | 'no-adapter'
  | 'ai-failed';

interface ImageRecord {
  mediaPath: string;
  width: number | null;
  source: ImageSource;
  aiCallDurationMs: number | null;
  aiRetries: number;
}

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
  ingestionAdapter,
  ingestionModel,
  ingestionEffort,
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

    // Rewrite image references pandoc inserted to point at the flattened
    // `media/<basename>` layout. Pandoc emits TWO forms depending on whether
    // the source DOCX preserved inline width/height styling:
    //   - Plain markdown: `![](./media/media/foo.png)` (relative path)
    //   - HTML img tag:   `<img src="/abs/.../media/media/foo.png" style="…" />`
    //                     (pandoc absolutizes the src and falls back to raw
    //                     HTML for anything markdown can't represent natively,
    //                     like inline sizing — common for figures from Word).
    // Both forms get rewritten by basename so the result is portable.
    let markdown = stdout;
    if (mediaFiles.length > 0) {
      markdown = markdown.replace(
        /(!\[[^\]]*\]\()([^)\s]+)(\))/g,
        (match, open: string, src: string, close: string) => {
          const hit = findFlattenedRel(src, mediaFiles);
          return hit ? `${open}${hit}${close}` : match;
        },
      );
      markdown = markdown.replace(
        /<img\b([^>]*?)\bsrc="([^"]+)"([^>]*?)>/gi,
        (match, before: string, src: string, after: string) => {
          const hit = findFlattenedRel(src, mediaFiles);
          return hit ? `<img${before}src="${hit}"${after}>` : match;
        },
      );
    }

    // Per-image classification + AI description pass. Order matches `mediaFiles`
    // so the metadata reflects the order pandoc emitted them. We snapshot the
    // list first because we may append `.ai.png` siblings during the loop.
    const imageRecords: ImageRecord[] = [];
    const originalMediaRels = mediaFiles.slice();
    for (const rel of originalMediaRels) {
      const abs = path.join(outDir, rel);
      let width: number | null = null;
      try {
        const img = await napiCanvas.loadImage(abs);
        width = img.width;
      } catch {
        // Couldn't decode (uncommon format, corrupt bytes) — fall through and
        // try to describe anyway, since AI vision can sometimes still read it.
        width = null;
      }

      if (width !== null && width < MIN_DESCRIBABLE_WIDTH) {
        imageRecords.push({
          mediaPath: rel,
          width,
          source: 'too-small',
          aiCallDurationMs: null,
          aiRetries: 0,
        });
        continue;
      }

      // For describable images, write a `.ai.png` sibling when the long edge
      // exceeds the vision-token cap and rewrite this image's references in
      // the markdown to point at the sibling. The AI call also uses the
      // sibling. The original is preserved on disk for KB Browser.
      let aiAbs = abs;
      let aiRel = rel;
      const sidecarAbs = abs + '.ai.png';
      const sidecarRel = rel + '.ai.png';
      const resolved = await ensureAiReadyImage(abs, sidecarAbs);
      if (resolved !== abs) {
        aiAbs = sidecarAbs;
        aiRel = sidecarRel;
        mediaFiles.push(sidecarRel);
        markdown = rewriteRefsToSibling(markdown, rel, sidecarRel);
      }

      if (!ingestionAdapter) {
        imageRecords.push({
          mediaPath: aiRel,
          width,
          source: 'no-adapter',
          aiCallDurationMs: null,
          aiRetries: 0,
        });
        continue;
      }

      const startedAt = Date.now();
      let description: string | null = null;
      let retried = false;
      let aiError: string | null = null;
      try {
        const result = await convertImageToMarkdown(aiAbs, {
          adapter: ingestionAdapter,
          model: ingestionModel,
          effort: ingestionEffort,
        });
        description = result.markdown;
        retried = result.retried;
      } catch (err) {
        aiError = err instanceof Error ? err.message : String(err);
      }
      const aiCallDurationMs = Date.now() - startedAt;

      if (description !== null) {
        markdown = augmentImageReference(markdown, aiRel, description);
        imageRecords.push({
          mediaPath: aiRel,
          width,
          source: 'artificial-intelligence',
          aiCallDurationMs,
          aiRetries: retried ? 1 : 0,
        });
      } else {
        console.warn(`[kb/docx] AI description failed for ${aiRel} of "${filename}": ${aiError}`);
        imageRecords.push({
          mediaPath: aiRel,
          width,
          source: 'ai-failed',
          aiCallDurationMs,
          aiRetries: 1,
        });
      }
    }

    // Prepend a title line so the converted markdown is self-identifying and
    // the Digestion CLI can cite the source filename without reaching into
    // meta.json. Matches the pdf/pptx handlers.
    const body = `# ${filename}\n\n${markdown.trim() || '_[empty document]_'}`;
    const wordCount = markdown.split(/\s+/).filter(Boolean).length;

    const sourceCounts = imageRecords.reduce(
      (acc, r) => {
        acc[r.source] = (acc[r.source] ?? 0) + 1;
        return acc;
      },
      {} as Record<ImageSource, number>,
    );

    return {
      text: body,
      mediaFiles,
      handler: 'docx/pandoc-hybrid',
      metadata: {
        wordCount,
        mediaCount: mediaFiles.length,
        sourceCounts,
        images: imageRecords,
      },
    };
  } finally {
    await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => undefined);
  }
};

/**
 * Look up the post-flatten relative path for an image reference whose `src`
 * may be relative (`./media/media/foo.png`) or absolute (the full disk path
 * pandoc emits when it falls back to an HTML `<img>` tag). Returns the entry
 * in `mediaFiles` whose basename matches `src`'s basename — including the
 * collision-suffixed form (`foo-1.png`) when two embedded images shared a
 * basename. Returns `null` when nothing matches (so callers can leave the
 * reference untouched rather than fabricate a path).
 */
function findFlattenedRel(src: string, mediaFiles: string[]): string | null {
  const baseRaw = path.basename(src);
  const flatBase = baseRaw.replace(/[\/\\]/g, '_');
  const stem = flatBase.replace(/\.[^.]+$/, '');
  return (
    mediaFiles.find((m) => {
      const mBase = path.basename(m);
      return mBase === flatBase || mBase.startsWith(stem + '-');
    }) ?? null
  );
}

/**
 * Replace every link target equal to `oldRel` with `newRel` in the markdown.
 * Handles both pandoc output forms — `![alt](oldRel)` and `<img src="oldRel">`.
 * Used after an oversized image's `.ai.png` sibling is written so digestion
 * follows the link to the downscaled copy that fits the vision-token cap.
 */
function rewriteRefsToSibling(markdown: string, oldRel: string, newRel: string): string {
  const escaped = oldRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mdRe = new RegExp(`(!\\[[^\\]]*\\]\\()${escaped}(\\))`, 'g');
  const htmlRe = new RegExp(`(<img\\b[^>]*?\\bsrc=")${escaped}("[^>]*?>)`, 'gi');
  return markdown.replace(mdRe, `$1${newRel}$2`).replace(htmlRe, `$1${newRel}$2`);
}

/**
 * Append a quoted "Image description" block right after every reference to
 * `mediaRel` in the markdown. Handles both pandoc output forms — markdown
 * `![alt](mediaRel)` and HTML `<img ... src="mediaRel" ...>`. Multi-line
 * descriptions are quoted with `>` on every line so the rendered markdown
 * shows them as a single blockquote.
 */
function augmentImageReference(
  markdown: string,
  mediaRel: string,
  description: string,
): string {
  const desc = description.trim();
  if (!desc) return markdown;

  const lines = desc.split('\n');
  const quoted = lines
    .map((line, i) =>
      i === 0
        ? `> Image description (source: artificial-intelligence): ${line}`
        : `> ${line}`,
    )
    .join('\n');

  const escaped = mediaRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mdRe = new RegExp(`(!\\[[^\\]]*\\]\\(${escaped}\\))`, 'g');
  const htmlRe = new RegExp(`(<img\\b[^>]*?\\bsrc="${escaped}"[^>]*?>)`, 'gi');
  return markdown.replace(mdRe, `$1\n\n${quoted}`).replace(htmlRe, `$1\n\n${quoted}`);
}
