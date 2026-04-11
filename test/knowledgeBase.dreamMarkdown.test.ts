/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Synthesis markdown generator tests ─────────────────────────────────────

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { KbDatabase } from '../src/services/knowledgeBase/db';
import {
  regenerateSynthesisMarkdown,
  generateDreamTmpFiles,
  cleanupDreamTmp,
} from '../src/services/knowledgeBase/dreamMarkdown';

let tmpDir: string;
let rawDir: string;
let db: KbDatabase;
let synthesisDir: string;
let knowledgeDir: string;

function makeRaw(contents: string) {
  const buf = Buffer.from(contents);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const rawId = sha256.slice(0, 16);
  fs.writeFileSync(path.join(rawDir, `${rawId}.txt`), buf);
  return { rawId, sha256, byteLength: buf.length };
}

function seedRawAndEntry(entryId: string) {
  const { rawId, sha256, byteLength } = makeRaw(`content-${entryId}`);
  db.insertRaw({
    rawId, sha256, status: 'ingested', byteLength,
    mimeType: 'text/plain', handler: null,
    uploadedAt: new Date().toISOString(), metadata: null,
  });
  db.insertEntry({
    entryId, rawId, title: `Entry ${entryId}`, slug: entryId, summary: `Summary ${entryId}`,
    schemaVersion: 1, digestedAt: new Date().toISOString(), tags: [`tag-${entryId}`],
  });
}

