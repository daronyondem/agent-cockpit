# Server Management

NEVER run `node server.js` directly. This causes orphan processes and port conflicts.

Always use pm2:
- Start: `npx pm2 start ecosystem.config.js`
- Restart: `npx pm2 restart agent-cockpit-dev`
- Stop: `npx pm2 stop agent-cockpit-dev`
- Logs: `npx pm2 logs agent-cockpit-dev`

This is the **dev** instance running on port 3335 (`chat-dev.dytunnel.work`).
The production instance runs separately from `/Users/daronyondem/Sites/agent-cockpit` on port 3334.

# Commits & PRs

- Do NOT add `Co-Authored-By: Claude ...` lines in commit messages.
- Do NOT add "Generated with Claude Code" footers in PR bodies.
