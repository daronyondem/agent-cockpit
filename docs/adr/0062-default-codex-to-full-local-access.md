---
id: 0062
title: Default Codex to full local access
status: Accepted
date: 2026-05-15
supersedes: [0014]
superseded-by: null
tags:
  - codex
  - configuration
  - security
  - install
affects:
  - src/config/index.ts
  - src/services/backends/codex.ts
  - test/codexBackend.test.ts
  - README.md
  - docs/spec-server-security.md
  - docs/spec-backend-services.md
  - docs/spec-testing.md
  - docs/adr/0014-make-codex-execution-policy-configurable.md
---

## Context

Agent Cockpit runs local CLI agents on the user's machine and presents them as a
browser-accessible cockpit. Claude Code and Kiro paths already auto-approve or
bypass CLI permission prompts for normal cockpit usage, while Codex previously
defaulted to `approvalPolicy: "on-request"` and `sandbox: "workspace-write"`.

[ADR-0014](0014-make-codex-execution-policy-configurable.md) made Codex policy
configurable but kept the conservative default. That left fresh Codex installs
less aligned with the product's trusted-local-agent posture and required users
to discover server env overrides before Codex could operate with the same broad
local authority expected from Agent Cockpit.

The app still needs an escape hatch for restricted or remotely exposed
deployments, but the default should match the primary local single-user install
model.

## Decision

Codex defaults to full local access in Agent Cockpit:

```bash
CODEX_APPROVAL_POLICY=never
CODEX_SANDBOX_MODE=danger-full-access
```

`src/config/index.ts` uses those values when the environment is unset, and
`CodexAdapter` uses the same values when constructed without explicit policy
options. Interactive app-server threads receive the full-access policy through
`thread/start` / `thread/resume`. Codex one-shot calls use
`--dangerously-bypass-approvals-and-sandbox` by default.

The env vars remain supported. Deployments that need a stricter posture can set
values such as:

```bash
CODEX_APPROVAL_POLICY=on-request
CODEX_SANDBOX_MODE=workspace-write
```

Restricted non-default one-shot calls pass explicit `--ask-for-approval` and
`--sandbox` flags so the configured policy is still honored.

## Alternatives Considered

- **Keep ADR-0014 defaults and document the opt-in**: Rejected because the user
  wants Agent Cockpit to be a trusted local agent by default rather than making
  fresh Codex users configure env vars for expected filesystem/tool access.
- **Add a first-run toggle instead of changing defaults**: Rejected because the
  immediate product decision is a default posture change, and adding a UI toggle
  would introduce new persistence and migration behavior beyond this scope.
- **Mutate `~/.codex/config.toml` during setup**: Rejected because Agent Cockpit
  should not rewrite user-owned vendor configuration for a server-owned runtime
  policy.

## Consequences

- + Fresh Codex installs behave like a fully trusted local coding agent without
  extra setup.
- + Claude, Kiro, and Codex now have a more consistent Agent Cockpit execution
  posture.
- - Remote or multi-user deployments must explicitly set stricter Codex env vars
  if full local tool/filesystem access is not acceptable.
- ~ The policy remains process-wide for the Agent Cockpit server, not
  per-conversation or per-profile.

## References

- [ADR-0014: Make Codex execution policy configurable](0014-make-codex-execution-policy-configurable.md)
- [Server security spec](../spec-server-security.md#61-configuration)
- [CodexAdapter spec](../spec-backend-services.md#codexadapter-srcservicesbackendscodexts)
