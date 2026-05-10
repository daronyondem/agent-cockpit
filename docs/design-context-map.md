# Context Map Scope

Status: Proposed golden scope for the full feature. Tracked by issue #281 and ADR-0044.

## Purpose

Context Map is a workspace-level feature that builds and maintains a durable map of the important things in a workspace, the relationships between them, and the evidence that supports those conclusions.

The feature exists to help users and chat runtimes recover continuity across long-running work without depending on a particular folder structure, CLI vendor, or project type. It must work for software repositories, account research workspaces, book/manuscript workspaces, and personal planning workspaces.

Context Map is not just another memory note store. It answers a different question:

- Memory answers: "What durable facts, preferences, corrections, and project context should future sessions remember?"
- Knowledge Base answers: "What source material has the user uploaded or ingested, and what topics can be synthesized from it?"
- Context Map answers: "What are the important entities in this workspace, how are they connected, what evidence supports them, and what compact context should a runtime retrieve right now?"

## Product Name

The user-facing feature name is **Context Map**.

Internal implementation may use entity-oriented terms such as `entities`, `relationships`, `evidence`, and `context_pack`, but the UI should present the feature as Context Map.

Rejected names:

- Entity Map: accurate, but too technical for the main product surface.
- Workspace Graph: accurate, but infrastructure-heavy.
- Knowledge Graph: too loaded and enterprise-oriented.

## Core Concepts

### Entity

An entity is a durable named thing that is likely to matter again in the workspace.

Examples:

- Person
- Organization
- Project
- Workflow
- Document
- Concept
- Decision
- Tool
- Asset
- Account
- Competitor
- Chapter
- Citation source
- Software module
- GitHub issue
- Architecture decision

The product must not create entities for every noun, filename, person mention, or passing topic. An entity should exist only when retaining it is likely to improve future work.

### Entity Type

An entity type is the category assigned to an entity.

Context Map starts with a small default type catalog:

- `person`
- `organization`
- `project`
- `workflow`
- `document`
- `feature`
- `concept`
- `decision`
- `tool`
- `asset`

The catalog must be flexible. The processor may suggest workspace-specific entity types, and the user may apply, rename, merge, or discard them when they require attention.

Examples of workspace-specific types:

- Software development workspace: `repository`, `spec_area`, `service`, `endpoint`, `test_suite`, `adr`, `github_issue`, `pull_request`
- Personal planning workspace: `life_area`, `opportunity`, `personal_project`, `content_platform`, `content_piece`, `relationship`
- Customer/account research workspace: `account`, `stakeholder`, `competitor`, `strategic_frame`, `problem_statement`, `deliverable`, `meeting`
- Manuscript/research workspace: `book`, `chapter`, `citation_source`, `claim`, `framework`, `prompt`, `figure`, `script`

### Relationship

A relationship is a typed edge between two entities.

Examples:

- `person works_on project`
- `organization competes_with organization`
- `project depends_on workflow`
- `chapter cites source`
- `issue affects service`
- `decision supersedes decision`
- `stakeholder owns deliverable`

Relationships must be evidence-backed and lifecycle-aware. They may be active, pending attention, discarded, superseded, stale, or in conflict.

### Evidence

Evidence is the source material that supports an entity, fact, or relationship.

Evidence may come from:

- Conversation messages
- Session summaries
- High-signal workspace files
- Workspace instructions
- README, SPEC, OUTLINE, STYLE_GUIDE, meeting notes, task files, or similar project-defining documents
- Later: explicitly reviewed Memory/KB references, Git metadata, GitHub issues, pull requests, external connectors, and other structured integrations

The product must not assume the existence of a `context/` folder. Such a folder may be useful evidence in a specific workspace, but it is not a product primitive.

### Context Pack

A context pack is a compact runtime bundle selected from Context Map for the current user request or session.

It may include:

- Matching entities
- Important related entities
- Relevant relationships
- Small summaries
- Evidence pointers
- Related conversations
- Related files
- Later: explicitly reviewed Memory/KB evidence pointers

