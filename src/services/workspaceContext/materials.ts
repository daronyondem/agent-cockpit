import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

export interface WorkspaceContextTextFile {
  path: string;
  name: string;
  size: number;
  updatedAt: string;
}

export interface WorkspaceContextAssetFile extends WorkspaceContextTextFile {
  mimeType: string;
  previewable: boolean;
  kind: 'image' | 'text' | 'binary';
}

export interface ResolvedWorkspaceContextFile {
  absPath: string;
  relPath: string;
  root: string;
  stat: fs.Stats;
  mimeType: string;
  language: string;
  kind: 'image' | 'text' | 'binary';
  previewable: boolean;
}

export class WorkspaceContextMaterialError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'WorkspaceContextMaterialError';
    this.status = status;
  }
}

export const WORKSPACE_CONTEXT_REFERENCE_EDIT_LIMIT_BYTES = 5 * 1024 * 1024;
export const WORKSPACE_CONTEXT_ASSET_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

const CONTEXT_MARKDOWN_EXTENSIONS = new Set(['.md']);
const REFERENCE_TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

const TEXT_ASSET_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.yaml', '.yml']);
const IMAGE_ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const BINARY_ASSET_EXTENSIONS = new Set(['.pdf']);
const ASSET_EXTENSIONS = new Set([
  ...Array.from(TEXT_ASSET_EXTENSIONS),
  ...Array.from(IMAGE_ASSET_EXTENSIONS),
  ...Array.from(BINARY_ASSET_EXTENSIONS),
]);

const MIME_BY_EXT: Record<string, string> = {
  '.bmp': 'image/bmp',
  '.csv': 'text/csv; charset=utf-8',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
};

export function listContextMarkdownFiles(root: string): Promise<WorkspaceContextTextFile[]> {
  return listTextFiles(root, CONTEXT_MARKDOWN_EXTENSIONS);
}

export function listReferenceFiles(root: string): Promise<WorkspaceContextTextFile[]> {
  return listTextFiles(root, REFERENCE_TEXT_EXTENSIONS);
}

