import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CliProfileAuthService } from '../src/services/cliProfileAuthService';
import { CopilotAuthCleanupError, probeCopilotProfile } from '../src/services/backends/copilotProfileStatus';
import { spawnCopilotProcess } from '../src/services/backends/copilotProcess';
import { runCopilotDeviceAuth } from '../src/services/backends/copilotDeviceAuth';
import { CopilotRuntimeCleanupError } from '../src/services/backends/copilotSdkRuntime';
import type { CliProfile, Settings } from '../src/types';

jest.mock('../src/services/backends/copilotProcess', () => ({ spawnCopilotProcess: jest.fn() }));
jest.mock('../src/services/backends/copilotProfileStatus', () => ({
  ...jest.requireActual('../src/services/backends/copilotProfileStatus'), probeCopilotProfile: jest.fn(),
}));

const profile: CliProfile = { id: 'copilot-account', name: 'Copilot', harness: 'copilot', authMode: 'server-configured', command: '/fixture/copilot', createdAt: '', updatedAt: '' };
const probe = jest.mocked(probeCopilotProfile);
let proc: EventEmitter & { stdout: PassThrough; stderr: PassThrough };
let stop: jest.Mock;
let dir: string;
let service: CliProfileAuthService;
let invalidate: jest.Mock;
let provider: string | undefined;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settled(jobId: string) {
  for (let i = 0; i < 100 && service.getJob(jobId)?.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  return service.getJob(jobId)!;
}
function exit(code = 0) { proc.emit('exit', code, null); }

beforeEach(() => {
  jest.clearAllMocks();
  provider = process.env.COPILOT_PROVIDER_BASE_URL;
  delete process.env.COPILOT_PROVIDER_BASE_URL;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-auth-unit-'));
  proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  stop = jest.fn().mockResolvedValue(undefined);
  jest.mocked(spawnCopilotProcess).mockReturnValue({ proc, scope: { stop } } as never);
  probe.mockResolvedValue({ authenticated: true, modelsAvailable: true, modelCount: 2 });
  invalidate = jest.fn().mockResolvedValue(undefined);
  service = new CliProfileAuthService(dir, { authTimeoutMs: 1000, onCopilotAuthChanged: invalidate });
});
afterEach(async () => {
  await service.shutdown().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
  if (provider === undefined) delete process.env.COPILOT_PROVIDER_BASE_URL;
  else process.env.COPILOT_PROVIDER_BASE_URL = provider;
});

test('keeps shared auth defaults and refuses unproven account homes or environment overrides', async () => {
  const settings = { cliProfiles: [profile] } as Settings;
  expect(service.profileWithAuthDefaults(settings, profile.id)).toEqual({ settings, profile, changed: false });
  for (const change of [{ authMode: 'account' as const }, { configDir: '/separate' }, { env: { GH_TOKEN: 'fixture' } }]) {
    await expect(service.startAuth({ ...profile, ...change })).rejects.toThrow('Account isolation is not supported');
  }
  await expect(service.startAuth({ ...profile, disabled: true })).rejects.toThrow('disabled');
  expect(fs.readdirSync(dir)).toEqual([]);
  expect(jest.mocked(spawnCopilotProcess).mock.calls).toHaveLength(0);
});

test('streams native device instructions and redacts split credentials before returning snapshots', async () => {
  const job = await service.startAuth(profile);
  expect(job.args).toEqual(['--no-auto-update', 'login', '--device-code']);
  const [command, args, options] = jest.mocked(spawnCopilotProcess).mock.calls[0];
  expect([command, args, options.stdio]).toEqual(['/fixture/copilot', job.args, ['ignore', 'pipe', 'pipe']]);
  expect([options.env?.NO_COLOR, options.env?.COPILOT_AUTO_UPDATE]).toEqual(['1', 'false']);
  const text = Buffer.from('To authenticate, visit https://github.com/login/device and enter code ABCD-1234. café\n');
  proc.stdout.write(text.subarray(0, text.length - 2)); proc.stdout.write(text.subarray(text.length - 2));
  proc.stderr.write('Bearer fixture-'); proc.stderr.write('secret\n');
  proc.stderr.write('gho_native'); proc.stderr.write('credential\n');
  proc.stderr.write('x'.repeat(9000)); proc.stderr.write('hidden-tail\nNext diagnostic\n');
  const events = JSON.stringify(service.getJob(job.id));
  expect(events).toContain('ABCD-1234'); expect(events).toContain('café');
  expect(events).not.toContain('fixture-secret'); expect(events).not.toContain('nativecredential'); expect(events).not.toContain('hidden-tail');
  expect(events).toContain('Next diagnostic');
  exit();
  expect(await settled(job.id)).toMatchObject({ status: 'succeeded' });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(probe).toHaveBeenCalledWith(profile, expect.any(AbortSignal));
  expect(invalidate).toHaveBeenCalledTimes(1);
});

test('login exit alone is insufficient, and verification starts only after tree cleanup', async () => {
  let release!: () => void;
  stop.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
  const job = await service.startAuth(profile); exit(); await tick();
  expect(probe).not.toHaveBeenCalled(); expect(service.getJob(job.id)?.status).toBe('running');
  release();
  expect((await settled(job.id)).status).toBe('succeeded');
});

test.each([
  [{ authenticated: false, modelsAvailable: false, modelCount: 0 }, 'credentials did not verify'],
  [{ authenticated: true, modelsAvailable: false, modelCount: 0, modelListError: 'HTTP 403; Bearer private-secret' }, 'model access did not verify'],
  [{ authenticated: true, modelsAvailable: false, modelCount: 0 }, 'subscription and organization policy'],
] as const)('rejects expired/missing credentials and unavailable entitlement: %s', async (status, message) => {
  probe.mockResolvedValue(status);
  const job = await service.startAuth(profile); exit();
  expect(await settled(job.id)).toMatchObject({ status: 'failed', error: expect.stringContaining(message) });
  expect(JSON.stringify(service.getJob(job.id))).not.toContain('private-secret');
  expect(invalidate).toHaveBeenCalledTimes(1);
});

test('does not verify a failed or missing executable as a successful login', async () => {
  const job = await service.startAuth(profile); proc.emit('error', new Error('spawn ENOENT'));
  expect(await settled(job.id)).toMatchObject({ status: 'failed', error: 'spawn ENOENT' });
  expect(probe).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledTimes(1);
});

test('a nonzero native exit remains failed even if other credentials exist', async () => {
  const job = await service.startAuth(profile); exit(1);
  expect(await settled(job.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('login exited (1)') });
  expect(probe).not.toHaveBeenCalled();
});

test('serializes every Copilot profile and blocks replacement while cancelled cleanup drains', async () => {
  let release!: () => void;
  stop.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
  const job = await service.startAuth(profile);
  await expect(service.startAuth({ ...profile, id: 'other' })).rejects.toThrow('share the terminal login');
  expect(service.cancelJob(job.id).status).toBe('cancelled'); await tick();
  let admitted = false;
  const next = service.startAuth(profile).then(job => { admitted = true; return job; });
  await tick(); expect(admitted).toBe(false);
  expect(service.getJob(job.id)?.status).toBe('cancelled');
  release(); await tick();
  stop.mockResolvedValue(undefined);
  const replacement = await next; exit();
  expect((await settled(replacement.id)).status).toBe('succeeded');
});

test('times out without allowing late success or leaving a login worker', async () => {
  service = new CliProfileAuthService(dir, { authTimeoutMs: 15 });
  const job = await service.startAuth(profile);
  expect(await settled(job.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('timed out') });
  await tick(); exit(); await tick();
  expect(service.getJob(job.id)?.status).toBe('failed');
  expect(stop).toHaveBeenCalledTimes(1); expect(probe).not.toHaveBeenCalled();
});

test('cancels fresh verification and waits for shutdown cleanup without overwriting cancellation', async () => {
  let release!: () => void;
  probe.mockImplementation((_profile, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { release = () => reject(new Error('Verification cancelled')); }, { once: true });
  }));
  const job = await service.startAuth(profile); exit(); await tick();
  service.cancelJob(job.id);
  let closed = false;
  const ending = service.shutdown().then(() => { closed = true; });
  await tick(); expect(closed).toBe(false);
  release(); await ending;
  expect(service.getJob(job.id)?.status).toBe('cancelled');
  await expect(service.startAuth(profile)).rejects.toThrow('shutting down');
});