Context packs must be bounded. They should provide pointers and compact summaries, not dump the entire graph into the active chat context.

## Relationship To Existing Features

### Memory

Context Map is separate from Memory and must not require Memory to be enabled.

Memory remains the durable note/fact/preference store. Context Map organizes durable workspace concepts and relationships.

Context Map does not broadly scan existing memory entries. Future Memory linkage should be designed explicitly as reviewed evidence pointers or targeted lookups, not as automatic extraction from the Memory store.

The two features should remain independently enableable. A workspace may use Memory without Context Map, Context Map without Memory, both, or neither.

### Knowledge Base

Context Map is separate from KB and must not require KB to be enabled.

KB is source-document ingestion, topic synthesis, document retrieval, and document-grounded search.

Context Map does not broadly scan KB entries, topics, or source documents. KB stores can contain very large document collections, so future KB linkage should be a separately designed, reviewed, targeted evidence flow rather than automatic Context Map extraction.

### Chat CLI

The active chat CLI must not be responsible for maintaining Context Map during normal conversation. Context Map processing happens asynchronously in the background.

The active CLI may read from Context Map through read-only MCP tools.

### MCP

Context Map MCP access is read-only in the agreed scope and should stay read-only until there is a strong reason to introduce governed write tools.

Initial read-only tools:

- `entity_search(query, types?, limit?)`
- `get_entity(id, includeEvidence?)`
- `get_related_entities(id, depth?, relationshipTypes?, limit?)`
- `context_pack(query, maxEntities?, includeFiles?, includeConversations?)`

The chat CLI should not directly write active entities, facts, or relationships. If write-like behavior is introduced later, it should create processor candidates only.

## Workspace Applicability

Context Map must support multiple workspace shapes.

### Software Development Workspace

In a software development workspace, useful entities include:

- Repositories
- Spec areas
- Backend services
- Frontend screens
- API endpoints
- MCP servers
- ADRs
- GitHub issues
- Pull requests
- Test suites
- Product decisions
- Implementation phases

Useful relationships include:

- Issue affects service
- Spec documents endpoint
- ADR explains decision
- PR implements issue
- Test suite covers behavior
- Service exposes MCP tool

### Personal Planning Workspace

In a personal planning workspace, useful entities include:

- People
- Relationships
- Opportunities
- Personal projects
- Commitments
- Planning themes
- Writing platforms
- Content workflows
- Platform-specific workflows
- Drafts and content pieces

Useful relationships include:

- Person related_to person
- Project uses workflow
- Content piece targets platform
- Preference applies_to audience
- Personal project has constraint

The product must not depend on manually maintained `context/` files even if that workspace happens to have them.

### Account Research Workspace

In a customer/account research workspace, useful entities include:

- Customer/account
- Stakeholders
- Internal team members
- Competitors
- Problem statements
- Strategic frames
- Meetings
- Deliverables
- Source reports
- Extracted slide decks

Useful relationships include:

- Competitor threatens account
- Stakeholder owns concern
- Source supports problem statement
- Strategic frame applies_to deliverable
- Meeting discusses topic

### Manuscript/Research Workspace

In a manuscript or research workspace, useful entities include:

- Book
- Chapters
- Sections
- Concepts
- Frameworks
- Claims
- Citation sources
- Footnotes
- Prompts
- Scripts
- Figures and tables

Useful relationships include:

- Chapter cites source
- Claim supported_by source
- Concept appears_in chapter
- Prompt supports workflow
- Script generates artifact

## Enablement And Settings

Context Map is enabled separately per workspace.

Recommended settings model:

### Global Settings

Global settings define defaults:

- Context Map default enabled state for new workspaces, if introduced later
- Default processor CLI profile
- Default model
- Default effort/reasoning level
- Default scan interval
- Global concurrency cap
- Product-owned source policy

Context Map should have its own processor category. It may initially default to the same CLI profile as Memory or KB, but conceptually it performs different work: entity extraction, relationship detection, evidence linking, deduplication, auto-application, and needs-attention candidate generation.

### Workspace Settings

Workspace settings control workspace-specific behavior:

