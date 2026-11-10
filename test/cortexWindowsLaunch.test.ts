import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { execFile, spawn } from 'child_process';
import { startCortexRuntime, cortexVersion } from '../src/services/backends/cortexRuntime';
import { CortexProcessScope } from '../src/services/backends/cortexProcess';
import type { CortexRuntimeConfig } from '../src/types';

jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), execFile: jest.fn(), spawn: jest.fn() }));
jest.mock('../src/services/backends/cortexProcess', () => ({ CortexProcessScope: jest.fn() }));

describe('CoCo Windows ACP launch (simulated platform)', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const config: CortexRuntimeConfig = { command: 'C:\\CoCo space\\retained\\cortex.exe', args: ['acp', 'serve', '-c', 'literal & %PATH%'],
    cwd: 'C:\\Workspace space', env: { CORTEX_OAUTH_MANUAL: '1' }, fingerprint: 'fixture' };
  let stop: jest.Mock;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    jest.clearAllMocks(); stop = jest.fn().mockResolvedValue(undefined);
    jest.mocked(CortexProcessScope).mockImplementation(() => ({ watch: jest.fn(), pace: jest.fn(), stop }) as unknown as CortexProcessScope);
    jest.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], _options: unknown, callback: Function) => {
      callback(null, { stdout: 'Cortex Code v1.2.35' });
    }) as any);
  });
  afterEach(() => Object.defineProperty(process, 'platform', platform));

  test('version and ACP use the same executable, literal argv, hidden console and no detached Windows group', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 1234567, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin.on('data', data => {
      const request = JSON.parse(String(data));
      child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } })}\n`);
    });
    jest.mocked(spawn).mockReturnValue(child as any);
    const native = await startCortexRuntime(config);
    expect(execFile).toHaveBeenCalledWith(config.command, ['--no-auto-update', '--version'],
      expect.objectContaining({ cwd: config.cwd, env: config.env, windowsHide: true, timeout: 20000 }), expect.anything());
    expect(spawn).toHaveBeenCalledWith(config.command, config.args,
      { cwd: config.cwd, env: config.env, detached: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(native.version).toBe('1.2.35');
    await native.close(); expect(stop).toHaveBeenCalledTimes(1);
  });

  test('failed version/abort cannot launch ACP; a failed negotiation drains the owned process', async () => {
    jest.mocked(execFile).mockImplementation(((_c: string, _a: string[], _o: unknown, callback: Function) => callback(new Error('private error'))) as any);
    await expect(cortexVersion(config)).rejects.toThrow('version detection failed');
    expect(spawn).not.toHaveBeenCalled();
    jest.mocked(execFile).mockImplementation(((_c: string, _a: string[], _o: unknown, callback: Function) => callback(null, { stdout: 'Cortex Code v1.2.35' })) as any);
    const abort = new AbortController(); abort.abort();
    await expect(startCortexRuntime(config, undefined, abort.signal)).rejects.toThrow('cancelled');
    expect(spawn).not.toHaveBeenCalled();
    const child = Object.assign(new EventEmitter(), { pid: 1234567, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin.on('data', data => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(String(data)).id, result: { protocolVersion: 2 } })}\n`));
    jest.mocked(spawn).mockReturnValue(child as any);
    await expect(startCortexRuntime(config)).rejects.toThrow('ACP version 1');
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
