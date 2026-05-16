# Agent Instructions

This file is the canonical project guidance for coding agents working in this repository. Keep it vendor-neutral when possible; use tool-specific files such as `CLAUDE.md` only as compatibility shims or for genuinely tool-specific notes.

Project memory that should persist across agents is mirrored in
[`docs/agent-project-memory.md`](docs/agent-project-memory.md). Read it when
work touches installer/updater/release behavior, CLI profiles, mobile PWA,
Context Map, Memory, KB, or cross-agent workflow. When durable memory records a
recurring project rule, update that document and this file if the rule changes
agent workflow.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" -> "Write tests for invalid inputs, then make them pass"
- "Fix the bug" -> "Write a test that reproduces it, then make it pass"
- "Refactor X" -> "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
3. [Step] -> verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

# Maintainability Boundaries

Follow ADR-0051 for shared contracts, logging, and ownership boundaries.

- Keep public facades stable. `ChatService` and `ContextMapService` should remain orchestration/facade entrypoints; new persistence, parsing, normalization, scoring, source-planning, or policy logic should live in focused modules under the owning domain directory.
- For ChatService work, prefer focused modules under `src/services/chat/` for artifacts, usage ledgers, workspace feature settings, message queues, workspace instructions, and similar private stores. Preserve existing storage formats and migrations unless the task explicitly changes them.
- For Context Map work, keep `src/services/contextMap/service.ts` as the coordinator. Put source discovery/planning in `sourcePlanning.ts`, candidate primitives in `candidatePrimitives.ts`, safe auto-apply policy in `autoApply.ts`, JSON extraction/repair in `jsonRepair.ts`, and run/synthesis metadata in `pipelineMetadata.ts`.
- Put shared request/response shapes and runtime validators in `src/contracts/` whenever routes, clients, tests, or specs need the same boundary. Contract files imported by web or mobile must stay browser-safe and must not import server-only modules.
- Web and mobile clients should import shared types only from browser-safe contracts. Do not reach into backend services, route modules, filesystem helpers, or server-only types from frontend code.
- Keep large UI entrypoints as composition layers. Move pure projection, parsing, state-provider, viewport, and formatting behavior into focused modules or hooks with direct tests.
- Prefer behavior-oriented frontend tests for parsing, projection, state updates, and user-visible outcomes. Use source-string/static tests only for route registration, build guards, or import-boundary checks where runtime coverage is impractical.
- Use `src/utils/logger.ts` for backend logging in touched code. Do not add new backend `console.*` calls unless the file is an intentional CLI/test/build script or already documented as an allowed exception.
- When adding or changing an ownership boundary, update the relevant spec docs and add focused tests for the new module instead of only testing through the largest facade.
- Before opening a PR, run `npm run maintainability:check` and `npm run spec:drift` in addition to the existing required verification commands.

# Claude Code Interactive Compatibility

Claude Code Interactive depends on private Claude CLI terminal and transcript behavior. Any change to its protocol implementation must evaluate and update the real-Claude compatibility suites:

- Review `test/claudeCodeInteractive.e2e.test.ts` whenever touching `src/services/backends/claudeCodeInteractive.ts`, `claudeInteractivePty.ts`, `claudeInteractiveTerminal.ts`, `claudeInteractiveHooks.ts`, `claudeTranscriptEvents.ts`, `claudeTranscriptTailer.ts`, Claude Code profile protocol resolution, or Claude CLI update/compatibility warnings.
- Review `test/e2e/claudeCodeInteractive.ui.pw.ts` whenever touching the Claude Code Interactive composer/profile UI, reset/abort flow, or browser stream rendering. Keep this Playwright suite aligned with user-visible protocol behavior.
- Keep the suites aligned with the behavior being changed. Add or adjust real-CLI scenarios when changing prompt submission, PTY lifecycle, hook handling, transcript parsing, tool mapping, goal handling, abort cleanup, browser composer/profile selection, reset, or version compatibility.
- For Claude CLI version compatibility checks on a dev machine, run `npm run e2e:claude-interactive:report` and `npm run e2e:claude-interactive-ui:report` with an authenticated real `claude` CLI. These suites are intentionally not part of normal CI and should not be replaced with mocks for version-drift validation.

# Server Management

NEVER run `node server.js` directly. This causes orphan processes and port conflicts.

Always use pm2:
- Start: `npx pm2 start ecosystem.config.js`
- Restart: `npx pm2 restart [sitename]`
- Stop: `npx pm2 stop [sitename]`
- Logs: `npx pm2 logs [sitename]`

# Commits & PRs

