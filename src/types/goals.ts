// ── Thread Goal Types ────────────────────────────────────────────────

export type ThreadGoalBackend = 'codex' | 'claude-code' | 'claude-code-interactive';

export type ThreadGoalStatus = 'active' | 'paused' | 'budgetLimited' | 'complete' | 'cleared' | 'unknown';

export type ThreadGoalSource = 'native' | 'transcript' | 'runtime' | 'unknown';

export interface ThreadGoalSupportedActions {
  clear: boolean;
  stopTurn: boolean;
  pause: boolean;
  resume: boolean;
}

export interface ThreadGoal {
  backend?: ThreadGoalBackend;
  threadId?: string | null;
  sessionId?: string | null;
  objective: string;
  status: ThreadGoalStatus;
  supportedActions?: ThreadGoalSupportedActions;
  tokenBudget?: number | null;
  tokensUsed?: number | null;
  timeUsedSeconds?: number | null;
  turns?: number | null;
  iterations?: number | null;
  lastReason?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  source?: ThreadGoalSource;
}

export type GoalEventKind = 'set' | 'resumed' | 'paused' | 'achieved' | 'budget_limited' | 'cleared' | 'updated' | 'unknown';

export interface GoalEvent {
  kind: GoalEventKind;
  backend?: ThreadGoalBackend | string;
  objective?: string;
  status?: ThreadGoalStatus;
  reason?: string | null;
  goal?: ThreadGoal | null;
}

export type CodexThreadGoalStatus = Extract<ThreadGoalStatus, 'active' | 'paused' | 'budgetLimited' | 'complete'>;

export type CodexThreadGoal = ThreadGoal & {
  threadId: string;
  status: CodexThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

export interface GoalUpdatedEvent {
  type: 'goal_updated';
  goal: ThreadGoal;
}

export interface GoalClearedEvent {
  type: 'goal_cleared';
  threadId?: string | null;
}
