---
id: 0001
title: Record architecture decisions
status: Accepted
date: 2026-04-28
supersedes: []
superseded-by: null
tags: [meta, process]
affects:
  - CLAUDE.md
  - docs/SPEC.md
  - docs/adr/_template.md
  - scripts/adr-new.js
  - scripts/adr-index.js
  - scripts/adr-lint.js
  - scripts/lib/adr-frontmatter.js
  - .github/workflows/adr.yml
---

## Context

Agent Cockpit is developed primarily by a single human contributor with AI assistance. Architectural decisions — choosing SQLite over Postgres, picking an adapter shape, designing the KB ingestion pipeline, etc. — currently live scattered across PR descriptions, issue threads, and inside the contributor's head.

This causes two concrete problems:

1. **Decisions get lost.** Six months later, nobody remembers *why* we picked X over Y. The code shows what we did, not what we rejected.
2. **AI agents working on the codebase have no durable record of constraints.** Without an ADR, an agent reading the code can't tell whether a given pattern is load-bearing (a deliberate decision) or incidental (just how it happened to be written). Without that signal, it may "improve" something that was deliberately chosen, or re-litigate a decided question on every PR.

The SPEC documents under `docs/` describe *what is true now*. They don't capture *why*, *what was rejected*, or *what tradeoff was accepted*. That gap is what ADRs fill.

## Decision

Adopt a lightweight, Nygard-style ADR practice:

- **Location**: `docs/adr/`, with files named `NNNN-kebab-title.md` (zero-padded sequential).
- **Index**: `docs/adr/README.md`, auto-generated from frontmatter by `scripts/adr-index.js`. CI regenerates and commits it on PRs touching ADRs; do not edit it manually.
- **Template**: `docs/adr/_template.md`. Sections: Context, Decision, Alternatives Considered, Consequences, References.
- **Frontmatter** (validated by `scripts/adr-lint.js`):
  - `id`, `title`, `status`, `date`, `supersedes`, `superseded-by`, `tags`, `affects`
  - `status` ∈ {`Proposed`, `Accepted`, `Deprecated`, `Superseded`}
  - `affects` lists code paths or docs whose existence depends on this decision; lint verifies each path exists.
- **Lifecycle**: `Proposed` → `Accepted` (on merge) → optionally `Deprecated` or `Superseded by N`. Once accepted, content is immutable; only `status` and `superseded-by` may change. Reversing or revising a decision means writing a new ADR that supersedes the old.
- **Authoring**: ADRs are written by the agent preparing the PR (typically Claude Code), not the human contributor. CLAUDE.md defines the bar for when one is required.
- **CI**: `.github/workflows/adr.yml` runs on PRs touching `docs/adr/**` or the ADR scripts. It regenerates the index (auto-commits to the PR branch if stale) and runs lint (fails the PR if any rule violates).
- **Relationship with SPEC**: SPEC describes *what is true now*. ADRs describe *why we chose this and what we rejected*. Cross-link both ways; do not duplicate.

## Alternatives Considered

- **Keep all rationale in PR descriptions**. Rejected: PR bodies are not discoverable from the codebase, are awkward to cross-reference, and decay as the platform UI changes. ADRs live in the repo, version with the code, and are greppable.
- **Use an external decision log (Notion, Linear)**. Rejected: separates decision history from the code it constrains. Out-of-repo records are easy to forget to update and invisible to agents reading the codebase.
- **Inline rationale into SPEC documents**. Rejected: SPEC is intended to read as "what is true now," not as a history of choices. Mixing the two makes both worse — SPEC becomes archaeology, and the rationale gets edited away when SPEC is updated.
- **MADR or full-form ADR templates**. Rejected: heavier than needed for a small team. The Nygard form (Context/Decision/Alternatives/Consequences) covers the essentials without imposing structure that would discourage authors from writing them.
- **Use the `adr-tools` CLI**. Rejected: adds a system dependency and provides little beyond what a ~50-line node script does for our exact shape. Lint and index in repo means CI controls correctness without anyone needing extra tooling installed.

## Consequences

- + Future agents (and humans) can grep `docs/adr/` to discover *why* a given subsystem looks the way it does, and what was rejected.
- + Decisions get reviewed at decision time, alongside the implementation, in the same PR.
- + The `affects:` frontmatter creates a reverse index — given a file, you can find the ADRs that constrain it.
- + Lint catches the most common drift modes (missing fields, broken paths, status/superseded-by mismatch) automatically.
- - Adds ceremony to PRs that meet the bar. Mitigated by `npm run adr:new` scaffolding the file and CI auto-regenerating the index.
- - `affects:` paths can rot when files are renamed. Mitigated by the lint check, which fails the PR if any path is missing.
- ~ The judgment of "does this PR meet the bar?" is fuzzy by design. The bar in CLAUDE.md is intentionally illustrative rather than exhaustive — over-writing ADRs produces noise, under-writing produces gaps. We will recalibrate the bar as we accumulate experience.

## References

- CLAUDE.md — `Architecture Decision Records (ADRs)` section (the authoring bar and workflow)
- docs/SPEC.md — `Architecture Decision Records` index entry
- Michael Nygard, *Documenting Architecture Decisions* (2011) — the original write-up that inspired this template
