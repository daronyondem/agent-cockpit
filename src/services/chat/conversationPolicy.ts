import type { ClaudeCodeMode, EffortLevel, ServiceTier } from '../../types';
import { cliHarnessForBackend } from '../cliProfiles';

export interface ConversationPolicyModelMetadata {
  id: string;
  supportedEffortLevels?: EffortLevel[];
}

export function effectiveEffort(
  model: string | undefined,
  requested: EffortLevel | undefined,
  modelOption: ConversationPolicyModelMetadata | undefined,
): EffortLevel | undefined {
  if (!requested || !model) return undefined;
  const supported = modelOption?.supportedEffortLevels;
  if (!supported || supported.length === 0) return undefined;
  if (supported.includes(requested)) return requested;
  if (supported.includes('high')) return 'high';
  return supported[0];
}

export function effectiveServiceTier(backend: string, requested: ServiceTier | undefined): ServiceTier | undefined {
  if (backend !== 'codex') return undefined;
  return requested === 'fast' ? 'fast' : undefined;
}

export function effectiveClaudeCodeMode(
  backend: string,
  model: string | undefined,
  requested: ClaudeCodeMode | undefined,
  modelOption: ConversationPolicyModelMetadata | undefined,
): ClaudeCodeMode | undefined {
  if (requested !== 'ultracode' || !model) return undefined;
  if (cliHarnessForBackend(backend) !== 'claude-code') return undefined;
  return modelOption?.supportedEffortLevels?.includes('xhigh') ? 'ultracode' : undefined;
}

export function titleFallbackFromMessage(userMessage: string): string {
  return userMessage.substring(0, 80).replace(/\n/g, ' ').trim() || 'New Chat';
}

export function hardCutTitle(title: string, maxWords = 8): string {
  const words = title.trim().split(/\s+/);
  if (words.length <= maxWords) return title;
  return words.slice(0, maxWords).join(' ');
}
