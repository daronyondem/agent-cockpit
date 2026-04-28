---
id: 0013
title: Session-scoped topbar usage counter (zeroes on session reset)
status: Accepted
date: 2026-04-28
supersedes: []
superseded-by: null
tags: [usage, ui, sessions, historical]
affects:
  - src/services/chatService.ts
  - src/routes/chat.ts
  - src/types/index.ts
  - public/v2/src/streamStore.js
  - public/js/streaming.js
  - test/chatService.usage.test.ts
  - docs/spec-frontend.md
  - docs/spec-api-endpoints.md
  - docs/spec-data-models.md
---

## Context

Each conversation in the cockpit accumulates two distinct usage views:

1. **Conversation-cumulative `usage`** — the total tokens/cost the conversation has consumed across its entire lifetime, including every prior session within that conversation. This is what billing/audit cares about.
2. **Session-scoped `sessionUsage`** — the tokens/cost consumed since the *current* CLI session was started (or last reset via `POST /api/chat/conversations/:id/reset`). This is what tells the user "how much context have I burned since I last cleared".

The V2 topbar usage chip — the one the user actively reads to decide *"should I reset this session before continuing?"* — was historically reading the **conversation-cumulative `usage`** field. That made the chip monotonically increasing within a conversation: hitting "reset session" did not zero it. Users would reset, expect the chip to drop, and see the same big number staring back. The chip was effectively measuring a quantity orthogonal to the action they were trying to take with it.

V1's streaming UI was already wired to `sessionUsage` correctly. V2 had drifted to `usage` somewhere along the way and nobody had caught it until the Codex backend work surfaced the same symptom in a fresh code path.

## Decision

The V2 topbar usage chip reads **`sessionUsage`** (active-session-scoped), not `usage` (conversation-cumulative). On `POST /api/chat/conversations/:id/reset`, the chip zeroes — matching the semantics of the action that just happened.

Source of truth and propagation:

- `src/services/chatService.ts` owns the per-session ledger. `addUsage(convId, sessionIdx, delta)` mutates `convEntry.sessions[sessionIdx].usage` and recomputes the conversation-cumulative `usage` as the sum across sessions.
- `src/routes/chat.ts` includes `sessionUsage` (the *current* session's `usage` object) on every `usage` event broadcast over the WebSocket, alongside the existing conversation-cumulative `usage` field. Both flow on every event so clients can choose their view.
- `public/v2/src/streamStore.js` mirrors `sessionUsage` into the V2 store and the topbar chip renders from it. Conversation-cumulative `usage` is still mirrored for any view that wants the lifetime total.
- `public/js/streaming.js` (V1) was already reading `sessionUsage` — no change there; V1 stays correct.
- Reset semantics: `POST /api/chat/conversations/:id/reset` starts a new session (`sessions.push({ usage: { input, output, cache, cost: 0 } })`). The topbar chip immediately reflects the zeroed `sessionUsage` of the new session.

No client persistence. The store mirrors transiently; on reload the chip reads whatever the next `usage` event broadcasts.

## Alternatives Considered

- **Keep the chip on conversation-cumulative `usage` and add a separate session-scoped chip.** Rejected: two adjacent chips with subtly-different semantics is more confusing than one chip with the right semantics. The user wants one number that answers "should I reset?" — a second chip just adds noise.
- **Stop tracking conversation-cumulative `usage` entirely; only track per-session.** Rejected: cumulative is genuinely useful for billing/audit views and for any future "this conversation cost $X total" surface. Per-session is the right thing for *the topbar chip*; that doesn't mean cumulative should disappear.
- **Compute `sessionUsage` on the client** (subtract the cumulative-at-last-reset from the current cumulative). Rejected: the client doesn't know when resets happened across reload; the server is already the source of truth for the session boundaries (`sessions` array). Computing client-side would duplicate that logic and risk drift.
- **Reset `usage` (the cumulative field) on session reset to make the chip "right" without changing what it reads.** Rejected: would silently destroy the cumulative-billing semantic. Two consumers of one field with conflicting requirements; the right fix is to add the right field, not to redefine the existing one.
- **Persist `sessionUsage` to the conversation file separately from `usage`.** Already happens implicitly: `convEntry.sessions[i].usage` is on disk; `sessionUsage` on the wire is a projection of `sessions[currentIdx].usage`. No new persistence needed.
- **Defer until V2 is feature-complete.** Rejected: this was a small, surgical fix that landed alongside the Codex backend work (which exposed the gap in a fresh streaming path). Bundling it in PR #201 was cheaper than a separate follow-up — same files, same test scaffolding, same review pass.

## Consequences

- + The chip now matches the action the user is trying to take with it. Reset → chip zeroes → user can confidently start fresh.
- + V1 and V2 are aligned: both read `sessionUsage`. No "the old UI showed it differently" drift.
- + Cumulative `usage` is preserved for any future view that wants "lifetime conversation cost" — not destroyed.
- + Adding `sessionUsage` to the wire format is purely additive. Older clients that only know `usage` continue to work; new clients that want session-scoped read the new field.
- - Two usage fields on the wire (`usage` + `sessionUsage`) is slightly more bandwidth and slightly more cognitive load when reading event payloads. Both fields are small structs; the cost is in the noise.
- - The session boundary semantics (when does a "new session" start?) is now load-bearing on UX. `POST /reset` starts one; backend-initiated session restarts (e.g. Codex's `thread/resume` after interpreter crash) need to make the right call about whether to push a new session entry or extend the existing one. Documented in `docs/spec-data-models.md` for the Sessions array.
- - Plan-usage tracking (claude-plan-usage.json, the long-horizon "% of plan consumed" view) is a *separate* system from this counter. They share vocabulary ("usage") but live in different files and answer different questions. Keeping them mentally distinct is on the developer; the spec calls this out.
- ~ The fix landed as a bonus in PR #201 (Codex backend) rather than its own PR. Bundling was the right call given how small the delta was, but the PR title doesn't advertise it — anyone bisecting "when did the topbar chip start zeroing on reset" needs this ADR (or commit `dc5806e`) to find the change.

## References

- PR #201, commit `dc5806e` — the in-flight fix (bundled with the Codex backend ship)
- `src/services/chatService.ts` — `addUsage()` and the per-session ledger
- `src/routes/chat.ts` — the `usage` event broadcast that includes `sessionUsage`
- `docs/spec-data-models.md` — Sessions array shape and semantics
- `docs/spec-frontend.md` — V2 topbar chip rendering
- ADR-0004 — workspace memory capture on session reset (the *reason* sessions exist as a first-class concept; this ADR is the UI consequence)
