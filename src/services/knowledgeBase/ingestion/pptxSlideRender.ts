// ─── PPTX slide rasterization (LibreOffice + unpdf) ─────────────────────────
// Converts a `.pptx` buffer into one PNG per slide by shelling out to
// `soffice --headless --convert-to pdf` and then rendering each PDF page via
// unpdf + `@napi-rs/canvas`. Lives as a sibling of the PPTX handler so the
// hybrid handler can `import * as pptxSlideRender` and tests can use
// `jest.spyOn` on the named export to inject fake slide images for AI-path
// coverage without launching LibreOffice.
//
// Behavior on failure is intentionally defensive: any failure (LibreOffice
// missing, conversion timeout, PDF unreadable, individual page render error)
// falls back to either an empty `images: []` with a `warning` string, or a
// partial list of pages that did render. The caller decides how to surface
// the warning to the user.

import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { promises as fsp } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { renderPageAsImage, getDocumentProxy, createIsomorphicCanvasFactory } from 'unpdf';
import * as napiCanvas from '@napi-rs/canvas';
import { detectLibreOffice } from '../libreOffice';

const execFileAsync = promisify(execFile);

// 168 DPI. 16:9 slides exported as 960x540 pt render to 2240x1260 px,
// exact 28 px multiples that fit under Opus 4.7's 2576 px native long edge.
export const PPTX_SLIDE_RASTER_SCALE = 7 / 3;

export interface RasterizationResult {
  /** Slide image paths relative to `outDir`, e.g. `slides/slide-001.png`. */
  images: string[];
  /** Human-readable warning when something prevented full rasterization. */
  warning?: string;
}

/**
 * Shell out to `soffice --headless --convert-to pdf` to produce a PDF of the
 * deck, then render each PDF page as a PNG via unpdf + an isomorphic canvas
 * factory. Returns the list of slide image paths (relative to `outDir`), or
 * an empty array on any failure.
 */
export async function rasterizeSlidesViaLibreOffice(
  buffer: Buffer,
  filename: string,
  outDir: string,
): Promise<RasterizationResult> {
  const status = await detectLibreOffice();
  if (!status.available || !status.binaryPath) {
    return {
      images: [],
      warning: 'LibreOffice not available — slide-to-image conversion skipped.',
    };
  }

  // Work inside a temp dir so `soffice --outdir` can't collide with our
  // real output directory on retries.
  const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-pptx-'));
  try {
    const safeStem = path.basename(filename, path.extname(filename)).replace(/[^a-z0-9_-]/gi, '_');
    const inputPath = path.join(tmpBase, `${safeStem}-${crypto.randomBytes(4).toString('hex')}.pptx`);
    await fsp.writeFile(inputPath, buffer);

    // `--headless` keeps soffice from drawing a tray icon; `--norestore`
    // prevents it from recovering a crashed user profile; `--nolockcheck`
    // avoids the ~/.config/libreoffice lock file that blocks concurrent
    // instances under pm2.
    await execFileAsync(
      status.binaryPath,
      [
        '--headless',
        '--norestore',
        '--nolockcheck',
        '--convert-to', 'pdf',
        '--outdir', tmpBase,
        inputPath,
      ],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );

    const pdfPath = inputPath.replace(/\.pptx$/i, '.pdf');
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await fsp.readFile(pdfPath);
    } catch {
      return {
        images: [],
        warning: 'LibreOffice did not produce a PDF for the deck.',
      };
    }

    // Render each page with unpdf's `renderPageAsImage` helper. It takes
    // a `canvasImport` factory; we hand it the statically-imported
    // `@napi-rs/canvas` namespace so there's no per-page dynamic import
    // overhead (and no optional-dep failure mode — canvas is a regular
    // dep now). Crucially, we also build the CanvasFactory up front and
    // pass it to getDocumentProxy — without it pdfjs uses its own
    // NodeCanvasFactory stub that throws on image XObjects during
    // page.render() (see the matching comment in handlers/pdf.ts).
    const data = new Uint8Array(pdfBuffer.buffer.slice(
      pdfBuffer.byteOffset,
      pdfBuffer.byteOffset + pdfBuffer.byteLength,
    ));
    const canvasImport = async () => napiCanvas;
    const CanvasFactory = await createIsomorphicCanvasFactory(canvasImport);
    const pdf = await getDocumentProxy(data, { CanvasFactory } as unknown as Parameters<typeof getDocumentProxy>[1]);
    const totalPages = pdf.numPages;
    const slidesDir = path.join(outDir, 'slides');
    await fsp.mkdir(slidesDir, { recursive: true });
    const rel: string[] = [];

    for (let page = 1; page <= totalPages; page += 1) {
      try {
        const pngBuffer = await renderPageAsImage(pdf, page, {
          canvasImport,
          scale: PPTX_SLIDE_RASTER_SCALE,
        });
        const pngPath = path.join(slidesDir, `slide-${String(page).padStart(3, '0')}.png`);
        await fsp.writeFile(pngPath, Buffer.from(pngBuffer));
        rel.push(path.join('slides', `slide-${String(page).padStart(3, '0')}.png`));
      } catch (err) {
        // Skip bad pages — we still keep the ones that rendered — but
        // log so a catastrophic "every page failed" isn't silent.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[kb/pptx] Failed to rasterize slide ${page} of "${filename}": ${message}`);
      }
    }
    return { images: rel };
  } catch (err: unknown) {
    return {
      images: [],
      warning: `LibreOffice rasterization failed: ${(err as Error).message}`,
    };
  } finally {
    await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => undefined);
  }
}
