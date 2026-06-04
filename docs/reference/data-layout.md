# Data Layout

Agent Cockpit stores mutable runtime data under `AGENT_COCKPIT_DATA_DIR`, which
defaults to `data` for manual development installs. Production installers place
the data directory outside the replaceable app release directory.

## Main Layout

```text
data/
├── auth/                  # First-party owner auth state
├── chat/
│   ├── workspaces/{storageKey}/ # Workspace-scoped storage
│   │   ├── index.json
│   │   ├── {conversationId}/
│   │   ├── memory/
│   │   ├── knowledge/
│   │   ├── workspace-context/
│   │   ├── routines/
│   │   └── session-finalizers.json
│   ├── workspace-snapshots/{workspaceId}/ # Optional verified ZIP snapshots for archived workspaces
│   ├── workspace-trash/       # Product-owned moved originals from snapshot archive cleanup
│   ├── restored-workspaces/   # Default extraction root for snapshot restores
│   ├── stream-jobs.json
│   ├── usage-ledger.json
│   ├── artifacts/
│   └── settings.json
└── sessions/              # Express session files
```

The migration control directory is a sibling of the data root, not a child:

```text
data.migration/
├── exports/                # Temporary .acexport bundles
├── uploads/                # Uploaded bundles plus chunk metadata awaiting preview/confirm; successful imports remove their upload best-effort
├── staging/<importId>/data # Verified replacement data root
├── backups/                # Previous data roots after successful imports
├── pending-import.json
├── last-import.json
└── failed-import.json
```

## Workspace Scope

Conversations, session files, memory, Knowledge Base artifacts, and Workspace
Context state are scoped by stable workspace identity. Workspace Routines are
scoped the same way. `data/chat/workspaces.json` maps each immutable
`workspaceId` to mutable path metadata and to the on-disk `storageKey`; legacy
workspaces keep their original path hash as the storage key.

Archived workspaces keep their Agent Cockpit-owned data under the same
`workspaces/{storageKey}/` directory until the user restores or deletes the
archive record. Optional file snapshots are stored under
`workspace-snapshots/{workspaceId}/` as a ZIP plus a JSON manifest containing
per-file SHA-256 checksums. Snapshot restores extract into an empty destination;
when no destination is supplied the server uses `restored-workspaces/`. If
snapshot archival moves the original folder instead of deleting it, the moved
copy lives under `workspace-trash/` and is removed with the archived workspace
record.

## Workspace Routines Data

Workspace Routines live under Agent Cockpit data, not inside the workspace
project folder:

```text
data/chat/workspaces/{storageKey}/routines/
├── ROUTINE_AUTHORING.md
├── index.json
├── settings.json
└── items/{routineId}/
    ├── manifest.json
    ├── routine.md
    ├── state.json
    ├── persistent-state/
    └── runs/{runId}/
        ├── input.md
        ├── output/
        ├── tmp/
        ├── final.md
        └── notify.md
```

`ROUTINE_AUTHORING.md` is the contract a harness reads before creating or
editing a routine. `settings.json` stores workspace outreach settings such as
the Telegram destination chat; the shared Telegram bot token lives in
`data/chat/settings.json` under global integrations. `persistent-state/` is the
cross-run state folder for one routine. `runs/{runId}/output/` contains durable
artifacts for a single execution.

## Export And Import

Export creates a `.acexport` ZIP that contains `manifest.json` plus `data/...`.
The archive writer streams file contents from disk and verifies the finished ZIP
against the manifest before download. The manifest records app/source metadata,
workspace summaries, excluded runtime paths, and a SHA-256 checksum for every
included file. Import lazily reads archive entries, rejects unsafe or undeclared
data files, enforces the 20 GB included-data cap, and verifies staged checksums
before writing `pending-import.json`.

Import is destructive by design. After the user types `REPLACE`, the server
stages the bundle and restarts. Startup renames the current data root into
`data.migration/backups/` and renames the staged `data/` directory into the
active data-root path. It does not merge with the destination installation.

Manual migration by copying the data root remains safe for user-owned state as
long as Agent Cockpit is stopped and the copy includes the whole data root.
However, the built-in export/import flow adds a manifest, checksum verification,
backup, restart orchestration, and post-import checks. Runtime session files and
active-stream jobs are intentionally excluded from exported bundles.

## Production Install Metadata

Production installers also write install-state metadata used by self-update and
Install Doctor. See [spec-deployment.md](../spec-deployment.md) for the full
manifest contract.
