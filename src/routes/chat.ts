import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import multer from 'multer';
import { csrfGuard } from '../middleware/csrf';
import type { ChatService } from '../services/chatService';
import type { BackendRegistry } from '../services/backends/registry';
import type { UpdateService } from '../services/updateService';
import { MemoryWatcher } from '../services/memoryWatcher';
import { createMemoryMcpServer, type MemoryMcpServer } from '../services/memoryMcp';
import { detectLibreOffice } from '../services/knowledgeBase/libreOffice';
import { detectPandoc } from '../services/knowledgeBase/pandoc';
import {
  KbIngestionService,
  KbDisabledError,
  KbLocationConflictError,
  KbValidationError,
} from '../services/knowledgeBase/ingestion';
import {
  KbDigestionService,
  KbDigestDisabledError,
} from '../services/knowledgeBase/digest';
import { KbDreamService } from '../services/knowledgeBase/dream';
import { checkOllamaHealth } from '../services/knowledgeBase/embeddings';
import { createKbSearchMcpServer } from '../services/kbSearchMcp';
import type { Request, Response, NextFunction, ActiveStreamEntry, ToolActivity, StreamEvent, WsServerFrame, EffortLevel } from '../types';
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
        const skipLedger = backend === 'kiro';
        const updated = await chatService.addUsage(convId, event.usage, backend, event.model, { skipLedger });
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
  const memoryWatcher = new MemoryWatcher();
  // Per-conversation map of last-known memory file fingerprints (filename → sha-ish)
  // used by the watcher to compute `changedFiles` for the `memory_update` WS frame.
  // Cleared when the watcher is unwatched so a re-watched conversation starts fresh.
  const memoryFingerprints = new Map<string, Map<string, string>>();
  let wsFns: Pick<WsFunctions, 'send' | 'isConnected' | 'isStreamAlive' | 'clearBuffer'> | null = null;

  /**
   * Fan out a `kb_state_update` frame to every active stream whose
   * conversation belongs to the target workspace. Mirrors the pattern
   * used for `memory_update` — only conversations with a live WS get
   * the frame; the KB Browser polls GET /kb when it's opened standalone
   * (no active stream) so it still sees changes.
   */
  function broadcastKbStateUpdate(hash: string, frame: import('../types').KbStateUpdateEvent): void {
    if (!wsFns) return;
    for (const [convId] of activeStreams) {
      if (chatService.getWorkspaceHashForConv(convId) === hash && wsFns.isConnected(convId)) {
        wsFns.send(convId, frame);
      }
    }
  }

  // Knowledge Base ingestion orchestrator. Owns the per-workspace queue
  // that runs format handlers (pdf/docx/pptx/passthrough) and emits
  // `kb_state_update` frames when the DB changes.
  const kbIngestion = new KbIngestionService({
    chatService,
    emit: broadcastKbStateUpdate,
  });

  // Knowledge Base digestion orchestrator. Runs the configured Digestion
  // CLI in `runOneShot` mode against each raw file's converted text and
  // writes the resulting entries back into the DB + `entries/` tree.
  const kbDigestion = new KbDigestionService({
    chatService,
    backendRegistry,
    emit: broadcastKbStateUpdate,
  });
  // Late-bind the circular ingestion ↔ digestion dependency so that
  // files auto-digest on ingestion completion when the workspace has
  // `kbAutoDigest=true`.
  kbIngestion.setDigestTrigger(kbDigestion);

  // Knowledge Base dreaming orchestrator. Runs the configured Dreaming
  // CLI to synthesize entries into a knowledge graph of topics and
  // connections. Manual-only — triggered via POST /kb/dream or /kb/redream.
  // KB Search MCP server — exposes search and ingestion tools to CLIs
  // during both dreaming and conversation sessions.
  const kbSearchMcp = createKbSearchMcpServer({ chatService, kbIngestion });
  router.use('/mcp', kbSearchMcp.router);

  const kbDreaming = new KbDreamService({
    chatService,
    backendRegistry,
    emit: broadcastKbStateUpdate,
    kbSearchMcp,
  });

  // Memory MCP server — exposes `memory_note` tool to non-Claude CLIs via the
  // stdio stub in `src/services/memoryMcp/stub.cjs`.  The router is mounted
  // at `/mcp/memory/notes` below; the `issue`/`revoke` helpers are used by
  // the Kiro backend wiring to hand out per-session bearer tokens.
  const memoryMcp: MemoryMcpServer = createMemoryMcpServer({
    chatService,
    backendRegistry,
    getWsFns: () => wsFns,
  });
  router.use('/mcp', memoryMcp.router);

  function fingerprintMemoryFiles(snapshot: { files: Array<{ filename: string; content: string }> }): Map<string, string> {
    const fp = new Map<string, string>();
    for (const f of snapshot.files) {
      // Cheap content fingerprint: length + first 32 chars hash via djb2.
      // Good enough to detect edits without pulling in crypto.
      let hash = 5381;
      const sample = f.content.slice(0, 256);
      for (let i = 0; i < sample.length; i++) hash = ((hash << 5) + hash) ^ sample.charCodeAt(i);
      fp.set(f.filename, `${f.content.length}:${(hash >>> 0).toString(36)}`);
    }
    return fp;
  }

  function diffFingerprints(prev: Map<string, string> | undefined, next: Map<string, string>): string[] {
    const changed: string[] = [];
    for (const [filename, fp] of next) {
      if (!prev || prev.get(filename) !== fp) changed.push(filename);
    }
    return changed;
  }

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

  // ── Server restart ─────────────────────────────────────────────────────────
  // Plain pm2 restart without the git pull/npm install steps of /update-trigger.
  // Used by the "Restart Server" button in Global Settings so users can
  // re-trigger startup-time detection (e.g. pandoc) after installing something
  // externally. Guards against active streams the same way update-trigger does.
  router.post('/server/restart', csrfGuard, async (_req: Request, res: Response) => {
    if (!updateService) return res.status(501).json({ error: 'Update service not available' });
    try {
      const result = await updateService.restart({
        hasActiveStreams: () => activeStreams.size > 0,
      });
      if (result.success) {
        res.json(result);
      } else {
        res.status(409).json(result);
      }
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

      // Augment with KB status so the frontend can render the dreaming
      // banner without a separate round-trip to GET /kb.
      const kbEnabled = await chatService.getWorkspaceKbEnabled(conv.workspaceHash);
      if (kbEnabled) {
        const db = chatService.getKbDb(conv.workspaceHash);
        if (db) {
          const snapshot = db.getSynthesisSnapshot();
          const counters = db.getCounters();
          (conv as unknown as Record<string, unknown>).kb = {
            enabled: true,
            dreamingNeeded: snapshot.needsSynthesisCount > 0,
            pendingEntries: snapshot.needsSynthesisCount,
            dreamingStatus: kbDreaming.isRunning(conv.workspaceHash) ? 'running' : snapshot.status,
            failedItems: counters.rawByStatus.failed,
          };
        }
      }

      res.json(conv);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Create conversation ────────────────────────────────────────────────────
  router.post('/conversations', csrfGuard, async (req: Request, res: Response) => {
    try {
      const conv = await chatService.createConversation(
        req.body.title,
        req.body.workingDir,
        req.body.backend,
        req.body.model,
        req.body.effort,
      );
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
      const convId = param(req, 'id');
      const entry = activeStreams.get(convId);
      if (entry) {
        entry.abort();
        activeStreams.delete(convId);
      }
      memoryWatcher.unwatch(convId);
      memoryFingerprints.delete(convId);
      memoryMcp.revokeMemoryMcpSession(convId);
      kbSearchMcp.revokeKbSearchSession(convId);
      const ok = await chatService.deleteConversation(convId);
      if (!ok) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Archive conversation ───────────────────────────────────────────────────
  router.patch('/conversations/:id/archive', csrfGuard, async (req: Request, res: Response) => {
    try {
      const convId = param(req, 'id');
      const entry = activeStreams.get(convId);
      if (entry) {
        entry.abort();
        activeStreams.delete(convId);
      }
      memoryWatcher.unwatch(convId);
      memoryFingerprints.delete(convId);
      const ok = await chatService.archiveConversation(convId);
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
      // Capture the current backend BEFORE resetting the session, so
      // memory is extracted from whichever CLI the ending session used.
      const preConv = await chatService.getConversation(convId);
      const endingBackend = preConv?.backend || null;

      // Clear any stale event buffer so a subsequent WS connection
      // doesn't replay old-session events into the new session.
      if (wsFns) wsFns.clearBuffer(convId);
      const result = await chatService.resetSession(convId);
      if (!result) return res.status(404).json({ error: 'Conversation not found' });

      // Capture the ending backend's native memory into workspace storage
      // so it can be injected into the next session (including when the
      // user switches CLIs). Runs best-effort — failures never block reset.
      // Gated on the per-workspace Memory toggle: when Memory is disabled,
      // we do nothing, and the workspace memory store stays inert.
      const resetWsHash = chatService.getWorkspaceHashForConv(convId);
      const memoryOnForReset = resetWsHash
        ? await chatService.getWorkspaceMemoryEnabled(resetWsHash)
        : false;
      if (endingBackend && memoryOnForReset) {
        console.log(`[memory] reset handler: attempting capture for conv=${convId} backend=${endingBackend}`);
        try {
          const snapshot = await chatService.captureWorkspaceMemory(convId, endingBackend);
          if (snapshot) {
            console.log(`[memory] captured ${snapshot.files.length} memory file(s) for conv=${convId} backend=${endingBackend}`);
          } else {
            console.log(`[memory] reset handler: no memory captured for conv=${convId} backend=${endingBackend}`);
          }
        } catch (err: unknown) {
          console.error(`[memory] capture on reset failed for conv=${convId}:`, (err as Error).message);
        }

        // Also run post-session extraction for every backend: the Memory
        // CLI scans the just-ended session transcript and writes any new
        // memory notes into `files/notes/` via addMemoryNoteEntry. This
        // runs for Claude Code too — its native `#` capture covers
        // explicitly-saved memories but misses incidental durable facts
        // (user role, deadlines, corrections) mentioned conversationally.
        if (resetWsHash && preConv?.messages?.length) {
          console.log(`[memory] reset handler: running post-session extraction for conv=${convId} backend=${endingBackend}`);
          try {
            const savedCount = await memoryMcp.extractMemoryFromSession({
              workspaceHash: resetWsHash,
              conversationId: convId,
              messages: preConv.messages.map((m) => ({ role: m.role, content: m.content })),
            });
            if (savedCount > 0) {
              console.log(`[memory] post-session extraction saved ${savedCount} entry(ies) for conv=${convId}`);
            }
          } catch (err: unknown) {
            console.error(`[memory] post-session extraction failed for conv=${convId}:`, (err as Error).message);
          }
        }
      } else if (!endingBackend) {
        console.log(`[memory] reset handler: no ending backend for conv=${convId}, skipping capture`);
      } else {
        console.log(`[memory] reset handler: memory disabled for conv=${convId}, skipping capture`);
      }

      // Let the backend adapter clean up per-conversation state (e.g. ACP processes)
      const conv = await chatService.getConversation(convId);
      if (conv) {
        const adapter = backendRegistry.get(conv.backend);
        if (adapter) adapter.onSessionReset(convId);
      }

      // Revoke any Memory / KB Search MCP tokens issued for this
      // conversation — new ones will be minted on the next message send.
      memoryMcp.revokeMemoryMcpSession(convId);
      kbSearchMcp.revokeKbSearchSession(convId);

      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Send message + stream response ────────────────────────────────────────
  router.post('/conversations/:id/message', csrfGuard, async (req: Request, res: Response) => {
    const convId = param(req, 'id');
    const { content, backend, model, effort } = req.body as {
      content?: string;
      backend?: string;
      model?: string;
      effort?: EffortLevel;
    };

    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'Message content required' });
    }

    const conv = await chatService.getConversation(convId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    if (backend && backend !== conv.backend) {
      await chatService.updateConversationBackend(convId, backend);
    }
    if (model !== undefined && model !== (conv.model || undefined)) {
      await chatService.updateConversationModel(convId, model || null);
    }
    if (effort !== undefined && effort !== (conv.effort || undefined)) {
      await chatService.updateConversationEffort(convId, effort || null);
    }

    const userMsg = await chatService.addMessage(convId, 'user', content.trim(), backend || conv.backend);

    const isNewSession = conv.messages.length === 0;

    const backendId = backend || conv.backend;
    const wsHashForSend = chatService.getWorkspaceHashForConv(convId);
    const memoryEnabledForSend = wsHashForSend
      ? await chatService.getWorkspaceMemoryEnabled(wsHashForSend)
      : false;
    // All memory-enabled sessions get the Memory MCP stub so they can
    // persist notes via `memory_note`. Kiro spawns it over ACP's
    // `mcpServers`; Claude Code spawns it via `--mcp-config`.
    const needsMemoryMcp = memoryEnabledForSend && !!wsHashForSend;
    const kbEnabledForSend = wsHashForSend
      ? await chatService.getWorkspaceKbEnabled(wsHashForSend)
      : false;
    const needsKbMcp = kbEnabledForSend && !!wsHashForSend;

    let cliMessage = content.trim();
    if (isNewSession) {
      // Build the user-message prefix: workspace discussion history
      // pointer, then workspace memory pointer (read-side access to the
      // merged memory store), then workspace KB pointer (read-side
      // access to the knowledge pipeline state and entries). All live
      // in the user message — not the system prompt — so they survive
      // `--resume` via the CLI's own conversation history on subsequent
      // turns.
      const prefixes: string[] = [];
      const ctx = chatService.getWorkspaceContext(convId);
      if (ctx) prefixes.push(ctx);
      if (wsHashForSend) {
        const memPointer = await chatService.getWorkspaceMemoryPointer(wsHashForSend);
        if (memPointer) prefixes.push(memPointer);
        const kbPointer = await chatService.getWorkspaceKbPointer(wsHashForSend);
        if (kbPointer) prefixes.push(kbPointer);
      }
      if (prefixes.length > 0) {
        cliMessage = prefixes.join('\n\n') + '\n\n' + cliMessage;
      }
    }

    let systemPrompt = '';
    if (isNewSession) {
      const settings = await chatService.getSettings();
      const globalPrompt = settings.systemPrompt || '';
      const wsInstructions = wsHashForSend ? (await chatService.getWorkspaceInstructions(wsHashForSend)) || '' : '';
      // Append an addendum that teaches the CLI to call the `memory_note`
      // MCP tool when it learns something worth remembering. Runs for
      // Claude Code too: its native `#` flow covers explicit saves, but
      // `memory_note` captures incidental durable facts mentioned
      // conversationally.
      const memoryMcpAddendum = needsMemoryMcp
        ? [
            '# Persistent memory',
            'You have access to a `memory_note` MCP tool (from the `agent-cockpit-memory` server). Call it whenever you learn something worth remembering across sessions:',
            '- **user** — the user\'s role, expertise, preferences, or responsibilities',
            '- **feedback** — a correction or confirmation the user has given you (include the reason if known)',
            '- **project** — ongoing work context, goals, deadlines, constraints, or stakeholders',
            '- **reference** — pointers to external systems (Linear, Slack, Grafana, etc.)',
            '',
            'Each call should capture ONE fact in natural language — do not batch unrelated facts. Pass the category in `type` when you know it. Keep notes terse. Do not call `memory_note` for ephemeral task state or things already visible in the current code.',
          ].join('\n')
        : '';
      const kbMcpAddendum = needsKbMcp
        ? (() => {
            const kbPath = path.resolve(chatService.getKbKnowledgeDir(wsHashForSend!));
            return [
              '# Knowledge Base',
              'You have access to a workspace knowledge base via MCP tools (from the `agent-cockpit-kb-search` server) and the local filesystem.',
              '',
              '## Search tools (use these to find relevant knowledge)',
              '- `search_topics(query)` — semantic + keyword search across all synthesized topics. Returns topic IDs, titles, summaries, and scores.',
              '- `search_entries(query)` — semantic + keyword search across all digested entries. Returns entry IDs, titles, summaries, and scores.',
              '- `get_topic(topic_id)` — full topic content, connections, and assigned entry list.',
              '- `find_similar_topics(topic_id)` — topics with similar embeddings.',
              '- `find_unconnected_similar(topic_id)` — similar topics with no existing connection.',
              '- `kb_ingest(file_path)` — ingest a local file into the knowledge base.',
              '',
              '## Reading full content (use after search narrows results)',
              `- Entries: \`${kbPath}/entries/<entryId>/entry.md\` — YAML frontmatter (title, tags, source) + digested markdown body.`,
              `- Synthesis: \`${kbPath}/synthesis/*.md\` — cross-entry topic synthesis.`,
              `- DB: \`${kbPath}/state.db\` — SQLite index of raw files, folders, and entries.`,
              '',
              '## Workflow',
              'Use search tools first to find relevant topics and entries by semantic meaning, then read the entry files directly for full content. Search narrows the space; file reads give you depth.',
            ].join('\n');
          })()
        : '';
      const parts = [globalPrompt, wsInstructions, memoryMcpAddendum, kbMcpAddendum].filter(Boolean);
      systemPrompt = parts.join('\n\n');
    }

    const adapter = backendRegistry.get(backendId);
    if (!adapter) {
      return res.status(400).json({ error: `Unknown backend: ${backendId}` });
    }

    // Mint MCP tokens for Memory and KB Search when their respective
    // features are enabled. Both use the same pattern: session-scoped
    // bearer tokens revoked on session reset or conversation delete.
    let mcpServers: import('../types').McpServerConfig[] | undefined;
    if (needsMemoryMcp && wsHashForSend) {
      const issued = memoryMcp.issueMemoryMcpSession(convId, wsHashForSend);
      mcpServers = issued.mcpServers;
      console.log(`[memoryMcp] Issued token for conv=${convId} backend=${backendId}`);
    }
    if (needsKbMcp && wsHashForSend) {
      const kbIssued = kbSearchMcp.issueKbSearchSession(convId, wsHashForSend);
      mcpServers = [...(mcpServers || []), ...kbIssued.mcpServers];
      console.log(`[kbSearchMcp] Issued token for conv=${convId} backend=${backendId}`);
    }

    console.log(`[chat] Starting CLI stream for conv=${convId} session=${conv.currentSessionId} isNew=${isNewSession} backend=${backendId} workingDir=${conv.workingDir || 'default'}`);
    // Re-fetch conversation so we pick up any effort downgrade triggered by a
    // model change in this same request.
    const refreshedConv = await chatService.getConversation(convId);
    const effectiveEffort = effort !== undefined
      ? (refreshedConv?.effort || undefined)
      : (conv.effort || undefined);
    const { stream, abort, sendInput } = adapter.sendMessage(cliMessage, {
      sessionId: conv.currentSessionId,
      conversationId: convId,
      isNewSession,
      workingDir: conv.workingDir || null,
      systemPrompt,
      externalSessionId: conv.externalSessionId || null,
      model: model || conv.model || undefined,
      effort: effectiveEffort,
      mcpServers,
    });
    const needsTitleUpdate = isNewSession && conv.sessionNumber > 1;
    activeStreams.set(convId, { stream, abort, sendInput, backend: backendId, needsTitleUpdate, titleUpdateMessage: needsTitleUpdate ? content.trim() : null });

    // If a WebSocket is connected for this conversation, pipe the stream to it
    if (wsFns && wsFns.isConnected(convId)) {
      wsFns.clearBuffer(convId); // Fresh buffer for the new stream

      // Start real-time memory watching for this stream.  When Claude
      // Code's extraction agent writes to its memory directory, the
      // watcher debounces for 500ms then re-snapshots into workspace
      // storage via captureWorkspaceMemory — so memories written mid-
      // session aren't lost if the user closes the browser before
      // the next session reset.  Best-effort: if the backend has no
      // memory dir (or hasn't created one yet), nothing happens.
      // Scoped to the processStream lifecycle so the watcher is always
      // cleaned up in the onDone callback below.
      // Gated on the per-workspace Memory toggle — watching is skipped
      // entirely when Memory is disabled for this workspace.
      const watchWorkspaceHash = chatService.getWorkspaceHashForConv(convId);
      const memoryOnForWatch = watchWorkspaceHash
        ? await chatService.getWorkspaceMemoryEnabled(watchWorkspaceHash)
        : false;
      const watchWorkspacePath = conv.workingDir || adapter.workingDir || null;
      if (memoryOnForWatch && watchWorkspacePath) {
        const memDir = adapter.getMemoryDir(watchWorkspacePath);
        if (memDir) {
          // `fs.watch` requires the directory to exist — on brand new
          // workspaces where the CLI hasn't written any memory yet the
          // dir is absent, and without this `mkdirSync` the watcher
          // silently fails to attach and mid-session memory writes
          // never produce a `memory_update` frame.
          try {
            fs.mkdirSync(memDir, { recursive: true });
          } catch (err: unknown) {
            console.warn(`[memoryWatcher] could not create ${memDir}:`, (err as Error).message);
          }
          memoryWatcher.watch(convId, memDir, async () => {
            try {
              const snapshot = await chatService.captureWorkspaceMemory(convId, backendId);
              if (snapshot) {
                console.log(`[memoryWatcher] re-captured ${snapshot.files.length} memory file(s) for conv=${convId} backend=${backendId}`);
                const nextFp = fingerprintMemoryFiles(snapshot);
                const changedFiles = diffFingerprints(memoryFingerprints.get(convId), nextFp);
                memoryFingerprints.set(convId, nextFp);
                if (wsFns && wsFns.isConnected(convId)) {
                  wsFns.send(convId, {
                    type: 'memory_update',
                    capturedAt: snapshot.capturedAt,
                    fileCount: snapshot.files.length,
                    changedFiles,
                  });
                }
              }
            } catch (err: unknown) {
              console.error(`[memoryWatcher] capture failed for conv=${convId}:`, (err as Error).message);
            }
          });
        }
      }

      processStream(
        convId,
        activeStreams.get(convId)!,
        (frame) => { wsFns!.send(convId, frame); },
        () => !wsFns!.isStreamAlive(convId),
        () => {
          activeStreams.delete(convId);
          memoryWatcher.unwatch(convId);
          memoryFingerprints.delete(convId);
        },
        { chatService },
      ).catch((err) => {
        console.error(`[chat] WS stream error for conv=${convId}:`, err);
        if (wsFns) {
          wsFns.send(convId, { type: 'error', error: (err as Error).message });
          wsFns.send(convId, { type: 'done' });
        }
        activeStreams.delete(convId);
        memoryWatcher.unwatch(convId);
        memoryFingerprints.delete(convId);
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

  // ── Workspace memory ───────────────────────────────────────────────────────
  // GET returns the merged snapshot (CLI captures + notes) together with the
  // per-workspace enable flag so the memory panel can render a single view.
  // 404 is reserved for "workspace doesn't exist"; an enabled workspace with
  // no entries yet returns 200 with `snapshot: null`.
  router.get('/workspaces/:hash/memory', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const enabled = await chatService.getWorkspaceMemoryEnabled(hash);
      const snapshot = await chatService.getWorkspaceMemory(hash);
      if (snapshot === null && !enabled) {
        // If there's no snapshot AND memory is off, it's effectively a
        // legacy GET. Preserve the existing "empty panel" contract.
        return res.json({ enabled, snapshot: null });
      }
      res.json({ enabled, snapshot });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:hash/memory/enabled', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { enabled } = req.body as { enabled?: boolean };
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }
      const hash = param(req, 'hash');
      const result = await chatService.setWorkspaceMemoryEnabled(hash, enabled);
      if (result === null) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ enabled: result });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // DELETE a single memory entry by relative path (e.g. `claude/foo.md` or
  // `notes/note_...md`). Path is validated against the workspace's memory
  // files dir inside chatService to prevent traversal.
  router.delete('/workspaces/:hash/memory/entries/:relpath(*)', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const relPath = decodeURIComponent(param(req, 'relpath'));
      if (!relPath) return res.status(400).json({ error: 'relpath required' });

      const deleted = await chatService.deleteMemoryEntry(hash, relPath);
      if (!deleted) return res.status(404).json({ error: 'Entry not found' });

      const snapshot = await chatService.getWorkspaceMemory(hash);

      // Notify any connected WebSocket so open memory panels refresh.
      if (wsFns) {
        for (const [convId] of activeStreams) {
          if (chatService.getWorkspaceHashForConv(convId) === hash && wsFns.isConnected(convId)) {
            wsFns.send(convId, {
              type: 'memory_update',
              capturedAt: snapshot?.capturedAt || new Date().toISOString(),
              fileCount: snapshot?.files.length || 0,
              changedFiles: [relPath],
            });
          }
        }
      }

      res.json({ ok: true, snapshot });
    } catch (err: unknown) {
      const msg = (err as Error).message || 'Delete failed';
      const status = /traversal/i.test(msg) ? 400 : 500;
      res.status(status).json({ error: msg });
    }
  });

  // DELETE all memory entries for a workspace — the "Clear all memory"
  // button in Workspace Settings → Memory. Wipes both `claude/` (CLI
  // capture) and `notes/` (memory_note + session extraction). Leaves the
  // workspace's Memory-enabled flag untouched so the user can keep the
  // feature on and just start over.
  router.delete('/workspaces/:hash/memory/entries', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const deleted = await chatService.clearWorkspaceMemory(hash);
      const snapshot = await chatService.getWorkspaceMemory(hash);

      // Notify any connected WebSocket so open memory panels refresh.
      if (wsFns) {
        for (const [convId] of activeStreams) {
          if (chatService.getWorkspaceHashForConv(convId) === hash && wsFns.isConnected(convId)) {
            wsFns.send(convId, {
              type: 'memory_update',
              capturedAt: snapshot?.capturedAt || new Date().toISOString(),
              fileCount: snapshot?.files.length || 0,
              changedFiles: [],
            });
          }
        }
      }

      res.json({ ok: true, deleted, snapshot });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message || 'Clear failed' });
    }
  });

  // ── Workspace Knowledge Base ────────────────────────────────────────────────
  // GET returns the KB state snapshot (pipeline counters, folder tree, and a
  // page of raw rows in the currently-focused folder) together with the
  // per-workspace enable flag so the KB Browser can render a single
  // consolidated view. 404 is reserved for "workspace doesn't exist"; an
  // enabled workspace with no files yet returns 200 with an empty snapshot
  // (counters = 0, folders = [root]).
  //
  // Query params:
  //   - folder: virtual folder to scope the raw listing to (default root)
  //   - limit:  page size for the raw listing (default 500)
  //   - offset: page offset for the raw listing (default 0)
  router.get('/workspaces/:hash/kb', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const enabled = await chatService.getWorkspaceKbEnabled(hash);
      const folderParam = typeof req.query.folder === 'string' ? req.query.folder : undefined;
      const limitParam = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const offsetParam = typeof req.query.offset === 'string' ? Number(req.query.offset) : undefined;
      const state = await chatService.getKbStateSnapshot(hash, {
        folderPath: folderParam,
        limit: Number.isFinite(limitParam) ? limitParam : undefined,
        offset: Number.isFinite(offsetParam) ? offsetParam : undefined,
      });
      if (state === null) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ enabled, state });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:hash/kb/enabled', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { enabled } = req.body as { enabled?: boolean };
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }
      const hash = param(req, 'hash');
      const result = await chatService.setWorkspaceKbEnabled(hash, enabled);
      if (result === null) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ enabled: result });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── KB raw-file ingestion ───────────────────────────────────────────────────
  // POST accepts a single file via multipart/form-data under the `file`
  // field, stages it under `knowledge/raw/<rawId>.<ext>`, and kicks off
  // background ingestion on the per-workspace queue. Returns 202 with the
  // initial raw entry (status='ingesting') so the frontend can render the
  // row immediately and swap its badge as `kb_state_update` frames arrive.
  //
  // We use in-memory multer storage because the orchestrator needs the
  // buffer to compute the sha256 rawId *before* deciding where on disk
  // the file belongs. 200 MB comfortably fits real-world PPTX decks and
  // media-heavy PDFs — the conversation-attachment endpoint keeps its
  // own smaller limit since those uploads are a different use case.
  const KB_UPLOAD_LIMIT_MB = 200;
  const kbUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: KB_UPLOAD_LIMIT_MB * 1024 * 1024, files: 1 },
  });

  // Multer throws `LIMIT_FILE_SIZE` (and friends) via `next(err)` BEFORE
  // the route handler runs, so an inline try/catch in the handler never
  // sees them — Express's default error handler ends up returning an
  // HTML 500 which the client can't parse. Wrap multer in a shim that
  // converts its errors into proper JSON responses the KB Browser can
  // display to the user.
  const kbUploadMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    kbUpload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? `File exceeds the ${KB_UPLOAD_LIMIT_MB} MB upload limit.`
          : err.message;
        res.status(400).json({ error: msg });
        return;
      }
      if (err) {
        res.status(500).json({ error: (err as Error).message });
        return;
      }
      next();
    });
  };

  router.post(
    '/workspaces/:hash/kb/raw',
    csrfGuard,
    kbUploadMiddleware,
    async (req: Request, res: Response) => {
      try {
        const hash = param(req, 'hash');
        const file = (req as unknown as { file?: Express.Multer.File }).file;
        if (!file) return res.status(400).json({ error: 'Missing "file" form field.' });

        // Pre-flight format guards — done here (not in the handler) so the
        // user sees an actionable error immediately instead of a failed
        // ingestion entry sitting in state.db.
        const lowerName = file.originalname.toLowerCase();
        if (lowerName.endsWith('.doc')) {
          return res.status(400).json({
            error:
              'Legacy .doc format is not supported. Please resave the document as .docx in Word or LibreOffice and upload again.',
          });
        }
        if (lowerName.endsWith('.docx')) {
          const pandocStatus = await detectPandoc();
          if (!pandocStatus.available) {
            return res.status(400).json({
              error:
                'DOCX ingestion requires Pandoc, which was not found on the server PATH. ' +
                'Install it from https://pandoc.org/installing.html (or via your package manager: `brew install pandoc`, `apt install pandoc`, `choco install pandoc`) and restart Agent Cockpit.',
            });
          }
        }

        // Virtual folder path is an optional multipart field. Empty string
        // or missing = root. Normalization + segment validation happens
        // inside the orchestrator so the route doesn't duplicate the rules.
        const body = (req as unknown as { body?: Record<string, string> }).body || {};
        const folderPath =
          typeof body.folder === 'string'
            ? body.folder
            : typeof (req.query.folder) === 'string'
              ? (req.query.folder as string)
              : '';

        // Multer gives us the raw bytes on `file.buffer` when using memoryStorage.
        const result = await kbIngestion.enqueueUpload(hash, {
          buffer: file.buffer,
          filename: file.originalname,
          mimeType: file.mimetype || 'application/octet-stream',
          folderPath,
        });
        res.status(202).json(result);
      } catch (err: unknown) {
        if (err instanceof KbDisabledError) {
          return res.status(400).json({ error: err.message });
        }
        if (err instanceof KbLocationConflictError) {
          return res.status(409).json({ error: err.message });
        }
        if (err instanceof KbValidationError) {
          return res.status(400).json({ error: err.message });
        }
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  router.delete('/workspaces/:hash/kb/raw/:rawId', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const rawId = param(req, 'rawId');
      // `?folder=...&filename=...` scopes the delete to one location
      // and respects ref-counting (other locations + raw row survive).
      // Without those params we purge the raw file entirely.
      const folderParam = typeof req.query.folder === 'string' ? req.query.folder : undefined;
      const filenameParam = typeof req.query.filename === 'string' ? req.query.filename : undefined;
      if (folderParam !== undefined && filenameParam) {
        const removed = await kbIngestion.deleteLocation(hash, rawId, folderParam, filenameParam);
        if (!removed) return res.status(404).json({ error: 'Location not found.' });
        return res.json({ ok: true });
      }
      const removed = await kbIngestion.purgeRaw(hash, rawId);
      if (!removed) return res.status(404).json({ error: 'Raw file not found.' });
      res.json({ ok: true });
    } catch (err: unknown) {
      if (err instanceof KbDisabledError) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── KB auto-digest toggle ───────────────────────────────────────────────────
  // Sets the per-workspace "auto-digest" flag. When true, newly-ingested
  // files are automatically fed through the digestion CLI as soon as
  // conversion completes. When false, the KB Browser exposes a "Digest
  // All Pending" button instead. The flag lives on the workspace index.
  router.put('/workspaces/:hash/kb/auto-digest', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { autoDigest } = req.body as { autoDigest?: boolean };
      if (typeof autoDigest !== 'boolean') {
        return res.status(400).json({ error: 'autoDigest must be a boolean' });
      }
      const hash = param(req, 'hash');
      const result = await chatService.setWorkspaceKbAutoDigest(hash, autoDigest);
      if (result === null) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ autoDigest: result });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── KB embedding config ─────────────────────────────────────────────────────

  router.get('/workspaces/:hash/kb/embedding-config', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const cfg = await chatService.getWorkspaceKbEmbeddingConfig(hash);
      res.json({ embeddingConfig: cfg ?? null });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:hash/kb/embedding-config', csrfGuard, async (req: Request, res: Response) => {
    try {
      const { model, ollamaHost, dimensions } = req.body as {
        model?: string;
        ollamaHost?: string;
        dimensions?: number;
      };
      if (model !== undefined && typeof model !== 'string') {
        return res.status(400).json({ error: 'model must be a string' });
      }
      if (ollamaHost !== undefined && typeof ollamaHost !== 'string') {
        return res.status(400).json({ error: 'ollamaHost must be a string' });
      }
      if (dimensions !== undefined && (typeof dimensions !== 'number' || dimensions < 1)) {
        return res.status(400).json({ error: 'dimensions must be a positive number' });
      }
      const hash = param(req, 'hash');
      const result = await chatService.setWorkspaceKbEmbeddingConfig(hash, {
        model, ollamaHost, dimensions,
      });
      if (result === null) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ embeddingConfig: result });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/kb/embedding-health', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const cfg = await chatService.getWorkspaceKbEmbeddingConfig(hash);
      const result = await checkOllamaHealth(cfg);
      res.json(result);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── KB digestion ────────────────────────────────────────────────────────────
  // Trigger digestion for a single raw file (manual "Digest now" button).
  // Fire-and-forget: returns 202 immediately; progress is streamed via
  // `kb_state_update` WS frames. Errors land on the raw row's errorClass.
  router.post(
    '/workspaces/:hash/kb/raw/:rawId/digest',
    csrfGuard,
    async (req: Request, res: Response) => {
      try {
        const hash = param(req, 'hash');
        const rawId = param(req, 'rawId');
        kbDigestion.enqueueDigest(hash, rawId).catch((err) => {
          console.error(`[kb] digest ${rawId} error:`, err);
        });
        res.status(202).json({ accepted: true });
      } catch (err: unknown) {
        if (err instanceof KbDigestDisabledError) {
          return res.status(400).json({ error: err.message });
        }
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // Trigger digestion for every eligible raw file in the workspace
  // (ingested + pending-delete). Fire-and-forget: returns 202 immediately.
  // Fires `kb_state_update` frames with `batchProgress: {done, total}` as
  // the run proceeds so the UI can show a progress bar.
  router.post('/workspaces/:hash/kb/digest-all', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      kbDigestion.enqueueBatchDigest(hash).catch((err) => {
        console.error('[kb] digest-all error:', err);
      });
      res.status(202).json({ accepted: true });
    } catch (err: unknown) {
      if (err instanceof KbDigestDisabledError) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── KB entries ──────────────────────────────────────────────────────────────
  // GET /entries returns a paginated list of digested entries, optionally
  // filtered by folder (via the joined raw_locations), tag, or rawId.
  router.get('/workspaces/:hash/kb/entries', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const enabled = await chatService.getWorkspaceKbEnabled(hash);
      if (!enabled) return res.json({ entries: [] });
      const db = chatService.getKbDb(hash);
      if (!db) return res.json({ entries: [] });

      const folder = typeof req.query.folder === 'string' ? req.query.folder : undefined;
      const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
      const rawId = typeof req.query.rawId === 'string' ? req.query.rawId : undefined;
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const offset = typeof req.query.offset === 'string' ? Number(req.query.offset) : undefined;

      const entries = db.listEntries({
        folderPath: folder,
        tag,
        rawId,
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined,
      });
      res.json({ entries });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /entries/:entryId returns a single entry's metadata + full body
  // read from disk. The body is the rendered `entry.md` (YAML frontmatter
  // + markdown) — the UI strips the frontmatter for preview.
  router.get('/workspaces/:hash/kb/entries/:entryId', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const entryId = param(req, 'entryId');
      if (!/^[a-zA-Z0-9_.-]+$/.test(entryId)) {
        return res.status(400).json({ error: 'Invalid entryId.' });
      }
      const db = chatService.getKbDb(hash);
      if (!db) return res.status(404).json({ error: 'KB not enabled' });
      const entry = db.getEntry(entryId);
      if (!entry) return res.status(404).json({ error: 'Entry not found' });
      const entryPath = path.join(chatService.getKbEntriesDir(hash), entryId, 'entry.md');
      let body = '';
      try {
        body = await fs.promises.readFile(entryPath, 'utf8');
      } catch {
        body = '';
      }
      res.json({ entry, body });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── KB folders ──────────────────────────────────────────────────────────────
  // Create a virtual folder. Idempotent — re-creating an existing folder
  // is a no-op and returns 200 with the normalized path.
  router.post('/workspaces/:hash/kb/folders', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const { folderPath } = req.body as { folderPath?: string };
      if (typeof folderPath !== 'string' || folderPath.trim() === '') {
        return res.status(400).json({ error: 'folderPath is required.' });
      }
      const normalized = await kbIngestion.createFolder(hash, folderPath);
      res.json({ folderPath: normalized });
    } catch (err: unknown) {
      if (err instanceof KbDisabledError) return res.status(400).json({ error: err.message });
      if (err instanceof KbValidationError) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Rename a folder subtree in-place. All files under the old path move
  // to the new path via a single raw_locations update (no disk moves).
  router.put('/workspaces/:hash/kb/folders', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const { fromPath, toPath } = req.body as { fromPath?: string; toPath?: string };
      if (typeof fromPath !== 'string' || typeof toPath !== 'string') {
        return res.status(400).json({ error: 'fromPath and toPath are required.' });
      }
      await kbIngestion.renameFolder(hash, fromPath, toPath);
      res.json({ ok: true });
    } catch (err: unknown) {
      if (err instanceof KbDisabledError) return res.status(400).json({ error: err.message });
      if (err instanceof KbValidationError) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Delete a folder subtree. `?cascade=true` removes every location
  // under the subtree (following ref-counted raw delete rules). Without
  // cascade the call errors if the subtree contains any files.
  router.delete('/workspaces/:hash/kb/folders', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const folderPath = typeof req.query.folder === 'string' ? req.query.folder : undefined;
      if (!folderPath) return res.status(400).json({ error: 'folder query parameter is required.' });
      const cascade = req.query.cascade === 'true' || req.query.cascade === '1';
      await kbIngestion.deleteFolder(hash, folderPath, { cascade });
      res.json({ ok: true });
    } catch (err: unknown) {
      if (err instanceof KbDisabledError) return res.status(400).json({ error: err.message });
      if (err instanceof KbValidationError) return res.status(400).json({ error: err.message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Stream the original bytes back for the Raw tab preview. We sanitize
  // the rawId against a hex character class to prevent path traversal —
  // the ingestion path already guarantees this shape, but belt-and-braces
  // here because this endpoint reads from disk and returns whatever it
  // finds under the safely-joined path.
  router.get('/workspaces/:hash/kb/raw/:rawId', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const rawId = param(req, 'rawId');
      if (!/^[a-f0-9]{1,64}$/i.test(rawId)) {
        return res.status(400).json({ error: 'Invalid rawId.' });
      }
      const diskPath = await chatService.getKbRawFilePath(hash, rawId);
      if (!diskPath) return res.status(404).json({ error: 'Raw file not found.' });
      // Confirm the resolved path is still inside the workspace KB dir —
      // defense in depth against a path that somehow escapes.
      const rawDir = path.resolve(chatService.getKbRawDir(hash));
      if (!path.resolve(diskPath).startsWith(rawDir)) {
        return res.status(400).json({ error: 'Invalid path.' });
      }
      try {
        await fs.promises.access(diskPath);
      } catch {
        return res.status(404).json({ error: 'Raw file not found on disk.' });
      }
      res.sendFile(path.resolve(diskPath));
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── KB Dreaming / Synthesis ────────────────────────────────────────────────

  // Start an incremental dreaming run. Returns 202 immediately; the run
  // progresses in the background with WS frames for progress.
  router.post('/workspaces/:hash/kb/dream', csrfGuard, async (req: Request, res: Response) => {
    const hash = param(req, 'hash');
    try {
      if (kbDreaming.isRunning(hash)) {
        res.status(409).json({ error: 'A dreaming run is already in progress.' });
        return;
      }
      const dreamDb = chatService.getKbDb(hash);
      if (dreamDb && dreamDb.countNeedsSynthesis() === 0) {
        res.status(400).json({ error: 'No entries pending synthesis. Upload and digest files first.' });
        return;
      }
      // Fire and forget — the service manages its own status in the DB.
      kbDreaming.dream(hash).catch((err) => {
        console.error(`[kb:dream] incremental run failed for ${hash}:`, err);
      });
      res.status(202).json({ ok: true, mode: 'incremental' });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Wipe all synthesis and run a full rebuild.
  router.post('/workspaces/:hash/kb/redream', csrfGuard, async (req: Request, res: Response) => {
    const hash = param(req, 'hash');
    try {
      if (kbDreaming.isRunning(hash)) {
        res.status(409).json({ error: 'A dreaming run is already in progress.' });
        return;
      }
      const redreamDb = chatService.getKbDb(hash);
      if (redreamDb && redreamDb.getCounters().entryCount === 0) {
        res.status(400).json({ error: 'No entries to rebuild. Upload and digest files first.' });
        return;
      }
      kbDreaming.redream(hash).catch((err) => {
        console.error(`[kb:dream] full rebuild failed for ${hash}:`, err);
      });
      res.status(202).json({ ok: true, mode: 'full-rebuild' });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Synthesis state: topics, connections, status for the KB Browser synthesis tab.
  router.get('/workspaces/:hash/kb/synthesis', async (req: Request, res: Response) => {
    const hash = param(req, 'hash');
    try {
      const db = chatService.getKbDb(hash);
      if (!db) {
        res.status(404).json({ error: 'Knowledge Base not found.' });
        return;
      }
      const snapshot = db.getSynthesisSnapshot();
      const topics = db.listTopics();
      const connections = db.listAllConnections();
      const godNodes = new Set(snapshot.godNodes);

      res.json({
        status: snapshot.status,
        lastRunAt: snapshot.lastRunAt,
        lastRunError: snapshot.lastRunError,
        topicCount: snapshot.topicCount,
        connectionCount: snapshot.connectionCount,
        needsSynthesisCount: snapshot.needsSynthesisCount,
        godNodes: snapshot.godNodes,
        dreamProgress: snapshot.dreamProgress,
        topics: topics.map((t) => ({
          topicId: t.topicId,
          title: t.title,
          summary: t.summary,
          entryCount: t.entryCount,
          connectionCount: t.connectionCount,
          isGodNode: godNodes.has(t.topicId),
        })),
        connections: connections.map((c) => ({
          sourceTopic: c.sourceTopic,
          targetTopic: c.targetTopic,
          relationship: c.relationship,
          confidence: c.confidence,
        })),
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Single topic detail: prose + entries + connections.
  router.get('/workspaces/:hash/kb/synthesis/:topicId', async (req: Request, res: Response) => {
    const hash = param(req, 'hash');
    const topicId = param(req, 'topicId');
    try {
      const db = chatService.getKbDb(hash);
      if (!db) {
        res.status(404).json({ error: 'Knowledge Base not found.' });
        return;
      }
      const topic = db.getTopic(topicId);
      if (!topic) {
        res.status(404).json({ error: `Topic "${topicId}" not found.` });
        return;
      }
      const godNodesRaw = db.getSynthesisMeta('god_nodes');
      const godNodes: string[] = godNodesRaw ? JSON.parse(godNodesRaw) : [];

      const entryIds = db.listTopicEntryIds(topicId);
      const entries = entryIds
        .map((eid) => db.getEntry(eid))
        .filter((e) => e !== null);

      const connections = db.listConnectionsForTopic(topicId).map((c) => ({
        sourceTopic: c.sourceTopic,
        targetTopic: c.targetTopic,
        relationship: c.relationship,
        confidence: c.confidence,
      }));

      res.json({
        topicId: topic.topicId,
        title: topic.title,
        summary: topic.summary,
        content: topic.content,
        updatedAt: topic.updatedAt,
        entryCount: topic.entryCount,
        connectionCount: topic.connectionCount,
        isGodNode: godNodes.includes(topicId),
        entries,
        connections,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Expose the cached LibreOffice detection result to the frontend so the
  // global Settings → Knowledge Base "Convert PPTX slides to images" checkbox
  // can validate on-click and auto-uncheck with a warning when the binary is
  // missing. `detectLibreOffice()` is cached at module level after the first
  // call (server.ts runs it at startup), so this endpoint is effectively a
  // read of that cache on every request.
  router.get('/kb/libreoffice-status', async (_req: Request, res: Response) => {
    try {
      const status = await detectLibreOffice();
      res.json(status);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Pandoc detection mirror of the LibreOffice endpoint above. Unlike
  // LibreOffice this is required for DOCX ingestion (not optional), so the
  // UI uses this to show a persistent "install pandoc" banner on the KB
  // Raw tab and to block DOCX uploads pre-flight.
  router.get('/kb/pandoc-status', async (_req: Request, res: Response) => {
    try {
      const status = await detectPandoc();
      res.json(status);
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
    memoryWatcher.unwatchAll();
    memoryFingerprints.clear();
    if (updateService) updateService.stop();
  }

  function setWsFunctions(fns: Pick<WsFunctions, 'send' | 'isConnected' | 'isStreamAlive' | 'clearBuffer'>) {
    wsFns = fns;
  }

  return { router, shutdown, activeStreams, setWsFunctions, memoryMcp };
}
