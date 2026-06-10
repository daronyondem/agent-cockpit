---
id: 0085
title: Represent Claude Code Ultracode as a provider session mode
status: Accepted
date: 2026-06-10
supersedes: []
superseded-by: null
tags: [claude-code, cli-profiles, frontend, mobile]
affects:
  - src/contracts/claudeCodeMode.ts
  - src/contracts/conversations.ts
  - src/contracts/streams.ts
  - src/types/index.ts
  - src/services/chatService.ts
  - src/services/backends/claudeCode.ts
  - src/services/backends/claudeCodeInteractive.ts
  - src/routes/chat/streamRoutes.ts
  - src/routes/chat/goalRoutes.ts
  - web/AgentCockpitWeb/src/streamStore.js
  - web/AgentCockpitWeb/src/chat/composer.jsx
  - mobile/AgentCockpitPWA/src/App.tsx
  - mobile/AgentCockpitPWA/src/appModel.ts
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
---

## Context

Claude Code added Ultracode as a session setting that is enabled with
`/effort ultracode` or the CLI `--settings '{"ultracode": true}'` payload.
It is not a model id and not a normal reasoning-effort value. Internally the
CLI still reports an xhigh-style effort to hooks, and Ultracode is limited to
models that support xhigh reasoning.

Agent Cockpit already has a shared `EffortLevel` contract used by Codex,
Claude Code, OpenCode, settings, web, mobile, and persisted conversations.
Adding `ultracode` to that shared union would make non-Claude adapters and UI
surfaces appear to support a Claude-only mode and would blur the difference
between model reasoning effort and provider session behavior.

## Decision

Represent Ultracode as `claudeCodeMode: "ultracode"` on conversation/session
runtime selection, not as an `EffortLevel`.

The field is accepted by conversation create, message send, and goal-set
requests. `null` or an empty string clears the mode. `ChatService` stores the
field only for Claude Code-family backends (`claude-code` and
`claude-code-interactive`) when the selected model advertises `xhigh` in
`supportedEffortLevels`; model, backend, profile, and reset transitions
reconcile or clear stale values.

The standard Claude Code adapter forwards the mode by adding
`--settings '{"ultracode":true}'` to the `claude --print` invocation. The
interactive adapter merges `ultracode: true` into its existing hook settings
JSON so SessionStart/PreToolUse/Stop hooks and Ultracode share one
`--settings` payload.

Desktop and mobile expose a Claude-only **Mode** selector with Default and
Ultracode options only when the selected Claude model supports xhigh.

## Alternatives Considered

- **Add `ultracode` to shared `EffortLevel`**. Rejected because it would expose
  a Claude-specific session workflow as if it were a provider-neutral effort
  value and would require every non-Claude adapter to reject or ignore it.
- **Model Ultracode as a synthetic Claude model id**. Rejected because the
  upstream CLI treats Ultracode as a session setting layered on top of a real
  model, and users still need to choose the actual Claude model.
- **Inject `/effort ultracode` as prompt text**. Rejected because standard
  `claude --print` already supports direct settings injection, and prompt-text
  slash commands would couple Agent Cockpit to interactive terminal behavior
  instead of the CLI's structured settings mechanism.

## Consequences

- + The shared effort contract remains provider-neutral.
- + Standard and interactive Claude Code use the same persisted selection and
  request contract while preserving their different launch transports.
- + Existing conversations without the field keep current behavior, and
  session reset clears the mode so users do not accidentally carry it into a
  new session.
- - Each client must handle one Claude-specific runtime field alongside model
  and effort.
- ~ Ultracode availability is inferred from `supportedEffortLevels.includes("xhigh")`;
  if Claude changes that capability relationship, the metadata gate must be
  updated.

## References

- [spec-api-endpoints.md](../spec-api-endpoints.md)
- [spec-backend-services.md](../spec-backend-services.md)
- [spec-frontend.md](../spec-frontend.md)
- [spec-mobile-pwa.md](../spec-mobile-pwa.md)
- [ADR-0058: Support Claude Code Interactive through transcript-watched PTY](0058-support-claude-code-interactive-through-transcript-watched-pty.md)
- [ADR-0079: Use harness for CLI profile runtime identity](0079-use-harness-for-cli-profile-runtime-identity.md)
