import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';
import Database from 'better-sqlite3';
import {
  DATA_EXPORT_SCHEMA_VERSION,
  type DataExportJobStatusResponse,
  type DataExportFileRecord,
  type DataExportManifest,
  type DataExportWorkspaceRecord,
} from '../contracts/dataMigration';
import type { CliProfile, Settings } from '../types';
import { checkOllamaHealth, type EmbeddingConfig } from './knowledgeBase/embeddings';
import { detectLibreOffice } from './knowledgeBase/libreOffice';
import { detectPandoc } from './knowledgeBase/pandoc';
import { logger } from '../utils/logger';

const log = logger.child({ module: 'data-migration' });

const CONTROL_DIR_SUFFIX = '.migration';
const PENDING_IMPORT_FILE = 'pending-import.json';
const LAST_IMPORT_FILE = 'last-import.json';
const MANIFEST_PATH = 'manifest.json';
const DATA_PREFIX = 'data/';
const UPLOAD_EXTENSION = '.acexport';
const MAX_IMPORT_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_BUNDLE_UNCOMPRESSED_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;

interface DataMigrationServiceOptions {
  dataRoot: string;
  appVersion: string;
  authDataDir?: string | null;
  now?: () => Date;
}

interface PendingImportRecord {
  schemaVersion: 1;
  importId: string;
  uploadId: string;
  createdAt: string;
  stagingDataDir: string;
  backupPath: string;
  manifest: DataExportManifest;
}

export interface DataImportScheduleResult {
  importId: string;
  backupPath: string;
  pendingPath: string;
  manifest: DataExportManifest;
}

export interface DataExportBundleResult {
  filePath: string;
  filename: string;
  manifest: DataExportManifest;
}

export interface DataMigrationCheckResult {
  checkedAt: string;
  dataRoot: string;
  summary: {
    status: 'ok' | 'warning' | 'error';
    errors: number;
    warnings: number;
  };
  workspaces: Array<{
    workspaceId: string;
    storageKey: string;
    currentPath: string | null;
    storage: CheckStatus;
    workspacePath: CheckStatus;
    memory: CheckStatus;
    knowledge: CheckStatus & {
      stateDb?: CheckStatus;
      vectors?: CheckStatus;
      embedding?: CheckStatus;
    };
    workspaceContext: CheckStatus;
  }>;
  tools: {
    pandoc: CheckStatus;
    libreOffice: CheckStatus;
    cliProfiles: CheckStatus[];
  };
}

interface CheckStatus {
  status: 'ok' | 'warning' | 'error' | 'skipped';
  message: string;
  path?: string;
}

interface CollectedFile {
  absolutePath: string;
  relativePath: string;
  zipPath: string;
  bytes: number;
  sha256: string;
}

type ExportProgress = {
  phase: string;
  progress: number;
};

interface ExportJobRecord extends DataExportJobStatusResponse {
  filePath?: string;
}

export class DataMigrationService {
  private readonly dataRoot: string;
  private readonly appVersion: string;
  private readonly authDataDir: string | null;
  private readonly now: () => Date;
  private readonly exportJobs = new Map<string, ExportJobRecord>();
  readonly controlDir: string;

  constructor(options: DataMigrationServiceOptions) {
    this.dataRoot = path.resolve(options.dataRoot);
    this.appVersion = options.appVersion;
    this.authDataDir = options.authDataDir ? path.resolve(options.authDataDir) : null;
    this.now = options.now || (() => new Date());
    this.controlDir = controlDirForDataRoot(this.dataRoot);
  }

  static controlDirForDataRoot(dataRoot: string): string {
    return controlDirForDataRoot(dataRoot);
  }

  static applyPendingImport(dataRoot: string): { applied: boolean; backupPath?: string; error?: string } {
    const resolvedDataRoot = path.resolve(dataRoot);
    const controlDir = controlDirForDataRoot(resolvedDataRoot);
    const pendingPath = path.join(controlDir, PENDING_IMPORT_FILE);
    if (!fs.existsSync(pendingPath)) return { applied: false };

    let pending: PendingImportRecord | undefined;
    try {
      pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as PendingImportRecord;
      validatePendingImportRecord(pending, controlDir);

      const stagedRoot = path.resolve(pending.stagingDataDir);
      if (!fs.existsSync(stagedRoot) || !fs.statSync(stagedRoot).isDirectory()) {
        throw new Error(`Staged import data directory not found: ${stagedRoot}`);
      }

      const backupPath = path.resolve(pending.backupPath);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.mkdirSync(path.dirname(resolvedDataRoot), { recursive: true });

      let movedCurrent = false;
      if (fs.existsSync(resolvedDataRoot)) {
        if (fs.existsSync(backupPath)) {
          throw new Error(`Backup path already exists: ${backupPath}`);
        }
        fs.renameSync(resolvedDataRoot, backupPath);
        movedCurrent = true;
      }

      try {
        fs.renameSync(stagedRoot, resolvedDataRoot);
      } catch (err) {
        if (movedCurrent && !fs.existsSync(resolvedDataRoot) && fs.existsSync(backupPath)) {
          fs.renameSync(backupPath, resolvedDataRoot);
        }
        throw err;
      }

      const appliedRecord = {
        importId: pending.importId,
        uploadId: pending.uploadId,
        appliedAt: new Date().toISOString(),
        backupPath,
        manifest: pending.manifest,
      };
      try {
        fs.writeFileSync(path.join(controlDir, LAST_IMPORT_FILE), JSON.stringify(appliedRecord, null, 2) + '\n');
      } catch (err) {
        log.warn('Applied data import but could not write import metadata', { importId: pending.importId, error: (err as Error).message });
      }
      try {
        fs.rmSync(pendingPath, { force: true });
      } catch (err) {
        log.warn('Applied data import but could not remove pending import marker', { importId: pending.importId, error: (err as Error).message });
      }
      try {
        fs.rmSync(path.dirname(stagedRoot), { recursive: true, force: true });
      } catch (err) {
        log.warn('Applied data import but could not clean staging directory', { importId: pending.importId, error: (err as Error).message });
      }
      try {
        removeUploadFilesSync(controlDir, pending.uploadId);
      } catch (err) {
        log.warn('Applied data import but could not remove uploaded bundle', { importId: pending.importId, error: (err as Error).message });
      }
      log.info('Applied pending data import', { importId: pending.importId, backupPath });
      return { applied: true, backupPath };
    } catch (err: unknown) {
      const message = (err as Error).message || String(err);
      log.error('Pending data import failed', { error: message });
      try {
        fs.writeFileSync(
          path.join(controlDir, 'failed-import.json'),
          JSON.stringify({ failedAt: new Date().toISOString(), error: message, pending: pending || null }, null, 2) + '\n',
        );
        fs.renameSync(pendingPath, path.join(controlDir, `failed-${Date.now()}-${PENDING_IMPORT_FILE}`));
      } catch {
        try {
          fs.rmSync(pendingPath, { force: true });
        } catch {
          // best effort only
        }
      }
      return { applied: false, error: message };
    }
  }

