import type { CliProfile, CliVendor, Settings } from '../types';

export const SUPPORTED_CLI_VENDORS: CliVendor[] = ['claude-code', 'kiro', 'codex'];

const SERVER_CONFIGURED_PREFIX = 'server-configured';

const VENDOR_LABELS: Record<CliVendor, string> = {
  'claude-code': 'Claude Code',
  kiro: 'Kiro',
  codex: 'Codex',
};

export function isCliVendor(value: string | undefined | null): value is CliVendor {
  return !!value && (SUPPORTED_CLI_VENDORS as string[]).includes(value);
}

export function serverConfiguredCliProfileId(vendor: CliVendor): string {
  return `${SERVER_CONFIGURED_PREFIX}-${vendor}`;
}

export function cliProfileIdForBackend(backend: string | undefined | null): string | undefined {
  return isCliVendor(backend) ? serverConfiguredCliProfileId(backend) : undefined;
}

export interface CliProfileRuntime {
  backendId: string;
  cliProfileId?: string;
  profile?: CliProfile;
}

export function createServerConfiguredCliProfile(vendor: CliVendor, timestamp: string = new Date().toISOString()): CliProfile {
  return {
    id: serverConfiguredCliProfileId(vendor),
    name: `${VENDOR_LABELS[vendor]} (Server Configured)`,
    vendor,
    authMode: 'server-configured',
    createdAt: timestamp,
    updatedAt: timestamp,
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
    return {
      runtime: {
        backendId: profile.vendor,
        cliProfileId: profile.id,
        profile,
      },
    };
  }

  return {
    runtime: {
      backendId: fallbackBackend || settings.defaultBackend || 'claude-code',
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
    if (!isCliVendor(vendorValue)) continue;
    const id = serverConfiguredCliProfileId(vendorValue);
    if (existingIds.has(id)) continue;
    profiles.push(createServerConfiguredCliProfile(vendorValue, timestamp));
    existingIds.add(id);
    changed = true;
  }

  let defaultCliProfileId = settings.defaultCliProfileId;
  if (!defaultCliProfileId && isCliVendor(settings.defaultBackend)) {
    const candidateId = serverConfiguredCliProfileId(settings.defaultBackend);
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
