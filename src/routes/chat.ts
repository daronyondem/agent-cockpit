import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import multer from 'multer';
import { csrfGuard } from '../middleware/csrf';
import type { ChatService } from '../services/chatService';
import type { BackendRegistry } from '../services/backends/registry';
import type { UpdateService } from '../services/updateService';
import type { Request, Response, ActiveStreamEntry, ToolActivity, StreamEvent, WsServerFrame } from '../types';
import type { WsFunctions } from '../ws';

/** Extract a named route param as a string (Express 5 types them as string | string[]). */
function param(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : val;
}

// ── Stream processing ────────────────────────────────────────────────────────

interface ProcessStreamDeps {
  chatService: ChatService;
}

/**
 * Processes a CLI stream, accumulating state and emitting typed frames.
 * Transport-agnostic: the caller provides `emit` (WS send)
 * and `isClosed` (checks if the connection is gone).
 */
export async function processStream(
  convId: string,
  entry: ActiveStreamEntry,
  emit: (frame: WsServerFrame) => void,
  isClosed: () => boolean,
  onDone: () => void,
  deps: ProcessStreamDeps,
): Promise<void> {
  const { chatService } = deps;
  const { stream, backend } = entry;

  let fullResponse = '';
  let thinkingText = '';
  let resultText: string | null = null;
  let hasStreamingDeltas = false;
  let pendingPlanContent = '';
  let titleUpdateTriggered = false;
  let titleUpdatePromise: Promise<void> | null = null;
  let toolActivityAccumulator: Array<{
    tool: string;
    description: string;
    id: string | null;
    isAgent?: boolean;
    subagentType?: string;
    parentAgentId?: string;
    outcome?: string;
    status?: string;
    startTime: number;
  }> = [];

  function computeToolDurations(activities: typeof toolActivityAccumulator): ToolActivity[] {
    if (!activities.length) return [];
    const now = Date.now();
    return activities.map((t, i) => {
      const nextStart = activities[i + 1]?.startTime || now;
      const duration = t.startTime ? nextStart - t.startTime : null;
      const toolEntry: ToolActivity = { tool: t.tool, description: t.description, id: t.id, duration, startTime: t.startTime };
      if (t.isAgent) { toolEntry.isAgent = true; toolEntry.subagentType = t.subagentType; }
      if (t.parentAgentId) { toolEntry.parentAgentId = t.parentAgentId; }
      if (t.outcome) { toolEntry.outcome = t.outcome; }
      if (t.status) { toolEntry.status = t.status; }
      return toolEntry;
    });
  }

  function maybeUpdateTitle() {
    if (titleUpdateTriggered || !entry.needsTitleUpdate || !entry.titleUpdateMessage) return;
    titleUpdateTriggered = true;
    titleUpdatePromise = chatService.generateAndUpdateTitle(convId, entry.titleUpdateMessage)
      .then((newTitle) => {
        if (newTitle && !isClosed()) {
          console.log(`[chat] Title updated for conv=${convId}: ${newTitle}`);
          emit({ type: 'title_updated', title: newTitle });
        }
      })
      .catch((err: Error) => {
        console.error(`[chat] Failed to update title for conv=${convId}:`, err.message);
      });
  }

  try {
    for await (const event of stream) {
      if (isClosed()) break;

      if (event.type === 'text') {
        fullResponse += event.content;
        if (event.streaming) {
          hasStreamingDeltas = true;
          emit({ type: 'text', content: event.content });
        }
      } else if (event.type === 'thinking') {
        thinkingText += event.content;
        if (event.streaming) {
          emit({ type: 'thinking', content: event.content });
        }
      } else if (event.type === 'tool_outcomes') {
        for (const outcome of (event.outcomes || [])) {
          const match = toolActivityAccumulator.find(t => t.id === outcome.toolUseId);
          if (match) {
            match.outcome = outcome.outcome || undefined;
            match.status = outcome.status || undefined;
          }
        }
        emit({ type: 'tool_outcomes', outcomes: event.outcomes });
      } else if (event.type === 'turn_boundary') {
        const turnToolActivity = computeToolDurations(toolActivityAccumulator);
        if (hasStreamingDeltas && fullResponse.trim()) {
          console.log(`[chat] Saving intermediate message for conv=${convId}, len=${fullResponse.trim().length}, tools=${turnToolActivity.length}`);
          const intermediateMsg = await chatService.addMessage(convId, 'assistant', fullResponse.trim(), backend, thinkingText.trim() || null, turnToolActivity.length > 0 ? turnToolActivity : undefined);
          if (intermediateMsg) emit({ type: 'assistant_message', message: intermediateMsg });
          maybeUpdateTitle();
        }
        emit({ type: 'turn_complete' });
        fullResponse = '';
        thinkingText = '';
        hasStreamingDeltas = false;
        toolActivityAccumulator = [];
      } else if (event.type === 'tool_activity') {
        if (event.isPlanFile && event.planContent) {
          pendingPlanContent = event.planContent;
        }
        const { type: _t, planContent: _pc, ...rest } = event;
        const restAny = rest as Record<string, unknown>;
        if (restAny.isPlanMode && restAny.planAction === 'exit' && pendingPlanContent) {
          restAny.planContent = pendingPlanContent;
        }
        if (restAny.isAgent && restAny.id) {
          console.log(`[chat] AGENT ${restAny.id} parentAgentId=${restAny.parentAgentId || 'none'}`);
        }
        emit({ type: 'tool_activity', ...rest } as WsServerFrame);
        if (!event.isPlanMode && !event.isQuestion) {
          toolActivityAccumulator.push({
            tool: rest.tool,
            description: rest.description || '',
            id: rest.id || null,
            isAgent: rest.isAgent || undefined,
            subagentType: rest.subagentType || undefined,
            parentAgentId: rest.parentAgentId || undefined,
            startTime: Date.now(),
          });
        }
      } else if (event.type === 'result') {
        resultText = event.content;
      } else if (event.type === 'usage') {
        const updated = await chatService.addUsage(convId, event.usage, backend, event.model);
        if (!isClosed()) {
          emit({ type: 'usage', usage: updated?.conversationUsage || event.usage, sessionUsage: updated?.sessionUsage });
        }
      } else if (event.type === 'error') {
        console.error(`[chat] Stream error for conv=${convId}:`, event.error);
        emit({ type: 'error', error: event.error });
      } else if (event.type === 'done') {
        const apiErrPattern = /^API Error:\s*\d{3}\s/;
        const finalToolActivity = computeToolDurations(toolActivityAccumulator);
        const finalToolActivityArg = finalToolActivity.length > 0 ? finalToolActivity : undefined;
        if (hasStreamingDeltas && fullResponse.trim()) {
          if (apiErrPattern.test(fullResponse.trim())) {
            console.log(`[chat] Stream done for conv=${convId}, detected API error in text — not saving as message`);
            emit({ type: 'error', error: fullResponse.trim() });
          } else {
            console.log(`[chat] Stream done for conv=${convId}, saving final segment len=${fullResponse.trim().length}, tools=${finalToolActivity.length}`);
            const assistantMsg = await chatService.addMessage(convId, 'assistant', fullResponse.trim(), backend, thinkingText.trim() || null, finalToolActivityArg);
            if (assistantMsg) emit({ type: 'assistant_message', message: assistantMsg });
            maybeUpdateTitle();
          }
        } else if (resultText && resultText.trim()) {
          console.log(`[chat] Stream done for conv=${convId}, saving result len=${resultText.trim().length}, tools=${finalToolActivity.length}`);
          const assistantMsg = await chatService.addMessage(convId, 'assistant', resultText.trim(), backend, thinkingText.trim() || null, finalToolActivityArg);
          if (assistantMsg) emit({ type: 'assistant_message', message: assistantMsg });
          maybeUpdateTitle();
        } else {
          console.log(`[chat] Stream done for conv=${convId}, no content to save`);
        }
        toolActivityAccumulator = [];
        if (titleUpdatePromise) await titleUpdatePromise;
        emit({ type: 'done' });
      }
    }
  } catch (err: unknown) {
    console.error(`[chat] Stream exception for conv=${convId}:`, err);
    if (!isClosed()) {
      emit({ type: 'error', error: (err as Error).message });
      emit({ type: 'done' });
    }
  } finally {
    onDone();
  }
}

