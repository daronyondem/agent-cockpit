---
id: 0031
title: Treat AGENTS as the cross CLI instruction hub
status: Accepted
date: 2026-05-05
supersedes: []
superseded-by: null
tags:
  - cli
  - instructions
  - workspace
affects:
  - src/services/chatService.ts
  - src/routes/chat.ts
  - public/v2/src/shell.jsx
  - public/v2/src/api.js
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-frontend.md
  - README.md
---

## Context

Agent Cockpit supports multiple local CLI vendors, but each vendor discovers project instructions through a different file convention. Claude Code reads `CLAUDE.md`, Kiro reads steering files under `.kiro/steering/`, and Codex-compatible agents use `AGENTS.md` as the vendor-neutral project instruction file.

When a workspace has instructions for only one vendor, switching the conversation to another supported CLI can silently drop the user's project guidance. Copying content across vendor files would avoid the immediate drop, but the copies would drift and make it unclear which file is authoritative.

## Decision

Agent Cockpit treats `AGENTS.md` as the preferred cross-CLI instruction hub and uses vendor-specific files as thin compatibility entrypoints.

The workspace compatibility check detects:

- `AGENTS.md` for Codex/vendor-neutral agents
- `CLAUDE.md` for Claude Code
- any `*.md` under `.kiro/steering/` for Kiro

When at least one source exists and one or more supported vendor entrypoints are missing, the desktop composer shows an actionable warning icon. The one-click action creates only missing pointer files and never overwrites existing user-authored instruction files.

If `AGENTS.md` is missing but a vendor-specific source exists, Agent Cockpit creates an `AGENTS.md` pointer first, then points missing vendor files at `AGENTS.md`. This makes future compatibility additions converge on a single neutral hub instead of chaining vendor files together.

## Alternatives Considered

- **Duplicate instruction content into every vendor file**. Rejected because copies drift and users cannot tell which file is canonical.
- **Pairwise pointers between vendor files**. Rejected because adding more vendors creates chains such as Kiro -> Claude -> AGENTS or cycles if users already have imports in place.
- **Only support the existing `CLAUDE.md` / Kiro steering sync**. Rejected because Codex support makes this a general multi-vendor compatibility problem, not a two-vendor bridge.

## Consequences

- + Users can switch supported CLI vendors without silently losing project-level guidance.
- + Existing instruction investments stay in place; Agent Cockpit creates compatibility pointers instead of rewriting or copying them.
- + Future CLI adapters can add a native entrypoint while still converging on `AGENTS.md` as the neutral hub.
- - Pointer files add visible repo files that users may need to review or commit.
- ~ The compatibility check is filesystem-based and runs on demand; it does not watch the workspace for live instruction-file changes.

## References

- Refs #171
- [API endpoints spec](../spec-api-endpoints.md#311-workspace-instructions)
- [Backend services spec](../spec-backend-services.md)
- [Data models spec](../spec-data-models.md#cli-instruction-compatibility-status)
- [Frontend spec](../spec-frontend.md)
