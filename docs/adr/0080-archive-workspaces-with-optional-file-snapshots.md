---
id: 0080
title: Archive workspaces with optional file snapshots
status: Accepted
date: 2026-05-29
supersedes: []
superseded-by: null
tags: [workspace, data-model, archival]
affects:
  - src/contracts/workspaces.ts
  - src/routes/chat.ts
  - src/routes/chat/workspaceArchiveRoutes.ts
  - src/services/chatService.ts
  - src/services/sessionFinalizerQueue.ts
  - src/services/chat/conversationLifecycleStore.ts
  - src/services/chat/workspaceFeatureSettingsStore.ts
  - src/services/chat/workspaceIdentityStore.ts
  - src/services/chat/workspaceArchiveStore.ts
  - src/services/chat/workspaceSnapshotService.ts
  - web/AgentCockpitWeb/src/workspaceSettings.jsx
  - web/AgentCockpitWeb/src/screens/archivedWorkspaces.jsx
  - docs/spec-data-models.md
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-frontend.md
  - docs/spec-mobile-pwa.md
---

## Context

Agent Cockpit stored conversations, Memory, Workspace Context, and Knowledge Base data per workspace, but users had no workspace-level lifecycle state. If a project was no longer active, the only practical options were to leave it mixed into active workspace lists or manually delete folders, risking loss of retained conversation history and learned context.

The product goal is to let users retire a workspace while preserving Agent Cockpit-owned history and learnings. Users may also delete the original workspace folder after archival, so restoration cannot assume the original path still exists. Some users want Agent Cockpit to keep a verified copy of workspace files and clean up the original folder on their behalf; others only want to retain conversation/context data and manage source files themselves.

## Decision

Workspace archive state is persisted on `WorkspaceIndex.archive`, keyed by the immutable `workspaceId`. Archived workspaces are hidden from normal conversation lists, new conversations are blocked, and scheduled workspace Memory/Knowledge Base/Workspace Context work skips them without clearing feature settings. Archived workspaces remain visible through dedicated archive endpoints and desktop UI.

Archive supports two modes:

- `history_only` preserves Agent Cockpit-owned data only. Restoring requires the current workspace path to still exist, or the user must remap the archived workspace to an existing folder first.
- `file_snapshot` creates a verified ZIP snapshot under Agent Cockpit's data root before archival. The snapshot includes a manifest with file checksums and supports `exclude_common` or `include_all` inclusion policy. Restore extracts into an empty destination, rejects unsafe ZIP paths, verifies checksums, remaps the workspace, and then clears archive state.

Optional original-folder cleanup is part of snapshot archival. `keep` leaves source files in place, `move_to_trash` moves the original folder into product-owned `workspace-trash`, and `delete_permanently` requires exact confirmation text. Cleanup refuses to operate when the source path overlaps Agent Cockpit archive storage.

Archive final-learning passes reuse the existing persisted `SessionFinalizerQueue`. Archive-tagged jobs include an archive timestamp identity key so a restored-and-rearchived workspace can run a fresh pass for the same conversation/session. The route layer marks the archive pass completed once all archive-tagged jobs succeed, failed when a terminal job fails, and completed immediately when no Memory or Workspace Context finalizer jobs are enabled.

Deleting an archived workspace record is a separate destructive action. It requires the workspace to be archived and removes Agent Cockpit-owned retained data: workspace storage, snapshots, product-trash copies for that workspace, conversation artifacts, conversation lookup entries, and the workspace identity registry record.

## Alternatives Considered

- **Only delete workspace records**: Rejected because it would discard conversation history and learned context, which is the information users most want to retain after a project stops being active.
- **Always snapshot workspace files**: Rejected because repositories can be very large, generated dependency folders are often wasteful, and some users already have source control or backup systems for files.
- **Restore missing original folders automatically for history-only archives**: Rejected because Agent Cockpit cannot reconstruct files it did not snapshot. History-only restore must require an existing/remapped folder.
- **Store snapshots beside the workspace folder**: Rejected because users may delete that folder after archival. Product-owned snapshot storage must live under the data root.

## Consequences

- + Users can remove inactive workspaces from active flows while preserving conversations, Memory, Workspace Context, and Knowledge Base context.
- + Users who opt into file snapshots can restore a deleted workspace folder from Agent Cockpit-owned verified ZIP storage.
- + The default history-only mode avoids copying large repositories when the user only needs retained discussion/context.
- + Archive state follows stable workspace identity and survives path remapping.
- - Snapshot creation and restore add storage, checksum, and ZIP safety complexity.
- - Archive deletion must be treated as destructive because it removes the retained history/context record, not only a UI listing.
- ~ Mobile PWA continues to hide archived workspace conversations through the default conversation-list contract; workspace archive management remains a desktop surface because remapping and filesystem snapshot paths are desktop workflows.

## References

- [ADR-0073: Use Stable Workspace Identities](0073-use-stable-workspace-identities.md)
- [Data models](../spec-data-models.md)
- [API endpoints](../spec-api-endpoints.md)
- [Frontend behavior](../spec-frontend.md)
