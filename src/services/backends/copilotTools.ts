import { extractToolOutcome, shortenPath } from './toolUtils';
import type { StreamEvent } from '../../types';

export function copilotToolStartEvents(data: Record<string, unknown>): StreamEvent[] {
  const detail = copilotToolDetail(data);
  if (!detail) return [];
  return [{ type: 'tool_activity', ...detail }];
}

export function copilotToolCompleteEvents(data: Record<string, unknown>): StreamEvent[] {
  const id = stringOrNull(data.toolCallId);
  if (!id) return [];
  const rawName = stringOrNull(data.toolName) || '';
  const tool = canonicalCopilotToolName(rawName);
  const success = data.success !== false;
  const result = isRecord(data.result) ? data.result : {};
  const content = typeof result.content === 'string' ? result.content : '';
  const outcome = success
    ? (extractToolOutcome(tool, content) || { outcome: 'done', status: 'success' as const })
    : { outcome: 'error', status: 'error' as const };
  return [{
    type: 'tool_outcomes',
    outcomes: [{
      toolUseId: id,
      isError: !success,
      outcome: outcome.outcome,
      status: outcome.status,
    }],
  }];
}

function copilotToolDetail(data: Record<string, unknown>): {
  tool: string;
  description: string;
  id: string | null;
} | null {
  const rawName = stringOrNull(data.toolName);
  if (!rawName) return null;
  const id = stringOrNull(data.toolCallId);
  const input = isRecord(data.arguments) ? data.arguments : {};

  const mcp = copilotMcpToolName(rawName);
  if (mcp) {
    return { tool: mcp.tool, id, description: `${mcp.server}.${mcp.tool}` };
  }

  const canonical = canonicalCopilotToolName(rawName);
  switch (canonical) {
    case 'Read': {
      const filePath = firstString(input.path, input.file_path, input.filePath);
      return { tool: 'Read', id, description: filePath ? `Reading \`${shortenPath(filePath)}\`` : 'Reading file' };
    }
    case 'Write': {
      const filePath = firstString(input.path, input.file_path, input.filePath);
      return { tool: 'Write', id, description: filePath ? `Writing \`${shortenPath(filePath)}\`` : 'Writing file' };
    }
    case 'Edit': {
      const filePath = firstString(input.path, input.file_path, input.filePath);
      return { tool: 'Edit', id, description: filePath ? `Editing \`${shortenPath(filePath)}\`` : 'Editing file' };
    }
    case 'Bash': {
      const description = firstString(input.description);
      const command = firstString(input.command, input.cmd);
      if (description) return { tool: 'Bash', id, description };
      const short = command && command.length > 60 ? command.slice(0, 60) + '...' : command;
      return { tool: 'Bash', id, description: short ? `Running: \`${short}\`` : 'Running command' };
    }
    case 'Grep': {
      const pattern = firstString(input.pattern, input.query);
      return { tool: 'Grep', id, description: pattern ? `Searching for \`${pattern}\`` : 'Searching files' };
    }
    case 'Glob': {
      const pattern = firstString(input.pattern);
      return { tool: 'Glob', id, description: pattern ? `Finding files matching \`${pattern}\`` : 'Finding files' };
    }
    case 'WebFetch': {
      const url = firstString(input.url);
      return { tool: 'WebFetch', id, description: url ? `Fetching: ${url}` : 'Fetching web content' };
    }
    case 'WebSearch': {
      const query = firstString(input.query, input.q);
      return { tool: 'WebSearch', id, description: query ? `Searching: \`${query}\`` : 'Searching the web' };
    }
    default:
      return { tool: canonical, id, description: `Using ${canonical}` };
  }
}

export function canonicalCopilotToolName(rawName: string): string {
  const normalized = rawName.replace(/[-_\s]/g, '').toLowerCase();
  const map: Record<string, string> = {
    bash: 'Bash',
    shell: 'Bash',
    runcommand: 'Bash',
    view: 'Read',
    read: 'Read',
    readfile: 'Read',
    create: 'Write',
    write: 'Write',
    writefile: 'Write',
    str_replace: 'Edit',
    strreplace: 'Edit',
    strreplaceeditor: 'Edit',
    edit: 'Edit',
    editfile: 'Edit',
    applypatch: 'Edit',
    grep: 'Grep',
    rg: 'Grep',
    search: 'Grep',
    glob: 'Glob',
    list: 'List',
    ls: 'List',
    webfetch: 'WebFetch',
    fetch: 'WebFetch',
    websearch: 'WebSearch',
    reportintent: 'Intent',
  };
  return map[normalized] || titleCase(rawName);
}

function copilotMcpToolName(rawName: string): { server: string; tool: string } | null {
  const knownPrefixes = ['agent-cockpit-memory_', 'agent-cockpit-kb-search_', 'agent-cockpit-memory-', 'agent-cockpit-kb-search-'];
  for (const prefix of knownPrefixes) {
    if (rawName.startsWith(prefix)) {
      return { server: prefix.slice(0, -1), tool: rawName.slice(prefix.length) };
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function titleCase(raw: string): string {
  const parts = raw.split(/[-_\s]+/).filter(Boolean);
  if (parts.length === 0) return raw;
  return parts.map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

