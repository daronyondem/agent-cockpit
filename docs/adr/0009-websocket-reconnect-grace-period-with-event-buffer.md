---
id: 0009
title: WebSocket reconnect grace period with server-side event buffering
status: Superseded
date: 2026-04-28
supersedes: []
superseded-by: 0016
tags: [websocket, streaming, reliability, historical]
affects:
  - src/ws.ts
  - src/routes/chat.ts
  - public/v2/src/streamStore.js
  - test/chat.websocket.test.ts
---

## Context

The cockpit's chat path streams CLI events (text deltas, thinking, tool activity, usage, done) over a WebSocket. The original implementation tied the stream to the WebSocket lifetime: when the WS closed, the CLI was aborted. Two real-world failures fell out of that model:

1. **Brief network blips killed in-flight CLI runs.** A 200 ms wifi handover, a tab-switch on a flaky connection, even a short captive-portal interception — any of these closed the WS and aborted the CLI mid-stream. The user saw "the spinner stopped, where's my answer?" with nothing to recover.
2. **Stale post-sleep WebSockets stuck conversations.** After laptop sleep + network change, the client kept a `readyState === OPEN` socket that was actually dead. The server gated `processStream` on a "live connection" check that returned true (because the socket on the server side hadn't received the close yet), so the CLI never spawned. The user's first post-wake send sat "in-progress" forever with no response.

Both pointed to the same root cause: **the WS connection was treated as load-bearing for the stream's lifetime**, when in practice the WS should be a transport for events and the stream should outlive a momentary disconnect.

## Decision

Decouple stream lifetime from WS lifetime via a **60-second reconnect grace period with server-side event buffering**.

When a WS closes (or doesn't exist at submission time):

1. The server starts a 60 s grace timer (`GRACE_PERIOD_MS = 60_000`, overridable via `gracePeriodMs` for tests).
2. The CLI keeps streaming. Events go into a per-conversation ring buffer (`MAX_BUFFER_SIZE = 1000` events).
3. `isStreamAlive(convId)` returns true while either the WS is open *or* a grace timer is running, so `processStream`'s `isClosed` callback doesn't bail.
4. If the WS reconnects within 60 s, the buffer is replayed in order to the new socket. The user's UI continues uninterrupted.
5. If the grace expires, the server aborts the CLI and emits synthetic `error` (`"WebSocket reconnect grace period expired"`) and `done` frames into the buffer. A later reconnect (e.g. page refresh hours later) sees the closure and unsticks the UI.

Two corollaries:

- **`POST /message` no longer requires a live WS** at submission time. If no socket is connected, the server starts a grace period immediately so the buffer accumulates events while the client gets its socket up.
- **The client revalidates its WS** on the `online` event and on `visibilitychange` after ≥30 s hidden (debounced — short tab switches don't trigger replay flicker). Revalidation closes with code 4000 and re-opens, which re-arms a fresh socket on the server's side and triggers buffer replay.

A 1000-event buffer cap keeps memory bounded; longer streams get the most recent 1000 events on reconnect (older events drop oldest-first). Two timers per buffer (`graceTimer` for the 60 s window, `cleanupTimer` for post-`done` retention) keep buffer lifecycle explicit.

## Alternatives Considered

- **Tie the stream strictly to the WS** (the original behavior). Rejected — it's exactly what produced the two failure modes. A stream that dies on every wifi blip is unusable on real networks.
- **Replay-on-reconnect with no grace period** (kill the CLI immediately, replay buffered events). Rejected: pointless, because the moment the CLI is killed there are no new events to buffer. The grace period is what lets the CLI keep working while we wait for the client to come back.
- **Use SSE (Server-Sent Events) instead of WebSocket.** Rejected: SSE is unidirectional. We need bidirectional for plan-mode approvals, stdin input (for some backend interactions), turn/steer, and stop-button delivery. Switching to SSE would force a parallel side channel for everything client-to-server.
- **Use long-polling.** Rejected: same bidirectional gap as SSE, plus higher latency and more connection churn. WS with reconnect grace is strictly better.
- **Use a much longer grace period (e.g. 30 minutes)** to be maximally forgiving. Rejected: a 30-minute grace means a CLI process running tools (which could include shell commands) is held alive long after the user has given up and walked away. 60 s covers the realistic disconnect cases (handovers, tab switches, brief sleep) without tying up the runtime for hours.
- **Use a much shorter grace period (e.g. 5 s)** to free resources faster. Rejected: too aggressive for laptop-sleep / network-change scenarios where reconnection takes ~10–30 s.
- **Make the client retry the entire send if the WS dropped.** Rejected: the CLI may have already run a destructive tool by the time the network blip happens. Re-sending the prompt would re-execute that tool. The grace period preserves the in-flight work; re-sending would lose it or duplicate it.
- **Persist the buffer to disk so it survives server restarts.** Rejected: server restarts are rare and intentional; the buffer is a transient transport-level artifact, not user data. The frontend's draft-restore (ADR-0011) handles the user-data side. Persisting the event buffer would add complexity for a vanishing edge case.
- **Skip the synthetic `error` + `done` frames after grace expiry.** Rejected: a later reconnect would see no `done` event and the UI would stay "in-progress" forever. The synthetic frames are what makes the closed state observable to a refreshed client.

## Consequences

- + Brief network blips (≤60 s) are invisible to the user. The CLI keeps working; the buffer holds events; the UI replays seamlessly on reconnect.
- + The post-sleep stuck-conversation failure is fixed. Even if the client's socket appears `OPEN` but is actually dead, the server starts the stream anyway and arms the grace period; the client's revalidation logic catches the dead socket and replaces it.
- + `POST /message` works without a live WS. A user whose socket is mid-reconnect can submit a message and see the response when the socket comes back.
- + The bidirectional channel (turn/steer, stop-button, plan approvals, stdin) is preserved by staying on WebSocket.
- - The CLI continues running for up to 60 s after a real disconnect (user closed the tab and walked away). For most CLIs this is cheap; for one running a shell tool it could mean continued tool execution after the user is gone. Mitigated by the user being able to explicitly cancel before walking away; the 60 s cap prevents indefinite drift.
- - Buffer cap of 1000 events: a very long stream that disconnects partway through replays only the last 1000 events on reconnect. Empirically chats produce far fewer than 1000 events per turn, but a tool-heavy turn could exceed it. The drop-oldest-first policy keeps the most recent state visible, which is what users actually need.
- - The synthetic `error` frame after grace expiry is intentionally generic (`"WebSocket reconnect grace period expired"`). It tells the user *that* their session lapsed but not *why* — which is fine because the user already knows the disconnect happened (they walked away, closed the laptop, etc.).
- ~ Two timers per buffer (`graceTimer`, `cleanupTimer`) plus the buffer ring make `src/ws.ts` non-trivial. The lifecycle is documented in interface comments and locked down by `test/chat.websocket.test.ts`. Don't refactor without re-reading both.
- ~ `gracePeriodMs` is overridable in `WsOptions` so tests can exercise grace-expiry paths in 200 ms instead of 60 s. The override is test-only by convention; production never sets it.

## References

- Commit `f54dade` — `feat: add WebSocket reconnection with event buffering and state recovery` (the original implementation)
- Commit `011753f` — `fix: revalidate WS and spawn CLI on network change` (the post-sleep / `POST` -without-WS extension)
- ADR-0011 — rolling session TTL + draft restore (the user-data analogue: client-side persistence of in-progress work, complementing this server-side persistence of in-flight events)
