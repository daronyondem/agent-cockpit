import express from 'express';
import path from 'path';
import { csrfGuard } from '../../middleware/csrf';
import type { ChatService } from '../../services/chatService';
import type { BackendRegistry } from '../../services/backends/registry';
import type { BaseBackendAdapter } from '../../services/backends/base';
import { ACTIVE_STREAM_JOB_STATES } from '../../services/streamJobRegistry';
import { StreamJobSupervisor, type PendingMessageSend } from '../../services/streamJobSupervisor';
import type { MemoryMcpServer } from '../../services/memoryMcp';
import type { KbSearchMcpServer } from '../../services/kbSearchMcp';
import type { ContextMapMcpServer } from '../../services/contextMap/mcp';
import { validateConversationInputRequest, validateSendMessageRequest } from '../../contracts/streams';
import { isContractValidationError } from '../../contracts/validation';
import type {
  ActiveStreamEntry,
  EffortLevel,
  McpServerConfig,
  Request,
  Response,
  SendMessageResult,
  ServiceTier,
  StreamJobRuntimeInfo,
  StreamJobState,
} from '../../types';
import { logger } from '../../utils/logger';
import { buildMemoryMcpAddendum, buildMemoryMcpResumeReminder } from './memoryPrompt';
import { isCliProfileResolutionError, param } from './routeUtils';

const log = logger.child({ module: 'stream-routes' });

type Conversation = NonNullable<Awaited<ReturnType<ChatService['getConversation']>>>;
type CliRuntime = Awaited<ReturnType<ChatService['resolveCliProfileRuntime']>>;

export interface AttachAndPipeStreamArgs {
  convId: string;
  conv: Conversation;
  backendId: string;
  runtime: CliRuntime;
  adapter: BaseBackendAdapter;
  sendResult: SendMessageResult;
  jobId: string;
  needsTitleUpdate: boolean;
  titleUpdateMessage: string | null;
  model: string | null;
  effort: EffortLevel | null;
  serviceTier?: ServiceTier | null;
  logUserMessageId?: string | null;
  logUserMessageTimestamp?: string | null;
}

export interface StreamRoutesOptions {
  chatService: ChatService;
  backendRegistry: BackendRegistry;
  streamSupervisor: StreamJobSupervisor;
  streamJobs: StreamJobSupervisor['registry'];
  activeStreams: Map<string, ActiveStreamEntry>;
  pendingMessageSends: Map<string, PendingMessageSend>;
  memoryMcp: MemoryMcpServer;
  kbSearchMcp: KbSearchMcpServer;
  contextMapMcp: ContextMapMcpServer;
  hasInFlightTurn: (convId: string) => boolean;
  requestPendingAbort: (convId: string) => Promise<boolean>;
  abortActiveStream: (convId: string) => Promise<boolean>;
  finalizePendingAbortIfRequested: (convId: string, backend: string, pending: PendingMessageSend) => Promise<boolean>;
  attachAndPipeStream: (args: AttachAndPipeStreamArgs) => Promise<void>;
  isWsConnected: (convId: string) => boolean;
}

