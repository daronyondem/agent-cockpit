import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CliProfileAuthService, redactCliAuthText, type CliAuthJobSnapshot } from '../src/services/cliProfileAuthService';
import type { CliProfile, Settings } from '../src/types';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = jest.fn(() => true);
}

type SpawnCall = {
  command: string;
  args: string[];
  opts: unknown;
  child: FakeChild;
};

type SpawnHandler = (call: SpawnCall, index: number) => void;

describe('CliProfileAuthService', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-profile-auth-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeService(spawn = createSpawn(() => {}), opts: Partial<ConstructorParameters<typeof CliProfileAuthService>[1]> = {}): CliProfileAuthService {
    return new CliProfileAuthService(tmpDir, {
      spawn: spawn as never,
      authTimeoutMs: 150,
      statusPollTimeoutMs: 120,
      statusPollIntervalMs: 20,
      ...opts,
    });
  }

  function makeProfile(overrides: Partial<CliProfile> = {}): CliProfile {
    const harness = overrides.harness ?? 'claude-code';
    return {
      id: 'profile-claude',
      name: 'Claude Profile',
      harness,
      authMode: 'account',
      command: path.join(tmpDir, harness === 'codex' ? 'codex' : harness === 'opencode' ? 'opencode' : 'claude'),
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      ...overrides,
    };
  }

  function makeSettings(profiles: CliProfile[]): Settings {
    return {
      theme: 'system',
      sendBehavior: 'enter',
      systemPrompt: '',
      cliProfiles: profiles,
    };
  }

  function createSpawn(handler: SpawnHandler): jest.Mock {
    const calls: SpawnCall[] = [];
    const spawn = jest.fn((command: string, args: string[], opts: unknown) => {
      const child = new FakeChild();
      const call = { command, args, opts, child };
      calls.push(call);
      handler(call, calls.length - 1);
      return child;
    });
    (spawn as jest.Mock & { calls: SpawnCall[] }).calls = calls;
    return spawn;
  }

  function closeSoon(call: SpawnCall, options: { stdout?: string; stderr?: string; code?: number | null; signal?: NodeJS.Signals | null } = {}): void {
    setImmediate(() => {
      if (options.stdout) call.child.stdout.emit('data', Buffer.from(options.stdout));
      if (options.stderr) call.child.stderr.emit('data', Buffer.from(options.stderr));
      call.child.emit('close', options.code ?? 0, options.signal ?? null);
    });
  }

  function errorSoon(call: SpawnCall, err: Error): void {
    setImmediate(() => {
      call.child.emit('error', err);
    });
  }

  async function waitForJob(service: CliProfileAuthService, jobId: string, timeoutMs = 1_000): Promise<CliAuthJobSnapshot | null> {
    const deadline = Date.now() + timeoutMs;
    let last: CliAuthJobSnapshot | null = null;
    while (Date.now() <= deadline) {
      last = service.getJob(jobId);
      if (last && last.status !== 'running') return last;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return last;
  }

  describe('profile defaults', () => {
    test('defaultConfigDir is deterministic, sanitized, and capped', () => {
      const service = makeService();
      const id = ' --Unsafe Profile Id With Spaces And Symbols!@#$%^&*() That Keeps Going-- ';
      const dir = service.defaultConfigDir({ id });
      const hash = crypto.createHash('sha1').update(id).digest('hex').slice(0, 10);

      expect(dir).toBe(service.defaultConfigDir({ id }));
      expect(dir).toBe(path.join(tmpDir, 'cli-profiles', `Unsafe-Profile-Id-With-Spaces-And-Symbols-That-K-${hash}`));
      expect(service.defaultConfigDir({ id: '' })).toBe(path.join(
        tmpDir,
        'cli-profiles',
        `profile-${crypto.createHash('sha1').update('').digest('hex').slice(0, 10)}`,
      ));
    });

    test('profileWithAuthDefaults rejects unsupported profile states', () => {
      const service = makeService();
      const disabled = makeProfile({ id: 'disabled', name: 'Disabled', disabled: true });
      const serverConfigured = makeProfile({ id: 'server', name: 'Server', authMode: 'server-configured' });
      const opencode = makeProfile({ id: 'opencode', name: 'OpenCode', harness: 'opencode' });
      const kiro = makeProfile({ id: 'kiro', name: 'Kiro', harness: 'kiro' });

      expect(() => service.profileWithAuthDefaults(makeSettings([]), 'missing')).toThrow('CLI profile not found: missing');
      expect(() => service.profileWithAuthDefaults(makeSettings([disabled]), 'disabled')).toThrow('CLI profile is disabled: Disabled');
      expect(() => service.profileWithAuthDefaults(makeSettings([serverConfigured]), 'server')).toThrow('Remote authentication is only available for account profiles.');
      expect(() => service.profileWithAuthDefaults(makeSettings([opencode]), 'opencode')).toThrow('Remote authentication is not supported for OpenCode profiles yet.');
      expect(() => service.profileWithAuthDefaults(makeSettings([kiro]), 'kiro')).toThrow('Remote authentication is not supported for Kiro profiles yet.');
    });

    test('profileWithAuthDefaults assigns configDir and preserves existing account config dirs', () => {
      const service = makeService();
      const withoutConfig = makeProfile({ id: 'needs-config', configDir: undefined });
      const assigned = service.profileWithAuthDefaults(makeSettings([withoutConfig]), 'needs-config');

      expect(assigned.changed).toBe(true);
      expect(assigned.profile.configDir).toBe(service.defaultConfigDir(withoutConfig));
      expect(assigned.profile.updatedAt).not.toBe(withoutConfig.updatedAt);

      const withConfig = makeProfile({ id: 'has-config', configDir: path.join(tmpDir, 'custom-config') });
      expect(service.profileWithAuthDefaults(makeSettings([withConfig]), 'has-config')).toEqual({
        settings: makeSettings([withConfig]),
        profile: withConfig,
        changed: false,
      });
    });

    test('setup account profiles strip generated auth homes but preserve unrelated env', () => {
      const service = makeService();
      const setup = makeProfile({
        id: 'setup-codex-account',
        name: 'Setup Codex',
        harness: 'codex',
        configDir: path.join(tmpDir, 'old-codex-home'),
        env: {
          CODEX_HOME: path.join(tmpDir, 'upper'),
          codex_home: path.join(tmpDir, 'lower'),
          KEEP_ME: 'yes',
        },
      });
      const result = service.profileWithAuthDefaults(makeSettings([setup]), setup.id);

      expect(result.changed).toBe(true);
      expect(result.profile.configDir).toBeUndefined();
      expect(result.profile.env).toEqual({ KEEP_ME: 'yes' });

      const cleanSetup = makeProfile({
        id: 'setup-claude-code-account',
        harness: 'claude-code',
        configDir: undefined,
        env: { KEEP_ME: 'yes' },
      });
      expect(service.profileWithAuthDefaults(makeSettings([cleanSetup]), cleanSetup.id)).toEqual({
        settings: makeSettings([cleanSetup]),
        profile: cleanSetup,
        changed: false,
      });
    });
  });

  describe('checkProfile', () => {
    test('parses noisy Claude auth JSON with loggedIn=true', async () => {
      const spawn = createSpawn((call) => {
        closeSoon(call, { stdout: 'noise before\n{"loggedIn":true,"account":"daron"}\nnoise after' });
      });
      const service = makeService(spawn);

      const result = await service.checkProfile(makeProfile());

      expect(result).toMatchObject({
        available: true,
        authenticated: true,
        status: 'ok',
        exitCode: 0,
      });
      expect(spawn).toHaveBeenCalledWith(
        path.join(tmpDir, 'claude'),
        ['auth', 'status', '--json'],
        expect.any(Object),
      );
    });

    test('reports Claude logged-out and missing loggedIn JSON as not authenticated', async () => {
      const profile = makeProfile();
      let service = makeService(createSpawn((call) => closeSoon(call, { stdout: '{"loggedIn":false}' })));
      expect(await service.checkProfile(profile)).toMatchObject({
        authenticated: false,
        status: 'not-authenticated',
        output: '{"loggedIn":false}',
      });

      service = makeService(createSpawn((call) => closeSoon(call, { stdout: '{"authMethod":"oauth"}' })));
      expect(await service.checkProfile(profile)).toMatchObject({
        authenticated: false,
        status: 'not-authenticated',
      });
    });

    test('interprets Codex status exit codes', async () => {
      const codex = makeProfile({ id: 'codex', name: 'Codex', harness: 'codex' });
      let service = makeService(createSpawn((call) => closeSoon(call, { stdout: 'Logged in as daron' })));
      expect(await service.checkProfile(codex)).toMatchObject({
        harness: 'codex',
        authenticated: true,
        status: 'ok',
      });

      service = makeService(createSpawn((call) => closeSoon(call, { stderr: 'not logged in', code: 1 })));
      expect(await service.checkProfile(codex)).toMatchObject({
        authenticated: false,
        status: 'not-authenticated',
        error: 'not logged in',
        exitCode: 1,
      });
    });

    test('maps spawn ENOENT to unavailable and Kiro to unsupported', async () => {
      const service = makeService(createSpawn((call) => errorSoon(call, new Error('spawn claude ENOENT'))));

      expect(await service.checkProfile(makeProfile())).toMatchObject({
        available: false,
        authenticated: null,
        status: 'unavailable',
        error: 'spawn claude ENOENT',
      });
      expect(await service.checkProfile(makeProfile({ harness: 'kiro' }))).toMatchObject({
        available: false,
        authenticated: null,
        status: 'unsupported',
      });
    });
  });

  describe('startAuth lifecycle', () => {
    test('succeeds after login exits zero and status verifies authenticated', async () => {
      const spawn = createSpawn((call, index) => {
        if (index === 0) {
          closeSoon(call, {
            stdout: '\u001b[90mOpen https://example.test/device with Bearer secret-token and sk-12345678SECRET\u001b[0m',
          });
          return;
        }
        closeSoon(call, { stdout: '{"loggedIn":true}' });
      });
      const service = makeService(spawn);

      const started = await service.startAuth(makeProfile());
      const job = await waitForJob(service, started.id);

      expect(job).toMatchObject({
        status: 'succeeded',
        exitCode: 0,
        signal: null,
      });
      const output = job!.events.map(event => event.text).join('\n');
      expect(output).toContain('https://example.test/device');
      expect(output).toContain('Bearer [REDACTED]');
      expect(output).toContain('sk-12345678[REDACTED]');
      expect(output).not.toContain('\u001b[');
      expect(spawn).toHaveBeenNthCalledWith(1, path.join(tmpDir, 'claude'), ['auth', 'login', '--claudeai'], expect.any(Object));
      expect(spawn).toHaveBeenNthCalledWith(2, path.join(tmpDir, 'claude'), ['auth', 'status', '--json'], expect.any(Object));
    });

    test('fails on login nonzero exit and child error', async () => {
      let service = makeService(createSpawn((call) => closeSoon(call, { stderr: 'bad login', code: 2 })));
      let started = await service.startAuth(makeProfile());
      await expect(waitForJob(service, started.id)).resolves.toMatchObject({
        status: 'failed',
        exitCode: 2,
        error: 'Claude Code auth exited with code 2.',
      });

      service = makeService(createSpawn((call) => errorSoon(call, new Error('spawn failed'))));
      started = await service.startAuth(makeProfile({ id: 'profile-error' }));
      await expect(waitForJob(service, started.id)).resolves.toMatchObject({
        status: 'failed',
        error: 'spawn failed',
      });
    });

    test('fails when verification never reports authenticated before timeout', async () => {
      const service = makeService(createSpawn((call, index) => {
        if (index === 0) {
          closeSoon(call);
          return;
        }
        closeSoon(call, { stdout: '{"loggedIn":false}' });
      }), { statusPollTimeoutMs: 60, statusPollIntervalMs: 20 });

      const started = await service.startAuth(makeProfile());
      const job = await waitForJob(service, started.id);

      expect(job?.status).toBe('failed');
      expect(job?.error).toContain('authentication did not verify before timeout');
      expect(job?.error).toContain('"loggedIn":false');
    });

    test('auth timeout fails the job and terminates the child', async () => {
      const spawn = createSpawn(() => {});
      const service = makeService(spawn, { authTimeoutMs: 40 });

      const started = await service.startAuth(makeProfile());
      const job = await waitForJob(service, started.id);

      expect(job?.status).toBe('failed');
      expect(job?.error).toContain('authentication timed out');
      expect((spawn as jest.Mock & { calls: SpawnCall[] }).calls[0].child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    test('rejects duplicate running auth jobs for the same profile', async () => {
      const service = makeService(createSpawn(() => {}), { authTimeoutMs: 1_000 });
      const profile = makeProfile();

      const started = await service.startAuth(profile);
      await expect(service.startAuth(profile)).rejects.toThrow('Authentication is already running for Claude Profile');
      service.cancelJob(started.id);
    });

    test('caps event history at 120 and truncates long event text', async () => {
      const spawn = createSpawn((call) => {
        setImmediate(() => {
          for (let index = 0; index < 130; index += 1) {
            call.child.stdout.emit('data', Buffer.from(`event-${index} ${'x'.repeat(4_500)}\n`));
          }
          call.child.emit('close', 1, null);
        });
      });
      const service = makeService(spawn);

      const started = await service.startAuth(makeProfile());
      const job = await waitForJob(service, started.id);

      expect(job?.status).toBe('failed');
      expect(job?.events).toHaveLength(120);
      expect(job?.events.every(event => event.text.length <= 4_000)).toBe(true);
      expect(job?.events[0].text).not.toContain('event-0');
    });
  });

  describe('job bookkeeping', () => {
    test('getJob returns defensive clones', async () => {
      const service = makeService(createSpawn(() => {}), { authTimeoutMs: 1_000 });
      const started = await service.startAuth(makeProfile());
      const clone = service.getJob(started.id)!;

      clone.events.push({ at: 'now', type: 'info', text: 'mutated' });
      clone.args.push('mutated');

      expect(service.getJob(started.id)?.events.map(event => event.text)).not.toContain('mutated');
      expect(service.getJob(started.id)?.args).not.toContain('mutated');
      service.cancelJob(started.id);
      expect(service.getJob('missing')).toBeNull();
    });

    test('cancelJob cancels running jobs and leaves finished jobs unchanged', async () => {
      const service = makeService(createSpawn(() => {}), { authTimeoutMs: 1_000 });
      const started = await service.startAuth(makeProfile());

      const cancelled = service.cancelJob(started.id);
      expect(cancelled).toMatchObject({ status: 'cancelled', error: 'Authentication cancelled.' });
      expect(service.cancelJob(started.id)).toMatchObject({ status: 'cancelled' });
      expect(() => service.cancelJob('missing')).toThrow('Auth job not found: missing');
    });

    test('shutdown cancels all running jobs', async () => {
      const service = makeService(createSpawn(() => {}), { authTimeoutMs: 1_000 });
      const first = await service.startAuth(makeProfile({ id: 'first', name: 'First' }));
      const second = await service.startAuth(makeProfile({ id: 'second', name: 'Second' }));

      service.shutdown();

      expect(service.getJob(first.id)).toMatchObject({
        status: 'cancelled',
        error: 'Authentication cancelled because the server is shutting down.',
      });
      expect(service.getJob(second.id)).toMatchObject({ status: 'cancelled' });
    });

    test('evicts oldest non-running jobs beyond the recent job limit', async () => {
      const service = makeService(createSpawn((call) => closeSoon(call, { code: 1 })));
      const ids: string[] = [];

      for (let index = 0; index < 45; index += 1) {
        const started = await service.startAuth(makeProfile({ id: `profile-${index}`, name: `Profile ${index}` }));
        ids.push(started.id);
        await waitForJob(service, started.id);
      }

      expect(service.getJob(ids[0])).toBeNull();
      expect(service.getJob(ids[4])).toBeNull();
      expect(service.getJob(ids[5])).not.toBeNull();
      expect(service.getJob(ids[44])).not.toBeNull();
    });
  });

  test('redactCliAuthText strips terminal control sequences and auth secrets', () => {
    expect(redactCliAuthText(
      '\u001b[31mBearer bearer-token-value access_token="abc123" refreshToken=def456 api-key:ghi789 sk-12345678SECRET\u001b[0m',
    )).toBe('Bearer [REDACTED] access_token="[REDACTED]" refreshToken=[REDACTED] api-key:[REDACTED] sk-12345678[REDACTED]');
  });
});
