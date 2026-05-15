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

  test('runs Windows smoke before publishing release assets', () => {
    expect(source).toContain('windows-smoke:');
    expect(source).toContain('runs-on: windows-latest');
    expect(source).toContain('fetch-depth: 0');
    expect(source).toContain('smoke_only:');
    expect(source).toContain('needs: windows-smoke');
    expect(source).toContain('if: ${{ !inputs.smoke_only }}');
    expect(source).toContain('test/updateService.test.ts -t Windows');
    expect(source).toContain('Parse Windows installer');
    expect(source).toContain('Package release on Windows');
    expect(source).toContain('Exercise Windows installer');
    expect(source).toContain('-Channel dev -DevDir $devDir -InstallDir $installDir -InstallNode -SkipOpen -Port $port');
    expect(source).toContain('schtasks.exe /Query /TN AgentCockpit');
    expect(source).toContain('Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "http://127.0.0.1:$port/auth/setup"');
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
  });
});
