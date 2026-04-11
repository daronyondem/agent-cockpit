// ─── Knowledge Base dreaming orchestrator ────────────────────────────────────
//
// Owns the "entries → synthesis" stage of the KB pipeline.
//
// Two-phase file-reference pipeline:
//   Phase 1 (Discovery): batch entries against topic summaries to find matches
//   Phase 2 (Synthesis): feed matched topics + entries to CLI for operations
//
// All prompts are lightweight instruction sheets pointing to files on disk.
// The CLI reads files on demand using its own tools (allowTools: true).
//
// Two modes:
//   - Incremental (default): processes only entries with needs_synthesis = 1
//   - Full Rebuild (Re-Dream): wipes synthesis tables, marks all entries
//     needs_synthesis = 1, then runs incremental
//
// Post-dream: regenerate markdown, detect god nodes, emit WS frames.

import path from 'path';
import type {
  KbErrorClass,
  KbStateUpdateEvent,
  Settings,
} from '../../types';
import type { BaseBackendAdapter, RunOneShotOptions } from '../backends/base';
import type { BackendRegistry } from '../backends/registry';
import type { KbDatabase } from './db';
import { parseDreamOutput, applyOperations } from './dreamOps';
import {
  regenerateSynthesisMarkdown,
  generateDreamTmpFiles,
  cleanupDreamTmp,
} from './dreamMarkdown';

// ── Prompt templates ────────────────────────────────────────────────────────

const EXECUTION_STRATEGY = `
## Execution Strategy
Use multiple agents to parallelize your work where possible. For example:
- Read multiple entry files in parallel rather than sequentially.
- Process independent topics concurrently.
- Delegate sub-tasks (reading files, evaluating matches) to separate agents.
`.trim();

function buildDiscoveryPrompt(
  entryList: Array<{ entryId: string; title: string; entryPath: string }>,
  topicCount: number,
): string {
  const entryLines = entryList
    .map((e) => `- ${e.entryId}: "${e.title}" — read at ${e.entryPath}`)
    .join('\n');
  return `You are analyzing new knowledge base entries to find which existing topics they relate to.

## New Entries
${entryLines}

## Existing Topics
Full list at: _dream_tmp/all-topics.txt
(${topicCount} topics, each line: ID | title | one-line summary)

## Task
Read each entry file. Scan the topic list. For each entry, identify which topics are
relevant. An entry is relevant to a topic if it contains information that belongs in
that topic, introduces facts that would change its content, or reveals connections.

Return JSON only:
{ "matches": [{ "entry_id": "...", "topic_id": "...", "reason": "one sentence" }] }

If no matches found, return: { "matches": [] }

${EXECUTION_STRATEGY}`;
}

function buildSynthesisPrompt(
  matchedTopics: Array<{ topicId: string; title: string; slug: string }>,
  entryList: Array<{ entryId: string; title: string; entryPath: string }>,
  topicCount: number,
  hasGodNodes: boolean,
): string {
  const topicLines = matchedTopics
    .map((t) => `- ${t.topicId}: "${t.title}" — read full content at _dream_tmp/topic-${t.slug}-content.md`)
    .join('\n');
  const entryLines = entryList
    .map((e) => `- ${e.entryId}: "${e.title}" — read at ${e.entryPath}`)
    .join('\n');
  const refLines = [
    `- All topic titles: _dream_tmp/all-topics.txt`,
    ...(hasGodNodes ? ['- God node warnings: _dream_tmp/god-nodes.txt'] : []),
  ].join('\n');

  return `You are updating a knowledge base synthesis layer.

## Topics to Update
${topicLines}

## New Entries to Process
${entryLines}

## Reference Files
${refLines}

## Instructions
1. Read each topic content file and each entry file.
2. Assign each new entry to one or more topics.
3. Rewrite topic content (prose) to incorporate new information.
4. Add/update connections to other topics (see all-topics.txt for full list).
5. If a topic is overly broad (see god-nodes.txt), consider splitting it.
6. You may merge, split, rename, or delete topics if restructuring improves clarity.
7. Every new entry must be assigned to at least one topic.

Connection confidence:
- "extracted": explicitly stated in entries
- "inferred": logically follows from content
- "speculative": plausible but uncertain

Return a JSON object with an "operations" array. Available operations:
- create_topic: { op, topic_id (slug), title, summary (one line), content (full markdown prose) }
- update_topic: { op, topic_id, title?, summary?, content? }
- merge_topics: { op, source_topic_ids[], into_topic_id, title, summary, content }
- split_topic: { op, source_topic_id, into: [{ topic_id, title, summary, content }] }
- delete_topic: { op, topic_id }
- assign_entries: { op, topic_id, entry_ids[] }
- unassign_entries: { op, topic_id, entry_ids[] }
- add_connection: { op, source_topic, target_topic, relationship, confidence, evidence }
- update_connection: { op, source_topic, target_topic, relationship?, confidence? }
- remove_connection: { op, source_topic, target_topic }

Return JSON only, no other text.

${EXECUTION_STRATEGY}`;
}