- Context Map enabled/disabled
- Processor mode:
  - Use global default
  - Override for this workspace
- Optional workspace-specific CLI profile/model/effort override
- Source toggles:
  - Conversations
  - Session summaries
  - Existing memory
  - Knowledge Base
  - High-signal files
  - Workspace instructions
  - Later: Git/GitHub/connectors
- Processing cadence override, if needed
- Initial scan controls
- Rebuild controls

Workspace settings should store only overrides. If a workspace uses the global default, later global setting changes should apply automatically. If a workspace uses an override, it should stay pinned until the user changes it.

## Processing Model

Context Map processing is asynchronous and background-owned.

It must not run inside the active chat turn and must not interrupt the user's chat transcript with suggestions.

### Initial Workspace Scan

When Context Map is enabled for a workspace, the system should offer an initial scan.

The scan should prefer high-signal sources first:

- Conversation summaries
- Instruction files
- README/SPEC/OUTLINE/STYLE_GUIDE and similar project-defining files
- A bounded, deterministically scored set of other Markdown files discovered recursively under the workspace root
- Bounded code outlines for software workspaces, generated from selected implementation/configuration files
- File tree and headings
- High-signal documents such as meeting notes, task lists, source indexes, and workflow docs

The initial scan should persist processor candidates, automatically apply safe high-confidence additive discoveries, and leave ambiguous, risky, sensitive, destructive, low-confidence, conflicting, or blocked candidates in a Needs Attention queue.

The user can inspect, edit, apply, merge, or discard Needs Attention items, but routine high-confidence Context Map maintenance should happen transparently in the background.

### Ongoing Processing

Ongoing processing should be scheduler-driven, not turn-based.

Recommended baseline:

- Every 5 minutes, a background scheduler checks Context Map enabled workspaces.
- It finds conversations updated since the last Context Map processing pass.
- It processes only unprocessed message ranges.
- It also discovers workspace-owned sources and processes only new, changed, or previously missing source packets during scheduled runs; manual rebuild remains the full source re-evaluation path.
- If a processor is already running for the workspace, the workspace is marked dirty and picked up by a later run.
- The scheduler should avoid launching expensive CLI work for trivial changes.

Recommended thresholds:

- Process when at least 2 new completed messages exist, or
- Process when at least 1 new message exists and the conversation has been idle for a configured number of minutes, or
- Always process remaining unprocessed messages during session reset/archive.

The exact default cadence may be adjusted, but the product direction is a time-bound scheduler with message-count and idle constraints.

### Session Reset And Archival

Session reset/archive should force a final Context Map processing pass for any unprocessed message range in that conversation/session.

This complements the scheduler but does not replace it. Some sessions last for days, so waiting for reset alone is not acceptable.

### Incremental Cursors

The processor must avoid reprocessing entire conversations during normal operation.

Each conversation should have durable processing cursors, such as:

- `lastProcessedMessageId`
- `lastProcessedAt`
- `lastProcessedSessionEpoch`
- `lastProcessedSourceHash`

Each processing run should record its source span:

- `conversationId`
- `sessionEpoch`
- `startMessageId`
- `endMessageId`
- `sourceHash`

If the exact span was already processed, the system should skip it.

Workspace source packets should have similar durable cursors keyed by source type and source id:

- `lastProcessedSourceHash`
- `lastProcessedAt`
- `lastSeenAt`
- `status` (`active` or `missing`)

Scheduled runs should skip unchanged source packets, retry failed/new/changed packets, and mark previously active but now undiscovered sources as missing metadata rather than deleting graph data.

If the same fact appears again, it should attach evidence at most once per source span. Repeated mentions should not create duplicate facts or artificially over-emphasize a concept.

### Idempotency And Deduplication

Context Map must be idempotent.

The same source material processed twice should not produce duplicate active entities, duplicate relationships, or inflated confidence.

Deduplication should consider:

- Entity name and aliases
- Entity type
- Existing relationships
- Evidence source spans
- Canonical IDs
- Confidence
- User-confirmed merges

### Background Processor

The background processor may use a separate CLI profile from the active chat CLI.

