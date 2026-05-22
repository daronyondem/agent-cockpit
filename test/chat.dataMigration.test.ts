import fs from 'fs';
import fsp from 'fs/promises';
import http from 'http';
import path from 'path';
import { DATA_IMPORT_CONFIRMATION } from '../src/contracts/dataMigration';
import { DataMigrationService } from '../src/services/dataMigrationService';
import { createChatRouterEnv, destroyChatRouterEnv, CSRF_TOKEN, type ChatRouterEnv, type HttpResult } from './helpers/chatEnv';

let env: ChatRouterEnv;

afterEach(async () => {
  if (env) await destroyChatRouterEnv(env);
});

describe('chat data migration routes', () => {
  test('starts an export job and downloads the ready bundle', async () => {
    env = await createChatRouterEnv();
    const dataRoot = path.join(env.tmpDir, 'data');
    await fsp.mkdir(path.join(dataRoot, 'chat'), { recursive: true });
    await fsp.writeFile(path.join(dataRoot, 'chat', 'settings.json'), '{"theme":"dark"}');

    const started = await env.request('POST', '/api/chat/migration/export/start', {});
    expect(started.status).toBe(202);
    expect(started.body.jobId).toMatch(/^export-/);
    expect(started.body.status).toBe('running');
    expect(started.body.progress).toBeGreaterThanOrEqual(1);

    const ready = await waitForExportJob(started.body.jobId);
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');
    expect(ready.body.progress).toBe(100);
    expect(ready.body.filename).toMatch(/\.acexport$/);
    expect(ready.body.manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'chat/settings.json' }),
    ]));

    const download = await env.request('GET', `/api/chat/migration/export/${started.body.jobId}/download`);
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain('.acexport');
    expect(download.headers['content-type']).toBe('application/octet-stream');
  });

  test('previews a chunked uploaded export bundle', async () => {
    env = await createChatRouterEnv();
    const bundle = await createBundle(env.tmpDir);
    const content = await fsp.readFile(bundle);
    const started = await env.request('POST', '/api/chat/migration/import/uploads/start', {
      filename: 'agent-cockpit-export.acexport',
      size: content.length,
    });

    expect(started.status).toBe(200);
    expect(started.body.uploadId).toMatch(/^upload-/);
    expect(started.body.chunkSize).toBeGreaterThan(0);

    const uploadId = started.body.uploadId;
    const chunkSize = Math.max(1, Math.min(64 * 1024, started.body.chunkSize));
    for (let offset = 0; offset < content.length; offset += chunkSize) {
      const chunk = content.subarray(offset, Math.min(content.length, offset + chunkSize));
      const uploaded = await rawRequest('PUT', `/api/chat/migration/import/uploads/${uploadId}/chunk?offset=${offset}`, chunk);
      expect(uploaded.status).toBe(200);
      expect(uploaded.body.uploadId).toBe(uploadId);
    }

    const preview = await env.request('POST', `/api/chat/migration/import/uploads/${uploadId}/finish`, {});
    expect(preview.status).toBe(200);
    expect(preview.body.uploadId).toBe(uploadId);
    expect(preview.body.manifest.counts.files).toBe(1);
    expect(preview.body.manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'chat/settings.json' }),
    ]));
  });

  test('previews an uploaded export bundle and stages replacement only after REPLACE confirmation', async () => {
    const fakeUpdateService = {
      restart: jest.fn(async () => ({ success: true, steps: [] })),
      stop: jest.fn(),
    };
    env = await createChatRouterEnv({ updateService: fakeUpdateService });
    const bundle = await createBundle(env.tmpDir);
    const preview = await env.multipartRequest(
      'POST',
      '/api/chat/migration/import/preview',
      'bundle',
      'agent-cockpit-export.acexport',
      'application/zip',
      await fsp.readFile(bundle),
    );

    expect(preview.status).toBe(200);
    expect(preview.body.uploadId).toMatch(/^upload-/);
    expect(preview.body.manifest.counts.files).toBe(1);
    expect(preview.body.warnings).toContain('Import replaces the active Agent Cockpit data root after backup. Existing data will no longer be active after restart.');

    const rejected = await env.request('POST', '/api/chat/migration/import/confirm', {
      uploadId: preview.body.uploadId,
      confirmation: 'replace',
    });
    expect(rejected.status).toBe(400);
    expect(fakeUpdateService.restart).not.toHaveBeenCalled();

    const confirmed = await env.request('POST', '/api/chat/migration/import/confirm', {
      uploadId: preview.body.uploadId,
      confirmation: DATA_IMPORT_CONFIRMATION,
    });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.ok).toBe(true);
    expect(confirmed.body.pending).toBe(true);
    expect(confirmed.body.backupPath).toContain('data-backup-');
    expect(fakeUpdateService.restart).toHaveBeenCalledTimes(1);
    const controlDir = DataMigrationService.controlDirForDataRoot(path.join(env.tmpDir, 'data'));
    expect(fs.existsSync(path.join(controlDir, 'pending-import.json'))).toBe(true);
  });

  test('returns migration status and post-import checks', async () => {
    env = await createChatRouterEnv();

    const status = await env.request('GET', '/api/chat/migration/status');
    const checks = await env.request('GET', '/api/chat/migration/checks');

    expect(status.status).toBe(200);
    expect(status.body.dataRoot).toBe(path.join(env.tmpDir, 'data'));
    expect(status.body.pendingImport).toBe(false);
    expect(checks.status).toBe(200);
    expect(checks.body.dataRoot).toBe(path.join(env.tmpDir, 'data'));
    expect(checks.body.summary).toHaveProperty('status');
  });

  test('returns a client error when confirming a missing upload', async () => {
    const fakeUpdateService = {
      restart: jest.fn(async () => ({ success: true, steps: [] })),
      stop: jest.fn(),
    };
    env = await createChatRouterEnv({ updateService: fakeUpdateService });

    const confirmed = await env.request('POST', '/api/chat/migration/import/confirm', {
      uploadId: 'missing-upload',
      confirmation: DATA_IMPORT_CONFIRMATION,
    });

    expect(confirmed.status).toBe(400);
    expect(confirmed.body.error).toContain('Import upload not found');
    expect(fakeUpdateService.restart).not.toHaveBeenCalled();
  });

  test('cancels staged import if restart fails', async () => {
    const fakeUpdateService = {
      restart: jest.fn(async () => ({ success: false, steps: [], error: 'restart unavailable' })),
      stop: jest.fn(),
    };
    env = await createChatRouterEnv({ updateService: fakeUpdateService });
    const bundle = await createBundle(env.tmpDir);
    const preview = await env.multipartRequest(
      'POST',
      '/api/chat/migration/import/preview',
      'bundle',
      'agent-cockpit-export.acexport',
      'application/zip',
      await fsp.readFile(bundle),
    );

    const confirmed = await env.request('POST', '/api/chat/migration/import/confirm', {
      uploadId: preview.body.uploadId,
      confirmation: DATA_IMPORT_CONFIRMATION,
    });

    expect(confirmed.status).toBe(409);
    expect(confirmed.body.pending).toBe(false);
    expect(confirmed.body.error).toBe('restart unavailable');
    const controlDir = DataMigrationService.controlDirForDataRoot(path.join(env.tmpDir, 'data'));
    expect(fs.existsSync(path.join(controlDir, 'pending-import.json'))).toBe(false);
  });
});

async function waitForExportJob(jobId: string) {
  let latest = await env.request('GET', `/api/chat/migration/export/${jobId}/status`);
  for (let attempt = 0; attempt < 20 && latest.body?.status === 'running'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
    latest = await env.request('GET', `/api/chat/migration/export/${jobId}/status`);
  }
  return latest;
}

function rawRequest(method: string, urlPath: string, body: Buffer): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, env.baseUrl);
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'x-csrf-token': CSRF_TOKEN,
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode!, body: data, headers: res.headers });
        }
      });
    });
    req.setTimeout(2000, () => req.destroy(new Error(`Timed out waiting for ${method} ${urlPath}`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function createBundle(tmpDir: string): Promise<string> {
  const sourceRoot = path.join(tmpDir, 'source-data');
  await fsp.mkdir(path.join(sourceRoot, 'chat'), { recursive: true });
  await fsp.writeFile(path.join(sourceRoot, 'chat', 'settings.json'), '{"theme":"dark"}');
  const service = new DataMigrationService({
    dataRoot: sourceRoot,
    appVersion: '0.0.0-test',
    now: () => new Date('2026-05-21T12:00:00.000Z'),
  });
  return (await service.createExportBundle()).filePath;
}
