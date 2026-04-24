import net from 'net';
import path from 'path';
import express from 'express';
import session from 'express-session';
import FileStoreFactory from 'session-file-store';
import config from './src/config';
import { setupAuth, requireAuth, meHandler } from './src/middleware/auth';
import { ensureCsrfToken } from './src/middleware/csrf';
import { applySecurity } from './src/middleware/security';
import { createChatRouter } from './src/routes/chat';
import { attachWebSocket } from './src/ws';
import { ChatService } from './src/services/chatService';
import { BackendRegistry } from './src/services/backends/registry';
import { ClaudeCodeAdapter } from './src/services/backends/claudeCode';
import { KiroAdapter } from './src/services/backends/kiro';
import { UpdateService } from './src/services/updateService';
import { ClaudePlanUsageService } from './src/services/claudePlanUsageService';
import { KiroPlanUsageService } from './src/services/kiroPlanUsageService';
import { detectLibreOffice } from './src/services/knowledgeBase/libreOffice';
import { detectPandoc } from './src/services/knowledgeBase/pandoc';
import type { Request, Response, NextFunction } from './src/types';

const FileStore = FileStoreFactory(session);

const app = express();

app.set('trust proxy', 1);

applySecurity(app);

const sessionStore = new FileStore({
  path: path.join(__dirname, 'data', 'sessions'),
  ttl: 24 * 60 * 60,
  retries: 0,
});

app.use(session({
  store: sessionStore,
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // Rolling: every authenticated request resets cookie.maxAge so an active
  // user never hits the 24h wall mid-workflow. Idle users still expire after
  // 24h of no activity.
  rolling: true,
  cookie: {
    secure: 'auto',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

// Passport 0.7 regenerate/save polyfill — must come BEFORE setupAuth
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.session && !req.session.regenerate) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req.session as any).regenerate = (cb: () => void) => cb();
  }
  if (req.session && !req.session.save) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req.session as any).save = (cb: () => void) => cb();
  }
  next();
});

// Public brand asset — served without auth so /auth/login can render the
// Agent Cockpit logo. One targeted route instead of a blanket public-asset
// mount, so the rest of public/ stays behind requireAuth.
app.get('/logo-full-no-text.svg', (_req: Request, res: Response): void => {
  res.sendFile(path.join(__dirname, 'public', 'logo-full-no-text.svg'));
});

setupAuth(app, config);

app.use(requireAuth);
app.use(ensureCsrfToken);

app.use(express.json());

app.get('/api/csrf-token', (req: Request, res: Response) => {
  res.json({ csrfToken: req.session.csrfToken });
});

app.get('/api/me', meHandler);

const backendRegistry = new BackendRegistry();
backendRegistry.register(new ClaudeCodeAdapter({ workingDir: config.DEFAULT_WORKSPACE }));
backendRegistry.register(new KiroAdapter({ workingDir: config.DEFAULT_WORKSPACE }));

const chatService = new ChatService(__dirname, { defaultWorkspace: config.DEFAULT_WORKSPACE, backendRegistry });
const updateService = new UpdateService(__dirname);
const claudePlanUsageService = new ClaudePlanUsageService(__dirname);
const kiroPlanUsageService = new KiroPlanUsageService(__dirname);
const { router: chatRouter, shutdown: chatShutdown, activeStreams, setWsFunctions } = createChatRouter({ chatService, backendRegistry, updateService, claudePlanUsageService, kiroPlanUsageService });
app.use('/api/chat', chatRouter);

// V2 is the default UI. Root redirects to /v2/; /legacy/ keeps the
// previous vanilla-JS UI reachable (served from public/index.html via
// express.static) as a fallback during the cutover.
app.get('/', (_req: Request, res: Response): void => { res.redirect('/v2/'); });
app.get(['/legacy', '/legacy/'], (_req: Request, res: Response): void => { res.redirect('/index.html'); });

app.use(express.static(path.join(__dirname, 'public')));

