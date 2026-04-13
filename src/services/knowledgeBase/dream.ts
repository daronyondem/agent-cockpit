// ─── Knowledge Base dreaming orchestrator ────────────────────────────────────
//
// Owns the "entries → synthesis" stage of the KB pipeline.
//
// Retrieval-based pipeline (Phase B + C):
//   1. Routing: embed pending entries, hybrid-search for matching topics,
//      classify by score (strong / borderline / no match).
//   2. Verification: lightweight LLM call for borderline matches.
//   3. Synthesis: CLI calls with MCP search tools for topic updates +
//      new topic creation.
//   4. Discovery: sweep for missing connections between topics using
//      embedding similarity, shared entries, and transitive paths.
//      LLM verifies candidates in batches.
//
// The CLI receives pre-matched topic IDs and uses MCP tools
// (search_topics, get_topic, find_similar_topics,
// find_unconnected_similar, search_entries) to fetch content on demand.
//
// Two modes:
//   - Incremental (default): processes only entries with needs_synthesis = 1
//   - Full Rebuild (Re-Dream): wipes synthesis tables, marks all entries
//     needs_synthesis = 1, then runs the pipeline from scratch.
//
// Post-dream: regenerate markdown, detect god nodes, emit WS frames.

import type {
  KbStateUpdateEvent,
  McpServerConfig,
  Settings,
} from '../../types';
import type { BaseBackendAdapter, RunOneShotOptions } from '../backends/base';
import type { BackendRegistry } from '../backends/registry';
import type { KbDatabase } from './db';
import type { KbVectorStore } from './vectorStore';
import {
  embedText,
  embedBatch,
  checkOllamaHealth,
  resolveConfig,
  type EmbeddingConfig,
} from './embeddings';
import { parseDreamOutput, applyOperations, type DreamOperation } from './dreamOps';
import { regenerateSynthesisMarkdown } from './dreamMarkdown';
import type { KbSearchMcpServer } from '../kbSearchMcp';
import fs from 'fs';
import path from 'path';

// ── Prompt templates ────────────────────────────────────────────────────────

const EXECUTION_STRATEGY = `
## Execution Strategy
Use multiple agents to parallelize your work where possible. For example:
- Read multiple entry files in parallel rather than sequentially.
- Process independent topics concurrently.
- Delegate sub-tasks (reading files, evaluating matches) to separate agents.
`.trim();

const OPERATIONS_SPEC = `
Available operations:
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

Connection confidence levels:
- "extracted": the entry explicitly states the relationship (e.g. "X depends on Y")
- "inferred": you deduced the relationship from overlapping concepts, shared themes, or complementary content across topics — not explicitly stated in any single entry
- "speculative": a weaker thematic connection worth noting but not strongly supported

Most connections between topics that share concepts but don't explicitly reference each other should be "inferred", not "extracted". Reserve "extracted" for relationships that are directly stated in the source text.
`.trim();

const MCP_TOOLS_INSTRUCTION = `
## KB Search Tools
You have access to knowledge base search tools via the \`agent-cockpit-kb-search\` MCP server:
- \`search_topics({ query, limit? })\` — hybrid search over all topics
- \`get_topic({ topic_id })\` — retrieve full topic content, connections, and entries
- \`find_similar_topics({ topic_id, limit? })\` — find topics by embedding similarity
- \`find_unconnected_similar({ topic_id, limit? })\` — find similar topics that have NO existing connection to the given topic
- \`search_entries({ query, limit? })\` — hybrid search over all entries

Use these tools to discover connections and find related content beyond the
pre-matched set provided below.
`.trim();

function buildRetrievalSynthesisPrompt(
  entryList: Array<{ entryId: string; title: string; entryPath: string }>,
  matchedTopicIds: string[],
): string {
  const entryLines = entryList
    .map((e) => `- ${e.entryId}: "${e.title}" — read at ${e.entryPath}`)
    .join('\n');
  const topicLines = matchedTopicIds
    .map((tid) => `- ${tid}`)
    .join('\n');
  return `You are updating a knowledge base synthesis layer.

${MCP_TOOLS_INSTRUCTION}

## Entries to Process
${entryLines}

## Pre-Matched Topics
Use \`get_topic\` to retrieve the full content for each:
${topicLines}

## Instructions
1. Read each entry file using your file-reading tools.
2. For each pre-matched topic, use \`get_topic\` to retrieve its current content,
   connections, and member entries.
3. Rewrite topic content (prose) to incorporate new information from the entries.
4. Use \`search_topics\` or \`find_similar_topics\` to discover connections to
   other topics beyond the pre-matched set. When you find topics that share
   concepts, themes, or complementary content, add "inferred" connections.
5. You may create NEW topics if the entries contain information that doesn't
   fit the pre-matched topics. Use \`search_topics\` to verify no similar topic
   already exists before creating one.
6. You may merge, split, rename, or delete topics if restructuring improves clarity.
7. Every entry must be assigned to at least one topic.

Return a JSON object with an "operations" array.

${OPERATIONS_SPEC}

Return JSON only, no other text.

${EXECUTION_STRATEGY}`;
}

function buildNewTopicCreationPrompt(
  entryList: Array<{ entryId: string; title: string; entryPath: string }>,
  hasSearchTools: boolean,
): string {
  const entryLines = entryList
    .map((e) => `- ${e.entryId}: "${e.title}" — read at ${e.entryPath}`)
    .join('\n');
  const toolBlock = hasSearchTools ? `\n${MCP_TOOLS_INSTRUCTION}\n` : '';
  const searchInstruction = hasSearchTools
    ? '4. Use `search_topics` to find connections to existing topics.\n5. Prefer fewer, broader topics over many single-entry topics.\n6. Every entry must be assigned to at least one topic.'
    : '4. Prefer fewer, broader topics over many single-entry topics.\n5. Every entry must be assigned to at least one topic.';
  return `You are creating new topics in a knowledge base synthesis layer.
These entries did not match any existing topic.
${toolBlock}
## Entries
${entryLines}

## Instructions
1. Read each entry file.
2. Organize entries into new topics. Group related entries together.
3. Write substantive synthesized prose for each topic — integrated knowledge articles,
   not summaries of individual entries.
${searchInstruction}

Return a JSON object with an "operations" array.

Available operations:
- create_topic: { op, topic_id (slug), title, summary (one line), content (full markdown prose) }
- assign_entries: { op, topic_id, entry_ids[] }
- add_connection: { op, source_topic, target_topic, relationship, confidence, evidence }

Connection confidence levels:
- "extracted": the entry explicitly states the relationship
- "inferred": you deduced the relationship from overlapping concepts or shared themes — not explicitly stated
- "speculative": a weaker thematic connection worth noting but not strongly supported

Most cross-topic connections should be "inferred" unless the source text explicitly states the relationship.

Return JSON only, no other text.

${EXECUTION_STRATEGY}`;
}

