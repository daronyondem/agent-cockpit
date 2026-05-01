// ── Memory MCP Server ───────────────────────────────────────────────────────
//
// Exposes a `memory_note` MCP tool to non-Claude CLIs so they can persist
// durable memory into workspace storage at `data/chat/workspaces/{hash}/memory/`.
//
// Architecture:
//   1. When a non-Claude session starts for a Memory-enabled workspace,
//      `issueMemoryMcpSession(convId, hash)` mints a per-session bearer
//      token and returns an ACP-compatible `mcpServers` array pointing at
//      `stub.cjs`.  The stub is a tiny dependency-free Node process that
//      speaks MCP over stdio and forwards `memory_note` tool calls to the
//      HTTP endpoint below.
//
//   2. This router mounts `POST /mcp/memory/notes` on the chat API.
//      On each incoming note it:
//        - Authorizes via `X-Memory-Token`.
//        - Resolves the session's conversation + workspace hash.
//        - Verifies `memoryEnabled` on the workspace.
//        - Loads the current merged snapshot (for dedup context).
//        - Spawns the globally-configured **Memory CLI** via its backend
//          adapter's `runOneShot()` helper, with a prompt that asks the
//          CLI to either classify+format the note into a frontmatter
//          markdown entry or emit `SKIP:<filename>` when the note is a
//          duplicate of an existing memory.
//        - On success, writes the entry via `chatService.addMemoryNoteEntry`
//          and notifies any connected WebSocket with a `memory_update` frame
//          so open memory panels refresh in place.
//
// The separation of concerns here is deliberate:
//   - The CLI spoken to via MCP ("the user's CLI") knows *when* to call
//     `memory_note`.  It gets prompt guidance from the system prompt
//     addendum added in the Kiro backend wiring.
//   - The Memory CLI ("the configured Memory CLI") knows *how* to format
//     and dedupe notes.  It's invoked server-side for each note so the
//     main chat CLI doesn't need to understand the memory file layout.

import express from 'express';
import crypto from 'crypto';
import path from 'path';
import type { Request, Response, Message } from '../../types';
import type { ChatService } from '../chatService';
import type { BackendRegistry } from '../backends/registry';
import type { WsFunctions } from '../../ws';
import { parseFrontmatter } from '../backends/claudeCode';

// ── Session registry ────────────────────────────────────────────────────────

interface MemoryMcpSession {
  token: string;
  conversationId: string;
  workspaceHash: string;
  createdAt: number;
}

/** Absolute path to the stdio stub launched by non-Claude CLIs as an MCP server. */
export const MEMORY_MCP_STUB_PATH = path.resolve(__dirname, 'stub.cjs');

// ── Helpers ─────────────────────────────────────────────────────────────────

function mintToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Render the prompt we hand to the Memory CLI for a single `memory_note`
 * call.  The CLI is expected to reply with either:
 *   - `SKIP: <filename>` when the note duplicates an existing entry, or
 *   - a full frontmatter markdown document starting with `---`.
 *
 * We deliberately keep the prompt structured so a small, cheap model can
 * handle it reliably.
 */
