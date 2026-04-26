import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import multer from 'multer';
import { csrfGuard } from '../middleware/csrf';
import { attachmentFromPath } from '../services/chatService';
import type { ChatService } from '../services/chatService';
import type { BackendRegistry } from '../services/backends/registry';
import type { UpdateService } from '../services/updateService';
import type { ClaudePlanUsageService } from '../services/claudePlanUsageService';
import type { KiroPlanUsageService } from '../services/kiroPlanUsageService';
import type { CodexPlanUsageService } from '../services/codexPlanUsageService';
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
import type { Request, Response, NextFunction, ActiveStreamEntry, ContentBlock, ToolActivity, StreamEvent, WsServerFrame, EffortLevel } from '../types';
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
    batchIndex: number;
  }> = [];
  // Monotonic counter used to tag tool activities. All tool_uses emitted
  // between two CLI `user` events (turn_boundaries) share the same batch —
  // those are the parallel tool calls from a single LLM assistant turn.
  let batchIndex = 0;
  // Set when a turn_boundary fires; the next tool_activity advances batchIndex.
  let pendingNewBatch = false;
  // Ordered interleaving of text / thinking / tool blocks as they arrive
  // from the CLI stream. Parallel to the flat `fullResponse` / `thinkingText`
  // / `toolActivityAccumulator` buckets, but preserves the source ordering
  // that those flat accumulators lose. Persisted as `Message.contentBlocks`.
  let blocks: ContentBlock[] = [];

  function appendTextBlock(content: string): void {
    if (!content) return;
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'text') {
      last.content += content;
    } else {
      blocks.push({ type: 'text', content });
    }
  }

  function appendThinkingBlock(content: string): void {
    if (!content) return;
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'thinking') {
      last.content += content;
    } else {
      blocks.push({ type: 'thinking', content });
    }
  }

  function patchToolBlock(id: string | null | undefined, outcome: string | undefined, status: string | undefined): void {
    if (!id) return;
    for (const b of blocks) {
      if (b.type === 'tool' && b.activity.id === id) {
        if (outcome !== undefined) b.activity.outcome = outcome || undefined;
        if (status !== undefined) b.activity.status = status || undefined;
        return;
      }
    }
  }

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
      toolEntry.batchIndex = t.batchIndex;
      return toolEntry;
    });
  }

  // Merge the duration-computed tool activities (in order) back into the
  // ordered `blocks` array, returning a fresh ContentBlock[] suitable for
  // persistence. Text / thinking blocks pass through unchanged; each tool
  // block gets replaced with the next entry from `finalTools`, which
  // matches the order tools were pushed onto the accumulator.
  function finalizeBlocks(finalTools: ToolActivity[]): ContentBlock[] {
    let ti = 0;
    return blocks.map(b => {
      if (b.type === 'tool') {
        const next = finalTools[ti++];
        return { type: 'tool', activity: next || b.activity };
      }
      return { ...b };
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
        appendTextBlock(event.content);
        emit({ type: 'text', content: event.content });
      } else if (event.type === 'thinking') {
        thinkingText += event.content;
        appendThinkingBlock(event.content);
        emit({ type: 'thinking', content: event.content });
      } else if (event.type === 'tool_outcomes') {
        for (const outcome of (event.outcomes || [])) {
          const match = toolActivityAccumulator.find(t => t.id === outcome.toolUseId);
          if (match) {
            match.outcome = outcome.outcome || undefined;
            match.status = outcome.status || undefined;
          }
          patchToolBlock(outcome.toolUseId, outcome.outcome || undefined, outcome.status || undefined);
        }
        emit({ type: 'tool_outcomes', outcomes: event.outcomes });
      } else if (event.type === 'turn_boundary') {
        if (fullResponse.trim()) {
          const turnToolActivity = computeToolDurations(toolActivityAccumulator);
          const turnBlocks = finalizeBlocks(turnToolActivity);
          console.log(`[chat] Saving intermediate message for conv=${convId}, len=${fullResponse.trim().length}, tools=${turnToolActivity.length}, blocks=${turnBlocks.length}`);
          const intermediateMsg = await chatService.addMessage(convId, 'assistant', fullResponse.trim(), backend, thinkingText.trim() || null, turnToolActivity.length > 0 ? turnToolActivity : undefined, 'progress', turnBlocks.length > 0 ? turnBlocks : undefined);
          if (intermediateMsg) emit({ type: 'assistant_message', message: intermediateMsg });
          maybeUpdateTitle();
          // Only reset when we actually persisted a segment. A tool-only
          // turn_boundary (no text since the last save) keeps its accumulated
          // tools so they ride along with the next segment that has text —
          // otherwise parallel tools executed sequentially by the CLI get
          // dropped after the first boundary.
          fullResponse = '';
          thinkingText = '';
          toolActivityAccumulator = [];
          blocks = [];
        }
        // Any turn_boundary closes the current batch; the next tool_activity
        // will start a new one. Used by the frontend to group parallel tools.
        pendingNewBatch = true;
        emit({ type: 'turn_complete' });
      } else if (event.type === 'tool_activity') {
        if (event.isPlanFile && event.planContent) {
          pendingPlanContent = event.planContent;
        }
        const { type: _t, planContent: _pc, ...rest } = event;
        const restAny = rest as Record<string, unknown>;
        if (restAny.isPlanMode && restAny.planAction === 'exit') {
          const fallbackPlanContent = pendingPlanContent
            || fullResponse.trim()
            || resultText?.trim()
            || '';
          if (fallbackPlanContent) {
            restAny.planContent = fallbackPlanContent;
          }
        }
        if (restAny.isAgent && restAny.id) {
          console.log(`[chat] AGENT ${restAny.id} parentAgentId=${restAny.parentAgentId || 'none'}`);
        }
        emit({ type: 'tool_activity', ...rest } as WsServerFrame);
        if (!event.isPlanMode && !event.isQuestion) {
          if (pendingNewBatch) {
            batchIndex += 1;
            pendingNewBatch = false;
          }
          const startTime = Date.now();
          toolActivityAccumulator.push({
            tool: rest.tool,
            description: rest.description || '',
            id: rest.id || null,
            isAgent: rest.isAgent || undefined,
            subagentType: rest.subagentType || undefined,
            parentAgentId: rest.parentAgentId || undefined,
            startTime,
            batchIndex,
          });
          const blockActivity: ToolActivity = {
            tool: rest.tool,
            description: rest.description || '',
            id: rest.id || null,
            duration: null,
            startTime,
            batchIndex,
          };
          if (rest.isAgent) { blockActivity.isAgent = true; if (rest.subagentType) blockActivity.subagentType = rest.subagentType; }
          if (rest.parentAgentId) blockActivity.parentAgentId = rest.parentAgentId;
          blocks.push({ type: 'tool', activity: blockActivity });
        }
      } else if (event.type === 'result') {
        resultText = event.content;
      } else if (event.type === 'external_session') {
        // Vendor-agnostic: any backend that obtains its own session ID emits
        // this so we can persist it onto the active SessionEntry and rehydrate
        // after a cockpit server restart. Not forwarded to the frontend.
        try {
          await chatService.setExternalSessionId(convId, event.sessionId);
        } catch (err: unknown) {
          console.warn(`[chat] Failed to persist externalSessionId for conv=${convId}:`, (err as Error).message);
        }
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
        const finalBlocks = finalizeBlocks(finalToolActivity);
        const finalBlocksArg = finalBlocks.length > 0 ? finalBlocks : undefined;
        if (fullResponse.trim()) {
          if (apiErrPattern.test(fullResponse.trim())) {
            console.log(`[chat] Stream done for conv=${convId}, detected API error in text — not saving as message`);
            emit({ type: 'error', error: fullResponse.trim() });
          } else {
            console.log(`[chat] Stream done for conv=${convId}, saving final segment len=${fullResponse.trim().length}, tools=${finalToolActivity.length}, blocks=${finalBlocks.length}`);
            const assistantMsg = await chatService.addMessage(convId, 'assistant', fullResponse.trim(), backend, thinkingText.trim() || null, finalToolActivityArg, 'final', finalBlocksArg);
            if (assistantMsg) emit({ type: 'assistant_message', message: assistantMsg });
            maybeUpdateTitle();
          }
        } else if (resultText && resultText.trim()) {
          console.log(`[chat] Stream done for conv=${convId}, saving result len=${resultText.trim().length}, tools=${finalToolActivity.length}, blocks=${finalBlocks.length}`);
          // `resultText` is set by backends that emit a final `result` event
          // instead of streaming text deltas. There are no text blocks in
          // `blocks` in that case, so synthesize one so contentBlocks still
          // reflects the saved content faithfully.
          const resultBlocks: ContentBlock[] = finalBlocks.length > 0
            ? [...finalBlocks, { type: 'text', content: resultText.trim() }]
            : [{ type: 'text', content: resultText.trim() }];
          const assistantMsg = await chatService.addMessage(convId, 'assistant', resultText.trim(), backend, thinkingText.trim() || null, finalToolActivityArg, 'final', resultBlocks);
          if (assistantMsg) emit({ type: 'assistant_message', message: assistantMsg });
          maybeUpdateTitle();
        } else {
          console.log(`[chat] Stream done for conv=${convId}, no content to save`);
        }
        toolActivityAccumulator = [];
        blocks = [];
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
  claudePlanUsageService: ClaudePlanUsageService;
  kiroPlanUsageService: KiroPlanUsageService;
  codexPlanUsageService: CodexPlanUsageService;
}

export function createChatRouter({ chatService, backendRegistry, updateService, claudePlanUsageService, kiroPlanUsageService, codexPlanUsageService }: ChatRouterDeps) {
  const router = express.Router();
  const packageJson = require('../../package.json');

  const activeStreams = new Map<string, ActiveStreamEntry>();
  const memoryWatcher = new MemoryWatcher();
  // Per-conversation map of last-known memory file fingerprints (filename → sha-ish)
  // used by the watcher to compute `changedFiles` for the `memory_update` WS frame.
  // Cleared when the watcher is unwatched so a re-watched conversation starts fresh.
  const memoryFingerprints = new Map<string, Map<string, string>>();
  let wsFns: Pick<WsFunctions, 'send' | 'isConnected' | 'isStreamAlive' | 'clearBuffer' | 'forEachConnected'> | null = null;

  /**
   * Fan out a `kb_state_update` frame to every conversation with an OPEN
   * WebSocket whose workspace matches the event — regardless of whether
   * that conv has an active agent stream. This is what lets the composer
   * KB status icon update in real time while the user is idle in the
   * conversation (e.g. after uploading files via the KB Browser).
   */
  function broadcastKbStateUpdate(hash: string, frame: import('../types').KbStateUpdateEvent): void {
    if (!wsFns) return;
    const sent = new Set<string>();
    wsFns.forEachConnected((convId) => {
      if (chatService.getWorkspaceHashForConv(convId) !== hash) return;
      if (sent.has(convId)) return;
      sent.add(convId);
      wsFns!.send(convId, frame);
    });
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

  // ── Claude plan usage ──────────────────────────────────────────────────────
  // Returns the last-successful `/api/oauth/usage` snapshot from the
  // ClaudePlanUsageService cache. Never triggers a refresh itself — those
  // happen opportunistically on server start and after each Claude Code
  // assistant turn (wired in server.ts and in the stream onDone below).
  router.get('/plan-usage', (_req: Request, res: Response) => {
    res.json(claudePlanUsageService.getCached());
  });

  // ── Kiro plan usage ────────────────────────────────────────────────────────
  // Mirrors /plan-usage: returns the cached GetUsageLimits snapshot from
  // KiroPlanUsageService without triggering a fetch. Refreshes happen on
  // server start and after each Kiro turn (see stream onDone below).
  router.get('/kiro-plan-usage', (_req: Request, res: Response) => {
    res.json(kiroPlanUsageService.getCached());
  });

  // ── Codex plan usage ───────────────────────────────────────────────────────
  // Mirrors /plan-usage and /kiro-plan-usage: returns the cached
  // `account/read` + `account/rateLimits/read` snapshot from
  // CodexPlanUsageService. Refreshes happen on server start and after
  // each Codex turn (see stream onDone below).
  router.get('/codex-plan-usage', (_req: Request, res: Response) => {
    res.json(codexPlanUsageService.getCached());
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

  // ── Active streams ─────────────────────────────────────────────────────────
  // Lets the frontend rehydrate sidebar "streaming" dots after a page refresh.
  // `activeStreams` is the in-memory registry of CLI streams whose generator
  // has not yet returned — a conversation is listed here while its stream is
  // running OR paused awaiting user input (plan approval / question).
  router.get('/active-streams', (_req: Request, res: Response) => {
    res.json({ ids: Array.from(activeStreams.keys()) });
  });

  // ── Get single conversation ────────────────────────────────────────────────
  router.get('/conversations/:id', async (req: Request, res: Response) => {
    try {
      const conv = await chatService.getConversation(param(req, 'id'));
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });

      // Augment with KB status so the frontend's composer KB status icon
      // can render without a separate round-trip to GET /kb.
      const kbEnabled = await chatService.getWorkspaceKbEnabled(conv.workspaceHash);
      if (kbEnabled) {
        const db = chatService.getKbDb(conv.workspaceHash);
        if (db) {
          const snapshot = db.getSynthesisSnapshot();
          const counters = db.getCounters();
          const autoDigest = await chatService.getWorkspaceKbAutoDigest(conv.workspaceHash);
          (conv as unknown as Record<string, unknown>).kb = {
            enabled: true,
            dreamingNeeded: snapshot.needsSynthesisCount > 0,
            pendingEntries: snapshot.needsSynthesisCount,
            pendingDigestions: counters.pendingCount,
            autoDigest,
            dreamingStatus: kbDreaming.isRunning(conv.workspaceHash) ? 'running' : snapshot.status,
            dreamingStopping: kbDreaming.isStopRequested(conv.workspaceHash),
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

  // ── Set / clear unread flag ───────────────────────────────────────────────
  router.patch('/conversations/:id/unread', csrfGuard, async (req: Request, res: Response) => {
    try {
      const unread = req.body && req.body.unread === true;
      const ok = await chatService.setConversationUnread(param(req, 'id'), unread);
      if (!ok) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ ok: true, unread });
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
      const { queue } = req.body as { queue?: unknown };
      if (!Array.isArray(queue)) {
        return res.status(400).json({ error: 'queue must be an array of QueuedMessage' });
      }
      // Each entry must be { content: string, attachments?: AttachmentMeta[] }.
      // Legacy string entries are rejected — the client is expected to post the
      // new shape; server-side legacy migration is limited to reads.
      for (const entry of queue) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return res.status(400).json({ error: 'queue entries must be objects with a content string' });
        }
        const q = entry as { content?: unknown; attachments?: unknown };
        if (typeof q.content !== 'string') {
          return res.status(400).json({ error: 'queue entries must have a string content field' });
        }
        if (q.attachments != null) {
          if (!Array.isArray(q.attachments)) {
            return res.status(400).json({ error: 'queue entries attachments must be an array' });
          }
          for (const a of q.attachments) {
            if (!a || typeof a !== 'object' || Array.isArray(a)) {
              return res.status(400).json({ error: 'each attachment must be an object' });
            }
            const am = a as { name?: unknown; path?: unknown };
            if (typeof am.name !== 'string' || typeof am.path !== 'string') {
              return res.status(400).json({ error: 'each attachment must have string name and path' });
            }
          }
        }
      }
      const ok = await chatService.setQueue(param(req, 'id'), queue as import('../types').QueuedMessage[]);
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
              `- Reflections: \`${kbPath}/synthesis/reflections/*.md\` — cross-topic insights, patterns, contradictions, and gaps (generated during dreaming).`,
              `- DB: \`${kbPath}/state.db\` — SQLite index of raw files, folders, and entries.`,
              '',
              '## Workflow',
              'Use search tools first to find relevant topics and entries by semantic meaning, then read the entry files directly for full content. Search narrows the space; file reads give you depth.',
            ].join('\n');
          })()
        : '';
      const fileDeliveryAddendum = [
        '# File delivery',
        'When the user explicitly asks you to create, generate, or give them a downloadable file (e.g. "give me a CSV", "create a report file", "export this as JSON"), follow these steps:',
        '1. Create the file in the current working directory.',
        '2. After creating the file, output a reference on its own line using this exact format:',
        '   <!-- FILE_DELIVERY:/absolute/path/to/file.ext -->',
        '3. You may include multiple FILE_DELIVERY markers if the user asks for multiple files.',
        '',
        'Do NOT use FILE_DELIVERY for files you create as part of normal coding tasks (editing source code, config files, etc.). Only use it when the user explicitly wants a deliverable file to download.',
      ].join('\n');
      const parts = [globalPrompt, wsInstructions, memoryMcpAddendum, kbMcpAddendum, fileDeliveryAddendum].filter(Boolean);
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
          if (backendId === 'claude-code') {
            claudePlanUsageService.maybeRefresh('turn-done');
          } else if (backendId === 'kiro') {
            kiroPlanUsageService.maybeRefresh('turn-done');
          } else if (backendId === 'codex') {
            codexPlanUsageService.maybeRefresh('turn-done');
          }
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

  router.post('/conversations/:id/input', csrfGuard, async (req: Request, res: Response) => {
    const convId = param(req, 'id');
    const { text, streamActive } = req.body as { text?: string; streamActive?: boolean };

    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Input text required' });
    }

    const conv = await chatService.getConversation(convId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const entry = activeStreams.get(convId);
    if (streamActive && entry?.sendInput) {
      console.log(`[chat] Delivering interaction input via active stream for conv=${convId}`);
      entry.sendInput(text.trim());
      return res.json({ mode: 'stdin' });
    }

    return res.json({ mode: 'message' });
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
    const files = ((req as unknown as { files?: Express.Multer.File[] }).files || []).map((f) => {
      // Use the stored filename (which was already sanitized by multer's filename
      // callback) rather than originalname so the path we return is the one on
      // disk — that matters when the content string ships with `[Uploaded files:
      // <path>]` and the agent reads from disk.
      const meta = attachmentFromPath(f.path, f.size);
      return {
        name: meta.name,
        path: meta.path,
        size: meta.size,
        kind: meta.kind,
        meta: meta.meta,
      };
    });
    res.json({ files });
  });

  // Serve uploaded files
  // ?mode=view     → returns { content, filename, language } JSON for the viewer panel
  // ?mode=download → Content-Disposition: attachment (browser downloads the file)
  // (no mode)      → serves the file directly (legacy / images)
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
      res.json({ ok: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
      res.status(500).json({ error: 'Failed to delete file' });
    }
  });

  // OCR an uploaded image attachment to Markdown via a one-shot CLI call.
  // The conversation's configured backend/model/effort are reused so the
  // user gets the same quality they'd get if the image rode the prompt; the
  // call is throwaway (does not touch the active session). Caller is the
  // composer's per-attachment OCR button — result is inserted at the cursor
  // and cached client-side so re-clicks are free.
  router.post('/conversations/:id/attachments/ocr', csrfGuard, async (req: Request, res: Response) => {
    const convId = param(req, 'id');
    const { path: attachmentPath } = req.body as { path?: string };

    if (!attachmentPath || typeof attachmentPath !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }

    // Confine the path to this conversation's artifacts dir so a crafted
    // request can't OCR (and thereby exfiltrate text from) arbitrary files.
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

    const conv = await chatService.getConversation(convId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const backendId = conv.backend || 'claude-code';
    const adapter = backendRegistry.get(backendId);
    if (!adapter) {
      return res.status(500).json({ error: `Backend not registered: ${backendId}` });
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
        workingDir: conv.workingDir || undefined,
      });
      const cleaned = (markdown || '').trim();
      if (!cleaned) {
        return res.status(502).json({ error: 'OCR returned empty output' });
      }
      res.json({ markdown: cleaned });
    } catch (err: unknown) {
      console.error(`[ocr] backend=${backendId} conv=${convId} failed:`, (err as Error).message);
      return res.status(502).json({ error: (err as Error).message });
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

  // ── Workspace file delivery ─────────────────────────────────────────────────
  // Serves files from the workspace's working directory for the file delivery
  // feature. The CLI outputs <!-- FILE_DELIVERY:/path --> markers when the user
  // asks for a deliverable file; the UI renders download/view buttons that hit
  // this endpoint.
  //
  // ?mode=download → Content-Disposition: attachment (browser downloads the file)
  // ?mode=view     → returns { content, filename, language } JSON for the viewer panel
  router.get('/workspaces/:hash/files', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const filePath = req.query.path as string | undefined;
      const mode = (req.query.mode as string) || 'download';

      if (!filePath) {
        return res.status(400).json({ error: 'path query parameter is required' });
      }

      const workspacePath = await chatService.getWorkspacePath(hash);
      if (!workspacePath) {
        return res.status(404).json({ error: 'Workspace not found' });
      }

      // Path traversal protection: resolved path must be under the workspace root
      const resolved = path.resolve(filePath);
      const wsRoot = path.resolve(workspacePath);
      if (!resolved.startsWith(wsRoot + path.sep) && resolved !== wsRoot) {
        return res.status(403).json({ error: 'Access denied: path is outside workspace' });
      }

      // Check file exists and is a regular file
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
        // Cap viewable file size at 2 MB to avoid flooding the browser
        if (stat.size > 2 * 1024 * 1024) {
          return res.status(413).json({ error: 'File too large to view (max 2 MB). Use download instead.' });
        }
        const content = fs.readFileSync(resolved, 'utf8');
        const ext = path.extname(filename).replace('.', '');
        return res.json({ content, filename, language: ext });
      }

      // Download mode
      res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '\\"')}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      fs.createReadStream(resolved).pipe(res);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Workspace File Explorer ─────────────────────────────────────────────────
  //
  // Split-pane explorer in the main UI. All five endpoints resolve relative
  // paths against the workspace root (from `chatService.getWorkspacePath`)
  // and reject anything that escapes it. Hidden files are always returned.
  //
  //   GET    /workspaces/:hash/explorer/tree?path=<rel>
  //   GET    /workspaces/:hash/explorer/preview?path=<rel>&mode=view|raw|download
  //   POST   /workspaces/:hash/explorer/upload?path=<rel>&overwrite=true
  //   POST   /workspaces/:hash/explorer/mkdir
  //   POST   /workspaces/:hash/explorer/file
  //   PUT    /workspaces/:hash/explorer/file
  //   PATCH  /workspaces/:hash/explorer/rename
  //   DELETE /workspaces/:hash/explorer/entry?path=<rel>

  type ResolveOk = { ok: true; abs: string; root: string };
  type ResolveErr = { ok: false; status: number; error: string };

  async function resolveExplorerPath(hash: string, relPath: string): Promise<ResolveOk | ResolveErr> {
    const wsRoot = await chatService.getWorkspacePath(hash);
    if (!wsRoot) return { ok: false, status: 404, error: 'Workspace not found' };
    const root = path.resolve(wsRoot);
    const rel = (relPath || '').replace(/^[/\\]+/, '');
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return { ok: false, status: 403, error: 'Access denied: path is outside workspace' };
    }
    return { ok: true, abs, root };
  }

  function explorerMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const map: Record<string, string> = {
      '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
      '.json': 'application/json', '.xml': 'application/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml',
      '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
      '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
      '.ts': 'application/typescript', '.tsx': 'application/typescript', '.jsx': 'application/javascript',
      '.py': 'text/x-python', '.sh': 'application/x-sh', '.go': 'text/x-go', '.rs': 'text/x-rust',
      '.java': 'text/x-java', '.c': 'text/x-c', '.cpp': 'text/x-c++', '.h': 'text/x-c',
      '.log': 'text/plain', '.ini': 'text/plain', '.conf': 'text/plain', '.env': 'text/plain',
      '.sql': 'application/sql',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
      '.pdf': 'application/pdf',
    };
    return map[ext] || 'application/octet-stream';
  }

  const EXPLORER_TEXT_VIEW_LIMIT = 5 * 1024 * 1024;
  const EXPLORER_UPLOAD_LIMIT = 500 * 1024 * 1024;

  router.get('/workspaces/:hash/explorer/tree', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const rel = (req.query.path as string) || '';
      const r = await resolveExplorerPath(hash, rel);
      if (!r.ok) return res.status(r.status).json({ error: r.error });

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(r.abs);
      } catch {
        return res.status(404).json({ error: 'Directory not found' });
      }
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }

      let dirents: fs.Dirent[];
      try {
        dirents = await fs.promises.readdir(r.abs, { withFileTypes: true });
      } catch {
        return res.status(403).json({ error: 'Permission denied' });
      }

      const entries = await Promise.all(dirents.map(async (d) => {
        const abs = path.join(r.abs, d.name);
        let size = 0;
        let mtime = 0;
        try {
          const s = await fs.promises.stat(abs);
          size = s.size;
          mtime = s.mtimeMs;
        } catch { /* broken symlinks etc */ }
        return {
          name: d.name,
          type: d.isDirectory() ? 'dir' : 'file',
          size,
          mtime,
        };
      }));

      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

      const relPath = path.relative(r.root, r.abs);
      const parent = r.abs === r.root ? null : path.relative(r.root, path.dirname(r.abs));
      res.json({
        path: relPath,
        parent,
        entries,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/workspaces/:hash/explorer/preview', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const rel = req.query.path as string | undefined;
      const mode = (req.query.mode as string) || 'view';
      if (!rel) return res.status(400).json({ error: 'path query parameter is required' });

      const r = await resolveExplorerPath(hash, rel);
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      if (r.abs === r.root) return res.status(400).json({ error: 'Path must be a file' });

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(r.abs);
      } catch {
        return res.status(404).json({ error: 'File not found' });
      }
      if (!stat.isFile()) return res.status(400).json({ error: 'Path is not a file' });

      const filename = path.basename(r.abs);
      const mimeType = explorerMimeType(filename);

      if (mode === 'view') {
        if (stat.size > EXPLORER_TEXT_VIEW_LIMIT) {
          return res.status(413).json({ error: 'File too large to preview (max 5 MB). Use download.', size: stat.size });
        }
        const content = await fs.promises.readFile(r.abs, 'utf8');
        const ext = path.extname(filename).replace('.', '');
        return res.json({ content, filename, language: ext, mimeType, size: stat.size });
      }

      if (mode === 'download') {
        res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '\\"')}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
      } else {
        // raw
        res.setHeader('Content-Type', mimeType);
      }
      res.setHeader('Content-Length', String(stat.size));
      fs.createReadStream(r.abs).pipe(res);
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Upload — per-file endpoint. Client-side queue handles multi-file + drag-drop
  // with independent progress (mirrors the KB upload pattern). We write to a
  // temp filename first, then check conflicts and rename, so concurrent
  // uploads of different files to the same folder don't collide.
  const explorerUpload = multer({
    storage: multer.diskStorage({
      destination: (req: express.Request, _file: Express.Multer.File, cb: (err: Error | null, dir: string) => void) => {
        const abs = (req as unknown as { _explorerTargetAbs?: string })._explorerTargetAbs;
        if (!abs) return cb(new Error('Target directory not resolved'), '');
        cb(null, abs);
      },
      filename: (_req: express.Request, file: Express.Multer.File, cb: (err: Error | null, name: string) => void) => {
        const safe = file.originalname.replace(/[/\\]/g, '_');
        const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        cb(null, `.ac-upload-${nonce}-${safe}`);
      },
    }),
    limits: { fileSize: EXPLORER_UPLOAD_LIMIT, files: 1 },
  });

  const explorerUploadPrelude = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const hash = param(req, 'hash');
      const rel = (req.query.path as string) || '';
      const r = await resolveExplorerPath(hash, rel);
      if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(r.abs);
      } catch {
        res.status(404).json({ error: 'Target folder not found' });
        return;
      }
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'Target path is not a directory' });
        return;
      }
      (req as unknown as { _explorerTargetAbs?: string; _explorerRoot?: string })._explorerTargetAbs = r.abs;
      (req as unknown as { _explorerRoot?: string })._explorerRoot = r.root;
      next();
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  };

  const explorerUploadMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    explorerUpload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? `File exceeds the ${Math.floor(EXPLORER_UPLOAD_LIMIT / 1024 / 1024)} MB upload limit.`
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

  router.post('/workspaces/:hash/explorer/upload', csrfGuard, explorerUploadPrelude, explorerUploadMiddleware, async (req: Request, res: Response) => {
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    const targetDir = (req as unknown as { _explorerTargetAbs?: string })._explorerTargetAbs;
    if (!file || !targetDir) return res.status(400).json({ error: 'Missing file or target directory' });

    const overwrite = req.query.overwrite === 'true' || req.query.overwrite === '1';
    const finalName = file.originalname.replace(/[/\\]/g, '_');
    if (!finalName || finalName === '.' || finalName === '..') {
      await fs.promises.unlink(file.path).catch(() => {});
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const finalPath = path.join(targetDir, finalName);

    try {
      const exists = await fs.promises.stat(finalPath).then(() => true, () => false);
      if (exists && !overwrite) {
        await fs.promises.unlink(file.path).catch(() => {});
        return res.status(409).json({ error: 'File already exists', conflict: true, filename: finalName });
      }
      await fs.promises.rename(file.path, finalPath);
      const s = await fs.promises.stat(finalPath);
      res.json({ name: finalName, size: s.size, overwrote: exists });
    } catch (err: unknown) {
      await fs.promises.unlink(file.path).catch(() => {});
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.patch('/workspaces/:hash/explorer/rename', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const { from, to, overwrite } = req.body as { from?: string; to?: string; overwrite?: boolean };
      if (typeof from !== 'string' || typeof to !== 'string') {
        return res.status(400).json({ error: 'from and to are required strings' });
      }
      const fromRes = await resolveExplorerPath(hash, from);
      if (!fromRes.ok) return res.status(fromRes.status).json({ error: fromRes.error });
      const toRes = await resolveExplorerPath(hash, to);
      if (!toRes.ok) return res.status(toRes.status).json({ error: toRes.error });
      if (fromRes.abs === fromRes.root) return res.status(400).json({ error: 'Cannot rename workspace root' });
      if (toRes.abs === toRes.root) return res.status(400).json({ error: 'Cannot overwrite workspace root' });
      if (fromRes.abs === toRes.abs) return res.json({ ok: true, unchanged: true });

      try {
        await fs.promises.access(fromRes.abs);
      } catch {
        return res.status(404).json({ error: 'Source not found' });
      }

      const targetExists = await fs.promises.stat(toRes.abs).then(() => true, () => false);
      if (targetExists && !overwrite) {
        return res.status(409).json({ error: 'Destination already exists', conflict: true });
      }
      if (targetExists && overwrite) {
        await fs.promises.rm(toRes.abs, { recursive: true, force: true });
      }

      await fs.promises.mkdir(path.dirname(toRes.abs), { recursive: true });
      await fs.promises.rename(fromRes.abs, toRes.abs);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/explorer/mkdir', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const { parent, name } = req.body as { parent?: string; name?: string };
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      const trimmed = name.trim();
      if (/[/\\]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
        return res.status(400).json({ error: 'Invalid folder name' });
      }
      const parentRel = typeof parent === 'string' ? parent : '';
      const parentRes = await resolveExplorerPath(hash, parentRel);
      if (!parentRes.ok) return res.status(parentRes.status).json({ error: parentRes.error });

      let parentStat: fs.Stats;
      try {
        parentStat = await fs.promises.stat(parentRes.abs);
      } catch {
        return res.status(404).json({ error: 'Parent folder not found' });
      }
      if (!parentStat.isDirectory()) {
        return res.status(400).json({ error: 'Parent path is not a directory' });
      }

      const targetAbs = path.join(parentRes.abs, trimmed);
      if (!targetAbs.startsWith(parentRes.root + path.sep) && targetAbs !== parentRes.root) {
        return res.status(403).json({ error: 'Access denied: path is outside workspace' });
      }

      const existing = await fs.promises.stat(targetAbs).then((s) => s, () => null);
      if (existing) {
        return res.status(409).json({ error: 'A file or folder with this name already exists' });
      }

      await fs.promises.mkdir(targetAbs);
      const relPath = path.relative(parentRes.root, targetAbs);
      res.json({ ok: true, path: relPath, name: trimmed });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/workspaces/:hash/explorer/file', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const { parent, name, content } = req.body as { parent?: string; name?: string; content?: string };
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      const trimmed = name.trim();
      if (/[/\\]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
        return res.status(400).json({ error: 'Invalid file name' });
      }
      const body = typeof content === 'string' ? content : '';
      const byteLength = Buffer.byteLength(body, 'utf8');
      if (byteLength > EXPLORER_TEXT_VIEW_LIMIT) {
        return res.status(413).json({ error: `Content exceeds the ${Math.floor(EXPLORER_TEXT_VIEW_LIMIT / 1024 / 1024)} MB edit limit.` });
      }

      const parentRel = typeof parent === 'string' ? parent : '';
      const parentRes = await resolveExplorerPath(hash, parentRel);
      if (!parentRes.ok) return res.status(parentRes.status).json({ error: parentRes.error });

      let parentStat: fs.Stats;
      try {
        parentStat = await fs.promises.stat(parentRes.abs);
      } catch {
        return res.status(404).json({ error: 'Parent folder not found' });
      }
      if (!parentStat.isDirectory()) {
        return res.status(400).json({ error: 'Parent path is not a directory' });
      }

      const targetAbs = path.join(parentRes.abs, trimmed);
      if (!targetAbs.startsWith(parentRes.root + path.sep) && targetAbs !== parentRes.root) {
        return res.status(403).json({ error: 'Access denied: path is outside workspace' });
      }

      const existing = await fs.promises.stat(targetAbs).then((s) => s, () => null);
      if (existing) {
        return res.status(409).json({ error: 'A file or folder with this name already exists' });
      }

      await fs.promises.writeFile(targetAbs, body, 'utf8');
      const s = await fs.promises.stat(targetAbs);
      const relPath = path.relative(parentRes.root, targetAbs);
      res.json({ ok: true, path: relPath, name: trimmed, size: s.size });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/workspaces/:hash/explorer/file', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const { path: rel, content } = req.body as { path?: string; content?: string };
      if (typeof rel !== 'string' || !rel) {
        return res.status(400).json({ error: 'path is required' });
      }
      if (typeof content !== 'string') {
        return res.status(400).json({ error: 'content must be a string' });
      }
      const byteLength = Buffer.byteLength(content, 'utf8');
      if (byteLength > EXPLORER_TEXT_VIEW_LIMIT) {
        return res.status(413).json({ error: `Content exceeds the ${Math.floor(EXPLORER_TEXT_VIEW_LIMIT / 1024 / 1024)} MB edit limit.` });
      }

      const r = await resolveExplorerPath(hash, rel);
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      if (r.abs === r.root) return res.status(400).json({ error: 'Path must be a file' });

      let stat: fs.Stats | null = null;
      try {
        stat = await fs.promises.stat(r.abs);
      } catch {
        return res.status(404).json({ error: 'File not found' });
      }
      if (!stat.isFile()) {
        return res.status(400).json({ error: 'Path is not a file' });
      }

      await fs.promises.writeFile(r.abs, content, 'utf8');
      const s = await fs.promises.stat(r.abs);
      res.json({ ok: true, size: s.size, mtime: s.mtimeMs });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/workspaces/:hash/explorer/entry', csrfGuard, async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const rel = req.query.path as string | undefined;
      if (!rel) return res.status(400).json({ error: 'path query parameter is required' });
      const r = await resolveExplorerPath(hash, rel);
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      if (r.abs === r.root) return res.status(400).json({ error: 'Cannot delete workspace root' });

      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(r.abs);
      } catch {
        return res.status(404).json({ error: 'Not found' });
      }
      if (stat.isDirectory()) {
        await fs.promises.rm(r.abs, { recursive: true, force: true });
      } else {
        await fs.promises.unlink(r.abs);
      }
      res.json({ ok: true });
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
  // The digestion orchestrator emits `kb_state_update` frames with
  // `digestProgress: { done, total, avgMsPerItem, etaMs? }` as the run
  // proceeds (unified across batch, single-file, and auto-digest runs)
  // so the toolbar can render live `N / M — ~X min remaining`.
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
  // GET /entries returns a paginated list of digested entries with
  // filtering by title substring (`search`), folder, tag(s), rawId, and
  // date ranges on uploaded (raw.uploaded_at) and digested
  // (entries.digested_at) timestamps. Multi-tag filtering uses AND
  // semantics — an entry must carry every tag in the `tags` csv. The
  // response includes a `total` count (pre-pagination) so the UI can
  // render pagination controls.
  router.get('/workspaces/:hash/kb/entries', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const enabled = await chatService.getWorkspaceKbEnabled(hash);
      if (!enabled) return res.json({ entries: [], total: 0 });
      const db = chatService.getKbDb(hash);
      if (!db) return res.json({ entries: [], total: 0 });

      const folder = typeof req.query.folder === 'string' ? req.query.folder : undefined;
      const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
      const tags = typeof req.query.tags === 'string'
        ? req.query.tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
        : undefined;
      const rawId = typeof req.query.rawId === 'string' ? req.query.rawId : undefined;
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const uploadedFrom = typeof req.query.uploadedFrom === 'string' ? req.query.uploadedFrom : undefined;
      const uploadedTo = typeof req.query.uploadedTo === 'string' ? req.query.uploadedTo : undefined;
      const digestedFrom = typeof req.query.digestedFrom === 'string' ? req.query.digestedFrom : undefined;
      const digestedTo = typeof req.query.digestedTo === 'string' ? req.query.digestedTo : undefined;
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const offset = typeof req.query.offset === 'string' ? Number(req.query.offset) : undefined;

      const filter = {
        folderPath: folder,
        tag,
        tags,
        rawId,
        search,
        uploadedFrom,
        uploadedTo,
        digestedFrom,
        digestedTo,
      };
      const entries = db.listEntries({
        ...filter,
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined,
      });
      const total = db.countEntries(filter);
      res.json({ entries, total });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /tags returns every distinct tag in the KB with its entry count,
  // ordered most-used first. Feeds the entries-tab tag picker.
  router.get('/workspaces/:hash/kb/tags', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const enabled = await chatService.getWorkspaceKbEnabled(hash);
      if (!enabled) return res.json({ tags: [] });
      const db = chatService.getKbDb(hash);
      if (!db) return res.json({ tags: [] });
      res.json({ tags: db.listAllTags() });
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
      const locations = entry.rawId ? db.listLocations(entry.rawId) : [];
      res.json({ entry, body, locations });
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

  // Serve a media file produced by ingestion under `converted/<rawId>/`.
  // Entry bodies reference embedded images / extracted slides / rasterized
  // pages with relative paths like `media/Slide123.jpg` or
  // `slides/slide-001.png`, all rooted at the per-raw converted directory.
  // The frontend rewrites those into URLs that hit this endpoint.
  router.get('/workspaces/:hash/kb/raw/:rawId/media/:mediapath(*)', async (req: Request, res: Response) => {
    try {
      const hash = param(req, 'hash');
      const rawId = param(req, 'rawId');
      if (!/^[a-f0-9]{1,64}$/i.test(rawId)) {
        return res.status(400).json({ error: 'Invalid rawId.' });
      }
      const relPath = decodeURIComponent(param(req, 'mediapath') || '');
      if (!relPath) return res.status(400).json({ error: 'media path required' });
      // Reject any segment that would escape the rawId directory. The
      // resolve-and-startsWith check below is the real guard, but keep this
      // as a fast, explicit rejection for traversal attempts.
      if (relPath.split(/[\\/]+/).some((seg) => seg === '..')) {
        return res.status(400).json({ error: 'Invalid path.' });
      }
      const rawDir = path.resolve(chatService.getKbConvertedDir(hash), rawId);
      const diskPath = path.resolve(rawDir, relPath);
      if (!diskPath.startsWith(rawDir + path.sep)) {
        return res.status(400).json({ error: 'Invalid path.' });
      }
      try {
        await fs.promises.access(diskPath);
      } catch {
        return res.status(404).json({ error: 'Media file not found.' });
      }
      res.sendFile(diskPath);
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

  // Cooperatively stop an in-progress dream run. Honored at the next
  // batch/phase boundary; already-committed work is preserved. Returns 404
  // if no run is in progress.
  router.post('/workspaces/:hash/kb/dream/stop', csrfGuard, async (req: Request, res: Response) => {
    const hash = param(req, 'hash');
    try {
      if (!kbDreaming.isRunning(hash)) {
        res.status(404).json({ ok: false, error: 'No dreaming run in progress.' });
        return;
      }
      kbDreaming.requestStop(hash);
      res.json({ ok: true, stopping: true });
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
        stopping: kbDreaming.isStopRequested(hash),
        lastRunAt: snapshot.lastRunAt,
        lastRunError: snapshot.lastRunError,
        topicCount: snapshot.topicCount,
        connectionCount: snapshot.connectionCount,
        needsSynthesisCount: snapshot.needsSynthesisCount,
        godNodes: snapshot.godNodes,
        dreamProgress: snapshot.dreamProgress,
        reflectionCount: snapshot.reflectionCount,
        staleReflectionCount: snapshot.staleReflectionCount,
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

  // ── KB Reflections ──────────────────────────────────────────────────────

  // List all reflections with stale detection.
  router.get('/workspaces/:hash/kb/reflections', async (req: Request, res: Response) => {
    const hash = param(req, 'hash');
    try {
      const db = chatService.getKbDb(hash);
      if (!db) {
        res.status(404).json({ error: 'Knowledge Base not found.' });
        return;
      }
      const reflections = db.listReflections();
      const staleIds = new Set(db.listStaleReflectionIds());

      res.json({
        reflections: reflections.map((r) => ({
          reflectionId: r.reflectionId,
          title: r.title,
          type: r.type,
          summary: r.summary,
          citationCount: r.citationCount,
          createdAt: r.createdAt,
          isStale: staleIds.has(r.reflectionId),
        })),
      });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Single reflection detail: full content + cited entries.
  router.get('/workspaces/:hash/kb/reflections/:reflectionId', async (req: Request, res: Response) => {
    const hash = param(req, 'hash');
    const reflectionId = param(req, 'reflectionId');
    try {
      const db = chatService.getKbDb(hash);
      if (!db) {
        res.status(404).json({ error: 'Knowledge Base not found.' });
        return;
      }
      const detail = db.getReflection(reflectionId);
      if (!detail) {
        res.status(404).json({ error: `Reflection "${reflectionId}" not found.` });
        return;
      }
      // Resolve cited entry metadata.
      const citedEntries = detail.citedEntryIds
        .map((eid) => db.getEntry(eid))
        .filter((e) => e !== null);

      res.json({
        reflectionId: detail.reflectionId,
        title: detail.title,
        type: detail.type,
        summary: detail.summary,
        content: detail.content,
        createdAt: detail.createdAt,
        citationCount: detail.citationCount,
        citedEntries,
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

  function setWsFunctions(fns: Pick<WsFunctions, 'send' | 'isConnected' | 'isStreamAlive' | 'clearBuffer' | 'forEachConnected'>) {
    wsFns = fns;
  }

  return { router, shutdown, activeStreams, setWsFunctions, memoryMcp };
}
