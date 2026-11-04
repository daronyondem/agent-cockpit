import type { CopilotSession } from '@github/copilot-sdk' with { 'resolution-mode': 'import' };
import type { BackendGoalCapability, ThreadGoal } from '../../types';
import { parseGoalAiCreditLimit } from '../../contracts/goals';

type NativeGoal = NonNullable<Awaited<ReturnType<CopilotSession['rpc']['autopilotObjective']['getState']>>['state']>;
export type CopilotGoalRun = { kind: 'set'; objective: string; aiCreditLimit?: number } | { kind: 'resume'; aiCreditLimit: number };

export const COPILOT_GOALS: BackendGoalCapability = { set: true, status: 'native', pause: true, resume: true, clear: false };

/** Native credits and objective turns are not token or elapsed-time measurements. */
export function projectCopilotGoal(state: NativeGoal | null | undefined, sessionId: string): ThreadGoal | null {
  if (!state) return null;
  return {
    backend: 'copilot', sessionId, threadId: sessionId, objectiveId: state.id,
    objective: state.objective, status: state.status === 'completed' ? 'complete' : state.status,
    supportedActions: { clear: false, stopTurn: true, pause: true, resume: true },
    turns: state.turnCount, lastReason: state.pauseReason || state.completionSummary || null,
    ...(state.creditLimit ? { aiCreditLimit: state.creditLimit.credits ?? null, aiCreditsUsed: state.creditLimit.creditsUsed } : {}),
    source: 'native',
  };
}

export async function readCopilotGoal(session: CopilotSession): Promise<ThreadGoal | null> {
  return projectCopilotGoal((await session.rpc.autopilotObjective.getState()).state, session.sessionId);
}

/** Use only public command effects; never delete objective storage to fake Clear. */
export async function invokeCopilotGoal(session: CopilotSession, run: CopilotGoalRun): Promise<{ prompt: string; displayPrompt?: string }> {
  const limit = parseGoalAiCreditLimit(run.aiCreditLimit, run.kind === 'resume');
  if (run.kind === 'resume' && (await readCopilotGoal(session))?.status !== 'paused') {
    throw new Error('Only a paused Copilot goal can be resumed.');
  }
  const effect = await session.rpc.commands.invoke({ name: 'autopilot',
    input: `${limit === undefined ? '' : `--max-ai-credits ${limit} `}${run.kind === 'set' ? `-- ${run.objective.trim()}` : ''}`.trim() });
  if (effect.kind !== 'agent-prompt') throw new Error('Copilot did not accept the goal run.');
  return { prompt: effect.prompt, displayPrompt: effect.displayPrompt };
}

export async function pauseCopilotGoal(session: CopilotSession): Promise<ThreadGoal | null> {
  const current = await readCopilotGoal(session);
  if (current?.status === 'active') await session.rpc.commands.invoke({ name: 'autopilot', input: 'off' });
  return readCopilotGoal(session);
}
