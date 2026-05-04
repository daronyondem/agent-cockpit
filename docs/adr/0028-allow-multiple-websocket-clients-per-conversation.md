---
id: 0028
title: Allow multiple WebSocket clients per conversation
status: Proposed
date: 2026-05-04
supersedes: []
superseded-by: null
tags: [websocket, mobile-pwa, realtime]
affects:
  - src/ws.ts
  - mobile/AgentCockpitPWA/src/App.tsx
  - docs/spec-api-endpoints.md
  - docs/spec-mobile-pwa.md
  - test/chat.websocket.test.ts
---

## Context

The mobile PWA conversation list needs to keep running-state badges current without forcing the user to tap Refresh. The existing stream WebSocket endpoint already provides the authoritative terminal frames, but the transport stored only one open socket per conversation. A passive PWA list monitor for a running conversation would therefore replace an already-open desktop or mobile chat socket for the same conversation.

The PWA also needs a fallback because mobile browsers can suspend timers and sockets while backgrounded. The active-stream REST endpoint remains the durable reconciliation surface for stale badges and missed socket events.

## Decision

The WebSocket layer stores a set of open sockets per conversation and broadcasts each live stream frame to every open socket. `isConnected(conversationId)` is true while at least one socket remains open, and the stream is marked disconnected/buffering only after the last socket closes.

The mobile PWA uses that transport to open passive list monitors for conversations returned by `/api/chat/active-streams` while the list screen is visible. The list monitor ignores text deltas, reacts to title/message/terminal/interaction-needed frames, and refreshes the conversation list when a stream completes. A periodic and focus/visibility REST refresh remains in place for mobile suspension and missed-event recovery.

## Alternatives Considered

- **Keep one socket per conversation and poll only**: Rejected because stale running badges would still persist until the next poll, and shortening the interval would add avoidable REST traffic.
- **Add a new global list-events WebSocket**: Rejected for this change because the existing per-conversation stream socket already carries the needed events and replay semantics. A global activity feed would add a new API surface before the product needs it.
- **Let passive list sockets replace chat sockets**: Rejected because opening the mobile list could break an active desktop or mobile chat view for the same conversation.

## Consequences

- + Mobile running badges clear promptly when streams finish, even without tapping Refresh.
- + Multiple clients can observe the same running conversation without displacing each other.
- - The server may hold more WebSocket transports for the same running conversation.
- ~ The PWA keeps a REST fallback because mobile browsers can still suspend WebSockets and timers.

## References

- [ADR-0009: WebSocket reconnect grace period with event buffer](0009-websocket-reconnect-grace-period-with-event-buffer.md)
- [ADR-0016: Keep CLI streams alive across WebSocket disconnects](0016-keep-cli-streams-alive-across-websocket-disconnects.md)
- [Mobile PWA Client spec](../spec-mobile-pwa.md)
- [API Endpoints spec](../spec-api-endpoints.md)
