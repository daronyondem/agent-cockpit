import express from 'express';
import session from 'express-session';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { issueMobileAuthCode, requireAuth, setupAuth, meHandler } from '../src/middleware/auth';
import { ensureCsrfToken } from '../src/middleware/csrf';
import { LocalAuthStore } from '../src/services/localAuthStore';
import type { AppConfig } from '../src/types';

// ── Test helpers ────────────────────────────────────────────────────────────

interface TestResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function makeRequest(
  server: http.Server,
  method: string,
  urlPath: string,
  host: string,
  options: { body?: string; headers?: Record<string, string> } = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as { port: number }).port;
    const headers: Record<string, string | number> = { host, ...options.headers };
    if (options.body) {
      headers['content-length'] = Buffer.byteLength(options.body);
    }
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
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
  AUTH_DATA_DIR: '',
  AUTH_SETUP_TOKEN: 'setup-token',
  AUTH_ENABLE_LEGACY_OAUTH: false,
  DEFAULT_WORKSPACE: '/tmp',
  BASE_PATH: '/tmp',
  CODEX_APPROVAL_POLICY: 'on-request',
  CODEX_SANDBOX_MODE: 'workspace-write',
};

function buildAuthApp(configOverrides: Partial<AppConfig> = {}): express.Express {
  const app = express();
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  const authDir = configOverrides.AUTH_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cockpit-auth-'));
  setupAuth(app, { ...baseConfig, AUTH_DATA_DIR: authDir, ...configOverrides });
  app.get('/api/csrf-token', ensureCsrfToken, (req, res) => {
    res.json({ csrfToken: req.session.csrfToken });
  });
  return app;
}

async function setupOwner(server: http.Server): Promise<TestResponse> {
  const body = new URLSearchParams({
    email: 'owner@example.com',
    displayName: 'Owner User',
    password: 'correct horse battery staple',
  }).toString();
  return makeRequest(server, 'POST', '/auth/setup', 'localhost', {
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
}

function cookieFrom(res: TestResponse): string {
  return Array.isArray(res.headers['set-cookie'])
    ? res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ')
    : String(res.headers['set-cookie']).split(';')[0];
}

async function setupOwnerCookie(server: http.Server): Promise<string> {
  await setupOwner(server);
  const body = new URLSearchParams({
    email: 'owner@example.com',
    password: 'correct horse battery staple',
  }).toString();
  const login = await makeRequest(server, 'POST', '/auth/login/password', 'example.com', {
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  expect(login.status).toBe(302);
  return cookieFrom(login);
}

async function csrfToken(server: http.Server, cookie: string): Promise<string> {
  const res = await makeRequest(server, 'GET', '/api/csrf-token', 'example.com', {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  return JSON.parse(res.body).csrfToken;
}

describe('setupAuth — /auth/login', () => {
  test('redirects to setup before the local owner exists', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/auth/login', 'example.com');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/auth/setup');
    });
  });

  test('returns 200 with the first-party login markup after setup', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      await setupOwner(server);
      const res = await makeRequest(server, 'GET', '/auth/login', 'example.com');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('Sign in to Agent Cockpit');
      expect(res.body).toContain('action="/auth/login/password"');
    });
  });

  test('does not show third-party provider buttons by default', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      await setupOwner(server);
      const res = await makeRequest(server, 'GET', '/auth/login', 'example.com');
      expect(res.body).not.toContain('Continue with Google');
      expect(res.body).not.toContain('Continue with GitHub');
      expect(res.body).not.toContain('href="/auth/google"');
      expect(res.body).not.toContain('href="/auth/github"');
    });
  });

  test('contains Agent Cockpit branding', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      await setupOwner(server);
      const res = await makeRequest(server, 'GET', '/auth/login', 'example.com');
      expect(res.body).toContain('Agent Cockpit');
    });
  });

  test('propagates ?popup=1 as a hidden password-login mode field', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      await setupOwner(server);
      const res = await makeRequest(server, 'GET', '/auth/login?popup=1', 'example.com');
      expect(res.body).toContain('name="popup" value="1"');
    });
  });

  test('propagates ?mobile=1 as a hidden password-login mode field', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      await setupOwner(server);
      const res = await makeRequest(server, 'GET', '/auth/login?mobile=1', 'example.com');
      expect(res.body).toContain('name="mobile" value="1"');
    });
  });

  test('omits mobile and popup hidden fields in normal login mode', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      await setupOwner(server);
      const res = await makeRequest(server, 'GET', '/auth/login', 'example.com');
      expect(res.body).not.toContain('name="mobile" value="1"');
      expect(res.body).not.toContain('name="popup" value="1"');
    });
  });
});

