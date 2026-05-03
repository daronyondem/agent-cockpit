import { execFileSync } from 'child_process';
import path from 'path';

describe('ADR lint script', () => {
  test('validates the repository ADR set', () => {
    const root = path.join(__dirname, '..');

    const output = execFileSync(process.execPath, ['scripts/adr-lint.js'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(output).toContain('All ');
    expect(output).toContain('ADR(s) valid.');
  });
});
