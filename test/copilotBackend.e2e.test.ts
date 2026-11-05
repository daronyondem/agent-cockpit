import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync } from 'child_process';
import { CopilotAdapter } from '../src/services/backends/copilot';
import { copilotUsageMetrics } from '../src/services/backends/copilotUsage';
import { startCopilotSdkRuntime } from '../src/services/backends/copilotSdkRuntime';
import { resolveCopilotCliRuntime } from '../src/services/backends/copilotRuntime';
import { copilotSessionConfig } from '../src/services/backends/copilotSessionConfig';
import { spawnCopilotProcess } from '../src/services/backends/copilotProcess';
import type { StreamEvent } from '../src/types';

const native = process.env.COPILOT_E2E === '1' ? describe : describe.skip;

native('real Copilot CLI compatibility', () => {
  let workdir: string;
  beforeAll(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-native-e2e-'));
    console.info('Copilot compatibility evidence', {
      cli: execFileSync('copilot', ['--no-auto-update', '--version'], { encoding: 'utf8' }).split('\n')[0],
      platform: process.platform, arch: process.arch,
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
    });
  });
  afterAll(() => { fs.rmSync(workdir, { recursive: true, force: true }); });

  (process.platform === 'win32' ? test.skip : test)('reaps orphaned native bash work with an isolated local model fixture', async () => {
    const fixtureDir = fs.mkdtempSync(path.join(workdir, 'orphan-'));
    const pidFile = path.join(fixtureDir, 'worker.pid');
    const worker = path.join(fixtureDir, 'worker.cjs');
    fs.writeFileSync(worker, `
process.on('SIGTERM', () => {});
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(pidFile + '.tmp')}, String(process.pid));
fs.renameSync(${JSON.stringify(pidFile + '.tmp')}, ${JSON.stringify(pidFile)});
setInterval(() => {}, 1000);
`);
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const command = `/bin/sh -c ${quote(`${quote(process.execPath)} ${quote(worker)} </dev/null >/dev/null 2>&1 &`)}`;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        const request = JSON.parse(body);
        // Leave the parent turn active after the shell finishes so stop, rather
        // than normal CLI completion, owns cancellation of the detached worker.
        if (request.messages.some((message: { role: string }) => message.role === 'tool')) return;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-shell', type: 'function', function: {
          name: 'bash', arguments: JSON.stringify({ command, description: 'Process cleanup fixture', initial_wait: 1000 }),
        } }] };
        for (const [content, reason] of [[delta, null], [{}, 'tool_calls']]) {
          res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'gpt-4', choices: [{ index: 0, delta: content, finish_reason: reason }] })}\n\n`);
        }
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const { proc, scope } = spawnCopilotProcess('copilot', [
      '-p', 'Run the supplied synthetic fixture command.', '--no-auto-update', '--disable-client-telemetry',
      '--disable-builtin-mcps', '--no-ask-user', '--allow-all', '--output-format', 'json', '--stream', 'on',
    ], {
      cwd: fixtureDir, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH, HOME: fixtureDir, COPILOT_HOME: fixtureDir,
        COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${port}/v1`, COPILOT_PROVIDER_TYPE: 'openai', COPILOT_MODEL: 'gpt-4',
      },
    });
    proc.stdout?.resume();
    let stderr = '';
    proc.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    const alive = (pid: number) => {
      try {
        return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z');
      } catch { return false; }
    };
    let workerPid: number | undefined;
    try {
      for (let i = 0; i < 500 && !fs.existsSync(pidFile) && proc.exitCode === null; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (!fs.existsSync(pidFile)) throw new Error(`Native bash did not start the fixture worker: ${stderr}`);
      workerPid = Number(fs.readFileSync(pidFile, 'utf8'));
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(alive(workerPid)).toBe(true);
      await scope.stop();
      expect(alive(workerPid)).toBe(false);
    } finally {
      await scope.stop();
      if (workerPid && alive(workerPid)) process.kill(workerPid, 'SIGKILL');
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 20_000);

  test('transports explicit image and PDF attachments without file tools', async () => {
    // Skipped native suites must not load the canvas GC worker in normal CI.
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(32, 32);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ff0000';
    context.fillRect(0, 0, 32, 32);
    const image = path.join(workdir, 'red.png');
    fs.writeFileSync(image, canvas.toBuffer('image/png'));
    const adapter = new CopilotAdapter({ workingDir: workdir });
    const text = await adapter.runOneShot('What is the dominant color of the attached image? Reply with one word. Do not use tools.', {
      attachments: [{ path: image, kind: 'image' }], timeoutMs: 60_000, model: 'gpt-6.1-sol',
    });
    expect(text.toLowerCase()).toContain('red');

    const content = 'BT /F1 18 Tf 36 120 Td (COPILOT_PDF_7315) Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (const [index, object] of objects.entries()) {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const document = path.join(workdir, 'marker.pdf');
    fs.writeFileSync(document, pdf);
    expect(await adapter.runOneShot('Read the single marker in the attached PDF. Reply with only that marker. Do not use tools.', {
      attachments: [{ path: document, kind: 'pdf' }], timeoutMs: 60_000, model: 'gpt-6.1-sol',
    })).toContain('COPILOT_PDF_7315');
  }, 135_000);

  test('injects and calls a local Memory-shaped MCP tool', async () => {
    const tool = path.join(workdir, 'memory-fixture.cjs');
    const calls = path.join(workdir, 'mcp-calls.jsonl');
    fs.writeFileSync(tool, `
const fs = require('fs');
const readline = require('readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') {
    result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  } else if (request.method === 'tools/list') {
    result = { tools: [{ name: 'memory_search', description: 'Find a synthetic compatibility marker', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }] };
  } else if (request.method === 'tools/call') {
    fs.appendFileSync(process.argv[2], JSON.stringify(request.params) + '\\n');
    result = { content: [{ type: 'text', text: 'MCP_PARITY_8741' }] };
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\\n');
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`);
    const adapter = new CopilotAdapter({ workingDir: workdir });
    const text = await adapter.runOneShot('Call memory_search with query "compatibility marker". Reply with only the marker returned by that tool.', {
      mcpServers: [{ name: 'agent-cockpit-memory', command: process.execPath, args: [tool, calls] }],
      timeoutMs: 60_000,
    });
    expect(text).toContain('MCP_PARITY_8741');
    expect(fs.readFileSync(calls, 'utf8')).toContain('"name":"memory_search"');
  }, 75_000);

  test('restricted one-shots, streamed text, native resume, and per-turn usage', async () => {
    const adapter = new CopilotAdapter({ workingDir: workdir });
    expect(await adapter.runOneShot('Reply with exactly PONG. Do not use tools.', { timeoutMs: 60_000, model: 'auto' })).toBe('PONG');

    async function turn(prompt: string, externalSessionId?: string) {
      const result = adapter.sendMessage(prompt, {
        sessionId: 'native-copilot-test', isNewSession: !externalSessionId,
        externalSessionId, workingDir: workdir, systemPrompt: 'Reply concisely. Do not use tools.',
      });
      const timer = setTimeout(() => result.abort(), 60_000);
      const events: StreamEvent[] = [];
      try {
        for await (const event of result.stream) events.push(event);
      } finally {
        clearTimeout(timer);
      }
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      expect(events.some(event => event.type === 'text' && event.streaming)).toBe(true);
      const session = events.find(event => event.type === 'external_session');
      const usage = events.find(event => event.type === 'usage');
      if (session?.type !== 'external_session' || usage?.type !== 'usage') throw new Error('Copilot omitted native session or usage');
      return {
        sessionId: session.sessionId,
        usage: usage.usage,
        text: events.filter((event): event is Extract<StreamEvent, { type: 'text' }> => event.type === 'text')
          .map(event => event.content).join(''),
      };
    }

    const first = await turn('Remember the marker COPILOT_PARITY_5729. Reply with exactly that marker.');
    expect(first.text.trim()).toBe('COPILOT_PARITY_5729');
    const second = await turn('What exact marker did I ask you to remember? Reply with only that marker.', first.sessionId);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.text.trim()).toBe('COPILOT_PARITY_5729');
    const runtime = resolveCopilotCliRuntime();
    const owned = await startCopilotSdkRuntime(runtime, workdir);
    let total;
    try {
      const session = await owned.client.resumeSession(first.sessionId, { ...copilotSessionConfig({ sessionId: 'native-ledger', isNewSession: false, systemPrompt: '', workingDir: workdir }, runtime.env, workdir), continuePendingWork: false });
      total = copilotUsageMetrics(await session.rpc.usage.getMetrics());
    } finally { await owned.stop(); }
    if (!total) throw new Error('Copilot omitted the saved usage checkpoint');
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'credits'] as const) {
      expect((first.usage[key] || 0) + (second.usage[key] || 0)).toBe(total[key] || 0);
    }
    expect(first.usage.costSource).toBe('none');
    expect(second.usage.costSource).toBe('none');
  }, 180_000);
});
