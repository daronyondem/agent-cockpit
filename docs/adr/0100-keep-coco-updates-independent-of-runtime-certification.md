---
id: 0100
title: Keep CoCo updates independent of runtime certification
status: Accepted
date: 2026-11-10
supersedes: []
superseded-by: null
tags: [backends, updates, compatibility]
affects:
  - src/services/cortexUpdates.ts
  - test/cortexUpdates.test.ts
  - scripts/probe-cortex-updates.ts
  - scripts/probe-cortex-auth.ts
  - docs/spec-cortex-code.md
---

## Context

CoCo initially allowed managed updates only from individually verified CLI
versions. Adding 1.2.37 addressed one release, but the next version would disable
future updates again, even after a successful Cockpit-managed upgrade. Codex
and Claude already determine update access from the installation method and
keep runtime compatibility warnings separate.

## Decision

CoCo update eligibility depends on its official macOS standalone installation:
the activation symlink, versioned executable, matching metadata and fresh native
version response. There is no patch, minor or major version allowlist.

Continue checking Snowflake stable metadata and invoking native `update <target>`
with the checked full distribution. Preserve active-chat exclusion, preflight
revalidation, terminal-auth environment, awaited cleanup, fresh activation/version
verification and no automatic retry. A changed native updater interface produces
an ordinary update failure through that path rather than a certification block.

Chat, login, media and strict-processor evidence remains independently scoped.
Compatibility cautions are nonblocking and appear only for an available update.
This replaces the per-version updater eligibility policy in ADR-0099's C49
section; its other runtime and platform decisions remain unchanged.

## Alternatives Considered

- **Extend the allowlist for each release**: Rejected because every new version
  recreates the same end-user failure and requires another Cockpit release.
- **Update arbitrary installations**: Rejected because wrappers, custom layouts
  and unverified native platforms still need installation-specific handling.

## Consequences

- New CoCo releases retain managed update access without Cockpit code changes.
- A future native updater can fail if its interface or distribution layout
  changes; existing error reporting and post-update checks remain necessary.
- Native probes record the actual tested release. Future-version fixtures prove
  update policy, not compatibility of a binary that has not been tested.
- Mobile remains a chat/run client without CLI administration.

## References

- [Managed CLI updates](0027-manage-cli-updates-from-web-cockpit.md)
- [CoCo integration](0099-integrate-cortex-code-through-its-native-acp-interface.md)
- [CoCo update specification](../spec-cortex-code.md#native-cli-updates-p8-c49)
