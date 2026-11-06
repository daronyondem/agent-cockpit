import * as pty from 'node-pty';
import { startCortexLogin, type CortexLoginCallbacks } from '../src/services/cortexLogin';
import { CortexProcessScope } from '../src/services/backends/cortexProcess';

describe('Cortex native PTY login ownership', () => {
  afterEach(() => jest.restoreAllMocks());
  test('uses manual shared auth without a shell, owns its descendants, and stops idempotently', async () => {
    let onData!: (text: string) => void;
    let onExit!: (event: { exitCode: number }) => void;
    const dataDispose = jest.fn(), exitDispose = jest.fn(), write = jest.fn();
    const native = { pid: 1234567, write, kill: jest.fn(),
      onData: jest.fn(fn => { onData = fn; return { dispose: dataDispose }; }),
      onExit: jest.fn(fn => { onExit = fn; return { dispose: exitDispose }; }) };
    const spawn = jest.spyOn(pty, 'spawn').mockReturnValue(native as unknown as pty.IPty);
    const watch = jest.spyOn(CortexProcessScope.prototype, 'watch').mockImplementation(() => {});
    const stop = jest.spyOn(CortexProcessScope.prototype, 'stop').mockResolvedValue();
    const callbacks: CortexLoginCallbacks = { owner: jest.fn(), received: jest.fn(), ready: jest.fn(), failed: jest.fn(), exit: jest.fn() };
    const config = { command: '/pinned/cortex', args: [], cwd: '/private/synthetic', env: { CORTEX_OAUTH_MANUAL: '1' }, fingerprint: 'fixture' };
    const login = startCortexLogin(config, 'literal; $(no-shell)', callbacks);
    expect(spawn).toHaveBeenCalledWith('/pinned/cortex', expect.arrayContaining(['--no-auto-update', '--private', '-c', 'literal; $(no-shell)']),
      expect.objectContaining({ cwd: config.cwd, env: config.env }));
    expect(watch).toHaveBeenCalledTimes(1);
    onData('[N] Skip'); expect(write).toHaveBeenCalledWith('n');
    login.write('fixture\r'); expect(write).toHaveBeenLastCalledWith('fixture\r');
    await Promise.all([login.stop(), login.stop()]);
    expect(stop).toHaveBeenCalledTimes(1); expect(dataDispose).toHaveBeenCalledTimes(1); expect(exitDispose).toHaveBeenCalledTimes(1);
    expect(() => login.write('late')).toThrow('no longer active');
    onData('All tests passed!'); expect(callbacks.ready).not.toHaveBeenCalled();
    onExit({ exitCode: 0 }); expect(callbacks.exit).toHaveBeenCalledTimes(1);
  });
});
