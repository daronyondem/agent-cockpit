import fs from 'fs';
import crypto from 'crypto';
import type { CliProfile } from '../../types';
import { resolveCliCommandForRuntime, type CliCommandResolution } from '../cliCommandResolver';

export interface CopilotCliRuntime extends CliCommandResolution {
  command: string;
  env: NodeJS.ProcessEnv;
  configDir?: string;
  profileKey: string;
}

export function resolveCopilotCliRuntime(profile?: CliProfile): CopilotCliRuntime {
  if (profile && profile.harness !== 'copilot') {
    throw new Error(`CLI profile harness ${profile.harness} is not copilot`);
  }
  const requestedCommand = profile?.command?.trim() || 'copilot';
  const env: NodeJS.ProcessEnv = { ...process.env, ...profile?.env };
  const hash = crypto.createHash('sha1').update(JSON.stringify({
    id: profile?.id || null,
    command: requestedCommand,
    env: profile?.env || {},
  })).digest('hex').slice(0, 12);
  return {
    ...resolveCliCommandForRuntime('copilot', requestedCommand, env),
    env,
    profileKey: profile ? `${profile.id}:${hash}` : `server-configured:${hash}`,
  };
}

export function resolveCopilotWorkingDir(workingDir: string | null | undefined): string {
  const cwd = workingDir?.trim() || process.cwd();
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      throw new Error(`Copilot working directory is not a directory: ${cwd}`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Copilot working directory does not exist: ${cwd}`);
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') {
      throw new Error(`Copilot working directory is not a directory: ${cwd}`);
    }
    throw err;
  }
  return cwd;
}
