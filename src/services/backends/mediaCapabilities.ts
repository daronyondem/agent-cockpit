import type {
  BackendMetadata,
  ModelInputModality,
  ModelOption,
  OneShotMediaTransport,
} from '../../types';

export type OneShotMediaInputCheck =
  | { ok: true; model: ModelOption; transports: OneShotMediaTransport[] }
  | {
      ok: false;
      reason: 'missing-backend-transport' | 'missing-model' | 'missing-model-modality';
      model?: ModelOption;
      transports: OneShotMediaTransport[];
      message: string;
    };

export function oneShotMediaTransports(
  metadata: BackendMetadata | null | undefined,
  modality: ModelInputModality,
): OneShotMediaTransport[] {
  const transports = metadata?.capabilities?.oneShotMediaInput?.[modality];
  return Array.isArray(transports) ? transports : [];
}

export function selectModelOption(
  metadata: BackendMetadata | null | undefined,
  modelId?: string | null,
): ModelOption | undefined {
  const models = metadata?.models || [];
  const requestedModelId = modelId?.trim();
  if (requestedModelId) {
    const selected = models.find(model => model.id === requestedModelId);
    if (selected) return selected;
  }
  return models.find(model => model.default) || models[0];
}

export function modelSupportsInputModality(
  model: ModelOption | null | undefined,
  modality: ModelInputModality,
): boolean {
  return model?.capabilities?.input?.[modality] === true;
}

export function checkOneShotMediaInput(
  metadata: BackendMetadata | null | undefined,
  modelId: string | null | undefined,
  modality: ModelInputModality,
): OneShotMediaInputCheck {
  const transports = oneShotMediaTransports(metadata, modality);
  if (transports.length === 0) {
    return {
      ok: false,
      reason: 'missing-backend-transport',
      transports,
      message: `${metadata?.label || metadata?.id || 'Selected backend'} does not expose ${modality} attachments for one-shot calls.`,
    };
  }

  const requestedModelId = modelId?.trim();
  const model = requestedModelId
    ? (metadata?.models || []).find(candidate => candidate.id === requestedModelId)
    : selectModelOption(metadata, modelId);
  if (!model) {
    return {
      ok: false,
      reason: 'missing-model',
      transports,
      message: requestedModelId
        ? `${metadata?.label || metadata?.id || 'Selected backend'} did not report selected model ${requestedModelId}, so ${modality} support cannot be verified.`
        : `${metadata?.label || metadata?.id || 'Selected backend'} did not report any models, so ${modality} support cannot be verified.`,
    };
  }

  if (!modelSupportsInputModality(model, modality)) {
    return {
      ok: false,
      reason: 'missing-model-modality',
      model,
      transports,
      message: `Model ${model.label || model.id} does not report ${modality} input support.`,
    };
  }

  return { ok: true, model, transports };
}
