import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(__dirname, '..');
const PORT = 3399;
const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function startServer(): ChildProcess {
  const tsxPreflight = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'preflight.cjs');
  const tsxLoader = pathToFileURL(path.join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  return spawn(process.execPath, ['--require', tsxPreflight, '--import', tsxLoader, path.join(ROOT, 'server.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      SESSION_SECRET: 'test-secret',
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_CALLBACK_URL: 'http://localhost:3399/auth/google/callback',
      ALLOWED_EMAIL: 'test@test.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function formatServerOutput(stdout: string, stderr: string): string {
  return [
    '--- stdout ---',
    stdout.trim() || '(empty)',
    '--- stderr ---',
    stderr.trim() || '(empty)',
  ].join('\n');
}

function waitForReady(server: ChildProcess, getOutput: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.stdout!.off('data', onStdout);
      server.off('error', onError);
      server.off('close', onClose);
      if (err) reject(err);
      else resolve();
    };

    const onStdout = (chunk: Buffer) => {
      if (chunk.toString().includes('running on port')) {
        finish();
      }
    };
    const onError = (err: Error) => finish(err);
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`Server exited before ready (code=${code}, signal=${signal})\n${getOutput()}`));
    };

    timeout = setTimeout(() => {
      server.kill('SIGKILL');
      finish(new Error(`Server did not start in time on port ${PORT}\n${getOutput()}`));
    }, 10000);

    server.stdout!.on('data', onStdout);
    server.on('error', onError);
    server.on('close', onClose);
  });
}

function waitForExit(server: ChildProcess): Promise<ExitResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.kill('SIGKILL');
      reject(new Error('Server did not exit within 5s'));
    }, 5000);
    server.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function testSignal(signal: NodeJS.Signals) {
  const server = startServer();
  let stdout = '';
  let stderr = '';
  server.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
  server.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

  await waitForReady(server, () => formatServerOutput(stdout, stderr));
  server.kill(signal);
  const exit = await waitForExit(server);
  const output = formatServerOutput(stdout, stderr);

  if (!stdout.includes(`Received ${signal}`)) {
    throw new Error(`Server did not log receipt of ${signal}\n${output}`);
  }
  if (!stdout.includes('HTTP server closed')) {
    throw new Error(`Server did not close HTTP server after ${signal}\n${output}`);
  }

  const signalExitCode = SIGNAL_EXIT_CODES[signal];
  const gracefulExit = exit.code === 0 || exit.code === signalExitCode || exit.signal === signal;
  if (!gracefulExit) {
    throw new Error(
      `Expected graceful exit for ${signal}, got code=${exit.code}, signal=${exit.signal}\n${output}`,
    );
  }
}

describe('graceful shutdown', () => {
  test('SIGINT shuts down gracefully', async () => {
    await testSignal('SIGINT');
  }, 15000);

  test('SIGTERM shuts down gracefully', async () => {
    await testSignal('SIGTERM');
  }, 15000);
});