function buildMemoryNotePrompt(args: {
  content: string;
  type?: string;
  tags?: string[];
  existing: Array<{ filename: string; type: string; description: string | null; name: string | null }>;
}): string {
  const typeHint = args.type ? `\nSuggested type: ${args.type}` : '';
  const tagsHint = args.tags && args.tags.length ? `\nSuggested tags: ${args.tags.join(', ')}` : '';
  const existingList = args.existing.length
    ? args.existing
        .map(
          (f) =>
            `- [${f.type}] ${f.filename} — ${f.description || f.name || '(no description)'}`,
        )
        .join('\n')
    : '(none yet)';

  return `You are the Memory Librarian for an AI coding assistant. A CLI session has captured a new memory note. Your job is to either reject it as a duplicate of an existing memory, or format it as a single, well-structured memory file.

## Existing memory entries
${existingList}

## New note (raw, from the CLI)
${args.content}${typeHint}${tagsHint}

## Memory types
- user: user's role, preferences, expertise, or responsibilities
- feedback: corrections or confirmations the user has given (keep a "Why:" line)
- project: ongoing work context, deadlines, stakeholders, motivations (keep a "Why:" line)
- reference: pointers to external resources (Linear, Slack, dashboards, etc.)

## Output format
Reply with EXACTLY ONE of these two formats — nothing else, no prose, no code fences:

### Option A — duplicate of existing entry
\`SKIP: <filename-from-the-existing-list>\`

Use this when the new note adds no information beyond what an existing entry already captures.

### Option B — new entry
Emit a complete markdown file starting with a YAML frontmatter block:

\`\`\`
---
name: <short slug, lowercase with underscores, max 40 chars>
description: <one-line description, max 150 chars — what this memory is about>
type: <user | feedback | project | reference>
---

<body: the fact, rule, or reference. For feedback/project include **Why:** and **How to apply:** lines.>
\`\`\`

Rules:
- Be terse; do not invent facts beyond the raw note.
- Use the suggested type if it is provided and appropriate.
- If the new note is ambiguous or too thin to be useful, still write it out — do NOT SKIP unless it is a clear duplicate.
- Output ONLY the file content. Do not wrap it in markdown code fences.
`;
}

/**
 * Build the prompt we hand to the Memory CLI for end-of-session extraction.
 * The CLI is expected to scan the transcript and reply with either:
 *   - `NONE` when there is nothing new worth remembering, or
 *   - one or more frontmatter markdown documents, each delimited by a
 *     line containing only `===`.
 */
function buildExtractionPrompt(args: {
  transcript: string;
  existing: Array<{ filename: string; type: string; description: string | null; name: string | null }>;
}): string {
  const existingList = args.existing.length
    ? args.existing
        .map(
          (f) =>
            `- [${f.type}] ${f.filename} — ${f.description || f.name || '(no description)'}`,
        )
        .join('\n')
    : '(none yet)';

  return `You are the Memory Librarian for an AI coding assistant. A chat session just ended. Your job is to scan the transcript and extract any new durable memories that weren't already captured.

## Existing memory entries
${existingList}

## Session transcript
${args.transcript}

## Memory types
- user: user's role, preferences, expertise, or responsibilities
- feedback: corrections or confirmations the user gave during this session (keep a "Why:" line)
- project: ongoing work context, deadlines, stakeholders, motivations (keep a "Why:" line)
- reference: pointers to external resources (Linear, Slack, dashboards, etc.)

## What to extract (and what NOT to)
Extract ONLY non-obvious facts that will be useful in a future session and are NOT already captured. Good candidates:
- User said "I'm a data scientist" → user memory
- User corrected your approach with a reason → feedback memory
- User mentioned a deadline or external dependency → project memory
- User pointed to a dashboard or ticket tracker → reference memory

Do NOT extract:
- Ephemeral task state ("we were debugging X")
- Things already visible in git history or the codebase
- Duplicates of existing entries (check the list above)
- Your own explanations or solutions

## Output format
Reply with EXACTLY ONE of these formats — nothing else:

### Option A — no new memories worth keeping
\`NONE\`

### Option B — one or more new entries
Emit each entry as a complete markdown file starting with a YAML frontmatter block. Separate multiple entries with a line containing only \`===\`:

\`\`\`
---
name: <short slug, lowercase with underscores, max 40 chars>
description: <one-line description, max 150 chars>
type: <user | feedback | project | reference>
---

<body>
===
---
name: <second entry>
description: ...
type: ...
---

<body>
\`\`\`

Be terse. Output ONLY the content. Do not wrap in code fences.
`;
}

/** Extract a filename hint from a frontmatter `name:` line. */
function nameFromFrontmatter(content: string): string | null {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  const block = content.slice(3, end);
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (line.toLowerCase().startsWith('name:')) {
      let value = line.slice(5).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value || null;
    }
  }
  return null;
}

// ── Factory ─────────────────────────────────────────────────────────────────

interface CreateMemoryMcpDeps {
  chatService: ChatService;
  backendRegistry: BackendRegistry;
  getWsFns: () => Pick<WsFunctions, 'send' | 'isConnected'> | null;
}

