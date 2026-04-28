---
id: 0004
title: Capture CLI memory at workspace level on session reset
status: Accepted
date: 2026-04-28
supersedes: []
superseded-by: null
tags: [memory, backends, sessions, historical]
affects:
  - src/services/chatService.ts
  - src/services/backends/base.ts
  - src/services/backends/claudeCode.ts
  - src/routes/chat.ts
  - src/types/index.ts
---

## Context

Claude Code (and other CLIs) accumulate "memory" — user preferences, feedback corrections, project context, references — in a per-project directory under their own control (e.g. `~/.claude/projects/<sanitized-path>/memory/`). This memory is the CLI's own state and is invisible to the cockpit by default.

Two concrete user problems followed:

1. **Memory was lost across session resets.** When a user reset a conversation, the new session started with no awareness of accumulated guidance. The CLI itself still had the memory on disk, but the mapping from cockpit conversation → CLI session was severed by the reset, and the CLI's memory dir was scoped to the *project*, not to the *conversation*. So the new session would re-derive things the user had already taught — wasted turns and frustrating regressions on user preferences.
2. **Switching CLIs lost it entirely.** Memory is a CLI-private artifact. A workspace pinned to Claude Code accumulates memory in `~/.claude/projects/...`; the moment the user pins it to Kiro, Codex, or any future backend, that memory is invisible.

A separate constraint shaped the solution: cockpit users frequently work in **git worktrees** (`~/github/agent-cockpit-feature-x` next to `~/github/agent-cockpit`). Each worktree has a distinct absolute path, so a naive workspace key would split memory across worktrees of the same repo — which is the opposite of what users intend.

## Decision

Mirror the CLI's per-project memory into the cockpit's per-workspace store at session reset, and re-inject it into new sessions as a system-prompt block. The cockpit becomes a backend-agnostic memory **carrier**.

Concrete shape:

- **New `extractMemory(workspacePath)` hook on `BaseBackendAdapter`**, returning `MemorySnapshot | null`. Default returns `null` (memory is opt-in per backend). `ClaudeCodeAdapter` is the first implementer; Kiro and other backends do not implement it yet.
- **Capture is triggered by `POST /conversations/:id/reset`.** After the reset handler archives the active session, it calls `chatService.captureWorkspaceMemory(convId, endingBackend)` which invokes the ending backend's `extractMemory(workspacePath)` and persists the snapshot to `workspaces/{hash}/memory/`: raw `.md` files mirrored under `memory/files/`, parsed metadata in `snapshot.json`.
- **Capture is best-effort.** Extraction or persistence errors are logged and never block the reset.
- **Injection is triggered by `POST /conversations/:id/message` for a new session.** The stored snapshot is loaded via `getWorkspaceMemory(hash)`, serialized into a system-prompt block grouped by memory type (User Preferences / Feedback / Project Context / References / Other), and appended to the existing system-prompt parts (global prompt + workspace instructions). All backends benefit without code changes — even those that don't implement `extractMemory` can *consume* memory captured by another backend.
- **Git worktrees are canonicalized to the main repo path.** `resolveCanonicalWorkspacePath()` detects worktrees by looking for a `.git` *file* (not directory) containing a `gitdir:` pointer, reads the `commondir` file inside the worktree's metadata dir to locate the main repo's `.git` directory, and returns its parent. Two worktrees of the same repo share one memory store; non-git workspaces, main repos, malformed metadata, and dangling pointers all pass through unchanged.
- **Claude Code's project-dir resolution falls back to a prefix scan.** `resolveClaudeMemoryDir(workspacePath)` first tries an exact sanitized match (`/foo/bar` → `-foo-bar`). For long paths Claude Code adds a `Bun.hash`-based suffix that can't be reproduced in Node, so we fall back to a prefix scan of `~/.claude/projects/` and pick the shortest matching directory.

This is a **one-way mirror, capture-on-reset only**. Real-time capture, write-back to the CLI's memory dir, UI for editing memory, and `extractMemory` for non-Claude-Code backends are explicitly deferred (see References).

## Alternatives Considered