test('shutdown aborts device login and waits for descendant cleanup', async () => {
  let release!: () => void;
  stop.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
  const job = await service.startAuth(profile);
  let closed = false; const ending = service.shutdown().then(() => { closed = true; });
  await tick(); expect(closed).toBe(false);
  release(); await ending;
  expect(service.getJob(job.id)?.status).toBe('cancelled'); expect(probe).not.toHaveBeenCalled();
});

test.each(['login', 'verification', 'startup', 'cache'])('retains an admission barrier when %s cleanup fails', async failure => {
  if (failure === 'login') stop.mockRejectedValue(new Error('worker survived'));
  if (failure === 'verification') probe.mockRejectedValue(new CopilotAuthCleanupError('Probe cleanup failed'));
  if (failure === 'startup') probe.mockRejectedValue(new CopilotRuntimeCleanupError('Probe startup cleanup failed'));
  if (failure === 'cache') invalidate.mockRejectedValue(new Error('cache worker survived'));
  const job = await service.startAuth(profile); exit();
  expect((await settled(job.id)).status).toBe('failed');
  await expect(service.startAuth(profile)).rejects.toBeInstanceOf(CopilotRuntimeCleanupError);
  await expect(service.shutdown()).rejects.toBeInstanceOf(CopilotRuntimeCleanupError);
});

test('shutdown prevents a replacement waiting on cancelled cleanup from starting', async () => {
  let release!: () => void;
  stop.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
  const job = await service.startAuth(profile); service.cancelJob(job.id);
  const replacement = expect(service.startAuth(profile)).rejects.toThrow('shutting down');
  const ending = service.shutdown(); await tick(); release();
  await ending; await replacement;
  expect(jest.mocked(spawnCopilotProcess).mock.calls).toHaveLength(1);
});

test('does not claim GitHub login verifies a custom provider', async () => {
  process.env.COPILOT_PROVIDER_BASE_URL = 'http://127.0.0.1:1';
  const job = await service.startAuth(profile);
  expect(await settled(job.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('custom model provider') });
  expect(jest.mocked(spawnCopilotProcess).mock.calls).toHaveLength(0); expect(probe).not.toHaveBeenCalled();
});

test('an already-cancelled job creates no native process', async () => {
  await expect(runCopilotDeviceAuth(profile, AbortSignal.abort(), jest.fn())).rejects.toThrow('cancelled');
  expect(jest.mocked(spawnCopilotProcess).mock.calls).toHaveLength(0);
});
