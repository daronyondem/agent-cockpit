---
id: 0052
title: Persist message pins on session messages
status: Proposed
date: 2026-05-11
supersedes: []
superseded-by: null
tags: [chat, messages, pinning, persistence, frontend, mobile]
affects:
  - src/contracts/responses.ts
  - src/contracts/conversations.ts
  - src/services/chatService.ts
  - src/routes/chat/conversationRoutes.ts
  - web/AgentCockpitWeb/src/shell.jsx
  - web/AgentCockpitWeb/src/streamStore.js
  - mobile/AgentCockpitPWA/src/App.tsx
  - docs/spec-data-models.md
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
---

## Context

Issue #282 adds message pinning so a user can mark important chat turns and navigate among them without leaving the active transcript. Messages already persist in per-session JSON files and are returned through the shared `Message` contract to desktop and mobile clients. Pin state needs to survive reloads and be available to both clients, but it should not affect conversation ordering, unread state, title generation, usage, or session reset behavior.

The UX selected for the first slice is inline and transcript-owned: a hover/touch message toolbar for Copy, Copy MD, and Pin/Unpin; pinned styling on the message itself; and a sticky pinned-message strip for navigation. A separate pinboard/right rail can still be added later, but it should read the same persisted state.

## Decision

Store pin state as optional `Message.pinned?: boolean` on the message object inside `workspaces/{hash}/{convId}/session-N.json`. `true` marks a message as pinned; absent means unpinned. Unpinning deletes the field rather than storing `false`.

Expose a focused mutation endpoint:

`PATCH /api/chat/conversations/:id/messages/:messageId/pin`

The route validates `{ pinned: boolean }`, updates only the active-session message through `ChatService.setMessagePinned()`, and returns `{ ok: true, pinned, message }`. It does not touch workspace-index activity metadata, message counts, or conversation summaries.

Desktop `StreamStore.setMessagePinned()` performs an optimistic in-memory patch and rolls back on failure. Desktop and mobile render their pinned navigation surfaces from `Message.pinned` in the active conversation state.

## Alternatives Considered

- **Store a separate pin list on the conversation index**: Rejected because it would duplicate message ids outside the session file, require cleanup when sessions reset/archive, and create a second persistence surface for a message-local property.
- **Create a dedicated pinboard store per conversation**: Rejected for this slice because pins are simple message annotations and the selected UX is transcript-owned. A future pinboard can project from `Message.pinned` without changing persistence.
- **Persist `pinned: false` on unpinned messages**: Rejected because almost every message is unpinned and existing JSON files omit falsey optional fields.

## Consequences

- + Pin state travels with the message through existing conversation/session reads and requires no migration for legacy sessions.
- + Conversation list ordering, last-message previews, unread flags, and title behavior remain unchanged when a pin is toggled.
- + Desktop and mobile share the same browser-safe contract and REST mutation.
- - Only active-session messages can be toggled by the first route. Archived session previews may show historical `pinned` state, but cannot mutate old-session pins yet.
- ~ A future right-rail pinboard should read from `Message.pinned` rather than introduce a separate source of truth.

## References

- Issue #282
- [Data Models: Message](../spec-data-models.md#message)
- [API Endpoints: Conversations](../spec-api-endpoints.md#32-conversations)
- [Frontend Behavior: ChatLive](../spec-frontend.md#v2--default-frontend)
- [Mobile PWA Client](../spec-mobile-pwa.md)
