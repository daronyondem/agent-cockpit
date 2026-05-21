---
id: 0073
title: Use stable workspace identities
status: Accepted
date: 2026-05-21
supersedes: []
superseded-by: null
tags:
  - chat
  - workspaces
  - data-model
  - migration
affects:
  - src/services/chat/workspaceIdentityStore.ts
  - src/services/chatService.ts
  - src/services/chat/workspaceFeatureSettingsStore.ts
  - src/services/sessionFinalizerQueue.ts
  - src/routes/chat/workspaceLocationRoutes.ts
  - src/routes/chat.ts
  - src/contracts/workspaces.ts
  - src/contracts/responses.ts
  - src/types/index.ts
  - web/AgentCockpitWeb/src/api.js
  - web/AgentCockpitWeb/src/workspaceSettings.jsx
  - web/AgentCockpitWeb/src/primitives.jsx
  - web/AgentCockpitWeb/src/shell.jsx
  - web/AgentCockpitWeb/src/streamStore.js
  - mobile/AgentCockpitPWA/src/api.ts
  - mobile/AgentCockpitPWA/src/appModel.ts
  - mobile/AgentCockpitPWA/src/App.tsx
  - test/chat.workspaceIdentityStore.test.ts
  - test/chatService.workspace.test.ts
  - test/chat.rest.test.ts
  - test/sessionFinalizerQueue.test.ts
  - docs/spec-data-models.md
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
  - docs/spec-testing.md
  - docs/spec-coverage.md
  - docs/SPEC.md
  - docs/agent-project-memory.md
  - AGENTS.md
---

## Context

Agent Cockpit originally used `SHA-256(workspacePath).substring(0, 16)` as both
the workspace's public identifier and its storage folder. That was simple, but
it made the absolute path part of identity. Moving an install to another server,
mounting the same project at a different path, or renaming a checkout made the
same logical workspace look like a different workspace unless data was manually
copied or path-hash references were rewritten.

The product constraint is that Agent Cockpit is a hosted web app controlled by
the server. There are no long-lived old web clients to keep compatible after a
deploy refresh. The durable compatibility requirement is existing on-disk data:
workspace folders, conversation IDs, memory files, KB databases, Workspace
Context markdown, session-finalizer queues, and historical `workspaceHash`
fields must keep resolving.

## Decision

Give every workspace a stable internal UUID and treat the absolute workspace
path as mutable metadata.

`data/chat/workspaces.json` is the workspace identity registry. Each record maps
`workspaceId` to a storage key, the current absolute path, the original legacy
path hash, previous paths, and timestamps. Existing workspace folders remain at
their legacy hash storage key. New workspaces also use the initial path hash as
their storage key, but clients and runtime maps use `workspaceId` as the
canonical workspace reference.

On startup, `WorkspaceIdentityStore` scans existing workspace folders, adds
missing `WorkspaceIndex.workspaceId` fields, rebuilds the registry from actual
indexes when the registry is missing or corrupt, and drops stale registry
records that no longer have a workspace folder. `ChatService` resolves any
workspace reference through the registry before touching storage, so legacy
hashes, storage keys, and new workspace IDs all continue to work server-side.

Current web and mobile clients send `workspaceId` for workspace-scoped API
calls. Responses still include `workspaceHash` as a legacy/debug field, but it
is no longer the canonical client key. Workspace-scoped caches, stream fan-out,
finalizer enqueueing, Memory/KB/Workspace Context checks, and enabled-workspace
schedulers use workspace IDs.

Workspace location changes are explicit metadata updates. `GET
/workspaces/:workspaceId/location` returns the current path and prior paths;
`PUT /workspaces/:workspaceId/location` validates that the target directory
exists, rejects path collisions, rejects active workspace turns or active
Workspace Context processing, rejects enabled worktree isolation, then updates
the registry and `WorkspaceIndex.workspacePath` without moving the workspace
storage folder.

## Alternatives Considered

- **Keep path hash as identity**: preserve the previous model and document a
  manual migration procedure. Rejected because path changes are a normal part of
  server migration, and path-derived identity would keep creating accidental new
  workspaces.
- **Rename storage folders to UUIDs**: make the directory name match
  `workspaceId`. Rejected because it creates unnecessary migration churn across
  Memory, KB, Workspace Context, session files, finalizer queues, backups, and
  user expectations. A stable internal ID can be canonical without moving
  existing folders.
- **Support old client payloads indefinitely**: keep `workspaceHash` as a
  first-class public API input. Rejected as a product requirement because the
  hosted web app refreshes with the server. The server still accepts legacy
  hashes for on-disk compatibility and operational safety, but current clients
  should use `workspaceId`.

## Consequences

- + Workspace identity survives path moves, server migrations, and mount-point
  changes.
- + Existing workspace folders and data remain in place; migration is registry
  and index metadata rather than a filesystem move.
- + Current clients can use a single stable `workspaceId` across Memory, KB,
  Workspace Context, files, Git, and worktree settings.
- + The server can rebuild the registry from workspace indexes if
  `workspaces.json` is missing or corrupt.
- - Workspace code must distinguish canonical workspace IDs from storage keys
  and legacy hashes at boundaries.
- - Docs and tests must treat `workspaceHash` as legacy compatibility, not new
  API vocabulary.
- ~ Storage folder names are still legacy hashes by design; this is an
  implementation/storage detail rather than workspace identity.

## References

- [Data model spec](../spec-data-models.md)
- [API endpoint spec](../spec-api-endpoints.md)
- [Backend service spec](../spec-backend-services.md)
- [Frontend spec](../spec-frontend.md)
- [Mobile PWA spec](../spec-mobile-pwa.md)
- [ADR-0072: Use per-conversation Git worktrees for workspace isolation](0072-use-per-conversation-git-worktrees-for-workspace-isolation.md)
