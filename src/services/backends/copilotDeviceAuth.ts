import { StringDecoder } from 'string_decoder';
import crypto from 'crypto';
import type { CliProfile } from '../../types';
import type { CliAuthJobSnapshot } from '../cliProfileAuthService';
import { buildCliCommandInvocation } from '../cliCommandResolver';
import { spawnCopilotProcess } from './copilotProcess';
import { resolveCopilotCliRuntime } from './copilotRuntime';
import { CopilotAuthCleanupError, probeCopilotProfile } from './copilotProfileStatus';
import { CopilotRuntimeCleanupError } from './copilotSdkRuntime';

export const COPILOT_DEVICE_AUTH_ARGS = ['--no-auto-update', 'login', '--device-code'];

/** A terminal snapshot may be cancelled while completion still drains owned work. */
export class CopilotDeviceAuthJob {
  readonly snapshot: CliAuthJobSnapshot;
  readonly controller = new AbortController();
  readonly completion: Promise<void>;

  constructor(profile: CliProfile, timeoutMs: number,
    event: (snapshot: CliAuthJobSnapshot, type: 'info' | 'stdout' | 'stderr' | 'error' | 'exit', text: string) => void,
    redact: (text: string) => string, invalidate?: () => Promise<void>) {
    const now = new Date().toISOString();
    const snapshot: CliAuthJobSnapshot = this.snapshot = {
      id: `auth-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
      profileId: profile.id, profileName: profile.name, harness: profile.harness,
      status: 'running', startedAt: now, updatedAt: now, command: profile.command || 'copilot',
      args: [...COPILOT_DEVICE_AUTH_ARGS], events: [],
    };
    event(snapshot, 'info', 'Starting shared Copilot terminal authentication. Open the native verification URL and enter its one-time code.');
    const timeout = setTimeout(() => {
      if (snapshot.status !== 'running') return;
      snapshot.status = 'failed';
      snapshot.error = 'Copilot authentication timed out. Start authentication again before the device code expires.';
      event(snapshot, 'error', snapshot.error);
      this.controller.abort();
    }, timeoutMs);
    this.completion = (async () => {
      let failure: unknown;
      try {
        await runCopilotDeviceAuth(profile, this.controller.signal, (type, text) => {
          if (snapshot.status === 'running') event(snapshot, type, text);
        });
      } catch (error) { failure = error; }
      finally { clearTimeout(timeout); }
      // Login can change credentials even when access verification fails.
      try { await invalidate?.(); }
      catch (cause) { failure = new CopilotAuthCleanupError('Copilot account cache cleanup failed. Restart the server before trying again.', { cause }); }
      if (snapshot.status === 'running' || failure instanceof CopilotRuntimeCleanupError) {
        snapshot.status = failure ? 'failed' : 'succeeded';
        if (failure) snapshot.error = redact(failure instanceof Error ? failure.message : String(failure));
        event(snapshot, failure ? 'error' : 'exit', snapshot.error || 'Authentication completed. Shared terminal credentials and model access verified.');
      }
      if (failure instanceof CopilotRuntimeCleanupError) throw failure;
    })();
    // Owners await completion; do not emit an unhandled rejection before shutdown.
    void this.completion.catch(() => {});
  }
}

/** Shared terminal credentials stay native-owned; no tokens or account homes are copied. */
export async function runCopilotDeviceAuth(
  profile: CliProfile,
  signal: AbortSignal,
  event: (type: 'stdout' | 'stderr' | 'info', text: string) => void,
): Promise<void> {
  if (signal.aborted) throw new Error('Copilot authentication cancelled.');
  const runtime = resolveCopilotCliRuntime(profile);
  if (runtime.env.COPILOT_PROVIDER_BASE_URL) {
    throw new Error('This Copilot server uses a custom model provider. Configure its provider credentials on the server; GitHub device login does not verify that provider.');
  }
  const invocation = buildCliCommandInvocation(runtime, COPILOT_DEVICE_AUTH_ARGS);
  const { proc, scope } = spawnCopilotProcess(invocation.command, invocation.args, {
    cwd: process.cwd(), env: { ...runtime.env, NO_COLOR: '1', COPILOT_AUTO_UPDATE: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const type of ['stdout', 'stderr'] as const) {
    const decoder = new StringDecoder('utf8');
    let pending = '', discarded = false;
    const read = (text: string) => {
      const lines = (pending + text).split(/\r?\n/);
      pending = lines.pop()!;
      for (const line of lines) {
        if (!discarded && line.length <= 8192) event(type, line);
        discarded = false;
      }
      // Redact whole lines in the owner, including credentials split across chunks.
      if (pending.length > 8192) { pending = ''; discarded = true; }
    };
    proc[type]!.on('data', chunk => read(decoder.write(chunk)));
    proc[type]!.on('end', () => { read(decoder.end()); if (!discarded && pending) event(type, pending); });
  }
  let abort!: () => void;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        proc.once('error', reject);
        // Do not wait for pipes inherited by a detached child before cleaning up.
        proc.once('exit', (code, exitSignal) => code === 0 ? resolve()
          : reject(new Error(`Copilot login exited (${exitSignal || code}). Complete login in a terminal if the CLI requires interactive credential storage.`)));
      }),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('Copilot authentication cancelled.'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
    try { await scope.stop(); }
    catch (cause) { throw new CopilotAuthCleanupError('Copilot login cleanup failed. Restart the server before trying again.', { cause }); }
  }
  if (signal.aborted) throw new Error('Copilot authentication cancelled.');
  event('info', 'Verifying Copilot credentials and model access in a fresh process.');
  const status = await probeCopilotProfile(profile, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
  if (signal.aborted) throw new Error('Copilot authentication cancelled.');
  if (!status.authenticated) throw new Error('Copilot login finished, but credentials did not verify. Start authentication again or run Check GitHub Copilot.');
  if (!status.modelsAvailable) throw new Error(`Copilot credentials were found, but model access did not verify. ${status.modelListError || 'Check the account subscription and organization policy.'}`);
  event('info', `Copilot credentials and model catalog access verified (${status.modelCount} models).`);
}
