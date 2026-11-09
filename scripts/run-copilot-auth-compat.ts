import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { resolveCopilotCliRuntime } from '../src/services/backends/copilotRuntime';
import { buildCliCommandInvocation } from '../src/services/cliCommandResolver';

const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-auth-compat-'));
const cli = process.env.COPILOT_AUTH_CLI || 'copilot';
const runtime = resolveCopilotCliRuntime({ id: 'auth-compat', name: 'Auth compatibility', harness: 'copilot',
  authMode: 'server-configured', command: cli, createdAt: '', updatedAt: '' });
const version = buildCliCommandInvocation(runtime, ['--no-auto-update', '--version']);
const evidence = {
  startedAt: new Date().toISOString(), cli: execFileSync(version.command, version.args, { env: runtime.env, encoding: 'utf8', timeout: 15000 }).trim(),
  sdk: '1.0.28', platform: process.platform, arch: process.arch, node: process.version,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  scope: 'Temporary auth home. Requests device codes and cancels without browser authorization. No hosted entitlement or two-account proof.',
};
const child = spawn(process.execPath, ['--experimental-vm-modules', require.resolve('jest/bin/jest'), 'test/copilotAuth.e2e.test.ts', '--runInBand', ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, COPILOT_AUTH_E2E: '1', COPILOT_AUTH_REPORT_DIR: reportDir },
});
const finish = (exitCode: number, error?: string) => {
  fs.writeFileSync(path.join(reportDir, 'compatibility-report.json'), JSON.stringify({ ...evidence, finishedAt: new Date().toISOString(), exitCode, ...(error ? { error } : {}) }, null, 2));
  console.info(`Copilot auth compatibility report: ${reportDir}`);
  process.exitCode = exitCode;
};
child.once('error', error => finish(1, error.message));
child.once('exit', code => finish(code ?? 1));
