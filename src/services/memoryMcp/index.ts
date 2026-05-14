// ── Memory MCP Server ───────────────────────────────────────────────────────
//
// Exposes `memory_search` and `memory_note` MCP tools to CLIs so they can
// retrieve and persist durable memory in workspace storage at
// `data/chat/workspaces/{hash}/memory/`.
//
// Architecture:
//   1. When a non-Claude session starts for a Memory-enabled workspace,
//      `issueMemoryMcpSession(convId, hash)` mints a per-session bearer
//      token and returns an ACP-compatible `mcpServers` array pointing at
//      `stub.cjs`.  The stub is a tiny dependency-free Node process that
//      speaks MCP over stdio and forwards memory tool calls to the HTTP
//      endpoints below.
//
//   2. This router mounts `POST /mcp/memory/search` and
//      `POST /mcp/memory/notes` on the chat API.
//      On each incoming tool call it:
//        - Authorizes via `X-Memory-Token`.
//        - Resolves the session's conversation + workspace hash.
//        - Verifies `memoryEnabled` on the workspace.
//        - For search: runs local lexical recall over the merged snapshot.
//        - For notes: loads the current merged snapshot (for dedup context).
//        - Spawns the globally-configured **Memory CLI** via its backend
//          adapter's `runOneShot()` helper for write governance, with a
//          prompt that asks the CLI for a JSON save/skip/supersede decision.
//        - On success, writes the entry via `chatService.addMemoryNoteEntry`
//          and emits a workspace-scoped `memory_update` frame so open
//          memory panels refresh in place.
//
// The separation of concerns here is deliberate:
//   - The CLI spoken to via MCP ("the user's CLI") knows *when* to call
//     `memory_search` and `memory_note`.  It gets prompt guidance from the system prompt
//     addendum added in the Kiro backend wiring.
//   - The Memory CLI ("the configured Memory CLI") knows *how* to format
//     and dedupe notes.  It's invoked server-side for each note so the
//     main chat CLI doesn't need to understand the memory file layout.

import express from 'express';
import crypto from 'crypto';
import path from 'path';
import type {
  CliProfile,
  Request,
  Response,
  Settings,
  Message,
  MemoryFile,
  MemoryProcessorStatus,
  MemoryProcessorStatusSnapshot,
  MemoryRedaction,
  MemoryStatus,
  MemoryConsolidationAction,
  MemoryConsolidationActionType,
  MemoryConsolidationApplyResult,
  MemoryConsolidationDraft,
  MemoryConsolidationDraftApplyResult,
  MemoryConsolidationDraftOperation,
  MemoryConsolidationDraftOperationType,
  MemoryConsolidationProposal,
  MemoryReviewDraftItem,
  MemoryReviewRun,
  MemoryReviewRunSource,
  MemoryReviewUpdateEvent,
  MemoryUpdateEvent,
  MemoryWriteAction,
  MemoryWriteOutcome,
} from '../../types';
import type { ChatService } from '../chatService';
import type { BackendRegistry } from '../backends/registry';
import { parseFrontmatter } from '../backends/claudeCode';
import { backendForCliProfile } from '../cliProfiles';
import { logger } from '../../utils/logger';

// ── Session registry ────────────────────────────────────────────────────────

interface MemoryMcpSession {
  token: string;
  conversationId: string;
  workspaceHash: string;
  createdAt: number;
  activeChatProfile?: MemoryProfileContext;
}

interface MemoryProfileContext {
  backendId?: string;
  profileId?: string;
  profileName?: string;
}

interface MemoryMcpSessionOptions {
  activeChatRuntime?: {
    backendId: string;
    cliProfileId?: string;
    profile?: CliProfile;
  };
}

/** Absolute path to the stdio stub launched by non-Claude CLIs as an MCP server. */
export const MEMORY_MCP_STUB_PATH = path.resolve(__dirname, 'stub.cjs');

// ── Helpers ─────────────────────────────────────────────────────────────────

function mintToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Render the prompt we hand to the Memory CLI for a single `memory_note`
 * call.  The CLI is expected to reply with a JSON decision object. Legacy
 * `SKIP:<filename>` and frontmatter-only outputs are still accepted by the
 * parser for older Memory CLI prompts.
 *
 * We deliberately keep the prompt structured so a small, cheap model can
 * handle it reliably.
 */
function buildMemoryNotePrompt(args: {
  content: string;
  type?: string;
  tags?: string[];
  redactions?: MemoryRedaction[];
  existing: Array<{ filename: string; type: string; description: string | null; name: string | null }>;
}): string {
  const typeHint = args.type ? `\nSuggested type: ${args.type}` : '';
  const tagsHint = args.tags && args.tags.length ? `\nSuggested tags: ${args.tags.join(', ')}` : '';
  const redactionHint = args.redactions && args.redactions.length
    ? `\nRedaction notice: Agent Cockpit replaced ${args.redactions.length} sensitive value${args.redactions.length === 1 ? '' : 's'} with [REDACTED: ...] placeholders before this prompt. Preserve those placeholders and do not reconstruct the original values.`
    : '';
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
${args.content}${typeHint}${tagsHint}${redactionHint}

## Memory types
- user: user's role, preferences, expertise, or responsibilities
- feedback: corrections or confirmations the user has given (keep a "Why:" line)
- project: ongoing work context, deadlines, stakeholders, motivations (keep a "Why:" line)
- reference: pointers to external resources (Linear, Slack, dashboards, etc.)

## Output format
Reply with EXACTLY ONE JSON object — nothing else, no prose, no code fences.

### Duplicate of existing entry

\`\`\`json
{
  "action": "skipped_duplicate",
  "reason": "The note repeats an existing memory.",
  "duplicateOf": "<filename-from-the-existing-list>"
}
\`\`\`

Use this when the new note adds no information beyond what an existing entry already captures.

### Ephemeral or unsuitable for durable memory

\`\`\`json
{
  "action": "skipped_ephemeral",
  "reason": "The note is short-lived task state."
}
\`\`\`

Use this when the new note is temporary task state, a one-off command result, or too thin/ambiguous to be useful later.

### New entry

\`\`\`json
{
  "action": "saved",
  "reason": "The note captures a durable preference.",
  "entry": "---\\nname: <short slug, lowercase with underscores, max 40 chars>\\ndescription: <one-line description, max 150 chars — what this memory is about>\\ntype: <user | feedback | project | reference>\\n---\\n\\n<body>"
}
\`\`\`

### Replacement entry that supersedes older memories

\`\`\`json
{
  "action": "superseded_saved",
  "reason": "The note updates older memory entries.",
  "supersedes": ["<filename-from-the-existing-list>"],
  "entry": "---\\nname: <short slug>\\ndescription: <one-line description>\\ntype: <user | feedback | project | reference>\\n---\\n\\n<body>"
}
\`\`\`

The entry value must be a complete markdown file starting with a YAML frontmatter block:

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
- If the new note is ambiguous or too thin to be useful, use skipped_ephemeral with a short reason.
- Preserve any [REDACTED: ...] placeholders exactly as provided.
- Output ONLY the JSON object. Do not wrap it in markdown code fences.
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

function buildMemoryConsolidationPrompt(args: {
  entries: MemoryFile[];
}): string {
  const entries = args.entries.map((entry) => {
    const status = entry.metadata?.status || 'active';
    const redacted = status === 'redacted' || (entry.metadata?.redaction || []).length > 0;
    const body = redacted
      ? '[redacted content withheld; use filename/name/description only and do not reconstruct secrets]'
      : (entry.content || '').slice(0, 1200);
    return [
      `### ${entry.filename}`,
      `entry_id: ${entry.metadata?.entryId || ''}`,
      `type: ${entry.type}`,
      `status: ${status}`,
      `source: ${entry.source || entry.metadata?.source || 'cli-capture'}`,
      `name: ${entry.name || ''}`,
      `description: ${entry.description || ''}`,
      '',
      body,
    ].join('\n');
  }).join('\n\n');

  return `You are the Memory Librarian for an AI coding assistant. Review the current workspace memory and propose conservative consolidation actions.

## Current active/redacted memory entries
${entries || '(none)'}

## Allowed actions
- mark_superseded: one memory is stale or contradicted by a newer/current memory. This can be applied automatically because it only changes lifecycle metadata.
- merge_candidates: two or more entries look like near-duplicates and should eventually be merged by a human-reviewed rewrite. Advisory only.
- split_candidate: one entry combines unrelated facts and should eventually be split. Advisory only.
- normalize_candidate: title or description should be normalized. Advisory only.
- keep: no change needed for a relevant entry or group.

## Output format
Reply with EXACTLY ONE JSON object — nothing else, no prose, no code fences.

\`\`\`json
{
  "summary": "Short audit summary.",
  "actions": [
    {
      "action": "mark_superseded",
      "filename": "<older filename>",
      "supersededBy": "<newer/current filename>",
      "reason": "Why the first entry should be marked superseded."
    },
    {
      "action": "merge_candidates",
      "filenames": ["<filename>", "<filename>"],
      "reason": "Why these look duplicative."
    },
    {
      "action": "split_candidate",
      "filename": "<filename>",
      "reason": "Why this entry mixes separate facts."
    },
    {
      "action": "normalize_candidate",
      "filename": "<filename>",
      "title": "Suggested title or description normalization",
      "reason": "Why this metadata should be cleaned up."
    }
  ]
}
\`\`\`

Rules:
- Be conservative. When uncertain, prefer keep or an advisory action.
- Do not propose deletes.
- Do not propose rewriting redacted content or reconstructing secrets.
- Only use filenames from the current entry list.
- Output ONLY the JSON object.
`;
}

function memoryFileIsRedacted(entry: MemoryFile): boolean {
  const status = entry.metadata?.status || 'active';
  return status === 'redacted' || (entry.metadata?.redaction || []).length > 0;
}