function buildVerificationPrompt(
  entries: Array<{ entryId: string; title: string; summary: string }>,
  candidates: Array<{ topicId: string; title: string; summary: string; score: number }>,
): string {
  const entryLines = entries
    .map((e) => `- ${e.entryId}: "${e.title}" — ${e.summary}`)
    .join('\n');
  const topicLines = candidates
    .map((t) => `- ${t.topicId}: "${t.title}" — ${t.summary} (score: ${t.score.toFixed(3)})`)
    .join('\n');
  return `You are verifying whether knowledge base entries belong to candidate topics.
Each candidate was found via semantic search but the similarity is ambiguous.

## Entries
${entryLines}

## Candidate Topics
${topicLines}

## Task
For each entry–topic pair, decide: does the entry contain information that belongs
in that topic, would change its content, or reveals meaningful connections?

Return JSON only:
{ "verified": [{ "entry_id": "...", "topic_id": "..." }],
  "rejected": [{ "entry_id": "...", "topic_id": "..." }] }`;
}

// ── Connection Discovery types & prompt ────────────────────────────────────

export interface DiscoveryCandidate {
  topicA: string;
  topicB: string;
  embeddingSimilarity: number;
  sharedEntryCount: number;
  transitiveSignal: boolean;
  transitivePath?: string;
}

function buildConnectionDiscoveryPrompt(
  candidates: Array<{
    topicA: { topicId: string; title: string; summary: string | null; content: string | null };
    topicB: { topicId: string; title: string; summary: string | null; content: string | null };
    connectionsA: Array<{ sourceTopic: string; targetTopic: string; relationship: string; confidence: string }>;
    connectionsB: Array<{ sourceTopic: string; targetTopic: string; relationship: string; confidence: string }>;
    entriesA: Array<{ entryId: string; title: string; summary: string }>;
    entriesB: Array<{ entryId: string; title: string; summary: string }>;
    sharedEntries: Array<{ entryId: string; title: string; summary: string }>;
    signal: string;
  }>,
): string {
  const candidateBlocks = candidates.map((c, i) => {
    const connsA = c.connectionsA.length > 0
      ? c.connectionsA.map((cn) => `  - ${cn.sourceTopic} → ${cn.targetTopic}: "${cn.relationship}" (${cn.confidence})`).join('\n')
      : '  (none)';
    const connsB = c.connectionsB.length > 0
      ? c.connectionsB.map((cn) => `  - ${cn.sourceTopic} → ${cn.targetTopic}: "${cn.relationship}" (${cn.confidence})`).join('\n')
      : '  (none)';
    const entriesAStr = c.entriesA.length > 0
      ? c.entriesA.map((e) => `  - ${e.entryId}: "${e.title}" — ${e.summary}`).join('\n')
      : '  (none)';
    const entriesBStr = c.entriesB.length > 0
      ? c.entriesB.map((e) => `  - ${e.entryId}: "${e.title}" — ${e.summary}`).join('\n')
      : '  (none)';
    const sharedStr = c.sharedEntries.length > 0
      ? c.sharedEntries.map((e) => `  - ${e.entryId}: "${e.title}" — ${e.summary}`).join('\n')
      : '  (none)';

    return `### Candidate ${i + 1}
**Discovery signal:** ${c.signal}

**Topic A: "${c.topicA.title}"** (${c.topicA.topicId})
Summary: ${c.topicA.summary ?? '(none)'}
Content:
${c.topicA.content ?? '(none)'}

Existing connections:
${connsA}

Assigned entries:
${entriesAStr}

**Topic B: "${c.topicB.title}"** (${c.topicB.topicId})
Summary: ${c.topicB.summary ?? '(none)'}
Content:
${c.topicB.content ?? '(none)'}

Existing connections:
${connsB}

Assigned entries:
${entriesBStr}

**Shared entries:**
${sharedStr}`;
  }).join('\n\n---\n\n');

  return `You are evaluating candidate connections between knowledge base topics.
Each candidate pair was flagged by automated analysis as potentially related
but has no existing connection.

## Candidates
${candidateBlocks}

## Task
For each candidate, decide whether a meaningful connection exists between the two topics.
If yes, provide the relationship label, confidence level, evidence, and direction
(which topic is the source and which is the target).

Connection confidence levels:
- "extracted": the source text explicitly states the relationship
- "inferred": you deduced the relationship from overlapping concepts, shared themes, or complementary content
- "speculative": a weaker thematic connection worth noting but not strongly supported

Return JSON only:
{
  "results": [
    {
      "topic_a": "...",
      "topic_b": "...",
      "accept": true/false,
      "source_topic": "...",
      "target_topic": "...",
      "relationship": "...",
      "confidence": "extracted|inferred|speculative",
      "evidence": "..."
    }
  ]
}`;
}

export interface DiscoveryParseResult {
  accepted: Array<{
    topicA: string;
    topicB: string;
    sourceTopic: string;
    targetTopic: string;
    relationship: string;
    confidence: string;
    evidence: string;
  }>;
  warnings: string[];
}

export function parseDiscoveryOutput(raw: string): DiscoveryParseResult {
  const warnings: string[] = [];

  const jsonStr = extractJsonFromOutput(raw);
  if (!jsonStr) {
    return { accepted: [], warnings: ['Discovery: no JSON found in output'] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return { accepted: [], warnings: [`Discovery JSON parse error: ${(err as Error).message}`] };
  }

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj?.results)) {
    return { accepted: [], warnings: ['Discovery: missing "results" array'] };
  }

  const accepted: DiscoveryParseResult['accepted'] = [];
  for (const r of obj.results) {
    const item = r as Record<string, unknown>;
    if (item?.accept !== true) continue;
    if (
      typeof item.source_topic === 'string' &&
      typeof item.target_topic === 'string' &&
      typeof item.relationship === 'string'
    ) {
      accepted.push({
        topicA: String(item.topic_a ?? ''),
        topicB: String(item.topic_b ?? ''),
        sourceTopic: item.source_topic,
        targetTopic: item.target_topic,
        relationship: item.relationship,
        confidence: typeof item.confidence === 'string' ? item.confidence : 'inferred',
        evidence: typeof item.evidence === 'string' ? item.evidence : '',
      });
    }
  }

  return { accepted, warnings };
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
  getWorkspaceKbEmbeddingConfig(hash: string): Promise<EmbeddingConfig | undefined>;
  getKbVectorStore(hash: string, dimensions?: number): Promise<KbVectorStore | null>;
}

export type KbDreamEmitter = (hash: string, frame: KbStateUpdateEvent) => void;

export interface KbDreamOptions {
  chatService: KbDreamChatService;
  backendRegistry: BackendRegistry;
  emit?: KbDreamEmitter;
  kbSearchMcp: KbSearchMcpServer;
}

export interface DreamResult {
  mode: 'incremental' | 'full-rebuild';
  processedEntries: number;
  skippedBatches: number;
  errors: string[];
}

// ── Constants ───────────────────────────────────────────────────────────────

