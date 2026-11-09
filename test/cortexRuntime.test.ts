import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { CliProfile } from '../src/types';
import { cortexRecord, type CortexAcpClient } from '../src/services/backends/cortexProtocol';
import { CortexRuntime, cortexVersion, resolveCortexRuntime, startCortexRuntime, type CortexSessionOptions } from '../src/services/backends/cortexRuntime';
import { CortexSessions } from '../src/services/backends/cortexSessions';
import { CortexCodeAdapter } from '../src/services/backends/cortex';
import { BackendRegistry } from '../src/services/backends/registry';

// The deterministic executable is a POSIX shebang fixture; Windows has separate launch tests.
const runtimeSuite = process.platform === 'win32' ? describe.skip : describe;
runtimeSuite('CoCo POSIX runtime foundations', () => {
  let dir: string;
  let profile: CliProfile;
  let options: CortexSessionOptions;
  const runtimes: CortexRuntime[] = [];
  const pools: CortexSessions[] = [];
  beforeAll(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-runtime-')));
    const command = path.join(dir, 'cortex fixture');
    await fs.copyFile(path.join(__dirname, 'fixtures/cortex/acp.cjs'), command);
    await fs.chmod(command, 0o700);
    profile = { id: 'cortex-a', name: 'Test', harness: 'cortex-code', authMode: 'account', command,
      cortexCode: { connection: 'a "quoted" connection; $(not-a-command)' }, createdAt: '', updatedAt: '' };
    options = { profile, workspaceId: 'workspace-a', cwd: dir };
  });
  afterEach(async () => {
    await Promise.all(pools.splice(0).map(pool => pool.shutdown()));
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  async function start(input = options) {
    const runtime = await startCortexRuntime(resolveCortexRuntime(input));
    runtimes.push(runtime);
    return runtime;
  }
  function pool(startup = startCortexRuntime) { const value = new CortexSessions(startup); pools.push(value); return value; }
  const prompt = (runtime: CortexRuntime, text: string) => runtime.prompt([{ type: 'text', text }]);

  test('exact ACP argv preserves literal connection/cwd, forces managed env, and detects binary version', async () => {
    const runtime = await start({ ...options, profile: { ...profile, env: { CORTEX_ENABLE_MEMORY: '1', CORTEX_ACP_TEST_MODE: '1' } } });
    const state = cortexRecord(await runtime.client.request('_test/state'));
    expect(state.argv).toEqual(['acp', 'serve', '-c', profile.cortexCode!.connection, '-w', dir,
      '--only-explicit-plugins', '--only-explicit-skills', '--only-explicit-mcp-servers']);
    expect(state).toMatchObject({ cwd: dir, memory: '0', test: '0', manual: '1' });
    expect(runtime.version).toBe('1.2.35');
    expect(cortexRecord(runtime.init.agentInfo).version).toBe('1.0.0');
  });

  test('setup profiles retain shared auth; explicit profiles can resolve a separate home without changing executable', () => {
    const shared = resolveCortexRuntime({ ...options, profile: { ...profile, id: 'setup-cortex-code-account', configDir: '/private/home', env: { snowflake_home: '/private/other' } } });
    expect(shared.env.SNOWFLAKE_HOME).toBe(process.env.SNOWFLAKE_HOME);
    expect(shared.env.snowflake_home).toBeUndefined();
    const explicit = resolveCortexRuntime({ ...options, profile: { ...profile, configDir: '~/separate' } });
    expect(explicit.env.SNOWFLAKE_HOME).toBe(path.join(os.homedir(), 'separate'));
    expect(explicit.command).toBe(shared.command);
    expect(explicit.fingerprint).not.toBe(shared.fingerprint);
  });

  test('version detection and startup retain the same distribution when native activation changes', async () => {
    const alias = path.join(dir, 'activation'), updated = path.join(dir, 'new cortex');
    await fs.writeFile(updated, (await fs.readFile(profile.command!, 'utf8')).replace('Cortex Code v1.2.35', 'Cortex Code v1.2.37'), { mode: 0o700 });
    await fs.symlink(profile.command!, alias);
    const input = { ...options, profile: { ...profile, command: alias } };
    const pinned = resolveCortexRuntime(input);
    expect(pinned.command).toBe(await fs.realpath(profile.command!));
    await fs.unlink(alias); await fs.symlink(updated, alias);
    expect(await cortexVersion(pinned)).toBe('1.2.35');
    const later = resolveCortexRuntime(input);
    expect(await cortexVersion(later)).toBe('1.2.37');
    expect(later.fingerprint).not.toBe(pinned.fingerprint);
    const runtime = await startCortexRuntime(pinned); runtimes.push(runtime);
    expect(runtime.version).toBe('1.2.35');
  });

  test('resolution rejects invalid profiles and command absence without leaking values', () => {
    expect(() => resolveCortexRuntime({ ...options, profile: { ...profile, disabled: true } })).toThrow('enabled');
    expect(() => resolveCortexRuntime({ ...options, profile: { ...profile, cortexCode: undefined } })).toThrow(/connection/);
    expect(() => resolveCortexRuntime({ ...options, profile: { ...profile, command: '/private/no-such-command' } })).toThrow('executable is unavailable');
    expect(() => resolveCortexRuntime({ ...options, profile: { ...profile, command: 'missing-cortex-processor', env: { PATH: dir } } })).toThrow('executable was not found');
  });

  test('version/protocol failures are bounded and cleaned up', async () => {
    const bad = (env: Record<string, string>) => resolveCortexRuntime({ ...options, profile: { ...profile, env } });
    await expect(cortexVersion(bad({ FIXTURE_BAD_VERSION: '1' }))).rejects.toThrow('version detection failed');
    await expect(startCortexRuntime(bad({ FIXTURE_BAD_PROTOCOL: '1' }))).rejects.toThrow('ACP version 1');
  });

  test('cancelled startup cannot leave a version probe or spawn a new ACP owner', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(cortexVersion(resolveCortexRuntime(options), abort.signal)).rejects.toThrow('version detection failed');
    await expect(startCortexRuntime(resolveCortexRuntime(options), jest.fn(), abort.signal)).rejects.toThrow('version detection failed');
  });

  test('load suppresses replay, preserves session ID, and new turns still emit updates', async () => {
    const runtime = await start();
    const frames: unknown[] = [];
    runtime.subscribe(frame => { frames.push(frame); });
    await runtime.prepare('existing-session');
    expect(frames).toEqual([]);
    expect(runtime.sessionId).toBe('existing-session');
    await prompt(runtime, 'hello');
    expect(frames).toHaveLength(1);
    expect(runtime.configOptions).toHaveLength(1);
  });

  test('native cancel keeps a healthy session usable, forbids overlapping prompts and never retries', async () => {
    const runtime = await start();
    await expect(prompt(runtime, 'not-ready')).rejects.toThrow('not prepared');
    await runtime.prepare();
    const pending = prompt(runtime, 'wait');
    await expect(prompt(runtime, 'overlap')).rejects.toThrow('active prompt');
    await runtime.cancel(500);
    expect(await pending).toEqual({ stopReason: 'cancelled' });
    expect(runtime.client.isClosed).toBe(false);
    await expect(prompt(runtime, 'next')).resolves.toEqual({ stopReason: 'end_turn' });
    expect(cortexRecord(await runtime.client.request('_test/state')).prompts).toBe(2);
    await runtime.cancel();
  });

  test('unresponsive cancel terminates runtime and rejects prompt rather than retrying', async () => {
    const runtime = await start({ ...options, profile: { ...profile, env: { FIXTURE_IGNORE_CANCEL: '1' } } });
    await runtime.prepare();
    const pending = prompt(runtime, 'wait');
    const failed = expect(pending).rejects.toThrow('cancellation');
    await runtime.cancel(10);
    await failed;
    expect(runtime.client.isClosed).toBe(true);
    expect(runtime.client.process.exitCode !== null || runtime.client.process.signalCode !== null).toBe(true);
  });

  test('concurrent conversation startup has one owner; independent conversations remain separate', async () => {
    const startSpy = jest.fn(startCortexRuntime);
    const sessions = pool(startSpy);
    const first = sessions.acquire('one', options);
    await expect(sessions.acquire('one', options)).rejects.toThrow('already active');
    const [a, b] = await Promise.all([first, sessions.acquire('two', options)]);
    expect(a).not.toBe(b);
    sessions.release('one', a);
    expect(await sessions.acquire('one', options)).toBe(a);
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  test('profile, workspace, cwd, executable/env and context changes invalidate runtime fingerprints', async () => {
    const sessions = pool();
    let previous = await sessions.acquire('one', options);
    const secondDir = path.join(dir, 'moved');
    await fs.mkdir(secondDir, { recursive: true });
    for (const changed of [
      { ...options, workspaceId: 'workspace-b' }, { ...options, cwd: secondDir },
      { ...options, profile: { ...profile, id: 'cortex-b' } },
      { ...options, profile: { ...profile, env: { FIXTURE_MODEL: 'model-b' } } },
      { ...options, contextKey: 'instructions-v2', pluginDir: dir },
    ]) {
      sessions.release('one', previous);
      const next = await sessions.acquire('one', changed);
      expect(next).not.toBe(previous);
      expect(previous.client.isClosed).toBe(true);
      previous = next;
    }
  });

  test('each effective ownership input independently changes the fingerprint, including executable replacement', async () => {
    const baseline = resolveCortexRuntime(options).fingerprint;
    for (const changed of [
      { ...options, workspaceId: 'other-workspace' }, { ...options, cwd: path.join(dir, 'other') },
      { ...options, contextKey: 'v2' }, { ...options, pluginDir: dir },
      { ...options, profile: { ...profile, id: 'other-profile' } },
      { ...options, profile: { ...profile, cortexCode: { connection: 'other-connection' } } },
      { ...options, profile: { ...profile, env: { FIXTURE_MODEL: 'other-model' } } },
    ]) expect(resolveCortexRuntime(changed).fingerprint).not.toBe(baseline);
    const previous = await fs.stat(profile.command!);
    await fs.utimes(profile.command!, previous.atime, new Date(previous.mtimeMs + 1000));
    expect(resolveCortexRuntime(options).fingerprint).not.toBe(baseline);
  });

  test('session close is idempotent and prevents new prompt work while closing', async () => {
    const runtime = await start();
    await runtime.prepare();
    const request = jest.spyOn(runtime.client, 'request');
    const first = runtime.close();
    expect(runtime.close()).toBe(first);
    await expect(prompt(runtime, 'late')).rejects.toThrow('closing');
    await first;
    expect(request.mock.calls.filter(([method]) => method === 'session/close')).toHaveLength(1);
  });

  test('discovery is scoped to profile and failures never return a stale catalog', async () => {
    const sessions = pool();
    expect((await sessions.discover(options)).configOptions).toEqual([{ id: 'model', options: [{ value: 'model-a' }] }]);
    const alternate = { ...options, profile: { ...profile, env: { FIXTURE_MODEL: 'model-b' } } };
    expect((await sessions.discover(alternate)).configOptions).toEqual([{ id: 'model', options: [{ value: 'model-b' }] }]);
    await expect(sessions.discover({ ...options, profile: { ...profile, env: { FIXTURE_CATALOG_FAIL: '1' } } })).rejects.toThrow('catalog unavailable');
  });

  test('reset while startup is late closes it and allows a fresh acquisition', async () => {
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    let late: CortexAcpClient | undefined;
    const sessions = pool(async (config, onClient) => {
      await gate;
      return startCortexRuntime(config, client => { late = client; onClient?.(client); });
    });
    const pending = sessions.acquire('one', options);
    const rejected = expect(pending).rejects.toThrow(/reset|stopped/);
    const reset = sessions.reset('one');
    unblock();
    await Promise.all([rejected, reset]);
    expect(late).toBeDefined();
    expect(late!.isClosed).toBe(true);
    expect(late!.process.exitCode !== null || late!.process.signalCode !== null).toBe(true);
    expect((await sessions.acquire('one', options)).client.isClosed).toBe(false);
  });

  test('idle eviction skips active leases, reset rejects pending RPCs and clears reverse interactions', async () => {
    const sessions = pool();
    const active = await sessions.acquire('active', options);
    const idle = await sessions.acquire('idle', options);
    sessions.release('idle', idle);
    await sessions.evictIdle(0);
    expect(idle.client.isClosed).toBe(true);
    expect(active.client.isClosed).toBe(false);
    const pending = prompt(active, 'wait');
    const rejected = expect(pending).rejects.toThrow('stopped');
    await sessions.reset('active');
    await rejected;
  });

  test('shutdown generation closes pending startups and remains reusable through BackendRegistry.shutdownAll', async () => {
    const sessions = pool();
    const registry = new BackendRegistry();
    const adapter = new CortexCodeAdapter({ sessions });
    registry.register(adapter);
    const first = await sessions.acquire('one', options);
    const pending = sessions.acquire('late', options);
    const rejected = expect(pending).rejects.toThrow(/reset|stopped/);
    registry.shutdownAll();
    await rejected;
    await adapter.stopping;
    expect(first.client.isClosed).toBe(true);
    expect((await sessions.acquire('one', options)).client.isClosed).toBe(false);
  });
});