function buildMemoryConsolidationDraftPrompt(args: {
  action: MemoryConsolidationAction;
  entries: MemoryFile[];
}): string {
  const entries = args.entries.map((entry) => [
    `### ${entry.filename}`,
    `entry_id: ${entry.metadata?.entryId || ''}`,
    `type: ${entry.type}`,
    `status: ${entry.metadata?.status || 'active'}`,
    `source: ${entry.source || entry.metadata?.source || 'cli-capture'}`,
    `name: ${entry.name || ''}`,
    `description: ${entry.description || ''}`,
    '',
    (entry.content || '').slice(0, 4000),
  ].join('\n')).join('\n\n');
  const sourceList = args.entries.map((entry) => entry.filename);
  const replacementRule = args.entries.every((entry) => entry.filename.startsWith('notes/'))
    ? '- For normalize_candidate on a notes/* entry, prefer one replace operation for that filename.'
    : '- For normalize_candidate on claude/* or mixed-source entries, create a new normalized note and supersede the original instead of replacing it.';

  return `You are the Memory Librarian for an AI coding assistant. Draft exact, human-reviewable file changes for one approved memory consolidation action.

## Selected action
${JSON.stringify(args.action, null, 2)}

## Source entries
${entries || '(none)'}

## Allowed source filenames
${sourceList.map((filename) => `- ${filename}`).join('\n') || '(none)'}

## Output format
Reply with EXACTLY ONE JSON object — nothing else, no prose, no code fences.

\`\`\`json
{
  "summary": "Short summary of the exact draft.",
  "operations": [
    {
      "operation": "create",
      "filenameHint": "short-slug",
      "supersedes": ["<source filename>"],
      "reason": "Why this new entry replaces or splits the source.",
      "content": "---\\nname: <short_slug>\\ndescription: <one-line description>\\ntype: <user | feedback | project | reference>\\n---\\n\\n<body>"
    },
    {
      "operation": "replace",
      "filename": "<notes/source filename>",
      "reason": "Why this note should be rewritten in place.",
      "content": "---\\nname: <short_slug>\\ndescription: <one-line description>\\ntype: <user | feedback | project | reference>\\n---\\n\\n<body>"
    }
  ]
}
\`\`\`

Rules:
- Do not delete files.
- Do not invent facts not present in the source entries.
- Every content value must be a complete markdown file starting with YAML frontmatter.
- create operations must include supersedes values chosen only from the allowed source filenames.
- replace operations may only target notes/* source filenames and must preserve the durable fact while improving structure.
${replacementRule}
- merge_candidates should produce one create operation that supersedes all merged source entries.
- split_candidate should produce two to five create operations, each superseding the original source entry.
- normalize_candidate should produce one replace operation for notes/* sources, or one create operation that supersedes the source when replacement is not allowed.
- Output ONLY the JSON object.
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

interface RedactionResult {
  content: string;
  redaction: MemoryRedaction[];
}

interface ParsedMemoryCliOutcome {
  action: MemoryWriteAction;
  reason: string;
  entry?: string;
  duplicateOf?: string;
  supersedes: string[];
}

const DEFAULT_MEMORY_SEARCH_LIMIT = 5;
const MAX_MEMORY_SEARCH_LIMIT = 20;
const MAX_MEMORY_SEARCH_CONTENT_CHARS = 4000;
const MEMORY_CONSOLIDATION_CLI_TIMEOUT_MS = 10 * 60_000;
const PROCESSOR_ERROR_MESSAGE_MAX = 500;
const log = logger.child({ service: 'memoryMcp' });

function addRedaction(redaction: MemoryRedaction[], kind: string, reason: string): void {
  if (!redaction.some((item) => item.kind === kind && item.reason === reason)) {
    redaction.push({ kind, reason });
  }
}

function mergeRedactions(...sets: Array<MemoryRedaction[] | undefined>): MemoryRedaction[] {
  const merged: MemoryRedaction[] = [];
  for (const set of sets) {
    for (const item of set || []) {
      addRedaction(merged, item.kind, item.reason);
    }
  }
  return merged;
}

function luhnCheck(digits: string): boolean {
  let sum = 0;
  let doubleNext = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (!Number.isInteger(n)) return false;
    if (doubleNext) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    doubleNext = !doubleNext;
  }
  return sum > 0 && sum % 10 === 0;
}

function redactMemoryContent(input: string): RedactionResult {
  let content = input;
  const redaction: MemoryRedaction[] = [];

  const replace = (
    regex: RegExp,
    kind: string,
    reason: string,
    replacement: string | ((...args: any[]) => string),
  ) => {
    let matched = false;
    content = content.replace(regex, (...args: any[]) => {
      matched = true;
      return typeof replacement === 'function' ? replacement(...args) : replacement;
    });
    if (matched) addRedaction(redaction, kind, reason);
  };

  replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    'private_key',
    'Private key material must not be written to memory.',
    '[REDACTED: private_key]',
  );
  replace(
    /\b(Authorization\s*:\s*(?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]+)/gi,
    'auth_header',
    'Authorization header credentials must not be written to memory.',
    (match: string, prefix: string) => `${prefix}[REDACTED: auth_header]`,
  );
  replace(
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
    'api_token',
    'API tokens must not be written to memory.',
    '[REDACTED: api_token]',
  );
  replace(
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    'api_token',
    'API tokens must not be written to memory.',
    '[REDACTED: api_token]',
  );
  replace(
    /\bxox[a-z]-[A-Za-z0-9-]{10,}\b/gi,
    'api_token',
    'API tokens must not be written to memory.',
    '[REDACTED: api_token]',
  );
  replace(
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    'api_token',
    'API tokens must not be written to memory.',
    '[REDACTED: api_token]',
  );
  let secretAssignmentMatched = false;
  content = content.replace(
    /\b(password|passwd|pwd|secret|api[_-]?key|token)\b(\s*[:=]\s*)(['"]?)([^'"\s,;]+)/gi,
    (match: string, key: string, separator: string, quote: string, value: string) => {
      if (value.startsWith('[REDACTED:')) return match;
      secretAssignmentMatched = true;
      return `${key}${separator}${quote || ''}[REDACTED: secret_assignment]${quote || ''}`;
    },
  );
  if (secretAssignmentMatched) {
    addRedaction(redaction, 'secret_assignment', 'Secret assignments must not be written to memory.');
  }

  let paymentCardMatched = false;
  content = content.replace(/\b(?:\d[ -]?){13,19}\b/g, (match: string) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhnCheck(digits)) return match;
    paymentCardMatched = true;
    return '[REDACTED: payment_card]';
  });
  if (paymentCardMatched) {
    addRedaction(redaction, 'payment_card', 'Payment card numbers must not be written to memory.');
  }

  return { content, redaction };
}

function sanitizeProfileLabel(value: string | undefined | null, fallback: string): string {
  const text = String(value || fallback || 'Unknown profile')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 120) : 'Unknown profile';
}

function profileContextFromRuntime(runtime: {
  backendId?: string;
  cliProfileId?: string;
  profile?: CliProfile;
} | undefined | null): MemoryProfileContext | undefined {
  if (!runtime) return undefined;
  const backendId = runtime.backendId || backendForCliProfile(runtime.profile);
  const profileId = runtime.profile?.id || runtime.cliProfileId;
  const profileName = runtime.profile?.name || profileId || backendId;
  return {
    ...(backendId ? { backendId } : {}),
    ...(profileId ? { profileId } : {}),
    ...(profileName ? { profileName: sanitizeProfileLabel(profileName, backendId || 'Unknown profile') } : {}),
  };
}

function configuredMemoryProfileContext(settings: Settings): MemoryProfileContext {
  const memory = settings.memory || {};
  const profile = memory.cliProfileId
    ? settings.cliProfiles?.find((candidate) => candidate.id === memory.cliProfileId)
    : undefined;
  const backendId = profile
    ? backendForCliProfile(profile, memory.cliBackend || settings.defaultBackend)
    : memory.cliBackend || settings.defaultBackend || 'claude-code';
  const profileId = profile?.id || memory.cliProfileId;
  const profileName = profile?.name || profileId || backendId;
  return {
    backendId,
    ...(profileId ? { profileId } : {}),
    profileName: sanitizeProfileLabel(profileName, backendId),
  };
}

function profileContextsDiffer(memoryProfile: MemoryProfileContext, chatProfile?: MemoryProfileContext): boolean {
  if (!chatProfile) return false;
  if (memoryProfile.profileId && chatProfile.profileId) {
    return memoryProfile.profileId !== chatProfile.profileId;
  }
  if (memoryProfile.backendId && chatProfile.backendId && memoryProfile.backendId !== chatProfile.backendId) {
    return true;
  }
  const memoryLabel = memoryProfile.profileName || memoryProfile.profileId || memoryProfile.backendId || '';
  const chatLabel = chatProfile.profileName || chatProfile.profileId || chatProfile.backendId || '';
  return !!memoryLabel && !!chatLabel && memoryLabel !== chatLabel;
}

function sanitizeProcessorErrorMessage(value: string): string {
  const compact = String(value || 'Unknown processor error')
    .replace(/(?:[A-Za-z]:)?(?:~|\/)[^\s'"`]*(?:\.codex|\.claude|credential|credentials|auth|token)[^\s'"`]*/gi, '[redacted credential path]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]')
    .replace(/\bxox[a-z]-[A-Za-z0-9-]{10,}\b/gi, '[REDACTED]')
    .replace(/\b(?:access|refresh)[_-]?token(["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/-]+=*/gi, (_match, sep) => `token${sep}[REDACTED]`)
    .replace(/\s+/g, ' ')
    .trim();
  return (compact || 'Unknown processor error').slice(0, PROCESSOR_ERROR_MESSAGE_MAX);
}

function classifyProcessorRunFailure(message: string): MemoryProcessorStatus {
  const lower = message.toLowerCase();
  if (/\b(auth|authenticate|authentication|authenticated|unauthorized|unauthorised|credential|login|logged in|refresh token|access token|revoked|expired|oauth|401|403)\b/.test(lower)) {
    return 'authentication_failed';
  }
  if (/\b(not installed|enoent|not found|not registered|disabled|unavailable|unsupported)\b/.test(lower)) {
    return 'unavailable';
  }
  return 'runtime_failed';
}

function processorFailureCode(status: MemoryProcessorStatus): string {
  if (status === 'authentication_failed') return 'memory_processor_auth_failed';
  if (status === 'unavailable') return 'memory_processor_unavailable';
  if (status === 'bad_output') return 'memory_processor_bad_output';
  return 'memory_processor_runtime_failed';
}

function processorStatusLabel(status: MemoryProcessorStatus): string {
  if (status === 'authentication_failed') return 'Authentication failed';
  if (status === 'unavailable') return 'Unavailable';
  if (status === 'bad_output') return 'Bad output';
  if (status === 'last_succeeded') return 'Last succeeded';
  return 'Runtime failed';
}

function buildProcessorStatusSnapshot(args: {
  status: MemoryProcessorStatus;
  memoryProfile: MemoryProfileContext;
  activeChatProfile?: MemoryProfileContext;
  error?: string;
}): MemoryProcessorStatusSnapshot {
  const differs = profileContextsDiffer(args.memoryProfile, args.activeChatProfile);
  return {
    status: args.status,
    updatedAt: new Date().toISOString(),
    ...(args.memoryProfile.backendId ? { backendId: args.memoryProfile.backendId } : {}),
    ...(args.memoryProfile.profileId ? { profileId: args.memoryProfile.profileId } : {}),
    ...(args.memoryProfile.profileName ? { profileName: args.memoryProfile.profileName } : {}),
    ...(args.activeChatProfile?.backendId ? { chatBackendId: args.activeChatProfile.backendId } : {}),
    ...(args.activeChatProfile?.profileId ? { chatProfileId: args.activeChatProfile.profileId } : {}),
    ...(args.activeChatProfile?.profileName ? { chatProfileName: args.activeChatProfile.profileName } : {}),
    ...(args.activeChatProfile ? { differsFromChatProfile: differs } : {}),
    ...(args.error ? { error: args.error } : {}),
  };
}

function buildProcessorFailureMessage(args: {
  status: MemoryProcessorStatus;
  memoryProfile: MemoryProfileContext;
  activeChatProfile?: MemoryProfileContext;
  detail: string;
}): string {
  const memoryLabel = sanitizeProfileLabel(
    args.memoryProfile.profileName || args.memoryProfile.profileId || args.memoryProfile.backendId,
    'Memory processor',
  );
  const chatLabel = args.activeChatProfile
    ? sanitizeProfileLabel(
      args.activeChatProfile.profileName || args.activeChatProfile.profileId || args.activeChatProfile.backendId,
      'active chat profile',
    )
    : null;
  const profilePrefix = chatLabel && profileContextsDiffer(args.memoryProfile, args.activeChatProfile)
    ? `The chat is running with ${chatLabel}, but Memory is configured to process notes with ${memoryLabel}. `
    : `Memory is configured to process notes with ${memoryLabel}. `;

  if (args.status === 'authentication_failed') {
    return `Memory note was not saved. ${profilePrefix}The ${memoryLabel} profile failed authentication: ${args.detail}. Re-authenticate that profile or change the Memory profile in Settings.`;
  }
  if (args.status === 'unavailable') {
    return `Memory note was not saved. ${profilePrefix}The Memory processor is unavailable: ${args.detail}. Check the Memory profile in Settings.`;
  }
  if (args.status === 'bad_output') {
    return `Memory note was not saved. ${profilePrefix}The Memory processor returned unusable output: ${args.detail}.`;
  }
  return `Memory note was not saved. ${profilePrefix}The Memory processor failed while processing the note: ${args.detail}.`;
}

function stripJsonFences(value: string): string {
  const trimmed = value.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  const stripped = stripJsonFences(value);
  if (!stripped.trimStart().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(stripped);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      const parsed = JSON.parse(stripped.slice(start, end + 1));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
}

function normalizeMemoryWriteAction(value: unknown): MemoryWriteAction | null {
  if (value === 'saved'
    || value === 'skipped_duplicate'
    || value === 'skipped_ephemeral'
    || value === 'redacted_saved'
    || value === 'superseded_saved') {
    return value;
  }
  if (value === 'duplicate' || value === 'skip_duplicate') return 'skipped_duplicate';
  if (value === 'ephemeral' || value === 'skip_ephemeral') return 'skipped_ephemeral';
  return null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function boundedMemorySearchLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return DEFAULT_MEMORY_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_MEMORY_SEARCH_LIMIT, parsed));
}

function memorySearchStatusScope(value: unknown): MemoryStatus[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('status must be active or all');
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'active') return ['active', 'redacted'];
  if (normalized === 'all') return ['active', 'redacted', 'superseded', 'deleted'];
  throw new Error('status must be active or all');
}