It should:

- Run outside active chat turns
- Use bounded prompts and source packets
- Respect per-workspace and global concurrency limits
- Persist runs before beginning expensive work
- Persist failures for UI inspection
- Continue gracefully after server restarts when possible
- Never block the user's ability to chat

## Candidate And Attention Model

Context Map changes proposed by the processor should be recorded as durable candidates before they affect canonical state.

High-confidence additive candidates can be auto-applied when they have source-span provenance and do not carry sensitive/destructive ambiguity. Relationship candidates also need active/resolved endpoints; relationships that depend on pending endpoint entity candidates stay in Needs Attention so the user can apply the dependency batch deliberately. Auto-applied candidates still remain visible as audit/change records with `status: active` and an audit event noting processor application.

Candidates that are unsafe to apply automatically stay `pending` and appear as Needs Attention items.

Candidate types:

- New entity
- Entity update
- Entity merge
- New relationship
- Relationship update
- Relationship removal/supersession
- New entity type
- Alias addition
- Evidence link addition
- Sensitivity classification
- Conflict flag

Candidate statuses:

- `pending`
- `active`
- `discarded`
- `superseded`
- `stale`
- `conflict`
- `failed`

Needs Attention actions:

- Apply
- Edit
- Discard
- Merge
- Split
- Mark sensitive
- Mark stale
- Resolve conflict
- Open evidence

Scheduled/background processing may apply safe, high-confidence additive changes without interrupting the user. Anything sensitive, destructive, ambiguous, conflicting, low-confidence, malformed, or dependency-blocked remains pending and is surfaced through Needs Attention.

## UI Scope

### Context Map Page

The main Context Map page should let users browse and search the active map.

Expected capabilities:

- Search entities
- Filter by type, status, source, sensitivity, and recency
- View entity detail cards
- View relationships
- Open evidence
- See related conversations and files
- Later: show explicitly reviewed Memory/KB evidence pointers
- See entity history/audit
- Edit user-controlled fields
- Merge or split entities when needed

Graph visualization may be useful, but the product must not depend on a graph canvas to be valuable. A searchable list plus relationship panels is likely more practical as the primary interface.

### Entity Detail

Entity detail should be rendered from the canonical store and may include:

- Name
- Type
- Aliases
- Summary
- Durable facts
- Relationships
- Evidence
- Related conversations
- Related files
- Later: explicitly reviewed Memory/KB evidence pointers
- Open questions
- Sensitivity
- Audit/history

The entity detail view may display Markdown fields, but Markdown is a field value stored in the canonical database, not a separate generated file.

### Needs Attention Surface

Needs Attention is the exception-handling surface for pending candidates that were not safe to auto-apply.

It should show:

- Pending items grouped by run/source/type
- The proposed change
- Confidence
- Evidence snippets and links
- Existing entity/relationship matches
- Conflicts
- Apply/edit/discard controls
- Run status and errors

### Notifications

Context Map notifications should be separate from chat transcript content.

They may use the existing composer/workspace notification area, or a more prominent workspace notification surface if the UX needs it. The final visual placement is open, but the decision is that Context Map suggestions should not appear as ordinary chat messages.

Notification examples:

- `3 Context Map updates`
- `Context scan failed`
- `2 Context Map items need attention`
- `Context Map processor needs configuration`

### Workspace Settings

Workspace Settings should expose:

- Enable/disable Context Map
- Processor mode: global default or workspace override
- Initial scan controls
- Processing status
- Last processed time
- Needs Attention count
- Rebuild controls
- Destructive clear/reset controls, with confirmation

### Global Settings

Global Settings should expose:

- Default Context Map processor CLI profile
- Model/effort defaults
- Default scan cadence
- Global concurrency cap
- Source policy is product-owned until additional processors are implemented and valuable enough to justify user-facing controls

## Storage And Source Of Truth

Context Map should have a single canonical source of truth.

The preferred canonical store is SQLite.

Do not maintain both editable JSON and editable Markdown versions of the same data. That creates two-way sync problems and consistency risk.

