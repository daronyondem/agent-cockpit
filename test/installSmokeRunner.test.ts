import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const { runCommand, windowsPathCleanupFunction } = require('../scripts/run-install-smoke.js');

test('installer commands return when detached descendants retain inherited output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-command-'));
  const pidFile = path.join(root, 'child.pid');
  try {
    const output = runCommand(process.execPath, ['-e', `
const fs = require('fs'), { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { detached: true, stdio: 'inherit' });
fs.writeFileSync(process.argv[1], String(child.pid));
child.unref();
console.log('PARENT_COMPLETE');
`, pidFile], { timeout: 3000 }, root);
    expect(output.trim()).toBe('PARENT_COMPLETE');
  } finally {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      try { process.kill(pid, 'SIGTERM'); } catch {}
      for (let attempt = 0; attempt < 30; attempt++) {
        try { process.kill(pid, 0); } catch { break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('installer command failures retain their stderr diagnostics', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-command-'));
  try {
    expect(() => runCommand(process.execPath, ['-e', "console.error('BUILD_FAILED');process.exit(7)"], { timeout: 3000 }, root))
      .toThrow('BUILD_FAILED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const hasPowerShell = !spawnSync(shell, ['-NoProfile', '-Command', 'exit 0']).error;
(hasPowerShell ? test : test.skip)('Windows smoke cleanup preserves PATH entries added during the run', () => {
  const command = `
${windowsPathCleanupFunction}
$current = 'C:\\Existing;C:\\AddedDuringRun;D:/Fixture/cli-tools/;D:\\Fixture\\cli-tools-extra;C:\\Other'
Remove-SmokePathEntry $current 'd:\\fixture\\cli-tools'
`;
  const output = execFileSync(shell, ['-NoProfile', '-Command', command], { encoding: 'utf8' });
  expect(output.trim()).toBe('C:\\Existing;C:\\AddedDuringRun;D:\\Fixture\\cli-tools-extra;C:\\Other');
});
