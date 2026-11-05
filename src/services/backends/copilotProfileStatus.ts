import type { CliProfile } from '../../types';
import { resolveCopilotCliRuntime } from './copilotRuntime';
import { CopilotRuntimeCleanupError, startCopilotSdkRuntime } from './copilotSdkRuntime';

export class CopilotAuthCleanupError extends CopilotRuntimeCleanupError {}

function catalogError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const details = JSON.parse(message.slice(message.indexOf('{'))) as { kind?: string; status?: number; body?: string };
    if (details.kind === 'http' && typeof details.status === 'number') {
      return `Copilot model discovery failed (HTTP ${details.status}). ${typeof details.body === 'string' ? details.body.trim() : ''}`.trim();
    }
  } catch { /* Other native failures already have a useful plain message. */ }
  return message;
}

/** Account credentials and catalog access are separate from CLI installation. */
export async function probeCopilotProfile(profile: CliProfile, abortSignal: AbortSignal) {
  const runtime = await startCopilotSdkRuntime(resolveCopilotCliRuntime(profile), process.cwd(), { abortSignal });
  try {
    const auth = await runtime.client.getAuthStatus();
    if (!auth.isAuthenticated) return { authenticated: false, modelsAvailable: false, modelCount: 0 };
    try {
      const models = await runtime.client.listModels();
      const count = models.filter(model => !model.policy || model.policy.state === 'enabled').length;
      return { authenticated: true, modelsAvailable: count > 0, modelCount: count,
        ...(count ? {} : { modelListError: 'Copilot returned no enabled models for this account.' }) };
    } catch (error) {
      return { authenticated: true, modelsAvailable: false, modelCount: 0, modelListError: catalogError(error) };
    }
  } finally {
    try { await runtime.stop(); }
    catch (cause) { throw new CopilotAuthCleanupError('Copilot authentication probe cleanup failed. Restart the server before trying again.', { cause }); }
  }
}
