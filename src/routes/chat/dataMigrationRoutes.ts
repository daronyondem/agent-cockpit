import express from 'express';
import fs from 'fs';
import multer from 'multer';
import { csrfGuard } from '../../middleware/csrf';
import { validateDataImportConfirmRequest, DATA_IMPORT_CONFIRMATION } from '../../contracts/dataMigration';
import { isContractValidationError } from '../../contracts/validation';
import type { ChatService } from '../../services/chatService';
import { DataMigrationService } from '../../services/dataMigrationService';
import type { UpdateService } from '../../services/updateService';
import type { Request, Response } from '../../types';
import { sendError } from './routeUtils';

export interface DataMigrationRoutesOptions {
  chatService: ChatService;
  dataMigrationService: DataMigrationService;
  updateService: UpdateService | null;
  hasAnyInFlightTurn: () => boolean;
}

export function createDataMigrationRouter(opts: DataMigrationRoutesOptions): express.Router {
  const { chatService, dataMigrationService, updateService, hasAnyInFlightTurn } = opts;
  const router = express.Router();
  fs.mkdirSync(dataMigrationService.uploadDir(), { recursive: true });
  const upload = multer({
    dest: dataMigrationService.uploadDir(),
    limits: { fileSize: 20 * 1024 * 1024 * 1024 },
  });

  router.get('/migration/status', (_req: Request, res: Response) => {
    res.json(dataMigrationService.getStatus());
  });

  router.get('/migration/export', async (_req: Request, res: Response) => {
    if (hasAnyInFlightTurn()) {
      return res.status(409).json({ error: 'Cannot export while conversations are actively running. Please wait for them to complete or abort them first.' });
    }
    try {
      chatService.closeKbDatabases();
      await chatService.closeKbVectorStores();
      const bundle = await dataMigrationService.createExportBundle();
      res.download(bundle.filePath, bundle.filename, (err) => {
        fs.rm(bundle.filePath, { force: true }, () => {});
        if (err && !res.headersSent) res.status(500).json({ error: err.message });
      });
    } catch (err: unknown) {
      sendError(res, 500, err);
    }
  });

  router.post('/migration/export/start', csrfGuard, async (_req: Request, res: Response) => {
    if (hasAnyInFlightTurn()) {
      return res.status(409).json({ error: 'Cannot export while conversations are actively running. Please wait for them to complete or abort them first.' });
    }
    try {
      chatService.closeKbDatabases();
      await chatService.closeKbVectorStores();
      res.status(202).json(dataMigrationService.startExportJob());
    } catch (err: unknown) {
      sendError(res, statusForExportError(err), err);
    }
  });

  router.get('/migration/export/:jobId/status', async (req: Request, res: Response) => {
    try {
      res.json(dataMigrationService.getExportJob(String(req.params.jobId || '')));
    } catch (err: unknown) {
      sendError(res, 404, err);
    }
  });

  router.get('/migration/export/:jobId/download', async (req: Request, res: Response) => {
    const jobId = String(req.params.jobId || '');
    try {
      const bundle = dataMigrationService.getExportJobDownload(jobId);
      res.download(bundle.filePath, bundle.filename, (err) => {
        dataMigrationService.deleteExportJob(jobId);
        if (err && !res.headersSent) res.status(500).json({ error: err.message });
      });
    } catch (err: unknown) {
      sendError(res, statusForExportError(err), err);
    }
  });

  router.post('/migration/import/preview', csrfGuard, upload.single('bundle'), async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'bundle file is required' });
    let uploadId: string | null = null;
    try {
      uploadId = await dataMigrationService.saveImportUpload(file.path, file.originalname);
      const preview = await dataMigrationService.previewImportUpload(uploadId);
      res.json(preview);
    } catch (err: unknown) {
      if (uploadId) {
        await dataMigrationService.deleteUpload(uploadId).catch(() => {});
      } else {
        fs.rm(file.path, { force: true }, () => {});
      }
      sendError(res, 400, err);
    }
  });

  router.post('/migration/import/confirm', csrfGuard, async (req: Request, res: Response) => {
    if (!updateService) return res.status(501).json({ error: 'Restart service not available' });
    if (hasAnyInFlightTurn()) {
      return res.status(409).json({ error: 'Cannot import while conversations are actively running. Please wait for them to complete or abort them first.' });
    }
    try {
      const request = validateDataImportConfirmRequest(req.body);
      if (request.confirmation !== DATA_IMPORT_CONFIRMATION) {
        return res.status(400).json({ error: `Type ${DATA_IMPORT_CONFIRMATION} to confirm replacement.` });
      }
      const scheduled = await dataMigrationService.scheduleImport(request.uploadId);
      const restart = await updateService.restart({ hasActiveStreams: hasAnyInFlightTurn });
      if (!restart.success) {
        await dataMigrationService.cancelPendingImport(scheduled.importId).catch(() => {});
        return res.status(409).json({
          ok: false,
          pending: false,
          error: restart.error || 'Restart failed. Import was not applied.',
          importId: scheduled.importId,
          backupPath: scheduled.backupPath,
          restart,
        });
      }
      res.json({
        ok: true,
        pending: true,
        restart,
        backupPath: scheduled.backupPath,
        importId: scheduled.importId,
        message: 'Import is staged and will replace this installation data root on restart.',
      });
    } catch (err: unknown) {
      if (isContractValidationError(err)) return sendError(res, 400, err);
      sendError(res, statusForImportConfirmError(err), err);
    }
  });

  router.get('/migration/checks', async (req: Request, res: Response) => {
    try {
      const deep = req.query.deep === 'true';
      res.json(await dataMigrationService.runPostImportChecks({ deep }));
    } catch (err: unknown) {
      sendError(res, 500, err);
    }
  });

  return router;
}

function statusForExportError(err: unknown): number {
  const message = ((err as Error).message || String(err)).toLowerCase();
  if (message.includes('already running')) return 409;
  if (message.includes('not found')) return 404;
  if (message.includes('not ready')) return 409;
  return 500;
}

function statusForImportConfirmError(err: unknown): number {
  const message = ((err as Error).message || String(err)).toLowerCase();
  if (message.includes('already pending')) return 409;
  if (
    message.includes('upload not found') ||
    message.includes('import bundle') ||
    message.includes('import manifest') ||
    message.includes('unsafe import') ||
    message.includes('checksum mismatch') ||
    message.includes('file size mismatch') ||
    message.includes('unexpected data file') ||
    message.includes('missing manifest file')
  ) {
    return 400;
  }
  return 500;
}
