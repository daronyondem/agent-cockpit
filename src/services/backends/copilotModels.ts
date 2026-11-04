import type { ModelCapabilities, ModelOption } from '../../types';

export const COPILOT_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'] as const;
export const COPILOT_EFFORT_SET = new Set<string>(COPILOT_EFFORT_ORDER);

const TEXT_MODEL_CAPABILITIES: ModelCapabilities = {
  input: { text: true },
  output: { text: true },
  reasoning: true,
};

interface CopilotModelSeed {
  id: string;
  family: string;
  costTier: 'high' | 'medium' | 'low';
  description: string;
  default?: boolean;
  reasoning?: boolean;
  mediaVerified?: boolean;
}

// Curated fallback for the current chat/one-shot paths; SDK profile checks
// discover account access separately. New capabilities require native evidence.
const COPILOT_MODEL_SEEDS: CopilotModelSeed[] = [
  { id: 'auto', family: 'auto', costTier: 'medium', description: 'Let GitHub Copilot choose an available model', default: true, reasoning: false },
  { id: 'claude-sonnet-5.5', family: 'claude', costTier: 'medium', description: 'Balanced Claude Sonnet model for everyday agentic coding' },
  { id: 'claude-sonnet-5', family: 'claude', costTier: 'medium', description: 'Claude Sonnet 5' },
  { id: 'claude-sonnet-4.6', family: 'claude', costTier: 'medium', description: 'Claude Sonnet 4.6' },
  { id: 'claude-fable-5.1', family: 'claude', costTier: 'high', description: 'Claude Fable 5.1' },
  { id: 'claude-fable-5', family: 'claude', costTier: 'high', description: 'Claude Fable 5' },
  { id: 'claude-haiku-5.5', family: 'claude', costTier: 'low', description: 'Fast Claude Haiku model', reasoning: false },
  { id: 'claude-haiku-4.5', family: 'claude', costTier: 'low', description: 'Claude Haiku 4.5', reasoning: false },
  { id: 'claude-opus-5.5', family: 'claude', costTier: 'high', description: 'Claude Opus 5.5' },
  { id: 'claude-opus-5', family: 'claude', costTier: 'high', description: 'Claude Opus 5' },
  { id: 'claude-opus-4.8', family: 'claude', costTier: 'high', description: 'Claude Opus 4.8' },
  { id: 'claude-opus-4.8-fast', family: 'claude', costTier: 'high', description: 'Latency-optimized Claude Opus 4.8' },
  { id: 'gpt-6.1-sol', family: 'gpt', costTier: 'high', description: 'OpenAI GPT-6.1 Sol', mediaVerified: true },
  { id: 'gpt-6-sol', family: 'gpt', costTier: 'high', description: 'OpenAI GPT-6 Sol' },
  { id: 'gpt-6-luna', family: 'gpt', costTier: 'high', description: 'OpenAI GPT-6 Luna' },
  { id: 'gpt-6-astra', family: 'gpt', costTier: 'high', description: 'OpenAI GPT-6 Astra' },
  { id: 'gpt-5.6-sol', family: 'gpt', costTier: 'high', description: 'OpenAI GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', family: 'gpt', costTier: 'high', description: 'OpenAI GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', family: 'gpt', costTier: 'high', description: 'OpenAI GPT-5.6 Luna' },
  { id: 'gpt-5.5', family: 'gpt', costTier: 'high', description: 'OpenAI GPT-5.5 reasoning model' },
  { id: 'gpt-5.4', family: 'gpt', costTier: 'medium', description: 'OpenAI GPT-5.4 model' },
  { id: 'gpt-5.3-codex', family: 'gpt', costTier: 'medium', description: 'OpenAI GPT-5.3 Codex coding model' },
  { id: 'gpt-5.4-mini', family: 'gpt', costTier: 'low', description: 'Fast, low-cost GPT-5.4 mini model' },
  { id: 'gpt-5-mini', family: 'gpt', costTier: 'low', description: 'Fast, low-cost GPT-5 mini model' },
  { id: 'gemini-3.8-flash', family: 'gemini', costTier: 'low', description: 'Gemini Flash; account availability and media/effort support are not verified', reasoning: false },
];

export const COPILOT_MODELS: ModelOption[] = COPILOT_MODEL_SEEDS.map(seed => ({
  id: seed.id,
  label: seed.id,
  family: seed.family,
  description: seed.description,
  costTier: seed.costTier,
  ...(seed.default ? { default: true } : {}),
  ...(seed.reasoning === false ? {} : { supportedEffortLevels: [...COPILOT_EFFORT_ORDER] }),
  capabilities: {
    ...TEXT_MODEL_CAPABILITIES,
    input: { text: true, image: seed.mediaVerified === true, pdf: seed.mediaVerified === true },
    reasoning: seed.reasoning !== false,
  },
}));
