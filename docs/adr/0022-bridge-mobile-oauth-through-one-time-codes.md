---
id: 0022
title: Bridge mobile OAuth through one-time codes
status: Superseded
date: 2026-05-03
supersedes: []
superseded-by: 0026
tags: [ios, auth, oauth, historical]
affects:
  - src/middleware/auth.ts
  - ios/AgentCockpit/Sources/AgentCockpitCore/APIClient.swift
  - ios/AgentCockpit/Sources/AgentCockpitUI/RootView.swift
  - ios/AgentCockpit/App/AgentCockpit/Info.plist
  - docs/spec-ios.md
  - docs/spec-server-security.md
---

## Context

The web app authenticates through server-side Passport OAuth and an `express-session` cookie. That works in a browser because the OAuth callback and API calls share the same browser cookie jar. The native iOS app can launch the same GitHub OAuth flow with `ASWebAuthenticationSession`, but it cannot safely assume the browser authentication session's cookies are available to the app's `URLSession` API client.

Real-device testing also happens through the same public Cloudflare tunnel domain as the web UI, so localhost bypass is not available.

## Decision

The server supports a mobile OAuth completion mode for existing providers. A native app starts GitHub OAuth with `/auth/github?mobile=1`. The existing callback still verifies the same allowed-email policy and then redirects to `agentcockpit://auth/callback?code=<one-time-code>`.

The one-time code is short-lived, single-use, and held server-side with the verified Passport user. The native app exchanges it at `POST /api/mobile-auth/exchange`, where the server calls `req.login()`, creates the normal session cookie and CSRF token, and returns the authenticated user plus CSRF token. After exchange, the native app uses the same REST, WebSocket, session-cookie, and CSRF contracts as the web app.

## Alternatives Considered

- **Assume `ASWebAuthenticationSession` cookies are shared with `URLSession`**: Rejected because this is not a stable contract for the app's API client and would fail unpredictably across session/storage settings.
- **Dev-only bearer token for mobile testing**: Rejected for this slice because it would test a different security model from production and would need to be replaced before App Store or TestFlight-style usage.
- **Embed GitHub OAuth directly in the native app**: Rejected because the server already owns OAuth provider configuration, allowed-email enforcement, sessions, and CSRF.

## Consequences

- + Real iPhone testing works against the same Cloudflare tunnel and GitHub OAuth app as the web UI.
- + The server remains the single auth authority; the native app receives only a short-lived completion code and the normal server session.
- - The native app must register and retain the custom `agentcockpit` callback URL scheme.
- ~ Public App Store distribution with third-party login still requires Sign in with Apple support in addition to GitHub.

## References

- [iOS Native Client](../spec-ios.md)
- [Server Initialization & Security](../spec-server-security.md)
- [ADR-0021](0021-build-ios-as-native-client.md)
