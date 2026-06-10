import { extractToolOutcome, shortenPath } from './toolUtils';
import type { ToolDetail } from '../../types';

// Codex doesn't expose generic tool names - items in the protocol are typed
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

export function codexItemIsToolItem(item: CodexThreadItem): boolean {
  return !!ITEM_TYPE_TO_TOOL[item.type] || item.type === 'mcpToolCall' || item.type === 'dynamicToolCall';
}

export interface CodexThreadItem {
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

export function deriveOutcomeFromItem(item: CodexThreadItem): { outcome: string; status: 'success' | 'error' | 'warning' } {
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

// Every `item/*` and `item/*/delta` notification carries `threadId` and
// `turnId` at the params level (alongside the `item` object). This is not
// reflected in the public README - verified by capturing raw JSON-RPC traffic
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
// terminal - that's almost always a child's, and acting on it would close
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
// top-level id - the cockpit UI nests one level deep. Non-spawnAgent items
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
