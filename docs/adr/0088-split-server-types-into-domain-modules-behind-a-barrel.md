---
id: 0088
title: Split server types into domain modules behind a barrel
status: Accepted
date: 2026-06-10
supersedes: []
superseded-by: null
tags: [maintainability, types]
affects:
  - src/types/index.ts
  - src/types/attachments.ts
  - src/types/backends.ts
  - src/types/chat.ts
  - src/types/cliEvents.ts
  - src/types/cliProfiles.ts
  - src/types/config.ts
  - src/types/conversations.ts
  - src/types/goals.ts
  - src/types/http.ts
  - src/types/install.ts
  - src/types/knowledgeBase.ts
  - src/types/memory.ts
  - src/types/sessionRecovery.ts
  - src/types/settings.ts
  - src/types/streams.ts
  - src/types/tools.ts
  - src/types/usage.ts
  - src/types/workspaceContext.ts
  - src/types/workspaces.ts
  - src/types/wsFrames.ts
  - scripts/check-maintainability.js
  - AGENTS.md
  - docs/agent-project-memory.md
  - docs/spec-data-models.md
  - docs/spec-backend-services.md
---

## Context

`src/types/index.ts` had grown into a 2,277-line declaration file covering
usage, chat messages, conversations, settings, stream events, Memory, KB,
backend adapters, installer/update state, WebSocket frames, and raw CLI event
shapes. It contained no runtime code, and import sites already used
`import type`, but the single file made ownership and dependency direction hard
to see.

Existing callers import the stable `../types` barrel from 121 server and test
sites. Four contract files also import selected server-only types from exactly
`../types`; `scripts/check-maintainability.js` intentionally blocks contract
imports from deep server paths. Browser clients consume browser-safe contracts
instead of reaching into `src/types`.

The split needs to improve maintainability without changing runtime behavior,
moving wire contracts, or forcing a broad import rewrite.

## Decision

Split server-only declarations into focused domain modules under `src/types/`
and reduce `src/types/index.ts` to a pure `export type *` barrel. Existing
imports from `../types` stay supported. Contracts continue to import only the
barrel when they need these server model types; deep `src/types/*` imports from
contracts remain disallowed.

The domain modules are declaration-only. They may import only sibling type
modules, Express type packages needed for HTTP/session augmentation, or focused
contract types where the pre-existing boundary already points that way. The
modules follow a level-ordered dependency graph:

- Leaf domains: usage, CLI profiles, tools, attachments, goals, session
  recovery, Memory, KB, raw CLI events, config, and HTTP.
- Workspace Context and install/update types depend only on leaf domains.
- Stream events, settings, chat messages, backend adapters, conversations,
  WebSocket frames, and workspace index types build on those lower-level
  domains.

Add a maintainability check that regular `src/types/*.ts` files stay
declaration-only and avoid importing server services, routes, utilities, or
frontend code. Runtime validators and browser-safe request/response contracts
remain in `src/contracts/`.

## Alternatives Considered

- **Rewrite all import sites to deep domain modules**: Rejected because the
  current barrel is a stable seam for routes, services, tests, and contracts.
  Rewriting every caller would add churn without improving runtime behavior.
- **Move shared-looking shapes into `src/contracts/`**: Rejected because
  contracts are wire and validator boundaries. Several browser-visible shapes
  are intentionally duplicated in contracts per ADR-0051 rather than importing
  broad server model types.
- **Introduce TypeScript path aliases**: Rejected because the project uses
  Node16 resolution without aliases. Aliases would add build/tooling surface for
  a split that relative type-only imports can express directly.
- **Keep one large `src/types/index.ts` file**: Rejected because it hides
  ownership and makes future additions more likely to accumulate in the barrel
  instead of the relevant domain.

## Consequences

- + Type ownership is visible by file, while the existing `../types` import
  surface remains stable.
- + The maintainability check makes the declaration-only rule explicit and
  catches accidental service/runtime imports into `src/types`.
- + The Express session augmentation still lives in one included TypeScript
  module, preserving project-wide `req.session` typing.
- - Adding a new server model type now requires choosing the right domain file
  instead of appending to the barrel.
- ~ Deep domain imports are available for server code when useful, but the
  barrel remains supported indefinitely for existing import sites and contracts.

## References

- Refs #429.
- [ADR-0051: Adopt shared contracts and logging foundations](0051-adopt-shared-contracts-and-logging-foundations.md)
- [Data Models & File Structure spec](../spec-data-models.md)
- [Backend Services spec](../spec-backend-services.md)