The UI may render Markdown cards, but those cards should be generated at read time from the canonical store.

Markdown-like content can exist as fields in the database:

- `summaryMarkdown`
- `notesMarkdown`
- `factMarkdown`

Structured data should stay structured:

- Entity IDs
- Types
- Aliases
- Relationships
- Evidence refs
- Status
- Confidence
- Sensitivity
- Source spans
- Review state
- Audit records

Potential data areas:

- `entities`
- `entity_types`
- `entity_aliases`
- `entity_facts`
- `relationships`
- `evidence_refs`
- `context_runs`
- `context_candidates`
- `conversation_cursors`
- `source_spans`
- `audit_events`
- `settings`

The exact schema can be designed during implementation, but the single-source-of-truth decision is settled.

## Source References

Every entity, fact, and relationship should be able to point back to evidence.

Evidence refs should support source types such as:

- `conversation_message`
- `conversation_summary`
- `memory_entry`
- `kb_entry`
- `kb_topic`
- `file`
- `workspace_instruction`
- `git_commit`
- `github_issue`
- `github_pull_request`
- `external_connector`

Not all source types need to ship at once.

Evidence refs should store enough information to reopen or inspect the source without duplicating full source content into Context Map.

## Retrieval And Ranking

Context Map retrieval should begin with reliable local retrieval and can later add embeddings.

The ranking model should consider:

- Text match against names, aliases, summaries, facts, and relationship labels
- Entity type match
- Relationship proximity
- Recency
- Source strength
- User confirmation
- Confidence
- Sensitivity/access constraints

Semantic retrieval can be added later, but the feature should not depend on embeddings for its first useful version.

Context pack assembly should be conservative:

- Prefer compact summaries and evidence pointers.
- Cap entity count and relationship depth.
- Avoid dumping large source text.
- Preserve source links so the CLI can request details through MCP when needed.

## Sensitivity And Governance

Context Map may process personal, professional, confidential, or otherwise sensitive information. It needs governance from the start.

Requirements:

- Per-workspace enablement
- Safe auto-application with Needs Attention fallback
- Sensitivity labels
- Secret redaction
- Evidence visibility
- Audit trail
- Clear/delete controls
- Ability to discard candidates without creating active graph entries
- Ability to mark entities or relationships sensitive
- No automatic public sharing

Sensitivity examples:

- `normal`
- `work-sensitive`
- `personal-sensitive`
- `secret-pointer`

The processor should avoid storing raw secrets. When a secret-like value is encountered, store that the workspace has a sensitive credential/reference only if useful, and point to the source without preserving the secret.

## Avoiding Saturation

Context Map must avoid becoming a noisy graph of every extracted noun.

High-signal source files and conversation mentions are evidence first. The processor must not create entities for the scanned file itself, ordinary filenames or local paths, the root workspace folder, or incidental image/logo/attachment assets. A `document` entity is appropriate only when the document is a durable conceptual artifact that future work will discuss by name, such as a maintained spec, ADR, proposal, roadmap, manuscript chapter, research source, or plan. An `asset` entity is appropriate only when the asset is a durable product or domain object, not just a file on disk.

Initial extraction should prefer the built-in entity type catalog and should not create ad hoc type slugs for every repository concept. `feature` is a built-in type for user-facing capabilities, behavior areas, and feature proposals. Other source-specific terms such as product, subsystem, backend, issue, pull request, architecture, policy, and principle should be mapped to the closest built-in type unless the processor intentionally proposes a custom new entity type. Relationships should use the canonical subject/predicate/object shape so candidates can be applied without manual schema repair.

