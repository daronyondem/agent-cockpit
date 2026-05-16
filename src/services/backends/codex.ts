import { spawn, execFile, type ChildProcess } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import { BaseBackendAdapter, type BackendCallOptions, type RunOneShotOptions } from './base';
import { sanitizeSystemPrompt, extractToolOutcome, shortenPath } from './toolUtils';
import { logger } from '../../utils/logger';
import type {
  BackendMetadata,
  ModelOption,
  McpServerConfig,
  SendMessageOptions,
  SendMessageResult,
  StreamEvent,
  Message,
  ToolDetail,
  Usage,
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  ServiceTier,
  CliProfile,
  CodexThreadGoal,
  CodexThreadGoalStatus,
  ThreadGoal,
} from '../../types';
import { buildCliCommandInvocation, resolveCliCommandForRuntime, type CliCommandResolution } from '../cliCommandResolver';

// ── Icon ────────────────────────────────────────────────────────────────────

const CODEX_ICON = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z" fill="#fff"/><path d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z" fill="url(#codex-gradient)"/><defs><linearGradient gradientUnits="userSpaceOnUse" id="codex-gradient" x1="12" x2="12" y1="3" y2="21"><stop stop-color="#B1A7FF"/><stop offset=".5" stop-color="#7A9DFF"/><stop offset="1" stop-color="#3941FF"/></linearGradient></defs></svg>';

// ── Configuration ────────────────────────────────────���──────────────────────

const CODEX_IDLE_TIMEOUT_MS = parseInt(process.env.CODEX_IDLE_TIMEOUT_MS || '', 10) || 600_000;
const DEFAULT_CODEX_APPROVAL_POLICY: CodexApprovalPolicy = 'never';
const DEFAULT_CODEX_SANDBOX_MODE: CodexSandboxMode = 'danger-full-access';
const CODEX_SUPPORTED_EFFORTS: EffortLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const CODEX_FALLBACK_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];
const CODEX_APP_SERVER_ARGS = ['app-server', '--enable', 'goals'];
const CODEX_CLIENT_CAPABILITIES = { experimentalApi: true };
const CODEX_FAST_SERVICE_TIER_ARGS = ['-c', 'service_tier="fast"', '-c', 'features.fast_mode=true'];
const codexLog = logger.child({ module: 'codex-backend' });
const CODEX_GOAL_SUPPORTED_ACTIONS = { clear: true, stopTurn: true, pause: true, resume: true };
const CODEX_GOAL_STATUS_POLL_MS = 1_000;

// Used as the polite-shutdown deadline before SIGKILL during process kill.
const PROCESS_KILL_GRACE_MS = 1_000;

export interface CodexCliRuntime extends CliCommandResolution {
  command: string;
  env: NodeJS.ProcessEnv;
  configDir?: string;
  profileKey: string;
}

