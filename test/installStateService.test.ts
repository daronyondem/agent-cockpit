import fs from 'fs';
import os from 'os';
import path from 'path';
import { InstallStateService } from '../src/services/installStateService';

describe('InstallStateService', () => {
  let tmpDir: string;
  let appRoot: string;
  let dataRoot: string;
  let service: InstallStateService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-state-'));
    appRoot = path.join(tmpDir, 'app');
    dataRoot = path.join(tmpDir, 'data');
    fs.mkdirSync(appRoot, { recursive: true });
    fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
    service = new InstallStateService({ appRoot, dataRoot });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('infers dev main install when manifest is missing', () => {
    const status = service.getStatus();

    expect(status.channel).toBe('dev');
    expect(status.source).toBe('git-main');
    expect(status.repo).toBe('daronyondem/agent-cockpit');
    expect(status.version).toBe('1.2.3');
    expect(status.branch).toBe('main');
    expect(status.appDir).toBe(appRoot);
    expect(status.dataDir).toBe(dataRoot);
    expect(status.stateSource).toBe('inferred');
    expect(status.stateError).toBeNull();
  });

  test('reports corrupt manifest and falls back to inferred dev status', () => {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'install.json'), '{ bad json', 'utf8');

    const status = service.getStatus();

    expect(status.channel).toBe('dev');
    expect(status.source).toBe('git-main');
    expect(status.stateSource).toBe('corrupt');
    expect(status.stateError).toEqual(expect.any(String));
  });

  test('normalizes legacy manifest shape', () => {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(
      path.join(dataRoot, 'install.json'),
      JSON.stringify({ channel: 'production', source: 'github-release', version: '2.0.0' }),
      'utf8',
    );

    const status = service.getStatus();

    expect(status.schemaVersion).toBe(1);
    expect(status.channel).toBe('production');
    expect(status.source).toBe('github-release');
    expect(status.version).toBe('2.0.0');
    expect(status.branch).toBeNull();
    expect(status.stateSource).toBe('legacy');
    expect(status.stateError).toBeNull();
  });

  test('writes normalized manifest state and marks welcome completion', async () => {
    await service.writeState({
      channel: 'production',
      source: 'github-release',
      version: '3.0.0',
      installDir: path.join(tmpDir, 'install'),
      appDir: path.join(tmpDir, 'install', 'current'),
      dataDir: dataRoot,
      installedAt: '2026-05-11T00:00:00.000Z',
      nodeRuntime: {
        source: 'private',
        version: '22.22.3',
        npmVersion: '10.9.8',
        binDir: path.join(tmpDir, 'install', 'runtime', 'node', 'bin'),
        runtimeDir: path.join(tmpDir, 'install', 'runtime', 'node'),
        requiredMajor: 22,
        updatedAt: '2026-05-11T00:00:00.000Z',
      },
    });

    let status = service.getStatus();
    expect(status.stateSource).toBe('stored');
    expect(status.channel).toBe('production');
    expect(status.source).toBe('github-release');
    expect(status.nodeRuntime).toEqual(expect.objectContaining({
      source: 'private',
      version: '22.22.3',
      requiredMajor: 22,
    }));
    expect(status.welcomeCompletedAt).toBeNull();

    status = await service.markWelcomeCompleted('2026-05-12T00:00:00.000Z');
    expect(status.welcomeCompletedAt).toBe('2026-05-12T00:00:00.000Z');
    expect(JSON.parse(fs.readFileSync(service.getManifestPath(), 'utf8')).welcomeCompletedAt)
      .toBe('2026-05-12T00:00:00.000Z');
  });
});
