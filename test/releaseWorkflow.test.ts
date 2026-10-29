import fs from 'fs';
import path from 'path';

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), '.github/workflows', file), 'utf8');

describe('production installer release gates', () => {
  test('publishes the same candidate artifact only after native smoke gates', () => {
    const source = read('release.yml');
    expect(source).toContain('needs: [candidate, platform-smoke]');
    expect(source).toContain('full_matrix: true');
    expect(source).toContain('if: ${{ !inputs.smoke_only }}');
    expect(source.match(/^\s+name: release-candidate$/gm)).toHaveLength(2);
    const publish = source.slice(source.indexOf('\n  release:'));
    expect(publish).toContain('actions/download-artifact@');
    expect(publish).not.toContain('release:package');
    expect(publish).not.toContain('npm version');
    expect(publish).toContain('dist/release/install-linux.sh');
  });

  test('runs actual production packages on native supported platforms and both runtimes', () => {
    const source = read('install-smoke.yml');
    for (const os of ['ubuntu-24.04', 'windows-latest', 'macos-15', 'macos-15-intel']) expect(source).toContain(os);
    expect(source).toContain('["system","private"]');
    expect(source).toContain('node scripts/run-install-smoke.js');
    expect(source).toContain('--release-dir candidate');
    expect(source).toContain('--auto-start');
    expect(source).toContain('--private-node');
    expect(source).toContain('--ui');
    expect(source).not.toContain('--channel dev');
    expect(source).toContain('if: always()');
  });

  test('checks relevant pull requests with the smaller native matrix', () => {
    const source = read('install.yml');
    expect(source).toContain('pull_request:');
    expect(source).toContain('npm run test:install');
    expect(source).toContain('uses: ./.github/workflows/install-smoke.yml');
    expect(source).not.toContain('full_matrix: true');
  });

  test('ADR checks fetch fork commits and do not push with a fork token', () => {
    const source = read('adr.yml');
    expect(source).toContain('ref: ${{ github.event.pull_request.head.sha }}');
    expect(source).toContain('CAN_PUSH_INDEX: ${{ github.event.pull_request.head.repo.full_name == github.repository }}');
    expect(source).toContain('if [[ "$CAN_PUSH_INDEX" == true &&');
    expect(source).not.toContain('ref: ${{ github.head_ref }}');
  });
});
