// ── KB Search MCP Server ────────────────────────────────────────────────────
//
// Exposes KB search and ingestion tools to CLIs during both dreaming and
// conversation sessions via MCP.
//
// Architecture (same two-process pattern as Memory MCP):
//   1. `issueKbSearchSession(sessionKey, hash)` mints a bearer token keyed
//      by `sessionKey` (convId for conversations, workspace hash for
//      dreaming) and returns an ACP-compatible `mcpServers` config pointing
//      at `stub.cjs`.
//   2. This router mounts `POST /mcp/kb-search/call` on the chat API.
//      Each incoming call:
//        - Authorizes via `X-KB-Search-Token`.
//        - Dispatches to the requested tool handler.
//        - Returns results as JSON.
//
// Session lifecycle:
//   - Dreaming: issue at dream start, revoke in the finally block.
//   - Conversations: issue on first message send, revoke on session reset
//     or conversation delete.
//   - Each CLI call spawns a fresh stub process that dies when the CLI
//     exits.  The token outlives individual CLI invocations.

import crypto from 'crypto';
import path from 'path';
import { promises as fsp } from 'fs';
import express, { type Request, type Response } from 'express';
import type { McpServerConfig } from '../../types';
import type { KbDatabase } from '../knowledgeBase/db';
import type { KbVectorStore } from '../knowledgeBase/vectorStore';
import { embedText, resolveConfig, type EmbeddingConfig } from '../knowledgeBase/embeddings';
import type { KbIngestionService } from '../knowledgeBase/ingestion';

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
  issueKbSearchSession(sessionKey: string, hash: string): { token: string; mcpServers: McpServerConfig[] };
  revokeKbSearchSession(sessionKey: string): void;
}

// ── Constants ───────────────────────────────────────────────────────────────

const KB_SEARCH_STUB_PATH = path.resolve(__dirname, 'stub.cjs');

function mintToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

// ── Factory ─────────────────────────────────────────────────────────────────

interface CreateKbSearchMcpDeps {
  chatService: KbSearchChatService;
  kbIngestion?: KbIngestionService;
}

export function createKbSearchMcpServer(
  { chatService, kbIngestion }: CreateKbSearchMcpDeps,
): KbSearchMcpServer {
  const sessions = new Map<string, KbSearchSession>(); // token → session
  const byKey = new Map<string, string>(); // sessionKey → token

  function issueKbSearchSession(sessionKey: string, hash: string): {
    token: string;
    mcpServers: McpServerConfig[];
  } {
    // Reuse existing token for this session key if one is live.
    const cachedToken = byKey.get(sessionKey);
    const cached = cachedToken ? sessions.get(cachedToken) : undefined;
    let token: string;
    if (cached) {
      token = cached.token;
    } else {
      token = mintToken();
      sessions.set(token, { token, workspaceHash: hash, createdAt: Date.now() });
      byKey.set(sessionKey, token);
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

  function revokeKbSearchSession(sessionKey: string): void {
    const token = byKey.get(sessionKey);
    if (!token) return;
    sessions.delete(token);
    byKey.delete(sessionKey);
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

    let results;
    try {
      const embedding = (await embedText(query, cfg)).embedding;
      results = await store.hybridSearchTopics(query, embedding, limit);
    } catch {
      // Ollama unavailable — fall back to keyword-only search silently.
      console.warn('[kbSearchMcp] Ollama embedding failed for search_topics, falling back to keyword search');
      results = await store.keywordSearchTopics(query, limit);
    }
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

    try {
      const results = await store.findSimilarTopics(topicId, limit);
      return {
        topics: results.map((r) => ({
          topic_id: r.id,
          title: r.title,
          summary: r.summary,
          score: Math.round(r.score * 1000) / 1000,
        })),
      };
    } catch {
      // Pure embedding-based — no keyword fallback possible.
      console.warn('[kbSearchMcp] findSimilarTopics failed (embeddings unavailable)');
      return { topics: [] };
    }
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

    let results;
    try {
      const embedding = (await embedText(query, cfg)).embedding;
      results = await store.hybridSearchEntries(query, embedding, limit);
    } catch {
      // Ollama unavailable — fall back to keyword-only search silently.
      console.warn('[kbSearchMcp] Ollama embedding failed for search_entries, falling back to keyword search');
      results = await store.keywordSearchEntries(query, limit);
    }
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

    try {
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
    } catch {
      // Pure embedding-based — no keyword fallback possible.
      console.warn('[kbSearchMcp] findUnconnectedSimilar failed (embeddings unavailable)');
      return { topics: [] };
    }
  }

  // ── Ingestion handler ──────────────────────────────────────────────────

  /** MIME lookup by extension — covers the formats the ingestion pipeline supports. */
  const EXT_TO_MIME: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.xml': 'text/xml',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.ts': 'text/plain',
    '.js': 'text/plain',
    '.py': 'text/plain',
    '.rb': 'text/plain',
    '.go': 'text/plain',
    '.rs': 'text/plain',
    '.java': 'text/plain',
    '.c': 'text/plain',
    '.cpp': 'text/plain',
    '.h': 'text/plain',
    '.sh': 'text/plain',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };

  async function handleKbIngest(
    hash: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!kbIngestion) return { error: 'Ingestion service not available' };

    const filePath = String(args.file_path ?? '').trim();
    if (!filePath) return { error: 'file_path is required' };

    // Validate the file exists and is readable.
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return { error: `File not found or not accessible: ${filePath}` };
    }
    if (!stat.isFile()) return { error: `Path is not a file: ${filePath}` };

    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mimeType = EXT_TO_MIME[ext] || 'application/octet-stream';

    let buffer: Buffer;
    try {
      buffer = await fsp.readFile(filePath);
    } catch (err: unknown) {
      return { error: `Failed to read file: ${(err as Error).message}` };
    }

    try {
      const result = await kbIngestion.enqueueUpload(hash, {
        buffer,
        filename,
        mimeType,
        folderPath: 'conversation-documents',
      });
      return {
        ok: true,
        raw_id: result.entry.rawId,
        filename: result.entry.filename,
        deduped: result.deduped,
      };
    } catch (err: unknown) {
      return { error: `Ingestion failed: ${(err as Error).message}` };
    }
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
    kb_ingest: handleKbIngest,
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
