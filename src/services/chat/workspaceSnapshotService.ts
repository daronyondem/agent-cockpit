import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import * as yazl from 'yazl';
import * as yauzl from 'yauzl';
import { atomicWriteFile } from '../../utils/atomicWrite';
import type {
  WorkspaceOriginalCleanupMode,
  WorkspaceSnapshotEstimateResponse,
  WorkspaceSnapshotInclusionPolicy,
  WorkspaceSnapshotMetadata,
} from '../../contracts/workspaces';

const SNAPSHOT_SCHEMA_VERSION = 1;
const ZIP_MANIFEST_PATH = '.agent-cockpit-workspace-snapshot.json';
const COMMON_EXCLUDED_SEGMENTS = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  '.turbo',
  '.cache',
  '.pytest_cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'coverage',
]);

type SnapshotEntryType = 'file' | 'directory' | 'symlink';

interface SnapshotManifestEntry {
  path: string;
  type: SnapshotEntryType;
  sizeBytes?: number;
  sha256?: string;
  mode?: number;
  mtimeMs?: number;
  linkTarget?: string;
}

interface SnapshotManifest {
  schemaVersion: 1;
  workspaceId: string;
  originalPath: string;
  createdAt: string;
  inclusionPolicy: WorkspaceSnapshotInclusionPolicy;
  entries: SnapshotManifestEntry[];
  archive: {
    path: string;
    sha256: string;
    sizeBytes: number;
  };
}

interface SnapshotPlan {
  entries: SnapshotManifestEntry[];
  fileCount: number;
  directoryCount: number;
  symlinkCount: number;
  excludedCount: number;
  sizeBytes: number;
}

export class WorkspaceSnapshotError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'WorkspaceSnapshotError';
    this.code = code;
    this.status = status;
  }
}

export class WorkspaceSnapshotService {
  constructor(private readonly opts: {
    snapshotsDir: string;
    trashDir: string;
    restoredDir: string;
  }) {}

  async estimate(
    workspaceId: string,
    workspacePath: string,
    inclusionPolicy: WorkspaceSnapshotInclusionPolicy,
  ): Promise<WorkspaceSnapshotEstimateResponse> {
    await this.assertWorkspacePath(workspacePath);
    const plan = await this.planSnapshot(workspacePath, inclusionPolicy);
    return {
      workspaceId,
      workspacePath,
      inclusionPolicy,
      fileCount: plan.fileCount,
      directoryCount: plan.directoryCount,
      symlinkCount: plan.symlinkCount,
      excludedCount: plan.excludedCount,
      sizeBytes: plan.sizeBytes,
    };
  }

