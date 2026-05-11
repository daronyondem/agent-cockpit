<p align="center">
  <img src="public/logo-text.svg" alt="Agent Cockpit" width="500" />
</p>

<p align="center">
  Run AI assistants from your browser. Keep your data. Switch vendors anytime.
</p>

<p align="center">
  <em>Built for command-line AI agents like Claude Code, OpenAI Codex, and Kiro.</em>
</p>

---

## Why Agent Cockpit?

When you use vendor-hosted AI interfaces — Anthropic's Claude, Amazon's Kiro, OpenAI's ChatGPT — each one builds up memory and context about you. Your conversation history, accumulated knowledge, working preferences, and the documents you've uploaded all sit inside their platform. The moment a better model ships from another provider, you can't take any of it with you. You start over.

Agent Cockpit decouples **your data** from **the AI vendor**. It runs on your own machine, talks to command-line AI agents, and stores every conversation, session, and knowledge-base entry locally on disk as open JSON and Markdown files. When you switch vendors, the new agent inherits everything the previous one built up — for code, for writing, for research, for whatever you use AI for.

The bet is simple: vendors will keep changing, but your context shouldn't reset every time. The model is rented; the context is yours.

## Who is this for?

Agent Cockpit is for you if any of these apply:

- You pay for more than one AI vendor and want a single interface across them.
- You want your conversations, knowledge base, and accumulated context on **your own machine**, not in a vendor's cloud.
- You want to switch vendors without losing history — because models keep getting better and lock-in keeps getting worse.
- You use AI for more than coding: research, writing, knowledge work, decision-making, running your day.
- You're comfortable self-hosting (Node.js, a server you control, optional tunnel for remote access).

It is **not** a hosted SaaS. If you want zero-setup, this isn't it. If you only ever use one vendor and never plan to switch, you don't need it.

## What it does

Three things, at the core:

### 1. Unified interface across AI vendors
Use Claude Code, OpenAI Codex, and Kiro from a single browser-based UI. Switch backends per conversation. Pick the model, set the reasoning effort, and keep your workflow consistent regardless of which vendor you're using.

### 2. Your data stays on your disk
Every conversation, session, memory snapshot, and knowledge-base entry is stored locally as open JSON or Markdown. No vendor cloud, no proprietary database, no lock-in. If you stop using Agent Cockpit tomorrow, your data is still right there in plain files.

### 3. Context is portable across vendors
The integrated memory system snapshots every change to a CLI's memory file. Cross-CLI instruction compatibility keeps `CLAUDE.md`, `AGENTS.md`, and Kiro steering files in sync. The knowledge base and the workspace Context Map feed structured context to whichever vendor you ask next. Switching backends doesn't reset your context — your accumulated knowledge follows you.

## The Knowledge Base

The KB is the longest-lived part of Agent Cockpit. While conversations come and go, the KB accumulates everything you want your AI to know about — in your files, on your disk, queryable by any vendor you point at it.

Upload PDFs, Word documents, PowerPoints, images, CSV/TSV files, Markdown, and text-like files into a per-workspace knowledge base. Agent Cockpit converts and analyzes each file, extracts structured entries, organizes them into synthesized topics, discovers connections between ideas, and surfaces topic/reflection readers that your AI agents can search and reason over during conversations.

Use it for code documentation. Use it for board prep. Use it for personal reading notes. Use it for whatever you want to be able to ask an AI about later — and have the answer grounded in *your* sources.

## The Context Map

The Context Map is the workspace-level graph that tracks the important entities in a workspace — people, projects, services, documents, decisions — the relationships between them, and the evidence that supports each conclusion. It runs asynchronously in the background, scans high-signal workspace files and conversation history, and surfaces a governed graph you can review and curate from workspace settings.

When the active CLI needs to ground a turn, it can read the graph through read-only MCP tools: matching entities, related entities, and a compact context pack of pointers, summaries, and evidence — instead of dumping every memory or KB document into the prompt.

Context Map is separate from Memory and the Knowledge Base, enabled per workspace, and disabled by default. See [docs/spec-context-map.md](docs/spec-context-map.md) for the full feature specification.

## Supported Backends

| Backend | CLI | Status |
|---------|-----|--------|
| **Claude Code** | `claude` | Fully supported |
| **Kiro** | `kiro-cli` | Fully supported |
| **OpenAI Codex** | `codex` | Fully supported |

Switch between backends per-conversation using the dropdown in the chat input area. Your selected backend is remembered for new conversations.

See [BACKENDS.md](BACKENDS.md) for a comparison of feature support across backends.

## How it gets used

Agent Cockpit is the substrate. The real value comes from the patterns you build on top of it. A few examples:

