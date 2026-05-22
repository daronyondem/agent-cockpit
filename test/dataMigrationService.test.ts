import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import { DATA_EXPORT_SCHEMA_VERSION, type DataExportManifest } from '../src/contracts/dataMigration';
import { DataMigrationService } from '../src/services/dataMigrationService';

const NOW = new Date('2026-05-21T12:00:00.000Z');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-migration-'));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('DataMigrationService', () => {
  test('exports the data root with manifest metadata and excludes runtime files', async () => {
    const dataRoot = path.join(tmpDir, 'data');
    const workspaceStorageKey = 'workspace-storage-key';
    const workspaceRoot = path.join(dataRoot, 'chat', 'workspaces', workspaceStorageKey);
    const workspacePath = path.join(tmpDir, 'workspace');
    await fsp.mkdir(path.join(workspaceRoot, 'memory', 'files'), { recursive: true });
    await fsp.mkdir(path.join(workspaceRoot, 'workspace-context'), { recursive: true });
    await fsp.mkdir(path.join(workspaceRoot, 'knowledge', 'vectors'), { recursive: true });
    await fsp.mkdir(path.join(dataRoot, 'sessions'), { recursive: true });
    await fsp.mkdir(workspacePath, { recursive: true });
    await fsp.writeFile(path.join(dataRoot, 'sessions', 'session.json'), 'runtime');
    await fsp.writeFile(path.join(dataRoot, 'chat', 'stream-jobs.json'), '{"jobs":[]}');
    await fsp.writeFile(path.join(dataRoot, 'chat', 'usage-ledger.json'), '{"days":[]}');
    await fsp.writeFile(path.join(dataRoot, 'chat', 'usage-pricing-overrides.json'), '{"schemaVersion":1,"version":"user-overrides:empty","entries":[]}');
    await fsp.writeFile(path.join(dataRoot, 'claude-plan-usage.json'), '{"fetchedAt":"2026-05-21T12:00:00.000Z"}');
    await fsp.mkdir(path.join(dataRoot, 'codex-plan-usage'), { recursive: true });
    await fsp.writeFile(path.join(dataRoot, 'codex-plan-usage', 'profile.json'), '{"fetchedAt":"2026-05-21T12:00:00.000Z"}');
    await fsp.writeFile(path.join(dataRoot, 'kiro-plan-usage.json'), '{"fetchedAt":"2026-05-21T12:00:00.000Z"}');
    await fsp.writeFile(path.join(workspaceRoot, 'knowledge', 'vectors', 'PG_VERSION'), '16');
    await fsp.writeFile(path.join(workspaceRoot, 'knowledge', 'vectors', 'postmaster.pid'), 'stale');
    await fsp.writeFile(path.join(workspaceRoot, '.DS_Store'), 'finder');
    await fsp.writeFile(path.join(workspaceRoot, 'memory', 'files', 'note.md'), 'memory');
    await fsp.writeFile(path.join(workspaceRoot, 'workspace-context', 'summary.md'), 'context');
    await fsp.writeFile(path.join(workspaceRoot, 'index.json'), JSON.stringify({
      memoryEnabled: true,
      kbEnabled: true,
      workspaceContextEnabled: true,
      kbEmbedding: { model: 'nomic-embed-text', ollamaHost: 'http://localhost:11434', dimensions: 768 },
    }));
    await fsp.writeFile(path.join(dataRoot, 'chat', 'workspaces.json'), JSON.stringify({
      workspaces: [{
        workspaceId: 'workspace-id',
        storageKey: workspaceStorageKey,
        currentPath: workspacePath,
        previousPaths: ['/old/path'],
      }],
    }));
    createKbDatabase(path.join(workspaceRoot, 'knowledge', 'state.db'));

    const service = new DataMigrationService({
      dataRoot,
      appVersion: '1.2.3',
      now: () => NOW,
    });

    const bundle = await service.createExportBundle();
    const zip = new AdmZip(bundle.filePath);
    const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8')) as DataExportManifest;
    const entryNames = zip.getEntries().map(entry => entry.entryName).sort();
    const manifestPaths = manifest.files.map(file => file.path);

    expect(bundle.filename).toBe('agent-cockpit-export-2026-05-21T12-00-00-000Z.acexport');
    expect(manifest.schemaVersion).toBe(DATA_EXPORT_SCHEMA_VERSION);
    expect(manifest.appVersion).toBe('1.2.3');
    expect(manifest.counts.workspaces).toBe(1);
    expect(manifest.workspaces[0]).toMatchObject({
      workspaceId: 'workspace-id',
      storageKey: workspaceStorageKey,
      currentPath: workspacePath,
      memory: { present: true, enabled: true },
      knowledge: {
        present: true,
        enabled: true,
        stateDb: true,
        vectors: true,
        embeddingConfig: { model: 'nomic-embed-text' },
      },
      workspaceContext: { present: true, enabled: true },
    });
    expect(entryNames).toContain(`data/chat/workspaces/${workspaceStorageKey}/knowledge/state.db`);
    expect(entryNames).toContain(`data/chat/workspaces/${workspaceStorageKey}/knowledge/vectors/PG_VERSION`);
    expect(entryNames).toContain('data/chat/usage-ledger.json');
    expect(entryNames).toContain('data/chat/usage-pricing-overrides.json');
    expect(entryNames).toContain('data/claude-plan-usage.json');
    expect(entryNames).toContain('data/codex-plan-usage/profile.json');
    expect(entryNames).toContain('data/kiro-plan-usage.json');
    expect(entryNames).not.toContain('data/sessions/session.json');
    expect(entryNames).not.toContain('data/chat/stream-jobs.json');
    expect(manifestPaths).toContain(`chat/workspaces/${workspaceStorageKey}/memory/files/note.md`);
    expect(manifestPaths).toEqual(expect.arrayContaining([
      'chat/usage-ledger.json',
      'chat/usage-pricing-overrides.json',
      'claude-plan-usage.json',
      'codex-plan-usage/profile.json',
      'kiro-plan-usage.json',
    ]));
    expect(manifestPaths).not.toContain('sessions/session.json');
    expect(manifest.excluded).toEqual(expect.arrayContaining([
      'sessions/',
      'chat/stream-jobs.json',
      '.DS_Store',
      `chat/workspaces/${workspaceStorageKey}/knowledge/vectors/postmaster.pid`,
    ]));
  });

  test('rejects a staged import when extracted bytes do not match the manifest', async () => {
    const dataRoot = path.join(tmpDir, 'destination');
    const uploadSource = path.join(tmpDir, 'tampered.acexport');
    const manifest = manifestForFiles([{ path: 'chat/settings.json', bytes: 2, sha256: sha256('ok') }]);
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    zip.addFile('data/chat/settings.json', Buffer.from('no'));
    zip.writeZip(uploadSource);
    const service = new DataMigrationService({
      dataRoot,
      appVersion: '0.0.0-test',
      now: () => NOW,
    });

    const uploadId = await service.saveImportUpload(uploadSource, 'tampered.acexport');

    await expect(service.scheduleImport(uploadId)).rejects.toThrow('checksum mismatch');
    const stagingDir = path.join(service.controlDir, 'staging');
    expect(fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir) : []).toEqual([]);
  });

  test('rejects undeclared data entries before activating an import', async () => {
    const dataRoot = path.join(tmpDir, 'destination');
    const uploadSource = path.join(tmpDir, 'unexpected.acexport');
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifestForFiles([]), null, 2) + '\n'));
    zip.addFile('data/chat/settings.json', Buffer.from('{}'));
    zip.writeZip(uploadSource);
    const service = new DataMigrationService({
      dataRoot,
      appVersion: '0.0.0-test',
      now: () => NOW,
    });

    const uploadId = await service.saveImportUpload(uploadSource, 'unexpected.acexport');

    await expect(service.scheduleImport(uploadId)).rejects.toThrow('unexpected data file');
    const stagingDir = path.join(service.controlDir, 'staging');
    expect(fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir) : []).toEqual([]);
  });

  test('rejects import manifests above the uncompressed bundle limit', async () => {
    const dataRoot = path.join(tmpDir, 'destination');
    const uploadSource = path.join(tmpDir, 'too-large.acexport');
    const oversizedBytes = 21 * 1024 * 1024 * 1024;
    const manifest = manifestForFiles([{ path: 'chat/settings.json', bytes: oversizedBytes, sha256: sha256('{}') }]);
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    zip.addFile('data/chat/settings.json', Buffer.from('{}'));
    zip.writeZip(uploadSource);
    const service = new DataMigrationService({
      dataRoot,
      appVersion: '0.0.0-test',
      now: () => NOW,
    });

    const uploadId = await service.saveImportUpload(uploadSource, 'too-large.acexport');

    await expect(service.previewImportUpload(uploadId)).rejects.toThrow('uncompressed data exceeds');
  });

  test('applies a pending import by replacing data root and backing up current data', async () => {
    const sourceRoot = path.join(tmpDir, 'source-data');
    const destinationRoot = path.join(tmpDir, 'active-data');
    await fsp.mkdir(path.join(sourceRoot, 'chat'), { recursive: true });
    await fsp.mkdir(destinationRoot, { recursive: true });
    await fsp.writeFile(path.join(sourceRoot, 'chat', 'settings.json'), '{"theme":"light"}');
    await fsp.writeFile(path.join(destinationRoot, 'old.txt'), 'old-active-data');
    const sourceService = new DataMigrationService({
      dataRoot: sourceRoot,
      appVersion: '0.0.0-test',
      now: () => NOW,
    });
    const destinationService = new DataMigrationService({
      dataRoot: destinationRoot,
      appVersion: '0.0.0-test',
      now: () => NOW,
    });
    const bundle = await sourceService.createExportBundle();
    const uploadCopy = path.join(tmpDir, 'upload.acexport');
    await fsp.copyFile(bundle.filePath, uploadCopy);
    const uploadId = await destinationService.saveImportUpload(uploadCopy, 'upload.acexport');
    const storedUploadPath = path.join(destinationService.uploadDir(), `${uploadId}.acexport`);
    const scheduled = await destinationService.scheduleImport(uploadId);
    expect(fs.existsSync(storedUploadPath)).toBe(true);

    const applied = DataMigrationService.applyPendingImport(destinationRoot);

    expect(applied).toEqual({ applied: true, backupPath: scheduled.backupPath });
    await expect(fsp.readFile(path.join(destinationRoot, 'chat', 'settings.json'), 'utf8')).resolves.toBe('{"theme":"light"}');
    await expect(fsp.readFile(path.join(scheduled.backupPath, 'old.txt'), 'utf8')).resolves.toBe('old-active-data');
    expect(fs.existsSync(path.join(destinationService.controlDir, 'pending-import.json'))).toBe(false);
    expect(fs.existsSync(path.join(destinationService.controlDir, 'last-import.json'))).toBe(true);
    expect(fs.existsSync(storedUploadPath)).toBe(false);
  });

  test('refuses to schedule a second import while one is already pending', async () => {
    const sourceRoot = path.join(tmpDir, 'source-data');
    const destinationRoot = path.join(tmpDir, 'active-data');
    await fsp.mkdir(path.join(sourceRoot, 'chat'), { recursive: true });
    await fsp.writeFile(path.join(sourceRoot, 'chat', 'settings.json'), '{"theme":"light"}');
    const sourceService = new DataMigrationService({
      dataRoot: sourceRoot,
      appVersion: '0.0.0-test',
      now: () => NOW,
    });
    const destinationService = new DataMigrationService({
      dataRoot: destinationRoot,
      appVersion: '0.0.0-test',
      now: () => NOW,
    });
    const bundle = await sourceService.createExportBundle();
    const firstUpload = path.join(tmpDir, 'first.acexport');
    const secondUpload = path.join(tmpDir, 'second.acexport');
    await fsp.copyFile(bundle.filePath, firstUpload);
    await fsp.copyFile(bundle.filePath, secondUpload);
    await destinationService.scheduleImport(await destinationService.saveImportUpload(firstUpload, 'first.acexport'));

    await expect(
      destinationService.scheduleImport(await destinationService.saveImportUpload(secondUpload, 'second.acexport')),
    ).rejects.toThrow('already pending');
  });

  test('moves a failed pending import aside so startup does not retry forever', async () => {
    const dataRoot = path.join(tmpDir, 'active-data');
    const controlDir = DataMigrationService.controlDirForDataRoot(dataRoot);
    await fsp.mkdir(controlDir, { recursive: true });
    await fsp.writeFile(path.join(controlDir, 'pending-import.json'), JSON.stringify({
      schemaVersion: 1,
      importId: 'import-bad',
      uploadId: 'upload-bad',
      createdAt: NOW.toISOString(),
      stagingDataDir: path.join(controlDir, 'missing', 'data'),
      backupPath: path.join(controlDir, 'backups', 'missing-backup'),
      manifest: manifestForFiles([]),
    }, null, 2) + '\n');

    const failed = DataMigrationService.applyPendingImport(dataRoot);
    const second = DataMigrationService.applyPendingImport(dataRoot);

    expect(failed.applied).toBe(false);
    expect(failed.error).toContain('Staged import data directory not found');
    expect(second).toEqual({ applied: false });
    expect(fs.existsSync(path.join(controlDir, 'pending-import.json'))).toBe(false);
    expect(fs.readdirSync(controlDir).some(name => name.startsWith('failed-') && name.endsWith('pending-import.json'))).toBe(true);
  });

  test('post-import checks report workspace storage, KB SQLite, and PGLite vector state', async () => {
    const dataRoot = path.join(tmpDir, 'data');
    const workspaceRoot = path.join(dataRoot, 'chat', 'workspaces', 'storage-key');
    await fsp.mkdir(path.join(workspaceRoot, 'knowledge', 'vectors'), { recursive: true });
    await fsp.writeFile(path.join(dataRoot, 'chat', 'workspaces.json'), JSON.stringify({
      workspaces: [{
        workspaceId: 'workspace-id',
        storageKey: 'storage-key',
        currentPath: path.join(tmpDir, 'missing-workspace-path'),
      }],
    }));
    await fsp.writeFile(path.join(workspaceRoot, 'index.json'), JSON.stringify({
      kbEnabled: true,
      kbEmbedding: { model: 'nomic-embed-text' },
    }));
    await fsp.writeFile(path.join(workspaceRoot, 'knowledge', 'vectors', 'PG_VERSION'), '16');
    createKbDatabase(path.join(workspaceRoot, 'knowledge', 'state.db'));
    const service = new DataMigrationService({
      dataRoot,
      appVersion: '0.0.0-test',
      now: () => NOW,
    });

    const checks = await service.runPostImportChecks();

    expect(checks.workspaces).toHaveLength(1);
    expect(checks.workspaces[0].storage.status).toBe('ok');
    expect(checks.workspaces[0].workspacePath.status).toBe('warning');
    expect(checks.workspaces[0].knowledge.stateDb?.status).toBe('ok');
    expect(checks.workspaces[0].knowledge.vectors?.status).toBe('ok');
    expect(checks.workspaces[0].knowledge.embedding?.status).toBe('warning');
    expect(checks.summary.status).toBe('warning');
  });
});

function createKbDatabase(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '8');
  } finally {
    db.close();
  }
}

function manifestForFiles(files: DataExportManifest['files']): DataExportManifest {
  return {
    schemaVersion: DATA_EXPORT_SCHEMA_VERSION,
    appVersion: '0.0.0-test',
    exportedAt: NOW.toISOString(),
    sourcePlatform: process.platform,
    dataRootName: 'data',
    includedRoot: 'AGENT_COCKPIT_DATA_DIR',
    auth: { included: false, path: null },
    counts: {
      workspaces: 0,
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    },
    workspaces: [],
    files,
    excluded: [],
    warnings: [],
  };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
