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
import { extractMediaFiles, extractSourceRange } from '../knowledgeBase/sourceRange';
import { expandGlossaryQuery } from '../knowledgeBase/glossary';

// ── Types ───────────────────────────────────────────────────────────────────

interface KbSearchSession {
  token: string;
  workspaceHash: string;
  createdAt: number;
}

/** Subset of ChatService used by KB Search MCP. */
export interface KbSearchChatService {
  getKbDb(hash: string): KbDatabase | null;
  getKbConvertedDir(hash: string): string;
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
const MAX_SOURCE_RANGE_UNITS = 25;
const MAX_SOURCE_RANGE_CHARS = 80_000;
const DEFAULT_DOCUMENT_LIMIT = 20;
const MAX_DOCUMENT_LIMIT = 100;
const DEFAULT_STRUCTURE_NODE_LIMIT = 200;
const MAX_STRUCTURE_NODE_LIMIT = 500;
const CONFIDENCE_RANK: Record<string, number> = {
  extracted: 0,
  inferred: 1,
  speculative: 2,
};

function mintToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function neighborhoodScore(
  distance: number,
  path: Array<{ confidence: string }>,
  isGodNode: boolean,
): number {
  const confidenceFactor = path.reduce((factor, edge) => {
    const rank = CONFIDENCE_RANK[edge.confidence] ?? CONFIDENCE_RANK.speculative;
    return factor * (rank === 0 ? 1 : rank === 1 ? 0.85 : 0.6);
  }, 1);
  const distanceFactor = 1 / Math.max(1, distance);
  const godPenalty = isGodNode ? 0.5 : 1;
  return distanceFactor * confidenceFactor * godPenalty;
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

  function expandSearchQuery(hash: string, query: string) {
    const db = chatService.getKbDb(hash);
    const glossary = db && typeof db.listGlossary === 'function' ? db.listGlossary() : [];
    return expandGlossaryQuery(query, glossary);
  }

  function queryTrace(expansion: ReturnType<typeof expandGlossaryQuery>): Record<string, unknown> {
    if (expansion.matches.length === 0) return { query: expansion.originalQuery };
    return {
      query: expansion.originalQuery,
      expanded_query: expansion.expandedQuery,
      glossary_matches: expansion.matches,
    };
  }

  // ── Tool handlers ───────────────────────────────────────────────────────

  async function handleSearchTopics(
    hash: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const query = String(args.query ?? '');
    const limit = Number(args.limit) || 10;
    if (!query) return { topics: [] };
    const expansion = expandSearchQuery(hash, query);
    const searchQuery = expansion.expandedQuery;

    const cfg = await chatService.getWorkspaceKbEmbeddingConfig(hash);
    if (!cfg) return { topics: [], warning: 'No embedding config', ...queryTrace(expansion) };
    const resolved = resolveConfig(cfg);

    const store = await chatService.getKbVectorStore(hash, resolved.dimensions);
    if (!store) return { topics: [], warning: 'Vector store unavailable', ...queryTrace(expansion) };

    let results;
    try {
      const embedding = (await embedText(searchQuery, cfg)).embedding;
      results = await store.hybridSearchTopics(searchQuery, embedding, limit);
    } catch {
      // Ollama unavailable — fall back to keyword-only search silently.
      console.warn('[kbSearchMcp] Ollama embedding failed for search_topics, falling back to keyword search');
      results = await store.keywordSearchTopics(searchQuery, limit);
    }
    return {
      ...queryTrace(expansion),
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
    const expansion = expandSearchQuery(hash, query);
    const searchQuery = expansion.expandedQuery;

    const cfg = await chatService.getWorkspaceKbEmbeddingConfig(hash);
    if (!cfg) return { entries: [], warning: 'No embedding config', ...queryTrace(expansion) };
    const resolved = resolveConfig(cfg);

    const store = await chatService.getKbVectorStore(hash, resolved.dimensions);
    if (!store) return { entries: [], warning: 'Vector store unavailable', ...queryTrace(expansion) };

    let results;
    try {
      const embedding = (await embedText(searchQuery, cfg)).embedding;
      results = await store.hybridSearchEntries(searchQuery, embedding, limit);
    } catch {
      // Ollama unavailable — fall back to keyword-only search silently.
      console.warn('[kbSearchMcp] Ollama embedding failed for search_entries, falling back to keyword search');
      results = await store.keywordSearchEntries(searchQuery, limit);
    }
    return {
      ...queryTrace(expansion),
      entries: results.map((r) => ({
        entry_id: r.id,
        title: r.title,
        summary: r.summary,
        score: Math.round(r.score * 1000) / 1000,
      })),
    };
  }

  async function handleListDocuments(
    hash: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const db = chatService.getKbDb(hash);
    if (!db) return { documents: [], error: 'KB database unavailable' };
    const query = String(args.query ?? '').trim();
    const limit = boundedInteger(args.limit, DEFAULT_DOCUMENT_LIMIT, 1, MAX_DOCUMENT_LIMIT);
    return {
      documents: db.listDocuments({ query, limit }).map((d) => ({
        raw_id: d.rawId,
        doc_name: d.docName,
        doc_description: d.docDescription,
        unit_type: d.unitType,
        unit_count: d.unitCount,
        structure_status: d.structureStatus,
        updated_at: d.updatedAt,
      })),
    };
  }

  async function handleGetDocumentStructure(
    hash: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const rawId = String(args.raw_id ?? '');
    if (!rawId) return { error: 'raw_id is required' };
    const db = chatService.getKbDb(hash);
    if (!db) return { error: 'KB database unavailable' };
    const document = db.getDocument(rawId);
    if (!document) return { error: `Document "${rawId}" not found` };
    const allNodes = db.listDocumentNodes(rawId);
    const offset = boundedInteger(args.offset, 0, 0, Math.max(0, allNodes.length));
    const limit = boundedInteger(args.limit, DEFAULT_STRUCTURE_NODE_LIMIT, 1, MAX_STRUCTURE_NODE_LIMIT);
    const nodes = allNodes.slice(offset, offset + limit);
    return {
      document: {
        raw_id: document.rawId,
        doc_name: document.docName,
        doc_description: document.docDescription,
        unit_type: document.unitType,
        unit_count: document.unitCount,
        structure_status: document.structureStatus,
        structure_error: document.structureError,
      },
      nodes: nodes.map((n) => ({
        node_id: n.nodeId,
        parent_node_id: n.parentNodeId,
        title: n.title,
        summary: n.summary,
        start_unit: n.startUnit,
        end_unit: n.endUnit,
        sort_order: n.sortOrder,
        source: n.source,
        metadata: n.metadata,
      })),
      node_count: allNodes.length,
      offset,
      limit,
      truncated: offset + nodes.length < allNodes.length,
    };
  }

  async function handleGetSourceRange(
    hash: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const rawId = String(args.raw_id ?? '');
    const startUnit = Number(args.start_unit);
    const endUnit = Number(args.end_unit);
    if (!rawId) return { error: 'raw_id is required' };
    if (!Number.isInteger(startUnit) || !Number.isInteger(endUnit) || startUnit < 1 || endUnit < startUnit) {
      return { error: 'start_unit and end_unit must be positive integers with end_unit >= start_unit' };
    }
    if (endUnit - startUnit + 1 > MAX_SOURCE_RANGE_UNITS) {
      return { error: `Requested range is too large; max ${MAX_SOURCE_RANGE_UNITS} units` };
    }

    const db = chatService.getKbDb(hash);
    if (!db) return { error: 'KB database unavailable' };
    const document = db.getDocument(rawId);
    if (!document) return { error: `Document "${rawId}" not found` };
    if (endUnit > document.unitCount) {
      return { error: `Requested range exceeds document unit_count ${document.unitCount}` };
    }

    const textPath = path.join(chatService.getKbConvertedDir(hash), rawId, 'text.md');
    let text: string;
    try {
      text = await fsp.readFile(textPath, 'utf8');
    } catch {
      return { error: `Converted text not found for raw "${rawId}"` };
    }

    const extracted = extractSourceRange(text, document.unitType, startUnit, endUnit);
    if (!extracted) return { error: `Could not extract ${document.unitType} range ${startUnit}-${endUnit}` };
    const truncated = extracted.length > MAX_SOURCE_RANGE_CHARS;
    const markdown = truncated ? extracted.slice(0, MAX_SOURCE_RANGE_CHARS) : extracted;

    return {
      raw_id: rawId,
      unit_type: document.unitType,
      start_unit: startUnit,
      end_unit: endUnit,
      markdown,
      media_files: extractMediaFiles(markdown),
      truncated,
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

  async function handleGetTopicNeighborhood(
    hash: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const topicId = String(args.topic_id ?? '');
    if (!topicId) return { error: 'topic_id is required' };
    const depthArg = Number(args.depth);
    const limitArg = Number(args.limit);
    const depth = Math.min(2, Math.max(1, Number.isInteger(depthArg) ? depthArg : 1));
    const limit = Math.max(1, Math.min(50, Number.isInteger(limitArg) ? limitArg : 10));
    const minConfidence = String(args.min_confidence ?? 'inferred');
    const maxRank = CONFIDENCE_RANK[minConfidence] ?? CONFIDENCE_RANK.inferred;
    const includeEntries = Boolean(args.include_entries);

    const db = chatService.getKbDb(hash);
    if (!db) return { error: 'KB database unavailable' };

    const seed = db.getTopic(topicId);
    if (!seed) return { error: `Topic "${topicId}" not found` };

    const allConnections = db
      .listAllConnections()
      .filter((c) => (CONFIDENCE_RANK[c.confidence] ?? CONFIDENCE_RANK.speculative) <= maxRank);
    const adjacency = new Map<string, typeof allConnections>();
    for (const edge of allConnections) {
      const sourceList = adjacency.get(edge.sourceTopic) ?? [];
      sourceList.push(edge);
      adjacency.set(edge.sourceTopic, sourceList);
      const targetList = adjacency.get(edge.targetTopic) ?? [];
      targetList.push(edge);
      adjacency.set(edge.targetTopic, targetList);
    }

    const godNodes = new Set(db.detectGodNodes());
    const queue: Array<{ topicId: string; distance: number; path: typeof allConnections }> = [
      { topicId, distance: 0, path: [] },
    ];
    const visited = new Set<string>([topicId]);
    const found: Array<{ topicId: string; distance: number; path: typeof allConnections; score: number }> = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.distance >= depth) continue;
      for (const edge of adjacency.get(current.topicId) ?? []) {
        const nextTopic = edge.sourceTopic === current.topicId ? edge.targetTopic : edge.sourceTopic;
        if (visited.has(nextTopic)) continue;
        visited.add(nextTopic);
        const nextPath = [...current.path, edge];
        const distance = current.distance + 1;
        const score = neighborhoodScore(distance, nextPath, godNodes.has(nextTopic));
        found.push({ topicId: nextTopic, distance, path: nextPath, score });
        queue.push({ topicId: nextTopic, distance, path: nextPath });
      }
    }

    const topics = found
      .map((item) => {
        const topic = db.getTopic(item.topicId);
        if (!topic) return null;
        const out: Record<string, unknown> = {
          topic_id: topic.topicId,
          title: topic.title,
          summary: topic.summary,
          distance: item.distance,
          score: Math.round(item.score * 1000) / 1000,
          path: item.path.map((edge) => ({
            source_topic: edge.sourceTopic,
            target_topic: edge.targetTopic,
            relationship: edge.relationship,
            confidence: edge.confidence,
          })),
        };
        if (includeEntries) {
          out.entries = db.listTopicEntryIds(topic.topicId).map((eid) => {
            const entry = db.getEntry(eid);
            return { entry_id: eid, title: entry?.title ?? eid };
          });
        }
        return out;
      })
      .filter((item): item is Record<string, unknown> => item !== null)
      .sort((a, b) =>
        Number(a.distance) - Number(b.distance)
        || Number(b.score) - Number(a.score)
        || String(a.title).localeCompare(String(b.title)))
      .slice(0, limit);

    return {
      seed_topic: {
        topic_id: seed.topicId,
        title: seed.title,
        summary: seed.summary,
      },
      topics,
    };
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
    get_topic_neighborhood: handleGetTopicNeighborhood,
    find_similar_topics: handleFindSimilarTopics,
    find_unconnected_similar: handleFindUnconnectedSimilar,
    search_entries: handleSearchEntries,
    list_documents: handleListDocuments,
    get_document_structure: handleGetDocumentStructure,
    get_source_range: handleGetSourceRange,
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
