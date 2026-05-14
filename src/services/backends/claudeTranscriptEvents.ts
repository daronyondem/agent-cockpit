import {
  extractToolDetails,
  extractToolOutcome,
  extractUsage,
} from './toolUtils';
import { CLAUDE_GOAL_SUPPORTED_ACTIONS } from './claudeCode';
import type {
  CliToolResultBlock,
  CliToolUseBlock,
  StreamEvent,
  ThreadGoal,
} from '../../types';

export interface ClaudeTranscriptAttachment {
  type?: string;
  met?: boolean;
  sentinel?: boolean;
  condition?: string;
  reason?: string;
  iterations?: number;
  durationMs?: number;
  tokens?: number;
}

export interface ClaudeTranscriptEntry {
  uuid?: string;
  type?: string;
  subtype?: string;
  timestamp?: string;
  sessionId?: string;
  entrypoint?: string;
  content?: unknown;
  message?: {
    role?: string;
    usage?: Record<string, number>;
    model?: string;
    content?: unknown;
  };
  usage?: Record<string, number>;
  cost_usd?: number;
  costUSD?: number;
  attachment?: ClaudeTranscriptAttachment;
  toolUseResult?: unknown;
}

export interface ClaudeTranscriptEventMapperState {
  toolNameById: Record<string, string>;
  lastProgressAgentId: string | null;
  emittedGoalKeys: Set<string>;
  emittedGoalCleared: boolean;
}

export function createClaudeTranscriptEventMapperState(): ClaudeTranscriptEventMapperState {
  return {
    toolNameById: {},
    lastProgressAgentId: null,
    emittedGoalKeys: new Set(),
    emittedGoalCleared: false,
  };
}

export function mapClaudeTranscriptEntryToStreamEvents(
  entry: ClaudeTranscriptEntry,
  state: ClaudeTranscriptEventMapperState = createClaudeTranscriptEventMapperState(),
  opts: { sessionId?: string | null; backend?: ThreadGoal['backend'] } = {},
): StreamEvent[] {
  const events: StreamEvent[] = [];
  const backend = opts.backend || 'claude-code-interactive';

  if (entry.attachment?.type === 'goal_status') {
    const goal = goalFromAttachment(entry, backend, opts.sessionId || entry.sessionId || null);
    if (goal) {
      const key = `${goal.status}:${goal.objective}:${goal.updatedAt || ''}:${goal.tokensUsed || ''}`;
      if (!state.emittedGoalKeys.has(key)) {
        state.emittedGoalKeys.add(key);
        events.push({ type: 'goal_updated', goal });
      }
    }
  }

  if (entry.type === 'assistant') {
    const content = normalizedContent(entry.message?.content);
    if (isSyntheticNoResponseEntry(entry, content)) return events;
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        events.push({ type: 'text', content: block.text });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        events.push({ type: 'thinking', content: block.thinking });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        if (typeof block.id === 'string') state.toolNameById[block.id] = block.name;
        const detail = extractToolDetails(block as unknown as CliToolUseBlock);
        if (!detail.isAgent && state.lastProgressAgentId) {
          detail.parentAgentId = state.lastProgressAgentId;
        }
        events.push({ type: 'tool_activity', ...detail });
      }
    }

    const usageEvent = extractUsage({
      usage: (entry.message?.usage || entry.usage) as Record<string, number> | undefined,
      cost_usd: typeof entry.cost_usd === 'number'
        ? entry.cost_usd
        : (typeof entry.costUSD === 'number' ? entry.costUSD : undefined),
    });
    if (usageEvent) {
      if (typeof entry.message?.model === 'string') usageEvent.model = entry.message.model;
      events.push(usageEvent);
    }
  } else if (entry.type === 'user') {
    const content = normalizedContent(entry.message?.content);
    const outcomes = [];
    for (const block of content) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const toolName = state.toolNameById[block.tool_use_id];
      const resultContent = toolResultContent(block as unknown as CliToolResultBlock, entry.toolUseResult);
      const extracted = extractToolOutcome(toolName, resultContent);
      outcomes.push({
        toolUseId: block.tool_use_id,
        isError: block.is_error === true,
        outcome: extracted ? extracted.outcome : (block.is_error ? 'error' : null),
        status: extracted ? extracted.status : (block.is_error ? 'error' : null),
      });
    }
    if (outcomes.length > 0) {
      events.push({ type: 'tool_outcomes', outcomes });
    }

    const text = transcriptText(entry);
    if (text.includes('[Request interrupted by user]')) {
      events.push({ type: 'error', error: 'Aborted by user', source: 'abort' });
    } else if (content.length > 0) {
      events.push({ type: 'turn_boundary' });
    }
  } else if (entry.type === 'system') {
    if (!state.emittedGoalCleared && isGoalClearedEntry(entry)) {
      state.emittedGoalCleared = true;
      events.push({ type: 'goal_cleared', threadId: opts.sessionId || entry.sessionId || null });
    }
    if (entry.subtype === 'task_progress' && typeof (entry as { tool_use_id?: unknown }).tool_use_id === 'string') {
      state.lastProgressAgentId = (entry as { tool_use_id: string }).tool_use_id;
    } else if (entry.subtype === 'task_notification' && typeof (entry as { tool_use_id?: unknown }).tool_use_id === 'string') {
      const toolUseId = (entry as { tool_use_id: string }).tool_use_id;
      const status = (entry as { status?: string }).status === 'completed'
        ? 'success'
        : ((entry as { status?: string }).status || 'success');
      events.push({
        type: 'tool_outcomes',
        outcomes: [{
          toolUseId,
          isError: status === 'error',
          outcome: (entry as { summary?: string }).summary || (entry as { status?: string }).status || 'done',
          status,
        }],
      });
      if (state.lastProgressAgentId === toolUseId) state.lastProgressAgentId = null;
    } else if (entry.subtype === 'turn_duration') {
      events.push({ type: 'done' });
    }
  }

  return events;
}

