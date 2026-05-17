# Agent Cockpit Product Positioning

This document is the message architecture for public Agent Cockpit copy. Use it
when writing the README, user docs, release notes, landing pages, or product
descriptions.

It is not a technical spec. Implementation truth remains in [SPEC.md](SPEC.md)
and the focused `docs/spec-*.md` files.

## Core Identity

**Category:** local browser cockpit for CLI-based AI agents.

**One-line promise:** run CLI AI agents from your browser, keep your context on
your machine, and switch vendors without starting over.

**Short description:** Agent Cockpit is an open source, local-first web UI for
Claude Code, OpenAI Codex, Kiro, and future command-line AI agents. It wraps the
CLIs users already install, streams their work into a browser interface, and
stores conversations, memory, knowledge-base material, and workspace context
locally.

## Primary Audience

Agent Cockpit is for technical users, builders, researchers, operators, and
knowledge workers who:

- use more than one AI vendor or expect to switch vendors over time;
- prefer self-hosted/local tooling over hosted SaaS for AI interaction data;
- want browser and mobile access to agents that run on their own machine;
- use AI across coding, research, planning, writing, and daily knowledge work;
- want long-lived project/workspace context outside any single vendor product.

## Positioning Pillars

### One Browser Interface For Local CLIs

Agent Cockpit should be understood as a cockpit, not a replacement runtime. It
starts or connects to local CLI backends and gives them a consistent browser UI
for conversation, tools, files, sessions, and approvals.

### Your AI Interaction Data Stays Local

Lead with user ownership of interaction data: conversations, sessions, memory,
knowledge-base entries, Context Map state, settings, and generated artifacts.
Avoid implying that Agent Cockpit operates a cloud service.

### Context Is Portable Across Vendors

Memory, Knowledge Base, workspace instructions, and Context Map should be
framed as provider-neutral context layers. A user can choose the best backend
for the next task without losing the workspace understanding that has built up
locally.

### Self-Hosted, But Not From Scratch

Be honest that Agent Cockpit is not a hosted SaaS. At the same time, production
installers on macOS and Windows own much of the server setup: private runtime
fallbacks, PM2 startup, release verification, self-update, and first-run owner
setup.

## What Agent Cockpit Is Not

- **Not hosted SaaS.** There is no Agent Cockpit cloud account or central
  dashboard.
- **Not a model provider.** It does not host, proxy, or resell inference.
- **Not a CLI replacement.** It wraps vendor CLIs and relies on their installed
  auth/runtime behavior.
- **Not an autonomous company orchestration layer.** It is a personal/local
  cockpit for interacting with AI agents, not a business-control-plane system.
- **Not zero setup.** The release installers reduce setup, but users still run
  and secure a local server and authenticate the vendor CLIs they choose.

## Message Hierarchy

Use this order when public copy needs to be brief:

1. Local browser UI for CLI AI agents.
2. Conversations and context stay on your machine.
3. Switch providers without losing accumulated workspace understanding.
4. Works today with Claude Code, Codex, and Kiro.
5. Production installers manage the local server on macOS and Windows.

## Proof Points

- Supports Claude Code, OpenAI Codex, and Kiro as local backends.
- Stores workspace-scoped conversations, sessions, memory, and knowledge-base
  artifacts locally.
- Context Map builds governed workspace context that backends can query through
  read-only MCP tools.
- Mobile PWA is served by the same authenticated backend.
- Production installs update from GitHub Releases; development installs track
  `main`.
- First-party local owner auth protects the web UI, with passkeys and recovery
  codes available after setup.

## Language Guidelines

- Prefer direct user-facing phrases: "your machine", "your workspace",
  "browser UI", "local CLI", "vendor CLIs", "owned context".
- Avoid provider-specific framing unless a section is backend-specific.
- Avoid overclaiming setup simplicity. Say "installer-managed local server"
  rather than "zero setup".
- Avoid enterprise jargon and inflated claims.
- Keep copy distinct from organization-scale orchestration language. Do not
  describe Agent Cockpit as an AI company, workforce, or autonomous business
  platform.
- Do not ask users to edit personal Claude Code settings for permissions or
  attribution in public setup copy.
