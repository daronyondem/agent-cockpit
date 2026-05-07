---
id: 0036
title: Represent Codex Fast mode as a service tier
status: Accepted
date: 2026-05-06
supersedes: []
superseded-by: null
tags: [codex, backend, frontend, mobile-pwa, data-model]
affects:
  - src/types/index.ts
  - src/services/backends/base.ts
  - src/services/backends/codex.ts
  - src/services/chatService.ts
  - src/services/settingsService.ts
  - src/routes/chat.ts
  - public/v2/src/streamStore.js
  - public/v2/src/shell.jsx
  - public/v2/src/screens/settingsScreen.jsx
  - mobile/AgentCockpitPWA/src/App.tsx
  - mobile/AgentCockpitPWA/src/api.ts
  - mobile/AgentCockpitPWA/src/types.ts
  - docs/spec-data-models.md
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
  - docs/spec-testing.md
  - test/codexBackend.test.ts
  - test/chatService.conversations.test.ts
  - test/chat.rest.test.ts
---

## Context

Codex Fast mode is a runtime service tier for Codex, not a distinct model id. Treating it as a model such as `gpt-5.5-fast` would make the cockpit store and send a model name that Codex does not expose as a normal catalog entry.

Agent Cockpit also needs this choice in the same places users already choose Codex runtime shape: a conversation picker, a global default for new conversations, one-shot calls such as OCR, durable stream jobs, goal-mode starts, and the mobile PWA.

## Decision

Agent Cockpit stores Codex Fast mode as an optional service-tier override.

The only persisted value is `serviceTier: "fast"` on a conversation or `defaultServiceTier: "fast"` in global settings. Absence means the selected Codex profile/config decides the tier. REST write paths accept `"fast"` to force Fast and `null`, `""`, or `"default"` to clear the override. Non-Codex runtime selections drop the stored service tier.

The Codex adapter maps `serviceTier: "fast"` to CLI config overrides: `-c service_tier="fast"` and `-c features.fast_mode=true`. The same mapping is used for `codex app-server` and `codex exec`. The app-server process cache key includes the service tier so switching a conversation between Default and Fast respawns the Codex process with the right config.

Desktop and mobile expose this as a Codex-only Speed control with Default and Fast choices. Goal-mode starts use the same effective service tier as normal sends.

## Alternatives Considered

- **Expose Fast as a model alias**: Rejected because it invents a model id and would pollute model selection, settings, and stored conversation records with a value Codex does not report as a model.
- **Require users to edit Codex config.toml globally**: Rejected because it prevents per-conversation control and hides the active speed tier from the cockpit UI.
- **Persist a `standard` or `default` tier**: Rejected because current runtime behavior only needs an override. Absence already represents "use the selected profile/config"; storing a second value would create extra migration and UI states without adding capability.

## Consequences

- + Model selection remains limited to real backend model ids.
- + Fast mode can be set globally for new Codex conversations or per conversation.
- + One-shot Codex calls, normal sends, and goal starts use the same runtime tier semantics.
- + Desktop and mobile stay in parity for Codex speed selection.
- - Changing the service tier for a live Codex conversation requires respawning that conversation's app-server process.
- ~ The field is intentionally Codex-specific; other adapters ignore it and the chat service clears it when switching away from Codex.

## References

- `docs/spec-data-models.md` Settings and ConversationEntry fields.
- `docs/spec-api-endpoints.md` conversation, message, settings, and goal endpoints.
- `docs/spec-backend-services.md` Codex Fast service-tier mapping.
- `docs/spec-frontend.md` desktop composer and Settings controls.
- `docs/spec-mobile-pwa.md` mobile run settings.
