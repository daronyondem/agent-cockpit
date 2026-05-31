import {
  DngPreviewExtractionError,
  extractDngPreviewJpeg,
} from '../src/services/chat/dngPreview';
import { makeDngWithJpegPreview, makeJpeg } from './helpers/dngFixture';

describe('DNG preview extraction', () => {
  test('extracts a little-endian embedded JPEG preview', () => {
    const jpeg = makeJpeg(8, 6);
    const dng = makeDngWithJpegPreview(jpeg, 8, 6, { endian: 'II' });

    const preview = extractDngPreviewJpeg(dng);

    expect(preview.width).toBe(8);
    expect(preview.height).toBe(6);
    expect(preview.buffer.equals(jpeg)).toBe(true);
  });

  test('extracts a big-endian embedded JPEG preview', () => {
    const jpeg = makeJpeg(10, 4);
    const dng = makeDngWithJpegPreview(jpeg, 10, 4, { endian: 'MM' });

    const preview = extractDngPreviewJpeg(dng);

    expect(preview.width).toBe(10);
    expect(preview.height).toBe(4);
    expect(preview.buffer.equals(jpeg)).toBe(true);
  });

  test('stops at JPEG EOI when the declared byte count includes trailing bytes', () => {
    const jpeg = makeJpeg(7, 5);
    const dng = makeDngWithJpegPreview(jpeg, 7, 5, {
      declaredByteCount: jpeg.length + 12,
      appendBytes: Buffer.from('trailingdata'),
    });

    const preview = extractDngPreviewJpeg(dng);

    expect(preview.buffer.equals(jpeg)).toBe(true);
  });

  test('rejects non-TIFF bytes', () => {
    expect(() => extractDngPreviewJpeg(Buffer.from('not a dng'))).toThrow(DngPreviewExtractionError);
  });

  test('rejects DNG files with no readable JPEG preview', () => {
    const jpeg = makeJpeg(6, 4);
    const dng = makeDngWithJpegPreview(jpeg, 6, 4, { compression: 1 });

    expect(() => extractDngPreviewJpeg(dng)).toThrow('DNG upload does not contain a readable embedded JPEG preview.');
  });

  test('skips linear raw subimages', () => {
    const jpeg = makeJpeg(6, 4);
    const dng = makeDngWithJpegPreview(jpeg, 6, 4, { photometric: 34892 });

    expect(() => extractDngPreviewJpeg(dng)).toThrow('DNG upload does not contain a readable embedded JPEG preview.');
  });
});
