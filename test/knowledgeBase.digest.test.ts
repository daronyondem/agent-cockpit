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
//   - Clear duplicate entries merge while retaining source ranges
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
  buildGleaningPrompt,
  parseEntries,
  stringifyEntry,
  slugify,
  DigestParseError,
  DigestSchemaError,
  KB_ENTRY_SCHEMA_VERSION,
} from '../src/services/knowledgeBase/digest';
import * as embeddings from '../src/services/knowledgeBase/embeddings';
import { WorkspaceTaskQueueRegistry } from '../src/services/knowledgeBase/workspaceTaskQueue';
import { BaseBackendAdapter, type RunOneShotOptions } from '../src/services/backends/base';
import { BackendRegistry } from '../src/services/backends/registry';
import type { BackendMetadata, KbStateUpdateEvent } from '../src/types';

const WORKSPACE_PATH = '/tmp/kb-digest-test';
const STUB_BACKEND_ID = 'stub-digester';
const TEST_RESUME_CAPABILITIES: BackendMetadata['resumeCapabilities'] = {
  activeTurnResume: 'unsupported',
  activeTurnResumeReason: 'Test stub does not expose active-turn reattach.',
  sessionResume: 'unsupported',
  sessionResumeReason: 'Test stub does not expose backend session resume.',
};

function workspaceHash(p: string): string {
  return crypto.createHash('sha256').update(p).digest('hex').substring(0, 16);
}

// ── Stub backend ─────────────────────────────────────────────────────────────
// Implements just enough of `BaseBackendAdapter` for the digestion
// orchestrator to call `runOneShot`. We expose handles to inject replies or
// failures per test so we don't have to rewire between cases.

type RunOneShotFn = (prompt: string, opts?: RunOneShotOptions) => Promise<string>;
type RunSessionShotFn = (prompts: string[], opts?: RunOneShotOptions) => Promise<string[]>;

class StubBackend extends BaseBackendAdapter {
  public calls: Array<{ prompt: string; opts?: RunOneShotOptions }> = [];
  public sessionCalls: Array<{ prompts: string[]; opts?: RunOneShotOptions }> = [];
  public runOneShotImpl: RunOneShotFn;
  public runSessionShotImpl: RunSessionShotFn;

  constructor(impl: RunOneShotFn) {
    super();
    this.runOneShotImpl = impl;
    this.runSessionShotImpl = async (prompts, opts) => {
      const out: string[] = [];
      for (const prompt of prompts) out.push(await this.runOneShotImpl(prompt, opts));
      return out;
    };
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
      resumeCapabilities: TEST_RESUME_CAPABILITIES,
    } as unknown as BackendMetadata;
  }

  async runOneShot(prompt: string, opts?: RunOneShotOptions): Promise<string> {
    this.calls.push({ prompt, opts });
    return this.runOneShotImpl(prompt, opts);
  }

  async runSessionShot(prompts: string[], opts?: RunOneShotOptions): Promise<string[]> {
    this.sessionCalls.push({ prompts, opts });
    return this.runSessionShotImpl(prompts, opts);
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
  // Single registry shared between ingestion + digestion mirrors the
  // production wiring in `routes/chat.ts`.
  const queueRegistry = new WorkspaceTaskQueueRegistry();
  ingestion = new KbIngestionService({
    chatService,
    emit: (h, frame) => emitted.push({ hash: h, frame }),
    queueRegistry,
  });
  digestion = new KbDigestionService({
    chatService,
    backendRegistry,
    emit: (h, frame) => emitted.push({ hash: h, frame }),
    queueRegistry,
  });

  // Bootstrap workspace with KB enabled.
  await chatService.createConversation('seed', WORKSPACE_PATH);
  hash = workspaceHash(WORKSPACE_PATH);
  await chatService.setWorkspaceKbEnabled(hash, true);
});