function seedTopicsAndEntries() {
  const now = new Date().toISOString();
  seedRawAndEntry('e1');
  seedRawAndEntry('e2');
  db.upsertTopic({ topicId: 'topic-a', title: 'Topic A', summary: 'Summary A', content: 'Content A', updatedAt: now });
  db.upsertTopic({ topicId: 'topic-b', title: 'Topic B', summary: 'Summary B', content: 'Content B', updatedAt: now });
  db.assignEntries('topic-a', ['e1']);
  db.assignEntries('topic-b', ['e2']);
  db.upsertConnection({
    sourceTopic: 'topic-a', targetTopic: 'topic-b',
    relationship: 'influences', confidence: 'inferred', evidence: null,
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-dream-md-'));
  rawDir = path.join(tmpDir, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  db = new KbDatabase(path.join(tmpDir, 'state.db'));
  knowledgeDir = path.join(tmpDir, 'knowledge');
  synthesisDir = path.join(knowledgeDir, 'synthesis');
  fs.mkdirSync(knowledgeDir, { recursive: true });
});

afterEach(() => {
  try { db.close(); } catch { /* */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── regenerateSynthesisMarkdown ────────────────────────────────────────────

describe('regenerateSynthesisMarkdown', () => {
  test('creates index.md with topic table', () => {
    seedTopicsAndEntries();
    regenerateSynthesisMarkdown(db, synthesisDir);

    const indexPath = path.join(synthesisDir, 'index.md');
    expect(fs.existsSync(indexPath)).toBe(true);
    const content = fs.readFileSync(indexPath, 'utf-8');
    expect(content).toContain('Topic A');
    expect(content).toContain('Topic B');
    expect(content).toContain('topics/topic-a.md');
  });

  test('creates per-topic markdown files', () => {
    seedTopicsAndEntries();
    regenerateSynthesisMarkdown(db, synthesisDir);

    const topicAPath = path.join(synthesisDir, 'topics', 'topic-a.md');
    expect(fs.existsSync(topicAPath)).toBe(true);
    const content = fs.readFileSync(topicAPath, 'utf-8');
    expect(content).toContain('# Topic A');
    expect(content).toContain('Content A');
    expect(content).toContain('Entry e1');
    expect(content).toContain('Topic B');
    expect(content).toContain('influences');
  });

  test('creates connections.md', () => {
    seedTopicsAndEntries();
    regenerateSynthesisMarkdown(db, synthesisDir);

    const connPath = path.join(synthesisDir, 'connections.md');
    expect(fs.existsSync(connPath)).toBe(true);
    const content = fs.readFileSync(connPath, 'utf-8');
    expect(content).toContain('Topic A');
    expect(content).toContain('Topic B');
    expect(content).toContain('influences');
    expect(content).toContain('inferred');
  });

  test('wipes existing synthesis directory before regenerating', () => {
    seedTopicsAndEntries();
    regenerateSynthesisMarkdown(db, synthesisDir);
    expect(fs.existsSync(path.join(synthesisDir, 'topics', 'topic-a.md'))).toBe(true);

    db.deleteTopic('topic-a');
    regenerateSynthesisMarkdown(db, synthesisDir);

    expect(fs.existsSync(path.join(synthesisDir, 'topics', 'topic-a.md'))).toBe(false);
    expect(fs.existsSync(path.join(synthesisDir, 'topics', 'topic-b.md'))).toBe(true);
  });

  test('handles empty DB gracefully', () => {
    regenerateSynthesisMarkdown(db, synthesisDir);
    const index = fs.readFileSync(path.join(synthesisDir, 'index.md'), 'utf-8');
    expect(index).toContain('0 topics');
    expect(fs.existsSync(path.join(synthesisDir, 'connections.md'))).toBe(true);
  });
});

// ─── generateDreamTmpFiles ──────────────────────────────────────────────────

describe('generateDreamTmpFiles', () => {
  test('creates all-topics.txt', () => {
    seedTopicsAndEntries();
    generateDreamTmpFiles(db, knowledgeDir);

    const topicsFile = path.join(knowledgeDir, '_dream_tmp', 'all-topics.txt');
    expect(fs.existsSync(topicsFile)).toBe(true);
    const content = fs.readFileSync(topicsFile, 'utf-8');
    expect(content).toContain('topic-a');
    expect(content).toContain('Topic A');
  });

  test('creates per-topic content files', () => {
    seedTopicsAndEntries();
    generateDreamTmpFiles(db, knowledgeDir);

    const contentFile = path.join(knowledgeDir, '_dream_tmp', 'topic-topic-a-content.md');
    expect(fs.existsSync(contentFile)).toBe(true);
    const content = fs.readFileSync(contentFile, 'utf-8');
    expect(content).toContain('# Topic A');
    expect(content).toContain('Entry e1');
  });

  test('creates god-nodes.txt when god nodes exist', () => {
    seedTopicsAndEntries();
    db.setSynthesisMeta('god_nodes', JSON.stringify(['topic-a']));
    generateDreamTmpFiles(db, knowledgeDir);

    const godFile = path.join(knowledgeDir, '_dream_tmp', 'god-nodes.txt');
    expect(fs.existsSync(godFile)).toBe(true);
    const content = fs.readFileSync(godFile, 'utf-8');
    expect(content).toContain('Topic A');
    expect(content).toContain('splitting');
  });

  test('no god-nodes.txt when no god nodes', () => {
    seedTopicsAndEntries();
    generateDreamTmpFiles(db, knowledgeDir);

    const godFile = path.join(knowledgeDir, '_dream_tmp', 'god-nodes.txt');
    expect(fs.existsSync(godFile)).toBe(false);
  });

  test('handles empty DB gracefully', () => {
    generateDreamTmpFiles(db, knowledgeDir);
    const topicsFile = path.join(knowledgeDir, '_dream_tmp', 'all-topics.txt');
    expect(fs.existsSync(topicsFile)).toBe(true);
    const content = fs.readFileSync(topicsFile, 'utf-8');
    expect(content).toContain('no topics yet');
  });
});

// ─── cleanupDreamTmp ────────────────────────────────────────────────────────

describe('cleanupDreamTmp', () => {
  test('removes _dream_tmp directory', () => {
    seedTopicsAndEntries();
    generateDreamTmpFiles(db, knowledgeDir);
    const tmpPath = path.join(knowledgeDir, '_dream_tmp');
    expect(fs.existsSync(tmpPath)).toBe(true);

    cleanupDreamTmp(knowledgeDir);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  test('no-op when _dream_tmp does not exist', () => {
    cleanupDreamTmp(knowledgeDir);
  });
});
