const MEMORY_NOTE_FAILURE_RULE = 'If `memory_note` fails or is unavailable, do not create or edit local memory files (`MEMORY.md`, `memory/*.md`, `.claude/**/memory/*.md`, or similar) as a fallback. Report that the Memory note was not saved and include the tool error instead.';

export function buildMemoryMcpAddendum(): string {
  return [
    '# Persistent memory',
    'You have access to `memory_search` and `memory_note` MCP tools (from the `agent-cockpit-memory` server). Use `memory_search` when prior preferences, feedback, project context, or references may affect the answer. Call `memory_note` whenever you learn something worth remembering across sessions:',
    '- **user** — the user\'s role, expertise, preferences, or responsibilities',
    '- **feedback** — a correction or confirmation the user has given you (include the reason if known)',
    '- **project** — ongoing work context, goals, deadlines, constraints, or stakeholders',
    '- **reference** — pointers to external systems (Linear, Slack, Grafana, etc.)',
    '',
    'Each call should capture ONE fact in natural language — do not batch unrelated facts. Pass the category in `type` when you know it. Keep notes terse. Do not call `memory_note` for ephemeral task state or things already visible in the current code.',
    MEMORY_NOTE_FAILURE_RULE,
  ].join('\n');
}

export function buildMemoryMcpResumeReminder(): string {
  return [
    '[Persistent memory write rule',
    MEMORY_NOTE_FAILURE_RULE,
    ']',
  ].join('\n');
}