export async function listAssetFiles(root: string): Promise<WorkspaceContextAssetFile[]> {
  const files: WorkspaceContextAssetFile[] = [];
  await walkFiles(root, root, ASSET_EXTENSIONS, async (abs, rel, stat) => {
    files.push(assetFileFromStat(rel, stat));
  });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readContextMarkdownFile(root: string, relPath: string): Promise<{ path: string; content: string } | null> {
  return readTextFile(root, relPath, CONTEXT_MARKDOWN_EXTENSIONS);
}

export async function readReferenceFile(root: string, relPath: string): Promise<{ path: string; content: string } | null> {
  return readTextFile(root, relPath, REFERENCE_TEXT_EXTENSIONS);
}

export async function writeReferenceFile(root: string, relPath: string, content: string): Promise<WorkspaceContextTextFile> {
  if (typeof content !== 'string') {
    throw new WorkspaceContextMaterialError(400, 'content must be a string');
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > WORKSPACE_CONTEXT_REFERENCE_EDIT_LIMIT_BYTES) {
    throw new WorkspaceContextMaterialError(413, 'Reference file is too large');
  }
  const target = await resolveWritablePath(root, relPath, REFERENCE_TEXT_EXTENSIONS);
  await rejectExistingSymlink(target.absPath);
  await fsp.writeFile(target.absPath, content, 'utf8');
  const stat = await fsp.stat(target.absPath);
  return textFileFromStat(target.relPath, stat);
}

export async function deleteReferenceFile(root: string, relPath: string): Promise<boolean> {
  return deleteFile(root, relPath, REFERENCE_TEXT_EXTENSIONS);
}

export async function writeAssetFile(root: string, relPath: string, content: Buffer): Promise<WorkspaceContextAssetFile> {
  if (!Buffer.isBuffer(content)) {
    throw new WorkspaceContextMaterialError(400, 'Asset content must be bytes');
  }
  if (content.length > WORKSPACE_CONTEXT_ASSET_UPLOAD_LIMIT_BYTES) {
    throw new WorkspaceContextMaterialError(413, 'Asset file is too large');
  }
  const target = await resolveWritablePath(root, relPath, ASSET_EXTENSIONS);
  await rejectExistingSymlink(target.absPath);
  await fsp.writeFile(target.absPath, content);
  const stat = await fsp.stat(target.absPath);
  return assetFileFromStat(target.relPath, stat);
}

export async function deleteAssetFile(root: string, relPath: string): Promise<boolean> {
  return deleteFile(root, relPath, ASSET_EXTENSIONS);
}

export async function resolveContextMarkdownFile(root: string, relPath: string): Promise<ResolvedWorkspaceContextFile | null> {
  return resolveExistingFile(root, relPath, CONTEXT_MARKDOWN_EXTENSIONS);
}

export async function resolveReferenceFile(root: string, relPath: string): Promise<ResolvedWorkspaceContextFile | null> {
  return resolveExistingFile(root, relPath, REFERENCE_TEXT_EXTENSIONS);
}

export async function resolveAssetFile(root: string, relPath: string): Promise<ResolvedWorkspaceContextFile | null> {
  return resolveExistingFile(root, relPath, ASSET_EXTENSIONS);
}

export function normalizeContextMarkdownPath(value: string): string | null {
  return normalizeRelativePath(value, CONTEXT_MARKDOWN_EXTENSIONS);
}

export function normalizeReferencePath(value: string): string | null {
  return normalizeRelativePath(value, REFERENCE_TEXT_EXTENSIONS);
}

export function normalizeAssetPath(value: string): string | null {
  return normalizeRelativePath(value, ASSET_EXTENSIONS);
}

export function workspaceContextMimeType(filename: string): string {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

export function workspaceContextLanguage(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.txt') return 'text';
  return ext.replace('.', '') || 'text';
}

export function workspaceContextAssetKind(filename: string): 'image' | 'text' | 'binary' {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_ASSET_EXTENSIONS.has(ext)) return 'image';
  if (TEXT_ASSET_EXTENSIONS.has(ext)) return 'text';
  return 'binary';
}

export function workspaceContextAssetPreviewable(filename: string): boolean {
  const kind = workspaceContextAssetKind(filename);
  return kind === 'image' || kind === 'text';
}

async function listTextFiles(root: string, extensions: Set<string>): Promise<WorkspaceContextTextFile[]> {
  const files: WorkspaceContextTextFile[] = [];
  await walkFiles(root, root, extensions, async (_abs, rel, stat) => {
    files.push(textFileFromStat(rel, stat));
  });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function walkFiles(
  root: string,
  current: string,
  extensions: Set<string>,
  visit: (abs: string, rel: string, stat: fs.Stats) => Promise<void>,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(current, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(root, abs, extensions, visit);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (!normalizeRelativePath(rel, extensions)) continue;
    const stat = await fsp.stat(abs);
    await visit(abs, rel, stat);
  }
}

async function readTextFile(root: string, relPath: string, extensions: Set<string>): Promise<{ path: string; content: string } | null> {
  const file = await resolveExistingFile(root, relPath, extensions);
  if (!file) return null;
  return { path: file.relPath, content: await fsp.readFile(file.absPath, 'utf8') };
}

async function resolveExistingFile(
  root: string,
  relPath: string,
  extensions: Set<string>,
): Promise<ResolvedWorkspaceContextFile | null> {
  const safeRel = normalizeRelativePath(relPath, extensions);
  if (!safeRel) return null;
  const rootAbs = path.resolve(root);
  const candidate = path.resolve(rootAbs, safeRel);
  if (!insideRoot(candidate, rootAbs)) return null;

  let realRoot: string;
  let realFile: string;
  let stat: fs.Stats;
  try {
    realRoot = await fsp.realpath(rootAbs);
    realFile = await fsp.realpath(candidate);
    if (!insideRoot(realFile, realRoot)) {
      throw new WorkspaceContextMaterialError(403, 'Access denied: path is outside Workspace Context');
    }
    stat = await fsp.stat(realFile);
  } catch (err: unknown) {
    if (err instanceof WorkspaceContextMaterialError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (!stat.isFile()) return null;
  return {
    absPath: realFile,
    relPath: safeRel,
    root: realRoot,
    stat,
    mimeType: workspaceContextMimeType(safeRel),
    language: workspaceContextLanguage(safeRel),
    kind: workspaceContextAssetKind(safeRel),
    previewable: workspaceContextAssetPreviewable(safeRel),
  };
}

async function resolveWritablePath(
  root: string,
  relPath: string,
  extensions: Set<string>,
): Promise<{ absPath: string; relPath: string }> {
  const safeRel = normalizeRelativePath(relPath, extensions);
  if (!safeRel) {
    throw new WorkspaceContextMaterialError(400, 'Invalid path');
  }
  const rootAbs = path.resolve(root);
  await fsp.mkdir(rootAbs, { recursive: true });
  const absPath = path.resolve(rootAbs, safeRel);
  if (!insideRoot(absPath, rootAbs)) {
    throw new WorkspaceContextMaterialError(403, 'Access denied: path is outside Workspace Context');
  }
  const parent = path.dirname(absPath);
  await fsp.mkdir(parent, { recursive: true });
  const realRoot = await fsp.realpath(rootAbs);
  const realParent = await fsp.realpath(parent);
  if (!insideRoot(realParent, realRoot)) {
    throw new WorkspaceContextMaterialError(403, 'Access denied: path is outside Workspace Context');
  }
  return { absPath, relPath: safeRel };
}

async function deleteFile(root: string, relPath: string, extensions: Set<string>): Promise<boolean> {
  const safeRel = normalizeRelativePath(relPath, extensions);
  if (!safeRel) throw new WorkspaceContextMaterialError(400, 'Invalid path');
  const rootAbs = path.resolve(root);
  const absPath = path.resolve(rootAbs, safeRel);
  if (!insideRoot(absPath, rootAbs)) {
    throw new WorkspaceContextMaterialError(403, 'Access denied: path is outside Workspace Context');
  }
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = await fsp.realpath(rootAbs);
    realFile = await fsp.realpath(absPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (!insideRoot(realFile, realRoot)) {
    throw new WorkspaceContextMaterialError(403, 'Access denied: path is outside Workspace Context');
  }
  const stat = await fsp.lstat(absPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new WorkspaceContextMaterialError(400, 'Path is not a file');
  }
  await fsp.rm(absPath, { force: true });
  return true;
}

async function rejectExistingSymlink(absPath: string): Promise<void> {
  try {
    const stat = await fsp.lstat(absPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new WorkspaceContextMaterialError(400, 'Path is not a regular file');
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

function textFileFromStat(rel: string, stat: fs.Stats): WorkspaceContextTextFile {
  return {
    path: rel,
    name: path.basename(rel),
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
}

function assetFileFromStat(rel: string, stat: fs.Stats): WorkspaceContextAssetFile {
  const kind = workspaceContextAssetKind(rel);
  return {
    ...textFileFromStat(rel, stat),
    mimeType: workspaceContextMimeType(rel),
    previewable: kind === 'image' || kind === 'text',
    kind,
  };
}

function normalizeRelativePath(value: string, extensions: Set<string>): string | null {
  const rel = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!rel) return null;
  const parts = rel.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.') || /[\u0000-\u001f]/.test(part))) {
    return null;
  }
  const ext = path.extname(parts[parts.length - 1]).toLowerCase();
  if (!extensions.has(ext)) return null;
  return parts.join('/');
}

function insideRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}
