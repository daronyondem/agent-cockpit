#!/usr/bin/env node
/**
 * Agent Cockpit Context Map MCP stdio shim.
 *
 * Spawned by CLIs as a read-only MCP server. Implements the minimal MCP
 * protocol subset (`initialize`, `tools/list`, `tools/call`) and forwards tool
 * calls to the cockpit HTTP endpoint.
 *
 * Environment variables:
 *   CONTEXT_MAP_TOKEN    — per-session bearer token issued by the cockpit
 *   CONTEXT_MAP_ENDPOINT — full URL, e.g.
 *                          http://127.0.0.1:3334/api/chat/mcp/context-map/call
 */

'use strict';

const readline = require('readline');
const http = require('http');
const https = require('https');

const TOKEN = process.env.CONTEXT_MAP_TOKEN || '';
const ENDPOINT = process.env.CONTEXT_MAP_ENDPOINT || '';

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function log(msg) {
  process.stderr.write('[contextMapMcp.stub] ' + msg + '\n');
}

const TOOLS = [
  {
    name: 'entity_search',
    description:
      'Search reviewed Context Map entities by name, alias, summary, notes, and active facts. ' +
      'Returns compact entity cards sorted by local relevance.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language or keyword search query.' },
        types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional entity type slugs to include, such as project, workflow, person, or decision.',
        },
        limit: { type: 'number', description: 'Max entities to return (default 10, max 50).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_entity',
    description:
      'Read one reviewed Context Map entity by ID, including aliases, active facts, and one-hop relationships.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Context Map entity ID.' },
        includeEvidence: { type: 'boolean', description: 'Include supporting evidence references.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_related_entities',
    description:
      'Traverse reviewed Context Map relationships around an entity. Use this to inspect connected projects, people, decisions, workflows, tools, and concepts.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Seed Context Map entity ID.' },
        depth: { type: 'number', description: 'Traversal depth, capped at 2 (default 1).' },
        relationshipTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional relationship predicates to include.',
        },
        limit: { type: 'number', description: 'Max related entities to return (default 10, max 50).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'context_pack',
    description:
      'Build a compact Context Map bundle for a query. Includes top entities, facts, relationships, and evidence references.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language or keyword query.' },
        maxEntities: { type: 'number', description: 'Max entities to include (default 5, max 10).' },
        includeFiles: { type: 'boolean', description: 'Include file evidence references (default true).' },
        includeConversations: { type: 'boolean', description: 'Include conversation evidence references (default true).' },
      },
      required: ['query'],
    },
  },
];

const VALID_TOOLS = new Set(TOOLS.map((t) => t.name));

function postToolCall(tool, args) {
  return new Promise((resolve, reject) => {
    if (!ENDPOINT || !TOKEN) {
      return reject(new Error('CONTEXT_MAP_ENDPOINT and CONTEXT_MAP_TOKEN must be set'));
    }
    let url;
    try {
      url = new URL(ENDPOINT);
    } catch (err) {
      return reject(new Error('Invalid CONTEXT_MAP_ENDPOINT: ' + err.message));
    }
    const payload = JSON.stringify({ tool, arguments: args });
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Context-Map-Token': TOKEN,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          let data;
          try {
            data = body ? JSON.parse(body) : {};
          } catch {
            data = { error: body || 'unparseable response' };
          }
          resolve({ status: res.statusCode || 0, data });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function handleToolCall(id, params) {
  const toolName = params && params.name;
  const toolArgs = (params && params.arguments) || {};
  if (!VALID_TOOLS.has(toolName)) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool: ' + toolName } });
    return;
  }
  try {
    const { status, data } = await postToolCall(toolName, toolArgs);
    if (status >= 200 && status < 300) {
      const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } else {
      const errText = 'Context Map failed (HTTP ' + status + '): ' + (data && data.error ? data.error : 'unknown error');
      log(errText);
      send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: errText }] } });
    }
  } catch (err) {
    log('Exception: ' + err.message);
    send({
      jsonrpc: '2.0',
      id,
      result: {
        isError: true,
        content: [{ type: 'text', text: 'Context Map failed: ' + err.message }],
      },
    });
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (rawLine) => {
  const line = rawLine.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-cockpit-context-map', version: '0.1.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    await handleToolCall(id, params);
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
});

rl.on('close', () => process.exit(0));
