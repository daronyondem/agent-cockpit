import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../../utils/logger';
import type {
  CliProfile,
  CodexApprovalPolicy,
  CodexSandboxMode,
  CodexThreadGoal,
  McpServerConfig,
  ServiceTier,
  ThreadGoal,
} from '../../types';
import { resolveCliCommandForRuntime, type CliCommandResolution } from '../cliCommandResolver';

export const CODEX_IDLE_TIMEOUT_MS = parseInt(process.env.CODEX_IDLE_TIMEOUT_MS || '', 10) || 600_000;
export const DEFAULT_CODEX_APPROVAL_POLICY: CodexApprovalPolicy = 'never';
export const DEFAULT_CODEX_SANDBOX_MODE: CodexSandboxMode = 'danger-full-access';
export const CODEX_APP_SERVER_ARGS = ['app-server', '--enable', 'goals'];
export const CODEX_CLIENT_CAPABILITIES = { experimentalApi: true };
const CODEX_FAST_SERVICE_TIER_ARGS = ['-c', 'service_tier="fast"', '-c', 'features.fast_mode=true'];
const CODEX_GOAL_SUPPORTED_ACTIONS = { clear: true, stopTurn: true, pause: true, resume: true };

// Used as the polite-shutdown deadline before SIGKILL during process kill.
export const PROCESS_KILL_GRACE_MS = 1_000;

const codexRuntimeLog = logger.child({ module: 'codex-runtime' });

export interface CodexCliRuntime extends CliCommandResolution {
  command: string;
  env: NodeJS.ProcessEnv;
  configDir?: string;
  profileKey: string;
}

export function resolveCodexCliRuntime(profile?: CliProfile): CodexCliRuntime {
  if (profile && profile.harness !== 'codex') {
    throw new Error(`CLI profile harness ${profile.harness} is not codex`);
  }
  const requestedCommand = profile?.command?.trim() || 'codex';
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (profile?.env) {
    for (const [key, value] of Object.entries(profile.env)) {
      env[key] = value;
    }
  }
  const configDir = profile?.configDir?.trim() || undefined;
  if (configDir) {
    env.CODEX_HOME = configDir;
  }

  const hash = crypto.createHash('sha1').update(JSON.stringify({
    id: profile?.id || null,
    command: requestedCommand,
    configDir: configDir || null,
    env: profile?.env || {},
  })).digest('hex').slice(0, 12);
  const commandResolution = resolveCliCommandForRuntime('codex', requestedCommand, env);

  return {
    ...commandResolution,
    env,
    ...(configDir ? { configDir } : {}),
    profileKey: profile ? `${profile.id}:${hash}` : `server-configured:${hash}`,
  };
}

export function normalizeCodexGoal(goal: CodexThreadGoal | null | undefined): ThreadGoal | null {
  if (!goal) return null;
  return {
    ...goal,
    backend: 'codex',
    supportedActions: CODEX_GOAL_SUPPORTED_ACTIONS,
    source: 'native',
  };
}

export function codexUsesFullAccess(approvalPolicy: CodexApprovalPolicy, sandbox: CodexSandboxMode): boolean {
  return approvalPolicy === 'never' && sandbox === 'danger-full-access';
}

export function buildCodexThreadSecurityParams(
  approvalPolicy: CodexApprovalPolicy = DEFAULT_CODEX_APPROVAL_POLICY,
  sandbox: CodexSandboxMode = DEFAULT_CODEX_SANDBOX_MODE,
): { approvalPolicy: CodexApprovalPolicy; sandbox: CodexSandboxMode } {
  return { approvalPolicy, sandbox };
}

// Codex configures MCP servers via `[mcp_servers.<name>]` sections in its
// config.toml. We inject cockpit-managed servers via repeated `-c
// mcp_servers.<name>.{command,args,env}=...` flags on the Codex invocation.
// Server-configured profiles leave `CODEX_HOME` alone, so Codex uses the
// server user's normal `~/.codex/`; account profiles can set `configDir`,
// which maps to `CODEX_HOME` and isolates auth/config/session state.

export function tomlEscapeString(v: string): string {
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
}

export function tomlBareKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlEscapeString(k);
}

export function hashMcpServers(servers: McpServerConfig[]): string {
  if (!servers || servers.length === 0) return '';
  // Stable hash: sort by name so order doesn't matter.
  const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name)).map((s) => ({
    name: s.name,
    command: s.command,
    args: s.args,
    env: s.env,
  }));
  return crypto.createHash('sha1').update(JSON.stringify(sorted)).digest('hex').slice(0, 12);
}

export function codexServiceTierKey(serviceTier?: ServiceTier): string {
  return serviceTier === 'fast' ? 'fast' : '';
}

export function buildCodexServiceTierArgs(serviceTier?: ServiceTier): string[] {
  return serviceTier === 'fast' ? [...CODEX_FAST_SERVICE_TIER_ARGS] : [];
}

export async function buildCodexConfigArgs(
  mcpServers: McpServerConfig[],
  runtime: CodexCliRuntime = resolveCodexCliRuntime(),
): Promise<string[]> {
  if (mcpServers.length === 0) return [];

  // Read user's config.toml only for collision detection - we never edit it.
  // If the user has a `[mcp_servers.<name>]` section that matches one we'd
  // inject, the user's wins (we skip ours and warn).
  const userConfigPath = path.join(runtime.configDir || path.join(os.homedir(), '.codex'), 'config.toml');
  let userConfig = '';
  try {
    userConfig = await fs.promises.readFile(userConfigPath, 'utf-8');
  } catch {
    // No user config - nothing to collide with
  }

  const args: string[] = [];
  for (const server of mcpServers) {
    if (userConfig && new RegExp(`^\\[mcp_servers\\.${server.name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'm').test(userConfig)) {
      codexRuntimeLog.warn('User config.toml already defines MCP server; keeping user config and skipping cockpit injection', {
        server: server.name,
      });
      continue;
    }
    const key = tomlBareKey(server.name);
    args.push('-c', `mcp_servers.${key}.command=${tomlEscapeString(server.command)}`);
    args.push('-c', `mcp_servers.${key}.args=[${(server.args || []).map(tomlEscapeString).join(', ')}]`);
    if (server.env && server.env.length > 0) {
      const envInline = '{ ' + server.env.map((e) => `${tomlBareKey(e.name)} = ${tomlEscapeString(e.value)}`).join(', ') + ' }';
      args.push('-c', `mcp_servers.${key}.env=${envInline}`);
    }
  }
  return args;
}

export function codexConfigDir(runtime?: CodexCliRuntime): string {
  return runtime?.configDir || path.join(os.homedir(), '.codex');
}