afterEach(() => {
  jest.restoreAllMocks();
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

  test('explains source-aware image-consultation rules per source label', () => {
    // Hybrid ingestion (issue #211) annotates each page/slide/image section
    // with a `> source: <label>` blockquote. The digestion prompt must teach
    // the CLI when to open the accompanying image based on that label —
    // replacing the blunt "open EVERY image" rule from PR #207.
    const prompt = buildDigestPrompt({
      filename: 'book.pdf',
      folderPath: 'books',
      rawId: 'pdfraw',
      handler: 'pdf/rasterized',
      mimeType: 'application/pdf',
      convertedTextPath: 'converted/pdfraw/text.md',
      convertedText: '# book.pdf\n\n## Page 1\n\n> source: pdfjs\n\n![Page 1](pages/page-0001.png)',
      handlerMetadata: { pageCount: 185, rasterDpi: 150 },
    });

    expect(prompt).toMatch(/`> source: <label>` blockquote/);

    // pdfjs / xml-extract — text reliable, consult image only when needed.
    expect(prompt).toContain('source: pdfjs');
    expect(prompt).toContain('source: xml-extract');
    expect(prompt).toMatch(/Consult the image\s+only when/);

    // artificial-intelligence — markdown primary, open image to verify.
    expect(prompt).toContain('source: artificial-intelligence');
    expect(prompt).toMatch(/markdown is your primary source/);
    expect(prompt).toMatch(/verify a specific table cell, figure detail/);

    // image-only — image IS the content, MUST open.
    expect(prompt).toContain('source: image-only');
    expect(prompt).toMatch(/image IS the content/);
    expect(prompt).toMatch(/MUST open and analyze it/);

    // Path-resolution rule preserved from PR #207.
    expect(prompt).toMatch(/relative to the converted text file's directory/);
  });

  test('buildGleaningPrompt asks only for missed additional entries', () => {
    const prompt = buildGleaningPrompt();
    expect(prompt).toContain('Review the source range');
    expect(prompt).toContain('Return only additional entries');
    expect(prompt).toContain('If nothing important was missed');
  });
});

describe('BaseBackendAdapter runSessionShot default', () => {
  test('replays prior prompts and outputs through runOneShot', async () => {
    class OneShotOnlyAdapter extends BaseBackendAdapter {
      prompts: string[] = [];
      async runOneShot(prompt: string): Promise<string> {
        this.prompts.push(prompt);
        return `out-${this.prompts.length}`;
      }
    }
    const adapter = new OneShotOnlyAdapter();

    await expect(adapter.runSessionShot(['first', 'second'])).resolves.toEqual(['out-1', 'out-2']);
    expect(adapter.prompts[0]).toBe('first');
    expect(adapter.prompts[1]).toContain('## Prompt 1');
    expect(adapter.prompts[1]).toContain('first');
    expect(adapter.prompts[1]).toContain('## Response 1');
    expect(adapter.prompts[1]).toContain('out-1');
    expect(adapter.prompts[1]).toContain('## Next Prompt\nsecond');
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
    expect(db.listEntrySources(`${rawId}-original`)).toHaveLength(1);

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
    expect(db.listEntrySources(`${rawId}-original`)).toEqual([]);
    expect(db.listEntrySources(`${rawId}-revised`)).toHaveLength(1);
    const remaining = db.listEntries({ rawId });
    expect(remaining.map((e) => e.slug)).toEqual(['revised']);

    // Disk: old dir gone, new dir exists.
    const oldDir = path.join(chatService.getKbEntriesDir(hash), `${rawId}-original`);
    const newDir = path.join(chatService.getKbEntriesDir(hash), `${rawId}-revised`);
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(newDir)).toBe(true);
  });

  test('redigest staging failure preserves prior entries and files', async () => {
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
    const entriesRoot = chatService.getKbEntriesDir(hash);
    const originalEntryId = `${rawId}-original`;
    const originalPath = path.join(entriesRoot, originalEntryId, 'entry.md');
    const originalMd = fs.readFileSync(originalPath, 'utf8');

    const realWriteFile = fs.promises.writeFile.bind(fs.promises);
    jest.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      if (String(file).includes(`${path.sep}.staging${path.sep}`)) {
        throw new Error('disk full while staging');
      }
      return realWriteFile(file, data, options);
    });

    backend.runOneShotImpl = async () => `---
title: Revised
slug: revised
summary: Updated.
tags: [v2]
---
Revised body.`;

    const result = await digestion.enqueueDigest(hash, rawId);

    expect(result.error?.class).toBe('schema_rejection');
    expect(db.entryIdTaken(originalEntryId)).toBe(true);
    expect(db.entryIdTaken(`${rawId}-revised`)).toBe(false);
    expect(db.listEntries({ rawId }).map((e) => e.slug)).toEqual(['original']);
    expect(fs.existsSync(originalPath)).toBe(true);
    expect(fs.readFileSync(originalPath, 'utf8')).toBe(originalMd);
    expect(fs.existsSync(path.join(entriesRoot, `${rawId}-revised`))).toBe(false);
    expect(db.getRawById(rawId)?.status).toBe('failed');
  });

  test('redigest recovers an interrupted file replacement before retrying', async () => {
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
    const entriesRoot = chatService.getKbEntriesDir(hash);
    const originalEntryId = `${rawId}-original`;
    const revisedEntryId = `${rawId}-revised`;
    const backupName = `${rawId}-interrupted`;
    const backupRoot = path.join(entriesRoot, '.backup', backupName);

    fs.mkdirSync(backupRoot, { recursive: true });
    fs.renameSync(path.join(entriesRoot, originalEntryId), path.join(backupRoot, originalEntryId));
    fs.mkdirSync(path.join(entriesRoot, revisedEntryId), { recursive: true });
    fs.writeFileSync(path.join(entriesRoot, revisedEntryId, 'entry.md'), 'crashed replacement');
    fs.mkdirSync(path.join(entriesRoot, '.staging', backupName), { recursive: true });
    fs.writeFileSync(
      path.join(backupRoot, 'manifest.json'),
      JSON.stringify({
        version: 1,
        rawId,
        stagingName: backupName,
        staleIds: [originalEntryId],
        replacementIds: [revisedEntryId],
        replacementDigestedAt: '2099-01-01T00:00:00.000Z',
      }),
    );

    backend.runOneShotImpl = async () => `---
title: Revised
slug: revised
summary: Updated.
tags: [v2]
---
Revised body.`;
    digestion = new KbDigestionService({
      chatService,
      backendRegistry,
      emit: (h, frame) => emitted.push({ hash: h, frame }),
      queueRegistry: new WorkspaceTaskQueueRegistry(),
    });

    const result = await digestion.enqueueDigest(hash, rawId);

    expect(result.error).toBeUndefined();
    expect(db.entryIdTaken(originalEntryId)).toBe(false);
    expect(db.entryIdTaken(revisedEntryId)).toBe(true);
    expect(fs.existsSync(backupRoot)).toBe(false);
    expect(fs.existsSync(path.join(entriesRoot, '.staging', backupName))).toBe(false);
    expect(fs.readFileSync(path.join(entriesRoot, revisedEntryId, 'entry.md'), 'utf8')).toContain('Revised body.');
  });

  test('re-digest deletes stale entry embeddings before writing replacements', async () => {
    const rawId = await seedRaw('first run content', 'first.md');
    const db = chatService.getKbDb(hash)!;
    const staleEntryId = `${rawId}-old`;
    db.insertEntry({
      entryId: staleEntryId,
      rawId,
      title: 'Old',
      slug: 'old',
      summary: 'Old summary.',
      schemaVersion: KB_ENTRY_SCHEMA_VERSION,
      digestedAt: '2026-01-02T00:00:00.000Z',
      tags: [],
    });

    const store = {
      deleteEntry: jest.fn().mockResolvedValue(undefined),
      setModel: jest.fn().mockResolvedValue(undefined),
      upsertEntry: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(chatService, 'getWorkspaceKbEmbeddingConfig').mockResolvedValue({
      model: 'test-embed',
      dimensions: 3,
    });
    jest.spyOn(chatService, 'getKbVectorStore').mockResolvedValue(store as any);
    jest.spyOn(embeddings, 'embedBatch').mockResolvedValue([
      { embedding: [0.1, 0.2, 0.3], model: 'test-embed', dimensions: 3 },
    ]);

    backend.runOneShotImpl = async () => `---
title: New
slug: new
summary: New summary.
tags: []
---
New body.`;

    const result = await digestion.enqueueDigest(hash, rawId);

    expect(result.error).toBeUndefined();
    expect(store.deleteEntry).toHaveBeenCalledWith(staleEntryId);
    expect(store.upsertEntry).toHaveBeenCalledWith(
      `${rawId}-new`,
      'New',
      'New summary.',
      [0.1, 0.2, 0.3],
    );
  });

  test('chunk failure preserves prior entries in strict mode', async () => {
    const pages = Array.from({ length: 30 }, (_, i) => `## Page ${i + 1}\nPage body ${i + 1}`).join('\n\n');
    const rawId = await seedRaw(pages, 'chunked.md');
    let call = 0;
    backend.runOneShotImpl = async () => {
      call += 1;
      return `---
title: Old ${call}
slug: old-${call}
summary: Existing chunk output.
tags: []
---
Old body ${call}.`;
    };
    await digestion.enqueueDigest(hash, rawId);
    const db = chatService.getKbDb(hash)!;
    expect(db.listEntries({ rawId }).map((e) => e.slug).sort()).toEqual(['old-1', 'old-2']);

    db.updateRawStatus(rawId, 'ingested');
    call = 0;
    backend.calls = [];
    backend.runOneShotImpl = async () => {
      call += 1;
      if (call === 2) return 'not parseable';
      return `---
title: New
slug: new
summary: New chunk output.
tags: []
---
New body.`;
    };

    const result = await digestion.enqueueDigest(hash, rawId);

    expect(result.error?.class).toBe('malformed_output');
    expect(backend.calls).toHaveLength(2);
    expect(db.listEntries({ rawId }).map((e) => e.slug).sort()).toEqual(['old-1', 'old-2']);
    expect(db.getRawById(rawId)?.status).toBe('failed');
  });

  test('text-heavy structured documents split into multiple digestion calls', async () => {
    const content = Array.from(
      { length: 6 },
      (_, i) => `# Section ${i + 1}\n${'body '.repeat(1100)}`,
    ).join('\n\n');
    const rawId = await seedRaw(content, 'large-sections.md');
    backend.runOneShotImpl = async (prompt) => {
      const range = prompt.match(/- Unit range: (\d+)-(\d+)/);
      const suffix = range ? `${range[1]}-${range[2]}` : 'unknown';
      return `---
title: Range ${suffix}
slug: range-${suffix}
summary: Range ${suffix}.
tags: []
---
Body ${suffix}.`;
    };

    const result = await digestion.enqueueDigest(hash, rawId);

    expect(result.error).toBeUndefined();
    expect(backend.calls).toHaveLength(3);
    expect(backend.calls.map((call) => call.prompt.match(/- Unit range: (\d+-\d+)/)?.[1])).toEqual([
      '1-3',
      '4-5',
      '6-7',
    ]);
  });

  test('gleaning is disabled by default and uses runOneShot only', async () => {
    const rawId = await seedRaw('plain source', 'plain.md');
    backend.runSessionShotImpl = jest.fn();
    backend.runOneShotImpl = async () => `---
title: Base
slug: base
summary: Base extraction.
tags: []
---
Base body.`;

    await digestion.enqueueDigest(hash, rawId);

    expect(backend.calls).toHaveLength(1);
    expect(backend.sessionCalls).toHaveLength(0);
  });

  test('gleaning enabled uses runSessionShot and merges additional entries', async () => {
    await chatService.saveSettings({
      theme: 'system',
      sendBehavior: 'enter',
      systemPrompt: '',
      defaultBackend: STUB_BACKEND_ID,
      workingDirectory: '',
      knowledgeBase: {
        digestionCliBackend: STUB_BACKEND_ID,
        kbGleaningEnabled: true,
      },
    });
    const rawId = await seedRaw('gleaning source', 'glean.md');
    backend.runSessionShotImpl = async () => [
      `---
title: Base
slug: base
summary: Base extraction.
tags: []
---
Base body.`,
      `---
title: Base Duplicate
slug: base
summary: Duplicate base extraction.
tags: [dupe]
---
Duplicate base body.
---
title: Gleaned
slug: gleaned
summary: Extra extraction.
tags: [extra]
---
Gleaned body.`,
    ];

    const result = await digestion.enqueueDigest(hash, rawId);

    expect(result.error).toBeUndefined();
    expect(backend.calls).toHaveLength(0);
    expect(backend.sessionCalls).toHaveLength(1);
    expect(backend.sessionCalls[0].prompts).toHaveLength(2);
    const db = chatService.getKbDb(hash)!;
    expect(db.listEntries({ rawId }).map((e) => e.slug).sort()).toEqual(['base', 'gleaned']);
  });

  test('exact slug duplicates merge and keep multiple source ranges', async () => {
    const pages = Array.from({ length: 30 }, (_, i) => `## Page ${i + 1}\nPage body ${i + 1}`).join('\n\n');
    const rawId = await seedRaw(pages, 'dup.md');
    let call = 0;
    backend.runOneShotImpl = async () => {
      call += 1;
      return `---
title: Shared Topic
slug: shared
summary: Shared extraction.
tags: [chunk-${call}]
---
Shared body from chunk ${call}.`;
    };
    const result = await digestion.enqueueDigest(hash, rawId);
    const db = chatService.getKbDb(hash)!;
    expect(result.entryIds).toEqual([`${rawId}-shared`]);
    expect(db.getEntry(`${rawId}-shared`)?.tags.sort()).toEqual(['chunk-1', 'chunk-2']);
    expect(db.listEntrySources(`${rawId}-shared`).map((s) => [s.startUnit, s.endUnit])).toEqual([[1, 25], [26, 30]]);
    const md = fs.readFileSync(
      path.join(chatService.getKbEntriesDir(hash), `${rawId}-shared`, 'entry.md'),
      'utf8',
    );
    expect(md).toContain('Shared body from chunk 1.');
    expect(md).toContain('Shared body from chunk 2.');
  });

  test('merged structure chunks store range lineage without a misleading single node', async () => {
    const rawId = await seedRaw('## Page 1\nPage body 1\n\n## Page 2\nPage body 2', 'merged-pages.md');
    backend.runOneShotImpl = async () => `---
title: Merged Pages
slug: merged-pages
summary: Covers both pages.
tags: [merged]
---
Merged body.`;

    await digestion.enqueueDigest(hash, rawId);

    const db = chatService.getKbDb(hash)!;
    const sources = db.listEntrySources(`${rawId}-merged-pages`);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      nodeId: null,
      chunkId: 'chunk-0001-u1-2',
      startUnit: 1,
      endUnit: 2,
    });
  });

  test('normalized title duplicates merge even when slugs differ', async () => {
    const pages = Array.from({ length: 30 }, (_, i) => `## Page ${i + 1}\nPage body ${i + 1}`).join('\n\n');
    const rawId = await seedRaw(pages, 'title-dupes.md');
    let call = 0;
    backend.runOneShotImpl = async () => {
      call += 1;
      return call === 1
        ? `---
title: Repeated Topic
slug: repeated-a
summary: First extraction.
tags: [a]
---
First body.`
        : `---
title: Repeated   Topic
slug: repeated-b
summary: Second extraction.
tags: [b]
---
Second body.`;
    };

    await digestion.enqueueDigest(hash, rawId);

    const db = chatService.getKbDb(hash)!;
    expect(db.entryIdTaken(`${rawId}-repeated-a`)).toBe(true);
    expect(db.entryIdTaken(`${rawId}-repeated-b`)).toBe(false);
    expect(db.getEntry(`${rawId}-repeated-a`)?.tags.sort()).toEqual(['a', 'b']);
    expect(db.listEntrySources(`${rawId}-repeated-a`)).toHaveLength(2);
    const md = fs.readFileSync(
      path.join(chatService.getKbEntriesDir(hash), `${rawId}-repeated-a`, 'entry.md'),
      'utf8',
    );
    expect(md).toContain('First body.');
    expect(md).toContain('Second body.');
  });

  test('non-duplicate entries remain separate', async () => {
    const rawId = await seedRaw('source with distinct entries', 'distinct.md');
    backend.runOneShotImpl = async () => `---
title: First Topic
slug: first-topic
summary: First extraction.
tags: []
---
First body.
---
title: Second Topic
slug: second-topic
summary: Second extraction.
tags: []
---
Second body.`;
    const result = await digestion.enqueueDigest(hash, rawId);
    expect(result.entryIds.sort()).toEqual([`${rawId}-first-topic`, `${rawId}-second-topic`].sort());
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

  test('records timeout class when Kiro reports TimedOut', async () => {
    const rawId = await seedRaw('some text', 'kiro-timeout.md');
    backend.runOneShotImpl = async () => {
      throw new Error('CodewhispererChatResponseStream(DispatchFailure({ source: TimedOut }))');
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
  test('digests every ingested raw and emits digestProgress frames', async () => {
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
      .map((e) => e.frame.changed.digestProgress)
      .filter((p) => p !== undefined);
    // Expect at least: one enqueue-time snapshot, two done-bump snapshots,
    // and a final null on drain.
    expect(progressFrames.length).toBeGreaterThanOrEqual(3);
    const lastNonNull = [...progressFrames].reverse().find((p) => p !== null);
    expect(lastNonNull).toMatchObject({ done: 2, total: 2 });
    expect(progressFrames[progressFrames.length - 1]).toBeNull();
  });

  test('returns empty array when nothing is eligible', async () => {
    const results = await digestion.enqueueBatchDigest(hash);
    expect(results).toEqual([]);
  });
});

// ─── digestProgress aggregate ───────────────────────────────────────────────

describe('digestProgress aggregate progress', () => {
  function extractProgressFrames(
    frames: Array<{ hash: string; frame: KbStateUpdateEvent }>,
  ) {
    return frames
      .filter((e) => 'digestProgress' in e.frame.changed)
      .map((e) => e.frame.changed.digestProgress);
  }

  test('single enqueueDigest bumps total and emits progress', async () => {
    const rawId = await seedRaw('single body', 'single.md');
    backend.runOneShotImpl = async () => `---
title: Solo
slug: solo
summary: Only one.
tags: []
---
Body.`;
    emitted.length = 0;
    await digestion.enqueueDigest(hash, rawId);

    const progress = extractProgressFrames(emitted);
    // First snapshot on enqueue: total=1, done=0.
    const first = progress.find((p) => p !== null);
    expect(first).toMatchObject({ total: 1, done: 0 });
    // Final null signal on drain.
    expect(progress[progress.length - 1]).toBeNull();
    // Penultimate non-null snapshot: done === total === 1.
    const lastNonNull = [...progress].reverse().find((p) => p !== null);
    expect(lastNonNull).toMatchObject({ done: 1, total: 1 });
  });

  test('etaMs is absent at done < 2 and present once done >= 2', async () => {
    const rawA = await seedRaw('alpha', 'a.md');
    const rawB = await seedRaw('beta', 'b.md');
    backend.runOneShotImpl = async (prompt) => {
      const isA = prompt.includes('a.md');
      // Add a small artificial delay so avgMsPerItem > 0 rounds non-zero.
      await new Promise((r) => setTimeout(r, 15));
      return `---
title: ${isA ? 'A' : 'B'}
slug: ${isA ? 'a' : 'b'}
summary: .
tags: []
---
Body.`;
    };
    emitted.length = 0;
    await digestion.enqueueBatchDigest(hash);

    const progress = extractProgressFrames(emitted);
    const nonNull = progress.filter((p): p is NonNullable<typeof p> => p != null);
    // No snapshot should carry etaMs while done < 2.
    for (const snap of nonNull) {
      if (snap.done < 2) expect(snap.etaMs).toBeUndefined();
    }
    // Once done === 2 (and avgMsPerItem > 0) the final snapshot reports
    // etaMs — for a fully-drained session remaining is 0, so etaMs is 0.
    const doneAtTwo = nonNull.filter((s) => s.done === 2);
    expect(doneAtTwo.length).toBeGreaterThan(0);
    const last = doneAtTwo[doneAtTwo.length - 1];
    expect(last.etaMs).toBeDefined();
    expect(last.etaMs).toBe(0);
    expect(last.avgMsPerItem).toBeGreaterThan(0);
    // rawA, rawB present — prevents unused-var lint complaints.
    expect(rawA && rawB).toBeTruthy();
  });

  test('mid-session enqueue bumps total without resetting avg', async () => {
    const rawA = await seedRaw('alpha', 'a.md');
    const rawBId = await seedRaw('beta', 'b.md');

    // Gate the first digest's CLI call so the second enqueue is guaranteed
    // to land while the session is still open. The previous form relied on
    // a 5 ms timer winning the race against `seedRaw('beta')` on a slow CI
    // runner — when it didn't, the first session drained before the second
    // enqueue and `total` never reached 2.
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });

    backend.runOneShotImpl = async (prompt) => {
      const isA = prompt.includes('a.md');
      if (isA) {
        signalFirstStarted();
        await firstHeld;
      }
      // 10 ms keeps avgMsPerItem > 0 once digests complete.
      await new Promise((r) => setTimeout(r, 10));
      return `---
title: ${isA ? 'A' : 'B'}
slug: ${isA ? 'a' : 'b'}
summary: .
tags: []
---
Body.`;
    };

    emitted.length = 0;
    const firstPromise = digestion.enqueueDigest(hash, rawA);
    await firstStarted;
    const secondPromise = digestion.enqueueDigest(hash, rawBId);
    // Spin until the session has registered the second raw (total = 2).
    // Deterministic: not time-based, so CI machine speed can't race.
    while (digestion.getSessionProgress(hash)?.total !== 2) {
      await new Promise((r) => setImmediate(r));
    }
    releaseFirst();
    await Promise.all([firstPromise, secondPromise]);

    const progress = extractProgressFrames(emitted);
    const nonNull = progress.filter((p): p is NonNullable<typeof p> => p != null);
    // Total should grow from 1 to 2 as the second enqueue lands.
    const maxTotal = Math.max(...nonNull.map((p) => p.total));
    expect(maxTotal).toBe(2);
    // avgMsPerItem must never reset to 0 once we've had a done sample.
    // Walk the snapshots and assert it only monotonically reflects new samples.
    const samples = nonNull.filter((p) => p.done >= 1).map((p) => p.avgMsPerItem);
    for (const v of samples) expect(v).toBeGreaterThan(0);
    // Final non-null snapshot: done === total === 2.
    const lastNonNull = nonNull[nonNull.length - 1];
    expect(lastNonNull).toMatchObject({ done: 2, total: 2 });
    // Drain signal fires exactly once at the very end.
    expect(progress[progress.length - 1]).toBeNull();
  });

  test('GET /kb returns digestProgress mid-session and null after drain', async () => {
    const rawA = await seedRaw('alpha', 'a.md');
    backend.runOneShotImpl = async () => {
      // Long enough that we can read the snapshot mid-flight.
      await new Promise((r) => setTimeout(r, 50));
      return `---
title: A
slug: a
summary: .
tags: []
---
Body.`;
    };
    const runPromise = digestion.enqueueDigest(hash, rawA);
    // Snapshot while the digest is in flight — enqueue already persisted
    // the session row, so GET /kb should surface it.
    await new Promise((r) => setTimeout(r, 10));
    const midSnapshot = await chatService.getKbStateSnapshot(hash);
    expect(midSnapshot?.digestProgress).not.toBeNull();
    expect(midSnapshot?.digestProgress?.total).toBe(1);

    await runPromise;
    const afterSnapshot = await chatService.getKbStateSnapshot(hash);
    expect(afterSnapshot?.digestProgress).toBeNull();
  });

  test('reports live chunk planning and chunk completion progress', async () => {
    const pages = Array.from({ length: 30 }, (_, i) => `## Page ${i + 1}\nPage body ${i + 1}`).join('\n\n');
    const rawId = await seedRaw(pages, 'chunk-progress.md');
    let call = 0;
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });

    backend.runOneShotImpl = async () => {
      call += 1;
      if (call === 1) {
        signalFirstStarted();
        await firstHeld;
      }
      return `---
title: Chunk ${call}
slug: chunk-${call}
summary: Chunk extraction.
tags: []
---
Body ${call}.`;
    };

    emitted.length = 0;
    const runPromise = digestion.enqueueDigest(hash, rawId);
    await firstStarted;

    const midProgress = digestion.getSessionProgress(hash);
    expect(midProgress?.chunks).toMatchObject({
      done: 0,
      total: 2,
      active: 1,
      phase: 'digesting',
      current: {
        rawId,
        chunkId: 'chunk-0001-u1-25',
        index: 1,
        total: 2,
        startUnit: 1,
        endUnit: 25,
        unitType: 'page',
      },
    });

    releaseFirst();
    await runPromise;

    const progress = extractProgressFrames(emitted);
    const nonNull = progress.filter((p): p is NonNullable<typeof p> => p != null);
    expect(nonNull.some((p) => p.chunks?.phase === 'planning')).toBe(true);
    expect(nonNull.some((p) => p.chunks?.phase === 'parsing')).toBe(true);
    const lastNonNull = nonNull[nonNull.length - 1];
    expect(lastNonNull.chunks).toMatchObject({
      done: 2,
      total: 2,
      active: 0,
      phase: 'committing',
      current: { rawId },
    });
  });

  test('crash recovery clears persisted digest_session on new KbDatabase', async () => {
    const db = chatService.getKbDb(hash)!;
    // Simulate a crash-frozen session row.
    db.upsertDigestSession({
      total: 5,
      done: 2,
      totalElapsedMs: 10_000,
      startedAt: new Date().toISOString(),
    });
    expect(db.getDigestSession()).not.toBeNull();

    // Build the path by asking the service for a fresh DB handle after
    // closing caches. Re-opening the DB at the same path should trigger
    // _recoverFromCrash and wipe the stale session row.
    chatService.closeKbDatabases?.();
    const reopened = chatService.getKbDb(hash)!;
    expect(reopened.getDigestSession()).toBeNull();
  });

  test('crash recovery flips stuck "digesting" raws back to "ingested"', async () => {
    const rawId = await seedRaw('will stick', 'stuck.md');
    const db = chatService.getKbDb(hash)!;
    // Simulate a worker that died mid-digest.
    db.updateRawStatus(rawId, 'digesting');
    expect(db.getRawById(rawId)?.status).toBe('digesting');

    chatService.closeKbDatabases?.();
    const reopened = chatService.getKbDb(hash)!;
    expect(reopened.getRawById(rawId)?.status).toBe('ingested');
  });
});

