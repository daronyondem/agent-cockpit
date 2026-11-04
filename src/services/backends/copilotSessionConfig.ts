import type { SessionConfigBase, MCPServerConfig, ProviderConfig } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import type { McpServerConfig, SendMessageOptions } from '../../types';
import { COPILOT_MODELS, COPILOT_EFFORT_ORDER } from './copilotModels';

/** Preserve the existing CLI environment contract for explicit custom providers. */
function providerFromEnv(env: NodeJS.ProcessEnv): ProviderConfig | undefined {
  if (!env.COPILOT_PROVIDER_BASE_URL) return undefined;
  const type = env.COPILOT_PROVIDER_TYPE || 'openai';
  if (type !== 'openai' && type !== 'anthropic' && type !== 'azure') {
    throw new Error(`Unsupported Copilot provider type: ${type}`);
  }
  return { type, baseUrl: env.COPILOT_PROVIDER_BASE_URL,
    ...(env.COPILOT_PROVIDER_API_KEY ? { apiKey: env.COPILOT_PROVIDER_API_KEY } : {}) };
}

export function copilotSessionConfig(options: SendMessageOptions, env: NodeJS.ProcessEnv, workingDir: string): SessionConfigBase {
  const model = options.model?.trim() || env.COPILOT_MODEL || undefined;
  const selected = COPILOT_MODELS.find(candidate => candidate.id === model);
  const effort = options.effort && selected?.supportedEffortLevels?.includes(options.effort)
    ? COPILOT_EFFORT_ORDER.find(candidate => candidate === options.effort) : undefined;
  const mcp = copilotMcpServers(options.mcpServers);
  return {
    clientName: 'agent-cockpit', model, workingDirectory: workingDir, streaming: true,
    ...(effort ? { reasoningEffort: effort } : {}),
    ...(Object.keys(mcp).length ? { mcpServers: mcp } : {}),
    provider: providerFromEnv(env),
    excludedTools: ['ask_user'],
    onPermissionRequest: () => ({ kind: 'approve-once' }),
  };
}

export function copilotMcpConfig(mcpServers: McpServerConfig[] | undefined): string | null {
  const servers = copilotMcpServers(mcpServers);
  return Object.keys(servers).length ? JSON.stringify({ mcpServers: servers }) : null;
}

function copilotMcpServers(mcpServers: McpServerConfig[] | undefined): Record<string, MCPServerConfig> {
  const servers: Record<string, MCPServerConfig> = {};
  if (!Array.isArray(mcpServers)) return servers;
  for (const server of mcpServers || []) {
    if (!server?.name || !server.command) continue;
    const env: Record<string, string> = {};
    for (const entry of server.env || []) {
      if (entry?.name && typeof entry.value === 'string') env[entry.name] = entry.value;
    }
    servers[server.name] = {
      type: 'local',
      command: server.command,
      args: Array.isArray(server.args) ? server.args : [],
      tools: ['*'],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  return servers;
}

export function composePrompt(message: string, systemPrompt: string | undefined, isNewSession: boolean): string {
  const system = isNewSession ? String(systemPrompt || '').trim() : '';
  if (!system) return message;
  return `System instructions:\n${system}\n\nUser message:\n${message}`;
}