export function createMemoryMcpServer({ chatService, backendRegistry, getWsFns }: CreateMemoryMcpDeps) {
  const sessions = new Map<string, MemoryMcpSession>(); // token → session
  const byConversation = new Map<string, string>(); // convId → token

  /**
   * Issue (or re-use) a token + `mcpServers` entry for a non-Claude
   * session.
   *
   * ## Idempotency
   *
   * This function is called by the chat route on **every message** a
   * memory-enabled workspace sends to a non-Claude backend, but the
   * MCP stub is only ever spawned once per ACP session — kiro-cli
   * spawns it inside `session/new` (or `session/load` on rehydrate)
   * and keeps it alive for the lifetime of that ACP process.  The
   * stub captures its bearer token from its spawn-time env and never
   * reads the env again.
   *
   * If we minted a fresh token on every call, every message after the
   * first one would revoke the token the still-running stub is holding,
   * and the model's next `memory_note` call would hit the endpoint with
   * an orphaned token and get HTTP 401.  So when a token already exists
   * for this conversation, we return it unchanged.  Rotation happens
   * exclusively at real lifetime boundaries: `revokeMemoryMcpSession`
   * is called on session reset, conversation delete, and graceful
   * shutdown.
   *
   * ## ACP env shape
   *
   * The returned `mcpServers` entry follows the ACP stdio MCP schema:
   * `env` is an **array of `{name, value}` objects**, NOT a plain
   * `Record<string, string>`.  Passing a plain object here causes
   * kiro-cli (and other strict ACP servers) to fail deserialization
   * and crash the ACP process with "ACP process closed".
   * See https://agentclientprotocol.com/protocol/session-setup
   */
  function issueMemoryMcpSession(conversationId: string, workspaceHash: string): {
    token: string;
    mcpServers: Array<{
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
    }>;
  } {
    // Reuse the existing token for this conversation if one is already
    // live.  We only mint a fresh token when none exists, or when the
    // cached session points at a different workspace (e.g. if the
    // conversation's workspace changed out from under us).
    const cachedToken = byConversation.get(conversationId);
    const cached = cachedToken ? sessions.get(cachedToken) : undefined;
    let token: string;
    if (cached && cached.workspaceHash === workspaceHash) {
      token = cached.token;
    } else {
      if (cachedToken) {
        // Stale or workspace mismatch — drop the old token before minting.
        revokeMemoryMcpSession(conversationId);
      }
      token = mintToken();
      sessions.set(token, {
        token,
        conversationId,
        workspaceHash,
        createdAt: Date.now(),
      });
      byConversation.set(conversationId, token);
    }

    // The endpoint URL is built relative to the in-process Express app.
    // Callers pass this in the env of the spawned MCP stub.
    const port = Number(process.env.PORT) || 3334;
    const endpoint = `http://127.0.0.1:${port}/api/chat/mcp/memory/notes`;

    return {
      token,
      mcpServers: [
        {
          name: 'agent-cockpit-memory',
          command: 'node',
          args: [MEMORY_MCP_STUB_PATH],
          env: [
            { name: 'MEMORY_TOKEN', value: token },
            { name: 'MEMORY_ENDPOINT', value: endpoint },
          ],
        },
      ],
    };
  }

  /** Revoke the token associated with a conversation (on session reset/close). */
  function revokeMemoryMcpSession(conversationId: string): void {
    const token = byConversation.get(conversationId);
    if (!token) return;
    sessions.delete(token);
    byConversation.delete(conversationId);
  }

  // ── HTTP router ───────────────────────────────────────────────────────────

  const router = express.Router();

  router.post('/memory/notes', async (req: Request, res: Response) => {
    const token = req.header('x-memory-token') || '';
    const session = token ? sessions.get(token) : null;
    if (!session) {
      return res.status(401).json({ error: 'Invalid or missing memory token' });
    }

    const { content, type: typeHint, tags } = (req.body || {}) as {
      content?: string;
      type?: string;
      tags?: string[];
    };
    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content is required' });
    }

    try {
      const hash = session.workspaceHash;
      const enabled = await chatService.getWorkspaceMemoryEnabled(hash);
      if (!enabled) {
        return res.status(403).json({ error: 'Memory is disabled for this workspace' });
      }

      // Build dedup context from the current snapshot.
      const snapshot = await chatService.getWorkspaceMemory(hash);
      const existing = (snapshot?.files || []).map((f) => ({
        filename: f.filename,
        type: f.type,
        description: f.description,
        name: f.name,
      }));

      // Resolve the configured Memory CLI.
      const settings = await chatService.getSettings();
      const memoryRuntime = await chatService.resolveCliProfileRuntime(
        settings.memory?.cliProfileId,
        settings.memory?.cliBackend || settings.defaultBackend || 'claude-code',
      );
      const cliId = memoryRuntime.backendId;
      const adapter = backendRegistry.get(cliId);
      if (!adapter) {
        return res.status(500).json({ error: `Memory CLI not registered: ${cliId}` });
      }

      const prompt = buildMemoryNotePrompt({
        content: content.trim(),
        type: typeHint,
        tags,
        existing,
      });

      let rawOutput: string;
      try {
        rawOutput = await adapter.runOneShot(prompt, {
          model: settings.memory?.cliModel,
          effort: settings.memory?.cliEffort,
          timeoutMs: 90_000,
          cliProfile: memoryRuntime.profile,
        });
      } catch (err: unknown) {
        console.error(`[memoryMcp] Memory CLI (${cliId}) failed:`, (err as Error).message);
        return res.status(502).json({ error: `Memory CLI failed: ${(err as Error).message}` });
      }

      const cleaned = (rawOutput || '').trim();
      if (!cleaned) {
        return res.status(502).json({ error: 'Memory CLI returned empty output' });
      }

      // Handle SKIP response.
      const skipMatch = cleaned.match(/^SKIP:\s*(\S+)/i);
      if (skipMatch) {
        console.log(`[memoryMcp] Memory CLI skipped note as duplicate of ${skipMatch[1]}`);
        return res.json({ ok: true, skipped: skipMatch[1] });
      }

      // Otherwise expect a frontmatter markdown document.
      if (!cleaned.startsWith('---')) {
        console.warn('[memoryMcp] Memory CLI output missing frontmatter; saving as-is');
      }
      const parsed = parseFrontmatter(cleaned);
      const filenameHint = nameFromFrontmatter(cleaned) || parsed.name || typeHint || 'note';

      const relPath = await chatService.addMemoryNoteEntry(hash, {
        content: cleaned,
        source: 'memory-note',
        filenameHint,
      });

      // Fire a WebSocket update so any open memory panel refreshes.
      const freshSnapshot = await chatService.getWorkspaceMemory(hash);
      const wsFns = getWsFns();
      if (wsFns && wsFns.isConnected(session.conversationId)) {
        wsFns.send(session.conversationId, {
          type: 'memory_update',
          capturedAt: freshSnapshot?.capturedAt || new Date().toISOString(),
          fileCount: freshSnapshot?.files.length || 0,
          changedFiles: [relPath],
        });
      }

      return res.json({ ok: true, filename: relPath });
    } catch (err: unknown) {
      console.error('[memoryMcp] Note handler failed:', err);
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * Post-session extraction for non-Claude CLIs.  Renders the given
   * transcript into a prompt, runs the configured Memory CLI via
   * `runOneShot`, parses the response, and writes any new entries via
   * `addMemoryNoteEntry`.  Best-effort: any errors are logged and
   * swallowed so this never blocks the session reset flow.
   *
   * Returns the number of new entries persisted (0 if none or on failure).
   */
  async function extractMemoryFromSession(args: {
    workspaceHash: string;
    conversationId: string;
    messages: Array<Pick<Message, 'role' | 'content'>>;
  }): Promise<number> {
    const { workspaceHash: hash, conversationId, messages } = args;
    if (!messages || messages.length === 0) return 0;

    try {
      const enabled = await chatService.getWorkspaceMemoryEnabled(hash);
      if (!enabled) return 0;

      // Load existing snapshot for dedup context.
      const snapshot = await chatService.getWorkspaceMemory(hash);
      const existing = (snapshot?.files || []).map((f) => ({
        filename: f.filename,
        type: f.type,
        description: f.description,
        name: f.name,
      }));

      // Render a bounded transcript: cap each message at 1500 chars and
      // stop once we hit 20k total chars to keep the prompt reasonable.
      const TRANSCRIPT_CHAR_BUDGET = 20000;
      const PER_MESSAGE_CAP = 1500;
      let transcript = '';
      for (const msg of messages) {
        const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System';
        const body = (msg.content || '').slice(0, PER_MESSAGE_CAP);
        const line = `${role}: ${body}\n\n`;
        if (transcript.length + line.length > TRANSCRIPT_CHAR_BUDGET) break;
        transcript += line;
      }
      if (!transcript.trim()) return 0;

      // Resolve the Memory CLI.
      const settings = await chatService.getSettings();
      const memoryRuntime = await chatService.resolveCliProfileRuntime(
        settings.memory?.cliProfileId,
        settings.memory?.cliBackend || settings.defaultBackend || 'claude-code',
      );
      const cliId = memoryRuntime.backendId;
      const adapter = backendRegistry.get(cliId);
      if (!adapter) {
        console.error(`[memoryMcp] extract: Memory CLI not registered: ${cliId}`);
        return 0;
      }

      const prompt = buildExtractionPrompt({ transcript, existing });
      let rawOutput: string;
      try {
        rawOutput = await adapter.runOneShot(prompt, {
          model: settings.memory?.cliModel,
          effort: settings.memory?.cliEffort,
          timeoutMs: 120_000,
          cliProfile: memoryRuntime.profile,
        });
      } catch (err: unknown) {
        console.error(`[memoryMcp] extract: Memory CLI (${cliId}) failed:`, (err as Error).message);
        return 0;
      }

      const cleaned = (rawOutput || '').trim();
      if (!cleaned || /^NONE\s*$/i.test(cleaned)) {
        console.log(`[memoryMcp] extract: no new memories for conv=${conversationId}`);
        return 0;
      }

      // Split on `===` delimiters.  Individual entries may or may not
      // start with `---` — we accept both and let `parseFrontmatter`
      // handle missing frontmatter gracefully.
      const rawEntries = cleaned
        .split(/\n===\n/)
        .map((e) => e.trim())
        .filter(Boolean);

      let savedCount = 0;
      const savedRelPaths: string[] = [];
      for (const entry of rawEntries) {
        try {
          const parsed = parseFrontmatter(entry);
          const filenameHint = nameFromFrontmatter(entry) || parsed.name || 'session';
          const relPath = await chatService.addMemoryNoteEntry(hash, {
            content: entry,
            source: 'session-extraction',
            filenameHint,
          });
          savedCount++;
          savedRelPaths.push(relPath);
        } catch (err: unknown) {
          console.error(`[memoryMcp] extract: failed to save entry:`, (err as Error).message);
        }
      }

      if (savedCount > 0) {
        console.log(`[memoryMcp] extract: saved ${savedCount} entry(ies) for conv=${conversationId}`);
        const freshSnapshot = await chatService.getWorkspaceMemory(hash);
        const wsFns = getWsFns();
        if (wsFns && wsFns.isConnected(conversationId)) {
          wsFns.send(conversationId, {
            type: 'memory_update',
            capturedAt: freshSnapshot?.capturedAt || new Date().toISOString(),
            fileCount: freshSnapshot?.files.length || 0,
            changedFiles: savedRelPaths,
          });
        }
      }

      return savedCount;
    } catch (err: unknown) {
      console.error('[memoryMcp] extractMemoryFromSession failed:', (err as Error).message);
      return 0;
    }
  }

  return {
    router,
    issueMemoryMcpSession,
    revokeMemoryMcpSession,
    extractMemoryFromSession,
  };
}

export type MemoryMcpServer = ReturnType<typeof createMemoryMcpServer>;
