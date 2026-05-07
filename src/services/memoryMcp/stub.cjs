#!/usr/bin/env node
/**
 * Agent Cockpit Memory MCP stdio shim.
 *
 * Spawned by CLIs as an MCP server via ACP's `mcpServers` config or a
 * backend-specific MCP launch mechanism. Implements the minimal subset of the MCP protocol
 * (`initialize`, `tools/list`, `tools/call`) and forwards memory tool
 * calls to Agent Cockpit's HTTP endpoints over localhost.
 *
 * Environment variables:
 *   MEMORY_TOKEN     — per-session bearer token issued by the cockpit
 *   MEMORY_ENDPOINT  — full URL of the note POST endpoint, e.g.
 *                      http://127.0.0.1:3335/chat/api/chat/mcp/memory/notes
 *   MEMORY_SEARCH_ENDPOINT — full URL of the search POST endpoint.
 *
 * This file is intentionally dependency-free and CommonJS so it can be
 * spawned with `node stub.cjs` from any Node environment without
 * transpilation or package installation.
 */

'use strict';

const readline = require('readline');
const http = require('http');
const https = require('https');

const TOKEN = process.env.MEMORY_TOKEN || '';
const ENDPOINT = process.env.MEMORY_ENDPOINT || '';
const SEARCH_ENDPOINT = process.env.MEMORY_SEARCH_ENDPOINT || ENDPOINT.replace(/\/notes(?:\?.*)?$/, '/search');

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function log(msg) {
  // MCP stdio protocol uses stdout for JSON-RPC, so diagnostics go to stderr.
  process.stderr.write('[memoryMcp.stub] ' + msg + '\n');
}

const TOOLS = [
  {
    name: 'memory_note',
    description:
      'Record a durable memory about the user, project, preferences, feedback, or external references. ' +
      'Call this whenever you learn something worth remembering across sessions — user preferences, ' +
      'corrections the user gives you, project context/deadlines, or pointers to external systems. ' +
      'Keep each note concise: one rule or fact per call.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The fact or rule to remember, in natural language.',
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description:
            'Category: user (role/preferences), feedback (corrections/confirmations), ' +
            'project (work context/deadlines), reference (external resources).',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for the memory entry.',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_search',
    description:
      'Search durable workspace memory for relevant user preferences, feedback, project context, ' +
      'decisions, and references before answering questions that may depend on prior context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query in natural language.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return. Defaults to 5, max 20.',
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference', 'unknown'],
          description: 'Optional memory type filter.',
        },
        status: {
          type: 'string',
          enum: ['active', 'all'],
          description:
            'Memory lifecycle scope. Defaults to active, which includes active and redacted entries. ' +
            'Use all to include superseded and deleted entries too.',
        },
        include_content: {
          type: 'boolean',
          description: 'Whether to include memory file content. Defaults to true.',
        },
      },
      required: ['query'],
    },
  },
];

function postJson(endpoint, args) {
  return new Promise((resolve, reject) => {
    if (!endpoint || !TOKEN) {
      return reject(new Error('MEMORY endpoint and MEMORY_TOKEN must be set'));
    }
    let url;
    try {
      url = new URL(endpoint);
    } catch (err) {
      return reject(new Error('Invalid MEMORY endpoint: ' + err.message));
    }
    const payload = JSON.stringify(args);
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
          'X-Memory-Token': TOKEN,
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

function postMemoryNote(args) {
  return postJson(ENDPOINT, args);
}

function postMemorySearch(args) {
  return postJson(SEARCH_ENDPOINT, args);
}

async function handleToolCall(id, params) {
  const toolName = params && params.name;
  const toolArgs = (params && params.arguments) || {};
  if (toolName !== 'memory_note' && toolName !== 'memory_search') {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool: ' + toolName } });
    return;
  }
  try {
    const { status, data } = toolName === 'memory_search'
      ? await postMemorySearch(toolArgs)
      : await postMemoryNote(toolArgs);
    if (status >= 200 && status < 300) {
      let text;
      if (toolName === 'memory_search') {
        text = JSON.stringify(data || { results: [] }, null, 2);
      } else if (data && data.skipped) {
        text = 'Memory note skipped (duplicate of ' + data.skipped + ')';
      } else if (data && data.filename) {
        text = 'Memory note saved: ' + data.filename;
      } else {
        text = 'Memory note processed.';
      }
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text }],
        },
      });
    } else {
      const errText =
        (toolName === 'memory_search' ? 'Memory search failed' : 'Memory note failed') +
        ' (HTTP ' + status + '): ' + (data && data.error ? data.error : 'unknown error');
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
        content: [{ type: 'text', text: (toolName === 'memory_search' ? 'Memory search failed: ' : 'Memory note failed: ') + err.message }],
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
        serverInfo: { name: 'agent-cockpit-memory', version: '0.1.0' },
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
