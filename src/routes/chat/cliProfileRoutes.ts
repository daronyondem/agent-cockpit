import express from 'express';
import { csrfGuard } from '../../middleware/csrf';
import type { BackendRegistry } from '../../services/backends/registry';
import type { ChatService } from '../../services/chatService';
import type { CliProfileAuthService } from '../../services/cliProfileAuthService';
import { backendForCliProfile, cliProtocolForBackend, cliVendorForBackend } from '../../services/cliProfiles';
import type { CliProfile, CliVendor, Request, Response, Settings } from '../../types';
import { isCliProfileResolutionError, param, sendError } from './routeUtils';

export interface CliProfileRoutesOptions {
  chatService: ChatService;
  backendRegistry: BackendRegistry;
  cliProfileAuth: CliProfileAuthService;
}

export function createCliProfileRouter(opts: CliProfileRoutesOptions): express.Router {
  const { chatService, backendRegistry, cliProfileAuth } = opts;
  const router = express.Router();

  router.get('/cli-profiles/:profileId/metadata', async (req: Request, res: Response) => {
    try {
      const profileId = param(req, 'profileId');
      const runtime = await chatService.resolveCliProfileRuntime(profileId);
      const adapter = backendRegistry.get(runtime.backendId);
      if (!adapter) {
        return res.status(500).json({ error: `CLI profile backend not registered: ${runtime.backendId}` });
      }
      const backend = await adapter.getMetadata({ cliProfile: runtime.profile });
      res.json({
        profileId: runtime.cliProfileId || profileId,
        backend,
      });
    } catch (err: unknown) {
      if (isCliProfileResolutionError(err)) return sendError(res, 400, err);
      sendError(res, 500, err);
    }
  });

  router.post('/cli-profiles/:id/test', csrfGuard, async (req: Request, res: Response) => {
    try {
      const settings = await chatService.getSettings();
      const prepared = cliProfileAuth.profileWithAuthDefaults(settings, param(req, 'id'));
      const savedSettings = prepared.changed
        ? await chatService.saveSettings(prepared.settings)
        : settings;
      const profile = savedSettings.cliProfiles?.find(candidate => candidate.id === prepared.profile.id) || prepared.profile;
      const result = await cliProfileAuth.checkProfile(profile);
      try {
        const runtime = await chatService.resolveCliProfileRuntime(profile.id);
        const adapter = backendRegistry.get(runtime.backendId);
        if (adapter) {
          const metadata = await adapter.getMetadata({ cliProfile: runtime.profile });
          const modelCount = Array.isArray(metadata.models) ? metadata.models.length : 0;
          result.modelsAvailable = modelCount > 0;
          result.modelCount = modelCount;
        }
      } catch (metadataErr: unknown) {
        result.modelListError = (metadataErr as Error).message || String(metadataErr);
      }
      res.json({
        result,
        profile,
        ...(prepared.changed ? { settings: savedSettings } : {}),
      });
    } catch (err: unknown) {
      sendError(res, 400, err);
    }
  });

  router.post('/cli-profiles/:id/auth/start', csrfGuard, async (req: Request, res: Response) => {
    try {
      const settings = await chatService.getSettings();
      const prepared = cliProfileAuth.profileWithAuthDefaults(settings, param(req, 'id'));
      const savedSettings = prepared.changed
        ? await chatService.saveSettings(prepared.settings)
        : settings;
      const profile = savedSettings.cliProfiles?.find(candidate => candidate.id === prepared.profile.id) || prepared.profile;
      const job = await cliProfileAuth.startAuth(profile);
      res.json({
        job,
        profile,
        ...(prepared.changed ? { settings: savedSettings } : {}),
      });
    } catch (err: unknown) {
      sendError(res, 400, err);
    }
  });

  router.post('/cli-profiles/setup-auth/:vendor/test', csrfGuard, async (req: Request, res: Response) => {
    try {
      const vendor = setupAuthVendor(param(req, 'vendor'));
      const prepared = await prepareSetupAuthProfile(chatService, vendor);
      const result = await cliProfileAuth.checkProfile(prepared.profile);
      try {
        const runtime = await chatService.resolveCliProfileRuntime(prepared.profile.id);
        const adapter = backendRegistry.get(runtime.backendId);
        if (adapter) {
          const metadata = await adapter.getMetadata({ cliProfile: runtime.profile });
          const modelCount = Array.isArray(metadata.models) ? metadata.models.length : 0;
          result.modelsAvailable = modelCount > 0;
          result.modelCount = modelCount;
        }
      } catch (metadataErr: unknown) {
        result.modelListError = (metadataErr as Error).message || String(metadataErr);
      }
      res.json({ result, profile: prepared.profile, settings: prepared.settings });
    } catch (err: unknown) {
      sendError(res, 400, err);
    }
  });

  router.post('/cli-profiles/setup-auth/:vendor/start', csrfGuard, async (req: Request, res: Response) => {
    try {
      const vendor = setupAuthVendor(param(req, 'vendor'));
      const prepared = await prepareSetupAuthProfile(chatService, vendor);
      const job = await cliProfileAuth.startAuth(prepared.profile);
      res.json({ job, profile: prepared.profile, settings: prepared.settings });
    } catch (err: unknown) {
      sendError(res, 400, err);
    }
  });

  router.get('/cli-profiles/auth-jobs/:jobId', async (req: Request, res: Response) => {
    const job = cliProfileAuth.getJob(param(req, 'jobId'));
    if (!job) {
      res.status(404).json({ error: 'Auth job not found' });
      return;
    }
    res.json({ job });
  });

  router.post('/cli-profiles/auth-jobs/:jobId/cancel', csrfGuard, async (req: Request, res: Response) => {
    try {
      res.json({ job: cliProfileAuth.cancelJob(param(req, 'jobId')) });
    } catch (err: unknown) {
      sendError(res, 404, err);
    }
  });

  return router;
}

