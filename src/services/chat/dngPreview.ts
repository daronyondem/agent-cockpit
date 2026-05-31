import { promises as fsp } from 'fs';

const TIFF_MAGIC = 42;
const MAX_IFDS_TO_SCAN = 32;
const MAX_TAG_VALUES = 64;

const TAG_BITS_PER_SAMPLE = 258;
const TAG_COMPRESSION = 259;
const TAG_PHOTOMETRIC_INTERPRETATION = 262;
const TAG_STRIP_OFFSETS = 273;
const TAG_SAMPLES_PER_PIXEL = 277;
const TAG_STRIP_BYTE_COUNTS = 279;
const TAG_SUB_IFDS = 330;

const COMPRESSION_JPEG = 7;
const PHOTOMETRIC_LINEAR_RAW = 34892;

const TYPE_SIZES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
  9: 4, // SLONG
  10: 8, // SRATIONAL
};

interface TiffEntry {
  tag: number;
  type: number;
  count: number;
  valueFieldOffset: number;
}

interface IfdData {
  entries: Map<number, TiffEntry>;
  nextIfdOffset: number;
}

interface PreviewCandidate {
  buffer: Buffer;
  width: number;
  height: number;
}

export interface DngPreviewJpeg {
  buffer: Buffer;
  width: number;
  height: number;
}

export class DngPreviewExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DngPreviewExtractionError';
  }
}

class TiffReader {
  readonly littleEndian: boolean;

  constructor(readonly buffer: Buffer) {
    const endian = buffer.subarray(0, 2).toString('ascii');
    if (endian !== 'II' && endian !== 'MM') {
      throw new DngPreviewExtractionError('DNG upload is not a TIFF/DNG file.');
    }
    this.littleEndian = endian === 'II';
    if (buffer.length < 8 || this.uint16(2) !== TIFF_MAGIC) {
      throw new DngPreviewExtractionError('DNG upload is not a supported TIFF/DNG file.');
    }
  }

  uint8(offset: number): number {
    this.assertRange(offset, 1);
    return this.buffer.readUInt8(offset);
  }

  uint16(offset: number): number {
    this.assertRange(offset, 2);
    return this.littleEndian ? this.buffer.readUInt16LE(offset) : this.buffer.readUInt16BE(offset);
  }

  uint32(offset: number): number {
    this.assertRange(offset, 4);
    return this.littleEndian ? this.buffer.readUInt32LE(offset) : this.buffer.readUInt32BE(offset);
  }

  firstIfdOffset(): number {
    return this.uint32(4);
  }

  readIfd(offset: number): IfdData {
    this.assertRange(offset, 2);
    const count = this.uint16(offset);
    if (count > 4096) {
      throw new DngPreviewExtractionError('DNG upload has an invalid TIFF directory.');
    }
    const tableStart = offset + 2;
    const tableBytes = count * 12;
    this.assertRange(tableStart, tableBytes + 4);

    const entries = new Map<number, TiffEntry>();
    for (let i = 0; i < count; i += 1) {
      const entryOffset = tableStart + i * 12;
      const tag = this.uint16(entryOffset);
      entries.set(tag, {
        tag,
        type: this.uint16(entryOffset + 2),
        count: this.uint32(entryOffset + 4),
        valueFieldOffset: entryOffset + 8,
      });
    }

    return {
      entries,
      nextIfdOffset: this.uint32(tableStart + tableBytes),
    };
  }

  readUnsignedValues(entry: TiffEntry | undefined, maxValues = MAX_TAG_VALUES): number[] {
    if (!entry || entry.count < 1 || entry.count > maxValues) return [];
    const typeSize = TYPE_SIZES[entry.type];
    if (!typeSize || ![1, 3, 4].includes(entry.type)) return [];
    const totalBytes = typeSize * entry.count;
    const dataOffset = totalBytes <= 4 ? entry.valueFieldOffset : this.uint32(entry.valueFieldOffset);
    this.assertRange(dataOffset, totalBytes);

    const values: number[] = [];
    for (let i = 0; i < entry.count; i += 1) {
      const offset = dataOffset + i * typeSize;
      if (entry.type === 1) values.push(this.uint8(offset));
      if (entry.type === 3) values.push(this.uint16(offset));
      if (entry.type === 4) values.push(this.uint32(offset));
    }
    return values;
  }

  private assertRange(offset: number, length: number): void {
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > this.buffer.length) {
      throw new DngPreviewExtractionError('DNG upload has invalid TIFF offsets.');
    }
  }
}

