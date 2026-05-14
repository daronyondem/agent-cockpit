import type { CliCommunicationProtocol, CliProfile, CliVendor, Settings } from '../types';

export const SUPPORTED_CLI_VENDORS: CliVendor[] = ['claude-code', 'kiro', 'codex'];
export const CLAUDE_CODE_INTERACTIVE_BACKEND_ID = 'claude-code-interactive';
export const CLAUDE_CODE_STANDARD_PROTOCOL: CliCommunicationProtocol = 'standard';
export const CLAUDE_CODE_INTERACTIVE_PROTOCOL: CliCommunicationProtocol = 'interactive';

const SERVER_CONFIGURED_PREFIX = 'server-configured';

const VENDOR_LABELS: Record<CliVendor, string> = {
  'claude-code': 'Claude Code',
  kiro: 'Kiro',
  codex: 'Codex',
};

export function isCliVendor(value: string | undefined | null): value is CliVendor {
  return !!value && (SUPPORTED_CLI_VENDORS as string[]).includes(value);
}

export function cliVendorForBackend(backend: string | undefined | null): CliVendor | undefined {
  if (backend === CLAUDE_CODE_INTERACTIVE_BACKEND_ID) return 'claude-code';
  return isCliVendor(backend) ? backend : undefined;
}

export function backendUsesCliVendor(backend: string | undefined | null, vendor: CliVendor | undefined | null): boolean {
  return !!vendor && cliVendorForBackend(backend) === vendor;
}

export function cliProtocolForBackend(
  backend: string | undefined | null,
  vendor: CliVendor | undefined | null = cliVendorForBackend(backend),
): CliCommunicationProtocol | undefined {
  if (vendor !== 'claude-code') return undefined;
  return backend === CLAUDE_CODE_INTERACTIVE_BACKEND_ID
    ? CLAUDE_CODE_INTERACTIVE_PROTOCOL
    : CLAUDE_CODE_STANDARD_PROTOCOL;
}

export function backendForCliProfile(
  profile: Pick<CliProfile, 'vendor' | 'protocol'> | undefined | null,
  fallbackBackend?: string | null,
): string {
  if (!profile) return fallbackBackend || 'claude-code';
  if (profile.vendor !== 'claude-code') return profile.vendor;
  if (profile.protocol === CLAUDE_CODE_INTERACTIVE_PROTOCOL) return CLAUDE_CODE_INTERACTIVE_BACKEND_ID;
  if (profile.protocol === CLAUDE_CODE_STANDARD_PROTOCOL) return 'claude-code';
  return backendUsesCliVendor(fallbackBackend, 'claude-code') ? fallbackBackend! : 'claude-code';
}

export function serverConfiguredCliProfileId(vendor: CliVendor): string {
  return `${SERVER_CONFIGURED_PREFIX}-${vendor}`;
}

export function cliProfileIdForBackend(backend: string | undefined | null): string | undefined {
  const vendor = cliVendorForBackend(backend);
  return vendor ? serverConfiguredCliProfileId(vendor) : undefined;
}

export interface CliProfileRuntime {
  backendId: string;
  cliProfileId?: string;
  profile?: CliProfile;
}

export function createServerConfiguredCliProfile(
  vendor: CliVendor,
  timestamp: string = new Date().toISOString(),
  protocol: CliCommunicationProtocol | undefined = cliProtocolForBackend(vendor, vendor),
): CliProfile {
  return {
    id: serverConfiguredCliProfileId(vendor),
    name: `${VENDOR_LABELS[vendor]} (Server Configured)`,
    vendor,
    authMode: 'server-configured',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(vendor === 'claude-code' ? { protocol: protocol || CLAUDE_CODE_STANDARD_PROTOCOL } : {}),
  };
}

export function resolveCliProfileRuntime(
  settings: Settings,
  cliProfileId: string | undefined | null,
  fallbackBackend: string | undefined | null,
): { runtime?: CliProfileRuntime; error?: string } {
  if (cliProfileId) {
    const profile = settings.cliProfiles?.find((candidate) => candidate.id === cliProfileId);
    if (!profile) {
      return { error: `CLI profile not found: ${cliProfileId}` };
    }
    if (profile.disabled) {
      return { error: `CLI profile is disabled: ${profile.name}` };
    }
    const legacyDefaultBackend = !fallbackBackend
      && cliProfileId === settings.defaultCliProfileId
      && backendUsesCliVendor(settings.defaultBackend, profile.vendor)
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
  return {
    runtime: {
      backendId: fallbackBackend || settings.defaultBackend || 'claude-code',
      ...(fallbackProfile ? { cliProfileId: fallbackProfile.id, profile: fallbackProfile } : {}),
    },
  };
}

export function ensureServerConfiguredCliProfiles(
  settings: Settings,
  vendors: Iterable<string | undefined | null>,
  timestamp: string = new Date().toISOString(),
): { settings: Settings; changed: boolean } {
  const profiles = Array.isArray(settings.cliProfiles) ? [...settings.cliProfiles] : [];
  const existingIds = new Set(profiles.map((profile) => profile.id));
  let changed = false;

  for (const vendorValue of vendors) {
    const vendor = cliVendorForBackend(vendorValue);
    if (!vendor) continue;
    const id = serverConfiguredCliProfileId(vendor);
    if (existingIds.has(id)) continue;
    profiles.push(createServerConfiguredCliProfile(vendor, timestamp, cliProtocolForBackend(vendorValue, vendor)));
    existingIds.add(id);
    changed = true;
  }

  let defaultCliProfileId = settings.defaultCliProfileId;
  const defaultVendor = cliVendorForBackend(settings.defaultBackend);
  if (!defaultCliProfileId && defaultVendor) {
    const candidateId = serverConfiguredCliProfileId(defaultVendor);
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
