---
id: 0025
title: Use mobile PWA as sole mobile client
status: Proposed
date: 2026-05-04
supersedes:
  - 0021
superseded-by: null
tags: [mobile, pwa, frontend]
affects:
  - mobile/AgentCockpitPWA
  - public/mobile
  - package.json
  - public/v2/src/screens/settingsScreen.jsx
  - docs/spec-mobile-pwa.md
  - docs/spec-deployment.md
  - docs/spec-testing.md
  - docs/spec-server-security.md
  - docs/spec-api-endpoints.md
  - docs/spec-frontend.md
  - docs/SPEC.md
  - SPEC.md
  - README.md
  - ONBOARDING.md
  - test/frontendRoutes.test.ts
---

## Context

Agent Cockpit evaluated three mobile paths: the native SwiftUI iOS client, an Expo/React Native prototype, and a browser-native PWA. The product is self-hosted and single-user-oriented: a user runs their own Agent Cockpit server and connects their own phone to it.

For that model, native distribution creates avoidable operational cost. SwiftUI requires Xcode signing and repeated sideloading during development. Expo improves iteration, but still introduces Expo Go, EAS, Apple signing, internal distribution, TestFlight, or App Store questions for a client that only connects to the user's own server.

The PWA can use the existing authenticated web origin, REST API, CSRF token flow, and WebSocket stream contracts. It avoids mobile pairing as an app bootstrap mechanism because the browser already owns the authenticated session.

## Decision

Use the mobile PWA as the only supported mobile client. Keep the source under `mobile/AgentCockpitPWA/`, build it with Vite, and emit static assets to `public/mobile/`. The existing Express static mount serves the generated PWA at `/mobile/` after authentication.

Remove the SwiftUI source tree under `ios/AgentCockpit`, the Expo source tree under `mobile/AgentCockpitExpo`, and their active setup/specification docs. The supported mobile installation path is `/mobile/` plus Add to Home Screen.

## Alternatives Considered

- **Keep SwiftUI as a fallback**: rejected because the native app was not the preferred UI/performance direction and retaining it would keep Xcode signing, simulator/device testing, and duplicate implementation work alive.
- **Promote Expo/React Native instead**: rejected because it still leaves native distribution and update infrastructure to own, even for single-user self-hosted installs.
- **Make the desktop V2 UI responsive enough to be the mobile app**: rejected because the desktop shell carries dense desktop-specific surfaces. A dedicated mobile PWA keeps the mobile workflow focused without destabilizing the primary desktop UI.

## Consequences

- + Mobile install/update guidance becomes one path: open `/mobile/` on the server and use the browser's home-screen install flow.
- + The repository no longer carries Swift, Xcode, Expo, React Native, EAS, or native asset maintenance for mobile clients.
- + The PWA shares the server's existing cookie and CSRF model, so no native app pairing bootstrap is needed for supported mobile use.
- - Native-only capabilities remain unavailable or weaker: reliable remote push after the browser context is killed, deeper filesystem integration, and long-running background execution.
- - The generated `public/mobile/` assets must be refreshed when PWA source changes.
- ~ Native mobile auth/pairing APIs are removed by ADR-0026, so previously paired native clients no longer have a supported session bootstrap path.

## References

- [Mobile PWA Client](../spec-mobile-pwa.md)
- [Export, Limitations & Deployment](../spec-deployment.md)
- [Server Initialization & Security](../spec-server-security.md)
- [API Endpoints](../spec-api-endpoints.md)
- [ADR-0026: Remove native mobile auth and pairing](0026-remove-native-mobile-auth-and-pairing.md)
