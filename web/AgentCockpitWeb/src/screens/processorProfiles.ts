import { checkBackendRoleEligibility, type BackendCapabilityMetadata } from '../../../../src/contracts/backendCapabilities';

/** Preserve an unsupported saved selection visibly, without offering it for new work. */
export function processorProfileChoices<T extends { id: string }>(profiles: T[],
  metadataForProfile: (profile: T) => BackendCapabilityMetadata | null,
  role: 'restrictedText' | 'toolEnabled', selectedId: string | null){
  return profiles.flatMap(profile => {
    const eligibility = checkBackendRoleEligibility(metadataForProfile(profile), { role });
    if (!eligibility.ok && profile.id !== selectedId) return [];
    return [{ profile, disabled: !eligibility.ok, reason: eligibility.ok ? null : eligibility.message }];
  });
}
