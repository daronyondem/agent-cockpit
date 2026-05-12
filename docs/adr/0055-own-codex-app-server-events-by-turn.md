---
id: 0055
title: Own Codex app-server events by turn
status: Accepted
date: 2026-05-12
supersedes: []
superseded-by: null
tags:
  - codex
  - backend
  - reliability
  - streaming
affects:
  - src/services/backends/codex.ts
  - test/codexBackend.test.ts
  - docs/spec-backend-services.md
  - docs/spec-testing.md
---

## Context

Codex app-server processes are intentionally reused per conversation so a local
thread keeps its model context, child-thread state, and CLI runtime alive between
cockpit user messages. The app-server exposes both notifications and
server-to-client JSON-RPC requests through the same stream. When a cockpit stream
stops consuming that stream, the process can still have queued notifications or
requests from a prior turn.

Before this decision, the adapter mostly filtered by thread id. That was not
enough because one Codex thread contains many turns. A later cockpit user message
could consume a previous turn's assistant text, tool activity, token usage,
approval request, user-input request, goal output, or `turn/completed`
notification. In the worst case, a stale completion could close the current
stream before the active turn produced output, while stale approval requests
could be accepted under the wrong user message.

The fix must preserve current child-agent rendering. Child Codex threads emit
their own item notifications, and the cockpit nests their tool activity under the
parent `spawnAgent` card once the current parent turn has identified the child
thread id.

## Decision

Codex app-server output is owned by a specific turn, not just by a thread.

For normal chat turns, the adapter treats the `turn/start` response as the
authoritative active parent `turnId`. The subsequent `turn/started` notification
is accepted only as a duplicate runtime notification for that same turn.

For goal streams, the adapter treats `thread/goal/updated.turnId` as the active
goal turn before any turn-scoped output can flow. Goal streams still forward
goal-state updates for the current thread, but text, tool activity, usage, errors,
and completion must match the active goal turn.

The adapter drops state-mutating notifications unless their `threadId` and
`turnId` match the active parent turn. It accepts child-thread tool activity only
after a current parent-turn `spawnAgent` item records the child `threadId`.
Stale child events cannot create that mapping because stale parent events are
dropped before receiver recording runs.

Server-to-client requests follow the same ownership boundary. Current-turn
command/file approvals are auto-approved as before. Stale command/file approvals
are canceled, stale permissions and user-input requests receive JSON-RPC errors,
and drained legacy approval requests are aborted rather than approved.

Before starting a new run on a reused app-server process, the adapter drains
queued notifications and rejects any queued server requests. It also inspects
`thread/read({ includeTurns: true })` and best-effort interrupts the latest
orphaned `inProgress` turn. These recovery steps reduce queued noise, but
turn-ownership filtering remains the correctness boundary.

## Alternatives Considered

- **Drain queued notifications only before each turn**: rejected because stale
  events can arrive after the drain and because server-to-client requests need an
  explicit reject/cancel response to avoid hanging the app-server.
- **Start a fresh app-server process for every user message**: rejected because
  it would discard the local Codex thread/runtime continuity that process reuse
  provides and would make every turn pay full startup and resume costs.
- **Filter only by `threadId`**: rejected because multiple Codex turns share one
  thread id; the bug exists specifically inside that shared-thread boundary.
- **Use `turn/started` as the active turn source for all stream types**: rejected
  because a stale `turn/started` notification can be queued before the current
  run. Normal chat already has an authoritative `turn/start` response, and goal
  streams expose the owned turn through `thread/goal/updated.turnId`.

## Consequences

- + A new cockpit user message cannot receive prior-turn Codex text, tool
  activity, token usage, approvals, user-input prompts, goal output, or
  completion.
- + Current child-thread tool attribution still works because child events are
  accepted only after the active parent turn records the child mapping.
- + Queued stale server requests are explicitly answered instead of being
  accidentally approved or left pending.
- - The adapter now depends on Codex app-server carrying turn ownership as
  `params.turnId` or `params.turn.id`; turn-scoped output without a turn id is
  treated as stale and dropped.
- ~ Goal streaming depends on `thread/goal/updated.turnId` to establish the owned
  goal turn. If the app-server protocol changes, the focused Codex adapter tests
  should fail before the behavior reaches users.

## References

- [Issue #298](https://github.com/daronyondem/agent-cockpit/issues/298)
- [ADR-0005: Reuse and reset CLI backend processes](0005-reuse-and-reset-cli-backend-processes.md)
- [Backend Services: CodexAdapter](../spec-backend-services.md#codexadapter)
- [Testing and CI/CD](../spec-testing.md)
