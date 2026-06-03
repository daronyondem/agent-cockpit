import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { csrfGuard } from '../../middleware/csrf';
import { attachmentFromPath, type ChatService } from '../../services/chatService';
import type { BackendRegistry } from '../../services/backends/registry';
import { checkOneShotMediaInput } from '../../services/backends/mediaCapabilities';
import { validateAttachmentOcrRequest, type AttachmentOcrResponse } from '../../contracts/uploads';
import { isContractValidationError } from '../../contracts/validation';
import type { Request, Response, NextFunction } from '../../types';
import { logger } from '../../utils/logger';
import { DngPreviewExtractionError } from '../../services/chat/dngPreview';
import { normalizeUploadedChatImage, originalDngPathForPreview } from '../../services/chat/uploadImageNormalization';
import {
  conversationHasMissingCliProfile,
  isCliProfileResolutionError,
  MISSING_CLI_PROFILE_RECOVERY_MESSAGE,
  param,
} from './routeUtils';

const log = logger.child({ module: 'chat-upload-routes' });
export const CONVERSATION_UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;
const CONVERSATION_UPLOAD_MAX_FILES = 10;

export interface UploadRoutesOptions {
  chatService: ChatService;
  backendRegistry: BackendRegistry;
}

export function createUploadRouter(opts: UploadRoutesOptions): express.Router {
  const { chatService, backendRegistry } = opts;
  const router = express.Router();

  const upload = multer({
    storage: multer.diskStorage({
      destination: async (_req, _file, cb) => {
        const id = (_req as Request).params.id;
        const dir = path.join(chatService.artifactsDir, Array.isArray(id) ? id[0] : id);
        await fs.promises.mkdir(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const safe = file.originalname.replace(/[\/\\]/g, '_');
        cb(null, safe);
      },
    }),
    limits: { fileSize: CONVERSATION_UPLOAD_LIMIT_BYTES, files: CONVERSATION_UPLOAD_MAX_FILES },
  });

  const uploadConversationFiles = (req: Request, res: Response, next: NextFunction): void => {
    upload.array('files', CONVERSATION_UPLOAD_MAX_FILES)(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        const message = err.code === 'LIMIT_FILE_SIZE'
          ? `File exceeds the ${Math.floor(CONVERSATION_UPLOAD_LIMIT_BYTES / 1024 / 1024)} MB upload limit.`
          : err.message;
        res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
        return;
      }
      if (err) {
        res.status(500).json({ error: (err as Error).message });
        return;
      }
      next();
    });
  };

  router.post('/conversations/:id/upload', csrfGuard, uploadConversationFiles, async (req: Request, res: Response) => {
    try {
      const files = [];
      for (const f of ((req as unknown as { files?: Express.Multer.File[] }).files || [])) {
        const normalizedPath = await normalizeUploadedChatImage(f.path);
        const stat = await fs.promises.stat(normalizedPath);
        const meta = attachmentFromPath(normalizedPath, stat.size);
        files.push({
          name: meta.name,
          path: meta.path,
          size: meta.size,
          kind: meta.kind,
          meta: meta.meta,
        });
      }
      res.json({ files });
    } catch (err: unknown) {
      if (err instanceof DngPreviewExtractionError) {
        return res.status(400).json({ error: err.message });
      }
      log.error('Failed to process uploaded conversation file', { error: err });
      return res.status(500).json({ error: 'Failed to process uploaded file' });
    }
  });

  router.get('/conversations/:id/files/:filename', async (req: Request, res: Response) => {
    const safe = param(req, 'filename').replace(/[\/\\]/g, '_');
    const filePath = path.join(chatService.artifactsDir, param(req, 'id'), safe);
    if (!path.resolve(filePath).startsWith(path.resolve(chatService.artifactsDir))) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    try {
      await fs.promises.access(filePath);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }
    const mode = (req.query.mode as string) || '';
    if (mode === 'view') {
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.size > 2 * 1024 * 1024) {
          return res.status(413).json({ error: 'File too large to view (max 2 MB). Use download instead.' });
        }
        const content = await fs.promises.readFile(filePath, 'utf8');
        const ext = path.extname(safe).replace('.', '');
        return res.json({ content, filename: safe, language: ext });
      } catch (err: unknown) {
        return res.status(500).json({ error: (err as Error).message });
      }
    }
    if (mode === 'download') {
      res.setHeader('Content-Disposition', `attachment; filename="${safe.replace(/"/g, '\\"')}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      return fs.createReadStream(filePath).pipe(res);
    }
    res.sendFile(path.resolve(filePath));
  });

  router.delete('/conversations/:id/upload/:filename', csrfGuard, async (req: Request, res: Response) => {
    const safe = param(req, 'filename').replace(/[\/\\]/g, '_');
    const filePath = path.join(chatService.artifactsDir, param(req, 'id'), safe);
    if (!path.resolve(filePath).startsWith(path.resolve(chatService.artifactsDir))) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    try {
      await fs.promises.unlink(filePath);
      const originalDngPath = originalDngPathForPreview(filePath);
      if (originalDngPath) {
        await fs.promises.unlink(originalDngPath).catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            log.warn('Failed to delete original DNG for preview attachment', { filePath: originalDngPath, error: err });
          }
        });
      }
      res.json({ ok: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
      res.status(500).json({ error: 'Failed to delete file' });
    }
  });

  router.post('/conversations/:id/attachments/ocr', csrfGuard, async (req: Request, res: Response) => {
    const convId = param(req, 'id');
    let attachmentPath: string;
    let requestedCliProfileId: string | undefined;
    let requestedBackend: string | undefined;
    try {
      ({
        path: attachmentPath,
        cliProfileId: requestedCliProfileId,
        backend: requestedBackend,
      } = validateAttachmentOcrRequest(req.body));
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    const convDir = path.resolve(path.join(chatService.artifactsDir, convId));
    const resolved = path.resolve(attachmentPath);
    if (resolved !== convDir && !resolved.startsWith(convDir + path.sep)) {
      return res.status(400).json({ error: 'Invalid attachment path' });
    }

    try {
      await fs.promises.access(resolved);
    } catch {
      return res.status(404).json({ error: 'Attachment not found' });
    }
    const meta = attachmentFromPath(resolved);
    if (meta.kind !== 'image') {
      return res.status(400).json({ error: 'OCR is only supported for image attachments' });
    }

    let conv = await chatService.getConversation(convId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    let recoveryMessage: Awaited<ReturnType<ChatService['addMessage']>> | null = null;
    try {
      if (requestedCliProfileId) {
        const profileOrProviderChanged = requestedCliProfileId !== conv.cliProfileId
          || (requestedBackend && requestedBackend !== conv.backend);
        if (profileOrProviderChanged) {
          const canRepairMissingProfile = conv.messages.length > 0
            ? await conversationHasMissingCliProfile(chatService, conv)
            : false;
          if (conv.messages.length > 0 && !canRepairMissingProfile) {
            return res.status(409).json({ error: 'Cannot switch CLI profile after the active session has messages' });
          }
          await chatService.updateConversationCliProfile(convId, requestedCliProfileId, requestedBackend || conv.backend);
          conv = (await chatService.getConversation(convId)) || conv;
          if (canRepairMissingProfile) {
            recoveryMessage = await chatService.addMessage(
              convId,
              'system',
              MISSING_CLI_PROFILE_RECOVERY_MESSAGE,
              conv.backend,
            );
            conv = (await chatService.getConversation(convId)) || conv;
          }
        }
      }
    } catch (err: unknown) {
      if (isCliProfileResolutionError(err)) {
        return res.status(400).json({ error: (err as Error).message });
      }
      throw err;
    }
    let runtime: Awaited<ReturnType<ChatService['resolveCliProfileRuntime']>>;
    try {
      runtime = await chatService.resolveCliProfileRuntime(conv.cliProfileId, conv.backend);
    } catch (err: unknown) {
      if (isCliProfileResolutionError(err)) {
        return res.status(400).json({ error: (err as Error).message });
      }
      throw err;
    }
    const backendId = runtime.backendId;
    if (requestedCliProfileId && requestedBackend && requestedBackend !== backendId) {
      return res.status(400).json({ error: `CLI profile backend ${backendId} does not match requested backend ${requestedBackend}` });
    }
    const adapter = backendRegistry.get(backendId);
    if (!adapter) {
      return res.status(500).json({ error: `Backend not registered: ${backendId}` });
    }
    const metadata = await adapter.getMetadata({ cliProfile: runtime.profile });
    const mediaCheck = checkOneShotMediaInput(metadata, conv.model || undefined, 'image');
    if (!mediaCheck.ok) {
      return res.status(400).json({ error: mediaCheck.message });
    }

    const prompt = [
      `Read the image at ${resolved} and convert its contents to clean Markdown.`,
      'Preserve structure — use headings for headings, lists for lists, and proper Markdown tables (| col | col | with a |---|---| separator) for any tabular data.',
      'If the image contains diagrams or non-text visuals you cannot transcribe, briefly note them in italics (e.g. *[diagram: network topology]*).',
      'Output only the Markdown. No preamble, no commentary, no fenced code wrapper around the whole thing.',
    ].join(' ');

    try {
      const markdown = await adapter.runOneShot(prompt, {
        model: conv.model || undefined,
        effort: conv.effort || undefined,
        timeoutMs: 90_000,
        allowTools: true,
        workingDir: conv.executionDir || conv.workingDir || undefined,
        cliProfile: runtime.profile,
        serviceTier: conv.serviceTier || undefined,
        attachments: [{ path: resolved, kind: 'image', name: meta.name }],
      });
      const cleaned = (markdown || '').trim();
      if (!cleaned) {
        return res.status(502).json({ error: 'OCR returned empty output' });
      }
      const body: AttachmentOcrResponse = { markdown: cleaned };
      if (recoveryMessage) body.recoveryMessage = recoveryMessage;
      res.json(body);
    } catch (err: unknown) {
      log.error('Attachment OCR failed', { backendId, convId, error: err });
      return res.status(502).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:workspaceId/files', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'workspaceId');
      const filePath = req.query.path as string | undefined;
      const mode = (req.query.mode as string) || 'download';

      if (!filePath) {
        return res.status(400).json({ error: 'path query parameter is required' });
      }

      const workspacePath = await chatService.getWorkspacePath(hash);
      if (!workspacePath) {
        return res.status(404).json({ error: 'Workspace not found' });
      }

      return serveScopedFile(res, workspacePath, filePath, mode);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/conversations/:id/workspace-file', async (req: Request, res: Response) => {
    try {
      const convId = param(req, 'id');
      const filePath = req.query.path as string | undefined;
      const mode = (req.query.mode as string) || 'download';

      if (!filePath) {
        return res.status(400).json({ error: 'path query parameter is required' });
      }

      const executionDir = await chatService.getConversationExecutionDir(convId);
      if (!executionDir) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      return serveScopedFile(res, executionDir, filePath, mode);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}

function serveScopedFile(res: Response, rootPath: string, filePath: string, mode: string) {
  const resolved = path.resolve(filePath);
  const root = path.resolve(rootPath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return res.status(403).json({ error: 'Access denied: path is outside workspace' });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return res.status(404).json({ error: 'File not found' });
  }
  if (!stat.isFile()) {
    return res.status(400).json({ error: 'Path is not a file' });
  }

  const filename = path.basename(resolved);

  if (mode === 'view') {
    if (stat.size > 2 * 1024 * 1024) {
      return res.status(413).json({ error: 'File too large to view (max 2 MB). Use download instead.' });
    }
    const content = fs.readFileSync(resolved, 'utf8');
    const ext = path.extname(filename).replace('.', '');
    return res.json({ content, filename, path: resolved, language: ext });
  }

  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '\\"')}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  return fs.createReadStream(resolved).pipe(res);
}
