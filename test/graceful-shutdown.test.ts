import { spawn, type ChildProcess } from 'child_process';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const PORT = 3399;

function startServer(): ChildProcess {
  const tsxBin = path.join(ROOT, 'node_modules', '.bin', 'tsx');
  return spawn(tsxBin, ['server.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
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

function waitForReady(server: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start in time')), 10000);
    server.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('running on port')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function waitForExit(server: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.kill('SIGKILL');
      reject(new Error('Server did not exit within 5s'));
    }, 5000);
    server.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function testSignal(signal: NodeJS.Signals) {
  const server = startServer();
  let stdout = '';
  server.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
  server.stderr!.on('data', () => { /* collect stderr silently */ });

  await waitForReady(server);
  server.kill(signal);
  const exitCode = await waitForExit(server);

  expect(exitCode).toBe(0);
  expect(stdout).toContain(`Received ${signal}`);
  expect(stdout).toContain('HTTP server closed');
}

describe('graceful shutdown', () => {
  test('SIGINT shuts down gracefully', async () => {
    await testSignal('SIGINT');
  }, 15000);

  test('SIGTERM shuts down gracefully', async () => {
    await testSignal('SIGTERM');
  }, 15000);
});
