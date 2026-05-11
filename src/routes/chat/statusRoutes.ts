import express from 'express';
import { csrfGuard } from '../../middleware/csrf';
import type { BackendRegistry } from '../../services/backends/registry';
import type { ChatService } from '../../services/chatService';
import type { ClaudePlanUsageService } from '../../services/claudePlanUsageService';
import type { CliUpdateService } from '../../services/cliUpdateService';
import type { CodexPlanUsageService } from '../../services/codexPlanUsageService';
import { detectLibreOffice } from '../../services/knowledgeBase/libreOffice';
import { detectPandoc } from '../../services/knowledgeBase/pandoc';
import type { KiroPlanUsageService } from '../../services/kiroPlanUsageService';
import type { UpdateService } from '../../services/updateService';
import type { Request, Response } from '../../types';
import packageJson from '../../../package.json';
import { isCliProfileResolutionError, param, sendError } from './routeUtils';
import { validateSettingsRequest, type VersionResponse } from '../../contracts/chat';

export interface ChatStatusRoutesOptions {
  chatService: ChatService;
  backendRegistry: BackendRegistry;
  updateService: UpdateService | null;
  cliUpdateService: CliUpdateService | null;
  claudePlanUsageService: ClaudePlanUsageService;
  kiroPlanUsageService: KiroPlanUsageService;
  codexPlanUsageService: CodexPlanUsageService;
  hasAnyInFlightTurn: () => boolean;
}

