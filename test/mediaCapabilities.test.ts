import type { BackendMetadata } from '../src/types';
import { checkOneShotMediaInput } from '../src/services/backends/mediaCapabilities';

function metadata(overrides: Partial<BackendMetadata> = {}): BackendMetadata {
  const base: BackendMetadata = {
    id: 'test-backend',
    label: 'Test Backend',
    icon: null,
    capabilities: {
      thinking: false,
      planMode: false,
      agents: false,
      toolActivity: false,
      userQuestions: false,
      stdinInput: false,
      oneShotMediaInput: { image: ['explicit-attachment'] },
    },
    models: [
      {
        id: 'vision',
        label: 'Vision',
        family: 'test',
        default: true,
        capabilities: { input: { text: true, image: true }, output: { text: true } },
      },
      {
        id: 'text',
        label: 'Text',
        family: 'test',
        capabilities: { input: { text: true, image: false }, output: { text: true } },
      },
    ],
    resumeCapabilities: {
      activeTurnResume: 'unsupported',
      activeTurnResumeReason: 'test backend',
      sessionResume: 'unsupported',
      sessionResumeReason: 'test backend',
    },
  };
  return { ...base, ...overrides };
}

describe('checkOneShotMediaInput', () => {
  test('passes when the backend transport and selected model modality are present', () => {
    expect(checkOneShotMediaInput(metadata(), 'vision', 'image')).toEqual({
      ok: true,
      model: expect.objectContaining({ id: 'vision' }),
      transports: ['explicit-attachment'],
    });
  });

  test('uses the default model when no model is explicitly selected', () => {
    expect(checkOneShotMediaInput(metadata(), undefined, 'image')).toEqual({
      ok: true,
      model: expect.objectContaining({ id: 'vision' }),
      transports: ['explicit-attachment'],
    });
  });

  test('fails when the backend has no one-shot transport for the modality', () => {
    const result = checkOneShotMediaInput(metadata({
      capabilities: {
        thinking: false,
        planMode: false,
        agents: false,
        toolActivity: false,
        userQuestions: false,
        stdinInput: false,
      },
    }), 'vision', 'image');

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'missing-backend-transport' });
  });

  test('fails when the selected model does not support the modality', () => {
    const result = checkOneShotMediaInput(metadata(), 'text', 'image');

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      reason: 'missing-model-modality',
      model: expect.objectContaining({ id: 'text' }),
    });
  });

  test('fails closed when an explicit model id is stale instead of falling back', () => {
    const result = checkOneShotMediaInput(metadata(), 'missing-model', 'image');

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'missing-model' });
  });
});
