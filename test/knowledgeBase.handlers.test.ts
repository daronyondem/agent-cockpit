/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Format handler tests ───────────────────────────────────────────────────
// PDF and PPTX handlers are tested against real fixtures in
// `test/fixtures/kb/`:
//   - sample.pdf    (592 B)   — tiny single-page PDF with one text line
//   - sample.pptx   (1.9 KB) — two slides with speaker notes on slide 1
// The DOCX handler shells out to pandoc, so instead of shipping a docx
// fixture + requiring pandoc everywhere, we stub `runPandoc` per test.
// Plus ad-hoc text/image buffers for the passthrough handler.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { pdfHandler } from '../src/services/knowledgeBase/handlers/pdf';
import { docxHandler } from '../src/services/knowledgeBase/handlers/docx';
import { pptxHandler } from '../src/services/knowledgeBase/handlers/pptx';
import * as pandocModule from '../src/services/knowledgeBase/pandoc';
import * as pdfSignalsModule from '../src/services/knowledgeBase/ingestion/pdfSignals';
import * as napiCanvas from '@napi-rs/canvas';
import {
  passthroughHandler,
  passthroughSupports,
} from '../src/services/knowledgeBase/handlers/passthrough';
import {
  pickHandler,
  ingestFile,
  UnsupportedFileTypeError,
} from '../src/services/knowledgeBase/handlers';

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'kb');

function readFixture(name: string): Buffer {
  return fs.readFileSync(path.join(FIXTURE_DIR, name));
}

/** Build a real, decodable PNG of the given dimensions (a flat blue rectangle).
 *  We need real PNGs for the DOCX width filter — `loadImage` rejects buffers
 *  that are just the PNG magic bytes. */
function makePng(width: number, height: number): Buffer {
  const canvas = napiCanvas.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3b82f6';
  ctx.fillRect(0, 0, width, height);
  return canvas.toBuffer('image/png');
}

let outDir: string;

beforeEach(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-handler-'));
});

