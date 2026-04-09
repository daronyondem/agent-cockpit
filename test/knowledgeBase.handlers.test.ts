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

let outDir: string;

beforeEach(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-handler-'));
});

afterEach(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

// ── PDF ─────────────────────────────────────────────────────────────────────

describe('pdfHandler', () => {
  test('rasterizes each page to PNG and returns a thin markdown index', async () => {
    const buffer = readFixture('sample.pdf');
    const result = await pdfHandler({
      buffer,
      filename: 'sample.pdf',
      mimeType: 'application/pdf',
      outDir,
    });

    // Handler identity + title prefix.
    expect(result.handler).toBe('pdf/rasterized');
    expect(result.text).toContain('# sample.pdf');

    // One section per page. The 1-page fixture produces exactly one `## Page 1`.
    expect(result.text).toContain('## Page 1');
    // No extracted prose — the thin index is image-references-only.
    expect(result.text).not.toContain('Hello KB test PDF');

    // The page image reference uses the same relative path we expose
    // via `mediaFiles`, so a CLI following the link lands on the file.
    expect(result.text).toMatch(/!\[Page 1\]\(pages\/page-0001\.png\)/);
    expect(result.mediaFiles).toEqual(['pages/page-0001.png']);
    // The PNG actually exists on disk and is non-empty.
    const onDisk = fs.statSync(path.join(outDir, 'pages/page-0001.png'));
    expect(onDisk.size).toBeGreaterThan(0);
    // PNG magic bytes sanity check.
    const header = fs.readFileSync(path.join(outDir, 'pages/page-0001.png'), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any).subarray(0, 8);
    expect(header[0]).toBe(0x89);
    expect(header[1]).toBe(0x50);
    expect(header[2]).toBe(0x4e);
    expect(header[3]).toBe(0x47);

    // Metadata reflects the new shape (pageCount + renderedPageCount,
    // no word count because we don't extract text anymore).
    expect(result.metadata?.pageCount).toBe(1);
    expect(result.metadata?.renderedPageCount).toBe(1);
    expect(result.metadata?.rasterDpi).toBe(150);
    expect(result.metadata?.wordCount).toBeUndefined();
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

  test('flattens pandoc-extracted media and preserves table markdown', async () => {
    runPandocSpy = jest
      .spyOn(pandocModule, 'runPandoc')
      .mockImplementation(async (args) => {
        // Find the --extract-media flag and simulate what pandoc does:
        // writes a `media/` subdir under the target with the embedded
        // image, using its OOXML-relative path.
        const extractArg = (args as string[]).find((a) =>
          a.startsWith('--extract-media='),
        )!;
        const mediaRoot = extractArg.replace('--extract-media=', '');
        const nested = path.join(mediaRoot, 'media');
        fs.mkdirSync(nested, { recursive: true });
        fs.writeFileSync(path.join(nested, 'image1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return {
          stdout:
            'Hello from the DOCX fixture.\n\n' +
            'Second paragraph for word count.\n\n' +
            '| a | b |\n|---|---|\n| 1 | 2 |\n\n' +
            '![image](media/media/image1.png)\n',
          stderr: '',
        };
      });

    const result = await docxHandler({
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]), // any bytes — handler just writes to a temp file
      filename: 'sample.docx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      outDir,
    });

    // Handler identity + title prefix.
    expect(result.handler).toBe('docx/pandoc');
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
    expect(result.metadata?.truncated).toBe(false);
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

  test('truncates oversized text files with a marker', async () => {
    const MAX = 200 * 1024;
    const big = Buffer.alloc(MAX + 500, 0x61); // 'a' repeated
    const result = await passthroughHandler({
      buffer: big,
      filename: 'huge.txt',
      mimeType: 'text/plain',
      outDir,
    });
    expect(result.metadata?.truncated).toBe(true);
    expect(result.text).toMatch(/Truncated at/);
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
    expect(result.handler).toBe('pdf/rasterized');
    // Dispatcher returns a rasterized index, not prose — the one page
    // of our fixture turns into exactly one PNG reference.
    expect(result.mediaFiles).toEqual(['pages/page-0001.png']);
    expect(result.text).toMatch(/!\[Page 1\]\(pages\/page-0001\.png\)/);
  });
});
