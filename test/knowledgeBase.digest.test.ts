/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Knowledge Base digestion orchestrator tests ─────────────────────────────
// Exercises `KbDigestionService` with a stub backend adapter so we can drive
// every parse/schema path without spinning up the real Claude Code CLI.
//
// What we cover:
//   - Pure `parseEntries` happy paths and every malformed shape
//   - `stringifyEntry` field order + quoting rules
//   - `buildDigestPrompt` includes all required sections
//   - End-to-end digest run against an ingested raw file, verifying:
//       · raw status transitions: ingested → digesting → digested
//       · entry.md lands on disk with correct frontmatter
//       · entries + entry_tags rows populated in the DB
//       · KB state frames emit on every transition
//   - Re-digest (second run on same raw) replaces stale entries
//   - Slug collision allocator appends -2, -3 suffixes
//   - CLI timeout / malformed output / schema rejection fail paths
//   - Batch digest iterates every ingested raw and reports per-item results
//   - KB disabled throws `KbDigestDisabledError`
//   - Missing Digestion CLI setting returns an unknown error on the raw row

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { ChatService } from '../src/services/chatService';
import {
  KbIngestionService,
} from '../src/services/knowledgeBase/ingestion';
import {
  KbDigestionService,
  KbDigestDisabledError,
  buildDigestPrompt,
  parseEntries,
  stringifyEntry,
  slugify,
  DigestParseError,
  DigestSchemaError,
  KB_ENTRY_SCHEMA_VERSION,
} from '../src/services/knowledgeBase/digest';
import { BaseBackendAdapter, type RunOneShotOptions } from '../src/services/backends/base';
import { BackendRegistry } from '../src/services/backends/registry';
import type { BackendMetadata, KbStateUpdateEvent } from '../src/types';

const WORKSPACE_PATH = '/tmp/kb-digest-test';
const STUB_BACKEND_ID = 'stub-digester';

function workspaceHash(p: string): string {
  return crypto.createHash('sha256').update(p).digest('hex').substring(0, 16);
}

// ── Stub backend ─────────────────────────────────────────────────────────────
// Implements just enough of `BaseBackendAdapter` for the digestion
// orchestrator to call `runOneShot`. We expose handles to inject replies or
// failures per test so we don't have to rewire between cases.

type RunOneShotFn = (prompt: string, opts?: RunOneShotOptions) => Promise<string>;

class StubBackend extends BaseBackendAdapter {
  public calls: Array<{ prompt: string; opts?: RunOneShotOptions }> = [];
  public runOneShotImpl: RunOneShotFn;

  constructor(impl: RunOneShotFn) {
    super();
    this.runOneShotImpl = impl;
  }

  get metadata(): BackendMetadata {
    return {
      id: STUB_BACKEND_ID,
      label: 'Stub Digester',
      icon: null,
      capabilities: {
        supportsThinking: false,
        supportsToolCalls: false,
        supportsMemory: false,
        supportsOneShot: true,
      },
    } as unknown as BackendMetadata;
  }

  async runOneShot(prompt: string, opts?: RunOneShotOptions): Promise<string> {
    this.calls.push({ prompt, opts });
    return this.runOneShotImpl(prompt, opts);
  }
}

let tmpDir: string;
let chatService: ChatService;
let ingestion: KbIngestionService;
let digestion: KbDigestionService;
let backendRegistry: BackendRegistry;
let backend: StubBackend;
let emitted: Array<{ hash: string; frame: KbStateUpdateEvent }>;
let hash: string;

async function seedRaw(content: string, filename: string): Promise<string> {
  const res = await ingestion.enqueueUpload(hash, {
    buffer: Buffer.from(content),
    filename,
    mimeType: 'text/markdown',
  });
  await ingestion.waitForIdle(hash);
  return res.entry.rawId;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-digest-'));
  chatService = new ChatService(tmpDir, { defaultWorkspace: WORKSPACE_PATH });
  await chatService.initialize();
  await chatService.saveSettings({
    theme: 'system',
    sendBehavior: 'enter',
    systemPrompt: '',
    defaultBackend: STUB_BACKEND_ID,
    workingDirectory: '',
    knowledgeBase: {
      digestionCliBackend: STUB_BACKEND_ID,
    },
  });
  backendRegistry = new BackendRegistry();
  backend = new StubBackend(async () => '');
  backendRegistry.register(backend);

  emitted = [];
  ingestion = new KbIngestionService({
    chatService,
    emit: (h, frame) => emitted.push({ hash: h, frame }),
  });
  digestion = new KbDigestionService({
    chatService,
    backendRegistry,
    emit: (h, frame) => emitted.push({ hash: h, frame }),
  });

  // Bootstrap workspace with KB enabled.
  await chatService.createConversation('seed', WORKSPACE_PATH);
  hash = workspaceHash(WORKSPACE_PATH);
  await chatService.setWorkspaceKbEnabled(hash, true);
});

