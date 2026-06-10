import { contractError } from './validation';

export type ContractClaudeCodeMode = 'ultracode';

export const CONTRACT_CLAUDE_CODE_MODES: readonly ContractClaudeCodeMode[] = ['ultracode'];

export type ClaudeCodeModeInput = ContractClaudeCodeMode | '' | null | undefined;

export function parseClaudeCodeModeInput(value: unknown): ContractClaudeCodeMode | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (value === 'ultracode') return 'ultracode';
  contractError('claudeCodeMode must be "ultracode"');
}
