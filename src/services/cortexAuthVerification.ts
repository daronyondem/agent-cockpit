import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { CliAuthCheckResult, CliProfile } from '../types';
import { resolveCortexRuntime, startCortexRuntime } from './backends/cortexRuntime';
import { cortexRecord } from './backends/cortexProtocol';
import { CortexEventDecoder } from './backends/cortexEvents';
import { cortexHasCompleteUsage } from './backends/cortexUsage';

/** One fresh process and one tiny request. Discovery alone is never auth proof. */
export async function verifyCortexAuthentication(profile: CliProfile, signal?: AbortSignal,
  start = startCortexRuntime, timeoutMs = 90_000): Promise<CliAuthCheckResult> {
  const result: CliAuthCheckResult = { profileId: profile.id, harness: profile.harness, command: profile.command || 'cortex',
    available: false, authenticated: null, status: 'error', output: '' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let root: string | undefined;
  let native: Awaited<ReturnType<typeof start>> | undefined;
  try {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-cortex-auth-'));
    await fs.chmod(root, 0o700);
    const config = resolveCortexRuntime({ profile, workspaceId: 'auth-check', cwd: root });
    if (controller.signal.aborted) throw new Error();
    native = await start(config, client => {
      const stop = () => { void client.close(); };
      controller.signal.addEventListener('abort', stop, { once: true });
      void client.closed.then(() => controller.signal.removeEventListener('abort', stop));
      if (controller.signal.aborted) stop();
    }, controller.signal);
    result.available = true;
    await native.prepare();
    const decoder = new CortexEventDecoder(native.sessionId!);
    let toolObserved = false;
    const unsubscribe = native.subscribe(message => {
      if (message.params?.sessionId !== native!.sessionId) return;
      const kind = cortexRecord(message.params?.update).sessionUpdate;
      if (message.id !== undefined || kind === 'tool_call' || kind === 'tool_call_update') {
        toolObserved = true;
        void native!.client.close(); // Never approve or continue tool work in this probe.
      }
      decoder.decode(message);
    });
    try {
      const marker = `COCKPIT_AUTH_${crypto.randomBytes(12).toString('hex')}`;
      const response = cortexRecord(await native.prompt([{ type: 'text',
        text: `Return exactly ${marker} as plain text. Do not use any tools, files, commands, skills, agents, web or SQL.` }], timeoutMs));
      if (response.stopReason === 'end_turn' && !toolObserved && !controller.signal.aborted
        && decoder.resultText === marker && cortexHasCompleteUsage(response.usage)) {
        result.authenticated = true; result.status = 'ok';
        result.output = 'Cortex Code credentials and inference access verified from a fresh process.';
      } else {
        const missing = /^Error: Connection error: Error: No Snowflake connection available\./.test(decoder.finalText.trim());
        result.authenticated = missing ? false : null;
        result.status = missing ? 'not-authenticated' : 'error';
        result.error = missing ? 'Cortex Code requires a working Snowflake connection and login.'
          : 'Cortex Code could not verify inference access. Check credentials, account/model grants and service availability.';
      }
    } finally { unsubscribe(); }
  } catch {
    result.error = controller.signal.aborted ? 'Cortex Code verification was cancelled or timed out.'
      : result.available && !native?.sessionId ? 'Cortex Code started, but ACP session setup failed before login could be verified. Check CLI compatibility and Snowflake service availability.'
      : 'Cortex Code verification failed. Check CLI installation, credentials, account access and service availability.';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    try {
      await native?.close();
      if (root) await fs.rm(root, { recursive: true, force: true });
    } catch {
      result.authenticated = null; result.status = 'error'; result.output = '';
      result.error = 'Cortex Code verification could not finish native cleanup.';
    }
  }
  return result;
}
