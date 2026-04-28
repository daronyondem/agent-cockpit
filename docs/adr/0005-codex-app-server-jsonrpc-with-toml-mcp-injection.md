---
id: 0005
title: Codex backend over `codex app-server` JSON-RPC with TOML MCP injection
status: Accepted
date: 2026-04-28
supersedes: []
superseded-by: null
tags: [backends, codex, mcp, transport, historical]
affects:
  - src/services/backends/codex.ts
  - test/codexBackend.test.ts
  - docs/spec-backend-services.md
---

## Context

After Claude Code (direct Anthropic API) and Kiro (ACP/JSON-RPC over Bedrock), OpenAI Codex was the third CLI backend to integrate. Codex ships two transports: a one-shot `codex exec` for non-interactive runs, and a long-lived `codex app-server` that speaks JSON-RPC 2.0 over stdio for interactive turns. Both share the same on-disk state under `~/.codex/` — auth credentials, session rollouts, plugins, and MCP server configuration in `config.toml`.

The cockpit needed a Codex adapter that:

1. **Streams** chat turns (text deltas, reasoning/thinking deltas, tool activity), since `runOneShot`-only would not satisfy the chat path.
2. **Survives server restarts.** A user mid-conversation should be able to redeploy the cockpit and resume the same Codex thread without losing context.
3. **Injects cockpit-managed MCP servers** so Codex can talk to the cockpit's KB, memory, and other internal MCPs — without forcing the user to manually edit their personal `~/.codex/config.toml` (and without surprising them by mutating it).
4. **Doesn't quietly hijack the user's Codex installation.** A user who runs `codex` standalone should see the same auth, sessions, and threads as inside cockpit — no parallel sandbox.

The third point is load-bearing. Codex's MCP configuration lives in `[mcp_servers.<name>]` sections of `~/.codex/config.toml`. Cockpit needs to register its own MCP servers per-conversation, but it has no business persisting them in the user's permanent config.

## Decision

Use **`codex app-server` over JSON-RPC** for chat (streaming) and **`codex exec`** for one-shots (`runOneShot`, `generateTitle`, `generateSummary`). Do **not** use any HTTP/SDK path to OpenAI directly.

For the app-server lifecycle:

- **Lazy spawn per conversation.** First message on a conversation spawns its own `codex app-server` child process; idle conversations don't run a process at all.
- **Idle timeout (`CODEX_IDLE_TIMEOUT_MS`, default 10 min).** The process is killed (SIGTERM, then SIGKILL after 1 s grace) after no activity. The next message respawns and uses `thread/resume` to reattach the same Codex thread.
- **`thread/resume` for continuity.** Conversation → Codex thread mapping is persisted by cockpit so that respawns (idle timeout, server restart, MCP-set change) reattach instead of starting fresh.
- **Auto-approve command/file/permissions requests** as they arrive on the JSON-RPC channel. The cockpit's chat surface is the user's interactive shell into Codex; defer-to-UI prompting would be redundant.
- **Dynamic model discovery.** On adapter construction, spawn a transient `codex app-server` to query `model/list` and replace the hardcoded fallback (`gpt-5.5`, `gpt-5.5-codex`, `gpt-5.5-mini`) with whatever the running CLI advertises. The OpenAI lineup churns enough that authoritative discovery beats hardcoding.

For MCP injection, **pass cockpit-managed servers as repeated `-c mcp_servers.<name>.{command,args,env}=…` TOML override flags on the `codex app-server` invocation**. The user's `~/.codex/config.toml` is **never edited**.

- Read the user's `config.toml` only for **collision detection.** If the user has defined `[mcp_servers.<name>]` matching one cockpit would inject, the user's definition wins; cockpit skips the injection and logs a warning.
- Hash the cockpit's MCP set (sorted, sha1, 12-char prefix). When the set changes mid-conversation, **respawn the app-server** with the new flags — TOML overrides are bound at process start.
- Use `codex exec`'s `-c` flag the same way for one-shot calls that need MCP context (currently none, but the helper is symmetric).

## Alternatives Considered