  getStatus() {
    return {
      dataRoot: this.dataRoot,
      controlDir: this.controlDir,
      pendingImport: fs.existsSync(path.join(this.controlDir, PENDING_IMPORT_FILE)),
      lastImport: readJsonIfExists(path.join(this.controlDir, LAST_IMPORT_FILE)),
    };
  }

  startExportJob(): DataExportJobStatusResponse {
    this.cleanupOldExportJobs();
    const active = Array.from(this.exportJobs.values()).find(job => job.status === 'running');
    if (active) throw new Error('A data export is already running.');
    const now = this.now().toISOString();
    const job: ExportJobRecord = {
      jobId: this.newId('export'),
      status: 'running',
      phase: 'Starting export',
      progress: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.exportJobs.set(job.jobId, job);
    void this.runExportJob(job);
    return publicExportJob(job);
  }

  getExportJob(jobId: string): DataExportJobStatusResponse {
    const job = this.exportJobs.get(safeId(jobId));
    if (!job) throw new Error('Export job not found.');
    return publicExportJob(job);
  }

  getExportJobDownload(jobId: string): { filePath: string; filename: string } {
    const job = this.exportJobs.get(safeId(jobId));
    if (!job) throw new Error('Export job not found.');
    if (job.status !== 'ready' || !job.filePath || !job.filename) {
      throw new Error('Export job is not ready for download.');
    }
    return { filePath: job.filePath, filename: job.filename };
  }

  deleteExportJob(jobId: string): void {
    const safe = safeId(jobId);
    const job = this.exportJobs.get(safe);
    if (job?.filePath) fs.rm(job.filePath, { force: true }, () => {});
    this.exportJobs.delete(safe);
  }

  async createExportBundle(options: { onProgress?: (progress: ExportProgress) => void } = {}): Promise<DataExportBundleResult> {
    await fsp.mkdir(this.exportDir(), { recursive: true });
    options.onProgress?.({ phase: 'Scanning data root', progress: 8 });
    const files = await this.collectExportFiles();
    options.onProgress?.({ phase: 'Building manifest', progress: 30 });
    const manifest = await this.buildManifest(files);
    const filename = `agent-cockpit-export-${timestampForFile(this.now())}${UPLOAD_EXTENSION}`;
    const filePath = path.join(this.exportDir(), filename);
    options.onProgress?.({ phase: 'Packaging export bundle', progress: 45 });
    await writeExportZip(filePath, manifest, files);
    options.onProgress?.({ phase: 'Verifying export bundle', progress: 90 });
    return { filePath, filename, manifest };
  }

  async saveImportUpload(sourcePath: string, originalName = 'agent-cockpit-import.acexport'): Promise<string> {
    await fsp.mkdir(this.uploadDir(), { recursive: true });
    const uploadId = this.newId('upload');
    const ext = path.extname(originalName).toLowerCase() || UPLOAD_EXTENSION;
    const filePath = this.uploadPath(uploadId, ext === '.zip' ? '.zip' : UPLOAD_EXTENSION);
    const stat = await fsp.stat(sourcePath);
    if (stat.size > MAX_IMPORT_UPLOAD_BYTES) {
      throw new Error('Import bundle is too large.');
    }
    await fsp.rename(sourcePath, filePath);
    return uploadId;
  }

  async previewImportUpload(uploadId: string): Promise<{ uploadId: string; manifest: DataExportManifest; warnings: string[] }> {
    const filePath = this.resolveUploadPath(uploadId);
    const { manifest } = await this.openAndValidateBundle(filePath);
    return {
      uploadId,
      manifest,
      warnings: importWarnings(manifest),
    };
  }

  async deleteUpload(uploadId: string): Promise<void> {
    const safe = safeId(uploadId);
    await Promise.all([
      fsp.rm(path.join(this.uploadDir(), `${safe}${UPLOAD_EXTENSION}`), { force: true }),
      fsp.rm(path.join(this.uploadDir(), `${safe}.zip`), { force: true }),
    ]);
  }

  async cancelPendingImport(importId?: string): Promise<boolean> {
    const pendingPath = path.join(this.controlDir, PENDING_IMPORT_FILE);
    const pending = readJsonIfExists(pendingPath) as PendingImportRecord | null;
    if (!pending) return false;
    if (importId && pending.importId !== importId) return false;
    await fsp.rm(pendingPath, { force: true });
    const stagingDir = pending.stagingDataDir ? path.dirname(pending.stagingDataDir) : null;
    if (stagingDir && isPathInside(stagingDir, this.controlDir)) {
      await fsp.rm(stagingDir, { recursive: true, force: true });
    }
    return true;
  }

  async scheduleImport(uploadId: string): Promise<DataImportScheduleResult> {
    const filePath = this.resolveUploadPath(uploadId);
    const { manifest } = await this.openAndValidateBundle(filePath);
    const importId = this.newId('import');
    const stagingRoot = path.join(this.stagingDir(), importId);
    const stagingDataDir = path.join(stagingRoot, 'data');
    const backupPath = path.join(this.backupDir(), `data-backup-${timestampForFile(this.now())}-${importId.slice(-6)}`);
    const pendingPath = path.join(this.controlDir, PENDING_IMPORT_FILE);

    if (fs.existsSync(pendingPath)) {
      throw new Error('A data import is already pending. Restart or clear the pending import before scheduling another.');
    }

    try {
      await fsp.rm(stagingRoot, { recursive: true, force: true });
      await fsp.mkdir(stagingRoot, { recursive: true });
      await this.extractBundleData(filePath, stagingRoot, manifest);
      removeKnownRuntimeFiles(stagingDataDir);

      if (!fs.existsSync(stagingDataDir) || !fs.statSync(stagingDataDir).isDirectory()) {
        throw new Error('Import bundle did not contain a data directory.');
      }
      await verifyStagedData(manifest, stagingDataDir);
    } catch (err) {
      await fsp.rm(stagingRoot, { recursive: true, force: true });
      throw err;
    }

    const pending: PendingImportRecord = {
      schemaVersion: 1,
      importId,
      uploadId,
      createdAt: this.now().toISOString(),
      stagingDataDir,
      backupPath,
      manifest,
    };
    await fsp.mkdir(this.controlDir, { recursive: true });
    await fsp.writeFile(pendingPath, JSON.stringify(pending, null, 2) + '\n');
    return { importId, backupPath, pendingPath, manifest };
  }

  async runPostImportChecks(options: { deep?: boolean } = {}): Promise<DataMigrationCheckResult> {
    const workspaces = await this.checkWorkspaces(options);
    const [pandoc, libreOffice] = await Promise.all([
      detectPandoc().then(status => status.available
        ? ok('Pandoc is available', status.binaryPath || undefined)
        : warn('Pandoc is not available; DOCX ingestion will fail until installed.')),
      detectLibreOffice().then(status => status.available
        ? ok('LibreOffice is available', status.binaryPath || undefined)
        : warn('LibreOffice is not available; PPTX slide rasterization will be skipped.')),
    ]);
    const cliProfiles = await this.checkCliProfiles();
    const statuses: CheckStatus[] = [
      pandoc,
      libreOffice,
      ...cliProfiles,
      ...workspaces.flatMap(workspace => [
        workspace.storage,
        workspace.workspacePath,
        workspace.memory,
        workspace.knowledge,
        workspace.knowledge.stateDb || skipped('No KB SQLite database to check'),
        workspace.knowledge.vectors || skipped('No vector store to check'),
        workspace.knowledge.embedding || skipped('No embedding config to check'),
        workspace.workspaceContext,
      ]),
    ];
    const errors = statuses.filter(item => item.status === 'error').length;
    const warnings = statuses.filter(item => item.status === 'warning').length;
    return {
      checkedAt: this.now().toISOString(),
      dataRoot: this.dataRoot,
      summary: {
        status: errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'ok',
        errors,
        warnings,
      },
      workspaces,
      tools: { pandoc, libreOffice, cliProfiles },
    };
  }

  uploadDir(): string {
    return path.join(this.controlDir, 'uploads');
  }

  private exportDir(): string {
    return path.join(this.controlDir, 'exports');
  }

  private stagingDir(): string {
    return path.join(this.controlDir, 'staging');
  }

  private backupDir(): string {
    return path.join(this.controlDir, 'backups');
  }

  private uploadPath(uploadId: string, ext = UPLOAD_EXTENSION): string {
    return path.join(this.uploadDir(), `${safeId(uploadId)}${ext}`);
  }

  private resolveUploadPath(uploadId: string): string {
    const safe = safeId(uploadId);
    const candidates = [
      path.join(this.uploadDir(), `${safe}${UPLOAD_EXTENSION}`),
      path.join(this.uploadDir(), `${safe}.zip`),
    ];
    const found = candidates.find(candidate => fs.existsSync(candidate));
    if (!found) throw new Error('Import upload not found. Upload the export bundle again.');
    return found;
  }

  private newId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
  }

