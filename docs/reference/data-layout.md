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
│   │   └── session-finalizers.json
│   ├── stream-jobs.json
│   ├── usage-ledger.json
│   ├── artifacts/
│   └── settings.json
└── sessions/              # Express session files
```

## Workspace Scope

Conversations, session files, memory, Knowledge Base artifacts, and Workspace
Context state are scoped by stable workspace identity. `data/chat/workspaces.json`
maps each immutable `workspaceId` to mutable path metadata and to the on-disk
`storageKey`; legacy workspaces keep their original path hash as the storage key.

## Production Install Metadata

Production installers also write install-state metadata used by self-update and
Install Doctor. See [spec-deployment.md](../spec-deployment.md) for the full
manifest contract.