afterEach(() => {
  chatService.closeKbDatabases?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── parseEntries pure tests ─────────────────────────────────────────────────

describe('parseEntries', () => {
  test('returns [] on empty output', () => {
    expect(parseEntries('')).toEqual([]);
    expect(parseEntries('   \n  ')).toEqual([]);
  });

  test('parses a single entry with inline tag array', () => {
    const out = `---
title: Hello World
slug: hello-world
summary: A cheerful greeting.
tags: [greeting, test, demo]
---
This is the body of the entry.

Multiple paragraphs are preserved.`;
    const entries = parseEntries(out);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.title).toBe('Hello World');
    expect(e.slug).toBe('hello-world');
    expect(e.summary).toBe('A cheerful greeting.');
    expect(e.tags).toEqual(['greeting', 'test', 'demo']);
    expect(e.body).toContain('body of the entry');
    expect(e.body).toContain('Multiple paragraphs');
  });

  test('parses a single entry with YAML list tags', () => {
    const out = `---
title: Alpha
slug: alpha
summary: First.
tags:
  - core
  - shared
---
Body text.`;
    const entries = parseEntries(out);
    expect(entries[0].tags).toEqual(['core', 'shared']);
  });

  test('parses multiple entries separated by ---', () => {
    const out = `---
title: One
slug: one
summary: First.
tags: [a]
---
First body.
---
title: Two
slug: two
summary: Second.
tags: [b]
---
Second body.`;
    const entries = parseEntries(out);
    expect(entries).toHaveLength(2);
    expect(entries[0].title).toBe('One');
    expect(entries[1].title).toBe('Two');
  });

  test('auto-derives slug from title when slug missing', () => {
    const out = `---
title: My Cool Topic!!
summary: Interesting.
tags: []
---
Body.`;
    const entries = parseEntries(out);
    expect(entries[0].slug).toBe('my-cool-topic');
  });

  test('throws DigestParseError on unterminated frontmatter', () => {
    const out = `---
title: Incomplete
summary: no closer`;
    expect(() => parseEntries(out)).toThrow(DigestParseError);
  });

  test('throws DigestSchemaError when required field is missing', () => {
    const out = `---
slug: x
summary: body needed
---
Some body.`;
    expect(() => parseEntries(out)).toThrow(DigestSchemaError);
  });

  test('throws DigestSchemaError on empty body', () => {
    const out = `---
title: Empty
slug: empty
summary: Nothing here.
---
`;
    expect(() => parseEntries(out)).toThrow(DigestSchemaError);
  });

  test('strips leading/trailing triple-backtick code fences', () => {
    const out = '```yaml\n---\ntitle: Fenced\nslug: fenced\nsummary: Wrapped in fences.\ntags: []\n---\nFenced body.\n```';
    const entries = parseEntries(out);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Fenced');
  });

  test('skips preamble prose before the first ---', () => {
    const out = 'Here are the entries I extracted:\n\n---\ntitle: After Preamble\nslug: after-preamble\nsummary: Should still parse.\ntags: []\n---\nBody text.';
    const entries = parseEntries(out);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('After Preamble');
  });

  test('lowercases frontmatter keys so Title/TITLE both work', () => {
    const out = '---\nTitle: Mixed Case\nSlug: mixed\nSummary: Case insensitive.\nTags: [cased]\n---\nBody.';
    const entries = parseEntries(out);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Mixed Case');
    expect(entries[0].tags).toEqual(['cased']);
  });

  test('treats --- as horizontal rule when not followed by frontmatter', () => {
    const out = `---
title: Deep Dive
slug: deep-dive
summary: Entry with horizontal rules.
tags: [test]
---
## Section A

Content for section A.

---

## Section B

Content for section B.

---

## Section C

Final section.`;
    const entries = parseEntries(out);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toContain('Section A');
    expect(entries[0].body).toContain('---');
    expect(entries[0].body).toContain('Section B');
    expect(entries[0].body).toContain('Section C');
  });

  test('horizontal rules in body do not break multi-entry parsing', () => {
    const out = `---
title: First
slug: first
summary: Has an HR.
tags: []
---
Body one.

---

More of body one.
---
title: Second
slug: second
summary: After an HR entry.
tags: []
---
Body two.`;
    const entries = parseEntries(out);
    expect(entries).toHaveLength(2);
    expect(entries[0].title).toBe('First');
    expect(entries[0].body).toContain('---');
    expect(entries[0].body).toContain('More of body one');
    expect(entries[1].title).toBe('Second');
    expect(entries[1].body).toContain('Body two');
  });

  test('normalizes and dedupes tags', () => {
    const out = `---
title: Tagged
slug: tagged
summary: Has tags.
tags: [Hello, HELLO, hello, "spaces here", spaces-here]
---
Body.`;
    const entries = parseEntries(out);
    // 'Hello' → 'hello', 'spaces here' → 'spaces-here', then dedupe.
    expect(entries[0].tags.sort()).toEqual(['hello', 'spaces-here']);
  });
});

// ─── stringifyEntry + slugify ───────────────────────────────────────────────

describe('stringifyEntry', () => {
  test('emits deterministic frontmatter field order and schemaVersion', () => {
    const md = stringifyEntry({
      title: 'Example',
      slug: 'example',
      summary: 'Sample entry.',
      tags: ['one', 'two'],
      body: 'Content here.',
    });
    expect(md).toMatch(/^---\ntitle: Example\nslug: example\nsummary: Sample entry\.\ntags: \[one, two\]\nschemaVersion: 1\n---\nContent here\.\n$/);
  });

  test('quotes values that contain special yaml characters', () => {
    const md = stringifyEntry({
      title: 'Has: a colon',
      slug: 'has-a-colon',
      summary: 'Brackets [x]',
      tags: [],
      body: 'Body.',
    });
    expect(md).toContain('title: "Has: a colon"');
    expect(md).toContain('summary: "Brackets [x]"');
  });

  test('includes uploadedAt and digestedAt when provided', () => {
    const md = stringifyEntry({
      title: 'Timed',
      slug: 'timed',
      summary: 'Has timestamps.',
      tags: [],
      body: 'Body.',
    }, { uploadedAt: '2026-04-10T10:00:00.000Z', digestedAt: '2026-04-10T10:05:00.000Z' });
    expect(md).toContain('uploadedAt: "2026-04-10T10:00:00.000Z"');
    expect(md).toContain('digestedAt: "2026-04-10T10:05:00.000Z"');
    // Timestamps should appear after schemaVersion and before the closing ---
    const lines = md.split('\n');
    const schemaIdx = lines.findIndex(l => l.startsWith('schemaVersion:'));
    const uploadIdx = lines.findIndex(l => l.startsWith('uploadedAt:'));
    const closerIdx = lines.indexOf('---', 1);
    expect(uploadIdx).toBeGreaterThan(schemaIdx);
    expect(closerIdx).toBeGreaterThan(uploadIdx);
  });
});

describe('slugify', () => {
  test('produces url-safe lowercase slugs', () => {
    expect(slugify('My Favourite Thing')).toBe('my-favourite-thing');
    expect(slugify("What's Up?")).toBe('what-s-up');
    expect(slugify('')).toBe('');
    expect(slugify('   leading and trailing   ')).toBe('leading-and-trailing');
  });
});

// ─── buildDigestPrompt ───────────────────────────────────────────────────────

describe('buildDigestPrompt', () => {
  test('includes output format rules, source context, and converted text', () => {
    const prompt = buildDigestPrompt({
      filename: 'doc.md',
      folderPath: 'notes',
      rawId: 'abc123',
      handler: 'passthrough/text',
      mimeType: 'text/markdown',
      convertedTextPath: 'converted/abc123/text.md',
      convertedText: '# Heading\nSome content.',
      handlerMetadata: { pages: 2 },
    });
    expect(prompt).toContain('Knowledge Base digestion request');
    expect(prompt).toContain('Return ONE OR MORE entries');
    expect(prompt).toContain('Filename: doc.md');
    expect(prompt).toContain('Folder: notes');
    expect(prompt).toContain('Raw ID: abc123');
    expect(prompt).toContain('Handler: passthrough/text');
    expect(prompt).toContain('pages: 2');
    expect(prompt).toContain('# Heading\nSome content.');
  });

  test('labels root folder explicitly', () => {
    const prompt = buildDigestPrompt({
      filename: 'doc.md',
      folderPath: '',
      rawId: 'abc',
      handler: 'x',
      mimeType: 'text/markdown',
      convertedTextPath: 'p',
      convertedText: 'c',
    });
    expect(prompt).toContain('Folder: <root>');
  });
});

// ─── End-to-end digest against seeded raw ────────────────────────────────────

describe('enqueueDigest end-to-end', () => {
  test('writes entry.md + DB rows and transitions status to digested', async () => {
    const rawId = await seedRaw('Some body content.\n\nMore text.', 'doc.md');
    backend.runOneShotImpl = async () => `---
title: Sample Entry
slug: sample-entry
summary: Demonstrates end-to-end digestion.
tags: [demo, test]
---
This is the body of the sample entry.

With two paragraphs to keep things interesting.`;
    emitted.length = 0;

    const result = await digestion.enqueueDigest(hash, rawId);
    expect(result.error).toBeUndefined();
    expect(result.entryIds).toHaveLength(1);
    const entryId = result.entryIds[0];
    expect(entryId).toBe(`${rawId}-sample-entry`);

    // DB row assertions
    const db = chatService.getKbDb(hash)!;
    const entry = db.getEntry(entryId);
    expect(entry?.title).toBe('Sample Entry');
    expect(entry?.tags.sort()).toEqual(['demo', 'test']);
    expect(entry?.schemaVersion).toBe(KB_ENTRY_SCHEMA_VERSION);

    // Raw row
    const raw = db.getRawById(rawId);
    expect(raw?.status).toBe('digested');
    expect(raw?.digested_at).not.toBeNull();

    // Disk: entries/<entryId>/entry.md
    const entryPath = path.join(chatService.getKbEntriesDir(hash), entryId, 'entry.md');
    const md = fs.readFileSync(entryPath, 'utf8');
    expect(md).toContain('title: Sample Entry');
    expect(md).toContain('schemaVersion: 1');
    expect(md).toContain('uploadedAt:');
    expect(md).toContain('digestedAt:');
    expect(md).toContain('body of the sample entry');

    // Frames: at least one digesting + one digested
    const kinds = emitted.map((e) => e.frame.type);
    expect(kinds.every((k) => k === 'kb_state_update')).toBe(true);
    expect(emitted.length).toBeGreaterThanOrEqual(2);

    // CLI call received our built prompt
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].opts?.allowTools).toBe(true);
    expect(backend.calls[0].opts?.workingDir).toBe(chatService.getKbKnowledgeDir(hash));
  });

  test('re-digest replaces stale entries for the same raw', async () => {
    const rawId = await seedRaw('first run content', 'first.md');
    backend.runOneShotImpl = async () => `---
title: Original
slug: original
summary: Originally.
tags: [v1]
---
Original body.`;
    await digestion.enqueueDigest(hash, rawId);
    const db = chatService.getKbDb(hash)!;
    expect(db.listEntries({ rawId })).toHaveLength(1);
    expect(db.entryIdTaken(`${rawId}-original`)).toBe(true);

    // Manually flip status back so a second run is accepted.
    db.updateRawStatus(rawId, 'ingested');
    backend.runOneShotImpl = async () => `---
title: Revised
slug: revised
summary: Updated.
tags: [v2]
---
Revised body.`;
    await digestion.enqueueDigest(hash, rawId);

    // Old entry was wiped, new one inserted with a fresh slug.
    expect(db.entryIdTaken(`${rawId}-original`)).toBe(false);
    expect(db.entryIdTaken(`${rawId}-revised`)).toBe(true);
    const remaining = db.listEntries({ rawId });
    expect(remaining.map((e) => e.slug)).toEqual(['revised']);

    // Disk: old dir gone, new dir exists.
    const oldDir = path.join(chatService.getKbEntriesDir(hash), `${rawId}-original`);
    const newDir = path.join(chatService.getKbEntriesDir(hash), `${rawId}-revised`);
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(newDir)).toBe(true);
  });

  test('appends -2 suffix on slug collisions within one run', async () => {
    const rawId = await seedRaw('source with duplicated slugs', 'dup.md');
    backend.runOneShotImpl = async () => `---
title: First
slug: same
summary: First with same slug.
tags: []
---
First body.
---
title: Second
slug: same
summary: Second with same slug.
tags: []
---
Second body.`;
    const result = await digestion.enqueueDigest(hash, rawId);
    expect(result.entryIds.sort()).toEqual([`${rawId}-same`, `${rawId}-same-2`].sort());
    const db = chatService.getKbDb(hash)!;
    expect(db.getEntry(`${rawId}-same`)?.title).toBe('First');
    expect(db.getEntry(`${rawId}-same-2`)?.title).toBe('Second');
  });

  test('records malformed_output failure class on parse error', async () => {
    const rawId = await seedRaw('some text', 'fail.md');
    backend.runOneShotImpl = async () => 'this is nonsense, no frontmatter here';
    const result = await digestion.enqueueDigest(hash, rawId);
    expect(result.error?.class).toBe('malformed_output');
    const db = chatService.getKbDb(hash)!;
    const raw = db.getRawById(rawId);
    expect(raw?.status).toBe('failed');
    expect(raw?.error_class).toBe('malformed_output');
  });

  test('records cli_error when runOneShot throws', async () => {
    const rawId = await seedRaw('some text', 'cli-fail.md');
    backend.runOneShotImpl = async () => {
      throw new Error('CLI exited non-zero');
    };
    const result = await digestion.enqueueDigest(hash, rawId);
    expect(result.error?.class).toBe('cli_error');
    const db = chatService.getKbDb(hash)!;
    expect(db.getRawById(rawId)?.status).toBe('failed');
  });

  test('records timeout class when the error mentions timeout', async () => {
    const rawId = await seedRaw('some text', 'timeout.md');
    backend.runOneShotImpl = async () => {
      throw new Error('Operation timeout after 300s');
    };
    const result = await digestion.enqueueDigest(hash, rawId);
    expect(result.error?.class).toBe('timeout');
  });

  test('throws KbDigestDisabledError when KB is off', async () => {
    await chatService.setWorkspaceKbEnabled(hash, false);
    await expect(digestion.enqueueDigest(hash, 'anything')).rejects.toBeInstanceOf(
      KbDigestDisabledError,
    );
  });

  test('returns error when no Digestion CLI is configured', async () => {
    await chatService.saveSettings({
      theme: 'system',
      sendBehavior: 'enter',
      systemPrompt: '',
      defaultBackend: STUB_BACKEND_ID,
      workingDirectory: '',
      knowledgeBase: {}, // no digestionCliBackend
    });
    const rawId = await seedRaw('content', 'no-cli.md');
    const result = await digestion.enqueueDigest(hash, rawId);
    expect(result.error?.class).toBe('unknown');
    expect(result.error?.message).toMatch(/No Digestion CLI/i);
  });
});

