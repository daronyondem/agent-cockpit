---
id: 0096
title: Track Copilot orphan ownership and drain before session changes
status: Superseded
date: 2026-11-02
supersedes: [0095]
superseded-by: 0097
tags: [backends, copilot, lifecycle, testing]
affects:
  - src/services/backends/copilotProcess.ts
  - src/services/backends/copilot.ts
  - src/services/streamJobSupervisor.ts
  - src/routes/chat.ts
  - src/routes/chat/conversationRoutes.ts
  - src/routes/chat/worktreeIsolationRoutes.ts
  - test/copilotProcess.test.ts
  - test/copilotBackend.e2e.test.ts
  - test/streamJobSupervisor.test.ts
  - test/chat.worktreeIsolation.test.ts
  - docs/spec-backend-services.md
---

## Context

Copilot 1.0.105 on macOS can start a short-lived shell that leaves a background
worker in a separate process group and session. If that shell exits between
snapshots, ancestry/group tracking never observes an ownership link to the
worker. A native local-model fixture reproduced continuing work after cleanup.

Reset also awaited backend cleanup after committing the new session and changing
its Git branch. A tracked worker could therefore observe the replacement branch
during TERM/KILL escalation. Awaiting cleanup needs an admission reservation so
another message or workspace change cannot enter the gap.

## Decision

Retain ADR-0095's JSONL transport, response isolation, usage rules, Windows
taskkill path, shutdown behavior, and deliberately smaller feature scope.

Create a fresh `AGENT_COCKPIT_COPILOT_SCOPE` UUID in the focused spawn helper for
each chat/one-shot child without changing the profile or server environment.
The inherited marker supplements PID/start and verified-group tracking. Before
TERM and KILL, wait for any ancestry-only scan and take a bounded, untruncated
current-user environment snapshot to recover marked orphans. Discard command and
environment text immediately after matching; never log it. Fall back to numeric
identity/group enumeration if the environment snapshot fails.

The stream supervisor owns temporary conversation/workspace reset reservations.
Acquire them before awaiting cleanup, drain all ending backends before any
session/worktree mutation, and release in `finally`. New chat/goal turns, repeat
resets, worktree mode changes, and CLI updates treat the relevant reservation as
busy. Post-reset summary/Memory/Workspace Context finalizers remain asynchronous.
Cleanup failure leaves the session and checkout unchanged and permits a retry.

## Alternatives Considered

- **Faster ancestry polling:** rejected because a leader can exit between any
  two snapshots; its inherited marker preserves a discoverable ownership link.
- **Cleanup after changing the checkout:** rejected because old tool work can
  write into the new session's branch.
- **Only move the awaited hook:** rejected because concurrent requests can start
  new work while the old runtime is draining.

## Consequences

- + Normal inherited-environment workers remain discoverable after their parent
  and detached group leader disappear; unrelated runs retain separate markers.
- + Cleanup and checkout replacement form one reserved operation across desktop
  and mobile callers.
- - Cleanup reads current-user process environments twice, bounded to 500 ms and
  8 MiB per snapshot; periodic ancestry scans remain environment-free.
- ~ This is lifecycle ownership, not an OS security sandbox. A worker that
  removes its marker, or whose environment the OS hides, still relies on
  observable ancestry/group ownership. Native Windows/Linux validation remains
  separate from macOS evidence and mocked Windows tests.

## References

- [ADR-0095](0095-contain-copilot-process-trees-and-isolate-delegated-responses.md).
- [Backend specification](../spec-backend-services.md#copilotadapter-srcservicesbackendscopilotts).
- [Reset and worktree endpoints](../spec-api-endpoints.md).
- [Compatibility and regression tests](../spec-testing.md).
- PR #571.
