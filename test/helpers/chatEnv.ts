/* eslint-disable @typescript-eslint/no-explicit-any */

import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import WebSocket from 'ws';
import { ChatService } from '../../src/services/chatService';
import { createChatRouter } from '../../src/routes/chat';
import { attachWebSocket, type WsFunctions } from '../../src/ws';
import { BackendRegistry } from '../../src/services/backends/registry';
import type { ActiveStreamEntry } from '../../src/types';
import type { StreamJobRegistry } from '../../src/services/streamJobRegistry';
import { MockBackendAdapter } from './mockBackendAdapter';

export const DEFAULT_WORKSPACE = '/tmp/test-workspace';
export const CSRF_TOKEN = 'test-csrf-token';

export interface HttpResult {
  status: number;
  body: any;
  headers: http.IncomingHttpHeaders;
}

export interface ChatRouterEnv {
  tmpDir: string;
  chatService: ChatService;
  mockBackend: MockBackendAdapter;
  backendRegistry: BackendRegistry;
  app: express.Express;
  server: http.Server;
  baseUrl: string;
  activeStreams: Map<string, ActiveStreamEntry>;
  streamJobs: StreamJobRegistry;
  reconcileInterruptedJobs: () => Promise<{ interrupted: number; removed: number }>;
  chatShutdown: () => Promise<void>;
  wsFns: WsFunctions;
  wsShutdown: () => void;
  request(method: string, urlPath: string, body?: any): Promise<HttpResult>;
  multipartRequest(method: string, urlPath: string, field: string, filename: string, contentType: string, content: Buffer): Promise<HttpResult>;
  connectWs(convId: string): Promise<WebSocket>;
  readWsEvents(ws: WebSocket, timeout?: number): Promise<any[]>;
}

export interface CreateChatRouterEnvOpts {
  /** Deprecated compatibility option; disconnect no longer aborts active streams. */
  gracePeriodMs?: number;
  bufferCleanupMs?: number;
  updateService?: any;
}

/** Build an isolated Express + WebSocket test server with a fresh ChatService,
    MockBackendAdapter and scratch tmpDir. Each test should create and tear
    down its own env for full isolation. */
export async function createChatRouterEnv(opts: CreateChatRouterEnvOpts = {}): Promise<ChatRouterEnv> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroute-'));
  const mockBackend = new MockBackendAdapter();
  const backendRegistry = new BackendRegistry();
  backendRegistry.register(mockBackend);
  const chatService = new ChatService(tmpDir, { defaultWorkspace: DEFAULT_WORKSPACE, backendRegistry });
  await chatService.initialize();

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.session = { csrfToken: CSRF_TOKEN };
    next();
  });

  const mockPlanUsage = {
    init: async () => {},
    getCached: () => ({ fetchedAt: null, planTier: null, subscriptionType: null, rateLimits: null, lastError: null, stale: true }),
    maybeRefresh: async () => {},
  } as any;
  const mockKiroPlanUsage = {
    init: async () => {},
    getCached: () => ({ fetchedAt: null, usage: null, lastError: null, stale: true }),
    maybeRefresh: async () => {},
  } as any;
  const mockCodexPlanUsage = {
    init: async () => {},
    getCached: () => ({ fetchedAt: null, account: null, rateLimits: null, lastError: null, stale: true }),
    maybeRefresh: async () => {},
  } as any;
  const chatResult = createChatRouter({ chatService, backendRegistry, updateService: opts.updateService ?? null as any, claudePlanUsageService: mockPlanUsage, kiroPlanUsageService: mockKiroPlanUsage, codexPlanUsageService: mockCodexPlanUsage });
  await chatResult.reconcileInterruptedJobs();
  const { activeStreams, streamJobs, reconcileInterruptedJobs, shutdown: chatShutdown } = chatResult;
  app.use('/api/chat', chatResult.router);

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

  const mockStore = {
    get: (_sid: string, cb: (err: any, session: any) => void) => cb(null, null),
    set: (_sid: string, _session: any, cb?: (err?: any) => void) => cb?.(),
    destroy: (_sid: string, cb?: (err?: any) => void) => cb?.(),
  } as any;
  const wsResult = attachWebSocket(server, {
    sessionStore: mockStore,
    sessionSecret: 'test-secret',
    activeStreams,
    abortStream: chatResult.abortActiveStream,
    bufferCleanupMs: opts.bufferCleanupMs,
    gracePeriodMs: opts.gracePeriodMs,
  });
  const wsShutdown = wsResult.shutdown;
  chatResult.setWsFunctions(wsResult);

  const request = (method: string, urlPath: string, body?: any): Promise<HttpResult> => {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, baseUrl);
      const options: http.RequestOptions = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          'x-csrf-token': CSRF_TOKEN,
          'Content-Type': 'application/json',
        },
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data), headers: res.headers });
          } catch {
            resolve({ status: res.statusCode!, body: data, headers: res.headers });
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  };

  const multipartRequest = (
    method: string,
    urlPath: string,
    field: string,
    filename: string,
    contentType: string,
    content: Buffer,
  ): Promise<HttpResult> => {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, baseUrl);
      const boundary = '----ac-mp-test-' + Math.random().toString(36).slice(2);
      const head = Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([head, content, tail]);
      const options: http.RequestOptions = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          'x-csrf-token': CSRF_TOKEN,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data), headers: res.headers });
          } catch {
            resolve({ status: res.statusCode!, body: data, headers: res.headers });
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  };

  const connectWs = (convId: string): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      const port = (server.address() as any).port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/chat/conversations/${convId}/ws`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  };

  const readWsEvents = (ws: WebSocket, timeout = 3000): Promise<any[]> => {
    return new Promise((resolve) => {
      const events: any[] = [];
      const timer = setTimeout(() => {
        ws.close();
        resolve(events);
      }, timeout);
      ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          events.push(event);
          if (event.type === 'done') {
            clearTimeout(timer);
            ws.close();
            resolve(events);
          }
        } catch {}
      });
      ws.on('close', () => {
        clearTimeout(timer);
        resolve(events);
      });
    });
  };

  return { tmpDir, chatService, mockBackend, backendRegistry, app, server, baseUrl, activeStreams, streamJobs, reconcileInterruptedJobs, chatShutdown, wsFns: wsResult, wsShutdown, request, multipartRequest, connectWs, readWsEvents };
}

async function removeTmpDirWithRetry(tmpDir: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw err;

      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }

  throw lastError;
}

async function waitForActiveStreamsToDrain(activeStreams: Map<string, ActiveStreamEntry>): Promise<void> {
  const deadline = Date.now() + 2000;

  while (activeStreams.size > 0) {
    if (Date.now() > deadline) {
      for (const entry of activeStreams.values()) entry.abort();
      throw new Error(`Timed out waiting for ${activeStreams.size} active chat stream(s) to finish`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function destroyChatRouterEnv(env: ChatRouterEnv): Promise<void> {
  await waitForActiveStreamsToDrain(env.activeStreams);
  env.wsShutdown();
  await new Promise<void>((resolve, reject) => {
    env.server.close((err?: Error) => {
      if (err) reject(err);
      else resolve();
    });
  });
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  await removeTmpDirWithRetry(env.tmpDir);
}