describe('setupAuth — /auth/setup', () => {
  test('returns first-run setup page when no owner exists', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/auth/setup', 'example.com');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Create the owner account');
    });
  });

  test('allows localhost setup and signs in the owner', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const res = await setupOwner(server);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/');
      expect(String(res.headers['set-cookie'] || '')).toContain('connect.sid');
    });
  });

  test('requires setup token for remote setup', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const body = new URLSearchParams({
        email: 'owner@example.com',
        displayName: 'Owner User',
        password: 'correct horse battery staple',
      }).toString();
      const res = await makeRequest(server, 'POST', '/auth/setup', 'example.com', {
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.status).toBe(403);
      expect(res.body).toContain('Remote setup requires a valid setup token.');
    });
  });

  test('accepts setup token for remote setup', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const body = new URLSearchParams({
        email: 'owner@example.com',
        displayName: 'Owner User',
        password: 'correct horse battery staple',
        setupToken: 'setup-token',
      }).toString();
      const res = await makeRequest(server, 'POST', '/auth/setup', 'example.com', {
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/');
    });
  });
});

describe('setupAuth — /auth/login/password', () => {
  test('rejects invalid owner credentials', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      await setupOwner(server);
      const body = new URLSearchParams({
        email: 'owner@example.com',
        password: 'wrong password',
      }).toString();
      const res = await makeRequest(server, 'POST', '/auth/login/password', 'example.com', {
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.status).toBe(401);
      expect(res.body).toContain('Invalid email or password.');
    });
  });

  test('logs in valid owner credentials as local provider', async () => {
    const app = buildAuthApp();
    app.use(requireAuth);
    app.get('/api/me', meHandler);

    await withServer(app, async (server) => {
      await setupOwner(server);
      const body = new URLSearchParams({
        email: 'owner@example.com',
        password: 'correct horse battery staple',
      }).toString();
      const res = await makeRequest(server, 'POST', '/auth/login/password', 'example.com', {
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/');
      expect(String(res.headers['set-cookie'] || '')).toContain('connect.sid');

      const cookie = Array.isArray(res.headers['set-cookie'])
        ? res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ')
        : String(res.headers['set-cookie']).split(';')[0];
      const me = await makeRequest(server, 'GET', '/api/me', 'example.com', {
        headers: { cookie },
      });
      expect(me.status).toBe(200);
      expect(JSON.parse(me.body)).toEqual({
        displayName: 'Owner User',
        email: 'owner@example.com',
        provider: 'local',
      });
    });
  });

  test('mobile password login redirects to native callback with one-time code', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      await setupOwner(server);
      const body = new URLSearchParams({
        email: 'owner@example.com',
        password: 'correct horse battery staple',
        mobile: '1',
      }).toString();
      const res = await makeRequest(server, 'POST', '/auth/login/password', 'example.com', {
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/^agentcockpit:\/\/auth\/callback\?code=/);
    });
  });
});

describe('setupAuth — /api/auth/status', () => {
  test('reports setup required before owner exists', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/api/auth/status', 'example.com');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        setupRequired: true,
        providers: {
          password: true,
          passkey: false,
          legacyOAuth: false,
        },
        passkeys: {
          registered: 0,
        },
        policy: {
          passkeyRequired: false,
        },
        recovery: {
          configured: false,
          total: 0,
          remaining: 0,
          createdAt: null,
        },
      });
    });
  });

  test('reports setup complete after owner exists', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      await setupOwner(server);
      const res = await makeRequest(server, 'GET', '/api/auth/status', 'example.com');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.setupRequired).toBe(false);
      expect(body.providers.passkey).toBe(true);
      expect(body.passkeys).toEqual({ registered: 0 });
      expect(body.policy).toEqual({ passkeyRequired: false });
    });
  });
});

