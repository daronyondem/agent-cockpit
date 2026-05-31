import { promises as fsp } from 'fs';
import path from 'path';
import * as napiCanvas from '@napi-rs/canvas';
import { DngPreviewExtractionError, extractDngPreviewJpegFromFile } from './dngPreview';

export const CHAT_UPLOAD_IMAGE_MAX_LONG_EDGE_PX = 2576;
const JPEG_QUALITY = 92;
const DNG_PREVIEW_SUFFIX = '.preview.jpg';

export function isDngUploadPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.dng';
}

export function dngPreviewPathFor(filePath: string): string {
  return `${filePath}${DNG_PREVIEW_SUFFIX}`;
}

export function originalDngPathForPreview(previewPath: string): string | null {
  const lower = previewPath.toLowerCase();
  const suffix = `.dng${DNG_PREVIEW_SUFFIX}`;
  if (!lower.endsWith(suffix)) return null;
  return previewPath.slice(0, -DNG_PREVIEW_SUFFIX.length);
}

export async function normalizeUploadedChatImage(filePath: string): Promise<string> {
  if (!isDngUploadPath(filePath)) return filePath;
  return writeDngPreviewJpeg(filePath);
}

async function writeDngPreviewJpeg(filePath: string): Promise<string> {
  const preview = await extractDngPreviewJpegFromFile(filePath);
  const outputPath = dngPreviewPathFor(filePath);
  const outputBuffer = await previewBufferForHarness(preview.buffer, preview.width, preview.height);
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, outputBuffer);
  return outputPath;
}

async function previewBufferForHarness(buffer: Buffer, width: number, height: number): Promise<Buffer> {
  const longEdge = Math.max(width, height);
  if (longEdge <= CHAT_UPLOAD_IMAGE_MAX_LONG_EDGE_PX) return buffer;

  let img: Awaited<ReturnType<typeof napiCanvas.loadImage>>;
  try {
    img = await napiCanvas.loadImage(buffer);
  } catch {
    throw new DngPreviewExtractionError('DNG upload contains an embedded JPEG preview, but it could not be decoded.');
  }

  const scale = CHAT_UPLOAD_IMAGE_MAX_LONG_EDGE_PX / longEdge;
  const newWidth = Math.max(1, Math.round(width * scale));
  const newHeight = Math.max(1, Math.round(height * scale));
  const canvas = napiCanvas.createCanvas(newWidth, newHeight);
  canvas.getContext('2d').drawImage(img, 0, 0, newWidth, newHeight);
  return canvas.toBuffer('image/jpeg', JPEG_QUALITY);
}