// Port guard — prevent orphan processes and port conflicts
function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => { tester.close(() => resolve(true)); })
      .listen(port);
  });
}

// Initialize workspace storage and run any pending migrations
chatService.initialize().then(async () => {
  const portFree = await checkPort(config.PORT);
  if (!portFree) {
    console.error(
      `[FATAL] Port ${config.PORT} is already in use. ` +
      `Use pm2 to manage this server: npx pm2 restart <app-name>`
    );
    process.exit(1);
  }

  updateService.start();

  // Load last-persisted Claude plan usage snapshot, then fire-and-forget
  // the first refresh. Further refreshes happen opportunistically after
  // each Claude Code assistant turn; both paths respect a 10-min floor.
  claudePlanUsageService.init().then(() => {
    claudePlanUsageService.maybeRefresh('server-start');
  }).catch((err: unknown) => {
    console.warn('[claudePlanUsage] init failed:', (err as Error).message);
  });

  // Same pattern for Kiro. Reads the kiro-cli SQLite store read-only to
  // pick up the IdC access token + CodeWhisperer profile ARN, then calls
  // AmazonCodeWhispererService.GetUsageLimits directly. Skipped silently
  // if kiro-cli isn't installed or the access token has rotated out.
  kiroPlanUsageService.init().then(() => {
    kiroPlanUsageService.maybeRefresh('server-start');
  }).catch((err: unknown) => {
    console.warn('[kiroPlanUsage] init failed:', (err as Error).message);
  });

  // Detect LibreOffice in the background — used by the KB PPTX ingestion
  // path when `Settings.knowledgeBase.convertSlidesToImages` is enabled.
  // Non-fatal: if detection fails or LibreOffice is missing, we log and
  // the KB feature falls back to text-only extraction at ingest time.
  detectLibreOffice().then((status) => {
    if (status.available) {
      console.log(`[kb] LibreOffice detected at ${status.binaryPath}`);
    } else {
      console.log('[kb] LibreOffice not found on PATH (optional — required only for PPTX slide-to-image conversion)');
    }
  }).catch((err: unknown) => {
    console.warn('[kb] LibreOffice detection failed:', (err as Error).message);
  });

  // Detect Pandoc in the background — required by the KB DOCX ingestion
  // path. Unlike LibreOffice this isn't optional: without pandoc, DOCX
  // uploads are rejected at the route level with install instructions.
  // We still start the server so the rest of the app works, and surface
  // the missing-binary state via the `/kb/pandoc-status` endpoint.
  detectPandoc().then((status) => {
    if (status.available) {
      console.log(`[kb] Pandoc detected at ${status.binaryPath}${status.version ? ` (v${status.version})` : ''}`);
    } else {
      console.log('[kb] Pandoc not found on PATH — DOCX uploads will be rejected until pandoc is installed (https://pandoc.org/installing.html)');
    }
  }).catch((err: unknown) => {
    console.warn('[kb] Pandoc detection failed:', (err as Error).message);
  });

  const server = app.listen(config.PORT, () => {
    console.log(`Agent Cockpit running on port ${config.PORT}`);
  });

  // Attach WebSocket server for bidirectional streaming
  const wsFns = attachWebSocket(server, {
    sessionStore,
    sessionSecret: config.SESSION_SECRET,
    activeStreams,
  });
  setWsFunctions(wsFns);

  function shutdown(signal: string) {
    console.log(`\n[shutdown] Received ${signal}, shutting down gracefully...`);

    chatShutdown();
    backendRegistry.shutdownAll();
    wsFns.shutdown();

    server.close(() => {
      console.log('[shutdown] HTTP server closed');
      process.exit(0);
    });

    setTimeout(() => {
      console.error('[shutdown] Forcing exit after 10s timeout');
      process.exit(1);
    }, 10000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}).catch(err => {
  console.error('[startup] Fatal initialization error:', err);
  process.exit(1);
});
