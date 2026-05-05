# Intentional Client Parity Decisions

[← Back to index](SPEC.md)

This register records deliberate differences between the desktop web UI and the mobile PWA. The default expectation is parity: new user-facing behavior should be available in both clients unless a decision here says otherwise.

## Active Decisions

| Date | Feature | Desktop web | Mobile PWA | Decision | Rationale | References |
|------|---------|-------------|------------|----------|-----------|------------|
| 2026-05-04 | CLI update notifications and update actions | Supported in the composer-adjacent dashboard notification and Settings → CLI Config | Not supported | Web-only | Updating local CLI binaries is a server-administration action. The desktop web UI already owns global settings, update/restart controls, and the larger action popover pattern; the mobile PWA remains focused on chat/run control and workspace file access. | [ADR-0027](adr/0027-manage-cli-updates-from-web-cockpit.md), [API spec](spec-api-endpoints.md#3131-cli-updates), [Frontend spec](spec-frontend.md) |
| 2026-05-05 | Codex goal mode | Supported through the composer Goal toggle, `/goal` slash commands, and the goal status strip | Not supported | Web-only for v1 | Goal mode adds a distinct composer send mode and persistent status/actions above the composer. The current mobile PWA remains scoped to chat/run control and workspace file access; it can display normal assistant output from goal runs started elsewhere, but does not fetch or control Codex goal state. Token budget controls are also out of scope for this slice. | [ADR-0032](adr/0032-use-codex-thread-goals-for-goal-mode.md), [API spec](spec-api-endpoints.md#371-codex-goals), [Frontend spec](spec-frontend.md), [Mobile spec](spec-mobile-pwa.md#deferred-slices) |

## Maintenance Rules

- Add an entry when a web feature is intentionally not implemented in the PWA, or when a PWA-only behavior intentionally differs from web.
- Do not use this file for unimplemented backlog. If a feature is merely deferred, keep it in the relevant spec's deferred section.
- Link the ADR when the parity difference follows from an architectural or product decision.
