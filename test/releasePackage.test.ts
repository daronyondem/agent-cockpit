import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

const repoRoot = process.cwd();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isExcluded, normalizeVersion } = require('../scripts/package-release.js');

function writeFile(root: string, relPath: string, content = '') {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function makeFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cockpit-release-root-'));
  writeFile(root, 'package.json', JSON.stringify({ name: 'agent-cockpit', version: '1.2.3', engines: { node: '>=23' } }));
  writeFile(root, 'package-lock.json', '{}');
  writeFile(root, 'tsconfig.json', '{}');
  writeFile(root, 'server.ts', 'export {};\n');
  writeFile(root, 'README.md', '# Agent Cockpit\n');
  writeFile(root, 'SPEC.md', 'See docs/SPEC.md\n');
  writeFile(root, 'docs/SPEC.md', '# Spec\n');
  writeFile(root, 'src/index.ts', 'export {};\n');
  writeFile(root, 'scripts/tool.js', 'console.log("tool");\n');
  writeFile(root, 'scripts/install-macos.sh', '#!/usr/bin/env bash\n');
  writeFile(root, 'scripts/install-windows.ps1', 'Set-StrictMode -Version Latest\n');
  writeFile(root, 'web/AgentCockpitWeb/src/App.jsx', 'export default function App() { return null; }\n');
  writeFile(root, 'mobile/AgentCockpitPWA/src/main.tsx', 'export {};\n');
  writeFile(root, 'public/favicon.svg', '<svg />\n');
  writeFile(root, 'public/v2-built/index.html', '<!doctype html><div id="root"></div>\n');
  writeFile(root, 'public/v2-built/assets/index.js', 'console.log("web");\n');
  writeFile(root, 'public/mobile-built/index.html', '<!doctype html><div id="root"></div>\n');
  writeFile(root, 'public/mobile-built/assets/index.js', 'console.log("mobile");\n');

  writeFile(root, '.env', 'SECRET=1\n');
  writeFile(root, 'data/state.json', '{}');
  writeFile(root, 'ecosystem.config.js', 'module.exports = {};\n');
  writeFile(root, 'node_modules/package/index.js', 'module.exports = {};\n');
  writeFile(root, 'mobile/AgentCockpitPWA/node_modules/package/index.js', 'module.exports = {};\n');
  writeFile(root, 'plans/local.md', '# Local plan\n');
  writeFile(root, 'plan.md', '# Local plan\n');
  writeFile(root, 'coverage/report.txt', 'coverage\n');
  writeFile(root, 'public/.v2-built-staging-abc/index.html', 'staging\n');
  return root;
}

describe('release package script', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const dir of tmpRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('normalizes semver inputs', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
    expect(normalizeVersion('1.2.3-beta.1')).toBe('1.2.3-beta.1');
    expect(() => normalizeVersion('latest')).toThrow('Invalid release version');
  });

  test('matches release exclusions', () => {
    expect(isExcluded('data/state.json')).toBe(true);
    expect(isExcluded('.env')).toBe(true);
    expect(isExcluded('mobile/AgentCockpitPWA/node_modules/package/index.js')).toBe(true);
    expect(isExcluded('public/.mobile-built-staging-123/index.html')).toBe(true);
    expect(isExcluded('public/mobile-built/index.html')).toBe(false);
  });

  test('packages built web and mobile assets with manifest and checksums', () => {
    const root = makeFixtureRoot();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cockpit-release-out-'));
    tmpRoots.push(root, outDir);

    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts/package-release.js'),
        '--root',
        root,
        '--out-dir',
        outDir,
        '--version',
        '1.2.3',
        '--source-ref',
        'main',
        '--commit',
        'abc123',
      ],
      { cwd: repoRoot },
    );

    const tarballPath = path.join(outDir, 'agent-cockpit-v1.2.3.tar.gz');
    const zipPath = path.join(outDir, 'agent-cockpit-v1.2.3.zip');
    const manifestPath = path.join(outDir, 'release-manifest.json');
    const checksumsPath = path.join(outDir, 'SHA256SUMS');

    expect(fs.existsSync(tarballPath)).toBe(true);
    expect(fs.existsSync(zipPath)).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'install-macos.sh'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'install-windows.ps1'))).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.existsSync(checksumsPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      name: 'agent-cockpit',
      version: '1.2.3',
      channel: 'production',
      source: 'github-release',
      sourceRef: 'main',
      sourceCommit: 'abc123',
      packageRoot: 'agent-cockpit-v1.2.3',
      requiredBuilds: {
        web: 'public/v2-built/index.html',
        mobile: 'public/mobile-built/index.html',
      },
      requiredRuntime: {
        node: {
          engine: '>=23',
          minimumMajor: 23,
        },
      },
    });
    expect(manifest.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'agent-cockpit-v1.2.3.tar.gz',
        role: 'app-tarball',
        platform: 'darwin',
        format: 'tar.gz',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        name: 'agent-cockpit-v1.2.3.zip',
        role: 'app-zip',
        platform: 'win32',
        format: 'zip',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        name: 'install-macos.sh',
        role: 'macos-installer',
        platform: 'darwin',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        name: 'install-windows.ps1',
        role: 'windows-installer',
        platform: 'win32',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]));
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(
      expect.arrayContaining([
        'public/v2-built/index.html',
        'public/mobile-built/index.html',
        'src/index.ts',
        'web/AgentCockpitWeb/src/App.jsx',
        'mobile/AgentCockpitPWA/src/main.tsx',
      ]),
    );
    expect(manifest.files.map((file: { path: string }) => file.path)).not.toEqual(
      expect.arrayContaining([
        '.env',
        'data/state.json',
        'ecosystem.config.js',
        'node_modules/package/index.js',
        'mobile/AgentCockpitPWA/node_modules/package/index.js',
        'plan.md',
        'plans/local.md',
        'public/.v2-built-staging-abc/index.html',
      ]),
    );

    const checksums = fs.readFileSync(checksumsPath, 'utf8');
    expect(checksums).toContain('agent-cockpit-v1.2.3.tar.gz');
    expect(checksums).toContain('agent-cockpit-v1.2.3.zip');
    expect(checksums).toContain('release-manifest.json');
    expect(checksums).toContain('install-macos.sh');
    expect(checksums).toContain('install-windows.ps1');

    const tarList = execFileSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' });
    expect(tarList).toContain('agent-cockpit-v1.2.3/public/v2-built/index.html');
    expect(tarList).toContain('agent-cockpit-v1.2.3/public/mobile-built/index.html');
    expect(tarList).toContain('agent-cockpit-v1.2.3/scripts/install-macos.sh');
    expect(tarList).not.toContain('agent-cockpit-v1.2.3/.env');
    expect(tarList).not.toContain('agent-cockpit-v1.2.3/data/state.json');
    expect(tarList).not.toContain('agent-cockpit-v1.2.3/plan.md');

    const zip = new AdmZip(zipPath);
    const zipEntries = zip.getEntries().map((entry: { entryName: string }) => entry.entryName);
    expect(zipEntries).toEqual(expect.arrayContaining([
      'agent-cockpit-v1.2.3/public/v2-built/index.html',
      'agent-cockpit-v1.2.3/public/mobile-built/index.html',
      'agent-cockpit-v1.2.3/scripts/install-windows.ps1',
    ]));
    expect(zipEntries).not.toEqual(expect.arrayContaining([
      'agent-cockpit-v1.2.3/.env',
      'agent-cockpit-v1.2.3/data/state.json',
      'agent-cockpit-v1.2.3/plan.md',
    ]));
  });
});