function buildNewTopicsPrompt(
  entryList: Array<{ entryId: string; title: string; entryPath: string }>,
): string {
  const entryLines = entryList
    .map((e) => `- ${e.entryId}: "${e.title}" — read at ${e.entryPath}`)
    .join('\n');
  return `You are creating new topics in a knowledge base synthesis layer. These entries did not match any existing topic.

## Entries
${entryLines}

## Existing Topics (for connection discovery)
Full list at: _dream_tmp/all-topics.txt

## Instructions
1. Read each entry file.
2. Organize entries into new topics. Group related entries together.
3. Write substantive synthesized prose for each topic — integrated knowledge articles,
   not summaries of individual entries.
4. Look for connections to existing topics (see all-topics.txt).
5. Prefer fewer, broader topics over many single-entry topics unless entries are
   truly unrelated.
6. Every entry must be assigned to at least one topic.

Return a JSON object with an "operations" array. Available operations:
create_topic, assign_entries, add_connection

Return JSON only, no other text.

${EXECUTION_STRATEGY}`;
}

function buildFullRebuildPrompt(
  entryList: Array<{ entryId: string; title: string; entryPath: string }>,
  batchNumber: number,
  totalBatches: number,
  hasExistingTopics: boolean,
): string {
  const entryLines = entryList
    .map((e) => `- ${e.entryId}: "${e.title}" — read at ${e.entryPath}`)
    .join('\n');
  const existingBlock = hasExistingTopics
    ? `\n## Topics Created in Prior Batches\nFull list at: _dream_tmp/all-topics.txt\nYou may assign entries to these existing topics or create new ones.\n`
    : '';
  return `You are building a knowledge base synthesis layer from scratch.

## Entries (batch ${batchNumber} of ${totalBatches})
${entryLines}
${existingBlock}
## Instructions
1. Read each entry file.
2. Discover topics and organize entries into them.
3. Write rich synthesized prose for each topic.
4. Establish connections between topics (within this batch and to prior-batch topics).
5. Every entry must be assigned to at least one topic.

Return a JSON object with an "operations" array. Return JSON only, no other text.

${EXECUTION_STRATEGY}`;
}

// ── Service types ───────────────────────────────────────────────────────────

/** Subset of chatService the dream orchestrator depends on. */
export interface KbDreamChatService {
  getWorkspaceKbEnabled(hash: string): Promise<boolean>;
  getKbDb(hash: string): KbDatabase | null;
  getSettings(): Promise<Settings>;
  getKbKnowledgeDir(hash: string): string;
  getKbEntriesDir(hash: string): string;
  getKbSynthesisDir(hash: string): string;
}

export type KbDreamEmitter = (hash: string, frame: KbStateUpdateEvent) => void;

export interface KbDreamOptions {
  chatService: KbDreamChatService;
  backendRegistry: BackendRegistry;
  emit?: KbDreamEmitter;
}

export interface DreamResult {
  mode: 'incremental' | 'full-rebuild';
  processedEntries: number;
  skippedBatches: number;
  errors: string[];
}

// ── Constants ───────────────────────────────────────────────────────────────

const DISCOVERY_BATCH_SIZE = 20;
const SYNTHESIS_BATCH_SIZE = 10;
const DEFAULT_CONCURRENCY = 2;
const DREAM_TIMEOUT_MS = 20 * 60_000; // 20 minutes per CLI call

// ── Service ─────────────────────────────────────────────────────────────────

export class KbDreamService {
  private readonly chatService: KbDreamChatService;
  private readonly backendRegistry: BackendRegistry;
  private readonly emit?: KbDreamEmitter;
  /** Per-workspace lock — only one dream run at a time. */
  private readonly running = new Set<string>();

