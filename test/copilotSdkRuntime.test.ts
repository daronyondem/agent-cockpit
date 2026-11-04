import fs from 'fs';
import os from 'os';
import path from 'path';
import { startCopilotSdkRuntime } from '../src/services/backends/copilotSdkRuntime';
import type { CopilotCliRuntime } from '../src/services/backends/copilotRuntime';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('Copilot owned SDK runtime', () => {
  let dir: string;
  let script: string;
  let log: string;
  let active: Awaited<ReturnType<typeof startCopilotSdkRuntime>> | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot sdk ü '));
    script = path.join(dir, 'peer.cjs');
    log = path.join(dir, 'calls.jsonl');
    fs.writeFileSync(script, `
const fs = require('fs');
const net = require('net');
const rpc = require(${JSON.stringify(require.resolve('vscode-jsonrpc/node'))});
const mode = process.argv[2];
const log = process.argv[3];
fs.writeFileSync(log, JSON.stringify({pid:process.pid,args:process.argv.slice(4),cwd:process.cwd(),fixture:process.env.SDK_FIXTURE,ownership:!!process.env.AGENT_COCKPIT_COPILOT_SCOPE,token:!!process.env.COPILOT_CONNECTION_TOKEN})+'\\n');
if (mode === 'exit') process.exit(7);
if (mode === 'silent') { setInterval(()=>{},1000); return; }
const server = net.createServer(socket => {
  const connection = rpc.createMessageConnection(socket,socket);
  connection.onRequest((method, params) => {
    fs.appendFileSync(log,JSON.stringify({method,tokenMatches:params?.token===process.env.COPILOT_CONNECTION_TOKEN})+'\\n');
    if (mode === 'handshake-hang') return new Promise(()=>{});
    if (method === 'connect') return {protocolVersion:mode==='old-protocol'?2:3};
    if (method === 'status.get' && mode === 'exit-on-status') { process.exit(7); }
    if (method === 'status.get') return {version:'fixture',protocolVersion:3};
    if (method === 'auth.getStatus') return {isAuthenticated:false};
    return {};
  });
  connection.listen();
});
server.listen(0,'127.0.0.1',()=>{
  process.stdout.write('Fixture boot\\nListening on po');
  setTimeout(()=>process.stdout.write('rt '+(mode==='invalid-port'?99999:server.address().port)+'\\n'),5);
});
`);
  });

  afterEach(async () => {
    await active?.stop();
    active = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const runtime = (mode = 'normal'): CopilotCliRuntime => ({
    command: process.execPath, argsPrefix: [script, mode, log], profileKey: 'fixture',
    env: { ...process.env, SDK_FIXTURE: 'café 日本語 😀' },
  });
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));

  test('connects the official SDK to an owned process with a fresh authenticated loopback connection', async () => {
    active = await startCopilotSdkRuntime(runtime(), dir);
    expect(await active.client.getStatus()).toEqual({ version: 'fixture', protocolVersion: 3 });
    expect(await active.client.getAuthStatus()).toEqual({ isAuthenticated: false });
    expect(calls()[0]).toMatchObject({
      cwd: fs.realpathSync(dir), fixture: 'café 日本語 😀', ownership: true, token: true,
      args: ['--headless', '--no-auto-update', '--log-level', 'none'],
    });
    expect(calls()).toContainEqual({ method: 'connect', tokenMatches: true });
    const pid = active.process.pid!;
    const stopping = active.stop();
    expect(active.stop()).toBe(stopping);
    expect((await active.closed).message).toBe('Copilot runtime stopped.');
    await stopping;
    expect(alive(pid)).toBe(false);
  }, 15000);

  test('cancels before spawn without starting a worker', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(startCopilotSdkRuntime(runtime(), dir, { abortSignal: controller.signal })).rejects.toThrow('startup aborted');
    expect(fs.existsSync(log)).toBe(false);
  });

  test('unexpected process exit force-closes without writing graceful session teardown to a dead socket', async () => {
    active = await startCopilotSdkRuntime(runtime('exit-on-status'), dir);
    const graceful = jest.spyOn(active.client, 'stop');
    const forced = jest.spyOn(active.client, 'forceStop');
    const status = active.client.getStatus().catch(error => error);
    expect((await active.closed).message).toContain('exited');
    await active.stop();
    expect(await status).toBeInstanceOf(Error);
    expect(graceful).not.toHaveBeenCalled();
    expect(forced).toHaveBeenCalled();
    expect(alive(active.process.pid!)).toBe(false);
  }, 15000);

  test('abort after startup closes the connection and owned process', async () => {
    const controller = new AbortController();
    active = await startCopilotSdkRuntime(runtime(), dir, { abortSignal: controller.signal });
    const pid = active.process.pid!;
    controller.abort();
    expect((await active.closed).message).toBe('Copilot runtime aborted.');
    await active.stop();
    expect(alive(pid)).toBe(false);
  }, 15000);

  test.each([
    ['silent', 'did not announce a port'],
    ['handshake-hang', 'handshake timed out'],
    ['invalid-port', 'invalid port'],
    ['old-protocol', 'protocol version mismatch'],
    ['exit', 'exited (7)'],
  ])('fails and drains owned workers for %s startup', async (mode, error) => {
    await expect(startCopilotSdkRuntime(runtime(mode), dir, { startupTimeoutMs: process.platform === 'win32' ? 5000 : 1500 })).rejects.toThrow(error);
    expect(alive(calls()[0].pid)).toBe(false);
  }, 15000);

  test('reports a missing executable without a lingering startup deadline', async () => {
    await expect(startCopilotSdkRuntime({ ...runtime(), command: path.join(dir, 'missing-executable') }, dir)).rejects.toThrow('ENOENT');
  });

  test('reports native exit even when the stream has no attached turn', async () => {
    active = await startCopilotSdkRuntime(runtime(), dir);
    active.process.kill('SIGTERM');
    expect((await active.closed).message).toContain('Copilot runtime exited');
    await active.stop();
    expect(alive(calls()[0].pid)).toBe(false);
  }, 15000);
});
