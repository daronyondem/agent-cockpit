import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function makeRequest(server: http.Server, urlPath: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as { port: number }).port;
    const req = http.request({
      method: 'GET',
      hostname: '127.0.0.1',
      port,
      path: urlPath,
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

async function withServer(app: express.Express, fn: (server: http.Server) => Promise<void>): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(server);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('frontend routes', () => {
  test('server routing keeps / as V2 redirect and removes /legacy redirect', () => {
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');
    expect(serverSrc).toContain("app.get('/', (_req: Request, res: Response): void => { res.redirect('/v2/'); });");
    expect(serverSrc).not.toMatch(/app\.get\(\s*\[\s*['"]\/legacy['"]/);
    expect(serverSrc).not.toContain("res.redirect('/index.html')");
  });

  test('static frontend surface serves V2 and leaves removed assets unavailable', async () => {
    const app = express();
    app.get('/', (_req, res) => { res.redirect('/v2/'); });
    app.use(express.static(path.join(ROOT, 'public')));

    await withServer(app, async (server) => {
      const root = await makeRequest(server, '/');
      expect(root.status).toBe(302);
      expect(root.headers.location).toBe('/v2/');

      const v2 = await makeRequest(server, '/v2/');
      expect(v2.status).toBe(200);
      expect(v2.headers['content-type']).toMatch(/text\/html/);
      expect(v2.body).toContain('<div id="root"');
      expect(v2.body).toContain('src/app.css?v=125');
      expect(v2.body).toContain('src/synthesisAtlas.js?v=117');
      expect(v2.body).toContain('src/screens/kbBrowser.jsx?v=119');
      expect(v2.body.indexOf('src/synthesisAtlas.js?v=117')).toBeLessThan(
        v2.body.indexOf('src/screens/kbBrowser.jsx?v=119'),
      );

      const mobile = await makeRequest(server, '/mobile/');
      expect(mobile.status).toBe(200);
      expect(mobile.headers['content-type']).toMatch(/text\/html/);
      expect(mobile.body).toContain('<div id="root"');
      expect(mobile.body).toContain('Agent Cockpit Mobile');
      expect(mobile.body).toContain('/mobile/manifest.webmanifest');
      expect(mobile.body).toMatch(/\/mobile\/assets\/index-[A-Za-z0-9_-]+\.js/);

      const manifest = await makeRequest(server, '/mobile/manifest.webmanifest');
      expect(manifest.status).toBe(200);
      expect(manifest.headers['content-type']).toMatch(/application\/manifest\+json|application\/octet-stream|application\/json/);
      expect(manifest.body).toContain('"start_url": "/mobile/"');

      for (const removedPath of ['/legacy/', '/index.html', '/styles.css', '/js/main.js', '/v2/deck.html']) {
        const res = await makeRequest(server, removedPath);
        expect(res.status).toBe(404);
      }
    });
  });
});