  constructor(opts: KbDreamOptions) {
    this.chatService = opts.chatService;
    this.backendRegistry = opts.backendRegistry;
    this.emit = opts.emit;
  }

  /** Start an incremental dream run. */
  async dream(hash: string): Promise<DreamResult> {
    return this._run(hash, 'incremental');
  }

  /** Wipe synthesis and run a full rebuild. */
  async redream(hash: string): Promise<DreamResult> {
    return this._run(hash, 'full-rebuild');
  }

  /** Check if a dream run is in progress for a workspace. */
  isRunning(hash: string): boolean {
    return this.running.has(hash);
  }

  // ── Core pipeline ─────────────────────────────────────────────────────────

  private async _run(hash: string, mode: 'incremental' | 'full-rebuild'): Promise<DreamResult> {
    if (this.running.has(hash)) {
      throw new Error('A dreaming run is already in progress for this workspace.');
    }

    const enabled = await this.chatService.getWorkspaceKbEnabled(hash);
    if (!enabled) throw new Error('Knowledge Base is not enabled for this workspace.');

    const db = this.chatService.getKbDb(hash);
    if (!db) throw new Error('Knowledge Base database not available.');

    this.running.add(hash);
    db.setSynthesisMeta('status', 'running');
    db.setSynthesisMeta('last_run_error', '');
    this._emitSynthesisChange(hash);

    const result: DreamResult = { mode, processedEntries: 0, skippedBatches: 0, errors: [] };

    try {
      if (mode === 'full-rebuild') {
        db.wipeSynthesis();
        db.markAllNeedsSynthesis();
      }

      const settings = await this.chatService.getSettings();
      const adapter = this._getAdapter(settings);
      const runOptions = this._buildRunOptions(hash, settings);
      const concurrency = settings.knowledgeBase?.dreamingConcurrency ?? DEFAULT_CONCURRENCY;

      const staleEntryIds = db.listNeedsSynthesisEntryIds();
      if (staleEntryIds.length === 0) {
        db.setSynthesisMeta('status', 'idle');
        db.setSynthesisMeta('last_run_at', new Date().toISOString());
        this._emitSynthesisChange(hash);
        return result;
      }

      const knowledgeDir = this.chatService.getKbKnowledgeDir(hash);
      const entriesDir = this.chatService.getKbEntriesDir(hash);
      const synthesisDir = this.chatService.getKbSynthesisDir(hash);

      // Generate temp files for prompts.
      generateDreamTmpFiles(db, knowledgeDir);

      // Build entry metadata list.
      const entryMeta = staleEntryIds.map((eid) => {
        const entry = db.getEntry(eid);
        return {
          entryId: eid,
          title: entry?.title ?? eid,
          entryPath: `entries/${eid}/entry.md`,
        };
      });

      const topicSummaries = db.listTopicSummaries();
      const hasGodNodes = (db.getSynthesisMeta('god_nodes') ?? '[]') !== '[]';

      if (mode === 'full-rebuild' || topicSummaries.length === 0) {
        // Full rebuild: batch all entries, no discovery phase needed.
        await this._runFullRebuild(
          db, adapter, runOptions, entryMeta, knowledgeDir, concurrency, result,
        );
      } else {
        // Incremental: discovery → synthesis.
        await this._runIncremental(
          db, adapter, runOptions, entryMeta, topicSummaries, hasGodNodes,
          knowledgeDir, concurrency, result,
        );
      }

      // Post-dream: regenerate markdown, detect god nodes.
      regenerateSynthesisMarkdown(db, synthesisDir);

      const godNodes = db.detectGodNodes();
      db.setSynthesisMeta('god_nodes', JSON.stringify(godNodes));

      // Refresh temp files for next run (in case topics changed).
      cleanupDreamTmp(knowledgeDir);

      db.setSynthesisMeta('status', 'idle');
      db.setSynthesisMeta('last_run_at', new Date().toISOString());
      if (result.errors.length > 0) {
        db.setSynthesisMeta('last_run_error', result.errors.join('; '));
      }
    } catch (err) {
      const msg = (err as Error).message;
      db.setSynthesisMeta('status', 'failed');
      db.setSynthesisMeta('last_run_error', msg);
      result.errors.push(msg);
    } finally {
      this.running.delete(hash);
      cleanupDreamTmp(this.chatService.getKbKnowledgeDir(hash));
      this._emitSynthesisChange(hash);
    }

    return result;
  }

