# Agent Instructions

This file is the canonical project guidance for coding agents working in this repository. Keep it vendor-neutral when possible; use tool-specific files such as `CLAUDE.md` only as compatibility shims or for genuinely tool-specific notes.

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
  4. Update the spec docs to reflect all changes (endpoints, methods, UI behavior, test file list).

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