- Use the GitHub CLI (`gh`) for GitHub interactions: creating PRs, reading PR/issue state, commenting, requesting reviews, applying labels, and checking CI. Use local `git` for local repository operations such as status, diff, branch, add, commit, and push.
- Do not use GitHub web/API connectors for normal repository work unless `gh` cannot perform the required action or the user explicitly asks for a different tool.
- Submit normal ready-for-review pull requests. Do not create draft PRs unless the user explicitly asks for a draft.
- All commits, PRs, issue comments, and other GitHub-visible activity must be authored as Daron Yondem using the configured local git/GitHub account.
- Do NOT mention AI assistants, agents, automation, or generated output in commit messages, PR bodies, issue comments, branch names, or release notes.
- Do NOT add tool-generated co-author lines in commit messages.
- Do NOT add generated-by footers in PR bodies.
- Do NOT add `Co-Authored-By: Claude ...` lines in commit messages.
- Do NOT add "Generated with Claude Code" footers in PR bodies.
- **Never use auto-closing keywords (`Closes`, `Fixes`, `Resolves`) for an issue unless the user has explicitly said the PR fully resolves it.** Default to non-closing references (`Refs #N`, `Re #N`, or just `#N`). This repo uses merge commits, so the keyword in any individual commit message lands on `main` verbatim and closes the issue on merge - fixing only the PR body is not enough. When in doubt, ask whether the issue should close on merge.
- Before submitting a PR, always:
  1. Run existing tests and ensure they pass.
  2. Add new tests for any new functionality or endpoints.
  3. Update existing tests if behavior changed.
  4. Evaluate mobile PWA impact. For every feature or behavior change, explicitly consider whether `mobile/AgentCockpitPWA`, `public/mobile`, mobile UX, PWA metadata, tests, or specs need updates.
  5. Update the spec docs to reflect all changes (endpoints, methods, UI behavior, test file list).
  6. Evaluate whether `AGENTS.md` needs updates. If the change introduces or changes a recurring architecture convention, ownership boundary, verification command, or agent workflow, update `AGENTS.md` in the same PR.

# Releases

- Before triggering the production release workflow, follow [`docs/release-workflow.md`](docs/release-workflow.md).
- Installer, release packaging, install-state, install-doctor, and self-update changes must preserve existing macOS production behavior. When a change targets Windows or another platform, explicitly verify the macOS-compatible path with focused tests such as `test/macosInstallerScript.test.ts`, `test/releasePackage.test.ts`, and relevant `test/updateService.test.ts` coverage, or document why a macOS check was unavailable.
- Windows Claude/Codex CLI detection and launch fixes must prefer installer-managed package entrypoints under `<installDir>\cli-tools` before npm `.cmd` shim fallbacks, use the shared Windows runtime resolver across backend/auth/doctor/update paths, and keep the macOS direct-command path unchanged.
- Release preparation is agent-owned: generate `docs/releases/v<version>.md` from commits, merged PRs, closed issues, and code changes between release versions, then share it with the human for review.
- Use [`docs/release-notes-prompt.md`](docs/release-notes-prompt.md) when generating the per-release document. Do not ask the human to draft release notes from scratch.
- Validate the GitHub Release body with `npm run release:notes -- --version <version> --out /tmp/agent-cockpit-release-notes.md` before triggering `.github/workflows/release.yml`.

# Specification Documents

The project specification lives under `docs/` as a wiki-style collection of markdown files. Start at [`docs/SPEC.md`](docs/SPEC.md) for the index and overview.

- These documents are the **single source of truth** for the project. They must contain every endpoint, data model, behavior, and implementation detail needed to rewrite the project from scratch.
- When making changes to the codebase, always update the relevant spec file(s) to reflect the new state.
- Include maximum detail - spec documents should be precise enough that a developer unfamiliar with the codebase can reimplement any feature from the spec alone.
- The root `SPEC.md` is a thin redirect; all content lives in `docs/`.

# Architecture Decision Records (ADRs)

Decisions about *why* the system is shaped the way it is live in [`docs/adr/`](docs/adr/README.md). SPEC documents describe *what is true now*; ADRs describe *why we chose this and what we rejected*. See [ADR-0001](docs/adr/0001-record-architecture-decisions.md) for the practice itself.

## When to write an ADR

Before opening any PR, evaluate whether it warrants an ADR. Write one if **at least one** of these applies:

- Hard to reverse (data model, public API, dependency choice, build system)
- Crosses multiple subsystems
- The obvious choice was rejected
- Sets a pattern future PRs will follow

**Skip otherwise**: routine bug fixes, small features inside one module, formatting changes, version bumps, dependency patch bumps, documentation-only changes, test-only changes.

When in doubt, lean toward writing one - but keep the bar honest. Over-writing produces noise.

## How to write one

1. `npm run adr:new -- "Short title in present tense"` - scaffolds the file with the next sequential ID and the standard frontmatter.
2. Fill the sections: **Context**, **Decision**, **Alternatives Considered**, **Consequences**, **References**. Keep it concise - a tight ADR is more useful than a thorough one nobody reads.
3. Set `tags` and populate `affects` with code paths and docs whose existence depends on this decision (lint validates each path exists).
4. Update relevant SPEC sections to reflect the new state, and cross-link them to the ADR. SPEC says *what*; ADR says *why*. Do not duplicate.
5. Commit alongside the implementation in the same PR branch - the ADR is part of the PR, not a follow-up.
6. Set `status: Proposed` if you want to leave room for the maintainer to push back; default to `Accepted` once you and the maintainer agree on the direction.

## Rules

- Filename pattern: `NNNN-kebab-title.md` (zero-padded sequential ID).
- Status lifecycle: `Proposed` -> `Accepted` (on merge) -> optionally `Deprecated` or `Superseded` later.
- Once `Accepted`, content is immutable. Only `status` and `superseded-by` may change. Reversing or revising = a new ADR that supersedes the old.
- Do **not** edit `docs/adr/README.md`. CI regenerates it from frontmatter on every PR touching `docs/adr/**`.
- The lint job (`npm run adr:lint`) validates frontmatter, filename, status/superseded-by rules, required sections, and that every path in `affects:` exists. Run it before pushing if you want fast feedback.