// ── Router ──────────────────────────────────────────────────────────────────

interface ChatRouterDeps {
  chatService: ChatService;
  backendRegistry: BackendRegistry;
  updateService: UpdateService;
}

export function createChatRouter({ chatService, backendRegistry, updateService }: ChatRouterDeps) {
  const router = express.Router();
  const packageJson = require('../../package.json');

  const activeStreams = new Map<string, ActiveStreamEntry>();
  let wsFns: Pick<WsFunctions, 'send' | 'isConnected' | 'isStreamAlive' | 'clearBuffer'> | null = null;

  // ── Available backends ──────────────────────────────────────────────────────
  router.get('/backends', (_req: Request, res: Response) => {
    res.json({ backends: backendRegistry.list() });
  });

  // ── Version ─────────────────────────────────────────────────────────────────
  router.get('/version', (_req: Request, res: Response) => {
    const status = updateService ? updateService.getStatus() : {} as Record<string, unknown>;
    res.json({
      version: packageJson.version,
      remoteVersion: (status as ReturnType<UpdateService['getStatus']>).remoteVersion || null,
      updateAvailable: (status as ReturnType<UpdateService['getStatus']>).updateAvailable || false,
    });
  });

  // ── Update status ──────────────────────────────────────────────────────────
  router.get('/update-status', (_req: Request, res: Response) => {
    if (!updateService) return res.json({ updateAvailable: false });
    res.json(updateService.getStatus());
  });

  // ── Manual version check ────────────────────────────────────────────────────
  router.post('/check-version', csrfGuard, async (_req: Request, res: Response) => {
    if (!updateService) return res.status(501).json({ error: 'Update service not available' });
    try {
      const status = await updateService.checkNow();
      res.json(status);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Trigger update ─────────────────────────────────────────────────────────
  router.post('/update-trigger', csrfGuard, async (_req: Request, res: Response) => {
    if (!updateService) return res.status(501).json({ error: 'Update service not available' });
    try {
      const result = await updateService.triggerUpdate({
        hasActiveStreams: () => activeStreams.size > 0,
      });
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Browse directories ─────────────────────────────────────────────────────
  router.get('/browse', (req: Request, res: Response) => {
    try {
      const dirPath = (req.query.path as string) || os.homedir();
      const showHidden = req.query.showHidden === 'true';

      const resolved = path.resolve(dirPath);
      if (!fs.existsSync(resolved)) {
        return res.status(400).json({ error: 'Path does not exist' });
      }
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(resolved, { withFileTypes: true });
      } catch {
        return res.status(403).json({ error: 'Permission denied: ' + resolved });
      }
      let dirs: string[] = [];
      for (const e of entries) {
        try {
          if (e.isDirectory()) dirs.push(e.name);
        } catch { /* skip entries that can't be stat'd */ }
      }
      dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      if (!showHidden) {
        dirs = dirs.filter(d => !d.startsWith('.'));
      }

      const parent = path.dirname(resolved);
      res.json({
        currentPath: resolved,
        parent: parent !== resolved ? parent : null,
        dirs,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Create directory ───────────────────────────────────────────────────────
  router.post('/mkdir', csrfGuard, (req: Request, res: Response) => {
    try {
      const { parentPath, name } = req.body as { parentPath?: string; name?: string };
      if (!parentPath || !name) {
        return res.status(400).json({ error: 'parentPath and name are required' });
      }
      if (/[/\\]/.test(name) || name === '.' || name === '..') {
        return res.status(400).json({ error: 'Invalid folder name' });
      }
      const parent = path.resolve(parentPath);
      const fullPath = path.resolve(parent, name);
      if (path.dirname(fullPath) !== parent) {
        return res.status(400).json({ error: 'Invalid folder name' });
      }
      if (fs.existsSync(fullPath)) {
        return res.status(409).json({ error: 'Folder already exists' });
      }
      try {
        fs.mkdirSync(fullPath);
      } catch {
        return res.status(403).json({ error: 'Permission denied' });
      }
      res.json({ created: fullPath });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Delete directory ────────────────────────────────────────────────────────
  router.post('/rmdir', csrfGuard, (req: Request, res: Response) => {
    try {
      const { dirPath } = req.body as { dirPath?: string };
      if (!dirPath) {
        return res.status(400).json({ error: 'dirPath is required' });
      }
      const resolved = path.resolve(dirPath);
      const parent = path.dirname(resolved);
      if (parent === resolved) {
        return res.status(400).json({ error: 'Cannot delete filesystem root' });
      }
      if (!fs.existsSync(resolved)) {
        return res.status(404).json({ error: 'Folder does not exist' });
      }
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }
      try {
        fs.rmSync(resolved, { recursive: true, force: true });
      } catch {
        return res.status(403).json({ error: 'Permission denied' });
      }
      res.json({ deleted: resolved, parent });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── List conversations ─────────────────────────────────────────────────────
  router.get('/conversations', async (req: Request, res: Response) => {
    try {
      const q = (req.query.q as string) || '';
      const archived = req.query.archived === 'true';
      const opts = { archived };
      const convs = q ? await chatService.searchConversations(q, opts) : await chatService.listConversations(opts);
      res.json({ conversations: convs });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Get single conversation ────────────────────────────────────────────────
  router.get('/conversations/:id', async (req: Request, res: Response) => {
    try {
      const conv = await chatService.getConversation(param(req, 'id'));
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
      res.json(conv);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Create conversation ────────────────────────────────────────────────────
  router.post('/conversations', csrfGuard, async (req: Request, res: Response) => {
    try {
      const conv = await chatService.createConversation(req.body.title, req.body.workingDir, req.body.backend);
      res.json(conv);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Rename conversation ────────────────────────────────────────────────────
  router.put('/conversations/:id', csrfGuard, async (req: Request, res: Response) => {
    try {
      const conv = await chatService.renameConversation(param(req, 'id'), req.body.title);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
      res.json(conv);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Delete conversation ────────────────────────────────────────────────────
  router.delete('/conversations/:id', csrfGuard, async (req: Request, res: Response) => {
    try {
      const entry = activeStreams.get(param(req, 'id'));
      if (entry) {
        entry.abort();
        activeStreams.delete(param(req, 'id'));
      }
      const ok = await chatService.deleteConversation(param(req, 'id'));
      if (!ok) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Archive conversation ───────────────────────────────────────────────────
  router.patch('/conversations/:id/archive', csrfGuard, async (req: Request, res: Response) => {
    try {
      const entry = activeStreams.get(param(req, 'id'));
      if (entry) {
        entry.abort();
        activeStreams.delete(param(req, 'id'));
      }
      const ok = await chatService.archiveConversation(param(req, 'id'));
      if (!ok) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Restore conversation ──────────────────────────────────────────────────
  router.patch('/conversations/:id/restore', csrfGuard, async (req: Request, res: Response) => {
    try {
      const ok = await chatService.restoreConversation(param(req, 'id'));
      if (!ok) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Message queue persistence ──────────────────────────────────────────────
  router.get('/conversations/:id/queue', async (req: Request, res: Response) => {
    try {
      const queue = await chatService.getQueue(param(req, 'id'));
      res.json({ queue });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/conversations/:id/queue', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { queue } = req.body as { queue?: string[] };
      if (!Array.isArray(queue) || !queue.every(item => typeof item === 'string')) {
        return res.status(400).json({ error: 'queue must be an array of strings' });
      }
      const ok = await chatService.setQueue(param(req, 'id'), queue);
      if (!ok) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/conversations/:id/queue', csrfGuard, async (req: Request, res: Response) => {
    try {
      const ok = await chatService.clearQueue(param(req, 'id'));
      if (!ok) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Download conversation as markdown ──────────────────────────────────────
  router.get('/conversations/:id/download', async (req: Request, res: Response) => {
    try {
      const md = await chatService.conversationToMarkdown(param(req, 'id'));
      if (!md) return res.status(404).json({ error: 'Conversation not found' });
      const conv = await chatService.getConversation(param(req, 'id'));
      const filename = (conv!.title || 'conversation').replace(/[^a-zA-Z0-9-_ ]/g, '').substring(0, 50).trim() + '.md';
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(md);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Download session as markdown ────────────────────────────────────────────
  router.get('/conversations/:id/sessions/:num/download', async (req: Request, res: Response) => {
    try {
      const sessionNumber = Number(param(req, 'num'));
      const md = await chatService.sessionToMarkdown(param(req, 'id'), sessionNumber);
      if (!md) return res.status(404).json({ error: 'Session not found' });
      const conv = await chatService.getConversation(param(req, 'id'));
      const title = (conv!.title || 'conversation').replace(/[^a-zA-Z0-9-_ ]/g, '').substring(0, 50).trim();
      const filename = `${title}-session-${sessionNumber}.md`;
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(md);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Session history ────────────────────────────────────────────────────────
  router.get('/conversations/:id/sessions', async (req: Request, res: Response) => {
    try {
      const sessions = await chatService.getSessionHistory(param(req, 'id'));
      if (!sessions) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ sessions });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Get session messages ───────────────────────────────────────────────────
  router.get('/conversations/:id/sessions/:num/messages', async (req: Request, res: Response) => {
    try {
      const sessionNumber = Number(param(req, 'num'));
      if (!sessionNumber || sessionNumber < 1) {
        return res.status(400).json({ error: 'Invalid session number' });
      }
      const messages = await chatService.getSessionMessages(param(req, 'id'), sessionNumber);
      if (!messages) return res.status(404).json({ error: 'Session not found' });
      res.json({ messages });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Reset session ──────────────────────────────────────────────────────────
  router.post('/conversations/:id/reset', csrfGuard, async (req: Request, res: Response) => {
    try {
      const convId = param(req, 'id');
      if (activeStreams.has(convId)) {
        return res.status(409).json({ error: 'Cannot reset session while streaming' });
      }
      // Clear any stale event buffer so a subsequent WS connection
      // doesn't replay old-session events into the new session.
      if (wsFns) wsFns.clearBuffer(convId);
      const result = await chatService.resetSession(convId);
      if (!result) return res.status(404).json({ error: 'Conversation not found' });
      // Let the backend adapter clean up per-conversation state (e.g. ACP processes)
      const conv = await chatService.getConversation(convId);
      if (conv) {
        const adapter = backendRegistry.get(conv.backend);
        if (adapter) adapter.onSessionReset(convId);
      }
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Send message + stream response ────────────────────────────────────────
  router.post('/conversations/:id/message', csrfGuard, async (req: Request, res: Response) => {
    const convId = param(req, 'id');
    const { content, backend } = req.body as { content?: string; backend?: string };

    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'Message content required' });
    }

    const conv = await chatService.getConversation(convId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    if (backend && backend !== conv.backend) {
      await chatService.updateConversationBackend(convId, backend);
    }

    const userMsg = await chatService.addMessage(convId, 'user', content.trim(), backend || conv.backend);

    const isNewSession = conv.messages.length === 0;

    let cliMessage = content.trim();
    if (isNewSession) {
      const ctx = chatService.getWorkspaceContext(convId);
      if (ctx) cliMessage = ctx + '\n\n' + cliMessage;
    }

    let systemPrompt = '';
    if (isNewSession) {
      const settings = await chatService.getSettings();
      const globalPrompt = settings.systemPrompt || '';
      const wsHash = chatService.getWorkspaceHashForConv(convId);
      const wsInstructions = wsHash ? (await chatService.getWorkspaceInstructions(wsHash)) || '' : '';
      const parts = [globalPrompt, wsInstructions].filter(Boolean);
      systemPrompt = parts.join('\n\n');
    }

    const backendId = backend || conv.backend;
    const adapter = backendRegistry.get(backendId);
    if (!adapter) {
      return res.status(400).json({ error: `Unknown backend: ${backendId}` });
    }

    console.log(`[chat] Starting CLI stream for conv=${convId} session=${conv.currentSessionId} isNew=${isNewSession} backend=${backendId} workingDir=${conv.workingDir || 'default'}`);
    const { stream, abort, sendInput } = adapter.sendMessage(cliMessage, {
      sessionId: conv.currentSessionId,
      conversationId: convId,
      isNewSession,
      workingDir: conv.workingDir || null,
      systemPrompt,
      externalSessionId: conv.externalSessionId || null,
    });
    const needsTitleUpdate = isNewSession && conv.sessionNumber > 1;
    activeStreams.set(convId, { stream, abort, sendInput, backend: backendId, needsTitleUpdate, titleUpdateMessage: needsTitleUpdate ? content.trim() : null });

    // If a WebSocket is connected for this conversation, pipe the stream to it
    if (wsFns && wsFns.isConnected(convId)) {
      wsFns.clearBuffer(convId); // Fresh buffer for the new stream
      processStream(
        convId,
        activeStreams.get(convId)!,
        (frame) => { wsFns!.send(convId, frame); },
        () => !wsFns!.isStreamAlive(convId),
        () => { activeStreams.delete(convId); },
        { chatService },
      ).catch((err) => {
        console.error(`[chat] WS stream error for conv=${convId}:`, err);
        if (wsFns) {
          wsFns.send(convId, { type: 'error', error: (err as Error).message });
          wsFns.send(convId, { type: 'done' });
        }
        activeStreams.delete(convId);
      });
    }

    res.json({ userMessage: userMsg, streamReady: true });
  });

  // ── File upload ─────────────────────────────────────────────────────────────
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
      }
    }),
    limits: { fileSize: 50 * 1024 * 1024 }
  });

  router.post('/conversations/:id/upload', csrfGuard, upload.array('files', 10), (req: Request, res: Response) => {
    const files = ((req as unknown as { files?: Express.Multer.File[] }).files || []).map((f) => ({
      name: f.originalname,
      path: f.path,
      size: f.size,
    }));
    res.json({ files });
  });

  // Serve uploaded files
  router.get('/conversations/:id/files/:filename', async (req: Request, res: Response) => {
    const safe = param(req, 'filename').replace(/[\/\\]/g, '_');
    const filePath = path.join(chatService.artifactsDir, param(req, 'id'), safe);
    if (!path.resolve(filePath).startsWith(path.resolve(chatService.artifactsDir))) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    try {
      await fs.promises.access(filePath);
      res.sendFile(path.resolve(filePath));
    } catch {
      res.status(404).json({ error: 'File not found' });
    }
  });

  router.delete('/conversations/:id/upload/:filename', csrfGuard, async (req: Request, res: Response) => {
    const safe = param(req, 'filename').replace(/[\/\\]/g, '_');
    const filePath = path.join(chatService.artifactsDir, param(req, 'id'), safe);
    if (!path.resolve(filePath).startsWith(path.resolve(chatService.artifactsDir))) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    try {
      await fs.promises.unlink(filePath);
      res.json({ ok: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
      res.status(500).json({ error: 'Failed to delete file' });
    }
  });

  // ── Workspace instructions ──────────────────────────────────────────────────
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

  // ── Usage Stats ────────────────────────────────────────────────────────────
  router.get('/usage-stats', async (_req: Request, res: Response) => {
    try {
      const ledger = await chatService.getUsageStats();
      res.json(ledger);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/usage-stats', csrfGuard, async (_req: Request, res: Response) => {
    try {
      await chatService.clearUsageStats();
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Settings ───────────────────────────────────────────────────────────────
  router.get('/settings', async (_req: Request, res: Response) => {
    try {
      res.json(await chatService.getSettings());
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/settings', csrfGuard, async (req: Request, res: Response) => {
    try {
      const settings = await chatService.saveSettings(req.body);
      res.json(settings);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Shutdown helper ────────────────────────────────────────────────────────
  function shutdown() {
    for (const [convId, entry] of activeStreams) {
      console.log(`[shutdown] Aborting active stream for conv=${convId}`);
      entry.abort();
    }
    activeStreams.clear();
    if (updateService) updateService.stop();
  }

  function setWsFunctions(fns: Pick<WsFunctions, 'send' | 'isConnected' | 'isStreamAlive' | 'clearBuffer'>) {
    wsFns = fns;
  }

  return { router, shutdown, activeStreams, setWsFunctions };
}