describe('setupAuth — recovery codes and policy', () => {
  test('regenerates recovery codes for authenticated owner sessions', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const cookie = await setupOwnerCookie(server);
      const csrf = await csrfToken(server, cookie);

      const res = await makeRequest(server, 'POST', '/api/auth/recovery/regenerate', 'example.com', {
        body: '{}',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
      });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.recoveryCodes).toHaveLength(10);
      expect(body.recovery.remaining).toBe(10);
      expect(body.recovery.configured).toBe(true);
    });
  });

  test('recovery code login is one-time use and disables passkey-required policy', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const cookie = await setupOwnerCookie(server);
      const csrf = await csrfToken(server, cookie);
      const generated = await makeRequest(server, 'POST', '/api/auth/recovery/regenerate', 'example.com', {
        body: '{}',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
      });
      const code = JSON.parse(generated.body).recoveryCodes[0];

      const body = new URLSearchParams({
        email: 'owner@example.com',
        recoveryCode: code,
      }).toString();
      const recovered = await makeRequest(server, 'POST', '/auth/recovery/login', 'example.com', {
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(recovered.status).toBe(302);
      expect(recovered.headers.location).toBe('/');
      expect(String(recovered.headers['set-cookie'] || '')).toContain('connect.sid');

      const reused = await makeRequest(server, 'POST', '/auth/recovery/login', 'example.com', {
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(reused.status).toBe(401);
      expect(reused.body).toContain('Invalid email or recovery code.');
    });
  });

  test('passkey-required policy cannot be enabled without a passkey and recovery codes', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const cookie = await setupOwnerCookie(server);
      const csrf = await csrfToken(server, cookie);

      const res = await makeRequest(server, 'PATCH', '/api/auth/policy', 'example.com', {
        body: JSON.stringify({ passkeyRequired: true }),
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
      });

      expect(res.status).toBe(409);
      expect(JSON.parse(res.body).error).toContain('Register at least one passkey');
    });
  });

  test('local passkeys can be listed, renamed, and guarded from unsafe deletion', async () => {
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cockpit-auth-'));
    const store = new LocalAuthStore(authDir);
    await store.createOwner({
      email: 'owner@example.com',
      displayName: 'Owner User',
      password: 'correct horse battery staple',
    });
    await store.regenerateRecoveryCodes();

    const created = await store.createPasskey({
      name: 'MacBook Touch ID',
      credentialId: 'credential-id',
      publicKey: Buffer.from('public-key').toString('base64url'),
      counter: 0,
      transports: ['internal'],
    });

    expect(await store.listPasskeys()).toHaveLength(1);
    const renamed = await store.renamePasskey(created.id, 'MacBook');
    expect(renamed?.name).toBe('MacBook');
    await expect(store.setPasskeyRequired(true)).resolves.toEqual({ passkeyRequired: true });
    await expect(store.deletePasskey(created.id)).rejects.toMatchObject({
      code: 'unsafe-policy',
    });
  });

  test('passkey option endpoints expose WebAuthn options and reject empty login', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const cookie = await setupOwnerCookie(server);
      const csrf = await csrfToken(server, cookie);

      const registerOptions = await makeRequest(server, 'POST', '/api/auth/passkeys/register/options', 'example.com', {
        body: JSON.stringify({ name: 'MacBook' }),
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
      });
      expect(registerOptions.status).toBe(200);
      const optionsBody = JSON.parse(registerOptions.body);
      expect(optionsBody.challenge).toBeTruthy();
      expect(optionsBody.rp.id).toBe('example.com');
      expect(optionsBody.user.name).toBe('owner@example.com');

      const list = await makeRequest(server, 'GET', '/api/auth/passkeys', 'example.com', {
        headers: { cookie },
      });
      expect(list.status).toBe(200);
      expect(JSON.parse(list.body)).toEqual({ passkeys: [] });

      const loginOptions = await makeRequest(server, 'POST', '/api/auth/passkeys/login/options', 'example.com', {
        body: '{}',
        headers: { 'content-type': 'application/json' },
      });
      expect(loginOptions.status).toBe(409);
      expect(JSON.parse(loginOptions.body).error).toContain('No passkeys');
    });
  });

  test('password login is blocked when passkey-required policy is already enabled', async () => {
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cockpit-auth-'));
    const state = {
      version: 1,
      owner: {
        id: 'local-owner',
        email: 'owner@example.com',
        displayName: 'Owner User',
        passwordHash: 'scrypt$invalid$invalid',
        createdAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-03T00:00:00.000Z',
      },
      policy: { passkeyRequired: true },
      passkeys: [{
        id: 'pk-1',
        name: 'iPhone',
        credentialId: 'credential',
        publicKey: 'public-key',
        counter: 0,
        createdAt: '2026-05-03T00:00:00.000Z',
      }],
      recoveryCodes: [{
        id: 'rc-1',
        codeHash: 'scrypt$invalid$invalid',
        createdAt: '2026-05-03T00:00:00.000Z',
      }],
      mobileDevices: [],
    };
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'owner.json'), `${JSON.stringify(state)}\n`);
    const app = buildAuthApp({ AUTH_DATA_DIR: authDir });

    await withServer(app, async (server) => {
      const body = new URLSearchParams({
        email: 'owner@example.com',
        password: 'correct horse battery staple',
      }).toString();
      const res = await makeRequest(server, 'POST', '/auth/login/password', 'example.com', {
        body,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.status).toBe(403);
      expect(res.body).toContain('Passkey login is required');
    });
  });

  test('local reset updates password, disables passkey-required, revokes devices, and regenerates recovery codes', async () => {
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cockpit-auth-'));
    const store = new LocalAuthStore(authDir);
    await store.createOwner({
      email: 'owner@example.com',
      displayName: 'Owner User',
      password: 'correct horse battery staple',
    });
    await store.createMobileDevice({ displayName: 'iPhone' });

    const result = await store.resetOwnerAccess({
      password: 'new correct horse battery staple',
      disablePasskeyRequired: true,
      revokeMobileDevices: true,
      regenerateRecoveryCodes: true,
    });

    expect(result.recoveryCodes).toHaveLength(10);
    await expect(store.verifyPassword('owner@example.com', 'new correct horse battery staple')).resolves.toMatchObject({
      email: 'owner@example.com',
    });
    await expect(store.getPolicy()).resolves.toEqual({ passkeyRequired: false });
    expect((await store.listMobileDevices())[0].revokedAt).toBeTruthy();
    expect((await store.getRecoveryStatus()).remaining).toBe(10);
  });
});

