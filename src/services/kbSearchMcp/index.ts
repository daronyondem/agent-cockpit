// ── KB Search MCP Server ────────────────────────────────────────────────────
//
// Exposes search tools to CLIs during dreaming so the synthesis step can
// dynamically search and fetch topic/entry data via MCP instead of reading
// flat file dumps.
//
// Architecture (same two-process pattern as Memory MCP):
//   1. `issueKbSearchSession(hash)` mints a per-dream-run bearer token and
//      returns an ACP-compatible `mcpServers` config pointing at `stub.cjs`.
//   2. This router mounts `POST /mcp/kb-search/call` on the chat API.
//      Each incoming call:
//        - Authorizes via `X-KB-Search-Token`.
//        - Dispatches to the requested tool handler.
//        - Returns results as JSON.
//
// Session lifecycle:
//   - Issue at dream start, revoke in the finally block.
//   - Each `runOneShot` CLI call spawns a fresh stub process that dies when
//     the CLI exits.  The token outlives individual CLI invocations.

import crypto from 'crypto';
import path from 'path';
import express, { type Request, type Response } from 'express';
import type { McpServerConfig } from '../../types';
import type { KbDatabase } from '../knowledgeBase/db';
import type { KbVectorStore } from '../knowledgeBase/vectorStore';
import { embedText, resolveConfig, type EmbeddingConfig } from '../knowledgeBase/embeddings';

// ── Types ───────────────────────────────────────────────────────────────────

interface KbSearchSession {
  token: string;
  workspaceHash: string;
  createdAt: number;
}

/** Subset of ChatService used by KB Search MCP. */
export interface KbSearchChatService {
  getKbDb(hash: string): KbDatabase | null;
  getKbVectorStore(hash: string, dimensions?: number): Promise<KbVectorStore | null>;
  getWorkspaceKbEmbeddingConfig(hash: string): Promise<EmbeddingConfig | undefined>;
}

export interface KbSearchMcpServer {
  router: express.Router;
  issueKbSearchSession(hash: string): { token: string; mcpServers: McpServerConfig[] };
  revokeKbSearchSession(hash: string): void;
}

// ── Constants ───────────────────────────────────────────────────────────────

const KB_SEARCH_STUB_PATH = path.resolve(__dirname, 'stub.cjs');

function mintToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

// ── Factory ─────────────────────────────────────────────────────────────────

interface CreateKbSearchMcpDeps {
  chatService: KbSearchChatService;
}

