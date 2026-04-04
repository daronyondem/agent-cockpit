import type {
  ToolDetail,
  ToolOutcomeResult,
  UsageEvent,
  CliToolUseBlock,
} from '../../types';

// ── System Prompt ──────────────────────────────────────────────────────────

const MAX_SYSTEM_PROMPT_LENGTH = 50000;

export function sanitizeSystemPrompt(prompt: string | null | undefined): string {
  if (!prompt || typeof prompt !== 'string') return '';
  let cleaned = prompt.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  if (cleaned.length > MAX_SYSTEM_PROMPT_LENGTH) {
    cleaned = cleaned.substring(0, MAX_SYSTEM_PROMPT_LENGTH);
  }
  return cleaned;
}

// ── Error Detection ────────────────────────────────────────────────────────

const API_ERROR_PATTERN = /^API Error:\s*\d{3}\s/;

export function isApiError(text: string): boolean {
  return API_ERROR_PATTERN.test(text.trim());
}

// ── Path Helpers ───────────────────────────────────────────────────────────

export function shortenPath(filePath: string): string {
  if (!filePath) return '';
  const parts = filePath.split('/');
  if (parts.length <= 3) return filePath;
  return '.../' + parts.slice(-2).join('/');
}

// ── Tool Outcome Extraction ────────────────────────────────────────────────

export function extractToolOutcome(toolName: string | undefined, content: unknown): ToolOutcomeResult | null {
  if (content == null) return null;
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  if (!text) return null;

  if (toolName === 'Bash') {
    const exitMatch = text.match(/exit (?:code|status)[:\s]*(\d+)/i) || text.match(/exited with (\d+)/i);
    if (exitMatch) {
      const code = parseInt(exitMatch[1], 10);
      return { outcome: `exit ${code}`, status: code === 0 ? 'success' : 'error' };
    }
    if (/error|ENOENT|command not found|permission denied/i.test(text.slice(0, 500))) {
      return { outcome: 'error', status: 'error' };
    }
    return { outcome: 'done', status: 'success' };
  }

  if (toolName === 'Grep') {
    const lines = text.split('\n').filter(l => l.trim());
    if (text.includes('No matches found') || lines.length === 0) {
      return { outcome: '0 matches', status: 'warning' };
    }
    return { outcome: `${lines.length} match${lines.length !== 1 ? 'es' : ''}`, status: 'success' };
  }

  if (toolName === 'Glob') {
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length === 0 || text.includes('No files found') || text.includes('No matches')) {
      return { outcome: '0 files', status: 'warning' };
    }
    return { outcome: `${lines.length} file${lines.length !== 1 ? 's' : ''}`, status: 'success' };
  }

  if (toolName === 'Read') {
    if (/not found|does not exist|ENOENT|no such file/i.test(text.slice(0, 200))) {
      return { outcome: 'not found', status: 'error' };
    }
    return { outcome: 'read', status: 'success' };
  }

  if (toolName === 'Write') {
    if (/error|failed/i.test(text.slice(0, 200))) {
      return { outcome: 'failed', status: 'error' };
    }
    return { outcome: 'written', status: 'success' };
  }

  if (toolName === 'Edit') {
    if (/not found|no match|not unique/i.test(text.slice(0, 300))) {
      return { outcome: 'no match', status: 'error' };
    }
    return { outcome: 'edited', status: 'success' };
  }

  if (toolName === 'Agent') {
    if (/error|failed|exception/i.test(text.slice(0, 300))) {
      return { outcome: 'error', status: 'error' };
    }
    return { outcome: 'done', status: 'success' };
  }

  if (toolName === 'WebSearch') {
    const lines = text.split('\n').filter(l => l.trim());
    return { outcome: `${Math.max(lines.length, 1)} result${lines.length !== 1 ? 's' : ''}`, status: 'success' };
  }
  if (toolName === 'WebFetch') {
    if (/error|failed|404|500|timeout/i.test(text.slice(0, 200))) {
      return { outcome: 'failed', status: 'error' };
    }
    return { outcome: 'fetched', status: 'success' };
  }

  return null;
}

// ── Tool Detail Extraction (Claude Code format) ────────────────────────────

export function extractToolDetails(block: CliToolUseBlock): ToolDetail {
  const name = block.name;
  const input = (block.input || {}) as Record<string, unknown>;
  const detail: ToolDetail = { tool: name, id: block.id || null, description: '' };

  switch (name) {
    case 'Read':
      detail.description = input.file_path
        ? `Reading \`${shortenPath(input.file_path as string)}\``
        : 'Reading file';
      break;
    case 'Write':
      detail.description = input.file_path
        ? `Writing \`${shortenPath(input.file_path as string)}\``
        : 'Writing file';
      detail.isPlanFile = !!(input.file_path && (input.file_path as string).includes('.claude/plans/'));
      if (detail.isPlanFile && input.content) {
        detail.planContent = input.content as string;
      }
      break;
    case 'Edit':
      detail.description = input.file_path
        ? `Editing \`${shortenPath(input.file_path as string)}\``
        : 'Editing file';
      break;
    case 'Bash':
      if (input.description) {
        detail.description = input.description as string;
      } else if (input.command) {
        const cmd = (input.command as string).length > 60
          ? (input.command as string).substring(0, 60) + '...'
          : input.command as string;
        detail.description = `Running: \`${cmd}\``;
      } else {
        detail.description = 'Running command';
      }
      break;
    case 'Grep':
      detail.description = input.pattern
        ? `Searching for \`${input.pattern}\`${input.glob ? ` in ${input.glob}` : ''}`
        : 'Searching files';
      break;
    case 'Glob':
      detail.description = input.pattern
        ? `Finding files matching \`${input.pattern}\``
        : 'Finding files';
      break;
    case 'Agent':
      detail.description = (input.description as string) || 'Running sub-agent';
      detail.subagentType = (input.subagent_type as string) || 'general-purpose';
      detail.isAgent = true;
      break;
    case 'TodoWrite':
      detail.description = 'Updating task list';
      break;
    case 'WebSearch':
      detail.description = input.query
        ? `Searching: \`${input.query}\``
        : 'Searching the web';
      break;
    case 'WebFetch':
      detail.description = input.url
        ? `Fetching: ${input.url}`
        : 'Fetching web content';
      break;
    case 'EnterPlanMode':
      detail.description = 'Entering plan mode';
      detail.isPlanMode = true;
      detail.planAction = 'enter';
      break;
    case 'ExitPlanMode':
      detail.description = 'Plan ready for approval';
      detail.isPlanMode = true;
      detail.planAction = 'exit';
      break;
    case 'AskUserQuestion':
      detail.description = 'Asking a question';
      detail.isQuestion = true;
      detail.questions = (input.questions as string[]) || [];
      break;
    default:
      detail.description = `Using ${name}`;
  }

  return detail;
}

// ── Usage Extraction ───────────────────────────────────────────────────────

export function extractUsage(event: { usage?: Record<string, number>; cost_usd?: number }): UsageEvent | null {
  const raw = event.usage;
  const hasCost = typeof event.cost_usd === 'number';
  if (!raw && !hasCost) return null;

  return {
    type: 'usage',
    usage: {
      inputTokens: raw?.input_tokens || 0,
      outputTokens: raw?.output_tokens || 0,
      cacheReadTokens: raw?.cache_read_input_tokens || 0,
      cacheWriteTokens: raw?.cache_creation_input_tokens || 0,
      costUsd: event.cost_usd || 0,
    },
  };
}
