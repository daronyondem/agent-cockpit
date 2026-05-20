<p align="center">
  <img src="public/logo-text.svg" alt="Agent Cockpit" width="500" />
</p>

<p align="center">
  Run CLI AI agents from your browser. Keep your context on your machine. Switch vendors without starting over.
</p>

<p align="center">
  <em>A local browser cockpit for Claude Code, OpenAI Codex, Kiro, and future command-line AI agents.</em>
</p>

<p align="center">
  <a href="https://github.com/daronyondem/agent-cockpit/actions/workflows/test.yml">
    <img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/daronyondem/agent-cockpit/test.yml?label=tests&logo=githubactions&logoColor=white" />
  </a>
  <a href="https://github.com/daronyondem/agent-cockpit/releases/latest">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/daronyondem/agent-cockpit?sort=semver&display_name=tag&label=release&logo=github" />
  </a>
  <a href="https://github.com/daronyondem/agent-cockpit/blob/main/LICENSE">
    <img alt="License" src="https://img.shields.io/github/license/daronyondem/agent-cockpit?label=license" />
  </a>
  <a href="#prerequisites">
    <img alt="Node >=22" src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white" />
  </a>
  <a href="https://github.com/daronyondem/agent-cockpit/releases">
    <img alt="Release downloads" src="https://img.shields.io/github/downloads/daronyondem/agent-cockpit/total?label=release%20downloads&logo=github" />
  </a>
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &middot;
  <a href="docs/README.md"><strong>Docs</strong></a> &middot;
  <a href="BACKENDS.md"><strong>Backends</strong></a> &middot;
  <a href="ONBOARDING.md"><strong>Self-hosting</strong></a> &middot;
  <a href="docs/SPEC.md"><strong>Spec</strong></a>
</p>

---

## What is Agent Cockpit?

Agent Cockpit is an open source, local-first web UI for command-line AI agents.
It runs on your machine, talks to local CLIs such as Claude Code, OpenAI Codex,
and Kiro, streams their work into a browser interface, and stores your
conversations, memory, and knowledge base on disk.

The core idea is simple: models and vendors will keep changing, but your working
context should not reset every time. Agent Cockpit decouples your AI interaction
data from the vendor interface you happen to use today.

## Agent Cockpit is right for you if

- You use more than one AI vendor and want a single browser interface across
  them.
- You want conversations, memory, knowledge-base entries, and workspace context
  on a machine you control.
- You want to switch from Claude Code to Codex or Kiro without losing the
  workspace understanding built up over time.
- You use AI for coding, writing, research, planning, operations, or other
  knowledge work.
- You are comfortable running a local server, or using the macOS/Linux/Windows
  installers to manage that server for you.

## Agent Cockpit is not for you if

- You want a hosted SaaS with no local setup.
- You only use one vendor and do not care about context portability.
- You want Agent Cockpit to replace vendor CLIs. It wraps those CLIs; it does
  not reimplement them.
- You want a multi-agent company or task-orchestration system. Agent Cockpit is
  a personal/local cockpit for interacting with AI agents you invoke.

## Without and With Agent Cockpit

| Without Agent Cockpit | With Agent Cockpit |
| --- | --- |
| AI work is scattered across terminal tabs and vendor apps. | Claude Code, Codex, and Kiro run from one browser UI. |
| Each vendor owns its own memory and history. | Conversations, memory, KB, and Workspace Context live locally. |
| Switching vendors means starting over. | Provider-neutral workspace context follows the next backend. |
| Remote access requires SSHing into a terminal. | Use the desktop web UI or mobile PWA through your own secure access path. |
| Tool output and generated files are buried in stream logs. | Tool activity, artifacts, file delivery, and session state are shown in the UI. |

## Core Capabilities

**Unified CLI interface**
Run Claude Code, OpenAI Codex, and Kiro from a browser-based chat surface. Switch
backends per conversation while keeping the same workspace and interaction
model.

**Local open storage**
Conversation files, session metadata, settings, memory snapshots, and
knowledge-base artifacts are stored under your local data directory as
JSON/Markdown plus local indexes where search requires them.

**Portable workspace context**
Workspace Memory, Knowledge Base, instruction compatibility checks, and
Workspace Context help each backend see the same durable context instead of
rebuilding it from scratch.

**Knowledge Base**
Upload PDFs, Word documents, PowerPoints, images, CSV/TSV files, Markdown, and
text-like files into a per-workspace knowledge base. Agent Cockpit converts,
extracts, organizes, and retrieves that material for later conversations.

**Workspace Context**
Workspace Context is markdown-first operating memory for a workspace. Agent
Cockpit creates a `workspace-context/` folder, installs a managed pointer block
in the workspace `AGENTS.md`, and uses a configured CLI processor to catch up
those markdown files from recent conversations and sessions. The active chat CLI
reads and updates the same files through normal workspace instructions.

**Real-time agent view**
Responses stream live with tool calls, sub-agents, thinking, outcomes, progress
state, draft persistence, plan-mode approvals, interactive questions, and
reconnection recovery.

**Mobile PWA**
The supported mobile client is served from the same backend at `/mobile/`, so
you can monitor and steer work from a phone without a native app.

**Self-update and first-party auth**
Production installs update from GitHub Releases. Dev installs update from
`main`. A first-party local owner account protects access, with password login,
passkeys, recovery codes, and optional legacy OAuth compatibility.

## Supported Backends

| Backend | CLI | Status |
| --- | --- | --- |
| **Claude Code** | `claude` | Fully supported |
| **OpenAI Codex** | `codex` | Fully supported |
| **Kiro** | `kiro-cli` | Fully supported |