  // ── Incremental mode ──────────────────────────────────────────────────────

  private async _runIncremental(
    db: KbDatabase,
    adapter: BaseBackendAdapter,
    runOptions: RunOneShotOptions,
    entryMeta: Array<{ entryId: string; title: string; entryPath: string }>,
    topicSummaries: Array<{ topicId: string; title: string; summary: string | null }>,
    hasGodNodes: boolean,
    knowledgeDir: string,
    concurrency: number,
    result: DreamResult,
  ): Promise<void> {
    // Phase 1: Discovery — batch entries and find matching topics.
    const batches = chunk(entryMeta, DISCOVERY_BATCH_SIZE);
    const allMatches: Array<{ entry_id: string; topic_id: string }> = [];
    let discoveryDone = 0;

    // Emit 0/N so the frontend exits "Starting…" immediately.
    this._emitDreamProgress('discovery', 0, batches.length,
      this._hashFromOptions(runOptions));

    for (const batchGroup of chunk(batches, concurrency)) {
      const promises = batchGroup.map(async (batch) => {
        const prompt = buildDiscoveryPrompt(batch, topicSummaries.length);
        return this._runCliWithRetry(adapter, prompt, runOptions);
      });

      const results = await Promise.allSettled(promises);
      for (const r of results) {
        discoveryDone++;
        this._emitDreamProgress('discovery', discoveryDone, batches.length,
          this._hashFromOptions(runOptions));
        if (r.status === 'fulfilled' && r.value) {
          const parsed = parseDiscoveryOutput(r.value);
          allMatches.push(...parsed.matches);
          if (parsed.warnings.length > 0) {
            result.errors.push(...parsed.warnings);
          }
        } else if (r.status === 'rejected') {
          result.skippedBatches++;
          result.errors.push(`Discovery batch failed: ${(r.reason as Error).message}`);
        }
      }
    }

    // Group entries by matched topic.
    const matchedEntryIds = new Set(allMatches.map((m) => m.entry_id));
    const unmatchedEntries = entryMeta.filter((e) => !matchedEntryIds.has(e.entryId));
    const topicToEntries = new Map<string, string[]>();
    for (const m of allMatches) {
      const existing = topicToEntries.get(m.topic_id) ?? [];
      existing.push(m.entry_id);
      topicToEntries.set(m.topic_id, existing);
    }

    // Phase 2a: Synthesis for matched entries.
    const synthBatches = this._buildSynthesisBatches(
      topicToEntries, entryMeta, topicSummaries,
    );
    let synthDone = 0;
    const totalSynthBatches = synthBatches.length + (unmatchedEntries.length > 0 ? 1 : 0);

    for (const batchGroup of chunk(synthBatches, concurrency)) {
      const promises = batchGroup.map(async (batch) => {
        const prompt = buildSynthesisPrompt(
          batch.topics, batch.entries, topicSummaries.length, hasGodNodes,
        );
        return this._runCliWithRetry(adapter, prompt, runOptions);
      });

      const results = await Promise.allSettled(promises);
      for (let i = 0; i < results.length; i++) {
        synthDone++;
        this._emitDreamProgress('synthesis', synthDone, totalSynthBatches,
          this._hashFromOptions(runOptions));
        const r = results[i];
        if (r.status === 'fulfilled' && r.value) {
          const { operations, warnings } = parseDreamOutput(r.value);
          if (warnings.length > 0) result.errors.push(...warnings);
          const applyWarnings = applyOperations(db, operations);
          if (applyWarnings.length > 0) result.errors.push(...applyWarnings);
          // Mark processed entries.
          const processedIds = batchGroup[i].entries.map((e) => e.entryId);
          db.clearNeedsSynthesis(processedIds);
          result.processedEntries += processedIds.length;
          // Refresh all-topics.txt for subsequent batches.
          generateDreamTmpFiles(db, this.chatService.getKbKnowledgeDir(
            this._hashFromOptions(runOptions)));
        } else if (r.status === 'rejected') {
          result.skippedBatches++;
          result.errors.push(`Synthesis batch failed: ${(r.reason as Error).message}`);
        }
      }
    }

    // Phase 2b: New topics for unmatched entries.
    if (unmatchedEntries.length > 0) {
      for (const batch of chunk(unmatchedEntries, SYNTHESIS_BATCH_SIZE)) {
        try {
          const prompt = buildNewTopicsPrompt(batch);
          const output = await this._runCliWithRetry(adapter, prompt, runOptions);
          if (output) {
            const { operations, warnings } = parseDreamOutput(output);
            if (warnings.length > 0) result.errors.push(...warnings);
            const applyWarnings = applyOperations(db, operations);
            if (applyWarnings.length > 0) result.errors.push(...applyWarnings);
            db.clearNeedsSynthesis(batch.map((e) => e.entryId));
            result.processedEntries += batch.length;
            generateDreamTmpFiles(db, this.chatService.getKbKnowledgeDir(
              this._hashFromOptions(runOptions)));
          }
        } catch (err) {
          result.skippedBatches++;
          result.errors.push(`New-topics batch failed: ${(err as Error).message}`);
        }
      }
      synthDone++;
      this._emitDreamProgress('synthesis', synthDone, totalSynthBatches,
        this._hashFromOptions(runOptions));
    }
  }

