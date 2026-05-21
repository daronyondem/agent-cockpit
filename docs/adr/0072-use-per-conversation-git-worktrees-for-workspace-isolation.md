---
id: 0072
title: Use per-conversation Git worktrees for workspace isolation
status: Accepted
date: 2026-05-20
supersedes: []
superseded-by: null
tags:
  - chat
  - git
  - worktrees
  - workspace-isolation
  - sessions
affects:
  - src/services/chatService.ts
  - src/services/chat/worktreeIsolationService.ts
  - src/routes/chat/worktreeIsolationRoutes.ts
  - src/routes/chat/streamRoutes.ts
  - src/routes/chat/goalRoutes.ts
  - src/routes/chat/uploadRoutes.ts
  - src/routes/chat/gitRoutes.ts
  - src/contracts/worktreeIsolation.ts
  - src/contracts/responses.ts
  - src/types/index.ts
  - web/AgentCockpitWeb/src/api.js
  - web/AgentCockpitWeb/src/shell.jsx
  - web/AgentCockpitWeb/src/workspaceSettings.jsx
  - mobile/AgentCockpitPWA/src/api.ts
  - mobile/AgentCockpitPWA/src/appModel.ts
  - test/chat.worktreeIsolation.test.ts
  - docs/spec-data-models.md
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
  - docs/spec-server-security.md
  - docs/spec-testing.md
  - docs/spec-coverage.md
---

## Context

Agent Cockpit historically mapped every conversation in a workspace to the same
filesystem checkout. That makes concurrent CLI agents easy to run from one UI,
but it also lets two active conversations edit the same files at the same time.
The result is not a Git merge conflict; it is direct working-tree interference
inside one folder before either branch is ready to push.

The product constraint is that workspaces are still the user's primary grouping
model. Conversations remain static UI objects, cannot be cheaply replaced after
every pull request, and may use any CLI vendor across their lifetime. Not every
workspace is a Git repository, so this isolation must be opt-in and must leave
non-Git workspaces unchanged.

## Decision

Add an optional workspace setting that uses one Git worktree per conversation.

When the setting is enabled for a Git-backed workspace, Agent Cockpit migrates
all existing conversations in that workspace into dedicated worktrees and resets
their CLI sessions. New conversations in that workspace also receive a dedicated
worktree. The canonical workspace path and workspace hash remain the shared
base checkout so sidebar grouping, Memory, Knowledge Base, and Workspace
Context stay workspace-scoped. The conversation response separately exposes an
`executionDir` and `checkout` block so CLI execution, OCR, goal runs, delivered
file previews, and conversation-scoped Git status/diff use the conversation's
worktree.

Branch lifecycle is session-scoped. Each reset archives the current session,
runs `git fetch origin`, and moves the conversation worktree to a fresh session
branch based on `origin/main`. Worktree lifecycle is conversation-scoped: the
same checkout folder remains attached to the conversation until the conversation
is deleted or worktree isolation is disabled. GitHub only sees normal pushed
branches; worktree metadata stays local.

Enablement is rejected unless the base checkout is clean, `origin/main` is
available after fetch, and every existing conversation can receive its
worktree. Disablement is rejected while the base checkout or any conversation
worktree has uncommitted changes. Clean disablement removes the conversation
worktrees, clears checkout metadata, resets affected sessions, and returns
conversations to the shared workspace path. Active or preparing CLI turns block
enablement and disablement.

## Alternatives Considered

- **Use separate conversations but keep one shared checkout**: rejected because
  it preserves the exact file-edit collision this feature is meant to prevent.
- **Create new conversations after every pull request merge**: rejected because
  conversations are durable UI objects that users revisit; requiring archive,
  delete, and recreate flows would make normal branch lifecycle too expensive.
- **Give each CLI vendor its own checkout**: rejected because the isolation
  boundary is conversation ownership, not backend vendor. A conversation can
  reset or switch runtime settings while still owning the same workspace copy.
- **Manage pull request merging or development-server publishing as product
  behavior**: rejected for this feature. GitHub integration remains branch/PR
  oriented, and any local server that points at the base checkout is a manual
  operator concern rather than a product workflow.

## Consequences

- + Multiple active CLI conversations can modify the same Git repository without
  clobbering one another's working files.
- + GitHub interoperability remains ordinary branch behavior: users push
  session branches and open pull requests exactly as they would without
  worktrees.
- + Existing workspace-level features keep their grouping because the workspace
  hash still derives from the canonical base checkout.
- - Enabling or disabling the setting is disruptive by design because every
  affected conversation session must reset.
- - Users must resolve dirty worktrees before reset, delete, or disable actions
  can proceed.
- ~ Merge conflicts are not eliminated. They move to the normal Git merge or PR
  integration boundary instead of occurring as simultaneous edits in one
  filesystem directory.

## References

- Issue #342: per-conversation Git worktree isolation.
- [Data model spec](../spec-data-models.md#workspace-index-workspaceshashindexjson)
- [API endpoints spec](../spec-api-endpoints.md#381-workspace-worktree-isolation)
- [Backend services spec](../spec-backend-services.md#41-chatservice)
- [Frontend spec](../spec-frontend.md)
- [Mobile PWA spec](../spec-mobile-pwa.md)
