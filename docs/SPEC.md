# Agent Cockpit — Specification

> **This specification is the single source of truth for the Agent Cockpit project.** It contains every endpoint, data model, behavior, and implementation detail needed to rewrite the project from scratch. Each section is maintained in its own file for navigability and depth.

## Table of Contents

| Section | File | Description |
|---------|------|-------------|
| 1. Overview | [This file](#1-overview) | Core use case, key principles |
| 2. Data Models & File Structure | [spec-data-models.md](spec-data-models.md) | On-disk layout, JSON schemas, workspace hashing |
| 3. API Endpoints | [spec-api-endpoints.md](spec-api-endpoints.md) | REST + WebSocket API surface |
| 4. Backend Services | [spec-backend-services.md](spec-backend-services.md) | ChatService, adapter system, KB pipeline, update service |
| 5. Server Initialization & Security | [spec-server-security.md](spec-server-security.md) | Config, startup order, auth, CSRF, CSP |
| 6. Frontend Behavior | [spec-frontend.md](spec-frontend.md) | SPA architecture, streaming, KB browser, settings |
| 7. Mobile PWA Client | [spec-mobile-pwa.md](spec-mobile-pwa.md) | Installable mobile web client architecture, implemented slice, deferred work |
| 8. Export, Limitations & Deployment | [spec-deployment.md](spec-deployment.md) | Markdown export, known limitations, deployment |
| 9. Testing & CI/CD | [spec-testing.md](spec-testing.md) | Test suite, test files, CI workflows |

### Design Documents

In-flight or pending design proposals that complement (but have not yet been folded into) the spec proper:

| Document | Status | Description |
|----------|--------|-------------|
| [design-kb-ingestion-hybrid.md](design-kb-ingestion-hybrid.md) | Implemented | Hybrid AI-assisted KB ingestion (PDF/DOCX/PPTX/image conversion at ingest time) — shipped across PRs #213–#228 |
| [design-kb-vnext-implementation-plan.md](design-kb-vnext-implementation-plan.md) | Proposed | Phased Knowledge Base vNext plan: document structure, chunked digestion, gleaning, glossary expansion, graph retrieval, synthesis history, and pipeline visualization |

### Notes & Findings

Engineering notes that capture empirical findings — not proposals or specs, but durable knowledge worth preserving:

| Document | Description |
|----------|-------------|
| [notes-kiro-bedrock-parity.md](notes-kiro-bedrock-parity.md) | Differences observed between Kiro (AWS Bedrock-routed) and Claude Code (direct Anthropic API) for Opus 4.7 — image format/dimension caps, ACP stream termination, JSON-RPC error extraction, etc. |
| [parity-decisions.md](parity-decisions.md) | Intentional parity decisions between the desktop web UI and the mobile PWA, especially features that are deliberately web-only. |

### Architecture Decision Records

ADRs capture *why* the system is shaped the way it is — the decision made, the alternatives considered, and the tradeoffs accepted. The SPEC documents above describe *what is true now*; ADRs describe *why we chose this and what we rejected*. SPEC sections should cross-link to the ADRs that shaped them, and vice versa, but should not duplicate the rationale.

See [docs/adr/README.md](adr/README.md) for the index and [ADR-0001](adr/0001-record-architecture-decisions.md) for the practice itself. Authoring guidance lives in [CLAUDE.md](../CLAUDE.md#architecture-decision-records-adrs).

---

## 1. Overview

**Agent Cockpit** is a web-based chat interface for interacting with the Claude Code CLI. It runs on the same machine as the CLI tools. The server spawns local `claude` CLI processes, streams responses back to the browser via WebSocket, and stores conversations in workspace-scoped JSON files on disk.

### Core Use Case

Install on a machine with Claude Code CLI. Expose via a tunnel (e.g., ngrok). Access from any device and interact with your local CLI remotely through the browser.

### Key Principles

- CLI and web interface **must** run on the same machine — spawns local CLI processes, not remote API calls.
- First-party local owner auth protects access. Legacy OAuth is optional and disabled by default.
- Local requests (localhost/127.0.0.1/::1) bypass authentication for development convenience.
