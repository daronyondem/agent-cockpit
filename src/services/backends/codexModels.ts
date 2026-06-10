import type { EffortLevel, ModelCapabilities, ModelOption } from '../../types';

const CODEX_SUPPORTED_EFFORTS: EffortLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const CODEX_FALLBACK_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];

export const CODEX_MODEL_CAPABILITIES: ModelCapabilities = {
  input: { text: true, image: true },
  output: { text: true },
};

// On first construction the adapter spawns a transient `codex app-server` in
// the background to query `model/list` and replace this list with whatever
// the running CLI advertises. This static set only fronts the model picker
// for the brief window before that refresh completes (and as a permanent
// fallback when the CLI is missing or `model/list` fails). The OpenAI model
// lineup churns enough that authoritative discovery beats hardcoding.
export const FALLBACK_MODELS: ModelOption[] = [
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    family: 'gpt',
    description: 'Latest GPT — default model for codex',
    costTier: 'high',
    default: true,
    supportedEffortLevels: CODEX_FALLBACK_EFFORTS,
    capabilities: CODEX_MODEL_CAPABILITIES,
  },
  {
    id: 'gpt-5.5-codex',
    label: 'GPT-5.5 Codex',
    family: 'gpt',
    description: 'Codex-tuned variant — optimized for agentic coding tasks',
    costTier: 'high',
    supportedEffortLevels: CODEX_FALLBACK_EFFORTS,
    capabilities: CODEX_MODEL_CAPABILITIES,
  },
  {
    id: 'gpt-5.5-mini',
    label: 'GPT-5.5 Mini',
    family: 'gpt',
    description: 'Smaller and faster — good for simple tasks',
    costTier: 'low',
    supportedEffortLevels: CODEX_FALLBACK_EFFORTS,
    capabilities: CODEX_MODEL_CAPABILITIES,
  },
];

export interface ModelListResult {
  data: CodexModelListEntry[];
}

interface CodexReasoningEffortOption {
  reasoningEffort?: string;
  effort?: string;
  description?: string;
}

export interface CodexModelListEntry {
  id?: string;
  model?: string;
  slug?: string;
  displayName?: string;
  display_name?: string;
  description?: string;
  isDefault?: boolean;
  is_default?: boolean;
  supportedReasoningEfforts?: CodexReasoningEffortOption[];
  supported_reasoning_levels?: CodexReasoningEffortOption[];
  defaultReasoningEffort?: string;
  default_reasoning_level?: string;
}

function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as string[]).includes(v);
}

function normalizeCodexEfforts(raw: unknown): EffortLevel[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const levels: EffortLevel[] = [];
  for (const item of raw) {
    const value = typeof item === 'string'
      ? item
      : (item as CodexReasoningEffortOption | undefined)?.reasoningEffort
        || (item as CodexReasoningEffortOption | undefined)?.effort;
    if (isEffortLevel(value) && CODEX_SUPPORTED_EFFORTS.includes(value) && !levels.includes(value)) {
      levels.push(value);
    }
  }
  return levels.length > 0 ? levels : undefined;
}

export function normalizeCodexModelOption(m: CodexModelListEntry): ModelOption | null {
  const id = m.id || m.model || m.slug;
  if (!id) return null;
  const supportedEffortLevels = normalizeCodexEfforts(m.supportedReasoningEfforts || m.supported_reasoning_levels);
  return {
    id,
    label: m.displayName || m.display_name || id,
    family: 'gpt',
    description: m.description || '',
    // Codex doesn't surface costTier - display all as medium so the
    // picker doesn't lie. Users can still see token usage per turn.
    costTier: 'medium',
    default: m.isDefault || m.is_default || false,
    ...(supportedEffortLevels ? { supportedEffortLevels } : {}),
    capabilities: CODEX_MODEL_CAPABILITIES,
  };
}

export function codexModelSupportsEffort(models: ModelOption[] | undefined, model: string | undefined, effort: EffortLevel | undefined): boolean {
  if (!model || !effort) return false;
  const modelOption = models?.find((m) => m.id === model);
  return !!modelOption?.supportedEffortLevels?.includes(effort);
}

export function buildCodexTurnStartParams(
  threadId: string,
  input: unknown[],
  model: string | undefined,
  effort: EffortLevel | undefined,
  models: ModelOption[] | undefined,
): Record<string, unknown> {
  const params: Record<string, unknown> = { threadId, input };
  if (model) params.model = model;
  if (codexModelSupportsEffort(models, model, effort)) params.effort = effort;
  return params;
}
