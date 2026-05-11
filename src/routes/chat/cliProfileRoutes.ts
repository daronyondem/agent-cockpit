import express from 'express';
import { csrfGuard } from '../../middleware/csrf';
import type { BackendRegistry } from '../../services/backends/registry';
import type { ChatService } from '../../services/chatService';
import type { CliProfileAuthService } from '../../services/cliProfileAuthService';
import type { Request, Response } from '../../types';
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