export function goalFromAttachment(
  entry: ClaudeTranscriptEntry,
  backend: ThreadGoal['backend'] = 'claude-code-interactive',
  sessionId?: string | null,
): ThreadGoal | null {
  const attachment = entry.attachment;
  if (!attachment || attachment.type !== 'goal_status') return null;
  const objective = typeof attachment.condition === 'string' ? attachment.condition.trim() : '';
  if (!objective) return null;
  const updatedAt = Date.parse(entry.timestamp || '') || Date.now();
  return {
    backend,
    sessionId: sessionId || null,
    objective,
    status: attachment.met === true ? 'complete' : 'active',
    supportedActions: CLAUDE_GOAL_SUPPORTED_ACTIONS,
    timeUsedSeconds: typeof attachment.durationMs === 'number' ? Math.max(0, Math.floor(attachment.durationMs / 1000)) : null,
    tokensUsed: typeof attachment.tokens === 'number' ? attachment.tokens : null,
    turns: typeof attachment.iterations === 'number' ? attachment.iterations : null,
    iterations: typeof attachment.iterations === 'number' ? attachment.iterations : null,
    lastReason: typeof attachment.reason === 'string' ? attachment.reason : null,
    createdAt: updatedAt,
    updatedAt,
    source: 'transcript',
  };
}

function normalizedContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is Record<string, unknown> => !!block && typeof block === 'object' && !Array.isArray(block));
}

function isSyntheticNoResponseEntry(entry: ClaudeTranscriptEntry, content: Array<Record<string, unknown>>): boolean {
  return entry.message?.model === '<synthetic>'
    && content.length === 1
    && content[0].type === 'text'
    && content[0].text === 'No response requested.';
}

function toolResultContent(block: CliToolResultBlock, toolUseResult: unknown): unknown {
  if (typeof block.content === 'string' && block.content) return block.content;
  if (Array.isArray(block.content)) {
    const text = block.content.filter(c => c.type === 'text').map(c => c.text || '').join('\n');
    if (text) return text;
  }
  return toolUseResult == null ? '' : toolUseResult;
}

function transcriptText(entry: ClaudeTranscriptEntry): string {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  return normalizedContent(content)
    .map(block => typeof block.text === 'string' ? block.text : '')
    .filter(Boolean)
    .join('\n');
}

function systemText(entry: ClaudeTranscriptEntry): string {
  if (typeof entry.content === 'string') return entry.content;
  return transcriptText(entry);
}

function isGoalClearedEntry(entry: ClaudeTranscriptEntry): boolean {
  return /\bGoal cleared\b/i.test(systemText(entry));
}