function draftWithEditedContent(
  base: MemoryConsolidationDraft,
  edited?: MemoryConsolidationDraft,
): MemoryConsolidationDraft {
  if (!edited) return base;
  if (!Array.isArray(edited.operations)) {
    throw new Error('draft.operations must be an array');
  }
  if (edited.operations.length !== base.operations.length) {
    throw new Error('draft.operations must match generated operations');
  }

  return {
    ...base,
    operations: base.operations.map((operation, index) => {
      const editedOperation = edited.operations[index];
      if (!editedOperation || typeof editedOperation.content !== 'string') {
        throw new Error('draft.operations[].content must be strings');
      }
      return {
        ...operation,
        content: editedOperation.content,
      };
    }),
  };
}

function parseMemoryCliOutcome(cleaned: string): ParsedMemoryCliOutcome | null {
  const raw = parseJsonObject(cleaned);
  if (!raw) return null;

  const action = normalizeMemoryWriteAction(raw.action);
  if (!action) {
    throw new Error('Memory CLI JSON output must include a valid action');
  }

  const reasonResult = redactMemoryContent(
    typeof raw.reason === 'string' && raw.reason.trim()
      ? raw.reason.trim()
      : 'Memory CLI did not provide a reason.',
  );
  const duplicateOf = typeof raw.duplicateOf === 'string' && raw.duplicateOf.trim()
    ? raw.duplicateOf.trim()
    : typeof raw.skipped === 'string' && raw.skipped.trim()
      ? raw.skipped.trim()
      : undefined;
  const entry = typeof raw.entry === 'string' ? raw.entry.trim() : undefined;

  if ((action === 'saved' || action === 'redacted_saved' || action === 'superseded_saved') && !entry) {
    throw new Error('Memory CLI JSON output must include entry for saved actions');
  }
  if (action === 'skipped_duplicate' && !duplicateOf) {
    throw new Error('Memory CLI JSON output must include duplicateOf for skipped_duplicate');
  }

  return {
    action,
    reason: reasonResult.content,
    ...(entry ? { entry } : {}),
    ...(duplicateOf ? { duplicateOf } : {}),
    supersedes: stringArray(raw.supersedes),
  };
}

function resolveExistingFilename(ref: string, existingFiles: MemoryFile[]): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const exact = existingFiles.find((file) => file.filename === trimmed);
  if (exact) return exact.filename;
  const basename = path.basename(trimmed);
  const byBasename = existingFiles.find((file) => path.basename(file.filename) === basename);
  if (byBasename) return byBasename.filename;
  const byName = existingFiles.find((file) => file.name === trimmed);
  return byName ? byName.filename : null;
}

function normalizeMemoryConsolidationAction(value: unknown): MemoryConsolidationActionType | null {
  if (value === 'mark_superseded'
    || value === 'merge_candidates'
    || value === 'split_candidate'
    || value === 'normalize_candidate'
    || value === 'keep') {
    return value;
  }
  if (value === 'supersede' || value === 'mark_stale') return 'mark_superseded';
  if (value === 'merge' || value === 'dedupe') return 'merge_candidates';
  if (value === 'split') return 'split_candidate';
  if (value === 'normalize' || value === 'rename') return 'normalize_candidate';
  return null;
}

function parseMemoryConsolidationProposal(
  rawOutput: string,
  existingFiles: MemoryFile[],
): Omit<MemoryConsolidationProposal, 'id' | 'createdAt'> {
  const raw = parseJsonObject(rawOutput);
  if (!raw) throw new Error('Memory CLI output must be a JSON object');

  const summaryRedaction = redactMemoryContent(
    typeof raw.summary === 'string' && raw.summary.trim()
      ? raw.summary.trim()
      : 'Memory consolidation review completed.',
  );
  const rawActions = Array.isArray(raw.actions) ? raw.actions : [];
  const actions: MemoryConsolidationAction[] = [];

  for (const rawAction of rawActions) {
    if (!rawAction || typeof rawAction !== 'object') continue;
    const record = rawAction as Record<string, unknown>;
    const action = normalizeMemoryConsolidationAction(record.action);
    if (!action) continue;

    const reasonRedaction = redactMemoryContent(
      typeof record.reason === 'string' && record.reason.trim()
        ? record.reason.trim()
        : 'No reason provided.',
    );
    const filename = typeof record.filename === 'string'
      ? resolveExistingFilename(record.filename, existingFiles)
      : null;
    const supersededBy = typeof record.supersededBy === 'string'
      ? resolveExistingFilename(record.supersededBy, existingFiles)
      : typeof record.replacement === 'string'
        ? resolveExistingFilename(record.replacement, existingFiles)
        : null;
    const filenames = stringArray(record.filenames)
      .map((item) => resolveExistingFilename(item, existingFiles))
      .filter((item): item is string => !!item);
    const title = typeof record.title === 'string' && record.title.trim()
      ? redactMemoryContent(record.title.trim()).content
      : undefined;

    if (action === 'mark_superseded') {
      if (!filename || !supersededBy || filename === supersededBy) continue;
      actions.push({
        action,
        filename,
        supersededBy,
        reason: reasonRedaction.content,
      });
      continue;
    }

    if (action === 'merge_candidates') {
      const merged = filenames.length ? filenames : [filename, supersededBy].filter((item): item is string => !!item);
      if (merged.length < 2) continue;
      actions.push({ action, filenames: [...new Set(merged)], reason: reasonRedaction.content });
      continue;
    }

    if (action === 'split_candidate' || action === 'normalize_candidate') {
      if (!filename) continue;
      actions.push({
        action,
        filename,
        reason: reasonRedaction.content,
        ...(title ? { title } : {}),
      });
      continue;
    }

    actions.push({
      action: 'keep',
      ...(filename ? { filename } : {}),
      ...(filenames.length ? { filenames: [...new Set(filenames)] } : {}),
      reason: reasonRedaction.content,
    });
  }

  return {
    summary: summaryRedaction.content,
    actions,
  };
}