The processor output is cleaned up deterministically before application. Duplicate entity variants are canonicalized, losing names are kept as aliases, alternate fact fields are merged into canonical facts, already-active entity matches become update candidates instead of duplicate new entities, no-op source rescan updates are dropped, common relationship predicate variants are normalized, non-governed comparative or ad-hoc relationship predicates are dropped, self-relationships and weak relationships with unresolved endpoints are dropped, resolved relationships are scored by predicate/type compatibility plus evidence, and useful evidence from rejected weak relationships is folded into same-run entity facts where possible. Same-name entity candidates with conflicting type slugs are resolved to one canonical type before persistence. Implementation predicates are reserved for implementation ownership or concrete component/tool/workflow/project evidence; UI placement, navigation, and access details remain facts. Broad `part_of` edges into the root project require high confidence so weak issue, bug, or UI-state associations do not clutter the graph. Markdown source packets have source-specific candidate budgets and source-local prompt guidance so a source file cannot flood the queue; relationship-heavy source shapes reserve one slot for a strict evidence-backed relationship so entity candidates do not starve useful graph edges. Code-outline packets are generated from bounded static outlines rather than raw full-file dumps, use paths as evidence instead of entity names, and reserve relationship capacity so implementation areas can connect to documented features/workflows without creating entities for ordinary functions, classes, imports, or files.

After deterministic cleanup, larger candidate sets go through bounded synthesis/ranking before persistence; scheduled incremental runs use a lower threshold so smaller changed-source batches still get cleanup. Small sets use a single pass. Larger sets are bucketed by source shape and synthesized in chunks, then the reduced output is ranked and sent to a compact final arbiter pass. Chunk passes can rewrite full candidate payloads, but the final arbiter returns decisions over stable refs (`keepRefs`, `dropRefs`, `mergeGroups`, `typeCorrections`, and `relationshipToFactRefs`) so the backend applies judgment to already-normalized candidates instead of asking the CLI to regenerate the whole payload. The normal final target is 34 or fewer candidates, the hard final cap is 45 candidates, and failed final arbiter output falls back to the ranked reduced set capped at 40 candidates before deterministic cleanup. These passes merge duplicates, choose canonical names, keep aliases/evidence, normalize fact objects into strings, drop low-value or file/path/local-asset noise, fold weak same-source local entities into stronger parent facts, recover only strict relationship candidates when both endpoints survived synthesis, and can convert weak relationships into entity facts. Extraction and synthesis are fail-open but bounded: the parser first applies a deterministic local repair for missing commas between adjacent JSON array values; malformed extraction output that remains invalid gets one JSON repair attempt before a source unit is marked failed; malformed synthesis output that remains invalid gets one JSON repair attempt before fallback; failed repair, timeout, or invalid refs are recorded in run metadata; failed chunks fall back to ranked subsets; and failed final arbitration is capped so raw extraction cannot flood Needs Attention. Run metadata records input/output candidate type counts for the whole synthesis path and each stage so diagnostics can identify whether relationship candidates were lost during extraction, chunk synthesis, final arbitration, or cleanup.

An entity candidate should generally require one or more of these signals:

- Mentioned across multiple sources or sessions
- Appears in high-signal workspace files
- Linked to durable memory, workflow, decision, source, or project context
- Explicitly saved or corrected by the user
- Has relationships to already important entities
- Likely to affect future runtime behavior
- Represents durable work, not temporary chat flow

The processor should prefer fewer, better candidates over exhaustive extraction.

Rejected or low-confidence material should not pollute active retrieval.

## Conflict And Lifecycle Handling

Context Map should support lifecycle management.

Entities, facts, and relationships may become stale, superseded, or contradicted.

Expected behaviors:

- Detect possible duplicates
- Detect contradictory relationships or facts
- Suggest merges
- Preserve history
- Let users supersede rather than destructively overwrite important information
- Keep discarded candidates out of default retrieval
- Allow explicit recall of inactive/superseded material where appropriate

## Completion Criteria

This issue should be considered complete only when the full Context Map feature exists as a usable, governed, workspace-level capability.

Completion means:

