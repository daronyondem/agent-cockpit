---
id: 0067
title: Page desktop chat transcripts without virtualization
status: Accepted
date: 2026-05-16
supersedes: []
superseded-by: null
tags: [frontend, chat, performance]
affects:
  - src/contracts/conversations.ts
  - src/contracts/responses.ts
  - src/routes/chat/conversationRoutes.ts
  - src/services/chatService.ts
  - src/types/index.ts
  - web/AgentCockpitWeb/src/api.js
  - web/AgentCockpitWeb/src/shell.jsx
  - web/AgentCockpitWeb/src/streamStore.js
  - docs/spec-api-endpoints.md
  - docs/spec-data-models.md
  - docs/spec-frontend.md
---

## Context

Long desktop chat conversations can contain hundreds or thousands of Markdown,
tool, artifact, and subagent-heavy rows. Keeping the whole active session
mounted makes typing, scrolling, and unrelated state updates slower because the
browser must retain and reconcile the entire transcript tree.

We previously tried a third-party virtualizer (`react-virtuoso`) because chat
rows are variable-height and need bottom-follow behavior. That path failed in
this application: scroll restoration, Back to end, composer overlap, pinned
jumps, and conversation switching became unstable. The immediate product
priority is a quality chat experience, and the user explicitly asked not to add
another external virtualization dependency for this attempt.

## Decision

Page the active-session transcript at the Agent Cockpit API boundary and keep
the desktop feed as a normal scroll container.

`GET /conversations/:id` remains full-transcript by default for compatibility,
but accepts `messageWindow=tail&limit=N` for the desktop chat load path. A new
`GET /conversations/:id/messages` endpoint returns tail, older-than-anchor, or
around-anchor message windows with stable zero-based indexes and all pinned
message summaries. The desktop `StreamStore` mounts the tail window, prepends
older pages when the user scrolls near the top, replaces the mounted page for
out-of-window pinned jumps, and reloads the tail before Back to end scrolls to
the real end.

No virtualizer package is added. The DOM is bounded by explicit page size and a
client-side mounted-window cap.

## Alternatives Considered

- **Use `react-virtuoso`**. Rejected for this repo after the failed attempt:
  its bottom-follow and scroll-restoration behavior conflicted with the
  existing composer/feed layout and produced regressions in normal chat
  navigation.
- **Use another virtualizer such as TanStack Virtual or react-window**.
  Rejected for this iteration because it would restart the same class of
  variable-height chat integration risks while adding another dependency.
- **Keep full transcripts mounted and optimize rendering only**. Rejected
  because memoization helps typing and unrelated renders, but it does not solve
  browser layout, memory, and scroll cost for unlimited transcripts.

## Consequences

- + The browser mounts a bounded number of transcript rows without introducing
  a virtualizer dependency.
- + Existing full conversation reads remain backward-compatible.
- + Pinned-message navigation can jump to messages outside the mounted page by
  fetching an around-anchor window first.
- - The server still reads and parses the full session JSON before slicing, so
  this primarily fixes browser rendering cost. Truly huge session files may need
  storage-level pagination later.
- - Cross-window derived UI, such as elapsed time or subagent relationships that
  depend on messages outside the mounted page, can only be complete for the
  loaded window unless a future endpoint returns additional projection metadata.
- ~ Back to end becomes a data operation when the current window has newer
  messages: it reloads the tail before scrolling.

## References

- docs/spec-api-endpoints.md — conversation message-window endpoints
- docs/spec-frontend.md — desktop StreamStore and ChatLive transcript paging
- docs/spec-data-models.md — `messageWindow` and `pinnedMessages` response
  shapes