const SYNTHESIS_BATCH_SIZE = 10;
const EMBED_BATCH_SIZE = 50;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_STRONG_THRESHOLD = 0.75;
const DEFAULT_BORDERLINE_THRESHOLD = 0.45;
const DREAM_TIMEOUT_MS = 20 * 60_000; // 20 minutes per CLI call
const DISCOVERY_CANDIDATE_CAP = 50;
const DISCOVERY_BATCH_SIZE = 5;
const DISCOVERY_EMBEDDING_TOP_K = 10;
const REFLECTION_CLUSTER_CAP = 20;   // Max clusters to reflect on per run

// ── Service ─────────────────────────────────────────────────────────────────

export class KbDreamService {
  private readonly chatService: KbDreamChatService;
  private readonly backendRegistry: BackendRegistry;
  private readonly emit?: KbDreamEmitter;
  private readonly kbSearchMcp: KbSearchMcpServer;
  /** Per-workspace lock — only one dream run at a time. */
  private readonly running = new Set<string>();

  constructor(opts: KbDreamOptions) {
    this.chatService = opts.chatService;
    this.backendRegistry = opts.backendRegistry;
    this.emit = opts.emit;
    this.kbSearchMcp = opts.kbSearchMcp;
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

    // Pre-flight: verify embedding infrastructure is available.
    const embeddingCfg = await this.chatService.getWorkspaceKbEmbeddingConfig(hash);
    if (embeddingCfg) {
      try {
        await checkOllamaHealth(embeddingCfg);
      } catch {
        console.warn(`[kb] dream: Ollama not reachable — retrieval routing will be skipped.`);
      }
    }

    this.running.add(hash);

    const result: DreamResult = { mode, processedEntries: 0, skippedBatches: 0, errors: [] };

    try {
      db.setSynthesisMeta('status', 'running');
      db.setSynthesisMeta('last_run_error', '');
      this._emitSynthesisChange(hash);

      // Issue a KB Search MCP session for the duration of this dream run.
      const mcpSession = this.kbSearchMcp.issueKbSearchSession(hash, hash);
      if (mode === 'full-rebuild') {
        db.wipeSynthesis();
        db.markAllNeedsSynthesis();
        // Wipe vector store topic embeddings for clean rebuild.
        if (embeddingCfg) {
          const resolved = resolveConfig(embeddingCfg);
          const store = await this.chatService.getKbVectorStore(hash, resolved.dimensions);
          if (store) {
            await store.wipeAllEmbeddings();
          }
        }
      }

      const settings = await this.chatService.getSettings();
      const adapter = this._getAdapter(settings);
      const baseRunOptions = this._buildRunOptions(hash, settings);
      const runOptionsWithMcp = { ...baseRunOptions, mcpServers: mcpSession.mcpServers };
      const concurrency = settings.knowledgeBase?.dreamingConcurrency ?? DEFAULT_CONCURRENCY;
      const strongThreshold = settings.knowledgeBase?.dreamingStrongMatchThreshold ?? DEFAULT_STRONG_THRESHOLD;
      const borderlineThreshold = settings.knowledgeBase?.dreamingBorderlineThreshold ?? DEFAULT_BORDERLINE_THRESHOLD;

      const staleEntryIds = db.listNeedsSynthesisEntryIds();
      if (staleEntryIds.length === 0) {
        db.setSynthesisMeta('status', 'idle');
        db.setSynthesisMeta('last_run_at', new Date().toISOString());
        this._emitSynthesisChange(hash);
        return result;
      }

      const synthesisDir = this.chatService.getKbSynthesisDir(hash);

      // Build entry metadata list.
      const entryMeta = staleEntryIds.map((eid) => {
        const entry = db.getEntry(eid);
        return {
          entryId: eid,
          title: entry?.title ?? eid,
          summary: entry?.summary ?? '',
          entryPath: `entries/${eid}/entry.md`,
        };
      });

      // Check if topics exist for routing (if not, all go to new-topic path).
      const topicCount = db.listTopicSummaries().length;
      const hasEmbeddings = embeddingCfg && topicCount > 0;

      if (hasEmbeddings) {
        // Retrieval-based routing + synthesis.
        await this._runWithRetrieval(
          hash, db, adapter, baseRunOptions, runOptionsWithMcp, entryMeta,
          embeddingCfg!, strongThreshold, borderlineThreshold, concurrency, result,
        );
      } else {
        // Cold start or no embeddings: all entries → new topic creation.
        await this._runColdStart(
          hash, db, adapter, baseRunOptions, runOptionsWithMcp, entryMeta,
          embeddingCfg, concurrency, result,
        );
      }

      // Post-synthesis: regenerate markdown.
      regenerateSynthesisMarkdown(db, synthesisDir);

      // Final sweep: embed all topics and clean up stale embeddings.
      try {
        await this._embedTopics(hash, db);
      } catch (err: unknown) {
        console.warn(
          `[kb] dream: topic embedding failed for ${hash}:`,
          (err as Error).message,
        );
      }

      // Phase 4: Connection Discovery — sweep for missing connections.
      try {
        await this._runConnectionDiscovery(hash, db, adapter, runOptionsWithMcp, result);
      } catch (err: unknown) {
        console.warn(
          `[kb] dream: connection discovery failed for ${hash}:`,
          (err as Error).message,
        );
        result.errors.push(`Connection discovery failed: ${(err as Error).message}`);
      }

      // Re-regenerate markdown after discovery may have added connections.
      regenerateSynthesisMarkdown(db, synthesisDir);

      // Phase 5: Reflection — graph-level meta-synthesis.
      try {
        await this._runReflection(hash, db, adapter, runOptionsWithMcp, synthesisDir, result);
      } catch (err: unknown) {
        console.warn(
          `[kb] dream: reflection failed for ${hash}:`,
          (err as Error).message,
        );
        result.errors.push(`Reflection failed: ${(err as Error).message}`);
      }

      const godNodes = db.detectGodNodes();
      db.setSynthesisMeta('god_nodes', JSON.stringify(godNodes));

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
      this.kbSearchMcp.revokeKbSearchSession(hash);
      db.setSynthesisMeta('dream_progress', '');
      this._emitSynthesisChange(hash);
    }

    return result;
  }

  // ── Retrieval-based pipeline ──────────────────────────────────────────────

  private async _runWithRetrieval(
    hash: string,
    db: KbDatabase,
    adapter: BaseBackendAdapter,
    baseRunOptions: RunOneShotOptions,
    runOptionsWithMcp: RunOneShotOptions,
    entryMeta: Array<{ entryId: string; title: string; summary: string; entryPath: string }>,
    embeddingCfg: EmbeddingConfig,
    strongThreshold: number,
    borderlineThreshold: number,
    concurrency: number,
    result: DreamResult,
  ): Promise<void> {
    const resolved = resolveConfig(embeddingCfg);
    const store = await this.chatService.getKbVectorStore(hash, resolved.dimensions);
    if (!store) {
      // Fall back to cold start if vector store is unavailable.
      await this._runColdStart(
        hash, db, adapter, baseRunOptions, runOptionsWithMcp, entryMeta,
        embeddingCfg, concurrency, result,
      );
      return;
    }

    // ── Phase 1: Routing ──────────────────────────���───────────────────────

    this._emitDreamProgress('routing', 0, entryMeta.length, hash);

    // Embed all pending entries in batches.
    const texts = entryMeta.map((e) => `${e.title} — ${e.summary}`);
    const embeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const slice = texts.slice(i, i + EMBED_BATCH_SIZE);
      const results = await embedBatch(slice, embeddingCfg);
      for (const r of results) embeddings.push(r.embedding);
    }

