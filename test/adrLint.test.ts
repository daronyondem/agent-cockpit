import { execFileSync } from 'child_process';
import fs from 'fs';
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

  test('keeps an explicit retired path-prefix allowance for archived public/v2 ADR references', () => {
    const root = path.join(__dirname, '..');
    const lintScript = fs.readFileSync(path.join(root, 'scripts/adr-lint.js'), 'utf8');

    expect(lintScript).toContain('RETIRED_PATH_PREFIXES');
    expect(lintScript).toContain("'public/v2/'");
    expect(lintScript).toContain('p.startsWith(prefix)');
  });
});
