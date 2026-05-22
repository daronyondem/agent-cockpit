---
id: 0074
title: Use data root bundles for migration
status: Accepted
date: 2026-05-21
supersedes: []
superseded-by: null
tags: [migration, data-root, import-export]
affects:
  - src/contracts/dataMigration.ts
  - src/services/dataMigrationService.ts
  - src/routes/chat/dataMigrationRoutes.ts
  - package.json
  - package-lock.json
  - server.ts
  - web/AgentCockpitWeb/src/screens/settingsScreen.jsx
  - web/AgentCockpitWeb/src/api.js
  - docs/spec-api-endpoints.md
  - docs/spec-data-models.md
  - docs/spec-backend-services.md
  - docs/spec-server-security.md
  - docs/spec-frontend.md
  - docs/spec-testing.md
  - docs/spec-coverage.md
  - docs/reference/data-layout.md
  - docs/agent-project-memory.md
  - AGENTS.md
---

## Context

Agent Cockpit's user-visible state is file-backed under `AGENT_COCKPIT_DATA_DIR`:
chat settings, workspace identity registry, conversations, Memory, Workspace
Context, Knowledge Base SQLite metadata, PGLite vector stores, first-party auth
state, and session/runtime metadata. Stable workspace identity now uses immutable
`workspaceId` values with mutable path metadata, so a copied data root can remain
internally coherent even when absolute workspace paths change on the destination
machine.

Users need a migration path that is simple enough to run from the web app. Import
must work on any existing installation, not only a fresh install, which means
partial merge semantics would be destructive and hard to explain unless every
data subdomain had its own conflict model.

## Decision

Agent Cockpit migrates installations as full data-root bundles. Export packages
the active `AGENT_COCKPIT_DATA_DIR` with a versioned manifest, file checksums,
workspace summaries, and explicit runtime-file exclusions. Archive read/write
uses streaming ZIP I/O so migration is not limited by process memory. Import
stages an uploaded bundle beside the data root, verifies every staged file
against the manifest, requires the user to type `REPLACE`, and then schedules a
restart-time replacement of the entire active data root. Startup applies the
pending import by renaming the current data root to a sibling backup path and
renaming the staged data root into place.

Import is intentionally destructive for the active installation. It does not
merge conversations, settings, workspaces, Memory, Workspace Context, KB
metadata, or vector stores. The previous data root remains in the migration
backup directory for manual recovery. If restart cannot be launched after
staging, the pending import is cancelled so a later unrelated restart does not
perform a delayed replacement.

## Alternatives Considered

- **Merge imported data into the destination installation**: Rejected for the
  first version because settings, conversations, workspace IDs, Memory entries,
  KB SQLite rows, PGLite vectors, auth state, and stream supervision metadata
  would each need conflict and ownership semantics. A partial merge that looks
  easy in the UI would be more likely to corrupt or duplicate state.
- **Fresh-install-only import**: Rejected because users may need to move between
  already-running installations. Requiring a fresh target would make the
  migration affordance less useful and would still need a way to detect and
  explain non-empty state.
- **Manual copy-only documentation**: Rejected because it preserves the core
  behavior but gives users no manifest, checksum verification, backup, restart
  orchestration, or post-import health checks.

## Consequences

- + Users get one export file and one import flow that covers chat, settings,
  workspace registry, Memory, Workspace Context, KB SQLite/PGLite, first-party
  auth when stored under the data root, and installer metadata under the same
  root.
- + The import safety model is explainable: it replaces everything after backup,
  and the UI/API require explicit `REPLACE` confirmation.
- + Manifest checksum verification catches truncated or tampered bundles before
  a restart can activate them.
- + Streaming archive I/O keeps large KB/raw-data bundles out of Node heap while
  still allowing the finished export and staged import to be verified against
  the manifest.
- + Import caps declared included bytes at 20 GB as a staging safety bound, so a
  compressed bundle cannot expand without limit.
- + Post-import checks can focus on environment dependencies that data copy
  cannot solve: workspace paths, Ollama embedding model availability, system CLI
  auth, Pandoc, and LibreOffice.
- - There is no selective restore or merge. Users who want one conversation or
  one workspace from another installation need a later feature.
- - Absolute workspace paths remain mutable metadata. After importing onto a
  different machine, users may need to remap missing workspace folders.
- ~ Runtime session files and active stream jobs are intentionally excluded so an
  imported installation starts without stale browser sessions or abandoned
  active-turn state.

## References

- [ADR-0073: Use stable workspace identities](0073-use-stable-workspace-identities.md)
- [API endpoint spec](../spec-api-endpoints.md)
- [Data model spec](../spec-data-models.md)
- [Data layout reference](../reference/data-layout.md)
