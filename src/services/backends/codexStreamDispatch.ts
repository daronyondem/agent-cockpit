import type { ServiceTier, StreamEvent, CodexThreadGoal, CodexThreadGoalStatus } from '../../types';
import { logger } from '../../utils/logger';
import { codexImageArtifactEvent } from './codexArtifacts';
import {
  codexItemIsToolItem,
  deriveOutcomeFromItem,
  eventBelongsToActiveParentTurn,
  eventBelongsToActiveStreamWork,
  extractCodexThreadId,
  extractCodexToolDetails,
  extractCodexTurnId,
  isParentTurnCompleted,
  lookupParentAgentId,
  recordSpawnAgentReceivers,
  type CodexThreadItem,
} from './codexEvents';
import { deriveCodexUsage, attachCodexUsagePricingTier } from './codexUsage';
import type { CodexAppServerClient, PendingUserInput } from './codexProtocol';
import type { CodexProcessEntry } from './codexProcess';
import { normalizeCodexGoal, type CodexCliRuntime } from './codexRuntime';

export interface CodexStreamState {
  readonly aborted: boolean;
  client: CodexAppServerClient | null;
  threadId: string | null;
  turnId: string | null;
  pendingUserInput: PendingUserInput | null;
  subagentByThreadId: Map<string, string>;
}

export interface CodexNotificationDispatchContext {
  mode: 'chat' | 'goal';
  client: CodexAppServerClient;
  state: CodexStreamState;
  activeTurnId: string | null;
  threadId: string;
  entry: CodexProcessEntry;
  runtime: CodexCliRuntime;
  serviceTier?: ServiceTier;
  model?: string;
  toolByItemId: Map<string, string>;
  emitRuntimeTurnId: (turnId: string) => StreamEvent | null;
  emittedText: boolean;
  turnEnded: boolean;
  needsReportTurn: boolean;
}

const codexStreamDispatchLog = logger.child({ module: 'codex-stream-dispatch' });

export function isTerminalCodexGoalStatus(status: CodexThreadGoalStatus | undefined): boolean {
  return status === 'complete' || status === 'budgetLimited';
}

export function* dispatchCodexNotification(
  ctx: CodexNotificationDispatchContext,
  params: Record<string, unknown>,
  method: string,
): Generator<StreamEvent> {
  const { client, state, activeTurnId, threadId, entry, runtime, serviceTier, model } = ctx;

  switch (method) {
    case 'thread/goal/updated': {
      if (extractCodexThreadId(params) !== threadId) break;
      const goal = (params as { goal?: CodexThreadGoal }).goal;
      const normalizedGoal = normalizeCodexGoal(goal);
      if (normalizedGoal) yield { type: 'goal_updated', goal: normalizedGoal };
      if (ctx.mode === 'goal') {
        const turnId = extractCodexTurnId(params);
        if (turnId) {
          const event = ctx.emitRuntimeTurnId(turnId);
          if (event) yield event;
        }
        if (
          isTerminalCodexGoalStatus(goal?.status)
          && (!turnId || !state.turnId || turnId === state.turnId)
        ) {
          if (!ctx.emittedText) ctx.needsReportTurn = true;
          ctx.turnEnded = true;
          client.stopNotifications();
        }
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
      if (turnId && turnId === activeTurnId && extractCodexThreadId(params) === state.threadId) {
        const event = ctx.emitRuntimeTurnId(turnId);
        if (event) yield event;
      }
      break;
    }

    case 'serverRequest/resolved': {
      const p = params as { requestId?: number };
      const pending = state.pendingUserInput;
      if (
        pending
        && pending.turnId === activeTurnId
        && typeof p.requestId === 'number'
        && p.requestId === pending.reqId
        && extractCodexThreadId(params) === state.threadId
      ) {
        state.pendingUserInput = null;
      }
      break;
    }

    case 'item/agentMessage/delta': {
      if (!eventBelongsToActiveParentTurn(params, state.threadId, activeTurnId)) break;
      const delta = (params as { delta?: string }).delta;
      if (typeof delta === 'string' && delta.length > 0) {
        ctx.emittedText = true;
        yield { type: 'text', content: delta, streaming: true };
      }
      break;
    }

    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta': {
      if (!eventBelongsToActiveParentTurn(params, state.threadId, activeTurnId)) break;
      const delta = (params as { delta?: string }).delta;
      if (typeof delta === 'string' && delta.length > 0) {
        yield { type: 'thinking', content: delta, streaming: true };
      }
      break;
    }

    case 'item/started': {
      if (!eventBelongsToActiveStreamWork(params, state.threadId, activeTurnId, state.subagentByThreadId)) break;
      const item = (params as { item?: CodexThreadItem }).item;
      if (!item) break;
      const detail = extractCodexToolDetails(item);
      if (detail) {
        ctx.toolByItemId.set(item.id, detail.tool);
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
      if (!eventBelongsToActiveStreamWork(params, state.threadId, activeTurnId, state.subagentByThreadId)) break;
      const item = (params as { item?: CodexThreadItem }).item;
      if (!item) break;
      recordSpawnAgentReceivers(item, state.subagentByThreadId);
      if (!codexItemIsToolItem(item)) break;
      const outcome = deriveOutcomeFromItem(item);
      const artifactEvent = codexImageArtifactEvent(item, state.threadId, runtime);
      if (artifactEvent) yield artifactEvent;
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
      if (!eventBelongsToActiveParentTurn(params, state.threadId, activeTurnId)) break;
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
        usage: attachCodexUsagePricingTier(deriveCodexUsage(tokenUsage), serviceTier),
        ...(model ? { model } : {}),
      };
      break;
    }

    case 'turn/completed': {
      if (!isParentTurnCompleted(params, state.threadId, activeTurnId)) break;
      ctx.turnEnded = true;
      client.stopNotifications();
      break;
    }

    case 'error': {
      if (!eventBelongsToActiveParentTurn(params, state.threadId, activeTurnId)) break;
      const errParam = (params as {
        error?: { message?: string };
        willRetry?: boolean;
      });
      const errMsg = errParam.error?.message || 'Codex error';
      if (!errParam.willRetry) {
        yield { type: 'error', error: errMsg };
        ctx.turnEnded = true;
        client.stopNotifications();
      } else {
        codexStreamDispatchLog.info('Recoverable Codex error while streaming; waiting for retry', {
          errorMessage: errMsg,
        });
      }
      break;
    }

    default:
      break;
  }
}