  async createSnapshot(
    workspaceId: string,
    workspacePath: string,
    inclusionPolicy: WorkspaceSnapshotInclusionPolicy,
  ): Promise<WorkspaceSnapshotMetadata> {
    await this.assertWorkspacePath(workspacePath);
    const createdAt = new Date().toISOString();
    const snapshotId = `snapshot-${createdAt.replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
    const snapshotDir = path.join(this.opts.snapshotsDir, workspaceId);
    await fsp.mkdir(snapshotDir, { recursive: true });
    const archivePath = path.join(snapshotDir, `${snapshotId}.zip`);
    const manifestPath = path.join(snapshotDir, `${snapshotId}.manifest.json`);
    const plan = await this.planSnapshot(workspacePath, inclusionPolicy);
    const manifestBase: Omit<SnapshotManifest, 'archive'> = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      workspaceId,
      originalPath: workspacePath,
      createdAt,
      inclusionPolicy,
      entries: plan.entries,
    };

    await this.writeZip(workspacePath, archivePath, manifestBase, plan.entries);
    const archiveChecksum = await hashFile(archivePath);
    const archiveStat = await fsp.stat(archivePath);
    const manifest: SnapshotManifest = {
      ...manifestBase,
      archive: {
        path: archivePath,
        sha256: archiveChecksum,
        sizeBytes: archiveStat.size,
      },
    };
    await atomicWriteFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    return {
      id: snapshotId,
      status: 'verified',
      archivePath,
      manifestPath,
      sizeBytes: archiveStat.size,
      fileCount: plan.fileCount,
      checksum: archiveChecksum,
      inclusionPolicy,
      createdAt,
      verifiedAt: new Date().toISOString(),
    };
  }

  defaultRestoreDestination(workspaceId: string, originalPath: string): string {
    const basename = path.basename(originalPath) || workspaceId;
    return path.join(this.opts.restoredDir, `${basename}-${workspaceId}`);
  }

  async restoreSnapshot(snapshot: WorkspaceSnapshotMetadata, destinationPath: string): Promise<string> {
    if (snapshot.status !== 'verified' || !snapshot.archivePath || !snapshot.manifestPath || !snapshot.checksum) {
      throw new WorkspaceSnapshotError('snapshot_unavailable', 'Workspace snapshot is not verified', 409);
    }
    const manifest = await this.readManifest(snapshot.manifestPath);
    const actualChecksum = await hashFile(snapshot.archivePath);
    if (actualChecksum !== manifest.archive.sha256 || actualChecksum !== snapshot.checksum) {
      throw new WorkspaceSnapshotError('snapshot_checksum_mismatch', 'Workspace snapshot checksum verification failed', 409);
    }

    const restoreRoot = path.resolve(destinationPath);
    await ensureEmptyDirectory(restoreRoot);
    const stagingRoot = path.join(
      path.dirname(restoreRoot),
      `.${path.basename(restoreRoot)}.restore-${Date.now().toString(36)}-${crypto.randomUUID()}`,
    );
    try {
      await fsp.mkdir(stagingRoot, { recursive: true });
      await this.extractZip(snapshot.archivePath, manifest, stagingRoot);
      await this.restoreSymlinks(manifest, stagingRoot);
      await this.verifyRestoredFiles(manifest, stagingRoot);
      await fsp.rm(restoreRoot, { recursive: true, force: true });
      await fsp.rename(stagingRoot, restoreRoot);
    } catch (err: unknown) {
      await fsp.rm(stagingRoot, { recursive: true, force: true });
      throw err;
    }
    return restoreRoot;
  }

  async cleanupOriginal(workspaceId: string, workspacePath: string, mode: WorkspaceOriginalCleanupMode): Promise<{ movedTo?: string }> {
    if (mode === 'keep') return {};
    await this.assertWorkspacePath(workspacePath);
    this.assertCleanupSafe(workspacePath);
    if (mode === 'delete_permanently') {
      await fsp.rm(workspacePath, { recursive: true });
      return {};
    }
    const basename = path.basename(workspacePath) || workspaceId;
    const destination = path.join(this.opts.trashDir, `${workspaceId}-${new Date().toISOString().replace(/[:.]/g, '-')}-${basename}`);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await moveDirectory(workspacePath, destination);
    return { movedTo: destination };
  }

  async deleteRetainedArtifacts(workspaceId: string, movedOriginalPath?: string): Promise<void> {
    await fsp.rm(path.join(this.opts.snapshotsDir, workspaceId), { recursive: true, force: true });
    if (movedOriginalPath) {
      const resolvedMovedPath = path.resolve(movedOriginalPath);
      if (isUnderRoot(this.opts.trashDir, resolvedMovedPath)) {
        await fsp.rm(resolvedMovedPath, { recursive: true, force: true });
      }
    }
    let trashEntries: string[];
    try {
      trashEntries = await fsp.readdir(this.opts.trashDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    await Promise.all(
      trashEntries
        .filter((entry) => entry.startsWith(`${workspaceId}-`))
        .map((entry) => fsp.rm(path.join(this.opts.trashDir, entry), { recursive: true, force: true })),
    );
  }

  async deleteSnapshot(snapshot: WorkspaceSnapshotMetadata): Promise<void> {
    await Promise.all([
      snapshot.archivePath ? fsp.rm(snapshot.archivePath, { force: true }) : Promise.resolve(),
      snapshot.manifestPath ? fsp.rm(snapshot.manifestPath, { force: true }) : Promise.resolve(),
    ]);
  }

  private async assertWorkspacePath(workspacePath: string): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(workspacePath);
    } catch {
      throw new WorkspaceSnapshotError('workspace_path_unavailable', 'Workspace folder is unavailable', 409);
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceSnapshotError('workspace_path_not_directory', 'Workspace path must be a directory', 400);
    }
  }

  private assertCleanupSafe(workspacePath: string): void {
    const source = path.resolve(workspacePath);
    const protectedDirs = [
      this.opts.snapshotsDir,
      this.opts.trashDir,
      this.opts.restoredDir,
    ].map((dir) => path.resolve(dir));
    if (protectedDirs.some((dir) => isUnderRoot(source, dir) || isUnderRoot(dir, source))) {
      throw new WorkspaceSnapshotError(
        'cleanup_would_remove_archive_storage',
        'Refusing to clean up a workspace folder that overlaps Agent Cockpit archive storage',
        409,
      );
    }
  }

  private async planSnapshot(
    workspacePath: string,
    inclusionPolicy: WorkspaceSnapshotInclusionPolicy,
  ): Promise<SnapshotPlan> {
    const root = path.resolve(workspacePath);
    const entries: SnapshotManifestEntry[] = [];
    let fileCount = 0;
    let directoryCount = 0;
    let symlinkCount = 0;
    let excludedCount = 0;
    let sizeBytes = 0;

    const visit = async (current: string, relParts: string[]): Promise<void> => {
      const children = await fsp.readdir(current, { withFileTypes: true });
      for (const child of children) {
        const nextRelParts = [...relParts, child.name];
        const relPath = toZipPath(nextRelParts);
        if (shouldExclude(nextRelParts, inclusionPolicy)) {
          excludedCount += 1;
          continue;
        }
        const fullPath = path.join(root, ...nextRelParts);
        const stat = await fsp.lstat(fullPath);
        if (stat.isDirectory()) {
          directoryCount += 1;
          entries.push({
            path: relPath,
            type: 'directory',
            mode: stat.mode & 0o777,
            mtimeMs: stat.mtimeMs,
          });
          await visit(fullPath, nextRelParts);
          continue;
        }
        if (stat.isSymbolicLink()) {
          symlinkCount += 1;
          entries.push({
            path: relPath,
            type: 'symlink',
            linkTarget: await fsp.readlink(fullPath),
            mode: stat.mode & 0o777,
            mtimeMs: stat.mtimeMs,
          });
          continue;
        }
        if (!stat.isFile()) continue;
        fileCount += 1;
        sizeBytes += stat.size;
        entries.push({
          path: relPath,
          type: 'file',
          sizeBytes: stat.size,
          sha256: await hashFile(fullPath),
          mode: stat.mode & 0o777,
          mtimeMs: stat.mtimeMs,
        });
      }
    };

    await visit(root, []);
    return { entries, fileCount, directoryCount, symlinkCount, excludedCount, sizeBytes };
  }

  private async writeZip(
    workspacePath: string,
    archivePath: string,
    manifest: Omit<SnapshotManifest, 'archive'>,
    entries: SnapshotManifestEntry[],
  ): Promise<void> {
    const zip = new yazl.ZipFile();
    const root = path.resolve(workspacePath);
    for (const entry of entries) {
      if (entry.type === 'directory') {
        zip.addEmptyDirectory(entry.path, {
          mode: entry.mode,
          mtime: new Date(entry.mtimeMs || Date.now()),
        });
      } else if (entry.type === 'file') {
        zip.addFile(path.join(root, ...entry.path.split('/')), entry.path, {
          mode: entry.mode,
          mtime: new Date(entry.mtimeMs || Date.now()),
        });
      }
    }
    zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'), ZIP_MANIFEST_PATH);
    zip.end();
    await pipeline(zip.outputStream, fs.createWriteStream(archivePath));
  }

  private async readManifest(manifestPath: string): Promise<SnapshotManifest> {
    const parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as SnapshotManifest;
    if (parsed.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
      throw new WorkspaceSnapshotError('snapshot_manifest_invalid', 'Workspace snapshot manifest is invalid', 409);
    }
    return parsed;
  }

  private async extractZip(archivePath: string, manifest: SnapshotManifest, restoreRoot: string): Promise<void> {
    const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    const zip = await openZip(archivePath);
    await new Promise<void>((resolve, reject) => {
      zip.readEntry();
      zip.on('entry', (entry) => {
        void (async () => {
          try {
            const entryName = normalizeZipEntryName(entry.fileName);
            if (entryName === ZIP_MANIFEST_PATH) {
              zip.readEntry();
              return;
            }
            const manifestEntry = expected.get(entryName);
            if (!manifestEntry) throw new WorkspaceSnapshotError('snapshot_unexpected_entry', `Unexpected snapshot entry: ${entry.fileName}`, 409);
            const targetPath = safeJoin(restoreRoot, manifestEntry.path);
            if (manifestEntry.type === 'directory') {
              await fsp.mkdir(targetPath, { recursive: true });
              zip.readEntry();
              return;
            }
            if (manifestEntry.type === 'symlink') {
              zip.readEntry();
              return;
            }
            await fsp.mkdir(path.dirname(targetPath), { recursive: true });
            const readStream = await openZipReadStream(zip, entry);
            await pipeline(readStream, fs.createWriteStream(targetPath, { mode: manifestEntry.mode }));
            zip.readEntry();
          } catch (err) {
            reject(err);
          }
        })();
      });
      zip.once('end', () => resolve());
      zip.once('error', reject);
    });
  }

  private async restoreSymlinks(manifest: SnapshotManifest, restoreRoot: string): Promise<void> {
    for (const entry of manifest.entries) {
      if (entry.type !== 'symlink' || !entry.linkTarget) continue;
      if (path.isAbsolute(entry.linkTarget)) continue;
      const linkPath = safeJoin(restoreRoot, entry.path);
      const resolvedTarget = path.resolve(path.dirname(linkPath), entry.linkTarget);
      if (!isUnderRoot(restoreRoot, resolvedTarget)) continue;
      await fsp.mkdir(path.dirname(linkPath), { recursive: true });
      await fsp.symlink(entry.linkTarget, linkPath);
    }
  }

  private async verifyRestoredFiles(manifest: SnapshotManifest, restoreRoot: string): Promise<void> {
    for (const entry of manifest.entries) {
      if (entry.type !== 'file' || !entry.sha256) continue;
      const actual = await hashFile(safeJoin(restoreRoot, entry.path));
      if (actual !== entry.sha256) {
        throw new WorkspaceSnapshotError('snapshot_restore_checksum_mismatch', `Restored file failed checksum verification: ${entry.path}`, 409);
      }
    }
  }
}

function toZipPath(parts: string[]): string {
  return parts.join('/');
}

function shouldExclude(parts: string[], policy: WorkspaceSnapshotInclusionPolicy): boolean {
  if (policy !== 'exclude_common') return false;
  return parts.some((part) => COMMON_EXCLUDED_SEGMENTS.has(part));
}

function normalizeZipEntryName(name: string): string {
  if (!name || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name)) {
    throw new WorkspaceSnapshotError('snapshot_unsafe_entry', 'Workspace snapshot contains an unsafe path', 409);
  }
  const normalized = path.posix.normalize(name);
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new WorkspaceSnapshotError('snapshot_unsafe_entry', 'Workspace snapshot contains an unsafe path', 409);
  }
  return normalized.replace(/\/$/, '');
}

function safeJoin(root: string, relPath: string): string {
  const normalized = normalizeZipEntryName(relPath);
  const target = path.resolve(root, ...normalized.split('/'));
  if (!isUnderRoot(root, target)) {
    throw new WorkspaceSnapshotError('snapshot_unsafe_entry', 'Workspace snapshot contains an unsafe path', 409);
  }
  return target;
}

function isUnderRoot(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  return target === resolvedRoot || target.startsWith(resolvedRoot + path.sep);
}

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function ensureEmptyDirectory(dir: string): Promise<void> {
  try {
    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) {
      throw new WorkspaceSnapshotError('restore_destination_not_directory', 'Restore destination must be a directory', 400);
    }
    const entries = await fsp.readdir(dir);
    if (entries.length > 0) {
      throw new WorkspaceSnapshotError('restore_destination_not_empty', 'Restore destination must be empty', 409);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await fsp.mkdir(dir, { recursive: true });
  }
}

async function moveDirectory(source: string, destination: string): Promise<void> {
  try {
    await fsp.rename(source, destination);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fsp.cp(source, destination, { recursive: true, errorOnExist: true });
    await fsp.rm(source, { recursive: true });
  }
}

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) reject(err || new Error('Unable to open workspace snapshot'));
      else resolve(zip);
    });
  });
}

function openZipReadStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) reject(err || new Error('Unable to read workspace snapshot entry'));
      else resolve(stream);
    });
  });
}