export function resolveCodexCliRuntime(profile?: CliProfile): CodexCliRuntime {
  if (profile && profile.vendor !== 'codex') {
    throw new Error(`CLI profile vendor ${profile.vendor} is not codex`);
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

function normalizeCodexGoal(goal: CodexThreadGoal | null | undefined): ThreadGoal | null {
  if (!goal) return null;
  return {
    ...goal,
    backend: 'codex',
    supportedActions: CODEX_GOAL_SUPPORTED_ACTIONS,
    source: 'native',
  };
}

function codexUsesFullAccess(approvalPolicy: CodexApprovalPolicy, sandbox: CodexSandboxMode): boolean {
  return approvalPolicy === 'never' && sandbox === 'danger-full-access';
}

export function buildCodexThreadSecurityParams(
  approvalPolicy: CodexApprovalPolicy = DEFAULT_CODEX_APPROVAL_POLICY,
  sandbox: CodexSandboxMode = DEFAULT_CODEX_SANDBOX_MODE,
): { approvalPolicy: CodexApprovalPolicy; sandbox: CodexSandboxMode } {
  return { approvalPolicy, sandbox };
}

// ── MCP injection helpers ───────────────────────────────────────────────────
//
// Codex configures MCP servers via `[mcp_servers.<name>]` sections in its
// config.toml. We inject cockpit-managed servers via repeated `-c
// mcp_servers.<name>.{command,args,env}=…` flags on the Codex invocation.
// Server-configured profiles leave `CODEX_HOME` alone, so Codex uses the
// server user's normal `~/.codex/`; account profiles can set `configDir`,
// which maps to `CODEX_HOME` and isolates auth/config/session state.

function tomlEscapeString(v: string): string {
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
}

function tomlBareKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlEscapeString(k);
}

function hashMcpServers(servers: McpServerConfig[]): string {
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

function codexServiceTierKey(serviceTier?: ServiceTier): string {
  return serviceTier === 'fast' ? 'fast' : '';
}

export function buildCodexServiceTierArgs(serviceTier?: ServiceTier): string[] {
  return serviceTier === 'fast' ? [...CODEX_FAST_SERVICE_TIER_ARGS] : [];
}

async function buildCodexConfigArgs(
  mcpServers: McpServerConfig[],
  runtime: CodexCliRuntime = resolveCodexCliRuntime(),
): Promise<string[]> {
  if (mcpServers.length === 0) return [];

  // Read user's config.toml only for collision detection — we never edit it.
  // If the user has a `[mcp_servers.<name>]` section that matches one we'd
  // inject, the user's wins (we skip ours and warn).
  const userConfigPath = path.join(runtime.configDir || path.join(os.homedir(), '.codex'), 'config.toml');
  let userConfig = '';
  try {
    userConfig = await fs.promises.readFile(userConfigPath, 'utf-8');
  } catch {
    // No user config — nothing to collide with
  }

  const args: string[] = [];
  for (const server of mcpServers) {
    if (userConfig && new RegExp(`^\\[mcp_servers\\.${server.name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'm').test(userConfig)) {
      console.warn(`[codex] User config.toml already defines [mcp_servers.${server.name}] — keeping user's, skipping cockpit injection`);
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

// ── Hardcoded fallback model list ─────────────────────────────────────────��─
//
// On first construction the adapter spawns a transient `codex app-server` in
// the background to query `model/list` and replace this list with whatever
// the running CLI advertises. This static set only fronts the model picker
// for the brief window before that refresh completes (and as a permanent
// fallback when the CLI is missing or `model/list` fails). The OpenAI model
// lineup churns enough that authoritative discovery beats hardcoding.
const FALLBACK_MODELS: ModelOption[] = [
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    family: 'gpt',
    description: 'Latest GPT — default model for codex',
    costTier: 'high',
    default: true,
    supportedEffortLevels: CODEX_FALLBACK_EFFORTS,
  },
  {
    id: 'gpt-5.5-codex',
    label: 'GPT-5.5 Codex',
    family: 'gpt',
    description: 'Codex-tuned variant — optimized for agentic coding tasks',
    costTier: 'high',
    supportedEffortLevels: CODEX_FALLBACK_EFFORTS,
  },
  {
    id: 'gpt-5.5-mini',
    label: 'GPT-5.5 Mini',
    family: 'gpt',
    description: 'Smaller and faster — good for simple tasks',
    costTier: 'low',
    supportedEffortLevels: CODEX_FALLBACK_EFFORTS,
  },
];

// ── Tool Name Normalization (by item TYPE, not tool name) ───────────────────
//
// Codex doesn't expose generic tool names — items in the protocol are typed
// (`commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`,
// `webSearch`, `imageView`, `imageGeneration`, `collabAgentToolCall`). We map
// the item type to Cockpit's canonical tool names. For `mcpToolCall` and
// `dynamicToolCall` the actual tool name is on the item itself and used
// verbatim.
const ITEM_TYPE_TO_TOOL: Record<string, string> = {
  commandExecution: 'Bash',
  fileChange: 'Edit',
  webSearch: 'WebSearch',
  imageView: 'Read',
  imageGeneration: 'ImageGen',
  collabAgentToolCall: 'Agent',
};

interface CodexThreadItem {
  type: string;
  id: string;
  // commandExecution
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  aggregatedOutput?: string | null;
  // fileChange
  changes?: Array<{ path?: string; type?: string }>;
  // mcpToolCall / dynamicToolCall / collabAgentToolCall
  // For collab calls `tool` is a fixed enum: spawnAgent | sendInput |
  // resumeAgent | wait | closeAgent.
  server?: string;
  tool?: string;
  namespace?: string | null;
  // webSearch
  query?: string;
  // imageView
  path?: string;
  // agentMessage
  text?: string;
  // status (varies per item kind)
  status?: string;
  success?: boolean | null;
  // collabAgentToolCall
  senderThreadId?: string;
  receiverThreadIds?: string[];
  prompt?: string;
  agentsStates?: Record<string, { status?: string; message?: string }>;
}

export function extractCodexToolDetails(item: CodexThreadItem): ToolDetail | null {
  const toolName = ITEM_TYPE_TO_TOOL[item.type];

  if (item.type === 'commandExecution') {
    const cmd = item.command || '';
    const short = cmd.length > 60 ? cmd.substring(0, 60) + '...' : cmd;
    return {
      tool: 'Bash',
      id: item.id,
      description: short ? `Running: \`${short}\`` : 'Running command',
    };
  }

  if (item.type === 'fileChange') {
    const first = item.changes && item.changes[0];
    const file = first?.path || '';
    return {
      tool: 'Edit',
      id: item.id,
      description: file ? `Editing \`${shortenPath(file)}\`` : 'Editing files',
    };
  }

  if (item.type === 'mcpToolCall') {
    const server = item.server || '';
    const tool = item.tool || '';
    return {
      tool: tool || 'mcp',
      id: item.id,
      description: server && tool ? `${server}.${tool}` : (tool || 'MCP tool call'),
    };
  }

  if (item.type === 'dynamicToolCall') {
    const tool = item.tool || '';
    const ns = item.namespace || '';
    return {
      tool: tool || 'dynamic',
      id: item.id,
      description: ns && tool ? `${ns}.${tool}` : (tool || 'Dynamic tool call'),
    };
  }

  if (item.type === 'webSearch') {
    const q = item.query || '';
    return {
      tool: 'WebSearch',
      id: item.id,
      description: q ? `Searching: \`${q.length > 60 ? q.substring(0, 60) + '...' : q}\`` : 'Searching the web',
    };
  }

  if (item.type === 'imageView') {
    const p = item.path || '';
    return {
      tool: 'Read',
      id: item.id,
      description: p ? `Viewing \`${shortenPath(p)}\`` : 'Viewing image',
    };
  }

  if (item.type === 'imageGeneration') {
    return {
      tool: 'ImageGen',
      id: item.id,
      description: 'Generating image',
    };
  }

  if (item.type === 'collabAgentToolCall') {
    // `tool` is one of: spawnAgent | sendInput | resumeAgent | wait | closeAgent.
    // `prompt` is set on spawnAgent / sendInput; absent on the others.
    // Child-thread item notifications carry `threadId` at the params level
    // (verified via raw protocol capture; see `lookupParentAgentId`), so
    // `_createStream` attributes child tool activity back to the originating
    // spawnAgent's Agent card via `parentAgentId`.
    const op = item.tool || 'subagent';
    const promptText = item.prompt || '';
    const promptShort = promptText.length > 80 ? promptText.substring(0, 80) + '...' : promptText;
    let description: string;
    if (op === 'spawnAgent') {
      description = promptShort ? `Spawning subagent: \`${promptShort}\`` : 'Spawning subagent';
    } else if (op === 'sendInput') {
      description = promptShort ? `Subagent input: \`${promptShort}\`` : 'Sending input to subagent';
    } else if (op === 'resumeAgent') {
      description = 'Resuming subagent';
    } else if (op === 'wait') {
      description = 'Waiting on subagent';
    } else if (op === 'closeAgent') {
      description = 'Closing subagent';
    } else {
      description = `Subagent ${op}`;
    }
    return {
      tool: 'Agent',
      id: item.id,
      description,
      isAgent: true,
      subagentType: op,
    };
  }

  if (toolName) {
    return { tool: toolName, id: item.id, description: `Using ${toolName}` };
  }

  return null;
}

function deriveOutcomeFromItem(item: CodexThreadItem): { outcome: string; status: 'success' | 'error' | 'warning' } {
  if (item.type === 'commandExecution') {
    const code = item.exitCode;
    if (code === 0) return { outcome: 'exit 0', status: 'success' };
    if (typeof code === 'number') return { outcome: `exit ${code}`, status: 'error' };
    if (item.status === 'failed') return { outcome: 'failed', status: 'error' };
    return { outcome: 'done', status: 'success' };
  }

  if (item.type === 'fileChange') {
    if (item.status === 'failed') return { outcome: 'failed', status: 'error' };
    const count = item.changes ? item.changes.length : 0;
    return { outcome: count > 0 ? `${count} change${count !== 1 ? 's' : ''}` : 'done', status: 'success' };
  }

  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    if (item.success === false || item.status === 'failed' || item.status === 'error') {
      return { outcome: 'error', status: 'error' };
    }
    return { outcome: 'done', status: 'success' };
  }

  if (item.type === 'collabAgentToolCall') {
    // status: inProgress | completed | failed (item-level)
    // agentsStates: per-receiver { status: pendingInit | running | interrupted |
    // completed | errored | shutdown | notFound, message? }. Surface a receiver
    // error even when the call itself "completed" so the user sees subagent
    // failures rather than a misleading green checkmark.
    const states = item.agentsStates ? Object.values(item.agentsStates) : [];
    const hasErrored = states.some((s) => s && (s.status === 'errored' || s.status === 'notFound'));
    if (item.status === 'failed' || hasErrored) return { outcome: 'failed', status: 'error' };
    if (item.status === 'inProgress') return { outcome: 'running', status: 'success' };
    return { outcome: 'done', status: 'success' };
  }

  // Fallback: try the generic outcome extractor by tool name
  const detail = extractCodexToolDetails(item);
  const fallback = detail ? extractToolOutcome(detail.tool, item.aggregatedOutput || '') : null;
  if (fallback) return fallback;

  return { outcome: 'done', status: 'success' };
}

function imageMimeTypeFromBytes(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function imageMimeTypeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.avif') return 'image/avif';
  return 'image/png';
}

function splitImageDataUrl(value: string): { dataBase64: string; mimeType?: string } | null {
  const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is);
  if (!match) return null;
  return { dataBase64: match[2], mimeType: match[1].toLowerCase() };
}

function imageBase64Candidate(value: string): { dataBase64: string; mimeType?: string } | null {
  const dataUrl = splitImageDataUrl(value);
  if (dataUrl) return dataUrl;
  const compact = value.replace(/\s+/g, '');
  if (compact.length < 64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  try {
    const sample = Buffer.from(compact.slice(0, 128), 'base64');
    const mimeType = imageMimeTypeFromBytes(sample);
    return mimeType ? { dataBase64: compact, mimeType } : null;
  } catch {
    return null;
  }
}

function findImageBase64(value: unknown, depth = 0): { dataBase64: string; mimeType?: string } | null {
  if (depth > 4 || value == null) return null;
  if (typeof value === 'string') return imageBase64Candidate(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageBase64(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const priority = ['result', 'image', 'data', 'dataBase64', 'base64', 'b64_json', 'content', 'output'];
  for (const key of priority) {
    if (key in obj) {
      const found = findImageBase64(obj[key], depth + 1);
      if (found) return found;
    }
  }
  for (const [key, child] of Object.entries(obj)) {
    if (priority.includes(key)) continue;
    const found = findImageBase64(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function findExistingImagePath(value: unknown, depth = 0): string | null {
  if (depth > 4 || value == null) return null;
  if (typeof value === 'string') {
    if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(value) && fs.existsSync(value)) return value;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findExistingImagePath(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findExistingImagePath(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function codexConfigDir(runtime?: CodexCliRuntime): string {
  return runtime?.configDir || path.join(os.homedir(), '.codex');
}

export function findCodexGeneratedImagePath(itemId: string, threadId: string | null, runtime?: CodexCliRuntime): string | null {
  const root = path.join(codexConfigDir(runtime), 'generated_images');
  const candidates: string[] = [];
  if (threadId) candidates.push(path.join(root, threadId, `${itemId}.png`));
  candidates.push(path.join(root, `${itemId}.png`));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, `${itemId}.png`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // No generated_images directory for this runtime/profile yet.
  }
  return null;
}

export function codexImageArtifactEvent(
  item: CodexThreadItem,
  threadId: string | null,
  runtime?: CodexCliRuntime,
): Extract<StreamEvent, { type: 'artifact' }> | null {
  if (item.type !== 'imageGeneration') return null;
  const foundBase64 = findImageBase64(item);
  if (foundBase64) {
    return {
      type: 'artifact',
      dataBase64: foundBase64.dataBase64,
      filename: `${item.id}.png`,
      mimeType: foundBase64.mimeType || 'image/png',
      title: 'Generated image',
      sourceToolId: item.id,
    };
  }
  const sourcePath = findExistingImagePath(item) || findCodexGeneratedImagePath(item.id, threadId, runtime);
  if (!sourcePath) return null;
  return {
    type: 'artifact',
    sourcePath,
    filename: path.basename(sourcePath),
    mimeType: imageMimeTypeFromPath(sourcePath),
    title: 'Generated image',
    sourceToolId: item.id,
  };
}

// ── Subagent thread routing ─────────────────────────────────────────────────
//
// Every `item/*` and `item/*/delta` notification carries `threadId` and
// `turnId` at the params level (alongside the `item` object). This is not
// reflected in the public README — verified by capturing raw JSON-RPC traffic
// against `codex app-server` during a multi_agent turn. We use that threadId
// to attribute child-thread activity to the right top-level Agent card.

export function lookupParentAgentId(
  params: Record<string, unknown>,
  subagentByThreadId: Map<string, string>,
): string | undefined {
  const tid = extractCodexThreadId(params);
  if (!tid) return undefined;
  return subagentByThreadId.get(tid);
}

export function eventIsFromChildThread(
  params: Record<string, unknown>,
  subagentByThreadId: Map<string, string>,
): boolean {
  const tid = extractCodexThreadId(params);
  return !!tid && subagentByThreadId.has(tid);
}

export function extractCodexThreadId(params: Record<string, unknown> | undefined | null): string | null {
  const threadId = params && (params as { threadId?: unknown }).threadId;
  return typeof threadId === 'string' && threadId.length > 0 ? threadId : null;
}

export function extractCodexTurnId(params: Record<string, unknown> | undefined | null): string | null {
  if (!params) return null;
  const turnId = (params as { turnId?: unknown }).turnId;
  if (typeof turnId === 'string' && turnId.length > 0) return turnId;
  const turn = (params as { turn?: unknown }).turn;
  if (turn && typeof turn === 'object') {
    const nested = (turn as { id?: unknown }).id;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  return null;
}

export function eventBelongsToActiveParentTurn(
  params: Record<string, unknown>,
  parentThreadId: string | null,
  activeTurnId: string | null,
): boolean {
  return !!parentThreadId
    && !!activeTurnId
    && extractCodexThreadId(params) === parentThreadId
    && extractCodexTurnId(params) === activeTurnId;
}

export function eventBelongsToActiveChildWork(
  params: Record<string, unknown>,
  activeTurnId: string | null,
  subagentByThreadId: Map<string, string>,
): boolean {
  const threadId = extractCodexThreadId(params);
  return !!activeTurnId && !!threadId && subagentByThreadId.has(threadId);
}

export function eventBelongsToActiveStreamWork(
  params: Record<string, unknown>,
  parentThreadId: string | null,
  activeTurnId: string | null,
  subagentByThreadId: Map<string, string>,
): boolean {
  return eventBelongsToActiveParentTurn(params, parentThreadId, activeTurnId)
    || eventBelongsToActiveChildWork(params, activeTurnId, subagentByThreadId);
}

// Multi-agent turns emit one `turn/completed` per thread (each child has its
// own turn lifecycle), so the cockpit can't treat the first one it sees as
// terminal — that's almost always a child's, and acting on it would close
// the stream before the parent's final summary arrives. Only the parent
// thread's `turn/completed` ends the cockpit's notification loop.
export function isParentTurnCompleted(
  params: Record<string, unknown>,
  parentThreadId: string | null,
  activeTurnId?: string | null,
): boolean {
  const completedTid = extractCodexThreadId(params);
  if (!completedTid || !parentThreadId) return true;
  if (activeTurnId != null) {
    return completedTid === parentThreadId && extractCodexTurnId(params) === activeTurnId;
  }
  return completedTid === parentThreadId;
}

// Extract child threadIds from a completed `collabAgentToolCall(spawnAgent)`
// and record each one against the top-level Agent card id. Grand-children
// (spawned by a thread that's already a child) are flattened to the same
// top-level id — the cockpit UI nests one level deep. Non-spawnAgent items
// and spawnAgent items without populated `receiverThreadIds` are no-ops.
export function recordSpawnAgentReceivers(
  item: CodexThreadItem,
  subagentByThreadId: Map<string, string>,
): void {
  if (item.type !== 'collabAgentToolCall') return;
  if (item.tool !== 'spawnAgent') return;
  if (!Array.isArray(item.receiverThreadIds) || item.receiverThreadIds.length === 0) return;
  const senderTid = item.senderThreadId;
  const topLevelCallId = (senderTid && subagentByThreadId.get(senderTid)) || item.id;
  for (const childTid of item.receiverThreadIds) {
    subagentByThreadId.set(childTid, topLevelCallId);
  }
}

// Derive a cockpit `Usage` event from a Codex `thread/tokenUsage/updated`
// notification. Codex exposes both `last` (this turn) and `total` (cumulative)
// counters; we deliberately use `last` for two reasons:
//
// 1. `inputTokens` is reported as `last.inputTokens - last.cachedInputTokens` —
//    only the fresh (uncached) portion of this turn's prompt. Codex's raw
//    `last.inputTokens` includes the entire prior conversation as cache reads,
//    so summing it across turns inflates the session input by the conversation
//    length. Subtracting the cached portion gives a per-turn "fresh input"
//    that matches Anthropic's `input_tokens` semantics (which already excludes
//    cache reads) and accumulates meaningfully via the `+=` aggregator.
// 2. `contextUsagePercentage` is computed from `last.totalTokens`, not
//    `total.totalTokens`. The percentage is meant as a snapshot of the current
//    turn's context window usage (always 0–100). Using cumulative total made
//    it grow without bound — a 10-turn session at full window read 1000%+.
export function deriveCodexUsage(tokenUsage: {
  total: { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
  last: { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
  modelContextWindow: number | null;
}): Usage {
  const last = tokenUsage.last;
  const cached = last.cachedInputTokens || 0;
  const freshInput = Math.max(0, (last.inputTokens || 0) - cached);
  const ctxPct = tokenUsage.modelContextWindow && tokenUsage.modelContextWindow > 0
    ? Math.round((last.totalTokens / tokenUsage.modelContextWindow) * 100)
    : undefined;
  return {
    inputTokens: freshInput,
    outputTokens: last.outputTokens || 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    costUsd: 0,
    contextUsagePercentage: ctxPct,
  };
}

// ── JSON-RPC Protocol Types (minimal hand-typed subset) ─────────────────────
//
// The full protocol surface is generated by `codex app-server generate-ts`
// (see docs/spec-backend-services.md → CodexAdapter). We hand-type only the
// shapes we actually use to keep the file small and avoid vendoring 400+
// generated files. Drift is checked manually by re-running the generator.

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  /** Present when the peer is sending a server-to-client request that needs a response. */
  id?: number;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

interface ThreadStartResult {
  thread: { id: string };
  model?: string;
}

interface ThreadResumeResult {
  thread: { id: string };
}

interface TurnStartResult {
  turn: { id: string; status?: string };
}

interface ThreadGoalGetResult {
  goal: CodexThreadGoal | null;
}

interface ThreadGoalSetResult {
  goal: CodexThreadGoal;
}

interface ThreadGoalClearResult {
  cleared: boolean;
}

interface ThreadReadResult {
  thread?: {
    status?: { type?: string };
    turns?: Array<{ id?: string; status?: string }>;
  };
}

// `item/tool/requestUserInput` (server-to-client request, EXPERIMENTAL,
// API v2 only). The server pauses the turn while waiting for our response.
interface ToolRequestUserInputOption {
  label: string;
  description: string;
}
interface ToolRequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: ToolRequestUserInputOption[];
}
interface ToolRequestUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: ToolRequestUserInputQuestion[];
}
// Each answer is a wrapping object holding a Vec<String> — multi-select capable.
interface ToolRequestUserInputAnswer {
  answers: string[];
}
interface ToolRequestUserInputResponse {
  answers: Record<string, ToolRequestUserInputAnswer>;
}

interface PendingUserInput {
  reqId: number;
  itemId: string;
  turnId: string;
  questions: ToolRequestUserInputQuestion[];
}

interface ModelListResult {
  data: CodexModelListEntry[];
}

interface CodexReasoningEffortOption {
  reasoningEffort?: string;
  effort?: string;
  description?: string;
}

interface CodexModelListEntry {
  id?: string;
  model?: string;
  slug?: string;
  displayName?: string;
  display_name?: string;
  description?: string;
  isDefault?: boolean;
  is_default?: boolean;
  supportedReasoningEfforts?: CodexReasoningEffortOption[];
  supported_reasoning_levels?: CodexReasoningEffortOption[];
  defaultReasoningEffort?: string;
  default_reasoning_level?: string;
}

function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as string[]).includes(v);
}

function normalizeCodexEfforts(raw: unknown): EffortLevel[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const levels: EffortLevel[] = [];
  for (const item of raw) {
    const value = typeof item === 'string'
      ? item
      : (item as CodexReasoningEffortOption | undefined)?.reasoningEffort
        || (item as CodexReasoningEffortOption | undefined)?.effort;
    if (isEffortLevel(value) && CODEX_SUPPORTED_EFFORTS.includes(value) && !levels.includes(value)) {
      levels.push(value);
    }
  }
  return levels.length > 0 ? levels : undefined;
}

export function normalizeCodexModelOption(m: CodexModelListEntry): ModelOption | null {
  const id = m.id || m.model || m.slug;
  if (!id) return null;
  const supportedEffortLevels = normalizeCodexEfforts(m.supportedReasoningEfforts || m.supported_reasoning_levels);
  return {
    id,
    label: m.displayName || m.display_name || id,
    family: 'gpt',
    description: m.description || '',
    // Codex doesn't surface costTier — display all as medium so the
    // picker doesn't lie. Users can still see token usage per turn.
    costTier: 'medium',
    default: m.isDefault || m.is_default || false,
    ...(supportedEffortLevels ? { supportedEffortLevels } : {}),
  };
}

export function codexModelSupportsEffort(models: ModelOption[] | undefined, model: string | undefined, effort: EffortLevel | undefined): boolean {
  if (!model || !effort) return false;
  const modelOption = models?.find((m) => m.id === model);
  return !!modelOption?.supportedEffortLevels?.includes(effort);
}

export function buildCodexTurnStartParams(
  threadId: string,
  input: unknown[],
  model: string | undefined,
  effort: EffortLevel | undefined,
  models: ModelOption[] | undefined,
): Record<string, unknown> {
  const params: Record<string, unknown> = { threadId, input };
  if (model) params.model = model;
  if (codexModelSupportsEffort(models, model, effort)) params.effort = effort;
  return params;
}

function buildCodexGoalTurnPrompt(objective: string | null | undefined): string {
  const trimmedObjective = typeof objective === 'string' ? objective.trim() : '';
  if (!trimmedObjective) return 'Continue working on the active goal and report the result in this chat.';
  return `Work on this active goal and report the result in this chat:\n\n${trimmedObjective}`;
}

function buildCodexGoalReportPrompt(objective: string | null | undefined): string {
  const trimmedObjective = typeof objective === 'string' ? objective.trim() : '';
  if (!trimmedObjective) return 'The goal has completed, but no final report was emitted. Provide the final report in this chat.';
  return `The goal has completed, but no final report was emitted. Provide the final report in this chat.\n\nGoal:\n${trimmedObjective}`;
}

function isTerminalCodexGoalStatus(status: CodexThreadGoalStatus | undefined): boolean {
  return status === 'complete' || status === 'budgetLimited';
}

interface CodexProcessEntry {
  proc: ChildProcess;
  client: CodexAppServerClient;
  initialized: boolean;
  threadId: string | null;
  idleTimer: NodeJS.Timeout | null;
  /** Hash of the mcpServers list this process was spawned with, or '' if none. */
  mcpHash: string;
  /** Hash of the Codex command/config/env profile used to spawn this process. */
  profileKey: string;
  /** Service tier override used to spawn this process, or '' for profile default. */
  serviceTierKey: string;
  /**
   * Last `total.totalTokens` we emitted a usage event for. Codex re-emits a
   * `thread/tokenUsage/updated` notification at every turn boundary that
   * mirrors the prior turn's final state — `last_token_usage` and
   * `total_token_usage` are byte-for-byte identical to the previous event.
   * Without filtering, the cockpit's `+=` aggregator double-counts one turn's
   * worth of tokens at every transition. Tracking the last emitted total per
   * app-server process (which is per-conversation) lets us drop these
   * duplicates while preserving genuine per-API-call updates within a turn.
   */
  lastTotalTokens: number;
}

// ── App Server JSON-RPC Client ──────────────────────────────────────────────

class CodexAppServerClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pendingRequests: Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }> = new Map();
  private notificationQueue: JsonRpcNotification[] = [];
  private notificationResolve: (() => void) | null = null;
  private buffer = '';
  private closed = false;
  private stopRequested = false;

  constructor(proc: ChildProcess) {
    this.proc = proc;

    proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcMessage;
          if ('method' in msg && msg.method) {
            // Notification or server-to-client request — both go through
            // the queue; the consumer distinguishes by the presence of `id`.
            this.notificationQueue.push(msg as JsonRpcNotification);
            if (this.notificationResolve) {
              this.notificationResolve();
              this.notificationResolve = null;
            }
          } else if ('id' in msg && msg.id != null) {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
              this.pendingRequests.delete(msg.id);
              const resp = msg as JsonRpcResponse;
              if (resp.error) {
                pending.reject(new Error(resp.error.message));
              } else {
                pending.resolve(resp.result);
              }
            }
          }
        } catch {
          console.warn('[codex] Failed to parse app-server message:', line.substring(0, 200));
        }
      }
    });

    proc.on('close', () => {
      this.closed = true;
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error('Codex app-server closed'));
      }
      this.pendingRequests.clear();
      if (this.notificationResolve) {
        this.notificationResolve();
        this.notificationResolve = null;
      }
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error('Codex app-server is closed');

    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.proc.stdin!.write(JSON.stringify(msg) + '\n');
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return;
    const msg = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    this.proc.stdin!.write(JSON.stringify(msg) + '\n');
  }

  respond(id: number, result: unknown): void {
    if (this.closed) return;
    const msg = { jsonrpc: '2.0', id, result };
    this.proc.stdin!.write(JSON.stringify(msg) + '\n');
  }

  respondError(id: number, code: number, message: string): void {
    if (this.closed) return;
    const msg = { jsonrpc: '2.0', id, error: { code, message } };
    this.proc.stdin!.write(JSON.stringify(msg) + '\n');
  }

  stopNotifications(): void {
    this.stopRequested = true;
    if (this.notificationResolve) {
      this.notificationResolve();
      this.notificationResolve = null;
    }
  }

  async *notifications(): AsyncGenerator<JsonRpcNotification> {
    while (!this.closed && !this.stopRequested) {
      if (this.notificationQueue.length > 0) {
        yield this.notificationQueue.shift()!;
      } else {
        await new Promise<void>((resolve) => {
          this.notificationResolve = resolve;
          setTimeout(resolve, 100);
        });
      }
    }
    while (this.notificationQueue.length > 0) {
      yield this.notificationQueue.shift()!;
    }
    this.stopRequested = false;
  }

  drainNotifications(onDrain?: (notification: JsonRpcNotification) => void): number {
    const drained = this.notificationQueue;
    this.notificationQueue = [];
    for (const notification of drained) {
      onDrain?.(notification);
    }
    const count = drained.length;
    return count;
  }

  kill(): void {
    if (!this.closed) {
      this.proc.kill('SIGTERM');
      // Hard kill if it doesn't shut down cleanly
      setTimeout(() => {
        if (!this.closed && !this.proc.killed) {
          this.proc.kill('SIGKILL');
        }
      }, PROCESS_KILL_GRACE_MS);
    }
  }
}

// ── Adapter ─────────────────────────────────────────────────────────────────

export class CodexAdapter extends BaseBackendAdapter {
  private processes: Map<string, CodexProcessEntry> = new Map();
  private modelCache: ModelOption[] | null = null;
  private profileModelCache: Map<string, ModelOption[]> = new Map();
  private modelRefreshes: Map<string, Promise<ModelOption[]>> = new Map();
  private readonly approvalPolicy: CodexApprovalPolicy;
  private readonly sandbox: CodexSandboxMode;

  constructor(options: { workingDir?: string; approvalPolicy?: CodexApprovalPolicy; sandbox?: CodexSandboxMode } = {}) {
    super(options);
    this.workingDir = options.workingDir || path.resolve(os.homedir(), '.codex', 'workspace');
    this.approvalPolicy = options.approvalPolicy || DEFAULT_CODEX_APPROVAL_POLICY;
    this.sandbox = options.sandbox || DEFAULT_CODEX_SANDBOX_MODE;

    // Best-effort dynamic model discovery in the background. Failure (CLI
    // missing, auth missing, network blocked) is not fatal — the picker
    // shows the fallback list until the user installs/auths Codex.
    //
    // Skipped under Jest so unit tests don't spawn real codex processes
    // (would prevent Jest from exiting cleanly).
    if (!process.env.JEST_WORKER_ID) {
      this._refreshModels().catch((err) => {
        console.warn(`[codex] model/list refresh failed: ${err.message || err}`);
      });
    }
  }

  get metadata(): BackendMetadata {
    return {
      id: 'codex',
      label: 'Codex',
      icon: CODEX_ICON,
      capabilities: {
        thinking: true,
        planMode: false,
        agents: true,
        toolActivity: true,
        userQuestions: true,
        stdinInput: true,
        goals: {
          set: true,
          clear: true,
          pause: true,
          resume: true,
          status: 'native',
        },
      },
      resumeCapabilities: {
        activeTurnResume: 'unsupported',
        activeTurnResumeReason: 'Codex thread/resume restores the thread for a later turn, but the adapter does not have a safe protocol path to reattach to a turn already running before the cockpit process restarted.',
        sessionResume: 'supported',
        sessionResumeReason: 'The adapter persists Codex thread IDs via external_session and uses thread/resume after process respawn before starting the next turn.',
      },
      models: this.modelCache || FALLBACK_MODELS,
    };
  }

  async getMetadata(options: BackendCallOptions = {}): Promise<BackendMetadata> {
    const models = await this._getModels(options.cliProfile);
    return {
      ...this.metadata,
      models,
    };
  }

  shutdown(): void {
    for (const [, entry] of this.processes) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.proc.kill('SIGTERM');
    }
    this.processes.clear();
  }

  onSessionReset(conversationId: string): void {
    const entry = this.processes.get(conversationId);
    if (entry) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.proc.kill('SIGTERM');
      this.processes.delete(conversationId);
    }
  }

  sendMessage(message: string, options: SendMessageOptions = {} as SendMessageOptions): SendMessageResult {
    let aborted = false;
    const state: {
      client: CodexAppServerClient | null;
      threadId: string | null;
      turnId: string | null;
      pendingUserInput: PendingUserInput | null;
      subagentByThreadId: Map<string, string>;
    } = {
      client: null,
      threadId: null,
      turnId: null,
      pendingUserInput: null,
      subagentByThreadId: new Map(),
    };

    const stream = this._createStream(message, options, {
      get aborted() { return aborted; },
      get client() { return state.client; },
      set client(c: CodexAppServerClient | null) { state.client = c; },
      get threadId() { return state.threadId; },
      set threadId(t: string | null) { state.threadId = t; },
      get turnId() { return state.turnId; },
      set turnId(t: string | null) { state.turnId = t; },
      get pendingUserInput() { return state.pendingUserInput; },
      set pendingUserInput(p: PendingUserInput | null) { state.pendingUserInput = p; },
      subagentByThreadId: state.subagentByThreadId,
    });

    const abort = () => {
      aborted = true;
      const { client, threadId, turnId } = state;
      if (client && !client.isClosed && threadId && turnId) {
        client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      }
    };

    // Route the user's input either to a pending `item/tool/requestUserInput`
    // request (JSON-RPC response) or to the in-flight turn (`turn/steer`):
    //   • If the server is currently waiting on a user-question, build a
    //     `ToolRequestUserInputResponse` and reply to the original request.
    //     Only the first question gets the user's text — the cockpit UI
    //     surfaces a single question at a time. The server tolerates partial
    //     answers (HashMap is unconstrained on the wire).
    //   • Otherwise append the text to the active turn via `turn/steer`,
    //     passing `expectedTurnId` so the server rejects stale UI input
    //     rather than applying it to a turn the user didn't intend.
    // No-ops when aborted, when text is empty/non-string, or when the
    // client/threadId state isn't populated yet.
    const sendInput = (text: string) => {
      if (aborted) return;
      if (typeof text !== 'string' || !text) return;
      const { client, threadId, turnId, pendingUserInput } = state;
      if (!client || client.isClosed || !threadId) return;

      if (pendingUserInput) {
        const first = pendingUserInput.questions[0];
        const response: ToolRequestUserInputResponse = { answers: {} };
        if (first) response.answers[first.id] = { answers: [text] };
        state.pendingUserInput = null;
        client.respond(pendingUserInput.reqId, response);
        return;
      }

      if (!turnId) return;
      client.request('turn/steer', {
        threadId,
        input: [{ type: 'text', text }],
        expectedTurnId: turnId,
      }).catch((err: Error) => {
        console.warn(`[codex] turn/steer rejected: ${err.message}`);
      });
    };

    return { stream, abort, sendInput };
  }

  async getGoal(options: SendMessageOptions): Promise<ThreadGoal | null> {
    const ctx = await this._getGoalThreadContext(options, { allowStart: false, reuseExistingMcp: true });
    if (!ctx.threadId) return null;
    const result = await ctx.client.request('thread/goal/get', { threadId: ctx.threadId }) as ThreadGoalGetResult;
    return normalizeCodexGoal(result.goal);
  }

  setGoalObjective(objective: string, options: SendMessageOptions = {} as SendMessageOptions): SendMessageResult {
    return this._createGoalRun({ objective: objective.trim() }, options);
  }

  resumeGoal(options: SendMessageOptions = {} as SendMessageOptions): SendMessageResult {
    return this._createGoalRun({ status: 'active' }, options);
  }

  async pauseGoal(options: SendMessageOptions): Promise<ThreadGoal | null> {
    const ctx = await this._getGoalThreadContext(options, { allowStart: false, reuseExistingMcp: true });
    if (!ctx.threadId) return null;
    const result = await ctx.client.request('thread/goal/set', {
      threadId: ctx.threadId,
      status: 'paused',
    }) as ThreadGoalSetResult;
    return normalizeCodexGoal(result.goal);
  }

  async clearGoal(options: SendMessageOptions): Promise<{ cleared: boolean; threadId?: string | null }> {
    const ctx = await this._getGoalThreadContext(options, { allowStart: false, reuseExistingMcp: true });
    if (!ctx.threadId) return { cleared: false, threadId: null };
    const result = await ctx.client.request('thread/goal/clear', { threadId: ctx.threadId }) as ThreadGoalClearResult;
    return { cleared: !!result.cleared, threadId: ctx.threadId };
  }

  private _createGoalRun(
    goalPatch: { objective?: string; status?: Extract<CodexThreadGoalStatus, 'active'> },
    options: SendMessageOptions,
  ): SendMessageResult {
    let aborted = false;
    const state: {
      client: CodexAppServerClient | null;
      threadId: string | null;
      turnId: string | null;
      pendingUserInput: PendingUserInput | null;
      subagentByThreadId: Map<string, string>;
    } = {
      client: null,
      threadId: null,
      turnId: null,
      pendingUserInput: null,
      subagentByThreadId: new Map(),
    };

    const stream = this._createGoalStream(goalPatch, options, {
      get aborted() { return aborted; },
      get client() { return state.client; },
      set client(c: CodexAppServerClient | null) { state.client = c; },
      get threadId() { return state.threadId; },
      set threadId(t: string | null) { state.threadId = t; },
      get turnId() { return state.turnId; },
      set turnId(t: string | null) { state.turnId = t; },
      get pendingUserInput() { return state.pendingUserInput; },
      set pendingUserInput(p: PendingUserInput | null) { state.pendingUserInput = p; },
      subagentByThreadId: state.subagentByThreadId,
    });

    const abort = () => {
      aborted = true;
      const { client, threadId, turnId } = state;
      if (client && !client.isClosed && threadId && turnId) {
        client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      }
    };

    const sendInput = (text: string) => {
      if (aborted) return;
      if (typeof text !== 'string' || !text) return;
      const { client, threadId, turnId, pendingUserInput } = state;
      if (!client || client.isClosed || !threadId) return;

      if (pendingUserInput) {
        const first = pendingUserInput.questions[0];
        const response: ToolRequestUserInputResponse = { answers: {} };
        if (first) response.answers[first.id] = { answers: [text] };
        state.pendingUserInput = null;
        client.respond(pendingUserInput.reqId, response);
        return;
      }

      if (!turnId) return;
      client.request('turn/steer', {
        threadId,
        input: [{ type: 'text', text }],
        expectedTurnId: turnId,
      }).catch((err: Error) => {
        console.warn(`[codex] goal turn/steer rejected: ${err.message}`);
      });
    };

    return { stream, abort, sendInput };
  }

  async generateSummary(
    messages: Pick<Message, 'role' | 'content'>[],
    fallback: string,
    options: BackendCallOptions = {},
  ): Promise<string> {
    if (!messages || messages.length === 0) return fallback || 'Empty session';
    try {
      let sessionText = '';
      for (const msg of messages) {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        const content = msg.content.substring(0, 500);
        sessionText += `${role}: ${content}\n\n`;
        if (sessionText.length > 4000) break;
      }
      const prompt = `Summarize the following chat session in one concise sentence (100-150 characters max). Only output the summary, nothing else:\n\n${sessionText}`;

      const out = await this._execOneShot(prompt, { timeoutMs: 30000, cliProfile: options.cliProfile });
      if (!out) return fallback || `Session (${messages.length} messages)`;
      return out.substring(0, 200);
    } catch {
      return fallback || `Session (${messages.length} messages)`;
    }
  }

  async generateTitle(userMessage: string, fallback: string, options: BackendCallOptions = {}): Promise<string> {
    if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
      return fallback || 'New Chat';
    }
    const titleFallback = () => fallback || userMessage.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
    try {
      const truncated = userMessage.substring(0, 2000);
      const prompt = `Generate a short, descriptive title (max 8 words) for a conversation that starts with this user message. Only output the title text, nothing else — no quotes, no prefix:\n\n${truncated}`;

      const out = await this._execOneShot(prompt, { timeoutMs: 30000, cliProfile: options.cliProfile });
      if (!out) return titleFallback();
      return out.substring(0, 80);
    } catch {
      return titleFallback();
    }
  }

  /**
   * Run a one-shot prompt via `codex exec` and return the model's final
   * answer text. Used by the Memory MCP server, KB digestion, generateTitle,
   * and generateSummary. `codex exec` uses the selected profile's runtime
   * env; account profiles set `CODEX_HOME` so OAuth/API-key state is isolated.
   */
  async runOneShot(prompt: string, options: RunOneShotOptions = {}): Promise<string> {
    return this._execOneShot(prompt, options);
  }

  // ── Private: model discovery ──────────────────────────────────────────────

  private _cacheModels(runtime: CodexCliRuntime, models: ModelOption[]): void {
    if (runtime.profileKey.startsWith('server-configured:')) {
      this.modelCache = models;
    } else {
      this.profileModelCache.set(runtime.profileKey, models);
    }
  }

  private _cachedModels(runtime: CodexCliRuntime): ModelOption[] | null {
    if (runtime.profileKey.startsWith('server-configured:')) {
      return this.modelCache;
    }
    return this.profileModelCache.get(runtime.profileKey) || null;
  }

  private _modelsFor(profile?: CliProfile): ModelOption[] {
    const runtime = resolveCodexCliRuntime(profile);
    return this._cachedModels(runtime) || FALLBACK_MODELS;
  }

  private async _getModels(profile?: CliProfile): Promise<ModelOption[]> {
    const runtime = resolveCodexCliRuntime(profile);
    const cached = this._cachedModels(runtime);
    if (cached && cached.length > 0) return cached;

    let refresh = this.modelRefreshes.get(runtime.profileKey);
    if (!refresh) {
      refresh = this._refreshModels(profile);
      this.modelRefreshes.set(runtime.profileKey, refresh);
      refresh.finally(() => this.modelRefreshes.delete(runtime.profileKey)).catch(() => {});
    }

    try {
      return await refresh;
    } catch (err) {
      console.warn(`[codex] model/list refresh failed: ${(err as Error).message || err}`);
      return this._cachedModels(runtime) || FALLBACK_MODELS;
    }
  }

  private async _refreshModels(profile?: CliProfile): Promise<ModelOption[]> {
    const runtime = resolveCodexCliRuntime(profile);
    const invocation = buildCliCommandInvocation(runtime, CODEX_APP_SERVER_ARGS);
    const proc = spawn(invocation.command, invocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: runtime.env,
    });

    let spawnFailed = false;
    proc.on('error', () => {
      // ENOENT etc — silently fall back. Logged at the catch in constructor.
      spawnFailed = true;
    });

    // Safety: kill the process even if something below hangs.
    const killTimer = setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 15_000);

    try {
      // Wait one tick so the spawn ENOENT event has a chance to fire before
      // we try to write to stdin and crash with EPIPE.
      await new Promise<void>((r) => setImmediate(r));
      if (spawnFailed) return this._cachedModels(runtime) || FALLBACK_MODELS;

      const client = new CodexAppServerClient(proc);
      await client.request('initialize', {
        clientInfo: { name: 'agent-cockpit', title: null, version: '1.0.0' },
        capabilities: CODEX_CLIENT_CAPABILITIES,
      });
      const result = await client.request('model/list', {
        limit: 50,
        includeHidden: false,
      }) as ModelListResult;

      if (result && Array.isArray(result.data) && result.data.length > 0) {
        const models = result.data
          .map(normalizeCodexModelOption)
          .filter((m): m is ModelOption => m !== null);
        // Ensure exactly one default
        if (models.length > 0 && !models.some((m) => m.default)) {
          models[0].default = true;
        }
        if (models.length > 0) {
          this._cacheModels(runtime, models);
          return models;
        }
      }
      return this._cachedModels(runtime) || FALLBACK_MODELS;
    } finally {
      clearTimeout(killTimer);
      if (!proc.killed) proc.kill('SIGTERM');
    }
  }

  // ── Private: process lifecycle ────────────────────────────────────────────

  private _resetIdleTimer(conversationId: string): void {
    const entry = this.processes.get(conversationId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      console.log(`[codex] Idle timeout for conv=${conversationId}, killing app-server`);
      entry.proc.kill('SIGTERM');
      this.processes.delete(conversationId);
    }, CODEX_IDLE_TIMEOUT_MS);
  }

  private async _getOrSpawnClient(
    conversationId: string,
    mcpServers: McpServerConfig[] = [],
    profile?: CliProfile,
    options: { reuseExistingMcp?: boolean; serviceTier?: ServiceTier } = {},
  ): Promise<CodexAppServerClient> {
    const runtime = resolveCodexCliRuntime(profile);
    const mcpHash = hashMcpServers(mcpServers);
    const serviceTierKey = codexServiceTierKey(options.serviceTier);
    const existing = this.processes.get(conversationId);
    if (
      existing
      && !existing.proc.killed
      && existing.proc.exitCode === null
      && (options.reuseExistingMcp || existing.mcpHash === mcpHash)
      && existing.profileKey === runtime.profileKey
      && existing.serviceTierKey === serviceTierKey
    ) {
      this._resetIdleTimer(conversationId);
      return existing.client;
    }

    if (existing) {
      if (existing.mcpHash !== mcpHash) {
        console.log(`[codex] MCP set changed for conv=${conversationId}, respawning app-server`);
      }
      if (existing.profileKey !== runtime.profileKey) {
        console.log(`[codex] CLI profile changed for conv=${conversationId}, respawning app-server`);
      }
      if (existing.serviceTierKey !== serviceTierKey) {
        console.log(`[codex] service tier changed for conv=${conversationId}, respawning app-server`);
      }
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      existing.proc.kill('SIGTERM');
      this.processes.delete(conversationId);
    }

    const configArgs = await buildCodexConfigArgs(mcpServers, runtime);
    const serviceTierArgs = buildCodexServiceTierArgs(options.serviceTier);
    if (serviceTierArgs.length > 0) {
      console.log(`[codex] Forcing Fast mode for conv=${conversationId}`);
    }
    if (configArgs.length > 0) {
      console.log(`[codex] Injecting ${mcpServers.length} MCP server(s) via -c flags for conv=${conversationId}`);
    }

    console.log(`[codex] Spawning codex app-server for conv=${conversationId}`);
    const invocation = buildCliCommandInvocation(runtime, [...CODEX_APP_SERVER_ARGS, ...serviceTierArgs, ...configArgs]);
    const proc = spawn(invocation.command, invocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: runtime.env,
    });

    proc.on('error', (err) => {
      console.error(`[codex] Process spawn error: ${err.message}`);
    });
    proc.on('close', (code, signal) => {
      console.log(`[codex] Process closed for conv=${conversationId} code=${code} signal=${signal}`);
    });
    proc.stderr!.on('data', (chunk: Buffer) => {
      console.error(`[codex] stderr: ${chunk.toString().substring(0, 500)}`);
    });

    const client = new CodexAppServerClient(proc);

    await client.request('initialize', {
      clientInfo: { name: 'agent-cockpit', title: null, version: '1.0.0' },
      capabilities: CODEX_CLIENT_CAPABILITIES,
    });
    console.log(`[codex] app-server initialized for conv=${conversationId}`);

    this.processes.set(conversationId, {
      proc,
      client,
      initialized: true,
      threadId: null,
      idleTimer: null,
      mcpHash,
      profileKey: runtime.profileKey,
      serviceTierKey,
      lastTotalTokens: 0,
    });
    this._resetIdleTimer(conversationId);

    return client;
  }

  // ── Private: streaming session ────────────────────────────────────────────

  private async _resolveThread(
    client: CodexAppServerClient,
    entry: CodexProcessEntry,
    convId: string,
    options: SendMessageOptions,
  ): Promise<{ threadId: string | null; externalSessionId?: string }> {
    const { isNewSession, workingDir, systemPrompt, externalSessionId, model } = options;
    const cwd = workingDir || this.workingDir || os.homedir();
    let threadId = entry.threadId;

    if (isNewSession && !threadId) {
      const cleanPrompt = sanitizeSystemPrompt(systemPrompt);
      const startParams: Record<string, unknown> = {
        cwd,
        ...buildCodexThreadSecurityParams(this.approvalPolicy, this.sandbox),
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      };
      if (model) startParams.model = model;
      if (cleanPrompt) startParams.developerInstructions = cleanPrompt;

      const result = await client.request('thread/start', startParams) as ThreadStartResult;
      threadId = result.thread.id;
      entry.threadId = threadId;
      console.log(`[codex] Started thread ${threadId} for conv=${convId}`);
      return { threadId, externalSessionId: threadId };
    }

    if (threadId) {
      return { threadId };
    }

    if (externalSessionId) {
      const resumeParams: Record<string, unknown> = {
        threadId: externalSessionId,
        cwd,
        ...buildCodexThreadSecurityParams(this.approvalPolicy, this.sandbox),
        excludeTurns: true,
        persistExtendedHistory: false,
      };
      if (model) resumeParams.model = model;

      try {
        const result = await client.request('thread/resume', resumeParams) as ThreadResumeResult;
        threadId = result.thread.id;
        entry.threadId = threadId;
        const drained = client.drainNotifications((notification) => {
          this._respondToStaleServerRequest(client, notification, 'Stale Codex request ignored after thread resume');
        });
        console.log(`[codex] Resumed thread ${threadId} for conv=${convId} (drained ${drained} notifications)`);
        return { threadId };
      } catch (err) {
        console.warn(`[codex] Resume failed for ${externalSessionId}: ${(err as Error).message}. Starting fresh thread.`);
        const startParams: Record<string, unknown> = {
          cwd,
          ...buildCodexThreadSecurityParams(this.approvalPolicy, this.sandbox),
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        };
        if (model) startParams.model = model;
        const result = await client.request('thread/start', startParams) as ThreadStartResult;
        threadId = result.thread.id;
        entry.threadId = threadId;
        return { threadId, externalSessionId: threadId };
      }
    }

    return { threadId: null };
  }

  private async _getGoalThreadContext(
    options: SendMessageOptions,
    control: { allowStart: boolean; reuseExistingMcp?: boolean },
  ): Promise<{
    client: CodexAppServerClient;
    entry: CodexProcessEntry;
    convId: string;
    threadId: string | null;
    externalSessionId?: string;
  }> {
    const { sessionId, conversationId, mcpServers, cliProfile, serviceTier } = options;
    const convId = conversationId || sessionId;
    const mcpServersForCodex: McpServerConfig[] = Array.isArray(mcpServers) ? mcpServers : [];
    const client = await this._getOrSpawnClient(convId, mcpServersForCodex, cliProfile, {
      reuseExistingMcp: control.reuseExistingMcp,
      serviceTier,
    });
    const entry = this.processes.get(convId)!;
    const resolved = await this._resolveThread(client, entry, convId, {
      ...options,
      isNewSession: control.allowStart ? options.isNewSession : false,
    });
    return {
      client,
      entry,
      convId,
      threadId: resolved.threadId,
      ...(resolved.externalSessionId ? { externalSessionId: resolved.externalSessionId } : {}),
    };
  }

  private _respondToStaleServerRequest(
    client: CodexAppServerClient,
    notification: JsonRpcNotification,
    reason: string,
  ): boolean {
    if (notification.id == null) return false;
    const reqId = notification.id;
    switch (notification.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        client.respond(reqId, { decision: 'cancel' });
        return true;
      case 'item/permissions/requestApproval':
      case 'item/tool/requestUserInput':
        client.respondError(reqId, -32000, reason);
        return true;
      case 'applyPatchApproval':
      case 'execCommandApproval':
        client.respond(reqId, { decision: 'abort' });
        return true;
      default:
        client.respondError(reqId, -32601, 'Not supported by client');
        return true;
    }
  }

  private _drainQueuedNotificationsBeforeRun(
    client: CodexAppServerClient,
    convId: string,
    phase: 'chat' | 'goal',
  ): void {
    const requestMethods = new Map<string, number>();
    const drained = client.drainNotifications((notification) => {
      if (notification.id != null) {
        requestMethods.set(notification.method, (requestMethods.get(notification.method) || 0) + 1);
        this._respondToStaleServerRequest(client, notification, 'Stale Codex request ignored before starting a new turn');
      }
    });
    if (drained > 0) {
      codexLog.warn('drained queued Codex notifications before starting turn', {
        conversationId: convId,
        phase,
        drained,
        serverRequests: Object.fromEntries(requestMethods.entries()),
      });
    }
  }

  private async _interruptActiveOrphanTurnIfAny(
    client: CodexAppServerClient,
    convId: string,
    threadId: string,
    phase: 'chat' | 'goal',
  ): Promise<void> {
    try {
      const result = await client.request('thread/read', { threadId, includeTurns: true }) as ThreadReadResult;
      const turns = result.thread?.turns || [];
      const activeTurn = [...turns].reverse().find((turn) => (
        typeof turn.id === 'string' && turn.status === 'inProgress'
      ));
      if (!activeTurn?.id) return;
      codexLog.warn('interrupting orphaned Codex turn before starting new turn', {
        conversationId: convId,
        threadId,
        turnId: activeTurn.id,
      });
      await client.request('turn/interrupt', { threadId, turnId: activeTurn.id }).catch((err: Error) => {
        codexLog.warn('failed to interrupt orphaned Codex turn', {
          conversationId: convId,
          threadId,
          turnId: activeTurn.id,
          errorMessage: err.message,
        });
      });
      this._drainQueuedNotificationsBeforeRun(client, convId, phase);
    } catch (err) {
      codexLog.warn('failed to inspect Codex thread for orphaned active turn', {
        conversationId: convId,
        threadId,
        errorMessage: (err as Error).message,
      });
    }
  }

  private async *_createGoalStream(
    goalPatch: { objective?: string; status?: Extract<CodexThreadGoalStatus, 'active'> },
    options: SendMessageOptions,
    state: {
      readonly aborted: boolean;
      client: CodexAppServerClient | null;
      threadId: string | null;
      turnId: string | null;
      pendingUserInput: PendingUserInput | null;
      subagentByThreadId: Map<string, string>;
    },
  ): AsyncGenerator<StreamEvent> {
    const { model, effort, cliProfile } = options;
    const runtime = resolveCodexCliRuntime(cliProfile);

    let ctx: Awaited<ReturnType<CodexAdapter['_getGoalThreadContext']>>;
    try {
      ctx = await this._getGoalThreadContext(options, { allowStart: true });
      state.client = ctx.client;
    } catch (err) {
      const errMsg = (err as Error).message;
      if (errMsg.includes('ENOENT') || errMsg.includes('not found')) {
        yield { type: 'error', error: 'Codex CLI is not installed. Install with `npm install -g @openai/codex`' };
      } else {
        yield { type: 'error', error: `Failed to start Codex: ${errMsg}` };
      }
      yield { type: 'done' };
      return;
    }

    const { client, entry, convId, threadId } = ctx;
    if (ctx.externalSessionId) {
      yield { type: 'external_session', sessionId: ctx.externalSessionId };
    }

    if (!threadId) {
      yield { type: 'error', error: 'No Codex thread ID available for this conversation' };
      yield { type: 'done' };
      return;
    }

    state.threadId = threadId;
    yield {
      type: 'backend_runtime',
      externalSessionId: threadId,
      processId: entry.proc.pid ?? null,
    };

    if (!ctx.externalSessionId) {
      this._drainQueuedNotificationsBeforeRun(client, convId, 'goal');
      await this._interruptActiveOrphanTurnIfAny(client, convId, threadId, 'goal');
    }

    try {
      const setParams: Record<string, unknown> = {
        threadId,
        status: 'active',
      };
      if (goalPatch.objective) setParams.objective = goalPatch.objective;
      const setResult = await client.request('thread/goal/set', setParams) as ThreadGoalSetResult;
      const normalizedGoal = normalizeCodexGoal(setResult.goal);
      if (normalizedGoal) yield { type: 'goal_updated', goal: normalizedGoal };

      const toolByItemId: Map<string, string> = new Map();
      let turnStarted = false;
      let turnEnded = false;
      let emittedText = false;
      let needsReportTurn = false;
      let emittedRuntimeTurnId: string | null = null;
      const emitRuntimeTurnId = (turnId: string): StreamEvent | null => {
        if (emittedRuntimeTurnId === turnId) return null;
        if (state.turnId && state.turnId !== turnId) return null;
        state.turnId = turnId;
        turnStarted = true;
        emittedRuntimeTurnId = turnId;
        return {
          type: 'backend_runtime',
          externalSessionId: threadId,
          activeTurnId: turnId,
          processId: entry.proc.pid ?? null,
        };
      };

      const activeObjective = normalizedGoal?.objective || goalPatch.objective || '';
      const userInput = [{
        type: 'text',
        text: buildCodexGoalTurnPrompt(activeObjective),
        text_elements: [],
      }];
      const modelCatalog = this._modelsFor(cliProfile);
      const turnParams = buildCodexTurnStartParams(threadId, userInput, model, effort, modelCatalog);
      try {
        const turnResp = await client.request('turn/start', turnParams) as TurnStartResult;
        const turnId = turnResp.turn.id;
        const runtimeEvent = emitRuntimeTurnId(turnId);
        if (runtimeEvent) yield runtimeEvent;
      } catch (err) {
        yield { type: 'error', error: `Codex goal turn failed: ${(err as Error).message}` };
        yield { type: 'done' };
        return;
      }

      const notificationIterator = client.notifications()[Symbol.asyncIterator]();
      let nextNotification = notificationIterator.next();

      while (true) {
        const next = await Promise.race([
          nextNotification.then((result) => ({ type: 'notification' as const, result })),
          new Promise<{ type: 'goal_poll' }>((resolve) => {
            setTimeout(() => resolve({ type: 'goal_poll' }), CODEX_GOAL_STATUS_POLL_MS);
          }),
        ]);

        if (next.type === 'goal_poll') {
          try {
            const goalResult = await client.request('thread/goal/get', { threadId }) as ThreadGoalGetResult;
            const polledGoal = normalizeCodexGoal(goalResult.goal);
            if (isTerminalCodexGoalStatus(goalResult.goal?.status)) {
              if (polledGoal) yield { type: 'goal_updated', goal: polledGoal };
              if (!emittedText) needsReportTurn = true;
              turnEnded = true;
              client.stopNotifications();
              break;
            }
          } catch (err) {
            codexLog.warn('failed to poll Codex goal status while streaming', {
              conversationId: convId,
              threadId,
              errorMessage: (err as Error).message,
            });
          }
          continue;
        }

        if (next.result.done) break;
        const notification = next.result.value;
        nextNotification = notificationIterator.next();

        if (state.aborted) {
          yield { type: 'error', error: 'Aborted by user' };
          yield { type: 'done' };
          return;
        }

        this._resetIdleTimer(convId);

        const params = (notification.params || {}) as Record<string, unknown>;
        const method = notification.method;

        if (notification.id != null) {
          const reqId = notification.id;

          if (method === 'item/commandExecution/requestApproval'
              || method === 'item/fileChange/requestApproval') {
            if (!eventBelongsToActiveStreamWork(params, state.threadId, state.turnId, state.subagentByThreadId)) {
              this._respondToStaleServerRequest(client, notification, 'Stale Codex goal approval request ignored');
              continue;
            }
            client.respond(reqId, { decision: 'acceptForSession' });
            continue;
          }

          if (method === 'item/permissions/requestApproval') {
            if (!eventBelongsToActiveStreamWork(params, state.threadId, state.turnId, state.subagentByThreadId)) {
              this._respondToStaleServerRequest(client, notification, 'Stale Codex goal permissions request ignored');
              continue;
            }
            client.respond(reqId, {
              permissions: { network: undefined, fileSystem: undefined },
              scope: 'session',
            });
            continue;
          }

          if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
            client.respond(reqId, { decision: 'approved' });
            continue;
          }

          if (method === 'item/tool/requestUserInput') {
            if (!eventBelongsToActiveStreamWork(params, state.threadId, state.turnId, state.subagentByThreadId)) {
              this._respondToStaleServerRequest(client, notification, 'Stale Codex goal user-input request ignored');
              continue;
            }
            const p = params as unknown as ToolRequestUserInputParams;
            const questions = Array.isArray(p.questions) ? p.questions : [];
            state.pendingUserInput = { reqId, itemId: p.itemId, turnId: p.turnId, questions };
            const first = questions[0];
            yield {
              type: 'tool_activity',
              tool: 'AskUserQuestion',
              id: p.itemId,
              description: (first && first.header) || 'Question',
              isQuestion: true,
              questions: questions.map((q) => ({
                question: q.question,
                options: Array.isArray(q.options) ? q.options : [],
              })),
            };
            continue;
          }

          client.respond(reqId, { error: { code: -32601, message: 'Not supported by client' } });
          continue;
        }

        switch (method) {
          case 'thread/goal/updated': {
            if (extractCodexThreadId(params) !== threadId) break;
            const goal = (params as { goal?: CodexThreadGoal }).goal;
            const normalizedGoal = normalizeCodexGoal(goal);
            if (normalizedGoal) yield { type: 'goal_updated', goal: normalizedGoal };
            const turnId = extractCodexTurnId(params);
            if (turnId) {
              const event = emitRuntimeTurnId(turnId);
              if (event) yield event;
            }
            if (
              isTerminalCodexGoalStatus(goal?.status)
              && (!turnId || !state.turnId || turnId === state.turnId)
            ) {
              if (!emittedText) needsReportTurn = true;
              turnEnded = true;
              client.stopNotifications();
            }
            break;
          }

          case 'thread/goal/cleared': {
            if (extractCodexThreadId(params) !== threadId) break;
            yield { type: 'goal_cleared', threadId: (params as { threadId?: string }).threadId || threadId };
            break;
          }

          case 'turn/started': {
            const turnId = extractCodexTurnId(params);
            if (turnId && turnId === state.turnId && extractCodexThreadId(params) === state.threadId) {
              const event = emitRuntimeTurnId(turnId);
              if (event) yield event;
            }
            break;
          }

          case 'serverRequest/resolved': {
            const p = params as { requestId?: number };
            const pending = state.pendingUserInput;
            if (
              pending
              && pending.turnId === state.turnId
              && typeof p.requestId === 'number'
              && p.requestId === pending.reqId
              && extractCodexThreadId(params) === state.threadId
            ) {
              state.pendingUserInput = null;
            }
            break;
          }

          case 'item/agentMessage/delta': {
            if (!eventBelongsToActiveParentTurn(params, state.threadId, state.turnId)) break;
            const delta = (params as { delta?: string }).delta;
            if (typeof delta === 'string' && delta.length > 0) {
              emittedText = true;
              yield { type: 'text', content: delta, streaming: true };
            }
            break;
          }

          case 'item/reasoning/textDelta':
          case 'item/reasoning/summaryTextDelta': {
            if (!eventBelongsToActiveParentTurn(params, state.threadId, state.turnId)) break;
            const delta = (params as { delta?: string }).delta;
            if (typeof delta === 'string' && delta.length > 0) {
              yield { type: 'thinking', content: delta, streaming: true };
            }
            break;
          }

          case 'item/started': {
            if (!eventBelongsToActiveStreamWork(params, state.threadId, state.turnId, state.subagentByThreadId)) break;
            const item = (params as { item?: CodexThreadItem }).item;
            if (!item) break;
            const detail = extractCodexToolDetails(item);
            if (detail) {
              toolByItemId.set(item.id, detail.tool);
              const parentAgentId = lookupParentAgentId(params, state.subagentByThreadId);
              yield {
                type: 'tool_activity',
                ...detail,
                ...(parentAgentId ? { parentAgentId } : {}),
              };
            }
            break;
          }

          case 'item/completed': {
            if (!eventBelongsToActiveStreamWork(params, state.threadId, state.turnId, state.subagentByThreadId)) break;
            const item = (params as { item?: CodexThreadItem }).item;
            if (!item) break;
            recordSpawnAgentReceivers(item, state.subagentByThreadId);
            if (!ITEM_TYPE_TO_TOOL[item.type] && item.type !== 'mcpToolCall' && item.type !== 'dynamicToolCall') {
              break;
            }
            const outcome = deriveOutcomeFromItem(item);
            const artifactEvent = codexImageArtifactEvent(item, state.threadId, runtime);
            if (artifactEvent) {
              yield artifactEvent;
            }
            yield {
              type: 'tool_outcomes',
              outcomes: [{
                toolUseId: item.id,
                isError: outcome.status === 'error',
                outcome: outcome.outcome,
                status: outcome.status,
              }],
            };
            break;
          }

          case 'thread/tokenUsage/updated': {
            if (!eventBelongsToActiveParentTurn(params, state.threadId, state.turnId)) break;
            const tokenUsage = (params as { tokenUsage?: {
              total: { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
              last: { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
              modelContextWindow: number | null;
            } }).tokenUsage;
            if (!tokenUsage) break;
            const totalTokens = tokenUsage.total.totalTokens || 0;
            if (totalTokens === entry.lastTotalTokens) break;
            entry.lastTotalTokens = totalTokens;
            yield {
              type: 'usage',
              usage: deriveCodexUsage(tokenUsage),
              ...(model ? { model } : {}),
            };
            break;
          }

          case 'turn/completed': {
            if (!isParentTurnCompleted(params, state.threadId, state.turnId)) break;
            turnEnded = true;
            client.stopNotifications();
            break;
          }

          case 'error': {
            if (!eventBelongsToActiveParentTurn(params, state.threadId, state.turnId)) break;
            const errParam = (params as {
              error?: { message?: string };
              willRetry?: boolean;
            });
            const errMsg = errParam.error?.message || 'Codex error';
            if (!errParam.willRetry) {
              yield { type: 'error', error: errMsg };
              turnEnded = true;
              client.stopNotifications();
            } else {
              console.log(`[codex] Recoverable error (will retry): ${errMsg}`);
            }
            break;
          }

          default:
            break;
        }
      }

      if (!turnEnded && turnStarted) {
        // Notification stream exited before turn/completed. Let processStream
        // persist whatever content was already emitted and close the UI turn.
      }

      if (needsReportTurn && !state.aborted) {
        state.turnId = null;
        state.pendingUserInput = null;
        state.subagentByThreadId.clear();
        yield* this._createStream(
          buildCodexGoalReportPrompt(activeObjective),
          {
            ...options,
            isNewSession: false,
            externalSessionId: threadId,
          },
          state,
        );
        return;
      }

      yield { type: 'done' };
    } catch (err) {
      yield { type: 'error', error: `Codex goal failed: ${(err as Error).message}` };
      yield { type: 'done' };
    }
  }

  private async *_createStream(
    message: string,
    options: SendMessageOptions,
    state: {
      readonly aborted: boolean;
      client: CodexAppServerClient | null;
      threadId: string | null;
      turnId: string | null;
      pendingUserInput: PendingUserInput | null;
      subagentByThreadId: Map<string, string>;
    },
  ): AsyncGenerator<StreamEvent> {
    const { sessionId, conversationId, model, effort, serviceTier, mcpServers, cliProfile } = options;
    const convId = conversationId || sessionId;
    const runtime = resolveCodexCliRuntime(cliProfile);
    const mcpServersForCodex: McpServerConfig[] = Array.isArray(mcpServers) ? mcpServers : [];

    let client: CodexAppServerClient;
    try {
      client = await this._getOrSpawnClient(convId, mcpServersForCodex, cliProfile, { serviceTier });
      state.client = client;
    } catch (err) {
      const errMsg = (err as Error).message;
      if (errMsg.includes('ENOENT') || errMsg.includes('not found')) {
        yield { type: 'error', error: 'Codex CLI is not installed. Install with `npm install -g @openai/codex`' };
      } else {
        yield { type: 'error', error: `Failed to start Codex: ${errMsg}` };
      }
      yield { type: 'done' };
      return;
    }

    const entry = this.processes.get(convId)!;

    try {
      // ── Resolve thread ───────────────────────────────────────────────
      const resolved = await this._resolveThread(client, entry, convId, options);
      const threadId = resolved.threadId;
      if (resolved.externalSessionId) {
        yield { type: 'external_session', sessionId: resolved.externalSessionId };
      }

      if (!threadId) {
        yield { type: 'error', error: 'No Codex thread ID available for this conversation' };
        yield { type: 'done' };
        return;
      }

      state.threadId = threadId;
      yield {
        type: 'backend_runtime',
        externalSessionId: threadId,
        processId: entry.proc.pid ?? null,
      };

      if (!resolved.externalSessionId) {
        this._drainQueuedNotificationsBeforeRun(client, convId, 'chat');
        await this._interruptActiveOrphanTurnIfAny(client, convId, threadId, 'chat');
      }

      // ── Build turn input ─────────────────────────────────────────────
      const userInput = [{ type: 'text', text: message, text_elements: [] }];
      const modelCatalog = this._modelsFor(cliProfile);
      const turnParams = buildCodexTurnStartParams(threadId, userInput, model, effort, modelCatalog);

      // ── Send turn ────────────────────────────────────────────────────
      console.log(`[codex] turn/start thread=${threadId} promptLen=${message.length}`);

      let turnEnded = false;
      let emittedRuntimeTurnId: string | null = null;
      let responseTurnId: string | null = null;
      const emitRuntimeTurnId = (turnId: string): StreamEvent | null => {
        if (emittedRuntimeTurnId === turnId) return null;
        state.turnId = turnId;
        emittedRuntimeTurnId = turnId;
        return {
          type: 'backend_runtime',
          externalSessionId: state.threadId,
          activeTurnId: turnId,
          processId: entry.proc.pid ?? null,
        };
      };

      try {
        const turnResp = await client.request('turn/start', turnParams) as TurnStartResult;
        responseTurnId = turnResp.turn.id;
        const runtimeEvent = emitRuntimeTurnId(responseTurnId);
        if (runtimeEvent) yield runtimeEvent;
        // Acceptance — turn/completed notification will arrive separately.
      } catch (err) {
        yield { type: 'error', error: `Codex turn failed: ${(err as Error).message}` };
        yield { type: 'done' };
        return;
      }

      // ── Stream notifications ─────────────────────────────────────────
      const toolByItemId: Map<string, string> = new Map();
      const notificationIterator = client.notifications()[Symbol.asyncIterator]();
      let nextNotification = notificationIterator.next();

      while (true) {
        const next = await nextNotification.then((result) => ({ type: 'notification' as const, result }));

        if (next.result.done) break;
        const notification = next.result.value;
        nextNotification = notificationIterator.next();

        if (state.aborted) {
          yield { type: 'error', error: 'Aborted by user' };
          yield { type: 'done' };
          return;
        }

        // Reset idle timer on every notification — keeps long-running turns
        // (multi-agent, large refactors) from being SIGTERM'd mid-flight.
        this._resetIdleTimer(convId);

        const params = (notification.params || {}) as Record<string, unknown>;
        const method = notification.method;

        // ── Server-to-client requests (auto-approve) ────────────────
        if (notification.id != null) {
          const reqId = notification.id;

          if (method === 'item/commandExecution/requestApproval'
              || method === 'item/fileChange/requestApproval') {
            if (!eventBelongsToActiveStreamWork(params, state.threadId, responseTurnId, state.subagentByThreadId)) {
              this._respondToStaleServerRequest(client, notification, 'Stale Codex approval request ignored');
              continue;
            }
            client.respond(reqId, { decision: 'acceptForSession' });
            continue;
          }

          if (method === 'item/permissions/requestApproval') {
            if (!eventBelongsToActiveStreamWork(params, state.threadId, responseTurnId, state.subagentByThreadId)) {
              this._respondToStaleServerRequest(client, notification, 'Stale Codex permissions request ignored');
              continue;
            }
            client.respond(reqId, {
              permissions: { network: undefined, fileSystem: undefined },
              scope: 'session',
            });
            continue;
          }

          // applyPatchApproval / execCommandApproval — legacy v1 approval shapes
          if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
            client.respond(reqId, { decision: 'approved' });
            continue;
          }

          // item/tool/requestUserInput — surface as a userQuestion in the
          // cockpit. The server pauses the turn until we respond. The
          // response is sent via `sendInput()` from the outer closure when
          // the user answers; see the sendInput branch on pendingUserInput.
          if (method === 'item/tool/requestUserInput') {
            if (!eventBelongsToActiveStreamWork(params, state.threadId, responseTurnId, state.subagentByThreadId)) {
              this._respondToStaleServerRequest(client, notification, 'Stale Codex user-input request ignored');
              continue;
            }
            const p = params as unknown as ToolRequestUserInputParams;
            const questions = Array.isArray(p.questions) ? p.questions : [];
            state.pendingUserInput = { reqId, itemId: p.itemId, turnId: p.turnId, questions };
            const first = questions[0];
            yield {
              type: 'tool_activity',
              tool: 'AskUserQuestion',
              id: p.itemId,
              description: (first && first.header) || 'Question',
              isQuestion: true,
              questions: questions.map((q) => ({
                question: q.question,
                options: Array.isArray(q.options) ? q.options : [],
              })),
            };
            continue;
          }

          // mcpServer/elicitation/request, item/tool/call — decline so we
          // don't hang the turn waiting on UI we don't yet expose.
          client.respond(reqId, { error: { code: -32601, message: 'Not supported by client' } });
          continue;
        }

        // ── Notifications ───────────────────────────────────────────
        switch (method) {
          case 'turn/started': {
            const turnId = extractCodexTurnId(params);
            if (turnId && turnId === responseTurnId && extractCodexThreadId(params) === state.threadId) {
              const event = emitRuntimeTurnId(turnId);
              if (event) yield event;
            }
            break;
          }

          case 'serverRequest/resolved': {
            // Server emits this after the pending server-to-client request
            // is settled — either because we responded, or because the turn
            // ended/was interrupted and the server cleared the request on
            // its side. Drop our pending state so a stale sendInput()
            // doesn't try to respond to a dead request.
            const p = params as { requestId?: number };
            const pending = state.pendingUserInput;
            if (
              pending
              && pending.turnId === responseTurnId
              && typeof p.requestId === 'number'
              && p.requestId === pending.reqId
              && extractCodexThreadId(params) === state.threadId
            ) {
              state.pendingUserInput = null;
            }
            break;
          }

          case 'item/agentMessage/delta': {
            // Drop child-thread message deltas: the parent's text content is
            // built only from its own deltas, and the child's final summary
            // bubbles up via `agentsStates[childTid].message` on the closing
            // wait/closeAgent collabAgentToolCall — surfaced as the Agent
            // card's outcome rather than streamed inline.
            if (!eventBelongsToActiveParentTurn(params, state.threadId, responseTurnId)) break;
            const delta = (params as { delta?: string }).delta;
            if (typeof delta === 'string' && delta.length > 0) {
              yield { type: 'text', content: delta, streaming: true };
            }
            break;
          }

          case 'item/reasoning/textDelta':
          case 'item/reasoning/summaryTextDelta': {
            // Drop child-thread reasoning for the same reason — UI has no
            // place to render per-child thinking under an Agent card today.
            if (!eventBelongsToActiveParentTurn(params, state.threadId, responseTurnId)) break;
            const delta = (params as { delta?: string }).delta;
            if (typeof delta === 'string' && delta.length > 0) {
              yield { type: 'thinking', content: delta, streaming: true };
            }
            break;
          }

          case 'item/started': {
            if (!eventBelongsToActiveStreamWork(params, state.threadId, responseTurnId, state.subagentByThreadId)) break;
            const item = (params as { item?: CodexThreadItem }).item;
            if (!item) break;
            const detail = extractCodexToolDetails(item);
            if (detail) {
              toolByItemId.set(item.id, detail.tool);
              const parentAgentId = lookupParentAgentId(params, state.subagentByThreadId);
              yield {
                type: 'tool_activity',
                ...detail,
                ...(parentAgentId ? { parentAgentId } : {}),
              };
            }
            break;
          }

          case 'item/completed': {
            if (!eventBelongsToActiveStreamWork(params, state.threadId, responseTurnId, state.subagentByThreadId)) break;
            const item = (params as { item?: CodexThreadItem }).item;
            if (!item) break;
            // Record any newly-spawned child threadIds against the top-level
            // Agent card so subsequent item/* events from those threads get
            // attributed back via `parentAgentId`. No-op for non-spawnAgent
            // items.
            recordSpawnAgentReceivers(item, state.subagentByThreadId);
            // Skip non-tool items (agentMessage, reasoning, plan, userMessage).
            // Their content already streamed via the delta notifications.
            // `collabAgentToolCall` is in ITEM_TYPE_TO_TOOL so it's covered;
            // mcpToolCall/dynamicToolCall aren't in the table because their
            // tool name is dynamic, but they're tool items.
            if (!ITEM_TYPE_TO_TOOL[item.type] && item.type !== 'mcpToolCall' && item.type !== 'dynamicToolCall') {
              break;
            }
            const outcome = deriveOutcomeFromItem(item);
            const artifactEvent = codexImageArtifactEvent(item, state.threadId, runtime);
            if (artifactEvent) {
              yield artifactEvent;
            }
            yield {
              type: 'tool_outcomes',
              outcomes: [{
                toolUseId: item.id,
                isError: outcome.status === 'error',
                outcome: outcome.outcome,
                status: outcome.status,
              }],
            };
            break;
          }

          case 'thread/tokenUsage/updated': {
            if (!eventBelongsToActiveParentTurn(params, state.threadId, responseTurnId)) break;
            const tokenUsage = (params as { tokenUsage?: {
              total: { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
              last: { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
              modelContextWindow: number | null;
            } }).tokenUsage;
            if (!tokenUsage) break;
            // Drop stale events: Codex re-emits the prior turn's final state
            // at every turn boundary with byte-identical `last` and `total`.
            // Filtering on cumulative `total.totalTokens` catches them without
            // losing genuine intra-turn updates (each real API call advances
            // total).
            const totalTokens = tokenUsage.total.totalTokens || 0;
            if (totalTokens === entry.lastTotalTokens) break;
            entry.lastTotalTokens = totalTokens;
            yield {
              type: 'usage',
              usage: deriveCodexUsage(tokenUsage),
              ...(model ? { model } : {}),
            };
            break;
          }

          case 'turn/completed': {
            // Multi-agent turns emit one `turn/completed` per thread (each
            // child has its own turn lifecycle). Only the parent thread's
            // `turn/completed` is terminal — closing on the first child's
            // would cut off the parent's final summary, which arrives after
            // the children finish.
            if (!isParentTurnCompleted(params, state.threadId, responseTurnId)) break;
            turnEnded = true;
            client.stopNotifications();
            break;
          }

          case 'error': {
            if (!eventBelongsToActiveParentTurn(params, state.threadId, responseTurnId)) break;
            const errParam = (params as {
              error?: { message?: string };
              willRetry?: boolean;
            });
            const errMsg = errParam.error?.message || 'Codex error';
            if (!errParam.willRetry) {
              yield { type: 'error', error: errMsg };
              turnEnded = true;
              client.stopNotifications();
            } else {
              console.log(`[codex] Recoverable error (will retry): ${errMsg}`);
            }
            break;
          }

          // Notifications we don't currently surface but may want later:
          // - thread/started, thread/closed, thread/status/changed
          // - item/commandExecution/outputDelta (live stdout/stderr)
          // - item/fileChange/outputDelta (live diff)
          // - turn/diff/updated, turn/plan/updated
          // - serverRequest/resolved (informational, fires after we reply)
          default:
            break;
        }
      }

      if (!turnEnded) {
        // Notification stream exited without a turn/completed — treat as done.
        // Common cause: process closed mid-turn.
      }

      yield { type: 'done' };
    } catch (err) {
      yield { type: 'error', error: `Codex error: ${(err as Error).message}` };
      yield { type: 'done' };
    }
  }

  // ── Private: codex exec one-shot ──────────────────────────────────────────

  /**
   * Run a one-shot prompt against `codex exec` and return the final answer.
   *
   * `codex exec` is a dedicated non-interactive subcommand that prints the
   * model's final text answer on stdout (no streaming protocol parsing
   * needed). It uses the selected profile's runtime env; account profiles set
   * `CODEX_HOME` so OAuth/API-key state is isolated.
   */
  private async _execOneShot(prompt: string, options: RunOneShotOptions = {}): Promise<string> {
    const { timeoutMs = 60000, abortSignal, workingDir, model, effort, serviceTier, mcpServers, cliProfile } = options;
    if (abortSignal?.aborted) throw new Error('codex exec stopped');
    const runtime = resolveCodexCliRuntime(cliProfile);
    const cwd = workingDir || this.workingDir || os.homedir();
    const mcpServersForCodex: McpServerConfig[] = Array.isArray(mcpServers) ? mcpServers : [];

    const configArgs = await buildCodexConfigArgs(mcpServersForCodex, runtime);

    const args = ['exec'];
    if (codexUsesFullAccess(this.approvalPolicy, this.sandbox)) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('--ask-for-approval', this.approvalPolicy, '--sandbox', this.sandbox);
    }
    args.push('--skip-git-repo-check', '-C', cwd, ...buildCodexServiceTierArgs(serviceTier), ...configArgs);
    const modelCatalog = this._cachedModels(runtime) || FALLBACK_MODELS;
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
          if (aborted || abortSignal?.aborted) {
            reject(new Error('codex exec failed: Process stopped by caller'));
            return;
          }
          if (timedOut) {
            reject(new Error(`codex exec failed: Process killed (timeout after ${timeoutMs / 1000}s)`));
            return;
          }
          if (err) {
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
          // `codex exec` prints status lines (e.g. session id, version) on
          // stderr but its final answer goes to stdout. The output may
          // contain a leading banner — we trim and return as-is. Callers
          // that need to strip a banner do their own slicing.
          resolve((stdout || '').trim());
        },
      );
      child.stdin?.end();
    });
  }
}
