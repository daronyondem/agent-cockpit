# Quickstart

Agent Cockpit runs on the same machine as your AI CLIs. Install the local
server, create the first owner account, make sure at least one backend CLI is
authenticated, then start a conversation from the browser.

## 1. Install Agent Cockpit

Use the production installer for your platform:

- [macOS install](../deploy/macos.md)
- [Linux install](../deploy/linux.md)
- [Windows install](../deploy/windows.md)

For development from source, see [development setup](../reference/development.md).

## 2. Create The Owner Account

Open the URL printed by the installer, usually `http://localhost:3334`, and
complete first-run setup at `/auth/setup`.

If you expose the backend before creating the owner account, set
`AUTH_SETUP_TOKEN` and enter that token during setup so a remote visitor cannot
claim the empty server.

## 3. Authenticate A Backend CLI

Agent Cockpit uses the upstream CLIs already installed on the same machine. At
least one of these should be installed and authenticated:

| Backend | Command |
| --- | --- |
| Claude Code | `claude` |
| OpenAI Codex | `codex` |
| Kiro | `kiro-cli` |
| OpenCode | `opencode` |

See [Supported Backends](backends.md) for setup notes and feature differences.

## 4. Choose A Workspace

Create or select a workspace directory in the UI. Conversations, memory, KB
state, Workspace Context data, and workspace settings are scoped to that
directory.

## 5. Send A Message

Pick a CLI profile from the composer, write a prompt, and send it. The response
streams through the browser while the local CLI works on the server machine.

Generated files and file-delivery references appear as cards in the
conversation when a backend emits them.

## 6. Add Durable Context

Once the basic chat path works, enable the context features that match your
workflow:

- [Memory](memory.md) for persistent working notes.
- [Knowledge Base](knowledge-base.md) for source documents.
- [Workspace Context](workspace-context.md) for markdown-first workspace
  operating memory.

If the workspace is a Git repository and you plan to run multiple
conversations against it at the same time, also consider
[Worktree Isolation](worktree-isolation.md) so each conversation works in its
own checkout and session branch.
