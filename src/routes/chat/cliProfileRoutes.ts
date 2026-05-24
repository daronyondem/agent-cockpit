import express from 'express';
import { csrfGuard } from '../../middleware/csrf';
import type { BackendRegistry } from '../../services/backends/registry';
import type { ChatService } from '../../services/chatService';
import type { CliProfileAuthService } from '../../services/cliProfileAuthService';
import { validateCliProfileDraftRequest } from '../../contracts/chat';
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

  router.post('/cli-profiles/opencode/draft/metadata', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { profile } = validateCliProfileDraftRequest(req.body);
      const draft = normalizeOpenCodeDraftProfile(profile);
      const adapter = backendRegistry.get('opencode');
      if (!adapter) {
        return res.status(500).json({ error: 'CLI profile backend not registered: opencode' });
      }
      const backend = await adapter.getMetadata({ cliProfile: draft });
      res.json({ profile: draft, backend });
    } catch (err: unknown) {
      sendError(res, 400, err);
    }
  });

  router.post('/cli-profiles/opencode/draft/test', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { profile } = validateCliProfileDraftRequest(req.body);
      const draft = normalizeOpenCodeDraftProfile(profile);
      const result = await cliProfileAuth.checkProfile(draft);
      try {
        const adapter = backendRegistry.get('opencode');
        if (adapter) {
          const metadata = await adapter.getMetadata({ cliProfile: draft });
          const modelCount = Array.isArray(metadata.models) ? metadata.models.length : 0;
          result.modelsAvailable = modelCount > 0;
          result.modelCount = modelCount;
        }
      } catch (metadataErr: unknown) {
        result.modelListError = (metadataErr as Error).message || String(metadataErr);
      }
      res.json({ result, profile: draft });
    } catch (err: unknown) {
      sendError(res, 400, err);
    }
  });

  router.post('/cli-profiles/:id/test', csrfGuard, async (req: Request, res: Response) => {
    try {
      const settings = await chatService.getSettings();
      const prepared = prepareProfileForTest(cliProfileAuth, settings, param(req, 'id'));
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

function normalizeOpenCodeDraftProfile(profile: CliProfile): CliProfile {
  if (!profile || profile.vendor !== 'opencode') {
    throw new Error('OpenCode draft profile must use vendor opencode.');
  }
  const now = new Date().toISOString();
  const id = String(profile.id || 'draft-opencode').trim() || 'draft-opencode';
  const provider = typeof profile.opencode?.provider === 'string' ? profile.opencode.provider.trim() : '';
  const command = typeof profile.command === 'string' ? profile.command.trim() : '';
  return {
    id,
    name: String(profile.name || 'OpenCode Profile').trim() || 'OpenCode Profile',
    vendor: 'opencode',
    authMode: 'server-configured',
    ...(command ? { command } : {}),
    ...(provider ? { opencode: { provider } } : {}),
    createdAt: typeof profile.createdAt === 'string' && profile.createdAt ? profile.createdAt : now,
    updatedAt: now,
    ...(profile.disabled ? { disabled: true } : {}),
  };
}

function prepareProfileForTest(
  cliProfileAuth: CliProfileAuthService,
  settings: Settings,
  profileId: string,
): { settings: Settings; profile: CliProfile; changed: boolean } {
  const profile = settings.cliProfiles?.find(candidate => candidate.id === profileId);
  if (!profile) throw new Error(`CLI profile not found: ${profileId}`);
  if (profile.authMode === 'account' && (profile.vendor === 'codex' || profile.vendor === 'claude-code')) {
    return cliProfileAuth.profileWithAuthDefaults(settings, profileId);
  }
  return { settings, profile, changed: false };
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
    && (!hasSetupAuthHome(profile, vendor) || profile.id.startsWith(setupIdPrefix))
  );
  if (existingAccount) {
    const profile = existingAccount.id.startsWith(setupIdPrefix)
      ? setupProfileWithoutAuthHome(existingAccount, vendor)
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

function setupProfileWithoutAuthHome(profile: CliProfile, vendor: SetupAuthVendor): CliProfile {
  const { configDir: _configDir, env, ...rest } = profile;
  const nextEnv = stripSetupAuthHomeEnv(vendor, env);
  const changed = Boolean(profile.configDir || nextEnv !== env);
  if (!changed) return profile;
  return {
    ...rest,
    ...(nextEnv && Object.keys(nextEnv).length > 0 ? { env: nextEnv } : {}),
    updatedAt: new Date().toISOString(),
  };
}

function hasSetupAuthHome(profile: CliProfile, vendor: SetupAuthVendor): boolean {
  if (profile.configDir) return true;
  const key = vendor === 'claude-code' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  return Boolean(Object.entries(profile.env || {}).some(([name, value]) =>
    name.toUpperCase() === key && String(value || '').trim().length > 0,
  ));
}

function stripSetupAuthHomeEnv(
  vendor: SetupAuthVendor,
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!env) return env;
  const key = vendor === 'claude-code' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  const stripped: Record<string, string> = {};
  let changed = false;
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === key) {
      changed = true;
      continue;
    }
    stripped[name] = value;
  }
  if (!changed) return env;
  return Object.keys(stripped).length > 0 ? stripped : undefined;
}
