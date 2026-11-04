import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';

const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-sdk-compat-'));
const evidence = {
  startedAt: new Date().toISOString(), sdk: '1.0.28', platform: process.platform, arch: process.arch, node: process.version,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  model: 'fixed local OpenAI-compatible replies; isolated auth; no hosted account',
};
const child = spawn(process.execPath, ['--experimental-vm-modules', require.resolve('jest/bin/jest'), 'test/copilotSdkRuntime.e2e.test.ts', '--runInBand', ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, COPILOT_SDK_E2E: '1', COPILOT_SDK_REPORT_DIR: reportDir },
});
const finish = (exitCode: number, error?: string) => {
  const runtimeFile = path.join(reportDir, 'runtime.json');
  const runtime = fs.existsSync(runtimeFile) ? JSON.parse(fs.readFileSync(runtimeFile, 'utf8')) as { cli: string; protocolVersion: number } : { cli: null };
  fs.writeFileSync(path.join(reportDir, 'compatibility-report.json'), JSON.stringify({ ...evidence, ...runtime, finishedAt: new Date().toISOString(), exitCode, ...(error ? { error } : {}) }, null, 2));
  console.info(`Copilot SDK compatibility report: ${reportDir}`);
  process.exitCode = exitCode;
};
child.once('error', error => finish(1, error.message));
child.once('exit', code => finish(code ?? 1));
