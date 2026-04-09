/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Format handler tests ───────────────────────────────────────────────────
// Each handler is tested against a real fixture in `test/fixtures/kb/`:
//   - sample.pdf    (592 B)   — tiny single-page PDF with one text line
//   - sample.docx   (1.1 KB) — two paragraphs + one embedded PNG
//   - sample.pptx   (1.9 KB) — two slides with speaker notes on slide 1
// Plus ad-hoc text/image buffers for the passthrough handler. The fixtures
// total <4 KB so they're cheap to ship in the repo.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { pdfHandler } from '../src/services/knowledgeBase/handlers/pdf';
import { docxHandler } from '../src/services/knowledgeBase/handlers/docx';
import { pptxHandler } from '../src/services/knowledgeBase/handlers/pptx';
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
  test('extracts per-page text with H2 headers', async () => {
    const buffer = readFixture('sample.pdf');
    const result = await pdfHandler({
      buffer,
      filename: 'sample.pdf',
      mimeType: 'application/pdf',
      outDir,
    });
    expect(result.handler).toBe('pdf');
    expect(result.text).toContain('# sample.pdf');
    expect(result.text).toContain('## Page 1');
    expect(result.text).toContain('Hello KB test PDF');
    expect(result.mediaFiles).toEqual([]);
    expect(result.metadata?.pageCount).toBe(1);
    expect(typeof result.metadata?.wordCount).toBe('number');
  });
});

// ── DOCX ────────────────────────────────────────────────────────────────────

describe('docxHandler', () => {
  test('extracts text and copies embedded media', async () => {
    const buffer = readFixture('sample.docx');
    const result = await docxHandler({
      buffer,
      filename: 'sample.docx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      outDir,
    });
    expect(result.handler).toBe('docx');
    expect(result.text).toContain('Hello from the DOCX fixture.');
    expect(result.text).toContain('Second paragraph for word count.');
    expect(result.text).toContain('## Embedded Media');
    expect(result.mediaFiles).toHaveLength(1);
    expect(result.mediaFiles[0]).toMatch(/^media\//);
    // The referenced file must actually exist on disk under outDir.
    expect(fs.existsSync(path.join(outDir, result.mediaFiles[0]))).toBe(true);
    expect(result.metadata?.wordCount).toBeGreaterThan(0);
    expect(result.metadata?.mediaCount).toBe(1);
  });

  test('handles DOCX with no media', async () => {
    // Build a DOCX on the fly with mammoth-friendly minimal XML but no
    // `word/media/` directory, to exercise the "no media" branch without
    // adding a second fixture.
    const AdmZip = require('adm-zip');
    const z = new AdmZip();
    z.addFile(
      '[Content_Types].xml',
      Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>',
      ),
    );
    z.addFile(
      '_rels/.rels',
      Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '</Relationships>',
      ),
    );
    z.addFile(
      'word/document.xml',
      Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:body><w:p><w:r><w:t>Text only.</w:t></w:r></w:p></w:body>' +
          '</w:document>',
      ),
    );
    const buffer = z.toBuffer();
    const result = await docxHandler({
      buffer,
      filename: 'plain.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      outDir,
    });
    expect(result.text).toContain('Text only.');
    expect(result.text).not.toContain('## Embedded Media');
    expect(result.mediaFiles).toEqual([]);
    expect(result.metadata?.mediaCount).toBe(0);
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
    expect(result.handler).toBe('pdf');
    expect(result.text).toContain('Hello KB test PDF');
  });
});
