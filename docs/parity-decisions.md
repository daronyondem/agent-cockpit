# Intentional Client Parity Decisions

[← Back to index](SPEC.md)

This register records deliberate differences between the desktop web UI and the mobile PWA. The default expectation is parity: new user-facing behavior should be available in both clients unless a decision here says otherwise.

## Active Decisions

| Date | Feature | Desktop web | Mobile PWA | Decision | Rationale | References |
|------|---------|-------------|------------|----------|-----------|------------|
| 2026-05-14 | Workspace Git Changes status/diff view | Supported in Files Browser → Changes with side-by-side base vs working-tree diff | Not supported | Web-only | The first shipped slice is a code-review surface optimized for wide desktop panes. The mobile PWA keeps the existing workspace file explorer until a compact mobile diff design is specified. | [API spec](spec-api-endpoints.md#313-workspace-git-changes), [Frontend spec](spec-frontend.md), [Mobile spec](spec-mobile-pwa.md#deferred-slices) |
| 2026-05-04 | CLI update notifications and update actions | Supported in the composer-adjacent dashboard notification and Settings → CLI Config | Not supported | Web-only | Updating local CLI binaries is a server-administration action. The desktop web UI already owns global settings, update/restart controls, and the larger action popover pattern; the mobile PWA remains focused on chat/run control and workspace file access. | [ADR-0027](adr/0027-manage-cli-updates-from-web-cockpit.md), [API spec](spec-api-endpoints.md#3141-cli-updates), [Frontend spec](spec-frontend.md) |

## Maintenance Rules

- Add an entry when a web feature is intentionally not implemented in the PWA, or when a PWA-only behavior intentionally differs from web.
- Do not use this file for unimplemented backlog. If a feature is merely deferred, keep it in the relevant spec's deferred section.
- Link the ADR when the parity difference follows from an architectural or product decision.