  private async runExportJob(job: ExportJobRecord): Promise<void> {
    try {
      const bundle = await this.createExportBundle({
        onProgress: progress => {
          job.phase = progress.phase;
          job.progress = Math.max(1, Math.min(99, Math.round(progress.progress)));
          job.updatedAt = this.now().toISOString();
        },
      });
      job.status = 'ready';
      job.phase = 'Ready to download';
      job.progress = 100;
      job.updatedAt = this.now().toISOString();
      job.filePath = bundle.filePath;
      job.filename = bundle.filename;
      job.manifest = bundle.manifest;
    } catch (err: unknown) {
      job.status = 'failed';
      job.phase = 'Export failed';
      job.progress = 100;
      job.updatedAt = this.now().toISOString();
      job.error = (err as Error).message || String(err);
      log.error('Data export job failed', { jobId: job.jobId, error: job.error });
    }
  }

  private cleanupOldExportJobs(): void {
    const cutoff = this.now().getTime() - 60 * 60 * 1000;
    for (const [jobId, job] of this.exportJobs.entries()) {
      const updatedAt = Date.parse(job.updatedAt);
      if (Number.isFinite(updatedAt) && updatedAt >= cutoff) continue;
      if (job.filePath) fs.rm(job.filePath, { force: true }, () => {});
      this.exportJobs.delete(jobId);
    }
  }