  // ── Full rebuild mode ─────────────────────────────────────────────────────

  private async _runFullRebuild(
    db: KbDatabase,
    adapter: BaseBackendAdapter,
    runOptions: RunOneShotOptions,
    entryMeta: Array<{ entryId: string; title: string; entryPath: string }>,
    knowledgeDir: string,
    concurrency: number,
    result: DreamResult,
  ): Promise<void> {
    // Sort entries by tags for better topic clustering.
    const entriesWithTags = entryMeta.map((e) => {
      const entry = db.getEntry(e.entryId);
      return { ...e, tags: entry?.tags ?? [] };
    });
    entriesWithTags.sort((a, b) => {
      const ta = a.tags.join(',');
      const tb = b.tags.join(',');
      return ta.localeCompare(tb);
    });

    const batches = chunk(entriesWithTags, SYNTHESIS_BATCH_SIZE);
    let done = 0;

    // Emit 0/N so the frontend exits "Starting…" immediately.
    this._emitDreamProgress('synthesis', 0, batches.length,
      this._hashFromOptions(runOptions));

    for (const batch of batches) {
      try {
        const hasExisting = db.listTopicSummaries().length > 0;
        const prompt = buildFullRebuildPrompt(batch, done + 1, batches.length, hasExisting);
        const output = await this._runCliWithRetry(adapter, prompt, runOptions);
        if (output) {
          const { operations, warnings } = parseDreamOutput(output);
          if (warnings.length > 0) result.errors.push(...warnings);
          const applyWarnings = applyOperations(db, operations);
          if (applyWarnings.length > 0) result.errors.push(...applyWarnings);
          db.clearNeedsSynthesis(batch.map((e) => e.entryId));
          result.processedEntries += batch.length;
          // Refresh all-topics.txt for subsequent batches.
          generateDreamTmpFiles(db, knowledgeDir);
        }
      } catch (err) {
        result.skippedBatches++;
        result.errors.push(`Rebuild batch ${done + 1}/${batches.length} failed: ${(err as Error).message}`);
      }
      done++;
      this._emitDreamProgress('synthesis', done, batches.length,
        this._hashFromOptions(runOptions));
    }
  }

  // ── CLI helpers ───────────────────────────────────────────────────────────

  private async _runCliWithRetry(
    adapter: BaseBackendAdapter,
    prompt: string,
    options: RunOneShotOptions,
  ): Promise<string | null> {
    try {
      return await adapter.runOneShot(prompt, options);
    } catch (err) {
      // Retry once.
      try {
        return await adapter.runOneShot(prompt, options);
      } catch (retryErr) {
        throw retryErr;
      }
    }
  }

  private _getAdapter(settings: Settings): BaseBackendAdapter {
    const backendId = settings.knowledgeBase?.dreamingCliBackend;
    if (!backendId) {
      throw new Error(
        'No Dreaming CLI backend configured. Set a backend in Knowledge Base settings.',
      );
    }
    const adapter = this.backendRegistry.get(backendId);
    if (!adapter) {
      throw new Error(`Dreaming CLI backend "${backendId}" is not registered.`);
    }
    return adapter;
  }

