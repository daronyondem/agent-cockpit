import crypto from 'crypto';
import type { ChildProcess } from 'child_process';
import type { CopilotClient } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import { buildCliCommandInvocation } from '../cliCommandResolver';
import { spawnCopilotProcess } from './copilotProcess';
import type { CopilotCliRuntime } from './copilotRuntime';

export interface CopilotSdkRuntime {
  client: CopilotClient;
  process: ChildProcess;
  /** Resolves immediately on exit, abort or stop, even if descendants hold pipes. */
  closed: Promise<Error>;
  stop(): Promise<void>;
}

function deadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function listeningPort(proc: ChildProcess, closed: Promise<Error>): Promise<number> {
  let output = '';
  let read: (chunk: Buffer) => void;
  return Promise.race([
    new Promise<number>((resolve, reject) => {
      read = chunk => {
        output = (output + chunk.toString()).slice(-8192);
        const match = output.match(/listening on port (\d+)/i);
        if (!match) return;
        const port = Number(match[1]);
        if (port > 0 && port <= 65535) resolve(port);
        else reject(new Error('Copilot runtime announced an invalid port.'));
      };
      proc.stdout!.on('data', read);
    }),
    closed.then(error => { throw error; }),
  ]).finally(() => {
    proc.stdout!.removeListener('data', read);
    proc.stdout!.resume();
  });
}

/** The SDK connects to our owned process; it never spawns or downloads a runtime. */
export async function startCopilotSdkRuntime(
  runtime: CopilotCliRuntime,
  workingDir: string,
  options: { abortSignal?: AbortSignal; startupTimeoutMs?: number } = {},
): Promise<CopilotSdkRuntime> {
  const { abortSignal, startupTimeoutMs = 15_000 } = options;
  if (abortSignal?.aborted) throw new Error('Copilot runtime startup aborted.');
  const { CopilotClient, RuntimeConnection } = await import('@github/copilot-sdk');
  if (abortSignal?.aborted) throw new Error('Copilot runtime startup aborted.');
  const connectionToken = crypto.randomUUID();
  const invocation = buildCliCommandInvocation(runtime, ['--headless', '--no-auto-update', '--log-level', 'none']);
  const { proc, scope } = spawnCopilotProcess(invocation.command, invocation.args, {
    cwd: workingDir, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...runtime.env, COPILOT_CONNECTION_TOKEN: connectionToken },
  });
  // Headless stdout only announces its port. Do not retain stderr or environments:
  // a custom CLI can include credentials in diagnostics.
  proc.stderr!.resume();
  let resolveClosed!: (error: Error) => void;
  const closed = new Promise<Error>(resolve => { resolveClosed = resolve; });
  let client: CopilotClient | undefined;
  let stopping: Promise<void> | undefined;
  let failed = false;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    abortSignal?.removeEventListener('abort', abort);
    resolveClosed(new Error('Copilot runtime stopped.'));
    stopping = (async () => {
      try {
        // A dead process cannot acknowledge session.detach. Force-close first
        // so JSON-RPC never writes graceful teardown requests to its ended socket.
        if (client) await deadline<unknown>(failed ? client.forceStop() : client.stop(), 1000, 'Copilot SDK disconnect timed out.').catch(() => {});
      } finally {
        try { await scope.stop(); }
        finally {
          if (client) await deadline(client.forceStop(), 1000, 'Copilot SDK close timed out.').catch(() => {});
        }
      }
    })();
    return stopping;
  };
  const fail = (error: Error) => {
    failed = true;
    resolveClosed(error);
    // Startup and adapter callers await stop; the exit handler must not reject
    // an unobserved promise if the process disappears while no turn is attached.
    void stop().catch(() => {});
  };
  const abort = () => {
    // Close the input channel before rejecting pending question callbacks;
    // otherwise their error responses can release more native work during Stop.
    failed = true;
    resolveClosed(new Error('Copilot runtime aborted.'));
    void stop().catch(() => {});
  };
  proc.once('error', fail);
  proc.once('exit', (code, signal) => fail(new Error(`Copilot runtime exited (${signal || code}).`)));
  abortSignal?.addEventListener('abort', abort, { once: true });
  if (abortSignal?.aborted) abort();
  try {
    const port = await deadline(listeningPort(proc, closed), startupTimeoutMs, 'Copilot runtime did not announce a port.');
    if (stopping) throw new Error('Copilot runtime startup aborted.');
    client = new CopilotClient({ connection: RuntimeConnection.forUri(`127.0.0.1:${port}`, { connectionToken }) });
    await deadline(Promise.race([client.start(), closed.then(error => { throw error; })]), startupTimeoutMs, 'Copilot SDK handshake timed out.');
    if (stopping) throw new Error('Copilot runtime startup aborted.');
    return { client, process: proc, closed, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
