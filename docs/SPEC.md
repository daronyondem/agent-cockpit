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
| 7. Export, Limitations & Deployment | [spec-deployment.md](spec-deployment.md) | Markdown export, known limitations, deployment |
| 8. Testing & CI/CD | [spec-testing.md](spec-testing.md) | Test suite, test files, CI workflows |

---

## 1. Overview

**Agent Cockpit** is a web-based chat interface for interacting with the Claude Code CLI. It runs on the same machine as the CLI tools. The server spawns local `claude` CLI processes, streams responses back to the browser via WebSocket, and stores conversations in workspace-scoped JSON files on disk.

### Core Use Case

Install on a machine with Claude Code CLI. Expose via a tunnel (e.g., ngrok). Access from any device and interact with your local CLI remotely through the browser.

### Key Principles

- CLI and web interface **must** run on the same machine — spawns local CLI processes, not remote API calls.
- OAuth protects access. Only whitelisted email addresses can log in.
- Local requests (localhost/127.0.0.1/::1) bypass authentication for development convenience.
