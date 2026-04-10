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
