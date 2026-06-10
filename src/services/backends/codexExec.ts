import { execFile, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { RunOneShotOptions } from './base';
import { FALLBACK_MODELS, codexModelSupportsEffort } from './codexModels';
import {
  PROCESS_KILL_GRACE_MS,
  buildCodexConfigArgs,
  buildCodexServiceTierArgs,
  codexUsesFullAccess,
  resolveCodexCliRuntime,
  tomlEscapeString,
} from './codexRuntime';
import type { CodexApprovalPolicy, CodexSandboxMode, McpServerConfig, ModelOption } from '../../types';
import { buildCliCommandInvocation } from '../cliCommandResolver';

export interface CodexExecContext {
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandboxMode;
  fallbackWorkingDir?: string;
  modelCatalog?: ModelOption[];
}

/**
 * Run a one-shot prompt against `codex exec` and return the final answer.
 *
 * `codex exec` is a dedicated non-interactive subcommand. Current Codex
 * versions print transcript/status text to stdout, so we ask it to write the
 * final assistant message to a temp file and return that clean payload.
 * Account profiles set `CODEX_HOME` so OAuth/API-key state is isolated.
 */
export async function runCodexExec(
  prompt: string,
  options: RunOneShotOptions = {},
  ctx: CodexExecContext,
): Promise<string> {
  const { timeoutMs = 60000, abortSignal, workingDir, model, effort, serviceTier, mcpServers, cliProfile } = options;
  if (abortSignal?.aborted) throw new Error('codex exec stopped');
  const runtime = resolveCodexCliRuntime(cliProfile);
  const cwd = workingDir || ctx.fallbackWorkingDir || os.homedir();
  const mcpServersForCodex: McpServerConfig[] = Array.isArray(mcpServers) ? mcpServers : [];
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cockpit-codex-'));
  const outputLastMessagePath = path.join(outputDir, 'last-message.txt');

  const configArgs = await buildCodexConfigArgs(mcpServersForCodex, runtime);

  const args = ['exec'];
  if (codexUsesFullAccess(ctx.approvalPolicy, ctx.sandbox)) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--ask-for-approval', ctx.approvalPolicy, '--sandbox', ctx.sandbox);
  }
  args.push('--skip-git-repo-check', '-C', cwd, '-o', outputLastMessagePath, ...buildCodexServiceTierArgs(serviceTier), ...configArgs);
  const modelCatalog = ctx.modelCatalog || FALLBACK_MODELS;
  if (codexModelSupportsEffort(modelCatalog, model, effort)) {
    args.push('-c', `model_reasoning_effort=${tomlEscapeString(effort!)}`);
  }
  if (model) {
    args.push('-m', model);
  }
  args.push(prompt);

  return new Promise<string>((resolve, reject) => {
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | null = null;
    let child: ChildProcess | null = null;
    const killChild = () => {
      const target = child;
      if (!target) return;
      try {
        target.kill('SIGTERM');
      } catch {}
      killTimer = setTimeout(() => {
        try {
          target.kill('SIGKILL');
        } catch {}
      }, PROCESS_KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const onAbort = () => {
      aborted = true;
      killChild();
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);
    timeoutTimer.unref?.();
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    const invocation = buildCliCommandInvocation(runtime, args);
    child = execFile(
      invocation.command,
      invocation.args,
      { maxBuffer: 4 * 1024 * 1024, env: runtime.env },
      (err, stdout, stderr) => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        abortSignal?.removeEventListener('abort', onAbort);
        const readFinalOutput = () => {
          try {
            const fromFile = fs.readFileSync(outputLastMessagePath, 'utf8').trim();
            if (fromFile) return fromFile;
          } catch {}
          return (stdout || '').trim();
        };
        const cleanupOutput = () => {
          try {
            fs.rmSync(outputDir, { recursive: true, force: true });
          } catch {}
        };
        if (aborted || abortSignal?.aborted) {
          cleanupOutput();
          reject(new Error('codex exec failed: Process stopped by caller'));
          return;
        }
        if (timedOut) {
          cleanupOutput();
          reject(new Error(`codex exec failed: Process killed (timeout after ${timeoutMs / 1000}s)`));
          return;
        }
        if (err) {
          cleanupOutput();
          const execErr = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
          if (execErr.code === 'ENOENT') {
            reject(new Error('Codex CLI is not installed. Install with `npm install -g @openai/codex`'));
            return;
          }
          let msg: string;
          if (execErr.killed) {
            msg = `Process killed (timeout after ${timeoutMs / 1000}s)`;
          } else if (stderr && stderr.trim()) {
            msg = stderr.trim().slice(-500);
          } else {
            msg = `Process exited with code ${execErr.code ?? 'unknown'}`;
          }
          reject(new Error(`codex exec failed: ${msg}`));
          return;
        }
        resolve(readFinalOutput());
        cleanupOutput();
      },
    );
    child.stdin?.end();
  });
}