describe('setupAuth — mobile pairing and devices', () => {
  test('creates and exchanges a short-lived mobile pairing challenge', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const cookie = await setupOwnerCookie(server);
      const csrf = await csrfToken(server, cookie);

      const challenge = await makeRequest(server, 'POST', '/api/mobile-pairing/challenges', 'example.com', {
        body: '{}',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
      });
      expect(challenge.status).toBe(200);
      const challengeBody = JSON.parse(challenge.body);
      expect(challengeBody.challengeId).toBeTruthy();
      expect(challengeBody.pairingCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(challengeBody.pairingUrl).toContain('agentcockpit://pair');
      expect(challengeBody.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);

      const exchange = await makeRequest(server, 'POST', '/api/mobile-pairing/exchange', 'example.com', {
        body: JSON.stringify({
          challengeId: challengeBody.challengeId,
          code: challengeBody.pairingCode,
          deviceName: 'Daron iPhone',
          platform: 'iOS',
        }),
        headers: { 'content-type': 'application/json', 'user-agent': 'AgentCockpit iOS' },
      });

      expect(exchange.status).toBe(200);
      const exchangeBody = JSON.parse(exchange.body);
      expect(exchangeBody.csrfToken).toBeTruthy();
      expect(exchangeBody.user).toEqual({
        email: 'owner@example.com',
        displayName: 'Owner User',
        provider: 'local',
      });
      expect(exchangeBody.device.displayName).toBe('Daron iPhone');
      expect(exchangeBody.device.platform).toBe('iOS');
      expect(String(exchange.headers['set-cookie'] || '')).toContain('connect.sid');

      const devices = await makeRequest(server, 'GET', '/api/mobile-devices', 'example.com', {
        headers: { cookie },
      });
      expect(devices.status).toBe(200);
      expect(JSON.parse(devices.body).devices).toHaveLength(1);
    });
  });

  test('pairing codes are single-use', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const cookie = await setupOwnerCookie(server);
      const csrf = await csrfToken(server, cookie);
      const challenge = await makeRequest(server, 'POST', '/api/mobile-pairing/challenges', 'example.com', {
        body: '{}',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
      });
      const challengeBody = JSON.parse(challenge.body);
      const exchangeBody = JSON.stringify({
        challengeId: challengeBody.challengeId,
        code: challengeBody.pairingCode,
      });

      const first = await makeRequest(server, 'POST', '/api/mobile-pairing/exchange', 'example.com', {
        body: exchangeBody,
        headers: { 'content-type': 'application/json' },
      });
      expect(first.status).toBe(200);

      const second = await makeRequest(server, 'POST', '/api/mobile-pairing/exchange', 'example.com', {
        body: exchangeBody,
        headers: { 'content-type': 'application/json' },
      });
      expect(second.status).toBe(400);
      expect(JSON.parse(second.body)).toEqual({ error: 'Invalid or expired pairing code' });
    });
  });

  test('pairing challenges expire after five minutes', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const cookie = await setupOwnerCookie(server);
      const csrf = await csrfToken(server, cookie);
      const now = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);

      try {
        const challenge = await makeRequest(server, 'POST', '/api/mobile-pairing/challenges', 'example.com', {
          body: '{}',
          headers: {
            cookie,
            'content-type': 'application/json',
            'x-csrf-token': csrf,
          },
        });
        const challengeBody = JSON.parse(challenge.body);
        nowSpy.mockReturnValue(now + (5 * 60 * 1000) + 1);

        const exchange = await makeRequest(server, 'POST', '/api/mobile-pairing/exchange', 'example.com', {
          body: JSON.stringify({
            challengeId: challengeBody.challengeId,
            code: challengeBody.pairingCode,
          }),
          headers: { 'content-type': 'application/json' },
        });

        expect(exchange.status).toBe(400);
        expect(JSON.parse(exchange.body)).toEqual({ error: 'Invalid or expired pairing code' });
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  test('revoking a mobile device blocks that mobile session', async () => {
    const app = buildAuthApp();
    app.use(requireAuth);
    app.get('/api/me', meHandler);

    await withServer(app, async (server) => {
      const ownerCookie = await setupOwnerCookie(server);
      const csrf = await csrfToken(server, ownerCookie);
      const challenge = await makeRequest(server, 'POST', '/api/mobile-pairing/challenges', 'example.com', {
        body: '{}',
        headers: {
          cookie: ownerCookie,
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
      });
      const challengeBody = JSON.parse(challenge.body);
      const exchange = await makeRequest(server, 'POST', '/api/mobile-pairing/exchange', 'example.com', {
        body: JSON.stringify({
          challengeId: challengeBody.challengeId,
          code: challengeBody.pairingCode,
          deviceName: 'Daron iPhone',
        }),
        headers: { 'content-type': 'application/json' },
      });
      const mobileCookie = cookieFrom(exchange);
      const deviceId = JSON.parse(exchange.body).device.id;

      const revoked = await makeRequest(server, 'DELETE', `/api/mobile-devices/${deviceId}`, 'example.com', {
        headers: {
          cookie: ownerCookie,
          'x-csrf-token': csrf,
        },
      });
      expect(revoked.status).toBe(200);
      expect(JSON.parse(revoked.body).device.revokedAt).toBeTruthy();

      const me = await makeRequest(server, 'GET', '/api/me', 'example.com', {
        headers: { cookie: mobileCookie },
      });
      expect(me.status).toBe(401);
      expect(JSON.parse(me.body)).toEqual({ error: 'Mobile device revoked' });
    });
  });
});

