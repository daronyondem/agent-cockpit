// ── Tool Types ───────────────────────────────────────────────────────

export interface ToolActivity {
  tool: string;
  description: string;
  id: string | null;
  duration: number | null;
  startTime: number;
  isAgent?: boolean;
  subagentType?: string;
  parentAgentId?: string;
  outcome?: string;
  status?: string;
  /**
   * Incremented by the server every time a CLI `user` event (tool_result)
   * closes out a batch of tool_uses. Tools emitted back-to-back without an
   * intervening `user` event share the same `batchIndex` — those are the
   * parallel tool calls from a single LLM assistant turn. The frontend uses
   * this to group parallel runs correctly instead of relying on startTime
   * gaps (which drift based on per-tool execution overhead).
   */
  batchIndex?: number;
}

export interface ToolQuestionOption {
  label: string;
  description?: string;
}

export interface ToolQuestion {
  question: string;
  options?: ToolQuestionOption[];
}

export interface ToolOutcome {
  toolUseId: string;
  isError: boolean;
  outcome: string | null;
  status: string | null;
}

export interface ToolDetail {
  tool: string;
  id: string | null;
  description: string;
  isAgent?: boolean;
  subagentType?: string;
  isPlanFile?: boolean;
  planContent?: string;
  planFilePath?: string;
  isPlanMode?: boolean;
  planAction?: 'enter' | 'exit';
  isQuestion?: boolean;
  questions?: ToolQuestion[];
  parentAgentId?: string;
}

export interface ToolOutcomeResult {
  outcome: string;
  status: 'success' | 'error' | 'warning';
}