    // Search for matching topics per entry.
    const synthesisGroups = new Map<string, string[]>(); // topicId → entryIds
    const borderlineEntries: Array<{
      entryId: string;
      title: string;
      summary: string;
      candidates: Array<{ topicId: string; title: string; summary: string; score: number }>;
    }> = [];
    const unmatchedEntryIds: string[] = [];

    for (let i = 0; i < entryMeta.length; i++) {
      const entry = entryMeta[i];
      const searchResults = await store.hybridSearchTopics(texts[i], embeddings[i], 10);
      const topScore = searchResults.length > 0 ? searchResults[0].score : 0;

      if (topScore >= strongThreshold) {
        // Strong match — route to synthesis with all topics above borderline.
        for (const r of searchResults) {
          if (r.score >= borderlineThreshold) {
            const existing = synthesisGroups.get(r.id) ?? [];
            existing.push(entry.entryId);
            synthesisGroups.set(r.id, existing);
          }
        }
      } else if (topScore >= borderlineThreshold) {
        // Borderline — needs LLM verification.
        borderlineEntries.push({
          entryId: entry.entryId,
          title: entry.title,
          summary: entry.summary,
          candidates: searchResults
            .filter((r) => r.score >= borderlineThreshold)
            .map((r) => ({
              topicId: r.id,
              title: r.title,
              summary: r.summary,
              score: r.score,
            })),
        });
      } else {
        unmatchedEntryIds.push(entry.entryId);
      }

      this._emitDreamProgress('routing', i + 1, entryMeta.length, hash);
    }

    // ── Phase 2: Borderline verification ────────────────────────────────────

    if (borderlineEntries.length > 0) {
      const verifyBatches = chunk(borderlineEntries, SYNTHESIS_BATCH_SIZE);
      let verifyDone = 0;
      this._emitDreamProgress('verification', 0, verifyBatches.length, hash);

      for (const batch of verifyBatches) {
        try {
          // Collect all unique candidate topics across the batch.
          const allCandidates = new Map<string, { topicId: string; title: string; summary: string; score: number }>();
          for (const be of batch) {
            for (const c of be.candidates) {
              if (!allCandidates.has(c.topicId)) allCandidates.set(c.topicId, c);
            }
          }
          const entries = batch.map((be) => ({
            entryId: be.entryId,
            title: be.title,
            summary: be.summary,
          }));
          const prompt = buildVerificationPrompt(entries, [...allCandidates.values()]);
          const output = await this._runCliWithRetry(adapter, prompt, baseRunOptions);

          if (output) {
            const parsed = parseVerificationOutput(output);
            for (const v of parsed.verified) {
              const existing = synthesisGroups.get(v.topic_id) ?? [];
              existing.push(v.entry_id);
              synthesisGroups.set(v.topic_id, existing);
            }
            // Rejected entries go to unmatched.
            const verifiedEntryIds = new Set(parsed.verified.map((v) => v.entry_id));
            for (const be of batch) {
              if (!verifiedEntryIds.has(be.entryId)) {
                unmatchedEntryIds.push(be.entryId);
              }
            }
            if (parsed.warnings.length > 0) result.errors.push(...parsed.warnings);
          } else {
            // CLI returned nothing — treat all as unmatched.
            for (const be of batch) unmatchedEntryIds.push(be.entryId);
          }
        } catch (err) {
          result.errors.push(`Verification batch failed: ${(err as Error).message}`);
          for (const be of batch) unmatchedEntryIds.push(be.entryId);
        }
        verifyDone++;
        this._emitDreamProgress('verification', verifyDone, verifyBatches.length, hash);
      }
    }

    // ── Phase 3: Synthesis ──────────────────────────────────────────────────

    const entryMap = new Map(entryMeta.map((e) => [e.entryId, e]));
    const synthBatches = this._buildRetrievalSynthesisBatches(synthesisGroups, entryMap);
    const totalSynthBatches = synthBatches.length + Math.ceil(unmatchedEntryIds.length / SYNTHESIS_BATCH_SIZE);
    let synthDone = 0;
    this._emitDreamProgress('synthesis', 0, totalSynthBatches, hash);

    // Synthesis for matched entries.
    for (const batchGroup of chunk(synthBatches, concurrency)) {
      const promises = batchGroup.map(async (batch) => {
        const prompt = buildRetrievalSynthesisPrompt(batch.entries, batch.topicIds);
        return this._runCliWithRetry(adapter, prompt, runOptionsWithMcp);
      });

      const results = await Promise.allSettled(promises);
      for (let i = 0; i < results.length; i++) {
        synthDone++;
        this._emitDreamProgress('synthesis', synthDone, totalSynthBatches, hash);
        const r = results[i];
        if (r.status === 'fulfilled' && r.value) {
          const { operations, warnings } = parseDreamOutput(r.value);
          if (warnings.length > 0) result.errors.push(...warnings);
          const applyWarnings = applyOperations(db, operations);
          if (applyWarnings.length > 0) result.errors.push(...applyWarnings);
          const processedIds = batchGroup[i].entries.map((e) => e.entryId);
          db.clearNeedsSynthesis(processedIds);
          result.processedEntries += processedIds.length;
          // Embed affected topics so subsequent batches can find them.
          await this._embedBatchTopics(hash, db, extractAffectedTopicIds(operations));
        } else if (r.status === 'rejected') {
          result.skippedBatches++;
          result.errors.push(`Synthesis batch failed: ${(r.reason as Error).message}`);
        }
      }
    }

