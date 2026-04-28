---
id: 0010
title: PM2 as the only supported process manager for the cockpit server
status: Accepted
date: 2026-04-28
supersedes: []
superseded-by: null
tags: [process-management, deployment, operations, historical]
affects:
  - CLAUDE.md
  - package.json
  - src/services/updateService.ts
  - docs/spec-backend-services.md
---

## Context

The cockpit server is a long-running Node process (`tsx server.ts`) that holds in-memory state for active streams, WS connections, the keyed mutex, the in-memory digestion counter (ADR-0008), and the WS reconnect grace buffers (ADR-0009). It also exposes a self-update path that needs to restart itself cleanly.

Three concrete failure modes shaped the policy:

1. **Orphan processes from `node`/`tsx server.ts` runs.** Running the server directly leaves a dangling process when the terminal closes or the user Ctrl-Cs the wrong window. The next start collides on the configured `PORT`. Multiple orphans accumulate over a debugging session and the user spends time chasing `lsof | grep :3335`.
2. **No automatic restart on crash.** A bare-`node` process that exits stays exited. The cockpit's whole point is to be ambiently available; an unsupervised crash means the user notices only when they next reach for it.
3. **Self-update needs to outlive its own process.** `updateService.triggerUpdate()` runs `git pull`, `npm install`, and a server restart. The restart has to happen *after* the current process exits, which means it can't be a child of the current process — it would die with the parent. A supervisor (PM2) gives us the "restart this app" primitive that survives the parent exiting.

## Decision

PM2 is the **only supported way to run the cockpit server**. The rule is documented in `CLAUDE.md` so AI assistants don't bypass it:

> **Server Management**
> NEVER run `node server.js` directly. This causes orphan processes and port conflicts.
> Always use pm2:
> - Start: `npx pm2 start ecosystem.config.js`
> - Restart: `npx pm2 restart [sitename]`
> - Stop: `npx pm2 stop [sitename]`
> - Logs: `npx pm2 logs [sitename]`

PM2 is a pinned project dependency (`pm2` in `package.json`), so `npx pm2 …` resolves to the project-local install — no global PM2 required.

The PM2 app definition lives in `ecosystem.config.js` at the repo root. The file is **gitignored** because it carries deployment-specific values (PORT, OAuth client IDs/secrets, callback URLs, `DEFAULT_WORKSPACE`, `BASE_PATH`) that should not live in source control. Each environment maintains its own copy.

`updateService` integrates with PM2 directly:

- `triggerUpdate()` runs `git pull` + `npm install`, **verifies the configured interpreter** (reads `ecosystem.config.js` fresh from disk via `fs.readFileSync` to avoid stale `require` cache; checks path-based interpreters on disk, resolves bare commands via `which`), then delegates to `_launchRestartScript()`.
- `_launchRestartScript()` writes `data/restart.sh` (sets `PATH` to `node_modules/.bin`, sleeps 2 s, then `pm2 delete` + `pm2 start ecosystem.config.js`) and launches it via **double-fork** (`nohup … &` in a subshell) so it survives PM2's treekill of the current process.
- The dirty-tree guard explicitly ignores `ecosystem.config.js` (alongside `data/`, `.env`, `.DS_Store`, `.claude/`, `coverage/`, `plans/`) so a local-only PM2 config doesn't block updates.

## Alternatives Considered

- **Run `node server.ts` (or `tsx server.ts`) directly.** Rejected: produces every failure mode listed in Context. No restart-on-crash, no graceful detach from the terminal, no supervisor for the self-update flow.
- **Use systemd / launchd / Windows Service.** Rejected: OS-specific, requires elevated privileges to install, splits the deployment story across platforms. PM2 runs identically on macOS/Linux/Windows and lives entirely in user-space.
- **Use Docker / Compose.** Rejected: adds a containerization layer for a single Node process. The cockpit is intended to run on the user's own machine (their CLIs are local; their workspace paths are local) — a container would force volume mounts for the workspace, the data directory, OAuth callback URLs, and the per-CLI installs (Claude Code, Kiro, Codex). Far more friction than the problem requires.
- **Use `forever` or `nodemon`.** Rejected: `forever` is mostly unmaintained; `nodemon` is a dev-loop tool, not a production supervisor. PM2 is the active, well-documented choice in this niche.
- **Use Node's built-in `cluster` module for self-restart.** Rejected: `cluster` solves "spawn N workers" not "restart cleanly when this process exits." We'd still need an external supervisor for the crash-recovery and self-update cases.
- **Make `ecosystem.config.js` a tracked file with placeholders.** Rejected: any tracked file with placeholders invites accidental commits of real secrets when someone forgets to template it back. Gitignoring the file makes the contract explicit — every environment is responsible for its own copy. The dirty-tree-guard ignore list keeps this from blocking updates.
- **Spawn the restart via `setTimeout(() => process.spawn(...))` in the same process.** Rejected: doesn't solve the "current process needs to die *first*" requirement. The double-fork-with-nohup pattern is what actually works.
- **Document PM2 as "recommended" but allow direct runs.** Rejected: a soft recommendation gets ignored by AI assistants and by the user under deadline pressure. The hard rule in `CLAUDE.md` (with `NEVER` capitalized) is what made the orphan-process problem stop happening.

## Consequences

- + Crash recovery is automatic. PM2 respawns on unexpected exit.
- + Self-update is reliable. The double-fork restart script survives the parent's death and brings the server back on the new code.
- + No global PM2 install required — `npx pm2 …` resolves to the project-local dependency.
- + The "always use PM2" rule is enforced in `CLAUDE.md`, so AI assistants writing code or running commands respect it without re-litigation.
- + Logs are uniform (`npx pm2 logs <sitename>`) regardless of how the server was started, when it was restarted, or whether the user is on dev or prod.
- - Adds PM2 as a runtime dependency. ~50 MB on disk (PM2 itself plus its deps). Acceptable; PM2 is mature and well-maintained.
- - Each environment maintains its own `ecosystem.config.js` and is responsible for its secrets. A new contributor cloning the repo has to write one (no template is committed to avoid the accidental-secret-commit risk).
- - The double-fork-with-nohup self-update script is non-trivial. If something needs to change about the restart flow, the developer needs to understand why it has to outlive its parent — that's documented in `spec-backend-services.md` (see `_launchRestartScript`).
- - PM2 is opinionated about logs (`~/.pm2/logs/`) and process metadata (`~/.pm2/`). A user who's never seen PM2 has to learn `pm2 list`, `pm2 logs`, `pm2 restart` to operate the cockpit. The `CLAUDE.md` block lists the four commands they actually need.
- ~ The interpreter-verification step in `triggerUpdate()` (read `ecosystem.config.js` fresh, check the path or PATH-resolve the interpreter) is necessary because `require`-cached config would mask a bad-interpreter change made out of band. It looks paranoid but exists to catch real edit-the-pm2-config-then-update sequences.

## References

- CLAUDE.md — `Server Management` section (the rule itself)
- `src/services/updateService.ts` — the self-update integration that depends on PM2 being the supervisor
- `docs/spec-backend-services.md` — `triggerUpdate` / `_launchRestartScript` documentation
- PM2 docs — https://pm2.keymetrics.io/docs/
