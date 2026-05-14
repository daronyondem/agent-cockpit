import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';

const root = process.cwd();
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const artifactDir = process.env.CLAUDE_INTERACTIVE_UI_E2E_ARTIFACT_DIR
  || path.join(root, 'data', 'chat', 'claude-interactive-ui-e2e', stamp);
const dataDir = path.join(artifactDir, 'data');
const chatDataDir = path.join(dataDir, 'chat');
const workspaceDir = path.join(artifactDir, 'Desktop', 'test-workspace');
const profileId = process.env.CLAUDE_INTERACTIVE_UI_PROFILE_ID || 'cc-int-e2e';
const playwrightExtraArgs = process.argv.slice(2);

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  process.stderr.write(`${message}\n`);
  writeReport({
    port: null,
    serverStdout: '',
    serverStderr: '',
    playwrightStdout: '',
    playwrightStderr: message,
    exitCode: 1,
    signal: null,
    command: 'tsx scripts/run-claude-interactive-ui-e2e.ts',
  });
  process.exit(1);
});

async function main(): Promise<void> {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(chatDataDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  fs.writeFileSync(path.join(workspaceDir, 'README.md'), [
    '# Claude Code Interactive UI E2E Workspace',
    '',
    'This workspace is created by scripts/run-claude-interactive-ui-e2e.ts.',
    '',
  ].join('\n'));
  writeSettings();

  const build = spawnSync('npm', ['run', 'web:build'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (build.stdout) process.stdout.write(build.stdout);
  if (build.stderr) process.stderr.write(build.stderr);
  if (build.status !== 0 || build.error) {
    writeReport({
      port: null,
      serverStdout: '',
      serverStderr: '',
      playwrightStdout: '',
      playwrightStderr: build.stderr || build.error?.message || 'web build failed',
      exitCode: build.status ?? 1,
      signal: build.signal,
      command: 'npm run web:build',
    });
    process.exit(build.status === null ? 1 : build.status);
  }

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverLog = { stdout: '', stderr: '' };
  const server = startServer(port, serverLog);

  let playwrightResult: ReturnType<typeof spawnSync> | null = null;
  try {
    await waitForServer(baseUrl, server);
    const env = {
      ...process.env,
      CLAUDE_INTERACTIVE_UI_E2E: '1',
      CLAUDE_INTERACTIVE_UI_E2E_ARTIFACT_DIR: artifactDir,
      CLAUDE_INTERACTIVE_UI_DATA_DIR: dataDir,
      CLAUDE_INTERACTIVE_UI_PROFILE_ID: profileId,
      CLAUDE_INTERACTIVE_UI_SERVER_PID: String(server.pid || ''),
      CLAUDE_INTERACTIVE_UI_SERVER_PORT: String(port),
      CLAUDE_INTERACTIVE_UI_WORKSPACE: workspaceDir,
      AGENT_COCKPIT_E2E_BASE_URL: baseUrl,
    };
    playwrightResult = spawnSync(
      'npx',
      [
        'playwright',
        'test',
        'test/e2e/claudeCodeInteractive.ui.pw.ts',
        '--config',
        'playwright.config.ts',
        '--project',
        'chromium',
        ...playwrightExtraArgs,
      ],
      {
        cwd: root,
        env,
        encoding: 'utf8',
      },
    );
    if (playwrightResult.stdout) process.stdout.write(playwrightResult.stdout);
    if (playwrightResult.stderr) process.stderr.write(playwrightResult.stderr);
  } catch (err: unknown) {
    playwrightResult = {
      status: 1,
      signal: null,
      error: err instanceof Error ? err : new Error(String(err)),
      stdout: '',
      stderr: err instanceof Error ? err.stack || err.message : String(err),
      output: [],
      pid: 0,
    } as ReturnType<typeof spawnSync>;
  } finally {
    await stopServer(server);
  }

  const exitCode = playwrightResult.status === null ? 1 : playwrightResult.status;
  const finishedAt = new Date();
  writeReport({
    port,
    serverStdout: serverLog.stdout,
    serverStderr: serverLog.stderr,
    playwrightStdout: playwrightResult.stdout || '',
    playwrightStderr: playwrightResult.stderr || playwrightResult.error?.message || '',
    exitCode,
    signal: playwrightResult.signal,
    command: [
      'npx',
      'playwright',
      'test',
      'test/e2e/claudeCodeInteractive.ui.pw.ts',
      '--config',
      'playwright.config.ts',
      '--project',
      'chromium',
      ...playwrightExtraArgs,
    ].join(' '),
    finishedAt,
  });

  process.stdout.write(`\nClaude Code Interactive UI E2E artifacts: ${artifactDir}\n`);
  process.exit(exitCode);
}

function writeSettings(): void {
  const now = new Date().toISOString();
  const settings = {
    theme: 'system',
    sendBehavior: 'enter',
    systemPrompt: '',
    defaultBackend: 'claude-code-interactive',
    defaultCliProfileId: profileId,
    workingDirectory: workspaceDir,
    cliProfiles: [
      {
        id: profileId,
        name: 'CC-Int',
        vendor: 'claude-code',
        protocol: 'interactive',
        authMode: 'server-configured',
        command: 'claude',
        createdAt: now,
        updatedAt: now,
      },
    ],
    contextMap: {
      scanIntervalMinutes: 1440,
      cliConcurrency: 1,
      extractionConcurrency: 1,
      synthesisConcurrency: 1,
    },
  };
  fs.writeFileSync(path.join(chatDataDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function startServer(port: number, log: { stdout: string; stderr: string }): ChildProcess {
  const child = spawn('npm', ['start'], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      AGENT_COCKPIT_DATA_DIR: dataDir,
      AUTH_DATA_DIR: path.join(dataDir, 'auth'),
      DEFAULT_WORKSPACE: workspaceDir,
      SESSION_SECRET: 'claude-interactive-ui-e2e',
      WEB_BUILD_MODE: 'skip',
      CODEX_SANDBOX_MODE: 'danger-full-access',
      CODEX_APPROVAL_POLICY: 'never',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => {
    const text = chunk.toString();
    log.stdout += text;
    process.stdout.write(text);
  });
  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    log.stderr += text;
    process.stderr.write(text);
  });
  return child;
}

async function waitForServer(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`test server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/csrf-token`);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(500);
  }
  throw new Error(`test server did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  killGroup(child, 'SIGTERM');
  if (await raceWithTimeout(exited, 5_000)) return;
  killGroup(child, 'SIGKILL');
  await raceWithTimeout(exited, 5_000);
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Best effort cleanup.
    }
  }
}

async function raceWithTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeReport(input: {
  port: number | null;
  serverStdout: string;
  serverStderr: string;
  playwrightStdout: string;
  playwrightStderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  command: string;
  finishedAt?: Date;
}): void {
  const finishedAt = input.finishedAt || new Date();
  const report = [
    '# Claude Code Interactive UI E2E Report',
    '',
    `- Started: ${startedAt.toISOString()}`,
    `- Finished: ${finishedAt.toISOString()}`,
    `- Exit code: ${input.exitCode}`,
    `- Signal: ${input.signal || 'none'}`,
    `- Artifact directory: ${artifactDir}`,
    `- Data directory: ${dataDir}`,
    `- Workspace: ${workspaceDir}`,
    `- Base URL: ${input.port == null ? '(server not started)' : `http://127.0.0.1:${input.port}`}`,
    `- CLI profile: ${profileId}`,
    '',
    '## Command',
    '',
    '```sh',
    input.command,
    '```',
    '',
    '## Playwright stdout',
    '',
    '```text',
    trimForReport(input.playwrightStdout),
    '```',
    '',
    '## Playwright stderr',
    '',
    '```text',
    trimForReport(input.playwrightStderr),
    '```',
    '',
    '## Server stdout',
    '',
    '```text',
    trimForReport(input.serverStdout),
    '```',
    '',
    '## Server stderr',
    '',
    '```text',
    trimForReport(input.serverStderr),
    '```',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(artifactDir, 'report.md'), report);
  fs.writeFileSync(path.join(artifactDir, 'result.json'), `${JSON.stringify({
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    exitCode: input.exitCode,
    signal: input.signal,
    artifactDir,
    dataDir,
    workspaceDir,
    port: input.port,
    profileId,
  }, null, 2)}\n`);
}

function trimForReport(value: string | null | undefined): string {
  const text = value || '';
  const limit = 50_000;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} chars]`;
}