type SetupAuthVendor = Extract<CliVendor, 'codex' | 'claude-code'>;

function setupAuthVendor(value: string): SetupAuthVendor {
  if (value === 'codex' || value === 'claude-code') return value;
  if (value === 'kiro') throw new Error('Remote authentication is not supported for Kiro profiles yet.');
  throw new Error(`Unsupported setup authentication vendor: ${value}`);
}

async function prepareSetupAuthProfile(
  chatService: ChatService,
  vendor: SetupAuthVendor,
): Promise<{ settings: Settings; profile: CliProfile }> {
  const settings = await chatService.getSettings();
  const preparedProfile = setupAuthProfile(settings, vendor);
  const savedSettings = preparedProfile.changed
    ? await chatService.saveSettings(preparedProfile.settings)
    : settings;
  const profile = savedSettings.cliProfiles?.find(candidate => candidate.id === preparedProfile.profile.id) || preparedProfile.profile;
  return { settings: savedSettings, profile };
}

function setupAuthProfile(settings: Settings, vendor: SetupAuthVendor): { settings: Settings; profile: CliProfile; changed: boolean } {
  const profiles = Array.isArray(settings.cliProfiles) ? settings.cliProfiles : [];
  const setupIdPrefix = `setup-${vendor}-account`;
  const existingAccount = profiles.find(profile =>
    profile.vendor === vendor
    && profile.authMode === 'account'
    && !profile.disabled
    && (!profile.configDir || profile.id.startsWith(setupIdPrefix))
  );
  if (existingAccount) {
    const profile = existingAccount.configDir && existingAccount.id.startsWith(setupIdPrefix)
      ? { ...existingAccount, configDir: undefined, updatedAt: new Date().toISOString() }
      : existingAccount;
    const nextProfiles = profile === existingAccount
      ? profiles
      : profiles.map(candidate => candidate.id === profile.id ? profile : candidate);
    const baseSettings = nextProfiles === profiles ? settings : { ...settings, cliProfiles: nextProfiles };
    const promoted = maybePromoteSetupProfile(baseSettings, nextProfiles, profile, vendor);
    return {
      settings: promoted || baseSettings,
      profile,
      changed: Boolean(promoted) || baseSettings !== settings,
    };
  }

  const now = new Date().toISOString();
  const profile: CliProfile = {
    id: uniqueSetupProfileId(profiles, `setup-${vendor}-account`),
    name: vendor === 'codex' ? 'Codex Account' : 'Claude Code Account',
    vendor,
    authMode: 'account',
    createdAt: now,
    updatedAt: now,
    ...(vendor === 'claude-code' ? { protocol: cliProtocolForBackend(settings.defaultBackend, vendor) || 'standard' } : {}),
  };
  const promoted = maybePromoteSetupProfile(settings, profiles, profile, vendor);
  const baseSettings = promoted || settings;
  return {
    settings: {
      ...baseSettings,
      cliProfiles: [...profiles, profile],
    },
    profile,
    changed: true,
  };
}

function maybePromoteSetupProfile(
  settings: Settings,
  profiles: CliProfile[],
  profile: CliProfile,
  vendor: SetupAuthVendor,
): Settings | null {
  const defaultProfile = settings.defaultCliProfileId
    ? profiles.find(candidate => candidate.id === settings.defaultCliProfileId)
    : undefined;
  const defaultVendor = cliVendorForBackend(settings.defaultBackend);
  const shouldMakeDefault = !settings.defaultCliProfileId
    || (defaultVendor === vendor && (!defaultProfile || defaultProfile.authMode === 'server-configured'));
  if (!shouldMakeDefault) return null;
  return {
    ...settings,
    defaultCliProfileId: profile.id,
    defaultBackend: backendForCliProfile(profile, settings.defaultBackend),
  };
}

function uniqueSetupProfileId(profiles: CliProfile[], baseId: string): string {
  const ids = new Set(profiles.map(profile => profile.id));
  if (!ids.has(baseId)) return baseId;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${baseId}-${i}`;
    if (!ids.has(candidate)) return candidate;
  }
  return `${baseId}-${Date.now().toString(36)}`;
}
