# Knowledge Base vNext Implementation Plan

[← Back to index](SPEC.md)

---

## Status

**Status:** Implemented locally through Phase 12  
**Created:** 2026-05-05  
**Decision record:** [ADR-0033](adr/0033-adopt-structure-guided-knowledge-base-digestion-and-retrieval.md)  
**Related issues:** [#123](https://github.com/daronyondem/agent-cockpit/issues/123), [#137](https://github.com/daronyondem/agent-cockpit/issues/137), [#138](https://github.com/daronyondem/agent-cockpit/issues/138), [#244](https://github.com/daronyondem/agent-cockpit/issues/244)  
**External reference:** [VectifyAI/PageIndex](https://github.com/VectifyAI/PageIndex)

This document is the implementation plan for the next major Knowledge Base evolution. It is intentionally more operational than a high-level proposal: each phase is scoped so it can become a reviewable PR with explicit tests, specs, and rollback boundaries.

The current KB already has a substantial pipeline: raw uploads, content-addressed dedupe, hybrid conversion into `text.md` plus media, per-raw digestion into entries, PGLite vector/BM25 indexing, dreaming into topics/connections/reflections, and MCP tools for retrieval. The main remaining weakness is that large documents still collapse through a single digestion response after conversion. That makes a 500-page PDF technically processable, but coverage is constrained by one model response's output budget.

The vNext goal is to add document structure, range-aware chunking, extraction coverage improvements, query recall improvements, graph traversal, synthesis provenance, and visual traceability without replacing the current KB foundation.

## Progress

- **2026-05-05:** Phase 0 design contract created: this plan, the `docs/SPEC.md` design-doc index entry, and [ADR-0033](adr/0033-adopt-structure-guided-knowledge-base-digestion-and-retrieval.md).
- **2026-05-05:** Phase 1 schema foundation completed: `KB_DB_SCHEMA_VERSION` matches the documented current version, migrations now advance through explicit version steps, and DB migration coverage includes V1 to V2, V2 to V3, and current-version fixtures.
- **2026-05-05:** Phase 2 completed: `kb_documents` and `kb_document_nodes` exist with typed DB accessors, replace-on-upsert semantics, migration coverage, raw-delete cascade coverage, deterministic page/slide/heading/fallback structure generation, and ingestion-time persistence after `text.md`/`meta.json` are written.
- **2026-05-05:** Phase 3 completed: KB Search MCP exposes `list_documents`, `get_document_structure`, and `get_source_range`; source range reads are capped, slice converted Markdown by page/slide/heading/line units, return relative media references, and the KB prompt addendum teaches agents to inspect structure before reading large sources.
- **2026-05-05:** Phase 4 planner slice completed: `planDigestChunks()` creates deterministic chunk plans from document structure without changing digestion execution. It preserves natural nodes when possible, merges small adjacent nodes up to the unit and estimated-token budgets, splits oversized ranges, and covers fallback ranges in order.
- **2026-05-05:** Phase 5 completed in strict mode: digestion now plans chunks from document structure, extracts each chunk's Markdown range, runs one Digestion CLI call per chunk, parses all chunk outputs before replacing prior entries, stages replacement entry files, and fails the raw without partial DB replacement when any chunk or write stage fails.
- **2026-05-05:** Phase 6 hook slice completed: `kbGleaningEnabled` is exposed in global KB settings, disabled by default, and routes chunk digestion through `runSessionShot([digestPrompt, gleaningPrompt])` when enabled. The base adapter provides a transcript-replay fallback over `runOneShot()`, while backend-native same-session implementations remain an optimization.
- **2026-05-05:** Phase 7 completed: `kb_entry_sources` stores entry-to-source chunk lineage, entry detail responses and the KB modal expose source ranges, redigestion/raw deletion cascade old lineage, and the digest writer now merges clear duplicate entries by exact slug or normalized title while preserving body content and every source range.
- **2026-05-05:** Phase 8 completed: `kb_glossary` stores workspace query expansions, KB Settings exposes glossary CRUD, REST routes validate create/update/delete, and MCP `search_entries`/`search_topics` expand whole-word glossary terms with `expanded_query` trace output.
- **2026-05-05:** Phase 9 completed: MCP exposes `get_topic_neighborhood` for bounded BFS over synthesized topic connections, with confidence filtering, directed path output, optional entry lists, cycle de-duplication, and god-node score penalties.
- **2026-05-05:** Phase 10 completed: `synthesis_runs` records Dream/Re-Dream lifecycle state, `synthesis_topic_history` records create/update/merge/split/delete topic evolution with source entry IDs, Re-Dream preserves historical rows, and focused DB/dream operation/service tests cover completed, failed, and stopped run statuses.
- **2026-05-05:** Phase 11 completed: the KB Browser now opens with a Pipeline overview, raw rows expose a Trace modal backed by `GET /kb/raw/:rawId/trace`, and the trace surface shows conversion artifacts, structure nodes, planned/used chunks, produced entries, embedding coverage, related synthesis topics, and digest debug dumps.
- **2026-05-06:** Phase 12 hardening completed locally: existing converted raws can be backfilled or individually restructured, failed raws can be retried, digested raws can be redigested without manual status resets, strict chunk failures preserve prior entries, specs were updated, `npm run typecheck`, `npm run adr:lint`, KB-focused tests, and the full Jest suite passed.
- **2026-05-06:** Review hardening completed locally: glossary and trace reads now gate on workspace existence plus KB enablement before opening `state.db`, redigest replacement writes have manifest-backed recovery, MCP document tools bound large responses, and merged multi-node chunks avoid first-node lineage.

## Target Pipeline

Current high-level flow:

```text
raw upload
  -> converted text.md + media + meta.json
  -> one digestion CLI call
  -> entries
  -> embeddings/BM25
  -> dreaming
  -> MCP retrieval
```

Target high-level flow:

```text
raw upload
  -> converted text.md + media + meta.json
  -> document structure/range index
  -> chunk planner
  -> chunked digestion
  -> optional gleaning pass
  -> entry merge/dedupe + source lineage
  -> embeddings/BM25
  -> glossary-aware search
  -> dreaming
  -> graph-neighborhood retrieval
  -> synthesis evidence timeline
  -> pipeline and query trace UI
```

## Current 500-Page PDF Behavior

For a 500-page PDF today:

1. The KB raw upload endpoint accepts the file if it is under the 1 GB KB upload cap.
2. The raw file is stored under `knowledge/raw/<rawId>.pdf`, with `raw` and `raw_locations` rows in `knowledge/state.db`.
3. The PDF handler processes every page sequentially.
4. For each page, the handler:
   - renders a PNG at 196 DPI into `knowledge/converted/<rawId>/pages/page-NNNN.png`;
   - creates a downscaled `.ai.png` sibling if needed for vision-model caps;
   - extracts text and layout signals with pdfjs;
   - classifies the page as `pdfjs`, `artificial-intelligence`, or `image-only`;
   - calls the configured Ingestion CLI for pages that need multimodal conversion;
   - records page-level metadata, source labels, image links, figure/table signals, conversion timing, and retry count.
5. The conversion output is written as:
   - `knowledge/converted/<rawId>/text.md`
   - `knowledge/converted/<rawId>/meta.json`
   - `knowledge/converted/<rawId>/pages/page-0001.png` through `page-0500.png`
   - any `.ai.png` sidecars.
6. If auto-digest is enabled, digestion starts after conversion. Otherwise the raw remains `ingested` until manually digested.
7. Digestion builds one prompt containing the whole converted `text.md` plus source metadata.
8. Digestion runs one CLI call through `adapter.runOneShot()`.
9. The digestion timeout is adaptive:

   ```text
   max(30 minutes, pageCount * 10 minutes)
   ```

   For 500 pages, this is roughly 83 hours and 20 minutes.
10. The CLI returns one or more YAML-frontmatter entry blocks.
11. The parser writes final entries directly to `knowledge/entries/<entryId>/entry.md`, inserts `entries` and `entry_tags` rows, and best-effort embeds `title — summary`.

This means the current pipeline can process a 500-page PDF, but the final extraction is bottlenecked by one digestion response. The ingestion phase may be high fidelity; the extraction phase can still be low coverage.

## Proposed 500-Page PDF Behavior

For a 500-page PDF after vNext:

1. Upload, dedupe, and hybrid conversion stay compatible with today's behavior.
2. After `text.md` and `meta.json` exist, the system creates a document record and a document-node tree for the raw.
3. The structure layer records units such as pages or slides, node IDs, titles, summaries, parent/child relationships, and start/end ranges.
4. A chunk planner turns the structure into bounded digestion work units.
5. Digestion runs one CLI call per chunk instead of one call for the whole document.
6. Optional gleaning can run a second turn for each chunk or larger section to recover missed entities, relationships, concepts, and facts.
7. Chunk outputs are staged, parsed, merged, deduped, and written as final entries.
8. Each final entry records source lineage: raw file, document node, page/slide range, and chunk ID.
9. Search and retrieval can use semantic/BM25 search, glossary-expanded queries, document structure inspection, source-range reads, topic graph traversal, topic reads, entry reads, and reflection reads.
10. Dreaming operations write synthesis history, so topic evolution is auditable.
11. The UI exposes a per-document trace and query-time retrieval trace so users can understand what happened.

## Design Principles

- **Preserve current ingestion fidelity.** The hybrid conversion path already extracts media and AI-assisted Markdown; vNext builds on it rather than replacing it.
- **Move structure before digestion.** Large-document coverage should not depend on one giant model response.
- **Keep chunks source-addressable.** Every chunk and every final entry must trace back to raw document ranges.
- **Prefer deterministic planning.** The first version should use deterministic structures and range splitting before adding more AI structure extraction.
- **Expose retrieval as tools, not prompt dumps.** Agents should fetch structure and ranges on demand.
- **Avoid graph-only or vector-only retrieval.** Use vector/BM25, document structure, glossary expansion, graph traversal, and direct source reads together.
- **Make failure visible.** Chunk failures, partial digestion, skipped gleaning, and stale synthesis must show up in metadata and UI.
- **Use PR-sized phases.** The pipeline crosses storage, queueing, adapters, MCP, UI, tests, and specs. It should not land as one monolith.

## Phase 0: Design Contract

### Goal

Freeze the architecture before behavior changes.

### Scope

- Maintain this document as the working implementation plan.
- Add an ADR for structure-guided KB digestion and retrieval.
- Define the exact current and proposed 500-page PDF flows.
- Define the DB tables, migration order, MCP tools, queue model, chunking rules, failure states, source lineage model, visualization model, and rollout strategy.

### Deliverables

- `docs/design-kb-vnext-implementation-plan.md`
- ADR under `docs/adr/`
- `docs/SPEC.md` design-doc index update

### Acceptance Criteria

- No code behavior changes.
- The implementation sequence is clear enough that each phase can be assigned to a separate PR.
- The ADR explains why PageIndex informs the design but is not vendored as a Python dependency.
- The plan explicitly calls out existing media extraction so future readers do not confuse the improvement with adding media support.

### Tests

No runtime tests required. Run ADR lint if an ADR is added.

## Phase 1: KB Schema Foundation

### Goal

Make future KB migrations safe before adding new tables.

### Current Risk

The code and docs must agree on the current KB schema version before more migrations are added. A mismatch makes future migrations ambiguous and increases the risk of silently skipping a schema change.

### Scope

- Verify `KB_DB_SCHEMA_VERSION` in `src/services/knowledgeBase/db.ts`.
- Verify `docs/spec-data-models.md` and `docs/spec-backend-services.md` describe the same version.
- Add migration tests for the existing `needs_synthesis` and `original_citation_count` columns.
- Add or document a clear migration helper pattern for future vNext migrations.

### Likely Files

- `src/services/knowledgeBase/db.ts`
- `test/knowledgeBase.*.test.ts`
- `docs/spec-data-models.md`
- `docs/spec-backend-services.md`
- `docs/spec-testing.md`

### Acceptance Criteria

- Fresh DBs and migrated DBs report the same expected schema version.
- Existing KB tests pass.
- A fixture DB missing older columns migrates to the current schema.
- Future phases have a clear place to add migrations.

### Verification

```bash
npm run typecheck
npm test
```

## Phase 2: Document Structure Storage

### Goal

Add a PageIndex-inspired structural layer without changing digestion yet.

### New Concepts

Document structure is a per-raw-file range index. It answers:

- What document is this raw file?
- What units does it contain? Pages, slides, lines, sections?
- What titled sections or fallback ranges exist?
- Which ranges should later be digestible or retrievable?

### Proposed Tables

Names may change during implementation, but the core model should be:

```sql
CREATE TABLE kb_documents (
  raw_id          TEXT PRIMARY KEY REFERENCES raw(raw_id) ON DELETE CASCADE,
  doc_name        TEXT NOT NULL,
  doc_description TEXT,
  unit_type       TEXT NOT NULL, -- page | slide | line | section | unknown
  unit_count      INTEGER NOT NULL DEFAULT 0,
  structure_status TEXT NOT NULL DEFAULT 'ready',
  structure_error TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE kb_document_nodes (
  node_id        TEXT NOT NULL,
  raw_id         TEXT NOT NULL REFERENCES kb_documents(raw_id) ON DELETE CASCADE,
  parent_node_id TEXT,
  title          TEXT NOT NULL,
  summary        TEXT,
  start_unit     INTEGER NOT NULL,
  end_unit       INTEGER NOT NULL,
  sort_order     INTEGER NOT NULL,
  source         TEXT NOT NULL, -- deterministic | ai | fallback
  metadata_json  TEXT,
  PRIMARY KEY (raw_id, node_id)
);

CREATE INDEX idx_kb_doc_nodes_raw_order ON kb_document_nodes(raw_id, sort_order);
CREATE INDEX idx_kb_doc_nodes_parent ON kb_document_nodes(raw_id, parent_node_id);
```

### Initial Structure Generation

Use deterministic structure first.

- **PDF:** derive one node per `## Page N` block initially; optionally group contiguous titled headings later.
- **PPTX:** derive one node per visible `## Slide N` block.
- **Markdown/DOCX/text:** derive heading nodes when headings exist.
- **Fallback:** create one root node covering the whole document.

Do not require AI structure extraction in the first version. AI outline generation can be a later enhancement after deterministic storage and retrieval work.

### Integration Point

After ingestion writes `converted/<rawId>/text.md` and `meta.json`, structure generation runs and writes the document/node rows.

### Acceptance Criteria

- Every successfully ingested raw can get a document structure.
- Raw deletion cascades document structure.
- Existing digestion behavior is unchanged.
- A PDF with 500 `## Page N` sections produces a deterministic structure covering pages 1 through 500.
- A fallback node is created when no structure can be inferred.

### Tests

- PDF-style `text.md` page blocks generate 1..N page nodes.
- PPTX-style `text.md` slide blocks generate 1..N slide nodes.
- Markdown headings generate hierarchical nodes.
- Fallback covers the whole document.
- Raw deletion removes structure.

## Phase 3: Source Range Retrieval

### Goal

Expose document structure and range reads to agents through MCP.

### New MCP Tools

```ts
list_documents({
  query?: string,
  limit?: number
})

get_document_structure({
  raw_id: string,
  offset?: number,
  limit?: number
})

get_source_range({
  raw_id: string,
  start_unit: number,
  end_unit: number
})
```

### Response Shape: `get_document_structure`

```ts
{
  document: {
    raw_id: string,
    doc_name: string,
    doc_description?: string,
    unit_type: 'page' | 'slide' | 'line' | 'section' | 'unknown',
    unit_count: number
  },
  nodes: [{
    node_id: string,
    parent_node_id?: string,
    title: string,
    summary?: string,
    start_unit: number,
    end_unit: number,
    sort_order: number,
    children?: unknown[]
  }],
  node_count: number,
  offset: number,
  limit: number,
  truncated: boolean
}
```

### Response Shape: `get_source_range`

```ts
{
  raw_id: string,
  unit_type: string,
  start_unit: number,
  end_unit: number,
  markdown: string,
  media_files: string[],
  truncated?: boolean
}
```

### Rules

- Return structure without full body text.
- Extract only requested page/slide/line sections from `converted/<rawId>/text.md`.
- Include referenced media paths in the response.
- Cap maximum range size to avoid accidental whole-document reads.
- Return an explicit error for unknown raw, missing converted text, invalid ranges, or excessive ranges.

### Likely Files

- `src/services/kbSearchMcp/index.ts`
- `src/services/kbSearchMcp/stub.cjs`
- `src/routes/chat.ts`
- `src/services/knowledgeBase/db.ts`
- `docs/spec-api-endpoints.md`
- `docs/spec-backend-services.md`
- `docs/spec-data-models.md`
- tests for MCP handler and range extraction

### Acceptance Criteria

- An agent can inspect a 500-page document structure and fetch pages 120-135 without reading the whole file.
- Existing MCP tools still work.
- The KB system prompt addendum teaches agents when to use document structure/range tools.

## Phase 4: Chunk Planner

### Goal

Plan digestion work units before changing digestion execution.

### New Concept

```ts
interface KbDigestChunk {
  chunkId: string;
  rawId: string;
  nodeIds: string[];
  startUnit: number;
  endUnit: number;
  estimatedTokens: number;
  reason: 'structure' | 'split-large-node' | 'fallback';
}
```

### Planner Rules

- Prefer natural document nodes.
- Split oversized nodes by page/slide/range budget.
- Never drop units.
- Keep chunks deterministic.
- Avoid overlap in the first version unless a specific source type proves it needs overlap.
- Preserve node IDs and source ranges.
- Make planner output inspectable for tests and UI.

### Proposed Budgets

Initial defaults should be conservative and easy to tune:

- max pages per PDF chunk: 20 to 30
- max slides per PPTX chunk: 20 to 30
- max estimated converted-text characters per chunk: implementation-defined after measuring real converted outputs

The budget should be a setting only if there is a clear user need. Start with internal constants documented in specs.

### Acceptance Criteria

- 10-page PDF can be one chunk.
- 185-page PDF becomes multiple bounded chunks.
- 500-page PDF becomes many bounded chunks.
- Large nodes are split deterministically.
- Chunk planner does not change digestion behavior yet.

### Tests

- small document stays one chunk
- large page list splits by budget
- natural structure nodes are preserved where possible
- oversized node splits
- unit coverage is complete and ordered

## Phase 5: Chunked Digestion

### Goal

Replace one giant digestion call with per-chunk digestion.

### Behavior

- Build chunks from the Phase 4 planner.
- For each chunk, extract the corresponding Markdown range from `converted/<rawId>/text.md`.
- Build a chunk-specific digestion prompt.
- Run one CLI call per chunk through the existing digestion CLI profile.
- Parse each chunk output independently.
- Stage parsed entries in memory or temporary files until the raw is ready to finalize.
- Write final entries after merge/dedupe in Phase 7. For the first chunked PR, a simple "write each parsed entry with source metadata" path may be acceptable if dedupe is scoped into the same PR.

### Prompt Changes

The chunk prompt should include:

- source file metadata
- raw ID
- chunk ID
- source unit range
- structure node titles and summaries when available
- source-aware image-consultation rules from the current digest prompt
- the converted Markdown range only, not the whole `text.md`

### Progress Model

Extend `kb_state_update` progress so the UI can display:

- total chunks
- completed chunks
- failed chunks
- current chunk range
- elapsed time
- estimated remaining time after enough samples

### Failure Model

Decide explicitly during implementation:

- **Strict mode:** any chunk failure fails the raw.
- **Partial mode:** successful chunks can still become entries while failed chunks are reported.

Initial recommendation: strict mode for correctness, with debug output per chunk. Partial mode is useful later but raises UI and trust questions.

### Debug Output

Write failed chunk output to a path like:

```text
knowledge/digest-debug/<rawId>-chunk-<chunkId>-<iso>.txt
```

### Acceptance Criteria

- A large PDF no longer needs one model response to cover every page.
- Chunk progress is visible.
- Chunk failures are diagnosable.
- Existing raw lifecycle states remain understandable.
- Small files still work.

### Tests

- chunk prompts contain only requested ranges
- multiple chunk outputs become entries
- failed chunk marks raw failed with useful error
- debug dump path is recorded
- existing parse behavior still works

## Phase 6: Optional Gleaning

### Goal

Implement issue #138 as an optional second extraction pass after chunking works.

### Adapter API

Add to `BaseBackendAdapter`:

```ts
async runSessionShot(
  prompts: string[],
  options?: RunOneShotOptions,
): Promise<string[]>
```

### Backend Behavior

- **Claude Code:** first call uses a fresh session ID; subsequent calls resume that session ID.
- **Kiro:** use one ephemeral ACP session and send prompts sequentially.
- **Codex:** use one app-server thread or equivalent sequential session primitive.
- **Fallback backend behavior:** the base implementation replays earlier prompts and outputs into the next `runOneShot()` prompt, so any backend with one-shot support can run gleaning. Native same-session implementations can override this for cleaner context and lower prompt overhead.

### Workspace Setting

```ts
kbGleaningEnabled?: boolean
```

Default: `false`.

### Gleaning Prompt

The second prompt should be narrow:

```text
Review the source range and the entries you just extracted.
Identify important entities, relationships, concepts, or facts that were missed
or under-represented. Return only additional entries in the exact same format.
If nothing important was missed, return no entries.
```

### Acceptance Criteria

- Disabled by default.
- When enabled, each chunk can run digest + glean in one backend session.
- Gleaned entries parse through the same parser.
- Duplicate gleaned entries do not produce duplicate final entries.
- Backend capability is visible enough that unsupported profiles do not create surprising failures.

### Tests

- base adapter default replays prior prompts and outputs through `runOneShot`
- backend implementations run sequential prompts
- disabled setting uses `runOneShot`
- enabled setting uses `runSessionShot`
- gleaned output merges with initial output

## Phase 7: Entry Lineage And Dedupe

### Goal

Make chunked output trustworthy and traceable.

### Proposed Table

```sql
CREATE TABLE kb_entry_sources (
  entry_id   TEXT NOT NULL REFERENCES entries(entry_id) ON DELETE CASCADE,
  raw_id     TEXT NOT NULL REFERENCES raw(raw_id) ON DELETE CASCADE,
  node_id    TEXT,
  chunk_id   TEXT NOT NULL,
  start_unit INTEGER NOT NULL,
  end_unit   INTEGER NOT NULL,
  PRIMARY KEY (entry_id, raw_id, chunk_id, start_unit, end_unit)
);

CREATE INDEX idx_kb_entry_sources_raw ON kb_entry_sources(raw_id);
CREATE INDEX idx_kb_entry_sources_entry ON kb_entry_sources(entry_id);
```

### Dedupe Strategy

Start conservative:

1. exact slug match within a raw
2. normalized title match within a raw
3. optional exact summary match

Do not attempt aggressive semantic body merging in the first pass. If two entries are similar but not clearly duplicates, keep both and preserve lineage.

### Entry Frontmatter

Add source fields to `entry.md` frontmatter or expose source lineage through APIs. Prefer DB lineage as source of truth; frontmatter can include a readable subset:

```yaml
sourceRawId: abc123
sourceUnits: "120-135"
sourceUnitType: page
```

### Acceptance Criteria

- Entry detail can show source document and page/slide range.
- Redigestion replaces old entries and old lineage cleanly.
- Deleting raw deletes lineage.
- Dedupe is deterministic and tested.

### Tests

- exact slug duplicates merge
- normalized title duplicates merge
- non-duplicates remain separate
- merged entry keeps multiple source ranges
- redigest clears old lineage

## Phase 8: Glossary Query Expansion

### Goal

Implement issue #137.

### Proposed Table

Because `state.db` is already per workspace, no `workspace_hash` column is needed:

```sql
CREATE TABLE kb_glossary (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  term       TEXT NOT NULL UNIQUE,
  expansion  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### API

```text
GET    /workspaces/:hash/kb/glossary
POST   /workspaces/:hash/kb/glossary
PUT    /workspaces/:hash/kb/glossary/:id
DELETE /workspaces/:hash/kb/glossary/:id
```

### MCP Behavior

Apply expansion in query-bearing tools:

- `search_entries`
- `search_topics`
- future document search if added

Do not apply expansion to ID-based tools such as `find_similar_topics` unless those tools later accept query text.

### Matching Rules

- case-insensitive
- whole-word
- no substring false positives
- append expansion near the matched term
- return the expanded query in MCP responses for traceability

### UI

Workspace Settings -> Knowledge Base:

- table of term and expansion
- add/edit/delete
- no bulk import in first pass

### Acceptance Criteria

- `OEE target` expands to include `Overall Equipment Effectiveness`.
- `employee` does not match `OEE`.
- Search still works when no glossary exists.
- Glossary writes invalidate any per-workspace cache.

## Phase 9: Graph-Neighborhood Retrieval

### Goal

Implement issue #244.

### MCP Tool

Recommended name:

```ts
get_topic_neighborhood({
  topic_id: string,
  depth?: number,
  limit?: number,
  min_confidence?: 'extracted' | 'inferred' | 'speculative',
  include_entries?: boolean
})
```

### Traversal Rules

- BFS over `synthesis_connections`.
- Default depth: 1.
- Initial cap: 2.
- Treat edges as undirected for discovery.
- Preserve original source/target direction in returned path.
- Default `min_confidence`: `inferred`, making speculative edges opt-in.
- Penalize god nodes so broad topics do not dominate results.

### Response Shape

```ts
{
  seed_topic: { topic_id, title, summary },
  topics: [{
    topic_id,
    title,
    summary,
    distance,
    score,
    path: [{
      source_topic,
      target_topic,
      relationship,
      confidence
    }],
    entries?: [{ entry_id, title }]
  }]
}
```

### Acceptance Criteria

- Agent can discover related topics through explicit synthesized relationships.
- Cycles do not produce duplicate topics.
- Confidence filters work.
- Missing topic produces a clear error.
- Existing topic search remains unchanged.

### Tests

- depth 1 traversal
- depth 2 traversal
- cycle handling
- confidence filtering
- limit enforcement
- god-node penalty where applicable
- MCP response shape

## Phase 10: Evidence Timeline

### Goal

Implement issue #123.

### Proposed Tables

```sql
CREATE TABLE synthesis_runs (
  run_id       TEXT PRIMARY KEY,
  mode         TEXT NOT NULL, -- incremental | redream
  status       TEXT NOT NULL, -- running | completed | failed | stopped
  started_at   TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT
);

CREATE TABLE synthesis_topic_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id     TEXT NOT NULL,
  change_type  TEXT NOT NULL, -- created | updated | merged_into | split_from | deleted
  old_content  TEXT,
  new_content  TEXT,
  entry_ids    TEXT, -- JSON array
  run_id       TEXT REFERENCES synthesis_runs(run_id),
  changed_at   TEXT NOT NULL
);

CREATE INDEX idx_topic_history_topic ON synthesis_topic_history(topic_id);
CREATE INDEX idx_topic_history_run ON synthesis_topic_history(run_id);
```

### Behavior

- Generate `run_id` at the start of every dream run.
- Pass `run_id` to `applyOperations`.
- Write history rows for:
  - `create_topic`
  - `update_topic`
  - `merge_topics`
  - `split_topic`
  - `delete_topic`
- Record run status on success, failure, and cooperative stop.

### Re-Dream Policy

Do not silently wipe history by default. Re-Dream should record that a rebuild happened and preserve prior history unless the user explicitly chooses a destructive reset in a later feature.

### Acceptance Criteria

- Topic evolution is auditable.
- Every mutating topic operation writes history.
- Dream runs have statuses.
- Existing reflection stale detection still works.

### Tests

- history row on create
- history row on update with old/new content
- history rows on merge
- history rows on split
- history row on delete
- run status on completed/failed/stopped

## Phase 11: Visualization

### Goal

Make the pipeline understandable in the UI.

### Views

#### Pipeline Overview

A static or semi-live map:

```text
Ingest: Upload -> Convert -> Structure
Digest: Chunk -> Digest -> Index
Dream / Synthesis: Topics -> Links -> Reflections
Retrieve: Queryable -> Ranker -> Access
```

The implemented web view uses the 08b operational-dashboard shape: a top meter strip for Files, Entries, Synthesis, Active, and Health; four vertical columns for Ingest, Digest, Dream / Synthesis, and Retrieve; stacked node cards with status dots; and footer summaries for Raw, Document Shape, Digest Output, and Dream Output. Entries stay under Digest/Index output while topics, links, and reflections stay under Dream output. The Synthesis meter suffixes the number with `topics`; its subtext and the Dream Output footer stay plain stage summaries and do not repeat stale counts. Health uses one short next-action phrase instead of a long counter rollup, and the Reflections node owns the stale reflection count. Raw queue labels say `awaiting digest` and are sourced from `rawByStatus.ingested`, not the broader `pendingCount` aggregate that also covers `pending-delete` cleanup rows. Structure warns with `needs backfill` when converted/raw-ready files exist but no document structure rows exist. Retrieve shows the current search surface honestly: queryable targets are entries + topics, the ranker reports `no targets` before entries/topics exist and `hybrid` only when vector targets exist, access shows `limited` instead of `ready` when only browser keyword search is available, and the Health meter reports `Structure needed` or `Search limited` for the same conditions.

#### Per-Document Trace

For one raw file:

- raw file metadata
- locations
- converted `text.md`
- media count
- structure status and node count
- chunk count and chunk ranges
- digestion status
- entries produced
- embeddings status
- synthesis topics using its entries
- failures/debug dumps

#### Query-Time Retrieval Trace

For one user question:

- original query
- glossary-expanded query
- MCP tools called
- topics returned
- entries returned
- document ranges read
- final sources used

The query trace may require recording retrieval events. If that is too large for the first UI pass, begin with a per-document trace and static pipeline map.

### Mobile PWA

Initial recommendation: web-only. The mobile PWA can link to KB status and continue to show chat-side KB notifications, but deep KB pipeline inspection is likely too dense for the first mobile implementation.

### Acceptance Criteria

- User can inspect what happened to a large document.
- User can see why a document produced a given number of entries.
- User can understand the difference between conversion, structure, digestion, indexing, and dreaming.

## Phase 12: Hardening And Rollout

### Goal

Make the new pipeline production-grade.

### Work Items

- Backfill structure for existing raws.
- Add explicit redigest/restructure controls.
- Add chunk retry controls.
- Improve partial failure UX if strict mode is too limiting.
- Add performance tests for 500-page metadata and structure operations.
- Add or update CI as needed, including dependency review or CodeQL if desired.
- Update all specs after final behavior stabilizes.

### Implemented Rollout Shape

- Workspace-level backfill: `POST /workspaces/:hash/kb/structure/backfill` builds missing `kb_documents` / `kb_document_nodes` from existing `converted/<rawId>/text.md` and `meta.json` artifacts. Missing converted text is skipped per raw rather than failing the whole batch.
- Per-raw restructure: `POST /workspaces/:hash/kb/raw/:rawId/structure` force-rebuilds one raw's structure from converted artifacts and is exposed in the Trace modal.
- Retry/redigest: `POST /workspaces/:hash/kb/raw/:rawId/digest` accepts `failed` raws as retries and `digested` raws as redigests. The Raw tab labels these actions as Retry or Redigest instead of requiring manual DB status changes.
- Chunk failure recovery: strict mode remains conservative. Failed chunks mark the raw failed, preserve previous entries and source lineage, write digest debug dumps when available, and can be retried at the raw level. Partial chunk writes remain a follow-up until the UI can explain partial coverage clearly.
- Text-heavy source protection: digestion now passes converted-text lengths into the planner so a DOCX/Markdown file with fewer than 25 sections can still split into multiple CLI calls when the combined text would exceed the soft chunk budget.
- Verification completed locally: `npm run typecheck`, `npm run adr:lint`, KB-focused Jest paths, and the full Jest suite.

### Acceptance Criteria

- Existing KB data still works.
- New raws use structure/chunking.
- Large docs are observable and recoverable.
- Documentation reflects the final implementation, not just the plan.

## ADR Guidance

Write an ADR before implementation if the phase:

- adds document structure as a permanent data model,
- changes digestion from one call to chunked calls,
- adds synthesis history,
- changes public MCP/API contracts,
- sets a pattern future KB features will follow.

Likely ADRs:

1. Structure-guided KB digestion and retrieval.
2. Chunked digestion with source lineage.
3. Synthesis evidence timeline.

Routine UI, test, and small endpoint phases may not need separate ADRs if covered by the broader ADR.

## Verification Checklist Per PR

Every implementation PR should answer:

- What behavior changed?
- What existing behavior is intentionally preserved?
- What files/tables/endpoints/tools were added?
- What is the migration path for existing workspaces?
- What happens on failure?
- What tests cover this?
- Were specs updated?
- Was mobile PWA impact evaluated?
- Does the PR avoid issue auto-closing keywords unless explicitly approved?

Minimum verification:

```bash
npm run typecheck
npm test
```

Run targeted tests first while developing, then the full suite before PR.

## Open Questions

- Should AI document-structure extraction be added after deterministic structure, or only when deterministic structure is too weak?
- Should synthesis history eventually include connection history as well as topic history?
- Should query-time retrieval traces be persisted, or only visible during a live chat turn?

## Non-Goals For The First Pass

- Do not vendor PageIndex or introduce a Python runtime dependency.
- Do not remove current hybrid conversion.
- Do not replace PGLite vector/BM25 search.
- Do not require glossary configuration for KB search to work.
- Do not implement a complex graph visualization in the same PR as graph retrieval.
- Do not make mobile PWA deep KB management a blocker for web KB pipeline work.
