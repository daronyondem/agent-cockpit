import type {
  BackendMetadata as BrowserBackendMetadata,
  ModelInputModality,
  ModelOption,
  OneShotMediaTransport,
} from './responses';
import { parseCortexCodeProfileConfig } from './cliProfiles';

/** Only the browser-safe metadata fields needed by selection checks. */
export type BackendCapabilityMetadata = Pick<BrowserBackendMetadata, 'id' | 'label' | 'capabilities' | 'models'>;
type BackendMetadata = BackendCapabilityMetadata;

export type BackendRoleRequest =
  | { role: 'chat' | 'questionReply' | 'planReply' | 'planRevision' | 'steering' }
  | { role: 'restrictedText' | 'toolEnabled'; sequential?: boolean; modality?: ModelInputModality; modelId?: string | null };

export type BackendRoleEligibility =
  | { ok: true }
  | { ok: false; reason: 'backend-unavailable' | 'unsupported-role' | 'unsupported-sequential'
      | 'missing-backend-transport' | 'missing-model' | 'missing-model-modality'
      | 'profile-disabled' | 'profile-unconfigured'; message: string };

export function checkProcessorProfileEligibility(
  profile: { id: string; disabled?: boolean; harness?: string; protocol?: string; cortexCode?: unknown },
  metadata: BackendCapabilityMetadata | null | undefined,
  request: Extract<BackendRoleRequest, { role: 'restrictedText' | 'toolEnabled' }>,
): BackendRoleEligibility {
  if (profile.disabled) return { ok: false, reason: 'profile-disabled', message: 'Selected CLI profile is disabled.' };
  if (profile.harness === 'cortex-code' || metadata?.id === 'cortex-code') {
    try { parseCortexCodeProfileConfig(profile.cortexCode); }
    catch { return { ok: false, reason: 'profile-unconfigured', message: 'Configure a named Snowflake connection for this CLI profile.' }; }
  }
  const backendId = profile.harness === 'claude-code' && profile.protocol === 'interactive' ? 'claude-code-interactive' : profile.harness;
  if (backendId && metadata?.id !== backendId) return { ok: false, reason: 'backend-unavailable', message: 'CLI profile metadata is unavailable or out of date.' };
  return checkBackendRoleEligibility(metadata, request);
}

/** Cheap service preflight: static registered capabilities, without CLI discovery. */
export function requireBackendRole(metadata: BackendCapabilityMetadata, request: BackendRoleRequest): void {
  const result = checkBackendRoleEligibility(metadata, request);
  if (!result.ok) throw new Error(request.role === 'restrictedText'
    ? `${metadata.label} cannot run without tools. Select another Memory profile.` : result.message);
}

/** Selection eligibility; callers must still resolve a registered runtime and enforce its policy. */
export function checkBackendRoleEligibility(
  metadata: BackendCapabilityMetadata | null | undefined,
  request: BackendRoleRequest,
): BackendRoleEligibility {
  if (!metadata) return { ok: false, reason: 'backend-unavailable', message: 'Selected backend is unavailable.' };
  const capabilities = metadata.capabilities;
  const unavailable = (): BackendRoleEligibility => ({ ok: false, reason: 'unsupported-role',
    message: `${metadata.label} does not support ${request.role === 'toolEnabled' ? 'tool-enabled background work'
      : request.role === 'restrictedText' ? 'tool-free processors' : request.role}.` });
  switch (request.role) {
    case 'chat': return { ok: true };
    case 'questionReply': return capabilities?.userQuestions === true ? { ok: true } : unavailable();
    case 'planReply': return capabilities?.planMode === true ? { ok: true } : unavailable();
    case 'planRevision': return capabilities?.planMode === true
      && (capabilities.planRevision ?? metadata.id === 'grok-build') ? { ok: true } : unavailable();
    case 'steering': return capabilities?.stdinInput === true ? { ok: true } : unavailable();
  }
  const oneShot = capabilities?.oneShot;
  const legacy = metadata.id !== 'cortex-code' && oneShot === undefined;
  if (!legacy && oneShot?.[request.role] !== true) return unavailable();
  if (request.sequential && !legacy && oneShot?.sequential !== true) {
    return { ok: false, reason: 'unsupported-sequential', message: `${metadata.label} does not support sequential processor calls.` };
  }
  if (request.modality && request.modality !== 'text') {
    const media = checkOneShotMediaInput(metadata, request.modelId, request.modality);
    if (!media.ok) return { ok: false, reason: media.reason, message: media.message };
  }
  return { ok: true };
}

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
