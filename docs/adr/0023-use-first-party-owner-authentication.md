---
id: 0023
title: Use first-party owner authentication
status: Accepted
date: 2026-05-03
supersedes: []
superseded-by: null
tags: [auth, ios, server, historical]
affects:
  - src/middleware/auth.ts
  - src/services/localAuthStore.ts
  - src/config/index.ts
  - src/types/index.ts
  - scripts/auth-reset.ts
  - package.json
  - public/v2/src/api.js
  - public/v2/src/screens/settingsScreen.jsx
  - public/v2/src/app.css
  - ios/AgentCockpit/Sources/AgentCockpitCore/APIClient.swift
  - ios/AgentCockpit/Sources/AgentCockpitCore/Models.swift
  - ios/AgentCockpit/Sources/AgentCockpitUI/RootView.swift
  - test/auth.test.ts
  - docs/spec-server-security.md
  - docs/spec-api-endpoints.md
  - docs/spec-ios.md
---

## Context

Agent Cockpit's deployment model is one backend per owner. The existing web login used Google OAuth and optional GitHub OAuth, which required every self-hosted backend to carry third-party provider client IDs, secrets, callback URLs, and allowed-email configuration. That model also complicated the native iOS companion app because a primary third-party login flow can trigger App Store login-service requirements, while the actual product model is closer to Home Assistant: a native app connects to a user-selected server and authenticates with that server.

The app is single-user today, so the smallest useful first-party auth model is one local owner account per backend. Passkeys, mobile QR pairing, paired-device management, and recovery codes all need a first-party owner identity to attach to.

## Decision

Agent Cockpit uses a first-party local owner account as the default authentication model. The implementation adds owner setup, password login, recovery codes, passkey-required policy guardrails, local session creation, mobile pairing/device records, and a file-backed auth store at `data/auth/owner.json` using hashed secrets. Third-party OAuth routes are disabled by default and are only available behind the transitional `AUTH_ENABLE_LEGACY_OAUTH=true` flag.

First-run setup is public only for localhost/server-console access. Remote setup requires `AUTH_SETUP_TOKEN`, so an exposed empty backend cannot be claimed without a server-side setup secret.

Mobile authentication continues to use the one-time-code session bridge, but the code can now be issued after first-party password/passkey login as well as legacy OAuth. Mobile pairing uses a backend-issued pairing challenge from an authenticated web session and exchanges it for the same session-cookie/CSRF contract as mobile web login. Future QR scanning will reuse the same backend-owned session contract.

## Alternatives Considered

- **Keep GitHub/Google OAuth as the primary backend login.** Rejected because each self-hosted backend owner would need third-party app registration, secrets, and callback management, and the iOS app would remain coupled to social-login review concerns.
- **Use Sign in with Apple as the shared identity provider.** Rejected as the default because arbitrary user-owned backend domains do not fit Apple's Services ID/domain/return-URL model, and the iOS app should be a companion client for the selected backend rather than a central Apple-auth broker.
- **Use Cloudflare Access as the default auth layer.** Rejected because Cloudflare Tunnel should remain transport/exposure infrastructure; Cloudflare Access would still make the primary app login depend on a third-party auth service.
- **Implement multi-user auth immediately.** Rejected because the product is single-user today and passkey/device/recovery work can be modeled cleanly around one owner first.

## Consequences

- + Self-hosted backends can authenticate without registering OAuth apps.
- + The iOS companion app can connect to user-selected backends using backend-owned auth, matching the Home Assistant-style model.
- + Passkeys, recovery codes, mobile QR pairing, and paired-device admin have a first-party owner identity to build on.
- - We now own password hashing, setup hardening, recovery UX, and lockout prevention.
- - Existing OAuth-only deployments need to create a local owner account before disabling legacy OAuth.
- ~ Legacy OAuth remains available only behind an explicit transitional flag while the migration finishes.

## References

- Refs #256
- [Server Initialization & Security](../spec-server-security.md)
- [API Endpoints](../spec-api-endpoints.md)
- [iOS Native Client](../spec-ios.md)
- [ADR-0022: Bridge mobile OAuth through one-time codes](0022-bridge-mobile-oauth-through-one-time-codes.md)