See [BACKENDS.md](BACKENDS.md) and [docs/user/backends.md](docs/user/backends.md)
for feature differences, auth notes, and setup guidance.

## How It Works

Agent Cockpit runs on the same machine as your CLI tools. When you send a
message through the browser, the server starts or connects to the selected local
backend, streams events over WebSocket, records the conversation under the
current workspace, and exposes generated files through the authenticated UI.

This has three important consequences:

- The CLI and the web interface must run on the same machine.
- Remote access is your responsibility. Use a private network, tunnel, or
  reverse proxy you control.
- The CLIs keep their normal vendor authentication. Agent Cockpit does not host
  or proxy model inference.

## Prerequisites

- Node.js 22+ for manual development installs. The macOS, Linux, and Windows
  release installers can install a private Node.js runtime automatically when
  Node/npm are missing.
- At least one CLI backend installed and authenticated on the same machine:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
    (`claude`)
  - [OpenAI Codex CLI](https://github.com/openai/codex) (`codex`, install with
    `npm install -g @openai/codex`)
  - [Kiro CLI](https://kiro.dev) (`kiro-cli`)
- Optional: [LibreOffice](https://www.libreoffice.org/) and/or
  [Pandoc](https://pandoc.org/) on `PATH` for broader Knowledge Base document
  conversion.
- Optional: [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/),
  Tailscale, or a similar access path for remote browser/mobile use.

## Quickstart

### macOS Production Install

The recommended production path on macOS is the release installer. It downloads
the latest GitHub Release, verifies checksums, installs dependencies, writes
local runtime config, starts Agent Cockpit through local PM2, and opens
first-run owner setup in the browser.

```bash
curl -fsSL https://github.com/daronyondem/agent-cockpit/releases/latest/download/install-macos.sh -o /tmp/install-agent-cockpit.sh
bash /tmp/install-agent-cockpit.sh --channel production
```

Dev installs track `main`:

```bash
bash /tmp/install-agent-cockpit.sh --channel dev
```

### Linux Production Install

The validated Linux production path is the release installer on Ubuntu 24.04 LTS
x64. It uses the same local server model as macOS, installs a private Node.js
runtime when needed, starts Agent Cockpit through local PM2, and opens or prints
the first-run setup URL.

```bash
curl -fsSL https://github.com/daronyondem/agent-cockpit/releases/latest/download/install-linux.sh -o /tmp/install-agent-cockpit.sh
bash /tmp/install-agent-cockpit.sh --channel production
```

Dev installs track `main`:

```bash
bash /tmp/install-agent-cockpit.sh --channel dev
```

Alpine/musl, NixOS, WSL, Linux arm64, and 32-bit Linux are not supported by the
first Linux installer.

### Windows Production Install

The supported Windows production path is a per-user PowerShell installer. It
installs under `%LOCALAPPDATA%\Agent Cockpit`, uses install-local PM2 state,
registers a current-user logon scheduled task, starts Agent Cockpit in the
background, and opens first-run owner setup in the browser.

```powershell
powershell -ExecutionPolicy Bypass -NoProfile -Command "iwr https://github.com/daronyondem/agent-cockpit/releases/latest/download/install-windows.ps1 -OutFile $env:TEMP\install-agent-cockpit.ps1; & $env:TEMP\install-agent-cockpit.ps1 -Channel production"
```

Dev installs track `main`:

```powershell
& $env:TEMP\install-agent-cockpit.ps1 -Channel dev
```

### Developer Quick Start

```bash
git clone https://github.com/daronyondem/agent-cockpit.git
cd agent-cockpit
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3334` in your browser and create the first local owner
account. On Windows, manual development installs use the same source checkout
path but the production PowerShell installer remains the recommended path for
non-development use. For persistent local server management, use PM2 as documented in
[ONBOARDING.md](ONBOARDING.md).

## Authentication and Security

Agent Cockpit uses one first-party local owner account by default. No GitHub,
Google, Apple ID, or Cloudflare Access login is required for the normal
self-hosted flow.

On first run, open `/auth/setup` and create the owner account. If the backend is
exposed through a tunnel before setup, set `AUTH_SETUP_TOKEN` and enter that
token on the setup page so a remote visitor cannot claim the empty backend.

After setup, open **Settings > Security** to register passkeys, generate
recovery codes, and optionally require passkey login.

For local lockout recovery, run this on the backend machine:

```bash
npm run auth:reset -- --password "new long password" --disable-passkey-required --revoke-sessions --regenerate-recovery-codes
```

## Documentation

Start with [docs/README.md](docs/README.md).

- [User Guide](docs/user/README.md) covers daily use, backends, Memory,
  Knowledge Base, Workspace Context, and mobile PWA.
- [Deploy Guide](docs/deploy/README.md) covers macOS, Linux, Windows, remote access,
  auth, updates, and troubleshooting.
- [Reference](docs/reference/README.md) covers data layout, environment
  variables, backend capabilities, development, and tests.
- [Specification](docs/SPEC.md) is the full implementation source of truth.

## Contributing

For implementation work, read [AGENTS.md](AGENTS.md) and
[docs/SPEC.md](docs/SPEC.md). This repo keeps user docs, technical specs, and
ADRs in source control.

Useful verification commands:

```bash
npm run typecheck
npm test
npm run maintainability:check
npm run spec:drift
```

Before production releases, follow [docs/release-workflow.md](docs/release-workflow.md).

## License

Copyright 2026 Daron Yondem.

Agent Cockpit is licensed under the Apache License, Version 2.0. See
[LICENSE](LICENSE).
