import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createCopilotLocalProvider } from '../test/helpers/copilotLocalProvider';
import { MEMORY_MARKER, type CopilotWorkflowPlan } from '../test/helpers/copilotWorkflowEnv';

async function main(): Promise<void> {
  if (process.platform === 'win32') throw new Error('The UI fixture launcher currently supports macOS/Linux. Run native Windows process tests separately.');
  const cwd = process.cwd();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-copilot-ui-'));
  const workspace = path.join(root, 'Desktop', 'copilot-fixture');
  const data = path.join(root, 'data');
  const cli = process.env.COPILOT_UI_CLI || 'copilot';
  const versionResult = spawnSync(cli, ['--no-auto-update', '--version'], { encoding: 'utf8' });
  if (versionResult.status !== 0) throw new Error(`Copilot CLI preflight failed: ${versionResult.error?.message || versionResult.stderr}`);
  const version = versionResult.stdout.split('\n')[0];
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(path.join(data, 'chat'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'AGENTS.md'), '# Browser fixture\nOnly perform synthetic fixture work. Report Memory failures without writing fallback memory files.\n');
  const plan: CopilotWorkflowPlan = {
    memoryOutput: JSON.stringify({ action: 'saved', reason: 'Durable synthetic project rule.', entry: `---\nname: fixture-project-rule\ndescription: Synthetic project identifier\ntype: project\n---\n\nThe permanent project identifier is ${MEMORY_MARKER}.` }),
    contextOutput: 'No Context changes.', sources: [],
  };
  const provider = await createCopilotLocalProvider(() => plan, workspace, MEMORY_MARKER);
  const launcher = path.join(root, 'copilot-fixture');
  const sdkLaunches = path.join(root, 'sdk-launches.log');
  await fs.writeFile(launcher, `#!${process.execPath}
if(process.argv.includes('--headless')) require('fs').appendFileSync(${JSON.stringify(sdkLaunches)},'SDK\\n');
const result = require('child_process').spawnSync(${JSON.stringify(cli)}, [...process.argv.slice(2), '--disable-client-telemetry', '--disable-builtin-mcps'], {
  stdio: 'inherit', env: { ...process.env, HOME: ${JSON.stringify(root)}, COPILOT_HOME: ${JSON.stringify(path.join(root, 'copilot-home'))},
    COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: ${JSON.stringify(provider.baseUrl)}, COPILOT_MODEL: 'gpt-4' }
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`);
  await fs.chmod(launcher, 0o755);
  const profileId = 'copilot-browser';
  const now = new Date().toISOString();
  await fs.writeFile(path.join(data, 'chat', 'settings.json'), JSON.stringify({
    theme: 'light', sendBehavior: 'enter', systemPrompt: 'Only perform the requested synthetic fixture work.',
    defaultBackend: 'copilot', defaultCliProfileId: profileId, workingDirectory: workspace,
    cliProfiles: [{ id: profileId, name: 'Copilot browser fixture', harness: 'copilot', authMode: 'server-configured', command: launcher, createdAt: now, updatedAt: now }],
    memory: { cliProfileId: profileId, cliModel: 'gpt-4' },
    workspaceContext: { scanIntervalMinutes: 1440, cliConcurrency: 1 },
  }, null, 2));
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port)); });
  });
  const app = `copilot-ui-${process.pid}`;
  const config = path.join(root, 'ecosystem.config.cjs');
  await fs.writeFile(config, `module.exports=${JSON.stringify({ apps: [{ name: app, cwd, script: 'server.ts', interpreter: process.execPath, node_args: ['--import', 'tsx'], autorestart: false,
    env: { NODE_ENV: 'test', PORT: port, BASE_PATH: '', AGENT_COCKPIT_DATA_DIR: data, AUTH_DATA_DIR: path.join(data, 'auth'), DEFAULT_WORKSPACE: workspace,
      SESSION_SECRET: `copilot-ui-fixture-${process.pid}`, WEB_BUILD_MODE: 'skip',
      COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: provider.baseUrl, COPILOT_PROVIDER_API_KEY: '', COPILOT_MODEL: 'gpt-4',
      COPILOT_GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '', GH_CONFIG_DIR: path.join(root, 'gh'), COPILOT_DISABLE_KEYTAR: '1' },
    out_file: path.join(root, 'server-out.log'), error_file: path.join(root, 'server-error.log'),
  }] })};\n`);
  const pm2 = (args: string[]) => spawnSync(process.execPath, [path.join(cwd, 'node_modules/pm2/bin/pm2'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, PM2_HOME: path.join(root, 'pm2') } });
  let exitCode = 1;
  let sdkRuntimeLaunches = 0;
  let pm2Started = false;
  let playwright: ChildProcess | undefined;
  let interrupted = false;
  const interrupt = () => { interrupted = true; playwright?.kill('SIGTERM'); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    for (const build of [{ cwd, args: ['build', '--config', 'web/AgentCockpitWeb/vite.config.ts'] }, { cwd: path.join(cwd, 'mobile/AgentCockpitPWA'), args: ['build'] }]) {
      if (spawnSync(process.execPath, [path.join(cwd, 'node_modules/vite/bin/vite.js'), ...build.args], { cwd: build.cwd, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } }).status !== 0) throw new Error('Production client build failed');
    }
    if (interrupted) throw new Error('Copilot UI run interrupted');
    pm2Started = true;
    if (pm2(['start', config, '--only', app]).status !== 0) throw new Error('Fixture PM2 startup failed');
    const baseUrl = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 120; i += 1) {
      if (interrupted) throw new Error('Copilot UI run interrupted');
      try { ready = (await fetch(`${baseUrl}/api/chat/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* starting */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error('Fixture server did not become ready');
    const browserExitCode = await new Promise<number>((resolve, reject) => {
      const child = playwright = spawn(process.execPath, [path.join(cwd, 'node_modules/playwright/cli.js'), 'test', 'test/e2e/copilot.ui.pw.ts', '--config', 'playwright.config.ts', '--project', 'chromium', ...process.argv.slice(2)], {
        cwd, stdio: 'inherit', env: { ...process.env, COPILOT_UI_E2E: '1', COPILOT_UI_WORKSPACE: workspace, COPILOT_UI_PROFILE_ID: profileId, AGENT_COCKPIT_E2E_BASE_URL: baseUrl },
      });
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
    if (browserExitCode === 0) {
      sdkRuntimeLaunches = (await fs.readFile(sdkLaunches, 'utf8')).trim().split('\n').filter(Boolean).length;
      if (!sdkRuntimeLaunches) throw new Error('Browser fixtures did not exercise SDK chat dispatch.');
    }
    exitCode = browserExitCode;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (pm2Started) { pm2(['delete', app]); pm2(['kill']); }
    await provider.close();
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const dirty = Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim());
    await fs.writeFile(path.join(root, 'compatibility-report.json'), JSON.stringify({ startedAt: now, finishedAt: new Date().toISOString(), revision, dirty, platform: process.platform, arch: process.arch, nodeVersion: process.version, copilotVersion: version, model: 'fixed local responses; isolated auth; no hosted account', sdkRuntimeLaunches, exitCode }, null, 2));
    process.stdout.write(`Copilot UI compatibility artifacts: ${root}\n`);
  }
  process.exitCode = exitCode;
}

main().catch(error => { process.stderr.write(`${(error as Error).stack || error}\n`); process.exitCode = 1; });
