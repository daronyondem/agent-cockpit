import { checkProcessorProfileEligibility, type BackendCapabilityMetadata } from '../../../../src/contracts/backendCapabilities';

/** Explicit saved identity wins even when unavailable; defaults apply only when unset. */
export function processorProfileForSetting<T extends { id: string; harness?: string; protocol?: string; disabled?: boolean }>(
  profiles: T[], profileId?: string | null, backendId?: string | null, fallbackBackend?: string | null, defaultId?: string | null,
): T | null {
  if (profileId) return profiles.find(profile => profile.id === profileId) || null;
  if (!backendId && defaultId) return profiles.find(profile => profile.id === defaultId) || null;
  const backend = backendId || fallbackBackend;
  if (!backend) return null;
  const harness = backend === 'claude-code-interactive' ? 'claude-code' : backend;
  const enabled = profiles.filter(profile => !profile.disabled);
  return enabled.find(profile => (profile.harness === 'claude-code' && profile.protocol === 'interactive' ? 'claude-code-interactive' : profile.harness) === backend)
    || enabled.find(profile => profile.id === `server-configured-${harness}`)
    || enabled.find(profile => profile.harness === harness) || null;
}

/** Preserve an unsupported saved selection visibly, without offering it for new work. */
export function processorProfileChoices<T extends { id: string }>(profiles: T[],
  metadataForProfile: (profile: T) => BackendCapabilityMetadata | null,
  role: 'restrictedText' | 'toolEnabled', selectedId: string | null, requirements: { sequential?: boolean } = {}){
  return profiles.flatMap(profile => {
    const eligibility = checkProcessorProfileEligibility(profile, metadataForProfile(profile), { role, ...requirements });
    if (!eligibility.ok && profile.id !== selectedId) return [];
    return [{ profile, disabled: !eligibility.ok, reason: eligibility.ok ? null : eligibility.message }];
  });
}
