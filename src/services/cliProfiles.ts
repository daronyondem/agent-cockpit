import type { CliCommunicationProtocol, CliHarness, CliProfile, Settings } from '../types';

export const SUPPORTED_CLI_HARNESSES: CliHarness[] = ['claude-code', 'kiro', 'codex', 'opencode'];
export const CLAUDE_CODE_INTERACTIVE_BACKEND_ID = 'claude-code-interactive';
export const CLAUDE_CODE_STANDARD_PROTOCOL: CliCommunicationProtocol = 'standard';
export const CLAUDE_CODE_INTERACTIVE_PROTOCOL: CliCommunicationProtocol = 'interactive';

const SERVER_CONFIGURED_PREFIX = 'server-configured';

const HARNESS_LABELS: Record<CliHarness, string> = {
  'claude-code': 'Claude Code',
  kiro: 'Kiro',
  codex: 'Codex',
  opencode: 'OpenCode',
};

export function isCliHarness(value: string | undefined | null): value is CliHarness {
  return !!value && (SUPPORTED_CLI_HARNESSES as string[]).includes(value);
}

export function cliHarnessForBackend(backend: string | undefined | null): CliHarness | undefined {
  if (backend === CLAUDE_CODE_INTERACTIVE_BACKEND_ID) return 'claude-code';
  return isCliHarness(backend) ? backend : undefined;
}

export function backendUsesCliHarness(backend: string | undefined | null, harness: CliHarness | undefined | null): boolean {
  return !!harness && cliHarnessForBackend(backend) === harness;
}

export function cliProtocolForBackend(
  backend: string | undefined | null,
  harness: CliHarness | undefined | null = cliHarnessForBackend(backend),
): CliCommunicationProtocol | undefined {
  if (harness !== 'claude-code') return undefined;
  return backend === CLAUDE_CODE_INTERACTIVE_BACKEND_ID
    ? CLAUDE_CODE_INTERACTIVE_PROTOCOL
    : CLAUDE_CODE_STANDARD_PROTOCOL;
}

export function backendForCliProfile(
  profile: Pick<CliProfile, 'harness' | 'protocol'> | undefined | null,
  fallbackBackend?: string | null,
): string {
  if (!profile) return fallbackBackend || '';
  if (profile.harness !== 'claude-code') return profile.harness;
  if (profile.protocol === CLAUDE_CODE_INTERACTIVE_PROTOCOL) return CLAUDE_CODE_INTERACTIVE_BACKEND_ID;
  if (profile.protocol === CLAUDE_CODE_STANDARD_PROTOCOL) return 'claude-code';
  return backendUsesCliHarness(fallbackBackend, 'claude-code') ? fallbackBackend! : 'claude-code';
}

export function serverConfiguredCliProfileId(harness: CliHarness): string {
  return `${SERVER_CONFIGURED_PREFIX}-${harness}`;
}

export function isSetupAccountCliProfile(profile: Pick<CliProfile, 'id' | 'harness' | 'authMode'>): boolean {
  if (profile.authMode !== 'account') return false;
  if (profile.harness !== 'claude-code' && profile.harness !== 'codex') return false;
  return profile.id === `setup-${profile.harness}-account`
    || profile.id.startsWith(`setup-${profile.harness}-account-`);
}

export function cliProfileIdForBackend(backend: string | undefined | null): string | undefined {
  const harness = cliHarnessForBackend(backend);
  return harness ? serverConfiguredCliProfileId(harness) : undefined;
}

export interface CliProfileRuntime {
  backendId: string;
  cliProfileId?: string;
  profile?: CliProfile;
}

export function createServerConfiguredCliProfile(
  harness: CliHarness,
  timestamp: string = new Date().toISOString(),
  protocol: CliCommunicationProtocol | undefined = cliProtocolForBackend(harness, harness),
): CliProfile {
  return {
    id: serverConfiguredCliProfileId(harness),
    name: `${HARNESS_LABELS[harness]} (Server Configured)`,
    harness,
    authMode: 'server-configured',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(harness === 'claude-code' ? { protocol: protocol || CLAUDE_CODE_STANDARD_PROTOCOL } : {}),
  };
}

export function resolveCliProfileRuntime(
  settings: Settings,
  cliProfileId: string | undefined | null,
  fallbackBackend: string | undefined | null,
): { runtime?: CliProfileRuntime; error?: string } {
  const requestedProfileId = cliProfileId || (!fallbackBackend ? settings.defaultCliProfileId : undefined);

  if (requestedProfileId) {
    const profile = settings.cliProfiles?.find((candidate) => candidate.id === requestedProfileId);
    if (!profile) {
      return { error: `CLI profile not found: ${requestedProfileId}` };
    }
    if (profile.disabled) {
      return { error: `CLI profile is disabled: ${profile.name}` };
    }
    const legacyDefaultBackend = !fallbackBackend
      && requestedProfileId === settings.defaultCliProfileId
      && backendUsesCliHarness(settings.defaultBackend, profile.harness)
      ? settings.defaultBackend
      : undefined;
    return {
      runtime: {
        backendId: backendForCliProfile(profile, fallbackBackend || legacyDefaultBackend),
        cliProfileId: profile.id,
        profile,
      },
    };
  }

  const fallbackProfileId = cliProfileIdForBackend(fallbackBackend);
  const fallbackProfile = fallbackProfileId
    ? settings.cliProfiles?.find((candidate) => candidate.id === fallbackProfileId && !candidate.disabled)
    : undefined;
  const backendId = fallbackBackend || settings.defaultBackend;
  if (!backendId) {
    return {
      error: 'CLI profile is required. Configure a Default CLI profile in Global Settings before starting CLI-powered work.',
    };
  }
  return {
    runtime: {
      backendId,
      ...(fallbackProfile ? { cliProfileId: fallbackProfile.id, profile: fallbackProfile } : {}),
    },
  };
}

export function ensureServerConfiguredCliProfiles(
  settings: Settings,
  harnesses: Iterable<string | undefined | null>,
  timestamp: string = new Date().toISOString(),
): { settings: Settings; changed: boolean } {
  const profiles = Array.isArray(settings.cliProfiles) ? [...settings.cliProfiles] : [];
  const existingIds = new Set(profiles.map((profile) => profile.id));
  let changed = false;

  for (const harnessValue of harnesses) {
    const harness = cliHarnessForBackend(harnessValue);
    if (!harness) continue;
    const id = serverConfiguredCliProfileId(harness);
    if (existingIds.has(id)) continue;
    profiles.push(createServerConfiguredCliProfile(harness, timestamp, cliProtocolForBackend(harnessValue, harness)));
    existingIds.add(id);
    changed = true;
  }

  let defaultCliProfileId = settings.defaultCliProfileId;
  const defaultHarness = cliHarnessForBackend(settings.defaultBackend);
  if (!defaultCliProfileId && defaultHarness) {
    const candidateId = serverConfiguredCliProfileId(defaultHarness);
    const candidate = profiles.find((profile) => profile.id === candidateId && !profile.disabled);
    if (candidate) {
      defaultCliProfileId = candidateId;
      changed = true;
    }
  }

  if (!changed && defaultCliProfileId === settings.defaultCliProfileId) {
    return { settings, changed: false };
  }

  return {
    settings: {
      ...settings,
      ...(profiles.length > 0 ? { cliProfiles: profiles } : {}),
      ...(defaultCliProfileId ? { defaultCliProfileId } : {}),
    },
    changed,
  };
}
