import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { CliProfile } from '../src/types';
import { CortexCodeAdapter } from '../src/services/backends/cortex';
import { CORTEX_RESTRICTED_DISTRIBUTION, CORTEX_RESTRICTED_DENY_TOOLS } from '../src/services/backends/cortexRestrictedPolicy';

const posix = process.platform === 'win32' ? describe.skip : describe;
posix('CoCo restricted native process fixture', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!, arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
  let dir: string, trace: string, profile: CliProfile, adapter: CortexCodeAdapter;
  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' }); Object.defineProperty(process, 'arch', { value: 'arm64' });
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c35-test-')); trace = path.join(dir, 'trace.jsonl');
    const command = path.join(dir, 'cortex'); await fs.copyFile(path.join(__dirname, 'fixtures/cortex/restricted.cjs'), command); await fs.chmod(command, 0o700);
    await fs.writeFile(path.join(dir, 'cortex-version.txt'), CORTEX_RESTRICTED_DISTRIBUTION);
    profile = { id: 'c35', name: 'Restricted fixture', harness: 'cortex-code', command, authMode: 'account',
      cortexCode: { connection: 'literal; $(no-shell)' }, env: { C35_FIXTURE_TRACE: trace, CORTEX_HOME: '/never-use', CORTEX_AGENT_MODE: 'pi' }, createdAt: '', updatedAt: '' };
    adapter = new CortexCodeAdapter({ workingDir: dir });
  });
  afterEach(async () => {
    adapter.shutdown(); await adapter.stopping;
    Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', arch);
    await fs.rm(dir, { recursive: true, force: true });
  });
  const options = () => ({ cliProfile: profile, model: 'claude-sonnet-4-6', effort: 'low' as const });
  const frames = async () => (await fs.readFile(trace, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  async function until(ready: () => Promise<boolean>) {
    for (let i = 0; i < 200 && !await ready(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(await ready()).toBe(true);
  }

  test('default and explicit false use a private native home/cwd, literal wrapped prompts and one sequential session', async () => {
    expect(await adapter.runSessionShot(['remember:NONCE', 'recall', '/sh touch forbidden'], options())).toEqual(['ANSWER', 'NONCE', 'ANSWER']);
    const rows = await frames(), start = rows.find(row => row.kind === 'start');
    expect(start.cwd).toBe(start.home); expect(start.cwd).not.toBe(dir);
    expect(start.controls).toEqual({ mode: 'standard', skills: '__all__', memory: '0' });
    expect(start.hooks).toEqual({ disableAllHooks: true });
    expect(start.args).toEqual(expect.arrayContaining(['--no-mcp', '--only-explicit-profiles', '--setting-sources', '', '-c', profile.cortexCode!.connection]));
    expect(start.args.slice(start.args.indexOf('--disallowed-tools') + 1)).toEqual(CORTEX_RESTRICTED_DENY_TOOLS);
    const prompts = rows.filter(row => row.kind === 'prompt'); expect(prompts).toHaveLength(3);
    expect(prompts[2].request.message.content[0].text.startsWith('/')).toBe(false);
    await expect(fs.stat(start.home)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await adapter.runOneShot('one', { ...options(), allowTools: false })).toBe('ANSWER');
    expect((await frames()).filter(row => row.kind === 'start')).toHaveLength(2);
  });

  test('rejects MCP/media, invalid effort/deadline, pre-abort and missing profiles without launching native work', async () => {
    await expect(adapter.runOneShot('one')).rejects.toThrow('explicit CLI profile');
    await expect(adapter.runOneShot('one', { ...options(), mcpServers: [{ name: 'never', command: 'never', args: [] }] })).rejects.toThrow('cannot accept MCP');
    await expect(adapter.runOneShot('one', { ...options(), attachments: [{ path: '/never', kind: 'image' }] })).rejects.toThrow('attachments');
    await expect(adapter.runOneShot('one', { ...options(), effort: 'ultra' })).rejects.toThrow('effort');
    await expect(adapter.runOneShot('one', { ...options(), timeoutMs: 0 })).rejects.toThrow('positive');
    await expect(adapter.runOneShot('one', { ...options(), abortSignal: AbortSignal.abort() })).rejects.toThrow('cancelled');
    expect(await adapter.runSessionShot([], options())).toEqual([]); expect(await frames()).toEqual([]);
  });

  test('rejects unknown version/distribution/platform before the headless launch', async () => {
    profile.env!.C35_FIXTURE_VERSION = '1.2.37';
    await expect(adapter.runOneShot('one', options())).rejects.toThrow('verified macOS arm64');
    delete profile.env!.C35_FIXTURE_VERSION;
    await fs.writeFile(path.join(dir, 'cortex-version.txt'), '1.2.35+999999.abcdef01234');
    await expect(adapter.runOneShot('one', options())).rejects.toThrow('verified macOS arm64');
    Object.defineProperty(process, 'arch', { value: 'x64' });
    expect(adapter.metadata.capabilities?.oneShot?.restrictedText).toBe(false);
    await expect(adapter.runOneShot('one', options())).rejects.toThrow('verified macOS arm64');
    expect(await frames()).toEqual([]);
  });

  test.each(['tools', 'hold'])('catalog %s cannot send a prompt', async init => {
    profile.env!.C35_FIXTURE_INIT = init;
    await expect(adapter.runOneShot('never', { ...options(), timeoutMs: 700 })).rejects.toThrow(init === 'hold' ? 'timed out' : 'tool-free protocol');
    expect((await frames()).filter(row => row.kind === 'prompt')).toHaveLength(0);
  });

  test('a removed pinned executable fails startup without claiming cleanup failed or replaying', async () => {
    profile.env!.C35_FIXTURE_REMOVE_SCRIPT = '1';
    await expect(adapter.runOneShot('never', options())).rejects.toThrow('restricted process failed');
    expect(await frames()).toEqual([]);
  });

  test.each(['tool', 'control', 'malformed', 'failure', 'partial', 'exit'])('native %s fails without replay or a second prompt', async input => {
    await expect(adapter.runSessionShot([input, 'never'], options())).rejects.toThrow(/restricted/);
    const rows = await frames(); expect(rows.filter(row => row.kind === 'prompt')).toHaveLength(1);
    await expect(fs.stat(rows[0].home)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('external abort and reusable shutdown drain active/starting jobs before removing homes', async () => {
    const abort = new AbortController();
    const pending = adapter.runOneShot('hold', { ...options(), abortSignal: abort.signal });
    const failed = expect(pending).rejects.toThrow('cancelled');
    await until(async () => (await frames()).some(row => row.kind === 'prompt')); abort.abort(); await failed;
    const stopped = adapter.runOneShot('hold', options()); const shutdown = expect(stopped).rejects.toThrow('shutdown');
    await until(async () => (await frames()).filter(row => row.kind === 'prompt').length === 2);
    adapter.shutdown(); await adapter.stopping; await shutdown;
    expect(await adapter.runOneShot('fresh', options())).toBe('ANSWER');
    profile.env!.C35_FIXTURE_INIT = 'hold';
    const starting = adapter.runOneShot('never', options()); const late = expect(starting).rejects.toThrow('shutdown');
    adapter.shutdown(); await adapter.stopping; await late;
    for (const row of (await frames()).filter(row => row.kind === 'start')) await expect(fs.stat(row.home)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
