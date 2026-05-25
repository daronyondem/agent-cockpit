---
id: 0078
title: Recover missing native sessions from snapshots
status: Proposed
date: 2026-05-25
supersedes: []
superseded-by: null
tags: [streaming, backends, session-recovery]
affects:
  - src/types/index.ts
  - src/contracts/responses.ts
  - src/routes/chat.ts
  - src/routes/chat/streamRoutes.ts
  - src/routes/chat/goalRoutes.ts
  - src/services/chatService.ts
  - src/services/chat/conversationMessageStore.ts
  - src/services/chat/sessionRecoveryStore.ts
  - src/services/backends/sessionRecovery.ts
  - src/services/backends/codex.ts
  - src/services/backends/claudeCode.ts
  - src/services/backends/kiro.ts
  - src/services/backends/opencode.ts
  - docs/spec-api-endpoints.md
  - docs/spec-backend-services.md
  - docs/spec-data-models.md
  - docs/spec-testing.md
  - test/backends.test.ts
  - test/chat.streaming.test.ts
  - test/codexBackend.test.ts
  - test/kiroBackend.test.ts
  - test/opencodeBackend.test.ts
---

## Context

Agent Cockpit persists opaque native session identifiers for backends such as
Codex, Claude Code, Kiro, and OpenCode so later turns can resume the CLI's own
conversation state. That native state is outside Agent Cockpit's storage
boundary: a CLI can prune it, fail to write it, read it from a different profile
home, or otherwise reject a resume with "session not found" style errors.

Before this decision, the best case was backend-specific silent fallback to a
fresh native session. That kept the chat unblocked, but the user received no
clear transcript marker and the fresh native session did not receive a reliable
instruction to inspect Agent Cockpit's saved conversation before answering.
Injecting the full transcript into the retry prompt is not acceptable because
large conversations can exceed prompt budgets, and pointing to the live
`session-N.json` file makes the target change while the retry turn is being
processed.

## Decision

When a backend reports that a persisted native session cannot be resumed, Agent
Cockpit writes a stable recovery snapshot under the conversation directory:
`session-recovery/session-N-latest.json`. The snapshot contains the Agent
Cockpit transcript prefix captured before the current failed turn is appended.
Repeated failures for the same source session overwrite the same `latest` file
with the refreshed prior discussion instead of creating unbounded copies.

Backend adapters then start a fresh native session and prepend a recovery
instruction block to the retry prompt. That block uses definitive language: the
harness MUST read the snapshot file before answering, MUST use it as the source
of prior-turn context, and must not continue from the latest user message alone.

The visible chat transcript receives a single friendly system message:
`Your previous harness session could not be resumed. Agent Cockpit recovered the conversation in a new session and will continue from the saved discussion context.`
The message intentionally omits paths and session ids. Debug details
(`backend`, raw failure reason, previous/new native session ids, snapshot path,
source session path/number, snapshot message count, recovery count, timestamp)
are stored in `Message.sessionRecovery` metadata inside the session JSON.
`session_recovery` remains a server-internal stream event consumed by
`processStream`; browser clients see only the normal persisted
`assistant_message` frame for the system message.

## Alternatives Considered

- **Inject the full prior transcript into the retry prompt**: rejected because
  long conversations can exceed backend prompt budgets and add avoidable latency
  to every recovery.
- **Point the retry prompt at the active `session-N.json` file**: rejected
  because that file continues to change as the turn progresses, so the path does
  not represent a stable prior-discussion boundary.
- **Show native ids, paths, and raw errors in the chat transcript**: rejected
  because those details are useful for debugging but not helpful as user-facing
  recovery copy.
- **Keep backend-specific silent fallback**: rejected because the user cannot
  tell recovery happened and the fresh native session may answer without reading
  the saved prior discussion.

## Consequences

- + Missing native sessions become recoverable across Codex, Claude Code, Kiro,
  and OpenCode with one shared prompt/message/snapshot contract.
- + Users get a positive, concise transcript marker while diagnostic details
  remain available in the session JSON for investigation.
- + Repeated failures refresh a stable snapshot path instead of leaving stale
  context behind.
- - Recovery now depends on the fresh native session honoring file-reading
  instructions; if it fails to inspect the snapshot, Agent Cockpit cannot prove
  semantic continuity.
- ~ Snapshots duplicate prior transcript content on disk, bounded to one latest
  file per source session.

## References

- [Backend Services: Native Session Recovery](../spec-backend-services.md#native-session-recovery)
- [Data Models: Session Recovery Snapshot](../spec-data-models.md#session-recovery-snapshot-workspacesstoragekeyconvidsession-recoverysession-n-latestjson)
- [Testing: backend and streaming recovery coverage](../spec-testing.md)
