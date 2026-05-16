import { execFile } from 'child_process';
import { CLAUDE_CODE_INTERACTIVE_BACKEND_ID } from '../cliProfiles';
import { buildCliCommandInvocation } from '../cliCommandResolver';
import type { CliCompatibilityStatus } from '../../types';
import type { ClaudeCliRuntime } from './claudeCode';

export const CLAUDE_CODE_INTERACTIVE_TESTED_CLI_VERSION = '2.1.142';

const EXEC_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 256 * 1024;

export function parseSemver(output: string | null | undefined): string | null {
  const match = String(output || '').match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : null;
}

export function compareSemver(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const left = a.split(/[-+]/)[0].split('.').map(Number);
  const right = b.split(/[-+]/)[0].split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const av = left[i] || 0;
    const bv = right[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

export function buildClaudeInteractiveCompatibilityStatus(
  command: string,
  currentVersion: string | null,
  error?: string | null,
): CliCompatibilityStatus {
  if (!currentVersion) {
    const missing = !!error && /\b(enoent|not found|no such file)\b/i.test(error);
    return {
      providerId: CLAUDE_CODE_INTERACTIVE_BACKEND_ID,
      command,
      currentVersion: null,
      testedVersion: CLAUDE_CODE_INTERACTIVE_TESTED_CLI_VERSION,
      status: missing ? 'missing' : 'unknown',
      severity: missing ? 'error' : 'warning',
      message: missing
        ? 'Claude Code Interactive cannot start because the Claude Code CLI was not found.'
        : 'Claude Code Interactive could not determine the installed Claude Code CLI version. This provider depends on private interactive transcript and terminal behavior.',
    };
  }

  const comparison = compareSemver(currentVersion, CLAUDE_CODE_INTERACTIVE_TESTED_CLI_VERSION);
  if (comparison === 0) {
    return {
      providerId: CLAUDE_CODE_INTERACTIVE_BACKEND_ID,
      command,
      currentVersion,
      testedVersion: CLAUDE_CODE_INTERACTIVE_TESTED_CLI_VERSION,
      status: 'supported',
      severity: 'none',
      message: null,
    };
  }

  if (comparison > 0) {
    return {
      providerId: CLAUDE_CODE_INTERACTIVE_BACKEND_ID,
      command,
      currentVersion,
      testedVersion: CLAUDE_CODE_INTERACTIVE_TESTED_CLI_VERSION,
      status: 'newer',
      severity: 'warning',
      message: 'Your installed Claude Code CLI is newer than the version Agent Cockpit currently supports for Claude Code Interactive. Interactive mode may still work, but you could run into compatibility issues. Standard mode is fully supported and ready to use. Standard mode uses your monthly credits, while Interactive mode uses your Claude usage limits. Agent Cockpit will add support for newer Claude Code CLI versions as soon as possible. Learn more: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan',
    };
  }

  return {
    providerId: CLAUDE_CODE_INTERACTIVE_BACKEND_ID,
    command,
    currentVersion,
    testedVersion: CLAUDE_CODE_INTERACTIVE_TESTED_CLI_VERSION,
    status: 'older',
    severity: 'warning',
    message: 'Your installed Claude Code CLI version is older than the version tested with Claude Code Interactive. This provider may miss transcript fields or terminal behavior that Agent Cockpit expects.',
  };
}

export async function probeClaudeInteractiveCompatibility(
  runtime: Pick<ClaudeCliRuntime, 'command' | 'env' | 'argsPrefix' | 'windowsCmdShim' | 'displayCommand'>,
): Promise<CliCompatibilityStatus> {
  const invocation = buildCliCommandInvocation(runtime, ['--version']);
  const displayCommand = runtime.displayCommand || runtime.command;
  try {
    const output = await execFileText(invocation.command, invocation.args, runtime.env);
    return buildClaudeInteractiveCompatibilityStatus(displayCommand, parseSemver(output));
  } catch (err: unknown) {
    const message = (err as Error).message || String(err);
    return buildClaudeInteractiveCompatibilityStatus(displayCommand, null, message);
  }
}

function execFileText(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env, timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || '').trim() || err.message));
      } else {
        resolve(String(stdout || '').trim());
      }
    });
  });
}
