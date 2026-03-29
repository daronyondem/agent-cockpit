const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3399;

function startServer() {
  return spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForReady(server) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start in time')), 5000);
    server.stdout.on('data', (chunk) => {
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

function waitForExit(server) {
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

async function testSignal(signal) {
  const server = startServer();
  let stderr = '';
  let stdout = '';
  server.stdout.on('data', (d) => { stdout += d.toString(); });
  server.stderr.on('data', (d) => { stderr += d.toString(); });

  await waitForReady(server);
  server.kill(signal);
  const exitCode = await waitForExit(server);

  assert.strictEqual(exitCode, 0, `Expected exit code 0 for ${signal}, got ${exitCode}\nstderr: ${stderr}`);
  assert.ok(stdout.includes(`Received ${signal}`), `Expected shutdown log for ${signal}\nstdout: ${stdout}`);
  assert.ok(stdout.includes('HTTP server closed'), `Expected server closed log\nstdout: ${stdout}`);
}

async function run() {
  const tests = [
    ['SIGINT shuts down gracefully', () => testSignal('SIGINT')],
    ['SIGTERM shuts down gracefully', () => testSignal('SIGTERM')],
  ];

  let passed = 0;
  let failed = 0;

  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${name}`);
      console.log(`    ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
