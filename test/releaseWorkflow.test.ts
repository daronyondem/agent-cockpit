import fs from 'fs';
import path from 'path';

const workflowPath = path.join(process.cwd(), '.github/workflows/release.yml');

function indexOfOrThrow(source: string, needle: string): number {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`Missing workflow text: ${needle}`);
  return index;
}

describe('release workflow', () => {
  const source = fs.readFileSync(workflowPath, 'utf8');

  test('runs platform smoke jobs before publishing release assets', () => {
    expect(source).toContain('windows-smoke:');
    expect(source).toContain('runs-on: windows-latest');
    expect(source).toContain('linux-smoke:');
    expect(source).toContain('runs-on: ubuntu-latest');
    expect(source).toContain('fetch-depth: 0');
    expect(source).toContain('smoke_only:');
    expect(source).toContain('needs: [windows-smoke, linux-smoke]');
    expect(source).toContain('if: ${{ !inputs.smoke_only }}');
    expect(source).toContain('test/updateService.test.ts -t Windows');
    expect(source).toContain('Parse Windows installer');
    expect(source).toContain('Package release on Windows');
    expect(source).toContain('Exercise Windows installer');
    expect(source).toContain('-Channel dev -DevDir $devDir -InstallDir $installDir -InstallNode -SkipOpen -Port $port');
    expect(source).toContain('schtasks.exe /Query /TN AgentCockpit');
    expect(source).toContain('Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "http://127.0.0.1:$port/auth/setup"');
    expect(source).toContain('Invoke-RestMethod -TimeoutSec 5 -Uri "http://127.0.0.1:$port/api/chat/install/doctor"');
    expect(source).toContain("foreach ($checkId in @('node', 'npm', 'pm2'))");
    expect(source).toContain('Install doctor required check failed');
    expect(source).toContain('test/updateService.test.ts -t Linux');
    expect(source).toContain('Parse Linux installer');
    expect(source).toContain('Package release on Linux');
    expect(source).toContain('Exercise Linux installer');
    expect(source).toContain('bash -n scripts/install-linux.sh');
    expect(source).toContain('./scripts/install-linux.sh --channel dev --dev-dir "$devDir" --install-dir "$installDir" --install-node --skip-open --port "$port"');
    expect(source).toContain("node - \"$port\" <<'NODE'");
    expect(source).toContain("for (const id of ['node', 'npm', 'pm2'])");
    expect(source).toContain('Install doctor request timed out');
    expect(source).toContain('"dist/release/install-linux.sh"');
  });

  test('builds Windows smoke release assets before packaging', () => {
    const windowsJob = indexOfOrThrow(source, 'windows-smoke:');
    const webBuild = indexOfOrThrow(source, '- run: npm run web:build');
    const mobileBuild = indexOfOrThrow(source, '- run: npm run mobile:build');
    const packageStep = indexOfOrThrow(source, '- name: Package release on Windows');
    const installerStep = indexOfOrThrow(source, '- name: Exercise Windows installer');

    expect(webBuild).toBeGreaterThan(windowsJob);
    expect(mobileBuild).toBeGreaterThan(windowsJob);
    expect(webBuild).toBeLessThan(packageStep);
    expect(mobileBuild).toBeLessThan(packageStep);
    expect(packageStep).toBeLessThan(installerStep);
    expect(source).toContain('npm run release:package -- --version 0.0.0-windows-smoke');
    expect(source).toContain("['app-tarball','linux','tar.gz']");
    expect(source).toContain("['linux-installer','linux',undefined]");
  });

  test('builds Linux smoke release assets before packaging', () => {
    const linuxJob = indexOfOrThrow(source, 'linux-smoke:');
    const packageStep = indexOfOrThrow(source, '- name: Package release on Linux');
    const installerStep = indexOfOrThrow(source, '- name: Exercise Linux installer');
    const linuxPackageCommand = indexOfOrThrow(source, 'npm run release:package -- --version 0.0.0-linux-smoke');

    expect(packageStep).toBeGreaterThan(linuxJob);
    expect(linuxPackageCommand).toBeGreaterThan(packageStep);
    expect(packageStep).toBeLessThan(installerStep);
    expect(source).toContain("['app-tarball','linux','tar.gz']");
    expect(source).toContain("['linux-installer','linux',undefined]");
  });
});