  private async collectExportFiles(): Promise<CollectedFile[]> {
    const files: CollectedFile[] = [];
    const excluded = new Set<string>();
    if (!fs.existsSync(this.dataRoot)) return files;

    const walk = async (dir: string): Promise<void> => {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const absolutePath = path.join(dir, entry.name);
        const relativePath = toPosix(path.relative(this.dataRoot, absolutePath));
        const exclusion = exportExclusion(relativePath, entry);
        if (exclusion) {
          excluded.add(exclusion);
          continue;
        }
        if (entry.isDirectory()) {
          await walk(absolutePath);
        } else if (entry.isFile()) {
          const stat = await fsp.stat(absolutePath);
          const sha256 = await hashFile(absolutePath);
          files.push({
            absolutePath,
            relativePath,
            zipPath: DATA_PREFIX + relativePath,
            bytes: stat.size,
            sha256,
          });
        } else if (entry.isSymbolicLink()) {
          excluded.add(`${relativePath} (symlink)`);
        }
      }
    };

    await walk(this.dataRoot);
    (files as CollectedFile[] & { excluded?: string[] }).excluded = Array.from(excluded).sort();
    return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  private async buildManifest(files: CollectedFile[]): Promise<DataExportManifest> {
    const fileRecords: DataExportFileRecord[] = files.map(file => ({
      path: file.relativePath,
      bytes: file.bytes,
      sha256: file.sha256,
    }));
    const bytes = fileRecords.reduce((sum, file) => sum + file.bytes, 0);
    if (bytes > MAX_BUNDLE_UNCOMPRESSED_BYTES) {
      throw new Error('Export data root is too large. Data migration bundles are limited to 20 GB of included files.');
    }
    const workspaces = await this.collectWorkspaceRecords();
    const authIncluded = this.authDataDir ? isPathInside(this.authDataDir, this.dataRoot) : false;
    const warnings: string[] = [];
    if (this.authDataDir && !authIncluded) {
      warnings.push('AUTH_DATA_DIR is outside AGENT_COCKPIT_DATA_DIR and is not included in this export.');
    }

    return {
      schemaVersion: DATA_EXPORT_SCHEMA_VERSION,
      appVersion: this.appVersion,
      exportedAt: this.now().toISOString(),
      sourcePlatform: process.platform,
      dataRootName: path.basename(this.dataRoot),
      includedRoot: 'AGENT_COCKPIT_DATA_DIR',
      auth: {
        included: authIncluded || fileRecords.some(file => file.path === 'auth/owner.json' || file.path.startsWith('auth/')),
        path: this.authDataDir,
        ...(this.authDataDir && !authIncluded ? { warning: 'AUTH_DATA_DIR is outside the exported data root.' } : {}),
      },
      counts: {
        workspaces: workspaces.length,
        files: fileRecords.length,
        bytes,
      },
      workspaces,
      files: fileRecords,
      excluded: ((files as CollectedFile[] & { excluded?: string[] }).excluded || []).sort(),
      warnings,
    };
  }

  private async collectWorkspaceRecords(): Promise<DataExportWorkspaceRecord[]> {
    const registryPath = path.join(this.dataRoot, 'chat', 'workspaces.json');
    const registry = readJsonIfExists(registryPath) as { workspaces?: unknown[] } | null;
    const records = Array.isArray(registry?.workspaces) ? registry!.workspaces : [];
    const result: DataExportWorkspaceRecord[] = [];
    for (const raw of records) {
      if (!raw || typeof raw !== 'object') continue;
      const record = raw as Record<string, unknown>;
      const workspaceId = stringField(record.workspaceId);
      const storageKey = stringField(record.storageKey);
      if (!workspaceId || !storageKey) continue;
      const currentPath = stringField(record.currentPath);
      const workspaceRoot = path.join(this.dataRoot, 'chat', 'workspaces', storageKey);
      const index = readJsonIfExists(path.join(workspaceRoot, 'index.json')) as Record<string, unknown> | null;
      const knowledgeDir = path.join(workspaceRoot, 'knowledge');
      const memoryDir = path.join(workspaceRoot, 'memory');
      const workspaceContextDir = path.join(workspaceRoot, 'workspace-context');
      result.push({
        workspaceId,
        storageKey,
        currentPath: currentPath || null,
        previousPaths: Array.isArray(record.previousPaths) ? record.previousPaths.filter((item): item is string => typeof item === 'string') : [],
        memory: {
          present: fs.existsSync(memoryDir),
          enabled: booleanField(index?.memoryEnabled),
        },
        knowledge: {
          present: fs.existsSync(knowledgeDir),
          enabled: booleanField(index?.kbEnabled),
          stateDb: fs.existsSync(path.join(knowledgeDir, 'state.db')),
          vectors: fs.existsSync(path.join(knowledgeDir, 'vectors')),
          embeddingConfig: embeddingConfigField(index?.kbEmbedding),
        },
        workspaceContext: {
          present: fs.existsSync(workspaceContextDir),
          enabled: booleanField(index?.workspaceContextEnabled),
        },
      });
    }
    return result.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
  }