function normalizeMemoryConsolidationDraftOperation(value: unknown): MemoryConsolidationDraftOperationType | null {
  if (value === 'create' || value === 'replace') return value;
  if (value === 'new' || value === 'new_entry' || value === 'create_entry') return 'create';
  if (value === 'rewrite' || value === 'normalize') return 'replace';
  return null;
}

function consolidationActionFilenames(action: MemoryConsolidationAction): string[] {
  if (action.action === 'mark_superseded') {
    return [action.filename, action.supersededBy].filter((filename): filename is string => !!filename);
  }
  if (action.action === 'merge_candidates') return action.filenames || [];
  if (action.action === 'split_candidate' || action.action === 'normalize_candidate') {
    return action.filename ? [action.filename] : [];
  }
  return [];
}

function resolveConsolidationActionFiles(
  action: MemoryConsolidationAction,
  existingFiles: MemoryFile[],
): MemoryFile[] {
  const filenames = consolidationActionFilenames(action);
  const resolved = filenames
    .map((filename) => resolveExistingFilename(filename, existingFiles))
    .filter((filename): filename is string => !!filename);
  const unique = [...new Set(resolved)];
  const byFilename = new Map(existingFiles.map((file) => [file.filename, file]));
  return unique.map((filename) => byFilename.get(filename)).filter((file): file is MemoryFile => !!file);
}

function parseMemoryConsolidationDraft(
  rawOutput: string,
  action: MemoryConsolidationAction,
  sourceFiles: MemoryFile[],
): Omit<MemoryConsolidationDraft, 'id' | 'createdAt' | 'action'> {
  const raw = parseJsonObject(rawOutput);
  if (!raw) throw new Error('Memory CLI output must be a JSON object');

  const sourceFilenames = sourceFiles.map((file) => file.filename);
  const summaryRedaction = redactMemoryContent(
    typeof raw.summary === 'string' && raw.summary.trim()
      ? raw.summary.trim()
      : 'Memory consolidation draft generated.',
  );
  const rawOperations = Array.isArray(raw.operations) ? raw.operations : [];
  const operations: MemoryConsolidationDraftOperation[] = [];

  for (const rawOperation of rawOperations.slice(0, 8)) {
    if (!rawOperation || typeof rawOperation !== 'object') continue;
    const record = rawOperation as Record<string, unknown>;
    const operation = normalizeMemoryConsolidationDraftOperation(record.operation);
    if (!operation) continue;

    const rawContent = typeof record.content === 'string' ? record.content.trim() : '';
    if (!rawContent.startsWith('---')) continue;
    const parsed = parseFrontmatter(rawContent);
    if (parsed.type === 'unknown') continue;
    const contentRedaction = redactMemoryContent(rawContent);
    const reasonRedaction = redactMemoryContent(
      typeof record.reason === 'string' && record.reason.trim()
        ? record.reason.trim()
        : 'No reason provided.',
    );

    if (operation === 'create') {
      const explicitSupersedes = stringArray(record.supersedes)
        .concat(stringArray(record.sourceFilenames))
        .concat(stringArray(record.filenames))
        .map((item) => resolveExistingFilename(item, sourceFiles))
        .filter((item): item is string => !!item);
      const supersedes = [...new Set(explicitSupersedes.length ? explicitSupersedes : sourceFilenames)];
      const filenameHint = typeof record.filenameHint === 'string' && record.filenameHint.trim()
        ? record.filenameHint.trim()
        : parsed.name || action.title || 'consolidated-memory';
      if (supersedes.length === 0) continue;
      operations.push({
        operation: 'create',
        filenameHint,
        supersedes,
        reason: reasonRedaction.content,
        content: contentRedaction.content,
      });
      continue;
    }

    const filename = typeof record.filename === 'string'
      ? resolveExistingFilename(record.filename, sourceFiles)
      : sourceFiles.length === 1 ? sourceFiles[0].filename : null;
    if (!filename || !filename.startsWith('notes/')) continue;
    operations.push({
      operation: 'replace',
      filename,
      reason: reasonRedaction.content,
      content: contentRedaction.content,
    });
  }

  if (operations.length === 0) {
    throw new Error('Memory CLI returned no valid draft operations');
  }

  return {
    summary: summaryRedaction.content,
    operations,
  };
}

// ── Factory ─────────────────────────────────────────────────────────────────

interface CreateMemoryMcpDeps {
  chatService: ChatService;
  backendRegistry: BackendRegistry;
  emitMemoryUpdate?: (workspaceHash: string, frame: MemoryUpdateEvent) => void;
  emitMemoryReviewUpdate?: (workspaceHash: string, frame: MemoryReviewUpdateEvent) => void;
}

