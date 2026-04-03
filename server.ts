import net from 'net';
import path from 'path';
import express from 'express';
import session from 'express-session';
import FileStoreFactory from 'session-file-store';
import config from './src/config';
import { setupAuth, requireAuth } from './src/middleware/auth';
import { ensureCsrfToken } from './src/middleware/csrf';
import { applySecurity } from './src/middleware/security';
import { createChatRouter } from './src/routes/chat';
import { attachWebSocket } from './src/ws';
import { ChatService } from './src/services/chatService';
import { BackendRegistry } from './src/services/backends/registry';
import { ClaudeCodeAdapter } from './src/services/backends/claudeCode';
import { UpdateService } from './src/services/updateService';
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

setupAuth(app, config);

app.use(requireAuth);
app.use(ensureCsrfToken);

app.use(express.json());

app.get('/api/csrf-token', (req: Request, res: Response) => {
  res.json({ csrfToken: req.session.csrfToken });
});

const backendRegistry = new BackendRegistry();
backendRegistry.register(new ClaudeCodeAdapter({ workingDir: config.DEFAULT_WORKSPACE }));

const chatService = new ChatService(__dirname, { defaultWorkspace: config.DEFAULT_WORKSPACE, backendRegistry });
const updateService = new UpdateService(__dirname);
const { router: chatRouter, shutdown: chatShutdown, activeStreams, setWsFunctions } = createChatRouter({ chatService, backendRegistry, updateService });
app.use('/api/chat', chatRouter);

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
