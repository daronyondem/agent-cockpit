import path from 'path';
import type { AttachmentKind, AttachmentMeta } from '../../types';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']);
const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.swift',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.hh',
  '.cs', '.fs', '.php', '.pl', '.lua', '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.html', '.css', '.scss', '.less', '.vue', '.svelte',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.ini', '.env',
]);
const TEXT_EXTS = new Set(['.txt', '.log', '.csv', '.tsv', '.rtf']);

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.cjs': 'application/javascript',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.jsx': 'application/javascript',
  '.py': 'text/x-python',
  '.sh': 'application/x-sh',
};

export function attachmentKindFromPath(p: string): AttachmentKind {
  const ext = path.extname(p).toLowerCase();
  if (!ext) return 'file';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.md' || ext === '.markdown') return 'md';
  if (CODE_EXTS.has(ext)) return 'code';
  if (TEXT_EXTS.has(ext)) return 'text';
  return 'file';
}

export function formatAttachmentSize(bytes: number | undefined): string | undefined {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function mimeTypeFromPath(p: string): string {
  return MIME_BY_EXT[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

export function extensionForMimeType(mimeType: string | undefined): string {
  const normalized = (mimeType || '').split(';')[0].trim().toLowerCase();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/svg+xml') return '.svg';
  if (normalized === 'image/bmp') return '.bmp';
  if (normalized === 'image/avif') return '.avif';
  if (normalized === 'application/pdf') return '.pdf';
  if (normalized === 'text/markdown') return '.md';
  if (normalized === 'text/plain') return '.txt';
  if (normalized === 'application/json') return '.json';
  return '';
}

export function sanitizeArtifactFilename(name: string): string {
  const safe = (name || '').replace(/[\/\\]/g, '_').replace(/[\u0000-\u001f]/g, '').trim();
  if (!safe || safe === '.' || safe === '..') {
    return `artifact-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  }
  return safe;
}

export function splitDataUrlBase64(value: string, fallbackMimeType?: string): { dataBase64: string; mimeType?: string } {
  const match = value.match(/^data:([^;,]+)?;base64,(.*)$/s);
  if (!match) return { dataBase64: value, mimeType: fallbackMimeType };
  return {
    dataBase64: match[2],
    mimeType: match[1] || fallbackMimeType,
  };
}

export function attachmentFromPath(abs: string, size?: number): AttachmentMeta {
  const name = path.basename(abs);
  const kind = attachmentKindFromPath(abs);
  return {
    name,
    path: abs,
    ...(size !== undefined ? { size } : {}),
    kind,
    meta: formatAttachmentSize(size),
  };
}