- **Personal knowledge work.** Ingest your reading list, meeting notes, and research into the KB. Ask any AI agent to reason over them. Switch agents based on which model handles your question best.
- **Multi-vendor coding.** Run Claude Code on the hard problem, switch to Codex for fast iteration, use Kiro for spec work. Same workspace, same files, same accumulated memory.
- **Persona profiles for the people you work with.** One conversation per person. Add context about them over time. Use it to prep for the next interaction — without ever sending those notes to a vendor's cloud.
- **Workflow execution from a tablet.** Give the CLI full filesystem access on a server you control, then describe a workflow in plain language. Let the agent run it on the host machine while you watch the stream from your phone.

These aren't features the tool conceptualizes — they're patterns the substrate enables. The tool is the runway; what you take off with is up to you.

## How It Works

Agent Cockpit runs on the same machine as your CLI tools. When you send a message through the browser, the server spawns a CLI process locally, streams the response back over WebSocket, and stores the conversation as a JSON file on disk. The CLI runs with full access to your local filesystem and tools, just as it would in your terminal.

This means:
- **The CLI and the web interface must run on the same machine.** Agent Cockpit spawns local processes, not remote API calls.
- **Expose the server for remote access.** Use a tunnel like [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to chat with your coding agents from any browser, anywhere, while they operate on your local files and environment.
- **First-party owner auth protects access.** Create one local owner account per Agent Cockpit server; exposed first-run setup can be guarded with `AUTH_SETUP_TOKEN`.

## Also included

Beyond the core, Agent Cockpit also ships with:

- **Real-time streaming** — responses stream live via WebSocket with automatic reconnection and state recovery
- **Agent & tool visualization** — sub-agents, tool calls, thinking, and outcomes shown in real time with grouped activity panels and a compact progress timeline that collapses intermediate turns
- **Multi-workspace support** — conversations are organized by workspace directory, each with its own system prompt and per-workspace memory and knowledge-base toggles
- **Instruction compatibility checks** — composer notification warns when `AGENTS.md`, `CLAUDE.md`, or Kiro steering files are out of sync across supported CLI vendors, with one-click pointer creation
- **Conversation management** — create, rename, search, archive, mark unread, and delete conversations grouped by workspace
- **Session management** — reset CLI sessions and view session history with LLM-generated summaries
- **Auto-generated titles** — conversation titles are generated automatically from the first message
- **Draft persistence** — unsent messages and attached files are preserved across conversation switches and survive session expiry mid-send
- **Plan mode and interactive questions** — approve plans and answer questions from the CLI directly in the browser, with the approval UI preserved across reconnects
- **CLI file delivery** — files emitted by the CLI appear inline as cards with a download button and an in-browser viewer
- **Browser tab status indicator** — favicon dot shows when a task is still running so you can flip away and check back
- **Per-CLI context tooltip** — hover the context chip to see what the active backend reports (tokens vs. credits/percentage), including a projected end-of-cycle usage status when the backend exposes a renewing quota window
- **Dark and light themes** — system-aware theme with manual override
- **First-party authentication** — local owner setup, password login, passkeys, recovery codes, and optional legacy OAuth compatibility
- **Mobile PWA** — installable mobile web client served from `/mobile/` by the same authenticated backend
- **Self-update** — check for updates and apply them from the UI with one click
- **Pluggable backend system** — extensible adapter architecture for adding new CLI backends
- **Graceful shutdown** — clean process cleanup on SIGTERM/SIGINT
- **Local open storage** — conversations, sessions, settings, memory, and knowledge-base artifacts stay on disk as JSON/Markdown plus embedded SQLite/PGLite indexes where structured search requires them (no hosted database)

## Prerequisites

- Node.js 22+ (declared in `engines`)
- At least one CLI backend installed and authenticated on the same machine:
  - [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
  - [Kiro CLI](https://kiro.dev) (`kiro-cli`)
  - [OpenAI Codex CLI](https://github.com/openai/codex) (`codex`, install with `npm install -g @openai/codex`)
- (Optional) [LibreOffice](https://www.libreoffice.org/) and/or [Pandoc](https://pandoc.org/) on `PATH` to expand Knowledge Base ingestion to Office and other document formats
- (Optional) [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or a similar tunnel for remote access — see [ONBOARDING.md](ONBOARDING.md) for a step-by-step self-hosting guide with PM2 and Cloudflare Tunnel

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
| `LOG_LEVEL` | No | `info` | Server log threshold: `error`, `warn`, `info`, or `debug`. Structured logger metadata redacts secret-like keys before writing to stdout/stderr. |

## Authentication Setup

Agent Cockpit uses one first-party local owner account by default. No GitHub, Google, Apple ID, or Cloudflare Access login is required for the normal self-hosted flow.

On first run, open `/auth/setup` and create the owner account with an email, display name, and password of at least 12 characters. If the backend is exposed through a tunnel before setup, set `AUTH_SETUP_TOKEN` and enter that token on the setup page so a remote visitor cannot claim the empty backend.

After setup, open **Settings > Security** to:

- Register one or more passkeys.
- Generate recovery codes and store them somewhere safe.
- Enable **Require passkey for login** after at least one passkey and one unused recovery code exist.

Passkeys are tied to the backend domain. If you move from one host to another, for example from `chat-dev.example.com` to `chat.example.com`, register a passkey while signed in on the new domain.

For local lockout recovery, run this on the backend machine:

```bash
npm run auth:reset -- --password "new long password" --disable-passkey-required --revoke-sessions --regenerate-recovery-codes
```

The reset command requires local filesystem access. It can reset the owner password, disable passkey-required mode, revoke sessions, and print replacement recovery codes.

### Legacy OAuth

Google/GitHub OAuth is legacy-only and disabled by default. Set `AUTH_ENABLE_LEGACY_OAUTH=true` only if you need the old provider routes temporarily, then configure the provider client id, client secret, callback URL, and `ALLOWED_EMAIL`.

## Remote Access with Cloudflare Tunnel

To access Agent Cockpit from outside your local network, use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):

```bash
cloudflared tunnel --url http://localhost:3334
```

Use the tunnel-provided URL to reach your local Agent Cockpit from any device. For a fresh exposed backend, set `AUTH_SETUP_TOKEN` before creating the owner account.

## Mobile PWA

The supported mobile client is served by the same backend at `/mobile/`. Open `https://<your-host>/mobile/` on the phone, sign in with the normal owner account, then use the browser's Add to Home Screen flow. The server rebuilds stale mobile assets into ignored `public/mobile-built/` during startup and self-update; `npm run mobile:build` remains the explicit local check.

The PWA uses the same authenticated web session as the desktop UI. Xcode, Expo Go, TestFlight, App Store distribution, and native app pairing are not part of the supported mobile path.

## Project Structure

```
agent-cockpit/
├── server.ts                 # Express server entry point (TypeScript, run via tsx)
├── src/
│   ├── ws.ts                 # WebSocket server (streaming, reconnection, state recovery)
│   ├── contracts/            # Shared API request/response contracts and validators
│   ├── types/index.ts        # Shared type definitions
│   ├── config/index.ts       # Environment configuration
│   ├── middleware/
│   │   ├── auth.ts           # First-party owner auth, legacy OAuth, login routes
│   │   ├── csrf.ts           # CSRF token generation and validation
│   │   └── security.ts       # Helmet CSP configuration
│   ├── routes/chat.ts        # Chat API composition root
│   ├── routes/chat/          # Focused chat route modules and shared route utilities
│   ├── utils/logger.ts       # Structured logger with level filtering and metadata redaction
│   └── services/
│       ├── localAuthStore.ts # First-party auth state, passkeys, recovery codes
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
│       ├── chat/             # Focused ChatService helper modules
│       ├── memoryWatcher.ts  # Watches CLI memory files for snapshot capture
│       ├── settingsService.ts # User settings persistence
│       ├── updateService.ts  # Self-update: version checking, git pull, builds, PM2 restart
│       ├── webBuildService.ts # V2 web asset build preflight
│       └── mobileBuildService.ts # Mobile PWA asset build preflight
├── public/
│   ├── v2/                   # Retired Browser-Babel placeholders for ADR path stability
│   ├── v2-built/             # Ignored Vite output served at /v2/
│   └── mobile-built/         # Ignored mobile PWA output served at /mobile/
├── web/
│   └── AgentCockpitWeb/      # Source for the Vite React V2 web UI
├── mobile/
│   └── AgentCockpitPWA/      # Source for the Vite React mobile PWA
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
    │   │   ├── knowledge/      # Per-workspace KB raw/converted/entries/synthesis
    │   │   ├── context-map/    # Per-workspace graph state and candidates
    │   │   └── session-finalizers.json # Durable reset/archive background jobs
    │   ├── stream-jobs.json    # Durable active-stream supervision registry
    │   ├── usage-ledger.json   # Daily backend/model usage totals
    │   ├── artifacts/          # Per-conversation uploaded files
    │   └── settings.json       # User settings
    └── sessions/               # Express session files
```

## Testing

Tests use Jest and run with:

```bash
npm test
```

Tests cover ChatService CRUD/messaging/sessions, backend adapter system (registry, ClaudeCodeAdapter, KiroAdapter, CodexAdapter, tool utilities), chat route integration (streaming, reconnection, options passthrough), graceful shutdown (SIGINT/SIGTERM), session file-store persistence, draft state persistence, message queuing, self-update service, first-party auth and legacy OAuth flows, settings service, browser tab indicator, V2 bundle budget checks, mobile PWA static serving, memory MCP and watcher, and the full Knowledge Base pipeline (ingestion, digestion, dreaming, embeddings, vector store, folders, multi-location, handlers).

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
