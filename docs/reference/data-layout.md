# Data Layout

Agent Cockpit stores mutable runtime data under `AGENT_COCKPIT_DATA_DIR`, which
defaults to `data` for manual development installs. Production installers place
the data directory outside the replaceable app release directory.

## Main Layout

```text
data/
├── auth/                  # First-party owner auth state
├── chat/
│   ├── workspaces/{hash}/ # Workspace-scoped storage
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
Context state are scoped by workspace directory. The workspace path is hashed
before it becomes an on-disk directory name.

## Production Install Metadata

Production installers also write install-state metadata used by self-update and
Install Doctor. See [spec-deployment.md](../spec-deployment.md) for the full
manifest contract.
