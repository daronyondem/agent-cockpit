// ── CLI Event Shapes ─────────────────────────────────────────────────

export interface CliToolUseBlock {
  type: 'tool_use';
  name: string;
  id?: string;
  input?: Record<string, unknown>;
}

export interface CliTextBlock {
  type: 'text';
  text?: string;
}

export interface CliThinkingBlock {
  type: 'thinking';
  thinking?: string;
}

export interface CliToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export type CliContentBlock = CliToolUseBlock | CliTextBlock | CliThinkingBlock | CliToolResultBlock;

export interface CliAssistantEvent {
  type: 'assistant';
  message?: {
    content?: CliContentBlock[];
  };
}

export interface CliContentBlockDeltaEvent {
  type: 'content_block_delta';
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
  };
}

export interface CliUserEvent {
  type: 'user';
  message?: {
    content?: CliContentBlock[];
  };
}

export interface CliResultEvent {
  type: 'result';
  result?: string | Record<string, unknown>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  cost_usd?: number;
}

export interface CliSystemEvent {
  type: 'system';
  subtype?: string;
  model?: string;
  tool_use_id?: string;
  status?: string;
  summary?: string;
  event?: string;
  tool?: string;
}

export type CliEvent =
  | CliAssistantEvent
  | CliContentBlockDeltaEvent
  | CliUserEvent
  | CliResultEvent
  | CliSystemEvent;
