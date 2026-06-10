import fs from 'fs';
import path from 'path';
import type { StreamEvent } from '../../types';
import type { CodexThreadItem } from './codexEvents';
import { codexConfigDir, type CodexCliRuntime } from './codexRuntime';

function imageMimeTypeFromBytes(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function imageMimeTypeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.avif') return 'image/avif';
  return 'image/png';
}

function splitImageDataUrl(value: string): { dataBase64: string; mimeType?: string } | null {
  const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is);
  if (!match) return null;
  return { dataBase64: match[2], mimeType: match[1].toLowerCase() };
}

function imageBase64Candidate(value: string): { dataBase64: string; mimeType?: string } | null {
  const dataUrl = splitImageDataUrl(value);
  if (dataUrl) return dataUrl;
  const compact = value.replace(/\s+/g, '');
  if (compact.length < 64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  try {
    const sample = Buffer.from(compact.slice(0, 128), 'base64');
    const mimeType = imageMimeTypeFromBytes(sample);
    return mimeType ? { dataBase64: compact, mimeType } : null;
  } catch {
    return null;
  }
}

function findImageBase64(value: unknown, depth = 0): { dataBase64: string; mimeType?: string } | null {
  if (depth > 4 || value == null) return null;
  if (typeof value === 'string') return imageBase64Candidate(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageBase64(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const priority = ['result', 'image', 'data', 'dataBase64', 'base64', 'b64_json', 'content', 'output'];
  for (const key of priority) {
    if (key in obj) {
      const found = findImageBase64(obj[key], depth + 1);
      if (found) return found;
    }
  }
  for (const [key, child] of Object.entries(obj)) {
    if (priority.includes(key)) continue;
    const found = findImageBase64(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function findExistingImagePath(value: unknown, depth = 0): string | null {
  if (depth > 4 || value == null) return null;
  if (typeof value === 'string') {
    if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(value) && fs.existsSync(value)) return value;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findExistingImagePath(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findExistingImagePath(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export function findCodexGeneratedImagePath(itemId: string, threadId: string | null, runtime?: CodexCliRuntime): string | null {
  const root = path.join(codexConfigDir(runtime), 'generated_images');
  const candidates: string[] = [];
  if (threadId) candidates.push(path.join(root, threadId, `${itemId}.png`));
  candidates.push(path.join(root, `${itemId}.png`));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, `${itemId}.png`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // No generated_images directory for this runtime/profile yet.
  }
  return null;
}

export function codexImageArtifactEvent(
  item: CodexThreadItem,
  threadId: string | null,
  runtime?: CodexCliRuntime,
): Extract<StreamEvent, { type: 'artifact' }> | null {
  if (item.type !== 'imageGeneration') return null;
  const foundBase64 = findImageBase64(item);
  if (foundBase64) {
    return {
      type: 'artifact',
      dataBase64: foundBase64.dataBase64,
      filename: `${item.id}.png`,
      mimeType: foundBase64.mimeType || 'image/png',
      title: 'Generated image',
      sourceToolId: item.id,
    };
  }
  const sourcePath = findExistingImagePath(item) || findCodexGeneratedImagePath(item.id, threadId, runtime);
  if (!sourcePath) return null;
  return {
    type: 'artifact',
    sourcePath,
    filename: path.basename(sourcePath),
    mimeType: imageMimeTypeFromPath(sourcePath),
    title: 'Generated image',
    sourceToolId: item.id,
  };
}
