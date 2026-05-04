---
id: 0021
title: Build iOS as native client
status: Superseded
date: 2026-05-02
supersedes: []
superseded-by: 0025
tags: [mobile, ios, historical]
affects:
  - ios/AgentCockpit
  - docs/spec-ios.md
  - docs/spec-testing.md
  - docs/SPEC.md
---

## Context

Agent Cockpit's existing implementation is a web app backed by a Mac-hosted Node/Express server. The server owns local CLI process spawning, workspace-scoped persistence, first-party owner authentication, CSRF, WebSocket stream replay, Memory, Knowledge Base ingestion, and file explorer mutations.

The native iOS app should provide an iOS-first interface without duplicating the server-side runtime. Running Claude Code, Codex, or Kiro CLIs on iOS is outside the product model and would break the project's core requirement that CLI processes run on the same Mac as the workspace.

## Decision

Build the iOS app as a native SwiftUI client for the existing Agent Cockpit server. The iOS source lives under `ios/AgentCockpit/` and is split into a Swift Package core/UI layer plus an app entrypoint. The server remains the source of truth for all durable state and privileged local-machine operations.

The first native slices mirror the documented chat API: list active and archived conversations, create/open/rename/archive/restore/delete conversations, send messages, stop streams, decode WebSocket frames, rehydrate active stream IDs, auto-drain queued follow-up messages, answer plan/question interactions through `/input`, display usage totals, upload/delete pending attachments, browse read-only workspace files, select CLI profile/model/effort, inspect sessions, reset sessions, and render a SwiftUI sidebar/transcript/composer shell. Native auth uses the server-owned first-party login and mobile pairing/session bridge through system web authentication rather than an embedded provider web view.

## Alternatives Considered

- **Reimplement the backend inside the iOS app**: Rejected because iOS cannot own the Mac workspace, spawn the local CLI tools in the required environment, or safely share the existing file-backed project state.
- **Wrap the existing web UI in a WebView**: Rejected because the goal is a native iOS app, and a WebView wrapper would preserve the browser-specific interaction model rather than producing native navigation, state, and system integration.
- **Use a cross-platform UI stack**: Rejected for the initial implementation because the app is explicitly iOS-native and the existing server already provides the cross-device abstraction.

## Consequences

- + The server API and SPEC remain the contract for both web and iOS clients.
- + Native iOS work can proceed incrementally with Swift tests around the client core.
- - The iOS app depends on reachable server networking and cannot function as a standalone local CLI host.
- - Public App Store distribution still requires care around any optional third-party/legacy login paths, but the default companion-app flow is backend-owned first-party auth.
- ~ Simulator/device verification requires full Xcode and an available iOS Simulator runtime.

## References

- `docs/spec-ios.md`
- `docs/spec-api-endpoints.md`
- `docs/spec-frontend.md`