- **Real-time filesystem watching of the CLI's memory dir.** Rejected for v1 (deferred to #101). Filesystem watching is more responsive but introduces lifecycle complexity (watcher leaks, debouncing, mid-write race), and it doesn't materially help the user-visible problem — memory is consumed at *session start*, not mid-conversation. Capture-on-reset hits the moment the CLI is most likely to have a stable, finalized memory dir.
- **Two-way sync (write cockpit-edited memory back to the CLI's dir).** Rejected for v1 (deferred to #109). The reverse flow is genuinely useful but introduces a conflict-resolution surface (what if both sides edit the same memory file between syncs?), schema-validation duty (cockpit would have to vouch for the CLI-readable format), and trust questions (is cockpit allowed to mutate the CLI's private state?). Shipping a passive mirror first lets us learn how memory is actually used before committing to a write path.
- **Per-conversation memory instead of per-workspace.** Rejected: memory is about long-running context (preferences, corrections, project facts), not single-conversation state. Scoping it to a conversation would defeat the purpose — the user would have to re-teach every reset. Per-workspace matches both the user's mental model and the CLI's own scoping.
- **Inject memory into resumed sessions as well as new ones.** Rejected: `claude-code --resume` doesn't accept `--append-system-prompt`. Only new sessions get the injected block. Resumed sessions already have whatever the CLI carried forward in its own state; injecting again would either duplicate or contradict it.
- **Naive absolute-path keying (no worktree canonicalization).** Rejected: would split memory across worktrees of one repo, which is exactly the case where a single contributor most wants their memory shared. The pure-fs canonicalization helper handles git worktrees with no `git` subprocess dependency.
- **Port `Bun.hash` to Node to reproduce Claude Code's long-path suffix exactly.** Rejected: `Bun.hash` is non-trivially reproducible and the prefix-scan fallback (pick shortest matching directory) is empirically correct for the cases that matter. Documented as a known limitation; pathological cases would need a real port.
- **Block the reset on memory capture failure.** Rejected: memory is a best-effort enrichment, not a load-bearing feature. A capture failure (CLI dir missing, permission error, malformed file) must never prevent the user from resetting their conversation.
- **Make `extractMemory` mandatory on every adapter.** Rejected: most backends don't have a per-project memory concept, and forcing them to return an empty snapshot is noise. The default `null` makes opting in per-backend cheap and explicit. Backends that don't implement it still benefit on the *injection* side because the snapshot is workspace-keyed, not backend-keyed.

## Consequences

- + Memory survives session resets, fresh conversations, and CLI switches. A user who teaches Claude Code that they prefer terse responses keeps that preference even after switching the workspace to Kiro.
- + Backend-agnostic by construction: the hook lives on `BaseBackendAdapter`, the storage is workspace-scoped, the injection path is universal. New backends only need to implement `extractMemory` if they have a memory concept to extract.
- + Worktree canonicalization makes the common contributor workflow (multiple worktrees per repo) Just Work.
- + Best-effort capture means a broken or moved CLI memory dir degrades gracefully — the user loses memory for that reset but doesn't lose the reset itself.
- - Memory is captured **only at session reset**, so guidance the user gives mid-conversation isn't available to the *next* session until the user actively resets. This is the trade for v1 simplicity; real-time capture is #101.
- - This is a **one-way mirror**: edits the user makes to cockpit's stored snapshot don't propagate back to the CLI's memory dir. Until #109 lands, the CLI is the source of truth and cockpit is a read-through cache.
- - Workspace hash is keyed by absolute path, so **renaming a workspace folder loses prior memory**. Worktree canonicalization handles the git case (which is the common one); a manual `mv` of a non-git workspace produces a fresh hash.
- - Claude Code's long-path suffix uses `Bun.hash` (irreproducible in Node). The prefix-scan fallback picks the shortest matching directory. In practice this is the right one; pathological collisions would need a real hash port.
- ~ The system-prompt injection block grows with stored memory. We rely on the CLI's own context window management; we do not currently truncate, summarize, or paginate the injected block. If memory accumulates beyond what's reasonable to inject, that's a future-work signal (related to #104, the memory UI).

## References

- Issue #85 — original feature request (closed by PR #110)
- PR #110 — implementation (`Capture CLI memory at workspace level on session reset`)
- Issue #109 — write-back from cockpit to CLI's memory dir (deferred)
- Issue #104 — UI for viewing/editing memory (deferred)
- Issue #101 — real-time filesystem watching (deferred)
- ADR-0003 — backend adapter encapsulation pattern (the same boundary that hosts `extractMemory`)
