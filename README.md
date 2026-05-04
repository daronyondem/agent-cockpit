<p align="center">
  <img src="public/logo-text.svg" alt="Agent Cockpit" width="500" />
</p>

<p align="center">
  A unified web interface for AI coding agents. Own your data, switch between providers freely.
</p>

---

## Why Agent Cockpit?

When you use vendor-hosted AI interfaces — Anthropic's Claude, Amazon's Kiro, Google's Gemini, OpenAI's ChatGPT — each one builds up memory and context about you: your preferences, your codebase knowledge, your working style. That memory is locked inside their platform. If a better model comes along from another provider, you can't take your conversation history, accumulated context, or customizations with you. You end up explaining yourself from scratch.

Agent Cockpit solves this by decoupling **your data** from **the AI provider**. It sits on your machine, talks to CLI-based coding agents, and keeps all conversations, sessions, and context locally on disk in open JSON files. When you switch to a different CLI backend, the new agent can access everything the previous one built up. Your investment in AI-assisted workflows stays with you, not with a vendor.

## Highlighted features

- **Own your data across any CLI** — Every conversation, session, and memory update is stored locally as open JSON on your own disk. Switch between Claude Code, Kiro, Codex, and future backends without losing history or context. When a better model ships from another vendor, your accumulated context comes with you instead of being locked inside their platform.
- **Remote web access to local or remote CLIs** — Install Agent Cockpit on your laptop or on a remote machine and drive it from any browser. Pair it with a tunnel like Cloudflare Tunnel to chat with your coding agents from your phone, tablet, or a café laptop while they operate on real files in their native environment.
- **Native iOS companion app** — Connect an iPhone to any self-hosted backend URL, pair it with a QR/manual code from the web UI, or sign in through the backend-owned passkey/password web flow.
- **Integrated memory system** — Adds persistent memory to CLIs that don't have one (like Kiro) and captures memory on the fly from CLIs that do (like Claude Code). Every change to the CLI's own memory file is snapshotted locally, so your accumulated context is portable and vendor-neutral — not trapped inside whichever CLI happens to own it today.
- **Token and cost tracking** — Token usage and cost are tracked per conversation so you always know what a long-running task or an experiment is actually costing you.
- **Message queue** — Keep typing while the CLI is still responding. Queued messages fire automatically as soon as the current response finishes, so your thinking isn't gated on the agent's latency — a feature rarely found in other chat UIs.
- **File and image uploads** — Drag and drop, paste from the clipboard, or use the attach button to send images and text files directly into chat, with inline previews, just like any modern chat interface.
- **Pick your CLI, model, and effort** — Switch backends per-conversation, choose the model (including Claude Opus 4.7), and set the reasoning effort up to `xhigh` when the CLI supports it.
- **Workspace file explorer** — Browse and edit files in the conversation's working directory directly from the browser, so you can review what the agent changed without leaving Agent Cockpit.
- **Markdown export & copy** — Download any conversation or individual session as a Markdown file, or copy any single message in its original Markdown with one click.
- **Knowledge base** — Upload PDFs, Word docs, PowerPoints, images, spreadsheets, and text files into a per-workspace knowledge base. Agent Cockpit automatically converts and analyzes each file, extracts structured entries, organizes them into topics, and discovers connections between ideas — surfaced as an interactive 3D knowledge graph your AI agents can search and reason over during conversations. Organize uploads into folders, watch live digestion progress and ETAs, let the system find patterns you missed, and give every future conversation deep, queryable context that goes far beyond what fits in a single prompt or memory file.

## Supported Backends

| Backend | CLI | Status |
|---------|-----|--------|
| **Claude Code** | `claude` | Fully supported |
| **Kiro** | `kiro-cli` | Fully supported |
| **OpenAI Codex** | `codex` | Fully supported |

Switch between backends per-conversation using the dropdown in the chat input area. Your selected backend is remembered for new conversations.

See [BACKENDS.md](BACKENDS.md) for a comparison of feature support across backends.