export async function extractDngPreviewJpegFromFile(filePath: string): Promise<DngPreviewJpeg> {
  return extractDngPreviewJpeg(await fsp.readFile(filePath));
}

export function extractDngPreviewJpeg(buffer: Buffer): DngPreviewJpeg {
  const reader = new TiffReader(buffer);
  const candidates: PreviewCandidate[] = [];
  const queue = [reader.firstIfdOffset()];
  const visited = new Set<number>();

  while (queue.length && visited.size < MAX_IFDS_TO_SCAN) {
    const offset = queue.shift() || 0;
    if (!offset || visited.has(offset)) continue;
    visited.add(offset);

    let ifd: IfdData;
    try {
      ifd = reader.readIfd(offset);
      const candidate = previewCandidateFromIfd(reader, ifd.entries);
      if (candidate) candidates.push(candidate);
    } catch (err: unknown) {
      if (candidates.length) continue;
      throw err;
    }

    const subIfds = reader.readUnsignedValues(ifd.entries.get(TAG_SUB_IFDS));
    for (const subIfd of subIfds) queue.push(subIfd);
    if (ifd.nextIfdOffset) queue.push(ifd.nextIfdOffset);
  }

  const best = candidates.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
  if (!best) {
    throw new DngPreviewExtractionError('DNG upload does not contain a readable embedded JPEG preview.');
  }
  return best;
}

function previewCandidateFromIfd(reader: TiffReader, entries: Map<number, TiffEntry>): PreviewCandidate | null {
  const compression = first(reader.readUnsignedValues(entries.get(TAG_COMPRESSION)));
  if (compression !== undefined && compression !== COMPRESSION_JPEG) return null;

  const photometric = first(reader.readUnsignedValues(entries.get(TAG_PHOTOMETRIC_INTERPRETATION)));
  if (photometric === PHOTOMETRIC_LINEAR_RAW) return null;

  const bitsPerSample = reader.readUnsignedValues(entries.get(TAG_BITS_PER_SAMPLE));
  if (bitsPerSample.length && bitsPerSample.some(value => value > 8)) return null;

  const samplesPerPixel = first(reader.readUnsignedValues(entries.get(TAG_SAMPLES_PER_PIXEL)));
  if (samplesPerPixel !== undefined && (samplesPerPixel < 1 || samplesPerPixel > 4)) return null;

  const offsets = reader.readUnsignedValues(entries.get(TAG_STRIP_OFFSETS));
  const byteCounts = reader.readUnsignedValues(entries.get(TAG_STRIP_BYTE_COUNTS));
  if (offsets.length !== 1 || byteCounts.length !== 1 || byteCounts[0] < 4) return null;

  const start = offsets[0];
  const declaredEnd = Math.min(reader.buffer.length, start + byteCounts[0]);
  if (start < 0 || declaredEnd <= start + 4) return null;
  if (reader.buffer[start] !== 0xff || reader.buffer[start + 1] !== 0xd8) return null;

  const dimensions = parseJpegDimensions(reader.buffer, start, declaredEnd);
  if (!dimensions) return null;

  const eoi = findJpegEoi(reader.buffer, start, declaredEnd);
  const end = eoi || declaredEnd;
  return {
    buffer: reader.buffer.subarray(start, end),
    width: dimensions.width,
    height: dimensions.height,
  };
}

function parseJpegDimensions(buffer: Buffer, start: number, end: number): { width: number; height: number } | null {
  let offset = start + 2;
  while (offset + 4 < end) {
    while (buffer[offset] === 0xff && offset < end) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > end) return null;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > end) return null;
    if (isStartOfFrame(marker)) {
      if (segmentLength < 7) return null;
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function findJpegEoi(buffer: Buffer, start: number, end: number): number | null {
  for (let i = start + 2; i + 1 < end; i += 1) {
    if (buffer[i] === 0xff && buffer[i + 1] === 0xd9) return i + 2;
  }
  return null;
}

function isStartOfFrame(marker: number): boolean {
  return (
    marker === 0xc0 ||
    marker === 0xc1 ||
    marker === 0xc2 ||
    marker === 0xc3 ||
    marker === 0xc5 ||
    marker === 0xc6 ||
    marker === 0xc7 ||
    marker === 0xc9 ||
    marker === 0xca ||
    marker === 0xcb ||
    marker === 0xcd ||
    marker === 0xce ||
    marker === 0xcf
  );
}

function first(values: number[]): number | undefined {
  return values.length ? values[0] : undefined;
}
