#!/usr/bin/env node
/**
 * Agent Cockpit KB Search MCP stdio shim.
 *
 * Spawned by CLIs during dreaming and conversation sessions as an MCP
 * server.  Implements the minimal MCP protocol subset (`initialize`,
 * `tools/list`, `tools/call`) and forwards tool calls to the cockpit's
 * HTTP endpoint.
 *
 * Environment variables:
 *   KB_SEARCH_TOKEN    — per-session bearer token issued by the cockpit
 *   KB_SEARCH_ENDPOINT — full URL, e.g.
 *                        http://127.0.0.1:3335/chat/api/chat/mcp/kb-search/call
 *
 * Dependency-free CommonJS — can be spawned with `node stub.cjs` anywhere.
 */

'use strict';

const readline = require('readline');
const http = require('http');
const https = require('https');

const TOKEN = process.env.KB_SEARCH_TOKEN || '';
const ENDPOINT = process.env.KB_SEARCH_ENDPOINT || '';

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function log(msg) {
  process.stderr.write('[kbSearchMcp.stub] ' + msg + '\n');
}

const TOOLS = [
  {
    name: 'search_topics',
    description:
      'Hybrid search (semantic + keyword) over all topics in the knowledge base. ' +
      'Returns the most relevant topics sorted by score.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language search query.',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 10).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_topic',
    description:
      'Retrieve the full content of a topic by ID, including its prose, ' +
      'connections to other topics, and assigned entry list.',
    inputSchema: {
      type: 'object',
      properties: {
        topic_id: {
          type: 'string',
          description: 'The topic ID (slug).',
        },
      },
      required: ['topic_id'],
    },
  },
  {
    name: 'find_similar_topics',
    description:
      'Find topics whose embeddings are closest to a given topic. ' +
      'Useful for discovering connections between topics.',
    inputSchema: {
      type: 'object',
      properties: {
        topic_id: {
          type: 'string',
          description: 'The topic ID to find similar topics for.',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 10).',
        },
      },
      required: ['topic_id'],
    },
  },
  {
    name: 'find_unconnected_similar',
    description:
      'Find topics similar to a given topic that have NO existing connection to it. ' +
      'Useful for discovering missing connections between related topics.',
    inputSchema: {
      type: 'object',
      properties: {
        topic_id: {
          type: 'string',
          description: 'The topic ID to find unconnected similar topics for.',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 10).',
        },
      },
      required: ['topic_id'],
    },
  },
  {
    name: 'get_topic_neighborhood',
    description:
      'Traverse synthesized topic connections around a seed topic. ' +
      'Use this to inspect graph neighbors through explicit relationships.',
    inputSchema: {
      type: 'object',
      properties: {
        topic_id: {
          type: 'string',
          description: 'The seed topic ID.',
        },
        depth: {
          type: 'number',
          description: 'Traversal depth, capped at 2 (default 1).',
        },
        limit: {
          type: 'number',
          description: 'Max topics to return (default 10).',
        },
        min_confidence: {
          type: 'string',
          description: 'Minimum confidence: extracted, inferred, or speculative (default inferred).',
        },
        include_entries: {
          type: 'boolean',
          description: 'Include assigned entry summaries for returned topics.',
        },
      },
      required: ['topic_id'],
    },
  },
  {
    name: 'search_entries',
    description:
      'Hybrid search (semantic + keyword) over all digested entries in the ' +
      'knowledge base. Returns the most relevant entries sorted by score.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language search query.',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 10).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_documents',
    description:
      'List converted knowledge-base documents and their structure status. ' +
      'Use this before fetching document structure or source ranges.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional filename/description search query.',
        },
        limit: {
          type: 'number',
          description: 'Max results to return, clamped to 1-100 (default 20).',
        },
      },
    },
  },
  {
    name: 'get_document_structure',
    description:
      'Return a document range tree without full body text. Use this to inspect pages, slides, sections, or fallback ranges.',
    inputSchema: {
      type: 'object',
      properties: {
        raw_id: {
          type: 'string',
          description: 'Raw document ID.',
        },
        offset: {
          type: 'number',
          description: 'Zero-based node offset for large structures (default 0).',
        },
        limit: {
          type: 'number',
          description: 'Max structure nodes to return, clamped to 1-500 (default 200).',
        },
      },
      required: ['raw_id'],
    },
  },
  {
    name: 'get_source_range',
    description:
      'Read a bounded page/slide/line/section range from a converted source document. ' +
      'Use this instead of asking for the whole document.',
    inputSchema: {
      type: 'object',
      properties: {
        raw_id: {
          type: 'string',
          description: 'Raw document ID.',
        },
        start_unit: {
          type: 'number',
          description: 'First page/slide/line/section number to read, 1-based.',
        },
        end_unit: {
          type: 'number',
          description: 'Last page/slide/line/section number to read, inclusive.',
        },
      },
      required: ['raw_id', 'start_unit', 'end_unit'],
    },
  },
  {
    name: 'kb_ingest',
    description:
      'Ingest a local file into the workspace knowledge base. The file is ' +
      'copied into the KB raw storage under a "conversation-documents" folder ' +
      'and queued for processing.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the file on disk.',
        },
      },
      required: ['file_path'],
    },
  },
];

const VALID_TOOLS = new Set(TOOLS.map((t) => t.name));

function postToolCall(tool, args) {
  return new Promise((resolve, reject) => {
    if (!ENDPOINT || !TOKEN) {
      return reject(new Error('KB_SEARCH_ENDPOINT and KB_SEARCH_TOKEN must be set'));
    }
    let url;
    try {
      url = new URL(ENDPOINT);
    } catch (err) {
      return reject(new Error('Invalid KB_SEARCH_ENDPOINT: ' + err.message));
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
          'X-KB-Search-Token': TOKEN,
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
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text }],
        },
      });
    } else {
      const errText =
        'KB search failed (HTTP ' + status + '): ' + (data && data.error ? data.error : 'unknown error');
      log(errText);
      send({
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: errText }],
        },
      });
    }
  } catch (err) {
    log('Exception: ' + err.message);
    send({
      jsonrpc: '2.0',
      id,
      result: {
        isError: true,
        content: [{ type: 'text', text: 'KB search failed: ' + err.message }],
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
        serverInfo: { name: 'agent-cockpit-kb-search', version: '0.1.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

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
