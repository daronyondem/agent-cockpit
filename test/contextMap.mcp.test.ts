import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import http from 'http';
import { createContextMapMcpServer, CONTEXT_MAP_MCP_STUB_PATH, type ContextMapChatService } from '../src/services/contextMap/mcp';
import { ContextMapDatabase } from '../src/services/contextMap/db';

const NOW = '2026-05-07T20:00:00.000Z';
const TEST_HTTP_HOST = '127.0.0.1';
const TEST_HTTP_TIMEOUT_MS = 2000;

let tmpDir: string;
let db: ContextMapDatabase;
let server: http.Server | null;
let baseUrl: string;

function makeChatService(enabled = true): ContextMapChatService {
  return {
    getContextMapDb: jest.fn().mockReturnValue(db),
    getWorkspaceContextMapEnabled: jest.fn().mockResolvedValue(enabled),
  };
}

function seedGraph() {
  db.insertEntity({
    entityId: 'ent-project',
    typeSlug: 'project',
    name: 'Context Map',
    summaryMarkdown: 'Workspace graph feature.',
    notesMarkdown: 'Reviewed map notes.',
    confidence: 0.92,
    now: NOW,
  });
  db.addAlias('ent-project', 'CM', NOW);
  db.insertFact({
    factId: 'fact-project',
    entityId: 'ent-project',
    statementMarkdown: 'Context Map uses approval review before active graph writes.',
    confidence: 0.88,
    now: NOW,
  });

  db.insertEntity({
    entityId: 'ent-workflow',
    typeSlug: 'workflow',
    name: 'Review Workflow',
    summaryMarkdown: 'Approves candidate changes.',
    confidence: 0.8,
    now: NOW,
  });
  db.insertRelationship({
    relationshipId: 'rel-project-workflow',
    subjectEntityId: 'ent-project',
    predicate: 'uses',
    objectEntityId: 'ent-workflow',
    confidence: 0.77,
    now: NOW,
  });

  const conversationEvidence = db.upsertEvidenceRef({
    evidenceId: 'ev-conversation',
    sourceType: 'conversation_message',
    sourceId: 'conv-1',
    locator: { startMessageId: 'm1', endMessageId: 'm2' },
    excerpt: 'Conversation excerpt.',
    now: NOW,
  });
  const fileEvidence = db.upsertEvidenceRef({
    evidenceId: 'ev-file',
    sourceType: 'file',
    sourceId: '/tmp/spec.md',
    locator: { line: 12 },
    excerpt: 'File excerpt.',
    now: NOW,
  });
  db.linkEvidence('entity', 'ent-project', conversationEvidence.evidenceId, NOW);
  db.linkEvidence('entity', 'ent-project', fileEvidence.evidenceId, NOW);
  db.linkEvidence('fact', 'fact-project', conversationEvidence.evidenceId, NOW);
  db.linkEvidence('relationship', 'rel-project-workflow', conversationEvidence.evidenceId, NOW);
}

function buildAndListen(chatService: ContextMapChatService) {
  const mcp = createContextMapMcpServer({ chatService });
  const app = express();
  app.use(express.json());
  app.use('/mcp', mcp.router);
  return new Promise<{ mcp: typeof mcp; close: () => Promise<void> }>((resolve) => {
    server = app.listen(0, TEST_HTTP_HOST, () => {
      const addr = server!.address() as { port: number };
      baseUrl = `http://${TEST_HTTP_HOST}:${addr.port}`;
      const close = () => new Promise<void>((done) => server!.close(() => done()));
      resolve({ mcp, close });
    });
  });
}

function request(body: unknown, token?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL('/mcp/context-map/call', baseUrl);
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(token ? { 'x-context-map-token': token } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.setTimeout(TEST_HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`Timed out after ${TEST_HTTP_TIMEOUT_MS}ms waiting for POST ${url.pathname} on ${baseUrl}`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-map-mcp-'));
  db = new ContextMapDatabase(path.join(tmpDir, 'state.db'));
  seedGraph();
  server = null;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('contextMapMcp session lifecycle', () => {
  test('returns a token and MCP server config pointing at the stub', () => {
    const mcp = createContextMapMcpServer({ chatService: makeChatService() });
    const first = mcp.issueContextMapMcpSession('conv-a', 'hash-a');
    const second = mcp.issueContextMapMcpSession('conv-a', 'hash-a');

    expect(first.token).toBeTruthy();
    expect(second.token).toBe(first.token);
    expect(first.mcpServers).toHaveLength(1);
    expect(first.mcpServers[0].name).toBe('agent-cockpit-context-map');
    expect(first.mcpServers[0].command).toBe('node');
    expect(first.mcpServers[0].args).toEqual([CONTEXT_MAP_MCP_STUB_PATH]);
    expect(first.mcpServers[0].env).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'CONTEXT_MAP_TOKEN', value: first.token }),
      expect.objectContaining({ name: 'CONTEXT_MAP_ENDPOINT' }),
    ]));
  });

  test('stub exposes the read-only Context Map tools', () => {
    const stub = fs.readFileSync(CONTEXT_MAP_MCP_STUB_PATH, 'utf8');
    expect(stub).toContain("name: 'entity_search'");
    expect(stub).toContain("name: 'get_entity'");
    expect(stub).toContain("name: 'get_related_entities'");
    expect(stub).toContain("name: 'context_pack'");
  });

  test('revocation invalidates the token', async () => {
    const { mcp, close } = await buildAndListen(makeChatService());
    const session = mcp.issueContextMapMcpSession('conv-a', 'hash-a');

    const before = await request({ tool: 'entity_search', arguments: { query: 'Context Map' } }, session.token);
    expect(before.status).toBe(200);

    mcp.revokeContextMapMcpSession('conv-a');
    const after = await request({ tool: 'entity_search', arguments: { query: 'Context Map' } }, session.token);
    expect(after.status).toBe(401);

    await close();
    server = null;
  });
});