  private _buildRunOptions(hash: string, settings: Settings): RunOneShotOptions {
    const kb = settings.knowledgeBase;
    const knowledgeDir = this.chatService.getKbKnowledgeDir(hash);
    return {
      model: kb?.dreamingCliModel ?? undefined,
      effort: kb?.dreamingCliEffort ?? undefined,
      timeoutMs: DREAM_TIMEOUT_MS,
      workingDir: knowledgeDir,
      allowTools: true,
      // Stash the hash in a way we can retrieve it later.
      _workspaceHash: hash,
    } as RunOneShotOptions & { _workspaceHash: string };
  }

  private _hashFromOptions(opts: RunOneShotOptions): string {
    return (opts as RunOneShotOptions & { _workspaceHash?: string })._workspaceHash ?? '';
  }

  // ── Synthesis batch builder ───────────────────────────────────────────────

  private _buildSynthesisBatches(
    topicToEntries: Map<string, string[]>,
    entryMeta: Array<{ entryId: string; title: string; entryPath: string }>,
    topicSummaries: Array<{ topicId: string; title: string; summary: string | null }>,
  ): Array<{
    topics: Array<{ topicId: string; title: string; slug: string }>;
    entries: Array<{ entryId: string; title: string; entryPath: string }>;
  }> {
    const entryMap = new Map(entryMeta.map((e) => [e.entryId, e]));
    const topicMap = new Map(topicSummaries.map((t) => [t.topicId, t]));
    const batches: Array<{
      topics: Array<{ topicId: string; title: string; slug: string }>;
      entries: Array<{ entryId: string; title: string; entryPath: string }>;
    }> = [];

    // Group entries that share topics together.
    const processedEntries = new Set<string>();
    for (const [topicId, entryIds] of topicToEntries) {
      const unprocessed = entryIds.filter((eid) => !processedEntries.has(eid));
      if (unprocessed.length === 0) continue;

      for (const entryBatch of chunk(unprocessed, SYNTHESIS_BATCH_SIZE)) {
        const topicInfo = topicMap.get(topicId);
        batches.push({
          topics: [{
            topicId,
            title: topicInfo?.title ?? topicId,
            slug: topicId,
          }],
          entries: entryBatch
            .map((eid) => entryMap.get(eid))
            .filter((e): e is NonNullable<typeof e> => e !== undefined),
        });
        for (const eid of entryBatch) processedEntries.add(eid);
      }
    }

    return batches;
  }

  // ── Emitters ──────────────────────────────────────────────────────────────

  private _emitSynthesisChange(hash: string): void {
    this.emit?.(hash, {
      type: 'kb_state_update',
      updatedAt: new Date().toISOString(),
      changed: { synthesis: true },
    });
  }

  private _emitDreamProgress(
    phase: 'discovery' | 'synthesis',
    done: number,
    total: number,
    hash: string,
  ): void {
    this.emit?.(hash, {
      type: 'kb_state_update',
      updatedAt: new Date().toISOString(),
      changed: { synthesis: true, dreamProgress: { phase, done, total } },
    });
  }
}

// ── Discovery output parser ─────────────────────────────────────────────────

interface DiscoveryParseResult {
  matches: Array<{ entry_id: string; topic_id: string }>;
  warnings: string[];
}

function parseDiscoveryOutput(raw: string): DiscoveryParseResult {
  const warnings: string[] = [];

  // Extract JSON from possibly noisy output.
  const jsonStr = extractJsonFromOutput(raw);
  if (!jsonStr) {
    return { matches: [], warnings: ['Discovery: no JSON found in output'] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return { matches: [], warnings: [`Discovery JSON parse error: ${(err as Error).message}`] };
  }

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj?.matches)) {
    return { matches: [], warnings: ['Discovery: missing "matches" array'] };
  }

  const matches: Array<{ entry_id: string; topic_id: string }> = [];
  for (const m of obj.matches) {
    const item = m as Record<string, unknown>;
    if (typeof item?.entry_id === 'string' && typeof item?.topic_id === 'string') {
      matches.push({ entry_id: item.entry_id, topic_id: item.topic_id });
    } else {
      warnings.push('Discovery: skipping match with missing entry_id or topic_id');
    }
  }

  return { matches, warnings };
}

function extractJsonFromOutput(raw: string): string | null {
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith('{')) return inner;
  }
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (raw[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

// ── Utilities ───────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
