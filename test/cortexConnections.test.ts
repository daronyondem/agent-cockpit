import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CortexConnections, cortexSnowflakeHome } from '../src/services/cortexConnections';
import { validateCortexConnectionCreate, validateCortexSetup, validateCortexRedirect } from '../src/contracts/cortexAuth';

describe('Cortex native connections', () => {
  let home: string;
  let store: CortexConnections;
  beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'cortex-connections-')); store = new CortexConnections(home); });
  afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });
  const input = { name: 'name "quoted".日本語; $(literal)', account: 'ORG-ACCOUNT.region', user: 'user "quoted" \\ 日本語' };

  test('appends safely quoted TOML, preserves original bytes/comments/secrets and creates private files atomically', async () => {
    const file = path.join(home, 'connections.toml');
    const original = '# Keep this comment\r\n[existing]\r\naccount = "EXAMPLE"\r\npassword = "secret-do-not-return"';
    await fs.writeFile(file, original, { mode: 0o644 });
    const result = await store.create(input);
    expect(await fs.readFile(file, 'utf8')).toMatch(new RegExp(`^${original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(JSON.stringify(result)).not.toMatch(/secret-do-not-return|ORG-ACCOUNT|quoted.*user/);
    expect(await store.selected(input.name)).toEqual({ name: input.name, manualOAuth: true, browserTimeoutMs: 600000 });
    const { parse } = await import('smol-toml');
    expect(parse(await fs.readFile(file, 'utf8'))[input.name]).toMatchObject({ account: input.account, user: input.user, client_store_temporary_credential: true });
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(home)).toEqual(['connections.toml']);
    await expect(store.create(input)).rejects.toThrow('already exists');
    expect(await fs.readFile(file, 'utf8')).toContain(original);
  });

  test('missing files enumerate empty, selected connection must exist, creation never overwrites a native default', async () => {
    expect(await store.list()).toEqual([]);
    await expect(store.selected('missing')).rejects.toThrow('unavailable');
    await store.create({ ...input, name: '__proto__' });
    expect((await store.list())[0].name).toBe('__proto__');
    expect(({} as Record<string, unknown>).account).toBeUndefined();
  });

  test('enumerates only names/capabilities with the native default timeout and handles snake-case timeout', async () => {
    await fs.writeFile(path.join(home, 'connections.toml'), 'scalar=1\n[a]\naccount="x"\nauthenticator="oauth_authorization_code"\n[b]\naccount="y"\nbrowserActionTimeout=2000\n[c]\nuser="z"\n[d]\naccount="x"\nbrowser_action_timeout=3000\n[e]\naccount="x"\nbrowserActionTimeout=-1\n');
    expect(await store.list()).toEqual([{ name: 'a', manualOAuth: true, browserTimeoutMs: 120000 }, { name: 'b', manualOAuth: false, browserTimeoutMs: 2000 },
      { name: 'd', manualOAuth: false, browserTimeoutMs: 3000 }, { name: 'e', manualOAuth: false, browserTimeoutMs: 120000 }]);
    expect(cortexSnowflakeHome({ SNOWFLAKE_HOME: '~/native' })).toBe(path.join(os.homedir(), 'native'));
    expect(cortexSnowflakeHome({})).toBe(path.join(os.homedir(), '.snowflake'));
  });

  test('malformed/oversized/symlinked files fail without exposing TOML source or replacing the original', async () => {
    const file = path.join(home, 'connections.toml');
    await fs.writeFile(file, '[broken\npassword="DO_NOT_EXPOSE"');
    await expect(store.list()).rejects.toThrow('Could not safely read');
    await expect(store.create(input)).rejects.not.toThrow('DO_NOT_EXPOSE');
    await fs.writeFile(file, 'x'.repeat(1024 * 1024 + 1));
    await expect(store.list()).rejects.toThrow('Could not safely read');
    if (process.platform !== 'win32') { // Windows symlink creation requires optional OS privileges.
      await fs.unlink(file);
      const target = path.join(home, 'other'); await fs.writeFile(target, ''); await fs.symlink(target, file);
      await expect(store.create(input)).rejects.toThrow('Could not safely read');
      expect(await fs.readFile(target, 'utf8')).toBe('');
    }
  });

  test('existing locks are never deleted; concurrent creates cannot silently lose a connection', async () => {
    const lock = path.join(home, '.cockpit-connections.lock');
    await fs.writeFile(lock, 'external owner');
    await expect(store.create(input)).rejects.toThrow('locked');
    expect(await fs.readFile(lock, 'utf8')).toBe('external owner');
    await fs.unlink(lock);
    const first = store.create(input);
    await expect(store.create({ ...input, name: 'second' })).rejects.toThrow('already running');
    await first;
    expect(await store.list()).toHaveLength(1);
  });

  test('external edits during a write are preserved and temporary files are removed', async () => {
    const read = jest.spyOn(store as unknown as { read(): Promise<{ raw: string; connections: object }> }, 'read');
    read.mockResolvedValueOnce({ raw: '', connections: {} }).mockResolvedValueOnce({ raw: '# external', connections: {} });
    await expect(store.create(input)).rejects.toThrow('changed during creation');
    expect(await fs.readdir(home)).toEqual([]);
  });

  test('atomic rename failure preserves the original and removes only owned temporary files', async () => {
    const file = path.join(home, 'connections.toml'); await fs.writeFile(file, '# unchanged\n');
    const rename = jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('PRIVATE_FILE_CONTENT'));
    try {
      await expect(store.create(input)).rejects.toThrow('Could not create');
      expect(await fs.readFile(file, 'utf8')).toBe('# unchanged\n');
      expect(await fs.readdir(home)).toEqual(['connections.toml']);
    } finally { rename.mockRestore(); }
  });

  test.each([
    null, { ...input, token: 'secret' }, { ...input, name: '' }, { ...input, name: 'x\n[other]' },
    { ...input, account: 'https://evil.invalid' }, { ...input, account: '../evil' }, { ...input, user: '\ud800' },
    { ...input, user: 123 }, { ...input, name: 'x'.repeat(129) },
  ])('rejects invalid connection input without echoing values %#', value => {
    expect(() => validateCortexConnectionCreate(value)).toThrow();
  });
  test('setup and redirect bodies accept only bounded declared strings', () => {
    expect(validateCortexSetup({ connection: 'native' })).toEqual({ connection: 'native' });
    expect(validateCortexRedirect({ generation: 'g', redirectUrl: 'http://127.0.0.1:1234/?code=x' })).toMatchObject({ generation: 'g' });
    expect(() => validateCortexSetup({ connection: 'n', account: 'secret' })).toThrow('Unexpected');
    expect(() => validateCortexRedirect({ generation: 'g', redirectUrl: 'x'.repeat(16385) })).toThrow('Redirect URL');
  });
});
