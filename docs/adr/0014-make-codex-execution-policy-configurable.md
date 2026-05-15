---
id: 0014
title: Make Codex execution policy configurable
status: Superseded
date: 2026-04-28
supersedes: []
superseded-by: 0062
tags: [codex, configuration, security]
affects:
  - server.ts
  - src/config/index.ts
  - src/services/backends/codex.ts
  - src/types/index.ts
  - README.md
  - docs/spec-backend-services.md
---

## Context

Codex supports multiple execution postures: normal sandboxed operation, approval-driven escalation, and full access through `danger-full-access` / approval policy `never`. Agent Cockpit previously hardcoded interactive Codex threads to `approvalPolicy: 'on-request'` and `sandbox: 'workspace-write'`, while one-shot `codex exec` calls always used `--full-auto`.

That default is reasonable for most installs, but it does not let a trusted single-user deployment intentionally run Codex the way the user would run an elevated terminal session. Making every install full-access by default would change the security posture for remote/tunneled Agent Cockpit deployments, where the browser UI can reach local tools and files.

## Decision

Codex execution policy is server configuration. `CODEX_APPROVAL_POLICY` and `CODEX_SANDBOX_MODE` are read from the environment, validated against Codex's known CLI values, and passed into `CodexAdapter` from `server.ts`.

The default remains `on-request` plus `workspace-write`. A deployment that wants full elevated Codex execution sets:

```bash
CODEX_APPROVAL_POLICY=never
CODEX_SANDBOX_MODE=danger-full-access
```

Interactive Codex threads receive those values in `thread/start` and `thread/resume`. One-shot `codex exec` keeps the existing `--full-auto` behavior by default, and switches to `--dangerously-bypass-approvals-and-sandbox` only for the explicit full-access combination above.

## Alternatives Considered

- **Hardcode full access for every Codex session**: Rejected because it silently weakens the default security posture for every deployment, including remote browser access.
- **Require users to edit `~/.codex/config.toml`**: Rejected because Agent Cockpit should not mutate or depend on persistent user Codex config for a server-owned runtime policy.
- **Expose the policy as a per-conversation UI toggle**: Rejected for now because the immediate requirement is deployment-level trust, and a UI toggle would add product surface and persistence rules that are not needed.

## Consequences

- + Trusted deployments can start Codex with full elevated permissions using env vars.
- + Default installs keep their previous Codex execution posture.
- - Operators must understand that `never` plus `danger-full-access` lets Codex run local commands and modify files without prompts.
- ~ The policy applies process-wide to the Agent Cockpit server, not per user or per conversation.

## References

- [CodexAdapter spec](../spec-backend-services.md#codexadapter-srcservicesbackendscodexts)
- [ADR-0005: Codex app-server JSON-RPC with TOML MCP injection](0005-codex-app-server-jsonrpc-with-toml-mcp-injection.md)
