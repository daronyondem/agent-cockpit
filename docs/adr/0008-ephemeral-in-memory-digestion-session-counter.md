---
id: 0008
title: Ephemeral in-memory digestion session counter
status: Accepted
date: 2026-04-28
supersedes: []
superseded-by: null
tags: [knowledge-base, digestion, persistence, historical]
affects:
  - src/services/knowledgeBase/digest.ts
  - src/types/index.ts
  - public/js/main.js
  - public/styles.css
  - test/knowledgeBase.digest.test.ts
---

## Context

Issue #150 asked for two things in the KB digestion UI:

1. **Live count of entities created during digestion.** Today, `enqueueBatchDigest()` emits `batchProgress: {done, total}` per raw-settled, but no entity count.
2. **A completion banner.** When the queue drains, show *"Digestion complete — N entities created"* that **persists until the user refreshes the page**.

Both require state that doesn't exist today: a per-run counter of entities created and an `active`/`complete` flag. The question this ADR answers is *where that state lives* — in memory inside `KbDigestionService`, or in a new SQLite table.

The wording of the issue ("persists until the user refreshes") is the key constraint. It does not ask for the count to survive server restarts, page closures, or session resets. It asks for the count to be available to a connected client during and immediately after a digestion run.

## Decision

The per-workspace digestion session counter (`entriesCreated`, `active`) lives **purely in memory** inside `KbDigestionService`, as a `Map<workspaceHash, { entriesCreated, active }>`. It is broadcast to clients on every relevant `KbStateUpdateEvent` and reset to zero when the next `enqueueBatchDigest()` starts. On server restart, the counter is gone — and that is acceptable per the issue's wording.

Concretely:

- New `KbStateUpdateEvent.changed.digestion: { active: boolean; entriesCreated: number }` field.
- `KbDigestionService` holds the in-memory map; mutates it on each entity creation and on queue drain.
- Frontend (`chatHandleKbStateUpdate`, `chatUpdateDigestCompleteBanner`) renders the live count during digestion and the persistent-until-refresh banner on completion.
- No SQLite schema change. No migration. No restart-recovery code path.

## Alternatives Considered

- **Persist the counter in a new `digestion_runs` SQLite table** with columns for workspace hash, started_at, ended_at, entries_created, status. Rejected: requires schema migration, frontend mount-time `lastRun` query, and — most painfully — **cleanup semantics for interrupted runs.** A server crash mid-digestion would leave a stale `active=true` row that needs reconciliation on next startup. Reconciliation is its own design problem (how do we tell "actually crashed" from "still running on another process"?) and the issue doesn't justify that complexity.
- **Persist with a "cleared on restart" flag.** A weaker version of the SQLite option: write the counter to disk but treat any `active=true` row at startup as stale and reset it. Rejected: still costs the schema, the migration, and the disk I/O on every entity creation. Buys nothing the in-memory approach doesn't already provide, and the "cleared on restart" semantics are exactly what in-memory gives you for free.
- **Persist with a TTL.** Auto-expire `active` rows after N minutes of no activity. Rejected for the same complexity reasons; also picks an arbitrary timeout that has no obvious right value.
- **Persist nothing, derive the count on demand.** Already what we did before this issue. Rejected because the issue exists *to add* this state; deriving "entities created in the current run" from `db.getCounters().entryCount` is impossible without a baseline (which would itself need to be persisted or held in memory — back to square one).
- **Send the count from the digestion CLI itself rather than counting in `KbDigestionService`.** Rejected: the CLI emits per-entry events that the service is already consuming; counting them in the service is the natural place. Pushing the responsibility to the CLI splits the source of truth.
- **Hold the counter in the frontend (count entities as the client sees them).** Rejected: a reload mid-digestion would lose the count, and a second tab would count differently. Server-side authority gives every client the same view.

## Consequences

- + Zero schema cost. No migration, no startup reconciliation, no disk I/O on the hot path.
- + The "cleared on restart" semantics fall out for free — no code, no flag, no timer.
- + Frontend logic is symmetric: same `KbStateUpdateEvent` handler drives both the live count and the completion banner. No second code path for "load last run on mount."
- + Multiple connected clients see the same count (broadcast on every state-update event), so two tabs of the cockpit during digestion stay in sync.
- - Server restart during digestion loses the counter. The next page load shows nothing, even if digestion completed five seconds before the restart. Acceptable per the issue's wording but worth being honest about.
- - A user who refreshes mid-digestion still sees the live count (because it's broadcast to every connection on every event), but a user who closes the tab and reopens *after* the queue drains sees no banner. The banner is "persists until refresh" by design — it's a transient notification, not a historical record.
- - There's no audit trail. If the user wants to know "how many entries did the last digestion run create?" after the fact, the answer is unavailable. Future work could persist a *summary row* per completed run (much simpler than tracking the active state) without changing this decision.
- ~ The decision is scoped to *this* counter. If a future feature genuinely needs persistent digestion-run history (analytics, billing, debugging), that's a separate ADR introducing a `digestion_runs` table with proper crash-recovery — not a retrofit of this in-memory counter.

## References

- Issue #150 — `KB: Show entity count during and after digestion` (the issue text and "persists until refresh" wording)
- PR #161 — `feat(kb): show entity count during and after digestion` (the implementation)
- ADR-0006 — atomic writes + keyed mutex (the persistence pattern this decision deliberately *doesn't* invoke)