describe('setupAuth — /api/mobile-auth/exchange', () => {
  function buildMobileExchangeApp(): express.Express {
    const app = buildAuthApp({
      GITHUB_CLIENT_ID: 'test-github-id',
      GITHUB_CLIENT_SECRET: 'test-github-secret',
      GITHUB_CALLBACK_URL: 'http://localhost:3000/auth/github/callback',
    });
    app.use(requireAuth);
    app.get('/api/me', meHandler);
    return app;
  }

  test('rejects an invalid mobile auth code', async () => {
    const app = buildMobileExchangeApp();
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'POST', '/api/mobile-auth/exchange', 'example.com', {
        body: JSON.stringify({ code: 'missing' }),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'Invalid or expired mobile auth code' });
    });
  });

  test('exchanges a valid mobile auth code for a session cookie and csrf token', async () => {
    const app = buildMobileExchangeApp();
    const code = issueMobileAuthCode({
      id: 'github-1',
      email: 'octocat@github.com',
      displayName: 'Octocat',
      provider: 'github',
    });

    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'POST', '/api/mobile-auth/exchange', 'example.com', {
        body: JSON.stringify({ code }),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.user).toEqual({
        email: 'octocat@github.com',
        displayName: 'Octocat',
        provider: 'github',
      });
      expect(typeof body.csrfToken).toBe('string');
      expect(body.csrfToken.length).toBeGreaterThan(0);
      expect(String(res.headers['set-cookie'] || '')).toContain('connect.sid');

      const cookie = Array.isArray(res.headers['set-cookie'])
        ? res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ')
        : String(res.headers['set-cookie']).split(';')[0];
      const me = await makeRequest(server, 'GET', '/api/me', 'example.com', {
        headers: { cookie },
      });
      expect(me.status).toBe(200);
      expect(JSON.parse(me.body)).toEqual({
        displayName: 'Octocat',
        email: 'octocat@github.com',
        provider: 'github',
      });
    });
  });
});