// ─── Batch digestion ─────────────────────────────────────────────────────────

describe('enqueueBatchDigest', () => {
  test('digests every ingested raw and emits batchProgress frames', async () => {
    const rawA = await seedRaw('alpha body', 'a.md');
    const rawB = await seedRaw('beta body', 'b.md');
    backend.runOneShotImpl = async (prompt) => {
      const isA = prompt.includes('a.md');
      return `---
title: ${isA ? 'Alpha' : 'Beta'}
slug: ${isA ? 'alpha' : 'beta'}
summary: ${isA ? 'A.' : 'B.'}
tags: []
---
Body for ${isA ? 'alpha' : 'beta'}.`;
    };
    emitted.length = 0;
    const results = await digestion.enqueueBatchDigest(hash);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.error === undefined)).toBe(true);

    const db = chatService.getKbDb(hash)!;
    expect(db.getRawById(rawA)?.status).toBe('digested');
    expect(db.getRawById(rawB)?.status).toBe('digested');

    const progressFrames = emitted
      .map((e) => e.frame.changed.batchProgress)
      .filter((p) => p !== undefined);
    expect(progressFrames.length).toBeGreaterThanOrEqual(2);
    expect(progressFrames[progressFrames.length - 1]).toEqual({ done: 2, total: 2 });
  });

  test('returns empty array when nothing is eligible', async () => {
    const results = await digestion.enqueueBatchDigest(hash);
    expect(results).toEqual([]);
  });
});
