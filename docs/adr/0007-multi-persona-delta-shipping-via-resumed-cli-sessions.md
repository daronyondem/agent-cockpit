---
id: 0007
title: Multi-persona conversations via per-persona resumed CLI sessions with delta-shipping
status: Proposed
date: 2026-04-28
supersedes: []
superseded-by: null
tags: [chat, backends, multi-persona, design, historical]
affects:
  - src/services/backends/base.ts
  - src/services/backends/claudeCode.ts
  - src/services/backends/kiro.ts
  - src/services/chatService.ts
  - src/types/index.ts
---

## Context

The `council-of-high-intelligence` skill prompted a design discussion about hosting multiple CLI-backed personas in a single cockpit conversation — a chat where, say, two "council members" (each a separately-prompted Claude Code session) debate a question while the user moderates. The cockpit's existing chat model is one-conversation-to-one-CLI-session: each conversation has a single `sessionId` and every turn goes to the same CLI session. Multi-persona breaks that assumption.

The naive design — *"on each turn, spawn a fresh CLI for each persona and feed it the entire conversation thread restated as text"* — was the first proposal but is expensive on every dimension: every turn pays full prompt re-send, forfeits the CLI's own prompt-caching, and grows quadratically with conversation length.

A second naive option — *"install the council skill into `~/.claude/skills/` and let one CLI session simulate the personas internally"* — bypasses the cockpit's UI/data model entirely (the cockpit can't show separate personas, can't route their tool calls, can't archive their state).

Neither matches the user-visible feature: distinct, persistent personas that each maintain their own coherent CLI history while interacting through a coordinator.

This ADR is **Proposed**, not Accepted — the implementation hasn't shipped. Recording the decision now so the design rationale is greppable when implementation begins.

## Decision

A multi-persona cockpit conversation maps to **N persistent CLI sessions, one per persona**, with a Coordinator that ships only **per-turn deltas** between them. Each persona session retains its own coherent user/assistant history via the CLI's native session-resume mechanism (`claude-code --resume`, Kiro `session/load`, Codex `thread/resume`). The persona itself is unaware that other sessions exist; it sees only what the Coordinator passes it.

Concrete shape:

- **Conversation data model.** `conversation.sessionId` (scalar) → `conversation.personaSessions: { personaId → sessionId }`. Each personaId maps to a CLI-side session id that can be resumed across turns.
- **Persona descriptor.** `{ adapter, model, systemPromptPrefix, displayName, mode: "resume" | "restate" }`. The `mode` field captures the per-backend capability: backends that support session resume (Claude Code, Kiro) use `mode: "resume"`; backends without native resume (currently Codex's `codex exec` one-shot path) fall back to `mode: "restate"`.
- **Per-turn delta shipping.** For each persona, the Coordinator sends a short prompt of the form *"User said: X. Meanwhile B just replied: Y. Your response?"* into that persona's resumed session. The persona's CLI history grows naturally; the cockpit ships only what's new.
- **Restate fallback.** For `mode: "restate"` personas, the Coordinator serializes the conversation thread as Markdown with `### <Persona>` headers and ships it as the prompt each turn. Tool calls in restated threads collapse to plain-text summaries (lossy seam, accepted because restate-mode is the degraded path).
- **MVP shape.** Two Claude personas, single round (user → A → B), no fixed cap on N or rounds in the data model. Council-style multi-round (user → A → B → A → B → user) deferred to follow-up.

The decision deliberately does **not** introduce a new "council" or "multi-persona" primitive at the adapter level. Personas are a `ChatService` concept that orchestrates the existing `BaseBackendAdapter` API. Adapters remain ignorant of multi-persona; they just see normal `sendMessage` calls on resumed sessions.

## Alternatives Considered

- **Stateless per-turn spawn + full thread restate for every persona.** Rejected: dramatically more expensive (every turn pays full prompt re-send, forfeits CLI prompt-caching, grows quadratically with conversation length). The naive baseline this design is optimizing against.
- **Skill-only "zero-touch" path** (install `council-of-high-intelligence` into `~/.claude/skills/`, let one CLI session simulate all personas internally). Rejected: bypasses cockpit's UI/data model entirely. The cockpit can't render distinct personas, can't route their tool calls separately, and can't archive their state. Loses the user-visible feature.
- **One CLI session per turn (spawn fresh, kill after)** instead of persistent resumed sessions. Rejected for the same caching/cost reasons as full restate; resume is the whole point.
- **Uniform "everyone restates" mode across providers.** Rejected: hybrid is better. Where backends *can* resume (Claude Code, Kiro), they should — the persona-mode field captures the per-backend capability so we don't pessimize the common case to accommodate the worst case.
- **A new `MultiPersonaAdapter` primitive at the adapter layer.** Rejected: adapters should stay focused on one CLI process. Multi-persona orchestration belongs in `ChatService` where the conversation lives. Pushing it into adapters would multiply the surface and entangle every backend with personas.
- **Coordinator-as-CLI** (use one CLI session as the Coordinator that prompts the others). Rejected: introduces a third inference call per turn for no benefit; the Coordinator is just a scripted message router and doesn't need a model.

## Consequences

- + Each persona gets the full benefit of its CLI's prompt caching and native session continuity. Cost per turn is bounded by the delta size, not by conversation length.
- + Adapters require no changes — multi-persona is implemented entirely above the adapter boundary. New backends inherit multi-persona for free if they implement session resume.
- + The `mode: "resume" | "restate"` field is honest about backend capability: degradation to restate is explicit and surface-able to the user, not silently slow.
- + MVP scope (2 Claude personas, single round) is shippable in an estimated 2-3 days because the underlying primitives (resumed sessions, adapter `sendMessage`, conversation persistence) already exist.
- - The data model migration (`conversation.sessionId` → `conversation.personaSessions`) touches every code path that reads or writes the active session id. We need a clean migration story (probably treat the legacy single-session shape as a one-persona case).
- - Restate-mode personas (Codex `codex exec`) lose tool-call fidelity in serialized threads. The lossy seam is documented but real — a persona running through restate sees less of its own history than one running through resume.
- - Edit/branching semantics aren't decided. If the user edits a past turn, what happens to each persona's resumed CLI state? Open question — likely each persona's session has to be reset or branched, but the CLI's own tooling for that varies by backend.
- - Session-recovery on CLI failure isn't decided. If persona B's CLI crashes mid-turn, do we retry, restart that persona's session, or fall the conversation back to single-persona mode? Open question.
- - No fixed cap on N personas in the data model. A 10-persona conversation would issue 10 inference calls per turn — fine for council use but a footgun if someone configures a runaway. Worth a soft cap with a confirmation prompt before merging the data model change.
- ~ Multi-round council semantics (A → B → A → B before returning to user) aren't in the MVP. The current shape (user → A → B → user) is single-round; multi-round may need a different turn loop or an outer "council" wrapper that orchestrates rounds.

## References

- Workspace memory note `notes/session_2026-04-25T18-29-29-311Z_project-multi-persona-design-refined.md` (refined synthesis)
- Workspace memory note `notes/session_2026-04-24T00-03-33-472Z_project-multi-persona-conversations.md` (earlier synthesis)
- ADR-0004 — workspace memory capture (the carrier for cross-session persona memory once this lands)
- ADR-0005 — Codex backend (the source of `mode: "restate"` falling back to `codex exec`)
- The `council-of-high-intelligence` skill prompt that motivated the design
