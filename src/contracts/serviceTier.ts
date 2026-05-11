import { contractError } from './validation';

export type ContractServiceTier = 'fast';
export type ServiceTierInput = ContractServiceTier | 'default' | null | '';

export function parseServiceTierInput(value: unknown): ContractServiceTier | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '' || value === 'default') return null;
  if (value === 'fast') return 'fast';
  contractError('serviceTier must be "fast" or "default"');
}
