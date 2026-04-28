---
id: 0006
title: Atomic writes and per-key mutex for shared JSON files
status: Accepted
date: 2026-04-28
supersedes: []
superseded-by: null
tags: [persistence, concurrency, reliability, historical]
affects:
  - src/utils/atomicWrite.ts
  - src/utils/keyedMutex.ts
  - src/services/chatService.ts
  - src/services/settingsService.ts
  - src/services/claudePlanUsageService.ts
  - src/services/kiroPlanUsageService.ts
  - test/utils.atomicWrite.test.ts
  - test/utils.keyedMutex.test.ts
  - test/chatService.concurrency.test.ts
---

## Context

A production crash brought the server down into a restart loop. The root cause: concurrent `fsp.writeFile` calls on the same workspace `index.json` truncated and byte-interleaved each other, leaving the file as one writer's body plus another writer's tail. `JSON.parse` then crashed at startup, the process exited, PM2 restarted, the corrupt file was re-read, and the loop continued.

The crash was the loud symptom; the underlying class of bug was wider:

1. **Torn writes.** `fs.writeFile` opens with `O_TRUNC` and writes in one or more `write(2)` calls. If two writers race, the file is truncated by both, and the second writer's content overlays the first — but only as far as the second writer's bytes go. A reader can observe a file shorter than either intended write.
2. **Lost updates from interleaved read-modify-write.** Even if writes were atomic, two concurrent mutators that each read the current snapshot, mutate independently, and write back will lose one set of changes. Mutex per shared resource is needed in addition to atomic writes.
3. **Single corrupt file → server-wide outage.** `_buildLookupMap` iterated workspaces, called `JSON.parse` on each, and threw on the first failure. One workspace's corruption took down the entire server's startup.

Several files have the same shape as the workspace index — a shared JSON document that any request handler may mutate: workspace `index.json`, `settings.json`, `claude-plan-usage.json`, `kiro-plan-usage.json`, ledger files. All exhibit the same risks.

## Decision

Two narrow primitives, applied uniformly to every shared-mutable JSON file, plus a defensive guard at startup.

**`atomicWriteFile(filePath, data, encoding?)`** — write to a sibling temp path (`.<base>.tmp.<pid>.<rand>`), then `fs.rename(2)` over the destination. POSIX `rename(2)` is atomic, so a reader always sees either the previous complete file or the new complete file — never a torn write, and never a zero-byte file produced by a crash mid-write. On error, the temp file is unlinked. This replaces every direct `fsp.writeFile` call on a shared JSON file in `ChatService`, `SettingsService`, `ClaudePlanUsageService`, `KiroPlanUsageService`, and `CodexPlanUsageService`.

**`KeyedMutex`** — serializes async operations per key. `run(key, fn)` for the same key runs FIFO; different keys run concurrently. `ChatService` wraps every read-modify-write of a workspace `index.json` in `_indexLock.run(hash, …)`, so workspace `A` and workspace `B` mutate in parallel but two concurrent mutations of `A` do not. Ledger writes share a separate `_ledgerLock`. The mutex is **not reentrant** — calling `run(k, …)` from inside a function already holding `k` deadlocks; this is documented and locked regions are kept self-contained.

**Defensive `try/catch` per workspace in `_buildLookupMap`.** One corrupt `index.json` is logged and skipped; the server still boots. Total outages from a single corrupt file are gone.

Test coverage: unit tests for both helpers (`test/utils.atomicWrite.test.ts`, `test/utils.keyedMutex.test.ts`) plus a `ChatService` concurrency integration test (`test/chatService.concurrency.test.ts`) that drives concurrent mutations and asserts no lost updates.

## Alternatives Considered

- **Move shared state into SQLite (or another database).** Rejected for this fix: real solution but a much larger change. The cockpit deliberately uses flat JSON files for workspace state (low-friction inspection, easy backup, no migration story). Atomic writes + keyed mutex preserve that property while closing the corruption hole. SQLite remains an option if the cost of file-level locking ever becomes load-bearing.
- **Use `proper-lockfile` or `lockfile` npm packages.** Rejected: external dependency, more complex than needed. Filesystem-based lockfiles also have their own failure modes (stale locks after a crash, NFS quirks). An in-process `KeyedMutex` is sufficient because the crash was in-process concurrency, not multi-process.
- **Single global mutex across all writes.** Rejected: would serialize unrelated workspaces. With dozens of workspaces and request handlers running concurrently, a single global lock would serialize them all behind whichever one held it. Per-key mutex preserves the isolation that already existed, just adds correctness.
- **Open files with `O_EXCL` flags or `flock(2)`.** Rejected: `O_EXCL` is for create-only paths and doesn't help us. `flock(2)` is advisory, kernel-managed, and adds platform-specific surface (Linux vs macOS quirks, network filesystems). `rename(2)` is well-understood, portable, and free of advisory-lock pitfalls.
- **Make the writers idempotent and accept lost updates.** Rejected: `index.json` is a list of conversations; losing an update means losing a conversation's metadata. Not acceptable.
- **Detect corruption and rebuild the file from a journal/log.** Rejected: would require introducing a write-ahead log, which is the start of reinventing a database. Atomic writes prevent the corruption in the first place.
- **Fix only `index.json` (the file that crashed prod).** Rejected: every shared mutable JSON file has the same race. We would just be waiting for the next file to crash. Apply both helpers everywhere a shared JSON file is written.
- **Make `KeyedMutex` reentrant.** Rejected: reentrant locks add bookkeeping (track holder identity, count re-entries) and obscure the call sites that would deadlock without reentry. Documenting "don't nest" and keeping locked regions self-contained is simpler. If we ever need reentrancy, that's a deliberate change to the mutex contract.

## Consequences

- + The original crash mode (torn `index.json` → server restart loop) is impossible. Either the previous complete file or the new complete file is observed; no partial state.
- + Lost updates from concurrent mutation are impossible per workspace. Different workspaces still run in parallel.
- + A single corrupt file no longer takes down the server. The defensive `try/catch` in `_buildLookupMap` lets the rest of the workspaces load.
- + The two primitives are general-purpose. Future shared-JSON files (new services, new caches) can use them by import; no per-callsite reinvention.
- - Atomic writes cost one extra `rename(2)` and a unique temp filename per write. Negligible in normal load; would matter if a hot path were doing thousands of writes per second (none are).
- - The mutex serializes writes to the same key. Concurrent mutations of one workspace queue, increasing tail latency under contention. Not visible in practice because per-workspace contention is low (one user, one chat at a time per workspace).
- - The mutex is in-process. Multiple cockpit processes writing to the same `index.json` would still race. We currently run a single process per host (PM2 manages restart, not parallel instances), but if that ever changes the file-level race comes back.
- ~ The `.<base>.tmp.<pid>.<rand>` files are visible during writes. A directory listing during heavy write activity will show them transiently. They're cleaned up on success or on the error path; a hard kill mid-write leaves a tmp file that's harmless (next run ignores it).
- ~ `KeyedMutex._tails` grows with the set of recently-used keys. We delete the tail when the queue empties (`if (this._tails.get(key) === next) this._tails.delete(key)`), so the map size tracks live contention, not historical use.

## References

- PR #198 — `fix: atomic writes + per-workspace mutex to prevent index.json corruption` (the implementation, with the prod crash as motivation)
- POSIX `rename(2)` — the atomicity guarantee this design rests on