## How It Works

Agent Cockpit runs on the same machine as your CLI tools. When you send a message through the browser, the server spawns a CLI process locally, streams the response back over WebSocket, and stores the conversation as a JSON file on disk. The CLI runs with full access to your local filesystem and tools, just as it would in your terminal.

This means:
- **The CLI and the web interface must run on the same machine.** Agent Cockpit spawns local processes, not remote API calls.
- **Expose the server for remote access.** Use a tunnel like [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to chat with your coding agents from any browser, anywhere, while they operate on your local files and environment.
- **First-party owner auth protects access.** Create one local owner account per backend; exposed first-run setup can be guarded with `AUTH_SETUP_TOKEN`.

## Additional features

Beyond the headline capabilities above, Agent Cockpit also ships with:

- **Real-time streaming** — responses stream live via WebSocket with automatic reconnection and state recovery
- **Agent & tool visualization** — sub-agents, tool calls, thinking, and outcomes shown in real time with grouped activity panels and a compact progress timeline that collapses intermediate turns
- **Multi-workspace support** — conversations are organized by workspace directory, each with its own system prompt and per-workspace memory and knowledge-base toggles
- **Conversation management** — create, rename, search, archive, mark unread, and delete conversations grouped by workspace
- **Session management** — reset CLI sessions and view session history with LLM-generated summaries
- **Auto-generated titles** — conversation titles are generated automatically from the first message
- **Draft persistence** — unsent messages and attached files are preserved across conversation switches and survive session expiry mid-send
- **Plan mode and interactive questions** — approve plans and answer questions from the CLI directly in the browser, with the approval UI preserved across reconnects
- **CLI file delivery** — files emitted by the CLI appear inline as cards with a download button and an in-browser viewer
- **Browser tab status indicator** — favicon dot shows when a task is still running so you can flip away and check back
- **Per-CLI context tooltip** — hover the context chip to see what the active backend reports (tokens vs. credits/percentage)
- **Dark and light themes** — system-aware theme with manual override
- **First-party authentication** — local owner setup, password login, recovery codes, mobile pairing, and optional legacy OAuth compatibility
- **Self-update** — check for updates and apply them from the UI with one click
- **Pluggable backend system** — extensible adapter architecture for adding new CLI backends
- **Graceful shutdown** — clean process cleanup on SIGTERM/SIGINT
- **File-based storage** — conversations, sessions, settings, memory, and knowledge-base entries stored as JSON/Markdown on disk (no database)

## Prerequisites

- Node.js 22+ (declared in `engines`)
- At least one CLI backend installed and authenticated on the same machine:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
  - [Kiro CLI](https://kiro.dev) (`kiro-cli`)
  - [OpenAI Codex CLI](https://github.com/openai/codex) (`codex`, install with `npm install -g @openai/codex`)
- (Optional) [LibreOffice](https://www.libreoffice.org/) and/or [Pandoc](https://pandoc.org/) on `PATH` to expand Knowledge Base ingestion to Office and other document formats
- (Optional) [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or a similar tunnel for remote access — see [ONBOARDING.md](ONBOARDING.md) for a step-by-step self-hosting guide with PM2 and Cloudflare Tunnel
- (Optional) Xcode and an iPhone running iOS 18+ to build and install the native app — see [docs/ios-app.md](docs/ios-app.md)

## Quick Start

1. Clone the repository and install dependencies:

```bash
git clone https://github.com/daronyondem/agent-cockpit.git
cd agent-cockpit
npm install
```

2. Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

3. Start the server:

```bash
npm start
```

4. Open `http://localhost:3334` in your browser and create the first local owner account.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3334` | Server listen port |
| `SESSION_SECRET` | Yes | — | Secret for signing session cookies |
| `AUTH_DATA_DIR` | No | `data/auth` | First-party owner auth state directory |
| `AUTH_SETUP_TOKEN` | Recommended for remote setup | — | Token required to create the first owner account from a non-localhost request |
| `AUTH_ENABLE_LEGACY_OAUTH` | No | `false` | Set to `true` to register legacy Google/GitHub OAuth routes |
| `GOOGLE_CLIENT_ID` | No | — | Legacy Google OAuth client ID, used only when legacy OAuth is enabled |
| `GOOGLE_CLIENT_SECRET` | No | — | Legacy Google OAuth client secret, used only when legacy OAuth is enabled |
| `GOOGLE_CALLBACK_URL` | No | — | Legacy Google OAuth callback URL, used only when legacy OAuth is enabled |
| `GITHUB_CLIENT_ID` | No | — | Legacy GitHub OAuth client ID, used only when legacy OAuth is enabled |
| `GITHUB_CLIENT_SECRET` | No | — | Legacy GitHub OAuth client secret, used only when legacy OAuth is enabled |
| `GITHUB_CALLBACK_URL` | No | — | Legacy GitHub OAuth callback URL, used only when legacy OAuth is enabled |
| `ALLOWED_EMAIL` | No | — | Legacy OAuth allowed-email list |
| `DEFAULT_WORKSPACE` | No | `~/.openclaw/workspace` | Default working directory for CLI processes |
| `BASE_PATH` | No | `''` | URL base path for reverse proxy deployments |
| `KIRO_ACP_IDLE_TIMEOUT_MS` | No | `3600000` | Idle timeout (ms) before killing the Kiro ACP process |
| `CODEX_IDLE_TIMEOUT_MS` | No | `600000` | Idle timeout (ms) before killing the Codex `app-server` process |
| `CODEX_APPROVAL_POLICY` | No | `on-request` | Codex approval policy for interactive threads (`untrusted`, `on-failure`, `on-request`, `never`) |
| `CODEX_SANDBOX_MODE` | No | `workspace-write` | Codex sandbox mode for interactive threads (`read-only`, `workspace-write`, `danger-full-access`). Use `CODEX_APPROVAL_POLICY=never` with `CODEX_SANDBOX_MODE=danger-full-access` to run Codex with full elevated permissions. |

## Authentication Setup

Agent Cockpit uses one first-party local owner account by default. No GitHub, Google, Apple ID, or Cloudflare Access login is required for the normal self-hosted flow.

On first run, open `/auth/setup` and create the owner account with an email, display name, and password of at least 12 characters. If the backend is exposed through a tunnel before setup, set `AUTH_SETUP_TOKEN` and enter that token on the setup page so a remote visitor cannot claim the empty backend.

After setup, open **Settings > Security** to:

- Register one or more passkeys.
- Generate recovery codes and store them somewhere safe.
- Enable **Require passkey for login** after at least one passkey and one unused recovery code exist.
- Create QR/manual pairing codes for the iOS app.
- Review and revoke paired mobile devices.

Passkeys are tied to the backend domain. If you move from one host to another, for example from `chat-dev.example.com` to `chat.example.com`, register a passkey while signed in on the new domain.

For local lockout recovery, run this on the backend machine:

```bash
npm run auth:reset -- --password "new long password" --disable-passkey-required --revoke-sessions --regenerate-recovery-codes
```

The reset command requires local filesystem access. It can reset the owner password, disable passkey-required mode, revoke sessions, revoke mobile devices, and print replacement recovery codes.

### Legacy OAuth

Google/GitHub OAuth is legacy-only and disabled by default. Set `AUTH_ENABLE_LEGACY_OAUTH=true` only if you need the old provider routes temporarily, then configure the provider client id, client secret, callback URL, and `ALLOWED_EMAIL`.

## Remote Access with Cloudflare Tunnel

To access Agent Cockpit from outside your local network, use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):

```bash
cloudflared tunnel --url http://localhost:3334
```

Use the tunnel-provided URL to reach your local Agent Cockpit from any device. For a fresh exposed backend, set `AUTH_SETUP_TOKEN` before creating the owner account.

## iOS App

The native iOS app lives in `ios/AgentCockpit`. It connects to a backend URL that the user enters on the connection screen, so it works with personal tunnel domains, LAN hosts, and separate dev/prod backends.

Supported login paths:

- **Sign in with Passkey or Password** opens the backend-owned login page in the system authentication session and returns to the app with a one-time code.
- **Scan QR Code** uses a pairing QR code created from **Settings > Security** in the web UI.
- **Pair Device** accepts the manual `challengeId` and pairing code from the same web UI panel.

See [docs/ios-app.md](docs/ios-app.md) for Xcode install steps, real-device setup, and mobile troubleshooting.

## Project Structure

```
agent-cockpit/
├── server.ts                 # Express server entry point (TypeScript, run via tsx)
├── src/
│   ├── ws.ts                 # WebSocket server (streaming, reconnection, state recovery)
│   ├── types/index.ts        # Shared type definitions
│   ├── config/index.ts       # Environment configuration
│   ├── middleware/
│   │   ├── auth.ts           # First-party owner auth, legacy OAuth, login routes
│   │   ├── csrf.ts           # CSRF token generation and validation
│   │   └── security.ts       # Helmet CSP configuration
│   ├── routes/chat.ts        # All chat API routes
│   └── services/
│       ├── localAuthStore.ts # First-party auth state, passkeys, recovery codes, mobile devices
│       ├── backends/
│       │   ├── base.ts           # Base adapter interface for CLI backends
│       │   ├── claudeCode.ts     # Claude Code CLI adapter
│       │   ├── kiro.ts           # Kiro CLI adapter (ACP protocol)
│       │   ├── codex.ts          # Codex CLI adapter (Codex App Server protocol)
│       │   ├── toolUtils.ts      # Shared tool helpers across backends
│       │   └── registry.ts       # Backend registry (pluggable adapter system)
│       ├── knowledgeBase/    # KB ingestion, digestion, dreaming, embeddings, vector store
│       ├── memoryMcp/        # Memory MCP server (notes from CLI tools)
│       ├── kbSearchMcp/      # Knowledge-base search MCP server
│       ├── chatService.ts    # Conversation CRUD, messages, sessions, workspaces, KB/memory state
│       ├── memoryWatcher.ts  # Watches CLI memory files for snapshot capture
│       ├── settingsService.ts # User settings persistence
│       └── updateService.ts  # Self-update: version checking, git pull, PM2 restart
├── public/
│   ├── v2/                   # Default UI (React 18 + Babel Standalone, no build step)
│   │   ├── index.html
│   │   └── src/              # JSX components, screens, primitives, styles
├── ios/                      # Native iOS companion app and Swift smoke tests
├── docs/                     # Wiki-style specification (see SPEC.md)
├── scripts/                  # Repository maintenance helpers
│   └── auth-reset.ts         # Local owner-account recovery command
├── test/                     # Jest test suites
└── data/                     # Runtime data (gitignored)
    ├── chat/
    │   ├── workspaces/{hash}/  # Workspace-scoped storage
    │   │   ├── index.json      # Conversations + session metadata
    │   │   ├── {convId}/       # Session files per conversation
    │   │   ├── memory/         # Per-workspace memory snapshots + notes
    │   │   └── knowledge/      # Per-workspace KB raw/converted/entries/synthesis
    │   ├── artifacts/          # Per-conversation uploaded files
    │   └── settings.json       # User settings
    └── sessions/               # Express session files
```

## Testing

Tests use Jest and run with:

```bash
npm test
```

Tests cover ChatService CRUD/messaging/sessions, backend adapter system (registry, ClaudeCodeAdapter, KiroAdapter, CodexAdapter, tool utilities), chat route integration (streaming, reconnection, options passthrough), graceful shutdown (SIGINT/SIGTERM), session file-store persistence, draft state persistence, message queuing, self-update service, first-party auth and legacy OAuth flows, settings service, browser tab indicator, memory MCP and watcher, and the full Knowledge Base pipeline (ingestion, digestion, dreaming, embeddings, vector store, folders, multi-location, handlers).

CI runs tests automatically on every pull request against `main` via GitHub Actions. Version bumps are automated on merge to `main`.

## Backend-Specific Notes

### Claude Code CLI

Agent Cockpit spawns Claude Code CLI processes on your behalf. To get the best experience, consider adding these settings to your `~/.claude/settings.json`:

```json
{
  "attribution": {
    "gitCommit": "",
    "pullRequest": ""
  },
  "permissions": {
    "allow": [
      "Edit(**)"
    ]
  }
}
```

- **`attribution.gitCommit: ""`** removes the `Co-Authored-By: Claude` trailer from git commits.
- **`attribution.pullRequest: ""`** removes the Claude attribution from pull request descriptions.
- **`permissions.allow: ["Edit(**)"]`** gives Claude Code permission to edit any file without prompting, useful since Agent Cockpit has no interactive terminal for approvals.

### Kiro CLI

Kiro connects via ACP (Agent Client Protocol) — JSON-RPC 2.0 over stdin/stdout. The adapter handles:
- Lazy process spawning with idle timeout (configurable via `KIRO_ACP_IDLE_TIMEOUT_MS`)
- Automatic session creation, loading, and resume across server restarts
- Sub-agent tracking with grouped tool activity visualization
- Permission auto-approval for all tool calls

Ensure `kiro-cli` is installed and authenticated before selecting Kiro as a backend.

### OpenAI Codex CLI

Codex connects via the Codex App Server protocol — JSON-RPC 2.0 over stdin/stdout (a separate transport from ACP, but conceptually similar). The adapter handles:
- Lazy `codex app-server` process spawning per conversation with idle timeout (configurable via `CODEX_IDLE_TIMEOUT_MS`, default 10 min)
- Automatic thread creation, resume across server restarts, and `turn/interrupt` for aborts
- Mid-turn user input via `turn/steer`
- Interactive user questions via `item/tool/requestUserInput` (gated behind Codex's `default_mode_request_user_input` experimental flag — wired but dormant until enabled)
- Full subagent thread demultiplexing — child threads spawned via `spawn_agent` render nested under their parent Agent card with their own live tool activity, matching Claude Code's behavior
- MCP server injection via `-c mcp_servers.<name>.{command,args,env}=…` overrides at spawn time, so your real `~/.codex/` is used unchanged for auth, sessions, and config
- Per-turn token usage tracking via `thread/tokenUsage/updated`
- Permission auto-approval for all tool calls and patches

To run Codex with full elevated permissions, set these in `.env` or your PM2 `ecosystem.config.js`:

```bash
CODEX_APPROVAL_POLICY=never
CODEX_SANDBOX_MODE=danger-full-access
```

Ensure `codex` is installed (`npm install -g @openai/codex`) and authenticated (`codex login` or `OPENAI_API_KEY`) before selecting Codex as a backend.

## Adding a New Backend

Agent Cockpit's pluggable adapter system makes it straightforward to add new CLI backends:

1. Create `src/services/backends/myBackend.ts` extending `BaseBackendAdapter`
2. Implement `metadata`, `sendMessage()`, `generateSummary()`, and optionally `generateTitle()`, `shutdown()`, `onSessionReset()`
3. Import shared helpers from `toolUtils.ts` (never import from another adapter)
4. Register in `server.ts` — no other file changes needed

See [docs/SPEC.md](docs/SPEC.md) for the full adapter contract and stream event protocol.

## Roadmap

Agent Cockpit supports Claude Code, Kiro, and OpenAI Codex as its first three backends. As vendors release more CLI-based coding agents, Agent Cockpit will add adapters so you can use them all from a single interface while keeping your data portable.

## Specification

See [docs/SPEC.md](docs/SPEC.md) for a complete technical specification covering every API endpoint, data model, frontend behavior, security mechanism, and implementation detail. The root `SPEC.md` is a thin redirect — all content lives under `docs/`.