// ─── Digestion session counter ──────────────────────────────────────────────

describe('digestion session counter', () => {
  test('single digest emits active:true then active:false with entry count', async () => {
    const rawId = await seedRaw('Session test body.', 'session.md');
    backend.runOneShotImpl = async () => `---
title: One
slug: one
summary: First.
tags: []
---
First body.
---
title: Two
slug: two
summary: Second.
tags: []
---
Second body.`;
    emitted.length = 0;
    await digestion.enqueueDigest(hash, rawId);

    const digestionFrames = emitted
      .map((e) => e.frame.changed.digestion)
      .filter((d): d is { active: boolean; entriesCreated: number } => d !== undefined);

    expect(digestionFrames).toEqual([
      { active: true, entriesCreated: 2 },
      { active: false, entriesCreated: 2 },
    ]);
  });

  test('batch digest accumulates entries across raws and closes once', async () => {
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
    await digestion.enqueueBatchDigest(hash);

    const digestionFrames = emitted
      .map((e) => e.frame.changed.digestion)
      .filter((d): d is { active: boolean; entriesCreated: number } => d !== undefined);

    // Two active:true frames (one per raw) followed by exactly one active:false.
    const active = digestionFrames.filter((d) => d.active);
    const complete = digestionFrames.filter((d) => !d.active);
    expect(active.map((d) => d.entriesCreated)).toEqual([1, 2]);
    expect(complete).toEqual([{ active: false, entriesCreated: 2 }]);
    // rawA, rawB were present — prevents TS/lint unused var complaints.
    expect(rawA).toBeTruthy();
    expect(rawB).toBeTruthy();
  });

  test('counter resets after completion so a second run starts at zero', async () => {
    const rawId = await seedRaw('first round', 'first.md');
    backend.runOneShotImpl = async () => `---
title: First
slug: first
summary: One.
tags: []
---
Body one.`;
    await digestion.enqueueDigest(hash, rawId);

    const rawId2 = await seedRaw('second round', 'second.md');
    backend.runOneShotImpl = async () => `---
title: Second
slug: second
summary: Two.
tags: []
---
Body two.`;
    emitted.length = 0;
    await digestion.enqueueDigest(hash, rawId2);

    const digestionFrames = emitted
      .map((e) => e.frame.changed.digestion)
      .filter((d): d is { active: boolean; entriesCreated: number } => d !== undefined);

    expect(digestionFrames).toEqual([
      { active: true, entriesCreated: 1 },
      { active: false, entriesCreated: 1 },
    ]);
  });

  test('failed digest still closes the session with zero entries', async () => {
    const rawId = await seedRaw('will fail', 'fail.md');
    backend.runOneShotImpl = async () => 'not parseable output';
    emitted.length = 0;
    const result = await digestion.enqueueDigest(hash, rawId);
    expect(result.error).toBeDefined();

    const digestionFrames = emitted
      .map((e) => e.frame.changed.digestion)
      .filter((d): d is { active: boolean; entriesCreated: number } => d !== undefined);

    // No entries were created, so we only emit the final active:false frame
    // with a zero count — no intermediate "active:true" progress frame.
    expect(digestionFrames).toEqual([
      { active: false, entriesCreated: 0 },
    ]);
  });
});

