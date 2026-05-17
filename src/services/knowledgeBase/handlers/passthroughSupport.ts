import path from 'path';

export const TEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.rst',
  '.log',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.html',
  '.htm',
]);

export const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
]);

/** True iff the extension belongs to a format the passthrough handler supports. */
export function passthroughSupports(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return TEXT_EXTS.has(ext) || IMAGE_EXTS.has(ext);
}
