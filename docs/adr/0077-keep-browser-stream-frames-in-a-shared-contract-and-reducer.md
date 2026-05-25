---
id: 0077
title: Keep browser stream frames in a shared contract and reducer
status: Proposed
date: 2026-05-25
supersedes: []
superseded-by: null
tags: [streaming, frontend, mobile-pwa, contracts, maintainability]
affects:
  - AGENTS.md
  - docs/agent-project-memory.md
  - src/contracts/streamFrames.ts
  - src/contracts/responses.ts
  - web/AgentCockpitWeb/src/stream/streamFrameReducer.ts
  - web/AgentCockpitWeb/src/streamStore.js
  - web/AgentCockpitWeb/vite.config.ts
  - mobile/AgentCockpitPWA/src/types.ts
  - docs/spec-api-endpoints.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
  - docs/spec-testing.md
---

## Context

Stream behavior is shared across backend routes, desktop WebSocket handling, and
the mobile PWA. Before this decision, the browser-visible stream frame shape was
duplicated across client-side type definitions and broad response contracts, and
desktop frame handling lived as imperative mutation logic in `streamStore.js`.
That made drift easy: route tests, desktop state transitions, and mobile PWA
types could each describe a slightly different frame surface.

The maintainability boundary in ADR-0051 requires shared request/response shapes
to live in `src/contracts/` when routes, clients, tests, or specs need the same
boundary. Stream frames are exactly that boundary, but adapter-internal events
such as `turn_boundary`, `result`, `external_session`, and `backend_runtime`
should not leak into browser clients.

## Decision

Keep browser-visible stream frames in a dedicated browser-safe contract at
`src/contracts/streamFrames.ts`. `src/contracts/responses.ts` re-exports that
union as the legacy `StreamEvent` alias for client compatibility, while
server-side backend adapters continue using the broader `src/types.StreamEvent`
union for internal events consumed by `processStream`.

Keep desktop stream-frame state transitions in a typed pure reducer at
`web/AgentCockpitWeb/src/stream/streamFrameReducer.ts`. `streamStore.js` remains
the orchestration/effect adapter: it supplies current time and id factories,
commits reducer state, opens/closes sockets, dispatches browser events, calls
`AgentApi`, starts timers, and refreshes plan-usage stores. The reducer does not
call timers, random/id generators, browser APIs, or network APIs directly.

Because the reducer is an independently imported module, the Vite web build may
split it into a named `stream-frame-reducer` chunk so the main application chunk
stays within the enforced bundle budget.

## Alternatives Considered

- **Keep frame types duplicated in each client**: rejected because every new
  browser-visible frame would require manual edits in desktop, mobile, and
  response contracts, making silent drift likely.
- **Make browser clients import the server-side `src/types.StreamEvent` union**:
  rejected because that union intentionally includes backend-internal events
  that are not forwarded to browsers and imports broader server-domain types.
- **Leave stream handling inside `streamStore.js`**: rejected because replay,
  pending interactions, live-only workspace updates, goal freshness, unread
  effects, and queue draining were coupled to sockets, timers, and API calls,
  making deterministic review and targeted tests hard.

## Consequences

- + Desktop and mobile clients compile against one browser-safe stream frame
  contract.
- + Desktop frame behavior can be reviewed and tested through deterministic
  reducer inputs and explicit effects.
- + `streamStore.js` stays responsible for browser/runtime side effects without
  owning every frame-specific state transition.
- - Stream changes now need contract, reducer, adapter, tests, and specs kept in
  sync; incomplete updates are easier to spot but still require discipline.
- ~ The web bundle has one additional named chunk when the reducer is split for
  budget control.

## References

- [ADR-0051: Adopt shared contracts and logging foundations](0051-adopt-shared-contracts-and-logging-foundations.md)
- [API stream event spec](../spec-api-endpoints.md#37-messaging-and-streaming)
- [Frontend StreamStore spec](../spec-frontend.md#v2--default-frontend)
- [Mobile PWA spec](../spec-mobile-pwa.md)
- [Testing spec](../spec-testing.md)