describe('POST /mcp/context-map/call', () => {
  test('rejects missing tokens and disabled workspaces', async () => {
    const enabled = await buildAndListen(makeChatService(true));
    const noToken = await request({ tool: 'entity_search', arguments: { query: 'Context Map' } });
    expect(noToken.status).toBe(401);
    await enabled.close();
    server = null;

    const disabled = await buildAndListen(makeChatService(false));
    const session = disabled.mcp.issueContextMapMcpSession('conv-disabled', 'hash-disabled');
    const res = await request({ tool: 'entity_search', arguments: { query: 'Context Map' } }, session.token);
    expect(res.status).toBe(403);
    await disabled.close();
    server = null;
  });

  test('entity_search searches active names, aliases, and facts', async () => {
    const { mcp, close } = await buildAndListen(makeChatService());
    const session = mcp.issueContextMapMcpSession('conv-search', 'hash-search');

    const byAlias = await request({ tool: 'entity_search', arguments: { query: 'CM' } }, session.token);
    expect(byAlias.status).toBe(200);
    expect(byAlias.body.entities[0]).toMatchObject({
      entity_id: 'ent-project',
      name: 'Context Map',
      aliases: ['CM'],
    });

    const byFact = await request({ tool: 'entity_search', arguments: { query: 'approval', types: ['project'] } }, session.token);
    expect(byFact.status).toBe(200);
    expect(byFact.body.entities.map((entity: any) => entity.entity_id)).toEqual(['ent-project']);

    await close();
    server = null;
  });

  test('entity_search does not match hidden secret-pointer summary content', async () => {
    db.insertEntity({
      entityId: 'ent-secret',
      typeSlug: 'asset',
      name: 'Secret Pointer',
      summaryMarkdown: 'Hidden launch code phrase.',
      notesMarkdown: 'Hidden private notes.',
      sensitivity: 'secret-pointer',
      now: NOW,
    });
    const { mcp, close } = await buildAndListen(makeChatService());
    const session = mcp.issueContextMapMcpSession('conv-secret-search', 'hash-secret-search');

    const hidden = await request({ tool: 'entity_search', arguments: { query: 'launch code' } }, session.token);
    const byName = await request({ tool: 'entity_search', arguments: { query: 'Secret Pointer' } }, session.token);

    expect(hidden.status).toBe(200);
    expect(hidden.body.entities).toEqual([]);
    expect(byName.status).toBe(200);
    expect(byName.body.entities).toEqual([
      expect.objectContaining({
        entity_id: 'ent-secret',
        name: 'Secret Pointer',
        summary: null,
      }),
    ]);

    await close();
    server = null;
  });

  test('get_entity returns facts, relationships, and optional evidence', async () => {
    const { mcp, close } = await buildAndListen(makeChatService());
    const session = mcp.issueContextMapMcpSession('conv-get', 'hash-get');

    const res = await request({
      tool: 'get_entity',
      arguments: { id: 'ent-project', includeEvidence: true },
    }, session.token);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      entity_id: 'ent-project',
      aliases: ['CM'],
      facts: [
        expect.objectContaining({
          fact_id: 'fact-project',
          evidence: [expect.objectContaining({ evidence_id: 'ev-conversation' })],
        }),
      ],
      relationships: [
        expect.objectContaining({
          relationship_id: 'rel-project-workflow',
          predicate: 'uses',
          direction: 'outgoing',
          other_entity: expect.objectContaining({ entity_id: 'ent-workflow' }),
        }),
      ],
      evidence: expect.arrayContaining([
        expect.objectContaining({ evidence_id: 'ev-conversation' }),
        expect.objectContaining({ evidence_id: 'ev-file' }),
      ]),
    });

    await close();
    server = null;
  });

  test('get_related_entities traverses active relationships', async () => {
    const { mcp, close } = await buildAndListen(makeChatService());
    const session = mcp.issueContextMapMcpSession('conv-related', 'hash-related');

    const res = await request({
      tool: 'get_related_entities',
      arguments: { id: 'ent-project', relationshipTypes: ['uses'], depth: 1 },
    }, session.token);

    expect(res.status).toBe(200);
    expect(res.body.related).toEqual([
      expect.objectContaining({
        distance: 1,
        entity: expect.objectContaining({ entity_id: 'ent-workflow' }),
        via: expect.objectContaining({ predicate: 'uses' }),
      }),
    ]);

    await close();
    server = null;
  });

  test('context_pack returns compact details and filters evidence sources', async () => {
    const { mcp, close } = await buildAndListen(makeChatService());
    const session = mcp.issueContextMapMcpSession('conv-pack', 'hash-pack');

    const res = await request({
      tool: 'context_pack',
      arguments: { query: 'Context Map', maxEntities: 1, includeConversations: false },
    }, session.token);

    expect(res.status).toBe(200);
    expect(res.body.entities).toHaveLength(1);
    expect(res.body.entities[0]).toMatchObject({
      entity_id: 'ent-project',
      facts: [
        expect.objectContaining({
          fact_id: 'fact-project',
          evidence: [],
        }),
      ],
      evidence: [expect.objectContaining({ evidence_id: 'ev-file' })],
    });

    await close();
    server = null;
  });
});
