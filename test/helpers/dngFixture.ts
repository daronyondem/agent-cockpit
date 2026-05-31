import * as napiCanvas from '@napi-rs/canvas';

type Endian = 'II' | 'MM';

interface DngFixtureOptions {
  endian?: Endian;
  compression?: number;
  photometric?: number;
  declaredByteCount?: number;
  appendBytes?: Buffer;
}

interface TiffTag {
  tag: number;
  type: number;
  count: number;
  value: number | number[];
}

export function makeJpeg(width: number, height: number): Buffer {
  const canvas = napiCanvas.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2458a6';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#f7d046';
  ctx.fillRect(Math.floor(width / 4), Math.floor(height / 4), Math.max(1, Math.floor(width / 2)), Math.max(1, Math.floor(height / 2)));
  return canvas.toBuffer('image/jpeg', 92);
}

export function makeDngWithJpegPreview(jpeg: Buffer, width: number, height: number, opts: DngFixtureOptions = {}): Buffer {
  const endian = opts.endian || 'II';
  const little = endian === 'II';
  const tags: TiffTag[] = [
    { tag: 254, type: 4, count: 1, value: 1 },
    { tag: 256, type: 4, count: 1, value: width },
    { tag: 257, type: 4, count: 1, value: height },
    { tag: 258, type: 3, count: 3, value: [8, 8, 8] },
    { tag: 259, type: 3, count: 1, value: opts.compression ?? 7 },
    { tag: 262, type: 3, count: 1, value: opts.photometric ?? 6 },
    { tag: 273, type: 4, count: 1, value: 0 },
    { tag: 277, type: 3, count: 1, value: 3 },
    { tag: 278, type: 4, count: 1, value: height },
    { tag: 279, type: 4, count: 1, value: opts.declaredByteCount ?? jpeg.length },
    { tag: 50706, type: 1, count: 4, value: [1, 4, 0, 0] },
  ].sort((a, b) => a.tag - b.tag);

  const ifdOffset = 8;
  const ifdSize = 2 + tags.length * 12 + 4;
  const tagValueBuffers = new Map<number, Buffer>();
  let dataOffset = ifdOffset + ifdSize;

  for (const tag of tags) {
    const valueBuffer = valueToBuffer(tag, little);
    if (valueBuffer.length > 4) {
      tagValueBuffers.set(tag.tag, valueBuffer);
      dataOffset += valueBuffer.length;
    }
  }

  const jpegOffset = dataOffset;
  const totalLength = jpegOffset + jpeg.length + (opts.appendBytes?.length || 0);
  const out = Buffer.alloc(totalLength);
  out.write(endian, 0, 'ascii');
  writeUInt16(out, 2, 42, little);
  writeUInt32(out, 4, ifdOffset, little);
  writeUInt16(out, ifdOffset, tags.length, little);

  let entryOffset = ifdOffset + 2;
  let externalOffset = ifdOffset + ifdSize;
  for (const tag of tags) {
    writeUInt16(out, entryOffset, tag.tag, little);
    writeUInt16(out, entryOffset + 2, tag.type, little);
    writeUInt32(out, entryOffset + 4, tag.count, little);
    if (tag.tag === 273) {
      writeUInt32(out, entryOffset + 8, jpegOffset, little);
    } else {
      const valueBuffer = tagValueBuffers.get(tag.tag) || valueToBuffer(tag, little);
      if (valueBuffer.length <= 4) {
        valueBuffer.copy(out, entryOffset + 8);
      } else {
        writeUInt32(out, entryOffset + 8, externalOffset, little);
        valueBuffer.copy(out, externalOffset);
        externalOffset += valueBuffer.length;
      }
    }
    entryOffset += 12;
  }

  writeUInt32(out, ifdOffset + 2 + tags.length * 12, 0, little);
  jpeg.copy(out, jpegOffset);
  opts.appendBytes?.copy(out, jpegOffset + jpeg.length);
  return out;
}

function valueToBuffer(tag: TiffTag, little: boolean): Buffer {
  const values = Array.isArray(tag.value) ? tag.value : [tag.value];
  if (tag.type === 4) {
    const longBuffer = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => writeUInt32(longBuffer, index * 4, value, little));
    return longBuffer;
  }

  const typeSize = tag.type === 3 ? 2 : 1;
  const buffer = Buffer.alloc(values.length * typeSize);
  values.forEach((value, index) => {
    if (tag.type === 3) writeUInt16(buffer, index * typeSize, value, little);
    else buffer.writeUInt8(value, index * typeSize);
  });
  return buffer;
}

function writeUInt16(buffer: Buffer, offset: number, value: number, little: boolean): void {
  if (little) buffer.writeUInt16LE(value, offset);
  else buffer.writeUInt16BE(value, offset);
}

function writeUInt32(buffer: Buffer, offset: number, value: number, little: boolean): void {
  if (little) buffer.writeUInt32LE(value, offset);
  else buffer.writeUInt32BE(value, offset);
}