export function createChatStatusRouter(opts: ChatStatusRoutesOptions): express.Router {
  const {
    chatService,
    backendRegistry,
    updateService,
    cliUpdateService,
    claudePlanUsageService,
    kiroPlanUsageService,
    codexPlanUsageService,
    hasAnyInFlightTurn,
  } = opts;
  const router = express.Router();

  router.get('/backends', (_req: Request, res: Response) => {
    res.json({ backends: backendRegistry.list() });
  });

  router.get('/version', (_req: Request, res: Response) => {
    const status = updateService ? updateService.getStatus() : {} as Record<string, unknown>;
    const body: VersionResponse = {
      version: packageJson.version,
      remoteVersion: (status as ReturnType<UpdateService['getStatus']>).remoteVersion || null,
      updateAvailable: (status as ReturnType<UpdateService['getStatus']>).updateAvailable || false,
    };
    res.json(body);
  });

  router.get('/update-status', (_req: Request, res: Response) => {
    if (!updateService) return res.json({ updateAvailable: false });
    res.json(updateService.getStatus());
  });

  router.post('/check-version', csrfGuard, async (_req: Request, res: Response) => {
    if (!updateService) return res.status(501).json({ error: 'Update service not available' });
    try {
      const status = await updateService.checkNow();
      res.json(status);
    } catch (err: unknown) {
      sendError(res, 500, err);
    }
  });

  router.post('/update-trigger', csrfGuard, async (_req: Request, res: Response) => {
    if (!updateService) return res.status(501).json({ error: 'Update service not available' });
    try {
      const result = await updateService.triggerUpdate({ hasActiveStreams: hasAnyInFlightTurn });
      res.json(result);
    } catch (err: unknown) {
      sendError(res, 500, err);
    }
  });

  router.post('/server/restart', csrfGuard, async (_req: Request, res: Response) => {
    if (!updateService) return res.status(501).json({ error: 'Update service not available' });
    try {
      const result = await updateService.restart({ hasActiveStreams: hasAnyInFlightTurn });
      if (result.success) {
        res.json(result);
      } else {
        res.status(409).json(result);
      }
    } catch (err: unknown) {
      sendError(res, 500, err);
    }
  });

  router.get('/plan-usage', async (req: Request, res: Response) => {
    try {
      const rawProfileId = req.query.cliProfileId;
      const cliProfileId = typeof rawProfileId === 'string' ? rawProfileId : undefined;
      if (!cliProfileId) return res.json(claudePlanUsageService.getCached());

      const runtime = await chatService.resolveCliProfileRuntime(cliProfileId, 'claude-code');
      if (runtime.backendId !== 'claude-code') {
        return res.status(400).json({ error: `CLI profile vendor ${runtime.backendId} is not claude-code` });
      }
      res.json(claudePlanUsageService.getCached(runtime.profile));
    } catch (err: unknown) {
      if (isCliProfileResolutionError(err)) return sendError(res, 400, err);
      sendError(res, 500, err);
    }
  });

  router.get('/kiro-plan-usage', (_req: Request, res: Response) => {
    res.json(kiroPlanUsageService.getCached());
  });

  router.get('/codex-plan-usage', async (req: Request, res: Response) => {
    try {
      const rawProfileId = req.query.cliProfileId;
      const cliProfileId = typeof rawProfileId === 'string' ? rawProfileId : undefined;
      if (!cliProfileId) return res.json(codexPlanUsageService.getCached());

      const runtime = await chatService.resolveCliProfileRuntime(cliProfileId, 'codex');
      if (runtime.backendId !== 'codex') {
        return res.status(400).json({ error: `CLI profile vendor ${runtime.backendId} is not codex` });
      }
      res.json(codexPlanUsageService.getCached(runtime.profile));
    } catch (err: unknown) {
      if (isCliProfileResolutionError(err)) return sendError(res, 400, err);
      sendError(res, 500, err);
    }
  });

  router.get('/cli-updates', async (_req: Request, res: Response) => {
    if (!cliUpdateService) return res.json({ items: [], lastCheckAt: null, updateInProgress: false });
    try {
      const settings = await chatService.getSettings();
      res.json(cliUpdateService.getStatus(settings));
    } catch (err: unknown) {
      sendError(res, 500, err);
    }
  });

  router.post('/cli-updates/check', csrfGuard, async (_req: Request, res: Response) => {
    if (!cliUpdateService) return res.status(501).json({ error: 'CLI update service not available' });
    try {
      const status = await cliUpdateService.checkNow(() => chatService.getSettings());
      res.json(status);
    } catch (err: unknown) {
      sendError(res, 500, err);
    }
  });

  router.post('/cli-updates/:id/update', csrfGuard, async (req: Request, res: Response) => {
    if (!cliUpdateService) return res.status(501).json({ error: 'CLI update service not available' });
    try {
      const result = await cliUpdateService.triggerUpdate(param(req, 'id'), {
        loadSettings: () => chatService.getSettings(),
        hasActiveStreams: hasAnyInFlightTurn,
        onUpdated: () => backendRegistry.shutdownAll(),
      });
      if (result.success) {
        res.json(result);
      } else {
        res.status(result.error && result.error.includes('actively running') ? 409 : 400).json(result);
      }
    } catch (err: unknown) {
      sendError(res, 500, err);
    }
  });

  router.get('/kb/libreoffice-status', async (_req: Request, res: Response) => {
    try {
      const status = await detectLibreOffice();
      res.json(status);
    } catch (err: unknown) {
      sendError(res, 500, err);
    }
  });

  router.get('/kb/pandoc-status', async (_req: Request, res: Response) => {
    try {
      const status = await detectPandoc();
      res.json(status);
    } catch (err: unknown) {
      sendError(res, 500, err);
    }
  });

  router.get('/usage-stats', async (_req: Request, res: Response) => {
    try {
      const ledger = await chatService.getUsageStats();
      res.json(ledger);
    } catch (err: unknown) {
      sendError(res, 500, err);
    }
  });

  router.delete('/usage-stats', csrfGuard, async (_req: Request, res: Response) => {
    try {
      await chatService.clearUsageStats();
      res.json({ ok: true });
    } catch (err: unknown) {
      sendError(res, 500, err);
    }
  });

  router.get('/settings', async (_req: Request, res: Response) => {
    try {
      res.json(await chatService.getSettings());
    } catch (err: unknown) {
      sendError(res, 500, err);
    }
  });

  router.put('/settings', csrfGuard, async (req: Request, res: Response) => {
    try {
      const settings = await chatService.saveSettings(validateSettingsRequest(req.body));
      res.json(settings);
    } catch (err: unknown) {
      const message = (err as Error).message || '';
      sendError(res, message === 'settings must be an object' ? 400 : 500, err);
    }
  });

  return router;
}
