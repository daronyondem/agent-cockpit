import express from 'express';
import http from 'http';
import { applySecurity } from '../src/middleware/security';

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function makeRequest(server: http.Server): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as { port: number }).port;
    const req = http.request({
      method: 'GET',
      hostname: '127.0.0.1',
      port,
      path: '/',
      headers: { host: 'localhost' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
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

describe('applySecurity', () => {
  test('omits upgrade-insecure-requests for local HTTP installs', async () => {
    const app = express();
    applySecurity(app);
    app.get('/', (_req, res) => res.send('ok'));

    await withServer(app, async (server) => {
      const res = await makeRequest(server);
      const csp = String(res.headers['content-security-policy']);

      expect(res.status).toBe(200);
      expect(csp).toContain("form-action 'self'");
      expect(csp).not.toContain('upgrade-insecure-requests');
    });
  });
});