- **Use OpenAI's official SDK over HTTPS directly.** Rejected: bypasses Codex's local features (auth lives in `~/.codex/auth.json`, session rollouts under `~/.codex/sessions/`, plugins, the user's `[mcp_servers.*]`). The user would have to authenticate twice (once with their `codex` CLI, once with cockpit), and threads opened in cockpit would be invisible to standalone `codex` runs. Going through `app-server` keeps cockpit a frontend over the user's existing Codex install.
- **Use `codex exec` for everything (no app-server).** Rejected: `codex exec` is one-shot — it can't stream, can't deliver tool-activity events as they happen, and starts a fresh thread each invocation. Fine for title/summary generation, useless for chat.
- **Redirect `CODEX_HOME` to a cockpit-controlled directory** (the obvious "isolation" path). Rejected: `CODEX_HOME` redirects everything — auth, session rollouts, plugins, *and* MCP config. After a respawn, `thread/resume` would fail because the new process can't find the previous thread's rollout file. The user's standalone `codex` would also be blind to cockpit's threads. We chose precision (only override MCP) over isolation.
- **Edit the user's `~/.codex/config.toml` to inject MCP servers, then revert on shutdown.** Rejected: invasive, leaves persistent state if cockpit crashes mid-edit, and creates a "what if the user is editing it concurrently?" race. TOML override flags are scoped to the process and cost zero on shutdown.
- **Spawn one `codex app-server` per turn.** Rejected: loses thread continuity (each turn starts fresh), wastes startup time, and breaks Codex's own session-rollout model. One process per conversation, lazily spawned, kept alive across turns, and respawned only on idle timeout or MCP-set change is the right granularity.
- **Keep the app-server alive forever per conversation (no idle timeout).** Rejected: a conversation untouched for hours holds an OpenAI process and its open file handles for nothing. Idle-timeout + `thread/resume` is the right tradeoff — invisible to the user, frees resources at rest.
- **Surface command/file approval prompts to the user.** Rejected for now: Codex is running locally on the user's behalf at the user's request. Approval prompts in the cockpit chat surface would interrupt the conversation flow and there's no UX surface designed for them. Auto-approve matches the contract the user already accepted by running `codex` standalone.
- **Hardcode the model list.** Rejected: OpenAI's model lineup churns. The hardcoded fallback exists only for the brief window before `model/list` returns and as a degradation when the CLI is missing — never as the long-term source of truth.
- **Defer the Codex backend until MCP injection is solved by upstream Codex.** Rejected: the TOML override approach works today, requires no upstream changes, and is reversible if Codex ever introduces a first-class injection mechanism. See ADR-0012 for the related decision to defer cockpit MCP integration as a *consumer* of Codex.

## Consequences

- + Cockpit is a true frontend over the user's `codex` install: same auth, same sessions, same threads visible from both surfaces. No parallel sandbox.
- + `thread/resume` makes server restarts and idle timeouts invisible to the user — the conversation continues from where it left off.
- + Per-conversation MCP injection without ever mutating `~/.codex/config.toml`. The user's personal config is read-only from cockpit's perspective.
- + Lazy spawn means idle conversations have zero process cost. Active ones get their own dedicated process so failures stay isolated.
- + Streaming (text, reasoning/thinking, tool activity) works because the JSON-RPC channel is bidirectional and notification-driven, mirroring the same shape Kiro's ACP path uses.
- - The adapter is the most complex of the three backends: lifecycle (spawn/idle/respawn), JSON-RPC client (request/response correlation, notification routing), MCP injection (TOML escaping, collision detection, hash-based change detection), tool dispatch (item-type-based, not tool-name-based), dynamic model discovery. ~1000 lines vs ~400 for Claude Code.
- - Respawning the app-server on MCP-set change loses any in-flight turn's tool state. We accept this — MCP-set changes mid-turn are rare and the alternative (waiting for the turn to settle before respawning) blocks the user's next message.
- - Auto-approving command/file/permissions requests means a malicious prompt could ask Codex to execute arbitrary shell or write arbitrary files on the user's machine. This matches the contract of running `codex` standalone, but cockpit makes it easier to be exposed to that risk because the prompts are coming from chat. Mitigated by the same trust boundary as Claude Code's tools.
- ~ TOML overrides are bound at process start, so any change to the cockpit's MCP set requires a full app-server respawn. This is fine for the cockpit's current MCP volatility (changes are rare, tied to admin actions) but would become awkward if MCP enablement ever moved to a per-message setting.
- ~ Codex's app-server protocol is partially documented; some behaviors (e.g. the multi-agent thread routing of `turn/steer`) were verified by capturing raw JSON-RPC traffic during real turns. The hand-typed protocol subset in `codex.ts` is the minimum we use; the full surface is generated by `codex app-server generate-ts` if needed.

## References

- PR #201 — `feat: add OpenAI Codex backend` (the implementation)
- Issue #135 — Codex backend feature request
- ADR-0003 — Kiro adapter encapsulation (the same pattern Codex follows for its protocol quirks)
- ADR-0004 — `extractMemory` hook on `BaseBackendAdapter` (which Codex adapter inherits but doesn't yet implement)
- ADR-0012 — Defer cockpit-side MCP integration *for* Codex (the inverse direction: cockpit consuming Codex's MCP, not Codex consuming cockpit's)