// ─── Substep emissions ──────────────────────────────────────────────────────

describe('substep emissions during digestion', () => {
  test('emits substep frames for CLI analysis and parsing phases', async () => {
    const rawId = await seedRaw('Substep test body.', 'sub.md');
    backend.runOneShotImpl = async () => `---
title: Substep
slug: substep
summary: Testing substep emissions.
tags: []
---
Substep body.`;
    emitted.length = 0;
    await digestion.enqueueDigest(hash, rawId);

    const substepFrames = emitted
      .filter((e) => e.frame.changed.substep !== undefined)
      .map((e) => e.frame.changed.substep!);

    // Should have at least 2 substep emissions: one for CLI analysis, one for parsing.
    expect(substepFrames.length).toBeGreaterThanOrEqual(2);
    expect(substepFrames.every((s) => s.rawId === rawId)).toBe(true);

    const texts = substepFrames.map((s) => s.text);
    expect(texts.some((t) => /CLI analysis/i.test(t) || /Running/i.test(t))).toBe(true);
    expect(texts.some((t) => /Pars/i.test(t))).toBe(true);
  });
});

// ─── Adaptive digest timeout ────────────────────────────────────────────────

describe('adaptive digest timeout', () => {
  // Helper: overwrite the converted meta.json after seedRaw so the digest
  // pipeline reads the desired handler metadata without needing a real
  // PDF/PPTX handler in the test path.
  async function seedWithMeta(metadata: Record<string, unknown>): Promise<string> {
    let content = 'body';
    if (typeof metadata.pageCount === 'number') {
      content = Array.from({ length: metadata.pageCount }, (_, i) => `## Page ${i + 1}\nbody ${i + 1}`).join('\n\n');
    } else if (typeof metadata.slideCount === 'number') {
      content = Array.from({ length: metadata.slideCount }, (_, i) => `## Slide ${i + 1}\nbody ${i + 1}`).join('\n\n');
    }
    const rawId = await seedRaw(content, 'doc.md');
    const metaPath = path.join(chatService.getKbConvertedDir(hash), rawId, 'meta.json');
    fs.writeFileSync(metaPath, JSON.stringify({ metadata }));
    return rawId;
  }

  function stubMinimalEntry() {
    backend.runOneShotImpl = async () => `---
title: T
slug: t
summary: s
tags: []
---
body.`;
  }

  test('falls back to 30-minute floor when no pageCount/slideCount is present', async () => {
    const rawId = await seedWithMeta({});
    stubMinimalEntry();
    await digestion.enqueueDigest(hash, rawId);
    expect(backend.calls[0].opts?.timeoutMs).toBe(30 * 60_000);
  });

  test('scales chunk timeout to chunk unit count × 10 minutes for large PDFs', async () => {
    const rawId = await seedWithMeta({ pageCount: 185, rasterDpi: 150 });
    stubMinimalEntry();
    await digestion.enqueueDigest(hash, rawId);
    expect(backend.calls).toHaveLength(8);
    expect(backend.calls[0].opts?.timeoutMs).toBe(25 * 10 * 60_000);
  });

  test('uses chunk unit count × 10 minutes for PPTX slides', async () => {
    const rawId = await seedWithMeta({ slideCount: 50 });
    stubMinimalEntry();
    await digestion.enqueueDigest(hash, rawId);
    expect(backend.calls).toHaveLength(2);
    expect(backend.calls[0].opts?.timeoutMs).toBe(25 * 10 * 60_000);
  });

  test('keeps the 30-minute floor when the unit count is small', async () => {
    const rawId = await seedWithMeta({ pageCount: 2 });
    stubMinimalEntry();
    await digestion.enqueueDigest(hash, rawId);
    expect(backend.calls[0].opts?.timeoutMs).toBe(30 * 60_000);
  });
});
