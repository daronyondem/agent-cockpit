---
id: 0026
title: Remove native mobile auth and pairing
status: Proposed
date: 2026-05-04
supersedes:
  - 0022
superseded-by: null
tags: [auth, mobile, pwa]
affects:
  - src/middleware/auth.ts
  - src/services/localAuthStore.ts
  - src/types/index.ts
  - scripts/auth-reset.ts
  - package.json
  - package-lock.json
  - public/v2/src/api.js
  - public/v2/src/screens/settingsScreen.jsx
  - public/v2/src/app.css
  - test/auth.test.ts
  - docs/spec-server-security.md
  - docs/spec-api-endpoints.md
  - docs/spec-frontend.md
  - docs/spec-backend-services.md
  - docs/spec-deployment.md
  - docs/spec-testing.md
  - docs/spec-mobile-pwa.md
  - README.md
  - ONBOARDING.md
---

## Context

ADR-0025 made the mobile PWA the only supported mobile client and removed the SwiftUI and Expo source trees. That left backend auth routes and Settings UI for native-only mobile pairing, one-time mobile auth callbacks, and paired-device revocation.

Those routes no longer match the supported product shape. The PWA is same-origin with the Agent Cockpit backend, so it can use the normal browser-owned `connect.sid` session, CSRF token, and WebSocket contracts. Keeping a separate native pairing/device surface would preserve extra auth behavior, docs, tests, dependencies, and user-facing controls for clients that the repository no longer ships.

## Decision

Remove the native mobile auth bridge and paired-device model from the active product surface.

The server no longer exposes `POST /api/mobile-auth/exchange`, `POST /api/mobile-pairing/challenges`, `POST /api/mobile-pairing/exchange`, `GET /api/mobile-devices`, `DELETE /api/mobile-devices/:id`, or `/auth/mobile-login`. Login, recovery, passkey, and legacy OAuth flows no longer carry `mobile` mode or issue `agentcockpit://` callback codes. The local auth store no longer persists `mobileDevices`, and the reset command no longer accepts `--revoke-mobile-devices`.

The desktop Settings Security tab manages only owner login policy, passkeys, and recovery codes. The PWA continues to authenticate by loading `/mobile/` behind `requireAuth` and using the same web session as `/v2/`.

## Alternatives Considered

- **Keep the native mobile routes undocumented.** Rejected because hidden auth surfaces still require tests, dependencies, and threat-model maintenance.
- **Keep paired-device revocation as a generic session manager.** Rejected because the implementation only tracked native mobile sessions. A future session-management feature should be designed around all browser sessions, not a renamed native-device table.
- **Migrate existing mobile-device records.** Rejected because the SwiftUI and Expo clients are no longer supported. Existing `mobileDevices` fields in `owner.json` are ignored and are dropped the next time auth state is rewritten.

## Consequences

- + The active auth model is simpler: first-party owner sessions, passkeys, recovery codes, optional legacy OAuth, and the normal browser session path for both desktop and mobile PWA.
- + The `qrcode` runtime dependency and native pairing UI are removed.
- + Documentation and tests no longer describe native-only mobile session bootstrap behavior.
- - Previously paired native mobile clients must switch to the PWA at `/mobile/`; there is no compatibility bridge for them.
- - The app still does not provide a general session-management UI for revoking individual browser sessions.

## References

- [ADR-0025: Use mobile PWA as sole mobile client](0025-use-mobile-pwa-as-sole-mobile-client.md)
- [ADR-0022: Bridge mobile OAuth through one-time codes](0022-bridge-mobile-oauth-through-one-time-codes.md)
- [Server Initialization & Security](../spec-server-security.md)
- [API Endpoints](../spec-api-endpoints.md)
- [Mobile PWA Client](../spec-mobile-pwa.md)
