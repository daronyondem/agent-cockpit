import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';

if (process.platform === 'win32') throw new Error('Copilot application workflow fixtures currently require POSIX; native Windows qualification remains pending.');
const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-workflows-compat-'));
const cli = process.env.COPILOT_WORKFLOW_CLI || 'copilot';
const evidence = {
  startedAt: new Date().toISOString(), cli: execFileSync(cli, ['--no-auto-update', '--version'], { encoding: 'utf8', timeout: 15000 }).trim(),
  sdk: JSON.parse(fs.readFileSync(path.join(__dirname, '../node_modules/@github/copilot-sdk/package.json'), 'utf8')).version as string,
  cliPath: cli, platform: process.platform, arch: process.arch, node: process.version,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  scope: 'Real Copilot SDK chat and JSONL processors with fixed local model replies, isolated auth/data and native tools. No hosted model judgment, account entitlement or cross-platform proof.',
};
const resultsPath = path.join(reportDir, 'jest-results.json');
const child = spawn(process.execPath, ['--experimental-vm-modules', require.resolve('jest/bin/jest'),
  'test/copilotWorkflows.e2e.test.ts', 'test/copilotKbRoutines.test.ts', '--runInBand', ...process.argv.slice(2), '--json', `--outputFile=${resultsPath}`], {
  stdio: 'inherit', env: { ...process.env, COPILOT_WORKFLOWS_E2E: '1', COPILOT_WORKFLOW_REPORT_DIR: reportDir },
});
const finish = (exitCode: number, error?: string) => {
  const results = fs.existsSync(resultsPath) ? JSON.parse(fs.readFileSync(resultsPath, 'utf8')) : {};
  const workflowsPath = path.join(reportDir, 'workflows.jsonl');
  const workflows = fs.existsSync(workflowsPath) ? fs.readFileSync(workflowsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const qualifiedExitCode = exitCode || (!workflows.length || !results.numPassedTests ? 1 : 0);
  fs.writeFileSync(path.join(reportDir, 'compatibility-report.json'), JSON.stringify({ ...evidence, finishedAt: new Date().toISOString(), exitCode: qualifiedExitCode,
    passed: results.numPassedTests ?? 0, failed: results.numFailedTests ?? 0, skipped: results.numPendingTests ?? 0, workflows,
    ...(error ? { error } : {}),
  }, null, 2));
  console.info(`Copilot application workflow report: ${reportDir}`);
  process.exitCode = qualifiedExitCode;
};
child.once('error', error => finish(1, error.message));
child.once('exit', code => finish(code ?? 1));
