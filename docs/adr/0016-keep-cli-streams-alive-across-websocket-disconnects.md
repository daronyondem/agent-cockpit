---
id: 0016
title: Keep CLI streams alive across WebSocket disconnects
status: Accepted
date: 2026-04-30
supersedes: [0009]
superseded-by: null
tags: [websocket, streaming, reliability, cli-lifecycle]
affects:
  - src/ws.ts
  - src/routes/chat.ts
  - src/types/index.ts
  - src/services/chatService.ts
  - src/services/backends/kiro.ts
  - public/v2/src/api.js
  - public/v2/src/streamStore.js
  - public/v2/src/shell.jsx
  - public/v2/src/app.css
  - test/chat.websocket.test.ts
  - test/chat.streaming.test.ts
  - test/chat.rest.test.ts
  - test/helpers/chatEnv.ts
  - test/streamStore.test.ts
  - docs/spec-api-endpoints.md
  - docs/spec-frontend.md
  - docs/spec-data-models.md
  - docs/spec-server-security.md
  - docs/spec-testing.md
---

## Context

ADR-0009 moved the chat path away from aborting a CLI immediately when the browser WebSocket closed. It did that with a 60-second reconnect grace period and an in-memory replay buffer. That fixed short network blips, but it still made browser transport state load-bearing: after the grace timer expired, `src/ws.ts` aborted the active CLI stream and `processStream` stopped because its liveness check depended on WebSocket/grace state.

That is the wrong boundary for a separated client/server deployment. The client laptop may sleep, refresh, or move networks while the server laptop remains online. Once the server accepts `POST /message`, the server-to-CLI stream and transcript persistence should continue without requiring the browser to stay connected.

The old model also had related consistency gaps:

- A refreshed V2 client could lose its in-memory `streaming` flag while the server still had an active stream.
- A second `POST /message` could overlap with the active server stream and clear the previous replay buffer.
- Terminal backend errors were transient WebSocket frames, so refresh could lose the reason a turn failed.
- Kiro used an `error` frame for a non-terminal model-switch warning, so durable error persistence needed explicit terminal/non-terminal semantics.

## Decision

CLI stream lifetime is server-owned and independent of browser WebSocket lifetime.

Once `POST /message` is accepted, browser/WebSocket liveness does not affect CLI stream lifetime or server-side persistence. Only backend completion, backend terminal error, stream exception, explicit abort/reset/archive/delete, or server shutdown may end the stream.

Implementation consequences:

- `activeStreams` is the authoritative in-memory owner of active CLI turns.
- `processStream` uses active-stream entry identity to decide whether the stream was cancelled or replaced. It no longer uses WebSocket liveness.
- WebSocket disconnect creates/keeps a replay buffer but does not abort the CLI stream.
- `POST /message` returns `409` while a conversation is already streaming, before persisting another user message or mutating backend/profile/model/effort selections.
- Explicit abort remains a cancellation path and emits terminal `error` + `done` frames after clearing stale buffered frames. V2 uses a REST abort endpoint so Stop does not require an open browser WebSocket. Legacy WebSocket abort frames delegate to the same router-owned abort path.
- Abort persists a durable `Message.streamError` assistant message with source `abort`; if `processStream` has accumulated partial assistant output, it is persisted before the abort marker.
- Completed replay buffers self-clean after `done` even when a browser WebSocket was connected at completion time.
- `GET /active-streams` keeps its compatibility `ids` field and also returns stream summaries (`backend`, `startedAt`, `lastEventAt`, `connected`) so server-owned streams have operational visibility independent of browser state.
- Terminal backend errors are persisted as assistant messages with `Message.streamError`.
- Terminal backend errors end `processStream` immediately; a backend is not required to yield a later `done` frame for cleanup.
- Partial assistant output accumulated before a terminal error is persisted before the stream-error message.
- Non-terminal adapter warnings use `ErrorEvent.terminal === false`; Kiro model-switch warnings are non-terminal and do not pause queue draining or create durable stream-error messages.
- V2 treats WebSocket errors as transport/reconnect state during active streams, not backend failures.
- V2 clears stale socket-open state after connect failure/timeout before retrying.
- V2 handles 409 races by restoring the optimistic send or queued item and returning the conversation to server-active streaming state.
- V2 reconciles stale local streaming state against `GET /active-streams` only after immediate replay has had a chance to settle.

## Alternatives Considered

- **Keep ADR-0009's 60-second grace abort.** Rejected because it still couples server-side CLI work to client availability. It works for short blips but fails the two-laptop client/server model.
- **Increase the grace period.** Rejected because it only changes the threshold. A 30-minute or 6-hour browser reconnect timer is still browser transport controlling CLI lifetime.
- **Retry the user prompt after reconnect.** Rejected because the CLI may already have executed tools. Retrying could duplicate side effects and create a second divergent turn.
- **Persist WebSocket replay buffers to disk.** Rejected for this change. The replay buffer is transport support, not the source of truth. Persisted conversation messages and durable stream-error records are the authoritative reload path.
- **Make all `error` frames durable terminal failures.** Rejected because some adapters already use `error` for warning-like events; Kiro model switching is the known case.

## Consequences

- + A client browser can disconnect longer than 60 seconds without aborting an active CLI stream while the server remains online.
- + A refreshed client can recover through replay when available, or through persisted conversation state after the replay buffer has been cleaned.
- + Overlapping sends are rejected before they can duplicate user messages or clear another stream's buffer.
- + Terminal backend failures are visible after reload.
- + Queue-drain races with server-active streams preserve queued messages and attachments.
- - A CLI can continue running after the user closes the client laptop. Explicit abort/reset/archive/delete and server shutdown remain the intentional cancellation paths.
- - This does not make active streams durable across server process restart or server laptop shutdown. External backend session IDs may help later turns resume vendor context, but the in-process generator is still lost on server crash.
- ~ WebSocket buffers remain in memory and bounded. They are for short-term replay, not durable state.
- ~ Transport reconnect and stale-state reconciliation make the V2 stream store more complex; tests cover replaced sockets, 409 recovery, and replay races.

## References

- Supersedes ADR-0009.
- GitHub issue #247.
- `docs/spec-api-endpoints.md`
- `docs/spec-frontend.md`
- `docs/spec-data-models.md`
- `docs/spec-server-security.md`
- `docs/spec-testing.md`
