import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

describe('Cortex Linux native probe safety', () => {
  function rejectedBeforeNativeInvocation(enabled: string): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-linux-guard-'));
    try {
      const executable = path.join(root, 'cortex'), marker = path.join(root, 'invoked');
      fs.writeFileSync(executable, '#!/bin/sh\ntouch "$C52_MARKER"\n', { mode: 0o700 });
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/probe-cortex-linux.ts', '--preflight'], {
        encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, CORTEX_LINUX_PROBE: enabled, CORTEX_TEST_COMMAND: executable,
          CORTEX_TEST_CONNECTION: 'fixture', C52_MARKER: marker, TMPDIR: root },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Cortex Linux probe failed (AssertionError)');
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.readdirSync(root).some(name => name.startsWith('cockpit cortex linux '))).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  test('requires explicit opt-in', () => rejectedBeforeNativeInvocation(''));
  const nonLinux = process.platform !== 'linux' ? test : test.skip;
  nonLinux('rejects this non-Linux host before creating fixtures', () => rejectedBeforeNativeInvocation('1'));
});