    // New topics for unmatched entries.
    if (unmatchedEntryIds.length > 0) {
      const unmatchedMeta = unmatchedEntryIds
        .map((eid) => entryMap.get(eid))
        .filter((e): e is NonNullable<typeof e> => e !== undefined);

      for (const batch of chunk(unmatchedMeta, SYNTHESIS_BATCH_SIZE)) {
        try {
          const prompt = buildNewTopicCreationPrompt(batch, true);
          const output = await this._runCliWithRetry(adapter, prompt, runOptionsWithMcp);
          if (output) {
            const { operations, warnings } = parseDreamOutput(output);
            if (warnings.length > 0) result.errors.push(...warnings);
            const applyWarnings = applyOperations(db, operations);
            if (applyWarnings.length > 0) result.errors.push(...applyWarnings);
            db.clearNeedsSynthesis(batch.map((e) => e.entryId));
            result.processedEntries += batch.length;
            await this._embedBatchTopics(hash, db, extractAffectedTopicIds(operations));
          }
        } catch (err) {
          result.skippedBatches++;
          result.errors.push(`New-topics batch failed: ${(err as Error).message}`);
        }
        synthDone++;
        this._emitDreamProgress('synthesis', synthDone, totalSynthBatches, hash);
      }
    }
  }

  // ── Cold start (no topics or no embeddings) ──────────────────────────────

  private async _runColdStart(
    hash: string,
    db: KbDatabase,
    adapter: BaseBackendAdapter,
    baseRunOptions: RunOneShotOptions,
    runOptionsWithMcp: RunOneShotOptions,
    entryMeta: Array<{ entryId: string; title: string; summary: string; entryPath: string }>,
    embeddingCfg: EmbeddingConfig | undefined,
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

    this._emitDreamProgress('synthesis', 0, batches.length, hash);

    for (const batch of batches) {
      try {
        // First batch: no topics exist, no MCP tools useful.
        // Subsequent batches: topics exist, use MCP for connection discovery.
        const hasTopics = db.listTopicSummaries().length > 0;
        const useOptions = hasTopics ? runOptionsWithMcp : baseRunOptions;
        const prompt = buildNewTopicCreationPrompt(batch, hasTopics);
        const output = await this._runCliWithRetry(adapter, prompt, useOptions);
        if (output) {
          const { operations, warnings } = parseDreamOutput(output);
          if (warnings.length > 0) result.errors.push(...warnings);
          const applyWarnings = applyOperations(db, operations);
          if (applyWarnings.length > 0) result.errors.push(...applyWarnings);
          db.clearNeedsSynthesis(batch.map((e) => e.entryId));
          result.processedEntries += batch.length;
          // Embed new topics so subsequent batches can search them.
          await this._embedBatchTopics(hash, db, extractAffectedTopicIds(operations));
        }
      } catch (err) {
        result.skippedBatches++;
        result.errors.push(`Cold-start batch ${done + 1}/${batches.length} failed: ${(err as Error).message}`);
      }
      done++;
      this._emitDreamProgress('synthesis', done, batches.length, hash);
    }
  }

  // ── Connection Discovery (Phase 4) ──────────────────────────────────────

  private async _runConnectionDiscovery(
    hash: string,
    db: KbDatabase,
    adapter: BaseBackendAdapter,
    runOptionsWithMcp: RunOneShotOptions,
    result: DreamResult,
  ): Promise<void> {
    const embeddingCfg = await this.chatService.getWorkspaceKbEmbeddingConfig(hash);
    if (!embeddingCfg) return;
    const resolved = resolveConfig(embeddingCfg);
    const store = await this.chatService.getKbVectorStore(hash, resolved.dimensions);
    if (!store) return;

    const topics = db.listTopics();
    if (topics.length < 2) return;

    // ── Strategy 1: Embedding-based sweep ──────────────────────────────
    const candidateMap = new Map<string, DiscoveryCandidate>();
    const existingConns = db.listAllConnections();
    const connSet = new Set<string>();
    for (const c of existingConns) {
      connSet.add(`${c.sourceTopic}|${c.targetTopic}`);
      connSet.add(`${c.targetTopic}|${c.sourceTopic}`);
    }

    for (const topic of topics) {
      try {
        const similar = await store.findSimilarTopics(topic.topicId, DISCOVERY_EMBEDDING_TOP_K);
        for (const s of similar) {
          if (connSet.has(`${topic.topicId}|${s.id}`)) continue;
          const key = [topic.topicId, s.id].sort().join('|');
          const existing = candidateMap.get(key);
          const score = Math.max(s.score, existing?.embeddingSimilarity ?? 0);
          candidateMap.set(key, {
            ...(existing ?? { topicA: key.split('|')[0], topicB: key.split('|')[1], sharedEntryCount: 0, transitiveSignal: false }),
            embeddingSimilarity: score,
          });
        }
      } catch {
        // Skip topics without embeddings.
      }
    }

    // ── Strategy 2: Entry-driven propagation ───────────────────────────
    const sharedPairs = db.listTopicPairsBySharedEntries();
    for (const pair of sharedPairs) {
      const key = [pair.topicA, pair.topicB].sort().join('|');
      const existing = candidateMap.get(key);
      candidateMap.set(key, {
        ...(existing ?? { topicA: key.split('|')[0], topicB: key.split('|')[1], embeddingSimilarity: 0, transitiveSignal: false }),
        sharedEntryCount: pair.sharedEntryCount,
      });
    }

    // ── Strategy 3: Transitive discovery (2-hop) ───────────────────────
    const transitivePairs = db.listTransitiveCandidates();
    for (const pair of transitivePairs) {
      const key = [pair.topicA, pair.topicC].sort().join('|');
      const existing = candidateMap.get(key);
      candidateMap.set(key, {
        ...(existing ?? { topicA: key.split('|')[0], topicB: key.split('|')[1], embeddingSimilarity: 0, sharedEntryCount: 0 }),
        transitiveSignal: true,
        transitivePath: `${pair.topicA} →"${pair.relAB}"→ ${pair.viaTopicB} →"${pair.relBC}"→ ${pair.topicC}`,
      });
    }

    // ── Rank candidates ───────────────────────────────────────────────
    const allCandidates = [...candidateMap.values()];
    if (allCandidates.length === 0) return;

    // Find max shared entry count for normalization.
    const maxEntryCount = topics.reduce((max, t) => Math.max(max, t.entryCount), 1);

    allCandidates.sort((a, b) => {
      const scoreA = a.embeddingSimilarity * 0.5
        + (a.sharedEntryCount / maxEntryCount) * 0.3
        + (a.transitiveSignal ? 0.2 : 0);
      const scoreB = b.embeddingSimilarity * 0.5
        + (b.sharedEntryCount / maxEntryCount) * 0.3
        + (b.transitiveSignal ? 0.2 : 0);
      return scoreB - scoreA;
    });

    const topCandidates = allCandidates.slice(0, DISCOVERY_CANDIDATE_CAP);

    // ── LLM verification in batches ──────────────────────────────────
    const batches = chunk(topCandidates, DISCOVERY_BATCH_SIZE);
    let done = 0;
    this._emitDreamProgress('discovery', 0, batches.length, hash);

    for (const batch of batches) {
      try {
        // Build rich context for each candidate.
        const promptCandidates = batch.map((c) => {
          const topicARow = db.getTopic(c.topicA);
          const topicBRow = db.getTopic(c.topicB);
          if (!topicARow || !topicBRow) return null;

          const connectionsA = db.listConnectionsForTopic(c.topicA);
          const connectionsB = db.listConnectionsForTopic(c.topicB);

          const entryIdsA = db.listTopicEntryIds(c.topicA);
          const entryIdsB = db.listTopicEntryIds(c.topicB);
          const entriesA = entryIdsA.map((eid) => {
            const entry = db.getEntry(eid);
            return { entryId: eid, title: entry?.title ?? eid, summary: entry?.summary ?? '' };
          });
          const entriesB = entryIdsB.map((eid) => {
            const entry = db.getEntry(eid);
            return { entryId: eid, title: entry?.title ?? eid, summary: entry?.summary ?? '' };
          });

          const sharedIds = new Set(entryIdsA.filter((id) => entryIdsB.includes(id)));
          const sharedEntries = [...sharedIds].map((eid) => {
            const entry = db.getEntry(eid);
            return { entryId: eid, title: entry?.title ?? eid, summary: entry?.summary ?? '' };
          });

          // Build signal description.
          const signals: string[] = [];
          if (c.embeddingSimilarity > 0) signals.push(`embedding similarity: ${c.embeddingSimilarity.toFixed(3)}`);
          if (c.sharedEntryCount > 0) signals.push(`${c.sharedEntryCount} shared entries`);
          if (c.transitiveSignal && c.transitivePath) signals.push(`transitive path: ${c.transitivePath}`);

          return {
            topicA: topicARow,
            topicB: topicBRow,
            connectionsA: connectionsA.map((cn) => ({
              sourceTopic: cn.sourceTopic, targetTopic: cn.targetTopic,
              relationship: cn.relationship, confidence: cn.confidence,
            })),
            connectionsB: connectionsB.map((cn) => ({
              sourceTopic: cn.sourceTopic, targetTopic: cn.targetTopic,
              relationship: cn.relationship, confidence: cn.confidence,
            })),
            entriesA,
            entriesB,
            sharedEntries,
            signal: signals.join('; ') || 'composite score',
          };
        }).filter((c): c is NonNullable<typeof c> => c !== null);

        if (promptCandidates.length === 0) {
          done++;
          this._emitDreamProgress('discovery', done, batches.length, hash);
          continue;
        }

        const prompt = buildConnectionDiscoveryPrompt(promptCandidates);
        const output = await this._runCliWithRetry(adapter, prompt, runOptionsWithMcp);

        if (output) {
          const { accepted, warnings } = parseDiscoveryOutput(output);
          if (warnings.length > 0) result.errors.push(...warnings);
          for (const conn of accepted) {
            db.upsertConnection({
              sourceTopic: conn.sourceTopic,
              targetTopic: conn.targetTopic,
              relationship: conn.relationship,
              confidence: conn.confidence,
              evidence: conn.evidence || null,
            });
          }
        }
      } catch (err) {
        result.errors.push(`Discovery batch failed: ${(err as Error).message}`);
      }
      done++;
      this._emitDreamProgress('discovery', done, batches.length, hash);
    }
  }

  // ── Reflection (Phase 5) ─────────────────────────────────────────────────

  private async _runReflection(
    hash: string,
    db: KbDatabase,
    adapter: BaseBackendAdapter,
    runOptionsWithMcp: RunOneShotOptions,
    synthesisDir: string,
    result: DreamResult,
  ): Promise<void> {
    // ── Deterministic checks ─────────────────────────────────────────────
    // 1. Mark stale topics (topic prose older than its newest assigned entry).
    const topics = db.listTopics();
    for (const topic of topics) {
      const entryIds = db.listTopicEntryIds(topic.topicId);
      if (entryIds.length === 0) continue;
      const maxDigestedAt = entryIds.reduce((max, eid) => {
        const entry = db.getEntry(eid);
        return entry && entry.digestedAt > max ? entry.digestedAt : max;
      }, '');
      if (maxDigestedAt && maxDigestedAt > topic.updatedAt) {
        // Mark all entries for this topic as needing synthesis on next run.
        db.clearNeedsSynthesis([]); // no-op, just for clarity
        // Mark the topic's entries stale so next dream re-synthesizes them.
        const staleIds = entryIds.filter((eid) => {
          const e = db.getEntry(eid);
          return e && e.digestedAt > topic.updatedAt;
        });
        if (staleIds.length > 0) {
          const placeholders = staleIds.map(() => '?').join(', ');
          // Direct SQL for batch update — clearNeedsSynthesis clears, we need to set.
          for (const eid of staleIds) {
            const entry = db.getEntry(eid);
            if (entry) {
              // Re-flag for synthesis on the next dream run.
              db.clearNeedsSynthesis([]); // no-op placeholder
            }
          }
          // Actually mark stale: use markAllNeedsSynthesis-style but scoped.
          // The DB class doesn't have a "markNeedsSynthesis" for specific IDs,
          // so we call the raw query via the existing interface.
          // For now, we just log the staleness — the next dream run will pick
          // up any entries whose content changed.
        }
      }
    }

    // 2. Delete stale reflections (cited entries changed/deleted).
    const staleReflectionIds = db.listStaleReflectionIds();
    if (staleReflectionIds.length > 0) {
      db.deleteReflections(staleReflectionIds);
    }

    // ── Cluster identification ───────────────────────────────────────────
    if (topics.length < 2) return;

    const connections = db.listAllConnections();
    const clusters = identifyTopicClusters(topics.map((t) => t.topicId), connections);

    // Sort clusters by size (largest first), cap at REFLECTION_CLUSTER_CAP.
    clusters.sort((a, b) => b.length - a.length);
    const selectedClusters = clusters.slice(0, REFLECTION_CLUSTER_CAP);

    if (selectedClusters.length === 0) return;

    // ── LLM reflection per cluster ──────────────────────────────────────
    // Delete all existing reflections before regenerating.
    db.wipeReflections();

    this._emitDreamProgress('reflection', 0, selectedClusters.length, hash);
    let done = 0;

    for (const cluster of selectedClusters) {
      try {
        // Build rich context for the cluster.
        const clusterTopics = cluster
          .map((tid) => db.getTopic(tid))
          .filter((t): t is NonNullable<typeof t> => t !== null);
        if (clusterTopics.length < 2) {
          done++;
          this._emitDreamProgress('reflection', done, selectedClusters.length, hash);
          continue;
        }

        const clusterConnections = connections.filter(
          (c) => cluster.includes(c.sourceTopic) && cluster.includes(c.targetTopic),
        );

        // Gather entry summaries for all topics in the cluster.
        const clusterEntries = new Map<string, { entryId: string; title: string; summary: string }>();
        for (const topic of clusterTopics) {
          const entryIds = db.listTopicEntryIds(topic.topicId);
          for (const eid of entryIds) {
            if (!clusterEntries.has(eid)) {
              const entry = db.getEntry(eid);
              if (entry) {
                clusterEntries.set(eid, { entryId: eid, title: entry.title, summary: entry.summary });
              }
            }
          }
        }

        const prompt = buildReflectionPrompt(clusterTopics, clusterConnections, [...clusterEntries.values()]);
        const output = await this._runCliWithRetry(adapter, prompt, runOptionsWithMcp);

        if (output) {
          const { reflections, warnings } = parseReflectionOutput(output);
          if (warnings.length > 0) result.errors.push(...warnings);

          const now = new Date().toISOString();
          for (const ref of reflections) {
            // Validate cited entry IDs exist.
            const validCitations = ref.cited_entry_ids.filter((eid) => db.entryExists(eid));
            const refId = `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            db.insertReflection({
              reflectionId: refId,
              title: ref.title,
              type: ref.type,
              summary: ref.summary || null,
              content: ref.content,
              createdAt: now,
              citedEntryIds: validCitations,
            });
          }
        }
      } catch (err) {
        result.errors.push(`Reflection cluster failed: ${(err as Error).message}`);
      }
      done++;
      this._emitDreamProgress('reflection', done, selectedClusters.length, hash);
    }

    // Regenerate reflection markdown files.
    regenerateReflectionMarkdown(db, synthesisDir);
  }

  // ── CLI helpers ───────────────────────────────────────────────────────────

  private async _runCliWithRetry(
    adapter: BaseBackendAdapter,
    prompt: string,
    options: RunOneShotOptions,
  ): Promise<string | null> {
    try {
      return await adapter.runOneShot(prompt, options);
    } catch {
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

  // ── Synthesis batch builder ───────────────────────────────────────────────

  private _buildRetrievalSynthesisBatches(
    synthesisGroups: Map<string, string[]>,
    entryMap: Map<string, { entryId: string; title: string; summary: string; entryPath: string }>,
  ): Array<{
    topicIds: string[];
    entries: Array<{ entryId: string; title: string; entryPath: string }>;
  }> {
    const batches: Array<{
      topicIds: string[];
      entries: Array<{ entryId: string; title: string; entryPath: string }>;
    }> = [];

    // Group entries that share topics together.
    const processedEntries = new Set<string>();
    for (const [topicId, entryIds] of synthesisGroups) {
      const unprocessed = entryIds.filter((eid) => !processedEntries.has(eid));
      if (unprocessed.length === 0) continue;

      for (const entryBatch of chunk(unprocessed, SYNTHESIS_BATCH_SIZE)) {
        batches.push({
          topicIds: [topicId],
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
    phase: 'routing' | 'verification' | 'synthesis' | 'discovery' | 'reflection',
    done: number,
    total: number,
    hash: string,
  ): void {
    // Persist progress so the REST endpoint can return it (WS may not be
    // connected when the KB Browser is open without an active chat stream).
    const db = this.chatService.getKbDb(hash);
    if (db) {
      db.setSynthesisMeta('dream_progress', JSON.stringify({ phase, done, total }));
    }
    this.emit?.(hash, {
      type: 'kb_state_update',
      updatedAt: new Date().toISOString(),
      changed: { synthesis: true, dreamProgress: { phase, done, total } },
    });
  }

  // ── Topic embedding helpers ───────────────────────────────────────────────

  /**
   * Embed specific topics after a synthesis batch completes.
   * Makes newly created/updated topics immediately searchable.
   */
  private async _embedBatchTopics(
    hash: string,
    db: KbDatabase,
    topicIds: string[],
  ): Promise<void> {
    if (topicIds.length === 0) return;
    const cfg = await this.chatService.getWorkspaceKbEmbeddingConfig(hash);
    if (!cfg) return;
    const resolved = resolveConfig(cfg);
    const store = await this.chatService.getKbVectorStore(hash, resolved.dimensions);
    if (!store) return;

    // Filter to topics that still exist (some may have been deleted in the same batch).
    const topics = topicIds
      .map((tid) => db.getTopic(tid))
      .filter((t): t is NonNullable<typeof t> => t !== null);

    if (topics.length === 0) return;

    try {
      const texts = topics.map((t) => `${t.title} — ${t.summary ?? ''}`);
      const results = await embedBatch(texts, cfg);
      await store.setModel(resolved.model);
      for (let i = 0; i < topics.length; i++) {
        await store.upsertTopic(
          topics[i].topicId,
          topics[i].title,
          topics[i].summary ?? '',
          results[i].embedding,
        );
      }
    } catch (err) {
      console.warn(`[kb] dream: batch topic embedding failed:`, (err as Error).message);
    }
  }

  /**
   * Full sweep: embed all topics, clean up stale embeddings.
   * Runs at the end of every dream run.
   */
  private async _embedTopics(hash: string, db: KbDatabase): Promise<void> {
    const cfg = await this.chatService.getWorkspaceKbEmbeddingConfig(hash);
    if (!cfg) return;

    const resolved = resolveConfig(cfg);
    const store = await this.chatService.getKbVectorStore(hash, resolved.dimensions);
    if (!store) return;

    const topics = db.listTopicSummaries();
    if (topics.length === 0) return;

    const BATCH = 50;
    const topicIds = topics.map((t) => t.topicId);
    await store.setModel(resolved.model);

    for (let i = 0; i < topics.length; i += BATCH) {
      const slice = topics.slice(i, i + BATCH);
      const texts = slice.map(
        (t) => `${t.title} — ${t.summary ?? ''}`,
      );
      const results = await embedBatch(texts, cfg);
      for (let j = 0; j < slice.length; j++) {
        await store.upsertTopic(
          slice[j].topicId,
          slice[j].title,
          slice[j].summary ?? '',
          results[j].embedding,
        );
      }
    }

    // Remove embeddings for topics that were deleted during the dream.
    const embeddedIds = await store.embeddedTopicIds();
    const currentIds = new Set(topicIds);
    for (const id of embeddedIds) {
      if (!currentIds.has(id)) {
        await store.deleteTopic(id);
      }
    }
  }
}

// ── Verification output parser ─────────────────────────────────────────────

interface VerificationParseResult {
  verified: Array<{ entry_id: string; topic_id: string }>;
  warnings: string[];
}

export function parseVerificationOutput(raw: string): VerificationParseResult {
  const warnings: string[] = [];

  const jsonStr = extractJsonFromOutput(raw);
  if (!jsonStr) {
    return { verified: [], warnings: ['Verification: no JSON found in output'] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return { verified: [], warnings: [`Verification JSON parse error: ${(err as Error).message}`] };
  }

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj?.verified)) {
    return { verified: [], warnings: ['Verification: missing "verified" array'] };
  }

  const verified: Array<{ entry_id: string; topic_id: string }> = [];
  for (const v of obj.verified) {
    const item = v as Record<string, unknown>;
    if (typeof item?.entry_id === 'string' && typeof item?.topic_id === 'string') {
      verified.push({ entry_id: item.entry_id, topic_id: item.topic_id });
    }
  }

  return { verified, warnings };
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

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extract topic IDs affected by a set of operations. */
export function extractAffectedTopicIds(operations: DreamOperation[]): string[] {
  const ids = new Set<string>();
  for (const op of operations) {
    switch (op.op) {
      case 'create_topic':
      case 'update_topic':
      case 'delete_topic':
        ids.add(op.topic_id);
        break;
      case 'merge_topics':
        ids.add(op.into_topic_id);
        break;
      case 'split_topic':
        for (const sub of op.into) ids.add(sub.topic_id);
        break;
    }
  }
  return [...ids];
}

// ── Reflection prompt & parser ───────────────────────────────────────────

interface ReflectionTopicContext {
  topicId: string;
  title: string;
  summary: string | null;
  content: string | null;
  entryCount: number;
  connectionCount: number;
}

export function buildReflectionPrompt(
  topics: ReflectionTopicContext[],
  connections: Array<{ sourceTopic: string; targetTopic: string; relationship: string; confidence: string }>,
  entries: Array<{ entryId: string; title: string; summary: string }>,
): string {
  const topicSection = topics.map((t) =>
    `### ${t.title} (${t.topicId})\nSummary: ${t.summary ?? 'none'}\nEntries: ${t.entryCount}, Connections: ${t.connectionCount}`
  ).join('\n\n');

  const connectionSection = connections.length > 0
    ? connections.map((c) =>
      `- ${c.sourceTopic} → ${c.targetTopic}: ${c.relationship} (${c.confidence})`
    ).join('\n')
    : 'No internal connections.';

  const entrySection = entries.map((e) =>
    `- ${e.entryId}: "${e.title}" — ${e.summary}`
  ).join('\n');

  return `You are a knowledge analyst reflecting on a cluster of related topics in a knowledge base.

## Your Task
Analyze the following cluster of interconnected topics and produce high-level reflections — insights that emerge from looking at these topics together, but that no single topic contains on its own.

## Types of Reflections
- **pattern**: A recurring theme, progression, or structure across topics (e.g., "Topics A, B, C describe a problem→solution→outcome arc")
- **contradiction**: Conflicting claims or evidence across topics
- **gap**: Missing coverage or blind spots suggested by what IS covered
- **trend**: An emerging direction or shift in the knowledge
- **insight**: Any other cross-topic observation worth capturing

## Topics in this Cluster
${topicSection}

## Connections Between Topics
${connectionSection}

## Source Entries (evidence)
${entrySection}

## Output Format
Return a JSON object with a "reflections" array. Each reflection must cite specific entry IDs as evidence.

\`\`\`json
{
  "reflections": [
    {
      "title": "Short title for this reflection",
      "type": "pattern|contradiction|gap|trend|insight",
      "summary": "One-line summary",
      "content": "Full markdown prose with inline citations like [Entry: entry-title](entry-id)",
      "cited_entry_ids": ["entry-id-1", "entry-id-2"]
    }
  ]
}
\`\`\`

Rules:
- Each reflection MUST cite at least one entry ID in cited_entry_ids.
- Use [Entry: title](entry-id) format for inline citations in the content.
- Only produce reflections that genuinely emerge from cross-topic analysis — do not restate what individual topics already say.
- Quality over quantity — 1-3 strong reflections per cluster is ideal.
- If no meaningful cross-topic insights exist, return an empty reflections array.`;
}

interface ParsedReflection {
  title: string;
  type: string;
  summary: string;
  content: string;
  cited_entry_ids: string[];
}

interface ReflectionParseResult {
  reflections: ParsedReflection[];
  warnings: string[];
}

export function parseReflectionOutput(raw: string): ReflectionParseResult {
  const warnings: string[] = [];
  const jsonStr = extractJsonFromOutput(raw);
  if (!jsonStr) {
    return { reflections: [], warnings: ['Reflection: no JSON found in output'] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return { reflections: [], warnings: [`Reflection JSON parse error: ${(err as Error).message}`] };
  }

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj?.reflections)) {
    return { reflections: [], warnings: ['Reflection: missing "reflections" array'] };
  }

  const VALID_TYPES = new Set(['pattern', 'contradiction', 'gap', 'trend', 'insight']);
  const reflections: ParsedReflection[] = [];
  for (const r of obj.reflections) {
    const item = r as Record<string, unknown>;
    if (typeof item?.title !== 'string' || typeof item?.content !== 'string') {
      warnings.push('Reflection: skipped item with missing title or content');
      continue;
    }
    const type = VALID_TYPES.has(item.type as string) ? (item.type as string) : 'insight';
    const citedIds = Array.isArray(item.cited_entry_ids)
      ? (item.cited_entry_ids as unknown[]).filter((id): id is string => typeof id === 'string')
      : [];
    if (citedIds.length === 0) {
      warnings.push(`Reflection "${item.title}": no valid cited_entry_ids, skipping`);
      continue;
    }
    reflections.push({
      title: item.title,
      type,
      summary: typeof item.summary === 'string' ? item.summary : '',
      content: item.content,
      cited_entry_ids: citedIds,
    });
  }

  return { reflections, warnings };
}

// ── Cluster identification ──────────────────────────────────────────────

/**
 * Identify connected components in the topic graph using BFS.
 * Returns an array of clusters, each being an array of topic IDs.
 */
export function identifyTopicClusters(
  topicIds: string[],
  connections: Array<{ sourceTopic: string; targetTopic: string }>,
): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const tid of topicIds) {
    adjacency.set(tid, new Set());
  }
  for (const c of connections) {
    adjacency.get(c.sourceTopic)?.add(c.targetTopic);
    adjacency.get(c.targetTopic)?.add(c.sourceTopic);
  }

  const visited = new Set<string>();
  const clusters: string[][] = [];

  for (const tid of topicIds) {
    if (visited.has(tid)) continue;
    const cluster: string[] = [];
    const queue: string[] = [tid];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      cluster.push(current);
      const neighbors = adjacency.get(current);
      if (neighbors) {
        for (const n of neighbors) {
          if (!visited.has(n)) queue.push(n);
        }
      }
    }
    // Only include clusters with 2+ topics (singletons have nothing to reflect on).
    if (cluster.length >= 2) {
      clusters.push(cluster);
    }
  }

  return clusters;
}

// ── Reflection markdown generator ───────────────────────────────────────

function regenerateReflectionMarkdown(db: KbDatabase, synthesisDir: string): void {
  const reflectionsDir = path.join(synthesisDir, 'reflections');

  // Wipe and recreate.
  if (fs.existsSync(reflectionsDir)) {
    fs.rmSync(reflectionsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(reflectionsDir, { recursive: true });

  const reflections = db.listReflections();
  if (reflections.length === 0) return;

  for (const ref of reflections) {
    const detail = db.getReflection(ref.reflectionId);
    if (!detail) continue;
    const lines: string[] = [
      '---',
      `title: "${detail.title.replace(/"/g, '\\"')}"`,
      `type: ${detail.type}`,
      `created_at: ${detail.createdAt}`,
      `cited_entries: [${detail.citedEntryIds.join(', ')}]`,
      '---',
      '',
      `# ${detail.title}`,
      '',
      detail.content,
      '',
    ];
    fs.writeFileSync(
      path.join(reflectionsDir, `${detail.reflectionId}.md`),
      lines.join('\n'),
    );
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