afterEach(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

// ── PDF ─────────────────────────────────────────────────────────────────────

describe('pdfHandler', () => {
  test('rasterizes each page and emits a hybrid source-annotated index', async () => {
    const buffer = readFixture('sample.pdf');
    const result = await pdfHandler({
      buffer,
      filename: 'sample.pdf',
      mimeType: 'application/pdf',
      outDir,
    });

    // Handler tag matches the renamed hybrid pipeline.
    expect(result.handler).toBe('pdf/rasterized-hybrid');
    expect(result.text).toContain('# sample.pdf');

    // One section per page with a `> source: ...` annotation. The fixture
    // is plain prose with no figures/tables, so source must be `pdfjs`.
    expect(result.text).toContain('## Page 1');
    expect(result.text).toMatch(
      /^> source: pdfjs \| figures: 0 \| table-likely: false$/m,
    );
    // The image link is preserved regardless of source.
    expect(result.text).toMatch(/!\[Page 1\]\(pages\/page-0001\.png\)/);
    expect(result.mediaFiles).toEqual(['pages/page-0001.png']);

    // pdfjs extracts the body text on safe-text pages.
    expect(result.text).toContain('Hello KB test PDF');

    // The PNG actually exists on disk and is non-empty.
    const onDisk = fs.statSync(path.join(outDir, 'pages/page-0001.png'));
    expect(onDisk.size).toBeGreaterThan(0);
    const header = fs
      .readFileSync(path.join(outDir, 'pages/page-0001.png'))
      .subarray(0, 4);
    expect([header[0], header[1], header[2], header[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    // Metadata: counts + nested sourceCounts + per-page array.
    expect(result.metadata?.pageCount).toBe(1);
    expect(result.metadata?.renderedPageCount).toBe(1);
    expect(result.metadata?.rasterDpi).toBe(150);
    const sourceCounts = result.metadata?.sourceCounts as Record<string, number>;
    expect(sourceCounts.pdfjs).toBe(1);
    expect(sourceCounts['artificial-intelligence']).toBeUndefined();
    expect(sourceCounts['image-only']).toBeUndefined();

    const pages = result.metadata?.pages as Array<{
      pageNumber: number;
      source: string;
      figureCount: number;
      tableLikely: boolean;
      extractedChars: number;
    }>;
    expect(pages).toHaveLength(1);
    expect(pages[0].pageNumber).toBe(1);
    expect(pages[0].source).toBe('pdfjs');
    expect(pages[0].figureCount).toBe(0);
    expect(pages[0].tableLikely).toBe(false);
    expect(pages[0].extractedChars).toBeGreaterThan(0);
  });

  test('falls back to image-only when no Ingestion CLI is configured for needs-ai pages', async () => {
    // Force the classify path into `needs-ai` by stubbing the signals
    // module to report figureCount > 0. Easiest way: load a real PDF and
    // monkey-patch `extractPageSignals` for the duration of the test.
    const spy = jest.spyOn(pdfSignalsModule, 'extractPageSignals').mockResolvedValue({
      extractedText: '',
      extractedChars: 0,
      figureCount: 1,
      tableLikely: false,
    });
    try {
      const buffer = readFixture('sample.pdf');
      const result = await pdfHandler({
        buffer,
        filename: 'sample.pdf',
        mimeType: 'application/pdf',
        outDir,
        // ingestionAdapter intentionally omitted
      });
      expect(result.text).toMatch(/^> source: image-only \| figures: 1 \| table-likely: false$/m);
      const sc = result.metadata?.sourceCounts as Record<string, number>;
      expect(sc['image-only']).toBe(1);
      expect(sc['artificial-intelligence']).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  test('calls the Ingestion CLI for needs-ai pages and annotates source: artificial-intelligence', async () => {
    const spy = jest.spyOn(pdfSignalsModule, 'extractPageSignals').mockResolvedValue({
      extractedText: '',
      extractedChars: 0,
      figureCount: 1,
      tableLikely: true,
    });

    const adapterCalls: Array<{ prompt: string; opts: any }> = [];
    const stubAdapter = {
      async runOneShot(prompt: string, opts?: any) {
        adapterCalls.push({ prompt, opts });
        return '## AI-reconstructed page heading\n\n| Col1 | Col2 |\n|------|------|\n| a    | b    |';
      },
    } as any;

    try {
      const buffer = readFixture('sample.pdf');
      const result = await pdfHandler({
        buffer,
        filename: 'sample.pdf',
        mimeType: 'application/pdf',
        outDir,
        ingestionAdapter: stubAdapter,
        ingestionModel: 'claude-sonnet-4-6',
      });

      expect(adapterCalls).toHaveLength(1);
      expect(adapterCalls[0].prompt).toContain('page-0001.png');
      expect(adapterCalls[0].opts.model).toBe('claude-sonnet-4-6');
      expect(adapterCalls[0].opts.allowTools).toBe(true);

      expect(result.text).toMatch(
        /^> source: artificial-intelligence \| figures: 1 \| table-likely: true$/m,
      );
      expect(result.text).toContain('AI-reconstructed page heading');
      // Image link is still appended after the AI body.
      expect(result.text).toMatch(/!\[Page 1\]\(pages\/page-0001\.png\)/);

      const sc = result.metadata?.sourceCounts as Record<string, number>;
      expect(sc['artificial-intelligence']).toBe(1);
      // First-attempt success → aiRetries=0 (not 1).
      const pages = result.metadata?.pages as Array<{ aiRetries: number }>;
      expect(pages[0].aiRetries).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test('records aiRetries=1 when the AI succeeds on the second attempt', async () => {
    const spy = jest.spyOn(pdfSignalsModule, 'extractPageSignals').mockResolvedValue({
      extractedText: '',
      extractedChars: 0,
      figureCount: 1,
      tableLikely: false,
    });
    let calls = 0;
    const stubAdapter = {
      async runOneShot() {
        calls += 1;
        if (calls === 1) throw new Error('first attempt failed');
        return '# AI second-attempt success';
      },
    } as any;

    try {
      const buffer = readFixture('sample.pdf');
      const result = await pdfHandler({
        buffer,
        filename: 'sample.pdf',
        mimeType: 'application/pdf',
        outDir,
        ingestionAdapter: stubAdapter,
      });
      const pages = result.metadata?.pages as Array<{ source: string; aiRetries: number }>;
      expect(pages[0].source).toBe('artificial-intelligence');
      expect(pages[0].aiRetries).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('falls back to image-only when the Ingestion CLI fails twice', async () => {
    const spy = jest.spyOn(pdfSignalsModule, 'extractPageSignals').mockResolvedValue({
      extractedText: '',
      extractedChars: 0,
      figureCount: 1,
      tableLikely: false,
    });
    const stubAdapter = {
      async runOneShot() {
        throw new Error('CLI exploded');
      },
    } as any;

    try {
      const buffer = readFixture('sample.pdf');
      const result = await pdfHandler({
        buffer,
        filename: 'sample.pdf',
        mimeType: 'application/pdf',
        outDir,
        ingestionAdapter: stubAdapter,
      });
      expect(result.text).toMatch(/^> source: image-only \| note: AI conversion failed after retry$/m);
      expect(result.text).toMatch(/!\[Page 1\]\(pages\/page-0001\.png\)/);
      const sc = result.metadata?.sourceCounts as Record<string, number>;
      expect(sc['image-only']).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── DOCX ────────────────────────────────────────────────────────────────────

// The docx handler shells out to pandoc, so rather than ship a real docx
// fixture and require pandoc on every dev machine + CI box, we stub
// `runPandoc` per test. The stub simulates what pandoc would write into
// `--extract-media` and returns the markdown body on stdout — exactly the
// contract the handler relies on.
describe('docxHandler', () => {
  let runPandocSpy: jest.SpyInstance;

  afterEach(() => {
    if (runPandocSpy) runPandocSpy.mockRestore();
  });

  /** Wire the runPandoc spy to drop a real PNG of the requested size into the
   *  --extract-media dir and emit one image reference in stdout. */
  function stubPandocOneImage(width: number, markdownBody: string) {
    runPandocSpy = jest
      .spyOn(pandocModule, 'runPandoc')
      .mockImplementation(async (args) => {
        const extractArg = (args as string[]).find((a) =>
          a.startsWith('--extract-media='),
        )!;
        const mediaRoot = extractArg.replace('--extract-media=', '');
        const nested = path.join(mediaRoot, 'media');
        fs.mkdirSync(nested, { recursive: true });
        fs.writeFileSync(path.join(nested, 'image1.png'), makePng(width, width));
        return { stdout: markdownBody, stderr: '' };
      });
  }

  test('flattens pandoc-extracted media and preserves table markdown', async () => {
    stubPandocOneImage(
      300,
      'Hello from the DOCX fixture.\n\n' +
        'Second paragraph for word count.\n\n' +
        '| a | b |\n|---|---|\n| 1 | 2 |\n\n' +
        '![image](media/media/image1.png)\n',
    );

    const result = await docxHandler({
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]), // any bytes — handler just writes to a temp file
      filename: 'sample.docx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      outDir,
    });

    // Handler identity + title prefix.
    expect(result.handler).toBe('docx/pandoc-hybrid');
    expect(result.text).toContain('# sample.docx');
    expect(result.text).toContain('Hello from the DOCX fixture.');
    expect(result.text).toContain('Second paragraph for word count.');
    // Markdown tables are preserved (the whole reason we switched to pandoc).
    expect(result.text).toContain('| a | b |');
    expect(result.text).toContain('| 1 | 2 |');

    // Media is flattened one level and referenced via the new path.
    expect(result.mediaFiles).toEqual(['media/image1.png']);
    expect(fs.existsSync(path.join(outDir, 'media', 'image1.png'))).toBe(true);
    // And pandoc's nested media/media/ subdir is cleaned up.
    expect(fs.existsSync(path.join(outDir, 'media', 'media'))).toBe(false);
    // The handler rewrites `media/media/...` references to match the flattened layout.
    expect(result.text).toContain('](media/image1.png)');
    expect(result.text).not.toContain('media/media/');

    // Pandoc got the expected argument shape.
    expect(runPandocSpy).toHaveBeenCalledTimes(1);
    const [argsArr] = runPandocSpy.mock.calls[0];
    expect(argsArr).toContain('--from=docx');
    expect(argsArr).toContain('--to=gfm');
    expect(argsArr).toContain('--wrap=none');
    expect((argsArr as string[]).some((a) => a.startsWith('--extract-media='))).toBe(true);

    expect(result.metadata?.mediaCount).toBe(1);
    expect(result.metadata?.wordCount).toBeGreaterThan(0);
    // Width-matching image with no adapter → `no-adapter`, link unchanged.
    const sc = result.metadata?.sourceCounts as Record<string, number>;
    expect(sc['no-adapter']).toBe(1);
    expect(sc['artificial-intelligence']).toBeUndefined();
    expect(result.text).not.toContain('Image description (source:');
    const images = result.metadata?.images as Array<{
      mediaPath: string;
      width: number | null;
      source: string;
    }>;
    expect(images).toHaveLength(1);
    expect(images[0].mediaPath).toBe('media/image1.png');
    expect(images[0].width).toBe(300);
    expect(images[0].source).toBe('no-adapter');
  });

  test('skips images narrower than 100px (icons, logos, decorative)', async () => {
    stubPandocOneImage(
      80,
      'Doc with a tiny logo.\n\n![logo](media/media/image1.png)\n',
    );
    const stubAdapter = {
      runOneShot: jest.fn(async () => 'should not be called'),
    } as any;

    const result = await docxHandler({
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      filename: 'tiny.docx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      outDir,
      ingestionAdapter: stubAdapter,
    });

    // Adapter must not be called for sub-threshold images.
    expect(stubAdapter.runOneShot).not.toHaveBeenCalled();
    const sc = result.metadata?.sourceCounts as Record<string, number>;
    expect(sc['too-small']).toBe(1);
    expect(sc['artificial-intelligence']).toBeUndefined();
    // Link is preserved as-is, no description block appended.
    expect(result.text).toContain('![logo](media/image1.png)');
    expect(result.text).not.toContain('Image description (source:');
  });

  test('appends an AI description after each describable image', async () => {
    stubPandocOneImage(
      400,
      'Intro paragraph.\n\n![chart](media/media/image1.png)\n\nClosing paragraph.\n',
    );
    const adapterCalls: Array<{ prompt: string; opts: any }> = [];
    const stubAdapter = {
      async runOneShot(prompt: string, opts?: any) {
        adapterCalls.push({ prompt, opts });
        return 'A line chart showing daily active users\nfrom Jan to Mar 2026, peaking at 12,400.';
      },
    } as any;

    const result = await docxHandler({
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      filename: 'sample.docx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      outDir,
      ingestionAdapter: stubAdapter,
      ingestionModel: 'claude-sonnet-4-6',
    });

    expect(adapterCalls).toHaveLength(1);
    expect(adapterCalls[0].prompt).toContain('image1.png');
    expect(adapterCalls[0].opts.model).toBe('claude-sonnet-4-6');
    expect(adapterCalls[0].opts.allowTools).toBe(true);

    const sc = result.metadata?.sourceCounts as Record<string, number>;
    expect(sc['artificial-intelligence']).toBe(1);

    // The image link is preserved AND followed by the multi-line quoted block.
    expect(result.text).toContain('![chart](media/image1.png)');
    expect(result.text).toContain(
      '> Image description (source: artificial-intelligence): A line chart showing daily active users',
    );
    expect(result.text).toContain('> from Jan to Mar 2026, peaking at 12,400.');

    const images = result.metadata?.images as Array<{
      source: string;
      width: number | null;
      aiCallDurationMs: number | null;
      aiRetries: number;
    }>;
    expect(images[0].source).toBe('artificial-intelligence');
    expect(images[0].width).toBe(400);
    expect(images[0].aiCallDurationMs).toBeGreaterThanOrEqual(0);
    expect(images[0].aiRetries).toBe(0);
  });

  test('rewrites HTML <img> tags (pandoc absolutizes when DOCX has inline styling) and appends AI description', async () => {
    // Pandoc falls back to raw HTML <img> for images that carry inline width/
    // height styling — anything markdown's `![](…)` can't represent. The src
    // gets absolutized to the on-disk path inside the --extract-media dir.
    runPandocSpy = jest
      .spyOn(pandocModule, 'runPandoc')
      .mockImplementation(async (args) => {
        const extractArg = (args as string[]).find((a) =>
          a.startsWith('--extract-media='),
        )!;
        const mediaRoot = extractArg.replace('--extract-media=', '');
        const nested = path.join(mediaRoot, 'media');
        fs.mkdirSync(nested, { recursive: true });
        const abs = path.join(nested, 'image1.png');
        fs.writeFileSync(abs, makePng(400, 400));
        // Emit pandoc's exact HTML-img output shape: absolute path + inline style.
        const stdout =
          'Intro paragraph.\n\n' +
          `<img src="${abs}" style="width:2.05in;height:2.79in" />\n\n` +
          'Closing paragraph.\n';
        return { stdout, stderr: '' };
      });
    const adapterCalls: Array<{ prompt: string }> = [];
    const stubAdapter = {
      async runOneShot(prompt: string) {
        adapterCalls.push({ prompt });
        return 'A line chart showing daily active users.';
      },
    } as any;

    const result = await docxHandler({
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      filename: 'styled.docx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      outDir,
      ingestionAdapter: stubAdapter,
    });

    expect(adapterCalls).toHaveLength(1);
    // Path was rewritten to the flattened relative form — no absolute path leaks.
    expect(result.text).not.toMatch(/src="\/[^"]*media\/media\//);
    expect(result.text).toContain('src="media/image1.png"');
    // Inline style is preserved through the rewrite.
    expect(result.text).toContain('style="width:2.05in;height:2.79in"');
    // AI description is appended right after the <img> tag.
    expect(result.text).toContain(
      '> Image description (source: artificial-intelligence): A line chart showing daily active users.',
    );
    const sc = result.metadata?.sourceCounts as Record<string, number>;
    expect(sc['artificial-intelligence']).toBe(1);
  });

  test('falls back to bare link when AI description fails twice', async () => {
    stubPandocOneImage(
      400,
      'Intro.\n\n![chart](media/media/image1.png)\n',
    );
    const stubAdapter = {
      async runOneShot() {
        throw new Error('CLI exploded');
      },
    } as any;

    const result = await docxHandler({
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      filename: 'fail.docx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      outDir,
      ingestionAdapter: stubAdapter,
    });

    const sc = result.metadata?.sourceCounts as Record<string, number>;
    expect(sc['ai-failed']).toBe(1);
    expect(sc['artificial-intelligence']).toBeUndefined();
    expect(result.text).toContain('![chart](media/image1.png)');
    expect(result.text).not.toContain('Image description (source:');
  });

  test('returns empty mediaFiles when pandoc does not produce any media', async () => {
    runPandocSpy = jest
      .spyOn(pandocModule, 'runPandoc')
      .mockResolvedValue({ stdout: 'Just some text.', stderr: '' });

    const result = await docxHandler({
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      filename: 'plain.docx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      outDir,
    });

    expect(result.text).toContain('Just some text.');
    expect(result.mediaFiles).toEqual([]);
    expect(result.metadata?.mediaCount).toBe(0);
    // We always pre-create the media dir (so we can walk it safely after);
    // but it should be empty and no image refs should leak into the text.
    expect(result.text).not.toContain('![');
    // No images → empty sourceCounts.
    expect(result.metadata?.sourceCounts).toEqual({});
    expect(result.metadata?.images).toEqual([]);
  });

  test('propagates pandoc failures so the orchestrator can mark the entry failed', async () => {
    runPandocSpy = jest
      .spyOn(pandocModule, 'runPandoc')
      .mockRejectedValue(new Error('pandoc failed: Couldn\'t parse docx'));

    await expect(
      docxHandler({
        buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        filename: 'broken.docx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        outDir,
      }),
    ).rejects.toThrow(/pandoc failed/);
  });
});

// ── PPTX ────────────────────────────────────────────────────────────────────

describe('pptxHandler', () => {
  test('extracts slide text, speaker notes, and embedded media', async () => {
    const buffer = readFixture('sample.pptx');
    const result = await pptxHandler({
      buffer,
      filename: 'sample.pptx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      outDir,
    });
    expect(result.handler).toBe('pptx');
    expect(result.text).toContain('## Slide 1');
    expect(result.text).toContain('## Slide 2');
    expect(result.text).toContain('Deck Title');
    expect(result.text).toContain('First slide bullet');
    expect(result.text).toContain('Second Slide');
    expect(result.text).toContain('### Speaker Notes');
    expect(result.text).toContain('Speaker notes for slide 1');
    expect(result.text).toContain('## Embedded Media');
    expect(result.mediaFiles).toHaveLength(1);
    expect(result.mediaFiles[0]).toMatch(/^media\//);
    expect(fs.existsSync(path.join(outDir, result.mediaFiles[0]))).toBe(true);
    expect(result.metadata?.slideCount).toBe(2);
    expect(result.metadata?.slidesToImagesRequested).toBe(false);
  });

  test('skips hidden slides and renumbers survivors to match rasterized PNGs', async () => {
    // Synthesize a minimal pptx in memory with 3 slides where slide 2 is
    // marked `show="0"` (hidden). The handler only looks at
    // `ppt/slides/slideN.xml` entries during text extraction, so a
    // partial pptx skeleton is enough — no need for content types,
    // presentation.xml, or rels.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    const slideXml = (body: string, hidden = false): string =>
      `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"${hidden ? ' show="0"' : ''}>
  <p:cSld><p:spTree>
    <p:sp><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;
    zip.addFile('ppt/slides/slide1.xml', Buffer.from(slideXml('Visible Alpha')));
    zip.addFile('ppt/slides/slide2.xml', Buffer.from(slideXml('Hidden Backup', true)));
    zip.addFile('ppt/slides/slide3.xml', Buffer.from(slideXml('Visible Beta')));
    const buffer: Buffer = zip.toBuffer();

    const result = await pptxHandler({
      buffer,
      filename: 'hidden-slides.pptx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      outDir,
    });

    // Only visible slides should appear, renumbered 1..2 (NOT 1, 3).
    expect(result.metadata?.slideCount).toBe(2);
    expect(result.metadata?.totalSlideCount).toBe(3);
    expect(result.metadata?.hiddenSlideCount).toBe(1);
    expect(result.text).toContain('## Slide 1');
    expect(result.text).toContain('Visible Alpha');
    expect(result.text).toContain('## Slide 2');
    expect(result.text).toContain('Visible Beta');
    expect(result.text).not.toContain('## Slide 3');
    expect(result.text).not.toContain('Hidden Backup');
    // Surface the skip in the markdown so downstream consumers notice.
    expect(result.text).toMatch(/1 of 3 slides.*hidden/);
  });

  test('records a warning when slide rasterization is requested but LibreOffice is missing', async () => {
    // Force the LibreOffice detection to report "not available" without
    // touching the filesystem by pointing PATH at an empty directory and
    // resetting the cached detection result. This keeps the test hermetic
    // on developer machines that happen to have `soffice` installed.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-soffice-'));
    const origPath = process.env.PATH;
    process.env.PATH = empty;
    const {
      _resetLibreOfficeCacheForTests,
    } = require('../src/services/knowledgeBase/libreOffice');
    _resetLibreOfficeCacheForTests();
    try {
      const buffer = readFixture('sample.pptx');
      const result = await pptxHandler({
        buffer,
        filename: 'sample.pptx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        outDir,
        convertSlidesToImages: true,
      });
      expect(result.metadata?.slidesToImagesRequested).toBe(true);
      expect(result.metadata?.slideImagesWarning).toMatch(/LibreOffice/i);
      expect(result.text).toMatch(/Slide rasterization note/);
    } finally {
      process.env.PATH = origPath;
      _resetLibreOfficeCacheForTests();
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ── Passthrough ─────────────────────────────────────────────────────────────

describe('passthroughHandler', () => {
  test('inlines markdown as-is', async () => {
    const buffer = Buffer.from('# Hello\n\nBody text.');
    const result = await passthroughHandler({
      buffer,
      filename: 'notes.md',
      mimeType: 'text/markdown',
      outDir,
    });
    expect(result.handler).toBe('passthrough/text');
    expect(result.text).toContain('# notes.md');
    expect(result.text).toContain('# Hello');
    expect(result.text).toContain('Body text.');
    expect(result.mediaFiles).toEqual([]);
  });

  test('wraps non-markdown text in a code fence', async () => {
    const buffer = Buffer.from('const x = 1;');
    const result = await passthroughHandler({
      buffer,
      filename: 'snippet.json',
      mimeType: 'application/json',
      outDir,
    });
    expect(result.text).toContain('```json\nconst x = 1;\n```');
  });

  test('preserves full content of large text files', async () => {
    const MAX = 200 * 1024;
    const big = Buffer.alloc(MAX + 500, 0x61); // 'a' repeated
    const result = await passthroughHandler({
      buffer: big,
      filename: 'huge.txt',
      mimeType: 'text/plain',
      outDir,
    });
    expect(result.text).not.toMatch(/Truncated/);
    expect(result.metadata?.byteLength).toBe(MAX + 500);
  });

  test('copies image files into media/ and embeds a reference', async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const result = await passthroughHandler({
      buffer: png,
      filename: 'pic.png',
      mimeType: 'image/png',
      outDir,
    });
    expect(result.handler).toBe('passthrough/image');
    expect(result.mediaFiles).toEqual(['media/pic.png']);
    expect(result.text).toContain('![pic.png](media/pic.png)');
    expect(fs.existsSync(path.join(outDir, 'media', 'pic.png'))).toBe(true);
  });

  test('passthroughSupports matches known extensions', () => {
    expect(passthroughSupports('a.txt')).toBe(true);
    expect(passthroughSupports('a.MD')).toBe(true);
    expect(passthroughSupports('a.png')).toBe(true);
    expect(passthroughSupports('a.pdf')).toBe(false);
    expect(passthroughSupports('a.docx')).toBe(false);
  });
});

// ── Dispatch ────────────────────────────────────────────────────────────────

describe('dispatch', () => {
  test('pickHandler returns the right handler by extension', () => {
    expect(pickHandler('a.pdf', '')).toBe(pdfHandler);
    expect(pickHandler('a.docx', '')).toBe(docxHandler);
    expect(pickHandler('a.pptx', '')).toBe(pptxHandler);
    expect(pickHandler('a.md', '')).toBe(passthroughHandler);
    expect(pickHandler('a.png', '')).toBe(passthroughHandler);
  });

  test('pickHandler falls back to MIME type when extension is unknown', () => {
    expect(pickHandler('paste', 'application/pdf')).toBe(pdfHandler);
    expect(pickHandler('paste', 'unknown/thing')).toBeNull();
  });

  test('ingestFile throws UnsupportedFileTypeError for unknown files', async () => {
    await expect(
      ingestFile({
        buffer: Buffer.from('x'),
        filename: 'thing.xyz',
        mimeType: 'application/octet-stream',
        outDir,
      }),
    ).rejects.toBeInstanceOf(UnsupportedFileTypeError);
  });

  test('ingestFile routes a pdf fixture through the pdf handler', async () => {
    const buffer = readFixture('sample.pdf');
    const result = await ingestFile({
      buffer,
      filename: 'sample.pdf',
      mimeType: 'application/pdf',
      outDir,
    });
    expect(result.handler).toBe('pdf/rasterized-hybrid');
    // Dispatcher returns a rasterized index — one page of the fixture turns
    // into exactly one PNG reference, with the source annotation block.
    expect(result.mediaFiles).toEqual(['pages/page-0001.png']);
    expect(result.text).toMatch(/!\[Page 1\]\(pages\/page-0001\.png\)/);
    expect(result.text).toMatch(/^> source: pdfjs/m);
  });
});
