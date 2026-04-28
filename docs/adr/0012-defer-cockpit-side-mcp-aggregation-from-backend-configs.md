---
id: 0012
title: Defer cockpit-side aggregation of backend-local MCP servers
status: Accepted
date: 2026-04-28
supersedes: []
superseded-by: null
tags: [mcp, codex, backends, scope, historical]
affects:
  - src/services/backends/codex.ts
  - src/services/backends/kiro.ts
  - src/services/backends/claudeCode.ts
  - src/routes/chat.ts
  - src/services/memoryMcp/index.ts
  - src/services/kbSearchMcp/index.ts
---

## Context

The cockpit ships its own internal MCP servers — `agent-cockpit-memory` (memory note capture) and `agent-cockpit-kb-search` (knowledge base search) — and injects them into each backend's MCP configuration so the CLI can call them as tools. The mechanism varies per backend: Claude Code via `--mcp-config <file>`, Kiro via `mcpServers` in `session/new` params, Codex via repeated `-c mcp_servers.<name>.…` TOML overrides (see ADR-0005).

Backends *also* support **user-defined MCP servers** — entries the user has put in their own CLI's config (e.g. `~/.codex/config.toml` `[mcp_servers.linear]`, Claude Code's per-project `.mcp.json`, Kiro's user settings). These are real, the user uses them outside the cockpit, and they show up in the CLI's tool catalog when running standalone.

The architectural question: should the cockpit **read those user-defined MCPs from each backend's config and expose them as cockpit-managed entities** — making them visible across backends, persistable in workspace state, surface-able in cockpit UI, and routable across conversation switches?

This came up specifically while shipping the Codex backend. Codex's MCP injection design (ADR-0005) explicitly preserves the user's `~/.codex/config.toml` and detects collisions — the cockpit reads it for collision purposes but does not parse, persist, or surface its `[mcp_servers.*]` entries.

## Decision

**Defer this aggregation.** The cockpit only manages its own MCP servers (`agent-cockpit-memory`, `agent-cockpit-kb-search`). It does **not**:

- Parse user-defined `[mcp_servers.*]` from `~/.codex/config.toml`, Claude Code's `.mcp.json`, or any other backend's user config and surface them in cockpit UI.
- Promote user-defined MCPs from one backend's config into another backend's session (e.g. expose Codex-configured Linear MCP to Claude Code).
- Provide a cockpit-level MCP registry that aggregates user MCPs across all configured backends.

User-defined MCPs **stay local to the backend whose config defined them**. A Linear MCP in `~/.codex/config.toml` is visible to Codex and only Codex; switching that conversation to Claude Code or Kiro mid-thread loses access to Linear unless the user has separately configured it in those backends' configs.

Cockpit's only behavior toward user-defined MCPs is **collision detection during injection**: when injecting `agent-cockpit-memory`, if the user has already defined `[mcp_servers.agent-cockpit-memory]`, the user's wins (we skip ours and warn). This is a defensive read, not aggregation.

## Alternatives Considered

- **Parse each backend's user MCP config and surface it in a cockpit-level "MCP servers" UI.** Rejected for now: each backend's MCP config has a different format (TOML vs JSON vs settings UI), different scoping rules (global vs per-project vs per-session), and different lifecycle expectations. Building a parser per backend, a normalized data model, and a UI atop them is a big lift for a feature whose user need is unclear — most users either set up MCPs uniformly across backends manually or use only one backend.
- **Promote user-defined MCPs from one backend's config into all other backends' sessions.** Rejected: violates the user's expectation that their `~/.codex/config.toml` only affects Codex. It also shifts trust: the user vetted that MCP for Codex's tool-call surface, not for Claude Code's. Promoting silently is a security mis-step.
- **Provide a cockpit-level MCP registry separate from any backend config** (cockpit owns its own list, which it injects into all backends). Rejected for now: this would be cleaner long-term but requires UI, persistence, secret management for MCP env vars, and a story for "the same MCP exists in cockpit's registry AND in the user's backend config — which wins?" Doable but out of scope for the Codex shipping window.
- **Adopt a single MCP standard across all backends and deprecate per-backend MCP config.** Rejected: not in our power. Each backend's MCP config is owned by that backend's team; the cockpit can only work with what's in front of it.
- **Block user-defined MCPs at the backend boundary** (force users to migrate everything into the cockpit's config). Rejected: hostile to the workflow where the user runs the CLI standalone outside cockpit. Standalone CLI use must keep working.

## Consequences

- + The cockpit's MCP responsibility is small and well-defined: inject its own two servers (memory, KB search) into whatever the backend supports. No aggregation logic, no per-backend config parser, no normalized data model.
- + User trust boundaries are preserved. A Linear MCP in `~/.codex/config.toml` is visible only to Codex, exactly as the user configured it.
- + Switching backends mid-conversation has predictable MCP behavior: cockpit's MCPs follow (because cockpit injects them everywhere), backend-local user MCPs do not.
- + The collision-detection pattern (read user config to skip on collision; never write) is a safe minimal interaction — it works with any backend whose user config is plain text we can grep.
- - Users who want one MCP available in every backend must configure it in every backend separately. This is friction we know exists and have explicitly chosen to accept until we have evidence the unified UI is worth the build.
- - "MCP X stopped working when I switched conversations to Claude Code" is a real user-confusing outcome that follows from this decision. The mitigation is documentation: the cockpit explains that user-side MCPs are per-backend, not cockpit-managed.
- - When a future cockpit-level MCP registry is built, this ADR will be superseded — and the migration story will need to handle existing backend-local MCPs (probably leave them in place; cockpit-level ones are additive).
- ~ The decision applies equally to Codex, Kiro, and Claude Code, but the friction is highest for Codex specifically because TOML config feels "least native" relative to the cockpit's JSON-shaped settings UI. If the unified registry ever ships, Codex users probably benefit most.

## References

- ADR-0005 — Codex backend with TOML MCP injection (the *forward* direction: cockpit's MCPs into Codex). This ADR covers the *reverse* direction we deferred.
- Issue #135 — Codex backend integration scope (the original Phase 3 plan included MCP injection; the broader question of cockpit-level MCP aggregation was never in scope and is deferred indefinitely)
- `src/services/memoryMcp/index.ts`, `src/services/kbSearchMcp/index.ts` — the two cockpit-internal MCP servers we *do* manage