  private async openAndValidateBundle(filePath: string): Promise<{ manifest: DataExportManifest }> {
    const { manifest, hasData } = await inspectImportZip(filePath);
    validateManifest(manifest);
    if (!hasData) throw new Error('Import bundle does not contain exported data.');
    return { manifest };
  }

  private async extractBundleData(filePath: string, targetDir: string, manifest: DataExportManifest): Promise<void> {
    await extractZipData(filePath, targetDir, manifest);
  }

  private async checkWorkspaces(options: { deep?: boolean }): Promise<DataMigrationCheckResult['workspaces']> {
    const records = await this.collectWorkspaceRecords();
    const checks: DataMigrationCheckResult['workspaces'] = [];
    for (const workspace of records) {
      const root = path.join(this.dataRoot, 'chat', 'workspaces', workspace.storageKey);
      const knowledgeDir = path.join(root, 'knowledge');
      const stateDbPath = path.join(knowledgeDir, 'state.db');
      const vectorsPath = path.join(knowledgeDir, 'vectors');
      const stateDb = fs.existsSync(stateDbPath) ? checkSqliteDb(stateDbPath) : skipped('No KB SQLite database present');
      const vectors = fs.existsSync(vectorsPath) ? checkPgliteDirectory(vectorsPath) : skipped('No KB vector store present');
      let embedding = workspace.knowledge.embeddingConfig
        ? warn(`Embedding config uses ${workspace.knowledge.embeddingConfig.model || 'default model'}; run deep checks to verify Ollama.`)
        : skipped('No embedding config present');
      if (options.deep && workspace.knowledge.embeddingConfig) {
        embedding = await checkEmbedding(workspace.knowledge.embeddingConfig);
      }
      checks.push({
        workspaceId: workspace.workspaceId,
        storageKey: workspace.storageKey,
        currentPath: workspace.currentPath,
        storage: fs.existsSync(root) ? ok('Workspace storage folder exists', root) : error('Workspace storage folder is missing', root),
        workspacePath: workspace.currentPath
          ? fs.existsSync(workspace.currentPath) ? ok('Workspace path exists', workspace.currentPath) : warn('Workspace path is missing; remap it in Workspace Settings.', workspace.currentPath)
          : warn('Workspace has no current path.'),
        memory: workspace.memory.present ? ok('Memory data present', path.join(root, 'memory')) : skipped('No memory directory present'),
        knowledge: {
          ...(workspace.knowledge.present ? ok('Knowledge Base data present', knowledgeDir) : skipped('No Knowledge Base directory present')),
          stateDb,
          vectors,
          embedding,
        },
        workspaceContext: workspace.workspaceContext.present ? ok('Workspace Context data present', path.join(root, 'workspace-context')) : skipped('No Workspace Context directory present'),
      });
    }
    return checks;
  }

  private async checkCliProfiles(): Promise<CheckStatus[]> {
    const settingsPath = path.join(this.dataRoot, 'chat', 'settings.json');
    const settings = readJsonIfExists(settingsPath) as Settings | null;
    const profiles = Array.isArray(settings?.cliProfiles) ? settings!.cliProfiles : [];
    if (profiles.length === 0) return [skipped('No CLI profiles configured')];
    return profiles.map(profile => checkCliProfile(profile, this.dataRoot));
  }
}

function controlDirForDataRoot(dataRoot: string): string {
  const resolved = path.resolve(dataRoot);
  return path.join(path.dirname(resolved), `${path.basename(resolved)}${CONTROL_DIR_SUFFIX}`);
}

function validatePendingImportRecord(record: PendingImportRecord, controlDir: string): void {
  if (!record || record.schemaVersion !== 1) throw new Error('Pending import has an unsupported schema version.');
  if (!record.importId || !record.stagingDataDir || !record.backupPath) throw new Error('Pending import is incomplete.');
  const resolvedControl = path.resolve(controlDir);
  if (!isPathInside(path.resolve(record.stagingDataDir), resolvedControl)) throw new Error('Pending import staging path is outside the migration control directory.');
  if (!isPathInside(path.resolve(record.backupPath), resolvedControl)) throw new Error('Pending import backup path is outside the migration control directory.');
}

