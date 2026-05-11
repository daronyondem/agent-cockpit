import express from 'express';
import { csrfGuard } from '../../middleware/csrf';
import type { ChatService } from '../../services/chatService';
import type { Request, Response } from '../../types';
import { param } from './routeUtils';

export function createWorkspaceInstructionRouter(chatService: ChatService): express.Router {
  const router = express.Router();

  router.get('/workspaces/:hash/instructions', async (req: Request, res: Response) => {
    try {
      const instructions = await chatService.getWorkspaceInstructions(param(req, 'hash'));
      if (instructions === null) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ instructions });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:hash/instructions', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { instructions } = req.body as { instructions?: string };
      if (typeof instructions !== 'string') {
        return res.status(400).json({ error: 'instructions must be a string' });
      }
      const result = await chatService.setWorkspaceInstructions(param(req, 'hash'), instructions);
      if (result === null) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ instructions: result });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:hash/instruction-compatibility', async (req: Request, res: Response) => {
    try {
      const status = await chatService.getWorkspaceInstructionCompatibility(param(req, 'hash'));
      if (!status) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ status });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/instruction-compatibility/pointers', csrfGuard, async (req: Request, res: Response) => {
    try {
      const result = await chatService.createWorkspaceInstructionPointers(param(req, 'hash'));
      if (!result) return res.status(404).json({ error: 'Workspace not found' });
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:hash/instruction-compatibility/dismissal', csrfGuard, async (req: Request, res: Response) => {
    try {
      const status = await chatService.dismissWorkspaceInstructionCompatibility(param(req, 'hash'));
      if (!status) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ status });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
