const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const { csrfGuard } = require('../middleware/csrf');

function createChatRouter({ chatService, cliBackend }) {
  const router = express.Router();

  // Track active streams so we can abort them
  const activeStreams = new Map();

  // ── Browse directories ─────────────────────────────────────────────────────
  router.get('/browse', (req, res) => {
    try {
      const dirPath = req.query.path || os.homedir();
      const showHidden = req.query.showHidden === 'true';

      const resolved = path.resolve(dirPath);
      if (!fs.existsSync(resolved)) {
        return res.status(400).json({ error: 'Path does not exist' });
      }
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }

      let entries;
      try {
        entries = fs.readdirSync(resolved, { withFileTypes: true });
      } catch (readErr) {
        return res.status(403).json({ error: 'Permission denied: ' + resolved });
      }
      let dirs = [];
      for (const e of entries) {
        try {
          if (e.isDirectory()) dirs.push(e.name);
        } catch { /* skip entries that can't be stat'd */ }
      }
      dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      if (!showHidden) {
        dirs = dirs.filter(d => !d.startsWith('.'));
      }

      const parent = path.dirname(resolved);
      res.json({
        currentPath: resolved,
        parent: parent !== resolved ? parent : null,
        dirs,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── List conversations ─────────────────────────────────────────────────────
  router.get('/conversations', async (req, res) => {
    try {
      const q = req.query.q || '';
      const convs = q ? await chatService.searchConversations(q) : await chatService.listConversations();
      res.json({ conversations: convs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Get single conversation ────────────────────────────────────────────────
  router.get('/conversations/:id', async (req, res) => {
    try {
      const conv = await chatService.getConversation(req.params.id);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
      res.json(conv);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Create conversation ────────────────────────────────────────────────────
  router.post('/conversations', csrfGuard, async (req, res) => {
    try {
      const conv = await chatService.createConversation(req.body.title, req.body.workingDir);
      res.json(conv);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Rename conversation ────────────────────────────────────────────────────
  router.put('/conversations/:id', csrfGuard, async (req, res) => {
    try {
      const conv = await chatService.renameConversation(req.params.id, req.body.title);
      if (!conv) return res.status(404).json({ error: 'Conversation not found' });
      res.json(conv);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Delete conversation ────────────────────────────────────────────────────
  router.delete('/conversations/:id', csrfGuard, async (req, res) => {
    try {
      // Abort any active stream
      const entry = activeStreams.get(req.params.id);
      if (entry) {
        entry.abort();
        activeStreams.delete(req.params.id);
      }
      const ok = await chatService.deleteConversation(req.params.id);
      if (!ok) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Download conversation as markdown ──────────────────────────────────────
  router.get('/conversations/:id/download', async (req, res) => {
    try {
      const md = await chatService.conversationToMarkdown(req.params.id);
      if (!md) return res.status(404).json({ error: 'Conversation not found' });
      const conv = await chatService.getConversation(req.params.id);
      const filename = (conv.title || 'conversation').replace(/[^a-zA-Z0-9-_ ]/g, '').substring(0, 50).trim() + '.md';
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(md);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Session history ────────────────────────────────────────────────────────
  router.get('/conversations/:id/sessions', async (req, res) => {
    try {
      const sessions = await chatService.getSessionHistory(req.params.id);
      if (!sessions) return res.status(404).json({ error: 'Conversation not found' });
      res.json({ sessions });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Reset session ──────────────────────────────────────────────────────────
  router.post('/conversations/:id/reset', csrfGuard, async (req, res) => {
    try {
      // Block if streaming
      if (activeStreams.has(req.params.id)) {
        return res.status(409).json({ error: 'Cannot reset session while streaming' });
      }
      const result = await chatService.resetSession(req.params.id);
      if (!result) return res.status(404).json({ error: 'Conversation not found' });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Send message + stream response (SSE) ──────────────────────────────────
  router.post('/conversations/:id/message', csrfGuard, async (req, res) => {
    const convId = req.params.id;
    const { content, backend } = req.body;

    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'Message content required' });
    }

    const conv = await chatService.getConversation(convId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    // Update backend if changed
    if (backend && backend !== conv.backend) {
      conv.backend = backend;
      await chatService.saveConversation(conv);
    }

    // Add user message
    const userMsg = await chatService.addMessage(convId, 'user', content.trim(), backend || conv.backend);

    // Determine if this is the first message in the current Claude Code session
    const currentSession = conv.sessions[conv.sessions.length - 1];
    const isNewSession = !currentSession || currentSession.messageCount === 0;

    // Start CLI streaming — store stream reference for the GET SSE endpoint
    console.log(`[chat] Starting CLI stream for conv=${convId} session=${conv.currentSessionId} isNew=${isNewSession} workingDir=${conv.workingDir || 'default'}`);
    const { stream, abort } = cliBackend.sendMessage(content.trim(), {
      sessionId: conv.currentSessionId,
      isNewSession,
      workingDir: conv.workingDir || null,
    });
    activeStreams.set(convId, { stream, abort, backend: backend || conv.backend });

    // Return the user message — frontend will open GET SSE for streaming
    res.json({ userMessage: userMsg, streamReady: true });
  });

  // ── SSE stream (GET — avoids express-session res.end hook issues with POST SSE) ──
  router.get('/conversations/:id/stream', (req, res) => {
    const convId = req.params.id;
    const entry = activeStreams.get(convId);

    if (!entry) {
      res.status(404).json({ error: 'No active stream' });
      return;
    }

    const { stream, abort, backend } = entry;

    // Raw SSE response — bypass express response handling
    res.socket.setTimeout(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }, 5000);

    req.on('close', () => {
      console.log(`[chat] SSE client disconnected for conv=${convId}`);
      clearInterval(keepalive);
      const e = activeStreams.get(convId);
      if (e) {
        e.abort();
        activeStreams.delete(convId);
      }
    });

    let fullResponse = '';
    let resultText = null;

    (async () => {
      try {
        for await (const event of stream) {
          if (res.writableEnded) break;

          if (event.type === 'text') {
            fullResponse += event.content;
            res.write(`data: ${JSON.stringify({ type: 'text', content: event.content })}\n\n`);
          } else if (event.type === 'result') {
            resultText = event.content;
          } else if (event.type === 'error') {
            console.error(`[chat] Stream error for conv=${convId}:`, event.error);
            res.write(`data: ${JSON.stringify({ type: 'error', error: event.error })}\n\n`);
          } else if (event.type === 'done') {
            const finalContent = resultText || fullResponse;
            console.log(`[chat] Stream done for conv=${convId}, responseLen=${finalContent.length}`);
            if (finalContent.trim()) {
              const assistantMsg = await chatService.addMessage(convId, 'assistant', finalContent.trim(), backend);
              res.write(`data: ${JSON.stringify({ type: 'assistant_message', message: assistantMsg })}\n\n`);
            }
            res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
          }
        }
      } catch (err) {
        console.error(`[chat] Stream exception for conv=${convId}:`, err);
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        }
      } finally {
        clearInterval(keepalive);
        activeStreams.delete(convId);
        if (!res.writableEnded) res.end();
      }
    })();
  });

  // ── Abort streaming ────────────────────────────────────────────────────────
  router.post('/conversations/:id/abort', csrfGuard, (req, res) => {
    const entry = activeStreams.get(req.params.id);
    if (entry) {
      entry.abort();
      activeStreams.delete(req.params.id);
      res.json({ ok: true });
    } else {
      res.json({ ok: false, message: 'No active stream' });
    }
  });

  // ── File upload ─────────────────────────────────────────────────────────────
  const upload = multer({
    storage: multer.diskStorage({
      destination: async (req, file, cb) => {
        const conv = await chatService.getConversation(req.params.id);
        const dir = conv?.workingDir || cliBackend.workingDir;
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const safe = file.originalname.replace(/[\/\\]/g, '_');
        cb(null, safe);
      }
    }),
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB
  });

  router.post('/conversations/:id/upload', csrfGuard, upload.array('files', 10), (req, res) => {
    const files = (req.files || []).map(f => ({
      name: f.originalname,
      path: f.path,
      size: f.size,
    }));
    res.json({ files });
  });

  // ── Settings ───────────────────────────────────────────────────────────────
  router.get('/settings', async (req, res) => {
    try {
      res.json(await chatService.getSettings());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/settings', csrfGuard, async (req, res) => {
    try {
      const settings = await chatService.saveSettings(req.body);
      res.json(settings);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Shutdown helper (abort all active CLI processes) ────────────────────────
  function shutdown() {
    for (const [convId, entry] of activeStreams) {
      console.log(`[shutdown] Aborting active stream for conv=${convId}`);
      entry.abort();
    }
    activeStreams.clear();
  }

  return { router, shutdown };
}

module.exports = { createChatRouter };