function validateManifest(manifest: DataExportManifest): void {
  if (!manifest || manifest.schemaVersion !== DATA_EXPORT_SCHEMA_VERSION) {
    throw new Error('Import bundle has an unsupported export schema version.');
  }
  if (manifest.includedRoot !== 'AGENT_COCKPIT_DATA_DIR') {
    throw new Error('Import bundle does not contain an Agent Cockpit data-root export.');
  }
  if (!manifest.exportedAt || !manifest.appVersion) {
    throw new Error('Import manifest is missing required metadata.');
  }
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.workspaces)) {
    throw new Error('Import manifest is missing file or workspace records.');
  }
  if (
    !manifest.counts ||
    !Number.isSafeInteger(manifest.counts.files) ||
    !Number.isSafeInteger(manifest.counts.bytes) ||
    manifest.counts.files < 0 ||
    manifest.counts.bytes < 0
  ) {
    throw new Error('Import manifest is missing valid file counts.');
  }
  let totalBytes = 0;
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(file.sha256)
    ) {
      throw new Error('Import manifest has an invalid file record.');
    }
    validateDataRelativePath(file.path);
    totalBytes += file.bytes;
    if (totalBytes > MAX_BUNDLE_UNCOMPRESSED_BYTES) {
      throw new Error('Import bundle uncompressed data exceeds the 20 GB limit.');
    }
  }
  if (manifest.counts.files !== manifest.files.length || manifest.counts.bytes !== totalBytes) {
    throw new Error('Import manifest file counts do not match file records.');
  }
}

function validateZipEntryName(name: string): void {
  const normalized = toPosix(name);
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || name.includes('\\')) {
    throw new Error(`Unsafe import entry path: ${name}`);
  }
  const parts = normalized.split('/');
  if (parts.includes('..')) throw new Error(`Unsafe import entry path: ${name}`);
  if (normalized !== MANIFEST_PATH && !normalized.startsWith(DATA_PREFIX)) {
    throw new Error(`Unexpected import entry path: ${name}`);
  }
}