export function createMemoryMcpServer({
  chatService,
  backendRegistry,
  emitMemoryUpdate,
  emitMemoryReviewUpdate,
}: CreateMemoryMcpDeps) {
  const sessions = new Map<string, MemoryMcpSession>(); // token → session
  const byConversation = new Map<string, string>(); // convId → token
  const runningReviewRuns = new Set<string>();

  async function emitFreshMemoryUpdate(
    hash: string,
    changedFiles: string[],
    sourceConversationId: string | null = null,
    writeOutcomes?: MemoryWriteOutcome[],
  ): Promise<void> {
    if (!emitMemoryUpdate) return;
    const freshSnapshot = await chatService.getWorkspaceMemory(hash);
    emitMemoryUpdate(hash, {
      type: 'memory_update',
      capturedAt: freshSnapshot?.capturedAt || new Date().toISOString(),
      fileCount: freshSnapshot?.files.length || 0,
      changedFiles,
      sourceConversationId,
      displayInChat: !!sourceConversationId,
      ...(writeOutcomes && writeOutcomes.length ? { writeOutcomes } : {}),
    });
  }

  async function emitFreshMemoryReviewUpdate(hash: string): Promise<void> {
    if (!emitMemoryReviewUpdate) return;
    const review = await chatService.getMemoryReviewStatus(hash);
    emitMemoryReviewUpdate(hash, {
      type: 'memory_review_update',
      updatedAt: new Date().toISOString(),
      review,
    });
  }

  async function recordMemoryProcessorStatus(status: MemoryProcessorStatusSnapshot): Promise<void> {
    try {
      const latestSettings = await chatService.getSettings();
      await chatService.saveSettings({
        ...latestSettings,
        memory: {
          ...(latestSettings.memory || {}),
          lastProcessorStatus: status,
        },
      });
    } catch (err: unknown) {
      log.warn('Failed to persist Memory processor status', { error: err });
    }
  }

  async function recordMemoryProcessorSuccess(
    memoryProfile: MemoryProfileContext,
    activeChatProfile?: MemoryProfileContext,
  ): Promise<void> {
    await recordMemoryProcessorStatus(buildProcessorStatusSnapshot({
      status: 'last_succeeded',
      memoryProfile,
      activeChatProfile,
    }));
  }

  async function sendMemoryProcessorFailure(
    res: Response,
    httpStatus: number,
    status: MemoryProcessorStatus,
    detail: string,
    memoryProfile: MemoryProfileContext,
    activeChatProfile?: MemoryProfileContext,
  ): Promise<Response> {
    const redactedDetail = sanitizeProcessorErrorMessage(detail);
    const snapshot = buildProcessorStatusSnapshot({
      status,
      memoryProfile,
      activeChatProfile,
      error: redactedDetail,
    });
    await recordMemoryProcessorStatus(snapshot);
    const message = buildProcessorFailureMessage({
      status,
      memoryProfile,
      activeChatProfile,
      detail: redactedDetail,
    });
    return res.status(httpStatus).json({
      error: message,
      message,
      code: processorFailureCode(status),
      statusLabel: processorStatusLabel(status),
      memoryProcessor: snapshot,
    });
  }

  function reviewItemId(prefix: 'action' | 'draft'): string {
    return `memreview_${prefix}_${crypto.randomBytes(8).toString('hex')}`;
  }

  function hasOpenReviewItems(run: MemoryReviewRun): boolean {
    return run.safeActions.some((item) => item.status === 'pending' || item.status === 'stale' || item.status === 'failed')
      || run.drafts.some((item) => item.status === 'pending' || item.status === 'stale' || item.status === 'failed');
  }

  function deriveMemoryReviewRunStatus(run: MemoryReviewRun): MemoryReviewRun['status'] {
    if (run.status === 'running') return 'running';
    const items = [...run.safeActions, ...run.drafts];
    if (hasOpenReviewItems(run)) return 'pending_review';
    if (items.length === 0) return run.failures.length ? 'failed' : 'completed';
    const applied = items.filter((item) => item.status === 'applied').length;
    const discarded = items.filter((item) => item.status === 'discarded').length;
    if (applied > 0 && discarded > 0) return 'partially_applied';
    if (applied > 0) return 'completed';
    if (discarded === items.length) return 'dismissed';
    return run.failures.length ? 'failed' : 'completed';
  }

  function finalizeMemoryReviewRun(run: MemoryReviewRun): MemoryReviewRun {
    const status = deriveMemoryReviewRunStatus(run);
    const now = new Date().toISOString();
    const terminal = status !== 'running' && status !== 'pending_review';
    return {
      ...run,
      status,
      updatedAt: now,
      ...(terminal ? { completedAt: run.completedAt || now } : { completedAt: undefined }),
    };
  }

  async function memoryReviewActionFingerprints(
    hash: string,
    action: MemoryConsolidationAction,
  ): Promise<Record<string, string>> {
    return chatService.getMemoryReviewSourceFingerprints(hash, consolidationActionFilenames(action));
  }

  async function memoryReviewItemIsStale(hash: string, expected: Record<string, string>): Promise<boolean> {
    const filenames = Object.keys(expected);
    if (filenames.length === 0) return false;
    const current = await chatService.getMemoryReviewSourceFingerprints(hash, filenames);
    return filenames.some((filename) => current[filename] !== expected[filename]);
  }

  async function saveMemoryReviewRunAndEmit(hash: string, run: MemoryReviewRun): Promise<MemoryReviewRun> {
    const saved = await chatService.saveMemoryReviewRun(hash, run);
    await emitFreshMemoryReviewUpdate(hash);
    return saved;
  }

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
  function issueMemoryMcpSession(
    conversationId: string,
    workspaceHash: string,
    options: MemoryMcpSessionOptions = {},
  ): {
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
    const activeChatProfile = profileContextFromRuntime(options.activeChatRuntime);
    const cachedToken = byConversation.get(conversationId);
    const cached = cachedToken ? sessions.get(cachedToken) : undefined;
    let token: string;
    if (cached && cached.workspaceHash === workspaceHash) {
      if (activeChatProfile) {
        cached.activeChatProfile = activeChatProfile;
      }
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
        activeChatProfile,
      });
      byConversation.set(conversationId, token);
    }

    // The endpoint URL is built relative to the in-process Express app.
    // Callers pass this in the env of the spawned MCP stub.
    const port = Number(process.env.PORT) || 3334;
    const endpoint = `http://127.0.0.1:${port}/api/chat/mcp/memory/notes`;
    const searchEndpoint = `http://127.0.0.1:${port}/api/chat/mcp/memory/search`;

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
            { name: 'MEMORY_SEARCH_ENDPOINT', value: searchEndpoint },
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

  router.post('/memory/search', async (req: Request, res: Response) => {
    const token = req.header('x-memory-token') || '';
    const session = token ? sessions.get(token) : null;
    if (!session) {
      return res.status(401).json({ error: 'Invalid or missing memory token' });
    }

    const { query, limit, type, types, status, include_content: includeContent } = (req.body || {}) as {
      query?: string;
      limit?: number;
      type?: string;
      types?: string[];
      status?: string;
      include_content?: boolean;
    };
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'query is required' });
    }

    try {
      const hash = session.workspaceHash;
      const enabled = await chatService.getWorkspaceMemoryEnabled(hash);
      if (!enabled) {
        return res.status(403).json({ error: 'Memory is disabled for this workspace' });
      }

      const requestedTypes = Array.isArray(types)
        ? types
        : typeof type === 'string' && type.trim()
          ? [type.trim()]
          : [];
      const memoryTypes = requestedTypes.filter((item): item is 'user' | 'feedback' | 'project' | 'reference' | 'unknown' =>
        item === 'user'
        || item === 'feedback'
        || item === 'project'
        || item === 'reference'
        || item === 'unknown',
      );
      let memoryStatuses: MemoryStatus[] | undefined;
      try {
        memoryStatuses = memorySearchStatusScope(status);
      } catch (err: unknown) {
        return res.status(400).json({ error: (err as Error).message });
      }
      const results = await chatService.searchWorkspaceMemory(hash, {
        query,
        limit: boundedMemorySearchLimit(limit),
        ...(memoryTypes.length ? { types: memoryTypes } : {}),
        ...(memoryStatuses ? { statuses: memoryStatuses } : {}),
      });

      return res.json({
        query: query.trim(),
        results: results.map((result) => {
          const content = result.content.length > MAX_MEMORY_SEARCH_CONTENT_CHARS
            ? `${result.content.slice(0, MAX_MEMORY_SEARCH_CONTENT_CHARS)}\n...`
            : result.content;
          return {
            filename: result.filename,
            entry_id: result.entryId,
            name: result.name,
            description: result.description,
            type: result.type,
            source: result.source,
            status: result.status,
            score: result.score,
            snippet: result.snippet,
            ...(includeContent === false ? {} : {
              content,
              truncated: result.content.length > MAX_MEMORY_SEARCH_CONTENT_CHARS,
            }),
          };
        }),
      });
    } catch (err: unknown) {
      console.error('[memoryMcp] Search handler failed:', err);
      return res.status(500).json({ error: (err as Error).message });
    }
  });

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
      const existingFiles = snapshot?.files || [];
      const existing = existingFiles.map((f) => ({
        filename: f.filename,
        type: f.type,
        description: f.description,
        name: f.name,
      }));

      // Resolve the configured Memory CLI.
      const settings = await chatService.getSettings();
      const activeChatProfile = session.activeChatProfile;
      let memoryRuntime: Awaited<ReturnType<ChatService['resolveCliProfileRuntime']>>;
      try {
        memoryRuntime = await chatService.resolveCliProfileRuntime(
          settings.memory?.cliProfileId,
          settings.memory?.cliBackend || settings.defaultBackend || 'claude-code',
        );
      } catch (err: unknown) {
        return await sendMemoryProcessorFailure(
          res,
          500,
          'unavailable',
          (err as Error).message,
          configuredMemoryProfileContext(settings),
          activeChatProfile,
        );
      }
      const memoryProfile = profileContextFromRuntime(memoryRuntime) || configuredMemoryProfileContext(settings);
      const cliId = memoryRuntime.backendId;
      const adapter = backendRegistry.get(cliId);
      if (!adapter) {
        return await sendMemoryProcessorFailure(
          res,
          500,
          'unavailable',
          `Memory CLI not registered: ${cliId}`,
          memoryProfile,
          activeChatProfile,
        );
      }

      const inputRedaction = redactMemoryContent(content.trim());
      const prompt = buildMemoryNotePrompt({
        content: inputRedaction.content,
        type: typeHint,
        tags,
        redactions: inputRedaction.redaction,
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
        const detail = (err as Error).message;
        log.warn('Memory processor CLI failed', { backendId: cliId, error: detail });
        return await sendMemoryProcessorFailure(
          res,
          502,
          classifyProcessorRunFailure(detail),
          detail,
          memoryProfile,
          activeChatProfile,
        );
      }

      const cleaned = (rawOutput || '').trim();
      if (!cleaned) {
        return await sendMemoryProcessorFailure(
          res,
          502,
          'bad_output',
          'Memory CLI returned empty output',
          memoryProfile,
          activeChatProfile,
        );
      }

      let parsedOutcome: ParsedMemoryCliOutcome | null;
      try {
        parsedOutcome = parseMemoryCliOutcome(cleaned);
      } catch (err: unknown) {
        return await sendMemoryProcessorFailure(
          res,
          502,
          'bad_output',
          `Memory CLI returned invalid governed output: ${(err as Error).message}`,
          memoryProfile,
          activeChatProfile,
        );
      }
      if (parsedOutcome) {
        if (parsedOutcome.action === 'skipped_duplicate' || parsedOutcome.action === 'skipped_ephemeral') {
          const duplicateOf = parsedOutcome.duplicateOf
            ? resolveExistingFilename(parsedOutcome.duplicateOf, existingFiles) || parsedOutcome.duplicateOf
            : undefined;
          const outcome: MemoryWriteOutcome = {
            action: parsedOutcome.action,
            reason: parsedOutcome.reason,
            skipped: duplicateOf || true,
            ...(duplicateOf ? { duplicateOf } : {}),
          };
          await emitFreshMemoryUpdate(hash, [], session.conversationId, [outcome]);
          await recordMemoryProcessorSuccess(memoryProfile, activeChatProfile);
          return res.json({
            ok: true,
            skipped: duplicateOf || true,
            outcome,
          });
        }

        const entryRedaction = redactMemoryContent(parsedOutcome.entry || '');
        const redaction = mergeRedactions(inputRedaction.redaction, entryRedaction.redaction);
        const parsed = parseFrontmatter(entryRedaction.content);
        const filenameHint = nameFromFrontmatter(entryRedaction.content) || parsed.name || typeHint || 'note';
        const relPath = await chatService.addMemoryNoteEntry(hash, {
          content: entryRedaction.content,
          source: 'memory-note',
          filenameHint,
        });

        const resolvedSupersedes = parsedOutcome.supersedes
          .map((ref) => resolveExistingFilename(ref, existingFiles))
          .filter((filename): filename is string => !!filename);
        const supersededIds = resolvedSupersedes
          .map((filename) => existingFiles.find((file) => file.filename === filename)?.metadata?.entryId)
          .filter((entryId): entryId is string => !!entryId);
        const hasRedaction = parsedOutcome.action === 'redacted_saved' || redaction.length > 0;
        const finalAction: MemoryWriteAction = parsedOutcome.action === 'saved' && hasRedaction
          ? 'redacted_saved'
          : parsedOutcome.action;

        const newMetadata = await chatService.patchMemoryEntryMetadata(hash, [{
          filename: relPath,
          patch: {
            status: hasRedaction ? 'redacted' : 'active',
            sourceConversationId: session.conversationId,
            ...(supersededIds.length ? { supersedes: supersededIds } : {}),
            ...(redaction.length ? { redaction } : {}),
          },
        }]);
        const newEntryId = newMetadata[0]?.entryId;
        if (newEntryId && resolvedSupersedes.length) {
          await chatService.patchMemoryEntryMetadata(
            hash,
            resolvedSupersedes.map((filename) => ({
              filename,
              patch: {
                status: 'superseded',
                supersededBy: newEntryId,
              },
            })),
          );
        }

        const outcome: MemoryWriteOutcome = {
          action: finalAction,
          reason: parsedOutcome.reason,
          filename: relPath,
          ...(resolvedSupersedes.length ? { superseded: resolvedSupersedes } : {}),
          ...(redaction.length ? { redaction } : {}),
        };
        await emitFreshMemoryUpdate(hash, [relPath], session.conversationId, [outcome]);
        await recordMemoryProcessorSuccess(memoryProfile, activeChatProfile);

        return res.json({ ok: true, filename: relPath, outcome });
      }

      // Handle legacy SKIP response.
      const skipMatch = cleaned.match(/^SKIP:\s*(\S+)/i);
      if (skipMatch) {
        log.info('Memory processor skipped duplicate note', { duplicateOf: skipMatch[1] });
        const skipped = resolveExistingFilename(skipMatch[1], existingFiles) || skipMatch[1];
        const outcome: MemoryWriteOutcome = {
          action: 'skipped_duplicate',
          reason: 'The note duplicates an existing memory.',
          skipped,
          duplicateOf: skipped,
        };
        await emitFreshMemoryUpdate(hash, [], session.conversationId, [outcome]);
        await recordMemoryProcessorSuccess(memoryProfile, activeChatProfile);
        return res.json({ ok: true, skipped, outcome });
      }

      // Otherwise accept a legacy frontmatter markdown document.
      const entryRedaction = redactMemoryContent(cleaned);
      const redaction = mergeRedactions(inputRedaction.redaction, entryRedaction.redaction);
      if (!entryRedaction.content.startsWith('---')) {
        log.warn('Memory processor output missing frontmatter; saving legacy note as-is');
      }
      const parsed = parseFrontmatter(entryRedaction.content);
      const filenameHint = nameFromFrontmatter(entryRedaction.content) || parsed.name || typeHint || 'note';

      const relPath = await chatService.addMemoryNoteEntry(hash, {
        content: entryRedaction.content,
        source: 'memory-note',
        filenameHint,
      });

      const outcome: MemoryWriteOutcome = {
        action: redaction.length ? 'redacted_saved' : 'saved',
        reason: 'Saved memory note.',
        filename: relPath,
        ...(redaction.length ? { redaction } : {}),
      };
      await chatService.patchMemoryEntryMetadata(hash, [{
        filename: relPath,
        patch: {
          status: redaction.length ? 'redacted' : 'active',
          sourceConversationId: session.conversationId,
          ...(redaction.length ? { redaction } : {}),
        },
      }]);

      // Fire a workspace-scoped WebSocket update so any open memory panel refreshes.
      await emitFreshMemoryUpdate(hash, [relPath], session.conversationId, [outcome]);
      await recordMemoryProcessorSuccess(memoryProfile, activeChatProfile);

      return res.json({ ok: true, filename: relPath, outcome });
    } catch (err: unknown) {
      log.error('Note handler failed', { error: err });
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
          const entryRedaction = redactMemoryContent(entry);
          const parsed = parseFrontmatter(entryRedaction.content);
          const filenameHint = nameFromFrontmatter(entryRedaction.content) || parsed.name || 'session';
          const relPath = await chatService.addMemoryNoteEntry(hash, {
            content: entryRedaction.content,
            source: 'session-extraction',
            filenameHint,
          });
          await chatService.patchMemoryEntryMetadata(hash, [{
            filename: relPath,
            patch: {
              sourceConversationId: conversationId,
              ...(entryRedaction.redaction.length
                ? { status: 'redacted' as const, redaction: entryRedaction.redaction }
                : {}),
            },
          }]);
          savedCount++;
          savedRelPaths.push(relPath);
        } catch (err: unknown) {
          console.error(`[memoryMcp] extract: failed to save entry:`, (err as Error).message);
        }
      }

      if (savedCount > 0) {
        console.log(`[memoryMcp] extract: saved ${savedCount} entry(ies) for conv=${conversationId}`);
        await emitFreshMemoryUpdate(hash, savedRelPaths, conversationId);
      }

      return savedCount;
    } catch (err: unknown) {
      console.error('[memoryMcp] extractMemoryFromSession failed:', (err as Error).message);
      return 0;
    }
  }

  async function proposeMemoryConsolidation(hash: string): Promise<MemoryConsolidationProposal> {
    const enabled = await chatService.getWorkspaceMemoryEnabled(hash);
    if (!enabled) throw new Error('Memory is disabled for this workspace');

    const snapshot = await chatService.getWorkspaceMemory(hash);
    const entries = (snapshot?.files || [])
      .filter((file) => {
        const status = file.metadata?.status || 'active';
        return status === 'active' || status === 'redacted';
      })
      .sort((a, b) => a.type.localeCompare(b.type) || a.filename.localeCompare(b.filename))
      .slice(0, 50);
    const createdAt = new Date().toISOString();
    const id = `memcon_${crypto.randomBytes(8).toString('hex')}`;

    if (entries.length < 2) {
      return {
        id,
        createdAt,
        summary: 'Not enough active memory entries to consolidate.',
        actions: [],
      };
    }

    const settings = await chatService.getSettings();
    const memoryRuntime = await chatService.resolveCliProfileRuntime(
      settings.memory?.cliProfileId,
      settings.memory?.cliBackend || settings.defaultBackend || 'claude-code',
    );
    const cliId = memoryRuntime.backendId;
    const adapter = backendRegistry.get(cliId);
    if (!adapter) {
      throw new Error(`Memory CLI not registered: ${cliId}`);
    }

    let rawOutput: string;
    try {
      rawOutput = await adapter.runOneShot(buildMemoryConsolidationPrompt({ entries }), {
        model: settings.memory?.cliModel,
        effort: settings.memory?.cliEffort,
        timeoutMs: MEMORY_CONSOLIDATION_CLI_TIMEOUT_MS,
        cliProfile: memoryRuntime.profile,
      });
    } catch (err: unknown) {
      throw new Error(`Memory CLI failed: ${(err as Error).message}`);
    }

    const cleaned = (rawOutput || '').trim();
    if (!cleaned) throw new Error('Memory CLI returned empty output');
    const parsed = parseMemoryConsolidationProposal(cleaned, entries);
    return {
      id,
      createdAt,
      ...parsed,
    };
  }

  async function draftMemoryConsolidation(
    hash: string,
    args: { action: MemoryConsolidationAction },
  ): Promise<MemoryConsolidationDraft> {
    const enabled = await chatService.getWorkspaceMemoryEnabled(hash);
    if (!enabled) throw new Error('Memory is disabled for this workspace');
    if (
      args.action.action !== 'merge_candidates'
      && args.action.action !== 'split_candidate'
      && args.action.action !== 'normalize_candidate'
    ) {
      throw new Error('Only merge, split, and normalize consolidation actions can be drafted');
    }

    const snapshot = await chatService.getWorkspaceMemory(hash);
    const files = snapshot?.files || [];
    const sourceFiles = resolveConsolidationActionFiles(args.action, files);
    const expectedCount = args.action.action === 'merge_candidates'
      ? Math.max(2, (args.action.filenames || []).length)
      : 1;
    if (sourceFiles.length < expectedCount) {
      throw new Error('Referenced memory file was not found');
    }
    for (const file of sourceFiles) {
      const status = file.metadata?.status || 'active';
      if (status === 'deleted' || status === 'superseded') {
        throw new Error('Only active memory entries can be drafted for rewrite');
      }
      if (memoryFileIsRedacted(file)) {
        throw new Error('Cannot draft rewrites for redacted memory entries');
      }
    }

    const settings = await chatService.getSettings();
    const memoryRuntime = await chatService.resolveCliProfileRuntime(
      settings.memory?.cliProfileId,
      settings.memory?.cliBackend || settings.defaultBackend || 'claude-code',
    );
    const cliId = memoryRuntime.backendId;
    const adapter = backendRegistry.get(cliId);
    if (!adapter) {
      throw new Error(`Memory CLI not registered: ${cliId}`);
    }

    let rawOutput: string;
    try {
      rawOutput = await adapter.runOneShot(buildMemoryConsolidationDraftPrompt({
        action: args.action,
        entries: sourceFiles,
      }), {
        model: settings.memory?.cliModel,
        effort: settings.memory?.cliEffort,
        timeoutMs: MEMORY_CONSOLIDATION_CLI_TIMEOUT_MS,
        cliProfile: memoryRuntime.profile,
      });
    } catch (err: unknown) {
      throw new Error(`Memory CLI failed: ${(err as Error).message}`);
    }

    const cleaned = (rawOutput || '').trim();
    if (!cleaned) throw new Error('Memory CLI returned empty output');
    const parsed = parseMemoryConsolidationDraft(cleaned, args.action, sourceFiles);
    return {
      id: `memdraft_${crypto.randomBytes(8).toString('hex')}`,
      createdAt: new Date().toISOString(),
      action: args.action,
      ...parsed,
    };
  }

  async function applyMemoryConsolidation(
    hash: string,
    args: { summary?: string; actions?: MemoryConsolidationAction[] },
  ): Promise<MemoryConsolidationApplyResult> {
    const enabled = await chatService.getWorkspaceMemoryEnabled(hash);
    if (!enabled) throw new Error('Memory is disabled for this workspace');

    const snapshot = await chatService.getWorkspaceMemory(hash);
    const files = snapshot?.files || [];
    const byFilename = new Map(files.map((file) => [file.filename, file]));
    const applied: MemoryConsolidationAction[] = [];
    const skipped: MemoryConsolidationApplyResult['skipped'] = [];
    const targetSupersedes = new Map<string, Set<string>>();
    const oldUpdates: Array<{ filename: string; patch: { status: 'superseded'; supersededBy: string } }> = [];
    const changedFiles = new Set<string>();

    for (const action of args.actions || []) {
      if (action.action !== 'mark_superseded') {
        skipped.push({
          action,
          reason: 'Advisory consolidation actions require manual review and are not applied automatically.',
        });
        continue;
      }
      const filename = action.filename || '';
      const supersededBy = action.supersededBy || '';
      const stale = byFilename.get(filename);
      const replacement = byFilename.get(supersededBy);
      if (!stale || !replacement) {
        skipped.push({ action, reason: 'Referenced memory file was not found.' });
        continue;
      }
      if (stale.filename === replacement.filename) {
        skipped.push({ action, reason: 'A memory entry cannot supersede itself.' });
        continue;
      }
      const staleStatus = stale.metadata?.status || 'active';
      const replacementStatus = replacement.metadata?.status || 'active';
      if (staleStatus === 'deleted' || staleStatus === 'superseded') {
        skipped.push({ action, reason: 'Only active or redacted entries can be marked superseded.' });
        continue;
      }
      if (replacementStatus === 'deleted' || replacementStatus === 'superseded') {
        skipped.push({ action, reason: 'Replacement entry must be active or redacted.' });
        continue;
      }
      const staleEntryId = stale.metadata?.entryId;
      const replacementEntryId = replacement.metadata?.entryId;
      if (!staleEntryId || !replacementEntryId) {
        skipped.push({ action, reason: 'Lifecycle metadata is missing for one of the referenced entries.' });
        continue;
      }

      oldUpdates.push({
        filename: stale.filename,
        patch: { status: 'superseded', supersededBy: replacementEntryId },
      });
      const existing = targetSupersedes.get(replacement.filename)
        || new Set<string>(replacement.metadata?.supersedes || []);
      existing.add(staleEntryId);
      targetSupersedes.set(replacement.filename, existing);
      changedFiles.add(stale.filename);
      changedFiles.add(replacement.filename);
      applied.push({
        action: 'mark_superseded',
        filename: stale.filename,
        supersededBy: replacement.filename,
        reason: action.reason || 'Marked stale memory superseded.',
      });
    }

    if (applied.length) {
      await chatService.patchMemoryEntryMetadata(hash, [
        ...oldUpdates,
        ...Array.from(targetSupersedes.entries()).map(([filename, supersedes]) => ({
          filename,
          patch: { supersedes: Array.from(supersedes) },
        })),
      ]);
      await emitFreshMemoryUpdate(hash, Array.from(changedFiles), null);
    }

    const auditPath = applied.length || skipped.length
      ? await chatService.saveMemoryConsolidationAudit(hash, {
        summary: args.summary || 'Manual memory consolidation applied.',
        applied,
        skipped,
      })
      : null;
    const nextSnapshot = await chatService.getWorkspaceMemory(hash);

    return {
      ok: true,
      applied,
      skipped,
      auditPath,
      snapshot: nextSnapshot,
    };
  }

  async function applyMemoryConsolidationDraft(
    hash: string,
    args: { summary?: string; draft: MemoryConsolidationDraft },
  ): Promise<MemoryConsolidationDraftApplyResult> {
    const enabled = await chatService.getWorkspaceMemoryEnabled(hash);
    if (!enabled) throw new Error('Memory is disabled for this workspace');

    const draft = args.draft;
    if (!draft || !Array.isArray(draft.operations)) {
      throw new Error('draft.operations must be an array');
    }

    const snapshot = await chatService.getWorkspaceMemory(hash);
    const files = snapshot?.files || [];
    let byFilename = new Map(files.map((file) => [file.filename, file]));
    const allowedSources = new Set(resolveConsolidationActionFiles(draft.action, files).map((file) => file.filename));
    const applied: MemoryConsolidationDraftOperation[] = [];
    const skipped: MemoryConsolidationDraftApplyResult['skipped'] = [];
    const createdFiles: string[] = [];
    const changedFiles = new Set<string>();
    const metadataUpdates: Array<{
      filename: string;
      patch: {
        status?: 'redacted' | 'superseded';
        redaction?: MemoryRedaction[];
        supersedes?: string[];
        supersededBy?: string;
      };
    }> = [];
    const sourceSupersededBy = new Set<string>();

    for (const operation of draft.operations) {
      const rawContent = typeof operation.content === 'string' ? operation.content.trim() : '';
      if (!rawContent.startsWith('---') || parseFrontmatter(rawContent).type === 'unknown') {
        skipped.push({ operation, reason: 'Draft content must be complete memory markdown with a supported type.' });
        continue;
      }
      const contentRedaction = redactMemoryContent(rawContent);

      if (operation.operation === 'create') {
        const supersedes = [...new Set(operation.supersedes || [])]
          .map((filename) => resolveExistingFilename(filename, files))
          .filter((filename): filename is string => !!filename)
          .filter((filename) => allowedSources.has(filename));
        if (supersedes.length === 0) {
          skipped.push({ operation, reason: 'Create operations must supersede at least one selected source entry.' });
          continue;
        }
        const sources = supersedes
          .map((filename) => byFilename.get(filename))
          .filter((file): file is MemoryFile => !!file);
        if (sources.length !== supersedes.length) {
          skipped.push({ operation, reason: 'Referenced source entry was not found.' });
          continue;
        }
        const invalidSource = sources.find((file) => {
          const status = file.metadata?.status || 'active';
          return status === 'deleted' || status === 'superseded' || memoryFileIsRedacted(file);
        });
        if (invalidSource) {
          skipped.push({ operation, reason: 'Only active, non-redacted source entries can be superseded by a draft.' });
          continue;
        }

        const filenameHint = operation.filenameHint
          || nameFromFrontmatter(contentRedaction.content)
          || draft.action.title
          || 'consolidated-memory';
        const relPath = await chatService.addMemoryNoteEntry(hash, {
          content: contentRedaction.content,
          source: 'memory-note',
          filenameHint,
        });
        createdFiles.push(relPath);
        changedFiles.add(relPath);

        const freshSnapshot = await chatService.getWorkspaceMemory(hash);
        byFilename = new Map((freshSnapshot?.files || []).map((file) => [file.filename, file]));
        const created = byFilename.get(relPath);
        const createdEntryId = created?.metadata?.entryId;
        const sourceEntryIds = sources
          .map((file) => file.metadata?.entryId)
          .filter((entryId): entryId is string => !!entryId);
        metadataUpdates.push({
          filename: relPath,
          patch: {
            ...(sourceEntryIds.length ? { supersedes: sourceEntryIds } : {}),
            ...(contentRedaction.redaction.length
              ? { status: 'redacted' as const, redaction: contentRedaction.redaction }
              : {}),
          },
        });
        if (createdEntryId) {
          for (const source of sources) {
            if (sourceSupersededBy.has(source.filename)) continue;
            sourceSupersededBy.add(source.filename);
            metadataUpdates.push({
              filename: source.filename,
              patch: { status: 'superseded', supersededBy: createdEntryId },
            });
            changedFiles.add(source.filename);
          }
        }
        applied.push({
          ...operation,
          filename: relPath,
          supersedes,
          content: contentRedaction.content,
        });
        continue;
      }

      if (operation.operation === 'replace') {
        const filename = operation.filename
          ? resolveExistingFilename(operation.filename, files)
          : null;
        if (!filename || !filename.startsWith('notes/') || !allowedSources.has(filename)) {
          skipped.push({ operation, reason: 'Replace operations can only target selected notes/* entries.' });
          continue;
        }
        const source = byFilename.get(filename);
        const sourceStatus = source?.metadata?.status || 'active';
        if (!source || sourceStatus === 'deleted' || sourceStatus === 'superseded' || memoryFileIsRedacted(source)) {
          skipped.push({ operation, reason: 'Only active, non-redacted notes can be replaced.' });
          continue;
        }
        const replaced = await chatService.replaceMemoryNoteEntry(hash, filename, contentRedaction.content);
        if (!replaced) {
          skipped.push({ operation, reason: 'Referenced notes entry was not found.' });
          continue;
        }
        changedFiles.add(filename);
        if (contentRedaction.redaction.length) {
          metadataUpdates.push({
            filename,
            patch: { status: 'redacted', redaction: contentRedaction.redaction },
          });
        }
        applied.push({
          ...operation,
          filename,
          content: contentRedaction.content,
        });
        continue;
      }

      skipped.push({ operation, reason: 'Unsupported draft operation.' });
    }

    if (metadataUpdates.length) {
      await chatService.patchMemoryEntryMetadata(hash, metadataUpdates);
    }
    if (changedFiles.size) {
      await emitFreshMemoryUpdate(hash, Array.from(changedFiles), null);
    }

    const auditPath = applied.length || skipped.length
      ? await chatService.saveMemoryConsolidationAudit(hash, {
        summary: args.summary || draft.summary || 'Memory consolidation draft applied.',
        applied: [],
        skipped: [],
        appliedDraftOperations: applied,
        skippedDraftOperations: skipped,
      })
      : null;
    const nextSnapshot = await chatService.getWorkspaceMemory(hash);

    return {
      ok: true,
      applied,
      skipped,
      createdFiles,
      changedFiles: Array.from(changedFiles),
      auditPath,
      snapshot: nextSnapshot,
    };
  }

  async function generateMemoryReviewRun(hash: string, initialRun: MemoryReviewRun): Promise<MemoryReviewRun> {
    let run = initialRun;
    try {
      const proposal = await proposeMemoryConsolidation(hash);
      run = {
        ...run,
        proposal,
        summary: proposal.summary,
        updatedAt: new Date().toISOString(),
      };

      for (const action of proposal.actions) {
        if (action.action === 'mark_superseded') {
          const itemNow = new Date().toISOString();
          run.safeActions.push({
            id: reviewItemId('action'),
            status: 'pending',
            action,
            sourceFingerprints: await memoryReviewActionFingerprints(hash, action),
            createdAt: itemNow,
            updatedAt: itemNow,
          });
          continue;
        }

        if (
          action.action === 'merge_candidates'
          || action.action === 'split_candidate'
          || action.action === 'normalize_candidate'
        ) {
          const itemNow = new Date().toISOString();
          const item: MemoryReviewDraftItem = {
            id: reviewItemId('draft'),
            status: 'pending',
            action,
            sourceFingerprints: await memoryReviewActionFingerprints(hash, action),
            createdAt: itemNow,
            updatedAt: itemNow,
          };
          try {
            item.draft = await draftMemoryConsolidation(hash, { action });
          } catch (err: unknown) {
            item.status = 'failed';
            item.failure = (err as Error).message || 'Draft generation failed';
          }
          run.drafts.push(item);
        }
      }

      run.status = 'pending_review';
      return await saveMemoryReviewRunAndEmit(hash, finalizeMemoryReviewRun(run));
    } catch (err: unknown) {
      run.status = 'failed';
      run.summary = 'Memory Review failed.';
      run.failures.push({ message: (err as Error).message || 'Memory Review failed' });
      return saveMemoryReviewRunAndEmit(hash, finalizeMemoryReviewRun(run));
    } finally {
      runningReviewRuns.delete(hash);
    }
  }

  async function startMemoryReviewRunInternal(
    hash: string,
    args: { source: MemoryReviewRunSource; replaceExisting?: boolean },
  ): Promise<{ run: MemoryReviewRun; completion?: Promise<MemoryReviewRun> }> {
    const enabled = await chatService.getWorkspaceMemoryEnabled(hash);
    if (!enabled) throw new Error('Memory is disabled for this workspace');

    const existingRuns = await chatService.listMemoryReviewRuns(hash);
    const actionableRuns = existingRuns
      .filter((run) => run.status === 'running' || run.status === 'pending_review' || run.status === 'failed');
    const existing = actionableRuns[0];
    if (existing && !args.replaceExisting) return { run: existing };

    if (runningReviewRuns.has(hash)) {
      throw new Error('Cannot start a new Memory Review while another review is still generating.');
    }

    if (args.replaceExisting && actionableRuns.length > 0) {
      const retiredAt = new Date().toISOString();
      for (const prior of actionableRuns) {
        prior.status = 'dismissed';
        prior.updatedAt = retiredAt;
        prior.completedAt = prior.completedAt || retiredAt;
        prior.summary = prior.summary || 'Memory Review dismissed before a new review was started.';
        for (const item of [...prior.safeActions, ...prior.drafts]) {
          if (item.status === 'applied' || item.status === 'discarded') continue;
          item.status = 'discarded';
          item.discardedAt = retiredAt;
          item.updatedAt = retiredAt;
        }
        await saveMemoryReviewRunAndEmit(hash, prior);
      }
    }

    const running = (await chatService.listMemoryReviewRuns(hash))
      .find((run) => run.status === 'running' || run.status === 'pending_review' || run.status === 'failed');
    if (running) return { run: running };

    runningReviewRuns.add(hash);
    const now = new Date().toISOString();
    const run: MemoryReviewRun = {
      version: 1,
      id: `memreview_${crypto.randomBytes(8).toString('hex')}`,
      workspaceHash: hash,
      status: 'running',
      source: args.source,
      createdAt: now,
      updatedAt: now,
      summary: 'Memory Review is generating drafts.',
      sourceSnapshotFingerprint: await chatService.getMemorySnapshotFingerprint(hash),
      safeActions: [],
      drafts: [],
      failures: [],
    };

    await saveMemoryReviewRunAndEmit(hash, run);
    const completion = generateMemoryReviewRun(hash, run);
    completion.catch(() => {});
    return { run, completion };
  }

  async function startMemoryReviewRun(
    hash: string,
    args: { source: MemoryReviewRunSource; replaceExisting?: boolean },
  ): Promise<MemoryReviewRun> {
    const started = await startMemoryReviewRunInternal(hash, args);
    return started.run;
  }

  async function createMemoryReviewRun(
    hash: string,
    args: { source: MemoryReviewRunSource; replaceExisting?: boolean },
  ): Promise<MemoryReviewRun> {
    const started = await startMemoryReviewRunInternal(hash, args);
    return started.completion ? started.completion : started.run;
  }

  async function getMemoryReviewRunOrThrow(hash: string, runId: string): Promise<MemoryReviewRun> {
    const run = await chatService.getMemoryReviewRun(hash, runId);
    if (!run) throw new Error('Memory Review not found');
    return run;
  }

  async function applyMemoryReviewSafeAction(
    hash: string,
    runId: string,
    itemId: string,
  ): Promise<MemoryReviewRun> {
    const run = await getMemoryReviewRunOrThrow(hash, runId);
    const item = run.safeActions.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error('Memory Review action not found');
    if (item.status === 'applied' || item.status === 'discarded') return run;

    const now = new Date().toISOString();
    if (await memoryReviewItemIsStale(hash, item.sourceFingerprints)) {
      item.status = 'stale';
      item.failure = 'Source memory changed after this review was generated.';
      item.updatedAt = now;
      run.status = 'pending_review';
      return saveMemoryReviewRunAndEmit(hash, finalizeMemoryReviewRun(run));
    }

    const result = await applyMemoryConsolidation(hash, {
      summary: run.summary,
      actions: [item.action],
    });
    item.result = result;
    item.updatedAt = new Date().toISOString();
    if (result.applied.length > 0) {
      item.status = 'applied';
      item.appliedAt = item.updatedAt;
      item.failure = undefined;
    } else {
      item.status = 'failed';
      item.failure = result.skipped[0]?.reason || 'No changes were applied.';
    }
    return saveMemoryReviewRunAndEmit(hash, finalizeMemoryReviewRun(run));
  }

  async function applyMemoryReviewDraft(
    hash: string,
    runId: string,
    draftId: string,
    args?: { draft?: MemoryConsolidationDraft },
  ): Promise<MemoryReviewRun> {
    const run = await getMemoryReviewRunOrThrow(hash, runId);
    const item = run.drafts.find((candidate) => candidate.id === draftId);
    if (!item) throw new Error('Memory Review draft not found');
    if (item.status === 'applied' || item.status === 'discarded') return run;
    if (!item.draft) {
      item.status = 'failed';
      item.failure = item.failure || 'Draft was not generated.';
      item.updatedAt = new Date().toISOString();
      return saveMemoryReviewRunAndEmit(hash, finalizeMemoryReviewRun(run));
    }

    const now = new Date().toISOString();
    if (await memoryReviewItemIsStale(hash, item.sourceFingerprints)) {
      item.status = 'stale';
      item.failure = 'Source memory changed after this review was generated.';
      item.updatedAt = now;
      run.status = 'pending_review';
      return saveMemoryReviewRunAndEmit(hash, finalizeMemoryReviewRun(run));
    }

    const reviewedDraft = draftWithEditedContent(item.draft, args?.draft);
    const result = await applyMemoryConsolidationDraft(hash, {
      summary: run.summary,
      draft: reviewedDraft,
    });
    item.result = result;
    item.updatedAt = new Date().toISOString();
    if (result.applied.length > 0) {
      item.status = 'applied';
      item.appliedAt = item.updatedAt;
      item.failure = undefined;
    } else {
      item.status = 'failed';
      item.failure = result.skipped[0]?.reason || 'No draft changes were applied.';
    }
    return saveMemoryReviewRunAndEmit(hash, finalizeMemoryReviewRun(run));
  }

  async function discardMemoryReviewItem(
    hash: string,
    runId: string,
    itemId: string,
  ): Promise<MemoryReviewRun> {
    const run = await getMemoryReviewRunOrThrow(hash, runId);
    const item = run.safeActions.find((candidate) => candidate.id === itemId)
      || run.drafts.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error('Memory Review item not found');
    if (item.status !== 'applied' && item.status !== 'discarded') {
      const now = new Date().toISOString();
      item.status = 'discarded';
      item.discardedAt = now;
      item.updatedAt = now;
    }
    return saveMemoryReviewRunAndEmit(hash, finalizeMemoryReviewRun(run));
  }

  async function regenerateMemoryReviewDraft(
    hash: string,
    runId: string,
    draftId: string,
  ): Promise<MemoryReviewRun> {
    const run = await getMemoryReviewRunOrThrow(hash, runId);
    const item = run.drafts.find((candidate) => candidate.id === draftId);
    if (!item) throw new Error('Memory Review draft not found');
    if (item.status === 'applied') return run;

    const now = new Date().toISOString();
    try {
      item.sourceFingerprints = await memoryReviewActionFingerprints(hash, item.action);
      item.draft = await draftMemoryConsolidation(hash, { action: item.action });
      item.status = 'pending';
      item.failure = undefined;
      item.discardedAt = undefined;
      item.regeneratedAt = now;
      item.updatedAt = now;
    } catch (err: unknown) {
      item.status = 'failed';
      item.discardedAt = undefined;
      item.failure = (err as Error).message || 'Draft regeneration failed';
      item.updatedAt = now;
    }

    run.status = 'pending_review';
    return saveMemoryReviewRunAndEmit(hash, finalizeMemoryReviewRun(run));
  }

  function isMemoryReviewRunning(hash: string): boolean {
    return runningReviewRuns.has(hash);
  }

  async function hasPendingMemoryReview(hash: string): Promise<boolean> {
    return (await chatService.getMemoryReviewStatus(hash)).pending;
  }

  async function hasMemoryChangedSinceLastScheduledReview(hash: string, since?: string): Promise<boolean> {
    return chatService.hasMemoryChangedSinceLastScheduledReview(hash, since);
  }

  return {
    router,
    issueMemoryMcpSession,
    revokeMemoryMcpSession,
    extractMemoryFromSession,
    proposeMemoryConsolidation,
    draftMemoryConsolidation,
    applyMemoryConsolidation,
    applyMemoryConsolidationDraft,
    startMemoryReviewRun,
    createMemoryReviewRun,
    applyMemoryReviewSafeAction,
    applyMemoryReviewDraft,
    discardMemoryReviewItem,
    regenerateMemoryReviewDraft,
    isMemoryReviewRunning,
    hasPendingMemoryReview,
    hasMemoryChangedSinceLastScheduledReview,
  };
}

export type MemoryMcpServer = ReturnType<typeof createMemoryMcpServer>;
