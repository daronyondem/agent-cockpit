import fs from 'fs';
import os from 'os';
import path from 'path';
import { InstallDoctorService } from '../src/services/installDoctorService';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-doctor-root-'));
  fs.mkdirSync(path.join(root, 'public/v2-built'), { recursive: true });
  fs.mkdirSync(path.join(root, 'public/mobile-built'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public/v2-built/index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(root, 'public/mobile-built/index.html'), '<!doctype html>');
  return root;
}

function makeInstallState(root: string, overrides: Record<string, unknown> = {}) {
  return {
    getStatus: () => ({
      schemaVersion: 1,
      channel: 'production',
      source: 'github-release',
      repo: 'daronyondem/agent-cockpit',
      version: '1.2.3',
      branch: null,
      installDir: root,
      appDir: root,
      dataDir: path.join(root, 'data'),
      installedAt: '2026-05-12T00:00:00.000Z',
      welcomeCompletedAt: null,
      nodeRuntime: null,
      stateSource: 'stored',
      stateError: null,
      ...overrides,
    }),
  } as any;
}

describe('InstallDoctorService', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports required runtime checks and optional tools', async () => {
    const root = makeRoot();
    roots.push(root);
    const dataRoot = path.join(root, 'data');
    const service = new InstallDoctorService({
      appRoot: root,
      dataRoot,
      installStateService: makeInstallState(root),
      updateService: {
        getStatus: () => ({
          localVersion: '1.2.3',
          remoteVersion: '1.2.4',
          updateAvailable: true,
          lastCheckAt: null,
          lastError: null,
          updateInProgress: false,
          installChannel: 'production',
          installSource: 'github-release',
          installStateSource: 'stored',
        }),
      } as any,
      commandRunner: async () => ({ ok: true, stdout: '1.0.0', stderr: '' }),
      detectPandoc: async () => ({ available: true, binaryPath: '/usr/local/bin/pandoc', version: '3.1.1', checkedAt: '2026-05-12T00:00:00.000Z' }),
      detectLibreOffice: async () => ({ available: true, binaryPath: '/usr/local/bin/soffice', checkedAt: '2026-05-12T00:00:00.000Z' }),
    });

    const status = await service.getStatus();

    expect(status.overallStatus).toBe('ok');
    expect(status.install.channel).toBe('production');
    expect(status.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'node', status: 'ok', required: true }),
      expect.objectContaining({ id: 'npm', status: 'ok', required: true }),
      expect.objectContaining({ id: 'pm2', status: 'ok', required: true }),
      expect.objectContaining({ id: 'data-dir', status: 'ok', required: true }),
      expect.objectContaining({ id: 'web-build', status: 'ok', required: true }),
      expect.objectContaining({ id: 'mobile-build', status: 'ok' }),
      expect.objectContaining({ id: 'pandoc', status: 'ok' }),
      expect.objectContaining({ id: 'libreoffice', status: 'ok' }),
      expect.objectContaining({ id: 'update-channel', status: 'ok', detail: expect.stringContaining('remote=1.2.4') }),
    ]));
  });

  test('surfaces required errors and optional warnings', async () => {
    const root = makeRoot();
    roots.push(root);
    fs.rmSync(path.join(root, 'public/v2-built/index.html'));
    const dataRoot = path.join(root, 'data-as-file');
    fs.writeFileSync(dataRoot, 'not a directory');
    const service = new InstallDoctorService({
      appRoot: root,
      dataRoot,
      installStateService: makeInstallState(root, { stateSource: 'corrupt', stateError: 'bad json' }),
      commandRunner: async (command) => {
        if (command === 'npm') return { ok: false, stdout: '', stderr: '', error: 'missing npm' };
        return { ok: true, stdout: '1.0.0', stderr: '' };
      },
      detectPandoc: async () => ({ available: false, binaryPath: null, version: null, checkedAt: '2026-05-12T00:00:00.000Z' }),
      detectLibreOffice: async () => ({ available: false, binaryPath: null, checkedAt: '2026-05-12T00:00:00.000Z' }),
    });

    const status = await service.getStatus();

    expect(status.overallStatus).toBe('error');
    expect(status.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'npm', status: 'error', required: true }),
      expect.objectContaining({ id: 'data-dir', status: 'error', required: true }),
      expect.objectContaining({ id: 'web-build', status: 'error', required: true }),
      expect.objectContaining({ id: 'pandoc', status: 'warning', required: false }),
      expect.objectContaining({ id: 'libreoffice', status: 'warning', required: false }),
      expect.objectContaining({ id: 'update-channel', status: 'warning', required: false }),
    ]));
  });
});