export function createKbSearchMcpServer(
  { chatService }: CreateKbSearchMcpDeps,
): KbSearchMcpServer {
  const sessions = new Map<string, KbSearchSession>(); // token → session
  const byWorkspace = new Map<string, string>(); // hash → token

  function issueKbSearchSession(hash: string): {
    token: string;
    mcpServers: McpServerConfig[];
  } {
    // Reuse existing token for this workspace if one is live.
    const cachedToken = byWorkspace.get(hash);
    const cached = cachedToken ? sessions.get(cachedToken) : undefined;
    let token: string;
    if (cached) {
      token = cached.token;
    } else {
      token = mintToken();
      sessions.set(token, { token, workspaceHash: hash, createdAt: Date.now() });
      byWorkspace.set(hash, token);
    }

    const port = Number(process.env.PORT) || 3334;
    const endpoint = `http://127.0.0.1:${port}/api/chat/mcp/kb-search/call`;

    return {
      token,
      mcpServers: [
        {
          name: 'agent-cockpit-kb-search',
          command: 'node',
          args: [KB_SEARCH_STUB_PATH],
          env: [
            { name: 'KB_SEARCH_TOKEN', value: token },
            { name: 'KB_SEARCH_ENDPOINT', value: endpoint },
          ],
        },
      ],
    };
  }

  function revokeKbSearchSession(hash: string): void {
    const token = byWorkspace.get(hash);
    if (!token) return;
    sessions.delete(token);
    byWorkspace.delete(hash);
  }

  // ── Tool handlers ───────────────────────────────────────────────────────

  async function handleSearchTopics(
    hash: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const query = String(args.query ?? '');
    const limit = Number(args.limit) || 10;
    if (!query) return { topics: [] };

    const cfg = await chatService.getWorkspaceKbEmbeddingConfig(hash);
    if (!cfg) return { topics: [], warning: 'No embedding config' };
    const resolved = resolveConfig(cfg);

    const store = await chatService.getKbVectorStore(hash, resolved.dimensions);
    if (!store) return { topics: [], warning: 'Vector store unavailable' };

    const embedding = (await embedText(query, cfg)).embedding;
    const results = await store.hybridSearchTopics(query, embedding, limit);
    return {
      topics: results.map((r) => ({
        topic_id: r.id,
        title: r.title,
        summary: r.summary,
        score: Math.round(r.score * 1000) / 1000,
      })),
    };
  }

  async function handleGetTopic(
    hash: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const topicId = String(args.topic_id ?? '');
    if (!topicId) return { error: 'topic_id is required' };

    const db = chatService.getKbDb(hash);
    if (!db) return { error: 'KB database unavailable' };

    const topic = db.getTopic(topicId);
    if (!topic) return { error: `Topic "${topicId}" not found` };

    const connections = db.listConnectionsForTopic(topicId);
    const entryIds = db.listTopicEntryIds(topicId);
    const entries = entryIds.map((eid) => {
      const entry = db.getEntry(eid);
      return { entry_id: eid, title: entry?.title ?? eid };
    });

    return {
      topic_id: topic.topicId,
      title: topic.title,
      summary: topic.summary,
      content: topic.content,
      entry_count: topic.entryCount,
      connection_count: topic.connectionCount,
      connections: connections.map((c) => ({
        source_topic: c.sourceTopic,
        target_topic: c.targetTopic,
        relationship: c.relationship,
        confidence: c.confidence,
      })),
      entries,
    };
  }

  async function handleFindSimilarTopics(
    hash: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const topicId = String(args.topic_id ?? '');
    const limit = Number(args.limit) || 10;
    if (!topicId) return { topics: [], error: 'topic_id is required' };

    const cfg = await chatService.getWorkspaceKbEmbeddingConfig(hash);
    if (!cfg) return { topics: [], warning: 'No embedding config' };
    const resolved = resolveConfig(cfg);

    const store = await chatService.getKbVectorStore(hash, resolved.dimensions);
    if (!store) return { topics: [], warning: 'Vector store unavailable' };

    const results = await store.findSimilarTopics(topicId, limit);
    return {
      topics: results.map((r) => ({
        topic_id: r.id,
        title: r.title,
        summary: r.summary,
        score: Math.round(r.score * 1000) / 1000,
      })),
    };
  }

  async function handleSearchEntries(
    hash: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const query = String(args.query ?? '');
    const limit = Number(args.limit) || 10;
    if (!query) return { entries: [] };

    const cfg = await chatService.getWorkspaceKbEmbeddingConfig(hash);
    if (!cfg) return { entries: [], warning: 'No embedding config' };
    const resolved = resolveConfig(cfg);

    const store = await chatService.getKbVectorStore(hash, resolved.dimensions);
    if (!store) return { entries: [], warning: 'Vector store unavailable' };

    const embedding = (await embedText(query, cfg)).embedding;
    const results = await store.hybridSearchEntries(query, embedding, limit);
    return {
      entries: results.map((r) => ({
        entry_id: r.id,
        title: r.title,
        summary: r.summary,
        score: Math.round(r.score * 1000) / 1000,
      })),
    };
  }

  async function handleFindUnconnectedSimilar(
    hash: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const topicId = String(args.topic_id ?? '');
    const limit = Number(args.limit) || 10;
    if (!topicId) return { topics: [], error: 'topic_id is required' };

    const db = chatService.getKbDb(hash);
    if (!db) return { topics: [], error: 'KB database unavailable' };

    const cfg = await chatService.getWorkspaceKbEmbeddingConfig(hash);
    if (!cfg) return { topics: [], warning: 'No embedding config' };
    const resolved = resolveConfig(cfg);

    const store = await chatService.getKbVectorStore(hash, resolved.dimensions);
    if (!store) return { topics: [], warning: 'Vector store unavailable' };

    const similar = await store.findSimilarTopics(topicId, limit + 20);
    const existingConns = db.listConnectionsForTopic(topicId);
    const connectedIds = new Set<string>();
    for (const c of existingConns) {
      connectedIds.add(c.sourceTopic);
      connectedIds.add(c.targetTopic);
    }

    const unconnected = similar
      .filter((r) => !connectedIds.has(r.id))
      .slice(0, limit);

    return {
      topics: unconnected.map((r) => ({
        topic_id: r.id,
        title: r.title,
        summary: r.summary,
        score: Math.round(r.score * 1000) / 1000,
      })),
    };
  }

  // ── Router ────────────────────────────────────────────────────────────────

  const TOOL_HANDLERS: Record<
    string,
    (hash: string, args: Record<string, unknown>) => Promise<unknown>
  > = {
    search_topics: handleSearchTopics,
    get_topic: handleGetTopic,
    find_similar_topics: handleFindSimilarTopics,
    find_unconnected_similar: handleFindUnconnectedSimilar,
    search_entries: handleSearchEntries,
  };

  const router = express.Router();

  router.post('/kb-search/call', async (req: Request, res: Response) => {
    const token = req.header('x-kb-search-token') || '';
    const session = token ? sessions.get(token) : null;
    if (!session) {
      return res.status(401).json({ error: 'Invalid or missing KB search token' });
    }

    const { tool, arguments: args } = (req.body || {}) as {
      tool?: string;
      arguments?: Record<string, unknown>;
    };

    if (!tool || !TOOL_HANDLERS[tool]) {
      return res.status(400).json({ error: `Unknown tool: ${tool}` });
    }

    try {
      const result = await TOOL_HANDLERS[tool](session.workspaceHash, args ?? {});
      return res.json(result);
    } catch (err) {
      console.error(`[kbSearchMcp] ${tool} failed:`, (err as Error).message);
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  return { router, issueKbSearchSession, revokeKbSearchSession };
}
