import express from 'express';
import http from 'http';
import { requireAuth } from '../src/middleware/auth';

// ── Test helpers ────────────────────────────────────────────────────────────

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function makeRequest(server: http.Server, method: string, urlPath: string, host: string): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as { port: number }).port;
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      headers: { host },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function buildApp(authenticated: boolean): express.Express {
  const app = express();
  // Simulate Passport's `req.isAuthenticated()` without wiring Passport itself.
  app.use((req, _res, next) => {
    (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => authenticated;
    next();
  });
  app.use(requireAuth);
  app.get('/api/ping', (_req, res) => { res.json({ ok: true }); });
  app.get('/ping', (_req, res) => { res.send('ok'); });
  return app;
}

async function withServer<T>(app: express.Express, fn: (server: http.Server) => Promise<T>): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(server);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('requireAuth middleware', () => {
  test('unauthenticated request to /api/* returns JSON 401', async () => {
    const app = buildApp(false);
    await withServer(app, async (server) => {
      // Use a non-localhost Host header so the localhost bypass does not trigger.
      const res = await makeRequest(server, 'GET', '/api/ping', 'example.com');
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(JSON.parse(res.body)).toEqual({ error: 'Not authenticated' });
    });
  });

  test('unauthenticated request to non-API path redirects to /auth/login', async () => {
    const app = buildApp(false);
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/ping', 'example.com');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/auth/login');
    });
  });

  test('authenticated request to /api/* passes through', async () => {
    const app = buildApp(true);
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/api/ping', 'example.com');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
    });
  });

  test('localhost bypass still works for /api/*', async () => {
    const app = buildApp(false);
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/api/ping', 'localhost');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
    });
  });

  test('localhost bypass still works for non-API paths', async () => {
    const app = buildApp(false);
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/ping', 'localhost');
      expect(res.status).toBe(200);
      expect(res.body).toBe('ok');
    });
  });
});
