# Coding Principles

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
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
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

- Do NOT add `Co-Authored-By: Claude ...` lines in commit messages.
- Do NOT add "Generated with Claude Code" footers in PR bodies.
- Before submitting a PR, always:
  1. Run existing tests and ensure they pass.
  2. Add new tests for any new functionality or endpoints.
  3. Update existing tests if behavior changed.
  4. Update the spec docs to reflect all changes (endpoints, methods, UI behavior, test file list).

# Specification Documents

The project specification lives under `docs/` as a wiki-style collection of markdown files. Start at [`docs/SPEC.md`](docs/SPEC.md) for the index and overview.

- These documents are the **single source of truth** for the project. They must contain every endpoint, data model, behavior, and implementation detail needed to rewrite the project from scratch.
- When making changes to the codebase, always update the relevant spec file(s) to reflect the new state.
- Include maximum detail — spec documents should be precise enough that a developer unfamiliar with the codebase can reimplement any feature from the spec alone.
- The root `SPEC.md` is a thin redirect; all content lives in `docs/`.