- Context Map has its own workspace enablement.
- Context Map has global default processor settings.
- Workspaces can use global defaults or override processor settings.
- Context Map has a canonical single source of truth.
- Entity types are flexible and user-adjustable.
- Initial workspace scan exists and uses generic evidence sources, not a hard-coded folder convention.
- Ongoing processing is asynchronous and scheduler-driven.
- Processing uses per-conversation cursors/source spans, avoids duplicate extraction, and isolates source-unit extraction failures so one malformed processor response does not discard successful candidates from the same run.
- Larger candidate sets are consolidated by chunked synthesis/ranking plus compact final arbitration before persistence, with bounded fallback metadata when synthesis fails.
- Session reset/archive performs a final incremental processing pass.
- Safe processor-proposed changes are auto-applied with durable audit records.
- Ambiguous, risky, sensitive, destructive, blocked, or low-confidence changes enter a durable Needs Attention queue.
- Users can inspect, edit, apply, discard, merge, and resolve candidates.
- Active entities and relationships are searchable and browsable in the UI.
- Entity detail renders readable cards from canonical data.
- Evidence links are visible and usable.
- Notifications surface only running scans, failures, and needs-attention work outside the chat transcript.
- Read-only MCP tools expose Context Map retrieval to active chat CLIs.
- Context pack assembly is bounded and useful.
- The feature works across software development, personal planning, account research, and manuscript/research workspaces.
- Memory and KB can be referenced but are not required.
- Sensitive data handling, redaction, lifecycle, and audit behavior are implemented.
- Tests and specs cover the data model, APIs, scheduler, auto-apply and needs-attention workflow, MCP tools, frontend surfaces, and reset/archive processing.

## Suggested Implementation Phases

The full feature may be implemented in phases, but the phases do not reduce the final scope.

1. Architecture/spec/ADR: finalize data model, settings model, processing model, and API boundaries.
2. Storage foundation: create canonical SQLite store, type catalog, entities, relationships, evidence refs, candidates, runs, cursors, and audit records.
3. Settings and enablement: add global defaults, workspace enablement, workspace overrides, product-owned source policy, and processor profile configuration.
4. Initial scan: scan high-signal sources, a bounded set of scored recursively discovered Markdown sources, bounded code outlines for software workspaces, create candidates, auto-apply safe discoveries, and route exceptions to Needs Attention.
5. Needs Attention: build durable exception queue and apply/edit/discard/merge flows.
6. Active map browsing: build Context Map UI, entity detail, search, filters, related evidence, and audit display.
7. Incremental scheduler: add 5-minute workspace scan loop, cursor-based conversation processing, idempotency, dirty flags, and reset/archive finalization.
8. Read-only MCP: expose `entity_search`, `get_entity`, `get_related_entities`, and `context_pack`.
9. Retrieval quality: improve ranking, context pack assembly, relationship traversal, and optional semantic retrieval.
10. Governance hardening: sensitivity, redaction, conflict workflows, destructive controls, and audit coverage.
11. Source expansion: add deeper KB integration, Git/GitHub source refs, connectors, and optional richer workspace file scanning.
12. Polish and parity: improve notifications, mobile/PWA impact, diagnostics, progress reporting, and operational tooling.

## Decisions Captured

- The feature is called Context Map.
- It is a separate workspace feature, not a sub-feature of Memory.
- Memory and KB can be evidence sources but are not required.
- The product must not depend on a `context/` folder.
- The active chat CLI should not maintain the map during normal conversation.
- MCP access for active chat should be read-only.
- Processing should be asynchronous and background-owned.
- Processing should not be turn-based.
- Processing should not wait only for session reset/archive.
- A scheduler should periodically process updated conversations, with message-count and idle constraints.
- Session reset/archive should finalize unprocessed ranges.
- Per-conversation cursors and source spans are required to avoid duplicate processing.
- Needs Attention suggestions should go to a separate notification surface, not into the chat transcript.
- Context Map should have its own enablement toggle.
- CLI processor settings should use global defaults with optional workspace overrides.
- Context Map should have its own processor profile category.
- SQLite should be the canonical source of truth.
- Rendered Markdown cards are acceptable, but editable Markdown files should not be a second source of truth.
- Entity types should have defaults but allow processor-suggested and user-confirmed workspace-specific types.
- The system should bias against saturation and create fewer, higher-value entities.
- Processor-proposed changes should auto-apply only when safe and route exceptions to Needs Attention.
- The final feature should work across software development, personal planning, account research, and manuscript/research workspaces.