function validateDataRelativePath(relativePath: string): void {
  const normalized = toPosix(relativePath);
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || relativePath.includes('\\') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Unsafe import manifest path: ${relativePath}`);
  }
  if (normalized.split('/').includes('..')) {
    throw new Error(`Unsafe import manifest path: ${relativePath}`);
  }
}

async function writeExportZip(filePath: string, manifest: DataExportManifest, files: CollectedFile[]): Promise<void> {
  const zip = new yazl.ZipFile();
  const output = fs.createWriteStream(filePath);
  const finished = new Promise<void>((resolve, reject) => {
    zip.outputStream.on('error', reject);
    output.on('error', reject);
    output.on('finish', resolve);
  });

  try {
    zip.outputStream.pipe(output);
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'), MANIFEST_PATH);
    for (const file of files) {
      zip.addFile(file.absolutePath, file.zipPath);
    }
    zip.end({ forceZip64Format: true, comment: '' });
    await finished;
    await verifyZipEntriesAgainstManifest(filePath, manifest);
  } catch (err) {
    output.destroy();
    await fsp.rm(filePath, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function inspectImportZip(filePath: string): Promise<{ manifest: DataExportManifest; hasData: boolean }> {
  const zipfile = await openZip(filePath);
  let manifestText: string | null = null;
  let hasData = false;
  const seen = new Set<string>();

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: unknown) => {
      if (settled) return;
      settled = true;
      zipfile.close();
      if (err) {
        reject(err);
        return;
      }
      if (!manifestText) {
        reject(new Error('Import bundle is missing manifest.json.'));
        return;
      }
      try {
        resolve({ manifest: JSON.parse(manifestText) as DataExportManifest, hasData });
      } catch (parseErr) {
        reject(new Error(`Import manifest is not valid JSON: ${(parseErr as Error).message}`));
      }
    };

    zipfile.on('entry', entry => {
      void (async () => {
        validateImportEntry(entry, seen);
        if (entry.fileName.startsWith(DATA_PREFIX)) hasData = true;
        if (entry.fileName !== MANIFEST_PATH) {
          zipfile.readEntry();
          return;
        }
        if (entry.uncompressedSize > MAX_MANIFEST_BYTES) {
          throw new Error('Import manifest is too large.');
        }
        const buffer = await readZipEntryBuffer(zipfile, entry, MAX_MANIFEST_BYTES);
        manifestText = buffer.toString('utf8');
        zipfile.readEntry();
      })().catch(done);
    });
    zipfile.on('error', done);
    zipfile.on('end', () => done());
    zipfile.readEntry();
  });
}

async function extractZipData(filePath: string, targetDir: string, manifest: DataExportManifest): Promise<void> {
  const zipfile = await openZip(filePath);
  const targetDataDir = path.resolve(targetDir, 'data');
  const expected = new Map(manifest.files.map(file => [toPosix(file.path), file]));
  const extracted = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: unknown) => {
      if (settled) return;
      settled = true;
      zipfile.close();
      if (err) reject(err);
      else resolve();
    };

    zipfile.on('entry', entry => {
      void (async () => {
        validateZipEntryName(entry.fileName);
        if (entry.isEncrypted()) throw new Error(`Encrypted import entries are not supported: ${entry.fileName}`);
        if (entry.fileName === MANIFEST_PATH || !entry.fileName.startsWith(DATA_PREFIX)) {
          zipfile.readEntry();
          return;
        }

        const relative = entry.fileName.slice(DATA_PREFIX.length);
        if (!relative) {
          zipfile.readEntry();
          return;
        }
        const absoluteTarget = path.resolve(targetDataDir, relative);
        if (!isPathInside(absoluteTarget, targetDataDir)) {
          throw new Error(`Unsafe import path: ${entry.fileName}`);
        }
        if (entry.fileName.endsWith('/')) {
          await fsp.mkdir(absoluteTarget, { recursive: true });
          zipfile.readEntry();
          return;
        }

        const expectedFile = expected.get(toPosix(relative));
        if (!expectedFile) {
          throw new Error(`Import bundle contains an unexpected data file: ${relative}`);
        }
        if (extracted.has(toPosix(relative))) {
          throw new Error(`Import bundle contains a duplicate data file: ${relative}`);
        }
        if (entry.uncompressedSize !== expectedFile.bytes) {
          throw new Error(`Import bundle file size mismatch: ${relative}`);
        }

        extracted.add(toPosix(relative));
        await fsp.mkdir(path.dirname(absoluteTarget), { recursive: true });
        const input = await openZipEntryStream(zipfile, entry);
        await pipeline(input, fs.createWriteStream(absoluteTarget));
        zipfile.readEntry();
      })().catch(done);
    });
    zipfile.on('error', done);
    zipfile.on('end', () => done());
    zipfile.readEntry();
  });
}

async function verifyZipEntriesAgainstManifest(filePath: string, manifest: DataExportManifest): Promise<void> {
  const zipfile = await openZip(filePath);
  const expected = new Map(manifest.files.map(file => [toPosix(file.path), file]));
  const actual = new Set<string>();
  const seen = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: unknown) => {
      if (settled) return;
      settled = true;
      zipfile.close();
      if (err) reject(err);
      else resolve();
    };

    zipfile.on('entry', entry => {
      void (async () => {
        validateImportEntry(entry, seen);
        if (entry.fileName === MANIFEST_PATH) {
          zipfile.readEntry();
          return;
        }
        const relative = entry.fileName.slice(DATA_PREFIX.length);
        if (!relative || entry.fileName.endsWith('/')) {
          zipfile.readEntry();
          return;
        }
        const expectedFile = expected.get(toPosix(relative));
        if (!expectedFile) {
          throw new Error(`Export bundle contains an unexpected data file: ${relative}`);
        }
        if (entry.uncompressedSize !== expectedFile.bytes) {
          throw new Error(`Export bundle file size mismatch: ${relative}`);
        }
        const hashed = await hashZipEntry(zipfile, entry);
        if (hashed.bytes !== expectedFile.bytes || hashed.sha256 !== expectedFile.sha256) {
          throw new Error(`Export bundle checksum mismatch: ${relative}`);
        }
        actual.add(toPosix(relative));
        zipfile.readEntry();
      })().catch(done);
    });
    zipfile.on('error', done);
    zipfile.on('end', () => {
      for (const relativePath of expected.keys()) {
        if (!actual.has(relativePath)) {
          done(new Error(`Export bundle is missing manifest file: ${relativePath}`));
          return;
        }
      }
      done();
    });
    zipfile.readEntry();
  });
}

function validateImportEntry(entry: yauzl.Entry, seen: Set<string>): void {
  validateZipEntryName(entry.fileName);
  if (seen.has(entry.fileName)) throw new Error(`Import bundle contains a duplicate entry: ${entry.fileName}`);
  seen.add(entry.fileName);
  if (entry.isEncrypted()) throw new Error(`Encrypted import entries are not supported: ${entry.fileName}`);
}

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (err, zipfile) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(zipfile);
    });
  });
}

function readZipEntryBuffer(zipfile: yauzl.ZipFile, entry: yauzl.Entry, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          stream.destroy(new Error('Import manifest is too large.'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

function openZipEntryStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) reject(err);
      else resolve(stream);
    });
  });
}

function hashZipEntry(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<{ bytes: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      stream.on('data', chunk => {
        bytes += chunk.length;
        hash.update(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve({ bytes, sha256: hash.digest('hex') }));
    });
  });
}

async function verifyStagedData(manifest: DataExportManifest, stagingDataDir: string): Promise<void> {
  const expected = new Map(manifest.files.map(file => [toPosix(file.path), file]));
  const actual = await collectRelativeFiles(stagingDataDir);
  for (const relativePath of actual) {
    if (!expected.has(relativePath)) {
      throw new Error(`Import bundle contains an unexpected data file: ${relativePath}`);
    }
  }
  for (const file of manifest.files) {
    const relativePath = toPosix(file.path);
    const absolutePath = path.resolve(stagingDataDir, relativePath);
    if (!isPathInside(absolutePath, stagingDataDir)) {
      throw new Error(`Unsafe import manifest path: ${file.path}`);
    }
    const stat = await fsp.stat(absolutePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new Error(`Import bundle is missing manifest file: ${relativePath}`);
    }
    if (stat.size !== file.bytes) {
      throw new Error(`Import bundle file size mismatch: ${relativePath}`);
    }
    const sha256 = await hashFile(absolutePath);
    if (sha256 !== file.sha256) {
      throw new Error(`Import bundle checksum mismatch: ${relativePath}`);
    }
  }
}

async function collectRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        files.push(toPosix(path.relative(root, absolutePath)));
      }
    }
  };
  await walk(root);
  return files.sort();
}

function exportExclusion(relativePath: string, entry: fs.Dirent): string | null {
  const normalized = toPosix(relativePath);
  const parts = normalized.split('/');
  const basename = parts[parts.length - 1];
  if (normalized === 'sessions' || normalized.startsWith('sessions/')) return 'sessions/';
  if (normalized === 'chat/stream-jobs.json') return 'chat/stream-jobs.json';
  if (basename === '.DS_Store') return '.DS_Store';
  if (basename === 'postmaster.pid') return normalized;
  if (parts.includes('pg_stat_tmp')) return normalized;
  if (parts.includes('.staging') || parts.includes('.tmp')) return normalized;
  if (entry.isDirectory() && (basename === 'tmp' || basename === 'temp')) return normalized;
  return null;
}

function removeKnownRuntimeFiles(root: string): void {
  if (!fs.existsSync(root)) return;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.name === 'postmaster.pid' || entry.name === '.DS_Store') {
        fs.rmSync(full, { force: true, recursive: entry.isDirectory() });
        continue;
      }
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  fs.rmSync(path.join(root, 'sessions'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'chat', 'stream-jobs.json'), { force: true });
}

function readJsonIfExists(filePath: string): unknown | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const handle = await fsp.open(filePath, 'r');
  try {
    const stream = handle.createReadStream();
    await new Promise<void>((resolve, reject) => {
      stream.on('data', chunk => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', resolve);
    });
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function isPathInside(candidate: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function safeId(value: string): string {
  const safe = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safe) throw new Error('Invalid identifier.');
  return safe;
}

function removeUploadFilesSync(controlDir: string, uploadId: string): void {
  const safe = safeId(uploadId);
  fs.rmSync(path.join(controlDir, 'uploads', `${safe}${UPLOAD_EXTENSION}`), { force: true });
  fs.rmSync(path.join(controlDir, 'uploads', `${safe}.zip`), { force: true });
}

function publicExportJob(job: ExportJobRecord): DataExportJobStatusResponse {
  return {
    jobId: job.jobId,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.filename ? { filename: job.filename } : {}),
    ...(job.manifest ? { manifest: job.manifest } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function booleanField(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function embeddingConfigField(value: unknown): EmbeddingConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.model === 'string' ? { model: record.model } : {}),
    ...(typeof record.ollamaHost === 'string' ? { ollamaHost: record.ollamaHost } : {}),
    ...(typeof record.dimensions === 'number' ? { dimensions: record.dimensions } : {}),
  };
}

function importWarnings(manifest: DataExportManifest): string[] {
  const warnings = [...(manifest.warnings || [])];
  warnings.push('Import replaces the active Agent Cockpit data root after backup. Existing data will no longer be active after restart.');
  if (manifest.workspaces.some(workspace => workspace.knowledge.embeddingConfig)) {
    warnings.push('This export contains KB embedding configuration. The destination machine must have the configured Ollama host/model for new semantic work.');
  }
  return warnings;
}

function ok(message: string, checkPath?: string): CheckStatus {
  return { status: 'ok', message, ...(checkPath ? { path: checkPath } : {}) };
}

function warn(message: string, checkPath?: string): CheckStatus {
  return { status: 'warning', message, ...(checkPath ? { path: checkPath } : {}) };
}

function error(message: string, checkPath?: string): CheckStatus {
  return { status: 'error', message, ...(checkPath ? { path: checkPath } : {}) };
}

function skipped(message: string): CheckStatus {
  return { status: 'skipped', message };
}

function checkSqliteDb(dbPath: string): CheckStatus {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    let row: { value: string } | undefined;
    try {
      row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    } finally {
      db.close();
    }
    if (!row?.value) {
      return error('KB SQLite database is missing schema_version metadata.', dbPath);
    }
    return ok('KB SQLite database opens successfully', dbPath);
  } catch (err: unknown) {
    return error(`KB SQLite database could not be opened: ${(err as Error).message}`, dbPath);
  }
}

function checkPgliteDirectory(vectorsPath: string): CheckStatus {
  if (!fs.existsSync(path.join(vectorsPath, 'PG_VERSION'))) {
    return error('PGLite vector directory is missing PG_VERSION.', vectorsPath);
  }
  if (fs.existsSync(path.join(vectorsPath, 'postmaster.pid'))) {
    return warn('PGLite vector directory has a stale postmaster.pid; restart/check may clear it.', vectorsPath);
  }
  return ok('PGLite vector directory is present', vectorsPath);
}

async function checkEmbedding(config: EmbeddingConfig): Promise<CheckStatus> {
  const label = `${config.model || 'nomic-embed-text'} at ${config.ollamaHost || 'http://localhost:11434'}`;
  const result = await checkOllamaHealth(config);
  return result.ok
    ? ok(`Ollama embedding model is available: ${label}`)
    : warn(`Ollama embedding check failed for ${label}: ${result.error || 'unknown error'}`);
}

function checkCliProfile(profile: CliProfile, dataRoot: string): CheckStatus {
  const label = `${profile.name || profile.id} (${profile.vendor})`;
  if (profile.disabled) return skipped(`${label} is disabled`);
  if (profile.vendor === 'kiro') return warn(`${label} uses system Kiro CLI auth outside Agent Cockpit; recheck on this machine.`);
  if (profile.authMode === 'account') {
    if (!profile.configDir) return warn(`${label} account profile has no configDir yet; re-auth may create one.`);
    const configDir = path.resolve(profile.configDir);
    if (!fs.existsSync(configDir)) return warn(`${label} config directory is missing; re-auth this profile.`, configDir);
    const inside = isPathInside(configDir, dataRoot);
    return inside
      ? ok(`${label} isolated auth/config directory is present`, configDir)
      : warn(`${label} config directory is outside the data root and was not restored by data import.`, configDir);
  }
  return warn(`${label} uses system CLI auth outside Agent Cockpit; re-auth or check login on this machine.`);
}