describe('setupAuth — /auth/popup-done', () => {
  test('returns 200 with HTML that posts ac-reauth-ok and self-closes', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/auth/popup-done', 'example.com');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain("type: 'ac-reauth-ok'");
      expect(res.body).toContain('window.opener.postMessage');
      expect(res.body).toContain('window.close()');
      expect(res.body).toContain('window.location.origin');
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
      (req.session!.destroy as any) = (cb?: (err?: unknown) => void) => {
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

describe('meHandler — /api/me', () => {
  function buildMeApp(authenticated: boolean, user: unknown): express.Express {
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => authenticated;
      (req as unknown as { user: unknown }).user = user;
      next();
    });
    app.use(requireAuth);
    app.get('/api/me', meHandler);
    return app;
  }

  test('unauthenticated non-local request returns 401', async () => {
    const app = buildMeApp(false, undefined);
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/api/me', 'example.com');
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: 'Not authenticated' });
    });
  });

  test('authenticated request returns displayName, email, and provider', async () => {
    const app = buildMeApp(true, { displayName: 'Daron Yondem', email: 'daron@example.com', provider: 'google' });
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/api/me', 'example.com');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        displayName: 'Daron Yondem',
        email: 'daron@example.com',
        provider: 'google',
      });
    });
  });

  test('authenticated GitHub user returns provider "github"', async () => {
    const app = buildMeApp(true, { displayName: 'octocat', email: 'octocat@github.com', provider: 'github' });
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/api/me', 'example.com');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).provider).toBe('github');
    });
  });

  test('localhost bypass with no user returns null fields', async () => {
    const app = buildMeApp(false, undefined);
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/api/me', 'localhost');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ displayName: null, email: null, provider: null });
    });
  });
});

describe('setupAuth — OAuth routes exist', () => {
  test('/auth/google route is not registered by default', async () => {
    const app = buildAuthApp();
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/auth/google', 'example.com');
      expect(res.headers.location || '').not.toContain('accounts.google.com');
    });
  });

  test('/auth/google route is registered only when legacy OAuth is explicitly enabled', async () => {
    const app = buildAuthApp({ AUTH_ENABLE_LEGACY_OAUTH: true });
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/auth/google', 'example.com');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('accounts.google.com');
    });
  });

  test('/auth/github route is registered when legacy OAuth and GitHub config are provided', async () => {
    const app = buildAuthApp({
      AUTH_ENABLE_LEGACY_OAUTH: true,
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

  test('/auth/github route is NOT registered when legacy OAuth is disabled', async () => {
    const app = buildAuthApp({
      GITHUB_CLIENT_ID: 'test-github-id',
      GITHUB_CLIENT_SECRET: 'test-github-secret',
      GITHUB_CALLBACK_URL: 'http://localhost:3000/auth/github/callback',
    });
    await withServer(app, async (server) => {
      const res = await makeRequest(server, 'GET', '/auth/github', 'example.com');
      // With legacy OAuth disabled, no route is registered — express returns 404 by default
      // (or could be handled by another middleware, but we expect it's not a redirect to GitHub)
      expect(res.headers.location || '').not.toContain('github.com');
    });
  });
});
