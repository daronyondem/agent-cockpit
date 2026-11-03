---
id: 0097
title: Contain Windows Copilot descendants in a per-run job
status: Accepted
date: 2026-11-03
supersedes: [0096]
superseded-by: null
tags: [backends, copilot, lifecycle, windows, testing]
affects:
  - src/services/backends/copilotWindowsProcess.ts
  - src/services/backends/copilotProcess.ts
  - test/copilotWindowsProcess.test.ts
  - .github/workflows/test.yml
  - docs/spec-backend-services.md
  - docs/spec-testing.md
---

## Context

Windows tree cleanup by launcher PID loses ownership when intervening launchers
exit. Polling descendants cannot close the short-lived-parent race already
reproduced on POSIX. A closed launcher must not leave tool work running during
reset, cancellation, or server shutdown.

## Decision

Retain ADR-0096's POSIX ownership markers, identity checks, lifecycle reservations,
JSONL transport, and usage behavior. Replace only the Windows launch boundary
with a hidden, per-run PowerShell wrapper that uses built-in Add-Type/PInvoke to
create an unnamed Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and no
breakaway permissions. Assign the wrapper itself before it starts Copilot, so
all normal descendants inherit ownership without a process-discovery race.

Only the wrapper holds the non-inheritable job handle. Its normal exit, failure,
or forced termination closes the handle and terminates remaining descendants,
including detached workers whose launcher is gone. Keep existing bounded
taskkill/direct-kill cancellation of the wrapper. Fail startup before launching
Copilot if job creation, configuration, or assignment fails.

Send the executable and quoted native argv as JSON through stdin, using a fixed
encoded wrapper script. The target inherits raw stdout/stderr, cwd, and the
selected environment; prompts never become PowerShell source. Run native Node
process fixtures on Windows CI without requiring a Copilot account.

## Alternatives Considered

- **Poll Windows ancestry:** rejected because short-lived parents can disappear
  between snapshots, and PID reuse adds further ambiguity.
- **Assign after launching Copilot:** rejected because it can spawn children
  before assignment. Assigning the wrapper first avoids suspended-process and
  custom pipe plumbing.
- **Ship a native dependency:** unnecessary for this Windows-only boundary;
  built-in PowerShell and kernel32 suffice.

## Consequences

- + Kernel ownership survives launcher exit and does not select unrelated PIDs.
- + Normal completion also reaps abandoned background workers.
- - Windows starts include PowerShell/Add-Type startup cost. Constrained systems
  that prohibit compilation or job assignment fail explicitly.
- ~ Job ownership covers normal process descendants, not processes created by
  external brokers such as WMI or scheduled services. It is not a security
  sandbox. Native process CI does not certify real Copilot Windows behavior.

## References

- [ADR-0096](0096-track-copilot-orphan-ownership-and-drain-before-session-changes.md).
- [Backend specification](../spec-backend-services.md#copilotadapter-srcservicesbackendscopilotts).
- [Testing specification](../spec-testing.md).
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
- PR #571.