export function createStreamRouter(opts: StreamRoutesOptions): express.Router {
  const {
    chatService,
    backendRegistry,
    streamSupervisor,
    streamJobs,
    activeStreams,
    pendingMessageSends,
    memoryMcp,
    kbSearchMcp,
    contextMapMcp,
    hasInFlightTurn,
    requestPendingAbort,
    abortActiveStream,
    finalizePendingAbortIfRequested,
    attachAndPipeStream,
    isWsConnected,
  } = opts;
  const router = express.Router();

  // ── Active streams ─────────────────────────────────────────────────────────
  // Lets the frontend rehydrate sidebar "streaming" dots after a page refresh.
  // `activeStreams` is the in-memory registry of CLI streams whose generator
  // has not yet returned — a conversation is listed here while its stream is
  // running OR paused awaiting user input (plan approval / question).
  router.get('/active-streams', async (_req: Request, res: Response) => {
    try {
      const streamsById = new Map<string, {
        id: string;
        jobId?: string | null;
        state?: string;
        backend: string;
        startedAt: string | null;
        lastEventAt: string | null;
        connected: boolean;
        runtimeAttached: boolean;
        pending: boolean;
        runtime: StreamJobRuntimeInfo | null;
      }>();

      for (const job of await streamJobs.listActive()) {
        streamsById.set(job.conversationId, {
          id: job.conversationId,
          jobId: job.id,
          state: job.state,
          backend: job.backend,
          startedAt: job.startedAt || job.createdAt || null,
          lastEventAt: job.lastEventAt || job.startedAt || job.createdAt || null,
          connected: isWsConnected(job.conversationId),
          runtimeAttached: activeStreams.has(job.conversationId),
          pending: pendingMessageSends.has(job.conversationId),
          runtime: job.runtime || null,
        });
      }

      for (const [id, entry] of activeStreams.entries()) {
        const existing = streamsById.get(id);
        streamsById.set(id, {
          id,
          jobId: entry.jobId || existing?.jobId || null,
          state: existing?.state || 'running',
          backend: entry.backend,
          startedAt: entry.startedAt || existing?.startedAt || null,
          lastEventAt: entry.lastEventAt || entry.startedAt || existing?.lastEventAt || null,
          connected: isWsConnected(id),
          runtimeAttached: true,
          pending: existing?.pending || false,
          runtime: existing?.runtime || null,
        });
      }

      const streams = Array.from(streamsById.values())
        .filter((stream) => ACTIVE_STREAM_JOB_STATES.has((stream.state || 'running') as StreamJobState));
      res.json({ ids: streams.map(s => s.id), streams });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });


  router.post('/conversations/:id/abort', csrfGuard, async (req: Request, res: Response) => {
    try {
      const convId = param(req, 'id');
      const conv = await chatService.getConversation(convId);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });

      let aborted = await abortActiveStream(convId);
      if (!aborted) aborted = await requestPendingAbort(convId);
      if (!aborted) {
        return res.json({ ok: true, aborted: false });
      }
      res.json({ ok: true, aborted: true });
    } catch (err: unknown) {
      res.status(500).json({ error: (err as Error).message });
    }
  });


  router.post('/conversations/:id/message', csrfGuard, async (req: Request, res: Response) => {
    const convId = param(req, 'id');
    let body: ReturnType<typeof validateSendMessageRequest>;
    try {
      body = validateSendMessageRequest(req.body);
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
    const { content, backend, model, effort, cliProfileId, serviceTier } = body;
    log.debug('POST /message accepted', { conversationId: convId, contentLength: content.length, activeStream: activeStreams.has(convId), wsConnected: isWsConnected(convId) });

    let conv = await chatService.getConversation(convId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (hasInFlightTurn(convId)) {
      return res.status(409).json({ error: 'Conversation is already streaming' });
    }

    let jobHandedOff = false;
    let pendingMessageSend: PendingMessageSend | null = null;
    try {
      pendingMessageSend = await streamSupervisor.beginAcceptedTurn({
        conversationId: convId,
        sessionId: conv.currentSessionId,
        backend: conv.backend,
        cliProfileId: conv.cliProfileId || cliProfileId || null,
        model: model !== undefined ? (model || null) : (conv.model || null),
        effort: effort !== undefined ? (effort || null) : (conv.effort || null),
        serviceTier: serviceTier !== undefined ? serviceTier : (conv.serviceTier || null),
        workingDir: conv.workingDir || null,
      });
      const jobId = pendingMessageSend.jobId;

      try {
        if (cliProfileId) {
          if (cliProfileId !== conv.cliProfileId) {
            if (conv.messages.length > 0) {
              return res.status(409).json({ error: 'Cannot switch CLI profile after the active session has messages' });
            }
            await chatService.updateConversationCliProfile(convId, cliProfileId);
          }
        } else if (backend && backend !== conv.backend) {
          await chatService.updateConversationBackend(convId, backend);
        }
      } catch (err: unknown) {
        if (isCliProfileResolutionError(err)) {
          return res.status(400).json({ error: (err as Error).message });
        }
        throw err;
      }
    if (model !== undefined && model !== (conv.model || undefined)) {
      await chatService.updateConversationModel(convId, model || null);
    }
    if (effort !== undefined && effort !== (conv.effort || undefined)) {
      await chatService.updateConversationEffort(convId, effort || null);
    }
    if (serviceTier !== undefined && serviceTier !== (conv.serviceTier || null)) {
      await chatService.updateConversationServiceTier(convId, serviceTier);
    }
    conv = (await chatService.getConversation(convId))!;

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
    if (cliProfileId && backend && backend !== backendId) {
      return res.status(400).json({ error: `CLI profile vendor ${backendId} does not match backend ${backend}` });
    }
    await streamSupervisor.markPreparing(jobId, {
      backend: backendId,
      sessionId: conv.currentSessionId,
      cliProfileId: runtime.cliProfileId || conv.cliProfileId || null,
      model: conv.model || null,
      effort: conv.effort || null,
      serviceTier: conv.serviceTier || null,
      workingDir: conv.workingDir || null,
    });
    const userMsg = await chatService.addMessage(convId, 'user', content.trim(), backendId);
    await streamSupervisor.markPreparing(jobId, {
      userMessageId: userMsg?.id || null,
    });
    if (await finalizePendingAbortIfRequested(convId, backendId, pendingMessageSend)) {
      return res.json({ userMessage: userMsg, streamReady: false, aborted: true });
    }

    const isNewSession = conv.messages.length === 0;

    const wsHashForSend = chatService.getWorkspaceHashForConv(convId);
    const memoryEnabledForSend = wsHashForSend
      ? await chatService.getWorkspaceMemoryEnabled(wsHashForSend)
      : false;
    // All memory-enabled sessions get the Memory MCP stub so they can
    // search memory and persist notes. Kiro spawns it over ACP's
    // `mcpServers`; Claude Code spawns it via `--mcp-config`.
    const needsMemoryMcp = memoryEnabledForSend && !!wsHashForSend;
    const kbEnabledForSend = wsHashForSend
      ? await chatService.getWorkspaceKbEnabled(wsHashForSend)
      : false;
    const needsKbMcp = kbEnabledForSend && !!wsHashForSend;
    const contextMapEnabledForSend = wsHashForSend
      ? await chatService.getWorkspaceContextMapEnabled(wsHashForSend)
      : false;
    const needsContextMapMcp = contextMapEnabledForSend && !!wsHashForSend;

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
    } else if (needsMemoryMcp) {
      cliMessage = buildMemoryMcpResumeReminder() + '\n\n' + cliMessage;
    }

    let systemPrompt = '';
    if (isNewSession) {
      const settings = await chatService.getSettings();
      const globalPrompt = settings.systemPrompt || '';
      const wsInstructions = wsHashForSend ? (await chatService.getWorkspaceInstructions(wsHashForSend)) || '' : '';
      // Append an addendum that teaches the CLI to use memory MCP tools
      // for targeted recall and durable writes. Runs for
      // Claude Code too: its native `#` flow covers explicit saves, but
      // `memory_note` captures incidental durable facts mentioned
      // conversationally.
      const memoryMcpAddendum = needsMemoryMcp ? buildMemoryMcpAddendum() : '';
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
              '- `get_topic_neighborhood(topic_id, depth?, limit?, min_confidence?, include_entries?)` — graph neighbors connected through synthesized relationships.',
              '- `find_similar_topics(topic_id)` — topics with similar embeddings.',
              '- `find_unconnected_similar(topic_id)` — similar topics with no existing connection.',
              '- `list_documents(query?)` — list converted source documents and unit counts.',
              '- `get_document_structure(raw_id)` — inspect page, slide, section, or fallback ranges without reading full content.',
              '- `get_source_range(raw_id, start_unit, end_unit)` — read a bounded converted source range with referenced media paths.',
              '- `kb_ingest(file_path)` — ingest a local file into the knowledge base.',
              '',
              '## Reading full content (use after search narrows results)',
              `- Entries: \`${kbPath}/entries/<entryId>/entry.md\` — YAML frontmatter (title, tags, source) + digested markdown body.`,
              `- Synthesis: \`${kbPath}/synthesis/*.md\` — cross-entry topic synthesis.`,
              `- Reflections: \`${kbPath}/synthesis/reflections/*.md\` — cross-topic insights, patterns, contradictions, and gaps (generated during dreaming).`,
              `- DB: \`${kbPath}/state.db\` — SQLite index of raw files, folders, and entries.`,
              '',
              '## Workflow',
              'Use search tools first to find relevant topics and entries by semantic meaning. For large source documents, inspect structure first, then fetch only the needed source ranges. Search narrows the space; targeted reads give you depth.',
            ].join('\n');
          })()
        : '';
      const contextMapMcpAddendum = needsContextMapMcp
        ? [
            '# Context Map',
            'You have read-only Context Map MCP tools (from the `agent-cockpit-context-map` server). Use them when the user asks about durable workspace entities, people, projects, workflows, decisions, tools, assets, relationships, or prior context that should be grounded in active graph data.',
            '',
            'Tools:',
            '- `entity_search(query, types?, limit?)` — search active entities by name, alias, and non-secret summary/notes/facts.',
            '- `get_entity(id, includeEvidence?)` — inspect one entity with aliases, facts, one-hop relationships, and optional evidence references.',
            '- `get_related_entities(id, depth?, relationshipTypes?, limit?)` — traverse active relationships around an entity.',
            '- `context_pack(query, maxEntities?, includeFiles?, includeConversations?)` — retrieve a compact bundle for the current request.',
            '',
            'Context Map tools are read-only. Do not try to update the map from chat; new or changed graph items are governed through Agent Cockpit review.',
          ].join('\n')
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
      const parts = [globalPrompt, wsInstructions, memoryMcpAddendum, kbMcpAddendum, contextMapMcpAddendum, fileDeliveryAddendum].filter(Boolean);
      systemPrompt = parts.join('\n\n');
    }

    if (await finalizePendingAbortIfRequested(convId, backendId, pendingMessageSend)) {
      return res.json({ userMessage: userMsg, streamReady: false, aborted: true });
    }

    const adapter = backendRegistry.get(backendId);
    if (!adapter) {
      return res.status(400).json({ error: `Unknown backend: ${backendId}` });
    }

    // Mint MCP tokens for Memory and KB Search when their respective
    // features are enabled. Both use the same pattern: session-scoped
    // bearer tokens revoked on session reset or conversation delete.
    let mcpServers: McpServerConfig[] | undefined;
    if (needsMemoryMcp && wsHashForSend) {
      const issued = memoryMcp.issueMemoryMcpSession(convId, wsHashForSend, { activeChatRuntime: runtime });
      mcpServers = issued.mcpServers;
      log.debug('Issued memory MCP token', { conversationId: convId, backend: backendId });
    }
    if (needsKbMcp && wsHashForSend) {
      const kbIssued = kbSearchMcp.issueKbSearchSession(convId, wsHashForSend);
      mcpServers = [...(mcpServers || []), ...kbIssued.mcpServers];
      log.debug('Issued KB Search MCP token', { conversationId: convId, backend: backendId });
    }
    if (needsContextMapMcp && wsHashForSend) {
      const contextMapIssued = contextMapMcp.issueContextMapMcpSession(convId, wsHashForSend);
      mcpServers = [...(mcpServers || []), ...contextMapIssued.mcpServers];
      log.debug('Issued Context Map MCP token', { conversationId: convId, backend: backendId });
    }

    if (await finalizePendingAbortIfRequested(convId, backendId, pendingMessageSend)) {
      return res.json({ userMessage: userMsg, streamReady: false, aborted: true });
    }

    log.info('Starting CLI stream', { conversationId: convId, sessionId: conv.currentSessionId, isNewSession, backend: backendId, workingDir: conv.workingDir || 'default' });
    // Re-fetch conversation so we pick up any effort downgrade triggered by a
    // model change in this same request.
    const refreshedConv = await chatService.getConversation(convId);
    if (await finalizePendingAbortIfRequested(convId, backendId, pendingMessageSend)) {
      return res.json({ userMessage: userMsg, streamReady: false, aborted: true });
    }
    const effectiveEffort = effort !== undefined
      ? (refreshedConv?.effort || undefined)
      : (conv.effort || undefined);
    const effectiveServiceTier = serviceTier !== undefined
      ? (refreshedConv?.serviceTier || undefined)
      : (conv.serviceTier || undefined);
    const sendResult = adapter.sendMessage(cliMessage, {
      sessionId: conv.currentSessionId,
      conversationId: convId,
      cliProfileId: runtime.cliProfileId || refreshedConv?.cliProfileId || conv.cliProfileId || undefined,
      cliProfile: runtime.profile,
      isNewSession,
      workingDir: conv.workingDir || null,
      systemPrompt,
      externalSessionId: conv.externalSessionId || null,
      model: model || conv.model || undefined,
      effort: effectiveEffort,
      serviceTier: effectiveServiceTier,
      mcpServers,
    });
    const needsTitleUpdate = isNewSession && conv.sessionNumber > 1;
    await attachAndPipeStream({
      convId,
      conv,
      backendId,
      runtime,
      adapter,
      sendResult,
      jobId,
      needsTitleUpdate,
      titleUpdateMessage: needsTitleUpdate ? content.trim() : null,
      model: model || conv.model || null,
      effort: effectiveEffort || null,
      serviceTier: effectiveServiceTier || null,
      logUserMessageId: userMsg?.id || null,
      logUserMessageTimestamp: userMsg?.timestamp || null,
    });
    jobHandedOff = true;

    res.json({ userMessage: userMsg, streamReady: true });
    } finally {
      if (pendingMessageSend) {
        streamSupervisor.clearPending(convId, pendingMessageSend);
      }
      if (!jobHandedOff) {
        try {
          if (pendingMessageSend) await streamSupervisor.completeJob(pendingMessageSend.jobId);
        } catch (err: unknown) {
          log.warn('Failed to delete unstarted stream job', { conversationId: convId, error: err });
        }
      }
    }
  });

  router.post('/conversations/:id/input', csrfGuard, async (req: Request, res: Response) => {
    const convId = param(req, 'id');
    let body: ReturnType<typeof validateConversationInputRequest>;
    try {
      body = validateConversationInputRequest(req.body);
    } catch (err: unknown) {
      if (isContractValidationError(err)) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
    const { text, streamActive } = body;

    const conv = await chatService.getConversation(convId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const entry = activeStreams.get(convId);
    if (streamActive && entry?.sendInput) {
      log.debug('Delivering interaction input via active stream', { conversationId: convId });
      entry.sendInput(text.trim());
      return res.json({ mode: 'stdin' });
    }

    return res.json({ mode: 'message' });
  });


  return router;
}
