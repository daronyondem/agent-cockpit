import {
  checkBackendRoleEligibility, checkProcessorProfileEligibility, type BackendCapabilityMetadata, type BackendRoleRequest,
} from '../src/contracts/backendCapabilities';

function metadata(overrides: Partial<BackendCapabilityMetadata> = {}): BackendCapabilityMetadata {
  return { id: 'cortex-code', label: 'CoCo', capabilities: { userQuestions: true, planMode: true,
    planRevision: true, stdinInput: false }, ...overrides };
}

describe('shared backend role eligibility', () => {
  test('profile eligibility separates configuration, metadata identity and independently gated processor roles', () => {
    const profile = { id: 'cortex', harness: 'cortex-code', cortexCode: { connection: 'fixture' } };
    const configured = metadata({ capabilities: { oneShot: { restrictedText: false, toolEnabled: true, sequential: true } } });
    expect(checkProcessorProfileEligibility(profile, configured, { role: 'toolEnabled', sequential: true })).toEqual({ ok: true });
    expect(checkProcessorProfileEligibility(profile, configured, { role: 'restrictedText' })).toMatchObject({ ok: false, reason: 'unsupported-role' });
    expect(checkProcessorProfileEligibility({ ...profile, disabled: true }, configured, { role: 'toolEnabled' })).toMatchObject({ ok: false, reason: 'profile-disabled' });
    expect(checkProcessorProfileEligibility({ ...profile, cortexCode: undefined }, configured, { role: 'toolEnabled' })).toMatchObject({ ok: false, reason: 'profile-unconfigured' });
    expect(checkProcessorProfileEligibility({ ...profile, cortexCode: { connection: 'PRIVATE\nVALUE' } }, configured, { role: 'toolEnabled' })).toEqual({ ok: false,
      reason: 'profile-unconfigured', message: 'Configure a named Snowflake connection for this CLI profile.' });
    expect(checkProcessorProfileEligibility(profile, metadata({ id: 'claude-code' }), { role: 'restrictedText' })).toMatchObject({ ok: false, reason: 'backend-unavailable' });
    expect(checkProcessorProfileEligibility(profile, undefined, { role: 'toolEnabled' })).toMatchObject({ ok: false, reason: 'backend-unavailable' });
    expect(checkProcessorProfileEligibility({ id: 'interactive', harness: 'claude-code', protocol: 'interactive' },
      metadata({ id: 'claude-code-interactive', capabilities: {} }), { role: 'toolEnabled' })).toEqual({ ok: true });
  });

  test('requires actual metadata and does not advertise an unavailable backend', () => {
    expect(checkBackendRoleEligibility(undefined, { role: 'chat' })).toMatchObject({ ok: false, reason: 'backend-unavailable' });
    expect(checkBackendRoleEligibility(metadata(), { role: 'chat' })).toEqual({ ok: true });
  });

  test.each(['questionReply', 'planReply', 'planRevision'] as const)('supports %s without enabling steering', role => {
    expect(checkBackendRoleEligibility(metadata(), { role })).toEqual({ ok: true });
    expect(checkBackendRoleEligibility(metadata(), { role: 'steering' })).toMatchObject({ ok: false, reason: 'unsupported-role' });
    expect(checkBackendRoleEligibility(metadata({ capabilities: {} }), { role })).toMatchObject({ ok: false });
  });

  test('keeps the legacy Grok revision default and respects explicit denial', () => {
    const grok = metadata({ id: 'grok-build', capabilities: { planMode: true, stdinInput: true } });
    expect(checkBackendRoleEligibility(grok, { role: 'planRevision' })).toEqual({ ok: true });
    expect(checkBackendRoleEligibility(grok, { role: 'steering' })).toEqual({ ok: true });
    expect(checkBackendRoleEligibility({ ...grok, capabilities: { planMode: true, planRevision: false } }, { role: 'planRevision' })).toMatchObject({ ok: false });
    expect(checkBackendRoleEligibility(metadata({ id: 'claude-code', capabilities: { planMode: true } }), { role: 'planRevision' })).toMatchObject({ ok: false });
  });

  test.each(['restrictedText', 'toolEnabled'] as const)('requires explicit CoCo %s support', role => {
    expect(checkBackendRoleEligibility(metadata(), { role })).toMatchObject({ ok: false, reason: 'unsupported-role' });
    expect(checkBackendRoleEligibility(metadata({ capabilities: { oneShot: { restrictedText: false, toolEnabled: false, sequential: false } } }), { role })).toMatchObject({ ok: false });
    expect(checkBackendRoleEligibility(metadata({ id: 'codex' }), { role, sequential: true })).toEqual({ ok: true });
  });

  test('certifies tool-enabled and sequential work separately from restricted text', () => {
    const tools = metadata({ capabilities: { oneShot: { restrictedText: false, toolEnabled: true, sequential: false } } });
    expect(checkBackendRoleEligibility(tools, { role: 'toolEnabled' })).toEqual({ ok: true });
    expect(checkBackendRoleEligibility(tools, { role: 'restrictedText' })).toMatchObject({ ok: false });
    expect(checkBackendRoleEligibility(tools, { role: 'toolEnabled', sequential: true })).toMatchObject({ ok: false, reason: 'unsupported-sequential' });
    const sequential = metadata({ capabilities: { oneShot: { restrictedText: false, toolEnabled: true, sequential: true } } });
    expect(checkBackendRoleEligibility(sequential, { role: 'toolEnabled', sequential: true })).toEqual({ ok: true });
    expect(checkBackendRoleEligibility(sequential, { role: 'restrictedText', sequential: true })).toMatchObject({ ok: false });
    const restricted = metadata({ capabilities: { oneShot: { restrictedText: true, toolEnabled: false, sequential: true } } });
    expect(checkBackendRoleEligibility(restricted, { role: 'restrictedText', sequential: true })).toEqual({ ok: true });
  });

  test('requires both one-shot image transport and an explicitly image-capable model', () => {
    const request: BackendRoleRequest = { role: 'toolEnabled', modality: 'image', modelId: 'vision' };
    const base = metadata({ capabilities: { oneShot: { restrictedText: false, toolEnabled: true, sequential: true } },
      models: [{ id: 'vision', label: 'Vision', capabilities: { input: { image: true } } }] });
    expect(checkBackendRoleEligibility(base, request)).toMatchObject({ ok: false, reason: 'missing-backend-transport' });
    const image = { ...base, capabilities: { ...base.capabilities, oneShotMediaInput: { image: ['explicit-attachment' as const] } } };
    expect(checkBackendRoleEligibility(image, request)).toEqual({ ok: true });
    expect(checkBackendRoleEligibility(image, { ...request, modelId: 'missing' })).toMatchObject({ ok: false, reason: 'missing-model' });
    expect(checkBackendRoleEligibility({ ...image, models: [{ id: 'vision', label: 'Auto', default: true }] }, request)).toMatchObject({ ok: false, reason: 'missing-model-modality' });
    expect(checkBackendRoleEligibility(image, { role: 'toolEnabled', modality: 'text' })).toEqual({ ok: true });
  });

  test('respects an explicit processor denial on an existing harness', () => {
    const existing = metadata({ id: 'opencode', capabilities: { oneShot: { restrictedText: false, toolEnabled: true, sequential: true } } });
    expect(checkBackendRoleEligibility(existing, { role: 'restrictedText' })).toMatchObject({ ok: false });
  });
});
