const path = require('path');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const config = require('./src/config');
const { setupAuth, requireAuth } = require('./src/middleware/auth');
const { ensureCsrfToken } = require('./src/middleware/csrf');
const { applySecurity } = require('./src/middleware/security');
const { createChatRouter } = require('./src/routes/chat');
const { ChatService } = require('./src/services/chatService');
const { CLIBackend } = require('./src/services/cliBackend');

const app = express();

app.set('trust proxy', 1);

applySecurity(app);

app.use(session({
  store: new FileStore({
    path: path.join(__dirname, 'data', 'sessions'),
    ttl: 24 * 60 * 60,
    retries: 0,
  }),
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
app.use((req, res, next) => {
  if (req.session && !req.session.regenerate) {
    req.session.regenerate = (cb) => cb();
  }
  if (req.session && !req.session.save) {
    req.session.save = (cb) => cb();
  }
  next();
});

setupAuth(app, config);

app.use(requireAuth);
app.use(ensureCsrfToken);

app.use(express.json());

app.get('/api/csrf-token', (req, res) => {
  res.json({ csrfToken: req.session.csrfToken });
});

const chatService = new ChatService(__dirname, { defaultWorkspace: config.DEFAULT_WORKSPACE });
const cliBackend = new CLIBackend({ workingDir: config.DEFAULT_WORKSPACE });
const { router: chatRouter, shutdown: chatShutdown } = createChatRouter({ chatService, cliBackend });
app.use('/api/chat', chatRouter);

app.use(express.static(path.join(__dirname, 'public')));

// Initialize workspace storage and run any pending migrations
chatService.initialize().then(() => {
  const server = app.listen(config.PORT, () => {
    console.log(`Agent Cockpit running on port ${config.PORT}`);
  });

  function shutdown(signal) {
    console.log(`\n[shutdown] Received ${signal}, shutting down gracefully...`);

    chatShutdown();

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
