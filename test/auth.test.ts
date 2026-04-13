import express from 'express';
import session from 'express-session';
import http from 'http';
import { requireAuth, setupAuth } from '../src/middleware/auth';
import type { AppConfig } from '../src/types';

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

// ── setupAuth tests ────────────────────────────────────────────────────────

const baseConfig: AppConfig = {
  PORT: 0,
  SESSION_SECRET: 'test-secret',
  GOOGLE_CLIENT_ID: 'test-google-id',
  GOOGLE_CLIENT_SECRET: 'test-google-secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:3000/auth/google/callback',
  ALLOWED_EMAIL: 'test@example.com',
  DEFAULT_WORKSPACE: '/tmp',
  BASE_PATH: '/tmp',
};

function buildAuthApp(configOverrides: Partial<AppConfig> = {}): express.Express {
  const app = express();
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  setupAuth(app, { ...baseConfig, ...configOverrides });
  return app;
}

describe('setupAuth — /auth/login', () => {
  test('returns 200 with HTML containing "Sign In"', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/auth/login', 'example.com');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('Sign In');
    });
  });

  test('shows Google sign-in button', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/auth/login', 'example.com');
      expect(res.body).toContain('Sign in with Google');
      expect(res.body).toContain('href="/auth/google"');
    });
  });

  test('shows GitHub button when GitHub config is provided', async () => {
    const app = buildAuthApp({
      GITHUB_CLIENT_ID: 'test-github-id',
      GITHUB_CLIENT_SECRET: 'test-github-secret',
      GITHUB_CALLBACK_URL: 'http://localhost:3000/auth/github/callback',
    });
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/auth/login', 'example.com');
      expect(res.body).toContain('Sign in with GitHub');
      expect(res.body).toContain('href="/auth/github"');
    });
  });

  test('does NOT show GitHub button when GitHub config is missing', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/auth/login', 'example.com');
      expect(res.body).not.toContain('Sign in with GitHub');
      expect(res.body).not.toContain('href="/auth/github"');
    });
  });

  test('contains Agent Cockpit branding', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/auth/login', 'example.com');
      expect(res.body).toContain('Agent Cockpit');
    });
  });
});

describe('setupAuth — /auth/denied', () => {
  test('returns 403 with "Access Denied" HTML', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/auth/denied', 'example.com');
      expect(res.status).toBe(403);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('Access Denied');
    });
  });

  test('includes unauthorized account message', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/auth/denied', 'example.com');
      expect(res.body).toContain('not authorized');
    });
  });

  test('includes link back to login page', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/auth/denied', 'example.com');
      expect(res.body).toContain('href="/auth/login"');
      expect(res.body).toContain('Try a different account');
    });
  });
});

describe('setupAuth — /auth/logout', () => {
  test('redirects to / when session exists', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/auth/logout', 'example.com');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/');
    });
  });

  test('sets set-cookie header to clear connect.sid', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/auth/logout', 'example.com');
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      // The connect.sid cookie should be cleared (expires in the past or empty value)
      const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie!;
      expect(cookieStr).toContain('connect.sid');
    });
  });

  test('redirects to / even when session destroy callback receives an error', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const app = express();
    // Session middleware that provides a session whose destroy always errors
    app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
    app.use((req, _res, next) => {
      const origDestroy = req.session!.destroy.bind(req.session!);
      req.session!.destroy = (cb?: (err?: unknown) => void) => {
        // Simulate a destroy error — the logout handler should still redirect
        origDestroy((/* _err */) => {
          if (cb) cb(new Error('simulated destroy error'));
        });
      };
      next();
    });
    setupAuth(app, baseConfig);
    try {
      await withServer(app, async (server) => {
        const res = await makeRequest(server, 'GET', '/auth/logout', 'example.com');
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/');
        expect(spy).toHaveBeenCalledWith('Session destroy error:', expect.any(Error));
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('setupAuth — OAuth routes exist', () => {
  test('/auth/google route is registered', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      // Hitting /auth/google will try to redirect to Google OAuth.
      // Since we have fake credentials, passport will attempt the redirect.
      const res = await makeRequest(server, 'GET', '/auth/google', 'example.com');
      // Passport's Google strategy redirects to accounts.google.com
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('accounts.google.com');
    });
  });

  test('/auth/github route is registered when GitHub config is provided', async () => {
    const app = buildAuthApp({
      GITHUB_CLIENT_ID: 'test-github-id',
      GITHUB_CLIENT_SECRET: 'test-github-secret',
      GITHUB_CALLBACK_URL: 'http://localhost:3000/auth/github/callback',
    });
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/auth/github', 'example.com');
      // Passport's GitHub strategy redirects to github.com/login/oauth
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('github.com');
    });
  });

  test('/auth/github route is NOT registered when GitHub config is missing', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/auth/github', 'example.com');
      // Without GitHub config, no route is registered — express returns 404 by default
      // (or could be handled by another middleware, but we expect it's not a redirect to GitHub)
      expect(res.headers.location || '').not.toContain('github.com');
    });
  });
});
